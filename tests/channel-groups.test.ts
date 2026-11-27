import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConversationSyncFromEnv } from "../src/acp/conversation-sync.js";
import type { GatewayConfig } from "../src/config.js";
import { BotLoopGuard } from "../src/gateway/guards.js";
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
  InboundMessage,
  OutboundMessage,
} from "../src/types.js";

const PHOTON_CHAT = "+15550001111";
const TELEGRAM_CHAT = "telegram::42";
const DISCORD_CHAT = "discord::99";
const DM_CHAT = "+15559998888";

const tempDirs: string[] = [];

async function createTempDir(prefix = "agw-wave9-"): Promise<string> {
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
  overrides: Partial<GatewayConfig> = {},
): GatewayConfig {
  return {
    allowedSenders: new Set([PHOTON_CHAT, "telegram:42", "discord:99", DM_CHAT]),
    allowGroups: false,
    groupMentionPatterns: ["@agy"],
    agyBin: "agy",
    defaultCwd: dataDir,
    channelDefaultCwds: {},
    ingressDebounceMs: 0,
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
    chatId: PHOTON_CHAT,
    senderId: PHOTON_CHAT,
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

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

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

  texts(): string[] {
    return this.sent.map((msg) => msg.text ?? "");
  }

  last(): string {
    return this.texts().at(-1) ?? "";
  }
}

class MockBackend implements ExtendedAgentBackend {
  turnCalls: AgentTurnInput[] = [];
  availableSessions: AcpSessionSummary[] = [
    { sessionId: "sess-acp-001", cwd: os.tmpdir(), title: "ACP One" },
  ];

  async stop(): Promise<void> {}

  async sendTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    this.turnCalls.push(input);
    return {
      sessionId: `sess-${input.chatId.replace(/[^a-z0-9]+/gi, "-")}`,
      text: `Echo: ${input.text}`,
      stopReason: "end_turn",
    };
  }

  async cancelTurn(): Promise<boolean> {
    return false;
  }

  async resetSession(): Promise<void> {}

  async listSessions(): Promise<AcpSessionSummary[]> {
    return [...this.availableSessions];
  }
}

interface SetupOptions {
  config?: Partial<GatewayConfig>;
  loopGuard?: BotLoopGuard;
}

async function setupRouter(options: SetupOptions = {}) {
  const dataDir = await createTempDir();
  const store = new GatewayStore(dataDir);
  await store.load();
  const channel = new MockChannel();
  const backend = new MockBackend();
  const scheduler = new LoopScheduler({ store, channel });
  const config = makeConfig(dataDir, options.config);
  const router = new GatewayRouter({
    config,
    channel,
    backend,
    store,
    scheduler,
    loopGuard: options.loopGuard,
    quotaFetcher: async () => ({ available: false, fetchedAt: Date.now(), groups: [] }),
  });
  router.markReady();
  return { dataDir, config, store, channel, backend, scheduler, router };
}

async function seedThreeChannels(router: GatewayRouter): Promise<void> {
  await router.handleInbound(makeInbound({ text: "photon hello" }));
  await router.handleInbound(
    makeInbound({
      channel: "telegram",
      chatId: TELEGRAM_CHAT,
      senderId: "42",
      text: "telegram hello",
    }),
  );
  await router.handleInbound(
    makeInbound({
      channel: "discord",
      chatId: DISCORD_CHAT,
      senderId: "99",
      text: "discord hello",
    }),
  );
}

