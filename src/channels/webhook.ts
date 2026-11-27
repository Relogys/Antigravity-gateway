import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { GatewayConfig } from "../config.js";
import type {
  AttachmentKind,
  ChannelAdapter,
  InboundAttachment,
  OutboundAttachment,
  OutboundMessage,
} from "../types.js";
import { BaseChannelAdapter, type InboundHandler } from "./base.js";
import {
  BoundedDedupeCache,
  closeHttpServer,
  configureHttpServerTimeouts,
  errorMessage,
  isLoopbackHost,
  listenHttpServer,
  parseRequestUrl,
  readBoundedHttpBody,
  saveInboundMedia,
} from "./utils.js";

export { isLoopbackHost };

/* eslint-disable @typescript-eslint/no-explicit-any */

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 18791;
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_OUTBOUND_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const MAX_WAIT_TIMEOUT_MS = 600_000;
const MAX_SSE_CLIENTS = 100;

export interface WebhookAdapterOptions {
  fetchImpl?: typeof fetch;
  /** Silence window (after the first reply, while the turn is running) that ends a `wait` call. */
  idleMs?: number;
  /** After the gateway finished handling a message with zero replies, keep waiting this long. */
  noReplyGraceMs?: number;
  /** Short settle window after the handler finished and replies exist. */
  settleMs?: number;
  maxBodyBytes?: number;
  mediaDir?: string;
  /** Clock injection for replay/timestamp checks (default `Date.now`). */
  nowFn?: () => number;
}

export interface WebhookReply {
  messageId: string;
  chatId: string;
  text: string;
  markdown?: boolean;
  replyToMessageId?: string;
  attachments: Array<{
    name?: string;
    mimeType?: string;
    url?: string;
    dataBase64?: string;
    error?: string;
  }>;
  timestamp: number;
}

interface Waiter {
  chatId: string;
  replies: WebhookReply[];
  onReply: () => void;
  cancel: () => void;
}

