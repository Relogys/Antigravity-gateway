#!/usr/bin/env node
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import dotenv from "dotenv";
import { ZodError } from "zod";
import { AgyAcpClient } from "./acp/client.js";
import { fetchAgyQuota, formatQuotaSummary } from "./acp/quota.js";
import {
  exportGatewayBundle,
  importGatewayBundle,
  parseRemapRule,
  type PathRemapRule,
} from "./backup.js";
import { MultiChannelHub, qualifyChatId } from "./channels/hub.js";
import { createEnabledAdapters } from "./channels/registry.js";
import { isLoopbackHost } from "./channels/utils.js";
import {
  CHANNEL_NAMES,
  getEnabledChannelNames,
  loadConfig,
  type ChannelName,
  type GatewayConfig,
} from "./config.js";
import { GatewayStore } from "./gateway/store.js";
import { redactSecrets, tailLogFile } from "./logger.js";
import {
  formatPidPayload,
  isGatewayProcess,
  isPidAlive,
  parsePidContent,
  readPidFile,
  readPidMetadata,
  type PidMetadata,
} from "./pid.js";
import { resolveServicePaths, runServiceCommand } from "./service.js";
import type { HealthSnapshot } from "./types.js";
import { runSetupWizard } from "./wizard.js";

export {
  formatPidPayload,
  isGatewayProcess,
  isPidAlive,
  parsePidContent,
  readPidFile,
  readPidMetadata,
  type PidMetadata,
};

/** Format a config parsing failure into concise, secret-redacted field hints. */
export function formatConfigError(err: unknown): string {
  if (err instanceof ZodError) {
    return err.issues
      .map((issue) => {
        const key = issue.path.length > 0 ? issue.path.join(".") : "env";
        return `${key}: ${redactSecrets(issue.message)}`;
      })
      .join("; ");
  }
  return redactSecrets(err instanceof Error ? err.message : String(err));
}

const execFileAsync = promisify(execFile);