describe("Strict per-IM-channel session grouping", () => {
  it("/sessions shows only the current channel group, while <channel> and all widen scope", async () => {
    const { channel, router } = await setupRouter();
    await seedThreeChannels(router);

    await router.handleInbound(makeInbound({ text: "/sessions" }));
    const current = channel.last();
    expect(current).toContain("📂 photon");
    expect(current).toContain(`• ${PHOTON_CHAT}`);
    expect(current).not.toContain(TELEGRAM_CHAT);
    expect(current).not.toContain(DISCORD_CHAT);
    expect(current).toContain("ACP sessions (use /resume <index|id>):");
    expect(current).toContain("1. sess-acp-0");
    expect(current).toContain(
      "Use /sessions all to list all channel groups, or /groups for summary.",
    );

    await router.handleInbound(makeInbound({ text: "/sessions telegram" }));
    const telegram = channel.last();
    expect(telegram).toContain("📂 telegram");
    expect(telegram).toContain(`• ${TELEGRAM_CHAT}`);
    expect(telegram).not.toContain(PHOTON_CHAT);
    expect(telegram).not.toContain(DISCORD_CHAT);
    expect(telegram).not.toContain("ACP sessions");

    await router.handleInbound(makeInbound({ text: "/sessions all" }));
    const all = channel.last();
    expect(all).toContain("📂 photon");
    expect(all).toContain("📂 telegram");
    expect(all).toContain("📂 discord");
    expect(all).toContain(PHOTON_CHAT);
    expect(all).toContain(TELEGRAM_CHAT);
    expect(all).toContain(DISCORD_CHAT);

    router.stop();
  });

  it("/groups summarizes every bound channel group and marks the current one", async () => {
    const { channel, router } = await setupRouter();
    await seedThreeChannels(router);

    await router.handleInbound(makeInbound({ text: "/groups" }));
    const reply = channel.last();
    expect(reply).toContain("📂 photon (this channel) — 1 session(s)");
    expect(reply).toContain("📂 telegram — 1 session(s)");
    expect(reply).toContain("📂 discord — 1 session(s)");

    await router.handleInbound(makeInbound({ text: "/groups -h" }));
    expect(channel.last()).toContain("Usage: /groups");

    router.stop();
  });
});

describe("/new with a grouped title", () => {
  it("assigns [photon] Sprint Planning to a fresh session without touching telegram", async () => {
    const { store, channel, router } = await setupRouter();
    await seedThreeChannels(router);

    const telegramBefore = store.getSession(TELEGRAM_CHAT);
    expect(telegramBefore?.sessionId).toBeTruthy();

    await router.handleInbound(makeInbound({ text: "/new Sprint Planning" }));
    expect(channel.last()).toContain("[photon] Sprint Planning");

    const fresh = store.getSession(PHOTON_CHAT);
    expect(fresh?.title).toBe("[photon] Sprint Planning");
    expect(fresh?.channelGroup).toBe("photon");
    expect(fresh?.sessionId).toBe("");

    const telegramAfter = store.getSession(TELEGRAM_CHAT);
    expect(telegramAfter?.title).toBe(telegramBefore?.title);
    expect(telegramAfter?.sessionId).toBe(telegramBefore?.sessionId);

    router.stop();
  });
});

describe("Per-channel default workspace", () => {
  it("resolves <CHANNEL>_CWD independently for photon and telegram", async () => {
    const photonCwd = path.join(os.tmpdir(), "workspace-photon");
    const telegramCwd = path.join(os.tmpdir(), "workspace-telegram");
    const { store, backend, router } = await setupRouter({
      config: { channelDefaultCwds: { photon: photonCwd, telegram: telegramCwd } },
    });

    await router.handleInbound(makeInbound({ text: "photon run" }));
    await router.handleInbound(
      makeInbound({
        channel: "telegram",
        chatId: TELEGRAM_CHAT,
        senderId: "42",
        text: "telegram run",
      }),
    );

    expect(backend.turnCalls[0]!.cwd).toBe(photonCwd);
    expect(backend.turnCalls[1]!.cwd).toBe(telegramCwd);
    expect(store.getSession(PHOTON_CHAT)?.cwd).toBe(photonCwd);
    expect(store.getSession(TELEGRAM_CHAT)?.cwd).toBe(telegramCwd);

    router.stop();
  });
});

