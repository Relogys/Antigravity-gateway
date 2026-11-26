import * as acp from "@agentclientprotocol/sdk";
import type { GatewayConfig } from "../config.js";
import type {
  AcpSessionSummary,
  AgentBackend,
  AgentTurnCallbacks,
  AgentTurnInput,
  AgentTurnResult,
  ApprovalMode,
  BusyMode,
  InboundAttachment,
  PendingPermission,
  SessionInfo,
} from "../types.js";
import { AgyAcpClient, type AcpPermissionHandler, type NewSessionInfo } from "./client.js";
import { PermissionManager, type PermissionDecision } from "./permissions.js";

export interface AgyAcpClientLike {
  ensureStarted(): Promise<unknown>;
  stop(): Promise<void>;
  newSession(cwd: string): Promise<NewSessionInfo>;
  loadSession(sessionId: string, cwd: string): Promise<void>;
  resumeSession?(sessionId: string, cwd: string): Promise<void>;
  listSessions(cwd?: string): Promise<AcpSessionSummary[]>;
  closeSession?(sessionId: string): Promise<void>;
  setConfigOption(sessionId: string, configId: string, value: string): Promise<void>;
  setMode(sessionId: string, modeId: string): Promise<void>;
  prompt(
    sessionId: string,
    input: {
      text: string;
      attachments?: InboundAttachment[];
      callbacks?: AgentTurnCallbacks;
      permissionHandler?: AcpPermissionHandler;
    },
  ): Promise<AgentTurnResult>;
  cancel(sessionId: string): Promise<void>;
  getAvailableModels(): string[];
  getAvailableBaseModels(): string[];
  getAvailableEfforts(): string[];
  getAvailableModes(): string[];
}

export interface AgyAgentBackendOptions {
  client?: AgyAcpClientLike;
  permissionNotifier?: (chatId: string, perm: PendingPermission) => Promise<void> | void;
  permissionManager?: PermissionManager;
}

const EFFORT_SUFFIX_RE = /^(.*)-(low|medium|high|xhigh|max)$/i;

/**
 * Splits a composite Antigravity model slug (e.g. `gemini-4-hydrogen-high`)
 * into base model ID (`gemini-4-hydrogen`) + effort (`high`), unless the
 * full string already matches a known base model ID (like `gpt-oss-120b-medium`).
 */
export function splitModelAndEffort(
  modelInput: string,
  knownBaseModels: string[] = [],
): { model: string; effort?: string } {
  const trimmed = modelInput.trim();
  if (!trimmed) {
    return { model: trimmed };
  }
  if (knownBaseModels.includes(trimmed)) {
    return { model: trimmed };
  }
  const match = EFFORT_SUFFIX_RE.exec(trimmed);
  if (match && match[1]) {
    const base = match[1];
    const effort = match[2].toLowerCase();
    // If knownBaseModels is provided and contains base, or if base looks like a model family
    if (knownBaseModels.length === 0 || knownBaseModels.includes(base)) {
      return { model: base, effort };
    }
  }
  return { model: trimmed };
}

interface ChatSessionState {
  info: SessionInfo;
  busyMode: BusyMode;
  activeTurn: boolean;
  queuedPrompts: string[];
  turnChain: Promise<void>;
}

export class AgyAgentBackend implements AgentBackend {
  private readonly client: AgyAcpClientLike;
  private readonly permissions: PermissionManager;
  private readonly permissionNotifier?: (
    chatId: string,
    perm: PendingPermission,
  ) => Promise<void> | void;
  private readonly chats = new Map<string, ChatSessionState>();

  constructor(
    private readonly config: GatewayConfig,
    options: AgyAgentBackendOptions = {},
  ) {
    this.client =
      options.client ??
      new AgyAcpClient({
        agyBin: config.agyBin,
        defaultCwd: config.defaultCwd,
        approvalMode: config.approvalMode,
        geminiApiKey: config.geminiApiKey,
      });
    this.permissions = options.permissionManager ?? new PermissionManager();
    this.permissionNotifier = options.permissionNotifier;
  }

  async start(): Promise<void> {
    await this.client.ensureStarted();
  }

  async stop(): Promise<void> {
    this.permissions.cancelAll();
    await this.client.stop();
  }

  private getOrCreateChatState(chatId: string, cwd?: string): ChatSessionState {
    let state = this.chats.get(chatId);
    if (!state) {
      const now = Date.now();
      const initialModel = this.config.defaultModel
        ? splitModelAndEffort(
            this.config.defaultModel,
            this.client.getAvailableBaseModels(),
          )
        : undefined;
      state = {
        info: {
          chatId,
          sessionId: "",
          cwd: cwd ?? this.config.defaultCwd,
          model: initialModel?.model,
          effort: this.config.defaultEffort ?? initialModel?.effort,
          approvalMode: this.config.approvalMode,
          busyMode: "queue",
          createdAt: now,
          updatedAt: now,
        },
        busyMode: "queue",
        activeTurn: false,
        queuedPrompts: [],
        turnChain: Promise.resolve(),
      };
      this.chats.set(chatId, state);
    }
    return state;
  }

