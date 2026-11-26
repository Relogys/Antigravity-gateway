import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";
import type { ApprovalMode, LogLevel } from "./types.js";

/**
 * Normalize an iMessage / Apple sender identifier into canonical form.
 * - Strips Apple/Photon routing prefixes such as `any;-;` or `iMessage;-;`
 * - Lowercases email addresses
 * - Preserves E.164 `+` and digits for phone numbers
 */
export function normalizeSenderId(raw: string): string {
  let value = raw.trim();
  if (!value) {
    return "";
  }

  // Strip routing prefix like "any;-;+15551234567" or "iMessage;-;user@example.com"
  const semiIdx = value.lastIndexOf(";-;");
  if (semiIdx !== -1) {
    value = value.slice(semiIdx + 3).trim();
  }

  if (!value) {
    return "";
  }

  if (value.includes("@")) {
    return value.toLowerCase();
  }

  const compact = value.replace(/[\s().-]/g, "");
  if (/^\+?\d{7,16}$/.test(compact)) {
    return compact.startsWith("+") ? compact : `+${compact}`;
  }

  return value.toLowerCase();
}

/**
 * Parse a comma-separated allowlist of phone numbers or Apple ID emails.
 */
export function parseAllowedSenders(raw: string | undefined): Set<string> {
  if (!raw) {
    return new Set();
  }

  const allowed = new Set<string>();
  for (const part of raw.split(",")) {
    const normalized = normalizeSenderId(part);
    if (normalized) {
      allowed.add(normalized);
    }
  }
  return allowed;
}

function parseBoolEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid boolean env value: "${value}"`);
}

function parseListEnv(value: string | undefined, defaults: string[]): string[] {
  if (value === undefined || value.trim() === "") {
    return defaults;
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const envSchema = z.object({
  SPECTRUM_PROJECT_ID: z.string().trim().min(1, "SPECTRUM_PROJECT_ID is required"),
  SPECTRUM_PROJECT_SECRET: z.string().trim().min(1, "SPECTRUM_PROJECT_SECRET is required"),
  ALLOWED_SENDERS: z.string().optional(),
  ALLOW_GROUPS: z.string().optional(),
  GROUP_MENTION_PATTERNS: z.string().optional(),
  AGY_BIN: z.string().trim().min(1).default("agy"),
  DEFAULT_CWD: z.string().trim().optional(),
  APPROVAL_MODE: z.enum(["auto", "interactive", "sandbox"]).default("interactive"),
  DEFAULT_MODEL: z.string().trim().optional(),
  DEFAULT_EFFORT: z.string().trim().optional(),
  GEMINI_API_KEY: z.string().trim().optional(),
  HEALTH_ENABLED: z.string().optional(),
  HEALTH_HOST: z.string().trim().min(1).default("127.0.0.1"),
  HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(18790),
  PHOTON_READ_RECEIPTS: z.string().optional(),
  PHOTON_REACTIONS: z.string().optional(),
  QUOTA_WARN_THRESHOLD: z.coerce.number().min(0).max(100).default(15),
  DATA_DIR: z.string().trim().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export interface GatewayConfig {
  spectrumProjectId: string;
  spectrumProjectSecret: string;
  allowedSenders: Set<string>;
  allowGroups: boolean;
  groupMentionPatterns: string[];
  agyBin: string;
  defaultCwd: string;
  approvalMode: ApprovalMode;
  defaultModel?: string;
  defaultEffort?: string;
  geminiApiKey?: string;
  healthEnabled: boolean;
  healthHost: string;
  healthPort: number;
  photonReadReceipts: boolean;
  photonReactions: boolean;
  quotaWarnThreshold: number;
  dataDir: string;
  logLevel: LogLevel;
}

export interface LoadConfigOptions {
  loadDotenv?: boolean;
  dotenvPath?: string;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  options: LoadConfigOptions = {},
): GatewayConfig {
  if (options.loadDotenv !== false) {
    dotenv.config({ path: options.dotenvPath, quiet: true });
  }

  const parsed = envSchema.parse(env);

  const defaultCwd = parsed.DEFAULT_CWD
    ? path.resolve(parsed.DEFAULT_CWD)
    : process.cwd();
  const dataDir = parsed.DATA_DIR
    ? path.resolve(parsed.DATA_DIR)
    : path.resolve(process.cwd(), "data");

  return {
    spectrumProjectId: parsed.SPECTRUM_PROJECT_ID,
    spectrumProjectSecret: parsed.SPECTRUM_PROJECT_SECRET,
    allowedSenders: parseAllowedSenders(parsed.ALLOWED_SENDERS),
    allowGroups: parseBoolEnv(parsed.ALLOW_GROUPS, false),
    groupMentionPatterns: parseListEnv(parsed.GROUP_MENTION_PATTERNS, [
      "@agy",
      "@antigravity",
    ]),
    agyBin: parsed.AGY_BIN,
    defaultCwd,
    approvalMode: parsed.APPROVAL_MODE,
    defaultModel: parsed.DEFAULT_MODEL || undefined,
    defaultEffort: parsed.DEFAULT_EFFORT || undefined,
    geminiApiKey: parsed.GEMINI_API_KEY || undefined,
    healthEnabled: parseBoolEnv(parsed.HEALTH_ENABLED, false),
    healthHost: parsed.HEALTH_HOST,
    healthPort: parsed.HEALTH_PORT,
    photonReadReceipts: parseBoolEnv(parsed.PHOTON_READ_RECEIPTS, true),
    photonReactions: parseBoolEnv(parsed.PHOTON_REACTIONS, true),
    quotaWarnThreshold: parsed.QUOTA_WARN_THRESHOLD,
    dataDir,
    logLevel: parsed.LOG_LEVEL,
  };
}
