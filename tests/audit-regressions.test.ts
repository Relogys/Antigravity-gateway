import { createHmac } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeStoreSenderKey, type GatewayConfig } from "../src/config.js";
import { DiscordChannelAdapter } from "../src/channels/discord.js";
import { GoogleChatChannelAdapter } from "../src/channels/googlechat.js";
import { LineChannelAdapter } from "../src/channels/line.js";
import { TeamsChannelAdapter } from "../src/channels/teams.js";
import { readResponseWithinLimit } from "../src/channels/utils.js";
import { WebhookChannelAdapter } from "../src/channels/webhook.js";
import { WeComChannelAdapter } from "../src/channels/wecom.js";
import { WhatsAppChannelAdapter } from "../src/channels/whatsapp.js";
import { ZulipChannelAdapter } from "../src/channels/zulip.js";
import {
  GatewayRouter,
  type ExtendedAgentBackend,
  type ExtendedChannelAdapter,
} from "../src/gateway/router.js";
import { LoopScheduler } from "../src/gateway/scheduler.js";
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
const stops: Array<() => Promise<unknown>> = [];

async function createTempDir(prefix = "agw-audit-"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const stop of stops.splice(0)) {
    await stop().catch(() => {});
  }
  vi.useRealTimers();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

function makeBaseConfig(
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
    geminiApiKey: "",
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
    logLevel: "error",
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

  async sendTyping(): Promise<void> {}
  async markRead(): Promise<void> {}
  async react(): Promise<void> {}
  getStats() {
    return {};
  }
}

