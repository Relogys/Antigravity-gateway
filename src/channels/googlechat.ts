import { randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { GatewayConfig } from "../config.js";
import type {
  AttachmentKind,
  ChannelAdapter,
  InboundAttachment,
  InboundMessage,
  OutboundMessage,
} from "../types.js";
import { BaseChannelAdapter, type InboundHandler } from "./base.js";
import { chunkText, isMentioned } from "./utils.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const CHAT_API_BASE = "https://chat.googleapis.com/v1";
const MAX_TEXT_CHARS = 4096;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PATH = "/googlechat";
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_SEND_TIMEOUT_MS = 15_000;
const MAX_THREADS = 1000;
const ADDED_TO_SPACE_REPLY =
  "Thanks for adding me! Mention me with a message to get started.";
const LEADING_MENTION_RE = /^\s*(?:<users\/[^>\s]+>|@[^\s]+)\s*/i;

export interface GoogleChatConfig {
  enabled: boolean;
  webhookUrl: string;
  accessToken: string;
  verificationToken: string;
  webhookHost: string;
  webhookPort: number;
  webhookPath: string;
}

export interface GoogleChatAdapterOptions {
  fetchImpl?: typeof fetch;
  maxBodyBytes?: number;
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
  }

  getPort(): number | null {
    return this.boundPort;
  }

  async start(onMessage: InboundHandler): Promise<void> {
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
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once("error", onError);
      server.listen(this.cfg.webhookPort, this.cfg.webhookHost || DEFAULT_HOST, () => {
        server.off("error", onError);
        resolve();
      });
    });
    this.boundPort = (server.address() as AddressInfo).port;
    this.setConnected(true);
  }

  async stop(): Promise<void> {
    this.setConnected(false);
    this.threads.clear();
    const server = this.server;
    this.server = undefined;
    this.boundPort = null;
    this.handler = undefined;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    }
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
    });
    res.end(payload);
  }

  private async readBody(req: http.IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      total += buf.byteLength;
      if (total > this.maxBodyBytes) {
        throw new HttpError(413, "request body too large");
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
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
    if (!this.verifyToken(event, req)) {
      throw new HttpError(401, "unauthorized");
    }

    if (event.type === "ADDED_TO_SPACE") {
      this.json(res, 200, { text: ADDED_TO_SPACE_REPLY });
      return;
    }

    this.json(res, 200, {});
    if (event.type === "MESSAGE") {
      void this.handleMessageEvent(event).catch((err) => this.noteError(err));
    }
  }

  private verifyToken(event: GoogleChatEvent, req: http.IncomingMessage): boolean {
    const expected = this.cfg.verificationToken;
    if (!expected) {
      return true;
    }
    if (typeof event.token === "string" && safeEqual(event.token, expected)) {
      return true;
    }
    const header = req.headers.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    const match = /^Bearer\s+(.+)$/i.exec(value ?? "");
    return Boolean(match) && safeEqual((match as RegExpExecArray)[1].trim(), expected);
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

    const messageId = message.name?.trim() || randomUUID();
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
    this.threads.delete(spaceName);
    this.threads.set(spaceName, threadName);
    while (this.threads.size > MAX_THREADS) {
      const oldest = this.threads.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.threads.delete(oldest);
    }
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
      if (this.cfg.accessToken && msg.chatId.startsWith("spaces/")) {
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