import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import { IngressBurstCoalescer } from "../src/gateway/burst.js";
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
  InboundAttachment,
  InboundMessage,
  OutboundMessage,
  TurnActivitySnapshot,
} from "../src/types.js";

type ReplyMeta = {
  replyToMessageId?: string;
  replyToText?: string;
  replyToIsOwnMessage?: boolean;
};

const HOME_CHAT_ID = "+15550001111";
const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agw-wave8b-"));
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
    allowedSenders: new Set([HOME_CHAT_ID]),
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
    chatId: HOME_CHAT_ID,
    senderId: HOME_CHAT_ID,
    isGroup: false,
    text: "hello",
    attachments: [],
    timestamp: Date.now(),
    service: "iMessage",
    mentionsBot: false,
    ...overrides,
  };
}

class MockChannel implements ExtendedChannelAdapter {
  readonly name = "photon";
  connected = true;
  sent: OutboundMessage[] = [];
  typingEvents: Array<{ chatId: string; active: boolean }> = [];

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

  async markRead(): Promise<void> {}

  async react(): Promise<void> {}

  getStats() {
    return {};
  }

  texts(): string[] {
    return this.sent.map((msg) => msg.text ?? "");
  }
}

class MockBackend implements ExtendedAgentBackend {
  turnCalls: AgentTurnInput[] = [];
  turnHandler?: (input: AgentTurnInput) => Promise<AgentTurnResult>;
  activityGetter?: (chatId: string) => TurnActivitySnapshot | undefined;

  async stop(): Promise<void> {}

  async sendTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    this.turnCalls.push(input);
    if (this.turnHandler) {
      return this.turnHandler(input);
    }
    return {
      sessionId: "sess-live-001",
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

  getTurnActivity(chatId: string): TurnActivitySnapshot | undefined {
    return this.activityGetter?.(chatId);
  }
}

interface SetupOptions {
  burstDebounceMs?: number;
  burstHardCapMs?: number;
  progressPollIntervalMs?: number;
  config?: Partial<GatewayConfig>;
  backend?: MockBackend;
  channel?: MockChannel;
}

async function setupRouter(options: SetupOptions = {}) {
  const dataDir = await createTempDir();
  const store = new GatewayStore(dataDir);
  await store.load();
  const channel = options.channel ?? new MockChannel();
  const backend = options.backend ?? new MockBackend();
  const scheduler = new LoopScheduler({ store, channel });
  const config = makeConfig(dataDir, options.config);
  const router = new GatewayRouter({
    config,
    channel,
    backend,
    store,
    scheduler,
    burstDebounceMs: options.burstDebounceMs,
    burstHardCapMs: options.burstHardCapMs,
    progressPollIntervalMs: options.progressPollIntervalMs,
    quotaFetcher: async () => ({
      available: false,
      fetchedAt: Date.now(),
      groups: [],
    }),
  });
  router.markReady();
  return { dataDir, config, store, channel, backend, scheduler, router };
}

describe("IngressBurstCoalescer", () => {
  it("merges rapid bubbles + photo attachment within the debounce window into one flush", async () => {
    vi.useFakeTimers();
    const flushed: InboundMessage[] = [];
    const coalescer = new IngressBurstCoalescer({
      debounceMs: 100,
      hardCapMs: 1000,
      onFlush: (merged) => {
        flushed.push(merged);
      },
    });
    const photo: InboundAttachment = {
      type: "image",
      name: "photo.jpg",
      mimeType: "image/jpeg",
    };

    coalescer.enqueue(makeInbound({ id: "b1", text: "line one", timestamp: 1 }));
    await vi.advanceTimersByTimeAsync(40);
    coalescer.enqueue(makeInbound({ id: "b2", text: "line two", timestamp: 2 }));
    await vi.advanceTimersByTimeAsync(40);
    coalescer.enqueue(
      makeInbound({
        id: "b3",
        text: "",
        attachments: [photo],
        mentionsBot: true,
        timestamp: 3,
      }),
    );

    await vi.advanceTimersByTimeAsync(99);
    expect(flushed).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(flushed).toHaveLength(1);
    const merged = flushed[0]!;
    expect(merged.id).toBe("b3");
    expect(merged.text).toBe("line one\nline two");
    expect(merged.attachments).toEqual([photo]);
    expect(merged.mentionsBot).toBe(true);
    expect(merged.timestamp).toBe(3);
  });

  it("enforces hardCapMs even while bubbles keep arriving, ignoring stale timers via generation", async () => {
    vi.useFakeTimers();
    const flushed: InboundMessage[] = [];
    const coalescer = new IngressBurstCoalescer({
      debounceMs: 500,
      hardCapMs: 300,
      onFlush: (merged) => {
        flushed.push(merged);
      },
    });

    coalescer.enqueue(makeInbound({ id: "c1", text: "first", timestamp: 1 }));
    await vi.advanceTimersByTimeAsync(100);
    coalescer.enqueue(makeInbound({ id: "c2", text: "second", timestamp: 2 }));
    await vi.advanceTimersByTimeAsync(100);
    coalescer.enqueue(makeInbound({ id: "c3", text: "third", timestamp: 3 }));
    await vi.advanceTimersByTimeAsync(100);

    expect(flushed).toHaveLength(1);
    expect(flushed[0]!.text).toBe("first\nsecond\nthird");

    // Nothing else should fire later.
    await vi.advanceTimersByTimeAsync(1000);
    expect(flushed).toHaveLength(1);
  });

  it("deduplicates adjacent identical captions and skips empty fragments", async () => {
    vi.useFakeTimers();
    const flushed: InboundMessage[] = [];
    const coalescer = new IngressBurstCoalescer({
      debounceMs: 50,
      onFlush: (merged) => {
        flushed.push(merged);
      },
    });

    coalescer.enqueue(makeInbound({ id: "d1", text: "same caption" }));
    coalescer.enqueue(makeInbound({ id: "d2", text: "  same caption  " }));
    coalescer.enqueue(makeInbound({ id: "d3", text: "different" }));
    coalescer.enqueue(makeInbound({ id: "d4", text: "" }));
    coalescer.enqueue(makeInbound({ id: "d5", text: "same caption" }));

    await vi.advanceTimersByTimeAsync(60);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]!.text).toBe("same caption\ndifferent\nsame caption");
  });

