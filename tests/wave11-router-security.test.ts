import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PermissionManager } from "../src/acp/permissions.js";
import type { GatewayConfig } from "../src/config.js";
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
  ApprovalMode,
  InboundMessage,
  OutboundMessage,
  PermissionOption,
  SessionInfo,
} from "../src/types.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agw-wave11-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

const SAMPLE_OPTIONS: PermissionOption[] = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
  { optionId: "reject-once", name: "Deny", kind: "reject_once" },
];

function makeConfig(
  dataDir: string,
  overrides: Partial<GatewayConfig> = {},
): GatewayConfig {
  return {
    allowedSenders: new Set(["telegram:1001", "telegram:1002", "telegram:1003"]),
    adminSenders: new Set(["telegram:1003"]),
    allowGroups: true,
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
    turnMaxRetries: 2,
    autoBootstrapChannelSession: true,
    dataDir,
    logLevel: "info",
    ...overrides,
  };
}

function makeInbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    channel: "telegram",
    chatId: "telegram::group-1",
    senderId: "1001",
    isGroup: true,
    text: "@agy hello",
    attachments: [],
    timestamp: Date.now(),
    mentionsBot: true,
    ...overrides,
  };
}

class TestChannel implements ExtendedChannelAdapter {
  readonly name = "telegram";
  sent: Array<{ chatId: string; text?: string }> = [];

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async sendMessage(msg: OutboundMessage): Promise<{ messageId?: string }> {
    this.sent.push({ chatId: msg.chatId, text: msg.text });
    return { messageId: `msg-${this.sent.length}` };
  }
  isConnected(): boolean {
    return true;
  }
  last(): string {
    return this.sent.at(-1)?.text ?? "";
  }
}

/** Backend whose permission gate is the real PermissionManager. */
class PermissionBackend implements ExtendedAgentBackend {
  readonly permissions = new PermissionManager({ timeoutMs: 60_000 });
  readonly approvalModes = new Map<string, ApprovalMode>();
  readonly sessions = new Map<string, SessionInfo>();
  turnCalls: AgentTurnInput[] = [];

  async stop(): Promise<void> {}

  async sendTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    this.turnCalls.push(input);
    const approvalMode = input.approvalMode ?? "interactive";
    this.approvalModes.set(input.chatId, approvalMode);
    void this.permissions.handlePermissionRequest(
      input.chatId,
      approvalMode,
      {
        sessionId: "sess-1",
        toolCallId: `tc-${this.turnCalls.length}`,
        title: "Run command",
        kind: "execute",
        requesterSenderId: input.requesterSenderId,
        options: SAMPLE_OPTIONS,
      },
      () => undefined,
    );
    return {
      sessionId: "sess-1",
      text: `Echo: ${input.text}`,
      stopReason: "end_turn",
    };
  }

  async cancelTurn(): Promise<boolean> {
    return false;
  }

  async resetSession(chatId: string): Promise<void> {
    this.permissions.cancelAllForChat(chatId);
  }

  async listSessions(): Promise<AcpSessionSummary[]> {
    return [];
  }

  setApprovalMode(chatId: string, mode: ApprovalMode): void {
    this.approvalModes.set(chatId, mode);
  }

  getApprovalMode(chatId: string): ApprovalMode {
    return this.approvalModes.get(chatId) ?? "interactive";
  }

  getPendingPermission(chatId: string) {
    return this.permissions.getPending(chatId);
  }

  resolvePermission(
    chatId: string,
    decision: "once" | "session" | "always" | "deny",
    actor?: { senderId?: string; isGroup?: boolean; isAdmin?: boolean },
  ): boolean {
    return this.permissions.resolve(chatId, decision, actor);
  }

  resolvePermissionWithResult(
    chatId: string,
    decision: "once" | "session" | "always" | "deny",
    actor?: { senderId?: string; isGroup?: boolean; isAdmin?: boolean },
  ) {
    return this.permissions.resolveWithResult(chatId, decision, actor);
  }

  getSessionInfo(chatId: string): SessionInfo | undefined {
    return this.sessions.get(chatId);
  }

  getStats() {
    return {
      activeSessions: 0,
      activeTurns: 0,
      pendingPermissions: this.permissions.pendingCount(),
    };
  }
}

