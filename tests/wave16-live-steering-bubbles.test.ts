import * as acp from "@agentclientprotocol/sdk";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgyAcpClient,
  type AcpPermissionHandler,
  type NewSessionInfo,
} from "../src/acp/client.js";
import { AgyAgentBackend, type AgyAcpClientLike } from "../src/acp/sessions.js";
import { parsePhotonNativeCommands, type GatewayConfig } from "../src/config.js";
import type { GatewayStore } from "../src/gateway/store.js";
import { TurnExecutor, type TurnExecutorHost } from "../src/gateway/turn-executor.js";
import type {
  AcpSessionSummary,
  AgentTurnCallbacks,
  AgentTurnInput,
  AgentTurnResult,
  InboundAttachment,
  InboundMessage,
  OutboundActionButton,
  SessionInfo,
} from "../src/types.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeTestConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    allowedSenders: new Set(["+15550001111"]),
    allowGroups: false,
    groupMentionPatterns: ["@agy", "@antigravity"],
    agyBin: "agy",
    defaultCwd: "/tmp/workspace",
    channelDefaultCwds: {},
    approvalMode: "auto",
    defaultBusyMode: "queue",
    streamIntermediateReplies: true,
    healthEnabled: false,
    healthHost: "127.0.0.1",
    healthPort: 18790,
    quotaWarnThreshold: 15,
    progressSilenceMs: 0,
    sessionStallTimeoutMs: 0,
    turnMaxRetries: 0,
    ingressDebounceMs: 0,
    autoBootstrapChannelSession: false,
    dataDir: "/tmp/data",
    logLevel: "info",
    ...overrides,
  };
}

function makeInboundMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: "msg-user-1",
    channel: "photon",
    chatId: "chat-1",
    senderId: "+15550001111",
    isGroup: false,
    text: "Run diagnostics",
    attachments: [],
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

interface RecordedReply {
  chatId: string;
  text: string;
  replyToMessageId?: string;
  mediaPaths?: string[];
  actions?: OutboundActionButton[];
}

interface TurnExecutorHarness {
  executor: TurnExecutor;
  sentReplies: RecordedReply[];
  typingCalls: Array<{ chatId: string; active: boolean }>;
  reactions: Array<{ chatId: string; messageId: string; emoji: string }>;
  recordedErrors: string[];
}

function createTurnExecutorHarness(options: {
  config?: Partial<GatewayConfig>;
  sendTurn: (input: AgentTurnInput) => Promise<AgentTurnResult>;
  sendReplyImpl?: (reply: RecordedReply, callIndex: number) => Promise<void> | void;
  onboarded?: boolean;
}): TurnExecutorHarness {
  const config = makeTestConfig(options.config);
  const sentReplies: RecordedReply[] = [];
  const typingCalls: Array<{ chatId: string; active: boolean }> = [];
  const reactions: Array<{ chatId: string; messageId: string; emoji: string }> = [];
  const recordedErrors: string[] = [];

  const sessionRecord: SessionInfo = {
    chatId: "chat-1",
    sessionId: "sess-1",
    cwd: config.defaultCwd,
    approvalMode: config.approvalMode,
    busyMode: "queue",
    onboarded: options.onboarded ?? true,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };

  const channel: TurnExecutorHost["channel"] = {
    name: "photon",
    start: async () => {},
    stop: async () => {},
    isConnected: () => true,
    sendMessage: async () => ({ messageId: "out-1" }),
    sendTyping: async (chatId: string, active: boolean) => {
      typingCalls.push({ chatId, active });
    },
    react: async (chatId: string, messageId: string, emoji: string) => {
      reactions.push({ chatId, messageId, emoji });
    },
  };

  const backend: TurnExecutorHost["backend"] = {
    stop: async () => {},
    sendTurn: options.sendTurn,
    cancelTurn: async () => false,
    resetSession: async () => {},
    listSessions: async () => [],
  };

  const store = {
    getSession: () => sessionRecord,
  } as unknown as GatewayStore;

  let replyCallCount = 0;

  const host: TurnExecutorHost = {
    config,
    channel,
    backend,
    store,
    typingIntervalMs: 0,
    progressPollIntervalMs: 60_000,
    rememberLastPrompt: () => {},
    withReplyQuote: (_msg, text) => text,
    getSessionGeneration: () => 0,
    consumeStopDrain: () => false,
    consumeUserCancel: () => false,
    shiftChatQueue: () => undefined,
    reactionsEnabled: () => true,
    resolveDefaultCwd: () => config.defaultCwd,
    resolveChannelGroup: () => "default",
    getChatApprovalMode: () => config.approvalMode,
    getChatBusyMode: () => "queue",
    getChatVerbosity: () => "normal",
    getChatToolProgressMode: () => "off",
    getChatToolProgressKeep: () => false,
    shouldUseLiveProgressEdit: () => false,
    ensureSessionRecord: async (_chatId, patch) => ({
      ...sessionRecord,
      ...patch,
    }),
    maybeGetLowQuotaNotice: async () => "",
    recordError: (message) => {
      recordedErrors.push(message);
    },
    sendReply: async (chatId, text, replyToMessageId, mediaPaths, actions) => {
      const callIndex = replyCallCount++;
      const entry: RecordedReply = {
        chatId,
        text,
        replyToMessageId,
        mediaPaths,
        actions,
      };
      if (options.sendReplyImpl) {
        await options.sendReplyImpl(entry, callIndex);
      }
      sentReplies.push(entry);
    },
  };

  return {
    executor: new TurnExecutor(host),
    sentReplies,
    typingCalls,
    reactions,
    recordedErrors,
  };
}

