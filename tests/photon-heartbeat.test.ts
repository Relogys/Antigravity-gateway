import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import {
  GatewayRouter,
  type ExtendedAgentBackend,
  type ExtendedChannelAdapter,
} from "../src/gateway/router.js";
import { LoopScheduler } from "../src/gateway/scheduler.js";
import { GatewayStore } from "../src/gateway/store.js";
import { PhotonChannelAdapter } from "../src/photon/adapter.js";
import { StreamStalenessWatchdog } from "../src/photon/staleness.js";
import type {
  AcpSessionSummary,
  AgentTurnInput,
  AgentTurnResult,
  InboundMessage,
  OutboundMessage,
} from "../src/types.js";

const tempDirs: string[] = [];

async function createTempDir(prefix = "agw-heartbeat-"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

function makeConfig(dataDir: string): GatewayConfig {
  return {
    allowedSenders: new Set(["+15550001111"]),
    allowGroups: false,
    groupMentionPatterns: ["@agy"],
    agyBin: "agy",
    defaultCwd: dataDir,
    approvalMode: "interactive",
    defaultModel: "test-model",
    defaultEffort: "high",
    healthEnabled: false,
    healthHost: "127.0.0.1",
    healthPort: 0,
    quotaWarnThreshold: 0,
    dataDir,
    logLevel: "info",
    photon: {
      projectId: "test-project-id",
      projectSecret: "test-project-secret",
      readReceipts: false,
      reactions: false,
    },
  };
}

function makeInbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    channel: "photon",
    chatId: "+15550001111",
    senderId: "+15550001111",
    isGroup: false,
    text: "hello",
    attachments: [],
    timestamp: Date.now(),
    service: "iMessage",
    mentionsBot: true,
    ...overrides,
  };
}

describe("StreamStalenessWatchdog heartbeat timeout", () => {
  it("fires onHeartbeatTimeout during cold start even when probeSpaceId is undefined", async () => {
    let now = 5_000_000;
    const probeFn = vi.fn();
    const onZombieDetected = vi.fn();
    const onHeartbeatTimeout = vi.fn();

    const watchdog = new StreamStalenessWatchdog({
      silenceThresholdMs: 60_000,
      probeCooldownMs: 30_000,
      heartbeatTimeoutMs: 10_000,
      probeFn,
      onZombieDetected,
      onHeartbeatTimeout,
      nowFn: () => now,
    });

    expect(watchdog.getState().probeSpaceId).toBeUndefined();
    expect(watchdog.getState().lastHeartbeatAt).toBe(5_000_000);

    // Healthy heartbeat but no space to probe yet -> nothing to do.
    now += 9_000;
    expect(await watchdog.checkOnce()).toBe("skipped");
    expect(onHeartbeatTimeout).not.toHaveBeenCalled();

    // Heartbeat silence crosses the timeout even without a probe space.
    now += 1_000;
    expect(await watchdog.checkOnce()).toBe("heartbeat_timeout");
    expect(onHeartbeatTimeout).toHaveBeenCalledTimes(1);
    expect(onHeartbeatTimeout).toHaveBeenCalledWith({
      silentHeartbeatMs: 10_000,
    });
    expect(probeFn).not.toHaveBeenCalled();
    expect(onZombieDetected).not.toHaveBeenCalled();

    // Cooldown suppresses duplicate restarts inside the same window.
    expect(await watchdog.checkOnce()).toBe("skipped");
    expect(onHeartbeatTimeout).toHaveBeenCalledTimes(1);

    // A fresh heartbeat re-arms the watchdog.
    watchdog.recordHeartbeat(now);
    now += 5_000;
    expect(await watchdog.checkOnce()).toBe("skipped");
    expect(onHeartbeatTimeout).toHaveBeenCalledTimes(1);
  });

  it("can be disabled with heartbeatTimeoutMs: 0", async () => {
    let now = 1_000_000;
    const onHeartbeatTimeout = vi.fn();

    const watchdog = new StreamStalenessWatchdog({
      heartbeatTimeoutMs: 0,
      probeFn: vi.fn(),
      onZombieDetected: vi.fn(),
      onHeartbeatTimeout,
      nowFn: () => now,
    });

    now += 24 * 60 * 60 * 1000;
    expect(await watchdog.checkOnce()).toBe("skipped");
    expect(onHeartbeatTimeout).not.toHaveBeenCalled();
  });

  it("recordHeartbeat updates lastHeartbeatAt without resetting inbound silence (zombie still detected)", async () => {
    let now = 1_000_000;
    const probeFn = vi
      .fn()
      .mockRejectedValue({ code: 5, message: "5 NOT_FOUND" });
    const onZombieDetected = vi.fn();
    const onHeartbeatTimeout = vi.fn();

    const watchdog = new StreamStalenessWatchdog({
      silenceThresholdMs: 60_000,
      probeCooldownMs: 30_000,
      heartbeatTimeoutMs: 180_000,
      probeSpaceId: "any;-;+15550001234",
      probeFn,
      onZombieDetected,
      onHeartbeatTimeout,
      nowFn: () => now,
    });

    // Transport keeps pulsing heartbeats while inbound messages are dropped.
    now += 40_000;
    watchdog.recordHeartbeat(now);
    now += 40_000;
    watchdog.recordHeartbeat(now);

    const state = watchdog.getState();
    expect(state.lastHeartbeatAt).toBe(1_080_000);
    expect(state.lastInboundAt).toBe(1_000_000);

    const outcome = await watchdog.checkOnce();
    expect(outcome).toBe("zombie");
    expect(probeFn).toHaveBeenCalledTimes(1);
    expect(onHeartbeatTimeout).not.toHaveBeenCalled();
    expect(onZombieDetected).toHaveBeenCalledWith(
      expect.objectContaining({
        silentMs: 80_000,
        spaceId: "any;-;+15550001234",
      }),
    );
  });
});