  it("preserves the first reply-quote metadata while merging", () => {
    const coalescer = new IngressBurstCoalescer({ onFlush: () => {} });
    const photo: InboundAttachment = { type: "image", name: "a.jpg" };
    const quoted: InboundMessage & ReplyMeta = {
      ...makeInbound({ id: "m1", text: "caption" }),
      replyToMessageId: "orig-1",
      replyToText: "quoted text",
      replyToIsOwnMessage: true,
    };

    const merged = coalescer.mergeMessages([
      quoted,
      makeInbound({ id: "m2", text: "caption", attachments: [photo], mentionsBot: true }),
      makeInbound({ id: "m3", text: "" }),
    ]) as InboundMessage & ReplyMeta;

    expect(merged.id).toBe("m3");
    expect(merged.text).toBe("caption");
    expect(merged.attachments).toEqual([photo]);
    expect(merged.mentionsBot).toBe(true);
    expect(merged.replyToMessageId).toBe("orig-1");
    expect(merged.replyToText).toBe("quoted text");
    expect(merged.replyToIsOwnMessage).toBe(true);
  });

  it("discard(chatId) drops buffered fragments without touching other chats", async () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const coalescer = new IngressBurstCoalescer({ debounceMs: 100, onFlush });

    coalescer.enqueue(makeInbound({ chatId: "chat-a", text: "frag one" }));
    coalescer.enqueue(makeInbound({ chatId: "chat-a", text: "frag two" }));
    coalescer.enqueue(makeInbound({ chatId: "chat-b", text: "survives" }));
    coalescer.discard("chat-a");

    await vi.advanceTimersByTimeAsync(200);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect((onFlush.mock.calls[0]![0] as InboundMessage).chatId).toBe("chat-b");
  });

  it("stop() cancels every pending timer; debounceMs <= 0 flushes directly", async () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const coalescer = new IngressBurstCoalescer({ debounceMs: 100, onFlush });
    coalescer.enqueue(makeInbound({ text: "first" }));
    coalescer.enqueue(makeInbound({ chatId: "other", text: "second" }));
    coalescer.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onFlush).not.toHaveBeenCalled();

    const immediate = vi.fn();
    const direct = new IngressBurstCoalescer({ debounceMs: 0, onFlush: immediate });
    direct.enqueue(makeInbound({ id: "instant", text: "now" }));
    expect(immediate).toHaveBeenCalledTimes(1);
    expect((immediate.mock.calls[0]![0] as InboundMessage).text).toBe("now");
  });
});

