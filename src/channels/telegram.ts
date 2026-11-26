import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GatewayConfig } from "../config.js";
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
  MAX_INLINE_MEDIA_BYTES,
  chunkText,
  downloadToBuffer,
  errorMessage,
  isMentioned,
  reconnectDelayMs,
  saveInboundMedia,
  sleepWithAbort,
  type DownloadOptions,
} from "./utils.js";

const TELEGRAM_API = "https://api.telegram.org";
const TELEGRAM_MAX_TEXT = 4000;
const TELEGRAM_EDIT_MAX_TEXT = 4096;
const DEFAULT_POLL_TIMEOUT_SEC = 30;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface TelegramAdapterOptions {
  /** Injected fetch (tests). Defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Injected file downloader (tests). Defaults to `downloadToBuffer`. */
  download?: (url: string, options?: DownloadOptions) => Promise<Buffer>;
  /** Directory for saved inbound media. Defaults to `<dataDir>/media`. */
  mediaDir?: string;
  /** Override the Bot API base URL. */
  apiBase?: string;
  /** Override the error backoff (attempt -> ms). */
  backoffMs?: (attempt: number) => number;
}

interface TgUser {
  id: number;
  is_bot?: boolean;
  username?: string;
}

interface TgFileRef {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  file_name?: string;
  mime_type?: string;
  width?: number;
  height?: number;
}

interface TgMessage {
  message_id: number;
  date?: number;
  chat: { id: number | string; type: string };
  from?: TgUser;
  text?: string;
  caption?: string;
  photo?: TgFileRef[];
  document?: TgFileRef;
  voice?: TgFileRef;
  audio?: TgFileRef;
  video?: TgFileRef;
  reply_to_message?: { message_id: number; from?: TgUser };
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

interface TgApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function attachmentKindFromMime(mime: string | undefined, fallback: AttachmentKind): AttachmentKind {
  if (!mime) {
    return fallback;
  }
  if (mime.startsWith("image/")) {
    return "image";
  }
  if (mime.startsWith("audio/")) {
    return "audio";
  }
  if (mime.startsWith("video/")) {
    return "video";
  }
  return fallback;
}

const IMAGE_EXT_RE = /\.(png|jpe?g|webp)$/i;

function isPhotoAttachment(att: OutboundAttachment): boolean {
  if (att.mimeType) {
    return /^image\/(png|jpe?g|webp)$/i.test(att.mimeType);
  }
  const name = att.name ?? att.path ?? att.url ?? "";
  return IMAGE_EXT_RE.test(name.split("?")[0] ?? "");
}

export class TelegramChannelAdapter extends BaseChannelAdapter {
  readonly name = "telegram";

  private readonly token: string;
  private readonly pollTimeoutSec: number;
  private readonly groupMentionPatterns: string[];
  private readonly fetchImpl: FetchLike;
  private readonly download: NonNullable<TelegramAdapterOptions["download"]>;
  private readonly mediaDir: string;
  private readonly apiBase: string;
  private readonly backoff: (attempt: number) => number;
  private readonly dedupe = new BoundedDedupeCache();

  private abort?: AbortController;
  private loop?: Promise<void>;
  private offset = 0;
  private botId?: number;
  private botUsername?: string;

  constructor(config: GatewayConfig, options: TelegramAdapterOptions = {}) {
    super();
    if (!config.telegram) {
      throw new Error("Telegram is not configured (TELEGRAM_BOT_TOKEN missing)");
    }
    this.token = config.telegram.botToken;
    this.pollTimeoutSec = Math.max(0, config.telegram.pollTimeoutSec ?? DEFAULT_POLL_TIMEOUT_SEC);
    this.groupMentionPatterns = config.groupMentionPatterns ?? [];
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.download = options.download ?? downloadToBuffer;
    this.mediaDir = options.mediaDir ?? path.join(config.dataDir, "media");
    this.apiBase = options.apiBase ?? TELEGRAM_API;
    this.backoff = options.backoffMs ?? ((attempt) => reconnectDelayMs(attempt));
  }

