import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { AgyAgentBackend } from "./acp/sessions.js";
import { createConversationSyncFromEnv } from "./acp/conversation-sync.js";
import { MultiChannelHub } from "./channels/hub.js";
import { createEnabledAdapters } from "./channels/registry.js";
import { getEnabledChannelNames, loadConfig } from "./config.js";
import { GatewayRouter } from "./gateway/router.js";
import { LoopScheduler } from "./gateway/scheduler.js";
import { GatewayStore } from "./gateway/store.js";
import { HealthServer } from "./health.js";
import { redactSecrets } from "./logger.js";
import {
  formatPidPayload,
  isGatewayProcess,
  parsePidContent,
  readPidFile,
} from "./pid.js";
import type { PendingPermission } from "./types.js";

const CLEAN_SHUTDOWN_SENTINEL = ".clean_shutdown";

async function acquirePidLock(dataDir: string): Promise<string> {
  await fsp.mkdir(dataDir, { recursive: true });
  const pidPath = path.join(dataDir, "gateway.pid");

  if (fs.existsSync(pidPath)) {
    const raw = await fsp.readFile(pidPath, "utf8").catch(() => "");
    const existing = parsePidContent(raw);
    if (
      existing &&
      existing.pid !== process.pid &&
      (await isGatewayProcess(existing))
    ) {
      throw new Error(
        `Antigravity gateway is already running (PID ${existing.pid}). Lock: ${pidPath}`,
      );
    }
    await fsp.rm(pidPath, { force: true }).catch(() => {});
  }

  await fsp.writeFile(pidPath, formatPidPayload(process.pid, process.argv[1]), {
    encoding: "utf8",
    flag: "wx",
  });
  return pidPath;
}

async function releasePidLock(pidPath: string | null): Promise<void> {
  if (!pidPath) {
    return;
  }
  try {
    if (readPidFile(pidPath) === process.pid) {
      await fsp.rm(pidPath, { force: true });
    }
  } catch {
    // Ignore if already removed
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const burstDebounceMs = config.ingressDebounceMs;
  const cleanShutdownPath = path.join(config.dataDir, CLEAN_SHUTDOWN_SENTINEL);
  const pidPath = await acquirePidLock(config.dataDir);

  let router: GatewayRouter | undefined;
  let healthServer: HealthServer | undefined;
  let scheduler: LoopScheduler | undefined;
  let channel: MultiChannelHub | undefined;
  let backend: AgyAgentBackend | undefined;
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[gateway] Received ${signal}; shutting down...`);

    if (signal === "SIGINT" || signal === "SIGTERM") {
      router?.stop();
      await fsp
        .writeFile(cleanShutdownPath, `${new Date().toISOString()}\n`, "utf8")
        .catch(() => {});
    }
    scheduler?.stop();
    await channel?.stop().catch(() => {});
    await backend?.stop().catch(() => {});
    await healthServer?.stop().catch(() => {});
    await releasePidLock(pidPath);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT").then(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM").then(() => process.exit(0));
  });

  try {
    const store = new GatewayStore(config.dataDir);
    await store.load();

    const previousHomeChatId = store.getHomeChatId();
    // A known home chat without the sentinel means the last run never shut down cleanly.
    const recoveredFromUncleanShutdown =
      Boolean(previousHomeChatId) && !fs.existsSync(cleanShutdownPath);

    const { adapters, errors } = await createEnabledAdapters(config);
    for (const [name, reason] of Object.entries(errors)) {
      console.error(`[gateway] Channel "${name}" is configured but unavailable: ${reason}`);
    }
    if (adapters.length === 0) {
      throw new Error(
        `No channels available (configured: ${getEnabledChannelNames(config).join(", ") || "none"}). ` +
          "Set credentials for at least one channel in .env (see .env.example).",
      );
    }
    if (previousHomeChatId) {
      const photonAdapter = adapters.find((a) => a.name === "photon") as
        | { seedProbeSpaceId?: (spaceId: string) => void }
        | undefined;
      if (photonAdapter?.seedProbeSpaceId) {
        if (previousHomeChatId.startsWith("photon::")) {
          photonAdapter.seedProbeSpaceId(previousHomeChatId.slice("photon::".length));
        } else if (!previousHomeChatId.includes("::")) {
          photonAdapter.seedProbeSpaceId(previousHomeChatId);
        }
      }
    }
    channel = new MultiChannelHub(adapters, {
      // Unqualified legacy chat ids (pre-hub stores) belong to the iMessage channel.
      defaultChannel: config.photon ? "photon" : undefined,
    });
    if (config.autoBootstrapChannelSession) {
      for (const name of channel.listChannelNames()) {
        const bound = await store.ensureChannelBinding(name);
        if (bound.isNew) {
          console.log(
            `[gateway] Bound new channel session group [${bound.record.groupName}]`,
          );
        }
      }
    }
    backend = new AgyAgentBackend(config, {
      permissionNotifier: async (chatId: string, perm: PendingPermission) => {
        await router?.notifyPermission(chatId, perm);
      },
    });
    scheduler = new LoopScheduler({ store, channel });
    router = new GatewayRouter({
      config,
      channel,
      backend,
      store,
      scheduler,
      burstDebounceMs,
      conversationSync: createConversationSyncFromEnv(),
    });

    if (config.healthEnabled) {
      healthServer = new HealthServer(config, () => router!.getHealthSnapshot());
      await healthServer.start();
      console.log(
        `[gateway] Health endpoint listening on http://${config.healthHost}:${config.healthPort}/healthz`,
      );
    }

    await backend.start();
    scheduler.start();
    await channel.start((msg) => router!.handleInbound(msg));
    router.markReady();

    // Startup succeeded: clear any stale sentinel and tell the home chat we recovered.
    await fsp.rm(cleanShutdownPath, { force: true }).catch(() => {});
    if (recoveredFromUncleanShutdown && previousHomeChatId) {
      await channel
        .sendMessage({
          chatId: previousHomeChatId,
          text: `♻️ Antigravity Gateway recovered after unexpected restart (channels: ${channel.listChannelNames().join(", ")}).`,
          markdown: true,
        })
        .catch(() => {});
      console.log(
        `[gateway] Sent unclean-restart recovery notice to ${previousHomeChatId}`,
      );
    }

    console.log(
      `[gateway] Antigravity gateway started (channels=${channel.listChannelNames().join(",")}, approval=${config.approvalMode}, allowlist=${config.allowedSenders.size}, paired=${store.listApprovedSenders().length})`,
    );
  } catch (err) {
    await shutdown("startup-error");
    throw err;
  }
}

main().catch((err) => {
  console.error("[gateway] Fatal error:", redactSecrets(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