async function setup() {
  const dataDir = await createTempDir();
  const store = new GatewayStore(dataDir);
  await store.load();
  const channel = new TestChannel();
  const backend = new PermissionBackend();
  const scheduler = new LoopScheduler({ store, channel });
  const router = new GatewayRouter({
    config: makeConfig(dataDir),
    channel,
    backend,
    store,
    scheduler,
    quotaFetcher: async () => ({ available: false, fetchedAt: Date.now(), groups: [] }),
  });
  router.markReady();
  return { dataDir, store, channel, backend, scheduler, router };
}

const GROUP_CHAT = "telegram::group-1";

describe("Group permission approvals are bound to the requester", () => {
  it("rejects other allowlisted members, keeps the request pending, then lets the requester approve", async () => {
    const { router, channel, backend } = await setup();

    // User A triggers a turn -> backend registers a pending permission for A.
    await router.handleInbound(makeInbound({ senderId: "1001", text: "@agy run it" }));
    expect(backend.getPendingPermission(GROUP_CHAT)?.requesterSenderId).toBe(
      "telegram:1001",
    );

    // User B is allowlisted but not the requester: approval must be refused.
    await router.handleInbound(makeInbound({ senderId: "1002", text: "@agy /approve" }));
    expect(channel.last()).toContain("Only the original requester (telegram:1001)");
    expect(backend.getPendingPermission(GROUP_CHAT)).toBeDefined();

    // Same for deny.
    await router.handleInbound(makeInbound({ senderId: "1002", text: "@agy /deny" }));
    expect(channel.last()).toContain("Only the original requester (telegram:1001)");
    expect(backend.getPendingPermission(GROUP_CHAT)).toBeDefined();

    // The original requester can settle it.
    await router.handleInbound(makeInbound({ senderId: "1001", text: "@agy /approve" }));
    expect(channel.last()).toContain("Approved (once)");
    expect(backend.getPendingPermission(GROUP_CHAT)).toBeUndefined();
  });

  it("lets a configured admin override another member's pending permission", async () => {
    const { router, channel, backend } = await setup();

    await router.handleInbound(makeInbound({ senderId: "1001", text: "@agy run it" }));
    expect(backend.getPendingPermission(GROUP_CHAT)).toBeDefined();

    await router.handleInbound(makeInbound({ senderId: "1003", text: "@agy /deny" }));
    expect(channel.last()).toContain("Denied");
    expect(backend.getPendingPermission(GROUP_CHAT)).toBeUndefined();
  });
});

describe("Group /yolo is admin-gated", () => {
  it("refuses non-admin members and leaves the approval mode unchanged", async () => {
    const { router, channel, backend } = await setup();
    expect(backend.getApprovalMode(GROUP_CHAT)).toBe("interactive");

    await router.handleInbound(makeInbound({ senderId: "1002", text: "@agy /yolo" }));
    expect(channel.last()).toContain("restricted to configured ADMIN_SENDERS");
    expect(backend.getApprovalMode(GROUP_CHAT)).toBe("interactive");

    // Admin can toggle it.
    await router.handleInbound(makeInbound({ senderId: "1003", text: "@agy /yolo" }));
    expect(channel.last()).toContain("Approval mode set to auto");
    expect(backend.getApprovalMode(GROUP_CHAT)).toBe("auto");
  });

  it("keeps DM /yolo available to any allowlisted sender", async () => {
    const { router, channel, backend } = await setup();
    const dmChat = "telegram::dm-1001";

    await router.handleInbound(
      makeInbound({
        chatId: dmChat,
        senderId: "1001",
        isGroup: false,
        text: "/yolo",
      }),
    );
    expect(channel.last()).toContain("Approval mode set to auto");
    expect(backend.getApprovalMode(dmChat)).toBe("auto");
  });
});

describe("Extracted command modules remain wired to GatewayRouter", () => {
  it("dispatches system, session, loop, and version commands", async () => {
    const { router, channel } = await setup();
    const dmChat = "telegram::dm-1001";
    const send = (text: string) =>
      router.handleInbound(
        makeInbound({ chatId: dmChat, senderId: "1001", isGroup: false, text }),
      );

    await send("/ping");
    expect(channel.last()).toContain("🏓 Pong!");

    await send("/help");
    expect(channel.last()).toContain("Antigravity Gateway Commands:");

    await send("/verbose");
    expect(channel.last()).toContain("Verbosity: brief");

    await send("/progress");
    expect(channel.last()).toContain("Tool progress:");

    await send("/status");
    expect(channel.last()).toContain("Status: ok");

    await send("/loop list");
    expect(channel.last()).toContain("No scheduled loops for this chat.");

    await send("/version");
    expect(channel.last()).toContain("antigravity-gateway v0.4.3");
  });
});