class MockBackend implements ExtendedAgentBackend {
  turnCalls: AgentTurnInput[] = [];
  cancelledChats: string[] = [];
  resetChats: string[] = [];
  busyChats = new Set<string>();
  queues = new Map<string, string[]>();
  busyModes = new Map<string, BusyMode>();
  approvalModes = new Map<string, ApprovalMode>();
  sessions = new Map<string, SessionInfo>();
  pendingPerms = new Map<string, PendingPermission>();
  sessionSeq = 0;
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
      return { sessionId, text: `Echo: ${input.text}`, stopReason: "end_turn" };
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
    return [];
  }

  async attachSession(chatId: string, sessionId: string, cwd: string): Promise<void> {
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

  async setModel(chatId: string, modelInput: string) {
    await this.setConfigOption(chatId, "model", modelInput.trim());
    return { model: modelInput.trim() };
  }

  async setEffort(chatId: string, effort: string): Promise<void> {
    await this.setConfigOption(chatId, "thought_level", effort);
  }

  getAvailableModels(): string[] {
    return ["gemini-4-neon-high"];
  }
  getAvailableEfforts(): string[] {
    return ["low", "medium", "high"];
  }
  getAvailableModes(): string[] {
    return ["default", "auto"];
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
    const len = this.queues.get(chatId)?.length ?? 0;
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
  resolvePermission(): boolean {
    return false;
  }
  getSessionInfo(chatId: string): SessionInfo | undefined {
    return this.sessions.get(chatId);
  }
  getStats() {
    return {
      activeSessions: this.sessions.size,
      activeTurns: this.busyChats.size,
      pendingPermissions: this.pendingPerms.size,
    };
  }
}

async function setupRouter(configOverrides: Partial<GatewayConfig> = {}) {
  const rootDir = await createTempDir();
  const dataDir = path.join(rootDir, "data");
  const cwdDir = path.join(rootDir, "workspace");
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(cwdDir, { recursive: true });

  const config = makeBaseConfig(dataDir, cwdDir, configOverrides);
  const store = new GatewayStore(dataDir);
  await store.load();
  const channel = new MockChannel();
  const backend = new MockBackend();
  const scheduler = new LoopScheduler({ store, channel });
  const quota: QuotaSummary = {
    available: true,
    fetchedAt: Date.now(),
    groups: [],
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

function httpRequest(options: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  agent?: http.Agent | false;
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: options.port,
        method: options.method,
        path: options.path,
        headers: options.headers,
        agent: options.agent ?? false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}

describe("Audit security & store regressions", () => {
  it("prevents Photon ;-; prefix stripping from colliding with channel-prefixed sender keys", async () => {
    expect(normalizeStoreSenderKey("iMessage;-;+1 (555) 123-4567")).toBe("+15551234567");
    expect(normalizeStoreSenderKey("webhook:evil;-;+15551234567")).toBe(
      "webhook:evil;-;+15551234567",
    );
    expect(normalizeStoreSenderKey("slack:U01ABC")).toBe("slack:u01abc");

    const dataDir = await createTempDir();
    const store = new GatewayStore(dataDir);
    await store.load();

    await store.addApprovedSender("+15551234567");
    expect(store.isApprovedSender("iMessage;-;+15551234567")).toBe(true);
    expect(store.isApprovedSender("webhook:evil;-;+15551234567")).toBe(false);

    const pairing = await store.createOrGetPairing("discord:UserOne");
    expect(pairing.code).toBeTruthy();

    const wrong = await store.approvePairing("00000000");
    expect(wrong.ok).toBe(false);

    const ok = await store.approvePairing(pairing.code!.toLowerCase());
    expect(ok).toEqual({
      ok: true,
      senderId: "discord:userone",
      reason: "approved",
    });
    expect(store.isApprovedSender("discord:USERONE")).toBe(true);
    expect(store.isApprovedSender("telegram:userone")).toBe(false);

    expect(await store.revokeApprovedSender("discord:UserOne")).toBe(true);
    expect(store.isApprovedSender("discord:userone")).toBe(false);
    expect(store.isApprovedSender("+15551234567")).toBe(true);
  });
});

describe("Audit GatewayRouter regressions", () => {
  it("enforces chatId ownership on /loop pause, resume, and rm", async () => {
    const { store, scheduler, router, channel } = await setupRouter({
      allowedSenders: new Set(["+15550001111", "+15550002222"]),
    });

    const job = await scheduler.addLoop({
      chatId: "+15550001111",
      prompt: "owner task",
      intervalMs: 60_000,
    });

    for (const action of ["pause", "resume", "rm"]) {
      channel.sent.length = 0;
      await router.handleInbound(
        makeInbound({
          chatId: "+15550002222",
          senderId: "+15550002222",
          text: `/loop ${action} ${job.id}`,
        }),
      );
      expect(channel.sent.at(-1)?.text).toContain(`Loop [${job.id}] not found.`);
      const persisted = store.getLoops().find((l) => l.id === job.id);
      expect(persisted?.enabled).toBe(true);
    }

    await router.handleInbound(
      makeInbound({
        chatId: "+15550001111",
        senderId: "+15550001111",
        text: `/loop rm ${job.id}`,
      }),
    );
    expect(store.getLoops().find((l) => l.id === job.id)).toBeUndefined();
  });

  it("persists approvalMode and busyMode across router restarts", async () => {
    const { dataDir, cwdDir, config, store, channel, router } = await setupRouter();

    await router.handleInbound(makeInbound({ text: "/yolo" }));
    expect(store.getSession("+15550001111")?.approvalMode).toBe("auto");

    await router.handleInbound(makeInbound({ text: "/busy steer" }));
    expect(store.getSession("+15550001111")?.busyMode).toBe("steer");

    const reloadedStore = new GatewayStore(dataDir);
    await reloadedStore.load();
    const restartedBackend = new MockBackend();
    const restartedScheduler = new LoopScheduler({ store: reloadedStore, channel });
    const restartedRouter = new GatewayRouter({
      config: makeBaseConfig(dataDir, cwdDir, { allowedSenders: config.allowedSenders }),
      channel,
      backend: restartedBackend,
      store: reloadedStore,
      scheduler: restartedScheduler,
      quotaFetcher: async () => ({ available: true, fetchedAt: Date.now(), groups: [] }),
    });
    restartedRouter.markReady();

    await restartedRouter.handleInbound(makeInbound({ text: "hello after restart" }));
    expect(restartedBackend.turnCalls).toHaveLength(1);
    expect(restartedBackend.turnCalls[0]?.approvalMode).toBe("auto");
    expect(restartedBackend.getBusyMode("+15550001111")).toBe("steer");
    expect(reloadedStore.getSession("+15550001111")?.approvalMode).toBe("auto");
    expect(reloadedStore.getSession("+15550001111")?.busyMode).toBe("steer");
  });

  it("drains a prompt queued right after /new before the cancelled turn resolves", async () => {
    const { backend, router } = await setupRouter();

    let releaseTurn1!: () => void;
    let turn1Started!: () => void;
    const turn1StartedPromise = new Promise<void>((r) => {
      turn1Started = r;
    });

    backend.turnHandler = async (input) => {
      if (input.text === "first turn") {
        turn1Started();
        await new Promise<void>((resolve) => {
          releaseTurn1 = resolve;
        });
        return { sessionId: "sess-old", text: "cancelled", stopReason: "cancelled" };
      }
      return { sessionId: "sess-fresh", text: `Fresh: ${input.text}`, stopReason: "end_turn" };
    };

    const firstTurnPromise = router.handleInbound(makeInbound({ text: "first turn" }));
    await turn1StartedPromise;

    await router.handleInbound(makeInbound({ text: "/new" }));
    await router.handleInbound(makeInbound({ text: "prompt after new" }));

    releaseTurn1();
    await firstTurnPromise;

    expect(backend.turnCalls.map((t) => t.text)).toEqual(["first turn", "prompt after new"]);
    expect(backend.turnCalls[1]?.sessionId).toBeUndefined();
  });

  it("serializes concurrent initial DM inbound messages cleanly", async () => {
    const { backend, router } = await setupRouter();

    let releaseTurn1!: () => void;
    let turn1Entered!: () => void;
    const turn1EnteredPromise = new Promise<void>((r) => {
      turn1Entered = r;
    });
    let activeCalls = 0;
    let maxConcurrent = 0;

    backend.turnHandler = async (input) => {
      activeCalls += 1;
      maxConcurrent = Math.max(maxConcurrent, activeCalls);
      try {
        if (input.text === "msg one") {
          turn1Entered();
          await new Promise<void>((r) => {
            releaseTurn1 = r;
          });
        }
        return { sessionId: "sess-dm", text: `OK: ${input.text}`, stopReason: "end_turn" };
      } finally {
        activeCalls -= 1;
      }
    };

    const p1 = router.handleInbound(makeInbound({ text: "msg one" }));
    await turn1EnteredPromise;

    const p2 = router.handleInbound(makeInbound({ text: "msg two" }));
    await p2;
    expect(maxConcurrent).toBe(1);
    expect(backend.turnCalls).toHaveLength(1);

    releaseTurn1();
    await p1;

    expect(maxConcurrent).toBe(1);
    expect(backend.turnCalls.map((t) => t.text)).toEqual(["msg one", "msg two"]);
  });

  it("strips non-ASCII/CJK group mention patterns", async () => {
    const { backend, router } = await setupRouter({
      allowGroups: true,
      groupMentionPatterns: ["@助手"],
    });

    await router.handleInbound(
      makeInbound({
        chatId: "group-1",
        isGroup: true,
        mentionsBot: true,
        text: "@助手 run tests",
      }),
    );

    expect(backend.turnCalls).toHaveLength(1);
    expect(backend.turnCalls[0]?.text).toBe("run tests");
  });
});

describe("Audit HTTP & webhook hardening regressions", () => {
  it("refuses non-loopback binding on callback adapters without verification secrets", async () => {
    const dataDir = await createTempDir();
    const base = makeBaseConfig(dataDir, dataDir);

    const wa = new WhatsAppChannelAdapter({
      ...base,
      whatsapp: {
        enabled: true,
        accessToken: "wa-tok",
        phoneNumberId: "12345",
        verifyToken: "vt",
        appSecret: "",
        apiVersion: "v21.0",
        webhookHost: "0.0.0.0",
        webhookPort: 0,
        webhookPath: "/whatsapp/webhook",
        allowedUsers: new Set(),
      },
    });
    await expect(wa.start(async () => {})).rejects.toThrow(/WHATSAPP_APP_SECRET/i);

    const teams = new TeamsChannelAdapter({
      ...base,
      teams: {
        enabled: true,
        webhookSecret: "",
        appId: "",
        appPassword: "",
        tenantId: "botframework.com",
        incomingWebhookUrl: "",
        webhookHost: "0.0.0.0",
        webhookPort: 0,
        webhookPath: "/teams/messages",
        allowedUsers: new Set(),
      },
    });
    await expect(teams.start(async () => {})).rejects.toThrow(/TEAMS_WEBHOOK_SECRET/i);

    const gchat = new GoogleChatChannelAdapter({
      ...base,
      googlechat: {
        enabled: true,
        webhookUrl: "",
        accessToken: "",
        verificationToken: "",
        webhookHost: "0.0.0.0",
        webhookPort: 0,
        webhookPath: "/googlechat/events",
        allowedUsers: new Set(),
      },
    });
    await expect(gchat.start(async () => {})).rejects.toThrow(/GOOGLECHAT_VERIFICATION_TOKEN/i);

    const wecom = new WeComChannelAdapter({
      ...base,
      wecom: {
        corpId: "ww123",
        agentId: 1000002,
        secret: "wecom-sec",
        token: "",
        encodingAesKey: "",
        host: "0.0.0.0",
        port: 0,
        allowedUsers: new Set(),
      },
    });
    await expect(wecom.start(async () => {})).rejects.toThrow(/WECOM_TOKEN/i);

    const webhook = new WebhookChannelAdapter({
      ...base,
      webhook: {
        enabled: true,
        host: "0.0.0.0",
        port: 0,
        allowedUsers: new Set(),
      },
    });
    await expect(webhook.start(async () => {})).rejects.toThrow(/WEBHOOK_TOKEN/i);
  });

  it("fails closed (401) on WhatsApp, Teams, and Google Chat inbound POSTs without secrets even on loopback", async () => {
    const dataDir = await createTempDir();
    const base = makeBaseConfig(dataDir, dataDir);

    const wa = new WhatsAppChannelAdapter({
      ...base,
      whatsapp: {
        enabled: true,
        accessToken: "wa-tok",
        phoneNumberId: "12345",
        verifyToken: "vt",
        appSecret: "",
        apiVersion: "v21.0",
        webhookHost: "127.0.0.1",
        webhookPort: 0,
        webhookPath: "/whatsapp/webhook",
        allowedUsers: new Set(),
      },
    });
    await wa.start(async () => {});
    stops.push(() => wa.stop());
    const waRes = await httpRequest({
      port: wa.getPort()!,
      method: "POST",
      path: "/whatsapp/webhook",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entry: [] }),
    });
    expect(waRes.status).toBe(401);

    const teams = new TeamsChannelAdapter({
      ...base,
      teams: {
        enabled: true,
        webhookSecret: "",
        appId: "",
        appPassword: "",
        tenantId: "botframework.com",
        incomingWebhookUrl: "",
        webhookHost: "127.0.0.1",
        webhookPort: 0,
        webhookPath: "/teams/messages",
        allowedUsers: new Set(),
      },
    });
    await teams.start(async () => {});
    stops.push(() => teams.stop());
    const teamsRes = await httpRequest({
      port: teams.getPort()!,
      method: "POST",
      path: "/teams/messages",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "message", text: "hi" }),
    });
    expect(teamsRes.status).toBe(401);

    const gchat = new GoogleChatChannelAdapter({
      ...base,
      googlechat: {
        enabled: true,
        webhookUrl: "",
        accessToken: "",
        verificationToken: "",
        webhookHost: "127.0.0.1",
        webhookPort: 0,
        webhookPath: "/googlechat/events",
        allowedUsers: new Set(),
      },
    });
    await gchat.start(async () => {});
    stops.push(() => gchat.stop());
    const gchatRes = await httpRequest({
      port: gchat.getPort()!,
      method: "POST",
      path: "/googlechat/events",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "MESSAGE" }),
    });
    expect(gchatRes.status).toBe(401);
  });

  it("deduplicates Google Chat deliveries sharing message.name", async () => {
    const dataDir = await createTempDir();
    const base = makeBaseConfig(dataDir, dataDir);
    const seen: InboundMessage[] = [];
    const gchat = new GoogleChatChannelAdapter({
      ...base,
      googlechat: {
        enabled: true,
        webhookUrl: "",
        accessToken: "",
        verificationToken: "gchat-verify-tok",
        webhookHost: "127.0.0.1",
        webhookPort: 0,
        webhookPath: "/googlechat/events",
        allowedUsers: new Set(),
      },
    });
    await gchat.start(async (msg) => {
      seen.push(msg);
    });
    stops.push(() => gchat.stop());

    const payload = JSON.stringify({
      type: "MESSAGE",
      token: "gchat-verify-tok",
      space: { name: "spaces/AAA123", type: "DM" },
      message: {
        name: "spaces/AAA123/messages/dup-1",
        sender: { name: "users/1001" },
        text: "hello once",
      },
    });

    for (let i = 0; i < 2; i += 1) {
      const res = await httpRequest({
        port: gchat.getPort()!,
        method: "POST",
        path: "/googlechat/events",
        headers: { "content-type": "application/json" },
        body: payload,
      });
      expect(res.status).toBe(200);
    }
    await vi.waitFor(() => {
      expect(seen).toHaveLength(1);
    });
    expect(seen[0]?.text).toBe("hello once");
  });

  it("handles out-of-range numeric XML entities in WeCom without throwing", async () => {
    const dataDir = await createTempDir();
    const base = makeBaseConfig(dataDir, dataDir);
    const seen: InboundMessage[] = [];
    const wecom = new WeComChannelAdapter({
      ...base,
      wecom: {
        corpId: "ww123",
        agentId: 1000002,
        secret: "wecom-sec",
        host: "127.0.0.1",
        port: 0,
        allowedUsers: new Set(),
      },
    });
    await wecom.start(async (msg) => {
      seen.push(msg);
    });
    stops.push(() => wecom.stop());

    const xml =
      "<xml><ToUserName><![CDATA[ww123]]></ToUserName><FromUserName><![CDATA[alice]]></FromUserName>" +
      "<MsgType><![CDATA[text]]></MsgType><Content>hi &#99999999; &#x10FFFFF;</Content><MsgId>wc-1</MsgId></xml>";

    const res = await httpRequest({
      port: wecom.getPort()!,
      method: "POST",
      path: "/wecom/callback",
      headers: { "content-type": "application/xml" },
      body: xml,
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.text).toContain("hi");
  });

  it("cancels pending wait:true Webhook requests cleanly on stop()", async () => {
    const dataDir = await createTempDir();
    const base = makeBaseConfig(dataDir, dataDir);
    const webhook = new WebhookChannelAdapter({
      ...base,
      webhook: {
        enabled: true,
        host: "127.0.0.1",
        port: 0,
        token: "wh-tok",
        allowedUsers: new Set(),
      },
    });

    let handlerCalled!: () => void;
    const handlerEntered = new Promise<void>((r) => {
      handlerCalled = r;
    });
    await webhook.start(async () => {
      handlerCalled();
    });
    stops.push(() => webhook.stop());

    const reqPromise = httpRequest({
      port: webhook.getPort()!,
      method: "POST",
      path: "/v1/messages",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wh-tok",
      },
      body: JSON.stringify({
        chatId: "wh-chat-1",
        text: "wait forever unless cancelled",
        wait: true,
        timeoutMs: 600_000,
      }),
    });

    await handlerEntered;
    const startedStop = Date.now();
    const [reqOutcome] = await Promise.all([Promise.allSettled([reqPromise]), webhook.stop()]);
    expect(Date.now() - startedStop).toBeLessThan(2000);
    if (reqOutcome[0]?.status === "fulfilled") {
      expect(reqOutcome[0].value.status).toBe(200);
      expect(JSON.parse(reqOutcome[0].value.text)).toMatchObject({ ok: true, timedOut: true });
    }
  });

  it("returns 400 on malformed HealthServer request URLs and closes keep-alive sockets quickly", async () => {
    const health = new HealthServer(
      { healthHost: "127.0.0.1", healthPort: 0 },
      () => ({
        status: "ok",
        startedAt: Date.now(),
        uptimeMs: 10,
        channelConnected: true,
        activeSessions: 0,
        activeTurns: 0,
        pendingPermissions: 0,
        activeLoops: 0,
      }),
    );
    await health.start();
    stops.push(() => health.stop());

    const port = health.getPort()!;
    const rawResponse = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(port, "127.0.0.1", () => {
        sock.write("GET http://[invalid HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
      });
      const chunks: Buffer[] = [];
      sock.on("data", (d) => chunks.push(d));
      sock.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      sock.on("error", reject);
    });
    expect(rawResponse).toMatch(/^HTTP\/1\.1 400 /);

    const agent = new http.Agent({ keepAlive: true });
    try {
      const okRes = await httpRequest({
        port,
        method: "GET",
        path: "/healthz",
        agent,
      });
      expect(okRes.status).toBe(200);
      const stopStart = Date.now();
      await health.stop();
      expect(Date.now() - stopStart).toBeLessThan(1000);
    } finally {
      agent.destroy();
    }
  });

  it("rejects oversized Content-Length requests with 413 and connection: close", async () => {
    const dataDir = await createTempDir();
    const base = makeBaseConfig(dataDir, dataDir);
    const webhook = new WebhookChannelAdapter(
      {
        ...base,
        webhook: {
          enabled: true,
          host: "127.0.0.1",
          port: 0,
          token: "wh-tok",
          allowedUsers: new Set(),
        },
      },
      { maxBodyBytes: 64 },
    );
    await webhook.start(async () => {});
    stops.push(() => webhook.stop());

    const res = await httpRequest({
      port: webhook.getPort()!,
      method: "POST",
      path: "/v1/messages",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wh-tok",
        "content-length": "512",
      },
    });
    expect(res.status).toBe(413);
    expect(res.headers.connection).toBe("close");
  });
});

