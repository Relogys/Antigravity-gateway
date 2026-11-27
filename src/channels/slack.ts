import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GatewayConfig } from "../config.js";
import type {
  AttachmentKind,
  ChannelAdapter,
  InboundAttachment,
  InboundMessage,
  OutboundMessage,
} from "../types.js";
import { BaseChannelAdapter, type InboundHandler } from "./base.js";
import { stripIdeFileLinks } from "./format.js";
import {
  BoundedDedupeCache,
  MAX_INLINE_MEDIA_BYTES,
  chunkText,
  downloadToBuffer,
  isMentioned,
  saveInboundMedia,
  type DownloadOptions,
} from "./utils.js";

const SLACK_MAX_TEXT = 3900;
const MAX_TRACKED_THREADS = 2000;

/** Slack message subtypes that carry real user content. */
const ACCEPTED_SUBTYPES = new Set<string | undefined>([undefined, "file_share", "thread_broadcast"]);

const EMOJI_TO_SLACK: Record<string, string> = {
  "👀": "eyes",
  "👍": "+1",
  "👎": "-1",
  "✅": "white_check_mark",
  "❌": "x",
  "❤": "heart",
  "🎉": "tada",
  "🔥": "fire",
  "🙏": "pray",
  "😂": "joy",
  "🤔": "thinking_face",
  "⏳": "hourglass_flowing_sand",
  "⚠": "warning",
  "🚀": "rocket",
  "💡": "bulb",
  "🤖": "robot_face",
  "👌": "ok_hand",
  "🙌": "raised_hands",
  "😀": "grinning",
  "😅": "sweat_smile",
  "😢": "cry",
  "💯": "100",
  "✨": "sparkles",
  "🛠": "hammer_and_wrench",
  "✍": "writing_hand",
  "🧠": "brain",
};

/** Map an emoji (unicode, `:name:` or bare name) to a Slack reaction name. */
export function toSlackReactionName(emoji: string): string | undefined {
  const trimmed = emoji.trim().replace(/\uFE0F/g, "");
  if (!trimmed) {
    return undefined;
  }
  const mapped = EMOJI_TO_SLACK[trimmed];
  if (mapped) {
    return mapped;
  }
  const named = trimmed.replace(/^:|:$/g, "");
  return /^[a-z0-9_+-]+$/i.test(named) ? named.toLowerCase() : undefined;
}

/* ------------------------------------------------------------------------ *
 * Minimal structural view of the Bolt App so tests can inject a fake.
 * ------------------------------------------------------------------------ */

export interface SlackFileLike {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
}

export interface SlackEventLike {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  channel: string;
  channel_type?: string;
  files?: SlackFileLike[];
}

type SlackEventHandler = (args: { event: SlackEventLike }) => Promise<void> | void;

export interface SlackAppLike {
  event(name: string, handler: SlackEventHandler): unknown;
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
  client: {
    auth: { test(args: { token: string }): Promise<{ user_id?: string; bot_id?: string }> };
    chat: {
      postMessage(args: Record<string, unknown>): Promise<{ ts?: string }>;
      update(args: Record<string, unknown>): Promise<unknown>;
      delete?: (args: {
        token?: string;
        channel: string;
        ts: string;
      }) => Promise<unknown>;
    };
    reactions: { add(args: Record<string, unknown>): Promise<unknown> };
    filesUploadV2?: (args: Record<string, unknown>) => Promise<unknown>;
  };
}

export type SlackAppFactory = (cfg: {
  botToken: string;
  appToken: string;
}) => SlackAppLike | Promise<SlackAppLike>;

export interface SlackAdapterOptions {
  appFactory?: SlackAppFactory;
  download?: (url: string, options?: DownloadOptions) => Promise<Buffer>;
  mediaDir?: string;
}

