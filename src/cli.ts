#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import dotenv from "dotenv";
import { fetchAgyQuota, formatQuotaSummary } from "./acp/quota.js";
import { MultiChannelHub, qualifyChatId } from "./channels/hub.js";
import { createEnabledAdapters } from "./channels/registry.js";
import {
  CHANNEL_NAMES,
  getEnabledChannelNames,
  loadConfig,
  type ChannelName,
  type GatewayConfig,
} from "./config.js";
import { GatewayStore } from "./gateway/store.js";
import type { HealthSnapshot } from "./types.js";

const execFileAsync = promisify(execFile);

function printUsage(): void {
  console.log(`Antigravity Gateway Admin CLI

Usage:
  pnpm cli pair list              List pending pairing codes & approved senders
  pnpm cli pair approve <CODE>    Approve a pending 8-character pairing code
  pnpm cli pair revoke <sender>   Revoke an approved sender
  pnpm cli pair clear             Clear all pending pairing requests
  pnpm cli status                 Show live health endpoint + local store summary
  pnpm cli usage                  Check Antigravity quota (0 model tokens)
  pnpm cli doctor                 Run environment & connectivity diagnostics (lists all channels)
  pnpm cli send --channel <name> --to <chatId> <text>
                                  Send a one-off message through a configured channel
`);
}

function getSafeEnvPaths(): {
  dataDir: string;
  agyBin: string;
  healthEnabled: boolean;
  healthHost: string;
  healthPort: number;
  allowedCount: number;
  config?: GatewayConfig;
  enabledChannels: ChannelName[];
} {
  dotenv.config({ quiet: true });
  try {
    const cfg = loadConfig(process.env, { loadDotenv: false });
    return {
      dataDir: cfg.dataDir,
      agyBin: cfg.agyBin,
      healthEnabled: cfg.healthEnabled,
      healthHost: cfg.healthHost,
      healthPort: cfg.healthPort,
      allowedCount: cfg.allowedSenders.size,
      config: cfg,
      enabledChannels: getEnabledChannelNames(cfg),
    };
  } catch {
    const dataDir = process.env.DATA_DIR
      ? path.resolve(process.env.DATA_DIR)
      : path.resolve(process.cwd(), "data");
    return {
      dataDir,
      agyBin: process.env.AGY_BIN?.trim() || "agy",
      healthEnabled: ["1", "true", "yes", "on"].includes(
        (process.env.HEALTH_ENABLED ?? "").trim().toLowerCase(),
      ),
      healthHost: process.env.HEALTH_HOST?.trim() || "127.0.0.1",
      healthPort: Number.parseInt(process.env.HEALTH_PORT ?? "18790", 10) || 18790,
      allowedCount: (process.env.ALLOWED_SENDERS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean).length,
      enabledChannels: [],
    };
  }
}

async function fetchLiveStatus(
  host: string,
  port: number,
): Promise<HealthSnapshot | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(`http://${host}:${port}/status`, {
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

  const live = await fetchLiveStatus(info.healthHost, info.healthPort);
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

async function runDoctorCommand(): Promise<number> {
  const info = getSafeEnvPaths();
  let issues = 0;

  // 1. Node version
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (major >= 22) {
    console.log(`[OK] Node.js ${process.version}`);
  } else {
    console.log(`[FAIL] Node.js ${process.version} (requires >=22.0.0)`);
    issues++;
  }

  // 2. .env presence & required keys (no secret values printed!)
  const envExists = fs.existsSync(path.resolve(process.cwd(), ".env"));
  if (!envExists) {
    console.log("[WARN] .env file missing in workspace root (copy .env.example to .env)");
  }
  if (!info.config) {
    console.log("[FAIL] Configuration failed to load (check .env values)");
    issues++;
  }
  if (info.enabledChannels.length > 0) {
    console.log(`[OK] ${info.enabledChannels.length}/${CHANNEL_NAMES.length} channel(s) configured`);
  } else {
    console.log("[FAIL] No channels configured (set credentials for at least one channel)");
    issues++;
  }
  for (const name of CHANNEL_NAMES) {
    const enabled = info.enabledChannels.includes(name);
    const detail = enabled ? describeChannel(name, info.config) : channelHint(name);
    console.log(`  - ${name.padEnd(10)} ${enabled ? "configured" : "disabled  "}  ${detail}`);
  }

  // 3. agy --version
  try {
    const { stdout } = await execFileAsync(info.agyBin, ["--version"], {
      timeout: 10_000,
      windowsHide: true,
    });
    console.log(`[OK] ${info.agyBin} --version -> ${stdout.trim()}`);
  } catch (err) {
    console.log(
      `[FAIL] Unable to run '${info.agyBin} --version': ${err instanceof Error ? err.message : String(err)}`,
    );
    issues++;
  }

  // 4. Zero-token /usage check
  const quota = await fetchAgyQuota(info.agyBin, { forceRefresh: true });
  if (quota.available) {
    console.log(
      `[OK] agy /usage (0 tokens) -> 5h: ${quota.fiveHourRemainingPercent ?? "?"}%, Weekly: ${quota.weeklyRemainingPercent ?? "?"}%`,
    );
  } else if (process.env.GEMINI_API_KEY) {
    console.log(`[OK] GEMINI_API_KEY set (${quota.error ?? "quota endpoint disabled in API key mode"})`);
  } else {
    console.log(`[WARN] agy /usage unavailable: ${quota.error ?? "unknown"}`);
  }

  // 5. Allowlist & pairing
  const store = new GatewayStore(info.dataDir);
  await store.load();
  const pairedCount = store.listApprovedSenders().length;
  const pendingCount = store.listPendingPairings().length;
  if (info.allowedCount + pairedCount > 0) {
    console.log(
      `[OK] Access control: ${info.allowedCount} env allowlist + ${pairedCount} paired sender(s), ${pendingCount} pending`,
    );
  } else {
    console.log(
      `[WARN] Allowlist is empty (fail-closed; DMs will receive pairing codes, ${pendingCount} pending)`,
    );
  }

  // 6. Health port & PID lock
  if (info.healthEnabled) {
    const live = await fetchLiveStatus(info.healthHost, info.healthPort);
    if (live) {
      console.log(`[OK] Health server live at http://${info.healthHost}:${info.healthPort}/status`);
    } else {
      const free = await isPortAvailable(info.healthHost, info.healthPort);
      console.log(
        free
          ? `[OK] Health port ${info.healthHost}:${info.healthPort} is available`
          : `[WARN] Health port ${info.healthHost}:${info.healthPort} is already in use`,
      );
    }
  } else {
    console.log("[OK] Health endpoint disabled (HEALTH_ENABLED=false)");
  }

  const pidFile = path.join(info.dataDir, "gateway.pid");
  if (fs.existsSync(pidFile)) {
    const rawPid = fs.readFileSync(pidFile, "utf8").trim();
    console.log(`[INFO] PID lock file present (${pidFile}, pid=${rawPid})`);
  } else {
    console.log("[OK] No stale gateway.pid lock");
  }

  return issues === 0 ? 0 : 1;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = (args[0] ?? "help").toLowerCase();
  const info = getSafeEnvPaths();

  let exitCode = 0;
  switch (cmd) {
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
      exitCode = await runDoctorCommand();
      break;
    case "send":
      exitCode = await runSendCommand(args.slice(1));
      break;
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

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