describe("Audit adapter & utility regressions", () => {
  it("ignores Zulip stream @**OtherUser** pills when requireMention is true", async () => {
    const dataDir = await createTempDir();
    const base = makeBaseConfig(dataDir, dataDir);
    let pollStep = 0;

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/v1/register")) {
        return new Response(
          JSON.stringify({
            result: "success",
            queue_id: "q-1",
            last_event_id: 0,
            full_name: "Gateway Bot",
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/v1/events")) {
        pollStep += 1;
        if (pollStep === 1) {
          return new Response(
            JSON.stringify({
              result: "success",
              events: [
                {
                  id: 1,
                  type: "message",
                  message: {
                    id: 101,
                    type: "stream",
                    sender_email: "alice@example.org",
                    display_recipient: "general",
                    subject: "topic",
                    content: "@**OtherUser** check this",
                    timestamp: 1700000000,
                  },
                },
                {
                  id: 2,
                  type: "message",
                  message: {
                    id: 102,
                    type: "stream",
                    sender_email: "alice@example.org",
                    display_recipient: "general",
                    subject: "topic",
                    content: "@**Gateway Bot** status please",
                    timestamp: 1700000001,
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Promise((_resolve, reject) => {
          const abort = () => reject(new DOMException("Aborted", "AbortError"));
          if (init?.signal?.aborted) {
            abort();
            return;
          }
          init?.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      return new Response(JSON.stringify({ result: "success" }), { status: 200 });
    };

    const zulip = new ZulipChannelAdapter(
      {
        ...base,
        zulip: {
          enabled: true,
          site: "https://zulip.example.test",
          botEmail: "gateway-bot@zulip.example.test",
          apiKey: "zulip-test-key",
          streams: ["general"],
          requireMention: true,
          allowedUsers: new Set(),
        },
      },
      { fetchImpl },
    );

    const inbound: InboundMessage[] = [];
    await zulip.start(async (msg) => {
      inbound.push(msg);
    });
    stops.push(() => zulip.stop());

    await vi.waitFor(() => {
      expect(inbound).toHaveLength(1);
    });
    expect(inbound[0]?.id).toBe("102");
    expect(inbound[0]?.text).toBe("status please");
    expect(inbound[0]?.mentionsBot).toBe(true);
  });

  it("aborts and rejects chunked downloads exceeding readResponseWithinLimit without Content-Length", async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(60));
        c.enqueue(new Uint8Array(60));
        c.close();
      },
    });
    const res = new Response(stream);

    await expect(readResponseWithinLimit(res, 100, controller)).rejects.toThrow(/exceeds 100 bytes/i);
    expect(controller.signal.aborted).toBe(true);
  });

  it("cleans up Discord client and ready timer when login() rejects", async () => {
    const dataDir = await createTempDir();
    const base = makeBaseConfig(dataDir, dataDir);
    let destroyed = false;

    const adapter = new DiscordChannelAdapter(
      {
        ...base,
        discord: {
          botToken: "discord-test-tok",
          allowedUsers: new Set(),
          allowGuilds: true,
          requireMention: true,
        },
      },
      {
        readyTimeoutMs: 60_000,
        clientFactory: () => ({
          user: null,
          channels: { fetch: async () => null },
          on() {
            return this;
          },
          once() {
            return this;
          },
          async login() {
            throw new Error("invalid token");
          },
          async destroy() {
            destroyed = true;
          },
          isReady: () => false,
        }),
      },
    );

    await expect(adapter.start(async () => {})).rejects.toThrow("invalid token");
    expect(destroyed).toBe(true);
    expect(adapter.isConnected()).toBe(false);
    await adapter.stop();
  });

  it("bounds LINE replyTokens cache across > 2000 unique chats", async () => {
    const dataDir = await createTempDir();
    const base = makeBaseConfig(dataDir, dataDir);
    const secret = "line-secret-for-bound-test";
    const sendUrls: string[] = [];

    const line = new LineChannelAdapter(
      {
        ...base,
        line: {
          channelAccessToken: "line-access-tok",
          channelSecret: secret,
          host: "127.0.0.1",
          port: 0,
          allowedUsers: new Set(),
        },
      },
      {
        fetchImpl: async (input) => {
          sendUrls.push(typeof input === "string" ? input : input.toString());
          return new Response(JSON.stringify({ sentMessages: [{ id: "m-out" }] }), {
            status: 200,
          });
        },
      },
    );

    const seen: InboundMessage[] = [];
    await line.start(async (msg) => {
      seen.push(msg);
    });
    stops.push(() => line.stop());

    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const total = 2050;
      for (let start = 0; start < total; start += 100) {
        const events = [];
        for (let i = start; i < Math.min(total, start + 100); i += 1) {
          events.push({
            type: "message",
            replyToken: `rt-${i}`,
            timestamp: Date.now(),
            source: { type: "user", userId: `U-${i}` },
            message: { id: `line-msg-${i}`, type: "text", text: "hi" },
          });
        }
        const raw = Buffer.from(JSON.stringify({ events }), "utf8");
        const sig = createHmac("sha256", secret).update(raw).digest("base64");
        const res = await httpRequest({
          port: line.getPort()!,
          method: "POST",
          path: "/line/webhook",
          headers: {
            "content-type": "application/json",
            "x-line-signature": sig,
          },
          body: raw,
          agent,
        });
        expect(res.status).toBe(200);
      }

      await vi.waitFor(() => {
        expect(seen).toHaveLength(total);
      });

      await line.sendMessage({ chatId: "U-0", text: "evicted" });
      await line.sendMessage({ chatId: "U-2049", text: "retained" });

      expect(sendUrls[0]).toContain("/v2/bot/message/push");
      expect(sendUrls[1]).toContain("/v2/bot/message/reply");
    } finally {
      agent.destroy();
    }
  });
});
