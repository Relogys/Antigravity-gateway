import {
  createPublicKey,
  randomUUID,
  timingSafeEqual,
  verify as verifySignature,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import http from "node:http";
import type { GatewayConfig } from "../config.js";
import type {
  AttachmentKind,
  ChannelAdapter,
  InboundAttachment,
  InboundMessage,
  OutboundMessage,
} from "../types.js";
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

/* eslint-disable @typescript-eslint/no-explicit-any */

const CHAT_API_BASE = "https://chat.googleapis.com/v1";
const MAX_TEXT_CHARS = 4096;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PATH = "/googlechat";
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_SEND_TIMEOUT_MS = 15_000;
const MAX_THREADS = 1000;
const DEFAULT_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/chat@system.gserviceaccount.com";
const CHAT_OIDC_ISSUER = "chat@system.gserviceaccount.com";
const DEFAULT_JWKS_CACHE_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;
const ADDED_TO_SPACE_REPLY =
  "Thanks for adding me! Mention me with a message to get started.";
const LEADING_MENTION_RE = /^\s*(?:<users\/[^>\s]+>|@[^\s]+)\s*/i;

export interface GoogleChatConfig {
  enabled: boolean;
  webhookUrl: string;
  accessToken: string;
  verificationToken: string;
  /** Expected `aud` claim (project number or endpoint URL) for Google Chat OIDC RS256 Bearer JWT verification. */
  audience?: string;
  /** Optional JWKS URL override for Google Chat OIDC verification. */
  jwksUrl?: string;
  webhookHost: string;
  webhookPort: number;
  webhookPath: string;
}

export interface GoogleChatAdapterOptions {
  fetchImpl?: typeof fetch;
  maxBodyBytes?: number;
  /** Clock injection for JWT expiry/skew checks (default `Date.now`). */
  nowFn?: () => number;
  /** How long fetched OIDC JWKS keys stay cached (default 1 hour). */
  jwksCacheTtlMs?: number;
}

export interface GoogleChatSendOptions {
  /** Chat REST thread resource name, e.g. `spaces/S/threads/T`. */
  threadName?: string;
  /** Incoming-webhook thread key. */
  threadKey?: string;
}

interface GoogleChatSpace {
  name?: string;
  type?: string;
  displayName?: string;
}

interface GoogleChatSender {
  name?: string;
  email?: string;
  displayName?: string;
  type?: string;
}

interface GoogleChatAttachment {
  name?: string;
  contentName?: string;
  contentType?: string;
  downloadUri?: string;
  source?: string;
}

interface GoogleChatMessage {
  name?: string;
  sender?: GoogleChatSender;
  createTime?: string;
  text?: string;
  argumentText?: string;
  thread?: { name?: string };
  attachment?: GoogleChatAttachment[];
}

interface GoogleChatEvent {
  type?: string;
  token?: string;
  eventTime?: string;
  space?: GoogleChatSpace;
  user?: GoogleChatSender;
  message?: GoogleChatMessage;
}

type GoogleChatInboundMessage = InboundMessage & {
  metadata?: { threadName?: string };
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function googleChatConfigOf(config: GatewayConfig): GoogleChatConfig | undefined {
  return (config as GatewayConfig & { googlechat?: GoogleChatConfig }).googlechat;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearerTokenOf(header: string | string[] | undefined): string | undefined {
  return extractAuthSchemeToken(header, "Bearer");
}

interface ParsedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
}

function decodeJwtSegment(segment: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function parseJwt(token: string): ParsedJwt | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return undefined;
  }
  const header = decodeJwtSegment(parts[0]!);
  const payload = decodeJwtSegment(parts[1]!);
  if (!header || !payload) {
    return undefined;
  }
  const signature = Buffer.from(parts[2]!, "base64url");
  if (signature.length === 0) {
    return undefined;
  }
  return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature };
}

function normalizeWebhookPath(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) {
    return DEFAULT_PATH;
  }
  return value.startsWith("/") ? value : `/${value}`;
}

function attachmentKindFor(mimeType: string | undefined): AttachmentKind {
  const type = (mimeType ?? "").toLowerCase();
  if (type.startsWith("image/")) {
    return "image";
  }
  if (type.startsWith("audio/")) {
    return "audio";
  }
  if (type.startsWith("video/")) {
    return "video";
  }
  return "file";
}

/**
 * Google Chat app adapter: receives events on an embedded HTTP webhook and replies
 * through the Chat REST API (service account access token) or an incoming webhook.
 */
