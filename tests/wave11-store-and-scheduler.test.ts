import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as realDelay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoopScheduler } from "../src/gateway/scheduler.js";
import {
  CURRENT_STATE_VERSION,
  GatewayStore,
  migratePersistedState,
} from "../src/gateway/store.js";
import type {
  ChannelAdapter,
  OutboundMessage,
  SessionInfo,
} from "../src/types.js";

const tempDirs: string[] = [];

async function createTempDir(prefix = "agw-wave11-"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.useRealTimers();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, attempts = 400): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) {
      return;
    }
    await realDelay(5);
  }
  throw new Error("Timed out waiting for condition");
}

async function waitForPersistedLoops(file: string, expected: number): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    const parsed = await readJson(file).catch(() => undefined);
    if (Array.isArray(parsed?.loops) && parsed.loops.length === expected) {
      return;
    }
    await realDelay(5);
  }
  throw new Error(`Timed out waiting for ${expected} persisted loops`);
}

/**
 * Advance fake timers in steps until `predicate` holds. The scheduler persists a
 * failed attempt before rescheduling, so the retry timer may appear slightly
 * after the current tick has already been advanced.
 */
async function advanceUntil(
  stepMs: number,
  predicate: () => boolean,
  maxSteps = 40,
): Promise<void> {
  for (let i = 0; i < maxSteps; i += 1) {
    if (predicate()) {
      return;
    }
    await vi.advanceTimersByTimeAsync(stepMs);
    await realDelay(5);
  }
  if (predicate()) {
    return;
  }
  throw new Error("Timed out advancing timers");
}

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    chatId: "+15550001111",
    sessionId: "sess-a",
    cwd: "/tmp/workspace",
    approvalMode: "interactive",
    busyMode: "queue",
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

class ScriptedChannel implements ChannelAdapter {
  readonly name = "test";
  sent: OutboundMessage[] = [];
  failures: Error[] = [];
  sendAttempts = 0;

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  isConnected(): boolean {
    return true;
  }

  async sendMessage(msg: OutboundMessage): Promise<{ messageId?: string }> {
    this.sendAttempts += 1;
    const failure = this.failures.shift();
    if (failure) {
      throw failure;
    }
    this.sent.push(msg);
    return { messageId: `out-${this.sent.length}` };
  }
}

