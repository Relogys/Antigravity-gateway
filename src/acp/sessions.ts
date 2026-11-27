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
  ModelCatalogEntry,
  PendingPermission,
  SessionInfo,
  TurnActivitySnapshot,
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
  getModelCatalog?(): ModelCatalogEntry[];
  ensureCatalogLoaded?(cwd: string): Promise<ModelCatalogEntry[]>;
}

export interface AgyAgentBackendOptions {
  client?: AgyAcpClientLike;
  permissionNotifier?: (chatId: string, perm: PendingPermission) => Promise<void> | void;
  permissionManager?: PermissionManager;
  /** Overrides the default `1500 * attempt` ms backoff between transient retries. */
  retryDelayMs?: number;
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

const EFFORT_TOKENS = ["low", "medium", "high", "xhigh"] as const;
const TRAILING_EFFORT_RE = /^(.*)-(low|medium|high|xhigh)$/i;
const MODEL_SLUG_RE = /^[a-z0-9][a-z0-9._-]{1,80}$/i;
const TRANSIENT_TURN_ERROR_RE =
  /timeout|timed out|rate.?limit|429|502|503|504|unavailable|econnreset|etimedout|epipe|overloaded|internal error|transport/i;

export type ModelResolution =
  | { ok: true; model: string; label?: string; effort?: string }
  | { ok: false; reason: "ambiguous"; message: string; candidates: ModelCatalogEntry[] }
  | { ok: false; reason: "invalid"; message: string };

/**
 * Resolves fuzzy / numbered / exact user model input against the live catalog.
 *
 * Accepts: a 1-based catalog index ("4"), index + effort ("4 xhigh"), a
 * `<query> <effort>` pair ("hydrogen xhigh"), an exact catalog id / available
 * slug ("gemini-4-neon-medium"), or a case-insensitive substring ("neon").
 * Ambiguous and unknown inputs are rejected explicitly so flags like "-h" are
 * never silently treated as model names.
 */
export function resolveModelSelection(
  input: string,
  catalog: ModelCatalogEntry[],
  availableModels: string[],
  availableEfforts: string[],
): ModelResolution {
  const trimmed = input.trim();
  if (!trimmed) {
    return {
      ok: false,
      reason: "invalid",
      message: "Provide a model name, number, or exact ID.",
    };
  }

  const effortSet = new Set<string>([
    ...EFFORT_TOKENS,
    ...availableEfforts.map((e) => e.toLowerCase()),
  ]);
  const tokens = trimmed.split(/\s+/);
  let effort: string | undefined;
  let query = trimmed;
  if (tokens.length >= 2) {
    const last = tokens[tokens.length - 1]!.toLowerCase();
    if (effortSet.has(last)) {
      effort = last;
      query = tokens.slice(0, -1).join(" ");
    }
  }

  // Reject CLI-style flags up front (e.g. "-h", "--help") so they are never
  // mistaken for a model; otherwise "-h" would substring-match "-hydrogen".
  if (query.startsWith("-")) {
    return {
      ok: false,
      reason: "invalid",
      message: `"${query}" is not a valid model name.`,
    };
  }

  // (a) 1-based numeric index into the catalog.
  if (/^\d+$/.test(query)) {
    const index = Number(query);
    if (catalog.length === 0) {
      return {
        ok: false,
        reason: "invalid",
        message: `No model catalog is available to resolve number "${query}".`,
      };
    }
    if (index >= 1 && index <= catalog.length) {
      const entry = catalog[index - 1]!;
      return { ok: true, model: entry.id, label: entry.name, effort };
    }
    return {
      ok: false,
      reason: "invalid",
      message: `Model number ${index} is out of range (1-${catalog.length}).`,
    };
  }

  // (b) exact catalog id.
  const exactEntry = catalog.find((e) => e.id === query);
  if (exactEntry) {
    return { ok: true, model: exactEntry.id, label: exactEntry.name, effort };
  }

  // (b) exact availableModels slug, splitting a trailing effort suffix.
  const exactSlug = availableModels.find((m) => m === query);
  if (exactSlug) {
    const split = TRAILING_EFFORT_RE.exec(exactSlug);
    if (split && split[1] && split[2]) {
      const base = split[1];
      const suffix = split[2].toLowerCase();
      const entry = catalog.find((e) => e.id === base);
      return {
        ok: true,
        model: entry?.id ?? base,
        label: entry?.name ?? base,
        effort: effort ?? suffix,
      };
    }
    const splitEntry = catalog.find((e) => e.id === exactSlug);
    return { ok: true, model: exactSlug, label: splitEntry?.name ?? exactSlug, effort };
  }

  // (d) case-insensitive substring match against catalog id or name.
  const needle = query.toLowerCase();
  const matches = catalog.filter(
    (e) =>
      e.id.toLowerCase().includes(needle) || e.name.toLowerCase().includes(needle),
  );
  if (matches.length === 1) {
    const entry = matches[0]!;
    return { ok: true, model: entry.id, label: entry.name, effort };
  }
  if (matches.length > 1) {
    const candidates = matches.map((m) => `${m.id} (${m.name})`).join(", ");
    return {
      ok: false,
      reason: "ambiguous",
      message: `Model "${query}" is ambiguous. Did you mean one of: ${candidates}?`,
      candidates: matches,
    };
  }

  if (catalog.length > 0) {
    const preview = catalog.slice(0, 10).map((m) => m.id).join(", ");
    const more = catalog.length > 10 ? `, +${catalog.length - 10} more` : "";
    return {
      ok: false,
      reason: "invalid",
      message: `Unknown model "${query}". Available: ${preview}${more}.`,
    };
  }

  // Empty catalog (e.g. offline / bare unit mocks): accept a plausible slug only,
  // which rejects flags such as "-h".
  if (!MODEL_SLUG_RE.test(query)) {
    return {
      ok: false,
      reason: "invalid",
      message: `"${query}" is not a valid model name.`,
    };
  }
  const split = splitModelAndEffort(query, []);
  return { ok: true, model: split.model, effort: effort ?? split.effort };
}

function isTransientTurnError(error: unknown): boolean {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return TRANSIENT_TURN_ERROR_RE.test(
      `${error.message} ${code !== undefined ? String(code) : ""}`,
    );
  }
  return TRANSIENT_TURN_ERROR_RE.test(String(error));
}

