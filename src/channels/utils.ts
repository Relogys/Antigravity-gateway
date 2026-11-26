import { mkdir, writeFile } from "node:fs/promises";
import type http from "node:http";
import type { AddressInfo } from "node:net";
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
    const buf = await readResponseWithinLimit(res, maxBytes, controller);
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

/** Stream a Fetch `Response` body into a Buffer while enforcing `maxBytes` incrementally. */
export async function readResponseWithinLimit(
  res: Response,
  maxBytes: number,
  abortController?: AbortController,
): Promise<Buffer> {
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw new Error(`Download exceeds ${maxBytes} bytes`);
    }
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          abortController?.abort();
          await reader.cancel().catch(() => {});
          throw new Error(`Download exceeds ${maxBytes} bytes`);
        }
        chunks.push(Buffer.from(value));
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/** True for loopback hosts (`127.0.0.0/8`, `localhost`, `::1`). */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** Parse a request URL against localhost, throwing `onInvalid()` on malformed paths. */
export function parseRequestUrl(rawUrl: string | undefined, onInvalid: () => Error): URL {
  try {
    return new URL(rawUrl ?? "/", "http://localhost");
  } catch {
    throw onInvalid();
  }
}

/** Read an HTTP request body with early `Content-Length` check and streaming byte cap. */
export async function readBoundedHttpBody(
  req: http.IncomingMessage,
  maxBytes: number,
  onTooLarge: () => Error,
): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    req.resume();
    throw onTooLarge();
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.byteLength;
    if (total > maxBytes) {
      throw onTooLarge();
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Configure safe keep-alive and request timeouts on an HTTP callback server. */
export function configureHttpServerTimeouts(
  server: http.Server,
  options: { requestTimeoutMs?: number } = {},
): void {
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 65_000;
  if (options.requestTimeoutMs !== undefined) {
    server.requestTimeout = options.requestTimeoutMs;
  }
}

/** Start listening on an HTTP server and resolve with its bound port. */
export async function listenHttpServer(
  server: http.Server,
  port: number,
  host: string,
): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

/** Close an HTTP server and terminate keep-alive sockets immediately. */
export async function closeHttpServer(server: http.Server | undefined): Promise<void> {
  if (!server) {
    return;
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

/** Insert or refresh a key in an LRU-bounded Map, evicting the oldest entry if full. */
export function rememberBounded<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  maxEntries: number,
): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    map.delete(oldest);
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
