import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Default cap for inline media downloads (20 MiB). */
export const MAX_INLINE_MEDIA_BYTES = 20 * 1024 * 1024;

/**
 * Split text into chunks of at most `maxLen` characters, preferring paragraph,
 * line, sentence, then word boundaries; hard-splits only when no boundary exists.
 * Never splits inside a UTF-16 surrogate pair. Returns `[]` for blank input.
 */
export function chunkText(text: string, maxLen: number): string[] {
  const limit = Math.max(1, Math.floor(maxLen));
  const input = text.trim();
  if (!input) {
    return [];
  }
  if (input.length <= limit) {
    return [input];
  }

  const chunks: string[] = [];
  let rest = input;
  while (rest.length > limit) {
    const window = rest.slice(0, limit + 1);
    let cut = -1;
    for (const sep of ["\n\n", "\n", ". ", " "]) {
      const idx = window.lastIndexOf(sep, limit);
      // Require a boundary past the first 30% so we don't emit tiny chunks.
      if (idx >= Math.floor(limit * 0.3)) {
        cut = idx + (sep === ". " ? 1 : 0);
        break;
      }
    }
    if (cut <= 0) {
      cut = limit;
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff && cut > 1) {
        cut -= 1; // keep surrogate pair together
      }
    }
    const piece = rest.slice(0, cut).trimEnd();
    if (piece) {
      chunks.push(piece);
    }
    rest = rest.slice(cut).trimStart();
  }
  if (rest) {
    chunks.push(rest);
  }
  return chunks;
}

/** Case-insensitive check whether `text` contains any of the mention `patterns`. */
export function isMentioned(text: string, patterns: readonly string[]): boolean {
  if (!text) {
    return false;
  }
  const lower = text.toLowerCase();
  return patterns.some((pattern) => {
    const p = pattern.trim().toLowerCase();
    return p.length > 0 && lower.includes(p);
  });
}

export interface BoundedDedupeOptions {
  maxEntries?: number;
  ttlMs?: number;
}

/**
 * Insertion-ordered TTL + size-bounded cache for inbound message-id dedupe.
 * `seen(id)` returns true if `id` was already recorded (duplicate), otherwise records it.
 */
export class BoundedDedupeCache {
  private readonly entries = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(options: BoundedDedupeOptions = {}) {
    this.maxEntries = options.maxEntries ?? 4000;
    this.ttlMs = options.ttlMs ?? 48 * 60 * 60 * 1000;
  }

  get size(): number {
    return this.entries.size;
  }

  has(id: string, now = Date.now()): boolean {
    const ts = this.entries.get(id);
    return ts !== undefined && now - ts < this.ttlMs;
  }

  seen(id: string, now = Date.now()): boolean {
    if (this.has(id, now)) {
      return true;
    }
    this.entries.delete(id);
    this.entries.set(id, now);
    for (const [key, ts] of this.entries) {
      if (this.entries.size <= this.maxEntries && now - ts < this.ttlMs) {
        break;
      }
      this.entries.delete(key);
    }
    return false;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Reduce an arbitrary (possibly hostile) filename/id to a safe single path segment. */
export function sanitizeFilename(name: string | undefined, fallback = "attachment.bin"): string {
  const base = path.basename((name ?? "").trim().replace(/\\/g, "/"));
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  if (!cleaned || cleaned === "." || cleaned === "..") {
    return fallback;
  }
  return cleaned;
}

/**
 * Persist inbound media under `<mediaDir>/<channel>/<msgId>-<filename>` (all segments
 * sanitized, no path traversal). Returns the absolute path written.
 */
export async function saveInboundMedia(
  mediaDir: string,
  channel: string,
  msgId: string,
  filename: string | undefined,
  data: Buffer | Uint8Array,
): Promise<string> {
  const dir = path.join(mediaDir, sanitizeFilename(channel, "channel"));
  await mkdir(dir, { recursive: true });
  const safeName = `${sanitizeFilename(msgId, "msg")}-${sanitizeFilename(filename)}`;
  const target = path.resolve(dir, safeName);
  await writeFile(target, data);
  return target;
}

export interface DownloadOptions {
  headers?: Record<string, string>;
  maxBytes?: number;
  timeoutMs?: number;
}

/** Download a URL into a Buffer with a size cap and timeout (for platform file URLs). */
export async function downloadToBuffer(
  url: string,
  options: DownloadOptions = {},
): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? MAX_INLINE_MEDIA_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  try {
    const res = await fetch(url, { headers: options.headers, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Download failed with HTTP ${res.status}`);
    }
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > maxBytes) {
      throw new Error(`Download exceeds ${maxBytes} bytes`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw new Error(`Download exceeds ${maxBytes} bytes`);
    }
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve after `ms`, or immediately when `signal` aborts. Never rejects. */
export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Exponential reconnect delay with jitter: ~500ms, 1s, 2s ... capped at `maxMs` (default 30s). */
export function reconnectDelayMs(attempt: number, initialMs = 500, maxMs = 30_000): number {
  const nominal = Math.min(maxMs, initialMs * 2 ** Math.max(0, attempt));
  return Math.round(nominal * (0.5 + Math.random() * 0.5));
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
