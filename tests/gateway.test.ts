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
import {
  LoopScheduler,
  parseDurationMs,
  parseScheduleSpec,
} from "../src/gateway/scheduler.js";
import { GatewayStore } from "../src/gateway/store.js";
import { HealthServer } from "../src/health.js";
import type {
  AcpSessionSummary,
  AgentTurnInput,
  AgentTurnResult,
  ApprovalMode,
  BusyMode,
  InboundMessage,
  OutboundMessage,
  PendingPermission,
  QuotaSummary,
  SessionInfo,
} from "../src/types.js";

const tempDirs: string[] = [];

async function createTempDir(prefix = "agw-test-"): Promise<string> {
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

function makeConfig(
  dataDir: string,
  defaultCwd: string,
  overrides: Partial<GatewayConfig> = {},
): GatewayConfig {
  return {
    allowedSenders: new Set(["+15550001111"]),
    allowGroups: false,
    groupMentionPatterns: ["@agy", "@antigravity"],
    agyBin: "agy",
    defaultCwd,
    approvalMode: "interactive",
    defaultModel: "gemini-4-neon",
    defaultEffort: "high",
    geminiApiKey: "secret-gemini-api-key",
    healthEnabled: false,
    healthHost: "127.0.0.1",
    healthPort: 0,
    photon: {
      projectId: "test-project-id",
      projectSecret: "test-project-secret",
      readReceipts: true,
      reactions: true,
    },
    quotaWarnThreshold: 15,
    dataDir,
    logLevel: "info",
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

class MockChannel implements ExtendedChannelAdapter {
  readonly name = "photon";
  connected = true;
  sent: OutboundMessage[] = [];
  reactions: Array<{ chatId: string; messageId: string; emoji: string }> = [];
  readReceipts: Array<{ chatId: string; messageId?: string }> = [];
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

  async markRead(chatId: string, messageId?: string): Promise<void> {
    this.readReceipts.push({ chatId, messageId });
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    this.reactions.push({ chatId, messageId, emoji });
  }

  getStats() {
    return {};
  }
}

class MockBackend implements ExtendedAgentBackend {
  turnCalls: AgentTurnInput[] = [];
  cancelledChats: string[] = [];
  resetChats: string[] = [];
  attachedSessions: Array<{ chatId: string; sessionId: string; cwd: string }> = [];
  resolvedPermissions: Array<{ chatId: string; decision: string }> = [];
  pendingPerms = new Map<string, PendingPermission>();
  busyChats = new Set<string>();
  queues = new Map<string, string[]>();
  busyModes = new Map<string, BusyMode>();
  approvalModes = new Map<string, ApprovalMode>();
  sessions = new Map<string, SessionInfo>();
  sessionSeq = 0;

  availableSessions: AcpSessionSummary[] = [
    { sessionId: "sess-old-001", cwd: "/tmp", title: "Previous Auth Work" },
    { sessionId: "sess-old-002", cwd: "/tmp", title: "Bug Hunt" },
  ];

  turnHandler?: (input: AgentTurnInput) => Promise<AgentTurnResult>;

  async stop(): Promise<void> {}

  async sendTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    this.turnCalls.push(input);
    this.busyChats.add(input.chatId);
    try {
      if (this.turnHandler) {
        return await this.turnHandler(input);
      }
      this.sessionSeq += 1;
      const sessionId = input.sessionId || `sess-${this.sessionSeq}`;
      const existing = this.sessions.get(input.chatId);
      this.sessions.set(input.chatId, {
        chatId: input.chatId,
        sessionId,
        cwd: input.cwd,
        model: input.model ?? existing?.model ?? "gemini-4-neon",
        effort: input.effort ?? existing?.effort ?? "high",
        mode: existing?.mode ?? "default",
        approvalMode: input.approvalMode ?? existing?.approvalMode ?? "interactive",
        busyMode: this.getBusyMode(input.chatId),
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      });
      return {
        sessionId,
        text: `Echo: ${input.text}`,
        stopReason: "end_turn",
      };
    } finally {
      this.busyChats.delete(input.chatId);
    }
  }

  async cancelTurn(chatId: string): Promise<boolean> {
    this.cancelledChats.push(chatId);
    return this.busyChats.has(chatId);
  }

  async resetSession(chatId: string): Promise<void> {
    this.resetChats.push(chatId);
    this.sessions.delete(chatId);
    this.queues.delete(chatId);
  }

  async listSessions(): Promise<AcpSessionSummary[]> {
    return [...this.availableSessions];
  }

  async attachSession(chatId: string, sessionId: string, cwd: string): Promise<void> {
    this.attachedSessions.push({ chatId, sessionId, cwd });
    this.sessions.set(chatId, {
      chatId,
      sessionId,
      cwd,
      approvalMode: this.getApprovalMode(chatId),
      busyMode: this.getBusyMode(chatId),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  async setConfigOption(chatId: string, configId: string, value: string): Promise<void> {
    const info = this.sessions.get(chatId) ?? {
      chatId,
      sessionId: "",
      cwd: ".",
      approvalMode: "interactive",
      busyMode: "queue",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (configId === "model") info.model = value;
    if (configId === "thought_level") info.effort = value;
    if (configId === "mode") info.mode = value;
    this.sessions.set(chatId, info);
  }

  async setMode(chatId: string, modeId: string): Promise<void> {
    await this.setConfigOption(chatId, "mode", modeId);
  }

  async setModel(
    chatId: string,
    modelInput: string,
  ): Promise<{ model: string; effort?: string }> {
    const m = /^(.*)-(low|medium|high|xhigh)$/i.exec(modelInput.trim());
    const model = m ? m[1] : modelInput.trim();
    const effort = m ? m[2].toLowerCase() : undefined;
    await this.setConfigOption(chatId, "model", model);
    if (effort) {
      await this.setConfigOption(chatId, "thought_level", effort);
    }
    return { model, effort };
  }

  async setEffort(chatId: string, effort: string): Promise<void> {
    await this.setConfigOption(chatId, "thought_level", effort);
  }

  getAvailableModels(): string[] {
    return ["gemini-4-neon-high", "gemini-4-hydrogen-high", "claude-opus-5-5-high"];
  }

  getAvailableEfforts(): string[] {
    return ["low", "medium", "high", "xhigh"];
  }

  getAvailableModes(): string[] {
    return ["default", "accept-edits", "auto", "plan"];
  }

  isBusy(chatId: string): boolean {
    return this.busyChats.has(chatId);
  }

  getBusyMode(chatId: string): BusyMode {
    return this.busyModes.get(chatId) ?? "queue";
  }

  setBusyMode(chatId: string, mode: BusyMode): void {
    this.busyModes.set(chatId, mode);
  }

  getQueue(chatId: string): string[] {
    return [...(this.queues.get(chatId) ?? [])];
  }

  enqueuePrompt(chatId: string, text: string): number {
    const q = this.queues.get(chatId) ?? [];
    q.push(text);
    this.queues.set(chatId, q);
    return q.length;
  }

  shiftQueuedPrompt(chatId: string): string | undefined {
    return this.queues.get(chatId)?.shift();
  }

  clearQueue(chatId: string): number {
    const q = this.queues.get(chatId);
    const len = q?.length ?? 0;
    this.queues.delete(chatId);
    return len;
  }

  setApprovalMode(chatId: string, mode: ApprovalMode): void {
    this.approvalModes.set(chatId, mode);
  }

  getApprovalMode(chatId: string): ApprovalMode {
    return this.approvalModes.get(chatId) ?? "interactive";
  }

  getPendingPermission(chatId: string): PendingPermission | undefined {
    return this.pendingPerms.get(chatId);
  }

  resolvePermission(
    chatId: string,
    decision: "once" | "session" | "always" | "deny",
  ): boolean {
    this.resolvedPermissions.push({ chatId, decision });
    const perm = this.pendingPerms.get(chatId);
    if (!perm) return false;
    this.pendingPerms.delete(chatId);
    perm.resolve(decision === "deny" ? null : "opt-allow");
    return true;
  }

  getSessionInfo(chatId: string): SessionInfo | undefined {
    return this.sessions.get(chatId);
  }

  getStats() {
    let activeSessions = 0;
    for (const s of this.sessions.values()) {
      if (s.sessionId) activeSessions++;
    }
    return {
      activeSessions,
      activeTurns: this.busyChats.size,
      pendingPermissions: this.pendingPerms.size,
    };
  }
}

describe("GatewayStore", () => {
  it("persists sessions, approved senders, loops, and homeChatId atomically across reloads", async () => {
    const dataDir = await createTempDir();
    const store = new GatewayStore(dataDir);
    await store.load();

    await Promise.all([
      store.upsertSession({
        chatId: "+15550001111",
        sessionId: "sess-1",
        cwd: dataDir,
        approvalMode: "interactive",
        busyMode: "queue",
        title: "Alpha",
        createdAt: 1000,
        updatedAt: 2000,
      }),
      store.addApprovedSender("iMessage;-;+1 (555) 222-3333"),
      store.setHomeChatId("+15550001111"),
      store.upsertLoop({
        id: "loop01",
        chatId: "+15550001111",
        prompt: "check build",
        intervalMs: 60_000,
        enabled: true,
        createdAt: 1000,
      }),
    ]);

    const files = await fs.readdir(dataDir);
    expect(files).toEqual(["state.json"]);

    const reloaded = new GatewayStore(dataDir);
    await reloaded.load();
    expect(reloaded.getSession("+15550001111")?.sessionId).toBe("sess-1");
    expect(reloaded.isApprovedSender("+15552223333")).toBe(true);
    expect(reloaded.getHomeChatId()).toBe("+15550001111");
    expect(reloaded.getLoops()).toHaveLength(1);
    expect(reloaded.getLoops()[0]?.id).toBe("loop01");

    expect(await reloaded.revokeApprovedSender("+15552223333")).toBe(true);
    expect(reloaded.isApprovedSender("+15552223333")).toBe(false);
    expect(await reloaded.deleteSession("+15550001111")).toBe(true);
    expect(await reloaded.deleteLoop("loop01")).toBe(true);
  });

  it("enforces 8-char pairing code TTL, 10m rate limit, max-3 pending cap, and 5-attempt lockout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T10:00:00Z"));

    const dataDir = await createTempDir();
    const store = new GatewayStore(dataDir);
    await store.load();

    // 1. Create pairing code & verify alphabet + length
    const p1 = await store.createOrGetPairing("+15550001001");
    expect(p1.reason).toBe("created");
    expect(p1.shouldNotify).toBe(true);
    expect(p1.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);

    // 2. Rate-limited within 10 minutes
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const p1Again = await store.createOrGetPairing("any;-;+15550001001");
    expect(p1Again.reason).toBe("rate_limited");
    expect(p1Again.shouldNotify).toBe(false);
    expect(p1Again.code).toBe(p1.code);

    // Allowed to re-notify after 10 minutes
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    const p1ReNotify = await store.createOrGetPairing("+15550001001");
    expect(p1ReNotify.shouldNotify).toBe(true);
    expect(p1ReNotify.code).toBe(p1.code);

    // 3. Max 3 pending pairings
    const p2 = await store.createOrGetPairing("+15550001002");
    const p3 = await store.createOrGetPairing("+15550001003");
    expect(p2.reason).toBe("created");
    expect(p3.reason).toBe("created");

    const p4 = await store.createOrGetPairing("+15550001004");
    expect(p4.reason).toBe("max_pending");
    expect(p4.shouldNotify).toBe(false);

    // 4. 5-attempt lockout on invalid codes
    for (let attempt = 1; attempt <= 4; attempt++) {
      const fail = await store.approvePairing("BADCODE1");
      expect(fail.ok).toBe(false);
      expect(fail.reason).toBe("invalid_code");
      expect(fail.remainingAttempts).toBe(5 - attempt);
    }
    const locked = await store.approvePairing("BADCODE1");
    expect(locked.ok).toBe(false);
    expect(locked.reason).toBe("locked");
    expect(locked.retryAfterMs).toBe(15 * 60_000);

    // Even a valid code is rejected while locked
    const duringLock = await store.approvePairing(p1.code!);
    expect(duringLock.ok).toBe(false);
    expect(duringLock.reason).toBe("locked");

    // After 15m lockout expires, valid code succeeds
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1000);
    const approved = await store.approvePairing(p2.code!.toLowerCase());
    expect(approved).toEqual({
      ok: true,
      senderId: "+15550001002",
      reason: "approved",
    });
    expect(store.isApprovedSender("+15550001002")).toBe(true);

    // 5. Remaining code expires after 1 hour TTL
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    const expired = await store.approvePairing(p1.code!);
    expect(expired.ok).toBe(false);
    expect(expired.reason).toBe("expired");

    // 6. Clear pending pairings resets pending & lockout
    await store.createOrGetPairing("+15550001005");
    expect(store.listPendingPairings()).toHaveLength(1);
    expect(await store.clearPendingPairings()).toBe(1);
    expect(store.listPendingPairings()).toHaveLength(0);
  });
});

describe("LoopScheduler", () => {
  it("parses durations and schedule expressions accurately", () => {
    expect(parseDurationMs("45s")).toBe(45_000);
    expect(parseDurationMs("30m")).toBe(1_800_000);
    expect(parseDurationMs("2h")).toBe(7_200_000);
    expect(parseDurationMs("1d")).toBe(86_400_000);
    expect(parseDurationMs("1h30m")).toBe(5_400_000);
    expect(parseDurationMs("500ms")).toBeNull();
    expect(parseDurationMs("0s")).toBeNull();
    expect(parseDurationMs("abc")).toBeNull();

    expect(parseScheduleSpec("every 15m check logs")).toEqual({
      kind: "loop",
      intervalMs: 900_000,
      prompt: "check logs",
      oneShot: false,
    });
    expect(parseScheduleSpec("remind 10m stand up")).toEqual({
      kind: "remind",
      intervalMs: 600_000,
      prompt: "stand up",
      oneShot: true,
    });
    expect(parseScheduleSpec("daily 09:30 morning brief")).toEqual({
      kind: "loop",
      cron: "09:30",
      prompt: "morning brief",
      oneShot: false,
    });
    expect(parseScheduleSpec("daily 25:99 invalid")).toBeNull();
  });

  it("fires one-way reminders without calling AI and manages recurring loops, pause/resume/rm, and stop", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T12:00:00Z"));

    const dataDir = await createTempDir();
    const store = new GatewayStore(dataDir);
    await store.load();
    const channel = new MockChannel();
    const runPrompt = vi.fn().mockResolvedValue("Loop summary ok");

    const scheduler = new LoopScheduler({ store, channel, runPrompt });
    scheduler.start();

    const rem = await scheduler.addReminder("+15550001111", 5000, "Drink water");
    expect(scheduler.activeCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(runPrompt).not.toHaveBeenCalled();
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]?.text).toBe("⏰ Reminder: Drink water");
    // One-shot reminder auto-deletes
    expect(scheduler.listJobs()).toHaveLength(0);

    const loop = await scheduler.addLoop({
      chatId: "+15550001111",
      prompt: "Check CI",
      intervalMs: 10_000,
    });
    expect(scheduler.activeCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(runPrompt).toHaveBeenCalledTimes(1);
    expect(channel.sent).toHaveLength(2);
    expect(channel.sent[1]?.text).toBe("Loop summary ok");

    // Pause stops future runs until resumed
    await scheduler.toggleLoop(loop.id, false);
    expect(scheduler.activeCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(runPrompt).toHaveBeenCalledTimes(1);

    await scheduler.toggleLoop(loop.id, true);
    expect(scheduler.activeCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runPrompt).toHaveBeenCalledTimes(2);

    // Stop clears timers cleanly without executing again
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runPrompt).toHaveBeenCalledTimes(2);

    expect(await scheduler.removeLoop(loop.id)).toBe(true);
    expect(scheduler.listJobs()).toHaveLength(0);
  });
});

describe("GatewayRouter integration", () => {
  async function setupRouter(options: {
    configOverrides?: Partial<GatewayConfig>;
    quota?: QuotaSummary;
  } = {}) {
    const rootDir = await createTempDir();
    const dataDir = path.join(rootDir, "data");
    const cwdDir = path.join(rootDir, "workspace");
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(cwdDir, { recursive: true });

    const config = makeConfig(dataDir, cwdDir, options.configOverrides);
    const store = new GatewayStore(dataDir);
    await store.load();
    const channel = new MockChannel();
    const backend = new MockBackend();
    const scheduler = new LoopScheduler({ store, channel });
    const quota: QuotaSummary = options.quota ?? {
      available: true,
      fetchedAt: Date.now(),
      fiveHourRemainingPercent: 64,
      weeklyRemainingPercent: 84,
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            {
              id: "gemini-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remainingFraction: 0.64,
              remainingPercent: 64,
              resetTime: "2026-11-26T21:00:00Z",
            },
          ],
        },
      ],
    };

    const router = new GatewayRouter({
      config,
      channel,
      backend,
      store,
      scheduler,
      quotaFetcher: async () => quota,
    });
    router.markReady();

    return { rootDir, dataDir, cwdDir, config, store, channel, backend, scheduler, router };
  }

  it("enforces fail-closed auth, DM pairing flow, and group chat gating", async () => {
    const { store, channel, backend, router } = await setupRouter({
      configOverrides: {
        allowedSenders: new Set(["+15550001111"]),
        allowGroups: false,
      },
    });

    // Unauthorized DM receives pairing code and never invokes backend
    await router.handleInbound(
      makeInbound({
        id: "dm-unauth-1",
        chatId: "+15559990000",
        senderId: "any;-;+1 (555) 999-0000",
        text: "secret prompt",
      }),
    );
    expect(backend.turnCalls).toHaveLength(0);
    expect(channel.sent).toHaveLength(1);
    const codeMatch = /pairing code ([A-Z0-9]{8})/.exec(channel.sent[0]?.text ?? "");
    expect(codeMatch).not.toBeNull();

    // Second unauthorized DM within rate-limit window does not spam pairing codes
    await router.handleInbound(
      makeInbound({
        id: "dm-unauth-2",
        chatId: "+15559990000",
        senderId: "+15559990000",
        text: "again",
      }),
    );
    expect(channel.sent).toHaveLength(1);

    // Approve pairing code -> user now works
    const approval = await store.approvePairing(codeMatch![1]);
    expect(approval.ok).toBe(true);

    await router.handleInbound(
      makeInbound({
        id: "dm-auth-1",
        chatId: "+15559990000",
        senderId: "+15559990000",
        text: "now authorized",
      }),
    );
    expect(backend.turnCalls).toHaveLength(1);
    expect(channel.sent.at(-1)?.text).toContain("Echo: now authorized");

    // Group chat gating when allowGroups=false
    await router.handleInbound(
      makeInbound({
        id: "grp-disabled",
        chatId: "any;+;chat123",
        senderId: "+15550001111",
        isGroup: true,
        mentionsBot: true,
        text: "@agy /whoami",
      }),
    );
    expect(channel.sent).toHaveLength(2); // unchanged

    // Group chat with allowGroups=true: requires both authorized sender AND mentionsBot
    const grpSetup = await setupRouter({
      configOverrides: {
        allowedSenders: new Set(["+15550001111"]),
        allowGroups: true,
      },
    });

    await grpSetup.router.handleInbound(
      makeInbound({
        id: "grp-no-mention",
        chatId: "any;+;chat123",
        senderId: "+15550001111",
        isGroup: true,
        mentionsBot: false,
        text: "casual chat",
      }),
    );
    await grpSetup.router.handleInbound(
      makeInbound({
        id: "grp-unauth-mention",
        chatId: "any;+;chat123",
        senderId: "+15558887777",
        isGroup: true,
        mentionsBot: true,
        text: "@agy /whoami",
      }),
    );
    expect(grpSetup.channel.sent).toHaveLength(0);

    await grpSetup.router.handleInbound(
      makeInbound({
        id: "grp-ok",
        chatId: "any;+;chat123",
        senderId: "+15550001111",
        isGroup: true,
        mentionsBot: true,
        text: "@agy: /whoami",
      }),
    );
    expect(grpSetup.channel.sent).toHaveLength(1);
    expect(grpSetup.channel.sent[0]?.text).toContain("Chat: any;+;chat123 (group)");
  });

  it("handles the full slash-command suite and low-quota footer warning", async () => {
    const lowQuota: QuotaSummary = {
      available: true,
      fetchedAt: Date.now(),
      fiveHourRemainingPercent: 12,
      weeklyRemainingPercent: 70,
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            {
              id: "gemini-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remainingFraction: 0.12,
              remainingPercent: 12,
              resetTime: "2026-11-26T21:00:00Z",
            },
          ],
        },
      ],
    };

    const { rootDir, channel, backend, store, scheduler, router } = await setupRouter({
      quota: lowQuota,
    });
    const send = (text: string) => router.handleInbound(makeInbound({ text }));

    await send("/help");
    expect(channel.sent.at(-1)?.text).toContain("Antigravity Gateway Commands:");

    await send("/commands");
    expect(channel.sent.at(-1)?.text).toContain("/usage");

    await send("/version");
    expect(channel.sent.at(-1)?.text).toContain("antigravity-gateway v0.2.0");

    await send("/whoami");
    expect(channel.sent.at(-1)?.text).toContain("Auth: env allowlist");

    await send("/usage");
    expect(channel.sent.at(-1)?.text).toContain("5h: 12% remaining");

    // Normal prompt triggers low-quota warning footer because 12% <= threshold 15%
    await send("explain event loop");
    const turnReply = channel.sent.at(-1)?.text ?? "";
    expect(turnReply).toContain("Echo: explain event loop");
    expect(turnReply).toContain("[Notice: 5h Antigravity quota at 12% remaining]");

    await send("/status");
    expect(channel.sent.at(-1)?.text).toContain("Status: ok");

    await send("/model");
    expect(channel.sent.at(-1)?.text).toContain("Current model:");

    await send("/model gemini-4-hydrogen-xhigh");
    expect(channel.sent.at(-1)?.text).toContain("Model set to: gemini-4-hydrogen (effort: xhigh)");

    await send("/effort medium");
    expect(channel.sent.at(-1)?.text).toContain("Effort set to: medium");

    await send("/mode plan");
    expect(channel.sent.at(-1)?.text).toContain("Mode set to: plan");

    await send("/approvals sandbox");
    expect(channel.sent.at(-1)?.text).toContain("Approval mode set to: sandbox");

    await send("/yolo");
    expect(channel.sent.at(-1)?.text).toContain("Approval mode set to auto");
    await send("/yolo");
    expect(channel.sent.at(-1)?.text).toContain("Approval mode restored to interactive");

    await send("/title My Gateway Session");
    expect(channel.sent.at(-1)?.text).toContain("Session title updated: My Gateway Session");
    await send("/title");
    expect(channel.sent.at(-1)?.text).toContain("Session title: My Gateway Session");

    await send("/sessions");
    expect(channel.sent.at(-1)?.text).toContain("1. sess-old-0");
    await send("/resume 1");
    expect(channel.sent.at(-1)?.text).toContain("Resumed session sess-old-001");

    await send("/compact");
    expect(backend.turnCalls.at(-1)?.text).toContain("Concisely summarize");

    const subDir = path.join(rootDir, "subproj");
    await fs.mkdir(subDir, { recursive: true });
    await send(`/cwd ${subDir}`);
    expect(channel.sent.at(-1)?.text).toContain(`Working directory set to: ${subDir}`);

    await send("/cwd nonexistent-folder-xyz");
    expect(channel.sent.at(-1)?.text).toContain("Directory does not exist:");

    await send("/busy steer");
    expect(channel.sent.at(-1)?.text).toContain("Busy mode set to: steer");
    await send("/busy queue");

    await send("/queue list");
    expect(channel.sent.at(-1)?.text).toContain("Queue is empty.");

    // /approve & /deny with pending permission
    const permResolved = vi.fn();
    backend.pendingPerms.set("+15550001111", {
      id: "perm-1",
      chatId: "+15550001111",
      sessionId: "sess-1",
      toolCallId: "tc-1",
      title: "Edit file",
      kind: "edit",
      options: [],
      createdAt: Date.now(),
      resolve: permResolved,
    });
    await send("/approve session");
    expect(channel.sent.at(-1)?.text).toContain("Approved (session)");
    expect(permResolved).toHaveBeenCalledWith("opt-allow");

    backend.pendingPerms.set("+15550001111", {
      id: "perm-2",
      chatId: "+15550001111",
      sessionId: "sess-1",
      toolCallId: "tc-2",
      title: "Delete file",
      kind: "delete",
      options: [],
      createdAt: Date.now(),
      resolve: permResolved,
    });
    await send("/deny unsafe");
    expect(channel.sent.at(-1)?.text).toContain("Denied: unsafe");
    expect(permResolved).toHaveBeenCalledWith(null);

    // /loop & /remind
    await send("/loop add 15m check status");
    const addLoopMsg = channel.sent.at(-1)?.text ?? "";
    expect(addLoopMsg).toContain("Loop [");
    const loopId = /\[([a-f0-9]+)\]/.exec(addLoopMsg)![1];

    await send("/loop list");
    expect(channel.sent.at(-1)?.text).toContain(loopId);

    await send(`/loop pause ${loopId}`);
    expect(channel.sent.at(-1)?.text).toContain(`Paused loop [${loopId}]`);

    await send(`/loop resume ${loopId}`);
    expect(channel.sent.at(-1)?.text).toContain(`Resumed loop [${loopId}]`);

    await send(`/loop rm ${loopId}`);
    expect(channel.sent.at(-1)?.text).toContain(`Removed loop [${loopId}]`);

    await send("/remind 20m water plants");
    expect(channel.sent.at(-1)?.text).toContain("Reminder [");
    scheduler.stop();

    await send("/new");
    expect(channel.sent.at(-1)?.text).toContain("Started a fresh session");

    await send("/discard");
    expect(channel.sent.at(-1)?.text).toContain("Discarded session and queue");
    expect(store.getSession("+15550001111")).toBeUndefined();

    await send("/stop");
    expect(channel.sent.at(-1)?.text).toContain("No active turn is running");
  });

  it("bypasses busy lock for control commands, drains FIFO queue, and resolves /steer & /new while busy", async () => {
    const { channel, backend, store, router } = await setupRouter();

    let releaseTurn1: (() => void) | undefined;
    let signalTurn1Started: (() => void) | undefined;
    const turn1Started = new Promise<void>((resolve) => {
      signalTurn1Started = resolve;
    });
    let turnCount = 0;
    backend.turnHandler = async (input) => {
      turnCount += 1;
      if (turnCount === 1) {
        signalTurn1Started?.();
        await new Promise<void>((resolve) => {
          releaseTurn1 = resolve;
        });
      }
      return {
        sessionId: "sess-busy-1",
        text: `Done: ${input.text}`,
        stopReason: "end_turn",
      };
    };

    // Start turn 1 (in flight)
    const p1 = router.handleInbound(makeInbound({ id: "t1", text: "first task" }));
    await turn1Started;

    // Idle-only command is blocked while busy
    await router.handleInbound(makeInbound({ id: "cmd-idle", text: "/model" }));
    expect(channel.sent.at(-1)?.text).toContain("Agent is currently busy");

    // Always-dispatchable control commands bypass busy lock
    await router.handleInbound(makeInbound({ id: "cmd-status", text: "/status" }));
    expect(channel.sent.at(-1)?.text).toContain("Turn: busy");

    // Enqueue 2 prompts in FIFO order while busy
    await router.handleInbound(makeInbound({ id: "q1", text: "second task" }));
    await router.handleInbound(makeInbound({ id: "q2", text: "/queue third task" }));
    expect(channel.sent.at(-1)?.text).toContain("Queued at #2");

    await router.handleInbound(makeInbound({ id: "q-list", text: "/queue list" }));
    expect(channel.sent.at(-1)?.text).toContain("1. second task");
    expect(channel.sent.at(-1)?.text).toContain("2. third task");

    // Complete turn 1 -> drains second task and third task in FIFO order
    releaseTurn1?.();
    await p1;

    expect(backend.turnCalls.map((c) => c.text)).toEqual([
      "first task",
      "second task",
      "third task",
    ]);

    // Verify /steer while busy cancels active turn, clears old queue, and redirects
    let releaseSteerTurn: (() => void) | undefined;
    let signalSteerStarted: (() => void) | undefined;
    const steerStarted = new Promise<void>((resolve) => {
      signalSteerStarted = resolve;
    });
    let steerTurnCount = 0;
    backend.turnHandler = async (input) => {
      steerTurnCount += 1;
      if (steerTurnCount === 1) {
        signalSteerStarted?.();
        await new Promise<void>((resolve) => {
          releaseSteerTurn = resolve;
        });
        return { sessionId: "sess-steer-1", text: "", stopReason: "cancelled" };
      }
      return { sessionId: "sess-steer-1", text: `Steered: ${input.text}`, stopReason: "end_turn" };
    };

    const pSteer = router.handleInbound(makeInbound({ id: "t-s1", text: "old direction" }));
    await steerStarted;

    await router.handleInbound(makeInbound({ id: "q-stale", text: "stale queued" }));
    await router.handleInbound(makeInbound({ id: "cmd-steer", text: "/steer new direction" }));
    expect(channel.sent.at(-1)?.text).toContain("Redirecting active turn");

    releaseSteerTurn?.();
    await pSteer;
    expect(channel.sent.at(-1)?.text).toContain("Steered: new direction");
    expect(backend.turnCalls.at(-1)?.text).toBe("new direction");
    expect(backend.getQueue("+15550001111")).toEqual([]);

    // Verify /new while busy cancels turn and does NOT resurrect deleted session
    let releaseCancelledTurn: (() => void) | undefined;
    let signalCancelStarted: (() => void) | undefined;
    const cancelStarted = new Promise<void>((resolve) => {
      signalCancelStarted = resolve;
    });
    backend.turnHandler = async () => {
      signalCancelStarted?.();
      await new Promise<void>((resolve) => {
        releaseCancelledTurn = resolve;
      });
      return {
        sessionId: "sess-old-zombie",
        text: "",
        stopReason: "cancelled",
      };
    };

    const pCancelled = router.handleInbound(makeInbound({ id: "t-cancel", text: "long work" }));
    await cancelStarted;

    await router.handleInbound(makeInbound({ id: "cmd-new", text: "/new" }));
    expect(backend.cancelledChats).toContain("+15550001111");
    expect(channel.sent.at(-1)?.text).toContain("Started a fresh session");

    releaseCancelledTurn?.();
    await pCancelled;
    expect(store.getSession("+15550001111")).toBeUndefined();
  });

  it("extracts safe MEDIA:<path> attachments and blocks secrets or traversal outside cwd", async () => {
    const { cwdDir, channel, backend, router } = await setupRouter();
    const safeFile = path.join(cwdDir, "report.png");
    await fs.writeFile(safeFile, "png");

    backend.turnHandler = async () => ({
      sessionId: "sess-media",
      text: [
        "Report ready.",
        "MEDIA:report.png",
        "MEDIA:.env",
        "MEDIA:../outside.txt",
        "MEDIA:keys/private.key",
      ].join("\n"),
      stopReason: "end_turn",
    });

    await router.handleInbound(makeInbound({ text: "generate report" }));
    const outbound = channel.sent.at(-1);
    expect(outbound?.text).toBe("Report ready.");
    expect(outbound?.attachments).toEqual([{ path: path.resolve(cwdDir, "report.png") }]);
  });
});