  getSessionInfo(chatId: string): SessionInfo | undefined {
    const state = this.chats.get(chatId);
    return state ? { ...state.info } : undefined;
  }

  isBusy(chatId: string): boolean {
    return this.chats.get(chatId)?.activeTurn ?? false;
  }

  getBusyMode(chatId: string): BusyMode {
    return this.getOrCreateChatState(chatId).busyMode;
  }

  setBusyMode(chatId: string, mode: BusyMode): void {
    const state = this.getOrCreateChatState(chatId);
    state.busyMode = mode;
    state.info.busyMode = mode;
    state.info.updatedAt = Date.now();
  }

  getQueue(chatId: string): string[] {
    return [...(this.chats.get(chatId)?.queuedPrompts ?? [])];
  }

  enqueuePrompt(chatId: string, text: string): number {
    const state = this.getOrCreateChatState(chatId);
    state.queuedPrompts.push(text);
    return state.queuedPrompts.length;
  }

  shiftQueuedPrompt(chatId: string): string | undefined {
    return this.chats.get(chatId)?.queuedPrompts.shift();
  }

  clearQueue(chatId: string): number {
    const state = this.chats.get(chatId);
    if (!state) {
      return 0;
    }
    const count = state.queuedPrompts.length;
    state.queuedPrompts.length = 0;
    return count;
  }

  setApprovalMode(chatId: string, mode: ApprovalMode): void {
    const state = this.getOrCreateChatState(chatId);
    state.info.approvalMode = mode;
    state.info.updatedAt = Date.now();
  }

  getApprovalMode(chatId: string): ApprovalMode {
    return this.getOrCreateChatState(chatId).info.approvalMode;
  }

  getPendingPermission(chatId: string): PendingPermission | undefined {
    return this.permissions.getPending(chatId);
  }

  resolvePermission(chatId: string, decision: PermissionDecision): boolean {
    return this.permissions.resolve(chatId, decision);
  }

  getAvailableModels(): string[] {
    return this.client.getAvailableModels();
  }

  getAvailableEfforts(): string[] {
    return this.client.getAvailableEfforts();
  }

  getAvailableModes(): string[] {
    return this.client.getAvailableModes();
  }

  getStats(): {
    activeSessions: number;
    activeTurns: number;
    pendingPermissions: number;
  } {
    let activeSessions = 0;
    let activeTurns = 0;
    for (const state of this.chats.values()) {
      if (state.info.sessionId) {
        activeSessions++;
      }
      if (state.activeTurn) {
        activeTurns++;
      }
    }
    return {
      activeSessions,
      activeTurns,
      pendingPermissions: this.permissions.pendingCount(),
    };
  }

  async sendTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    const state = this.getOrCreateChatState(input.chatId, input.cwd);

    const run = state.turnChain.then(async () => {
      state.activeTurn = true;
      try {
        return await this.executeTurn(state, input);
      } finally {
        state.activeTurn = false;
        state.info.updatedAt = Date.now();
      }
    });