describe("GatewayStore persistence hardening", () => {
  it("keeps a state.json.bak snapshot of the previous writer's state", async () => {
    const dataDir = await createTempDir();
    const first = new GatewayStore(dataDir);
    await first.load();
    await first.upsertSession(makeSession({ sessionId: "sess-a" }));

    expect((await fs.readdir(dataDir)).sort()).toEqual(["state.json"]);
    expect(await fileExists(path.join(dataDir, "state.json.bak"))).toBe(false);

    // A second instance (e.g. the daemon after a restart) rolls the prior
    // snapshot into the backup before replacing it.
    const second = new GatewayStore(dataDir);
    await second.load();
    await second.setHomeChatId("+15550001111");

    const backup = await readJson(path.join(dataDir, "state.json.bak"));
    const backupSessions = backup.sessions as Record<string, { sessionId: string }>;
    expect(backupSessions["+15550001111"]?.sessionId).toBe("sess-a");
    expect(backup.homeChatId).toBeUndefined();

    const current = await readJson(path.join(dataDir, "state.json"));
    expect(current.homeChatId).toBe("+15550001111");
    expect((await fs.readdir(dataDir)).sort()).toEqual(["state.json", "state.json.bak"]);
  });

  it("quarantines a corrupt state.json and recovers the last known-good backup", async () => {
    const dataDir = await createTempDir();
    const seed = new GatewayStore(dataDir);
    await seed.load();
    await seed.upsertSession(makeSession({ sessionId: "sess-good" }));

    const backupWriter = new GatewayStore(dataDir);
    await backupWriter.load();
    await backupWriter.setHomeChatId("+15550001111");
    expect(await fileExists(path.join(dataDir, "state.json.bak"))).toBe(true);

    // Truncated JSON as left behind by a crashed writer.
    await fs.writeFile(path.join(dataDir, "state.json"), '{"version":1,"sessions":{');

    const recovered = new GatewayStore(dataDir);
    await recovered.load();

    expect(recovered.wasRecoveredFromBackup()).toBe(true);
    expect(recovered.getSession("+15550001111")?.sessionId).toBe("sess-good");

    const files = await fs.readdir(dataDir);
    expect(files.some((name) => name.startsWith("state.json.corrupt."))).toBe(true);

    // The primary file is rewritten from the backup and parses cleanly again.
    const restored = await readJson(path.join(dataDir, "state.json"));
    const restoredSessions = restored.sessions as Record<string, { sessionId: string }>;
    expect(restoredSessions["+15550001111"]?.sessionId).toBe("sess-good");

    // A store loading clean state reports no recovery.
    const clean = new GatewayStore(dataDir);
    await clean.load();
    expect(clean.wasRecoveredFromBackup()).toBe(false);
  });

  it("migrates legacy unversioned/v0 state to v1 and rejects future schema versions", async () => {
    expect(CURRENT_STATE_VERSION).toBe(1);

    const migrated = migratePersistedState({
      sessions: { "+15550001111": makeSession() },
      approvedSenders: ["+15552223333"],
      pendingPairings: [],
      loops: [
        {
          id: "loop01",
          chatId: "+15550001111",
          prompt: "check build",
          intervalMs: 60_000,
          enabled: true,
          createdAt: 1000,
        },
      ],
      homeChatId: "+15550001111",
      boundChannels: {
        photon: { channel: "photon", groupName: "photon", firstBoundAt: 5 },
      },
    });
    expect(migrated.version).toBe(1);
    expect(Object.keys(migrated.sessions ?? {})).toEqual(["+15550001111"]);
    expect(migrated.approvedSenders).toEqual(["+15552223333"]);
    expect(migrated.loops).toHaveLength(1);
    expect(migrated.homeChatId).toBe("+15550001111");
    expect(Object.keys(migrated.boundChannels ?? {})).toEqual(["photon"]);

    expect(migratePersistedState({ version: 0, sessions: {} }).version).toBe(1);
    expect(() => migratePersistedState({ version: 99 })).toThrow(
      /Unsupported state\.json schema version 99 \(max supported: 1\)/,
    );

    const dataDir = await createTempDir();
    await fs.writeFile(
      path.join(dataDir, "state.json"),
      JSON.stringify({
        sessions: {},
        approvedSenders: ["iMessage;-;+1 (555) 222-3333"],
        pendingPairings: [],
        loops: [],
        homeChatId: "+15550001111",
      }),
    );

    const legacy = new GatewayStore(dataDir);
    await legacy.load();
    expect(legacy.getHomeChatId()).toBe("+15550001111");
    expect(legacy.isApprovedSender("+15552223333")).toBe(true);

    // The next write persists the upgraded marker.
    await legacy.ensureChannelBinding("photon");
    expect((await readJson(path.join(dataDir, "state.json"))).version).toBe(1);

    const futureDir = await createTempDir();
    await fs.writeFile(path.join(futureDir, "state.json"), JSON.stringify({ version: 99 }));
    const future = new GatewayStore(futureDir);
    await expect(future.load()).rejects.toThrow(
      /Unsupported state\.json schema version 99/,
    );
    // A future schema is never "recovered" by rewriting it as v1.
    expect((await readJson(path.join(futureDir, "state.json"))).version).toBe(99);
  });

  it("clears a stale lockfile and serializes concurrent mutateAtomic updates", async () => {
    const dataDir = await createTempDir();
    const lockPath = path.join(dataDir, "state.json.lock");
    const store = new GatewayStore(dataDir);
    await store.load();

    // Lock left behind by a crashed process (well past the staleness window).
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: 1, acquiredAt: Date.now() - 5 * 60_000 }),
      { mode: 0o600 },
    );

    await store.mutateAtomic(async () => {
      await store.addApprovedSender("+15550001001");
    });
    expect(store.isApprovedSender("+15550001001")).toBe(true);
    expect(await fileExists(lockPath)).toBe(false);

    // Two independent instances (as would happen with a CLI + live daemon)
    // mutate under the same lock without losing either update.
    const other = new GatewayStore(dataDir);
    await Promise.all([
      store.mutateAtomic(async () => {
        await store.addApprovedSender("+15550001002");
      }),
      other.mutateAtomic(async () => {
        await other.addApprovedSender("+15550001003");
      }),
    ]);

    const reloaded = new GatewayStore(dataDir);
    await reloaded.load();
    expect(reloaded.isApprovedSender("+15550001001")).toBe(true);
    expect(reloaded.isApprovedSender("+15550001002")).toBe(true);
    expect(reloaded.isApprovedSender("+15550001003")).toBe(true);
    expect(await fileExists(lockPath)).toBe(false);
  });
});