/** Repo root works for both `tsx src/cli.ts` and `node dist/cli.js`. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const STARTUP_PID_TIMEOUT_MS = 5_000;
const STOP_GRACEFUL_TIMEOUT_MS = 5_000;
const STOP_FORCE_TIMEOUT_MS = 3_000;
const CLI_DEFAULT_TAIL_LINES = 80;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await delay(100);
  }
  return !isPidAlive(pid);
}

function isDirWritable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export interface ResolveDaemonPathsOptions {
  logDir?: string;
  repoRoot?: string;
  isWritable?: (dir: string) => boolean;
}

export function resolveDaemonPaths(
  dataDir: string,
  options: ResolveDaemonPathsOptions = {},
): {
  pidFile: string;
  logFile: string;
  distEntry: string;
} {
  const repoRoot = options.repoRoot ? path.resolve(options.repoRoot) : REPO_ROOT;
  const checkWritable = options.isWritable ?? isDirWritable;

  let logDir: string;
  if (options.logDir?.trim()) {
    logDir = path.resolve(options.logDir.trim());
  } else {
    const insideNodeModules = /(^|[\\/])node_modules([\\/]|$)/i.test(repoRoot);
    const repoWritable = !insideNodeModules && checkWritable(repoRoot);
    logDir = repoWritable ? path.join(repoRoot, "logs") : path.join(dataDir, "logs");
  }

  return {
    pidFile: path.join(dataDir, "gateway.pid"),
    logFile: path.join(logDir, "gateway.log"),
    distEntry: path.join(repoRoot, "dist", "index.js"),
  };
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function printUsage(): void {
  console.log(`Antigravity Gateway Admin CLI

Usage:
  pnpm cli init [--yes] [--channels 1,2]
                                  Interactive first-time setup wizard (writes .env safely)
  pnpm cli setup                  Alias for 'pnpm cli init' (also: pnpm setup)
  pnpm cli start [--foreground]   Start the gateway (detached unless --foreground)
  pnpm cli stop                   Stop the running gateway (data/gateway.pid)
  pnpm cli restart                Restart the gateway (stop + start)
  pnpm cli logs [-n <lines>]      Tail gateway.log (default ${CLI_DEFAULT_TAIL_LINES} lines)
  pnpm cli service [install|uninstall|status|print]
                                  Manage native OS autostart (macOS launchd / Linux systemd / Windows Task)
  pnpm cli export [--out <file>] [--include-auth]
                                  Export secret-free backup bundle (sessions, loops, workspace bookmarks)
  pnpm cli import <file> [--dry-run] [--overwrite] [--include-auth] [--remap-cwd <from>=<to>]
                                  Import a backup bundle with optional preview and cross-OS path remapping
  pnpm cli status                 Show live health endpoint + local store summary
  pnpm cli doctor [--json] [--probe-acp]
                                  Run environment, security & connectivity diagnostics
  pnpm cli usage                  Check Antigravity quota (0 model tokens)
  pnpm cli pair list              List pending pairing codes & approved senders
  pnpm cli pair approve <CODE>    Approve a pending 8-character pairing code
  pnpm cli pair revoke <sender>   Revoke an approved sender
  pnpm cli pair clear             Clear all pending pairing requests
  pnpm cli send --channel <name> --to <chatId> <text>
                                  Send a one-off message through a configured channel
`);
}

function getSafeEnvPaths(): {
  dataDir: string;
  logDir?: string;
  agyBin: string;
  healthEnabled: boolean;
  healthHost: string;
  healthPort: number;
  healthToken?: string;
  allowedCount: number;
  config?: GatewayConfig;
  configError?: string;
  enabledChannels: ChannelName[];
} {
  dotenv.config({ quiet: true });
  try {
    const cfg = loadConfig(process.env, { loadDotenv: false });
    return {
      dataDir: cfg.dataDir,
      logDir: cfg.logDir,
      agyBin: cfg.agyBin,
      healthEnabled: cfg.healthEnabled,
      healthHost: cfg.healthHost,
      healthPort: cfg.healthPort,
      healthToken: cfg.healthToken,
      allowedCount: cfg.allowedSenders.size,
      config: cfg,
      enabledChannels: getEnabledChannelNames(cfg),
    };
  } catch (err) {
    const dataDir = process.env.DATA_DIR
      ? path.resolve(process.env.DATA_DIR)
      : path.resolve(process.cwd(), "data");
    const rawLogDir = process.env.LOG_DIR?.trim();
    const rawHealthToken = process.env.HEALTH_TOKEN?.trim();
    return {
      dataDir,
      logDir: rawLogDir ? path.resolve(rawLogDir) : undefined,
      agyBin: process.env.AGY_BIN?.trim() || "agy",
      healthEnabled: ["1", "true", "yes", "on"].includes(
        (process.env.HEALTH_ENABLED ?? "").trim().toLowerCase(),
      ),
      healthHost: process.env.HEALTH_HOST?.trim() || "127.0.0.1",
      healthPort: Number.parseInt(process.env.HEALTH_PORT ?? "18790", 10) || 18790,
      healthToken: rawHealthToken || undefined,
      allowedCount: (process.env.ALLOWED_SENDERS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean).length,
      configError: formatConfigError(err),
      enabledChannels: [],
    };
  }
}

async function fetchLiveStatus(
  host: string,
  port: number,
  token?: string,
): Promise<HealthSnapshot | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  const probeHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  try {
    const headers: Record<string, string> = {};
    if (token?.trim()) {
      headers.Authorization = `Bearer ${token.trim()}`;
    }
    const res = await fetch(`http://${probeHost}:${port}/status`, {
      headers,
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as HealthSnapshot;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function isPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, host);
  });
}

async function runPairCommand(args: string[], dataDir: string): Promise<number> {
  const sub = (args[0] ?? "").toLowerCase();
  const store = new GatewayStore(dataDir);
  await store.load();

  if (sub === "list") {
    const pending = store.listPendingPairings();
    const approved = store.listApprovedSenders();
    console.log(`Approved senders (${approved.length}):`);
    if (approved.length === 0) {
      console.log("  (none)");
    } else {
      for (const s of approved) {
        console.log(`  - ${s}`);
      }
    }
    console.log(`\nPending pairings (${pending.length}):`);
    if (pending.length === 0) {
      console.log("  (none)");
    } else {
      for (const p of pending) {
        const minsLeft = Math.max(
          0,
          Math.round((p.expiresAt - Date.now()) / 60_000),
        );
        console.log(`  - ${p.code} | ${p.senderId} | expires in ${minsLeft}m`);
      }
    }
    return 0;
  }

  if (sub === "approve") {
    const code = args[1];
    if (!code) {
      console.error("Usage: pnpm cli pair approve <CODE>");
      return 1;
    }
    const result = await store.approvePairing(code);
    if (result.ok) {
      console.log(`Approved sender: ${result.senderId}`);
      return 0;
    }
    if (result.reason === "locked") {
      const mins = Math.ceil((result.retryAfterMs ?? 0) / 60_000);
      console.error(`Pairing approval locked due to failed attempts. Retry in ${mins}m.`);
      return 1;
    }
    console.error(
      `Pairing approval failed (${result.reason}). Remaining attempts: ${result.remainingAttempts ?? "n/a"}`,
    );
    return 1;
  }

  if (sub === "revoke") {
    const sender = args[1];
    if (!sender) {
      console.error("Usage: pnpm cli pair revoke <sender>");
      return 1;
    }
    const removed = await store.revokeApprovedSender(sender);
    console.log(removed ? `Revoked sender: ${sender}` : `Sender not found: ${sender}`);
    return removed ? 0 : 1;
  }

  if (sub === "clear") {
    const cleared = await store.clearPendingPairings();
    console.log(`Cleared ${cleared} pending pairing(s).`);
    return 0;
  }

  printUsage();
  return 1;
}

async function runStatusCommand(): Promise<number> {
  const info = getSafeEnvPaths();
  const store = new GatewayStore(info.dataDir);
  await store.load();

  const live = await fetchLiveStatus(info.healthHost, info.healthPort, info.healthToken);
  if (live) {
    console.log("Live Gateway Status:");
    console.log(JSON.stringify(live, null, 2));
  } else {
    console.log(
      `Live Health Endpoint: unreachable at http://${info.healthHost}:${info.healthPort}/status` +
        (info.healthEnabled ? " (gateway may be stopped)" : " (HEALTH_ENABLED=false)"),
    );
  }

  console.log("\nPersisted Store Summary:");
  console.log(`  State file: ${store.stateFilePath}`);
  console.log(`  Sessions: ${store.listSessions().length}`);
  console.log(`  Approved paired senders: ${store.listApprovedSenders().length}`);
  console.log(`  Pending pairings: ${store.listPendingPairings().length}`);
  console.log(`  Loops/reminders: ${store.getLoops().length}`);
  return 0;
}

async function runUsageCommand(): Promise<number> {
  const info = getSafeEnvPaths();
  const summary = await fetchAgyQuota(info.agyBin, { forceRefresh: true });
  console.log(formatQuotaSummary(summary));
  return summary.available ? 0 : 1;
}

const CHANNEL_HINTS: Record<ChannelName, string> = {
  photon: "set SPECTRUM_PROJECT_ID + SPECTRUM_PROJECT_SECRET",
  telegram: "set TELEGRAM_BOT_TOKEN",
  discord: "set DISCORD_BOT_TOKEN",
  slack: "set SLACK_BOT_TOKEN + SLACK_APP_TOKEN",
  feishu: "set FEISHU_APP_ID + FEISHU_APP_SECRET",
  dingtalk: "set DINGTALK_CLIENT_ID + DINGTALK_CLIENT_SECRET",
  onebot: "set ONEBOT_WS_URL",
  webhook: "set WEBHOOK_ENABLED=true (+ WEBHOOK_TOKEN or WEBHOOK_SECRET)",
  wecom: "set WECOM_CORP_ID + WECOM_AGENT_ID + WECOM_SECRET",
  qqbot: "set QQBOT_APP_ID + QQBOT_CLIENT_SECRET",
  matrix: "set MATRIX_HOMESERVER_URL + MATRIX_ACCESS_TOKEN",
  mattermost: "set MATTERMOST_BASE_URL + MATTERMOST_BOT_TOKEN",
  line: "set LINE_CHANNEL_ACCESS_TOKEN + LINE_CHANNEL_SECRET",
  irc: "set IRC_HOST",
  whatsapp: "set WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID",
  zulip: "set ZULIP_SITE + ZULIP_BOT_EMAIL + ZULIP_API_KEY",
  rocketchat: "set ROCKETCHAT_URL + ROCKETCHAT_USER_ID + ROCKETCHAT_AUTH_TOKEN",
  signal: "set SIGNAL_API_URL + SIGNAL_ACCOUNT",
  teams: "set TEAMS_WEBHOOK_SECRET or TEAMS_APP_ID + TEAMS_APP_PASSWORD or TEAMS_INCOMING_WEBHOOK_URL",
  googlechat: "set GOOGLECHAT_WEBHOOK_URL or GOOGLECHAT_ACCESS_TOKEN or GOOGLECHAT_VERIFICATION_TOKEN",
};

function channelHint(name: ChannelName): string {
  return `(${CHANNEL_HINTS[name]})`;
}

/** Non-secret summary of a configured channel (never prints tokens/ids). */
function describeChannel(name: ChannelName, cfg?: GatewayConfig): string {
  if (!cfg) return "";
  switch (name) {
    case "photon":
      return `receipts=${cfg.photon?.readReceipts} reactions=${cfg.photon?.reactions}`;
    case "telegram":
      return `allowedUsers=${cfg.telegram?.allowedUsers.size} poll=${cfg.telegram?.pollTimeoutSec}s`;
    case "discord":
      return `allowedUsers=${cfg.discord?.allowedUsers.size} guilds=${cfg.discord?.allowGuilds}`;
    case "slack":
      return `allowedUsers=${cfg.slack?.allowedUsers.size} (socket mode)`;
    case "feishu":
      return `domain=${cfg.feishu?.domain} allowedUsers=${cfg.feishu?.allowedUsers.size}`;
    case "dingtalk":
      return `allowedUsers=${cfg.dingtalk?.allowedUsers.size} (stream mode)`;
    case "onebot":
      return `allowedUsers=${cfg.onebot?.allowedUsers.size} token=${cfg.onebot?.accessToken ? "set" : "none"}`;
    case "webhook": {
      const w = cfg.webhook;
      const auth = w?.token || w?.secret ? "auth=set" : "auth=NONE";
      return `${w?.host}:${w?.port} ${auth} allowedUsers=${w?.allowedUsers.size}`;
    }
    case "wecom":
      return `${cfg.wecom?.host}:${cfg.wecom?.port} allowedUsers=${cfg.wecom?.allowedUsers.size}`;
    case "qqbot":
      return `sandbox=${cfg.qqbot?.sandbox} allowedUsers=${cfg.qqbot?.allowedUsers.size}`;
    case "matrix":
      return `allowedUsers=${cfg.matrix?.allowedUsers.size}`;
    case "mattermost":
      return `allowedUsers=${cfg.mattermost?.allowedUsers.size}`;
    case "line":
      return `${cfg.line?.host}:${cfg.line?.port} allowedUsers=${cfg.line?.allowedUsers.size}`;
    case "irc":
      return `${cfg.irc?.host}:${cfg.irc?.port} tls=${cfg.irc?.tls} channels=${cfg.irc?.channels.length} allowedUsers=${cfg.irc?.allowedUsers.size}`;
    case "whatsapp":
      return `${cfg.whatsapp?.webhookHost}:${cfg.whatsapp?.webhookPort}${cfg.whatsapp?.webhookPath} api=${cfg.whatsapp?.apiVersion} allowedUsers=${cfg.whatsapp?.allowedUsers.size}`;
    case "zulip":
      return `streams=${cfg.zulip?.streams.length} mention=${cfg.zulip?.requireMention} allowedUsers=${cfg.zulip?.allowedUsers.size}`;
    case "rocketchat":
      return `mention=${cfg.rocketchat?.requireMention} allowedUsers=${cfg.rocketchat?.allowedUsers.size}`;
    case "signal":
      return `poll=${cfg.signal?.pollIntervalMs}ms allowedUsers=${cfg.signal?.allowedUsers.size}`;
    case "teams":
      return `${cfg.teams?.webhookHost}:${cfg.teams?.webhookPort}${cfg.teams?.webhookPath} allowedUsers=${cfg.teams?.allowedUsers.size}`;
    case "googlechat":
      return `${cfg.googlechat?.webhookHost}:${cfg.googlechat?.webhookPort}${cfg.googlechat?.webhookPath} allowedUsers=${cfg.googlechat?.allowedUsers.size}`;
  }
}

