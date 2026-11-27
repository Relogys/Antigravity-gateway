import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MultiChannelHub } from "../src/channels/hub.js";
import { isPhotonChannel, type GatewayConfig } from "../src/config.js";
import {
  GatewayRouter,
  type ExtendedAgentBackend,
  type ExtendedChannelAdapter,
} from "../src/gateway/router.js";
import { LoopScheduler } from "../src/gateway/scheduler.js";
import { GatewayStore } from "../src/gateway/store.js";
import { PHOTON_BACKGROUND_PRESETS } from "../src/photon/adapter.js";
import type {
  AcpSessionSummary,
  AgentTurnInput,
  AgentTurnResult,
  ChannelAdapter,
  InboundMessage,
  OutboundMessage,
  ToolCallEvent,
  TurnActivitySnapshot,
} from "../src/types.js";

const tempDirs: string[] = [];

async function createTempDir(prefix = "agw-wave10-"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
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
    allowedSenders: new Set(["+15550001111", "telegram:1001", "discord:2002"]),
    allowGroups: false,
    groupMentionPatterns: ["@agy"],
    agyBin: "agy",
    defaultCwd: dataDir,
    approvalMode: "interactive",
    defaultModel: "gemini-4-neon",
    defaultEffort: "high",
    healthEnabled: false,
    healthHost: "127.0.0.1",
    healthPort: 0,
    quotaWarnThreshold: 0,
    progressSilenceMs: 0,
    sessionStallTimeoutMs: 0,
    toolProgressEditIntervalMs: 0,
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
    channel: "telegram",
    chatId: "telegram::chat-1",
    senderId: "1001",
    isGroup: false,
    text: "hello",
    attachments: [],
    timestamp: Date.now(),
    mentionsBot: true,
    ...overrides,
  };
}

interface AdapterEvent {
  op: "send" | "edit" | "delete" | "typing" | "react";
  chatId: string;
  messageId?: string;
  text?: string;
  active?: boolean;
  emoji?: string;
}

/** Fully instrumented ChannelAdapter that records the full outbound event stream. */
class RecordingAdapter implements ChannelAdapter {
  connected = true;
  events: AdapterEvent[] = [];
  private seq = 0;

  constructor(readonly name: string) {}

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
    this.seq += 1;
    const messageId = `${this.name}-msg-${this.seq}`;
    this.events.push({ op: "send", chatId: msg.chatId, messageId, text: msg.text });
    return { messageId };
  }
  async sendTyping(chatId: string, active: boolean): Promise<void> {
    this.events.push({ op: "typing", chatId, active });
  }
  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    this.events.push({ op: "react", chatId, messageId, emoji });
  }
  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    this.events.push({ op: "edit", chatId, messageId, text });
  }
  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    this.events.push({ op: "delete", chatId, messageId });
  }
}

/** Adds the Photon-native iMessage surface on top of the recording adapter. */
class FakePhotonAdapter extends RecordingAdapter {
  pollCalls: Array<{ chatId: string; title: string; options: string[] }> = [];
  backgroundCalls: Array<{ chatId: string; value: string }> = [];
  contactCardCalls: string[] = [];
  unsendCalls: string[] = [];
  nextUnsend: { ok: boolean; messageId?: string; reason?: string } = { ok: true };

  constructor(name = "photon") {
    super(name);
  }

  async sendPoll(
    chatId: string,
    title: string,
    options: string[],
  ): Promise<{ messageId?: string }> {
    this.pollCalls.push({ chatId, title, options });
    return { messageId: `${this.name}-poll-${this.pollCalls.length}` };
  }

  async setBackground(chatId: string, presetOrClear: string): Promise<void> {
    const canonical = presetOrClear.trim().toLowerCase();
    if (canonical !== "clear") {
      const known = PHOTON_BACKGROUND_PRESETS.some(
        (preset) => preset.toLowerCase() === canonical,
      );
      if (!known) {
        throw new Error(
          `Unknown background preset "${presetOrClear}". Valid presets: ${PHOTON_BACKGROUND_PRESETS.join(", ")} (or "clear").`,
        );
      }
    }
    this.backgroundCalls.push({ chatId, value: presetOrClear });
  }

  async shareContactCard(chatId: string): Promise<void> {
    this.contactCardCalls.push(chatId);
  }

  async unsendLastMessage(
    chatId: string,
  ): Promise<{ ok: boolean; messageId?: string; reason?: string }> {
    this.unsendCalls.push(chatId);
    return this.nextUnsend;
  }
}