describe("LoopScheduler one-shot retry", () => {
  const chatId = "+15550001111";

  async function setup(options: { failures?: Error[]; maxRetries?: number } = {}) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T12:00:00Z"));

    const dataDir = await createTempDir();
    const store = new GatewayStore(dataDir);
    await store.load();
    const channel = new ScriptedChannel();
    channel.failures.push(...(options.failures ?? []));

    const scheduler = new LoopScheduler({
      store,
      channel,
      maxOneShotRetries: options.maxRetries ?? 3,
      oneShotRetryDelaysMs: [1000, 2000, 3000],
    });
    scheduler.start();

    return { dataDir, store, channel, scheduler };
  }

  it("retries a transient reminder failure and deletes only after a successful send", async () => {
    const { dataDir, store, channel, scheduler } = await setup({
      failures: [new Error("503 Service Unavailable")],
    });

    const reminder = await scheduler.addReminder(chatId, 5000, "Drink water");
    await vi.advanceTimersByTimeAsync(5000);
    await waitFor(
      () => scheduler.listJobs().find((job) => job.id === reminder.id)?.failedAttempts === 1,
    );

    const failed = scheduler.listJobs().find((job) => job.id === reminder.id);
    expect(failed).toBeDefined();
    expect(failed?.failedAttempts).toBe(1);
    expect(failed?.lastError).toContain("503");
    expect(failed?.nextRunAt).toBe(Date.now() + 1000);
    expect(channel.sent).toHaveLength(0);
    // Reminder retries never spam the broken channel with loop failure notices.
    expect(channel.sendAttempts).toBe(1);
    await waitForPersistedLoops(path.join(dataDir, "state.json"), 1);

    // The retry timer is armed before the failed attempt is persisted, so one
    // backoff tick fires it.
    await vi.advanceTimersByTimeAsync(1000);
    await waitFor(() => channel.sent.length === 1);
    await waitFor(() => scheduler.listJobs().length === 0);

    expect(channel.sent[0]?.text).toBe("⏰ Reminder: Drink water");
    await waitForPersistedLoops(path.join(dataDir, "state.json"), 0);
    expect(store.getLoops()).toHaveLength(0);
    scheduler.stop();
  });

  it("stops retrying and cleans up once maxOneShotRetries is exhausted", async () => {
    const { channel, scheduler } = await setup({
      failures: [
        new Error("503 Service Unavailable"),
        new Error("request timed out"),
        new Error("502 Bad Gateway"),
        new Error("ECONNRESET"),
      ],
      maxRetries: 2,
    });

    const reminder = await scheduler.addReminder(chatId, 5000, "Buy milk");

    await vi.advanceTimersByTimeAsync(5000);
    await waitFor(
      () => scheduler.listJobs().find((job) => job.id === reminder.id)?.failedAttempts === 1,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await waitFor(
      () => scheduler.listJobs().find((job) => job.id === reminder.id)?.failedAttempts === 2,
    );

    // Third failure exceeds the retry budget and removes the job.
    await vi.advanceTimersByTimeAsync(2000);
    await waitFor(() => scheduler.listJobs().length === 0);

    expect(channel.sendAttempts).toBe(3);
    expect(channel.sent).toHaveLength(0);

    // Nothing is re-scheduled after cleanup.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scheduler.listJobs()).toHaveLength(0);
    expect(channel.sendAttempts).toBe(3);
    scheduler.stop();
  });

  it("stops immediately on a permanent dead-target failure without futile retries", async () => {
    const { channel, scheduler } = await setup({
      failures: [new Error("403 Forbidden: bot was blocked by the user")],
      maxRetries: 3,
    });

    const reminder = await scheduler.addReminder(chatId, 5000, "Stand up");
    await advanceUntil(5000, () => scheduler.listJobs().length === 0);

    expect(channel.sendAttempts).toBe(1);
    expect(channel.sent).toHaveLength(0);
    expect(channel.failures).toHaveLength(0);
    expect(scheduler.getDeadTargetRegistry().isDead(chatId).dead).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(scheduler.listJobs()).toHaveLength(0);
    expect(channel.sendAttempts).toBe(1);
    expect(scheduler.listJobs().find((job) => job.id === reminder.id)).toBeUndefined();
    scheduler.stop();
  });
});