async function runSendCommand(args: string[]): Promise<number> {
  let channel: string | undefined;
  let to: string | undefined;
  const textParts: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--channel" || arg === "-c") {
      channel = args[++i];
    } else if (arg === "--to" || arg === "-t") {
      to = args[++i];
    } else {
      textParts.push(arg);
    }
  }
  const text = textParts.join(" ").trim();
  if (!channel || !to || !text) {
    console.error("Usage: pnpm cli send --channel <name> --to <chatId> <text>");
    console.error(`Channels: ${CHANNEL_NAMES.join(", ")}`);
    return 1;
  }
  if (!(CHANNEL_NAMES as readonly string[]).includes(channel)) {
    console.error(`Unknown channel "${channel}". Channels: ${CHANNEL_NAMES.join(", ")}`);
    return 1;
  }

  const info = getSafeEnvPaths();
  if (!info.config || !info.enabledChannels.includes(channel as ChannelName)) {
    console.error(`Channel "${channel}" is not configured/enabled (${CHANNEL_HINTS[channel as ChannelName]}).`);
    return 1;
  }

  const { adapters, errors } = await createEnabledAdapters(info.config, [channel]);
  if (adapters.length === 0) {
    console.error(`Channel "${channel}" unavailable: ${errors[channel as ChannelName] ?? "unknown error"}`);
    return 1;
  }

  const hub = new MultiChannelHub(adapters, { log: (m) => console.error(m) });
  try {
    await hub.start(() => {});
    const deadline = Date.now() + 15_000;
    while (!hub.isConnected() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const target = to.includes("::") ? to : qualifyChatId(channel, to);
    const result = await hub.sendMessage({ chatId: target, text, markdown: true });
    const id = result && "messageId" in result ? result.messageId : undefined;
    console.log(`Sent via ${channel}${id ? ` (message ${id})` : ""}.`);
    return 0;
  } catch (err) {
    console.error(`Send failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await hub.stop().catch(() => {});
  }
}

function formatDuration(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) {
    return null;
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function formatAge(ms: number): string {
  const duration = formatDuration(ms);
  return duration === null ? "unknown age" : `${duration} ago`;
}

async function runInitCommand(args: string[]): Promise<number> {
  let nonInteractive = false;
  let presetChannels: string[] | undefined;
  let envPath: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--non-interactive" || arg === "--yes" || arg === "-y") {
      nonInteractive = true;
    } else if (arg === "--channels" || arg === "--channel") {
      presetChannels = (args[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg === "--env") {
      envPath = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      return 0;
    } else {
      console.error(`Unknown init option: ${arg}`);
      return 1;
    }
  }

  await runSetupWizard({ nonInteractive, presetChannels, envPath });
  return 0;
}

interface DoctorCheckItem {
  name: string;
  status: "ok" | "warn" | "fail" | "info";
  detail: string;
}

async function runDoctorCommand(args: string[] = []): Promise<number> {
  const jsonOutput = args.includes("--json");
  const probeAcp = args.includes("--probe-acp");
  const info = getSafeEnvPaths();
  let issues = 0;
  const hints = new Set<string>();
  const checks: DoctorCheckItem[] = [];
  const report = (
    name: string,
    status: DoctorCheckItem["status"],
    detail: string,
    printLine?: string,
  ) => {
    checks.push({ name, status, detail });
    if (status === "fail") {
      issues += 1;
    }
    if (!jsonOutput) {
      console.log(printLine ?? `[${status.toUpperCase()}] ${detail}`);
    }
  };

  // 1. Node version
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (major >= 22) {
    report("node", "ok", `Node.js ${process.version}`);
  } else {
    report("node", "fail", `Node.js ${process.version} (requires >=22.0.0)`);
    hints.add("Install Node.js >=22: https://nodejs.org/en/download");
  }

  // 2. .env presence & required keys (no secret values printed!)
  const envPath = path.resolve(process.cwd(), ".env");
  const envExists = fs.existsSync(envPath);
  if (!envExists) {
    report("dotenv", "warn", `.env file missing in workspace root (${envPath})`);
    hints.add("Run 'pnpm setup' (or 'pnpm cli init') for interactive setup");
  }
  if (!info.config) {
    const errDetail = info.configError
      ? `Configuration failed to load: ${info.configError}`
      : "Configuration failed to load (check .env values)";
    report("config", "fail", errDetail);
    hints.add("Fix invalid values in .env, or re-run 'pnpm setup' to regenerate it");
  }
  if (info.enabledChannels.length > 0) {
    report(
      "channels",
      "ok",
      `${info.enabledChannels.length}/${CHANNEL_NAMES.length} channel(s) configured (${info.enabledChannels.join(", ")})`,
      `[OK] ${info.enabledChannels.length}/${CHANNEL_NAMES.length} channel(s) configured`,
    );
  } else {
    report(
      "channels",
      "fail",
      "No channels configured (set credentials for at least one channel)",
    );
    hints.add("Run 'pnpm setup' and choose at least one channel (e.g. Photon or Telegram)");
  }
  if (!jsonOutput) {
    for (const name of CHANNEL_NAMES) {
      const enabled = info.enabledChannels.includes(name);
      const detail = enabled ? describeChannel(name, info.config) : channelHint(name);
      console.log(`  - ${name.padEnd(10)} ${enabled ? "configured" : "disabled  "}  ${detail}`);
    }
  }

  // 3. agy --version (+ optional live ACP handshake probe)
  try {
    const { stdout } = await execFileAsync(info.agyBin, ["--version"], {
      timeout: 10_000,
      windowsHide: true,
    });
    report("agy", "ok", `${info.agyBin} --version -> ${stdout.trim()}`);
  } catch (err) {
    report(
      "agy",
      "fail",
      `Unable to run '${info.agyBin} --version': ${redactSecrets(err instanceof Error ? err.message : String(err))}`,
    );
    hints.add(
      "Install the Antigravity CLI (agy): https://antigravity.google/docs/getting-started (then re-run 'pnpm cli doctor')",
    );
  }

  if (probeAcp) {
    const client = new AgyAcpClient({
      agyBin: info.agyBin,
      defaultCwd: info.config?.defaultCwd ?? process.cwd(),
      approvalMode: info.config?.approvalMode ?? "interactive",
      geminiApiKey: info.config?.geminiApiKey,
      passthroughEnv: info.config?.agyPassthroughEnv,
    });
    try {
      await client.ensureStarted();
      const initRes = client.getInitializeResult();
      const agentName = initRes?.agentInfo?.name ?? "agy";
      const agentVersion = initRes?.agentInfo?.version ?? "unknown";
      report("acp_probe", "ok", `ACP handshake succeeded (${agentName} ${agentVersion})`);
    } catch (err) {
      report(
        "acp_probe",
        "fail",
        `ACP handshake failed: ${redactSecrets(err instanceof Error ? err.message : String(err))}`,
      );
      hints.add("Run 'agy' interactively once to confirm login, then re-run 'pnpm cli doctor --probe-acp'");
    } finally {
      await client.stop().catch(() => {});
    }
  }

  // 4. Zero-token /usage check
  const quota = await fetchAgyQuota(info.agyBin, { forceRefresh: true });
  if (quota.available) {
    report(
      "quota",
      "ok",
      `agy /usage (0 tokens) -> 5h: ${quota.fiveHourRemainingPercent ?? "?"}%, Weekly: ${quota.weeklyRemainingPercent ?? "?"}%`,
    );
  } else if (process.env.GEMINI_API_KEY) {
    report(
      "quota",
      "ok",
      `GEMINI_API_KEY set (${quota.error ?? "quota endpoint disabled in API key mode"})`,
    );
  } else {
    report("quota", "warn", `agy /usage unavailable: ${quota.error ?? "unknown"}`);
    hints.add("Sign in to agy ('agy' then choose a login method), or run 'pnpm cli usage' to re-check");
  }

  // 5. Allowlist & pairing
  const store = new GatewayStore(info.dataDir);
  await store.load();
  const pairedCount = store.listApprovedSenders().length;
  const pendingCount = store.listPendingPairings().length;
  if (info.allowedCount + pairedCount > 0) {
    report(
      "access_control",
      "ok",
      `Access control: ${info.allowedCount} env allowlist + ${pairedCount} paired sender(s), ${pendingCount} pending`,
    );
  } else {
    report(
      "access_control",
      "warn",
      `Allowlist is empty (fail-closed; DMs will receive pairing codes, ${pendingCount} pending)`,
    );
    hints.add(
      "Approve a sender with 'pnpm cli pair list' + 'pnpm cli pair approve <CODE>', or set ALLOWED_SENDERS in .env",
    );
  }

  // 6. Health server, live status, security posture, and per-channel state
  if (info.healthEnabled) {
    if (!isLoopbackHost(info.healthHost) && !info.healthToken) {
      report(
        "health_security",
        "warn",
        `Health endpoint listens on non-loopback host (${info.healthHost}) without HEALTH_TOKEN`,
      );
      hints.add("Set HEALTH_TOKEN in .env (or bind HEALTH_HOST=127.0.0.1) to protect /status and /metrics");
    }
    const live = await fetchLiveStatus(info.healthHost, info.healthPort, info.healthToken);
    if (live) {
      report(
        "health_server",
        "ok",
        `Health server live at http://${info.healthHost}:${info.healthPort}/status (uptime ${formatDuration(live.uptimeMs) ?? "unknown"})`,
      );
      const channelEntries = Object.entries(live.channels ?? {});
      let anyDisconnected = false;
      if (channelEntries.length > 0 && !jsonOutput) {
        console.log("  Live channel state:");
      }
      for (const [name, status] of channelEntries) {
        const parts: string[] = [status.connected ? "connected" : "disconnected"];
        if (typeof status.lastHeartbeatAt === "number") {
          parts.push(`heartbeat ${formatAge(Date.now() - status.lastHeartbeatAt)}`);
        }
        if (status.lastError) {
          parts.push(`error: ${status.lastError}`);
        }
        if (!jsonOutput) {
          console.log(
            `    ${status.connected ? "[OK]  " : "[WARN]"} ${name.padEnd(12)} ${parts.join(" | ")}`,
          );
        }
        if (!status.connected) {
          anyDisconnected = true;
        }
      }
      if (anyDisconnected) {
        hints.add("Inspect channel connection errors with 'pnpm cli logs'");
      }
      if (live.lastError) {
        report("gateway_error", "warn", `Gateway reported: ${live.lastError}`);
        hints.add("Review the error above and run 'pnpm cli logs'");
      }
    } else {
      const free = await isPortAvailable(info.healthHost, info.healthPort);
      if (free) {
        report(
          "health_server",
          "ok",
          `Health endpoint configured on http://${info.healthHost}:${info.healthPort}/status (gateway not running)`,
        );
      } else {
        report(
          "health_server",
          "warn",
          `Health port ${info.healthHost}:${info.healthPort} is in use but /status is unreachable`,
        );
        hints.add("Stop the process using the health port, verify HEALTH_TOKEN, or change HEALTH_PORT in .env");
      }
    }
  } else {
    report("health_server", "ok", "Health endpoint disabled (HEALTH_ENABLED=false)");
    hints.add("Set HEALTH_ENABLED=true in .env to use 'pnpm cli status' and '/metrics'");
  }

  // 7. Build artifact, daemon PID & native OS service
  const paths = resolveDaemonPaths(info.dataDir, { logDir: info.logDir });
  if (!fs.existsSync(paths.distEntry)) {
    report("build", "warn", `Built entry point missing (${paths.distEntry})`);
    hints.add("Run 'pnpm build' before starting the background daemon");
  }

  const pidMeta = readPidMetadata(paths.pidFile);
  if (pidMeta !== null && (await isGatewayProcess(pidMeta))) {
    report("daemon", "ok", `Background gateway running (PID ${pidMeta.pid}, ${paths.pidFile})`);
  } else if (pidMeta !== null && isPidAlive(pidMeta.pid)) {
    report(
      "daemon",
      "warn",
      `Stale gateway.pid (PID ${pidMeta.pid} belongs to another process)`,
    );
    hints.add("Run 'pnpm cli stop' to safely clear the stale PID file");
  } else if (pidMeta !== null) {
    report("daemon", "warn", `Stale gateway.pid (PID ${pidMeta.pid} is not alive)`);
    hints.add("Run 'pnpm cli stop' to clear the stale PID file, then 'pnpm cli start'");
  } else if (fs.existsSync(paths.pidFile)) {
    report("daemon", "warn", `Invalid gateway.pid contents (${paths.pidFile})`);
    hints.add("Run 'pnpm cli stop' to clean up the PID file");
  } else {
    report(
      "daemon",
      "info",
      "Background gateway stopped (no data/gateway.pid)",
      "[INFO] Background gateway stopped (no data/gateway.pid)\n       Run 'pnpm cli start' to start background gateway",
    );
  }

  const svc = resolveServicePaths(process.platform, os.homedir(), REPO_ROOT);
  if (svc.kind === "launchd" || svc.kind === "systemd") {
    const installed = fs.existsSync(svc.serviceFile);
    report(
      "service",
      "info",
      `${svc.kind} autostart service: ${installed ? "installed" : "not installed"} (${svc.serviceFile})`,
    );
  }

  if (jsonOutput) {
    console.log(
      JSON.stringify(
        {
          ok: issues === 0,
          issues,
          platform: process.platform,
          nodeVersion: process.version,
          enabledChannels: info.enabledChannels,
          checks,
          hints: [...hints],
        },
        null,
        2,
      ),
    );
  } else if (hints.size > 0) {
    console.log("\nSuggested fixes:");
    for (const hint of hints) {
      console.log(`  - ${hint}`);
    }
  }

  return issues === 0 ? 0 : 1;
}

