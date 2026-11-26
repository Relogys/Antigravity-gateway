import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GatewayConfig } from "../config.js";
import type {
  ChannelAdapter,
  InboundAttachment,
  OutboundAttachment,
  OutboundMessage,
} from "../types.js";
import { BaseChannelAdapter, type InboundHandler } from "./base.js";
import {
  BoundedDedupeCache,
  chunkText,
  downloadToBuffer,
  errorMessage,
  isMentioned,
  MAX_INLINE_MEDIA_BYTES,
  saveInboundMedia,
} from "./utils.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFn = (arg: any) => Promise<any>;

/** Minimal structural view of the Lark/Feishu SDK `Client` (so tests can inject fakes). */
export interface FeishuClientLike {
  im: {
    message: { create: AnyFn; reply: AnyFn };
    messageResource: { get: AnyFn };
    image: { create: AnyFn };
    file: { create: AnyFn };
    messageReaction: { create: AnyFn };
  };
  request?: AnyFn;
}

export interface FeishuEventDispatcherLike {
  register(handles: Record<string, (data: any) => unknown>): unknown;
}

export interface FeishuWsClientLike {
  start(params: { eventDispatcher: any }): Promise<void> | void;
  close?(params?: { force?: boolean }): void;
}

export interface FeishuSdkConfig {
  appId: string;
  appSecret: string;
  domain: "feishu" | "lark";
}

export interface FeishuAdapterOptions {
  createClient?: (cfg: FeishuSdkConfig) => FeishuClientLike;
  createWsClient?: (cfg: FeishuSdkConfig) => FeishuWsClientLike;
  createEventDispatcher?: () => FeishuEventDispatcherLike;
  /** Known bot open_id (otherwise discovered via the bot info API, best effort). */
  botOpenId?: string;
  mediaDir?: string;
}

const MAX_TEXT = 4000;

const EMOJI_MAP: Record<string, string> = {
  "👀": "EYES",
  "👍": "THUMBSUP",
  "👎": "THUMBSDOWN",
  "✅": "DONE",
  "❌": "THUMBSDOWN",
  "❤️": "HEART",
  "❤": "HEART",
  "🎉": "PARTY",
  "🙏": "PRAY",
  "💪": "MUSCLE",
  "👌": "OK",
  "😂": "LAUGH",
  "😄": "SMILE",
};

/** Map a unicode emoji (or an already-valid Feishu emoji_type) to a Feishu reaction type. */
export function toFeishuEmojiType(emoji: string): string | undefined {
  const trimmed = emoji.trim();
  if (EMOJI_MAP[trimmed]) {
    return EMOJI_MAP[trimmed];
  }
  if (/^[A-Za-z_]{2,40}$/.test(trimmed)) {
    return trimmed;
  }
  return undefined;
}

interface PostParse {
  text: string;
  imageKeys: string[];
}

/** Flatten a Feishu rich-text `post` payload (optionally locale-wrapped) to plain text. */
export function parseFeishuPost(content: any): PostParse {
  let body: any = content;
  if (!Array.isArray(body?.content)) {
    body =
      content?.zh_cn ??
      content?.en_us ??
      content?.ja_jp ??
      Object.values(content ?? {}).find(
        (v: any) => v && typeof v === "object" && Array.isArray((v as any).content),
      );
  }
  const paragraphs: string[] = [];
  const imageKeys: string[] = [];
  if (typeof body?.title === "string" && body.title.trim()) {
    paragraphs.push(body.title.trim());
  }
  for (const row of Array.isArray(body?.content) ? body.content : []) {
    let line = "";
    for (const el of Array.isArray(row) ? row : []) {
      switch (el?.tag) {
        case "text":
        case "md":
          line += el.text ?? "";
          break;
        case "a":
          line += el.text ?? "";
          if (el.href && el.href !== el.text) {
            line += ` (${el.href})`;
          }
          break;
        case "at":
          line += typeof el.user_id === "string" ? el.user_id : `@${el.user_name ?? ""}`;
          break;
        case "img":
          if (typeof el.image_key === "string") {
            imageKeys.push(el.image_key);
          }
          break;
        case "emotion":
          line += `:${el.emoji_type ?? ""}:`;
          break;
        default:
          break;
      }
    }
    paragraphs.push(line);
  }
  return { text: paragraphs.join("\n").trim(), imageKeys };
}