class RecordingBackend implements ExtendedAgentBackend {
  turnCalls: AgentTurnInput[] = [];
  activity?: TurnActivitySnapshot;
  turnHandler?: (input: AgentTurnInput) => Promise<AgentTurnResult>;

  async stop(): Promise<void> {}

  async sendTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    this.turnCalls.push(input);
    if (this.turnHandler) {
      return this.turnHandler(input);
    }
    return { sessionId: "sess-1", text: `Echo: ${input.text}`, stopReason: "end_turn" };
  }

  async cancelTurn(): Promise<boolean> {
    return false;
  }

  async resetSession(): Promise<void> {}

  async listSessions(): Promise<AcpSessionSummary[]> {
    return [];
  }

  getTurnActivity(): TurnActivitySnapshot | undefined {
    return this.activity;
  }
}

interface SetupOptions {
  config?: Partial<GatewayConfig>;
  backend?: RecordingBackend;
}

async function setupHub(adapters: ChannelAdapter[], options: SetupOptions = {}) {
  const dataDir = await createTempDir();
  const store = new GatewayStore(dataDir);
  await store.load();
  const hub = new MultiChannelHub(adapters, { log: () => {} });
  const backend = options.backend ?? new RecordingBackend();
  const config = makeConfig(dataDir, options.config);
  const scheduler = new LoopScheduler({ store, channel: hub });
  const router = new GatewayRouter({
    config,
    channel: hub,
    backend,
    store,
    scheduler,
    progressPollIntervalMs: 10,
    quotaFetcher: async () => ({ available: false, fetchedAt: Date.now(), groups: [] }),
  });
  router.markReady();
  await hub.start(() => {});
  return { dataDir, store, hub, backend, config, router };
}

function sendTexts(adapter: RecordingAdapter): string[] {
  return adapter.events
    .filter((event) => event.op === "send")
    .map((event) => event.text ?? "");
}

function sendEventWith(
  adapter: RecordingAdapter,
  needle: string,
): AdapterEvent | undefined {
  return adapter.events.find(
    (event) => event.op === "send" && (event.text ?? "").includes(needle),
  );
}

function toolCall(id: string, title: string, status = "in_progress"): ToolCallEvent {
  return { toolCallId: id, title, status };
}

// -------------------------------------------------------------- live progress

describe("Live editable tool progress (Telegram/Discord)", () => {
  it("edits one status card in place, then deletes it BEFORE the final reply (auto, keep=false)", async () => {
    const tg = new RecordingAdapter("telegram");
    const { router, backend } = await setupHub([tg]);

    backend.turnHandler = async (input) => {
      await input.callbacks?.onToolCall?.(toolCall("t1", "Read package.json"));
      await delay(30);
      await input.callbacks?.onToolCall?.(toolCall("t2", "Run pnpm test", "completed"));
      await delay(30);
      return {
        sessionId: "sess-1",
        text: "Done. Final answer.",
        stopReason: "end_turn",
      };
    };

    await router.handleInbound(makeInbound({ text: "build the project" }));

    const statusSends = tg.events.filter(
      (event) => event.op === "send" && (event.text ?? "").includes("处理中"),
    );
    expect(statusSends).toHaveLength(1);
    const statusId = statusSends[0]?.messageId;
    expect(statusId).toBeTruthy();

    // The single status message was edited in place (not re-sent).
    expect(tg.events.filter((event) => event.op === "edit").length).toBeGreaterThanOrEqual(1);

    const deleteEvent = tg.events.find(
      (event) => event.op === "delete" && event.messageId === statusId,
    );
    expect(deleteEvent).toBeTruthy();

    const finalSend = sendEventWith(tg, "Final answer");
    expect(finalSend).toBeTruthy();

    // Cleanup of the status card must land before the final answer.
    expect(tg.events.indexOf(deleteEvent!)).toBeLessThan(tg.events.indexOf(finalSend!));
  });

  it("keeps a ✅ summary above the final reply when toolProgressKeep is true", async () => {
    const tg = new RecordingAdapter("telegram");
    const { router, backend } = await setupHub([tg], { config: { toolProgressKeep: true } });

    backend.turnHandler = async (input) => {
      await input.callbacks?.onToolCall?.(toolCall("t1", "Read package.json"));
      await delay(25);
      await input.callbacks?.onToolCall?.(toolCall("t2", "Run pnpm test", "completed"));
      await delay(25);
      return { sessionId: "sess-1", text: "Final answer.", stopReason: "end_turn" };
    };

    await router.handleInbound(makeInbound({ text: "build the project" }));

    const summary = tg.events.find(
      (event) =>
        event.op === "edit" &&
        (event.text ?? "").includes("✅") &&
        (event.text ?? "").includes("已完成"),
    );
    expect(summary).toBeTruthy();

    // Kept: the card is never deleted.
    expect(tg.events.some((event) => event.op === "delete")).toBe(false);

    const finalSend = sendEventWith(tg, "Final answer");
    expect(finalSend).toBeTruthy();
    expect(tg.events.indexOf(summary!)).toBeLessThan(tg.events.indexOf(finalSend!));
  });

  it("keeps the summary when /progress keep is set for the chat", async () => {
    const tg = new RecordingAdapter("telegram");
    const { router, backend } = await setupHub([tg]);

    await router.handleInbound(makeInbound({ text: "/progress keep" }));
    expect(sendTexts(tg).at(-1)).toContain("on-finish=keep");

    backend.turnHandler = async (input) => {
      await input.callbacks?.onToolCall?.(toolCall("t1", "Read package.json"));
      await delay(25);
      await input.callbacks?.onToolCall?.(toolCall("t2", "Run pnpm test", "completed"));
      await delay(25);
      return { sessionId: "sess-1", text: "Final answer.", stopReason: "end_turn" };
    };

    await router.handleInbound(makeInbound({ text: "build the project" }));

    const summary = tg.events.find(
      (event) =>
        event.op === "edit" &&
        (event.text ?? "").includes("✅") &&
        (event.text ?? "").includes("已完成"),
    );
    expect(summary).toBeTruthy();
    expect(tg.events.some((event) => event.op === "delete")).toBe(false);
  });
});

