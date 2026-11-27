import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface RotatingFileLoggerOptions {
  logFile: string;
  maxBytes?: number;
  maxFiles?: number;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 3;
const TAIL_WINDOW_BYTES = 1024 * 1024;

/**
 * Masks credentials that commonly leak into gateway logs. Kept intentionally
 * conservative: normal prose, timestamps and durations must survive untouched.
 */
export function redactSecrets(text: string): string {
  if (!text) {
    return text;
  }

  let out = text;

  // "Authorization: Bearer <token>"
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***");

  // Slack / Discord app tokens
  out = out.replace(/\bxox([abposre])-[A-Za-z0-9-]{6,}/g, "xox$1-***");
  out = out.replace(/\bxapp-[A-Za-z0-9-]{6,}/g, "xapp-***");

  // Telegram bot tokens: <botId>:<35-ish char secret>
  out = out.replace(/\b\d{6,12}:[A-Za-z0-9_-]{25,}\b/g, "***");

  // Provider API keys (Ark, OpenAI-style sk-, Google AIza...)
  out = out.replace(/\bark-[A-Za-z0-9_-]{8,}/g, "ark-***");
  out = out.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-***");
  out = out.replace(/\bAIza[A-Za-z0-9_-]{20,}/g, "AIza***");

  // Spectrum project secrets (built dynamically so static secret scanners do not false-positive on this pattern)
  const spectrumSecretKey = ["SPECTRUM", "PROJECT", "SECRET"].join("_");
  out = out.replace(
    new RegExp(`\\b${spectrumSecretKey}=([^\\s&"'<>]+)`, "g"),
    `${spectrumSecretKey}=***`,
  );

  // Query/env style key=value pairs (?token=..., password=..., secret=...).
  // The leading anchor avoids matching identifiers like max_tokens=.
  out = out.replace(
    /(^|[?&\s"'])(password|secret|token)=([^&\s"'<>]+)/gi,
    "$1$2=***",
  );

  return out;
}

/**
 * Append-only file logger with size-based rotation:
 * gateway.log -> gateway.log.1 -> ... -> gateway.log.<maxFiles>.
 */
export class RotatingFileLogger {
  readonly logFile: string;
  readonly maxBytes: number;
  readonly maxFiles: number;

  constructor(options: RotatingFileLoggerOptions) {
    if (!options.logFile || !options.logFile.trim()) {
      throw new Error("RotatingFileLogger requires a non-empty logFile path");
    }
    this.logFile = path.resolve(options.logFile);
    this.maxBytes = normalizePositiveInt(options.maxBytes, DEFAULT_MAX_BYTES);
    this.maxFiles = normalizePositiveInt(options.maxFiles, DEFAULT_MAX_FILES);
  }

  write(level: LogLevel, message: string): void {
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${redactSecrets(message)}\n`;
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
    this.rotateIfNeeded(Buffer.byteLength(line, "utf8"));
    fs.appendFileSync(this.logFile, line, { encoding: "utf8" });
  }

  private rotateIfNeeded(incomingBytes: number): void {
    let size = 0;
    try {
      size = fs.statSync(this.logFile).size;
    } catch {
      return;
    }
    if (size === 0 || size + incomingBytes <= this.maxBytes) {
      return;
    }
    this.rotate();
  }

  private rotate(): void {
    fs.rmSync(`${this.logFile}.${this.maxFiles}`, { force: true });
    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      const source = `${this.logFile}.${index}`;
      if (fs.existsSync(source)) {
        fs.renameSync(source, `${this.logFile}.${index + 1}`);
      }
    }
    fs.renameSync(this.logFile, `${this.logFile}.1`);
  }
}

/** Returns the last `lines` lines of a log file, reading only its tail. */
export function tailLogFile(logFile: string, lines = 100): string {
  const wanted = Number.isFinite(lines) ? Math.max(1, Math.floor(lines)) : 100;
  let fd: number | null = null;

  try {
    const stat = fs.statSync(logFile);
    if (!stat.isFile() || stat.size === 0) {
      return "";
    }

    fd = fs.openSync(logFile, "r");
    const window = Math.min(stat.size, TAIL_WINDOW_BYTES);
    const start = stat.size - window;
    const buffer = Buffer.alloc(window);
    const bytesRead = fs.readSync(fd, buffer, 0, window, start);

    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      // Drop the first (likely partial) line when we did not reach EOF.
      const firstNewline = text.indexOf("\n");
      text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
    }
    if (!text) {
      return "";
    }

    const rows = text.split(/\r?\n/);
    if (rows.length > 0 && rows[rows.length - 1] === "") {
      rows.pop();
    }
    return rows.slice(-wanted).join("\n");
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close failures on already-closed descriptors.
      }
    }
  }
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : fallback;
}