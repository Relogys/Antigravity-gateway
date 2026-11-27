import { describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import type { AcpPermissionHandler, NewSessionInfo } from "../src/acp/client.js";
import {
  AgyAgentBackend,
  resolveModelSelection,
  type AgyAcpClientLike,
} from "../src/acp/sessions.js";
import { isProbeChannelAliveRejection } from "../src/photon/staleness.js";
import type {
  AcpSessionSummary,
  AgentTurnCallbacks,
  AgentTurnResult,
  InboundAttachment,
  ModelCatalogEntry,
  TurnActivitySnapshot,
} from "../src/types.js";

function makeTestConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    allowedSenders: new Set(["+15550001111"]),
    allowGroups: false,
    groupMentionPatterns: ["@agy"],
    agyBin: "agy",
    defaultCwd: "/tmp/workspace",
    approvalMode: "interactive",
    healthEnabled: false,
    healthHost: "127.0.0.1",
    healthPort: 18790,
    quotaWarnThreshold: 15,
    progressSilenceMs: 120_000,
    sessionStallTimeoutMs: 300_000,
    turnMaxRetries: 2,
    autoBootstrapChannelSession: true,
    dataDir: "/tmp/data",
    logLevel: "info",
    ...overrides,
  };
}

const TEST_CATALOG: ModelCatalogEntry[] = [
  { id: "gemini-4-neon", name: "Gemini 4 Neon" },
  { id: "gemini-4-carbon", name: "Gemini 4 Carbon" },
  { id: "gemini-4-argon", name: "Gemini 4 Argon" },
  { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  { id: "gpt-oss-120b-medium", name: "GPT OSS 120B" },
];

const TEST_AVAILABLE_MODELS = [
  "gemini-4-neon-low",
  "gemini-4-neon-medium",
  "gemini-4-neon-high",
  "gemini-4-neon-xhigh",
  "gemini-4-carbon-high",
  "gemini-4-argon-high",
  "gemini-4-hydrogen-high",
  "gemini-3.8-flash-high",
  "claude-opus-5-5-high",
  "claude-sonnet-5-5-high",
  "gpt-oss-120b-medium",
];

const TEST_EFFORTS = ["low", "medium", "high", "xhigh"];

class MockAgyAcpClient implements AgyAcpClientLike {
  started = false;
  stopped = false;
  sessionSeq = 0;
  catalog: ModelCatalogEntry[] = [];
  calls: Array<{ method: string; args: unknown[] }> = [];
  baseModels = [
    "gemini-4-neon",
    "gemini-4-hydrogen",
    "gemini-4-carbon",
    "gpt-oss-120b-medium",
  ];
  promptHandler?: (
    sessionId: string,
    input: {
      text: string;
      attachments?: InboundAttachment[];
      callbacks?: AgentTurnCallbacks;
      permissionHandler?: AcpPermissionHandler;
    },
  ) => Promise<AgentTurnResult>;

  async ensureStarted(): Promise<void> {
    this.started = true;
    this.calls.push({ method: "ensureStarted", args: [] });
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  async newSession(cwd: string): Promise<NewSessionInfo> {
    this.sessionSeq += 1;
    this.calls.push({ method: "newSession", args: [cwd] });
    return { sessionId: `sess-${this.sessionSeq}` };
  }

  async loadSession(sessionId: string, cwd: string): Promise<void> {
    this.calls.push({ method: "loadSession", args: [sessionId, cwd] });
  }

  async listSessions(cwd?: string): Promise<AcpSessionSummary[]> {
    this.calls.push({ method: "listSessions", args: [cwd] });
    return [];
  }

  async closeSession(sessionId: string): Promise<void> {
    this.calls.push({ method: "closeSession", args: [sessionId] });
  }

  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void> {
    this.calls.push({ method: "setConfigOption", args: [sessionId, configId, value] });
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    this.calls.push({ method: "setMode", args: [sessionId, modeId] });
  }

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
    return { sessionId, text: `echo:${input.text}`, stopReason: "end_turn" };
  }

  async cancel(sessionId: string): Promise<void> {
    this.calls.push({ method: "cancel", args: [sessionId] });
  }

  getAvailableModels(): string[] {
    return [...TEST_AVAILABLE_MODELS];
  }

  getAvailableBaseModels(): string[] {
    return [...this.baseModels];
  }

  getAvailableEfforts(): string[] {
    return [...TEST_EFFORTS];
  }

  getAvailableModes(): string[] {
    return ["default", "accept-edits", "auto", "plan"];
  }

  getModelCatalog(): ModelCatalogEntry[] {
    return [...this.catalog];
  }
}

function toolEvent(title: string): {
  toolCallId: string;
  title: string;
  status: string;
} {
  return { toolCallId: `tc-${title}`, title, status: "in_progress" };
}

describe("isProbeChannelAliveRejection (Spectrum GUID validation)", () => {
  it("treats INVALID_ARGUMENT / ValidationError / GUID rejections as alive", () => {
    expect(isProbeChannelAliveRejection({ code: 3, message: "INVALID_ARGUMENT" })).toBe(
      true,
    );
    expect(isProbeChannelAliveRejection({ code: "INVALID_ARGUMENT" })).toBe(true);
    expect(isProbeChannelAliveRejection({ code: "invalidArgument" })).toBe(true);
    expect(
      isProbeChannelAliveRejection({ name: "ValidationError", message: "bad guid" }),
    ).toBe(true);
    expect(isProbeChannelAliveRejection({ message: "ValidationError: bad guid" })).toBe(
      true,
    );
    expect(
      isProbeChannelAliveRejection({
        message: "Expected message resource GUID: probe-abc",
      }),
    ).toBe(true);
  });

  it("still treats NOT_FOUND as alive", () => {
    expect(isProbeChannelAliveRejection({ code: 5 })).toBe(true);
    expect(isProbeChannelAliveRejection({ code: "NOT_FOUND" })).toBe(true);
    expect(isProbeChannelAliveRejection(new Error("Message not found"))).toBe(true);
  });

  it("treats transport / timeout codes as offline", () => {
    expect(isProbeChannelAliveRejection({ code: 14, message: "UNAVAILABLE" })).toBe(
      false,
    );
    expect(isProbeChannelAliveRejection(new Error("DEADLINE_EXCEEDED"))).toBe(false);
    expect(isProbeChannelAliveRejection(new Error("ECONNRESET"))).toBe(false);
    expect(isProbeChannelAliveRejection({ code: 4, message: "deadline exceeded" })).toBe(
      false,
    );
  });
});

describe("resolveModelSelection", () => {
  const resolve = (input: string) =>
    resolveModelSelection(input, TEST_CATALOG, TEST_AVAILABLE_MODELS, TEST_EFFORTS);

  it("resolves a 1-based catalog index", () => {
    expect(resolve("4")).toEqual({
      ok: true,
      model: "gemini-4-hydrogen",
      label: "Gemini 4 Hydrogen",
    });
  });

  it("resolves a numbered index plus effort", () => {
    expect(resolve("4 xhigh")).toEqual({
      ok: true,
      model: "gemini-4-hydrogen",
      label: "Gemini 4 Hydrogen",
      effort: "xhigh",
    });
  });

  it("resolves a fuzzy keyword plus effort", () => {
    expect(resolve("hydrogen xhigh")).toEqual({
      ok: true,
      model: "gemini-4-hydrogen",
      label: "Gemini 4 Hydrogen",
      effort: "xhigh",
    });
  });

  it("resolves an exact full availableModels slug, splitting the effort", () => {
    expect(resolve("gemini-4-neon-medium")).toEqual({
      ok: true,
      model: "gemini-4-neon",
      label: "Gemini 4 Neon",
      effort: "medium",
    });
  });

  it("resolves an exact catalog id without an effort suffix", () => {
    expect(resolve("gpt-oss-120b-medium")).toEqual({
      ok: true,
      model: "gpt-oss-120b-medium",
      label: "GPT OSS 120B",
    });
  });

  it("reports ambiguity for a broad keyword", () => {
    const result = resolve("gemini");
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "ambiguous") {
      expect(result.candidates.length).toBeGreaterThan(1);
      expect(result.candidates.map((c) => c.id)).toContain("gemini-4-neon");
    } else {
      throw new Error("expected ambiguous resolution");
    }
  });

  it("rejects flags and unknown model names instead of silently accepting them", () => {
    const flag = resolve("-h");
    expect(flag.ok).toBe(false);
    if (!flag.ok) {
      expect(flag.reason).toBe("invalid");
    }

    const unknown = resolve("nonexistent");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.reason).toBe("invalid");
    }
  });
});

