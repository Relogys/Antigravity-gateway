import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as realDelay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildChildProcessEnv } from "../src/acp/client.js";
import {
  BotLoopGuard,
  DeadTargetRegistry,
  classifyPermanentDeliveryError,
} from "../src/gateway/guards.js";
import { LoopScheduler } from "../src/gateway/scheduler.js";
import { GatewayStore } from "../src/gateway/store.js";
import type { ChannelAdapter, OutboundMessage } from "../src/types.js";

const tempDirs: string[] = [];

async function createTempDir(prefix = "agw-guards-test-"): Promise<string> {
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

class FlakyChannel implements ChannelAdapter {
  readonly name = "test";
  sent: OutboundMessage[] = [];
  failWith: Error | null = null;

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  isConnected(): boolean {
    return true;
  }

  async sendMessage(msg: OutboundMessage): Promise<{ messageId?: string }> {
    if (this.failWith) {
      throw this.failWith;
    }
    this.sent.push(msg);
    return { messageId: `out-${this.sent.length}` };
  }
}

describe("BotLoopGuard", () => {
  it("allows up to maxEvents, trips cooldown on maxEvents + 1, and recovers cleanly", () => {
    let now = 1_000_000;
    const guard = new BotLoopGuard({
      maxEvents: 3,
      windowMs: 10_000,
      cooldownMs: 60_000,
      nowFn: () => now,
    });

    expect(guard.checkAndRecord("chat-a")).toEqual({ allowed: true, count: 1 });
    expect(guard.checkAndRecord("chat-a")).toEqual({ allowed: true, count: 2 });
    expect(guard.checkAndRecord("chat-a")).toEqual({ allowed: true, count: 3 });

    const tripped = guard.checkAndRecord("chat-a");
    expect(tripped.allowed).toBe(false);
    expect(tripped.count).toBe(4);
    expect(tripped.retryAfterMs).toBe(60_000);

    now += 10_000;
    const blocked = guard.checkAndRecord("chat-a");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(50_000);

    now += 50_000;
    expect(guard.checkAndRecord("chat-a")).toEqual({ allowed: true, count: 1 });

    guard.reset("chat-a");
    expect(guard.checkAndRecord("chat-a")).toEqual({ allowed: true, count: 1 });

    guard.clear();
    expect(guard.checkAndRecord("chat-a")).toEqual({ allowed: true, count: 1 });
  });

  it("evicts the oldest chat beyond maxChats", () => {
    let now = 0;
    const guard = new BotLoopGuard({
      maxEvents: 1,
      maxChats: 2,
      cooldownMs: 10_000,
      nowFn: () => now,
    });

    expect(guard.checkAndRecord("chat-a").allowed).toBe(true);
    expect(guard.checkAndRecord("chat-a").allowed).toBe(false); // cooldown tripped

    expect(guard.checkAndRecord("chat-b").allowed).toBe(true);
    expect(guard.checkAndRecord("chat-a").allowed).toBe(false); // still tracked

    now += 1;
    expect(guard.checkAndRecord("chat-c").allowed).toBe(true); // evicts chat-a
    expect(guard.checkAndRecord("chat-a").allowed).toBe(true); // fresh entry
  });
});

describe("classifyPermanentDeliveryError", () => {
  it("classifies forbidden, not-found, and plan-restricted failures", () => {
    expect(classifyPermanentDeliveryError(new Error("403 Forbidden"))).toBe("forbidden");
    expect(classifyPermanentDeliveryError({ status: 403, message: "blocked" })).toBe("forbidden");
    expect(
      classifyPermanentDeliveryError("Forbidden: bot was blocked by the user"),
    ).toBe("forbidden");
    expect(classifyPermanentDeliveryError(new Error("Bad Request: chat not found"))).toBe(
      "not_found",
    );
    expect(classifyPermanentDeliveryError("channel_not_found")).toBe("not_found");
    expect(classifyPermanentDeliveryError("Target not allowed for this plan")).toBe(
      "plan_restricted",
    );
  });

  it("ignores thread/message-level and transient failures", () => {
    expect(classifyPermanentDeliveryError(new Error("message not found"))).toBeNull();
    expect(classifyPermanentDeliveryError("thread not found")).toBeNull();
    expect(classifyPermanentDeliveryError("reply target unavailable")).toBeNull();
    expect(classifyPermanentDeliveryError("429 Too Many Requests")).toBeNull();
    expect(classifyPermanentDeliveryError("500 Internal Server Error")).toBeNull();
    expect(classifyPermanentDeliveryError("503 Service Unavailable")).toBeNull();
    expect(classifyPermanentDeliveryError("socket timeout")).toBeNull();
    expect(classifyPermanentDeliveryError(new Error("ECONNRESET"))).toBeNull();
  });
});

describe("DeadTargetRegistry", () => {
  it("marks permanent failures dead, expires after TTL, and self-clears on markAlive", () => {
    let now = 5_000;
    const registry = new DeadTargetRegistry({ ttlMs: 1_000, nowFn: () => now });

    expect(registry.recordError("chat-403", new Error("403 Forbidden"))).toBe(true);
    expect(registry.recordError("chat-missing", new Error("chat not found"))).toBe(true);
    expect(registry.recordError("chat-restricted", "Target not allowed")).toBe(true);
    expect(registry.recordError("chat-transient", "503 Service Unavailable")).toBe(false);
    expect(registry.size()).toBe(3);

    expect(registry.isDead("chat-403")).toEqual({ dead: true, reason: "forbidden" });
    expect(registry.isDead("chat-missing")).toEqual({ dead: true, reason: "not_found" });
    expect(registry.isDead("chat-restricted")).toEqual({
      dead: true,
      reason: "plan_restricted",
    });
    expect(registry.isDead("chat-transient")).toEqual({ dead: false });

    now += 1_000;
    expect(registry.isDead("chat-403")).toEqual({ dead: false });
    expect(registry.size()).toBe(2);

    registry.markAlive("chat-missing");
    expect(registry.isDead("chat-missing")).toEqual({ dead: false });
    expect(registry.size()).toBe(1);

    registry.clear();
    expect(registry.size()).toBe(0);
  });
});

describe("LoopScheduler dead-target resilience", () => {
  it("skips dead targets after a permanent failure and resumes after markAlive", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T12:00:00Z"));

    const dataDir = await createTempDir();
    const store = new GatewayStore(dataDir);
    await store.load();

    const channel = new FlakyChannel();
    channel.failWith = new Error("403 Forbidden");
    let promptCalls = 0;

    const scheduler = new LoopScheduler({
      store,
      channel,
      runPrompt: async () => {
        promptCalls += 1;
        return "tick";
      },
    });
    scheduler.start();

    const loop = await scheduler.addLoop({
      chatId: "dead-chat",
      prompt: "tick",
      intervalMs: 5_000,
    });

    // Let the async store write + reschedule settle between fake-timer advances.
    const tick = async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      await realDelay(10);
    };

    await tick();
    expect(promptCalls).toBe(1);
    expect(channel.sent).toHaveLength(0);
    expect(scheduler.getDeadTargetRegistry().isDead("dead-chat")).toEqual({
      dead: true,
      reason: "forbidden",
    });

    // Dead target: next tick is skipped entirely (no AI call, no send attempt).
    channel.failWith = null;
    await tick();
    expect(promptCalls).toBe(1);
    expect(channel.sent).toHaveLength(0);

    scheduler.getDeadTargetRegistry().markAlive("dead-chat");
    await tick();
    expect(promptCalls).toBe(2);
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]?.text).toBe("tick");

    scheduler.stop();
    expect(await scheduler.removeLoop(loop.id)).toBe(true);
  });
});

