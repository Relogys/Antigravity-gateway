import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { AgyAgentBackend } from "./acp/sessions.js";
import { loadConfig } from "./config.js";
import { GatewayRouter } from "./gateway/router.js";
import { LoopScheduler } from "./gateway/scheduler.js";
import { GatewayStore } from "./gateway/store.js";
import { HealthServer } from "./health.js";
import { PhotonChannelAdapter } from "./photon/adapter.js";
import type { PendingPermission } from "./types.js";

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

async function acquirePidLock(dataDir: string): Promise<string> {
  await fsp.mkdir(dataDir, { recursive: true });
  const pidPath = path.join(dataDir, "gateway.pid");

  if (fs.existsSync(pidPath)) {
    const raw = (await fsp.readFile(pidPath, "utf8").catch(() => "")).trim();
    const existingPid = Number.parseInt(raw, 10);
    if (existingPid && existingPid !== process.pid && isProcessAlive(existingPid)) {
      throw new Error(
        `Antigravity gateway is already running (PID ${existingPid}). Lock: ${pidPath}`,
      );
    }
    await fsp.rm(pidPath, { force: true }).catch(() => {});
  }

  await fsp.writeFile(pidPath, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
  return pidPath;
}

async function releasePidLock(pidPath: string | null): Promise<void> {
  if (!pidPath) {
    return;
  }
  try {
    const raw = (await fsp.readFile(pidPath, "utf8")).trim();
    if (Number.parseInt(raw, 10) === process.pid) {
      await fsp.rm(pidPath, { force: true });
    }
  } catch {
    // Ignore if already removed
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pidPath = await acquirePidLock(config.dataDir);

  let router: GatewayRouter | undefined;
  let healthServer: HealthServer | undefined;
  let scheduler: LoopScheduler | undefined;
  let channel: PhotonChannelAdapter | undefined;
  let backend: AgyAgentBackend | undefined;
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[gateway] Received ${signal}; shutting down...`);

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

    channel = new PhotonChannelAdapter(config);
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

    console.log(
      `[gateway] Antigravity iMessage gateway started (approval=${config.approvalMode}, allowlist=${config.allowedSenders.size}, paired=${store.listApprovedSenders().length})`,
    );
  } catch (err) {
    await shutdown("startup-error");
    throw err;
  }
}

main().catch((err) => {
  console.error("[gateway] Fatal error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
