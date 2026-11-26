import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";
import type { ApprovalMode, LogLevel } from "./types.js";

/** Canonical channel names (also the `channel` field on inbound messages and the chatId prefix). */
export const CHANNEL_NAMES = [
  "photon",
  "telegram",
  "discord",
  "slack",
  "feishu",
  "dingtalk",
  "onebot",
  "webhook",
  "wecom",
  "qqbot",
  "matrix",
  "mattermost",
  "line",
  "irc",
] as const;

export type ChannelName = (typeof CHANNEL_NAMES)[number];

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

/**
 * Normalize a non-iMessage platform user id (Telegram/Discord/Slack/... ids, handles, emails).
 * Only trims + lowercases; never applies phone-number rewriting (numeric ids stay numeric).
 */
export function normalizeUserId(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Parse a comma-separated per-channel allowlist (platform user ids). Values are
 * compared case-insensitively via `normalizeUserId`.
 */
export function parseAllowedUsers(raw: string | undefined): Set<string> {
  const allowed = new Set<string>();
  if (!raw) {
    return allowed;
  }
  for (const part of raw.split(",")) {
    const normalized = normalizeUserId(part);
    if (normalized) {
      allowed.add(normalized);
    }
  }
  return allowed;
}

/** True for the iMessage/Photon channel family (`photon`, legacy `photon-imessage`). */
export function isPhotonChannel(channel: string): boolean {
  return channel === "photon" || channel.startsWith("photon-");
}

/**
 * Canonical sender key used for allowlist / pairing / store lookups.
 * - Photon: the normalized phone/email (backwards compatible with existing stores).
 * - Others: `<channel>:<lowercased platform user id>` so ids never collide across platforms.
 */
export function senderKeyFor(channel: string, rawSenderId: string): string {
  if (isPhotonChannel(channel)) {
    return normalizeSenderId(rawSenderId);
  }
  const id = normalizeUserId(rawSenderId);
  return id ? `${channel.toLowerCase()}:${id}` : "";
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

/** Blank values and `your-...` placeholders (copied from old examples) count as "unset". */
function cleanEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || /^your-/i.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

const optionalString = z.string().optional();

/** Numeric env that treats blank strings as "unset" (so `FOO=` falls back to the default). */
function numberEnv(min: number, max: number, defaultValue: number) {
  return z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce.number().int().min(min).max(max).default(defaultValue),
  );
}

const envSchema = z.object({
  SPECTRUM_PROJECT_ID: optionalString,
  SPECTRUM_PROJECT_SECRET: optionalString,
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

  TELEGRAM_BOT_TOKEN: optionalString,
  TELEGRAM_ALLOWED_USERS: optionalString,
  TELEGRAM_POLL_TIMEOUT_SEC: numberEnv(0, 50, 30),

  DISCORD_BOT_TOKEN: optionalString,
  DISCORD_ALLOWED_USERS: optionalString,
  DISCORD_ALLOW_GUILDS: optionalString,

  SLACK_BOT_TOKEN: optionalString,
  SLACK_APP_TOKEN: optionalString,
  SLACK_ALLOWED_USERS: optionalString,

  FEISHU_APP_ID: optionalString,
  FEISHU_APP_SECRET: optionalString,
  FEISHU_DOMAIN: z.preprocess(
    (v) => (typeof v === "string" ? v.trim().toLowerCase() || undefined : v),
    z.enum(["feishu", "lark"]).default("feishu"),
  ),
  FEISHU_ALLOWED_USERS: optionalString,

  DINGTALK_CLIENT_ID: optionalString,
  DINGTALK_CLIENT_SECRET: optionalString,
  DINGTALK_ALLOWED_USERS: optionalString,

  ONEBOT_WS_URL: optionalString,
  ONEBOT_ACCESS_TOKEN: optionalString,
  ONEBOT_SELF_ID: optionalString,
  ONEBOT_ALLOWED_USERS: optionalString,

  WEBHOOK_ENABLED: optionalString,
  WEBHOOK_HOST: optionalString,
  WEBHOOK_PORT: numberEnv(1, 65535, 18791),
  WEBHOOK_TOKEN: optionalString,
  WEBHOOK_SECRET: optionalString,
  WEBHOOK_CALLBACK_URL: optionalString,
  WEBHOOK_ALLOWED_USERS: optionalString,

  WECOM_CORP_ID: optionalString,
  WECOM_AGENT_ID: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  ),
  WECOM_SECRET: optionalString,
  WECOM_TOKEN: optionalString,
  WECOM_ENCODING_AES_KEY: optionalString,
  WECOM_HOST: optionalString,
  WECOM_PORT: numberEnv(1, 65535, 18792),
  WECOM_ALLOWED_USERS: optionalString,

  QQBOT_APP_ID: optionalString,
  QQBOT_CLIENT_SECRET: optionalString,
  QQBOT_SANDBOX: optionalString,
  QQBOT_ALLOWED_USERS: optionalString,

  MATRIX_HOMESERVER_URL: optionalString,
  MATRIX_ACCESS_TOKEN: optionalString,
  MATRIX_USER_ID: optionalString,
  MATRIX_ALLOWED_USERS: optionalString,

  MATTERMOST_BASE_URL: optionalString,
  MATTERMOST_BOT_TOKEN: optionalString,
  MATTERMOST_ALLOWED_USERS: optionalString,

  LINE_CHANNEL_ACCESS_TOKEN: optionalString,
  LINE_CHANNEL_SECRET: optionalString,
  LINE_HOST: optionalString,
  LINE_PORT: numberEnv(1, 65535, 18793),
  LINE_ALLOWED_USERS: optionalString,

  IRC_HOST: optionalString,
  IRC_PORT: numberEnv(1, 65535, 6697),
  IRC_TLS: optionalString,
  IRC_NICK: optionalString,
  IRC_PASSWORD: optionalString,
  IRC_CHANNELS: optionalString,
  IRC_ALLOWED_USERS: optionalString,
});

