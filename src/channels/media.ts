import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { sanitizeFilename } from "./utils.js";

/** Hard cap for a single inbound media download (15 MiB). */
export const MAX_INBOUND_MEDIA_BYTES = 15 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 20_000;

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
};

const ALLOWED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".pdf", ".bin"]);

export interface DownloadInboundMediaOptions {
  url: string;
  mediaDir: string;
  headers?: Record<string, string>;
  filenameHint?: string;
  mimeTypeHint?: string;
  maxBytes?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface DownloadInboundMediaResult {
  localPath: string;
  mimeType: string;
  sizeBytes: number;
  name: string;
}

function assertHttpUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid media URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Refusing to download non-HTTP(S) media URL (${parsed.protocol})`);
  }
  return parsed;
}

/** Strip parameters (`;charset=...`) and lowercase a Content-Type header. */
function normalizeMimeType(value: string | null): string | undefined {
  const mime = value?.split(";")[0]?.trim().toLowerCase();
  return mime ? mime : undefined;
}

function extensionFromHint(filenameHint: string | undefined): string | undefined {
  if (!filenameHint) {
    return undefined;
  }
  const ext = path.extname(sanitizeFilename(filenameHint)).toLowerCase();
  if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
    return undefined;
  }
  return ext === ".jpeg" ? ".jpg" : ext;
}

function deriveExtension(
  filenameHint: string | undefined,
  mimeType: string,
): string {
  return (
    extensionFromHint(filenameHint) ??
    EXTENSION_BY_MIME[mimeType] ??
    ".bin"
  );
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Safe on-disk/display name: sanitized stem + a whitelisted extension. */
function deriveName(filenameHint: string | undefined, parsedUrl: URL, ext: string): string {
  const urlName = safeDecode(parsedUrl.pathname.split("/").pop() ?? "");
  const raw = filenameHint?.trim() || urlName.trim() || "media";
  const safe = sanitizeFilename(raw, "media");
  const stem = sanitizeFilename(safe.replace(/\.[^./\\]*$/, ""), "media");
  return `${stem || "media"}${ext}`.slice(0, 160);
}

/**
 * Stream a binary Fetch `Response` into a Buffer, aborting once `maxBytes` is
 * exceeded. Decodes bytes verbatim (no text decoding) so binary payloads such as
 * PNG/JPEG survive intact.
 */
export async function readBinaryResponseWithinLimit(
  res: Response,
  maxBytes: number,
  abortController?: AbortController,
): Promise<Buffer> {
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw new Error(`Media download exceeds ${maxBytes} bytes`);
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
          throw new Error(`Media download exceeds ${maxBytes} bytes`);
        }
        // Copy the bytes so a reused backing buffer cannot corrupt earlier chunks.
        chunks.push(Buffer.from(value));
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released / cancelled
    }
  }
  return Buffer.concat(chunks, total);
}

/**
 * Download an inbound media URL to `<mediaDir>/<timestamp>-<uuid>-<name>`.
 * Validates the URL scheme, streams with a byte cap and timeout, infers a safe
 * extension, and returns the persisted path plus metadata.
 */
export async function downloadInboundMedia(
  options: DownloadInboundMediaOptions,
): Promise<DownloadInboundMediaResult> {
  const parsed = assertHttpUrl(options.url);
  const maxBytes = options.maxBytes ?? MAX_INBOUND_MEDIA_BYTES;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;

  try {
    const res = await fetchImpl(parsed.toString(), {
      method: "GET",
      headers: options.headers,
      signal,
    });
    if (!res.ok) {
      throw new Error(`Media download failed with HTTP ${res.status}`);
    }

    const declared = Number(res.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`Media download exceeds ${maxBytes} bytes`);
    }

    const buffer = await readBinaryResponseWithinLimit(res, maxBytes, controller);

    const contentType = normalizeMimeType(res.headers.get("content-type"));
    const mimeType =
      contentType ??
      normalizeMimeType(options.mimeTypeHint ?? null) ??
      "application/octet-stream";
    const ext = deriveExtension(options.filenameHint, mimeType);
    const name = deriveName(options.filenameHint, parsed, ext);

    await mkdir(options.mediaDir, { recursive: true });
    const diskName = `${Date.now().toString(36)}-${randomUUID()}-${name}`;
    const localPath = path.resolve(options.mediaDir, diskName);
    await writeFile(localPath, buffer);

    return { localPath, mimeType, sizeBytes: buffer.byteLength, name };
  } finally {
    clearTimeout(timer);
  }
}