function isCancellationLike(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /\b(cancel|cancelled|canceled|aborted)\b/i.test(msg);
}

function conciseReason(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.split(/\r?\n/)[0]?.trim().slice(0, 200) || "unknown error";
}

function delayWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
  });
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
  private readonly activeTurnActivities = new Map<string, TurnActivitySnapshot>();
  private readonly turnAbortControllers = new Map<string, AbortController>();
  private readonly retryDelayMs?: number;

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
    this.retryDelayMs = options.retryDelayMs;
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

  async getModelCatalog(): Promise<ModelCatalogEntry[]> {
    if (this.client.ensureCatalogLoaded) {
      try {
        return await this.client.ensureCatalogLoaded(this.config.defaultCwd);
      } catch {
        return this.client.getModelCatalog?.() ?? [];
      }
    }
    return this.client.getModelCatalog?.() ?? [];
  }

  getTurnActivity(chatId: string): TurnActivitySnapshot | undefined {
    const snapshot = this.activeTurnActivities.get(chatId);
    return snapshot ? { ...snapshot } : undefined;
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
      const abort = new AbortController();
      this.turnAbortControllers.set(input.chatId, abort);
      const maxRetries = Math.max(0, this.config.turnMaxRetries ?? 2);
      const now = Date.now();
      const activity: TurnActivitySnapshot = {
        chatId: input.chatId,
        startedAt: now,
        lastActivityAt: now,
        phase: "starting",
        model: input.model ?? state.info.model,
        effort: input.effort ?? state.info.effort,
        toolCount: 0,
        retryCount: 0,
        maxRetries,
      };
      this.activeTurnActivities.set(input.chatId, activity);
      try {
        return await this.executeTurn(state, input, activity, abort.signal);
      } finally {
        this.activeTurnActivities.delete(input.chatId);
        if (this.turnAbortControllers.get(input.chatId) === abort) {
          this.turnAbortControllers.delete(input.chatId);
        }
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
    activity: TurnActivitySnapshot,
    abortSignal: AbortSignal,
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

    let hasStreamedText = false;
    const wrappedCallbacks: AgentTurnCallbacks = {
      onPermissionRequest: input.callbacks?.onPermissionRequest,
      onThoughtDelta: async (delta) => {
        activity.phase = "thinking";
        activity.lastActivityAt = Date.now();
        await input.callbacks?.onThoughtDelta?.(delta);
      },
      onToolCall: async (event) => {
        activity.phase = "tool";
        activity.currentTool = event.title;
        activity.toolCount += 1;
        activity.lastActivityAt = Date.now();
        await input.callbacks?.onToolCall?.(event);
      },
      onTextDelta: async (delta) => {
        activity.phase = "streaming";
        hasStreamedText = true;
        activity.lastActivityAt = Date.now();
        await input.callbacks?.onTextDelta?.(delta);
      },
    };

    const maxRetries = activity.maxRetries;
    let attempt = 0;
    for (;;) {
      try {
        return await this.client.prompt(state.info.sessionId, {
          text: input.text,
          attachments: input.attachments,
          callbacks: wrappedCallbacks,
          permissionHandler,
        });
      } catch (error) {
        const aborted = abortSignal.aborted;
        const canRetry =
          !hasStreamedText &&
          !aborted &&
          !isCancellationLike(error) &&
          isTransientTurnError(error) &&
          attempt < maxRetries;

        if (!canRetry) {
          if (aborted) {
            throw new Error(`Turn cancelled: ${conciseReason(error)}`);
          }
          throw error;
        }

        attempt += 1;
        activity.retryCount = attempt;
        activity.phase = "retrying";
        activity.lastRetryReason = conciseReason(error);
        activity.lastActivityAt = Date.now();

        await delayWithAbort(this.retryDelayMs ?? 1500 * attempt, abortSignal);
        if (abortSignal.aborted) {
          throw new Error(`Turn cancelled: ${conciseReason(error)}`);
        }
        activity.phase = "retrying";
      }
    }
  }

  async cancelTurn(chatId: string): Promise<boolean> {
    this.turnAbortControllers.get(chatId)?.abort();
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
  ): Promise<{ model: string; effort?: string; label?: string }> {
    const state = this.getOrCreateChatState(chatId);

    let catalog = this.client.getModelCatalog?.() ?? [];
    if (catalog.length === 0 && this.client.ensureCatalogLoaded) {
      catalog = await this.client.ensureCatalogLoaded(this.config.defaultCwd).catch(
        () => [],
      );
    }

    const resolved = resolveModelSelection(
      modelInput,
      catalog,
      this.client.getAvailableModels(),
      this.client.getAvailableEfforts(),
    );
    if (!resolved.ok) {
      throw new Error(resolved.message);
    }

    state.info.model = resolved.model;
    if (resolved.effort) {
      state.info.effort = resolved.effort;
    }
    state.info.updatedAt = Date.now();

    if (state.info.sessionId) {
      await this.client.setConfigOption(
        state.info.sessionId,
        "model",
        resolved.model,
      );
      if (resolved.effort) {
        await this.client.setConfigOption(
          state.info.sessionId,
          "thought_level",
          resolved.effort,
        );
      }
    }

    const result: { model: string; effort?: string; label?: string } = {
      model: resolved.model,
    };
    if (resolved.effort) {
      result.effort = resolved.effort;
    }
    if (resolved.label && resolved.label !== resolved.model) {
      result.label = resolved.label;
    }
    return result;
  }

  async setEffort(chatId: string, effort: string): Promise<void> {
    await this.setConfigOption(chatId, "thought_level", effort);
  }
}