class MockSteerableAcpClient implements AgyAcpClientLike {
  sessionSeq = 0;
  promptHandler?: (
    sessionId: string,
    input: {
      text: string;
      attachments?: InboundAttachment[];
      callbacks?: AgentTurnCallbacks;
      permissionHandler?: AcpPermissionHandler;
    },
  ) => Promise<AgentTurnResult>;
  steerMock = vi.fn<
    (
      sessionId: string,
      input: { text: string; attachments?: InboundAttachment[] },
    ) => Promise<boolean>
  >(async () => true);

  async ensureStarted(): Promise<void> {}
  async stop(): Promise<void> {}

  async newSession(_cwd: string): Promise<NewSessionInfo> {
    this.sessionSeq += 1;
    return { sessionId: `sess-${this.sessionSeq}` };
  }

  async loadSession(_sessionId: string, _cwd: string): Promise<void> {}
  async listSessions(_cwd?: string): Promise<AcpSessionSummary[]> {
    return [];
  }
  async setConfigOption(
    _sessionId: string,
    _configId: string,
    _value: string,
  ): Promise<void> {}
  async setMode(_sessionId: string, _modeId: string): Promise<void> {}

  async prompt(
    sessionId: string,
    input: {
      text: string;
      attachments?: InboundAttachment[];
      callbacks?: AgentTurnCallbacks;
      permissionHandler?: AcpPermissionHandler;
    },
  ): Promise<AgentTurnResult> {
    if (this.promptHandler) {
      return this.promptHandler(sessionId, input);
    }
    return {
      sessionId,
      text: `echo:${input.text}`,
      stopReason: "end_turn",
    };
  }

  async steer(
    sessionId: string,
    input: { text: string; attachments?: InboundAttachment[] },
  ): Promise<boolean> {
    return this.steerMock(sessionId, input);
  }

  async cancel(_sessionId: string): Promise<void> {}
  getAvailableModels(): string[] {
    return ["gemini-4-neon-high"];
  }
  getAvailableBaseModels(): string[] {
    return ["gemini-4-neon"];
  }
  getAvailableEfforts(): string[] {
    return ["low", "medium", "high", "xhigh"];
  }
  getAvailableModes(): string[] {
    return ["default", "auto"];
  }
}

interface FakePromptRequestRecord {
  method: string;
  params: { sessionId: string; prompt: acp.ContentBlock[] };
  deferred: Deferred<acp.PromptResponse>;
}