describe("PhotonChannelAdapter heartbeat state", () => {
  it("seedProbeSpaceId stores the home space and getStats exposes lastHeartbeatAt", async () => {
    const dataDir = await createTempDir();
    const adapter = new PhotonChannelAdapter(makeConfig(dataDir), {
      heartbeatTimeoutMs: 5_000,
    });

    const stats = adapter.getStats();
    expect(typeof stats.lastHeartbeatAt).toBe("number");
    expect(stats.lastHeartbeatAt).toBeGreaterThan(0);
    expect(stats.lastInboundAt).toBeUndefined();

    expect(() => adapter.seedProbeSpaceId("   ")).not.toThrow();
    adapter.seedProbeSpaceId("  any;-;+15550001234  ");
    const internals = adapter as unknown as { initialProbeSpaceId?: string };
    expect(internals.initialProbeSpaceId).toBe("any;-;+15550001234");

    // Seeding again (e.g. router startup with persisted homeChatId) replaces it.
    adapter.seedProbeSpaceId("+15550002222");
    expect(internals.initialProbeSpaceId).toBe("+15550002222");
  });

  it("reads PHOTON_PROBE_SPACE_ID and PHOTON_HEARTBEAT_TIMEOUT_MS env fallbacks", async () => {
    const dataDir = await createTempDir();
    process.env.PHOTON_PROBE_SPACE_ID = "any;-;+15550009999";
    process.env.PHOTON_HEARTBEAT_TIMEOUT_MS = "1234";
    try {
      const adapter = new PhotonChannelAdapter(makeConfig(dataDir));
      const internals = adapter as unknown as {
        initialProbeSpaceId?: string;
        heartbeatTimeoutMs: number;
      };
      expect(internals.initialProbeSpaceId).toBe("any;-;+15550009999");
      expect(internals.heartbeatTimeoutMs).toBe(1234);
    } finally {
      delete process.env.PHOTON_PROBE_SPACE_ID;
      delete process.env.PHOTON_HEARTBEAT_TIMEOUT_MS;
    }

    // Invalid / non-positive values fall back to the 180_000ms default.
    process.env.PHOTON_HEARTBEAT_TIMEOUT_MS = "not-a-number";
    try {
      const adapter = new PhotonChannelAdapter(makeConfig(dataDir));
      const internals = adapter as unknown as { heartbeatTimeoutMs: number };
      expect(internals.heartbeatTimeoutMs).toBe(180_000);
    } finally {
      delete process.env.PHOTON_HEARTBEAT_TIMEOUT_MS;
    }
  });
});

class TypingChannel implements ExtendedChannelAdapter {
  readonly name = "photon";
  connected = true;
  sent: OutboundMessage[] = [];
  typingEvents: Array<{ chatId: string; active: boolean }> = [];

  async start(): Promise<void> {
    this.connected = true;
  }