export interface PhotonConfig {
  projectId: string;
  projectSecret: string;
  readReceipts: boolean;
  reactions: boolean;
}

export interface TelegramConfig {
  botToken: string;
  allowedUsers: Set<string>;
  pollTimeoutSec: number;
}

export interface DiscordConfig {
  botToken: string;
  allowedUsers: Set<string>;
  allowGuilds: boolean;
}

export interface SlackConfig {
  botToken: string;
  appToken: string;
  allowedUsers: Set<string>;
}

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  domain: "feishu" | "lark";
  allowedUsers: Set<string>;
}

export interface DingTalkConfig {
  clientId: string;
  clientSecret: string;
  allowedUsers: Set<string>;
}

export interface OneBotConfig {
  wsUrl: string;
  accessToken?: string;
  selfId?: string;
  allowedUsers: Set<string>;
}

export interface WebhookConfig {
  enabled: boolean;
  host: string;
  port: number;
  token?: string;
  secret?: string;
  callbackUrl?: string;
  allowedUsers: Set<string>;
}

export interface WeComConfig {
  corpId: string;
  agentId: number;
  secret: string;
  token?: string;
  encodingAesKey?: string;
  host: string;
  port: number;
  allowedUsers: Set<string>;
}

export interface QQBotConfig {
  appId: string;
  clientSecret: string;
  sandbox: boolean;
  allowedUsers: Set<string>;
}

export interface MatrixConfig {
  homeserverUrl: string;
  accessToken: string;
  userId?: string;
  allowedUsers: Set<string>;
}

export interface MattermostConfig {
  baseUrl: string;
  botToken: string;
  allowedUsers: Set<string>;
}

export interface LineConfig {
  channelAccessToken: string;
  channelSecret: string;
  host: string;
  port: number;
  allowedUsers: Set<string>;
}

export interface IrcConfig {
  host: string;
  port: number;
  tls: boolean;
  nick: string;
  password?: string;
  channels: string[];
  allowedUsers: Set<string>;
}

export interface GatewayConfig {
  /** Global allowlist: photon phone/email entries, or `<channel>:<userId>` for other channels. */
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
  quotaWarnThreshold: number;
  dataDir: string;
  logLevel: LogLevel;

  /** Channel blocks: each present iff that channel's credentials are configured. */
  photon?: PhotonConfig;
  telegram?: TelegramConfig;
  discord?: DiscordConfig;
  slack?: SlackConfig;
  feishu?: FeishuConfig;
  dingtalk?: DingTalkConfig;
  onebot?: OneBotConfig;
  webhook?: WebhookConfig;
  wecom?: WeComConfig;
  qqbot?: QQBotConfig;
  matrix?: MatrixConfig;
  mattermost?: MattermostConfig;
  line?: LineConfig;
  irc?: IrcConfig;
}

export interface LoadConfigOptions {
  loadDotenv?: boolean;
  dotenvPath?: string;
}

/** Channels that are configured AND enabled (webhook additionally needs `enabled`). */
export function getEnabledChannelNames(config: GatewayConfig): ChannelName[] {
  return CHANNEL_NAMES.filter((name) => {
    if (name === "webhook") {
      return Boolean(config.webhook?.enabled);
    }
    return Boolean(config[name]);
  });
}

