import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import { MultiChannelHub } from "../src/channels/hub.js";
import { MatrixChannelAdapter } from "../src/channels/matrix.js";
import { TelegramChannelAdapter } from "../src/channels/telegram.js";
import { WhatsAppChannelAdapter } from "../src/channels/whatsapp.js";
import { PhotonChannelAdapter } from "../src/photon/adapter.js";
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
  ChannelAdapter,
  InboundMessage,
  OutboundMessage,
} from "../src/types.js";

// spectrum-ts is only exercised through PhotonChannelAdapter; a small structural
// mock lets us drive space/message handles without a live Spectrum transport.
const spectrumMock = vi.hoisted(() => ({
  spaceGet: undefined as undefined | ((chatId: string) => Promise<unknown>),
}));

vi.mock("spectrum-ts", () => ({
  Spectrum: vi.fn(),
  attachment: vi.fn(),
  markdown: vi.fn(),
  richlink: vi.fn(),
  text: vi.fn(),
  voice: vi.fn(),
}));

vi.mock("spectrum-ts/providers/imessage", () => ({
  effect: vi.fn(),
  imessage: Object.assign(
    vi.fn(() => ({
      space: {
        get: (chatId: string) =>
          spectrumMock.spaceGet
            ? spectrumMock.spaceGet(chatId)
            : Promise.reject(new Error("no space configured")),
      },
      user: vi.fn(),
    })),
    { config: vi.fn(() => ({})), effect: { message: {} } },
  ),
}));

const tempDirs: string[] = [];

