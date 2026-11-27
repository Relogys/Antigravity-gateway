import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type Content,
  type ContentInput,
  type Message,
  type Space,
  Spectrum,
  attachment,
  markdown,
  richlink,
  text,
  voice,
} from "spectrum-ts";
import {
  type IMessageMessageEffect,
  effect,
  imessage,
} from "spectrum-ts/providers/imessage";
import { normalizeSenderId, type GatewayConfig, type PhotonConfig } from "../config.js";
import type {
  AttachmentKind,
  ChannelAdapter,
  InboundAttachment,
  InboundMessage,
  OutboundAttachment,
  OutboundMessage,
} from "../types.js";
import {
  chooseSendFormat,
  chunkMessage,
  normalizeSpaceId,
  sanitizeForIMessage,
} from "./format.js";
import { StreamStalenessWatchdog } from "./staleness.js";

const DEDUPE_TTL_MS = 48 * 60 * 60 * 1000;
const DEDUPE_MAX_ENTRIES = 4000;
const MAX_CACHED_MESSAGES = 1000;
const MAX_CHAT_CACHE = 2000;
const MAX_ACTIVE_REACTIONS = 500;
const MAX_INLINE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const RICH_LINK_SUPPRESS_WINDOW_MS = 30 * 1000;
const TYPING_COOLDOWN_MS = 5 * 1000;
const RECONNECT_INITIAL_MS = 500;
const RECONNECT_MAX_MS = 30 * 1000;
const STARTUP_READY_TIMEOUT_MS = 15 * 1000;
const CONNECT_TIMEOUT_MS = 45 * 1000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 180 * 1000;

const URL_RE = /https?:\/\/\S+/i;

/** Unicode Object Replacement Character iMessage inserts for unsupported bubbles. */
const OBJECT_REPLACEMENT_RE = /\uFFFC/g;

function stripPlaceholders(value: string): string {
  return value.replace(OBJECT_REPLACEMENT_RE, "");
}

function parsePositiveIntEnv(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const value = Number(raw.trim());
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

const IGNORED_CONTENT_TYPES = new Set<string>([
  "read",
  "reaction",
  "typing",
  "poll",
  "poll_option",
  "addMember",
  "removeMember",
  "rename",
  "avatar",
  "leaveSpace",
  "effect",
  "custom",
]);

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function classifyAttachmentKind(mimeType?: string, isVoice = false): AttachmentKind {
  if (isVoice) {
    return "audio";
  }
  const lower = (mimeType ?? "").toLowerCase();
  if (lower.startsWith("image/")) {
    return "image";
  }
  if (lower.startsWith("audio/")) {
    return "audio";
  }
  if (lower.startsWith("video/")) {
    return "video";
  }
  if (lower.length > 0) {
    return "file";
  }
  return "other";
}

function sanitizeFilename(name: string | undefined, fallbackExt = ".bin"): string {
  const base = path.basename((name ?? "attachment").trim() || "attachment");
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!cleaned || cleaned === "." || cleaned === "..") {
    return `attachment${fallbackExt}`;
  }
  return cleaned;
}

function isAudioVoiceAttachment(att: OutboundAttachment): boolean {
  const mime = (att.mimeType ?? "").toLowerCase();
  const ext = path.extname(att.name ?? att.path ?? "").toLowerCase();
  return mime === "audio/mp4" || mime === "audio/x-caf" || ext === ".m4a" || ext === ".caf";
}

function resolveEffectId(name: string | undefined): IMessageMessageEffect | undefined {
  if (!name) {
    return undefined;
  }
  const map = imessage.effect.message as Record<string, IMessageMessageEffect>;
  if (name in map) {
    return map[name];
  }
  const values = Object.values(map);
  if (values.includes(name as IMessageMessageEffect)) {
    return name as IMessageMessageEffect;
  }
  return undefined;
}

interface ReactionHandle {
  unsend?: () => Promise<unknown>;
}

interface ActiveReaction {
  emoji: string;
  handle?: ReactionHandle;
}

export class PhotonChannelAdapter implements ChannelAdapter {
  readonly name = "photon";