describe("HealthServer", () => {
  it("binds ephemeral localhost port and serves /healthz, sanitized /status, 404, and 405", async () => {
    let currentStatus: "ok" | "degraded" = "ok";
    const health = new HealthServer(
      { healthHost: "127.0.0.1", healthPort: 0 },
      () => ({
        status: currentStatus,
        startedAt: 1000,
        uptimeMs: 5000,
        channelConnected: currentStatus === "ok",
        activeSessions: 2,
        activeTurns: 1,
        pendingPermissions: 0,
        activeLoops: 1,
      }),
    );

    await health.start();
    try {
      const port = health.getPort();
      expect(port).toBeTypeOf("number");
      expect(port).toBeGreaterThan(0);

      const base = `http://127.0.0.1:${port}`;

      const okRes = await fetch(`${base}/healthz`);
      expect(okRes.status).toBe(200);
      expect(await okRes.json()).toEqual({
        ok: true,
        status: "ok",
        uptimeMs: 5000,
        channelConnected: true,
      });

      currentStatus = "degraded";
      const degRes = await fetch(`${base}/healthz`);
      expect(degRes.status).toBe(503);
      expect(await degRes.json()).toEqual({
        ok: false,
        status: "degraded",
        uptimeMs: 5000,
        channelConnected: false,
      });

      const statusRes = await fetch(`${base}/status`);
      expect(statusRes.status).toBe(200);
      const statusBody = (await statusRes.json()) as Record<string, unknown>;
      expect(statusBody.status).toBe("degraded");
      expect(statusBody.activeSessions).toBe(2);
      expect(JSON.stringify(statusBody)).not.toContain("secret");
      expect(JSON.stringify(statusBody)).not.toContain("allowedSenders");

      const notFoundRes = await fetch(`${base}/unknown-route`);
      expect(notFoundRes.status).toBe(404);

      const methodRes = await fetch(`${base}/healthz`, { method: "POST" });
      expect(methodRes.status).toBe(405);
    } finally {
      await health.stop();
    }
  });
});
