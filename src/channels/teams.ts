import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { GatewayConfig, TeamsConfig } from "../config.js";
import type { ChannelAdapter, InboundMessage, OutboundMessage } from "../types.js";
import { BaseChannelAdapter, type InboundHandler } from "./base.js";
import {
  BoundedDedupeCache,
  chunkText,
  closeHttpServer,
  configureHttpServerTimeouts,
  extractAuthSchemeToken,
  isLoopbackHost,
  isMentioned,
  listenHttpServer,
  parseRequestUrl,
  readBoundedHttpBody,
  rememberBounded,
} from "./utils.js";

const LOGIN_BASE = "https://login.microsoftonline.com";
const BOT_FRAMEWORK_SCOPE = "https://api.botframework.com/.default";
const MAX_TEXT_CHARS = 4000;
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_SERVICE_URL_ENTRIES = 1000;
const TOKEN_EXPIRY_BUFFER_MS = 60_000;
const SEND_TIMEOUT_MS = 15_000;
const DEFAULT_WEBHOOK_PATH = "/teams/messages";

interface TeamsActivity {
  type?: string;
  id?: string;
  text?: string;
  replyToId?: string;
  from?: { id?: string; name?: string; aadObjectId?: string };
  conversation?: {
    id?: string;
    name?: string;
    conversationType?: string;
    isGroup?: boolean;
    tenantId?: string;
  };
  recipient?: { id?: string; name?: string };
  serviceUrl?: string;
  channelData?: Record<string, unknown>;
  timestamp?: string;
  entities?: Array<{ type?: string; text?: string; mentioned?: { id?: string; name?: string } }>;
}

export interface TeamsAdapterOptions {
  fetchImpl?: typeof fetch;
  maxBodyBytes?: number;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/** Verify Teams' `Authorization: HMAC <base64>` outgoing-webhook signature (timing-safe). */
export function verifyTeamsHmac(
  webhookSecret: string,
  rawBody: Buffer,
  authorizationHeader: string,
): boolean {
  if (!webhookSecret || !authorizationHeader.trim()) {
    return false;
  }
  const encoded = extractAuthSchemeToken(authorizationHeader, "HMAC");
  if (!encoded) {
    return false;
  }
  const provided = Buffer.from(encoded, "base64");
  if (provided.length === 0) {
    return false;
  }
  const key = Buffer.from(webhookSecret, "base64");
  const expected = createHmac("sha256", key).update(rawBody).digest();
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class TeamsChannelAdapter extends BaseChannelAdapter {
  readonly name = "teams";

  private readonly teamsConfig: TeamsConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly dedupe = new BoundedDedupeCache();
  private readonly serviceUrls = new Map<string, string>();
  private readonly inFlight = new Set<Promise<void>>();
  private server?: http.Server;
  private boundPort: number | null = null;
  private tokenCache?: CachedToken;
  private tokenPromise?: Promise<string>;

  constructor(
    private readonly config: GatewayConfig,
    private readonly options: TeamsAdapterOptions = {},
  ) {
    super();
    const cfg = config.teams;
    if (!cfg) {
      throw new Error(
        "Teams channel is not configured (TEAMS_WEBHOOK_SECRET, TEAMS_APP_ID/TEAMS_APP_PASSWORD, TEAMS_INCOMING_WEBHOOK_URL)",
      );
    }
    this.teamsConfig = cfg;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  }

  getPort(): number | null {
    return this.boundPort;
  }

  async start(onMessage: InboundHandler): Promise<void> {
    const cfg = this.teamsConfig;
    const host = cfg.webhookHost || "127.0.0.1";
    if (!isLoopbackHost(host) && !cfg.webhookSecret) {
      throw new Error(
        `Teams refuses to listen on non-loopback host "${host}" without TEAMS_WEBHOOK_SECRET`,
      );
    }
    this.handler = onMessage;

    const server = http.createServer((req, res) => {
      void this.route(req, res).catch((err) => {
        const status = err instanceof HttpError ? err.status : 500;
        if (!(err instanceof HttpError)) {
          this.noteError(err);
        }
        this.json(res, status, {
          ok: false,
          error: err instanceof HttpError ? err.message : "internal error",
        });
      });
    });
    configureHttpServerTimeouts(server, { requestTimeoutMs: 30_000 });
    this.server = server;

    try {
      this.boundPort = await listenHttpServer(server, cfg.webhookPort, host);
    } catch (err) {
      this.server = undefined;
      this.handler = undefined;
      throw err;
    }
    this.setConnected(true);
  }

  async stop(): Promise<void> {
    this.setConnected(false);
    this.dedupe.clear();
    this.serviceUrls.clear();
    this.tokenCache = undefined;
    this.tokenPromise = undefined;
    const server = this.server;
    this.server = undefined;
    this.boundPort = null;
    this.handler = undefined;
    await closeHttpServer(server);
    await Promise.allSettled(this.inFlight);
    this.inFlight.clear();
  }

  // ------------------------------------------------------------------ HTTP

  private get webhookPath(): string {
    const configured = this.teamsConfig.webhookPath?.trim() || DEFAULT_WEBHOOK_PATH;
    return configured.startsWith("/") ? configured : `/${configured}`;
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    if (res.headersSent) {
      return;
    }
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
      ...(status === 413 ? { connection: "close" } : {}),
    });
    res.end(payload);
  }