interface SseClient {
  res: http.ServerResponse;
  chatId?: string;
  cleanup: () => void;
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** `sha256=<hex>` HMAC-SHA256 signature over `body` (used for inbound auth and callbacks). */
export function signWebhookBody(secret: string, body: string | Buffer): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/**
 * `sha256=<hex>` replay-resistant signature over `<timestamp>.<deliveryId>.<body>`.
 * Falls back to {@link signWebhookBody} when no timestamp is supplied.
 */
export function signWebhookRequest(
  secret: string,
  body: string | Buffer,
  timestamp?: string | number,
  deliveryId?: string,
): string {
  const ts = timestamp === undefined ? "" : String(timestamp).trim();
  if (!ts) {
    return signWebhookBody(secret, body);
  }
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  const prefix = Buffer.from(`${ts}.${deliveryId ?? ""}.`, "utf8");
  return `sha256=${createHmac("sha256", secret)
    .update(Buffer.concat([prefix, bodyBuf]))
    .digest("hex")}`;
}

/** Parse a `x-webhook-timestamp` value (Unix seconds or milliseconds) into milliseconds. */
function parseTimestampMs(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value < 1e12 ? value * 1000 : value;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function attachmentKind(mime: string | undefined, name: string | undefined): AttachmentKind {
  const m = mime ?? "";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  if (/\.(png|jpe?g|gif|webp)$/i.test(name ?? "")) return "image";
  return mime || name ? "file" : "other";
}

export class WebhookChannelAdapter extends BaseChannelAdapter {
  readonly name = "webhook";

  private server?: http.Server;
  private boundPort: number | null = null;
  private readonly waiters = new Set<Waiter>();
  private readonly sseClients = new Set<SseClient>();
  private readonly fetchImpl: typeof fetch;
  private readonly mediaDir: string;
  private readonly nowFn: () => number;
  private readonly replayCache = new BoundedDedupeCache({
    maxEntries: 5000,
    ttlMs: 15 * 60 * 1000,
  });

  constructor(
    private readonly config: GatewayConfig,
    private readonly options: WebhookAdapterOptions = {},
  ) {
    super();
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.mediaDir = options.mediaDir ?? path.join(config.dataDir, "media");
    this.nowFn = options.nowFn ?? Date.now;
  }

  getPort(): number | null {
    return this.boundPort;
  }

  async start(onMessage: InboundHandler): Promise<void> {
    const cfg = this.config.webhook;
    if (!cfg) {
      throw new Error("Webhook channel is not configured (WEBHOOK_* env)");
    }
    const host = cfg.host || DEFAULT_HOST;
    if (!isLoopbackHost(host) && !cfg.token && !cfg.secret) {
      throw new Error(
        `Webhook refuses to listen on non-loopback host "${host}" without WEBHOOK_TOKEN or WEBHOOK_SECRET`,
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
    configureHttpServerTimeouts(server, { requestTimeoutMs: 0 });
    this.server = server;

    try {
      this.boundPort = await listenHttpServer(server, cfg.port ?? DEFAULT_PORT, host);
    } catch (err) {
      this.server = undefined;
      this.handler = undefined;
      throw err;
    }
    this.setConnected(true);
  }

  async stop(): Promise<void> {
    this.setConnected(false);
    for (const waiter of [...this.waiters]) {
      waiter.cancel();
    }
    this.waiters.clear();
    for (const client of [...this.sseClients]) {
      client.cleanup();
      if (!client.res.destroyed && !client.res.writableEnded) {
        client.res.end();
      }
    }
    this.sseClients.clear();
    const server = this.server;
    this.server = undefined;
    this.boundPort = null;
    this.handler = undefined;
    await closeHttpServer(server);
  }

  // ---------------------------------------------------------------- HTTP

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

  private checkBearer(req: http.IncomingMessage): boolean {
    const token = this.config.webhook?.token;
    if (!token) {
      return true;
    }
    const header = req.headers.authorization ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(header);
    return Boolean(m) && safeEqual((m as RegExpExecArray)[1].trim(), token);
  }

  private headerValue(req: http.IncomingMessage, name: string): string | undefined {
    const raw = req.headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  }

  /**
   * Verify signature, timestamp freshness, and (last) replay uniqueness.
   * Throws `HttpError` on failure; a `true` return means the request is authenticated.
   */
  private verifyInboundAuth(
    req: http.IncomingMessage,
    body: Buffer,
    isMessages: boolean,
  ): void {
    const cfg = this.config.webhook;
    const secret = cfg?.secret;
    const rawTimestamp = this.headerValue(req, "x-webhook-timestamp");
    const deliveryId =
      this.headerValue(req, "x-webhook-id") ?? this.headerValue(req, "x-webhook-nonce");

    if (secret) {
      const provided = this.headerValue(req, "x-webhook-signature")?.toLowerCase();
      if (!provided) {
        throw new HttpError(401, "unauthorized");
      }
      const expected =
        rawTimestamp !== undefined
          ? signWebhookRequest(secret, body, rawTimestamp, deliveryId ?? "")
          : signWebhookBody(secret, body);
      if (!safeEqual(provided, expected)) {
        throw new HttpError(401, "unauthorized");
      }
    }

    // Presence/format enforcement for strict mode (POST only; SSE subscribes never need it).
    if (isMessages && cfg?.requireTimestamp === true) {
      const tsMs = rawTimestamp === undefined ? undefined : parseTimestampMs(rawTimestamp);
      if (rawTimestamp === undefined || tsMs === undefined || deliveryId === undefined) {
        throw new HttpError(401, "timestamp and delivery id required");
      }
    }

    // Freshness applies whenever a timestamp is supplied.
    if (rawTimestamp !== undefined) {
      const tsMs = parseTimestampMs(rawTimestamp);
      const windowMs = (cfg?.replayWindowSec ?? 300) * 1000;
      if (tsMs === undefined || Math.abs(this.nowFn() - tsMs) > windowMs) {
        throw new HttpError(401, "webhook timestamp outside allowed window");
      }
    }

    if (!isMessages) {
      return;
    }

    // Only record the delivery id once auth + freshness passed, so spoofed requests
    // cannot poison the replay cache for the legitimate sender.
    if (deliveryId !== undefined && this.replayCache.seen(deliveryId, this.nowFn())) {
      throw new HttpError(409, "duplicate webhook delivery");
    }
  }

  private async readBody(req: http.IncomingMessage): Promise<Buffer> {
    const limit = this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    return readBoundedHttpBody(req, limit, () => new HttpError(413, "request body too large"));
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = parseRequestUrl(req.url, () => new HttpError(400, "invalid request URL"));
    const method = req.method ?? "GET";

    if (url.pathname === "/v1/health") {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      this.json(res, 200, { ok: true, channel: "webhook" });
      return;
    }

    const isMessages = url.pathname === "/v1/messages";
    const isEvents = url.pathname === "/v1/events";
    if (!isMessages && !isEvents) {
      throw new HttpError(404, "not found");
    }
    if ((isMessages && method !== "POST") || (isEvents && method !== "GET")) {
      throw new HttpError(405, "method not allowed");
    }

    if (!this.checkBearer(req)) {
      throw new HttpError(401, "unauthorized");
    }
    const body = isMessages ? await this.readBody(req) : Buffer.alloc(0);
    this.verifyInboundAuth(req, body, isMessages);

    if (isEvents) {
      this.openEventStream(req, res, url.searchParams.get("chatId") ?? undefined);
      return;
    }
    await this.handlePost(res, body);
  }

  private openEventStream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    chatId: string | undefined,
  ): void {
    if (this.sseClients.size >= MAX_SSE_CLIENTS) {
      throw new HttpError(503, "too many SSE listeners");
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    let client: SseClient;
    const cleanup = () => {
      clearInterval(heartbeat);
      this.sseClients.delete(client);
    };
    const writeSafe = (chunk: string) => {
      if (res.destroyed || res.writableEnded) {
        cleanup();
        return;
      }
      try {
        res.write(chunk);
      } catch {
        cleanup();
      }
    };
    const heartbeat = setInterval(() => writeSafe(": ping\n\n"), 25_000);
    heartbeat.unref();
    client = { res, chatId, cleanup };
    this.sseClients.add(client);
    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
    writeSafe(": connected\n\n");
  }

  private async handlePost(res: http.ServerResponse, raw: Buffer): Promise<void> {
    if (!this.handler) {
      throw new HttpError(503, "gateway not ready");
    }
    let body: any;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new HttpError(400, "invalid JSON body");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new HttpError(400, "body must be a JSON object");
    }
    const chatId = typeof body.chatId === "string" ? body.chatId.trim() : "";
    if (!chatId || chatId.length > 256) {
      throw new HttpError(400, "chatId is required (string, max 256 chars)");
    }
    const text = typeof body.text === "string" ? body.text : "";
    const fixedSenderId = this.config.webhook?.fixedSenderId?.trim();
    const senderId = fixedSenderId
      ? fixedSenderId
      : typeof body.senderId === "string" && body.senderId.trim()
        ? body.senderId.trim()
        : chatId;
    const hasAttachments = Array.isArray(body.attachments) && body.attachments.length > 0;
    if (!text.trim() && !hasAttachments) {
      throw new HttpError(400, "text or attachments required");
    }

    const messageId = randomUUID();
    const attachments = await this.parseInboundAttachments(messageId, body.attachments);

    const msg = {
      id: messageId,
      channel: this.name,
      chatId,
      senderId,
      isGroup: body.isGroup === true,
      text,
      attachments,
      replyToMessageId:
        typeof body.replyToMessageId === "string" ? body.replyToMessageId : undefined,
      timestamp: Date.now(),
      mentionsBot: true,
    };

    if (body.wait !== true) {
      void this.emit(msg);
      this.json(res, 202, { ok: true, messageId });
      return;
    }

    const timeoutMs = Math.min(
      MAX_WAIT_TIMEOUT_MS,
      Math.max(50, Number(body.timeoutMs) || DEFAULT_WAIT_TIMEOUT_MS),
    );
    const result = await this.emitAndCollect(msg, timeoutMs);
    this.json(res, 200, {
      ok: true,
      messageId,
      replies: result.replies,
      ...(result.timedOut ? { timedOut: true } : {}),
    });
  }

  private async parseInboundAttachments(
    messageId: string,
    raw: unknown,
  ): Promise<InboundAttachment[]> {
    if (!Array.isArray(raw)) {
      return [];
    }
    if (raw.length > 10) {
      throw new HttpError(400, "at most 10 attachments per message");
    }
    const out: InboundAttachment[] = [];
    for (const [i, item] of raw.entries()) {
      if (!item || typeof item !== "object") {
        throw new HttpError(400, "invalid attachment");
      }
      const name = typeof item.name === "string" ? item.name : undefined;
      const mimeType = typeof item.mimeType === "string" ? item.mimeType : undefined;
      const att: InboundAttachment = { type: attachmentKind(mimeType, name), name, mimeType };
      if (typeof item.dataBase64 === "string") {
        const data = Buffer.from(item.dataBase64, "base64");
        att.sizeBytes = data.byteLength;
        att.localPath = await saveInboundMedia(
          this.mediaDir,
          this.name,
          messageId,
          name ?? `attachment-${i}`,
          data,
        );
      } else if (typeof item.url === "string") {
        att.url = item.url;
      } else {
        throw new HttpError(400, "attachment needs dataBase64 or url");
      }
      out.push(att);
    }
    return out;
  }

  /** Run the handler while buffering replies for `msg.chatId` until they go quiet. */
  private emitAndCollect(
    msg: Parameters<WebhookChannelAdapter["emit"]>[0],
    timeoutMs: number,
  ): Promise<{ replies: WebhookReply[]; timedOut: boolean }> {
    const idleMs = this.options.idleMs ?? 2000;
    const graceMs = this.options.noReplyGraceMs ?? 3000;
    const settleMs = this.options.settleMs ?? 100;

    return new Promise((resolve) => {
      let finished = false;
      let emitDone = false;
      let timer: NodeJS.Timeout | undefined;
      let hardTimeout: NodeJS.Timeout | undefined;

      const finish = (timedOut: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(hardTimeout);
        this.waiters.delete(waiter);
        resolve({ replies: waiter.replies, timedOut });
      };
      const waiter: Waiter = {
        chatId: msg.chatId,
        replies: [],
        onReply: () => schedule(),
        cancel: () => finish(true),
      };
      const schedule = () => {
        if (finished) return;
        clearTimeout(timer);
        if (waiter.replies.length > 0) {
          timer = setTimeout(() => finish(false), emitDone ? settleMs : idleMs);
        } else if (emitDone) {
          timer = setTimeout(() => finish(false), graceMs);
        }
      };
      hardTimeout = setTimeout(() => finish(true), timeoutMs);
      hardTimeout.unref?.();

      this.waiters.add(waiter);
      void this.emit(msg).finally(() => {
        emitDone = true;
        schedule();
      });
    });
  }

  // -------------------------------------------------------------- outbound

  async sendMessage(msg: OutboundMessage): Promise<{ messageId?: string } | void> {
    const attachments: WebhookReply["attachments"] = [];
    for (const att of msg.attachments ?? []) {
      attachments.push(await this.encodeAttachment(att));
    }
    const reply: WebhookReply = {
      messageId: randomUUID(),
      chatId: msg.chatId,
      text: msg.text ?? "",
      ...(msg.markdown ? { markdown: true } : {}),
      ...(msg.replyToMessageId ? { replyToMessageId: msg.replyToMessageId } : {}),
      attachments,
      timestamp: Date.now(),
    };

    let waited = false;
    for (const waiter of this.waiters) {
      if (waiter.chatId === msg.chatId) {
        waiter.replies.push(reply);
        waiter.onReply();
        waited = true;
      }
    }

    const frame = `event: message\ndata: ${JSON.stringify(reply)}\n\n`;
    for (const client of [...this.sseClients]) {
      if (!client.chatId || client.chatId === msg.chatId) {
        if (client.res.destroyed || client.res.writableEnded) {
          client.cleanup();
          continue;
        }
        try {
          client.res.write(frame);
        } catch {
          client.cleanup();
        }
      }
    }

    const callbackUrl = this.config.webhook?.callbackUrl;
    if (!waited && callbackUrl) {
      await this.postCallback(callbackUrl, reply);
    }
    this.noteOutbound();
    return { messageId: reply.messageId };
  }

  private async encodeAttachment(att: OutboundAttachment): Promise<WebhookReply["attachments"][number]> {
    const base = {
      name: att.name ?? (att.path ? path.basename(att.path) : undefined),
      mimeType: att.mimeType,
    };
    try {
      let data: Buffer | undefined = att.buffer;
      if (!data && att.path) {
        data = await readFile(att.path);
      }
      if (data) {
        if (data.byteLength > MAX_OUTBOUND_ATTACHMENT_BYTES) {
          return { ...base, error: "attachment too large to inline" };
        }
        return { ...base, dataBase64: data.toString("base64") };
      }
      if (att.url) {
        return { ...base, url: att.url };
      }
      return { ...base, error: "attachment has no data" };
    } catch (err) {
      return { ...base, error: errorMessage(err) };
    }
  }

  private async postCallback(url: string, reply: WebhookReply): Promise<void> {
    const payload = JSON.stringify(reply);
    const headers: Record<string, string> = { "content-type": "application/json" };
    const secret = this.config.webhook?.secret;
    if (secret) {
      headers["x-webhook-signature"] = signWebhookBody(secret, payload);
    }
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: payload,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        throw new Error(`callback responded HTTP ${res.status}`);
      }
    } catch (err) {
      this.noteError(err);
    }
  }
}

export function createAdapter(config: GatewayConfig): ChannelAdapter {
  return new WebhookChannelAdapter(config);
}