export class GoogleChatChannelAdapter extends BaseChannelAdapter {
  readonly name = "googlechat";

  private readonly cfg: GoogleChatConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly webhookPath: string;
  private readonly maxBodyBytes: number;
  private readonly groupMentionPatterns: string[];
  private readonly threads = new Map<string, string>();
  private readonly dedupe = new BoundedDedupeCache();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly nowFn: () => number;
  private readonly jwksCacheTtlMs: number;
  private readonly jwksUrl: string;

  private jwksKeys = new Map<string, KeyObject>();
  private jwksFetchedAt = 0;
  private jwksFetchPromise?: Promise<void>;
  private server?: http.Server;
  private boundPort: number | null = null;

  constructor(
    private readonly config: GatewayConfig,
    private readonly options: GoogleChatAdapterOptions = {},
  ) {
    super();
    const cfg = googleChatConfigOf(config);
    if (!cfg) {
      throw new Error("Google Chat is not configured (GOOGLECHAT_* env)");
    }
    this.cfg = cfg;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.webhookPath = normalizeWebhookPath(cfg.webhookPath);
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.groupMentionPatterns = [...config.groupMentionPatterns];
    this.nowFn = options.nowFn ?? Date.now;
    this.jwksCacheTtlMs = options.jwksCacheTtlMs ?? DEFAULT_JWKS_CACHE_TTL_MS;
    this.jwksUrl = cfg.jwksUrl?.trim() || DEFAULT_JWKS_URL;
  }

  getPort(): number | null {
    return this.boundPort;
  }

  async start(onMessage: InboundHandler): Promise<void> {
    const host = this.cfg.webhookHost || DEFAULT_HOST;
    if (!isLoopbackHost(host) && !this.cfg.verificationToken && !this.cfg.audience) {
      throw new Error(
        `Google Chat refuses to listen on non-loopback host "${host}" without GOOGLECHAT_VERIFICATION_TOKEN or GOOGLECHAT_AUDIENCE`,
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
      this.boundPort = await listenHttpServer(server, this.cfg.webhookPort, host);
    } catch (err) {
      this.server = undefined;
      this.handler = undefined;
      throw err;
    }
    this.setConnected(true);
  }

  async stop(): Promise<void> {
    this.setConnected(false);
    this.threads.clear();
    this.dedupe.clear();
    const server = this.server;
    this.server = undefined;
    this.boundPort = null;
    this.handler = undefined;
    await closeHttpServer(server);
    await Promise.allSettled(this.inFlight);
    this.inFlight.clear();
  }

  // ------------------------------------------------------------------ HTTP

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
    return readBoundedHttpBody(
      req,
      this.maxBodyBytes,
      () => new HttpError(413, "request body too large"),
    );
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = parseRequestUrl(req.url, () => new HttpError(400, "invalid request URL"));
    if (url.pathname !== this.webhookPath) {
      throw new HttpError(404, "not found");
    }
    if ((req.method ?? "GET") !== "POST") {
      throw new HttpError(405, "method not allowed");
    }

    const raw = await this.readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new HttpError(400, "invalid JSON body");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpError(400, "body must be a JSON object");
    }
    const event = parsed as GoogleChatEvent;
    if (!(await this.verifyAuth(event, req))) {
      throw new HttpError(401, "unauthorized");
    }

    if (event.type === "ADDED_TO_SPACE") {
      this.json(res, 200, { text: ADDED_TO_SPACE_REPLY });
      return;
    }

