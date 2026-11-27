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
import type {
  AcpSessionSummary,
  AgentTurnInput,
  AgentTurnResult,
  ApprovalMode,
  BusyMode,
  InboundMessage,
  ModelCatalogEntry,
  OutboundMessage,
  SessionInfo,
  TurnActivitySnapshot,
} from "../src/types.js";

const tempDirs: string[] = [];

async function createTempDir(prefix = "agw-wave7b-"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  vi.useRealTimers();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

function makeConfig(
  dataDir: string,
  overrides: Partial<GatewayConfig> = {},
): GatewayConfig {
  return {
    allowedSenders: new Set(["+15550001111"]),
    allowGroups: false,
    groupMentionPatterns: ["@agy"],
    agyBin: "agy",
    defaultCwd: dataDir,
    approvalMode: "interactive",
    defaultModel: "gemini-4-neon",
    defaultEffort: "high",
    geminiApiKey: "test-key",
    healthEnabled: false,
    healthHost: "127.0.0.1",
    healthPort: 0,
    quotaWarnThreshold: 0,
    progressSilenceMs: 0,
    sessionStallTimeoutMs: 0,
    turnMaxRetries: 2,
    autoBootstrapChannelSession: true,
    dataDir,
    logLevel: "info",
    photon: {
      projectId: "test-project-id",
      projectSecret: "test-project-secret",
      readReceipts: true,
      reactions: true,
    },
    ...overrides,
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

function makeCatalog(count: number): ModelCatalogEntry[] {
  const entries: ModelCatalogEntry[] = [
    { id: "gemini-4-neon", name: "Gemini 4 Neon", efforts: ["high", "xhigh"] },
    { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", efforts: ["medium", "high"] },
  ];
  for (let i = 3; i <= count; i += 1) {
    entries.push({ id: `model-${i}`, name: `Model ${i}` });
  }
  return entries.slice(0, count);
}

class MockChannel implements ExtendedChannelAdapter {
  readonly name: string;
  connected = true;
  sent: OutboundMessage[] = [];
  reactions: Array<{ chatId: string; messageId: string; emoji: string }> = [];
  typingEvents: Array<{ chatId: string; active: boolean }> = [];

  constructor(name = "photon") {
    this.name = name;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

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

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    this.reactions.push({ chatId, messageId, emoji });
  }

  getStats() {
    return {};
  }

  texts(): string[] {
    return this.sent.map((m) => m.text ?? "");
  }
}

class MockBackend implements ExtendedAgentBackend {
  turnCalls: AgentTurnInput[] = [];
  setModelCalls: string[] = [];
  catalog?: ModelCatalogEntry[];
  availableSessions: AcpSessionSummary[] = [
    { sessionId: "sess-old-abc123", cwd: os.tmpdir(), title: "Previous Work" },
  ];
  turnHandler?: (input: AgentTurnInput) => Promise<AgentTurnResult>;
  activityGetter?: (chatId: string) => TurnActivitySnapshot | undefined;

  private sessions = new Map<string, SessionInfo>();

  async stop(): Promise<void> {}

  async sendTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    this.turnCalls.push(input);
    if (this.turnHandler) {
      return this.turnHandler(input);
    }
    return { sessionId: "sess-live-001", text: `Echo: ${input.text}`, stopReason: "end_turn" };
  }

  async cancelTurn(): Promise<boolean> {
    return false;
  }

  async resetSession(chatId: string): Promise<void> {
    this.sessions.delete(chatId);
  }

  async listSessions(): Promise<AcpSessionSummary[]> {
    return [...this.availableSessions];
  }

  getModelCatalog(): Promise<ModelCatalogEntry[]> {
    return Promise.resolve(this.catalog ?? []);
  }

  getTurnActivity(chatId: string): TurnActivitySnapshot | undefined {
    return this.activityGetter?.(chatId);
  }

  async setModel(
    chatId: string,
    modelInput: string,
  ): Promise<{ model: string; effort?: string; label?: string }> {
    this.setModelCalls.push(modelInput);

    const byIndex = Number.parseInt(modelInput, 10);
    if (String(byIndex) === modelInput.trim() && this.catalog) {
      const entry = this.catalog[byIndex - 1];
      if (!entry) {
        throw new Error(`No model at position ${modelInput}`);
      }
      this.setConfigOption(chatId, "model", entry.id);
      const effort = entry.efforts?.[0];
      if (effort) {
        this.setConfigOption(chatId, "thought_level", effort);
      }
      return { model: entry.id, effort, label: entry.name };
    }

    const byId = this.catalog?.find((m) => m.id === modelInput.trim());
    if (byId) {
      return { model: byId.id, label: byId.name };
    }

    throw new Error(`Unknown model "${modelInput}"`);
  }

  async setEffort(chatId: string, effort: string): Promise<void> {
    this.setConfigOption(chatId, "thought_level", effort);
  }

  getAvailableEfforts(): string[] {
    return ["low", "medium", "high", "xhigh"];
  }

  getAvailableModes(): string[] {
    return ["default", "accept-edits", "auto", "plan"];
  }

  setConfigOption(chatId: string, configId: string, value: string): void {
    const info = this.sessions.get(chatId) ?? {
      chatId,
      sessionId: "",
      cwd: os.tmpdir(),
      approvalMode: "interactive" as ApprovalMode,
      busyMode: "queue" as BusyMode,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (configId === "model") info.model = value;
    if (configId === "thought_level") info.effort = value;
    if (configId === "mode") info.mode = value;
    this.sessions.set(chatId, info);
  }

  getSessionInfo(chatId: string): SessionInfo | undefined {
    return this.sessions.get(chatId);
  }
}

interface SetupOptions {
  config?: Partial<GatewayConfig>;
  channel?: MockChannel;
  backend?: MockBackend;
  progressPollIntervalMs?: number;
}

async function setupRouter(options: SetupOptions = {}) {
  const dataDir = await createTempDir();
  const store = new GatewayStore(dataDir);
  await store.load();
  const channel = options.channel ?? new MockChannel("photon");
  const backend = options.backend ?? new MockBackend();
  const scheduler = new LoopScheduler({ store, channel });
  const config = makeConfig(dataDir, options.config);
  const router = new GatewayRouter({
    config,
    channel,
    backend,
    store,
    scheduler,
    progressPollIntervalMs: options.progressPollIntervalMs,
    quotaFetcher: async () => ({ available: false, fetchedAt: Date.now(), groups: [] }),
  });
  router.markReady();
  return { dataDir, config, store, channel, backend, scheduler, router };
}

describe("GatewayStore channel bindings", () => {
  it("auto-creates a normalized channel group and persists it across reloads", async () => {
    const dataDir = await createTempDir();
    const store = new GatewayStore(dataDir);
    await store.load();

    const first = await store.ensureChannelBinding("Photon");
    expect(first.isNew).toBe(true);
    expect(first.record.channel).toBe("photon");
    expect(first.record.groupName).toBe("photon");
    expect(typeof first.record.firstBoundAt).toBe("number");

    const second = await store.ensureChannelBinding("photon");
    expect(second.isNew).toBe(false);
    expect(store.getBoundChannels()).toHaveLength(1);

    const reloaded = new GatewayStore(dataDir);
    await reloaded.load();
    expect(reloaded.getBoundChannels()).toEqual([first.record]);
    expect((await reloaded.ensureChannelBinding("photon")).isNew).toBe(false);
  });

  it("tolerates legacy state.json files without a boundChannels map", async () => {
    const dataDir = await createTempDir();
    await fs.writeFile(
      path.join(dataDir, "state.json"),
      JSON.stringify({
        version: 1,
        sessions: {},
        approvedSenders: [],
        pendingPairings: [],
        pairingFailedAttempts: 0,
        loops: [],
      }),
    );

    const store = new GatewayStore(dataDir);
    await store.load();
    expect(store.getBoundChannels()).toEqual([]);
    expect((await store.ensureChannelBinding("Telegram")).isNew).toBe(true);
  });

  it("filters and sorts sessions by channel group", async () => {
    const dataDir = await createTempDir();
    const store = new GatewayStore(dataDir);
    await store.load();

    const base = {
      cwd: dataDir,
      approvalMode: "interactive" as ApprovalMode,
      busyMode: "queue" as BusyMode,
      createdAt: 1,
    };
    await store.upsertSession({ ...base, chatId: "photon::+1555", sessionId: "s1", updatedAt: 100 });
    await store.upsertSession({ ...base, chatId: "telegram::42", sessionId: "s2", updatedAt: 200 });
    await store.upsertSession({ ...base, chatId: "+15550009999", sessionId: "s3", updatedAt: 300 });
    await store.upsertSession({
      ...base,
      chatId: "photon::override",
      sessionId: "s4",
      channelGroup: "discord",
      updatedAt: 400,
    });

    expect(store.listSessionsByChannel("photon").map((s) => s.chatId)).toEqual([
      "+15550009999",
      "photon::+1555",
    ]);
    expect(store.listSessionsByChannel("discord").map((s) => s.chatId)).toEqual([
      "photon::override",
    ]);
    expect(store.listSessionsByChannel()).toHaveLength(4);
  });
});

describe("Idiot-proof /model", () => {
  it("shows the full numbered live catalog and usage hints, never treating flags as model ids", async () => {
    const backend = new MockBackend();
    backend.catalog = makeCatalog(18);
    const { channel, router } = await setupRouter({ backend });

    for (const input of ["/model", "/model -h", "/model --h", "/model list"]) {
      await router.handleInbound(makeInbound({ text: input }));
      const reply = channel.texts().at(-1) ?? "";
      expect(reply).toContain("Current model:");
      expect(reply).toContain("Available models (18):");
      expect(reply).toContain("1. Gemini 4 Neon (gemini-4-neon)");
      expect(reply).toContain("18. Model 18 (model-18)");
      expect(reply).not.toContain("more)");
      expect(reply).toContain("Switch by number: /model 4");
      expect(reply).toContain("Switch by keyword + effort: /model hydrogen xhigh");
      expect(reply).toContain("Change effort only: /effort [low|medium|high|xhigh]");
    }

    expect(backend.setModelCalls).toEqual([]);

    await router.handleInbound(makeInbound({ text: "/model 2" }));
    expect(channel.texts().at(-1)).toContain("Model set to: Gemini 4 Hydrogen (gemini-4-hydrogen) | effort: medium");

    await router.handleInbound(makeInbound({ text: "/model mystery" }));
    expect(channel.texts().at(-1)).toContain("Couldn't switch model");
    expect(channel.texts().at(-1)).toContain("Send /model to see the numbered list.");
  });
});

describe("Universal -h help flags", () => {
  it("returns clean usage text instead of treating -h/--help as arguments", async () => {
    const { channel, router } = await setupRouter();

    await router.handleInbound(makeInbound({ text: "/effort -h" }));
    expect(channel.texts().at(-1)).toContain("Usage: /effort");

    await router.handleInbound(makeInbound({ text: "/mode --help" }));
    expect(channel.texts().at(-1)).toContain("Usage: /mode");

    await router.handleInbound(makeInbound({ text: "/loop -h" }));
    expect(channel.texts().at(-1)).toContain("Usage: /loop");

    await router.handleInbound(makeInbound({ text: "/queue -h" }));
    expect(channel.texts().at(-1)).toContain("Usage: /queue");

    await router.handleInbound(makeInbound({ text: "/resume --h" }));
    expect(channel.texts().at(-1)).toContain("Usage: /resume");
  });
});

describe("Silence progress & stall watchdog", () => {
  it("pulses active tool name + tool count during a slow turn and clears after completion", async () => {
    const backend = new MockBackend();
    backend.activityGetter = (chatId) => ({
      chatId,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      phase: "tool",
      currentTool: "grep",
      toolCount: 3,
      retryCount: 0,
      maxRetries: 2,
    });
    backend.turnHandler = async () => {
      await delay(220);
      return { sessionId: "sess-slow", text: "Done thinking", stopReason: "end_turn" };
    };

    const { channel, router } = await setupRouter({
      backend,
      progressPollIntervalMs: 10,
      config: { progressSilenceMs: 25 },
    });

    await router.handleInbound(makeInbound({ text: "scan the repo" }));

    const progress = channel.texts().filter((t) => t.includes("正在执行工具"));
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0]).toContain("「grep」");
    expect(progress[0]).toContain("已调用 3 次");
    expect(progress[0]).toContain("发送 /stop 可取消");

    expect(channel.texts().at(-1)).toContain("Done thinking");

    const settled = channel.sent.length;
    await delay(80);
    expect(channel.sent.length).toBe(settled);
  });

  it("reports retry progress (第 2/2 次重试) while the model is retrying", async () => {
    const backend = new MockBackend();
    backend.activityGetter = (chatId) => ({
      chatId,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      phase: "retrying",
      retryCount: 2,
      maxRetries: 2,
      lastRetryReason: "429",
      toolCount: 1,
    });
    backend.turnHandler = async () => {
      await delay(160);
      return { sessionId: "sess-retry", text: "Recovered", stopReason: "end_turn" };
    };

    const { channel, router } = await setupRouter({
      backend,
      progressPollIntervalMs: 10,
      config: { progressSilenceMs: 25 },
    });

    await router.handleInbound(makeInbound({ text: "please retry" }));

    const retry = channel.texts().filter((t) => t.includes("次重试"));
    expect(retry.length).toBeGreaterThan(0);
    expect(retry[0]).toContain("第 2/2 次重试");
    expect(retry[0]).toContain("429");
  });

  it("fires the stall alert exactly once when activity is stale", async () => {
    const backend = new MockBackend();
    backend.activityGetter = (chatId) => ({
      chatId,
      startedAt: Date.now() - 60_000,
      lastActivityAt: Date.now() - 60_000,
      phase: "thinking",
      toolCount: 0,
      retryCount: 0,
      maxRetries: 2,
    });
    backend.turnHandler = async () => {
      await delay(220);
      return { sessionId: "sess-stalled", text: "Finally done", stopReason: "end_turn" };
    };

    const { channel, router } = await setupRouter({
      backend,
      progressPollIntervalMs: 10,
      config: { progressSilenceMs: 0, sessionStallTimeoutMs: 30 },
    });

    await router.handleInbound(makeInbound({ text: "stuck task" }));
    await delay(40);

    const stalls = channel.texts().filter((t) => t.includes("当前会话已静默"));
    expect(stalls).toHaveLength(1);
    expect(stalls[0]).toContain("发送 /stop");

    await delay(80);
    expect(channel.texts().filter((t) => t.includes("当前会话已静默"))).toHaveLength(1);
  });
});

describe("Channel-grouped sessions & onboarding", () => {
  it("auto-titles the first session, groups /sessions, and appends the welcome footer only once", async () => {
    const { channel, store, router } = await setupRouter();

    await router.handleInbound(makeInbound({ text: "first question" }));
    const firstReply = channel.texts().at(-1) ?? "";
    expect(firstReply).toContain("Echo: first question");
    expect(firstReply).toContain("💡 已自动建立 [photon] 分组会话");
    expect(firstReply).toContain("发 /model 切换模型");

    const session = store.getSession("+15550001111");
    expect(session?.title).toBe("[photon] Session #1");
    expect(session?.channelGroup).toBe("photon");
    expect(session?.onboarded).toBe(true);
    expect(store.getBoundChannels().map((c) => c.channel)).toContain("photon");

    await router.handleInbound(makeInbound({ text: "second question" }));
    const secondReply = channel.texts().at(-1) ?? "";
    expect(secondReply).toContain("Echo: second question");
    expect(secondReply).not.toContain("💡 已自动建立");

    const footerCount = channel.texts().filter((t) => t.includes("💡 已自动建立")).length;
    expect(footerCount).toBe(1);

    await router.handleInbound(makeInbound({ text: "/sessions" }));
    const sessionsReply = channel.texts().at(-1) ?? "";
    expect(sessionsReply).toContain("📂 photon");
    expect(sessionsReply).toContain("1. sess-old-a");
  });
});