async function runExportCommand(args: string[], dataDir: string): Promise<number> {
  let outPath: string | undefined;
  let includeAuth = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--out" || arg === "-o") {
      outPath = args[++i];
    } else if (arg.startsWith("--out=")) {
      outPath = arg.slice("--out=".length);
    } else if (arg === "--include-auth") {
      includeAuth = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: pnpm cli export [--out <file.json>] [--include-auth]");
      return 0;
    } else {
      console.error(`Unknown export option: ${arg}`);
      return 1;
    }
  }

  const store = new GatewayStore(dataDir);
  await store.load();
  const bundle = exportGatewayBundle(store, { includeAuth });
  const json = `${JSON.stringify(bundle, null, 2)}\n`;

  if (outPath) {
    const resolved = path.resolve(outPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, json, "utf8");
    console.log(
      `Exported ${bundle.sessions.length} session(s), ${bundle.loops.length} loop(s), ${Object.keys(bundle.workspaces).length} workspace bookmark(s) -> ${resolved}`,
    );
  } else {
    process.stdout.write(json);
  }
  return 0;
}

async function runImportCommand(args: string[], dataDir: string): Promise<number> {
  let inputFile: string | undefined;
  let dryRun = false;
  let overwrite = false;
  let includeAuth = false;
  const remapCwd: PathRemapRule[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--dry-run" || arg === "-n") {
      dryRun = true;
    } else if (arg === "--overwrite") {
      overwrite = true;
    } else if (arg === "--include-auth") {
      includeAuth = true;
    } else if (arg === "--remap-cwd") {
      const rule = parseRemapRule(args[++i] ?? "");
      if (!rule) {
        console.error("Invalid --remap-cwd value; expected <from>=<to>");
        return 1;
      }
      remapCwd.push(rule);
    } else if (arg.startsWith("--remap-cwd=")) {
      const rule = parseRemapRule(arg.slice("--remap-cwd=".length));
      if (!rule) {
        console.error("Invalid --remap-cwd value; expected <from>=<to>");
        return 1;
      }
      remapCwd.push(rule);
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: pnpm cli import <file.json> [--dry-run] [--overwrite] [--include-auth] [--remap-cwd <from>=<to>]",
      );
      return 0;
    } else if (!arg.startsWith("-") && !inputFile) {
      inputFile = arg;
    } else {
      console.error(`Unknown import argument: ${arg}`);
      return 1;
    }
  }

  if (!inputFile) {
    console.error("Usage: pnpm cli import <file.json> [--dry-run] [--overwrite] [--remap-cwd <from>=<to>]");
    return 1;
  }

  const resolved = path.resolve(inputFile);
  if (!fs.existsSync(resolved)) {
    console.error(`Backup file not found: ${resolved}`);
    return 1;
  }

  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8")) as unknown;
  const store = new GatewayStore(dataDir);
  await store.load();
  const summary = await importGatewayBundle(store, parsed, {
    dryRun,
    overwrite,
    includeAuth,
    remapCwd,
  });

  console.log(
    `${summary.dryRun ? "[DRY RUN] " : ""}Import summary (${resolved}):\n` +
      `  Sessions:   +${summary.sessionsAdded} added, ${summary.sessionsUpdated} updated, ${summary.sessionsSkipped} skipped\n` +
      `  Loops:      +${summary.loopsAdded} added, ${summary.loopsUpdated} updated, ${summary.loopsSkipped} skipped\n` +
      `  Workspaces: ${summary.workspacesImported} imported\n` +
      `  Paths remapped: ${summary.pathsRemapped}` +
      (includeAuth ? `\n  Approved senders added: ${summary.approvedSendersAdded}` : ""),
  );
  return 0;
}

