import type {
  ChannelAdapter,
  ChannelHealthStatus,
  InboundMessage,
  OutboundMessage,
} from "../types.js";
import { errorMessage } from "./utils.js";

/** Separator between channel name and raw chat id in hub-qualified chat ids. */
export const CHAT_ID_SEPARATOR = "::";

const CHANNEL_PREFIX_RE = /^[a-z][a-z0-9_-]*$/;

/** Build `<channel>::<rawChatId>`. */
export function qualifyChatId(channel: string, rawChatId: string): string {
  return `${channel}${CHAT_ID_SEPARATOR}${rawChatId}`;
}

/**
 * Split `<channel>::<rawChatId>` at the FIRST separator. Returns `{ chatId: input }`
 * (no channel) when the prefix is missing or is not a valid channel-name token.
 */
export function splitQualifiedChatId(qualified: string): {
  channel?: string;
  chatId: string;
} {
  const idx = qualified.indexOf(CHAT_ID_SEPARATOR);
  if (idx <= 0) {
    return { chatId: qualified };
  }
  const prefix = qualified.slice(0, idx);
  if (!CHANNEL_PREFIX_RE.test(prefix)) {
    return { chatId: qualified };
  }
  return { channel: prefix, chatId: qualified.slice(idx + CHAT_ID_SEPARATOR.length) };
}

export interface MultiChannelHubOptions {
  /** Used to route unqualified chat ids when more than one adapter is registered. */
  defaultChannel?: string;
  log?: (message: string) => void;
}

interface ChannelEntry {
  adapter: ChannelAdapter;
  startError?: string;
  lastInboundAt?: number;
  lastOutboundAt?: number;
  lastError?: string;
}

type InboundHandler = (msg: InboundMessage) => Promise<void> | void;

/**
 * Runs up to N channel adapters concurrently behind a single `ChannelAdapter`.
 * Inbound messages get `chatId` rewritten to `<channel>::<rawChatId>` (and `channel`
 * set to the adapter name); outbound calls are routed to the owning adapter.
 * Inbound handlers are dispatched without blocking the adapter's receive loop, so
 * `/stop` and other commands can arrive while a long agent turn is running.
 */
export class MultiChannelHub implements ChannelAdapter {
  readonly name = "hub";

  private readonly entries = new Map<string, ChannelEntry>();
  private readonly defaultChannel?: string;
  private readonly log: (message: string) => void;
  private handler?: InboundHandler;
  private started = false;

  constructor(adapters: ChannelAdapter[] = [], options: MultiChannelHubOptions = {}) {
    this.defaultChannel = options.defaultChannel;
    this.log = options.log ?? ((m) => console.log(m));
    for (const adapter of adapters) {
      this.register(adapter);
    }
  }

  /** Register an adapter under `adapter.name` (must be unique; register before `start()`). */
  register(adapter: ChannelAdapter): void {
    if (this.entries.has(adapter.name)) {
      throw new Error(`Channel "${adapter.name}" is already registered`);
    }
    if (!CHANNEL_PREFIX_RE.test(adapter.name)) {
      throw new Error(`Invalid channel name "${adapter.name}"`);
    }
    this.entries.set(adapter.name, { adapter });
  }

  listChannelNames(): string[] {
    return [...this.entries.keys()];
  }

  getAdapter(name: string): ChannelAdapter | undefined {
    return this.entries.get(name)?.adapter;
  }

  isConnected(): boolean {
    return [...this.entries.values()].some((e) => e.adapter.isConnected());
  }

  getChannelSnapshots(): Record<string, ChannelHealthStatus> {
    const out: Record<string, ChannelHealthStatus> = {};
    for (const [name, entry] of this.entries) {
      const stats = entry.adapter.getStats?.() ?? {};
      out[name] = {
        name,
        connected: entry.adapter.isConnected(),
        lastInboundAt: maxDefined(stats.lastInboundAt, entry.lastInboundAt),
        lastOutboundAt: maxDefined(stats.lastOutboundAt, entry.lastOutboundAt),
        lastHeartbeatAt: stats.lastHeartbeatAt,
        lastError: stats.lastError ?? entry.lastError ?? entry.startError,
      };
    }
    return out;
  }