  private async readBody(req: http.IncomingMessage): Promise<Buffer> {
    const limit = this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    return readBoundedHttpBody(req, limit, () => new HttpError(413, "request body too large"));
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = parseRequestUrl(req.url, () => new HttpError(400, "invalid request URL"));
    const method = req.method ?? "GET";

    if (url.pathname === "/teams/health") {
      if (method !== "GET") {
        throw new HttpError(405, "method not allowed");
      }
      this.json(res, 200, { ok: true, channel: "teams" });
      return;
    }

    if (url.pathname !== this.webhookPath) {
      throw new HttpError(404, "not found");
    }
    if (method !== "POST") {
      throw new HttpError(405, "method not allowed");
    }

    const raw = await this.readBody(req);
    const header = req.headers.authorization;
    const authorization = Array.isArray(header) ? (header[0] ?? "") : (header ?? "");
    if (
      !this.teamsConfig.webhookSecret ||
      !verifyTeamsHmac(this.teamsConfig.webhookSecret, raw, authorization)
    ) {
      throw new HttpError(401, "invalid HMAC signature");
    }

    let activity: TeamsActivity;
    try {
      activity = JSON.parse(raw.toString("utf8")) as TeamsActivity;
    } catch {
      throw new HttpError(400, "invalid JSON body");
    }
    if (!activity || typeof activity !== "object" || Array.isArray(activity)) {
      throw new HttpError(400, "body must be a JSON object");
    }

    this.json(res, 200, { ok: true });
    const task = this.handleActivity(activity).finally(() => {
      this.inFlight.delete(task);
    });
    this.inFlight.add(task);
  }

  // --------------------------------------------------------------- inbound

  private async handleActivity(activity: TeamsActivity): Promise<void> {
    try {
      if (activity.type !== "message") {
        return;
      }
      const chatId =
        typeof activity.conversation?.id === "string" ? activity.conversation.id : "";
      if (!chatId) {
        return;
      }
      const activityId =
        typeof activity.id === "string" && activity.id ? activity.id : randomUUID();
      if (this.dedupe.seen(activityId)) {
        return;
      }
      if (typeof activity.serviceUrl === "string" && activity.serviceUrl) {
        this.cacheServiceUrl(chatId, activity.serviceUrl);
      }

      const rawText = typeof activity.text === "string" ? activity.text : "";
      const recipientId = activity.recipient?.id;
      const hadMentionTag =
        /<at>[\s\S]*?<\/at>/i.test(rawText) ||
        (Array.isArray(activity.entities) &&
          activity.entities.some(
            (entity) =>
              entity?.type === "mention" &&
              (!recipientId || !entity.mentioned?.id || entity.mentioned.id === recipientId),
          ));
      const text = rawText
        .replace(/<at>[\s\S]*?<\/at>/gi, "")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
      if (!text) {
        return;
      }

      const senderId =
        typeof activity.from?.id === "string" && activity.from.id
          ? activity.from.id
          : chatId;
      const conversationType = activity.conversation?.conversationType;
      const isGroup =
        conversationType === "channel" ||
        conversationType === "groupChat" ||
        activity.conversation?.isGroup === true;
      const parsedTimestamp = Date.parse(activity.timestamp ?? "");
      const timestamp = Number.isFinite(parsedTimestamp) ? parsedTimestamp : Date.now();

      const inbound: InboundMessage & { metadata: Record<string, unknown> } = {
        id: activityId,
        channel: this.name,
        chatId,
        senderId,
        rawSenderId: activity.from?.id ?? senderId,
        isGroup,
        text,
        attachments: [],
        replyToMessageId:
          typeof activity.replyToId === "string" ? activity.replyToId : undefined,
        timestamp,
        mentionsBot: !isGroup || hadMentionTag || isMentioned(text, this.config.groupMentionPatterns),
        raw: activity,
        metadata: {
          serviceUrl: activity.serviceUrl,
          channelData: activity.channelData,
          fromName: activity.from?.name,
          conversationType,
        },
      };
      await this.emit(inbound);
    } catch (err) {
      this.noteError(err);
    }
  }

