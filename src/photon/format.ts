import path from "node:path";
import { normalizeSenderId } from "../config.js";

const DEFAULT_MAX_MESSAGE_LENGTH = 7500;

const SENSITIVE_PATH_SEGMENTS = new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  ".kube",
  ".docker",
]);

const SENSITIVE_BASENAMES = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  "credentials.json",
]);

const SENSITIVE_EXTENSIONS = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".kdbx",
]);

/**
 * Normalize an iMessage space/chat identifier into a canonical session key.
 * - Group chat GUIDs containing `;+;` are preserved (trimmed).
 * - DM GUIDs (`any;-;+15551234567`, `iMessage;-;user@example.com`, etc.) and bare
 *   handles are normalized to E.164 or lowercase email via `normalizeSenderId`.
 */
export function normalizeSpaceId(chatId: string): string {
  const trimmed = chatId.trim();
  if (!trimmed) {
    return "";
  }

  // Group chat GUIDs use `;+;` (e.g., `any;+;chat123456789`). Keep distinct from DMs.
  if (trimmed.includes(";+;")) {
    return trimmed;
  }

  return normalizeSenderId(trimmed) || trimmed;
}

/**
 * Lightly sanitize Markdown for iMessage rendering while preserving code blocks,
 * inline code, bold/italic emphasis, lists, and URLs.
 */
