import type { InboundMessage } from "../types.js";

/** Optional reply-quote metadata channels may attach to inbound messages. */
export interface ReplyQuoteMetadata {
  replyToMessageId?: string;
  replyToText?: string;
  replyToIsOwnMessage?: boolean;
}

export interface IngressBurstCoalescerOptions {
  /** Quiet period (ms) after the last bubble before a coalesced turn fires (default 350). */
  debounceMs?: number;
  /** Absolute ceiling (ms) measured from the first buffered bubble (default 1000). */
  hardCapMs?: number;
  /** Invoked exactly once per flush with the merged inbound message. */
  onFlush: (merged: InboundMessage) => Promise<void> | void;
}

interface BurstEntry {
  chatId: string;
  firstAt: number;
  generation: number;
  buffered: InboundMessage[];
  timer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_DEBOUNCE_MS = 350;
const DEFAULT_HARD_CAP_MS = 1000;

/**
 * Coalesces rapid-fire message bubbles (iMessage-style splitting) per
 * `chatId::senderId` into a single merged prompt, bounded by a hard cap so a
 * continuously typing sender still gets a timely reply.
 */
export class IngressBurstCoalescer {
  private readonly debounceMs: number;
  private readonly hardCapMs: number;
  private readonly onFlush: (merged: InboundMessage) => Promise<void> | void;
  private readonly entries = new Map<string, BurstEntry>();
  private generationSeed = 0;
  private stopped = false;

  constructor(options: IngressBurstCoalescerOptions) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.hardCapMs = options.hardCapMs ?? DEFAULT_HARD_CAP_MS;
    this.onFlush = options.onFlush;
  }

  enqueue(msg: InboundMessage): void {
    if (this.stopped) {
      return;
    }
    if (this.debounceMs <= 0) {
      this.invokeFlush(msg);
      return;
    }

    const key = `${msg.chatId}::${msg.senderId}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        chatId: msg.chatId,
        firstAt: Date.now(),
        generation: 0,
        buffered: [],
      };
      this.entries.set(key, entry);
    }
    entry.buffered.push(msg);
    this.arm(key, entry);
  }

  discard(chatId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.chatId !== chatId) {
        continue;
      }
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      this.entries.delete(key);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const entry of this.entries.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
    }
    this.entries.clear();
  }

  mergeMessages(batch: InboundMessage[]): InboundMessage {
    const last = batch[batch.length - 1];
    if (!last) {
      throw new Error("mergeMessages requires at least one message");
    }

    const texts: string[] = [];
    for (const msg of batch) {
      const text = (msg.text ?? "").trim();
      if (!text) {
        continue;
      }
      // Photo bubbles often repeat the same caption; keep one copy.
      if (texts.length > 0 && texts[texts.length - 1] === text) {
        continue;
      }
      texts.push(text);
    }

    const quoteSource = batch.find((msg) => {
      const meta = msg as InboundMessage & ReplyQuoteMetadata;
      return Boolean(meta.replyToMessageId) || Boolean(meta.replyToText);
    }) as (InboundMessage & ReplyQuoteMetadata) | undefined;

    const merged: InboundMessage & ReplyQuoteMetadata = {
      ...last,
      id: last.id,
      timestamp: last.timestamp,
      text: texts.join("\n"),
      attachments: batch.flatMap((msg) => msg.attachments ?? []),
      mentionsBot: batch.some((msg) => Boolean(msg.mentionsBot)),
    };
    if (quoteSource) {
      if (quoteSource.replyToMessageId !== undefined) {
        merged.replyToMessageId = quoteSource.replyToMessageId;
      }
      if (quoteSource.replyToText !== undefined) {
        merged.replyToText = quoteSource.replyToText;
      }
      if (quoteSource.replyToIsOwnMessage !== undefined) {
        merged.replyToIsOwnMessage = quoteSource.replyToIsOwnMessage;
      }
    }
    return merged;
  }

  private arm(key: string, entry: BurstEntry): void {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }

    const generation = ++this.generationSeed;
    entry.generation = generation;

    const elapsed = Date.now() - entry.firstAt;
    const capRemaining = Math.max(0, this.hardCapMs - elapsed);
    const delay = Math.min(this.debounceMs, capRemaining);

    entry.timer = setTimeout(() => this.flush(key, generation), delay);
    entry.timer.unref?.();
  }

  private flush(key: string, expectedGeneration: number): void {
    const entry = this.entries.get(key);
    if (!entry || entry.generation !== expectedGeneration) {
      return;
    }
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    this.entries.delete(key);
    if (entry.buffered.length === 0 || this.stopped) {
      return;
    }
    this.invokeFlush(this.mergeMessages(entry.buffered));
  }

  private invokeFlush(merged: InboundMessage): void {
    try {
      const result = this.onFlush(merged);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch(() => {});
      }
    } catch {
      // A failed flush must never take down the ingress loop.
    }
  }
}