/** Per-channel allowlist (platform user ids, lowercased). Photon has no per-channel list. */
export function getChannelAllowedUsers(
  config: GatewayConfig,
  channel: string,
): ReadonlySet<string> {
  switch (channel) {
    case "telegram":
      return config.telegram?.allowedUsers ?? new Set();
    case "discord":
      return config.discord?.allowedUsers ?? new Set();
    case "slack":
      return config.slack?.allowedUsers ?? new Set();
    case "feishu":
      return config.feishu?.allowedUsers ?? new Set();
    case "dingtalk":
      return config.dingtalk?.allowedUsers ?? new Set();
    case "onebot":
      return config.onebot?.allowedUsers ?? new Set();
    case "webhook":
      return config.webhook?.allowedUsers ?? new Set();
    case "wecom":
      return config.wecom?.allowedUsers ?? new Set();
    case "qqbot":
      return config.qqbot?.allowedUsers ?? new Set();
    case "matrix":
      return config.matrix?.allowedUsers ?? new Set();
    case "mattermost":
      return config.mattermost?.allowedUsers ?? new Set();
    case "line":
      return config.line?.allowedUsers ?? new Set();
    case "irc":
      return config.irc?.allowedUsers ?? new Set();
    default:
      return new Set();
  }
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

  const spectrumId = cleanEnv(parsed.SPECTRUM_PROJECT_ID);
  const spectrumSecret = cleanEnv(parsed.SPECTRUM_PROJECT_SECRET);
  const photon: PhotonConfig | undefined =
    spectrumId && spectrumSecret
      ? {
          projectId: spectrumId,
          projectSecret: spectrumSecret,
          readReceipts: parseBoolEnv(parsed.PHOTON_READ_RECEIPTS, true),
          reactions: parseBoolEnv(parsed.PHOTON_REACTIONS, true),
        }
      : undefined;

  const telegramToken = cleanEnv(parsed.TELEGRAM_BOT_TOKEN);
  const discordToken = cleanEnv(parsed.DISCORD_BOT_TOKEN);
  const slackBot = cleanEnv(parsed.SLACK_BOT_TOKEN);
  const slackApp = cleanEnv(parsed.SLACK_APP_TOKEN);
  const feishuId = cleanEnv(parsed.FEISHU_APP_ID);
  const feishuSecret = cleanEnv(parsed.FEISHU_APP_SECRET);
  const dingId = cleanEnv(parsed.DINGTALK_CLIENT_ID);
  const dingSecret = cleanEnv(parsed.DINGTALK_CLIENT_SECRET);
  const onebotUrl = cleanEnv(parsed.ONEBOT_WS_URL);
  const wecomCorpId = cleanEnv(parsed.WECOM_CORP_ID);
  const wecomSecret = cleanEnv(parsed.WECOM_SECRET);
  const qqbotAppId = cleanEnv(parsed.QQBOT_APP_ID);
  const qqbotClientSecret = cleanEnv(parsed.QQBOT_CLIENT_SECRET);
  const matrixHomeserverUrl = cleanEnv(parsed.MATRIX_HOMESERVER_URL);
  const matrixAccessToken = cleanEnv(parsed.MATRIX_ACCESS_TOKEN);
  const mattermostBaseUrl = cleanEnv(parsed.MATTERMOST_BASE_URL);
  const mattermostBotToken = cleanEnv(parsed.MATTERMOST_BOT_TOKEN);
  const lineChannelAccessToken = cleanEnv(parsed.LINE_CHANNEL_ACCESS_TOKEN);
  const lineChannelSecret = cleanEnv(parsed.LINE_CHANNEL_SECRET);
  const ircHost = cleanEnv(parsed.IRC_HOST);

  if (onebotUrl && !/^wss?:\/\//i.test(onebotUrl)) {
    throw new Error("ONEBOT_WS_URL must start with ws:// or wss://");
  }

  const webhookTouched = [
    parsed.WEBHOOK_ENABLED,
    parsed.WEBHOOK_TOKEN,
    parsed.WEBHOOK_SECRET,
    parsed.WEBHOOK_CALLBACK_URL,
    parsed.WEBHOOK_ALLOWED_USERS,
  ].some((v) => cleanEnv(v) !== undefined);

  return {
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
    quotaWarnThreshold: parsed.QUOTA_WARN_THRESHOLD,
    dataDir,
    logLevel: parsed.LOG_LEVEL,

    photon,
    telegram: telegramToken
      ? {
          botToken: telegramToken,
          allowedUsers: parseAllowedUsers(parsed.TELEGRAM_ALLOWED_USERS),
          pollTimeoutSec: parsed.TELEGRAM_POLL_TIMEOUT_SEC,
        }
      : undefined,
    discord: discordToken
      ? {
          botToken: discordToken,
          allowedUsers: parseAllowedUsers(parsed.DISCORD_ALLOWED_USERS),
          allowGuilds: parseBoolEnv(parsed.DISCORD_ALLOW_GUILDS, false),
        }
      : undefined,
    slack:
      slackBot && slackApp
        ? {
            botToken: slackBot,
            appToken: slackApp,
            allowedUsers: parseAllowedUsers(parsed.SLACK_ALLOWED_USERS),
          }
        : undefined,
    feishu:
      feishuId && feishuSecret
        ? {
            appId: feishuId,
            appSecret: feishuSecret,
            domain: parsed.FEISHU_DOMAIN,
            allowedUsers: parseAllowedUsers(parsed.FEISHU_ALLOWED_USERS),
          }
        : undefined,
    dingtalk:
      dingId && dingSecret
        ? {
            clientId: dingId,
            clientSecret: dingSecret,
            allowedUsers: parseAllowedUsers(parsed.DINGTALK_ALLOWED_USERS),
          }
        : undefined,
    onebot: onebotUrl
      ? {
          wsUrl: onebotUrl,
          accessToken: cleanEnv(parsed.ONEBOT_ACCESS_TOKEN),
          selfId: cleanEnv(parsed.ONEBOT_SELF_ID),
          allowedUsers: parseAllowedUsers(parsed.ONEBOT_ALLOWED_USERS),
        }
      : undefined,
    webhook: webhookTouched
      ? {
          enabled: parseBoolEnv(parsed.WEBHOOK_ENABLED, false),
          host: cleanEnv(parsed.WEBHOOK_HOST) ?? "127.0.0.1",
          port: parsed.WEBHOOK_PORT,
          token: cleanEnv(parsed.WEBHOOK_TOKEN),
          secret: cleanEnv(parsed.WEBHOOK_SECRET),
          callbackUrl: cleanEnv(parsed.WEBHOOK_CALLBACK_URL),
          allowedUsers: parseAllowedUsers(parsed.WEBHOOK_ALLOWED_USERS),
        }
      : undefined,
    wecom:
      wecomCorpId && parsed.WECOM_AGENT_ID !== undefined && wecomSecret
        ? {
            corpId: wecomCorpId,
            agentId: parsed.WECOM_AGENT_ID,
            secret: wecomSecret,
            token: cleanEnv(parsed.WECOM_TOKEN),
            encodingAesKey: cleanEnv(parsed.WECOM_ENCODING_AES_KEY),
            host: cleanEnv(parsed.WECOM_HOST) ?? "127.0.0.1",
            port: parsed.WECOM_PORT,
            allowedUsers: parseAllowedUsers(parsed.WECOM_ALLOWED_USERS),
          }
        : undefined,
    qqbot:
      qqbotAppId && qqbotClientSecret
        ? {
            appId: qqbotAppId,
            clientSecret: qqbotClientSecret,
            sandbox: parseBoolEnv(parsed.QQBOT_SANDBOX, false),
            allowedUsers: parseAllowedUsers(parsed.QQBOT_ALLOWED_USERS),
          }
        : undefined,
    matrix:
      matrixHomeserverUrl && matrixAccessToken
        ? {
            homeserverUrl: matrixHomeserverUrl,
            accessToken: matrixAccessToken,
            userId: cleanEnv(parsed.MATRIX_USER_ID),
            allowedUsers: parseAllowedUsers(parsed.MATRIX_ALLOWED_USERS),
          }
        : undefined,
    mattermost:
      mattermostBaseUrl && mattermostBotToken
        ? {
            baseUrl: mattermostBaseUrl,
            botToken: mattermostBotToken,
            allowedUsers: parseAllowedUsers(parsed.MATTERMOST_ALLOWED_USERS),
          }
        : undefined,
    line:
      lineChannelAccessToken && lineChannelSecret
        ? {
            channelAccessToken: lineChannelAccessToken,
            channelSecret: lineChannelSecret,
            host: cleanEnv(parsed.LINE_HOST) ?? "127.0.0.1",
            port: parsed.LINE_PORT,
            allowedUsers: parseAllowedUsers(parsed.LINE_ALLOWED_USERS),
          }
        : undefined,
    irc: ircHost
      ? {
          host: ircHost,
          port: parsed.IRC_PORT,
          tls: parseBoolEnv(parsed.IRC_TLS, true),
          nick: cleanEnv(parsed.IRC_NICK) ?? "antigravity-bot",
          password: cleanEnv(parsed.IRC_PASSWORD),
          channels: parseListEnv(parsed.IRC_CHANNELS, []),
          allowedUsers: parseAllowedUsers(parsed.IRC_ALLOWED_USERS),
        }
      : undefined,
  };
}