    // Keep the chain alive even if an individual turn rejects
    state.turnChain = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }

  private async executeTurn(
    state: ChatSessionState,
    input: AgentTurnInput,
  ): Promise<AgentTurnResult> {
    const cwd = input.cwd || state.info.cwd || this.config.defaultCwd;
    if (input.approvalMode) {
      state.info.approvalMode = input.approvalMode;
    }

    if (input.sessionId && input.sessionId !== state.info.sessionId) {
      await this.client.loadSession(input.sessionId, cwd);
      state.info.sessionId = input.sessionId;
      state.info.cwd = cwd;
    } else if (!state.info.sessionId || state.info.cwd !== cwd) {
      const created = await this.client.newSession(cwd);
      state.info.sessionId = created.sessionId;
      state.info.cwd = cwd;

      if (state.info.model) {
        await this.client.setConfigOption(
          created.sessionId,
          "model",
          state.info.model,
        );
      }
      if (state.info.effort) {
        await this.client.setConfigOption(
          created.sessionId,
          "thought_level",
          state.info.effort,
        );
      }
      if (state.info.mode) {
        await this.client.setConfigOption(
          created.sessionId,
          "mode",
          state.info.mode,
        );
      }
    }

    if (input.model) {
      const split = splitModelAndEffort(
        input.model,
        this.client.getAvailableBaseModels(),
      );
      await this.client.setConfigOption(state.info.sessionId, "model", split.model);
      state.info.model = split.model;
      const eff = input.effort ?? split.effort;
      if (eff) {
        await this.client.setConfigOption(state.info.sessionId, "thought_level", eff);
        state.info.effort = eff;
      }
    } else if (input.effort) {
      await this.client.setConfigOption(
        state.info.sessionId,
        "thought_level",
        input.effort,
      );
      state.info.effort = input.effort;
    }

    const permissionHandler: AcpPermissionHandler = async (req) => {
      const reqInfo = {
        sessionId: req.sessionId,
        toolCallId: req.toolCall.toolCallId,
        title: req.toolCall.title ?? req.toolCall.toolCallId,
        kind: req.toolCall.kind ?? undefined,
        options: req.options.map((o) => ({
          optionId: o.optionId,
          name: o.name,
          kind: o.kind,
        })),
      };

      let selectedId: string | null;
      if (input.callbacks?.onPermissionRequest) {
        selectedId = await input.callbacks.onPermissionRequest(reqInfo);
      } else {
        selectedId = await this.permissions.handlePermissionRequest(
          input.chatId,
          state.info.approvalMode,
          reqInfo,
          this.permissionNotifier
            ? (perm) => this.permissionNotifier!(input.chatId, perm)
            : undefined,
        );
      }

      if (selectedId) {
        return {
          outcome: {
            outcome: "selected",
            optionId: selectedId,
          },
        };
      }
      return {
        outcome: {
          outcome: "cancelled",
        },
      };
    };

    const result = await this.client.prompt(state.info.sessionId, {
      text: input.text,
      attachments: input.attachments,
      callbacks: input.callbacks,
      permissionHandler,
    });
    return result;
  }

  async cancelTurn(chatId: string): Promise<boolean> {
    const state = this.chats.get(chatId);
    if (!state || !state.info.sessionId || !state.activeTurn) {
      return false;
    }
    this.permissions.cancelAllForChat(chatId);
    await this.client.cancel(state.info.sessionId);
    return true;
  }

  async resetSession(chatId: string): Promise<void> {
    const state = this.chats.get(chatId);
    if (!state) {
      return;
    }
    this.permissions.cancelAllForChat(chatId);
    state.queuedPrompts.length = 0;
    const prevSessionId = state.info.sessionId;
    state.info.sessionId = "";
    state.info.updatedAt = Date.now();
    if (prevSessionId && this.client.closeSession) {
      await this.client.closeSession(prevSessionId).catch(() => undefined);
    }
  }

  async listSessions(cwd?: string): Promise<AcpSessionSummary[]> {
    return this.client.listSessions(cwd ?? this.config.defaultCwd);
  }

  async attachSession(chatId: string, sessionId: string, cwd: string): Promise<void> {
    const state = this.getOrCreateChatState(chatId, cwd);
    this.permissions.cancelAllForChat(chatId);
    await this.client.loadSession(sessionId, cwd);
    state.info.sessionId = sessionId;
    state.info.cwd = cwd;
    state.info.updatedAt = Date.now();
  }

  async setConfigOption(
    chatId: string,
    configId: string,
    value: string,
  ): Promise<void> {
    const state = this.getOrCreateChatState(chatId);
    if (configId === "model") {
      state.info.model = value;
    } else if (configId === "thought_level") {
      state.info.effort = value;
    } else if (configId === "mode") {
      state.info.mode = value;
    }
    state.info.updatedAt = Date.now();

    if (state.info.sessionId) {
      await this.client.setConfigOption(state.info.sessionId, configId, value);
    }
  }

  async setMode(chatId: string, modeId: string): Promise<void> {
    const state = this.getOrCreateChatState(chatId);
    state.info.mode = modeId;
    state.info.updatedAt = Date.now();
    if (state.info.sessionId) {
      await this.client.setConfigOption(state.info.sessionId, "mode", modeId);
    }
  }

  async setModel(
    chatId: string,
    modelInput: string,
  ): Promise<{ model: string; effort?: string }> {
    const state = this.getOrCreateChatState(chatId);
    // Ensure client metadata is loaded if not yet started
    if (this.client.getAvailableBaseModels().length === 0) {
      await this.client.ensureStarted();
    }
    const split = splitModelAndEffort(
      modelInput,
      this.client.getAvailableBaseModels(),
    );
    state.info.model = split.model;
    if (split.effort) {
      state.info.effort = split.effort;
    }
    state.info.updatedAt = Date.now();

    if (state.info.sessionId) {
      await this.client.setConfigOption(state.info.sessionId, "model", split.model);
      if (split.effort) {
        await this.client.setConfigOption(
          state.info.sessionId,
          "thought_level",
          split.effort,
        );
      }
    }
    return split;
  }

  async setEffort(chatId: string, effort: string): Promise<void> {
    await this.setConfigOption(chatId, "thought_level", effort);
  }
}