    this.json(res, 200, {});
    if (event.type === "MESSAGE") {
      const task = this.handleMessageEvent(event)
        .catch((err) => this.noteError(err))
        .finally(() => {
          this.inFlight.delete(task);
        });
      this.inFlight.add(task);
    }
  }

  private async verifyAuth(
    event: GoogleChatEvent,
    req: http.IncomingMessage,
  ): Promise<boolean> {
    if (this.cfg.audience?.trim()) {
      if (await this.verifyOidcBearer(req)) {
        return true;
      }
      // OIDC failed: fall back to the legacy static token only when one is explicitly configured.
      if (!this.cfg.verificationToken) {
        return false;
      }
    }
    return this.verifyStaticToken(event, req);
  }

  private verifyStaticToken(event: GoogleChatEvent, req: http.IncomingMessage): boolean {
    const expected = this.cfg.verificationToken;
    if (!expected) {
      return false;
    }
    if (typeof event.token === "string" && safeEqual(event.token, expected)) {
      return true;
    }
    const provided = bearerTokenOf(req.headers.authorization);
    return provided !== undefined && safeEqual(provided, expected);
  }

  private async verifyOidcBearer(req: http.IncomingMessage): Promise<boolean> {
    const token = bearerTokenOf(req.headers.authorization);
    if (!token) {
      return false;
    }
    const jwt = parseJwt(token);
    if (!jwt) {
      return false;
    }
    if (jwt.header.alg !== "RS256") {
      return false;
    }
    const kid = typeof jwt.header.kid === "string" ? jwt.header.kid.trim() : "";
    if (!kid) {
      return false;
    }

    let keys: Map<string, KeyObject>;
    try {
      keys = await this.loadJwks(false);
    } catch {
      return false;
    }
    let key = keys.get(kid);
    if (!key) {
      // Google rotates signing keys: force a single JWKS refresh when an unknown kid arrives.
      try {
        keys = await this.loadJwks(true);
      } catch {
        return false;
      }
      key = keys.get(kid);
    }
    if (!key) {
      return false;
    }

    let signatureValid = false;
    try {
      signatureValid = verifySignature(
        "RSA-SHA256",
        Buffer.from(jwt.signingInput, "utf8"),
        key,
        jwt.signature,
      );
    } catch {
      return false;
    }
    if (!signatureValid) {
      return false;
    }
    return this.validateOidcClaims(jwt.payload);
  }

  private validateOidcClaims(payload: Record<string, unknown>): boolean {
    const expectedAudience = this.cfg.audience?.trim();
    if (!expectedAudience) {
      return false;
    }
    if (payload.iss !== CHAT_OIDC_ISSUER) {
      return false;
    }
    const aud = payload.aud;
    const audienceMatches =
      typeof aud === "string"
        ? aud === expectedAudience
        : Array.isArray(aud) && aud.includes(expectedAudience);
    if (!audienceMatches) {
      return false;
    }

    const nowSec = Math.floor(this.nowFn() / 1000);
    const exp = payload.exp;
    if (typeof exp !== "number" || !Number.isFinite(exp)) {
      return false;
    }
    if (nowSec > exp + CLOCK_SKEW_SECONDS) {
      return false;
    }
    if (payload.iat !== undefined) {
      if (typeof payload.iat !== "number" || !Number.isFinite(payload.iat)) {
        return false;
      }
      if (payload.iat > nowSec + CLOCK_SKEW_SECONDS) {
        return false;
      }
    }
    if (payload.nbf !== undefined) {
      if (typeof payload.nbf !== "number" || !Number.isFinite(payload.nbf)) {
        return false;
      }
      if (payload.nbf > nowSec + CLOCK_SKEW_SECONDS) {
        return false;
      }
    }
    return true;
  }

  private async loadJwks(forceRefresh: boolean): Promise<Map<string, KeyObject>> {
    const now = this.nowFn();
    const fresh = this.jwksKeys.size > 0 && now - this.jwksFetchedAt < this.jwksCacheTtlMs;
    if (fresh && !forceRefresh) {
      return this.jwksKeys;
    }
    if (!this.jwksFetchPromise) {
      this.jwksFetchPromise = this.fetchJwks()
        .then((keys) => {
          this.jwksKeys = keys;
          this.jwksFetchedAt = this.nowFn();
        })
        .finally(() => {
          this.jwksFetchPromise = undefined;
        });
    }
    await this.jwksFetchPromise;
    return this.jwksKeys;
  }

  private async fetchJwks(): Promise<Map<string, KeyObject>> {
    const res = await this.fetchImpl(this.jwksUrl, {
      signal: AbortSignal.timeout(DEFAULT_SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new HttpError(401, `JWKS endpoint responded HTTP ${res.status}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new HttpError(401, "invalid JWKS response");
    }
    const rawKeys = (body as { keys?: unknown } | null)?.keys;
    if (!Array.isArray(rawKeys)) {
      throw new HttpError(401, "invalid JWKS response");
    }
    const keys = new Map<string, KeyObject>();
    for (const jwk of rawKeys) {
      if (!jwk || typeof jwk !== "object") {
        continue;
      }
      const kid = (jwk as { kid?: unknown }).kid;
      if (typeof kid !== "string" || !kid) {
        continue;
      }
      try {
        keys.set(kid, createPublicKey({ key: jwk as JsonWebKey, format: "jwk" }));
      } catch {
        // Ignore malformed keys rather than failing the whole set.
      }
    }
    if (keys.size === 0) {
      throw new HttpError(401, "JWKS contained no usable keys");
    }
    return keys;
  }

  // --------------------------------------------------------------- inbound

  private async handleMessageEvent(event: GoogleChatEvent): Promise<void> {
    const message = event.message;
    const spaceName = event.space?.name?.trim();
    if (!message || !spaceName) {
      return;
    }
    const senderId = message.sender?.name?.trim() || message.sender?.email?.trim();
    if (!senderId) {
      return;
    }

    const rawName = message.name?.trim();
    if (rawName && this.dedupe.seen(rawName)) {
      return;
    }
    const messageId = rawName || randomUUID();
    const rawText =
      typeof message.argumentText === "string" && message.argumentText.trim()
        ? message.argumentText
        : (message.text ?? "");
    const hadLeadingMention = LEADING_MENTION_RE.test(rawText);
    const text = rawText.replace(LEADING_MENTION_RE, "").trim();

    const threadName = message.thread?.name?.trim() || undefined;
    if (threadName) {
      this.rememberThread(spaceName, threadName);
    }

    const attachments: InboundAttachment[] = [];
    for (const att of message.attachment ?? []) {
      if (!att || typeof att !== "object") {
        continue;
      }
      attachments.push({
        type: attachmentKindFor(att.contentType),
        name: att.contentName ?? att.name,
        mimeType: att.contentType,
        url: att.downloadUri,
      });
    }
    if (!text && attachments.length === 0) {
      return;
    }

    const spaceType = event.space?.type;
    const isGroup =
      Boolean(spaceType) && spaceType !== "DM" && spaceType !== "DIRECT_MESSAGE";
    const parsedTime = Date.parse(event.eventTime ?? message.createTime ?? "");
    const timestamp = Number.isFinite(parsedTime) ? parsedTime : Date.now();

    const inbound: GoogleChatInboundMessage = {
      id: messageId,
      channel: this.name,
      chatId: spaceName,
      senderId,
      isGroup,
      text,
      attachments,
      timestamp,
      mentionsBot:
        !isGroup || hadLeadingMention || isMentioned(text, this.groupMentionPatterns),
      raw: event,
      ...(threadName ? { metadata: { threadName } } : {}),
    };
    await this.emit(inbound);
  }

  private rememberThread(spaceName: string, threadName: string): void {
    rememberBounded(this.threads, spaceName, threadName, MAX_THREADS);
  }

  // -------------------------------------------------------------- outbound

  async sendMessage(
    msg: OutboundMessage,
    options: GoogleChatSendOptions = {},
  ): Promise<{ messageId?: string } | void> {
    const chunks = chunkText(msg.text ?? "", MAX_TEXT_CHARS);
    if (chunks.length === 0) {
      return;
    }
    const threadName = options.threadName ?? this.threads.get(msg.chatId);
    const threadKey = options.threadKey;

    let messageId: string | undefined;
    for (const chunk of chunks) {
      let body: { name?: string } | undefined;
      if (this.cfg.accessToken && /^spaces\/[A-Za-z0-9._-]+$/.test(msg.chatId)) {
        const endpoint = `${CHAT_API_BASE}/${msg.chatId}/messages`;
        const url = threadName
          ? `${endpoint}?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`
          : endpoint;
        const payload: Record<string, unknown> = { text: chunk };
        if (threadName) {
          payload.thread = { name: threadName };
        }
        body = await this.postJson(url, payload, {
          Authorization: `Bearer ${this.cfg.accessToken}`,
        });
      } else if (this.cfg.webhookUrl) {
        const payload: Record<string, unknown> = { text: chunk };
        if (threadKey) {
          payload.thread = { threadKey };
        }
        body = await this.postJson(this.cfg.webhookUrl, payload);
      } else {
        throw new Error(
          "Google Chat is not configured for sending (GOOGLECHAT_ACCESS_TOKEN or GOOGLECHAT_WEBHOOK_URL required)",
        );
      }
      if (body?.name !== undefined) {
        messageId = String(body.name);
      }
    }

    this.noteOutbound();
    return messageId !== undefined ? { messageId } : undefined;
  }

  private async postJson(
    url: string,
    payload: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ name?: string } | undefined> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(DEFAULT_SEND_TIMEOUT_MS),
      });
    } catch (err) {
      this.noteError(err);
      throw err;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const err = new Error(
        `Google Chat API responded HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      );
      this.noteError(err);
      throw err;
    }
    try {
      return (await res.json()) as { name?: string };
    } catch {
      return undefined;
    }
  }
}

export function createAdapter(config: GatewayConfig): ChannelAdapter {
  return new GoogleChatChannelAdapter(config);
}