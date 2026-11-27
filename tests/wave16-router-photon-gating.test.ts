import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgyAgentBackend, type AgyAcpClientLike } from "../src/acp/sessions.js";
import { MultiChannelHub } from "../src/channels/hub.js";
import {
  loadConfig,
  parsePhotonNativeCommands,
  type GatewayConfig,
} from "../src/config.js";
import { isUnsupportedPhotonBackendError } from "../src/gateway/commands/photon.js";
import { formatHelpText, HELP_TEXT } from "../src/gateway/commands/system.js";
import {
  GatewayRouter,
  type ExtendedAgentBackend,
} from "../src/gateway/router.js";
import { LoopScheduler } from "../src/gateway/scheduler.js";
import { GatewayStore } from "../src/gateway/store.js";
import type {
  AgentTurnInput,
  AgentTurnResult,
  ChannelAdapter,
  InboundAttachment,
  InboundMessage,
  OutboundMessage,
  PhotonNativeCapabilities,
  PhotonNativeCommandName,
} from "../src/types.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agw-wave16-router-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

class RecordingAdapter implements ChannelAdapter {
  readonly name: string;
  readonly sent: OutboundMessage[] = [];
  readonly reactions: Array<{ chatId: string; messageId: string; emoji: string }> = [];

  constructor(name: string) {
    this.name = name;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  isConnected(): boolean {
    return true;
  }
  async sendMessage(msg: OutboundMessage): Promise<{ messageId?: string }> {
    this.sent.push(msg);
    return { messageId: `out-${this.sent.length}` };
  }
  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    this.reactions.push({ chatId, messageId, emoji });
  }
}

class FakePhotonAdapter extends RecordingAdapter implements PhotonNativeCapabilities {
  pollCalls: Array<{ chatId: string; title: string; options: string[] }> = [];
  bgCalls: Array<{ chatId: string; value: string }> = [];
  cardCalls: string[] = [];
  unsendCalls: string[] = [];

  pollError?: unknown;
  bgError?: unknown;
  cardError?: unknown;
  unsendError?: unknown;
  nextUnsendResult: { ok: boolean; messageId?: string; reason?: string } = {
    ok: true,
    messageId: "msg-1",
  };

  constructor() {
    super("photon");
  }

  async sendPoll(chatId: string, title: string, options: string[]) {
    this.pollCalls.push({ chatId, title, options });
    if (this.pollError) throw this.pollError;
    return { messageId: "poll-1" };
  }

  async setBackground(chatId: string, value: string) {
    this.bgCalls.push({ chatId, value });
    if (this.bgError) throw this.bgError;
  }

  async shareContactCard(chatId: string) {
    this.cardCalls.push(chatId);
    if (this.cardError) throw this.cardError;
  }

  async unsendLastMessage(chatId: string) {
    this.unsendCalls.push(chatId);
    if (this.unsendError) throw this.unsendError;
    return this.nextUnsendResult;
  }
}

class SteerableBackend implements ExtendedAgentBackend {
  turnCalls: AgentTurnInput[] = [];
  steerCalls: Array<{
    chatId: string;
    text: string;
    attachments?: InboundAttachment[];
  }> = [];
  cancelledChats: string[] = [];
  busyChats = new Set<string>();
  steerResult = true;
  enableSteer = true;
  turnHandler?: (input: AgentTurnInput) => Promise<AgentTurnResult>;
  onSteer?: (chatId: string, text: string) => void;

  async stop(): Promise<void> {}

  async sendTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    this.turnCalls.push(input);
    this.busyChats.add(input.chatId);
    try {
      if (this.turnHandler) {
        return await this.turnHandler(input);
      }
      return {
        sessionId: "sess-1",
        text: `Echo: ${input.text}`,
        stopReason: "end_turn",
      };
    } finally {
      this.busyChats.delete(input.chatId);
    }
  }

  steerTurn = async (
    chatId: string,
    text: string,
    attachments?: InboundAttachment[],
  ): Promise<boolean> => {
    if (!this.enableSteer) {
      return false;
    }
    this.steerCalls.push({ chatId, text, attachments });
    this.onSteer?.(chatId, text);
    return this.steerResult;
  };

  async cancelTurn(chatId: string): Promise<boolean> {
    this.cancelledChats.push(chatId);
    return this.busyChats.has(chatId);
  }

  async resetSession(): Promise<void> {}
  async listSessions() {
    return [];
  }
  isBusy(chatId: string): boolean {
    return this.busyChats.has(chatId);
  }
}

function makeInbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: `in-${Math.random().toString(36).slice(2, 8)}`,
    channel: "photon",
    chatId: "photon::+15550001111",
    senderId: "+15550001111",
    text: "hello",
    isGroup: false,
    mentionsBot: false,
    attachments: [],
    timestamp: Date.now(),
    ...overrides,
  };
}

async function setupRouterWithHub(options: {
  adapters: ChannelAdapter[];
  backend?: ExtendedAgentBackend;
  configOverrides?: Partial<GatewayConfig>;
  photonNativeCommands?: Set<PhotonNativeCommandName>;
}) {
  const dir = await makeTempDir();
  const dataDir = path.join(dir, "data");
  await fs.mkdir(dataDir, { recursive: true });

  const config: GatewayConfig = {
    ...loadConfig({ DATA_DIR: dataDir, DEFAULT_CWD: dir }, { loadDotenv: false }),
    allowedSenders: new Set(["+15550001111", "telegram:user-1"]),
    photon: {
      projectId: "proj",
      projectSecret: "secret",
      readReceipts: true,
      reactions: true,
      ...(options.photonNativeCommands
        ? { nativeCommands: options.photonNativeCommands }
        : {}),
    },
    ...options.configOverrides,
  };

  const hub = new MultiChannelHub(options.adapters);
  const store = new GatewayStore(dataDir);
  await store.load();
  const scheduler = new LoopScheduler({ store, channel: hub });
  const backend = options.backend ?? new SteerableBackend();
  const router = new GatewayRouter({
    config,
    channel: hub,
    backend,
    store,
    scheduler,
    typingIntervalMs: 0,
    quotaFetcher: async () => ({ available: false, fetchedAt: Date.now(), groups: [] }),
  });
  router.markReady();

  return { dir, config, hub, store, scheduler, backend, router };
}

describe("v0.4.3 config defaults & Photon native command parsing", () => {
  it("defaults DEFAULT_BUSY_MODE to steer and STREAM_INTERMEDIATE_REPLIES to true", () => {
    const cfg = loadConfig({}, { loadDotenv: false });
    expect(cfg.defaultBusyMode).toBe("steer");
    expect(cfg.streamIntermediateReplies).toBe(true);
  });

  it("allows overriding DEFAULT_BUSY_MODE and STREAM_INTERMEDIATE_REPLIES", () => {
    expect(
      loadConfig({ DEFAULT_BUSY_MODE: "queue" }, { loadDotenv: false }).defaultBusyMode,
    ).toBe("queue");
    expect(
      loadConfig({ DEFAULT_BUSY_MODE: "INTERRUPT" }, { loadDotenv: false })
        .defaultBusyMode,
    ).toBe("interrupt");
    expect(
      loadConfig({ STREAM_INTERMEDIATE_REPLIES: "false" }, { loadDotenv: false })
        .streamIntermediateReplies,
    ).toBe(false);
  });

  it("parses PHOTON_NATIVE_COMMANDS for all, none, and comma-separated subsets", () => {
    expect([...parsePhotonNativeCommands(undefined)]).toEqual([
      "poll",
      "bg",
      "unsend",
      "card",
    ]);
    expect([...parsePhotonNativeCommands("all")]).toEqual([
      "poll",
      "bg",
      "unsend",
      "card",
    ]);
    expect([...parsePhotonNativeCommands("none")]).toEqual([]);
    expect([...parsePhotonNativeCommands("off")]).toEqual([]);
    expect([...parsePhotonNativeCommands("unsend, /poll, bogus")]).toEqual([
      "unsend",
      "poll",
    ]);

    const cfg = loadConfig(
      {
        SPECTRUM_PROJECT_ID: "proj",
        SPECTRUM_PROJECT_SECRET: "sec",
        PHOTON_NATIVE_COMMANDS: "unsend,poll",
      },
      { loadDotenv: false },
    );
    expect([...(cfg.photon?.nativeCommands ?? [])]).toEqual(["unsend", "poll"]);
  });

  it("AgyAgentBackend defaults new chat busyMode to steer unless configured otherwise", () => {
    const stubClient = {
      start: async () => {},
      stop: async () => {},
      newSession: async () => ({ sessionId: "s1" }),
      loadSession: async () => {},
      prompt: async () => ({ stopReason: "end_turn" }),
      cancel: async () => {},
      listSessions: async () => [],
      setConfigOption: async () => {},
      setMode: async () => {},
      getAvailableModels: () => [],
      getAvailableBaseModels: () => [],
      getAvailableEfforts: () => [],
      getAvailableModes: () => [],
    } as unknown as AgyAcpClientLike;

    const defaultCfg = loadConfig({}, { loadDotenv: false });
    const defaultBackend = new AgyAgentBackend(defaultCfg, { client: stubClient });
    expect(defaultBackend.getBusyMode("chat-1")).toBe("steer");

    const queueCfg = loadConfig({ DEFAULT_BUSY_MODE: "queue" }, { loadDotenv: false });
    const queueBackend = new AgyAgentBackend(queueCfg, { client: stubClient });
    expect(queueBackend.getBusyMode("chat-1")).toBe("queue");
  });
});