function safeJson(raw: unknown): any {
  if (typeof raw !== "string") {
    return raw ?? {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function streamToBuffer(stream: AsyncIterable<unknown>, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.byteLength;
    if (total > maxBytes) {
      throw new Error(`Download exceeds ${maxBytes} bytes`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function looksLikeImage(att: OutboundAttachment): boolean {
  if (att.mimeType?.startsWith("image/")) {
    return true;
  }
  const name = att.name ?? att.path ?? att.url ?? "";
  return /\.(png|jpe?g|gif|webp|bmp)(\?|$)/i.test(name);
}

export class FeishuChannelAdapter extends BaseChannelAdapter {
  readonly name = "feishu";

  private readonly dedupe = new BoundedDedupeCache();
  private client?: FeishuClientLike;
  private ws?: FeishuWsClientLike;
  private botOpenId?: string;
  private readonly mediaDir: string;

  constructor(
    private readonly config: GatewayConfig,
    private readonly options: FeishuAdapterOptions = {},
  ) {
    super();
    this.botOpenId = options.botOpenId;
    this.mediaDir = options.mediaDir ?? path.join(config.dataDir, "media");
  }

  async start(onMessage: InboundHandler): Promise<void> {
    const cfg = this.config.feishu;
    if (!cfg) {
      throw new Error("Feishu is not configured (FEISHU_APP_ID / FEISHU_APP_SECRET)");
    }
    this.handler = onMessage;
    const sdkCfg: FeishuSdkConfig = {
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      domain: cfg.domain,
    };

    let lark: typeof import("@larksuiteoapi/node-sdk") | undefined;
    const needSdk =
      !this.options.createClient ||
      !this.options.createWsClient ||
      !this.options.createEventDispatcher;
    if (needSdk) {
      lark = await import("@larksuiteoapi/node-sdk");
    }
    const domain = cfg.domain === "lark" ? lark?.Domain.Lark : lark?.Domain.Feishu;

    this.client =
      this.options.createClient?.(sdkCfg) ??
      (new lark!.Client({
        appId: cfg.appId,
        appSecret: cfg.appSecret,
        domain,
      }) as unknown as FeishuClientLike);
    const dispatcher =
      this.options.createEventDispatcher?.() ??
      (new lark!.EventDispatcher({}) as unknown as FeishuEventDispatcherLike);
    this.ws =
      this.options.createWsClient?.(sdkCfg) ??
      (new lark!.WSClient({
        appId: cfg.appId,
        appSecret: cfg.appSecret,
        domain,
        loggerLevel: lark!.LoggerLevel.error,
      }) as unknown as FeishuWsClientLike);

    dispatcher.register({
      "im.message.receive_v1": (data: any) => {
        // Ack immediately (Feishu expects a reply within ~3s); process asynchronously.
        void this.handleMessageEvent(data).catch((err) => this.noteError(err));
      },
    });

    if (!this.botOpenId && this.client.request) {
      try {
        const info = await this.client.request({ method: "GET", url: "/open-apis/bot/v3/info" });
        const openId = info?.bot?.open_id ?? info?.data?.bot?.open_id;
        if (typeof openId === "string" && openId) {
          this.botOpenId = openId;
        }
      } catch (err) {
        this.noteError(err);
      }
    }

    await this.ws.start({ eventDispatcher: dispatcher });
    this.setConnected(true);
  }

  async stop(): Promise<void> {
    this.setConnected(false);
    try {
      this.ws?.close?.({ force: true });
    } catch (err) {
      this.noteError(err);
    }
    this.ws = undefined;
    this.handler = undefined;
  }

  /** Process one `im.message.receive_v1` event payload. Exposed for tests. */
  async handleMessageEvent(data: any): Promise<void> {
    const ev = data?.event ?? data;
    const message = ev?.message;
    const sender = ev?.sender;
    if (!message?.message_id || !message.chat_id) {
      return;
    }
    if (sender?.sender_type === "app") {
      return;
    }
    const messageId = String(message.message_id);
    if (this.dedupe.seen(messageId)) {
      return;
    }

    const senderId = String(sender?.sender_id?.open_id ?? sender?.sender_id?.user_id ?? "");
    if (!senderId) {
      return;
    }
    const isGroup = message.chat_type === "group" || message.chat_type === "topic_group";
    const content = safeJson(message.content);
    const msgType = String(message.message_type ?? "text");
    const mentions: any[] = Array.isArray(message.mentions) ? message.mentions : [];

    let rawText = "";
    const attachments: InboundAttachment[] = [];
    const downloads: Array<Promise<void>> = [];
    const addMedia = (
      type: InboundAttachment["type"],
      key: string,
      resType: "image" | "file",
      name: string | undefined,
    ) => {
      downloads.push(
        this.downloadMedia(messageId, key, resType, type, name)
          .then((att) => {
            attachments.push(att);
          })
          .catch((err) => {
            this.noteError(err);
          }),
      );
    };

    switch (msgType) {
      case "text":
        rawText = typeof content.text === "string" ? content.text : "";
        break;
      case "post": {
        const post = parseFeishuPost(content);
        rawText = post.text;
        for (const key of post.imageKeys) {
          addMedia("image", key, "image", `${key}.png`);
        }
        break;
      }
      case "image":
        if (content.image_key) {
          addMedia("image", String(content.image_key), "image", `${content.image_key}.png`);
        }
        break;
      case "file":
        if (content.file_key) {
          addMedia("file", String(content.file_key), "file", content.file_name);
        }
        break;
      case "audio":
        if (content.file_key) {
          addMedia("audio", String(content.file_key), "file", `${content.file_key}.opus`);
        }
        break;
      case "media":
        if (content.file_key) {
          addMedia("video", String(content.file_key), "file", content.file_name ?? "video.mp4");
        }
        break;
      default:
        return;
    }
    await Promise.all(downloads);

    const botMentioned = this.botOpenId
      ? mentions.some((m) => m?.id?.open_id === this.botOpenId)
      : mentions.length > 0;
    const text = this.cleanText(rawText, mentions);
    const mentionsBot =
      botMentioned || isMentioned(text, this.config.groupMentionPatterns) || !isGroup;

    if (!text && attachments.length === 0) {
      return;
    }

    await this.emit({
      id: messageId,
      channel: this.name,
      chatId: String(message.chat_id),
      senderId,
      isGroup,
      text,
      attachments,
      replyToMessageId: message.parent_id ? String(message.parent_id) : undefined,
      timestamp: Number(message.create_time) || Date.now(),
      mentionsBot,
      raw: data,
    });
  }

  private cleanText(raw: string, mentions: any[]): string {
    let text = raw;
    for (const m of mentions) {
      const key = typeof m?.key === "string" ? m.key : undefined;
      if (!key) {
        continue;
      }
      // Unknown bot id: every mention is treated as addressing the bot.
      const isBot = this.botOpenId ? m?.id?.open_id === this.botOpenId : true;
      const replacement = isBot || !m.name ? "" : `@${m.name}`;
      text = text.split(key).join(replacement);
    }
    // With an unknown bot id every mention counts as "the bot", so drop leftover placeholders.
    text = text.replace(/@_user_\d+/g, "");
    return text
      .replace(/[ \t]{2,}/g, " ")
      .replace(/^[ \t]+/gm, "")
      .trim();
  }

  private async downloadMedia(
    messageId: string,
    fileKey: string,
    resType: "image" | "file",
    kind: InboundAttachment["type"],
    name: string | undefined,
  ): Promise<InboundAttachment> {
    if (!this.client) {
      throw new Error("Feishu client not started");
    }
    const res = await this.client.im.messageResource.get({
      params: { type: resType },
      path: { message_id: messageId, file_key: fileKey },
    });
    let data: Buffer;
    if (typeof res?.getReadableStream === "function") {
      data = await streamToBuffer(res.getReadableStream(), MAX_INLINE_MEDIA_BYTES);
    } else if (Buffer.isBuffer(res)) {
      data = res;
    } else if (Buffer.isBuffer(res?.data)) {
      data = res.data;
    } else {
      throw new Error("Feishu messageResource.get returned no readable data");
    }
    const localPath = await saveInboundMedia(this.mediaDir, this.name, messageId, name ?? fileKey, data);
    const mimeType = res?.headers?.["content-type"];
    return {
      type: kind,
      name,
      mimeType: typeof mimeType === "string" ? mimeType : undefined,
      sizeBytes: data.byteLength,
      localPath,
      guid: fileKey,
    };
  }

  async sendMessage(msg: OutboundMessage): Promise<{ messageId?: string } | void> {
    const client = this.requireClient();
    let lastId: string | undefined;
    let replyTo = msg.replyToMessageId;

    for (const chunk of chunkText(msg.text ?? "", MAX_TEXT)) {
      const [msgType, content] = msg.markdown
        ? ([
            "post",
            { zh_cn: { content: [[{ tag: "md", text: chunk }]] } },
          ] as const)
        : (["text", { text: chunk }] as const);
      lastId = (await this.deliver(client, msg.chatId, replyTo, msgType, content)) ?? lastId;
      replyTo = undefined; // only quote-reply on the first chunk
    }

    for (const att of msg.attachments ?? []) {
      try {
        const data = await this.loadAttachment(att);
        const name = att.name ?? (att.path ? path.basename(att.path) : "attachment");
        if (looksLikeImage(att)) {
          const up = await client.im.image.create({
            data: { image_type: "message", image: data },
          });
          const imageKey = up?.image_key ?? up?.data?.image_key;
          if (!imageKey) {
            throw new Error("Feishu image upload returned no image_key");
          }
          lastId =
            (await this.deliver(client, msg.chatId, replyTo, "image", { image_key: imageKey })) ??
            lastId;
        } else {
          const up = await client.im.file.create({
            data: { file_type: "stream", file_name: name, file: data },
          });
          const fileKey = up?.file_key ?? up?.data?.file_key;
          if (!fileKey) {
            throw new Error("Feishu file upload returned no file_key");
          }
          lastId =
            (await this.deliver(client, msg.chatId, replyTo, "file", { file_key: fileKey })) ??
            lastId;
        }
        replyTo = undefined;
      } catch (err) {
        this.noteError(err);
        throw err;
      }
    }

    this.noteOutbound();
    return { messageId: lastId };
  }

  private async deliver(
    client: FeishuClientLike,
    chatId: string,
    replyTo: string | undefined,
    msgType: string,
    content: unknown,
  ): Promise<string | undefined> {
    const body = { msg_type: msgType, content: JSON.stringify(content) };
    let res: any;
    if (replyTo) {
      try {
        res = await client.im.message.reply({ path: { message_id: replyTo }, data: body });
        this.assertOk(res);
      } catch (err) {
        // Quoted message may have been recalled: fall back to a plain send.
        this.noteError(err);
        res = undefined;
      }
    }
    if (!res) {
      res = await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, ...body },
      });
      this.assertOk(res);
    }
    return res?.data?.message_id ?? res?.message_id;
  }

  private assertOk(res: any): void {
    if (res && typeof res.code === "number" && res.code !== 0) {
      throw new Error(`Feishu API error ${res.code}: ${res.msg ?? "unknown"}`);
    }
  }

  private async loadAttachment(att: OutboundAttachment): Promise<Buffer> {
    if (att.buffer) {
      return att.buffer;
    }
    if (att.path) {
      return readFile(att.path);
    }
    if (att.url) {
      return downloadToBuffer(att.url);
    }
    throw new Error("Outbound attachment has no buffer, path, or url");
  }

  async react(_chatId: string, messageId: string, emoji: string): Promise<void> {
    const type = toFeishuEmojiType(emoji);
    if (!type) {
      return;
    }
    try {
      await this.requireClient().im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: type } },
      });
    } catch (err) {
      this.noteError(errorMessage(err));
    }
  }

  private requireClient(): FeishuClientLike {
    if (!this.client) {
      throw new Error("Feishu adapter not started");
    }
    return this.client;
  }
}

export function createAdapter(config: GatewayConfig): ChannelAdapter {
  return new FeishuChannelAdapter(config);
}