export function sanitizeForIMessage(text: string): string {
  if (!text) {
    return "";
  }

  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inFence = false;
  let tableHeaders: string[] | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (/^```|^~~~/.test(trimmed)) {
      tableHeaders = null;
      inFence = !inFence;
      out.push(line);
      continue;
    }

    if (inFence) {
      out.push(line);
      continue;
    }

    // Horizontal rules -> em-dash line
    if (/^(?:[-*_]\s*){3,}$/.test(trimmed)) {
      tableHeaders = null;
      out.push("———");
      continue;
    }

    // Markdown table handling: header | separator | rows
    if (trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.includes("|")) {
      const cells = trimmed
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim());

      const nextLine = (lines[i + 1] ?? "").trim();
      const isSeparator = cells.every((c) => /^:?-{2,}:?$/.test(c));

      if (isSeparator) {
        continue;
      }

      if (
        !tableHeaders &&
        nextLine.startsWith("|") &&
        nextLine
          .replace(/^\||\|$/g, "")
          .split("|")
          .every((c) => /^:?\s*-{2,}\s*:?$/.test(c.trim()))
      ) {
        tableHeaders = cells;
        continue;
      }

      if (tableHeaders && tableHeaders.length === cells.length) {
        const pairs = cells.map((cell, idx) => {
          const hdr = tableHeaders?.[idx];
          return hdr ? `${hdr}: ${cell}` : cell;
        });
        out.push(`• ${pairs.join(" | ")}`);
        continue;
      }

      out.push(`• ${cells.join(" | ")}`);
      continue;
    }

    tableHeaders = null;

    // Headings (`# Title`) -> bold line
    const headingMatch = line.match(/^#{1,6}\s+(.+?)\s*#*$/);
    if (headingMatch?.[1]) {
      out.push(`**${headingMatch[1]}**`);
      continue;
    }

    out.push(line);
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const BARE_URL_RE = /^https?:\/\/\S+$/i;
const CONTAINS_URL_RE = /https?:\/\/\S+/i;

/**
 * Select the safest Spectrum content mode for an outbound text message:
 * - Bare single http(s) URL -> `"richlink"`
 * - Any text containing a URL -> `"text"` (avoids markdown/data-detection edge cases)
 * - Otherwise `"markdown"` when `preferMarkdown !== false`, else `"text"`
 */
export function chooseSendFormat(
  text: string,
  preferMarkdown = true,
): { mode: "text" | "markdown" | "richlink"; content: string } {
  const trimmed = text.trim();

  if (BARE_URL_RE.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return { mode: "richlink", content: trimmed };
      }
    } catch {
      // Fall through to text mode if URL parsing fails
    }
  }

  if (CONTAINS_URL_RE.test(text)) {
    return { mode: "text", content: text };
  }

  return {
    mode: preferMarkdown !== false ? "markdown" : "text",
    content: text,
  };
}

function findSplitIndex(slice: string): number {
  const minBound = Math.floor(slice.length * 0.4);

  const paraIdx = slice.lastIndexOf("\n\n");
  if (paraIdx >= minBound) {
    return paraIdx + 2;
  }

  const lineIdx = slice.lastIndexOf("\n");
  if (lineIdx >= minBound) {
    return lineIdx + 1;
  }

  const spaceIdx = slice.lastIndexOf(" ");
  if (spaceIdx >= minBound) {
    return spaceIdx + 1;
  }

  return slice.length;
}

/**
 * Split long outbound messages on clean paragraph/line/word boundaries and
 * prepend `[i/n]` markers when more than one chunk is produced.
 */
export function chunkMessage(
  text: string,
  maxLen: number = DEFAULT_MAX_MESSAGE_LENGTH,
): string[] {
  const limit = Math.max(20, Math.floor(maxLen));
  if (text.length <= limit) {
    return [text];
  }

  // Reserve room for `[99/99] ` prefix (up to 10 chars) while keeping body roomy.
  const prefixReserve = Math.min(10, Math.floor(limit * 0.35));
  const bodyLimit = Math.max(10, limit - prefixReserve);

  const rawChunks: string[] = [];
  let remaining = text;

  while (remaining.length > bodyLimit) {
    const candidate = remaining.slice(0, bodyLimit);
    let splitAt = findSplitIndex(candidate);
    if (splitAt <= 0) {
      splitAt = bodyLimit;
    }

    const head = remaining.slice(0, splitAt).trimEnd();
    if (head) {
      rawChunks.push(head);
    }
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    rawChunks.push(remaining);
  }

  if (rawChunks.length <= 1) {
    return rawChunks.length === 1 ? rawChunks : [text];
  }

  const total = rawChunks.length;
  return rawChunks.map((chunk, idx) => `[${idx + 1}/${total}] ${chunk}`);
}

function isSensitiveMediaPath(resolvedPath: string): boolean {
  const normalized = resolvedPath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  const base = (segments.at(-1) ?? "").toLowerCase();

  if (base === ".env" || base.startsWith(".env.")) {
    return true;
  }
  if (SENSITIVE_BASENAMES.has(base)) {
    return true;
  }

  const ext = path.extname(base);
  if (SENSITIVE_EXTENSIONS.has(ext)) {
    return true;
  }

  for (const seg of segments) {
    if (SENSITIVE_PATH_SEGMENTS.has(seg.toLowerCase())) {
      return true;
    }
  }

  return false;
}

function isWithinRoot(candidatePath: string, allowedRoot: string): boolean {
  const resolvedCandidate = path.resolve(candidatePath);
  const resolvedRoot = path.resolve(allowedRoot);

  const normCandidate =
    process.platform === "win32"
      ? resolvedCandidate.toLowerCase()
      : resolvedCandidate;
  const normRoot =
    process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot;

  const rel = path.relative(normRoot, normCandidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const MEDIA_DIRECTIVE_RE =
  /MEDIA:(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"'`<>]+))/gi;

/**
 * Extract `MEDIA:<path>` directives from outbound agent text while blocking
 * sensitive secret paths (`.env`, `.ssh`, private keys) and paths outside `allowedRoot`.
 */
export function extractOutboundMedia(
  text: string,
  allowedRoot?: string,
): { cleanText: string; mediaPaths: string[] } {
  if (!text) {
    return { cleanText: "", mediaPaths: [] };
  }

  const mediaPaths: string[] = [];
  const seen = new Set<string>();
  const baseDir = allowedRoot ? path.resolve(allowedRoot) : process.cwd();

  const stripped = text.replace(
    MEDIA_DIRECTIVE_RE,
    (_full, doubleQuoted?: string, singleQuoted?: string, bare?: string) => {
      const rawTarget = (doubleQuoted ?? singleQuoted ?? bare ?? "").trim();
      if (!rawTarget) {
        return "";
      }

      const resolved = path.isAbsolute(rawTarget)
        ? path.resolve(rawTarget)
        : path.resolve(baseDir, rawTarget);

      if (isSensitiveMediaPath(resolved)) {
        return "";
      }

      if (allowedRoot && !isWithinRoot(resolved, allowedRoot)) {
        return "";
      }

      if (!seen.has(resolved)) {
        seen.add(resolved);
        mediaPaths.push(resolved);
      }

      return "";
    },
  );

  const cleanText = stripped
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { cleanText, mediaPaths };
}
