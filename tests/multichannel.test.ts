import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MultiChannelHub,
  qualifyChatId,
  splitQualifiedChatId,
} from "../src/channels/hub.js";
import {
  BoundedDedupeCache,
  chunkText,
  isMentioned,
  saveInboundMedia,
} from "../src/channels/utils.js";
import {
  getEnabledChannelNames,
  loadConfig,
  senderKeyFor,
  type GatewayConfig,
} from "../src/config.js";
import { GatewayRouter } from "../src/gateway/router.js";
import { LoopScheduler } from "../src/gateway/scheduler.js";
import { GatewayStore } from "../src/gateway/store.js";
import type {
  AgentBackend,
  ChannelAdapter,
  InboundMessage,
  OutboundMessage,
} from "../src/types.js";

class FakeAdapter implements ChannelAdapter {
  connected = false;
  sent: OutboundMessage[] = [];
  typing: Array<{ chatId: string; active: boolean }> = [];
  reactions: string[] = [];
  handler?: (msg: InboundMessage) => Promise<void> | void;

  constructor(
    readonly name: string,
    private readonly failStart = false,
  ) {}

  async start(onMessage: (msg: InboundMessage) => Promise<void> | void): Promise<void> {
    if (this.failStart) {
      throw new Error("boom");
    }
    this.handler = onMessage;
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
    return { messageId: `${this.name}-${this.sent.length}` };
  }
  async sendTyping(chatId: string, active: boolean): Promise<void> {
    this.typing.push({ chatId, active });
  }
  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    this.reactions.push(`${chatId}|${messageId}|${emoji}`);
  }
}

function inbound(channel: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: `m-${Math.random().toString(36).slice(2, 8)}`,
    channel,
    chatId: "chat-1",
    senderId: "user-1",
    isGroup: false,
    text: "hello",
    attachments: [],
    timestamp: Date.now(),
    mentionsBot: true,
    ...overrides,
  };
}

describe("chat id helpers", () => {
  it("qualifies and splits at the first separator", () => {
    expect(qualifyChatId("telegram", "42")).toBe("telegram::42");
    expect(splitQualifiedChatId("telegram::42")).toEqual({ channel: "telegram", chatId: "42" });
    expect(splitQualifiedChatId("photon::any;-;x@y.z")).toEqual({
      channel: "photon",
      chatId: "any;-;x@y.z",
    });
    expect(splitQualifiedChatId("a::b::c")).toEqual({ channel: "a", chatId: "b::c" });
    expect(splitQualifiedChatId("plain")).toEqual({ chatId: "plain" });
    expect(splitQualifiedChatId("Bad Prefix::x")).toEqual({ chatId: "Bad Prefix::x" });
  });
});

describe("MultiChannelHub", () => {
  it("namespaces inbound ids and routes outbound calls to the owning adapter", async () => {
    const tg = new FakeAdapter("telegram");
    const dc = new FakeAdapter("discord");
    const hub = new MultiChannelHub([tg, dc], { log: () => {} });
    const received: InboundMessage[] = [];
    await hub.start((m) => {
      received.push(m);
    });

    tg.handler?.(inbound("telegram", { chatId: "42" }));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({ channel: "telegram", chatId: "telegram::42" });

    await hub.sendMessage({ chatId: "discord::9", text: "hi" });
    await hub.sendTyping("telegram::42", true);
    await hub.react("discord::9", "mid", "👍");
    expect(dc.sent).toEqual([{ chatId: "9", text: "hi" }]);
    expect(tg.sent).toHaveLength(0);
    expect(tg.typing).toEqual([{ chatId: "42", active: true }]);
    expect(dc.reactions).toEqual(["9|mid|👍"]);

    await expect(hub.sendMessage({ chatId: "unqualified", text: "x" })).rejects.toThrow(
      /Cannot route/,
    );
    await expect(hub.sendMessage({ chatId: "slack::1", text: "x" })).rejects.toThrow(
      /Unknown channel/,
    );

    expect(hub.listChannelNames()).toEqual(["telegram", "discord"]);
    expect(hub.getAdapter("discord")).toBe(dc);
    const snaps = hub.getChannelSnapshots();
    expect(snaps.telegram?.connected).toBe(true);
    expect(snaps.discord?.lastOutboundAt).toBeTypeOf("number");

    await hub.stop();
    expect(hub.isConnected()).toBe(false);
  });

  it("falls back to the only adapter (or defaultChannel) for unqualified ids", async () => {
    const solo = new FakeAdapter("telegram");
    const hubSolo = new MultiChannelHub([solo], { log: () => {} });
    await hubSolo.start(() => {});
    await hubSolo.sendMessage({ chatId: "raw-id", text: "a" });
    expect(solo.sent[0]?.chatId).toBe("raw-id");

    const a = new FakeAdapter("photon");
    const b = new FakeAdapter("telegram");
    const hub = new MultiChannelHub([a, b], { defaultChannel: "photon", log: () => {} });
    await hub.start(() => {});
    await hub.sendMessage({ chatId: "any;-;+15550001111", text: "legacy" });
    expect(a.sent[0]?.chatId).toBe("any;-;+15550001111");
  });

  it("isolates start failures per channel", async () => {
    const good = new FakeAdapter("telegram");
    const bad = new FakeAdapter("discord", true);
    const logs: string[] = [];
    const hub = new MultiChannelHub([good, bad], { log: (m) => logs.push(m) });
    await hub.start(() => {});
    expect(good.isConnected()).toBe(true);
    const snaps = hub.getChannelSnapshots();
    expect(snaps.discord).toMatchObject({ connected: false, lastError: "boom" });
    expect(logs.join("\n")).toContain('"discord" failed to start');
    expect(hub.isConnected()).toBe(true);
  });
});

