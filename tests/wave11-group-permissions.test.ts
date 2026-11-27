import { describe, expect, it, vi } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import type { AcpPermissionHandler, NewSessionInfo } from "../src/acp/client.js";
import { PermissionManager } from "../src/acp/permissions.js";
import { AgyAgentBackend, type AgyAcpClientLike } from "../src/acp/sessions.js";
import type {
  AcpSessionSummary,
  AgentTurnCallbacks,
  AgentTurnResult,
  InboundAttachment,
  PermissionOption,
} from "../src/types.js";

const SAMPLE_OPTIONS: PermissionOption[] = [
  { optionId: "opt-allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "opt-allow-always", name: "Allow always", kind: "allow_always" },
  { optionId: "opt-reject-once", name: "Deny", kind: "reject_once" },
  { optionId: "opt-reject-always", name: "Deny always", kind: "reject_always" },
];

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

class MockAgyAcpClient implements AgyAcpClientLike {
  promptHandler?: (
    sessionId: string,
    input: {
      text: string;
      attachments?: InboundAttachment[];
      callbacks?: AgentTurnCallbacks;
      permissionHandler?: AcpPermissionHandler;
    },
  ) => Promise<AgentTurnResult>;

  async ensureStarted(): Promise<void> {}
  async stop(): Promise<void> {}

  async newSession(_cwd: string): Promise<NewSessionInfo> {
    return { sessionId: "sess-1" };
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
    return { sessionId, text: `echo:${input.text}`, stopReason: "end_turn" };
  }

  async cancel(_sessionId: string): Promise<void> {}

  getAvailableModels(): string[] {
    return [];
  }

  getAvailableBaseModels(): string[] {
    return [];
  }

  getAvailableEfforts(): string[] {
    return [];
  }

  getAvailableModes(): string[] {
    return [];
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("PermissionManager group requester binding", () => {
  it("rejects a non-requester group member and keeps the request alive for the requester", async () => {
    const mgr = new PermissionManager();
    const notify = vi.fn();

    const pending = mgr.handlePermissionRequest(
      "group-1",
      "interactive",
      {
        sessionId: "sess-1",
        toolCallId: "tc-1",
        title: "Run command",
        kind: "execute",
        options: SAMPLE_OPTIONS,
        requesterSenderId: "telegram:111",
      },
      notify,
    );

    expect(mgr.getPending("group-1")?.requesterSenderId).toBe("telegram:111");

    // A different group member trying to approve must be rejected and must
    // NOT settle or cancel the pending request.
    const mismatch = mgr.resolveWithResult("group-1", "once", {
      senderId: "telegram:222",
      isGroup: true,
      isAdmin: false,
    });
    expect(mismatch).toEqual({
      ok: false,
      reason: "requester_mismatch",
      requesterSenderId: "telegram:111",
      permissionId: mgr.getPending("group-1")?.id,
    });
    expect(mgr.pendingCount()).toBe(1);
    expect(mgr.getPending("group-1")).toBeDefined();

    // A deny attempt from the wrong member is equally blocked.
    const mismatchDeny = mgr.resolveWithResult("group-1", "deny", {
      senderId: "telegram:222",
      isGroup: true,
      isAdmin: false,
    });
    expect(mismatchDeny.reason).toBe("requester_mismatch");
    expect(mgr.pendingCount()).toBe(1);

    // The original requester settles it successfully.
    const approved = mgr.resolveWithResult("group-1", "once", {
      senderId: "telegram:111",
      isGroup: true,
    });
    expect(approved.ok).toBe(true);
    expect(await pending).toBe("opt-allow-once");
    expect(mgr.pendingCount()).toBe(0);
  });

  it("matches the requester case-insensitively", async () => {
    const mgr = new PermissionManager();
    const pending = mgr.handlePermissionRequest(
      "group-ci",
      "interactive",
      {
        sessionId: "sess-1",
        toolCallId: "tc-ci",
        title: "Run",
        kind: "execute",
        options: SAMPLE_OPTIONS,
        requesterSenderId: "Telegram:111",
      },
      () => undefined,
    );

    const ok = mgr.resolveWithResult("group-ci", "once", {
      senderId: "telegram:111",
      isGroup: true,
    });
    expect(ok.ok).toBe(true);
    expect(await pending).toBe("opt-allow-once");
  });

  it("lets a group admin approve or deny another user's request", async () => {
    const mgr = new PermissionManager();

    const approvePending = mgr.handlePermissionRequest(
      "group-admin-approve",
      "interactive",
      {
        sessionId: "sess-1",
        toolCallId: "tc-admin-1",
        title: "Run",
        kind: "execute",
        options: SAMPLE_OPTIONS,
        requesterSenderId: "telegram:111",
      },
      () => undefined,
    );
    const adminApprove = mgr.resolveWithResult("group-admin-approve", "once", {
      senderId: "telegram:999",
      isGroup: true,
      isAdmin: true,
    });
    expect(adminApprove.ok).toBe(true);
    expect(await approvePending).toBe("opt-allow-once");

    const denyPending = mgr.handlePermissionRequest(
      "group-admin-deny",
      "interactive",
      {
        sessionId: "sess-1",
        toolCallId: "tc-admin-2",
        title: "Delete",
        kind: "delete",
        options: SAMPLE_OPTIONS,
        requesterSenderId: "telegram:111",
      },
      () => undefined,
    );
    const adminDeny = mgr.resolveWithResult("group-admin-deny", "deny", {
      senderId: "telegram:999",
      isGroup: true,
      isAdmin: true,
    });
    expect(adminDeny.ok).toBe(true);
    expect(await denyPending).toBe("opt-reject-once");
  });

  it("stays backward compatible for DMs and the legacy two-argument resolve", async () => {
    const mgr = new PermissionManager();

    // DM: requester set but isGroup is false -> any sender may resolve.
    const dmPending = mgr.handlePermissionRequest(
      "dm-1",
      "interactive",
      {
        sessionId: "sess-1",
        toolCallId: "tc-dm",
        title: "Run",
        kind: "execute",
        options: SAMPLE_OPTIONS,
        requesterSenderId: "telegram:111",
      },
      () => undefined,
    );
    expect(
      mgr.resolve("dm-1", "once", { senderId: "telegram:222", isGroup: false }),
    ).toBe(true);
    expect(await dmPending).toBe("opt-allow-once");

    // Legacy: no actor and no requester recorded -> behaves exactly as before.
    const legacyPending = mgr.handlePermissionRequest(
      "chat-legacy",
      "interactive",
      {
        sessionId: "sess-1",
        toolCallId: "tc-legacy",
        title: "Run",
        kind: "execute",
        options: SAMPLE_OPTIONS,
      },
      () => undefined,
    );
    expect(mgr.resolve("chat-legacy", "deny")).toBe(true);
    expect(await legacyPending).toBe("opt-reject-once");
    expect(mgr.resolve("chat-legacy", "deny")).toBe(false);
  });

  it("returns reason 'none' when there is no pending request", () => {
    const mgr = new PermissionManager();
    expect(mgr.resolveWithResult("missing", "once")).toEqual({
      ok: false,
      reason: "none",
    });
    expect(mgr.resolve("missing", "once")).toBe(false);
  });
});

describe("AgyAgentBackend group requester threading", () => {
  it("threads requesterSenderId from sendTurn into PermissionManager and resolvePermissionWithResult", async () => {
    const client = new MockAgyAcpClient();
    const permissions = new PermissionManager();

    let capturedOutcome: unknown;
    client.promptHandler = async (sessionId, input) => {
      const response = await input.permissionHandler!({
        sessionId,
        toolCall: {
          toolCallId: "tc-1",
          title: "Run command",
          kind: "execute",
        },
        options: SAMPLE_OPTIONS.map((o) => ({
          optionId: o.optionId,
          name: o.name,
          kind: o.kind,
        })),
      } as never);
      capturedOutcome = response;
      return { sessionId, text: "done", stopReason: "end_turn" };
    };

    const backend = new AgyAgentBackend(makeTestConfig(), {
      client,
      permissionManager: permissions,
      permissionNotifier: () => undefined,
    });

    const turn = backend.sendTurn({
      chatId: "group:A",
      cwd: "/tmp/workspace",
      text: "run it",
      requesterSenderId: "telegram:111",
    });

    await waitFor(() => backend.getPendingPermission("group:A") !== undefined);
    expect(backend.getPendingPermission("group:A")?.requesterSenderId).toBe(
      "telegram:111",
    );

    const mismatch = backend.resolvePermissionWithResult("group:A", "deny", {
      senderId: "telegram:222",
      isGroup: true,
      isAdmin: false,
    });
    expect(mismatch).toMatchObject({
      ok: false,
      reason: "requester_mismatch",
      requesterSenderId: "telegram:111",
    });
    // Request must remain alive after the mismatched attempt.
    expect(backend.getPendingPermission("group:A")).toBeDefined();

    const approved = backend.resolvePermissionWithResult("group:A", "once", {
      senderId: "telegram:111",
      isGroup: true,
    });
    expect(approved.ok).toBe(true);

    const result = await turn;
    expect(result.text).toBe("done");
    expect(capturedOutcome).toEqual({
      outcome: { outcome: "selected", optionId: "opt-allow-once" },
    });
    expect(backend.getPendingPermission("group:A")).toBeUndefined();
  });

  it("keeps the legacy two-argument resolvePermission working on the backend", async () => {
    const client = new MockAgyAcpClient();
    client.promptHandler = async (sessionId, input) => {
      await input.permissionHandler!({
        sessionId,
        toolCall: { toolCallId: "tc-2", title: "Run", kind: "execute" },
        options: SAMPLE_OPTIONS.map((o) => ({
          optionId: o.optionId,
          name: o.name,
          kind: o.kind,
        })),
      } as never);
      return { sessionId, text: "legacy-done", stopReason: "end_turn" };
    };

    const backend = new AgyAgentBackend(makeTestConfig(), {
      client,
      permissionManager: new PermissionManager(),
      permissionNotifier: () => undefined,
    });

    const turn = backend.sendTurn({
      chatId: "chat-legacy-backend",
      cwd: "/tmp/workspace",
      text: "go",
    });

    await waitFor(
      () => backend.getPendingPermission("chat-legacy-backend") !== undefined,
    );
    expect(backend.resolvePermission("chat-legacy-backend", "once")).toBe(true);
    const result = await turn;
    expect(result.text).toBe("legacy-done");
  });
});