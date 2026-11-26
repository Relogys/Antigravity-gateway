import { describe, expect, it, vi } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import type { AcpPermissionHandler, NewSessionInfo } from "../src/acp/client.js";
import { PermissionManager } from "../src/acp/permissions.js";
import { formatQuotaSummary, parseUsageJson } from "../src/acp/quota.js";
import {
  AgyAgentBackend,
  splitModelAndEffort,
  type AgyAcpClientLike,
} from "../src/acp/sessions.js";
import type {
  AcpSessionSummary,
  AgentTurnCallbacks,
  AgentTurnResult,
  InboundAttachment,
  PendingPermission,
  PermissionOption,
} from "../src/types.js";

function makeTestConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    allowedSenders: new Set(["+15550001111"]),
    allowGroups: false,
    groupMentionPatterns: ["@agy", "@antigravity"],
    agyBin: "agy",
    defaultCwd: "/tmp/workspace",
    approvalMode: "interactive",
    healthEnabled: false,
    healthHost: "127.0.0.1",
    healthPort: 18790,
    photon: {
      projectId: "test-project-id",
      projectSecret: "test-project-secret",
      readReceipts: true,
      reactions: true,
    },
    quotaWarnThreshold: 15,
    dataDir: "/tmp/data",
    logLevel: "info",
    ...overrides,
  };
}

