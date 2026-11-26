import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
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
  chunkText,
  closeHttpServer,
  configureHttpServerTimeouts,
  isLoopbackHost,
  listenHttpServer,
  MAX_INLINE_MEDIA_BYTES,
  parseRequestUrl,
  readBoundedHttpBody,
  readResponseWithinLimit,
  saveInboundMedia,
} from "./utils.js";

const API_BASE = "https://qyapi.weixin.qq.com";
const MAX_TEXT = 2000;
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_OUTBOUND_MEDIA_BYTES = 20 * 1024 * 1024;

export interface WeComAdapterOptions {
  fetchImpl?: typeof fetch;
  mediaDir?: string;
  maxBodyBytes?: number;
  now?: () => number;
}

function signatureDigest(token: string, values: string[]): string {
  return createHash("sha1").update([token, ...values].sort().join(""), "utf8").digest("hex");
}

function signaturesEqual(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{40}$/i.test(actual)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(actual.toLowerCase(), "ascii"), Buffer.from(expected, "ascii"));
}

/** Verify a WeCom callback SHA1 signature. The fourth sorted value is Encrypt, or empty for plaintext. */
export function verifyWeComSignature(
  token: string,
  timestamp: string,
  nonce: string,
  encryptOrEmpty: string,
  signature: string,
): boolean {
  const expected = signatureDigest(token, [timestamp, nonce, encryptOrEmpty]);
  return signaturesEqual(signature.trim(), expected);
}

function decodeKey(encodingAesKey: string): Buffer {
  // WeCom publishes 43 Base64 characters; the omitted padding represents one byte.
  if (!/^[A-Za-z0-9+/]{43}=?$/.test(encodingAesKey)) {
    throw new Error("WeCom EncodingAESKey must contain 43 Base64 characters");
  }
  const key = Buffer.from(`${encodingAesKey.replace(/=$/, "")}=`, "base64");
  if (key.byteLength !== 32) {
    throw new Error("WeCom EncodingAESKey must decode to 32 bytes");
  }
  return key;
}

function unpadPkcs7(data: Buffer): Buffer {
  if (data.byteLength === 0 || data.byteLength % 16 !== 0) {
    throw new Error("Invalid WeCom decrypted payload length");
  }
  const padding = data[data.byteLength - 1];
  // The WeCom reference implementation uses PKCS#7 with a 32-byte block size.
  if (padding < 1 || padding > 32 || padding > data.byteLength) {
    throw new Error("Invalid WeCom PKCS#7 padding");
  }
  for (const byte of data.subarray(data.byteLength - padding)) {
    if (byte !== padding) {
      throw new Error("Invalid WeCom PKCS#7 padding");
    }
  }
  return data.subarray(0, data.byteLength - padding);
}

/** Decrypt a WXBizMsgCrypt payload and validate its framing and optional CorpID. */
export function decryptWeComMessage(
  encodingAesKey: string,
  encryptedBase64: string,
  expectedCorpId?: string,
): string {
  const key = decodeKey(encodingAesKey);
  const encrypted = Buffer.from(encryptedBase64, "base64");
  if (encrypted.byteLength === 0 || encrypted.byteLength % 16 !== 0) {
    throw new Error("Invalid WeCom encrypted payload length");
  }
  const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  const plain = unpadPkcs7(Buffer.concat([decipher.update(encrypted), decipher.final()]));
  if (plain.byteLength < 20) {
    throw new Error("Invalid WeCom decrypted message framing");
  }
  const length = plain.readUInt32BE(16);
  // The trailing CorpID is required by WXBizMsgCrypt, so the message is a prefix.
  if (length > plain.byteLength - 20) {
    throw new Error("Invalid WeCom decrypted message length");
  }
  const corpId = plain.subarray(20 + length).toString("utf8");
  if (expectedCorpId !== undefined && corpId !== expectedCorpId) {
    throw new Error("WeCom decrypted message CorpID does not match");
  }
  return plain.subarray(20, 20 + length).toString("utf8");
}