describe("Official sidebar group sync", () => {
  it("sends the exact UpdateConversation payload when both env vars are set", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    const sync = createConversationSyncFromEnv(
      {
        ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:5000",
        ANTIGRAVITY_CSRF_TOKEN: "csrf-test-token",
      },
      fetchMock as unknown as typeof fetch,
    );
    expect(sync).toBeDefined();

    const ok = await sync!.syncSessionGroup({
      sessionId: "sess-1",
      channelGroup: "photon",
      title: "Hello",
    });
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "http://127.0.0.1:5000/product.v1.ConversationService/UpdateConversation",
    );
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Connect-Protocol-Version"]).toBe("1");
    expect(headers["x-antigravity-csrf-token"]).toBe("csrf-test-token");
    expect(JSON.parse(String(init.body))).toEqual({
      conversationId: "sess-1",
      annotations: {
        title: "Hello",
        tags: ["gateway", "channel:photon"],
        conversationGroupId: "gateway:photon",
      },
    });
  });

  it("omits the title when not provided", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    const sync = createConversationSyncFromEnv(
      {
        ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:5000",
        ANTIGRAVITY_CSRF_TOKEN: "csrf-test-token",
      },
      fetchMock as unknown as typeof fetch,
    );
    await sync!.syncSessionGroup({ sessionId: "sess-2", channelGroup: "telegram" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.annotations.title).toBeUndefined();
    expect(body.annotations.conversationGroupId).toBe("gateway:telegram");
    expect(body.annotations.tags).toEqual(["gateway", "channel:telegram"]);
  });

  it("stays disabled unless both env vars are present", () => {
    expect(createConversationSyncFromEnv({}, vi.fn() as unknown as typeof fetch)).toBeUndefined();
    expect(
      createConversationSyncFromEnv(
        { ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:5000" },
        vi.fn() as unknown as typeof fetch,
      ),
    ).toBeUndefined();
    expect(
      createConversationSyncFromEnv(
        { ANTIGRAVITY_CSRF_TOKEN: "csrf-test-token" },
        vi.fn() as unknown as typeof fetch,
      ),
    ).toBeUndefined();
  });

  it("swallows HTTP failures and thrown errors cleanly", async () => {
    const notOk = createConversationSyncFromEnv(
      {
        ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:5000",
        ANTIGRAVITY_CSRF_TOKEN: "csrf-test-token",
      },
      vi.fn(async () => ({ ok: false })) as unknown as typeof fetch,
    );
    await expect(
      notOk!.syncSessionGroup({ sessionId: "sess-3", channelGroup: "photon" }),
    ).resolves.toBe(false);

    const throwing = createConversationSyncFromEnv(
      {
        ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:5000",
        ANTIGRAVITY_CSRF_TOKEN: "csrf-test-token",
      },
      vi.fn(async () => {
        throw new Error("connection refused");
      }) as unknown as typeof fetch,
    );
    await expect(
      throwing!.syncSessionGroup({ sessionId: "sess-4", channelGroup: "photon" }),
    ).resolves.toBe(false);
  });
});

describe("Group-chat loop protection", () => {
  it("stops runaway group bursts after maxEvents while DMs keep working", async () => {
    const guard = new BotLoopGuard({ maxEvents: 3, windowMs: 60_000, cooldownMs: 60_000 });
    const { channel, router } = await setupRouter({
      config: { allowGroups: true },
      loopGuard: guard,
    });

    for (let i = 0; i < 5; i += 1) {
      await router.handleInbound(
        makeInbound({
          chatId: "photon::group-1",
          isGroup: true,
          mentionsBot: true,
          text: "/ping",
        }),
      );
    }

    const pongs = channel.texts().filter((text) => text.includes("🏓 Pong!"));
    expect(pongs).toHaveLength(3);

    await router.handleInbound(makeInbound({ chatId: DM_CHAT, text: "/ping" }));
    expect(channel.last()).toContain("🏓 Pong!");

    router.stop();
  });
});