describe("Router burst integration", () => {
  it("coalesces rapid non-command bubbles into a single sendTurn", async () => {
    const { channel, backend, store, router } = await setupRouter({
      burstDebounceMs: 60,
    });
    await store.setHomeChatId(HOME_CHAT_ID);

    await router.handleInbound(makeInbound({ id: "rb-1", text: "first fragment" }));
    await router.handleInbound(makeInbound({ id: "rb-2", text: "second fragment" }));
    await router.handleInbound(
      makeInbound({
        id: "rb-3",
        text: "",
        attachments: [{ type: "image", name: "pic.jpg" }],
      }),
    );

    expect(backend.turnCalls).toHaveLength(0);
    await delay(200);

    expect(backend.turnCalls).toHaveLength(1);
    expect(backend.turnCalls[0]!.text).toBe("first fragment\nsecond fragment");
    expect(backend.turnCalls[0]!.attachments).toHaveLength(1);
    expect(channel.texts().at(-1)).toContain("Echo: first fragment\nsecond fragment");
    router.stop();
  });

  it("lets /stop bypass the burst and discard buffered fragments", async () => {
    const { channel, backend, store, router } = await setupRouter({
      burstDebounceMs: 150,
    });
    await store.setHomeChatId(HOME_CHAT_ID);

    await router.handleInbound(makeInbound({ id: "bs-1", text: "buffered one" }));
    await router.handleInbound(makeInbound({ id: "bs-2", text: "buffered two" }));
    await router.handleInbound(makeInbound({ id: "bs-stop", text: "/stop" }));

    expect(channel.texts().at(-1)).toContain("No active turn is running");

    await delay(350);
    expect(backend.turnCalls).toHaveLength(0);
    expect(channel.texts().some((text) => text.includes("Echo:"))).toBe(false);
    router.stop();
  });
});

describe("Reply-quote context injection", () => {
  it("prepends trimmed, capped [Replying to ...] context to the ACP prompt", async () => {
    const { backend, router } = await setupRouter();

    const quoted: InboundMessage & ReplyMeta = {
      ...makeInbound({ id: "q-1", text: "follow-up" }),
      replyToMessageId: "orig-1",
      replyToText: "  How do I reverse a list?  ",
      replyToIsOwnMessage: false,
    };
    await router.handleInbound(quoted);
    expect(backend.turnCalls[0]!.text).toBe(
      '[Replying to quoted message: "How do I reverse a list?"]\n\nfollow-up',
    );

    const own: InboundMessage & ReplyMeta = {
      ...makeInbound({ id: "q-2", text: "and now?" }),
      replyToText: "Use the slice trick.",
      replyToIsOwnMessage: true,
    };
    await router.handleInbound(own);
    expect(backend.turnCalls[1]!.text).toBe(
      '[Replying to previous assistant message: "Use the slice trick."]\n\nand now?',
    );

    const long: InboundMessage & ReplyMeta = {
      ...makeInbound({ id: "q-3", text: "summarize" }),
      replyToText: "x".repeat(900),
    };
    await router.handleInbound(long);
    expect(backend.turnCalls[2]!.text).toBe(
      `[Replying to quoted message: "${"x".repeat(500)}"]\n\nsummarize`,
    );
    router.stop();
  });
});