function attachFakeAcpConnection(client: AgyAcpClient): {
  requests: FakePromptRequestRecord[];
  emitUpdate: (notification: acp.SessionNotification) => Promise<void>;
} {
  const requests: FakePromptRequestRecord[] = [];
  const fakeProc = {
    exitCode: null,
    killed: false,
    kill: vi.fn(),
    once: vi.fn(),
  } as unknown as ChildProcess;

  const fakeConn = {
    agent: {
      request: vi.fn((method: string, params: unknown) => {
        const deferred = createDeferred<acp.PromptResponse>();
        requests.push({
          method,
          params: params as FakePromptRequestRecord["params"],
          deferred,
        });
        return deferred.promise;
      }),
      notify: vi.fn(async () => {}),
    },
    close: vi.fn(),
    closed: new Promise<void>(() => {}),
  } as unknown as acp.ClientConnection;

  const internal = client as unknown as {
    proc: ChildProcess | null;
    connection: acp.ClientConnection | null;
    handleSessionUpdate: (notification: acp.SessionNotification) => Promise<void>;
  };
  internal.proc = fakeProc;
  internal.connection = fakeConn;

  return {
    requests,
    emitUpdate: (notification) => internal.handleSessionUpdate(notification),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TurnExecutor pre-tool-call intermediate bubble flushing", () => {
  it("flushes pre-tool text immediately before sendTurn finishes, re-triggers typing, and sends only post-tool text as Bubble 2", async () => {
    const toolEntered = createDeferred<void>();
    const releaseTurn = createDeferred<void>();
    const msg = makeInboundMessage({ id: "msg-quote-1", chatId: "chat-1" });

    const harness = createTurnExecutorHarness({
      sendTurn: async (input) => {
        await input.callbacks?.onTextDelta?.("Let me check ");
        await input.callbacks?.onTextDelta?.("the logs first.");
        await input.callbacks?.onToolCall?.({
          toolCallId: "tc-1",
          title: "read_logs",
          status: "in_progress",
        });
        toolEntered.resolve();

        await releaseTurn.promise;

        await input.callbacks?.onTextDelta?.("Logs look clean — no errors found.");
        return {
          sessionId: "sess-1",
          text: "Let me check the logs first.Logs look clean — no errors found.",
          stopReason: "end_turn",
        };
      },
    });

    const turnPromise = harness.executor.executeTurn(msg, msg.text, []);
    await toolEntered.promise;

    // Bubble 1 must already be delivered BEFORE sendTurn completes.
    expect(harness.sentReplies).toHaveLength(1);
    expect(harness.sentReplies[0]).toMatchObject({
      chatId: "chat-1",
      text: "Let me check the logs first.",
      replyToMessageId: "msg-quote-1",
    });

    // Typing was started initially AND re-armed immediately after Bubble 1 flushed.
    expect(harness.typingCalls).toEqual([
      { chatId: "chat-1", active: true },
      { chatId: "chat-1", active: true },
    ]);

    releaseTurn.resolve();
    await turnPromise;

    // Bubble 2 contains ONLY post-tool text, does NOT quote msg.id again, and has zero duplication.
    expect(harness.sentReplies).toHaveLength(2);
    expect(harness.sentReplies[1]).toMatchObject({
      chatId: "chat-1",
      text: "Logs look clean — no errors found.",
      replyToMessageId: undefined,
    });
    expect(harness.sentReplies[1]?.text).not.toContain("Let me check");
    expect(harness.typingCalls).toEqual([
      { chatId: "chat-1", active: true },
      { chatId: "chat-1", active: true },
      { chatId: "chat-1", active: false },
    ]);
    expect(harness.reactions).toEqual([
      { chatId: "chat-1", messageId: "msg-quote-1", emoji: "👀" },
      { chatId: "chat-1", messageId: "msg-quote-1", emoji: "👍" },
    ]);
  });

  it("produces exactly 3 clean bubbles in strict order across a multi-tool turn without empty bubbles between back-to-back tools", async () => {
    const msg = makeInboundMessage({ id: "msg-multi-1" });

    const harness = createTurnExecutorHarness({
      sendTurn: async (input) => {
        await input.callbacks?.onTextDelta?.("Step 1: scanning workspace.");
        await input.callbacks?.onToolCall?.({
          toolCallId: "tc-1",
          title: "list_files",
          status: "in_progress",
        });
        // Second tool fires with no text in between -> must NOT emit an empty bubble.
        await input.callbacks?.onToolCall?.({
          toolCallId: "tc-2",
          title: "read_config",
          status: "in_progress",
        });

        await input.callbacks?.onTextDelta?.("Step 2: running unit tests.");
        await input.callbacks?.onToolCall?.({
          toolCallId: "tc-3",
          title: "run_tests",
          status: "in_progress",
        });

        await input.callbacks?.onTextDelta?.("All 12 tests passed.");
        return {
          sessionId: "sess-1",
          text: "Step 1: scanning workspace.Step 2: running unit tests.All 12 tests passed.",
          stopReason: "end_turn",
        };
      },
    });

    await harness.executor.executeTurn(msg, msg.text, []);

    expect(harness.sentReplies.map((r) => ({
      text: r.text,
      replyToMessageId: r.replyToMessageId,
    }))).toEqual([
      { text: "Step 1: scanning workspace.", replyToMessageId: "msg-multi-1" },
      { text: "Step 2: running unit tests.", replyToMessageId: undefined },
      { text: "All 12 tests passed.", replyToMessageId: undefined },
    ]);
    expect(harness.typingCalls.filter((t) => t.active)).toHaveLength(3);
    expect(harness.typingCalls.at(-1)).toEqual({ chatId: "chat-1", active: false });
  });

  it("does not emit an empty bubble when pre-tool text is whitespace-only", async () => {
    const toolEntered = createDeferred<void>();
    const releaseTurn = createDeferred<void>();
    const msg = makeInboundMessage({ id: "msg-ws-1" });

    const harness = createTurnExecutorHarness({
      sendTurn: async (input) => {
        await input.callbacks?.onTextDelta?.("   \n\t  \n ");
        await input.callbacks?.onToolCall?.({
          toolCallId: "tc-ws",
          title: "inspect",
          status: "in_progress",
        });
        toolEntered.resolve();

        await releaseTurn.promise;

        await input.callbacks?.onTextDelta?.("Actual final reply.");
        return {
          sessionId: "sess-1",
          text: "   \n\t  \n Actual final reply.",
          stopReason: "end_turn",
        };
      },
    });

    const turnPromise = harness.executor.executeTurn(msg, msg.text, []);
    await toolEntered.promise;

    expect(harness.sentReplies).toHaveLength(0);

    releaseTurn.resolve();
    await turnPromise;

    expect(harness.sentReplies).toHaveLength(1);
    expect(harness.sentReplies[0]?.text.trim()).toBe("Actual final reply.");
    expect(harness.sentReplies[0]?.replyToMessageId).toBe("msg-ws-1");
  });

  it("restores the failed segment into pendingSegment when intermediate sendReply rejects so final delivery loses nothing", async () => {
    // Case A: First intermediate flush fails -> final turn delivers complete combined text quoting msg.id.
    const msgA = makeInboundMessage({ id: "msg-fail-a" });
    const harnessA = createTurnExecutorHarness({
      sendReplyImpl: (_reply, callIndex) => {
        if (callIndex === 0) {
          throw new Error("socket reset");
        }
      },
      sendTurn: async (input) => {
        await input.callbacks?.onTextDelta?.("Checking service health... ");
        await input.callbacks?.onToolCall?.({
          toolCallId: "tc-a",
          title: "check_health",
          status: "in_progress",
        });
        await input.callbacks?.onTextDelta?.("Service is healthy.");
        return {
          sessionId: "sess-1",
          text: "Checking service health... Service is healthy.",
          stopReason: "end_turn",
        };
      },
    });

    await harnessA.executor.executeTurn(msgA, msgA.text, []);

    expect(harnessA.recordedErrors).toEqual([
      "Intermediate reply flush failed: socket reset",
    ]);
    expect(harnessA.sentReplies).toHaveLength(1);
    expect(harnessA.sentReplies[0]).toMatchObject({
      text: "Checking service health... Service is healthy.",
      replyToMessageId: "msg-fail-a",
    });

    // Case B: Bubble 1 succeeds, Bubble 2 flush fails -> restored into pendingSegment and combined with post-tool text without duplicating Bubble 1.
    const msgB = makeInboundMessage({ id: "msg-fail-b" });
    const harnessB = createTurnExecutorHarness({
      sendReplyImpl: (_reply, callIndex) => {
        if (callIndex === 1) {
          throw new Error("rate limited");
        }
      },
      sendTurn: async (input) => {
        await input.callbacks?.onTextDelta?.("Phase 1 done.");
        await input.callbacks?.onToolCall?.({
          toolCallId: "tc-b1",
          title: "step_one",
          status: "in_progress",
        });
        await input.callbacks?.onTextDelta?.("Phase 2 starting...");
        await input.callbacks?.onToolCall?.({
          toolCallId: "tc-b2",
          title: "step_two",
          status: "in_progress",
        });
        await input.callbacks?.onTextDelta?.(" Phase 2 complete.");
        return {
          sessionId: "sess-1",
          text: "Phase 1 done.Phase 2 starting... Phase 2 complete.",
          stopReason: "end_turn",
        };
      },
    });

    await harnessB.executor.executeTurn(msgB, msgB.text, []);

    expect(harnessB.recordedErrors).toEqual([
      "Intermediate reply flush failed: rate limited",
    ]);
    expect(harnessB.sentReplies.map((r) => ({
      text: r.text,
      replyToMessageId: r.replyToMessageId,
    }))).toEqual([
      { text: "Phase 1 done.", replyToMessageId: "msg-fail-b" },
      { text: "Phase 2 starting... Phase 2 complete.", replyToMessageId: undefined },
    ]);
  });

  it("disables intermediate flushing and sends one combined bubble when streamIntermediateReplies is false", async () => {
    const toolEntered = createDeferred<void>();
    const releaseTurn = createDeferred<void>();
    const msg = makeInboundMessage({ id: "msg-disabled-1" });

    const harness = createTurnExecutorHarness({
      config: { streamIntermediateReplies: false },
      sendTurn: async (input) => {
        await input.callbacks?.onTextDelta?.("Before tool.");
        await input.callbacks?.onToolCall?.({
          toolCallId: "tc-1",
          title: "run_cmd",
          status: "in_progress",
        });
        toolEntered.resolve();

        await releaseTurn.promise;

        await input.callbacks?.onTextDelta?.("\n\nAfter tool.");
        return {
          sessionId: "sess-1",
          text: "Before tool.\n\nAfter tool.",
          stopReason: "end_turn",
        };
      },
    });

    const turnPromise = harness.executor.executeTurn(msg, msg.text, []);
    await toolEntered.promise;

    expect(harness.sentReplies).toHaveLength(0);

    releaseTurn.resolve();
    await turnPromise;

    expect(harness.sentReplies).toHaveLength(1);
    expect(harness.sentReplies[0]).toMatchObject({
      text: "Before tool.\n\nAfter tool.",
      replyToMessageId: "msg-disabled-1",
    });
  });

  it("remains backward compatible when a backend returns { text } without invoking onTextDelta", async () => {
    const msg = makeInboundMessage({ id: "msg-legacy-1" });

    const harness = createTurnExecutorHarness({
      sendTurn: async (input) => {
        // Backend triggers a tool call without ever streaming deltas.
        await input.callbacks?.onToolCall?.({
          toolCallId: "tc-legacy",
          title: "legacy_tool",
          status: "completed",
        });
        return {
          sessionId: "sess-1",
          text: "Complete response from non-streaming backend.",
          stopReason: "end_turn",
        };
      },
    });

    await harness.executor.executeTurn(msg, msg.text, []);

    expect(harness.sentReplies).toHaveLength(1);
    expect(harness.sentReplies[0]).toMatchObject({
      text: "Complete response from non-streaming backend.",
      replyToMessageId: "msg-legacy-1",
    });
    expect(harness.reactions.at(-1)).toEqual({
      chatId: "chat-1",
      messageId: "msg-legacy-1",
      emoji: "👍",
    });
  });

  it("reacts with thumbs-up (not stop) and avoids duplicate empty replies when pre-tool text is sent and no post-tool text follows", async () => {
    const msg = makeInboundMessage({ id: "msg-notail-1" });

    const harness = createTurnExecutorHarness({
      sendTurn: async (input) => {
        await input.callbacks?.onTextDelta?.("I have updated the file for you.");
        await input.callbacks?.onToolCall?.({
          toolCallId: "tc-write",
          title: "write_file",
          status: "completed",
        });
        // No post-tool deltas emitted.
        return {
          sessionId: "sess-1",
          text: "I have updated the file for you.",
          stopReason: "end_turn",
        };
      },
    });

    await harness.executor.executeTurn(msg, msg.text, []);

    expect(harness.sentReplies).toHaveLength(1);
    expect(harness.sentReplies[0]).toMatchObject({
      text: "I have updated the file for you.",
      replyToMessageId: "msg-notail-1",
    });
    expect(harness.reactions).toEqual([
      { chatId: "chat-1", messageId: "msg-notail-1", emoji: "👀" },
      { chatId: "chat-1", messageId: "msg-notail-1", emoji: "👍" },
    ]);
  });

  it("flushPendingOutput(chatId) flushes buffered text cleanly before a mid-turn steer and is a no-op when idle", async () => {
    const textBuffered = createDeferred<void>();
    const releaseTurn = createDeferred<void>();
    const msg = makeInboundMessage({ id: "msg-steer-flush-1", chatId: "chat-1" });

    const harness = createTurnExecutorHarness({
      sendTurn: async (input) => {
        await input.callbacks?.onTextDelta?.("Drafting initial plan...");
        textBuffered.resolve();

        await releaseTurn.promise;

        await input.callbacks?.onTextDelta?.("Updated plan per your steer.");
        return {
          sessionId: "sess-1",
          text: "Drafting initial plan...Updated plan per your steer.",
          stopReason: "end_turn",
        };
      },
    });

    // Calling flushPendingOutput on an idle chat is a safe no-op.
    await expect(harness.executor.flushPendingOutput("chat-idle")).resolves.toBeUndefined();
    expect(harness.sentReplies).toHaveLength(0);

    const turnPromise = harness.executor.executeTurn(msg, msg.text, []);
    await textBuffered.promise;

    // Buffered text has not flushed yet because no tool call fired.
    expect(harness.sentReplies).toHaveLength(0);

    // Flush explicitly right before injecting a mid-turn steer.
    await harness.executor.flushPendingOutput("chat-1");

    expect(harness.sentReplies).toHaveLength(1);
    expect(harness.sentReplies[0]).toMatchObject({
      chatId: "chat-1",
      text: "Drafting initial plan...",
      replyToMessageId: "msg-steer-flush-1",
    });
    expect(harness.typingCalls).toEqual([
      { chatId: "chat-1", active: true },
      { chatId: "chat-1", active: true },
    ]);

    releaseTurn.resolve();
    await turnPromise;

    expect(harness.sentReplies).toHaveLength(2);
    expect(harness.sentReplies[1]).toMatchObject({
      chatId: "chat-1",
      text: "Updated plan per your steer.",
      replyToMessageId: undefined,
    });
  });
});