const SAMPLE_OPTIONS: PermissionOption[] = [
  { optionId: "opt-allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "opt-allow-always", name: "Allow always", kind: "allow_always" },
  { optionId: "opt-reject-once", name: "Deny", kind: "reject_once" },
  { optionId: "opt-reject-always", name: "Deny always", kind: "reject_always" },
];

class MockAgyAcpClient implements AgyAcpClientLike {
  started = false;
  stopped = false;
  sessionSeq = 0;
  calls: Array<{ method: string; args: unknown[] }> = [];
  activeOrder: string[] = [];
  promptHandler?: (
    sessionId: string,
    input: {
      text: string;
      attachments?: InboundAttachment[];
      callbacks?: AgentTurnCallbacks;
      permissionHandler?: AcpPermissionHandler;
    },
  ) => Promise<AgentTurnResult>;
  sessionsList: AcpSessionSummary[] = [
    {
      sessionId: "sess-existing-1",
      cwd: "/tmp/workspace",
      title: "Existing session",
      updatedAt: "2026-11-26T10:00:00Z",
    },
  ];
  baseModels = [
    "gemini-4-neon",
    "gemini-4-carbon",
    "gemini-4-argon",
    "gemini-4-hydrogen",
    "gemini-3.8-flash",
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "gpt-oss-120b-medium",
  ];

  async ensureStarted(): Promise<void> {
    this.started = true;
    this.calls.push({ method: "ensureStarted", args: [] });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.calls.push({ method: "stop", args: [] });
  }

  async newSession(cwd: string): Promise<NewSessionInfo> {
    this.sessionSeq += 1;
    const sessionId = `sess-${this.sessionSeq}`;
    this.calls.push({ method: "newSession", args: [cwd] });
    return { sessionId };
  }

  async loadSession(sessionId: string, cwd: string): Promise<void> {
    this.calls.push({ method: "loadSession", args: [sessionId, cwd] });
  }

  async listSessions(cwd?: string): Promise<AcpSessionSummary[]> {
    this.calls.push({ method: "listSessions", args: [cwd] });
    return this.sessionsList;
  }

  async closeSession(sessionId: string): Promise<void> {
    this.calls.push({ method: "closeSession", args: [sessionId] });
  }

  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void> {
    this.calls.push({
      method: "setConfigOption",
      args: [sessionId, configId, value],
    });
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
    this.calls.push({ method: "prompt", args: [sessionId, input.text] });
    if (this.promptHandler) {
      return this.promptHandler(sessionId, input);
    }
    return {
      sessionId,
      text: `echo:${input.text}`,
      stopReason: "end_turn",
    };
  }

  async cancel(sessionId: string): Promise<void> {
    this.calls.push({ method: "cancel", args: [sessionId] });
  }

  getAvailableModels(): string[] {
    return [
      "gemini-4-neon-high",
      "gemini-4-hydrogen-high",
      "gpt-oss-120b-medium",
    ];
  }

  getAvailableBaseModels(): string[] {
    return [...this.baseModels];
  }

  getAvailableEfforts(): string[] {
    return ["low", "medium", "high", "xhigh"];
  }

  getAvailableModes(): string[] {
    return ["default", "accept-edits", "auto", "plan"];
  }
}

describe("quota parsing and formatting", () => {
  it("parses real agy -p /usage --output-format json payload", () => {
    const sampleJson = JSON.stringify({
      conversation_id: "",
      status: "SUCCESS",
      response: "Gemini Models\tWeekly Limit Remaining\t87%\n",
      duration_seconds: 0,
      num_turns: 0,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      command: {
        name: "usage",
        data: {
          groups: [
            {
              name: "Gemini Models",
              buckets: [
                {
                  id: "gemini-weekly",
                  name: "Weekly Limit Remaining",
                  window: "weekly",
                  remaining_fraction: 0.8676,
                  reset_time: "2026-12-03T07:24:44Z",
                },
                {
                  id: "gemini-5h",
                  name: "Five Hour Limit Remaining",
                  window: "5h",
                  remaining_fraction: 0.7631,
                  reset_time: "2026-11-26T21:39:45Z",
                },
              ],
            },
            {
              name: "Claude and GPT models",
              buckets: [
                {
                  id: "3p-weekly",
                  name: "Weekly Limit Remaining",
                  window: "weekly",
                  remaining_fraction: 1,
                  reset_time: "1970-01-01T00:00:00Z",
                },
                {
                  id: "3p-5h",
                  name: "Five Hour Limit Remaining",
                  window: "5h",
                  remaining_fraction: 1,
                  reset_time: "1970-01-01T00:00:00Z",
                },
              ],
            },
          ],
        },
      },
    });

    const summary = parseUsageJson(sampleJson, 123456);
    expect(summary.available).toBe(true);
    expect(summary.fetchedAt).toBe(123456);
    expect(summary.groups).toHaveLength(2);
    expect(summary.fiveHourRemainingPercent).toBe(76);
    expect(summary.fiveHourResetTime).toBe("2026-11-26T21:39:45Z");
    expect(summary.weeklyRemainingPercent).toBe(87);
    expect(summary.weeklyResetTime).toBe("2026-12-03T07:24:44Z");

    const formatted = formatQuotaSummary(summary);
    expect(formatted).toContain("Gemini Models");
    expect(formatted).toContain("5h: 76% remaining");
    expect(formatted).toContain("Weekly: 87% remaining");
    expect(formatted).toContain("Claude and GPT models");
    expect(formatted).toContain("100% remaining (full)");
  });

  it("handles API-key error envelopes and invalid JSON gracefully", () => {
    const apiKeyErr = parseUsageJson(
      JSON.stringify({
        status: "ERROR",
        error: "/usage is unavailable with a Gemini API key",
      }),
    );
    expect(apiKeyErr.available).toBe(false);
    expect(apiKeyErr.error).toContain("Gemini API key");
    expect(formatQuotaSummary(apiKeyErr)).toContain("Quota unavailable");

    const invalid = parseUsageJson("not-json");
    expect(invalid.available).toBe(false);
    expect(invalid.error).toContain("Failed to parse");
  });
});

describe("PermissionManager", () => {
  it("immediately picks allow_always in auto mode without prompting", async () => {
    const mgr = new PermissionManager();
    const notify = vi.fn();
    const optionId = await mgr.handlePermissionRequest(
      "chat-1",
      "auto",
      {
        sessionId: "sess-1",
        toolCallId: "tc-1",
        title: "Run tests",
        kind: "execute",
        options: SAMPLE_OPTIONS,
      },
      notify,
    );

    expect(optionId).toBe("opt-allow-always");
    expect(notify).not.toHaveBeenCalled();
    expect(mgr.pendingCount()).toBe(0);
  });

  it("auto-allows read/edit in sandbox mode and prompts for execute/delete", async () => {
    const mgr = new PermissionManager();
    const notify = vi.fn();

    const readOpt = await mgr.handlePermissionRequest(
      "chat-1",
      "sandbox",
      {
        sessionId: "sess-1",
        toolCallId: "tc-read",
        title: "Read package.json",
        kind: "read",
        options: SAMPLE_OPTIONS,
      },
      notify,
    );
    expect(readOpt).toBe("opt-allow-once");
    expect(notify).not.toHaveBeenCalled();

    const execPromise = mgr.handlePermissionRequest(
      "chat-1",
      "sandbox",
      {
        sessionId: "sess-1",
        toolCallId: "tc-exec",
        title: "Run rm -rf",
        kind: "execute",
        options: SAMPLE_OPTIONS,
      },
      notify,
    );

    expect(notify).toHaveBeenCalledTimes(1);
    expect(mgr.pendingCount()).toBe(1);
    expect(mgr.resolve("chat-1", "deny")).toBe(true);
    expect(await execPromise).toBe("opt-reject-once");
    expect(mgr.pendingCount()).toBe(0);
  });

  it("resolves interactive permissions for once, session, always, and deny", async () => {
    const mgr = new PermissionManager();

    const decisions: Array<{
      decision: "once" | "session" | "always" | "deny";
      expected: string;
    }> = [
      { decision: "once", expected: "opt-allow-once" },
      { decision: "session", expected: "opt-allow-always" },
      { decision: "always", expected: "opt-allow-always" },
      { decision: "deny", expected: "opt-reject-once" },
    ];

    for (const item of decisions) {
      const p = mgr.handlePermissionRequest(
        "chat-1",
        "interactive",
        {
          sessionId: "sess-1",
          toolCallId: `tc-${item.decision}`,
          title: "Run command",
          kind: "execute",
          options: SAMPLE_OPTIONS,
        },
        () => undefined,
      );
      expect(mgr.getPending("chat-1")?.toolCallId).toBe(`tc-${item.decision}`);
      expect(mgr.resolve("chat-1", item.decision)).toBe(true);
      expect(await p).toBe(item.expected);
    }
    expect(mgr.resolve("chat-1", "once")).toBe(false);
  });

  it("defaults to deny on timeout and cleans up on cancelAllForChat", async () => {
    vi.useFakeTimers();
    try {
      const mgr = new PermissionManager({ timeoutMs: 5000 });
      const timedOutPromise = mgr.handlePermissionRequest(
        "chat-timeout",
        "interactive",
        {
          sessionId: "sess-1",
          toolCallId: "tc-timeout",
          title: "Slow approval",
          kind: "delete",
          options: SAMPLE_OPTIONS,
        },
        () => undefined,
      );

      expect(mgr.pendingCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await timedOutPromise).toBe("opt-reject-once");
      expect(mgr.pendingCount()).toBe(0);

      const canceledPromise = mgr.handlePermissionRequest(
        "chat-cancel",
        "interactive",
        {
          sessionId: "sess-2",
          toolCallId: "tc-cancel",
          title: "Canceled approval",
          kind: "execute",
          options: SAMPLE_OPTIONS,
        },
        () => undefined,
      );
      expect(mgr.pendingCount()).toBe(1);
      mgr.cancelAllForChat("chat-cancel");
      expect(await canceledPromise).toBe("opt-reject-once");
      expect(mgr.pendingCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("splitModelAndEffort", () => {
  const baseModels = [
    "gemini-4-neon",
    "gemini-4-carbon",
    "gemini-4-hydrogen",
    "gemini-3.8-flash",
    "claude-opus-5-5",
    "gpt-oss-120b-medium",
  ];

  it("splits composite model+effort slugs", () => {
    expect(splitModelAndEffort("gemini-4-hydrogen-high", baseModels)).toEqual({
      model: "gemini-4-hydrogen",
      effort: "high",
    });
    expect(splitModelAndEffort("gemini-4-neon-xhigh", baseModels)).toEqual({
      model: "gemini-4-neon",
      effort: "xhigh",
    });
    expect(splitModelAndEffort("claude-opus-5-5-medium", baseModels)).toEqual({
      model: "claude-opus-5-5",
      effort: "medium",
    });
  });

  it("preserves exact base models including gpt-oss-120b-medium", () => {
    expect(splitModelAndEffort("gpt-oss-120b-medium", baseModels)).toEqual({
      model: "gpt-oss-120b-medium",
    });
    expect(splitModelAndEffort("gemini-4-carbon", baseModels)).toEqual({
      model: "gemini-4-carbon",
    });
  });
});

describe("AgyAgentBackend", () => {
  it("serializes concurrent turns for the same chat", async () => {
    const client = new MockAgyAcpClient();
    const events: string[] = [];

    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    let count = 0;
    client.promptHandler = async (sessionId, input) => {
      count += 1;
      const idx = count;
      events.push(`start:${idx}:${input.text}`);
      if (idx === 1) {
        await firstGate;
      }
      events.push(`end:${idx}:${input.text}`);
      return { sessionId, text: `reply:${input.text}`, stopReason: "end_turn" };
    };

    const backend = new AgyAgentBackend(makeTestConfig(), { client });

    const p1 = backend.sendTurn({
      chatId: "chat-serial",
      cwd: "/tmp/workspace",
      text: "first",
    });
    const p2 = backend.sendTurn({
      chatId: "chat-serial",
      cwd: "/tmp/workspace",
      text: "second",
    });

    // Give turn 1 microtasks time to enter promptHandler
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["start:1:first"]);
    expect(backend.isBusy("chat-serial")).toBe(true);

    releaseFirst?.();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.text).toBe("reply:first");
    expect(r2.text).toBe("reply:second");
    expect(events).toEqual([
      "start:1:first",
      "end:1:first",
      "start:2:second",
      "end:2:second",
    ]);
    expect(backend.isBusy("chat-serial")).toBe(false);
    // Reused the same session for both turns
    expect(r1.sessionId).toBe("sess-1");
    expect(r2.sessionId).toBe("sess-1");
  });

  it("supports setModel, setEffort, setMode, attachSession, listSessions, cancelTurn, resetSession, and getStats", async () => {
    const client = new MockAgyAcpClient();
    const notified: PendingPermission[] = [];
    const backend = new AgyAgentBackend(makeTestConfig(), {
      client,
      permissionNotifier: async (_chatId, perm) => {
        notified.push(perm);
      },
    });

    await backend.sendTurn({
      chatId: "chat-a",
      cwd: "/tmp/workspace",
      text: "hello",
    });
    expect(backend.getStats()).toEqual({
      activeSessions: 1,
      activeTurns: 0,
      pendingPermissions: 0,
    });

    const split = await backend.setModel("chat-a", "gemini-4-hydrogen-high");
    expect(split).toEqual({ model: "gemini-4-hydrogen", effort: "high" });
    await backend.setEffort("chat-a", "xhigh");
    await backend.setMode("chat-a", "plan");

    expect(client.calls).toContainEqual({
      method: "setConfigOption",
      args: ["sess-1", "model", "gemini-4-hydrogen"],
    });
    expect(client.calls).toContainEqual({
      method: "setConfigOption",
      args: ["sess-1", "thought_level", "high"],
    });
    expect(client.calls).toContainEqual({
      method: "setConfigOption",
      args: ["sess-1", "thought_level", "xhigh"],
    });
    expect(client.calls).toContainEqual({
      method: "setConfigOption",
      args: ["sess-1", "mode", "plan"],
    });

    const sessions = await backend.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe("sess-existing-1");

    await backend.attachSession("chat-a", "sess-existing-1", "/tmp/workspace");
    expect(backend.getSessionInfo("chat-a")?.sessionId).toBe("sess-existing-1");

    // Verify cancelTurn when busy
    let releaseTurn: (() => void) | undefined;
    client.promptHandler = async (sessionId) => {
      await new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
      return { sessionId, text: "", stopReason: "cancelled" };
    };
    const busyTurn = backend.sendTurn({
      chatId: "chat-a",
      cwd: "/tmp/workspace",
      text: "long task",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(await backend.cancelTurn("chat-a")).toBe(true);
    expect(client.calls).toContainEqual({
      method: "cancel",
      args: ["sess-existing-1"],
    });
    releaseTurn?.();
    await busyTurn;

    await backend.resetSession("chat-a");
    expect(backend.getStats().activeSessions).toBe(0);
    expect(client.calls).toContainEqual({
      method: "closeSession",
      args: ["sess-existing-1"],
    });
  });
});