describe("channel utils", () => {
  it("chunkText respects the limit and prefers natural boundaries", () => {
    expect(chunkText("   ", 10)).toEqual([]);
    expect(chunkText("short", 10)).toEqual(["short"]);
    const text = `${"a".repeat(40)}\n\n${"b".repeat(40)}`;
    const chunks = chunkText(text, 50);
    expect(chunks).toEqual(["a".repeat(40), "b".repeat(40)]);
    const long = chunkText("x".repeat(250), 100);
    expect(long.every((c) => c.length <= 100)).toBe(true);
    expect(long.join("")).toBe("x".repeat(250));
    const words = chunkText("one two three four five six seven", 12);
    expect(words.every((c) => c.length <= 12)).toBe(true);
    expect(words.join(" ")).toBe("one two three four five six seven");
  });

  it("isMentioned matches case-insensitively", () => {
    expect(isMentioned("Hey @AGY help", ["@agy"])).toBe(true);
    expect(isMentioned("hello", ["@agy", ""])).toBe(false);
  });

  it("BoundedDedupeCache dedupes, expires, and bounds size", () => {
    const cache = new BoundedDedupeCache({ maxEntries: 2, ttlMs: 1000 });
    expect(cache.seen("a", 0)).toBe(false);
    expect(cache.seen("a", 10)).toBe(true);
    cache.seen("b", 20);
    cache.seen("c", 30);
    expect(cache.size).toBe(2);
    expect(cache.seen("a", 40)).toBe(false);
    expect(cache.seen("c", 5000)).toBe(false);
  });

  it("saveInboundMedia sanitizes path segments", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agw-media-"));
    try {
      const saved = await saveInboundMedia(dir, "telegram", "../evil", "../../x y.png", Buffer.from("d"));
      expect(path.relative(dir, saved).startsWith("..")).toBe(false);
      expect(await fs.readFile(saved, "utf8")).toBe("d");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("multi-channel config", () => {
  it("enables channels only when credentials are present", () => {
    const empty = loadConfig({}, { loadDotenv: false });
    expect(getEnabledChannelNames(empty)).toEqual([]);

    const cfg = loadConfig(
      {
        SPECTRUM_PROJECT_ID: "pid",
        SPECTRUM_PROJECT_SECRET: "psecret",
        TELEGRAM_BOT_TOKEN: "tok",
        TELEGRAM_ALLOWED_USERS: "123, ABC",
        TELEGRAM_POLL_TIMEOUT_SEC: "",
        SLACK_BOT_TOKEN: "xoxb-only-bot",
        FEISHU_APP_ID: "id",
        FEISHU_APP_SECRET: "sec",
        FEISHU_DOMAIN: "LARK",
        ONEBOT_WS_URL: "ws://127.0.0.1:3001",
        WEBHOOK_ENABLED: "true",
        WEBHOOK_TOKEN: "t",
      },
      { loadDotenv: false },
    );
    expect(getEnabledChannelNames(cfg)).toEqual(["photon", "telegram", "feishu", "onebot", "webhook"]);
    expect(cfg.slack).toBeUndefined();
    expect(cfg.telegram?.pollTimeoutSec).toBe(30);
    expect([...(cfg.telegram?.allowedUsers ?? [])]).toEqual(["123", "abc"]);
    expect(cfg.feishu?.domain).toBe("lark");
    expect(cfg.webhook).toMatchObject({ enabled: true, host: "127.0.0.1", port: 18791 });
    expect(() => loadConfig({ ONEBOT_WS_URL: "http://x" }, { loadDotenv: false })).toThrow(/ws/);
  });

  it("namespaces non-photon sender keys", () => {
    expect(senderKeyFor("photon", "any;-;+1 (555) 000-1111")).toBe("+15550001111");
    expect(senderKeyFor("telegram", " 15550001111 ")).toBe("telegram:15550001111");
  });
});

describe("router multi-channel auth", () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    while (tempDirs.length) {
      await fs.rm(tempDirs.pop()!, { recursive: true, force: true }).catch(() => {});
    }
  });

  class EchoBackend implements AgentBackend {
    turns: string[] = [];
    async stop() {}
    async sendTurn(input: { text: string }) {
      this.turns.push(input.text);
      return { sessionId: "s1", text: `Echo: ${input.text}`, stopReason: "end_turn" };
    }
    async cancelTurn() {
      return false;
    }
    async resetSession() {}
    async listSessions() {
      return [];
    }
  }

  async function setup(overrides: Partial<GatewayConfig> = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agw-mc-"));
    tempDirs.push(root);
    const config = loadConfig(
      {
        DATA_DIR: path.join(root, "data"),
        DEFAULT_CWD: root,
        QUOTA_WARN_THRESHOLD: "0",
        TELEGRAM_BOT_TOKEN: "tok",
        TELEGRAM_ALLOWED_USERS: "1001",
        DISCORD_BOT_TOKEN: "tok",
        DISCORD_ALLOW_GUILDS: "true",
        DISCORD_ALLOWED_USERS: "2002",
      },
      { loadDotenv: false },
    );
    Object.assign(config, overrides);
    const store = new GatewayStore(config.dataDir);
    await store.load();
    const tg = new FakeAdapter("telegram");
    const dc = new FakeAdapter("discord");
    const hub = new MultiChannelHub([tg, dc], { log: () => {} });
    const backend = new EchoBackend();
    const router = new GatewayRouter({
      config,
      channel: hub,
      backend,
      store,
      scheduler: new LoopScheduler({ store, channel: hub }),
      quotaFetcher: async () => ({ available: false, fetchedAt: Date.now(), groups: [] }),
    });
    router.markReady();
    await hub.start((m) => router.handleInbound(m));
    return { tg, dc, hub, backend, router, store, config };
  }

  it("applies per-channel allowlists and routes replies to the origin channel", async () => {
    const { tg, dc, hub, backend, router } = await setup();

    await router.handleInbound({ ...inbound("telegram", { senderId: "1001", text: "hi" }), chatId: "telegram::7" });
    expect(backend.turns).toEqual(["hi"]);
    expect(tg.sent.at(-1)).toMatchObject({ chatId: "7" });
    expect(tg.sent.at(-1)?.text).toContain("Echo: hi");
    expect(dc.sent).toHaveLength(0);

    // Telegram allowlist does not authorize the same id on Discord (fail-closed + pairing)
    await router.handleInbound({ ...inbound("discord", { senderId: "1001", text: "nope" }), chatId: "discord::dm1" });
    expect(backend.turns).toEqual(["hi"]);
    expect(dc.sent.at(-1)?.text).toMatch(/pairing code [A-Z0-9]{8}/);

    // Discord guild messages need allowGuilds + mention + allowlist
    await router.handleInbound({
      ...inbound("discord", { senderId: "2002", isGroup: true, mentionsBot: true, text: "@agy ping" }),
      chatId: "discord::guild1",
    });
    expect(backend.turns).toEqual(["hi", "ping"]);

    await router.handleInbound({ ...inbound("telegram", { senderId: "1001", text: "/channels" }), chatId: "telegram::7" });
    const report = tg.sent.at(-1)?.text ?? "";
    expect(report).toContain("telegram (this chat)");
    expect(report).toContain("discord");

    const snap = router.getHealthSnapshot();
    expect(Object.keys(snap.channels ?? {}).sort()).toEqual(["discord", "telegram"]);
    expect(snap.status).toBe("ok");
    await hub.stop();
  });

  it("pairing approval is channel-namespaced and honors global qualified entries", async () => {
    const { tg, dc, backend, router, store, config } = await setup();
    config.allowedSenders.add("discord:3003");

    await router.handleInbound({ ...inbound("telegram", { senderId: "5005", text: "x" }), chatId: "telegram::5" });
    const code = /pairing code ([A-Z0-9]{8})/.exec(tg.sent.at(-1)?.text ?? "")?.[1];
    expect(code).toBeDefined();
    expect((await store.approvePairing(code!)).senderId).toBe("telegram:5005");

    await router.handleInbound({ ...inbound("telegram", { senderId: "5005", text: "paired" }), chatId: "telegram::5" });
    expect(backend.turns).toEqual(["paired"]);

    await router.handleInbound({ ...inbound("discord", { senderId: "5005", text: "wrong channel" }), chatId: "discord::5" });
    expect(backend.turns).toEqual(["paired"]);

    await router.handleInbound({ ...inbound("discord", { senderId: "3003", text: "global" }), chatId: "discord::3" });
    expect(backend.turns).toEqual(["paired", "global"]);
    expect(dc.sent.some((m) => m.chatId === "3")).toBe(true);
  });
});
