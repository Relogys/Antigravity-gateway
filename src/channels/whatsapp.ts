import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import type { GatewayConfig, WhatsAppConfig } from "../config.js";
import type {
  AttachmentKind,
  ChannelAdapter,
  InboundAttachment,
  InboundMessage,
  OutboundAttachment,
  OutboundMessage,
} from "../types.js";
import { BaseChannelAdapter, type InboundHandler } from "./base.js";
import {
  BoundedDedupeCache,
  chunkText,
  closeHttpServer,
  configureHttpServerTimeouts,
  isLoopbackHost,
  isMentioned,
  listenHttpServer,
  parseRequestUrl,
  readBoundedHttpBody,
} from "./utils.js";

const GRAPH_BASE = "https://graph.facebook.com";
const MAX_TEXT_CHARS = 4096;
const MAX_CAPTION_CHARS = 1024;
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGES_PER_WEBHOOK = 100;
const SEND_TIMEOUT_MS = 15_000;
const DEFAULT_WEBHOOK_PATH = "/whatsapp/webhook";

type WhatsAppMediaKind = "image" | "audio" | "video" | "document";

interface WhatsAppMedia {
  id?: string;
  mime_type?: string;
  caption?: string;
  filename?: string;
  file_size?: number;
  link?: string;
}

interface WhatsAppMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: WhatsAppMedia;
  audio?: WhatsAppMedia;
  video?: WhatsAppMedia;
  document?: WhatsAppMedia;
  button?: { text?: string; payload?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
  };
  context?: { message_id?: string };
}

interface WhatsAppValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
  messages?: WhatsAppMessage[];
  statuses?: unknown[];
}

interface WhatsAppWebhookBody {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{ field?: string; value?: WhatsAppValue }>;
  }>;
}

/** Extension fields accepted on outbound messages so callers can send media directly. */
interface WhatsAppSendExtensions {
  mediaUrl?: string;
  mediaType?: string;
  attachment?: string | OutboundAttachment;
}

interface ResolvedWhatsAppMedia {
  kind: WhatsAppMediaKind;
  link?: string;
  id?: string;
  filename?: string;
}

export interface WhatsAppAdapterOptions {
  fetchImpl?: typeof fetch;
  maxBodyBytes?: number;
}