  private cacheServiceUrl(conversationId: string, serviceUrl: string): void {
    const normalized = serviceUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(normalized)) {
      return;
    }
    rememberBounded(this.serviceUrls, conversationId, normalized, MAX_SERVICE_URL_ENTRIES);
  }

  // ------------------------------------------------------------------ auth

  private async getAccessToken(): Promise<string> {
    const cfg = this.teamsConfig;
    if (!cfg.appId || !cfg.appPassword) {
      throw new Error("Teams app credentials are not configured (TEAMS_APP_ID, TEAMS_APP_PASSWORD)");
    }
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt > now) {
      return this.tokenCache.token;
    }
    if (!this.tokenPromise) {
      this.tokenPromise = this.requestAccessToken().finally(() => {
        this.tokenPromise = undefined;
      });
    }
    return this.tokenPromise;
  }

  private async requestAccessToken(): Promise<string> {
    const cfg = this.teamsConfig;
    const tenant = cfg.tenantId || "botframework.com";
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: cfg.appId,
      client_secret: cfg.appPassword,
      scope: BOT_FRAMEWORK_SCOPE,
    }).toString();

    let res: Response;
    try {
      res = await this.fetchImpl(
        `${LOGIN_BASE}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        },
      );
    } catch (err) {
      this.noteError(err);
      throw err;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const err = new Error(
        `Teams OAuth token request failed with HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      );
      this.noteError(err);
      throw err;
    }
    const data = (await res.json().catch(() => undefined)) as
      | { access_token?: unknown; expires_in?: unknown }
      | undefined;
    if (typeof data?.access_token !== "string" || !data.access_token) {
      const err = new Error("Teams OAuth token response did not include access_token");
      this.noteError(err);
      throw err;
    }
    const expiresInSec = Number(data.expires_in);
    const ttlMs =
      Number.isFinite(expiresInSec) && expiresInSec > 0 ? expiresInSec * 1000 : 3_600_000;
    this.tokenCache = {
      token: data.access_token,
      expiresAt: Date.now() + Math.max(0, ttlMs - TOKEN_EXPIRY_BUFFER_MS),
    };
    return data.access_token;
  }

  // -------------------------------------------------------------- outbound

  async sendMessage(msg: OutboundMessage): Promise<{ messageId?: string } | void> {
    const chunks = chunkText(msg.text ?? "", MAX_TEXT_CHARS);
    if (chunks.length === 0) {
      return;
    }
    const cfg = this.teamsConfig;
    const serviceUrl = this.serviceUrls.get(msg.chatId);

    if (serviceUrl && cfg.appId && cfg.appPassword) {
      const token = await this.getAccessToken();
      let lastMessageId: string | undefined;
      for (const [index, chunk] of chunks.entries()) {
        const activity: Record<string, unknown> = { type: "message", text: chunk };
        if (index === 0 && msg.replyToMessageId) {
          activity.replyToId = msg.replyToMessageId;
        }
        if (msg.markdown) {
          activity.textFormat = "markdown";
        }
        lastMessageId =
          (await this.postActivity(serviceUrl, msg.chatId, token, activity)) ?? lastMessageId;
      }
      this.noteOutbound();
      return lastMessageId ? { messageId: lastMessageId } : undefined;
    }

    if (cfg.incomingWebhookUrl) {
      for (const chunk of chunks) {
        await this.postIncomingWebhook(cfg.incomingWebhookUrl, chunk);
      }
      this.noteOutbound();
      return;
    }

    const err = new Error(
      "Teams channel cannot send: no cached Bot Framework serviceUrl for this conversation and TEAMS_INCOMING_WEBHOOK_URL is not configured",
    );
    this.noteError(err);
    throw err;
  }

  private async postActivity(
    serviceUrl: string,
    chatId: string,
    token: string,
    activity: Record<string, unknown>,
  ): Promise<string | undefined> {
    const url = `${serviceUrl}/v3/conversations/${encodeURIComponent(chatId)}/activities`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(activity),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (err) {
      this.noteError(err);
      throw err;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const err = new Error(
        `Teams Bot Framework responded HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      );
      this.noteError(err);
      throw err;
    }
    const body = (await res.json().catch(() => undefined)) as { id?: unknown } | undefined;
    return typeof body?.id === "string" ? body.id : undefined;
  }

  private async postIncomingWebhook(url: string, text: string): Promise<void> {
    const payload = {
      "@type": "MessageCard",
      "@context": "https://schema.org/extensions",
      text,
    };
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (err) {
      this.noteError(err);
      throw err;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const err = new Error(
        `Teams incoming webhook responded HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      );
      this.noteError(err);
      throw err;
    }
  }
}

export function createAdapter(config: GatewayConfig): ChannelAdapter {
  return new TeamsChannelAdapter(config);
}