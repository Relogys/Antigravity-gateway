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
import { MAX_INBOUND_MEDIA_BYTES, downloadInboundMedia } from "./media.js";
import {
  BoundedDedupeCache,
  MAX_INLINE_MEDIA_BYTES,
  chunkText,
  downloadToBuffer,
  isMentioned,
  saveInboundMedia,
  type DownloadOptions,
} from "./utils.js";

const DISCORD_MAX_TEXT = 1950;
const DISCORD_EDIT_MAX_TEXT = 2000;
const DISCORD_MAX_FILES_PER_MESSAGE = 10;
const MAX_CACHED_MESSAGES = 500;
const READY_WAIT_MS = 15_000;

/* ------------------------------------------------------------------------ *
 * Minimal structural views of the discord.js objects this adapter touches,
 * so tests can inject lightweight fakes.
 * ------------------------------------------------------------------------ */

export interface DiscordAttachmentLike {
  id?: string;
  url: string;
  name?: string | null;
  contentType?: string | null;
  size?: number;
}

export interface DiscordReactionLike {
  users?: { remove(userId: string): Promise<unknown> };
}

export interface DiscordMessageLike {
  id: string;
  channelId: string;
  content: string;
  createdTimestamp?: number;
  author: { id: string; bot?: boolean };
  guild?: unknown | null;
  mentions: { has(target: unknown): boolean; repliedUser?: { id: string } | null };
  reference?: { messageId?: string | null } | null;
  attachments?: { values(): Iterable<DiscordAttachmentLike> } | Iterable<DiscordAttachmentLike>;
  reactions?: {
    cache?: Map<string, DiscordReactionLike> | { get(key: string): DiscordReactionLike | undefined };
  };
  react?(emoji: string): Promise<unknown>;
  edit?(content: string): Promise<unknown>;
  channel?: {
    messages?: { cache?: { get?(id: string): DiscordMessageLike | undefined } };
  };
}

export interface DiscordSendableChannel {
  send(options: Record<string, unknown>): Promise<{ id: string }>;
  sendTyping?(): Promise<unknown>;
  messages?: {
    fetch(id: string): Promise<DiscordMessageLike>;
    cache?: { get?(id: string): DiscordMessageLike | undefined };
  };
}