  private readonly config: GatewayConfig;
  private readonly photon: PhotonConfig;
  private readonly startupTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly heartbeatTimeoutMs: number;
  private initialProbeSpaceId?: string;
  private resolveReady?: () => void;
  private readonly mediaDir: string;

  private app?: Awaited<ReturnType<typeof Spectrum>>;
  private onMessageHandler?: (msg: InboundMessage) => Promise<void> | void;
  private loopAbort?: AbortController;
  private loopPromise?: Promise<void>;
  private watchdog?: StreamStalenessWatchdog;

  private connected = false;
  private stopping = false;
  private lastInboundAt?: number;
  private lastOutboundAt?: number;
  private lastHeartbeatAt?: number;
  private lastError?: string;

  private readonly seenIds = new Map<string, number>();
  private readonly spacesByChatId = new Map<string, Space>();
  private readonly messagesById = new Map<string, Message>();
  private readonly lastServiceByChatId = new Map<string, "iMessage" | "SMS" | "RCS" | "unknown">();
  private readonly lastUrlAtByChatId = new Map<string, number>();
  private readonly lastTypingAtByChatId = new Map<string, number>();
  private readonly activeReactionsByMessageId = new Map<string, ActiveReaction>();

  constructor(
    config: GatewayConfig,
    options: {
      startupTimeoutMs?: number;
      connectTimeoutMs?: number;
      heartbeatTimeoutMs?: number;
      initialProbeSpaceId?: string;
    } = {},
  ) {
    if (!config.photon) {
      throw new Error(
        "Photon channel requires SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET",
      );
    }
    this.config = config;
    this.photon = config.photon;
    this.startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_READY_TIMEOUT_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.heartbeatTimeoutMs =
      options.heartbeatTimeoutMs ??
      parsePositiveIntEnv(process.env.PHOTON_HEARTBEAT_TIMEOUT_MS) ??
      DEFAULT_HEARTBEAT_TIMEOUT_MS;
    const seededSpace =
      options.initialProbeSpaceId ?? process.env.PHOTON_PROBE_SPACE_ID;
    this.initialProbeSpaceId = seededSpace?.trim() || undefined;
    this.lastHeartbeatAt = Date.now();
    this.mediaDir = path.join(config.dataDir, "media");
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Seeds the inbound-probe space from a persisted home chat so staleness detection arms on startup. */
  seedProbeSpaceId(spaceId: string): void {
    const trimmed = spaceId.trim();
    if (!trimmed) {
      return;
    }
    this.initialProbeSpaceId = trimmed;
    this.watchdog?.setProbeSpaceId(trimmed);
  }

  getStats(): {
    lastInboundAt?: number;
    lastOutboundAt?: number;
    lastHeartbeatAt?: number;
    lastError?: string;
  } {
    return {
      lastInboundAt: this.lastInboundAt,
      lastOutboundAt: this.lastOutboundAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastError: this.lastError,
    };
  }

  async start(onMessage: (msg: InboundMessage) => Promise<void> | void): Promise<void> {
    if (this.loopPromise) {
      return;
    }

    this.stopping = false;
    this.onMessageHandler = onMessage;
    this.loopAbort = new AbortController();

    await mkdir(this.mediaDir, { recursive: true });

    this.watchdog = new StreamStalenessWatchdog({
      probeSpaceId: this.initialProbeSpaceId,
      heartbeatTimeoutMs: this.heartbeatTimeoutMs,
      probeFn: async (spaceId, probeMessageId) => {
        if (!this.app) {
          throw new Error("Spectrum app is not initialized");
        }
        const im = imessage(this.app);
        const space = await im.space.get(spaceId);
        return await space.getMessage(probeMessageId);
      },
      onZombieDetected: async ({ silentMs }) => {
        await this.resetConnection(
          `Zombie gRPC stream suspected after ${Math.round(silentMs / 1000)}s silence; reconnecting`,
        );
      },
      onHeartbeatTimeout: async ({ silentHeartbeatMs }) => {
        await this.resetConnection(
          `Transport heartbeat missing for ${Math.round(silentHeartbeatMs / 1000)}s; reconnecting`,
        );
      },
    });
    this.watchdog.start();

    const ready = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });
    this.loopPromise = this.runStreamLoop(this.loopAbort.signal);