/** Encrypt plaintext using the WXBizMsgCrypt random-prefix/length/CorpID framing. */
export function encryptWeComMessage(
  encodingAesKey: string,
  plaintext: string,
  corpId: string,
): string {
  const key = decodeKey(encodingAesKey);
  const message = Buffer.from(plaintext, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(message.byteLength, 0);
  const plain = Buffer.concat([randomBytes(16), length, message, Buffer.from(corpId, "utf8")]);
  // Use 32-byte PKCS#7 blocks as specified by WXBizMsgCrypt (not CBC's 16-byte default).
  const padding = 32 - (plain.byteLength % 32);
  const padded = Buffer.concat([plain, Buffer.alloc(padding, padding)]);
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}

function xmlValue(xml: string, tag: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i").exec(xml);
  if (!match) {
    return "";
  }
  return match[1]
    .trim()
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/i, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (all, hex: string) => {
      const cp = Number.parseInt(hex, 16);
      return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : all;
    })
    .replace(/&#(\d+);/g, (all, decimal: string) => {
      const cp = Number.parseInt(decimal, 10);
      return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : all;
    })
    .replace(/&amp;/g, "&");
}

function collectXmlFields(xml: string, fields: Record<string, string>): void {
  const pattern = /<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
  for (let match = pattern.exec(xml); match; match = pattern.exec(xml)) {
    const body = match[2];
    // CDATA payloads may contain "<", so only real child elements trigger recursion.
    const withoutCdata = body.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
    if (/<[A-Za-z_][\w.-]*(?:\s[^>]*)?>/.test(withoutCdata)) {
      collectXmlFields(body, fields);
    } else {
      fields[match[1].toLowerCase()] = xmlValue(match[0], match[1]);
    }
  }
}