describe("Live progress on Photon (auto) uses silence pulses", () => {
  it("does not spawn a live edit card and truncates a 300-char tool name to ≤48 single-line chars", async () => {
    const rawTool =
      `Invoke-RestMethod -Uri https://example.com/${"a".repeat(260)}`;
    expect(rawTool.length).toBeGreaterThan(250);

    const photon = new FakePhotonAdapter("photon");
    const backend = new RecordingBackend();
    backend.activity = {
      chatId: "photon::+15550001111",
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      phase: "tool",
      currentTool: rawTool,
      toolCount: 3,
      retryCount: 0,
      maxRetries: 2,
    };
    backend.turnHandler = async () => {
      await delay(160);
      return { sessionId: "sess-1", text: "Done.", stopReason: "end_turn" };
    };

    const { router } = await setupHub([photon], {
      backend,
      config: { progressSilenceMs: 30, sessionStallTimeoutMs: 300_000 },
    });

    await router.handleInbound(
      makeInbound({
        channel: "photon",
        chatId: "photon::+15550001111",
        senderId: "+15550001111",
        text: "scan the repo",
      }),
    );

    // No in-place live card on iMessage/Photon.
    expect(photon.events.some((event) => event.op === "edit")).toBe(false);
    expect(
      photon.events.some(
        (event) => event.op === "send" && (event.text ?? "").includes("⚙️ **["),
      ),
    ).toBe(false);

    const pulses = sendTexts(photon).filter((text) => text.includes("正在执行工具"));
    expect(pulses.length).toBeGreaterThan(0);

    const match = /正在执行工具「(.+?)」/.exec(pulses[0]!);
    expect(match).toBeTruthy();
    const displayedTool = match![1]!;
    expect(Array.from(displayedTool).length).toBeLessThanOrEqual(48);
    expect(displayedTool).not.toContain("\n");
    expect(displayedTool.endsWith("…")).toBe(true);
    expect(pulses[0]).not.toContain(rawTool);
  });
});

// --------------------------------------------------------------- /progress

describe("/progress command", () => {
  it("shows usage, applies single & combined tokens, and rejects invalid input", async () => {
    const tg = new RecordingAdapter("telegram");
    const { router } = await setupHub([tg]);
    const last = () => sendTexts(tg).at(-1) ?? "";
    const send = (text: string) => router.handleInbound(makeInbound({ text }));

    await send("/progress -h");
    expect(last()).toContain("Tool progress:");
    expect(last()).toContain("Usage: /progress");

    await send("/progress keep");
    expect(last()).toContain("mode=auto");
    expect(last()).toContain("on-finish=keep");

    await send("/progress delete");
    expect(last()).toContain("on-finish=delete");

    await send("/progress edit");
    expect(last()).toContain("mode=edit");

    await send("/progress silence");
    expect(last()).toContain("mode=silence");

    await send("/progress off");
    expect(last()).toContain("mode=off");

    await send("/progress edit keep");
    expect(last()).toContain("mode=edit");
    expect(last()).toContain("on-finish=keep");

    await send("/progress bogus");
    expect(last()).toContain("Invalid option: bogus");
    expect(last()).toContain("Usage: /progress");
  });
});

