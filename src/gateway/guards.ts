export interface BotLoopGuardOptions {
  maxEvents?: number;
  windowMs?: number;
  cooldownMs?: number;
  maxChats?: number;
  nowFn?: () => number;
}

export interface BotLoopCheckResult {
  allowed: boolean;
  count: number;
  retryAfterMs?: number;
}

interface BotLoopEntry {
  timestamps: number[];
  cooledDownUntil?: number;
}

/**
 * Per-chat circuit breaker that stops runaway agent loops from spamming a chat.
 * Once a chat exceeds `maxEvents` within `windowMs`, further sends are blocked
 * for `cooldownMs`.
 */
export class BotLoopGuard {
  private readonly maxEvents: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;
  private readonly maxChats: number;
  private readonly nowFn: () => number;
  private readonly chats = new Map<string, BotLoopEntry>();

  constructor(options: BotLoopGuardOptions = {}) {
    this.maxEvents = options.maxEvents ?? 20;
    this.windowMs = options.windowMs ?? 300_000;
    this.cooldownMs = options.cooldownMs ?? 600_000;
    this.maxChats = options.maxChats ?? 2000;
    this.nowFn = options.nowFn ?? Date.now;
  }

  checkAndRecord(chatId: string): BotLoopCheckResult {
    const now = this.nowFn();
    let entry = this.chats.get(chatId);
    if (!entry) {
      if (this.chats.size >= this.maxChats) {
        const oldest = this.chats.keys().next().value;
        if (oldest !== undefined) {
          this.chats.delete(oldest);
        }
      }
      entry = { timestamps: [] };
      this.chats.set(chatId, entry);
    }

    if (entry.cooledDownUntil !== undefined) {
      if (now < entry.cooledDownUntil) {
        return {
          allowed: false,
          count: entry.timestamps.length,
          retryAfterMs: entry.cooledDownUntil - now,
        };
      }
      entry.cooledDownUntil = undefined;
      entry.timestamps = [];
    }

    const windowStart = now - this.windowMs;
    entry.timestamps = entry.timestamps.filter((ts) => ts > windowStart);
    entry.timestamps.push(now);

    if (entry.timestamps.length > this.maxEvents) {
      entry.cooledDownUntil = now + this.cooldownMs;
      return {
        allowed: false,
        count: entry.timestamps.length,
        retryAfterMs: this.cooldownMs,
      };
    }

    return { allowed: true, count: entry.timestamps.length };
  }

  reset(chatId: string): void {
    this.chats.delete(chatId);
  }

  clear(): void {
    this.chats.clear();
  }
}

export type PermanentDeliveryErrorKind = "forbidden" | "not_found" | "plan_restricted";

const TRANSIENT_PATTERNS = ["429", "500", "502", "503", "timeout", "timed out", "econnreset"];
const THREAD_LEVEL_PATTERNS = ["message not found", "thread not found", "reply target"];
const NOT_FOUND_PATTERNS = [
  "chat not found",
  "channel_not_found",
  "unknown channel",
  "unknown user",
  "recipient not found",
];
const FORBIDDEN_PATTERNS = [
  "403",
  "forbidden",
  "bot was blocked",
  "user is deactivated",
  "bot was kicked",
  "missing access",
  "missing permissions",
];
const PLAN_RESTRICTED_PATTERNS = ["target not allowed"];

function describeError(err: unknown): string {
  const parts: string[] = [];

  const push = (value: unknown): void => {
    if (typeof value === "string" || typeof value === "number") {
      parts.push(String(value));
    }
  };

  if (err instanceof Error) {
    parts.push(err.name, err.message);
    const extra = err as Error & {
      code?: unknown;
      status?: unknown;
      statusCode?: unknown;
      response?: { status?: unknown; statusCode?: unknown } | undefined;
    };
    push(extra.code);
    push(extra.status);
    push(extra.statusCode);
    if (extra.response && typeof extra.response === "object") {
      push(extra.response.status);
      push(extra.response.statusCode);
    }
  } else if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    for (const key of ["name", "message", "code", "status", "statusCode", "error", "reason", "description"]) {
      push(obj[key]);
    }
    try {
      parts.push(JSON.stringify(err));
    } catch {
      // Circular payloads still contribute their individual string fields above.
    }
  } else {
    push(err);
  }

  return parts.join(" ").toLowerCase();
}

function containsAny(haystack: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => haystack.includes(pattern));
}

/**
 * Classify delivery failures that will never succeed on retry, so reminders and
 * loops can stop hammering a chat that no longer exists or blocks the bot.
 */
export function classifyPermanentDeliveryError(err: unknown): PermanentDeliveryErrorKind | null {
  const text = describeError(err);
  if (!text) {
    return null;
  }

  if (containsAny(text, TRANSIENT_PATTERNS) || containsAny(text, THREAD_LEVEL_PATTERNS)) {
    return null;
  }
  if (containsAny(text, PLAN_RESTRICTED_PATTERNS)) {
    return "plan_restricted";
  }
  if (containsAny(text, NOT_FOUND_PATTERNS)) {
    return "not_found";
  }
  if (containsAny(text, FORBIDDEN_PATTERNS)) {
    return "forbidden";
  }
  return null;
}

export interface DeadTargetRegistryOptions {
  ttlMs?: number;
  maxEntries?: number;
  nowFn?: () => number;
}

interface DeadTargetEntry {
  reason: PermanentDeliveryErrorKind;
  recordedAt: number;
  expiresAt: number;
}

export interface DeadTargetStatus {
  dead: boolean;
  reason?: string;
}

/**
 * TTL-bounded registry of chats that permanently rejected delivery.
 * Entries self-clear on the next successful send or inbound message.
 */
export class DeadTargetRegistry {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly nowFn: () => number;
  private readonly entries = new Map<string, DeadTargetEntry>();

  constructor(options: DeadTargetRegistryOptions = {}) {
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 2000;
    this.nowFn = options.nowFn ?? Date.now;
  }

  recordError(chatId: string, err: unknown): boolean {
    const reason = classifyPermanentDeliveryError(err);
    if (!reason) {
      return false;
    }

    if (!this.entries.has(chatId) && this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }

    const now = this.nowFn();
    this.entries.set(chatId, {
      reason,
      recordedAt: now,
      expiresAt: now + this.ttlMs,
    });
    return true;
  }

  isDead(chatId: string): DeadTargetStatus {
    const entry = this.entries.get(chatId);
    if (!entry) {
      return { dead: false };
    }
    if (this.nowFn() >= entry.expiresAt) {
      this.entries.delete(chatId);
      return { dead: false };
    }
    return { dead: true, reason: entry.reason };
  }

  markAlive(chatId: string): void {
    this.entries.delete(chatId);
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}