describe("Power slash commands", () => {
  it("/ping reports channel, uptime, and connection state", async () => {
    const { channel, router } = await setupRouter();

    await router.handleInbound(makeInbound({ id: "p-1", text: "/ping" }));
    const reply = channel.texts().at(-1) ?? "";
    expect(reply).toContain("🏓 Pong!");
    expect(reply).toContain("channel=photon");
    expect(reply).toContain("connected=true");
    expect(reply).toMatch(/uptime=/);

    await router.handleInbound(makeInbound({ id: "p-h", text: "/ping -h" }));
    expect(channel.texts().at(-1)).toContain("Usage: /ping");
  });

  it("/sethome persists this conversation as the recovery home chat", async () => {
    const { channel, store, router } = await setupRouter();
    await store.setHomeChatId("+19998887777");

    await router.handleInbound(makeInbound({ id: "h-1", text: "/sethome" }));
    expect(store.getHomeChatId()).toBe(HOME_CHAT_ID);
    expect(channel.texts().at(-1)).toContain(
      `🏠 Home chat set to this conversation (${HOME_CHAT_ID}).`,
    );

    await router.handleInbound(makeInbound({ id: "h-h", text: "/sethome --help" }));
    expect(channel.texts().at(-1)).toContain("Usage: /sethome");
  });

  it("/verbose shows the level, supports -h, and `off` suppresses silence pulses", async () => {
    const backend = new MockBackend();
    backend.activityGetter = (chatId) => ({
      chatId,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      phase: "tool",
      currentTool: "grep",
      toolCount: 2,
      retryCount: 0,
      maxRetries: 2,
    });
    backend.turnHandler = async () => {
      await delay(120);
      return { sessionId: "sess-verbose", text: "quiet done", stopReason: "end_turn" };
    };

    const { channel, router } = await setupRouter({
      backend,
      progressPollIntervalMs: 10,
      config: { progressSilenceMs: 20, sessionStallTimeoutMs: 0 },
    });

    await router.handleInbound(makeInbound({ id: "v-0", text: "/verbose" }));
    expect(channel.texts().at(-1)).toContain("Verbosity: brief");
    expect(channel.texts().at(-1)).toContain("Usage: /verbose");

    await router.handleInbound(makeInbound({ id: "v-h", text: "/verbose -h" }));
    expect(channel.texts().at(-1)).toContain("Usage: /verbose");

    await router.handleInbound(makeInbound({ id: "v-off", text: "/verbose off" }));
    expect(channel.texts().at(-1)).toContain("Verbosity set to: off");

    await router.handleInbound(makeInbound({ id: "v-run", text: "stay quiet" }));
    expect(channel.texts().at(-1)).toContain("quiet done");

    const chatter = channel
      .texts()
      .filter((text) => text.includes("正在执行工具") || text.includes("思考/处理中"));
    expect(chatter).toHaveLength(0);
    router.stop();
  });

  it("/verbose off still surfaces stall alerts", async () => {
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
      await delay(90);
      return { sessionId: "sess-stall", text: "finished", stopReason: "end_turn" };
    };

    const { channel, router } = await setupRouter({
      backend,
      progressPollIntervalMs: 10,
      config: { progressSilenceMs: 20, sessionStallTimeoutMs: 25 },
    });

    await router.handleInbound(makeInbound({ id: "st-off", text: "/verbose off" }));
    await router.handleInbound(makeInbound({ id: "st-run", text: "stuck please" }));

    expect(channel.texts().some((text) => text.includes("当前会话已静默"))).toBe(true);
    expect(channel.texts().some((text) => text.includes("思考/处理中"))).toBe(false);
    router.stop();
  });

  it("/verbose brief keeps pulses; /verbose full adds tool/model/retry detail", async () => {
    const backend = new MockBackend();
    backend.activityGetter = (chatId) => ({
      chatId,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      phase: "thinking",
      model: "gemini-4-neon",
      effort: "high",
      toolCount: 3,
      retryCount: 1,
      maxRetries: 2,
    });
    backend.turnHandler = async () => {
      await delay(100);
      return { sessionId: "sess-brief", text: "done", stopReason: "end_turn" };
    };

    const { channel, router } = await setupRouter({
      backend,
      progressPollIntervalMs: 10,
      config: { progressSilenceMs: 20, sessionStallTimeoutMs: 0 },
    });

    await router.handleInbound(makeInbound({ id: "vb-run", text: "brief run" }));
    const briefPulse = channel.texts().find((text) => text.includes("思考/处理中"));
    expect(briefPulse).toBeTruthy();
    expect(briefPulse).not.toContain("📊");

    await router.handleInbound(makeInbound({ id: "vf-cmd", text: "/verbose full" }));
    expect(channel.texts().at(-1)).toContain("Verbosity set to: full");

    await router.handleInbound(makeInbound({ id: "vf-run", text: "full run" }));
    const fullPulse = channel.texts().find((text) => text.includes("📊"));
    expect(fullPulse).toBeTruthy();
    expect(fullPulse).toContain("模型 gemini-4-neon");
    expect(fullPulse).toContain("effort high");
    router.stop();
  });

  it("/retry re-runs the last prompt and reports when history is empty", async () => {
    const { channel, backend, router } = await setupRouter();

    await router.handleInbound(makeInbound({ id: "rt-empty", text: "/retry" }));
    expect(channel.texts().at(-1)).toContain(
      "No previous prompt to retry in this chat.",
    );

    await router.handleInbound(makeInbound({ id: "rt-1", text: "explain closures" }));
    expect(backend.turnCalls.map((call) => call.text)).toEqual(["explain closures"]);

    await router.handleInbound(makeInbound({ id: "rt-2", text: "/retry" }));
    expect(backend.turnCalls.map((call) => call.text)).toEqual([
      "explain closures",
      "explain closures",
    ]);
    expect(channel.texts().at(-1)).toContain("Echo: explain closures");

    await router.handleInbound(makeInbound({ id: "rt-h", text: "/retry --help" }));
    expect(channel.texts().at(-1)).toContain("Usage: /retry");
    router.stop();
  });
});