describe("AgyAgentBackend live turn activity", () => {
  it("tracks thought/tool/text phases and clears the snapshot in finally", async () => {
    const client = new MockAgyAcpClient();
    const snapshots: Array<TurnActivitySnapshot | undefined> = [];
    let backend!: AgyAgentBackend;

    client.promptHandler = async (sessionId, input) => {
      await input.callbacks?.onThoughtDelta?.("pondering");
      snapshots.push(backend.getTurnActivity("chat-activity"));

      await input.callbacks?.onToolCall?.(toolEvent("Search"));
      snapshots.push(backend.getTurnActivity("chat-activity"));

      await input.callbacks?.onTextDelta?.("hello");
      snapshots.push(backend.getTurnActivity("chat-activity"));

      return { sessionId, text: "hello", stopReason: "end_turn" };
    };

    backend = new AgyAgentBackend(makeTestConfig({ turnMaxRetries: 2 }), { client });
    await backend.sendTurn({
      chatId: "chat-activity",
      cwd: "/tmp/workspace",
      text: "go",
    });

    expect(snapshots[0]).toMatchObject({ phase: "thinking", toolCount: 0, maxRetries: 2 });
    expect(snapshots[1]).toMatchObject({
      phase: "tool",
      toolCount: 1,
      currentTool: "Search",
    });
    expect(snapshots[2]).toMatchObject({ phase: "streaming" });

    expect(backend.getTurnActivity("chat-activity")).toBeUndefined();
  });
});