async function runStartCommand(
  rest: string[],
  dataDir: string,
  logDir?: string,
): Promise<number> {
  const foreground = rest.includes("--foreground") || rest.includes("-f");
  const paths = resolveDaemonPaths(dataDir, { logDir });

  const existingMeta = readPidMetadata(paths.pidFile);
  if (existingMeta !== null && (await isGatewayProcess(existingMeta))) {
    console.log(`Gateway is already running (PID ${existingMeta.pid}).`);
    console.log(`Log file: ${paths.logFile}`);
    return 0;
  }
  if (existingMeta !== null || fs.existsSync(paths.pidFile)) {
    fs.rmSync(paths.pidFile, { force: true });
  }

  if (!fs.existsSync(paths.distEntry)) {
    console.error(`Built entry point not found: ${paths.distEntry}`);
    console.error("Build the gateway first: pnpm build");
    return 1;
  }

  if (foreground) {
    console.log(`Starting gateway in foreground (${paths.distEntry}). Press Ctrl+C to stop.`);
    return await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, [paths.distEntry], {
        cwd: REPO_ROOT,
        stdio: "inherit",
      });
      child.on("error", (err) => {
        console.error(`Failed to launch gateway: ${err.message}`);
        resolve(1);
      });
      child.on("exit", (code, signal) => {
        if (signal) {
          console.log(`Gateway exited after signal ${signal}.`);
        }
        resolve(code ?? 1);
      });
    });
  }

  fs.mkdirSync(path.dirname(paths.logFile), { recursive: true });
  fs.appendFileSync(
    paths.logFile,
    `${new Date().toISOString()} [cli] starting gateway in background\n`,
    "utf8",
  );

  const logFd = fs.openSync(paths.logFile, "a");
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [paths.distEntry], {
      cwd: REPO_ROOT,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
    });
  } finally {
    fs.closeSync(logFd);
  }

  const state: {
    error: Error | null;
    exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  } = { error: null, exit: null };
  child.on("error", (err) => {
    state.error = err;
  });
  child.on("exit", (code, signal) => {
    state.exit = { code, signal };
  });
  child.unref();

  const deadline = Date.now() + STARTUP_PID_TIMEOUT_MS;
  let runningPid: number | null = null;
  while (Date.now() < deadline) {
    if (state.error !== null || state.exit !== null) {
      break;
    }
    const pidFromFile = readPidFile(paths.pidFile);
    if (pidFromFile !== null && isPidAlive(pidFromFile)) {
      runningPid = pidFromFile;
      break;
    }
    await delay(100);
  }

  if (runningPid !== null) {
    console.log(`Gateway started in background (PID ${runningPid}).`);
    console.log(`Log file: ${paths.logFile}`);
    console.log("Stop with: pnpm cli stop");
    return 0;
  }
  if (state.error !== null) {
    console.error(`Failed to launch gateway: ${state.error.message}`);
    return 1;
  }
  if (state.exit !== null) {
    const { code, signal } = state.exit;
    console.error(
      `Gateway exited during startup (code=${code === null ? "null" : code}${signal ? `, signal=${signal}` : ""}).`,
    );
    const tail = tailLogFile(paths.logFile, 20);
    if (tail) {
      console.error(`--- ${paths.logFile} (tail) ---`);
      console.error(tail);
    }
    return 1;
  }
  console.error(
    `Gateway process launched (PID ${child.pid ?? "unknown"}) but ${paths.pidFile} did not appear within ${STARTUP_PID_TIMEOUT_MS / 1000}s.`,
  );
  const tail = tailLogFile(paths.logFile, 20);
  if (tail) {
    console.error(`--- ${paths.logFile} (tail) ---`);
    console.error(tail);
  }
  console.error(`Log file: ${paths.logFile}`);
  return 1;
}