  async start(onMessage: InboundHandler): Promise<void> {
    if (this.abort) {
      return;
    }
    this.handler = onMessage;
    const abort = new AbortController();
    this.abort = abort;

    // One bounded attempt to learn the bot identity; the loop retries on failure.
    try {
      await this.loadBotIdentity(abort.signal);
      if (abort.signal.aborted) {
        return;
      }
      this.setConnected(true);
    } catch (err) {
      if (abort.signal.aborted) {
        return;
      }
      this.noteError(err);
    }

    if (abort.signal.aborted) {
      return;
    }
    this.loop = this.pollLoop(abort.signal);
  }

  async stop(): Promise<void> {
    const abort = this.abort;
    this.abort = undefined;
    abort?.abort();
    this.setConnected(false);
    try {
      await this.loop;
    } catch {
      // loop errors are already recorded
    }
    this.loop = undefined;
    this.handler = undefined;
  }

  // ---------------------------------------------------------------- outbound

  async sendMessage(msg: OutboundMessage): Promise<{ messageId?: string } | void> {
    let lastId: string | undefined;
    const chunks = chunkText(msg.text ?? "", TELEGRAM_MAX_TEXT);
    const replyTo = msg.replyToMessageId ? Number(msg.replyToMessageId) : undefined;
    let replyParams: Record<string, unknown> | undefined =
      replyTo !== undefined && Number.isFinite(replyTo)
        ? { message_id: replyTo, allow_sending_without_reply: true }
        : undefined;

    for (const chunk of chunks) {
      const body: Record<string, unknown> = { chat_id: msg.chatId, text: chunk };
      if (replyParams) {
        body.reply_parameters = replyParams;
        replyParams = undefined; // only the first chunk quotes the original
      }
      const sent = await this.call<{ message_id: number }>("sendMessage", body);
      lastId = String(sent.message_id);
    }

    for (const att of msg.attachments ?? []) {
      const sentId = await this.sendAttachment(msg.chatId, att, replyParams);
      replyParams = undefined;
      if (sentId) {
        lastId = sentId;
      }
    }

    if (lastId === undefined && chunks.length === 0 && !(msg.attachments?.length)) {
      return;
    }
    this.noteOutbound();
    return lastId ? { messageId: lastId } : undefined;
  }

  async sendTyping(chatId: string, active: boolean): Promise<void> {
    if (!active) {
      return;
    }
    try {
      await this.call("sendChatAction", { chat_id: chatId, action: "typing" });
    } catch (err) {
      this.noteError(err);
    }
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    try {
      await this.call("setMessageReaction", {
        chat_id: chatId,
        message_id: Number(messageId),
        reaction: [{ type: "emoji", emoji }],
      });
    } catch (err) {
      this.noteError(err);
    }
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    await this.call("editMessageText", {
      chat_id: chatId,
      message_id: Number(messageId),
      text: text.slice(0, TELEGRAM_EDIT_MAX_TEXT) || "…",
    });
  }

  // ----------------------------------------------------------------- inbound

  private async loadBotIdentity(signal?: AbortSignal): Promise<void> {
    const me = await this.call<TgUser>("getMe", {}, signal);
    this.botId = me.id;
    this.botUsername = me.username;
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    let attempt = 0;
    while (!signal.aborted) {
      try {
        if (this.botId === undefined) {
          await this.loadBotIdentity(signal);
        }
        const updates = await this.call<TgUpdate[]>(
          "getUpdates",
          {
            offset: this.offset || undefined,
            timeout: this.pollTimeoutSec,
            allowed_updates: ["message"],
          },
          signal,
          (this.pollTimeoutSec + 15) * 1000,
        );
        this.setConnected(true);
        attempt = 0;
        for (const update of updates) {
          if (signal.aborted) {
            return;
          }
          this.offset = Math.max(this.offset, update.update_id + 1);
          try {
            await this.handleUpdate(update);
          } catch (err) {
            this.noteError(err);
          }
        }
      } catch (err) {
        if (signal.aborted) {
          return;
        }
        this.setConnected(false);
        this.noteError(err);
        await sleepWithAbort(this.backoff(attempt), signal);
        attempt += 1;
      }
    }
  }