async function createTempDir(prefix = "agw-reactions-"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  spectrumMock.spaceGet = undefined;
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    allowedSenders: new Set(["+15550001111"]),
    allowGroups: false,
    groupMentionPatterns: ["@agy"],
    agyBin: "agy",
    defaultCwd: os.tmpdir(),
    approvalMode: "interactive",
    defaultModel: "test-model",
    defaultEffort: "high",
    healthEnabled: false,
    healthHost: "127.0.0.1",
    healthPort: 0,
    quotaWarnThreshold: 0,
    dataDir: os.tmpdir(),
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

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/* -------------------------------------------------------------------------- */
/* Photon clean reaction transitions                                          */
/* -------------------------------------------------------------------------- */

describe("PhotonChannelAdapter reaction transitions", () => {
  function setupPhoton() {
    const order: string[] = [];
    const seenHandle = {
      unsend: vi.fn(async () => {
        order.push("unsend:👀");
      }),
    };
    const thumbsHandle = {
      unsend: vi.fn(async () => {
        order.push("unsend:👍");
      }),
    };
    const react = vi.fn(async (emoji: string) => {
      order.push(`react:${emoji}`);
      return emoji === "👀" ? seenHandle : thumbsHandle;
    });
    const read = vi.fn(async () => {});
    const target = { id: "msg-1", direction: "inbound", react, read };
    spectrumMock.spaceGet = async () => ({
      getMessage: async (id: string) => (id === "msg-1" ? target : undefined),
    });

    const adapter = new PhotonChannelAdapter(makeConfig());
    (adapter as unknown as { app?: unknown }).app = {};
    return { adapter, react, read, seenHandle, order };
  }

  it("unsends the previous 👀 handle before applying 👍", async () => {
    const { adapter, react, seenHandle, order } = setupPhoton();

    await adapter.react("any;-;+15550001111", "msg-1", "👀");
    await adapter.react("any;-;+15550001111", "msg-1", "👍");

    expect(react).toHaveBeenCalledTimes(2);
    expect(react.mock.calls.map((args) => args[0])).toEqual(["👀", "👍"]);
    expect(seenHandle.unsend).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["react:👀", "unsend:👀", "react:👍"]);
  });

  it("is a no-op when the same emoji is applied twice", async () => {
    const { adapter, react, seenHandle } = setupPhoton();

    await adapter.react("any;-;+15550001111", "msg-1", "👀");
    await adapter.react("any;-;+15550001111", "msg-1", "👀");

    expect(react).toHaveBeenCalledTimes(1);
    expect(seenHandle.unsend).not.toHaveBeenCalled();
  });

  it("marks cached inbound messages read", async () => {
    const { adapter, read } = setupPhoton();

    // Prime the message cache through a reaction resolution.
    await adapter.react("any;-;+15550001111", "msg-1", "👀");
    // The transport can no longer resolve a space; the cached message must still read.
    spectrumMock.spaceGet = undefined;
    await adapter.markRead("any;-;+15550001111", "msg-1");

    expect(read).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Hub heartbeat passthrough                                                  */
/* -------------------------------------------------------------------------- */

class HeartbeatAdapter implements ChannelAdapter {
  readonly name = "photon";
  constructor(private readonly lastHeartbeatAt?: number) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  isConnected(): boolean {
    return true;
  }
  async sendMessage(): Promise<void> {}
  getStats() {
    return { lastHeartbeatAt: this.lastHeartbeatAt };
  }
}

describe("MultiChannelHub heartbeat passthrough", () => {
  it("forwards lastHeartbeatAt in getChannelSnapshots()", () => {
    const hub = new MultiChannelHub([new HeartbeatAdapter(1_700_000_000_000)], {
      log: () => {},
    });

    const snapshots = hub.getChannelSnapshots();
    expect(snapshots.photon?.lastHeartbeatAt).toBe(1_700_000_000_000);
  });
});

/* -------------------------------------------------------------------------- */
/* Router feedback lifecycle                                                  */
/* -------------------------------------------------------------------------- */

class FeedbackChannel implements ExtendedChannelAdapter {
  readonly name = "photon";
  connected = true;
  sent: OutboundMessage[] = [];
  reactions: Array<{ chatId: string; messageId: string; emoji: string }> = [];
  readReceipts: Array<{ chatId: string; messageId?: string }> = [];

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  isConnected(): boolean {
    return true;
  }
  async sendMessage(msg: OutboundMessage): Promise<{ messageId?: string }> {
    this.sent.push(msg);
    return { messageId: `out-${this.sent.length}` };
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
  reactionEmojis(): string[] {
    return this.reactions.map((r) => r.emoji);
  }
}

class FeedbackBackend implements ExtendedAgentBackend {
  turnHandler?: (input: AgentTurnInput) => Promise<AgentTurnResult>;

  async stop(): Promise<void> {}
  async sendTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    if (this.turnHandler) {
      return this.turnHandler(input);
    }
    return { sessionId: "sess-1", text: "All done", stopReason: "end_turn" };
  }
  async cancelTurn(): Promise<boolean> {
    return false;
  }
  async resetSession(): Promise<void> {}
  async listSessions(): Promise<AcpSessionSummary[]> {
    return [];
  }
}

function makeInbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: "inbound-1",
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

async function setupRouter() {
  const dataDir = await createTempDir();
  const store = new GatewayStore(dataDir);
  await store.load();
  const channel = new FeedbackChannel();
  const backend = new FeedbackBackend();
  const scheduler = new LoopScheduler({ store, channel });
  const router = new GatewayRouter({
    config: makeConfig({ dataDir }),
    channel,
    backend,
    store,
    scheduler,
    quotaFetcher: async () => ({ available: false, fetchedAt: Date.now(), groups: [] }),
  });
  router.markReady();
  return { channel, backend, router, scheduler };
}

describe("GatewayRouter Hermes feedback", () => {
  it("marks read and transitions 👀 -> 👍 on prompt success", async () => {
    const { channel, router, scheduler } = await setupRouter();

    await router.handleInbound(makeInbound({ text: "do the thing" }));

    expect(channel.readReceipts).toEqual([
      { chatId: "+15550001111", messageId: "inbound-1" },
    ]);
    expect(channel.reactionEmojis()).toEqual(["👀", "👍"]);
    expect(channel.sent.at(-1)?.text).toContain("All done");
    scheduler.stop();
  });

  it("transitions 👀 -> 👎 on prompt error", async () => {
    const { channel, backend, router, scheduler } = await setupRouter();
    backend.turnHandler = async () => {
      throw new Error("ACP exploded");
    };

    await router.handleInbound(makeInbound({ text: "explode" }));

    expect(channel.readReceipts).toHaveLength(1);
    expect(channel.reactionEmojis()).toEqual(["👀", "👎"]);
    expect(channel.sent.at(-1)?.text).toContain("Error: ACP exploded");
    scheduler.stop();
  });

  it("transitions 👀 -> 🛑 on a cancelled, empty turn", async () => {
    const { channel, backend, router, scheduler } = await setupRouter();
    backend.turnHandler = async () => ({
      sessionId: "sess-cancel",
      text: "   ",
      stopReason: "cancelled",
    });

    await router.handleInbound(makeInbound({ text: "long job" }));

    expect(channel.readReceipts).toHaveLength(1);
    expect(channel.reactionEmojis()).toEqual(["👀", "🛑"]);
    scheduler.stop();
  });

  it("reacts 👍 for fast slash commands like /help", async () => {
    const { channel, router, scheduler } = await setupRouter();

    await router.handleInbound(makeInbound({ text: "/help" }));

    expect(channel.readReceipts).toHaveLength(1);
    expect(channel.reactionEmojis()).toEqual(["👍"]);
    expect(channel.sent.at(-1)?.text).toContain("Antigravity Gateway Commands");
    scheduler.stop();
  });
});

/* -------------------------------------------------------------------------- */
/* Cross-channel native react() / markRead()                                  */
/* -------------------------------------------------------------------------- */

describe("Telegram reactions", () => {
  it("sends setMessageReaction via the Bot API", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (input: string, init?: { body?: unknown }) => {
      calls.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return jsonResponse({ ok: true, result: true });
    }) as unknown as (input: string, init?: RequestInit) => Promise<Response>;

    const adapter = new TelegramChannelAdapter(
      makeConfig({
        photon: undefined,
        telegram: { botToken: "123:TEST", allowedUsers: new Set(), pollTimeoutSec: 30 },
      }),
      { fetchImpl },
    );

    await adapter.react("42", "1001", "👍");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/bot123:TEST/setMessageReaction");
    expect(calls[0]!.body).toEqual({
      chat_id: "42",
      message_id: 1001,
      reaction: [{ type: "emoji", emoji: "👍" }],
    });
  });
});

describe("WhatsApp read receipts and reactions", () => {
  it("posts markRead and react payloads to the Graph API", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (input: string, init?: { body?: unknown }) => {
      calls.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const adapter = new WhatsAppChannelAdapter(
      makeConfig({
        photon: undefined,
        whatsapp: {
          enabled: true,
          accessToken: "test-access-token",
          phoneNumberId: "987654",
          verifyToken: "test-verify-token",
          appSecret: "test-app-secret",
          apiVersion: "v21.0",
          webhookHost: "127.0.0.1",
          webhookPort: 0,
          webhookPath: "/whatsapp/webhook",
          allowedUsers: new Set(),
        },
      }),
      { fetchImpl },
    );

    await adapter.markRead("15551230000", "wamid.inbound");
    await adapter.react("15551230000", "wamid.inbound", "👍");

    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe(
      "https://graph.facebook.com/v21.0/987654/messages",
    );
    expect(calls[0]!.body).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.inbound",
    });
    expect(calls[1]!.body).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "15551230000",
      type: "reaction",
      reaction: { message_id: "wamid.inbound", emoji: "👍" },
    });
  });
});