  getStats(): { lastInboundAt?: number; lastOutboundAt?: number; lastError?: string } {
    let lastInboundAt: number | undefined;
    let lastOutboundAt: number | undefined;
    let lastError: string | undefined;
    for (const snap of Object.values(this.getChannelSnapshots())) {
      lastInboundAt = maxDefined(lastInboundAt, snap.lastInboundAt);
      lastOutboundAt = maxDefined(lastOutboundAt, snap.lastOutboundAt);
      if (snap.lastError && !snap.connected) {
        lastError = `${snap.name}: ${snap.lastError}`;
      }
    }
    return { lastInboundAt, lastOutboundAt, lastError };
  }

  /**
   * Start every adapter concurrently. A failing channel is logged and recorded
   * (visible in `getChannelSnapshots()`), never thrown, so healthy channels keep running.
   */
  async start(onMessage: InboundHandler): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    this.handler = onMessage;

    await Promise.all(
      [...this.entries].map(async ([name, entry]) => {
        try {
          await entry.adapter.start((msg) => this.dispatchInbound(name, msg));
          entry.startError = undefined;
        } catch (err) {
          entry.startError = errorMessage(err);
          this.log(`[hub] Channel "${name}" failed to start: ${entry.startError}`);
        }
      }),
    );
  }

  async stop(): Promise<void> {
    this.started = false;
    await Promise.all(
      [...this.entries].map(async ([name, entry]) => {
        try {
          await entry.adapter.stop();
        } catch (err) {
          this.log(`[hub] Channel "${name}" failed to stop cleanly: ${errorMessage(err)}`);
        }
      }),
    );
  }

  private dispatchInbound(channel: string, msg: InboundMessage): void {
    const entry = this.entries.get(channel);
    if (entry) {
      entry.lastInboundAt = Date.now();
    }
    const handler = this.handler;
    if (!handler) {
      return;
    }
    const qualified: InboundMessage = {
      ...msg,
      channel,
      chatId: qualifyChatId(channel, msg.chatId),
    };
    Promise.resolve()
      .then(() => handler(qualified))
      .catch((err) => {
        if (entry) {
          entry.lastError = errorMessage(err);
        }
        this.log(`[hub] Inbound handler error on "${channel}": ${errorMessage(err)}`);
      });
  }

  /** Resolve the owning adapter + raw chat id for a (possibly unqualified) chat id. */
  resolveTarget(chatId: string): { channel: string; adapter: ChannelAdapter; rawChatId: string } {
    const split = splitQualifiedChatId(chatId);
    if (split.channel) {
      const entry = this.entries.get(split.channel);
      if (entry) {
        return { channel: split.channel, adapter: entry.adapter, rawChatId: split.chatId };
      }
    }

    if (this.entries.size === 1) {
      const [[channel, entry]] = [...this.entries];
      return { channel, adapter: entry.adapter, rawChatId: chatId };
    }

    if (!split.channel && this.defaultChannel) {
      const entry = this.entries.get(this.defaultChannel);
      if (entry) {
        return { channel: this.defaultChannel, adapter: entry.adapter, rawChatId: chatId };
      }
    }

    throw new Error(
      split.channel
        ? `Unknown channel "${split.channel}" (active: ${this.listChannelNames().join(", ") || "none"})`
        : `Cannot route chat id without "<channel>${CHAT_ID_SEPARATOR}" prefix (active: ${this.listChannelNames().join(", ") || "none"})`,
    );
  }

  async sendMessage(msg: OutboundMessage): Promise<{ messageId?: string } | void> {
    const { channel, adapter, rawChatId } = this.resolveTarget(msg.chatId);
    const entry = this.entries.get(channel);
    try {
      const result = await adapter.sendMessage({ ...msg, chatId: rawChatId });
      if (entry) {
        entry.lastOutboundAt = Date.now();
      }
      return result;
    } catch (err) {
      if (entry) {
        entry.lastError = errorMessage(err);
      }
      throw err;
    }
  }

  async sendTyping(chatId: string, active: boolean): Promise<void> {
    const { adapter, rawChatId } = this.resolveTarget(chatId);
    await adapter.sendTyping?.(rawChatId, active);
  }

  async markRead(chatId: string, messageId?: string): Promise<void> {
    const { adapter, rawChatId } = this.resolveTarget(chatId);
    await adapter.markRead?.(rawChatId, messageId);
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    const { adapter, rawChatId } = this.resolveTarget(chatId);
    await adapter.react?.(rawChatId, messageId, emoji);
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    const { adapter, rawChatId } = this.resolveTarget(chatId);
    await adapter.editMessage?.(rawChatId, messageId, text);
  }
}

function maxDefined(a?: number, b?: number): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}
