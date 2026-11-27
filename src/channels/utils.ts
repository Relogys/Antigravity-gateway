import { mkdir, writeFile } from "node:fs/promises";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

/** Default cap for inline media downloads (20 MiB). */
export const MAX_INLINE_MEDIA_BYTES = 20 * 1024 * 1024;

/** Newline + closing fence appended when a chunk ends inside an open code block. */
const FENCE_CLOSE = "\n```";
/** Below this limit we skip fence repair; there isn't enough room for balanced fences. */
const MIN_FENCE_LIMIT = 32;

/**
 * Pick a split point at most `limit` characters in, preferring paragraph, line,
 * sentence, then word boundaries; hard-splits (surrogate-safe) when none exists.
 */
function chooseCut(rest: string, limit: number): number {
  const window = rest.slice(0, limit + 1);
  for (const sep of ["\n\n", "\n", ". ", " "]) {
    const idx = window.lastIndexOf(sep, limit);
    // Require a boundary past the first 30% so we don't emit tiny chunks.
    if (idx >= Math.floor(limit * 0.3)) {
      return idx + (sep === ". " ? 1 : 0);
    }
  }
  let cut = limit;
  const code = rest.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff && cut > 1) {
    cut -= 1; // keep surrogate pair together
  }
  return cut;
}

/**
 * Nudge `cut` out of a short inline `` `code` `` span when a nearby space can
 * carry the boundary instead. Never splits a fenced block (runs of 3+ ticks).
 */
function avoidInlineBacktickSplit(rest: string, cut: number, limit: number): number {
  const head = rest.slice(0, cut);
  if (!head.includes("`") || /^\s*`{3,}/m.test(head)) {
    return cut;
  }
  let inInline = false;
  let openIdx = -1;
  let i = 0;
  while (i < head.length) {
    if (head[i] === "`") {
      let j = i;
      while (j < head.length && head[j] === "`") {
        j += 1;
      }
      if (j - i === 1) {
        inInline = !inInline;
        if (inInline) {
          openIdx = i;
        }
      }
      i = j;
    } else {
      i += 1;
    }
  }
  if (!inInline || openIdx < 0) {
    return cut;
  }
  const boundary = Math.max(rest.lastIndexOf(" ", openIdx), rest.lastIndexOf("\n", openIdx));
  if (boundary >= Math.floor(limit * 0.3) && boundary > 0) {
    return boundary;
  }
  const closeIdx = rest.indexOf("`", cut);
  if (closeIdx > cut && closeIdx + 1 <= limit) {
    return closeIdx + 1;
  }
  return cut;
}

interface FenceLine {
  /** Offset just past the fence delimiter line (its newline, or end of input). */
  endOffset: number;
  /** Info string of the delimiter (language tag for an opening fence). */
  lang: string;
}

/** Record every triple-backtick delimiter line with its offset, in one O(n) pass. */
function collectFenceLines(input: string): FenceLine[] {
  const lines: FenceLine[] = [];
  let start = 0;
  for (;;) {
    const nl = input.indexOf("\n", start);
    const end = nl === -1 ? input.length : nl;
    const match = /^\s*`{3,}(.*)$/.exec(input.slice(start, end));
    if (match) {
      lines.push({ endOffset: end, lang: match[1].trim() });
    }
    if (nl === -1) {
      break;
    }
    start = nl + 1;
  }
  return lines;
}

/**
 * Language of the fenced code block open at `offset`, or `undefined` when the
 * offset is outside any fence. Delimiter lines count once fully read.
 */
function openFenceLangAt(lines: FenceLine[], offset: number): string | undefined {
  let lo = 0;
  let hi = lines.length - 1;
  let read = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].endOffset <= offset) {
      read = mid + 1;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (read % 2 === 1) {
    return lines[read - 1].lang;
  }
  return undefined;
}

/**
 * Split text into chunks of at most `maxLen` characters, preferring paragraph,
 * line, sentence, then word boundaries; hard-splits only when no boundary exists.
 * Never splits inside a UTF-16 surrogate pair. Returns `[]` for blank input.
 *
 * Triple-backtick code fences are tracked across chunks: a boundary inside an
 * open fence closes the chunk with ``\n``` `` and reopens the next one with
 * ```` ```lang\n ```` (same language tag) when `maxLen` leaves room for it.
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

  const fenceLines = collectFenceLines(input);
  const chunks: string[] = [];
  let rest = input;
  let pos = 0; // original offset of rest[0]
  let pendingPrefix = ""; // reopened fence prepended to the next chunk

  while (rest.length + pendingPrefix.length > limit) {
    const effectiveLimit = limit - pendingPrefix.length;
    if (effectiveLimit <= 0) {
      // A pathological language tag consumed the budget; split without a prefix.
      const cut = Math.max(1, Math.min(rest.length, limit));
      const piece = rest.slice(0, cut).trimEnd();
      if (piece) {
        chunks.push(piece);
      }
      pos += cut;
      rest = rest.slice(cut).trimStart();
      pendingPrefix = "";
      continue;
    }

    let cut = chooseCut(rest, effectiveLimit);
    let fenceLang = openFenceLangAt(fenceLines, pos + cut);

    if (fenceLang === undefined && pendingPrefix === "") {
      cut = avoidInlineBacktickSplit(rest, cut, effectiveLimit);
      fenceLang = openFenceLangAt(fenceLines, pos + cut);
    }

    const fenceRoom = limit >= MIN_FENCE_LIMIT && effectiveLimit - FENCE_CLOSE.length > 0;
    if (fenceLang !== undefined && fenceRoom) {
      // Reserve room for the closing fence before re-picking the boundary.
      cut = chooseCut(rest, effectiveLimit - FENCE_CLOSE.length);
      fenceLang = openFenceLangAt(fenceLines, pos + cut);
    }

    const willClose = fenceRoom && fenceLang !== undefined;
    const body = rest.slice(0, cut).trimEnd();
    if (body) {
      chunks.push(`${pendingPrefix}${body}${willClose ? FENCE_CLOSE : ""}`);
    }

    const tail = rest.slice(cut);
    const trimmedTail = tail.trimStart();
    pos += cut + (tail.length - trimmedTail.length);
    rest = trimmedTail;
    pendingPrefix = willClose && fenceLang !== undefined ? `\`\`\`${fenceLang}\n` : "";

    if (cut <= 0) {
      // Guarantee progress on degenerate input.
      const forced = Math.min(limit, rest.length);
      rest = rest.slice(forced);
      pos += forced;
      pendingPrefix = "";
    }
  }

  if (rest) {
    chunks.push(pendingPrefix ? `${pendingPrefix}${rest}` : rest);
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