    // Wait for the first successful Spectrum connection so callers can sendMessage()
    // right after `await start()`. On timeout we keep the background reconnect loop
    // running and surface the condition via getStats().lastError (never throws).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      ready.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), this.startupTimeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer) {
      clearTimeout(timer);
    }
    if (timedOut && !this.connected) {
      this.lastError = `${this.lastError ? `${this.lastError}; ` : ""}Photon not connected after ${Math.round(this.startupTimeoutMs / 1000)}s; retrying in background`;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.connected = false;
    this.resolveReady?.();
    this.resolveReady = undefined;

    this.watchdog?.stop();
    this.watchdog = undefined;

    this.loopAbort?.abort();

    const currentApp = this.app;
    this.app = undefined;
    if (currentApp) {
      await currentApp.stop().catch(() => undefined);
    }

    if (this.loopPromise) {
      // Bound shutdown: a hung initial Spectrum() handshake must not block stop().
      await Promise.race([
        this.loopPromise.catch(() => undefined),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2000);
          timer.unref?.();
        }),
      ]);
      this.loopPromise = undefined;
    }

    this.spacesByChatId.clear();
    this.messagesById.clear();
    this.lastServiceByChatId.clear();
    this.lastUrlAtByChatId.clear();
    this.lastTypingAtByChatId.clear();
    this.activeReactionsByMessageId.clear();
  }

  /**
   * Tears down the current Spectrum app so the background loop reconnects.
   * Used by both zombie-inbound and heartbeat-timeout detection.
   */
  private async resetConnection(reason: string): Promise<void> {
    this.lastError = reason;
    this.connected = false;
    const currentApp = this.app;
    this.app = undefined;
    if (currentApp) {
      await currentApp.stop().catch(() => undefined);
    }
  }

  private async createSpectrumApp(): Promise<Awaited<ReturnType<typeof Spectrum>>> {
    const pending = Spectrum({
      projectId: this.photon.projectId,
      projectSecret: this.photon.projectSecret,
      providers: [
        imessage.config({
          onHeartbeat: () => {
            const heartbeatAt = Date.now();
            this.lastHeartbeatAt = heartbeatAt;
            this.watchdog?.recordHeartbeat(heartbeatAt);
          },
        }),
      ],
      options: {
        logLevel: this.config.logLevel,
      },
    });

    // A hung handshake must not wedge the reconnect loop: time out, retry, and make sure
    // a late-arriving app is closed instead of leaking.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Spectrum connection attempt timed out")),
        this.connectTimeoutMs,
      );
      timer.unref?.();
    });
    try {
      const created = await Promise.race([pending, timeout]);
      return created as unknown as Awaited<ReturnType<typeof Spectrum>>;
    } catch (error) {
      void pending.then(
        (late) => (late as { stop?: () => Promise<void> }).stop?.().catch(() => undefined),
        () => undefined,
      );
      throw error;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async runStreamLoop(signal: AbortSignal): Promise<void> {
    let attempt = 0;

    while (!this.stopping && !signal.aborted) {
      try {
        const currentApp = await this.createSpectrumApp();
        if (this.stopping || signal.aborted) {
          await currentApp.stop().catch(() => undefined);
          break;
        }
        this.app = currentApp;
        this.connected = true;
        this.lastError = undefined;
        this.lastHeartbeatAt = Date.now();
        this.watchdog?.recordHeartbeat(this.lastHeartbeatAt);
        attempt = 0;
        this.resolveReady?.();
        this.resolveReady = undefined;

        for await (const [space, message] of currentApp.messages) {
          if (this.stopping || signal.aborted) {
            break;
          }
          await this.handleRawMessage(space, message);
        }
      } catch (error) {
        if (this.stopping || signal.aborted) {
          break;
        }
        const rawMessage = error instanceof Error ? error.message : String(error);
        this.lastError = /CatchUpEvents/i.test(rawMessage)
          ? `Spectrum upstream CatchUpEvents error (retrying): ${rawMessage}`
          : rawMessage;
      } finally {
        this.connected = false;
        const currentApp = this.app;
        this.app = undefined;
        if (currentApp) {
          await currentApp.stop().catch(() => undefined);
        }
      }

      if (this.stopping || signal.aborted) {
        break;
      }

      const nominal = Math.min(RECONNECT_MAX_MS, RECONNECT_INITIAL_MS * 2 ** attempt);
      const jittered = Math.round(nominal * (0.5 + Math.random() * 0.5));
      attempt += 1;
      await sleepWithAbort(jittered, signal);
    }
  }

  private rememberChatEntry<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > MAX_CHAT_CACHE) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      map.delete(oldest);
    }
  }

  private isDuplicate(id: string, now: number): boolean {
    const existing = this.seenIds.get(id);
    if (existing !== undefined && now - existing < DEDUPE_TTL_MS) {
      return true;
    }
    this.seenIds.delete(id);
    this.seenIds.set(id, now);

    if (this.seenIds.size > DEDUPE_MAX_ENTRIES) {
      for (const [key, ts] of this.seenIds) {
        if (now - ts >= DEDUPE_TTL_MS || this.seenIds.size > DEDUPE_MAX_ENTRIES) {
          this.seenIds.delete(key);
        } else {
          break;
        }
      }
    }
    return false;
  }

  private cacheMessage(message: Message): void {
    this.messagesById.set(message.id, message);
    if (this.messagesById.size > MAX_CACHED_MESSAGES) {
      const oldestKey = this.messagesById.keys().next().value;
      if (oldestKey !== undefined) {
        this.messagesById.delete(oldestKey);
      }
    }
  }

  private rememberActiveReaction(messageId: string, entry: ActiveReaction): void {
    this.activeReactionsByMessageId.delete(messageId);
    this.activeReactionsByMessageId.set(messageId, entry);
    while (this.activeReactionsByMessageId.size > MAX_ACTIVE_REACTIONS) {
      const oldest = this.activeReactionsByMessageId.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.activeReactionsByMessageId.delete(oldest);
    }
  }

  private async extractInboundContent(
    chatId: string,
    rawContent: Content,
    now: number,
  ): Promise<{
    textParts: string[];
    attachments: InboundAttachment[];
    replyToMessageId?: string;
    replyToText?: string;
    replyToIsOwnMessage?: boolean;
    ignored: boolean;
  }> {
    if (rawContent.type === "reply") {
      const nested = await this.extractInboundContent(
        chatId,
        rawContent.content as Content,
        now,
      );
      const target = rawContent.target;
      const targetText = target ? this.extractPlainText(target.content) : "";
      return {
        ...nested,
        replyToMessageId: target?.id ?? nested.replyToMessageId,
        replyToText: nested.replyToText ?? (targetText || undefined),
        replyToIsOwnMessage:
          nested.replyToIsOwnMessage ??
          (target?.direction === "outbound" ? true : undefined),
      };
    }

    if (rawContent.type === "group") {
      const textParts: string[] = [];
      const attachments: InboundAttachment[] = [];
      for (const item of rawContent.items) {
        const sub = await this.extractInboundContent(
          chatId,
          item.content as Content,
          now,
        );
        if (!sub.ignored) {
          textParts.push(...sub.textParts);
          attachments.push(...sub.attachments);
        }
      }
      return {
        textParts,
        attachments,
        ignored: textParts.length === 0 && attachments.length === 0,
      };
    }

    if (IGNORED_CONTENT_TYPES.has(rawContent.type)) {
      return { textParts: [], attachments: [], ignored: true };
    }

    switch (rawContent.type) {
      case "text": {
        const text = stripPlaceholders(rawContent.text);
        if (!text.trim()) {
          // Lone \ufffc placeholder bubbles carry no user content.
          return { textParts: [], attachments: [], ignored: true };
        }
        if (URL_RE.test(text)) {
          this.rememberChatEntry(this.lastUrlAtByChatId, chatId, now);
        }
        return {
          textParts: [text],
          attachments: [],
          ignored: false,
        };
      }
      case "richlink": {
        this.rememberChatEntry(this.lastUrlAtByChatId, chatId, now);
        return {
          textParts: [rawContent.url],
          attachments: [],
          ignored: false,
        };
      }
      case "contact": {
        const label =
          rawContent.name?.formatted ||
          rawContent.phones?.[0]?.value ||
          rawContent.emails?.[0]?.value ||
          "Contact card";
        return {
          textParts: [`[Shared contact: ${label}]`],
          attachments: [],
          ignored: false,
        };
      }
      case "attachment":
      case "voice": {
        const isVoice = rawContent.type === "voice";
        const fileName = rawContent.name ?? (isVoice ? "voice.m4a" : "attachment");
        const lowerName = fileName.toLowerCase();

        // Filter Apple rich-link preview attachments arriving right after a URL
        if (lowerName.endsWith(".pluginpayloadattachment")) {
          const lastUrlAt = this.lastUrlAtByChatId.get(chatId);
          if (lastUrlAt !== undefined && now - lastUrlAt <= RICH_LINK_SUPPRESS_WINDOW_MS) {
            return { textParts: [], attachments: [], ignored: true };
          }
        }

        const inboundAtt: InboundAttachment = {
          type: classifyAttachmentKind(rawContent.mimeType, isVoice),
          mimeType: rawContent.mimeType,
          name: fileName,
          sizeBytes: rawContent.size,
          guid: rawContent.id,
          read: rawContent.read,
        };

        const knownSize = rawContent.size ?? 0;
        if (knownSize <= MAX_INLINE_ATTACHMENT_BYTES) {
          try {
            const data = await rawContent.read();
            if (data.byteLength <= MAX_INLINE_ATTACHMENT_BYTES) {
              inboundAtt.data = data;
              const safeName = `${now}-${sanitizeFilename(fileName)}`;
              const targetPath = path.join(this.mediaDir, safeName);
              await writeFile(targetPath, data);
              inboundAtt.localPath = targetPath;
            }
          } catch {
            // Keep metadata-only attachment if download fails or exceeds cap
          }
        }

        return {
          textParts: [],
          attachments: [inboundAtt],
          ignored: false,
        };
      }
      default:
        return { textParts: [], attachments: [], ignored: true };
    }
  }

  /** Best-effort plain text of a content tree, used to quote a replied-to message. */
  private extractPlainText(content: Content | undefined): string {
    if (!content) {
      return "";
    }
    switch (content.type) {
      case "text":
        return stripPlaceholders(content.text).trim();
      case "richlink":
        return content.url?.trim() ?? "";
      case "contact": {
        const label =
          content.name?.formatted ||
          content.phones?.[0]?.value ||
          content.emails?.[0]?.value ||
          "";
        return label.trim();
      }
      case "group": {
        const parts: string[] = [];
        for (const item of content.items) {
          const text = this.extractPlainText(item.content as Content);
          if (text) {
            parts.push(text);
          }
        }
        return parts.join("\n").trim();
      }
      case "reply":
        return this.extractPlainText(content.content as Content);
      default:
        return "";
    }
  }

  private matchesGroupMention(textBody: string): boolean {
    if (!textBody) {
      return false;
    }
    const lower = textBody.toLowerCase();
    return this.config.groupMentionPatterns.some((pattern) =>
      lower.includes(pattern.toLowerCase()),
    );
  }

  private async handleRawMessage(space: Space, message: Message): Promise<void> {
    if (message.direction !== "inbound") {
      return;
    }

    const now = Date.now();
    this.lastInboundAt = now;
    this.watchdog?.recordInbound(now);
    this.watchdog?.setProbeSpaceId(space.id);

    if (this.isDuplicate(message.id, now)) {
      return;
    }

    const chatId = normalizeSpaceId(space.id);
    if (!chatId) {
      return;
    }

    this.rememberChatEntry(this.spacesByChatId, chatId, space);
    this.cacheMessage(message);

    let isGroup = space.id.includes(";+;");
    let service: "iMessage" | "SMS" | "RCS" | "unknown" | undefined;

    if (message.platform === "imessage") {
      const imSpace = imessage(space) as {
        type?: "dm" | "group";
      };
      if (imSpace.type === "group") {
        isGroup = true;
      }

      const imMsg = imessage(message) as {
        sender?: { service?: "iMessage" | "SMS" | "RCS" | "unknown" };
      };
      service = imMsg.sender?.service;
      if (service) {
        this.rememberChatEntry(this.lastServiceByChatId, chatId, service);
      }
    }

    const extracted = await this.extractInboundContent(
      chatId,
      message.content,
      now,
    );
    if (extracted.ignored) {
      return;
    }

    const rawSenderId = message.sender?.id ?? "";
    const senderId = normalizeSenderId(rawSenderId);
    const bodyText = extracted.textParts.join("\n").trim();

    if (!bodyText && extracted.attachments.length === 0) {
      return;
    }

    const inboundMsg: InboundMessage = {
      id: message.id,
      channel: this.name,
      chatId,
      senderId,
      rawSenderId: rawSenderId || undefined,
      isGroup,
      text: bodyText,
      attachments: extracted.attachments,
      replyToMessageId: extracted.replyToMessageId,
      replyToText: extracted.replyToText,
      replyToIsOwnMessage: extracted.replyToIsOwnMessage,
      timestamp: message.timestamp.getTime(),
      service,
      mentionsBot: isGroup ? this.matchesGroupMention(bodyText) : true,
      raw: message,
    };

    if (this.onMessageHandler) {
      await this.onMessageHandler(inboundMsg);
    }
  }

  private async resolveSpace(chatId: string): Promise<Space> {
    const normalized = normalizeSpaceId(chatId);
    const cached = this.spacesByChatId.get(normalized) ?? this.spacesByChatId.get(chatId);
    if (cached) {
      return cached;
    }

    if (!this.app) {
      throw new Error("Photon Spectrum app is not connected");
    }

    const im = imessage(this.app);
    if (chatId.includes(";-;") || chatId.includes(";+;")) {
      const space = await im.space.get(chatId);
      this.rememberChatEntry(this.spacesByChatId, normalized, space);
      return space;
    }

    const user = await im.user(normalized);
    const space = await im.space.create(user);
    this.rememberChatEntry(this.spacesByChatId, normalized, space);
    return space;
  }

  private async resolveTargetMessage(
    space: Space,
    messageId: string,
  ): Promise<Message | undefined> {
    const cached = this.messagesById.get(messageId);
    if (cached) {
      return cached;
    }
    try {
      const fetched = await space.getMessage(messageId);
      if (fetched) {
        this.cacheMessage(fetched);
      }
      return fetched;
    } catch {
      return undefined;
    }
  }

  async sendMessage(msg: OutboundMessage): Promise<{ messageId?: string } | void> {
    try {
      return await this.deliverMessage(msg);
    } catch (error) {
      if (error instanceof Error && /target not allowed/i.test(error.message)) {
        throw new Error(
          "Photon plan restriction (Target not allowed): register this recipient in Photon Dashboard or have them message the bot first.",
        );
      }
      throw error;
    }
  }

  private async deliverMessage(msg: OutboundMessage): Promise<{ messageId?: string } | void> {
    const space = await this.resolveSpace(msg.chatId);
    const normalized = normalizeSpaceId(msg.chatId);
    const service = this.lastServiceByChatId.get(normalized);
    const effectId = resolveEffectId(msg.effect);

    let lastSentId: string | undefined;

    if (msg.text && msg.text.trim().length > 0) {
      const prepared =
        msg.markdown !== false ? sanitizeForIMessage(msg.text) : msg.text.trim();
      const chunks = chunkMessage(prepared);

      let replyTarget: Message | undefined;
      if (msg.replyToMessageId && service !== "SMS") {
        replyTarget = await this.resolveTargetMessage(space, msg.replyToMessageId);
      }

      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i] ?? "";
        const formatted = chooseSendFormat(chunk, msg.markdown !== false);

        let contentBuilder: ContentInput;
        if (formatted.mode === "richlink") {
          contentBuilder = richlink(formatted.content);
        } else if (formatted.mode === "markdown") {
          contentBuilder = markdown(formatted.content);
        } else {
          contentBuilder = text(formatted.content);
        }

        if (i === 0 && effectId) {
          contentBuilder = effect(contentBuilder, effectId);
        }

        let sent: Message | undefined;
        if (i === 0 && replyTarget) {
          try {
            sent = await replyTarget.reply(contentBuilder);
          } catch {
            sent = await space.send(contentBuilder);
          }
        } else {
          sent = await space.send(contentBuilder);
        }

        if (sent) {
          this.cacheMessage(sent);
          lastSentId = sent.id;
        }
        this.lastOutboundAt = Date.now();
      }
    }

    if (msg.attachments && msg.attachments.length > 0) {
      for (const att of msg.attachments) {
        const input = att.buffer ?? (att.path ? att.path : att.url ? new URL(att.url) : undefined);
        if (!input) {
          continue;
        }

        let builder: ContentInput;
        if (isAudioVoiceAttachment(att)) {
          builder = voice(input, {
            name: att.name,
            mimeType: att.mimeType,
          });
        } else if (Buffer.isBuffer(input)) {
          builder = attachment(input, {
            name: att.name ?? "attachment.bin",
            mimeType: att.mimeType ?? "application/octet-stream",
          });
        } else {
          builder = attachment(input, {
            name: att.name,
            mimeType: att.mimeType,
          });
        }

        const sent = await space.send(builder);
        if (sent) {
          this.cacheMessage(sent);
          lastSentId = sent.id;
        }
        this.lastOutboundAt = Date.now();
      }
    }

    return lastSentId ? { messageId: lastSentId } : undefined;
  }

  async sendTyping(chatId: string, active: boolean): Promise<void> {
    const normalized = normalizeSpaceId(chatId);
    const now = Date.now();

    if (active) {
      const last = this.lastTypingAtByChatId.get(normalized);
      if (last !== undefined && now - last < TYPING_COOLDOWN_MS) {
        return;
      }
      this.rememberChatEntry(this.lastTypingAtByChatId, normalized, now);
    } else {
      this.lastTypingAtByChatId.delete(normalized);
    }

    try {
      const space = await this.resolveSpace(chatId);
      if (active) {
        await space.startTyping();
      } else {
        await space.stopTyping();
      }
    } catch {
      // Typing indicators are best-effort
    }
  }

  async markRead(chatId: string, messageId?: string): Promise<void> {
    if (!this.photon.readReceipts || !messageId) {
      return;
    }
    try {
      // Prefer the cached inbound Message so receipts still work when the transport
      // cannot re-resolve the space (e.g. briefly disconnected).
      const cached = this.messagesById.get(messageId);
      const target =
        cached ??
        (await this.resolveSpace(chatId)
          .then((space) => this.resolveTargetMessage(space, messageId))
          .catch(() => undefined));
      if (target && target.direction === "inbound") {
        await target.read();
      }
    } catch {
      // Read receipts are best-effort
    }
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.photon.reactions) {
      return;
    }
    const previous = this.activeReactionsByMessageId.get(messageId);
    if (previous?.emoji === emoji) {
      // Avoid stacking duplicate tapbacks for the same message.
      return;
    }
    try {
      const space = await this.resolveSpace(chatId);
      const target = await this.resolveTargetMessage(space, messageId);
      if (!target) {
        return;
      }
      if (previous?.handle?.unsend) {
        // Retract the old reaction first so 👀 -> 👍/👎/🛑 is a clean transition.
        await previous.handle.unsend().catch(() => undefined);
      }
      const handle = await target.react(emoji);
      this.rememberActiveReaction(messageId, {
        emoji,
        handle: handle ?? undefined,
      });
    } catch {
      // Reactions are best-effort
    }
  }

  async editMessage(chatId: string, messageId: string, newText: string): Promise<void> {
    try {
      const space = await this.resolveSpace(chatId);
      const target = await this.resolveTargetMessage(space, messageId);
      if (target && target.direction === "outbound") {
        await target.edit(newText);
      }
    } catch {
      // Edits are best-effort
    }
  }
}