describe("Matrix read receipts and reactions", () => {
  it("posts m.read and sends m.reaction annotations", async () => {
    const calls: Array<{ url: string; method?: string; body: unknown }> = [];
    const fetchImpl = (async (input: string, init?: { method?: string; body?: unknown }) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.includes("/send/m.reaction/")) {
        return jsonResponse({ event_id: "$reaction-1" });
      }
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const adapter = new MatrixChannelAdapter(
      makeConfig({
        photon: undefined,
        matrix: {
          homeserverUrl: "https://matrix.example.test",
          accessToken: "test-access-token",
          userId: "@gateway:example.test",
          allowedUsers: new Set(),
        },
      }),
      { fetchImpl },
    );

    await adapter.markRead("!room:example.test", "$event-1");
    await adapter.react("!room:example.test", "$event-1", "👍");

    expect(calls).toHaveLength(2);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toContain("/_matrix/client/v3/rooms/");
    expect(calls[0]!.url).toContain("/receipt/m.read/");
    expect(calls[1]!.method).toBe("PUT");
    expect(calls[1]!.url).toContain("/send/m.reaction/");
    expect(calls[1]!.body).toEqual({
      "m.relates_to": {
        rel_type: "m.annotation",
        event_id: "$event-1",
        key: "👍",
      },
    });
  });
});