async function runStopCommand(dataDir: string, logDir?: string): Promise<number> {
  const paths = resolveDaemonPaths(dataDir, { logDir });
  const meta = readPidMetadata(paths.pidFile);

  if (meta === null) {
    if (fs.existsSync(paths.pidFile)) {
      fs.rmSync(paths.pidFile, { force: true });
      console.log("Removed invalid gateway.pid; gateway is not running.");
    } else {
      console.log("Gateway is not running (no PID file).");
    }
    return 0;
  }

  const { pid } = meta;

  if (!isPidAlive(pid)) {
    fs.rmSync(paths.pidFile, { force: true });
    console.log(`Removed stale PID file (PID ${pid} is not running). Gateway is stopped.`);
    return 0;
  }

  if (!(await isGatewayProcess(meta))) {
    fs.rmSync(paths.pidFile, { force: true });
    console.log(
      `Removed stale PID file (PID ${pid} belongs to an unrelated process; refused to signal it).`,
    );
    return 0;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
      console.error(
        `Failed to signal PID ${pid}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }
  }

  let exited = await waitForProcessExit(pid, STOP_GRACEFUL_TIMEOUT_MS);
  if (!exited && process.platform === "win32") {
    try {
      await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
      });
    } catch {
      // taskkill reports failure if the process already exited; the wait decides.
    }
    exited = await waitForProcessExit(pid, STOP_FORCE_TIMEOUT_MS);
  }

  if (!exited) {
    console.error(`Gateway (PID ${pid}) did not exit; leaving ${paths.pidFile} in place.`);
    return 1;
  }

  // On Windows, `process.kill(pid, "SIGTERM")` terminates immediately without running
  // JS SIGTERM handlers, so write `.clean_shutdown` here to avoid a false crash notice.
  if (process.platform === "win32") {
    try {
      fs.writeFileSync(
        path.join(dataDir, ".clean_shutdown"),
        `${new Date().toISOString()}\n`,
        "utf8",
      );
    } catch {
      // Best-effort sentinel write.
    }
  }

  fs.rmSync(paths.pidFile, { force: true });
  console.log(`Gateway stopped (PID ${pid}).`);
  return 0;
}

async function runRestartCommand(
  rest: string[],
  dataDir: string,
  logDir?: string,
): Promise<number> {
  const stopCode = await runStopCommand(dataDir, logDir);
  if (stopCode !== 0) {
    return stopCode;
  }
  return await runStartCommand(rest, dataDir, logDir);
}

function parseTailLines(args: string[]): number {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    const value =
      arg === "-n" || arg === "--lines" || arg === "--tail"
        ? args[i + 1]
        : arg.startsWith("-n=")
          ? arg.slice(3)
          : undefined;
    if (value === undefined) {
      continue;
    }
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return CLI_DEFAULT_TAIL_LINES;
}

function runLogsCommand(args: string[], dataDir: string, logDir?: string): number {
  const paths = resolveDaemonPaths(dataDir, { logDir });
  const content = tailLogFile(paths.logFile, parseTailLines(args));
  if (!content) {
    console.log(`No log output at ${paths.logFile} yet.`);
    return 0;
  }
  console.log(content);
  return 0;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = (args[0] ?? "help").toLowerCase();
  const info = getSafeEnvPaths();

  let exitCode = 0;
  switch (cmd) {
    case "init":
    case "setup":
      exitCode = await runInitCommand(args.slice(1));
      break;
    case "pair":
      exitCode = await runPairCommand(args.slice(1), info.dataDir);
      break;
    case "status":
      exitCode = await runStatusCommand();
      break;
    case "usage":
      exitCode = await runUsageCommand();
      break;
    case "doctor":
      exitCode = await runDoctorCommand(args.slice(1));
      break;
    case "export":
      exitCode = await runExportCommand(args.slice(1), info.dataDir);
      break;
    case "import":
      exitCode = await runImportCommand(args.slice(1), info.dataDir);
      break;
    case "send":
      exitCode = await runSendCommand(args.slice(1));
      break;
    case "start":
      exitCode = await runStartCommand(args.slice(1), info.dataDir, info.logDir);
      break;
    case "stop":
      exitCode = await runStopCommand(info.dataDir, info.logDir);
      break;
    case "restart":
      exitCode = await runRestartCommand(args.slice(1), info.dataDir, info.logDir);
      break;
    case "logs":
      exitCode = runLogsCommand(args.slice(1), info.dataDir, info.logDir);
      break;
    case "service": {
      const paths = resolveDaemonPaths(info.dataDir, { logDir: info.logDir });
      exitCode = await runServiceCommand(args.slice(1), {
        repoRoot: REPO_ROOT,
        distEntry: paths.distEntry,
        dataDir: info.dataDir,
        logFile: paths.logFile,
        logDir: info.logDir,
      });
      break;
    }
    case "help":
    case "--help":
    case "-h":
      printUsage();
      exitCode = 0;
      break;
    default:
      console.error(`Unknown CLI command: ${cmd}\n`);
      printUsage();
      exitCode = 1;
  }

  process.exitCode = exitCode;
}

if (isMainModule()) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
