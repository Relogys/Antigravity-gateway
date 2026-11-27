import { createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";
import path from "node:path";
import type { GatewayConfig, LineConfig } from "../config.js";
import type {
  AttachmentKind,
  ChannelAdapter,
  InboundAttachment,
  OutboundMessage,
} from "../types.js";
import { BaseChannelAdapter, type InboundHandler } from "./base.js";
import { stripMarkdownToReadableText } from "./format.js";
import {
  BoundedDedupeCache,
  chunkText,
  closeHttpServer,
  configureHttpServerTimeouts,
  isMentioned,
  listenHttpServer,
  MAX_INLINE_MEDIA_BYTES,
  parseRequestUrl,
  readBoundedHttpBody,
  readResponseWithinLimit,
  rememberBounded,
  saveInboundMedia,
} from "./utils.js";

const API_BASE = "https://api.line.me";
const CONTENT_BASE = "https://api-data.line.me";
const MAX_TEXT_CHARS = 4800;
const MAX_MESSAGES_PER_REQUEST = 5;
const DEFAULT_REPLY_TOKEN_TTL_MS = 50_000;
const MAX_REPLY_TOKENS = 2000;
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS_PER_WEBHOOK = 100;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const SEND_TIMEOUT_MS = 15_000;

const MEDIA_KINDS: Readonly<Record<string, AttachmentKind>> = {
  image: "image",
  audio: "audio",
  file: "file",
};

export interface LineAdapterOptions {
  fetchImpl?: typeof fetch;
  mediaDir?: string;
  maxBodyBytes?: number;
  /** Reply-token freshness window (LINE tokens are single-use and short-lived). */
  replyTokenTtlMs?: number;
}

interface LineSource {
  type?: string;
  userId?: string;
  groupId?: string;
  roomId?: string;
}

interface LineMessage {
  id?: string;
  type?: string;
  text?: string;
  fileName?: string;
  fileSize?: number;
  quotedMessageId?: string;
  mention?: { mentionees?: Array<{ isSelf?: boolean; userId?: string }> };
}

interface LineEvent {
  type?: string;
  replyToken?: string;
  timestamp?: number;
  source?: LineSource;
  message?: LineMessage;
}

interface LineWebhookBody {
  destination?: string;
  events?: unknown[];
}

interface ReplyTokenEntry {
  token: string;
  expiresAt: number;
}

/** Verify the `x-line-signature` header: timing-safe Base64 HMAC-SHA256 of the raw body. */
export function verifyLineSignature(
  channelSecret: string,
  rawBody: Buffer,
  signatureHeader: string,
): boolean {
  if (!channelSecret || !signatureHeader.trim()) {
    return false;
  }
  const provided = Buffer.from(signatureHeader.trim(), "base64");
  if (provided.length === 0) {
    return false;
  }
  const expected = createHmac("sha256", channelSecret).update(rawBody).digest();
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

export class LineChannelAdapter extends BaseChannelAdapter {
  readonly name = "line";

  private readonly lineConfig: LineConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly mediaDir: string;
  private readonly replyTokenTtlMs: number;
  private readonly dedupe = new BoundedDedupeCache();
  private readonly replyTokens = new Map<string, ReplyTokenEntry>();
  private readonly inFlight = new Set<Promise<void>>();
  private lifecycle = new AbortController();
  private server?: http.Server;
  private boundPort: number | null = null;
  private botUserId?: string;

  constructor(
    private readonly config: GatewayConfig,
    private readonly options: LineAdapterOptions = {},
  ) {
    super();
    const cfg = config.line;
    if (!cfg) {
      throw new Error(
        "LINE channel is not configured (LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET)",
      );
    }
    this.lineConfig = cfg;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.mediaDir = options.mediaDir ?? path.join(config.dataDir, "media");
    this.replyTokenTtlMs = options.replyTokenTtlMs ?? DEFAULT_REPLY_TOKEN_TTL_MS;
  }

  getPort(): number | null {
    return this.boundPort;
  }

  async start(onMessage: InboundHandler): Promise<void> {
    const cfg = this.lineConfig;
    this.handler = onMessage;
    this.lifecycle = new AbortController();

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
      this.boundPort = await listenHttpServer(server, cfg.port, cfg.host);
    } catch (err) {
      this.server = undefined;
      this.handler = undefined;
      throw err;
    }
    this.setConnected(true);
  }

  async stop(): Promise<void> {
    this.setConnected(false);
    this.lifecycle.abort();
    this.replyTokens.clear();
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
    const limit = this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    return readBoundedHttpBody(req, limit, () => new HttpError(413, "request body too large"));
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = parseRequestUrl(req.url, () => new HttpError(400, "invalid request URL"));
    const method = req.method ?? "GET";

    if (url.pathname === "/line/health") {
      if (method !== "GET") {
        throw new HttpError(405, "method not allowed");
      }
      this.json(res, 200, { ok: true, channel: "line" });
      return;
    }

    if (url.pathname !== "/line/webhook") {
      throw new HttpError(404, "not found");
    }
    if (method !== "POST") {
      throw new HttpError(405, "method not allowed");
    }

    const raw = await this.readBody(req);
    const header = req.headers["x-line-signature"];
    const signature = Array.isArray(header) ? (header[0] ?? "") : (header ?? "");
    if (!verifyLineSignature(this.lineConfig.channelSecret, raw, signature)) {
      throw new HttpError(401, "invalid signature");
    }

    let body: LineWebhookBody;
    try {
      body = JSON.parse(raw.toString("utf8")) as LineWebhookBody;
    } catch {
      throw new HttpError(400, "invalid JSON body");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new HttpError(400, "body must be a JSON object");
    }
    if (typeof body.destination === "string" && body.destination) {
      this.botUserId = body.destination;
    }

    this.json(res, 200, { ok: true });
    if (Array.isArray(body.events)) {
      const task = this.handleEvents(body.events).finally(() => {
        this.inFlight.delete(task);
      });
      this.inFlight.add(task);
    }
  }

  // --------------------------------------------------------------- inbound

  private async handleEvents(events: unknown[]): Promise<void> {
    for (const event of events.slice(0, MAX_EVENTS_PER_WEBHOOK)) {
      try {
        await this.handleEvent(event as LineEvent);
      } catch (err) {
        this.noteError(err);
      }
    }
  }

  private async handleEvent(ev: LineEvent): Promise<void> {
    if (!ev || ev.type !== "message" || !ev.message?.id) {
      return;
    }
    const sourceType = ev.source?.type;
    if (sourceType !== "user" && sourceType !== "group" && sourceType !== "room") {
      return;
    }
    const chatId =
      sourceType === "user"
        ? ev.source?.userId
        : sourceType === "group"
          ? ev.source?.groupId
          : ev.source?.roomId;
    if (!chatId) {
      return;
    }
    const messageId = ev.message.id;
    if (this.dedupe.seen(messageId)) {
      return;
    }
    if (typeof ev.replyToken === "string" && ev.replyToken) {
      this.cacheReplyToken(chatId, ev.replyToken);
    }

    const isGroup = sourceType !== "user";
    const attachments: InboundAttachment[] = [];
    const kind = MEDIA_KINDS[ev.message.type ?? ""];
    if (kind) {
      attachments.push(await this.downloadContent(messageId, kind, ev.message));
    }
    const text = ev.message.type === "text" ? (ev.message.text ?? "") : "";
    if (!text.trim() && attachments.length === 0) {
      return;
    }

    const mentionsBot =
      !isGroup ||
      this.isBotMentioned(ev.message) ||
      isMentioned(text, this.config.groupMentionPatterns);

    await this.emit({
      id: messageId,
      channel: this.name,
      chatId,
      senderId: ev.source?.userId ?? chatId,
      isGroup,
      text,
      attachments,
      replyToMessageId:
        typeof ev.message.quotedMessageId === "string" ? ev.message.quotedMessageId : undefined,
      timestamp: typeof ev.timestamp === "number" ? ev.timestamp : Date.now(),
      mentionsBot,
      raw: ev,
    });
  }

  private isBotMentioned(message: LineMessage): boolean {
    const mentionees = message.mention?.mentionees;
    if (!Array.isArray(mentionees)) {
      return false;
    }
    return mentionees.some(
      (mentionee) =>
        mentionee?.isSelf === true ||
        (this.botUserId !== undefined && mentionee?.userId === this.botUserId),
    );
  }

  private async downloadContent(
    messageId: string,
    kind: AttachmentKind,
    message: LineMessage,
  ): Promise<InboundAttachment> {
    const name =
      kind === "file"
        ? (message.fileName ?? `file-${messageId}`)
        : kind === "image"
          ? `image-${messageId}.jpg`
          : `audio-${messageId}.m4a`;
    const attachment: InboundAttachment = { type: kind, name, sizeBytes: message.fileSize };
    const url = `${CONTENT_BASE}/v2/bot/message/${encodeURIComponent(messageId)}/content`;
    try {
      const res = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${this.lineConfig.channelAccessToken}` },
        signal: AbortSignal.any([
          AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
          this.lifecycle.signal,
        ]),
      });
      if (!res.ok) {
        throw new Error(`LINE content download failed with HTTP ${res.status}`);
      }
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > MAX_INLINE_MEDIA_BYTES) {
        throw new Error(`LINE content exceeds ${MAX_INLINE_MEDIA_BYTES} bytes`);
      }
      const data = await readResponseWithinLimit(res, MAX_INLINE_MEDIA_BYTES);
      attachment.localPath = await saveInboundMedia(
        this.mediaDir,
        this.name,
        messageId,
        name,
        data,
      );
      attachment.sizeBytes = data.byteLength;
    } catch (err) {
      this.noteError(err);
    }
    return attachment;
  }

  // ------------------------------------------------------------ reply token

  private cacheReplyToken(chatId: string, token: string): void {
    const now = Date.now();
    for (const [key, entry] of this.replyTokens) {
      if (entry.expiresAt <= now) {
        this.replyTokens.delete(key);
      }
    }
    rememberBounded(
      this.replyTokens,
      chatId,
      { token, expiresAt: now + this.replyTokenTtlMs },
      MAX_REPLY_TOKENS,
    );
  }

  /** Take (and consume) a fresh single-use reply token for `chatId`. */
  private takeReplyToken(chatId: string): string | undefined {
    const entry = this.replyTokens.get(chatId);
    if (!entry) {
      return undefined;
    }
    this.replyTokens.delete(chatId);
    return entry.expiresAt > Date.now() ? entry.token : undefined;
  }

  // -------------------------------------------------------------- outbound

  async sendMessage(msg: OutboundMessage): Promise<{ messageId?: string } | void> {
    const text =
      msg.markdown === true ? stripMarkdownToReadableText(msg.text ?? "") : (msg.text ?? "");
    const chunks = chunkText(text, MAX_TEXT_CHARS);
    if (chunks.length === 0) {
      return;
    }
    const messages = chunks.map((text) => ({ type: "text", text }));
    const batches: Array<Array<{ type: string; text: string }>> = [];
    for (let i = 0; i < messages.length; i += MAX_MESSAGES_PER_REQUEST) {
      batches.push(messages.slice(i, i + MAX_MESSAGES_PER_REQUEST));
    }

    const replyToken = this.takeReplyToken(msg.chatId);
    let lastMessageId: string | undefined;
    for (const [index, batch] of batches.entries()) {
      const useReply = index === 0 && replyToken !== undefined;
      const url = useReply
        ? `${API_BASE}/v2/bot/message/reply`
        : `${API_BASE}/v2/bot/message/push`;
      const payload = useReply
        ? { replyToken, messages: batch }
        : { to: msg.chatId, messages: batch };
      const result = await this.postApi(url, payload);
      const id = result?.sentMessages?.at(-1)?.id;
      if (typeof id === "string") {
        lastMessageId = id;
      }
    }

    this.noteOutbound();
    return lastMessageId ? { messageId: lastMessageId } : undefined;
  }

  private async postApi(
    url: string,
    payload: unknown,
  ): Promise<{ sentMessages?: Array<{ id?: string }> } | undefined> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.lineConfig.channelAccessToken}`,
          "content-type": "application/json",
        },
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
        `LINE API responded HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      );
      this.noteError(err);
      throw err;
    }
    try {
      return (await res.json()) as { sentMessages?: Array<{ id?: string }> };
    } catch {
      return undefined;
    }
  }
}

export function createAdapter(config: GatewayConfig): ChannelAdapter {
  return new LineChannelAdapter(config);
}