describe("AgyAgentBackend.steerTurn()", () => {
  it("returns false when no turn is active for chatId (unknown or idle)", async () => {
    const client = new MockSteerableAcpClient();
    const backend = new AgyAgentBackend(makeTestConfig(), { client });

    expect(await backend.steerTurn("chat-missing", "change direction")).toBe(false);
    expect(client.steerMock).not.toHaveBeenCalled();

    // Run a normal turn to establish a session, then verify steerTurn returns false once idle.
    await backend.sendTurn({
      chatId: "chat-1",
      cwd: "/tmp/workspace",
      text: "initial prompt",
    });

    expect(await backend.steerTurn("chat-1", "too late")).toBe(false);
    expect(client.steerMock).not.toHaveBeenCalled();
  });

  it("delegates to client.steer(sessionId, { text, attachments }), refreshes activity.lastActivityAt, and returns true while a turn is in flight", async () => {
    let fakeNow = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => fakeNow);

    const client = new MockSteerableAcpClient();
    const promptStarted = createDeferred<void>();
    const releasePrompt = createDeferred<AgentTurnResult>();

    client.promptHandler = async (sessionId) => {
      promptStarted.resolve();
      const result = await releasePrompt.promise;
      return { ...result, sessionId };
    };

    const backend = new AgyAgentBackend(makeTestConfig(), { client });
    const turnPromise = backend.sendTurn({
      chatId: "chat-active",
      cwd: "/tmp/workspace",
      text: "refactor module",
    });

    await promptStarted.promise;

    const activityBefore = backend.getTurnActivity("chat-active");
    expect(activityBefore).toBeDefined();
    expect(activityBefore?.lastActivityAt).toBe(1_700_000_000_000);

    fakeNow = 1_700_000_015_000;
    const attachments: InboundAttachment[] = [
      { type: "file", name: "notes.md", localPath: "/tmp/notes.md" },
    ];
    const steered = await backend.steerTurn(
      "chat-active",
      "also keep the legacy helper",
      attachments,
    );

    expect(steered).toBe(true);
    expect(client.steerMock).toHaveBeenCalledTimes(1);
    expect(client.steerMock).toHaveBeenCalledWith("sess-1", {
      text: "also keep the legacy helper",
      attachments,
    });

    const activityAfter = backend.getTurnActivity("chat-active");
    expect(activityAfter?.lastActivityAt).toBe(1_700_000_015_000);

    // If client.steer returns false, lastActivityAt must not be bumped.
    client.steerMock.mockResolvedValueOnce(false);
    fakeNow = 1_700_000_025_000;
    expect(await backend.steerTurn("chat-active", "ignored")).toBe(false);
    expect(backend.getTurnActivity("chat-active")?.lastActivityAt).toBe(1_700_000_015_000);

    releasePrompt.resolve({
      sessionId: "sess-1",
      text: "Refactored cleanly.",
      stopReason: "end_turn",
    });
    await expect(turnPromise).resolves.toMatchObject({
      sessionId: "sess-1",
      text: "Refactored cleanly.",
      stopReason: "end_turn",
    });

    expect(await backend.steerTurn("chat-active", "post-completion")).toBe(false);
  });
});