  private async handleUpdate(update: TgUpdate): Promise<void> {
    const message = update.message;
    if (!message) {
      return;
    }
    if (this.dedupe.seen(`update:${update.update_id}`)) {
      return;
    }
    if (this.dedupe.seen(`msg:${message.chat.id}:${message.message_id}`)) {
      return;
    }
    if (message.from?.is_bot) {
      return;
    }

    const inbound = await this.toInbound(message);
    if (!inbound) {
      return;
    }
    await this.emit(inbound);
  }

  private async toInbound(message: TgMessage): Promise<InboundMessage | undefined> {
    const chatId = String(message.chat.id);
    const isGroup = message.chat.type === "group" || message.chat.type === "supergroup";
    const rawText = message.text ?? message.caption ?? "";
    const attachments = await this.collectAttachments(message);

    if (!rawText.trim() && attachments.length === 0) {
      return undefined;
    }

    let text = rawText;
    let mentionsBot = true;
    if (isGroup) {
      const username = this.botUsername;
      const mentionRe = username ? new RegExp(`@${escapeRegExp(username)}\\b`, "gi") : undefined;
      const viaUsername = mentionRe ? new RegExp(mentionRe.source, "i").test(rawText) : false;
      const viaPattern = isMentioned(rawText, this.groupMentionPatterns);
      const reply = message.reply_to_message?.from;
      const viaReply =
        reply !== undefined &&
        ((this.botId !== undefined && reply.id === this.botId) ||
          (username !== undefined && reply.username?.toLowerCase() === username.toLowerCase()));
      mentionsBot = viaUsername || viaPattern || Boolean(viaReply);
      if (mentionRe) {
        text = rawText.replace(mentionRe, " ").replace(/[ \t]{2,}/g, " ").trim();
      }
    }

    return {
      id: String(message.message_id),
      channel: this.name,
      chatId,
      senderId: String(message.from?.id ?? message.chat.id),
      isGroup,
      text: text.trim(),
      attachments,
      replyToMessageId: message.reply_to_message
        ? String(message.reply_to_message.message_id)
        : undefined,
      timestamp: (message.date ?? Math.floor(Date.now() / 1000)) * 1000,
      mentionsBot,
      raw: message,
    };
  }