describe("v0.4.3 live mid-turn steering & /inject command", () => {
  it("defaults to steer mode, flushes buffered text first, reacts 👀, and injects without cancelling", async () => {
    const photon = new FakePhotonAdapter();
    const backend = new SteerableBackend();
    const events: string[] = [];

    const origSendMessage = photon.sendMessage.bind(photon);
    photon.sendMessage = async (msg) => {
      events.push(`send:${msg.text ?? ""}`);
      return origSendMessage(msg);
    };
    backend.onSteer = (_chatId, text) => {
      events.push(`steer:${text}`);
    };

    const { router } = await setupRouterWithHub({ adapters: [photon], backend });

    let releaseTurn!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((r) => {
      markStarted = r;
    });

    backend.turnHandler = async (input) => {
      await input.callbacks?.onTextDelta?.("Working on step 1...");
      markStarted();
      await new Promise<void>((r) => {
        releaseTurn = r;
      });
      await input.callbacks?.onTextDelta?.("Final steered result.");
      return { sessionId: "sess-1", text: "", stopReason: "end_turn" };
    };

    const turnPromise = router.handleInbound(
      makeInbound({ id: "m1", text: "refactor router" }),
    );
    await started;

    const attachment: InboundAttachment = {
      kind: "image",
      path: "/tmp/ref.png",
      name: "ref.png",
    };
    await router.handleInbound(
      makeInbound({
        id: "m2",
        text: "also keep backward compat",
        attachments: [attachment],
        replyToText: "Working on step 1...",
      }),
    );

    expect(backend.cancelledChats).toEqual([]);
    expect(backend.steerCalls).toHaveLength(1);
    expect(backend.steerCalls[0]?.text).toContain("Working on step 1...");
    expect(backend.steerCalls[0]?.text).toContain("also keep backward compat");
    expect(backend.steerCalls[0]?.attachments).toEqual([attachment]);
    expect(photon.reactions).toContainEqual({
      chatId: "+15550001111",
      messageId: "m2",
      emoji: "👀",
    });

    const flushIdx = events.findIndex((e) => e.includes("send:Working on step 1..."));
    const steerIdx = events.findIndex((e) => e.startsWith("steer:"));
    const ackIdx = events.findIndex((e) =>
      e.includes("💬 Injected into active turn (in-flight)."),
    );
    expect(flushIdx).toBeGreaterThanOrEqual(0);
    expect(steerIdx).toBeGreaterThan(flushIdx);
    expect(ackIdx).toBeGreaterThan(steerIdx);

    releaseTurn();
    await turnPromise;
    expect(photon.sent.at(-1)?.text).toContain("Final steered result.");
  });

  it("supports /steer, /s, and /inject live while busy, and falls back to cancel+redirect when unsupported", async () => {
    const photon = new FakePhotonAdapter();
    const backend = new SteerableBackend();
    const { router } = await setupRouterWithHub({ adapters: [photon], backend });

    let releaseTurn!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((r) => {
      markStarted = r;
    });
    let calls = 0;
    backend.turnHandler = async (input) => {
      calls += 1;
      if (calls === 1) {
        markStarted();
        await new Promise<void>((r) => {
          releaseTurn = r;
        });
        return { sessionId: "sess-1", text: "", stopReason: "cancelled" };
      }
      return { sessionId: "sess-1", text: `Done: ${input.text}`, stopReason: "end_turn" };
    };

    const p1 = router.handleInbound(makeInbound({ id: "t1", text: "long task" }));
    await started;

    await router.handleInbound(makeInbound({ id: "c1", text: "/inject check edge cases" }));
    expect(backend.steerCalls.at(-1)?.text).toBe("check edge cases");
    expect(photon.sent.at(-1)?.text).toBe("💬 Injected into active turn (in-flight).");
    expect(backend.cancelledChats).toEqual([]);

    await router.handleInbound(makeInbound({ id: "c2", text: "/s keep tests fast" }));
    expect(backend.steerCalls.at(-1)?.text).toBe("keep tests fast");
    expect(photon.sent.at(-1)?.text).toBe("💬 Injected into active turn (in-flight).");

    // Disable live steering -> /steer must fall back to cancel + redirect
    backend.steerResult = false;
    await router.handleInbound(makeInbound({ id: "c3", text: "/steer new plan" }));
    expect(photon.sent.at(-1)?.text).toContain("Redirecting active turn");
    expect(backend.cancelledChats).toEqual(["photon::+15550001111"]);

    releaseTurn();
    await p1;
    expect(backend.turnCalls.map((c) => c.text)).toEqual(["long task", "new plan"]);

    // Verify help texts describe steer default, queue, and interrupt
    await router.handleInbound(makeInbound({ text: "/steer -h" }));
    expect(photon.sent.at(-1)?.text).toContain("/inject");
    await router.handleInbound(makeInbound({ text: "/busy -h" }));
    const busyHelp = photon.sent.at(-1)?.text ?? "";
    expect(busyHelp).toContain("steer");
    expect(busyHelp).toContain("default");
    expect(busyHelp).toContain("queue");
    expect(busyHelp).toContain("interrupt");
  });

  it("falls back to cancel+redirect for plain follow-ups when steerTurn returns false, and respects /busy queue", async () => {
    const photon = new FakePhotonAdapter();
    const backend = new SteerableBackend();
    backend.enableSteer = false;
    const { router } = await setupRouterWithHub({ adapters: [photon], backend });

    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstReady = new Promise<void>((r) => {
      firstStarted = r;
    });
    let calls = 0;
    backend.turnHandler = async (input) => {
      calls += 1;
      if (calls === 1) {
        firstStarted();
        await new Promise<void>((r) => {
          releaseFirst = r;
        });
        return { sessionId: "sess-1", text: "", stopReason: "cancelled" };
      }
      return { sessionId: "sess-1", text: `Handled: ${input.text}`, stopReason: "end_turn" };
    };

    const p = router.handleInbound(makeInbound({ id: "a1", text: "task A" }));
    await firstReady;

    // Plain message in default steer mode falls back to cancel + enqueue
    await router.handleInbound(makeInbound({ id: "a2", text: "task B" }));
    expect(backend.cancelledChats).toEqual(["photon::+15550001111"]);

    releaseFirst();
    await p;
    expect(backend.turnCalls.map((c) => c.text)).toEqual(["task A", "task B"]);

    // Switch to queue mode: plain message queues instead of steering/cancelling
    await router.handleInbound(makeInbound({ text: "/busy queue" }));
    backend.enableSteer = true;
    backend.cancelledChats = [];
    let releaseQ!: () => void;
    let qStarted!: () => void;
    const qReady = new Promise<void>((r) => {
      qStarted = r;
    });
    let qCalls = 0;
    backend.turnHandler = async (input) => {
      qCalls += 1;
      if (qCalls === 1) {
        qStarted();
        await new Promise<void>((r) => {
          releaseQ = r;
        });
      }
      return { sessionId: "sess-1", text: `Q: ${input.text}`, stopReason: "end_turn" };
    };

    const pq = router.handleInbound(makeInbound({ id: "q1", text: "first queued" }));
    await qReady;
    await router.handleInbound(makeInbound({ id: "q2", text: "second queued" }));
    expect(photon.sent.at(-1)?.text).toContain("Queued (#1)");
    expect(backend.steerCalls).toHaveLength(0);
    expect(backend.cancelledChats).toEqual([]);

    releaseQ();
    await pq;
  });

  it("respects DEFAULT_BUSY_MODE=queue on router and falls back when backend omits steerTurn", async () => {
    const photon = new FakePhotonAdapter();
    const backend = new SteerableBackend();
    // Simulate a minimal backend that does not implement steerTurn at all
    delete (backend as { steerTurn?: unknown }).steerTurn;

    const { router } = await setupRouterWithHub({
      adapters: [photon],
      backend,
      configOverrides: { defaultBusyMode: "queue" },
    });

    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstReady = new Promise<void>((r) => {
      firstStarted = r;
    });
    let calls = 0;
    backend.turnHandler = async (input) => {
      calls += 1;
      if (calls === 1) {
        firstStarted();
        await new Promise<void>((r) => {
          releaseFirst = r;
        });
      }
      return { sessionId: "sess-1", text: `Done: ${input.text}`, stopReason: "end_turn" };
    };

    const p = router.handleInbound(makeInbound({ id: "dq1", text: "first" }));
    await firstReady;
    await router.handleInbound(makeInbound({ id: "dq2", text: "second" }));
    expect(photon.sent.at(-1)?.text).toContain("Queued (#1)");
    expect(backend.cancelledChats).toEqual([]);

    // Explicit /steer falls back to cancel+redirect when backend lacks steerTurn
    await router.handleInbound(makeInbound({ id: "dq3", text: "/steer urgent" }));
    expect(photon.sent.at(-1)?.text).toContain("Redirecting active turn");
    expect(backend.cancelledChats).toEqual(["photon::+15550001111"]);

    releaseFirst();
    await p;
  });

  it("executes immediately instead of stranding in queue if the active turn finishes while steerTurn returns false", async () => {
    const photon = new FakePhotonAdapter();
    const backend = new SteerableBackend();
    const { router } = await setupRouterWithHub({ adapters: [photon], backend });

    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstReady = new Promise<void>((r) => {
      firstStarted = r;
    });
    let calls = 0;
    backend.turnHandler = async (input) => {
      calls += 1;
      if (calls === 1) {
        firstStarted();
        await new Promise<void>((r) => {
          releaseFirst = r;
        });
        return { sessionId: "sess-1", text: "First done", stopReason: "end_turn" };
      }
      return { sessionId: "sess-1", text: `Immediate: ${input.text}`, stopReason: "end_turn" };
    };

    const p1 = router.handleInbound(makeInbound({ id: "race-1", text: "first turn" }));
    await firstReady;

    // Simulate the active turn finishing during the async steerTurn window before steerTurn returns false.
    backend.steerTurn = async () => {
      releaseFirst();
      await p1;
      return false;
    };

    await router.handleInbound(makeInbound({ id: "race-2", text: "follow-up after finish" }));
    expect(backend.cancelledChats).toEqual([]);
    expect(backend.turnCalls.map((c) => c.text)).toEqual([
      "first turn",
      "follow-up after finish",
    ]);
    expect(photon.sent.at(-1)?.text).toBe("Immediate: follow-up after finish");

    // Same end-of-turn race via explicit /steer command
    let releaseSecond!: () => void;
    let secondStarted!: () => void;
    const secondReady = new Promise<void>((r) => {
      secondStarted = r;
    });
    let phase2Calls = 0;
    backend.turnHandler = async (input) => {
      phase2Calls += 1;
      if (phase2Calls === 1) {
        secondStarted();
        await new Promise<void>((r) => {
          releaseSecond = r;
        });
        return { sessionId: "sess-1", text: "Second done", stopReason: "end_turn" };
      }
      return { sessionId: "sess-1", text: `CmdImmediate: ${input.text}`, stopReason: "end_turn" };
    };

    const p2 = router.handleInbound(makeInbound({ id: "race-3", text: "second turn" }));
    await secondReady;
    backend.steerTurn = async () => {
      releaseSecond();
      await p2;
      return false;
    };

    await router.handleInbound(makeInbound({ id: "race-4", text: "/steer run now" }));
    expect(backend.cancelledChats).toEqual([]);
    expect(photon.sent.at(-1)?.text).toBe("CmdImmediate: run now");
  });
});

