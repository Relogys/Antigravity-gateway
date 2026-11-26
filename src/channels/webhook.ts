import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
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
import { errorMessage, saveInboundMedia } from "./utils.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 18791;
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_OUTBOUND_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const MAX_WAIT_TIMEOUT_MS = 600_000;

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
}

interface SseClient {
  res: http.ServerResponse;
  chatId?: string;
  heartbeat: NodeJS.Timeout;
}

/** True for loopback hosts (`127.0.0.0/8`, `localhost`, `::1`). */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
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

  constructor(
    private readonly config: GatewayConfig,
    private readonly options: WebhookAdapterOptions = {},
  ) {
    super();
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.mediaDir = options.mediaDir ?? path.join(config.dataDir, "media");
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
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once("error", onError);
      server.listen(cfg.port ?? DEFAULT_PORT, host, () => {
        server.off("error", onError);
        resolve();
      });
    });
    this.boundPort = (server.address() as AddressInfo).port;
    this.setConnected(true);
  }

  async stop(): Promise<void> {
    this.setConnected(false);
    for (const client of this.sseClients) {
      clearInterval(client.heartbeat);
      client.res.end();
    }
    this.sseClients.clear();
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

  // ---------------------------------------------------------------- HTTP

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

  private checkBearer(req: http.IncomingMessage): boolean {
    const token = this.config.webhook?.token;
    if (!token) {
      return true;
    }
    const header = req.headers.authorization ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(header);
    return Boolean(m) && safeEqual((m as RegExpExecArray)[1].trim(), token);
  }

  private checkSignature(req: http.IncomingMessage, body: Buffer): boolean {
    const secret = this.config.webhook?.secret;
    if (!secret) {
      return true;
    }
    const header = req.headers["x-webhook-signature"];
    const provided = (Array.isArray(header) ? header[0] : header)?.trim().toLowerCase();
    if (!provided) {
      return false;
    }
    return safeEqual(provided, signWebhookBody(secret, body));
  }

  private async readBody(req: http.IncomingMessage): Promise<Buffer> {
    const limit = this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      total += buf.byteLength;
      if (total > limit) {
        throw new HttpError(413, "request body too large");
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
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
    if (!this.checkSignature(req, body)) {
      throw new HttpError(401, "unauthorized");
    }

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
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
    heartbeat.unref();
    const client: SseClient = { res, chatId, heartbeat };
    this.sseClients.add(client);
    req.on("close", () => {
      clearInterval(heartbeat);
      this.sseClients.delete(client);
    });
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
    const senderId =
      typeof body.senderId === "string" && body.senderId.trim() ? body.senderId.trim() : chatId;
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
      const waiter: Waiter = { chatId: msg.chatId, replies: [], onReply: () => schedule() };

      const finish = (timedOut: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(hardTimeout);
        this.waiters.delete(waiter);
        resolve({ replies: waiter.replies, timedOut });
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
      const hardTimeout = setTimeout(() => finish(true), timeoutMs);

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
    for (const client of this.sseClients) {
      if (!client.chatId || client.chatId === msg.chatId) {
        client.res.write(frame);
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