  private async collectAttachments(message: TgMessage): Promise<InboundAttachment[]> {
    const jobs: Array<{ ref: TgFileRef; kind: AttachmentKind; name: string; mime?: string }> = [];

    if (message.photo?.length) {
      const largest = message.photo.reduce((best, cur) => {
        const bestScore = best.file_size ?? (best.width ?? 0) * (best.height ?? 0);
        const curScore = cur.file_size ?? (cur.width ?? 0) * (cur.height ?? 0);
        return curScore >= bestScore ? cur : best;
      });
      jobs.push({ ref: largest, kind: "image", name: `photo-${message.message_id}.jpg`, mime: "image/jpeg" });
    }
    if (message.document) {
      const d = message.document;
      jobs.push({
        ref: d,
        kind: attachmentKindFromMime(d.mime_type, "file"),
        name: d.file_name ?? `document-${message.message_id}`,
        mime: d.mime_type,
      });
    }
    if (message.voice) {
      const v = message.voice;
      jobs.push({ ref: v, kind: "audio", name: `voice-${message.message_id}.ogg`, mime: v.mime_type ?? "audio/ogg" });
    }
    if (message.audio) {
      const a = message.audio;
      jobs.push({
        ref: a,
        kind: "audio",
        name: a.file_name ?? `audio-${message.message_id}.mp3`,
        mime: a.mime_type,
      });
    }
    if (message.video) {
      const v = message.video;
      jobs.push({
        ref: v,
        kind: "video",
        name: v.file_name ?? `video-${message.message_id}.mp4`,
        mime: v.mime_type,
      });
    }

    const out: InboundAttachment[] = [];
    for (const job of jobs) {
      try {
        if ((job.ref.file_size ?? 0) > MAX_INLINE_MEDIA_BYTES) {
          throw new Error(`Telegram file ${job.name} exceeds ${MAX_INLINE_MEDIA_BYTES} bytes`);
        }
        const file = await this.call<{ file_path?: string; file_size?: number }>("getFile", {
          file_id: job.ref.file_id,
        });
        if (!file.file_path) {
          throw new Error("Telegram getFile returned no file_path");
        }
        const data = await this.download(
          `${this.apiBase}/file/bot${this.token}/${file.file_path}`,
        );
        const localPath = await saveInboundMedia(
          this.mediaDir,
          this.name,
          `${message.chat.id}-${message.message_id}`,
          job.name,
          data,
        );
        out.push({
          type: job.kind,
          mimeType: job.mime,
          name: job.name,
          sizeBytes: data.byteLength,
          data,
          localPath,
        });
      } catch (err) {
        this.noteError(err);
      }
    }
    return out;
  }

  // ----------------------------------------------------------------- helpers

  private async sendAttachment(
    chatId: string,
    att: OutboundAttachment,
    replyParams?: Record<string, unknown>,
  ): Promise<string | undefined> {
    const asPhoto = isPhotoAttachment(att);
    const method = asPhoto ? "sendPhoto" : "sendDocument";
    const field = asPhoto ? "photo" : "document";

    if (att.url && !att.buffer && !att.path) {
      const body: Record<string, unknown> = { chat_id: chatId, [field]: att.url };
      if (replyParams) {
        body.reply_parameters = replyParams;
      }
      const sent = await this.call<{ message_id: number }>(method, body);
      return String(sent.message_id);
    }

    let data: Buffer;
    if (att.buffer) {
      data = att.buffer;
    } else if (att.path) {
      data = await readFile(att.path);
    } else {
      return undefined;
    }
    const filename = att.name ?? (att.path ? path.basename(att.path) : `attachment${asPhoto ? ".jpg" : ".bin"}`);
    const form = new FormData();
    form.append("chat_id", chatId);
    if (replyParams) {
      form.append("reply_parameters", JSON.stringify(replyParams));
    }
    form.append(
      field,
      new Blob([new Uint8Array(data)], { type: att.mimeType ?? "application/octet-stream" }),
      filename,
    );
    const sent = await this.call<{ message_id: number }>(method, form);
    return String(sent.message_id);
  }

  private async call<T = unknown>(
    method: string,
    body: Record<string, unknown> | FormData,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ): Promise<T> {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) {
      signals.push(signal);
    }
    const init: RequestInit = {
      method: "POST",
      signal: AbortSignal.any(signals),
    };
    if (body instanceof FormData) {
      init.body = body;
    } else {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }

    const res = await this.fetchImpl(`${this.apiBase}/bot${this.token}/${method}`, init);
    let payload: TgApiResponse<T> | undefined;
    try {
      payload = (await res.json()) as TgApiResponse<T>;
    } catch (err) {
      throw new Error(`Telegram ${method} returned a non-JSON response (HTTP ${res.status}): ${errorMessage(err)}`);
    }
    if (!res.ok || !payload?.ok) {
      throw new Error(
        `Telegram ${method} failed: ${payload?.description ?? `HTTP ${res.status}`}`,
      );
    }
    return payload.result as T;
  }
}

export function createAdapter(config: GatewayConfig): ChannelAdapter {
  return new TelegramChannelAdapter(config);
}
