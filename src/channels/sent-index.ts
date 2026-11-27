export interface SentMessageRecord {
  text: string;
  isOwnMessage: boolean;
  timestamp: number;
}

export interface SentMessageIndexOptions {
  /** Maximum retained messages (LRU eviction). Defaults to 1000. */
  maxEntries?: number;
  /** Maximum stored characters per message; longer text is truncated. Defaults to 2000. */
  maxTextChars?: number;
}

const KEY_SEPARATOR = "\u0000";

function keyFor(channel: string, rawChatId: string, messageId: string): string {
  return `${channel}${KEY_SEPARATOR}${rawChatId}${KEY_SEPARATOR}${messageId}`;
}

/** Truncate to `max` UTF-16 units without splitting a surrogate pair. */
function truncateText(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return text.slice(0, end);
}

/**
 * Bounded index of recent messages keyed by `(channel, rawChatId, messageId)`.
 * Both `record` and `lookup` keep entries in access order, so eviction is O(1)
 * (delete the oldest Map key); stored text is truncated to `maxTextChars`.
 */
export class SentMessageIndex {
  private readonly entries = new Map<string, SentMessageRecord>();
  private readonly maxEntries: number;
  private readonly maxTextChars: number;

  constructor(options: SentMessageIndexOptions = {}) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 1000));
    this.maxTextChars = Math.max(1, Math.floor(options.maxTextChars ?? 2000));
  }

  get size(): number {
    return this.entries.size;
  }

  record(
    channel: string,
    rawChatId: string,
    messageId: string,
    text: string,
    isOwnMessage: boolean,
  ): void {
    const key = keyFor(channel, rawChatId, messageId);
    this.entries.delete(key);
    this.entries.set(key, {
      text: truncateText(text, this.maxTextChars),
      isOwnMessage,
      timestamp: Date.now(),
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
  }

  lookup(
    channel: string,
    rawChatId: string,
    messageId: string,
  ): SentMessageRecord | undefined {
    const key = keyFor(channel, rawChatId, messageId);
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    // Touch on hit so frequently referenced messages survive eviction.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { ...entry };
  }

  clear(): void {
    this.entries.clear();
  }
}