describe("v0.4.3 Photon capability gating & context-aware /help", () => {
  it("classifies unsupported Photon backend errors accurately without false positives", () => {
    expect(
      isUnsupportedPhotonBackendError(new Error("12 UNIMPLEMENTED: poll unavailable")),
    ).toBe(true);
    expect(
      isUnsupportedPhotonBackendError(
        Object.assign(new Error("rpc error"), { name: "UnsupportedError" }),
      ),
    ).toBe(true);
    expect(
      isUnsupportedPhotonBackendError(Object.assign(new Error("rpc"), { code: 12 })),
    ).toBe(true);
    expect(
      isUnsupportedPhotonBackendError(Object.assign(new Error("rpc"), { code: 7 })),
    ).toBe(true);
    expect(
      isUnsupportedPhotonBackendError(
        new Error("outer wrapper", {
          cause: Object.assign(new Error("inner"), { code: 12 }),
        }),
      ),
    ).toBe(true);
    expect(
      isUnsupportedPhotonBackendError("Action not supported in shared mode"),
    ).toBe(true);
    expect(
      isUnsupportedPhotonBackendError("FAILED_PRECONDITION: requires dedicated line"),
    ).toBe(true);
    expect(
      isUnsupportedPhotonBackendError("PERMISSION_DENIED: not available on this plan"),
    ).toBe(true);
    expect(isUnsupportedPhotonBackendError("feature not enabled")).toBe(true);

    expect(isUnsupportedPhotonBackendError("Unknown background preset: foo")).toBe(false);
    expect(isUnsupportedPhotonBackendError("2-minute window elapsed")).toBe(false);
    expect(isUnsupportedPhotonBackendError(new Error("ETIMEDOUT"))).toBe(false);
    expect(isUnsupportedPhotonBackendError(null)).toBe(false);
  });

  it("gates disabled Photon commands via PHOTON_NATIVE_COMMANDS while keeping -h help available", async () => {
    const photon = new FakePhotonAdapter();
    const { router } = await setupRouterWithHub({
      adapters: [photon],
      photonNativeCommands: new Set(["unsend"]),
    });

    const onPhoton = (text: string) => router.handleInbound(makeInbound({ text }));

    await onPhoton("/poll Q | A | B");
    expect(photon.sent.at(-1)?.text).toContain(
      "disabled on this gateway (configured via PHOTON_NATIVE_COMMANDS)",
    );
    expect(photon.pollCalls).toHaveLength(0);

    await onPhoton("/bg skyDusk");
    expect(photon.sent.at(-1)?.text).toContain("disabled on this gateway");
    expect(photon.bgCalls).toHaveLength(0);

    await onPhoton("/card");
    expect(photon.sent.at(-1)?.text).toContain("disabled on this gateway");
    expect(photon.cardCalls).toHaveLength(0);

    // Help still works for disabled commands
    await onPhoton("/poll -h");
    expect(photon.sent.at(-1)?.text).toContain("Usage: /poll");

    // Enabled command still runs
    await onPhoton("/unsend");
    expect(photon.unsendCalls).toHaveLength(1);
    expect(photon.sent.at(-1)?.text).toContain("Retracted last message");
  });

  it("detects runtime unsupported Photon errors, caches unsupported state, and hides them from /help", async () => {
    const photon = new FakePhotonAdapter();
    const { router } = await setupRouterWithHub({ adapters: [photon] });
    const onPhoton = (text: string) => router.handleInbound(makeInbound({ text }));

    photon.pollError = new Error("12 UNIMPLEMENTED: polls require dedicated line");
    await onPhoton("/poll Lunch | Sushi | Ramen");
    expect(photon.sent.at(-1)?.text).toContain(
      "not supported by your current Photon backend/line",
    );
    expect(photon.sent.at(-1)?.text).toContain("PHOTON_NATIVE_COMMANDS");
    expect(photon.pollCalls).toHaveLength(1);

    // Second call short-circuits without hitting the adapter again
    await onPhoton("/poll Dinner | Pizza | Pasta");
    expect(photon.sent.at(-1)?.text).toContain(
      "not supported by the current Photon backend/line",
    );
    expect(photon.pollCalls).toHaveLength(1);

    // Background & card errors also mark unsupported
    photon.bgError = new Error("PERMISSION_DENIED: background not available on this plan");
    await onPhoton("/bg skyDusk");
    expect(photon.sent.at(-1)?.text).toContain("PHOTON_NATIVE_COMMANDS");
    expect(photon.bgCalls).toHaveLength(1);
    await onPhoton("/bg clear");
    expect(photon.bgCalls).toHaveLength(1);

    photon.cardError = new Error("UnsupportedError: shared mode");
    await onPhoton("/card");
    expect(photon.sent.at(-1)?.text).toContain("PHOTON_NATIVE_COMMANDS");
    expect(photon.cardCalls).toHaveLength(1);

    // Unsend normal failure does NOT mark unsupported
    photon.nextUnsendResult = { ok: false, reason: "2-minute window elapsed" };
    await onPhoton("/unsend");
    expect(photon.sent.at(-1)?.text).toContain("2-minute window elapsed");

    // /help now shows ONLY /unsend in Photon section
    await onPhoton("/help");
    const helpAfterPartial = photon.sent.at(-1)?.text ?? "";
    expect(helpAfterPartial).toContain("Photon iMessage native:");
    expect(helpAfterPartial).toContain("/unsend");
    expect(helpAfterPartial).not.toContain("/poll");
    expect(helpAfterPartial).not.toContain("/bg");
    expect(helpAfterPartial).not.toContain("/card");

    // Unsend returning unsupported reason marks it unsupported -> /help hides entire Photon block
    photon.nextUnsendResult = { ok: false, reason: "FAILED_PRECONDITION: not supported" };
    await onPhoton("/unsend");
    expect(photon.sent.at(-1)?.text).toContain("PHOTON_NATIVE_COMMANDS");

    await onPhoton("/help");
    const helpAfterAll = photon.sent.at(-1)?.text ?? "";
    expect(helpAfterAll).not.toContain("Photon iMessage native:");
    expect(helpAfterAll).not.toContain("/unsend");
  });

  it("renders context-aware /help on non-Photon channels and preserves HELP_TEXT compatibility", async () => {
    const tg = new RecordingAdapter("telegram");
    const { router } = await setupRouterWithHub({ adapters: [tg] });

    await router.handleInbound(
      makeInbound({
        channel: "telegram",
        chatId: "telegram::chat-1",
        senderId: "user-1",
        text: "/help",
      }),
    );
    const tgHelp = tg.sent.at(-1)?.text ?? "";
    expect(tgHelp).toContain("/steer (/s, /inject)");
    expect(tgHelp).toContain("/busy [steer|queue|interrupt]");
    expect(tgHelp).not.toContain("Photon iMessage native:");
    expect(tgHelp).not.toContain("/poll");

    // Standalone helper & backwards-compatible HELP_TEXT
    expect(HELP_TEXT).toContain("Photon iMessage native:");
    expect(HELP_TEXT).toContain("/poll");
    expect(HELP_TEXT).toContain("/steer (/s, /inject)");
    expect(
      formatHelpText({ channel: "photon", enabledPhotonCommands: ["card"] }),
    ).toContain("/card");
    expect(
      formatHelpText({ channel: "photon", enabledPhotonCommands: [] }),
    ).not.toContain("Photon iMessage native:");
  });
});