async function defaultAppFactory(cfg: { botToken: string; appToken: string }): Promise<SlackAppLike> {
  const { App, LogLevel } = await import("@slack/bolt");
  return new App({
    token: cfg.botToken,
    appToken: cfg.appToken,
    socketMode: true,
    logLevel: LogLevel.ERROR,
  }) as unknown as SlackAppLike;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function kindFromMime(mime: string | undefined): AttachmentKind {
  if (!mime) {
    return "file";
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
  return "file";
}

/** Convert Slack mrkdwn link/entity encoding back to plain text. */
function decodeSlackText(text: string): string {
  return text
    .replace(/<(https?:[^|>]+|mailto:[^|>]+)(?:\|[^>]*)?>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export class SlackChannelAdapter extends BaseChannelAdapter {
  readonly name = "slack";

  private readonly botToken: string;
  private readonly appToken: string;
  private readonly groupMentionPatterns: string[];
  private readonly appFactory: SlackAppFactory;
  private readonly download: NonNullable<SlackAdapterOptions["download"]>;
  private readonly mediaDir: string;
  private readonly dedupe = new BoundedDedupeCache();
  /** chatId -> thread_ts of the most recent in-thread inbound message. */
  private readonly threads = new Map<string, string>();

  private app?: SlackAppLike;
  private botUserId?: string;

  constructor(config: GatewayConfig, options: SlackAdapterOptions = {}) {
    super();
    if (!config.slack) {
      throw new Error("Slack is not configured (SLACK_BOT_TOKEN / SLACK_APP_TOKEN missing)");
    }
    this.botToken = config.slack.botToken;
    this.appToken = config.slack.appToken;
    this.groupMentionPatterns = config.groupMentionPatterns ?? [];
    this.appFactory = options.appFactory ?? defaultAppFactory;
    this.download = options.download ?? downloadToBuffer;
    this.mediaDir = options.mediaDir ?? path.join(config.dataDir, "media");
  }

  async start(onMessage: InboundHandler): Promise<void> {
    if (this.app) {
      return;
    }
    this.handler = onMessage;
    const app = await this.appFactory({ botToken: this.botToken, appToken: this.appToken });
    this.app = app;

    app.event("message", async ({ event }) => {
      await this.handleEvent(event, false).catch((err) => this.noteError(err));
    });
    app.event("app_mention", async ({ event }) => {
      await this.handleEvent(event, true).catch((err) => this.noteError(err));
    });

    try {
      await app.start();
    } catch (err) {
      this.noteError(err);
      this.app = undefined;
      this.handler = undefined;
      throw err;
    }
    this.setConnected(true);

    try {
      const auth = await app.client.auth.test({ token: this.botToken });
      this.botUserId = auth.user_id;
    } catch (err) {
      this.noteError(err);
    }
  }

  async stop(): Promise<void> {
    const app = this.app;
    this.app = undefined;
    this.handler = undefined;
    this.setConnected(false);
    this.threads.clear();
    if (app) {
      try {
        await app.stop();
      } catch (err) {
        this.noteError(err);
      }
    }
  }

  // ---------------------------------------------------------------- outbound

  async sendMessage(msg: OutboundMessage): Promise<{ messageId?: string } | void> {
    const app = this.requireApp();
    const threadTs = this.resolveThread(msg.chatId, msg.replyToMessageId);
    const text =
      msg.markdown === true ? stripIdeFileLinks(msg.text ?? "") : (msg.text ?? "");
    const chunks = chunkText(text, SLACK_MAX_TEXT);
    let lastTs: string | undefined;

    for (const chunk of chunks) {
      const res = await app.client.chat.postMessage({
        token: this.botToken,
        channel: msg.chatId,
        text: chunk,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      lastTs = res.ts ?? lastTs;
    }

    for (const att of msg.attachments ?? []) {
      const ts = await this.sendAttachment(app, msg.chatId, att, threadTs);
      lastTs = ts ?? lastTs;
    }

    if (chunks.length === 0 && !msg.attachments?.length) {
      return;
    }
    this.noteOutbound();
    return lastTs ? { messageId: lastTs } : undefined;
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    const name = toSlackReactionName(emoji);
    if (!name) {
      return;
    }
    try {
      await this.requireApp().client.reactions.add({
        token: this.botToken,
        channel: chatId,
        timestamp: messageId,
        name,
      });
    } catch (err) {
      if (!/already_reacted/.test(String(err instanceof Error ? err.message : err))) {
        this.noteError(err);
      }
    }
  }

  async editMessage(
    chatId: string,
    messageId: string,
    text: string,
    options?: { markdown?: boolean },
  ): Promise<void> {
    const next = options?.markdown === true ? stripIdeFileLinks(text) : text;
    await this.requireApp().client.chat.update({
      token: this.botToken,
      channel: chatId,
      ts: messageId,
      text: next.slice(0, SLACK_MAX_TEXT + 100) || "…",
    });
  }

  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    await this.requireApp().client.chat.delete?.({
      token: this.botToken,
      channel: chatId,
      ts: messageId,
    });
  }

  // ----------------------------------------------------------------- inbound

  private async handleEvent(event: SlackEventLike, isMention: boolean): Promise<void> {
    if (!this.app) {
      return;
    }
    if (event.bot_id || event.subtype === "bot_message") {
      return;
    }
    if (!ACCEPTED_SUBTYPES.has(event.subtype)) {
      return;
    }
    if (!event.user || (this.botUserId && event.user === this.botUserId)) {
      return;
    }
    if (this.dedupe.seen(`${event.channel}:${event.ts}`)) {
      return;
    }

    const isDm = event.channel_type === "im";
    const isGroup = !isDm;
    const rawText = event.text ?? "";

    let mentionsBot = true;
    if (isGroup) {
      const viaTag = this.botUserId
        ? rawText.includes(`<@${this.botUserId}>`)
        : false;
      mentionsBot = isMention || viaTag || isMentioned(decodeSlackText(rawText), this.groupMentionPatterns);
    }

    let text = rawText;
    if (this.botUserId) {
      text = text.replace(new RegExp(`<@${escapeRegExp(this.botUserId)}>[:,]?\\s*`, "g"), " ");
    }
    text = decodeSlackText(text).trim();

    // Track thread continuity per chat so replies stay in-thread.
    if (event.thread_ts) {
      this.trackThread(event.channel, event.thread_ts);
    } else {
      this.threads.delete(event.channel);
    }

    const attachments = await this.collectAttachments(event);
    if (!text && attachments.length === 0) {
      return;
    }

    const inbound: InboundMessage = {
      id: event.ts,
      channel: this.name,
      chatId: event.channel,
      senderId: event.user,
      isGroup,
      text,
      attachments,
      replyToMessageId: event.thread_ts,
      timestamp: Math.round(Number(event.ts) * 1000) || Date.now(),
      mentionsBot,
      raw: event,
    };
    await this.emit(inbound);
  }

  private async collectAttachments(event: SlackEventLike): Promise<InboundAttachment[]> {
    const out: InboundAttachment[] = [];
    for (const file of event.files ?? []) {
      const url = file.url_private_download ?? file.url_private;
      if (!url) {
        continue;
      }
      try {
        if ((file.size ?? 0) > MAX_INLINE_MEDIA_BYTES) {
          throw new Error(`Slack file exceeds ${MAX_INLINE_MEDIA_BYTES} bytes`);
        }
        const data = await this.download(url, {
          headers: { Authorization: `Bearer ${this.botToken}` },
        });
        const name = file.name ?? file.title;
        const localPath = await saveInboundMedia(
          this.mediaDir,
          this.name,
          `${event.ts}-${file.id ?? out.length}`,
          name,
          data,
        );
        out.push({
          type: kindFromMime(file.mimetype),
          mimeType: file.mimetype,
          name,
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

  private requireApp(): SlackAppLike {
    if (!this.app) {
      throw new Error("Slack adapter is not started");
    }
    return this.app;
  }

  private trackThread(chatId: string, threadTs: string): void {
    this.threads.delete(chatId);
    this.threads.set(chatId, threadTs);
    if (this.threads.size > MAX_TRACKED_THREADS) {
      const oldest = this.threads.keys().next().value;
      if (oldest !== undefined) {
        this.threads.delete(oldest);
      }
    }
  }

  /**
   * Pick the `thread_ts` for an outbound message. DMs (`D…` ids) only thread when
   * continuing a thread the user started; channels honour the explicit reply target.
   */
  private resolveThread(chatId: string, replyTo?: string): string | undefined {
    const tracked = this.threads.get(chatId);
    if (!replyTo) {
      return tracked;
    }
    if (chatId.startsWith("D") && tracked !== replyTo) {
      return tracked;
    }
    return replyTo;
  }

  private async sendAttachment(
    app: SlackAppLike,
    chatId: string,
    att: NonNullable<OutboundMessage["attachments"]>[number],
    threadTs: string | undefined,
  ): Promise<string | undefined> {
    const label = att.name ?? (att.path ? path.basename(att.path) : att.url ?? "attachment");

    if (att.url && !att.buffer && !att.path) {
      const res = await app.client.chat.postMessage({
        token: this.botToken,
        channel: chatId,
        text: att.url,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      return res.ts;
    }

    let data: Buffer | undefined = att.buffer;
    if (!data && att.path) {
      data = await readFile(att.path);
    }
    if (!data) {
      return undefined;
    }

    const upload = app.client.filesUploadV2;
    if (typeof upload === "function") {
      try {
        await upload.call(app.client, {
          token: this.botToken,
          channel_id: chatId,
          file: data,
          filename: label,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        });
        return undefined;
      } catch (err) {
        this.noteError(err);
      }
    }

    // Graceful fallback when uploads are unavailable or fail.
    const res = await app.client.chat.postMessage({
      token: this.botToken,
      channel: chatId,
      text: `(attachment "${label}" could not be uploaded)`,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    return res.ts;
  }
}

export function createAdapter(config: GatewayConfig): ChannelAdapter {
  return new SlackChannelAdapter(config);
}