  async stop(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async sendMessage(msg: OutboundMessage): Promise<{ messageId?: string }> {
    this.sent.push(msg);
    return { messageId: `out-${this.sent.length}` };
  }

  async sendTyping(chatId: string, active: boolean): Promise<void> {
    this.typingEvents.push({ chatId, active });
  }

  getStats() {
    return {};
  }
}

class TurnBackend implements ExtendedAgentBackend {
  turnCalls: AgentTurnInput[] = [];
  turnHandler?: (input: AgentTurnInput) => Promise<AgentTurnResult>;

  async stop(): Promise<void> {}

  async sendTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    this.turnCalls.push(input);
    if (this.turnHandler) {
      return this.turnHandler(input);
    }
    return {
      sessionId: "sess-default",
      text: `Echo: ${input.text}`,
      stopReason: "end_turn",
    };
  }

  async cancelTurn(): Promise<boolean> {
    return false;
  }

  async resetSession(): Promise<void> {}

  async listSessions(): Promise<AcpSessionSummary[]> {
    return [];
  }
}

describe("GatewayRouter periodic typing refresh", () => {
  async function setupRouter(typingIntervalMs?: number) {
    const dataDir = await createTempDir("agw-typing-");
    const store = new GatewayStore(dataDir);
    await store.load();
    const channel = new TypingChannel();
    const backend = new TurnBackend();
    const scheduler = new LoopScheduler({ store, channel });
    const router = new GatewayRouter({
      config: makeConfig(dataDir),
      channel,
      backend,
      store,
      scheduler,
      quotaFetcher: async () => ({
        available: false,
        fetchedAt: Date.now(),
        groups: [],
      }),
      typingIntervalMs,
    });
    router.markReady();
    return { channel, backend, router, scheduler };
  }

  it("fires repeatedly during a slow ACP turn and stops cleanly after completion", async () => {
    vi.useFakeTimers();
    const { channel, backend, router, scheduler } = await setupRouter(1000);

    let releaseTurn: (() => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    backend.turnHandler = async () => {
      signalStarted?.();
      await new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
      return { sessionId: "sess-slow", text: "Done slowly", stopReason: "end_turn" };
    };

    const turn = router.handleInbound(makeInbound({ text: "slow task" }));
    await started;

    // Initial indicator fires as soon as the turn begins.
    expect(channel.typingEvents.filter((e) => e.active)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(3500);
    const activeDuringTurn = channel.typingEvents.filter((e) => e.active).length;
    expect(activeDuringTurn).toBeGreaterThanOrEqual(4);

    releaseTurn?.();
    await turn;
    expect(channel.typingEvents.at(-1)).toEqual({
      chatId: "+15550001111",
      active: false,
    });

    const countAfterCompletion = channel.typingEvents.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(channel.typingEvents.length).toBe(countAfterCompletion);
    scheduler.stop();
  });

  it("stops the typing refresh after a turn error and never leaks timers", async () => {
    vi.useFakeTimers();
    const { channel, backend, router, scheduler } = await setupRouter(1000);

    let releaseTurn: (() => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    backend.turnHandler = async () => {
      signalStarted?.();
      await new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
      throw new Error("ACP exploded");
    };

    const turn = router.handleInbound(makeInbound({ text: "explode" }));
    await started;

    await vi.advanceTimersByTimeAsync(2100);
    expect(channel.typingEvents.filter((e) => e.active).length).toBeGreaterThanOrEqual(3);

    releaseTurn?.();
    await turn;
    expect(channel.typingEvents.at(-1)).toEqual({
      chatId: "+15550001111",
      active: false,
    });
    expect(channel.sent.at(-1)?.text).toContain("Error: ACP exploded");

    const countAfterError = channel.typingEvents.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(channel.typingEvents.length).toBe(countAfterError);
    scheduler.stop();
  });

  it("sends no periodic refreshes when typingIntervalMs is 0", async () => {
    vi.useFakeTimers();
    const { channel, backend, router, scheduler } = await setupRouter(0);

    let releaseTurn: (() => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    backend.turnHandler = async () => {
      signalStarted?.();
      await new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
      return { sessionId: "sess-0", text: "done", stopReason: "end_turn" };
    };

    const turn = router.handleInbound(makeInbound({ text: "quick" }));
    await started;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(channel.typingEvents).toHaveLength(1);

    releaseTurn?.();
    await turn;
    expect(channel.typingEvents.at(-1)).toEqual({
      chatId: "+15550001111",
      active: false,
    });
    scheduler.stop();
  });
});