function safeEqualString(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Verify Meta's `X-Hub-Signature-256: sha256=<hex>` header (timing-safe HMAC-SHA256). */
export function verifyWhatsAppSignature(
  appSecret: string,
  rawBody: Buffer,
  signatureHeader: string,
): boolean {
  if (!appSecret || !signatureHeader.trim()) {
    return false;
  }
  const match = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader.trim());
  if (!match) {
    return false;
  }
  const provided = Buffer.from(match[1], "hex");
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function extractWhatsAppContent(msg: WhatsAppMessage): {
  text: string;
  attachments: InboundAttachment[];
} {
  const attachments: InboundAttachment[] = [];
  switch (msg.type) {
    case "text":
      return { text: msg.text?.body ?? "", attachments };
    case "image":
    case "audio":
    case "video":
    case "document": {
      const media = msg[msg.type];
      const kind: AttachmentKind = msg.type === "document" ? "file" : msg.type;
      attachments.push({
        type: kind,
        mimeType: media?.mime_type,
        name: media?.filename ?? `${msg.type}-${media?.id ?? "unknown"}`,
        sizeBytes: typeof media?.file_size === "number" ? media.file_size : undefined,
        guid: media?.id,
      });
      return { text: media?.caption ?? "", attachments };
    }
    case "interactive": {
      const reply = msg.interactive?.button_reply ?? msg.interactive?.list_reply;
      return { text: reply?.title ?? "", attachments };
    }
    case "button":
      return { text: msg.button?.text ?? "", attachments };
    default:
      return { text: "", attachments };
  }
}

function normalizeMediaKind(
  rawType: string | undefined,
  attachment: OutboundAttachment | undefined,
): WhatsAppMediaKind {
  const explicit = rawType?.trim().toLowerCase();
  if (
    explicit === "image" ||
    explicit === "audio" ||
    explicit === "video" ||
    explicit === "document"
  ) {
    return explicit;
  }
  const mime = attachment?.mimeType ?? "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "document";
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class WhatsAppChannelAdapter extends BaseChannelAdapter {
  readonly name = "whatsapp";

  private readonly whatsappConfig: WhatsAppConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly dedupe = new BoundedDedupeCache();
  private readonly inFlight = new Set<Promise<void>>();
  private server?: http.Server;
  private boundPort: number | null = null;

  constructor(
    private readonly config: GatewayConfig,
    private readonly options: WhatsAppAdapterOptions = {},
  ) {
    super();
    const cfg = config.whatsapp;
    if (!cfg) {
      throw new Error(
        "WhatsApp channel is not configured (WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID)",
      );
    }
    this.whatsappConfig = cfg;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  }

  getPort(): number | null {
    return this.boundPort;
  }

  async start(onMessage: InboundHandler): Promise<void> {
    const cfg = this.whatsappConfig;
    const host = cfg.webhookHost || "127.0.0.1";
    if (!isLoopbackHost(host) && !cfg.appSecret) {
      throw new Error(
        `WhatsApp refuses to listen on non-loopback host "${host}" without WHATSAPP_APP_SECRET`,
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
    const configured = this.whatsappConfig.webhookPath?.trim() || DEFAULT_WEBHOOK_PATH;
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

  private text(res: http.ServerResponse, status: number, body: string): void {
    if (res.headersSent) {
      return;
    }
    res.writeHead(status, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      ...(status === 413 ? { connection: "close" } : {}),
    });
    res.end(body);
  }

  private async readBody(req: http.IncomingMessage): Promise<Buffer> {
    const limit = this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    return readBoundedHttpBody(req, limit, () => new HttpError(413, "request body too large"));
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = parseRequestUrl(req.url, () => new HttpError(400, "invalid request URL"));
    const method = req.method ?? "GET";

    if (url.pathname === "/whatsapp/health") {
      if (method !== "GET") {
        throw new HttpError(405, "method not allowed");
      }
      this.json(res, 200, { ok: true, channel: "whatsapp" });
      return;
    }

    if (url.pathname !== this.webhookPath) {
      throw new HttpError(404, "not found");
    }
    if (method === "GET") {
      this.handleVerification(url, res);
      return;
    }
    if (method !== "POST") {
      throw new HttpError(405, "method not allowed");
    }
    await this.handleWebhookRequest(req, res);
  }

  // ------------------------------------------------------------ verification

  private matchesVerifyToken(provided: string): boolean {
    const expected = this.whatsappConfig.verifyToken;
    if (!expected) {
      return false;
    }
    return safeEqualString(provided, expected);
  }

  private handleVerification(url: URL, res: http.ServerResponse): void {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token") ?? "";
    const challenge = url.searchParams.get("hub.challenge") ?? "";
    if (mode !== "subscribe" || !this.matchesVerifyToken(token)) {
      throw new HttpError(403, "webhook verification failed");
    }
    this.text(res, 200, challenge);
  }

  // --------------------------------------------------------------- inbound

  private async handleWebhookRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const raw = await this.readBody(req);
    const header = req.headers["x-hub-signature-256"];
    const signature = Array.isArray(header) ? (header[0] ?? "") : (header ?? "");
    if (
      !this.whatsappConfig.appSecret ||
      !verifyWhatsAppSignature(this.whatsappConfig.appSecret, raw, signature)
    ) {
      throw new HttpError(401, "invalid signature");
    }

    let body: WhatsAppWebhookBody;
    try {
      body = JSON.parse(raw.toString("utf8")) as WhatsAppWebhookBody;
    } catch {
      throw new HttpError(400, "invalid JSON body");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new HttpError(400, "body must be a JSON object");
    }

    this.json(res, 200, { ok: true });
    const task = this.handleWebhook(body).finally(() => {
      this.inFlight.delete(task);
    });
    this.inFlight.add(task);
  }

  private async handleWebhook(body: WhatsAppWebhookBody): Promise<void> {
    const entries = Array.isArray(body.entry) ? body.entry : [];
    let processed = 0;
    for (const entry of entries) {
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      for (const change of changes) {
        const value = change?.value;
        if (!value || !Array.isArray(value.messages)) {
          continue;
        }
        for (const message of value.messages) {
          if (processed >= MAX_MESSAGES_PER_WEBHOOK) {
            return;
          }
          processed += 1;
          try {
            await this.handleMessage(value, message);
          } catch (err) {
            this.noteError(err);
          }
        }
      }
    }
  }

  private async handleMessage(value: WhatsAppValue, msg: WhatsAppMessage): Promise<void> {
    if (!msg || typeof msg !== "object") {
      return;
    }
    const from = typeof msg.from === "string" ? msg.from.trim() : "";
    const messageId = typeof msg.id === "string" ? msg.id : "";
    if (!from || !messageId) {
      return;
    }
    if (this.dedupe.seen(messageId)) {
      return;
    }

    const { text, attachments } = extractWhatsAppContent(msg);
    if (!text.trim() && attachments.length === 0) {
      return;
    }

    const contacts = Array.isArray(value.contacts) ? value.contacts : [];
    const profileName =
      contacts.find((contact) => contact?.wa_id === from)?.profile?.name ??
      contacts[0]?.profile?.name;
    const phoneNumberId = value.metadata?.phone_number_id;
    const isGroup = /@g\.us$/i.test(from);
    const seconds = Number(msg.timestamp);
    const timestamp = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Date.now();

    const inbound: InboundMessage & { metadata: Record<string, unknown> } = {
      id: messageId,
      channel: this.name,
      chatId: from,
      senderId: from,
      rawSenderId: from,
      isGroup,
      text,
      attachments,
      replyToMessageId:
        typeof msg.context?.message_id === "string" ? msg.context.message_id : undefined,
      timestamp,
      mentionsBot: !isGroup || isMentioned(text, this.config.groupMentionPatterns),
      raw: msg,
      metadata: {
        phoneNumberId,
        profileName,
        messageType: msg.type,
      },
    };
    await this.emit(inbound);
  }

  // -------------------------------------------------------------- outbound

  async sendMessage(msg: OutboundMessage): Promise<{ messageId?: string } | void> {
    const text = msg.text ?? "";
    const chunks = chunkText(text, MAX_TEXT_CHARS);
    const media = await this.resolveOutboundMedia(msg as OutboundMessage & WhatsAppSendExtensions);
    const trimmed = text.trim();
    const useCaption =
      media !== undefined &&
      media.kind !== "audio" &&
      trimmed.length > 0 &&
      trimmed.length <= MAX_CAPTION_CHARS;
    const textChunks = useCaption ? [] : chunks;
    if (!media && textChunks.length === 0) {
      return;
    }

    const context = msg.replyToMessageId ? { message_id: msg.replyToMessageId } : undefined;
    let lastMessageId: string | undefined;

    if (media) {
      const mediaPayload: Record<string, unknown> = media.link
        ? { link: media.link }
        : { id: media.id };
      if (media.kind === "document" && media.filename) {
        mediaPayload.filename = media.filename;
      }
      if (useCaption) {
        mediaPayload.caption = trimmed;
      }
      const payload: Record<string, unknown> = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: msg.chatId,
        type: media.kind,
        [media.kind]: mediaPayload,
        ...(context ? { context } : {}),
      };
      lastMessageId = await this.postGraphMessage(payload);
    }

    for (const [index, chunk] of textChunks.entries()) {
      const payload: Record<string, unknown> = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: msg.chatId,
        type: "text",
        text: { body: chunk, preview_url: false },
        ...(context && !media && index === 0 ? { context } : {}),
      };
      lastMessageId = (await this.postGraphMessage(payload)) ?? lastMessageId;
    }

    this.noteOutbound();
    return lastMessageId ? { messageId: lastMessageId } : undefined;
  }

  private async resolveOutboundMedia(
    msg: OutboundMessage & WhatsAppSendExtensions,
  ): Promise<ResolvedWhatsAppMedia | undefined> {
    const attachment = typeof msg.attachment === "object" ? msg.attachment : msg.attachments?.[0];
    const directUrl =
      msg.mediaUrl ?? (typeof msg.attachment === "string" ? msg.attachment : attachment?.url);
    const kind = normalizeMediaKind(msg.mediaType, attachment);
    if (directUrl) {
      return { kind, link: directUrl };
    }
    if (!attachment) {
      return undefined;
    }
    let data = attachment.buffer;
    if (!data && attachment.path) {
      data = await readFile(attachment.path);
    }
    if (!data || data.byteLength === 0) {
      return undefined;
    }
    const mimeType = attachment.mimeType ?? "application/octet-stream";
    const mediaId = await this.uploadMedia(data, mimeType, attachment.name);
    return { kind, id: mediaId, filename: attachment.name };
  }

  private async uploadMedia(
    data: Buffer,
    mimeType: string,
    filename: string | undefined,
  ): Promise<string> {
    const { apiVersion, phoneNumberId, accessToken } = this.whatsappConfig;
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mimeType);
    form.append(
      "file",
      new Blob([new Uint8Array(data)], { type: mimeType }),
      filename ?? "upload",
    );

    let res: Response;
    try {
      res = await this.fetchImpl(
        `${GRAPH_BASE}/${encodeURIComponent(apiVersion)}/${encodeURIComponent(phoneNumberId)}/media`,
        {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body: form,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (err) {
      this.noteError(err);
      throw err;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const err = new Error(
        `WhatsApp media upload failed with HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      );
      this.noteError(err);
      throw err;
    }
    const data2 = (await res.json().catch(() => undefined)) as { id?: unknown } | undefined;
    if (typeof data2?.id !== "string" || !data2.id) {
      const err = new Error("WhatsApp media upload response did not include an id");
      this.noteError(err);
      throw err;
    }
    return data2.id;
  }

  private async postGraphMessage(payload: Record<string, unknown>): Promise<string | undefined> {
    const { apiVersion, phoneNumberId, accessToken } = this.whatsappConfig;
    let res: Response;
    try {
      res = await this.fetchImpl(
        `${GRAPH_BASE}/${encodeURIComponent(apiVersion)}/${encodeURIComponent(phoneNumberId)}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
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
        `WhatsApp API responded HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      );
      this.noteError(err);
      throw err;
    }
    const body = (await res.json().catch(() => undefined)) as
      | { messages?: Array<{ id?: unknown }> }
      | undefined;
    const id = body?.messages?.[0]?.id;
    return typeof id === "string" ? id : undefined;
  }
}

export function createAdapter(config: GatewayConfig): ChannelAdapter {
  return new WhatsAppChannelAdapter(config);
}