describe("AgyAgentBackend transient pre-output retry", () => {
  it("retries a transient error before any output and succeeds", async () => {
    const client = new MockAgyAcpClient();
    let promptCalls = 0;
    let observed: TurnActivitySnapshot | undefined;
    let backend!: AgyAgentBackend;

    client.promptHandler = async (sessionId) => {
      promptCalls += 1;
      if (promptCalls === 1) {
        throw new Error("503 Service Unavailable");
      }
      observed = backend.getTurnActivity("chat-retry");
      return { sessionId, text: "recovered", stopReason: "end_turn" };
    };

    backend = new AgyAgentBackend(makeTestConfig({ turnMaxRetries: 2 }), {
      client,
      retryDelayMs: 1,
    });

    const result = await backend.sendTurn({
      chatId: "chat-retry",
      cwd: "/tmp/workspace",
      text: "go",
    });

    expect(result.text).toBe("recovered");
    expect(promptCalls).toBe(2);
    expect(observed).toMatchObject({ phase: "retrying", retryCount: 1 });
    expect(observed?.lastRetryReason).toContain("503");
    expect(backend.getTurnActivity("chat-retry")).toBeUndefined();
  });

  it("exhausts turnMaxRetries and rethrows when transient errors persist", async () => {
    const client = new MockAgyAcpClient();
    let promptCalls = 0;
    let lastRetryCount = 0;
    let backend!: AgyAgentBackend;

    client.promptHandler = async () => {
      promptCalls += 1;
      const snapshot = backend.getTurnActivity("chat-fail");
      if (snapshot) {
        lastRetryCount = snapshot.retryCount;
      }
      throw new Error("upstream timeout while calling model");
    };

    backend = new AgyAgentBackend(makeTestConfig({ turnMaxRetries: 2 }), {
      client,
      retryDelayMs: 1,
    });

    await expect(
      backend.sendTurn({ chatId: "chat-fail", cwd: "/tmp/workspace", text: "go" }),
    ).rejects.toThrow(/timeout/i);

    expect(promptCalls).toBe(3);
    expect(lastRetryCount).toBe(2);
    expect(backend.getTurnActivity("chat-fail")).toBeUndefined();
  });

  it("does not retry non-transient errors", async () => {
    const client = new MockAgyAcpClient();
    let promptCalls = 0;

    client.promptHandler = async () => {
      promptCalls += 1;
      throw new Error("ValidationError: unsupported parameter");
    };

    const backend = new AgyAgentBackend(makeTestConfig({ turnMaxRetries: 2 }), {
      client,
      retryDelayMs: 1,
    });

    await expect(
      backend.sendTurn({ chatId: "chat-fatal", cwd: "/tmp/workspace", text: "go" }),
    ).rejects.toThrow(/ValidationError/);

    expect(promptCalls).toBe(1);
  });

  it("does not retry after text has streamed", async () => {
    const client = new MockAgyAcpClient();
    let promptCalls = 0;

    client.promptHandler = async (_sessionId, input) => {
      promptCalls += 1;
      await input.callbacks?.onTextDelta?.("partial output");
      throw new Error("503 unavailable after streaming");
    };

    const backend = new AgyAgentBackend(makeTestConfig({ turnMaxRetries: 2 }), {
      client,
      retryDelayMs: 1,
    });

    await expect(
      backend.sendTurn({ chatId: "chat-partial", cwd: "/tmp/workspace", text: "go" }),
    ).rejects.toThrow(/503/);

    expect(promptCalls).toBe(1);
  });
});

describe("AgyAgentBackend.setModel with live catalog", () => {
  it("resolves numbered and fuzzy inputs through the catalog", async () => {
    const client = new MockAgyAcpClient();
    client.catalog = TEST_CATALOG;
    const backend = new AgyAgentBackend(makeTestConfig(), { client });

    await expect(backend.setModel("chat-model", "4")).resolves.toEqual({
      model: "gemini-4-hydrogen",
      label: "Gemini 4 Hydrogen",
    });
    await expect(backend.setModel("chat-model", "hydro xhigh")).resolves.toEqual({
      model: "gemini-4-hydrogen",
      effort: "xhigh",
      label: "Gemini 4 Hydrogen",
    });
  });

  it("throws a descriptive error for unknown model input", async () => {
    const client = new MockAgyAcpClient();
    client.catalog = TEST_CATALOG;
    const backend = new AgyAgentBackend(makeTestConfig(), { client });

    await expect(backend.setModel("chat-model", "-h")).rejects.toThrow(
      /not a valid model name/i,
    );
    await expect(backend.setModel("chat-model", "nonexistent")).rejects.toThrow(
      /Unknown model/i,
    );
  });
});