// ------------------------------------------------------------ Photon natives

describe("Photon native commands", () => {
  function photonSetup() {
    const photon = new FakePhotonAdapter("photon");
    return setupHub([photon]).then((ctx) => ({ ...ctx, photon }));
  }

  it("runs /poll, /bg, /card, and /unsend on the Photon channel", async () => {
    const { router, photon } = await photonSetup();
    const last = () => sendTexts(photon).at(-1) ?? "";
    const onPhoton = (text: string) =>
      router.handleInbound(
        makeInbound({
          channel: "photon",
          chatId: "photon::+15550001111",
          senderId: "+15550001111",
          text,
        }),
      );

    await onPhoton("/poll -h");
    expect(last()).toContain("Usage: /poll");

    await onPhoton("/poll Best language | Go | Rust");
    expect(last()).toContain("📊 Poll created: Best language (2 options)");
    expect(photon.pollCalls.at(-1)).toEqual({
      chatId: "+15550001111",
      title: "Best language",
      options: ["Go", "Rust"],
    });

    // Full-width pipe (Chinese IME) must split the same way.
    await onPhoton("/poll 最佳语言 ｜ Go ｜ Rust");
    expect(photon.pollCalls.at(-1)).toMatchObject({
      title: "最佳语言",
      options: ["Go", "Rust"],
    });

    await onPhoton("/poll only a question");
    expect(last()).toContain("Usage: /poll");

    await onPhoton("/bg -h");
    expect(last()).toContain("Usage: /bg");
    expect(last()).toContain("/bg list");

    await onPhoton("/bg list");
    const list = last();
    expect(list).toContain("skyDusk");
    expect(list).toContain("auroraGreen");
    expect(list).toContain("colorCarbon");
    expect(list).toContain("clear");
    expect(list).toContain("/bg <preset|clear|list>");

    await onPhoton("/bg skyDusk");
    expect(photon.backgroundCalls.at(-1)).toEqual({
      chatId: "+15550001111",
      value: "skyDusk",
    });
    expect(last()).toContain("🎨 Chat background updated to: skyDusk");

    await onPhoton("/bg clear");
    expect(photon.backgroundCalls.at(-1)).toEqual({
      chatId: "+15550001111",
      value: "clear",
    });
    expect(last()).toContain("🎨 Chat background cleared.");

    await onPhoton("/bg notapreset");
    expect(last()).toContain("Unknown background preset");

    await onPhoton("/card");
    expect(photon.contactCardCalls).toContain("+15550001111");
    expect(last()).toContain("🪪 Native contact card shared to this chat.");

    await onPhoton("/unsend");
    expect(photon.unsendCalls).toContain("+15550001111");
    expect(last()).toContain("↩️ Retracted last message.");

    photon.nextUnsend = { ok: false, reason: "2-minute window elapsed" };
    await onPhoton("/unsend");
    expect(last()).toContain("⚠️ Could not unsend: 2-minute window elapsed");
  });

  it("rejects every Photon-native command on a non-Photon channel", async () => {
    const tg = new RecordingAdapter("telegram");
    const { router } = await setupHub([tg]);
    const last = () => sendTexts(tg).at(-1) ?? "";
    const onTelegram = (text: string) =>
      router.handleInbound(
        makeInbound({ channel: "telegram", chatId: "telegram::chat-1", text }),
      );

    for (const text of [
      "/poll A | B | C",
      "/bg list",
      "/card",
      "/unsend",
    ]) {
      await onTelegram(text);
      expect(last()).toContain("only supported on the Photon iMessage channel");
    }

    // No Photon-native adapter exists on the hub, so nothing leaked through.
    expect(isPhotonChannel("telegram")).toBe(false);
    expect(tg.events.some((event) => event.op === "edit")).toBe(false);
  });
});

// ----------------------------------------------------- global IDE link strip

describe("Global IDE file-link stripping", () => {
  it("renders [router.ts](file:///... #L10-L20) as inline code before delivery", async () => {
    const tg = new RecordingAdapter("telegram");
    const { router, backend } = await setupHub([tg]);

    backend.turnHandler = async () => ({
      sessionId: "sess-1",
      text: "See [router.ts](file:///secret/path/router.ts#L10-L20) for the handler.",
      stopReason: "end_turn",
    });

    await router.handleInbound(makeInbound({ text: "where is the handler?" }));

    const reply = sendTexts(tg).at(-1) ?? "";
    expect(reply).toContain("router.ts:10-20");
    expect(reply).not.toContain("file:///");
    expect(reply).not.toContain("#L10");
  });
});