describe("AgyAcpClient.steer()", () => {
  it("returns false when client is not running or when steering an idle session", async () => {
    const client = new AgyAcpClient({
      agyBin: "agy",
      defaultCwd: "/tmp/workspace",
      approvalMode: "auto",
    });

    // Not started yet.
    expect(await client.steer("sess-1", { text: "hello" })).toBe(false);

    // Running, but no active turn on sess-idle.
    const { requests } = attachFakeAcpConnection(client);
    expect(await client.steer("sess-idle", { text: "hello" })).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it("keeps prompt() open after request #1 resolves early, accumulates post-steer chunks, and resolves when request #2 completes", async () => {
    const client = new AgyAcpClient({
      agyBin: "agy",
      defaultCwd: "/tmp/workspace",
      approvalMode: "auto",
    });
    const { requests, emitUpdate } = attachFakeAcpConnection(client);

    const streamedDeltas: string[] = [];
    const promptPromise = client.prompt("sess-live", {
      text: "Start analyzing the repo",
      callbacks: {
        onTextDelta: (delta) => {
          streamedDeltas.push(delta);
        },
      },
    });

    let promptSettled = false;
    void promptPromise.then(() => {
      promptSettled = true;
    });

    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.method).toBe(acp.methods.agent.session.prompt);
    expect(requests[0]?.params.sessionId).toBe("sess-live");
    expect(requests[0]?.params.prompt).toEqual([
      { type: "text", text: "Start analyzing the repo" },
    ]);

    // Stream pre-steer output chunk.
    await emitUpdate({
      sessionId: "sess-live",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Scanning source files. " },
      },
    });

    // Dispatch live steer request #2 on the same sessionId.
    const steered = await client.steer("sess-live", {
      text: "Focus only on src/acp/",
    });
    expect(steered).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.method).toBe(acp.methods.agent.session.prompt);
    expect(requests[1]?.params.sessionId).toBe("sess-live");
    expect(requests[1]?.params.prompt).toEqual([
      { type: "text", text: "Focus only on src/acp/" },
    ]);

    // Resolve request #1 early -> prompt() must remain pending while request #2 is in flight.
    requests[0]!.deferred.resolve({ stopReason: "end_turn" });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(promptSettled).toBe(false);

    // Emit post-steer chunks -> must still accumulate into the active turn.
    await emitUpdate({
      sessionId: "sess-live",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Narrowed to src/acp/. " },
      },
    });
    await emitUpdate({
      sessionId: "sess-live",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Analysis complete." },
      },
    });

    expect(streamedDeltas).toEqual([
      "Scanning source files. ",
      "Narrowed to src/acp/. ",
      "Analysis complete.",
    ]);
    expect(promptSettled).toBe(false);

    // Resolve request #2 -> prompt() now resolves with the full accumulated text.
    requests[1]!.deferred.resolve({ stopReason: "end_turn" });
    const result = await promptPromise;

    expect(result).toEqual({
      sessionId: "sess-live",
      text: "Scanning source files. Narrowed to src/acp/. Analysis complete.",
      stopReason: "end_turn",
    });

    // Session is idle again after completion.
    expect(await client.steer("sess-live", { text: "after finish" })).toBe(false);
  });

  it("still resolves prompt() when one overlapping request resolves and the other rejects", async () => {
    const client = new AgyAcpClient({
      agyBin: "agy",
      defaultCwd: "/tmp/workspace",
      approvalMode: "auto",
    });
    const { requests, emitUpdate } = attachFakeAcpConnection(client);

    const promptPromise = client.prompt("sess-overlap", {
      text: "Initial task",
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    expect(await client.steer("sess-overlap", { text: "Steer override" })).toBe(true);
    expect(requests).toHaveLength(2);

    // Request #1 rejects (e.g. superseded), while request #2 produces text and resolves.
    requests[0]!.deferred.reject(new Error("superseded by steering prompt"));
    await emitUpdate({
      sessionId: "sess-overlap",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Handled via steered request." },
      },
    });
    requests[1]!.deferred.resolve({ stopReason: "end_turn" });

    await expect(promptPromise).resolves.toEqual({
      sessionId: "sess-overlap",
      text: "Handled via steered request.",
      stopReason: "end_turn",
    });
  });

  it("rejects prompt() with the latest steering request error even when request #1 resolved on handoff", async () => {
    const client = new AgyAcpClient({
      agyBin: "agy",
      defaultCwd: "/tmp/workspace",
      approvalMode: "auto",
    });
    const { requests } = attachFakeAcpConnection(client);

    const promptPromise = client.prompt("sess-latest-err", {
      text: "Initial task",
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    expect(await client.steer("sess-latest-err", { text: "Steer latest" })).toBe(true);
    expect(requests).toHaveLength(2);

    // Request #1 resolves early on steering handoff, then request #2 (latest owner) fails.
    requests[0]!.deferred.resolve({ stopReason: "end_turn" });
    await new Promise((resolve) => setTimeout(resolve, 15));
    requests[1]!.deferred.reject(new Error("steered request failed: rate limit"));

    await expect(promptPromise).rejects.toThrow("steered request failed: rate limit");
  });
});

describe("parsePhotonNativeCommands()", () => {
  it("returns all 4 native commands for undefined, empty, 'all', '*', and 'true'", () => {
    const expected = new Set(["poll", "bg", "unsend", "card"]);
    expect(parsePhotonNativeCommands(undefined)).toEqual(expected);
    expect(parsePhotonNativeCommands("")).toEqual(expected);
    expect(parsePhotonNativeCommands("   ")).toEqual(expected);
    expect(parsePhotonNativeCommands("all")).toEqual(expected);
    expect(parsePhotonNativeCommands("ALL")).toEqual(expected);
    expect(parsePhotonNativeCommands("*")).toEqual(expected);
    expect(parsePhotonNativeCommands("true")).toEqual(expected);
  });

  it("returns an empty set for 'none', 'off', 'false', and '0'", () => {
    expect(parsePhotonNativeCommands("none").size).toBe(0);
    expect(parsePhotonNativeCommands("NONE").size).toBe(0);
    expect(parsePhotonNativeCommands("off").size).toBe(0);
    expect(parsePhotonNativeCommands("false").size).toBe(0);
    expect(parsePhotonNativeCommands("0").size).toBe(0);
  });

  it("parses mixed-case, slash-prefixed, and invalid command lists cleanly", () => {
    expect(parsePhotonNativeCommands("unsend, /poll, invalid, BG")).toEqual(
      new Set(["unsend", "poll", "bg"]),
    );
    expect(parsePhotonNativeCommands("/card; //unsend  CARD  unknown")).toEqual(
      new Set(["card", "unsend"]),
    );
    expect(parsePhotonNativeCommands("unknown,invalid")).toEqual(new Set());
  });
});