export interface DiscordClientLike {
  user: { id: string } | null;
  channels: { fetch(id: string): Promise<unknown> };
  on(event: string, listener: (...args: any[]) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
  login(token: string): Promise<unknown>;
  destroy(): Promise<void> | void;
  isReady?(): boolean;
}

export type DiscordClientFactory = (config: {
  token: string;
}) => DiscordClientLike | Promise<DiscordClientLike>;

export interface DiscordAdapterOptions {
  clientFactory?: DiscordClientFactory;
  download?: (url: string, options?: DownloadOptions) => Promise<Buffer>;
  fetchImpl?: typeof fetch;
  mediaDir?: string;
  /** Max wait for the gateway "ready" event after login (ms). */
  readyTimeoutMs?: number;
}

async function defaultClientFactory(): Promise<DiscordClientLike> {
  const { Client, GatewayIntentBits, Partials } = await import("discord.js");
  const client = new Client({
    intents:
      GatewayIntentBits.Guilds |
      GatewayIntentBits.GuildMessages |
      GatewayIntentBits.DirectMessages |
      GatewayIntentBits.MessageContent,
    partials: [Partials.Channel, Partials.Message],
  });
  return client as unknown as DiscordClientLike;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function kindFromMime(mime: string | null | undefined): AttachmentKind {
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

function iterateAttachments(
  source: DiscordMessageLike["attachments"],
): DiscordAttachmentLike[] {
  if (!source) {
    return [];
  }
  const maybeValues = (source as { values?: () => Iterable<DiscordAttachmentLike> }).values;
  if (typeof maybeValues === "function") {
    return [...maybeValues.call(source)];
  }
  return [...(source as Iterable<DiscordAttachmentLike>)];
}

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)$/i;

function isInboundImage(att: DiscordAttachmentLike): boolean {
  if (att.contentType?.toLowerCase().startsWith("image/")) {
    return true;
  }
  const name = att.name ?? att.url.split("?")[0] ?? "";
  return IMAGE_EXT_RE.test(name);
}

export class DiscordChannelAdapter extends BaseChannelAdapter {
  readonly name = "discord";

  private readonly token: string;
  private readonly groupMentionPatterns: string[];
  private readonly clientFactory: DiscordClientFactory;
  private readonly download: NonNullable<DiscordAdapterOptions["download"]>;
  private readonly fetchImpl: typeof fetch;
  private readonly mediaDir: string;
  private readonly useInboundMediaBridge: boolean;
  private readonly readyTimeoutMs: number;
  private readonly dedupe = new BoundedDedupeCache();
  private readonly recentMessages = new Map<
    string,
    { message: DiscordMessageLike; lastReaction?: string }
  >();

  private client?: DiscordClientLike;
  private cancelReadyWait?: () => void;

  constructor(config: GatewayConfig, options: DiscordAdapterOptions = {}) {
    super();
    if (!config.discord) {
      throw new Error("Discord is not configured (DISCORD_BOT_TOKEN missing)");
    }
    this.token = config.discord.botToken;
    this.groupMentionPatterns = config.groupMentionPatterns ?? [];
    this.clientFactory = options.clientFactory ?? defaultClientFactory;
    this.download = options.download ?? downloadToBuffer;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.mediaDir = options.mediaDir ?? path.join(config.dataDir, "media");
    // An injected downloader is a test seam; production uses the media bridge.
    this.useInboundMediaBridge = options.download === undefined;
    this.readyTimeoutMs = options.readyTimeoutMs ?? READY_WAIT_MS;
  }

  async start(onMessage: InboundHandler): Promise<void> {
    if (this.client) {
      return;
    }
    this.handler = onMessage;
    const client = await this.clientFactory({ token: this.token });
    this.client = client;

    const ready = new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          if (this.cancelReadyWait === finish) {
            this.cancelReadyWait = undefined;
          }
          resolve();
        }
      };
      this.cancelReadyWait = finish;
      const timer = setTimeout(finish, this.readyTimeoutMs);
      timer.unref?.();
      client.once("clientReady", () => {
        this.setConnected(true);
        finish();
      });
    });

    client.on("messageCreate", (message: DiscordMessageLike) => {
      void this.handleMessage(message).catch((err) => this.noteError(err));
    });
    client.on("shardResume", () => this.setConnected(true));
    client.on("shardReconnecting", () => this.setConnected(false));
    client.on("shardDisconnect", () => this.setConnected(false));
    client.on("error", (err: unknown) => this.noteError(err));

    try {
      await client.login(this.token);
    } catch (err) {
      this.cancelReadyWait?.();
      this.noteError(err);
      this.client = undefined;
      this.handler = undefined;
      try {
        await client.destroy();
      } catch {
        // ignore teardown errors
      }
      throw err;
    }
    if (!this.client) {
      this.cancelReadyWait?.();
      return;
    }
    if (client.isReady?.()) {
      this.cancelReadyWait?.();
      this.setConnected(true);
    } else {
      await ready;
    }
  }

  async stop(): Promise<void> {
    this.cancelReadyWait?.();
    const client = this.client;
    this.client = undefined;
    this.handler = undefined;
    this.recentMessages.clear();
    this.setConnected(false);
    if (client) {
      try {
        await client.destroy();
      } catch (err) {
        this.noteError(err);
      }
    }
  }

  // ---------------------------------------------------------------- outbound

  async sendMessage(msg: OutboundMessage): Promise<{ messageId?: string } | void> {
    const channel = await this.fetchChannel(msg.chatId);
    const chunks = chunkText(msg.text ?? "", DISCORD_MAX_TEXT);

    const files = (msg.attachments ?? [])
      .map((att) => {
        const attachment = att.buffer ?? att.path ?? att.url;
        if (!attachment) {
          return undefined;
        }
        const name =
          att.name ??
          (att.path ? path.basename(att.path) : att.url ? path.basename(att.url.split("?")[0] ?? "") : undefined);
        return name ? { attachment, name } : { attachment };
      })
      .filter((f): f is NonNullable<typeof f> => f !== undefined);

    const fileGroups: Array<typeof files> = [];
    for (let i = 0; i < files.length; i += DISCORD_MAX_FILES_PER_MESSAGE) {
      fileGroups.push(files.slice(i, i + DISCORD_MAX_FILES_PER_MESSAGE));
    }

    const payloads: Array<Record<string, unknown>> = chunks.map((content) => ({ content }));
    if (fileGroups.length > 0) {
      if (payloads.length > 0) {
        // Attach the first batch of files to the final text chunk.
        payloads[payloads.length - 1]!.files = fileGroups.shift();
      }
      for (const group of fileGroups) {
        payloads.push({ files: group });
      }
    }
    if (payloads.length === 0) {
      return;
    }

    if (msg.replyToMessageId) {
      payloads[0]!.reply = {
        messageReference: msg.replyToMessageId,
        failIfNotExists: false,
      };
      payloads[0]!.allowedMentions = { repliedUser: false };
    }

    let lastId: string | undefined;
    for (const payload of payloads) {
      const sent = await channel.send(payload);
      lastId = sent.id;
    }
    this.noteOutbound();
    return lastId ? { messageId: lastId } : undefined;
  }

  async sendTyping(chatId: string, active: boolean): Promise<void> {
    if (!active) {
      return;
    }
    try {
      const channel = await this.fetchChannel(chatId);
      await channel.sendTyping?.();
    } catch (err) {
      this.noteError(err);
    }
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    try {
      const cached = this.recentMessages.get(messageId);
      const message = cached?.message ?? (await this.fetchMessage(chatId, messageId));
      const previous = cached?.lastReaction;
      if (previous === emoji) {
        return;
      }
      if (previous) {
        await this.removeBotReaction(message, previous).catch(() => undefined);
      }
      await message.react?.(emoji);
      this.cacheRecentMessage(message, emoji);
    } catch (err) {
      this.noteError(err);
    }
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    const message = await this.fetchMessage(chatId, messageId);
    if (typeof message.edit !== "function") {
      throw new Error("Discord message is not editable");
    }
    await message.edit(text.slice(0, DISCORD_EDIT_MAX_TEXT) || "…");
  }

  // ----------------------------------------------------------------- inbound

  private async handleMessage(message: DiscordMessageLike): Promise<void> {
    const client = this.client;
    if (!client) {
      return;
    }
    if (message.author.bot || message.author.id === client.user?.id) {
      return;
    }
    if (this.dedupe.seen(message.id)) {
      return;
    }

    const isGroup = Boolean(message.guild);
    const botUser = client.user;
    let text = message.content ?? "";
    let mentionsBot = true;

    if (isGroup) {
      const direct = botUser ? message.mentions.has(botUser) : false;
      mentionsBot = direct || isMentioned(text, this.groupMentionPatterns);
    }
    if (botUser) {
      const mentionRe = new RegExp(`<@!?${escapeRegExp(botUser.id)}>\\s*`, "g");
      text = text.replace(mentionRe, " ");
    }
    text = text.trim();

    const attachments = await this.collectAttachments(message);
    if (!text && attachments.length === 0) {
      return;
    }

    const replyToMessageId = message.reference?.messageId ?? undefined;
    const referenced = replyToMessageId
      ? this.resolveReferencedMessage(message, replyToMessageId)
      : undefined;

    const inbound: InboundMessage = {
      id: message.id,
      channel: this.name,
      chatId: message.channelId,
      senderId: message.author.id,
      isGroup,
      text,
      attachments,
      replyToMessageId,
      replyToText: referenced?.content?.trim() || undefined,
      replyToIsOwnMessage: referenced ? Boolean(referenced.author?.bot) : undefined,
      timestamp: message.createdTimestamp ?? Date.now(),
      mentionsBot,
      raw: message,
    };
    this.cacheRecentMessage(message);
    await this.emit(inbound);
  }

  private async collectAttachments(message: DiscordMessageLike): Promise<InboundAttachment[]> {
    const out: InboundAttachment[] = [];
    for (const att of iterateAttachments(message.attachments)) {
      if (this.useInboundMediaBridge && isInboundImage(att)) {
        try {
          if ((att.size ?? 0) > MAX_INBOUND_MEDIA_BYTES) {
            throw new Error(`Discord attachment exceeds ${MAX_INBOUND_MEDIA_BYTES} bytes`);
          }
          const media = await downloadInboundMedia({
            url: att.url,
            mediaDir: this.mediaDir,
            filenameHint: att.name ?? undefined,
            mimeTypeHint: att.contentType ?? undefined,
            fetchImpl: this.fetchImpl,
          });
          out.push({
            type: "image",
            kind: "image",
            mimeType: media.mimeType,
            name: media.name,
            sizeBytes: media.sizeBytes,
            localPath: media.localPath,
            url: att.url,
          } as InboundAttachment);
        } catch (err) {
          this.noteError(err);
        }
        continue;
      }

      try {
        if ((att.size ?? 0) > MAX_INLINE_MEDIA_BYTES) {
          throw new Error(`Discord attachment exceeds ${MAX_INLINE_MEDIA_BYTES} bytes`);
        }
        const data = await this.download(att.url);
        const name = att.name ?? undefined;
        const localPath = await saveInboundMedia(
          this.mediaDir,
          this.name,
          `${message.id}-${att.id ?? out.length}`,
          name,
          data,
        );
        out.push({
          type: kindFromMime(att.contentType),
          mimeType: att.contentType ?? undefined,
          name,
          sizeBytes: data.byteLength,
          data,
          localPath,
          url: att.url,
        });
      } catch (err) {
        this.noteError(err);
      }
    }
    return out;
  }

  // ----------------------------------------------------------------- helpers

  private async fetchChannel(chatId: string): Promise<DiscordSendableChannel> {
    const client = this.client;
    if (!client) {
      throw new Error("Discord adapter is not started");
    }
    const channel = (await client.channels.fetch(chatId)) as DiscordSendableChannel | null;
    if (!channel || typeof channel.send !== "function") {
      throw new Error(`Discord channel ${chatId} is not available for sending`);
    }
    return channel;
  }

  private async fetchMessage(chatId: string, messageId: string): Promise<DiscordMessageLike> {
    const channel = await this.fetchChannel(chatId);
    if (!channel.messages) {
      throw new Error(`Discord channel ${chatId} does not support message lookup`);
    }
    return channel.messages.fetch(messageId);
  }

  /** Resolve a replied-to message from the inbound cache or the channel's message cache. */
  private resolveReferencedMessage(
    message: DiscordMessageLike,
    messageId: string,
  ): DiscordMessageLike | undefined {
    const cached = this.recentMessages.get(messageId)?.message;
    if (cached) {
      return cached;
    }
    return message.channel?.messages?.cache?.get?.(messageId);
  }

  private cacheRecentMessage(message: DiscordMessageLike, lastReaction?: string): void {
    const previous = this.recentMessages.get(message.id);
    this.recentMessages.delete(message.id);
    this.recentMessages.set(message.id, {
      message,
      lastReaction: lastReaction ?? previous?.lastReaction,
    });
    while (this.recentMessages.size > MAX_CACHED_MESSAGES) {
      const oldest = this.recentMessages.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.recentMessages.delete(oldest);
    }
  }

  private async removeBotReaction(
    message: DiscordMessageLike,
    emoji: string,
  ): Promise<void> {
    const cache = message.reactions?.cache;
    if (!cache) {
      return;
    }
    const reaction =
      cache instanceof Map ? cache.get(emoji) : cache.get?.(emoji);
    const botId = this.client?.user?.id;
    const users = reaction?.users;
    if (reaction && botId && users && typeof users.remove === "function") {
      await users.remove(botId);
    }
  }
}

export function createAdapter(config: GatewayConfig): ChannelAdapter {
  return new DiscordChannelAdapter(config);
}