function xmlFields(xml: string): Record<string, string> {
  const fields: Record<string, string> = {};
  collectXmlFields(xml, fields);
  return fields;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface WeComApiResponse {
  errcode?: number;
  errmsg?: string;
  [key: string]: unknown;
}

export class WeComChannelAdapter extends BaseChannelAdapter {
  readonly name = "wecom";

  private readonly dedupe = new BoundedDedupeCache();
  private readonly fetchImpl: typeof fetch;
  private readonly mediaDir: string;
  private readonly now: () => number;
  private server?: http.Server;
  private boundPort: number | null = null;
  private token?: { value: string; expiresAt: number };
  private tokenRequest?: Promise<string>;
  private lifecycle = new AbortController();

  constructor(
    private readonly config: GatewayConfig,
    private readonly options: WeComAdapterOptions = {},
  ) {
    super();
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.mediaDir = options.mediaDir ?? path.join(config.dataDir, "media");
    this.now = options.now ?? Date.now;
  }

  getPort(): number | null {
    return this.boundPort;
  }

  async start(onMessage: InboundHandler): Promise<void> {
    const cfg = this.config.wecom;
    if (!cfg) {
      throw new Error("WeCom channel is not configured (WECOM_* env)");
    }
    if ((cfg.token && !cfg.encodingAesKey) || (!cfg.token && cfg.encodingAesKey)) {
      throw new Error("WECOM_TOKEN and WECOM_ENCODING_AES_KEY must be configured together");
    }
    const host = cfg.host || "127.0.0.1";
    if (!isLoopbackHost(host) && (!cfg.token || !cfg.encodingAesKey)) {
      throw new Error(
        `WeCom refuses to listen on non-loopback host "${host}" without WECOM_TOKEN and WECOM_ENCODING_AES_KEY`,
      );
    }
    this.handler = onMessage;
    this.lifecycle = new AbortController();
    const server = http.createServer((req, res) => {
      void this.route(req, res).catch((err: unknown) => {
        if (!(err instanceof HttpError)) {
          this.noteError(err);
        }
        const status = err instanceof HttpError ? err.status : 500;
        this.text(res, status, err instanceof HttpError ? err.message : "internal error");
      });
    });
    configureHttpServerTimeouts(server, { requestTimeoutMs: 30_000 });
    this.server = server;
    try {
      this.boundPort = await listenHttpServer(server, cfg.port, host);
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
    this.token = undefined;
    this.tokenRequest = undefined;
    const server = this.server;
    this.server = undefined;
    this.boundPort = null;
    this.handler = undefined;
    await closeHttpServer(server);
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

  private async readBody(req: http.IncomingMessage): Promise<string> {
    const limit = this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    const buf = await readBoundedHttpBody(
      req,
      limit,
      () => new HttpError(413, "request body too large"),
    );
    return buf.toString("utf8");
  }

  private checkSignature(url: URL, encrypted: string): void {
    const cfg = this.config.wecom;
    if (!cfg?.token) {
      if (encrypted) {
        throw new HttpError(400, "encrypted callback requires WECOM_TOKEN");
      }
      return;
    }
    const signature = url.searchParams.get("msg_signature") ?? url.searchParams.get("signature") ?? "";
    const timestamp = url.searchParams.get("timestamp") ?? "";
    const nonce = url.searchParams.get("nonce") ?? "";
    if (!verifyWeComSignature(cfg.token, timestamp, nonce, encrypted, signature)) {
      throw new HttpError(401, "invalid WeCom callback signature");
    }
  }

  private decrypt(xml: string): string {
    const cfg = this.config.wecom;
    if (!cfg?.encodingAesKey) {
      throw new HttpError(400, "encrypted callback requires WECOM_ENCODING_AES_KEY");
    }
    const encrypted = xmlValue(xml, "Encrypt");
    if (!encrypted) {
      throw new HttpError(400, "encrypted callback has no Encrypt element");
    }
    try {
      return decryptWeComMessage(cfg.encodingAesKey, encrypted, cfg.corpId);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : "WeCom decryption failed");
    }
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = parseRequestUrl(req.url, () => new HttpError(400, "invalid request URL"));
    const method = req.method ?? "GET";
    if (method === "GET") {
      const echo = url.searchParams.get("echostr");
      if (echo === null) {
        throw new HttpError(404, "not found");
      }
      const looksEncrypted = /^[A-Za-z0-9+/]+={0,2}$/.test(echo) && echo.length >= 16;
      this.checkSignature(url, looksEncrypted ? echo : "");
      const inner = looksEncrypted ? this.decrypt(`<xml><Encrypt><![CDATA[${echo}]]></Encrypt></xml>`) : echo;
      // URL verification echoes the plaintext echostr, not an XML response envelope.
      this.text(res, 200, xmlValue(inner, "EchoStr") || inner);
      return;
    }
    if (method !== "POST") {
      throw new HttpError(405, "method not allowed");
    }

    const body = await this.readBody(req);
    const encrypted = xmlValue(body, "Encrypt");
    this.checkSignature(url, encrypted);
    const xml = encrypted ? this.decrypt(body) : body;
    await this.handleXml(xml);
    this.text(res, 200, "success");
  }

  /** Parse and deliver one decrypted (or plaintext) WeCom XML callback. Exposed for tests. */
  async handleXml(xml: string): Promise<void> {
    const fields = xmlFields(xml);
    const type = (fields.msgtype ?? "").toLowerCase();
    if (!["text", "image", "voice", "file"].includes(type)) {
      return;
    }
    const senderId = fields.fromusername ?? "";
    if (!senderId) {
      return;
    }
    const id = fields.msgid || createHash("sha256").update(xml).digest("hex");
    if (this.dedupe.seen(id)) {
      return;
    }

    let text = type === "text" ? (fields.content ?? "") : "";
    if (type === "voice" && fields.recognition) {
      text = fields.recognition;
    }
    const attachments: InboundAttachment[] = [];
    const mediaId = fields.mediaid;
    if (mediaId && type !== "text") {
      const kind: AttachmentKind = type === "image" ? "image" : type === "voice" ? "audio" : "file";
      const name =
        fields.filename || fields.filename_ || `${id}.${type === "image" ? "jpg" : type === "voice" ? "amr" : "bin"}`;
      const attachment: InboundAttachment = { type: kind, name, guid: mediaId };
      try {
        const downloaded = await this.downloadMedia(mediaId);
        attachment.mimeType = downloaded.mimeType;
        attachment.sizeBytes = downloaded.data.byteLength;
        attachment.data = downloaded.data;
        attachment.localPath = await saveInboundMedia(this.mediaDir, this.name, id, name, downloaded.data);
      } catch (err) {
        this.noteError(err);
      }
      attachments.push(attachment);
    }
    if (!text.trim() && attachments.length === 0) {
      return;
    }

    const seconds = Number(fields.createtime);
    await this.emit({
      id,
      channel: this.name,
      chatId: senderId,
      senderId,
      isGroup: false,
      text: text.trim(),
      attachments,
      timestamp: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : this.now(),
      mentionsBot: true,
      raw: fields,
    });
  }

  private requireConfig() {
    const cfg = this.config.wecom;
    if (!cfg) {
      throw new Error("WeCom channel is not configured");
    }
    return cfg;
  }

  /** Return a cached Corp access token, refreshing shortly before its expiry. */
  private async getAccessToken(): Promise<string> {
    const cfg = this.requireConfig();
    if (this.token && this.token.expiresAt > this.now() + 60_000) {
      return this.token.value;
    }
    if (this.tokenRequest) {
      return this.tokenRequest;
    }
    this.tokenRequest = (async () => {
      const url = new URL(`${API_BASE}/cgi-bin/gettoken`);
      url.searchParams.set("corpid", cfg.corpId);
      url.searchParams.set("corpsecret", cfg.secret);
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
      const body = (await res.json().catch(() => ({}))) as WeComApiResponse & {
        access_token?: string;
        expires_in?: number;
      };
      if (!res.ok || body.errcode !== 0 || !body.access_token) {
        throw new Error(
          `WeCom access token request failed: ${body.errmsg ?? `HTTP ${res.status}`} (errcode ${body.errcode ?? "unknown"})`,
        );
      }
      const value = body.access_token;
      this.token = {
        value,
        expiresAt: this.now() + Math.max(60, body.expires_in ?? 7200) * 1000,
      };
      return value;
    })();
    try {
      return await this.tokenRequest;
    } finally {
      this.tokenRequest = undefined;
    }
  }

  private async apiFetch(pathname: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.getAccessToken();
    const url = new URL(`${API_BASE}${pathname}`);
    // Preserve operation params such as media_id and the media upload type.
    url.searchParams.set("access_token", token);
    return this.fetchImpl(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30_000) });
  }

  private static async apiJson(res: Response, operation: string): Promise<WeComApiResponse> {
    const body = (await res.json().catch(() => ({}))) as WeComApiResponse;
    if (!res.ok || body.errcode !== 0) {
      throw new Error(
        `WeCom ${operation} failed: ${body.errmsg ?? `HTTP ${res.status}`} (errcode ${body.errcode ?? "unknown"})`,
      );
    }
    return body;
  }

  private async downloadMedia(mediaId: string): Promise<{ data: Buffer; mimeType?: string }> {
    const res = await this.apiFetch(`/cgi-bin/media/get?media_id=${encodeURIComponent(mediaId)}`, {
      method: "GET",
      headers: { accept: "application/octet-stream" },
    });
    const mimeType = res.headers.get("content-type")?.split(";", 1)[0];
    if (!res.ok || mimeType === "application/json") {
      const body = (await res.json().catch(() => ({}))) as WeComApiResponse;
      throw new Error(
        `WeCom media download failed: ${body.errmsg ?? `HTTP ${res.status}`} (errcode ${body.errcode ?? "unknown"})`,
      );
    }
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_INLINE_MEDIA_BYTES) {
      throw new Error(`WeCom media download exceeds ${MAX_INLINE_MEDIA_BYTES} bytes`);
    }
    const data = await readResponseWithinLimit(res, MAX_INLINE_MEDIA_BYTES);
    return { data, mimeType };
  }

  async sendMessage(msg: OutboundMessage): Promise<{ messageId?: string } | void> {
    let lastId: string | undefined;
    for (const chunk of chunkText(msg.text ?? "", MAX_TEXT)) {
      const body = msg.markdown
        ? {
            touser: msg.chatId,
            msgtype: "markdown",
            agentid: this.requireConfig().agentId,
            markdown: { content: chunk },
          }
        : {
            touser: msg.chatId,
            msgtype: "text",
            agentid: this.requireConfig().agentId,
            text: { content: chunk },
          };
      const result = await this.sendPayload(body);
      lastId = typeof result.msgid === "string" || typeof result.msgid === "number" ? String(result.msgid) : lastId;
    }
    for (const attachment of msg.attachments ?? []) {
      const result = await this.sendAttachment(msg.chatId, attachment);
      lastId = typeof result.msgid === "string" || typeof result.msgid === "number" ? String(result.msgid) : lastId;
    }
    this.noteOutbound();
    return { messageId: lastId };
  }

  private async sendPayload(body: unknown): Promise<WeComApiResponse> {
    const res = await this.apiFetch("/cgi-bin/message/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return WeComChannelAdapter.apiJson(res, "message send");
  }

  private async loadAttachment(att: OutboundAttachment): Promise<Buffer> {
    const data = att.buffer ?? (att.path ? await readFile(att.path) : await this.downloadOutbound(att.url));
    if (data.byteLength > MAX_OUTBOUND_MEDIA_BYTES) {
      throw new Error(`WeCom outbound attachment exceeds ${MAX_OUTBOUND_MEDIA_BYTES} bytes`);
    }
    return data;
  }

  private async downloadOutbound(url: string | undefined): Promise<Buffer> {
    if (!url) {
      throw new Error("WeCom outbound attachment has no buffer, path, or url");
    }
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      throw new Error(`WeCom attachment download failed: HTTP ${res.status}`);
    }
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_INLINE_MEDIA_BYTES) {
      throw new Error(`WeCom attachment download exceeds ${MAX_INLINE_MEDIA_BYTES} bytes`);
    }
    return readResponseWithinLimit(res, MAX_INLINE_MEDIA_BYTES);
  }

  private async sendAttachment(chatId: string, att: OutboundAttachment): Promise<WeComApiResponse> {
    const data = await this.loadAttachment(att);
    const mimeType = att.mimeType ?? "application/octet-stream";
    const reference = att.name ?? att.path ?? att.url ?? "";
    const type = mimeType.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp)(?:$|\?)/i.test(reference)
      ? "image"
      : mimeType.startsWith("audio/") || /\.(amr|mp3|wav)(?:$|\?)/i.test(reference)
        ? "voice"
        : mimeType.startsWith("video/") || /\.mp4(?:$|\?)/i.test(reference)
          ? "video"
          : "file";
    const form = new FormData();
    form.append(
      "media",
      new Blob([new Uint8Array(data)], { type: mimeType }),
      att.name ?? (att.path ? path.basename(att.path) : `attachment.${type === "image" ? "jpg" : "bin"}`),
    );
    const uploaded = await this.apiFetch(`/cgi-bin/media/upload?type=${encodeURIComponent(type)}`, {
      method: "POST",
      body: form,
    });
    const uploadBody = await WeComChannelAdapter.apiJson(uploaded, "media upload");
    if (typeof uploadBody.media_id !== "string" || !uploadBody.media_id) {
      throw new Error("WeCom media upload returned no media_id");
    }
    return this.sendPayload({
      touser: chatId,
      msgtype: type,
      agentid: this.requireConfig().agentId,
      [type]: { media_id: uploadBody.media_id },
    });
  }
}

export function createAdapter(config: GatewayConfig): ChannelAdapter {
  return new WeComChannelAdapter(config);
}