describe("buildChildProcessEnv", () => {
  it("preserves Windows runtime variables while applying overrides", () => {
    const base: NodeJS.ProcessEnv = {
      SYSTEMROOT: "C:\\Windows",
      SystemRoot: "C:\\Windows",
      COMSPEC: "C:\\Windows\\system32\\cmd.exe",
      TEMP: "C:\\Temp",
      TMP: "C:\\Temp",
      PATHEXT: ".COM;.EXE;.BAT",
      WINDIR: "C:\\Windows",
      PATH: "C:\\Windows\\system32",
      Path: "C:\\Windows\\system32",
    };

    const env = buildChildProcessEnv(base, {
      GEMINI_API_KEY: "test-key-not-real",
      SYSTEMROOT: undefined,
      TEMP: undefined,
    });

    expect(env.SYSTEMROOT).toBe("C:\\Windows");
    expect(env.SystemRoot).toBe("C:\\Windows");
    expect(env.TEMP).toBe("C:\\Temp");
    expect(env.TMP).toBe("C:\\Temp");
    expect(env.COMSPEC).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(env.PATHEXT).toBe(".COM;.EXE;.BAT");
    expect(env.WINDIR).toBe("C:\\Windows");
    expect(env.PATH).toBe("C:\\Windows\\system32");
    expect(env.Path).toBe("C:\\Windows\\system32");
    expect(env.GEMINI_API_KEY).toBe("test-key-not-real");
    expect(env.PYTHONUTF8).toBe("1");

    // Overrides never delete system variables and the base env is untouched.
    expect(base.PYTHONUTF8).toBeUndefined();
    expect(buildChildProcessEnv({ ...base, PYTHONUTF8: "0" }).PYTHONUTF8).toBe("0");
  });
});