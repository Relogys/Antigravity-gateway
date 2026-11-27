import type { ConversationGroupSync } from "../acp/conversation-sync.js";
import type {
  PermissionResolveActor,
  PermissionResolveResult,
} from "../acp/permissions.js";
import { fetchAgyQuota } from "../acp/quota.js";
import { stripIdeFileLinks } from "../channels/format.js";
import { splitQualifiedChatId } from "../channels/hub.js";
import {
  getChannelAllowedUsers,
  isPhotonChannel,
  normalizeSenderId,
  normalizeUserId,
  senderKeyFor,
  type ChannelName,
  type GatewayConfig,
} from "../config.js";
import { extractOutboundMedia } from "../photon/format.js";
import type {
  AcpSessionSummary,
  AgentBackend,
  ApprovalMode,
  BusyMode,
  ChannelAdapter,
  ChannelHealthStatus,
  HealthSnapshot,
  InboundAttachment,
  InboundMessage,
  LoopJob,
  ModelCatalogEntry,
  PendingPermission,
  QuotaSummary,
  SessionInfo,
  ToolProgressMode,
  TurnActivitySnapshot,
} from "../types.js";
import { IngressBurstCoalescer, type ReplyQuoteMetadata } from "./burst.js";
import { handleLoopCommand } from "./commands/loop.js";
import { handlePhotonNativeCommand } from "./commands/photon.js";
import { handleSessionCommand } from "./commands/session.js";
import {
  formatUptime,
  handleSystemCommand,
  type RouterCommandContext,
  type VerbosityLevel,
} from "./commands/system.js";
import { BotLoopGuard } from "./guards.js";
import { LiveProgressTracker, sanitizeToolTitle } from "./progress.js";
import { LoopScheduler } from "./scheduler.js";
import type { GatewayStore } from "./store.js";

const DEFAULT_TYPING_INTERVAL_MS = 5000;
const DEFAULT_PROGRESS_POLL_INTERVAL_MS = 15_000;
const QUOTA_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const GATEWAY_VERSION = "0.3.0";
const MAX_SESSION_LIST_CACHE = 500;
const MAX_LAST_PROMPTS = 500;
const REPLY_QUOTE_SNIPPET_MAX = 500;

export interface ExtendedAgentBackend extends AgentBackend {
  getBusyMode?(chatId: string): BusyMode;
  setBusyMode?(chatId: string, mode: BusyMode): void;
  getQueue?(chatId: string): string[];
  enqueuePrompt?(chatId: string, text: string): number;
  shiftQueuedPrompt?(chatId: string): string | undefined;
  clearQueue?(chatId: string): number;
  isBusy?(chatId: string): boolean;
  setModel?(
    chatId: string,
    modelInput: string,
  ): Promise<{ model: string; effort?: string; label?: string }>;
  setEffort?(chatId: string, effort: string): Promise<void>;
  getAvailableModels?(): string[];
  getAvailableEfforts?(): string[];
  getAvailableModes?(): string[];
  /** Live model catalog (id + human-friendly name + efforts). Falls back to getAvailableModels. */
  getModelCatalog?(): Promise<ModelCatalogEntry[]>;
  /** Live per-turn activity used by the silence/stall watchdog. */
  getTurnActivity?(chatId: string): TurnActivitySnapshot | undefined;
  setApprovalMode?(chatId: string, mode: ApprovalMode): void;
  getApprovalMode?(chatId: string): ApprovalMode;
  getPendingPermission?(chatId: string): PendingPermission | undefined;
  resolvePermission?(
    chatId: string,
    decision: "once" | "session" | "always" | "deny",
    actor?: PermissionResolveActor,
  ): boolean;
  resolvePermissionWithResult?(
    chatId: string,
    decision: "once" | "session" | "always" | "deny",
    actor?: PermissionResolveActor,
  ): PermissionResolveResult;
  getStats?(): {
    activeSessions: number;
    activeTurns: number;
    pendingPermissions: number;
  };
  getSessionInfo?(chatId: string): SessionInfo | undefined;
}

export interface ExtendedChannelAdapter extends ChannelAdapter {
  /** Implemented by MultiChannelHub: per-channel health keyed by channel name. */
  getChannelSnapshots?(): Record<string, ChannelHealthStatus>;
  /** Implemented by MultiChannelHub: true when the target channel supports silent live edits. */
  supportsLiveProgressEdit?(chatId: string): boolean;
  /** Implemented by MultiChannelHub: true when the target channel supports message deletion. */
  canDeleteMessage?(chatId: string): boolean;
  /** Implemented by MultiChannelHub: resolve the owning adapter + raw chat id for a chat. */
  resolveTarget?(chatId: string): {
    channel: string;
    adapter: ChannelAdapter;
    rawChatId: string;
  };
  /** Implemented by MultiChannelHub: look up a registered adapter by channel name. */
  getAdapter?(name: string): ChannelAdapter | undefined;
}

export interface GatewayRouterDeps {
  config: GatewayConfig;
  channel: ExtendedChannelAdapter;
  backend: ExtendedAgentBackend;
  store: GatewayStore;
  scheduler: LoopScheduler;
  quotaFetcher?: () => Promise<QuotaSummary>;
  version?: string;
  /** Optional best-effort bridge mirroring session groups into the Antigravity sidebar. */
  conversationSync?: ConversationGroupSync;
  /** Per-chat circuit breaker for group-chat bursts (defaults to a new BotLoopGuard). */
  loopGuard?: BotLoopGuard;
  /** Typing refresh cadence during long ACP turns (default 5000ms; 0 disables). */
  typingIntervalMs?: number;
  /** How often the silence/stall watchdog samples turn activity (default 15000ms). */
  progressPollIntervalMs?: number;
  /** Rapid-fire bubble coalescing window; 0 disables coalescing (default 0). */
  burstDebounceMs?: number;
  /** Hard ceiling from the first buffered bubble before a coalesced flush (default 1000ms). */
  burstHardCapMs?: number;
}

const ALWAYS_DISPATCHABLE_COMMANDS = new Set([
  "stop",
  "cancel",
  "new",
  "reset",
  "status",
  "usage",
  "queue",
  "q",
  "steer",
  "s",
  "busy",
  "approve",
  "deny",
  "yolo",
  "whoami",
  "channels",
  "groups",
  "help",
  "commands",
  "version",
  "v",
  "ping",
  "sethome",
  "verbose",
  "progress",
  "poll",
  "bg",
  "unsend",
  "card",
]);

/** Slash commands that wipe/inspect pending work must also drop buffered burst fragments. */
const BURST_DISCARD_COMMANDS = new Set([
  "stop",
  "cancel",
  "new",
  "reset",
  "discard",
]);

/** @deprecated Wave 8A optional metadata, read defensively. */
type InboundWithQuote = InboundMessage & ReplyQuoteMetadata;

/** Slash commands that may take a while (network / agent work) get a 👀 working receipt. */
const SLOW_SLASH_COMMANDS = new Set([
  "usage",
  "sessions",
  "compact",
  "compress",
  "resume",
  "model",
  "effort",
  "mode",
]);

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isCancellationError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(cancel|cancelled|canceled|aborted)\b/i.test(msg);
}

/**
 * Central gateway router handling fail-closed authentication, slash commands,
 * serialized/queued turn execution, media extraction, quota notices, and health state.
 */
export class GatewayRouter {
  private readonly config: GatewayConfig;
  private readonly channel: ExtendedChannelAdapter;
  private readonly backend: ExtendedAgentBackend;
  private readonly store: GatewayStore;
  private readonly scheduler: LoopScheduler;
  private readonly quotaFetcher: () => Promise<QuotaSummary>;
  private readonly version: string;
  private readonly typingIntervalMs: number;
  private readonly progressPollIntervalMs: number;
  private readonly burstDebounceMs: number;
  private readonly burstCoalescer: IngressBurstCoalescer;
  private readonly conversationSync?: ConversationGroupSync;
  private readonly loopGuard: BotLoopGuard;

  private readonly startedAt = Date.now();
  private ready = false;
  private lastInboundAt?: number;
  private lastOutboundAt?: number;
  private lastError?: string;

  private readonly activeTurnChats = new Set<string>();
  private readonly cancelledByUser = new Set<string>();
  private readonly stopDrainChats = new Set<string>();
  private readonly sessionGenerations = new Map<string, number>();
  private readonly fallbackQueues = new Map<string, string[]>();
  private readonly fallbackBusyModes = new Map<string, BusyMode>();
  private readonly fallbackApprovalModes = new Map<string, ApprovalMode>();
  private readonly hydratedChats = new Set<string>();
  private readonly sessionListCache = new Map<string, AcpSessionSummary[]>();
  private readonly verbosityByChatId = new Map<string, VerbosityLevel>();
  private readonly toolProgressModeByChatId = new Map<string, ToolProgressMode>();
  private readonly toolProgressKeepByChatId = new Map<string, boolean>();
  private readonly lastPromptByChatId = new Map<string, string>();
  private cachedQuota?: QuotaSummary;

  constructor(deps: GatewayRouterDeps) {
    this.config = deps.config;
    this.channel = deps.channel;
    this.backend = deps.backend;
    this.store = deps.store;
    this.scheduler = deps.scheduler;
    this.version = deps.version ?? GATEWAY_VERSION;
    this.typingIntervalMs =
      deps.typingIntervalMs ?? DEFAULT_TYPING_INTERVAL_MS;
    this.progressPollIntervalMs =
      deps.progressPollIntervalMs ?? DEFAULT_PROGRESS_POLL_INTERVAL_MS;
    this.burstDebounceMs = deps.burstDebounceMs ?? 0;
    this.conversationSync = deps.conversationSync;
    this.loopGuard = deps.loopGuard ?? new BotLoopGuard();
    this.burstCoalescer = new IngressBurstCoalescer({
      debounceMs: this.burstDebounceMs,
      hardCapMs: deps.burstHardCapMs ?? 1000,
      onFlush: (merged) =>
        this.handleUserPrompt(merged, merged.text, merged.attachments),
    });
    this.quotaFetcher =
      deps.quotaFetcher ??
      (() =>
        fetchAgyQuota(this.config.agyBin, {
          env: {
            ...process.env,
            ...(this.config.geminiApiKey
              ? { GEMINI_API_KEY: this.config.geminiApiKey }
              : {}),
          },
        }));

    this.scheduler.setPromptRunner?.((job) => this.runLoopPrompt(job));
  }

  markReady(): void {
    this.ready = true;
  }

  /** Stops pending burst timers so buffered fragments never fire after shutdown. */
  stop(): void {
    this.burstCoalescer.stop();
  }

  /**
   * Called by AgyAgentBackend's permissionNotifier to alert the user in iMessage.
   */
  async notifyPermission(
    chatId: string,
    perm: PendingPermission,
  ): Promise<void> {
    const lines = [
      `⚠️ Permission requested: ${perm.title}${perm.kind ? ` (${perm.kind})` : ""}`,
      ...(perm.requesterSenderId
        ? [`Requested by: ${perm.requesterSenderId}`]
        : []),
      "Reply with:",
      "• /approve (once)",
      "• /approve session",
      "• /approve always",
      "• /deny",
    ];
    await this.sendReply(chatId, lines.join("\n"));
  }

  async handleInbound(msg: InboundMessage): Promise<void> {
    this.lastInboundAt = Date.now();

    const channel = msg.channel || this.channel.name;
    const rawSender = msg.senderId || msg.rawSenderId || "";
    const senderId = senderKeyFor(channel, rawSender);
    const authSource = this.resolveAuthSource(channel, rawSender, senderId);
    const authorized = senderId.length > 0 && authSource !== undefined;
    const groupsAllowed =
      this.config.allowGroups ||
      (channel === "discord" && Boolean(this.config.discord?.allowGuilds));

    if (msg.isGroup) {
      if (!authorized || !groupsAllowed || !msg.mentionsBot) {
        return;
      }
      const verdict = this.loopGuard.checkAndRecord(msg.chatId);
      if (!verdict.allowed) {
        return;
      }
    } else if (!authorized) {
      if (senderId) {
        const pairing = await this.store.createOrGetPairing(senderId);
        if (pairing.shouldNotify && pairing.code) {
          await this.sendReply(
            msg.chatId,
            `Access pending approval. Share pairing code ${pairing.code} with the host operator (expires in 1 hour).`,
            msg.id,
          );
        }
      }
      return;
    }

    if (this.readReceiptsEnabled(channel) && this.channel.markRead) {
      this.channel.markRead(msg.chatId, msg.id).catch(() => {});
    }

    const homeSave =
      !msg.isGroup && !this.store.getHomeChatId()
        ? this.store.setHomeChatId(msg.chatId).catch(() => {})
        : Promise.resolve();

    try {
      const bodyText = this.stripGroupMention(msg.text ?? "", msg.isGroup).trim();
      const cmdMatch = /^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(bodyText);

      if (cmdMatch) {
        const cmd = cmdMatch[1].toLowerCase();
        const args = (cmdMatch[2] ?? "").trim();
        // Commands never wait behind the coalescer; destructive ones also drop stale fragments.
        if (BURST_DISCARD_COMMANDS.has(cmd)) {
          this.burstCoalescer.discard(msg.chatId);
        }
        await this.handleSlashCommand(msg, senderId, cmd, args);
        return;
      }

      if (!bodyText && msg.attachments.length === 0) {
        return;
      }

      // Malformed slash input must bypass coalescing as well.
      if (bodyText.startsWith("/")) {
        await this.handleUserPrompt(msg, bodyText, msg.attachments);
        return;
      }

      if (this.burstDebounceMs > 0) {
        this.burstCoalescer.enqueue({ ...msg, text: bodyText });
        return;
      }

      await this.handleUserPrompt(msg, bodyText, msg.attachments);
    } finally {
      await homeSave;
    }
  }

  /**
   * Executes a scheduled prompt loop directly against the backend and sends the result.
   */
  async runLoopPrompt(job: LoopJob): Promise<void> {
    const syntheticMsg: InboundMessage = {
      id: `loop-${job.id}-${Date.now()}`,
      channel: splitQualifiedChatId(job.chatId).channel ?? this.channel.name,
      chatId: job.chatId,
      senderId: "scheduler",
      isGroup: false,
      text: job.prompt,
      attachments: [],
      timestamp: Date.now(),
    };
    const cwd = job.cwd ?? this.resolveDefaultCwd(job.chatId);
    if (this.isChatBusy(job.chatId)) {
      this.enqueueChatPrompt(job.chatId, job.prompt);
      return;
    }
    await this.executeTurn(syntheticMsg, job.prompt, [], {
      overrideCwd: cwd,
      isLoop: true,
    });
  }

  getHealthSnapshot(): HealthSnapshot {
    const channels = this.getChannelStatuses();
    const channelList = Object.values(channels);
    const channelConnected =
      channelList.length > 0
        ? channelList.some((c) => c.connected)
        : this.channel.isConnected();
    const allChannelsConnected =
      channelList.length > 0
        ? channelList.every((c) => c.connected)
        : channelConnected;
    const backendStats = this.backend.getStats?.();
    const channelStats = this.channel.getStats?.();
    const activeSessions =
      backendStats?.activeSessions ??
      this.store.listSessions().filter((s) => Boolean(s.sessionId)).length;

    const status = allChannelsConnected
      ? "ok"
      : this.ready
        ? "degraded"
        : "starting";

    return {
      status,
      startedAt: this.startedAt,
      uptimeMs: Date.now() - this.startedAt,
      channelConnected,
      activeSessions,
      activeTurns: backendStats?.activeTurns ?? this.activeTurnChats.size,
      pendingPermissions: backendStats?.pendingPermissions ?? 0,
      activeLoops: this.scheduler.activeCount(),
      lastInboundAt: channelStats?.lastInboundAt ?? this.lastInboundAt,
      lastOutboundAt: channelStats?.lastOutboundAt ?? this.lastOutboundAt,
      lastError: channelStats?.lastError ?? this.lastError,
      channels,
    };
  }

  private getChannelStatuses(): Record<string, ChannelHealthStatus> {
    const fromHub = this.channel.getChannelSnapshots?.();
    if (fromHub) {
      return fromHub;
    }
    const stats = this.channel.getStats?.() ?? {};
    return {
      [this.channel.name]: {
        name: this.channel.name,
        connected: this.channel.isConnected(),
        ...stats,
      },
    };
  }

  /**
   * Fail-closed sender authorization shared by every channel. Sources (unioned):
   * - per-channel `<CHANNEL>_ALLOWED_USERS` (platform ids)
   * - global `ALLOWED_SENDERS` (photon: phone/email; others: `<channel>:<id>` entries)
   * - paired senders in the store (`senderKey` is channel-namespaced for non-photon)
   */
  private resolveAuthSource(
    channel: string,
    rawSender: string,
    senderKey: string,
  ): "channel allowlist" | "env allowlist" | "paired allowlist" | undefined {
    if (!senderKey) {
      return undefined;
    }
    if (
      !isPhotonChannel(channel) &&
      getChannelAllowedUsers(this.config, channel).has(normalizeUserId(rawSender))
    ) {
      return "channel allowlist";
    }
    if (this.config.allowedSenders.has(senderKey)) {
      return "env allowlist";
    }
    if (this.store.isApprovedSender(senderKey)) {
      return "paired allowlist";
    }
    return undefined;
  }

  /**
   * True when the sender is listed in `ADMIN_SENDERS`, using the same keys as
   * `ALLOWED_SENDERS`: photon uses bare phone/email, other channels use
   * `<channel>:<userId>` (all case-insensitive).
   */
  private isAdminSender(
    channel: string,
    rawSender: string,
    canonicalSenderId: string,
  ): boolean {
    const admins = this.config.adminSenders;
    if (!admins || admins.size === 0) {
      return false;
    }

    const candidates = new Set<string>();
    const canonical = canonicalSenderId.trim().toLowerCase();
    if (canonical) {
      candidates.add(canonical);
    }
    const senderKey = senderKeyFor(channel, rawSender);
    if (senderKey) {
      candidates.add(senderKey.toLowerCase());
    }
    const raw = rawSender.trim();
    if (raw) {
      candidates.add(raw.toLowerCase());
      if (isPhotonChannel(channel)) {
        const normalized = normalizeSenderId(raw);
        if (normalized) {
          candidates.add(normalized);
        }
      } else {
        const normalized = normalizeUserId(raw);
        if (normalized) {
          candidates.add(normalized);
          candidates.add(`${channel.toLowerCase()}:${normalized}`);
        }
      }
    }

    for (const candidate of candidates) {
      if (admins.has(candidate)) {
        return true;
      }
    }
    return false;
  }

  private readReceiptsEnabled(channel: string): boolean {
    return isPhotonChannel(channel) ? (this.config.photon?.readReceipts ?? true) : true;
  }

  private reactionsEnabled(channel: string): boolean {
    return isPhotonChannel(channel) ? (this.config.photon?.reactions ?? true) : true;
  }

  private getChatVerbosity(chatId: string): VerbosityLevel {
    return this.verbosityByChatId.get(chatId) ?? "brief";
  }

  private getChatToolProgressMode(chatId: string): ToolProgressMode {
    return (
      this.toolProgressModeByChatId.get(chatId) ??
      this.config.toolProgressMode ??
      "auto"
    );
  }

  private getChatToolProgressKeep(chatId: string): boolean {
    return (
      this.toolProgressKeepByChatId.get(chatId) ??
      this.config.toolProgressKeep ??
      false
    );
  }

  /**
   * Decides whether a turn should render a single in-place edited progress card
   * (Telegram/Discord/Slack) instead of periodic silence pulses (iMessage/Photon).
   */
  private shouldUseLiveProgressEdit(chatId: string, channelName: string): boolean {
    if (this.getChatVerbosity(chatId) === "off") {
      return false;
    }
    const mode = this.getChatToolProgressMode(chatId);
    if (mode === "off" || mode === "silence") {
      return false;
    }
    if (mode === "edit") {
      return Boolean(this.channel.editMessage);
    }
    if (this.channel.supportsLiveProgressEdit) {
      return this.channel.supportsLiveProgressEdit(chatId);
    }
    return Boolean(this.channel.editMessage) && !isPhotonChannel(channelName);
  }

  /** Resolve the underlying adapter + raw platform chat id for native (Photon) calls. */
  private resolveNativeAdapter(
    chatId: string,
    channelName: string,
  ): { adapter: unknown; rawChatId: string } {
    if (this.channel.resolveTarget) {
      try {
        const target = this.channel.resolveTarget(chatId);
        return { adapter: target.adapter, rawChatId: target.rawChatId };
      } catch {
        // Fall through to the simpler resolution paths below.
      }
    }
    if (this.channel.getAdapter) {
      return {
        adapter: this.channel.getAdapter(channelName),
        rawChatId: splitQualifiedChatId(chatId).chatId,
      };
    }
    return {
      adapter: this.channel,
      rawChatId: splitQualifiedChatId(chatId).chatId,
    };
  }

  private rememberLastPrompt(chatId: string, text: string): void {
    if (!text.trim()) {
      return;
    }
    this.lastPromptByChatId.delete(chatId);
    this.lastPromptByChatId.set(chatId, text);
    while (this.lastPromptByChatId.size > MAX_LAST_PROMPTS) {
      const oldest = this.lastPromptByChatId.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.lastPromptByChatId.delete(oldest);
    }
  }

  /**
   * Prepends reply-quote context so the agent can resolve "this"/"that" references.
   * Wave 8A adds these optional fields to InboundMessage; read them defensively.
   */
  private withReplyQuote(msg: InboundMessage, text: string): string {
    const quote = msg as InboundWithQuote;
    const raw = typeof quote.replyToText === "string" ? quote.replyToText.trim() : "";
    if (!raw) {
      return text;
    }
    const snippet = raw.slice(0, REPLY_QUOTE_SNIPPET_MAX);
    const label =
      quote.replyToIsOwnMessage === true
        ? "previous assistant message"
        : "quoted message";
    return `[Replying to ${label}: "${snippet}"]\n\n${text}`;
  }

  private stripGroupMention(text: string, isGroup: boolean): string {
    if (!isGroup || !text) {
      return text;
    }
    let out = text.trim();
    for (const pattern of this.config.groupMentionPatterns) {
      const trimmed = pattern.trim();
      if (!trimmed) continue;
      const re = new RegExp(`^${escapeRegExp(trimmed)}(?=$|[\\s:,.!?])[:,\\s]*`, "i");
      out = out.replace(re, "").trim();
    }
    return out;
  }

  private cacheSessionList(chatId: string, list: AcpSessionSummary[]): void {
    this.sessionListCache.delete(chatId);
    this.sessionListCache.set(chatId, list);
    while (this.sessionListCache.size > MAX_SESSION_LIST_CACHE) {
      const oldest = this.sessionListCache.keys().next().value;
      if (oldest === undefined) break;
      this.sessionListCache.delete(oldest);
    }
  }

  private hydrateChatFromStore(chatId: string): void {
    if (this.hydratedChats.has(chatId)) {
      return;
    }
    this.hydratedChats.add(chatId);
    const stored = this.store.getSession(chatId);
    if (!stored) {
      return;
    }
    if (stored.busyMode) {
      this.backend.setBusyMode?.(chatId, stored.busyMode);
      this.fallbackBusyModes.set(chatId, stored.busyMode);
    }
    if (stored.approvalMode) {
      this.backend.setApprovalMode?.(chatId, stored.approvalMode);
      this.fallbackApprovalModes.set(chatId, stored.approvalMode);
    }
  }

  private getSessionGeneration(chatId: string): number {
    return this.sessionGenerations.get(chatId) ?? 0;
  }

  private bumpSessionGeneration(chatId: string): number {
    const next = this.getSessionGeneration(chatId) + 1;
    this.sessionGenerations.set(chatId, next);
    return next;
  }

  private isChatBusy(chatId: string): boolean {
    return (
      this.activeTurnChats.has(chatId) || (this.backend.isBusy?.(chatId) ?? false)
    );
  }

  private getChatBusyMode(chatId: string): BusyMode {
    this.hydrateChatFromStore(chatId);
    if (this.backend.getBusyMode) {
      return this.backend.getBusyMode(chatId);
    }
    return (
      this.fallbackBusyModes.get(chatId) ??
      this.store.getSession(chatId)?.busyMode ??
      "queue"
    );
  }

  private async setChatBusyMode(chatId: string, mode: BusyMode): Promise<void> {
    this.hydratedChats.add(chatId);
    this.backend.setBusyMode?.(chatId, mode);
    this.fallbackBusyModes.set(chatId, mode);
    await this.ensureSessionRecord(chatId, { busyMode: mode });
  }

  private getChatApprovalMode(chatId: string): ApprovalMode {
    this.hydrateChatFromStore(chatId);
    if (this.backend.getApprovalMode) {
      return this.backend.getApprovalMode(chatId);
    }
    return (
      this.fallbackApprovalModes.get(chatId) ??
      this.store.getSession(chatId)?.approvalMode ??
      this.config.approvalMode
    );
  }

  private async setChatApprovalMode(
    chatId: string,
    mode: ApprovalMode,
  ): Promise<void> {
    this.hydratedChats.add(chatId);
    this.backend.setApprovalMode?.(chatId, mode);
    this.fallbackApprovalModes.set(chatId, mode);
    await this.ensureSessionRecord(chatId, { approvalMode: mode });
  }

  private getChatQueue(chatId: string): string[] {
    if (this.backend.getQueue) {
      return this.backend.getQueue(chatId);
    }
    return [...(this.fallbackQueues.get(chatId) ?? [])];
  }

  private enqueueChatPrompt(chatId: string, prompt: string): number {
    this.stopDrainChats.delete(chatId);
    if (this.backend.enqueuePrompt) {
      return this.backend.enqueuePrompt(chatId, prompt);
    }
    const q = this.fallbackQueues.get(chatId) ?? [];
    q.push(prompt);
    this.fallbackQueues.set(chatId, q);
    return q.length;
  }

  private shiftChatQueue(chatId: string): string | undefined {
    if (this.backend.shiftQueuedPrompt) {
      return this.backend.shiftQueuedPrompt(chatId);
    }
    if (this.backend.getQueue && this.backend.clearQueue && this.backend.enqueuePrompt) {
      const items = [...this.backend.getQueue(chatId)];
      if (items.length === 0) {
        return undefined;
      }
      const next = items.shift();
      this.backend.clearQueue(chatId);
      for (const rest of items) {
        this.backend.enqueuePrompt(chatId, rest);
      }
      return next;
    }
    return this.fallbackQueues.get(chatId)?.shift();
  }

  private clearChatQueue(chatId: string): number {
    if (this.backend.clearQueue) {
      return this.backend.clearQueue(chatId);
    }
    const q = this.fallbackQueues.get(chatId);
    const count = q?.length ?? 0;
    this.fallbackQueues.delete(chatId);
    return count;
  }

  /** Channel group a chat belongs to: qualified prefix, else the channel name (hub legacy => photon). */
  private resolveChannelGroup(chatId: string): string {
    return (
      splitQualifiedChatId(chatId).channel ??
      (this.channel.name === "hub" ? "photon" : this.channel.name)
    );
  }

  /** Resolve this chat's working directory: stored cwd, then per-channel default, then global default. */
  private resolveDefaultCwd(chatId: string): string {
    const channelGroup = this.resolveChannelGroup(chatId);
    return (
      this.store.getSession(chatId)?.cwd ??
      this.config.channelDefaultCwds?.[channelGroup as ChannelName] ??
      this.config.defaultCwd
    );
  }

  private async ensureSessionRecord(
    chatId: string,
    patch: Partial<SessionInfo> = {},
  ): Promise<SessionInfo> {
    const existing = this.store.getSession(chatId);
    const now = Date.now();
    const channelGroup =
      existing?.channelGroup ?? this.resolveChannelGroup(chatId);

    let title = existing?.title;
    if (!title) {
      const siblings = this.store
        .listSessionsByChannel(channelGroup)
        .filter((session) => session.chatId !== chatId).length;
      title = `[${channelGroup}] Session #${siblings + 1}`;
    }

    const merged: SessionInfo = {
      chatId,
      sessionId: existing?.sessionId ?? "",
      cwd:
        existing?.cwd ??
        this.config.channelDefaultCwds?.[channelGroup as ChannelName] ??
        this.config.defaultCwd,
      model: existing?.model ?? this.config.defaultModel,
      effort: existing?.effort ?? this.config.defaultEffort,
      mode: existing?.mode,
      approvalMode: existing?.approvalMode ?? this.getChatApprovalMode(chatId),
      busyMode: existing?.busyMode ?? this.getChatBusyMode(chatId),
      title,
      channelGroup,
      onboarded: existing?.onboarded,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...patch,
    };
    await this.store.upsertSession(merged);
    await this.store.ensureChannelBinding(channelGroup);

    if (merged.sessionId) {
      this.conversationSync
        ?.syncSessionGroup({
          sessionId: merged.sessionId,
          channelGroup: merged.channelGroup ?? this.resolveChannelGroup(chatId),
          title: merged.title,
        })
        .catch(() => {});
    }

    return merged;
  }

  private async handleSlashCommand(
    msg: InboundMessage,
    senderId: string,
    cmd: string,
    args: string,
  ): Promise<void> {
    const { chatId } = msg;
    const busy = this.isChatBusy(chatId);

    if (busy && !ALWAYS_DISPATCHABLE_COMMANDS.has(cmd)) {
      await this.sendReply(
        chatId,
        "Agent is currently busy. Wait for completion, or use /stop, /status, /queue, /steer, /approve, or /deny.",
        msg.id,
      );
      return;
    }

    const reactionsOn = this.reactionsEnabled(msg.channel) && Boolean(this.channel.react);
    const slow = SLOW_SLASH_COMMANDS.has(cmd);
    if (reactionsOn && slow) {
      this.channel.react!(chatId, msg.id, "👀").catch(() => {});
    }

    try {
      await this.dispatchSlashCommand(msg, senderId, cmd, args, busy);
      if (reactionsOn) {
        // Fast commands confirm immediately after replying; slow ones report completion here.
        this.channel.react!(chatId, msg.id, "👍").catch(() => {});
      }
    } catch (err) {
      if (reactionsOn) {
        this.channel.react!(chatId, msg.id, "👎").catch(() => {});
      }
      throw err;
    }
  }

  private async dispatchSlashCommand(
    msg: InboundMessage,
    senderId: string,
    cmd: string,
    args: string,
    busy: boolean,
  ): Promise<void> {
    const ctx = this.createCommandContext(msg, senderId, cmd, args, busy);

    if (await handleSystemCommand(ctx, cmd)) {
      return;
    }
    if (await handleSessionCommand(ctx, cmd)) {
      return;
    }
    if (await handleLoopCommand(ctx, cmd)) {
      return;
    }

    if (cmd === "poll" || cmd === "bg" || cmd === "unsend" || cmd === "card") {
      const { adapter, rawChatId } = ctx.resolveNativeAdapter();
      await handlePhotonNativeCommand({
        cmd,
        args,
        chatId: msg.chatId,
        rawChatId,
        channelName: msg.channel,
        replyToMessageId: msg.id,
        adapter,
        sendReply: (to, text, replyTo) => this.sendReply(to, text, replyTo),
      });
      return;
    }

    await this.sendReply(
      msg.chatId,
      `Unknown command: /${cmd}. Send /help for available commands.`,
      msg.id,
    );
  }

  private createCommandContext(
    msg: InboundMessage,
    senderId: string,
    cmd: string,
    args: string,
    busy: boolean,
  ): RouterCommandContext {
    const chatId = msg.chatId;
    const channel = msg.channel || this.channel.name;
    const rawSender = msg.senderId || msg.rawSenderId || "";

    return {
      config: this.config,
      store: this.store,
      backend: this.backend,
      scheduler: this.scheduler,
      msg,
      chatId,
      senderId,
      cmd,
      args,
      busy,
      version: this.version,
      startedAt: this.startedAt,
      sendReply: (to, text, replyTo) => this.sendReply(to, text, replyTo),
      handleUserPrompt: (m, text, attachments) =>
        this.handleUserPrompt(m, text, attachments),
      isChannelConnected: () => this.channel.isConnected(),
      getChannelStatuses: () => this.getChannelStatuses(),
      resolveAuthSource: () =>
        this.resolveAuthSource(channel, rawSender, senderId),
      resolveNativeAdapter: () => this.resolveNativeAdapter(chatId, channel),
      isAdminSender: () => this.isAdminSender(channel, rawSender, senderId),
      getVerbosity: () => this.getChatVerbosity(chatId),
      setVerbosity: (level) => this.verbosityByChatId.set(chatId, level),
      getToolProgressMode: () => this.getChatToolProgressMode(chatId),
      setToolProgressMode: (mode) =>
        this.toolProgressModeByChatId.set(chatId, mode),
      getToolProgressKeep: () => this.getChatToolProgressKeep(chatId),
      setToolProgressKeep: (keep) =>
        this.toolProgressKeepByChatId.set(chatId, keep),
      shouldUseLiveProgressEdit: () =>
        this.shouldUseLiveProgressEdit(chatId, channel),
      getApprovalMode: () => this.getChatApprovalMode(chatId),
      setApprovalMode: (mode) => this.setChatApprovalMode(chatId, mode),
      getBusyMode: () => this.getChatBusyMode(chatId),
      setBusyMode: (mode) => this.setChatBusyMode(chatId, mode),
      getQueue: () => this.getChatQueue(chatId),
      enqueuePrompt: (prompt) => this.enqueueChatPrompt(chatId, prompt),
      clearQueue: () => this.clearChatQueue(chatId),
      getPendingPermission: () => this.backend.getPendingPermission?.(chatId),
      getHealthSnapshot: () => this.getHealthSnapshot(),
      getLastPrompt: () => this.lastPromptByChatId.get(chatId),
      resolveChannelGroup: () => this.resolveChannelGroup(chatId),
      resolveChannelGroupFor: (id) => this.resolveChannelGroup(id),
      resolveDefaultCwd: () => this.resolveDefaultCwd(chatId),
      ensureSessionRecord: (patch) => this.ensureSessionRecord(chatId, patch),
      bumpSessionGeneration: () => this.bumpSessionGeneration(chatId),
      forgetChatState: () => {
        this.sessionListCache.delete(chatId);
        this.fallbackBusyModes.delete(chatId);
        this.fallbackApprovalModes.delete(chatId);
        this.hydratedChats.delete(chatId);
      },
      markCancelled: () => {
        this.cancelledByUser.add(chatId);
      },
      unmarkCancelled: () => {
        this.cancelledByUser.delete(chatId);
      },
      markStopDrain: () => {
        this.stopDrainChats.add(chatId);
      },
      unmarkStopDrain: () => {
        this.stopDrainChats.delete(chatId);
      },
      getCachedSessionList: () => this.sessionListCache.get(chatId),
      cacheSessionList: (list) => this.cacheSessionList(chatId, list),
      fetchQuota: async () => {
        const summary = await this.quotaFetcher();
        this.cachedQuota = summary;
        return summary;
      },
    };
  }
  private async handleUserPrompt(
    msg: InboundMessage,
    text: string,
    attachments: InboundAttachment[],
  ): Promise<void> {
    const { chatId } = msg;
    if (this.isChatBusy(chatId)) {
      const mode = this.getChatBusyMode(chatId);
      if (mode === "queue") {
        const pos = this.enqueueChatPrompt(chatId, text);
        await this.sendReply(
          chatId,
          `Queued (#${pos}). Use /queue to inspect or /stop to cancel.`,
          msg.id,
        );
        return;
      }
      // interrupt or steer: enqueue before cancelling so the single executeTurn loop drains it cleanly
      if (mode === "steer") {
        this.clearChatQueue(chatId);
      }
      this.enqueueChatPrompt(chatId, text);
      this.stopDrainChats.delete(chatId);
      this.cancelledByUser.add(chatId);
      await this.backend.cancelTurn(chatId);
      return;
    }

    await this.executeTurn(msg, text, attachments);
  }

  private async executeTurn(
    msg: InboundMessage,
    text: string,
    attachments: InboundAttachment[],
    options: { overrideCwd?: string; isLoop?: boolean } = {},
  ): Promise<void> {
    const { chatId } = msg;
    if (!options.isLoop) {
      this.rememberLastPrompt(chatId, text);
    }
    this.activeTurnChats.add(chatId);

    try {
      let currentMsg = msg;
      let currentText = options.isLoop ? text : this.withReplyQuote(msg, text);
      let currentAttachments = attachments;
      let currentOptions = options;

      while (true) {
        const turnGeneration = this.getSessionGeneration(chatId);
        await this.runSingleTurn(
          currentMsg,
          currentText,
          currentAttachments,
          turnGeneration,
          currentOptions,
        );

        if (this.stopDrainChats.delete(chatId)) {
          break;
        }
        const nextPrompt = this.shiftChatQueue(chatId);
        if (!nextPrompt) {
          break;
        }
        currentMsg = {
          ...currentMsg,
          text: nextPrompt,
          attachments: [],
        };
        currentText = nextPrompt;
        currentAttachments = [];
        currentOptions = {};
      }
    } finally {
      this.activeTurnChats.delete(chatId);
    }
  }

  private async runSingleTurn(
    msg: InboundMessage,
    text: string,
    attachments: InboundAttachment[],
    turnGeneration: number,
    options: { overrideCwd?: string; isLoop?: boolean } = {},
  ): Promise<void> {
    const { chatId } = msg;

    if (this.reactionsEnabled(msg.channel) && this.channel.react && !options.isLoop) {
      this.channel.react(chatId, msg.id, "👀").catch(() => {});
    }

    let typingTimer: ReturnType<typeof setInterval> | undefined;
    let progressTimer: ReturnType<typeof setInterval> | undefined;
    let typingActive = false;
    const stopTyping = () => {
      if (typingTimer) {
        clearInterval(typingTimer);
        typingTimer = undefined;
      }
      if (typingActive) {
        typingActive = false;
        this.channel.sendTyping?.(chatId, false).catch(() => {});
      }
    };
    if (this.channel.sendTyping) {
      typingActive = true;
      this.channel.sendTyping(chatId, true).catch(() => {});
      if (this.typingIntervalMs > 0) {
        typingTimer = setInterval(() => {
          void this.channel.sendTyping?.(chatId, true).catch(() => {});
        }, this.typingIntervalMs);
        typingTimer.unref?.();
      }
    }

    const stored = this.store.getSession(chatId);
    const cwd = options.overrideCwd ?? this.resolveDefaultCwd(chatId);
    const approvalMode = this.getChatApprovalMode(chatId);
    const model = stored?.model ?? this.config.defaultModel;
    const effort = stored?.effort ?? this.config.defaultEffort;

    const useLiveProgress =
      !options.isLoop && this.shouldUseLiveProgressEdit(chatId, msg.channel);
    const toolProgressMode = this.getChatToolProgressMode(chatId);
    const liveProgress = useLiveProgress
      ? new LiveProgressTracker({
          chatId,
          modelLabel: model ?? "default",
          channel: this.channel,
          keepOnComplete: this.getChatToolProgressKeep(chatId),
          editIntervalMs: this.config.toolProgressEditIntervalMs ?? 1500,
          verbosity: this.getChatVerbosity(chatId),
          replyToMessageId: msg.id,
        })
      : undefined;

    try {
      // Silence progress & stall watchdog (interactive turns only).
      if (
        !options.isLoop &&
        (this.config.progressSilenceMs > 0 ||
          this.config.sessionStallTimeoutMs > 0)
      ) {
        const verbosity = this.getChatVerbosity(chatId);
        const turnStartedAt = Date.now();
        let lastProgressNotifyAt = turnStartedAt;
        let stallNotified = false;
        progressTimer = setInterval(() => {
          try {
            const now = Date.now();
            const activity = this.backend.getTurnActivity?.(chatId);
            const elapsed = formatUptime(now - turnStartedAt);
            const modelLabel = activity?.model ?? model ?? "default";
            const lastActivityAt = activity?.lastActivityAt ?? turnStartedAt;

            if (
              this.config.sessionStallTimeoutMs > 0 &&
              !stallNotified &&
              now - lastActivityAt >= this.config.sessionStallTimeoutMs
            ) {
              stallNotified = true;
              lastProgressNotifyAt = now;
              const silentFor = formatUptime(now - lastActivityAt);
              void this.sendReply(
                chatId,
                `⚠️ 当前会话已静默 ${silentFor} 无模型/工具活动（模型：${modelLabel}）。发送 /stop 可取消当前任务，或 /new 开启新会话。`,
              ).catch(() => {});
              return;
            }

            // `off`, explicit `off` mode, and live edited cards all suppress pulses,
            // but the stall alert above always fires.
            if (verbosity === "off" || toolProgressMode === "off" || useLiveProgress) {
              return;
            }

            if (
              this.config.progressSilenceMs > 0 &&
              now - lastProgressNotifyAt >= this.config.progressSilenceMs
            ) {
              lastProgressNotifyAt = now;
              let progressText: string;
              if (activity?.phase === "retrying") {
                const reason = activity.lastRetryReason
                  ? `（${activity.lastRetryReason}）`
                  : "";
                progressText = `⏳ [${modelLabel}] 遇到临时异常，正在第 ${activity.retryCount}/${activity.maxRetries} 次重试${reason}，已耗时 ${elapsed}…`;
              } else if (activity?.phase === "tool" && activity.currentTool) {
                const toolTitle = sanitizeToolTitle(activity.currentTool, 48);
                progressText = `⏳ [${modelLabel}] 处理中（已耗时 ${elapsed}）：正在执行工具「${toolTitle}」（已调用 ${activity.toolCount} 次）。发送 /stop 可取消。`;
              } else {
                const toolNote = activity?.toolCount
                  ? `，已调用 ${activity.toolCount} 次工具`
                  : "";
                const retryNote = activity?.retryCount
                  ? `，已重试 ${activity.retryCount} 次`
                  : "";
                progressText = `⏳ [${modelLabel}] 思考/处理中（已耗时 ${elapsed}${toolNote}${retryNote}）。发送 /stop 可取消。`;
              }
              if (verbosity === "full") {
                const detail = [
                  `模型 ${modelLabel}`,
                  activity?.effort ? `effort ${activity.effort}` : "",
                  `阶段 ${activity?.phase ?? "thinking"}`,
                  `工具 ${activity?.toolCount ?? 0} 次`,
                  `重试 ${activity?.retryCount ?? 0}/${activity?.maxRetries ?? 0}`,
                ]
                  .filter(Boolean)
                  .join(" | ");
                progressText += `\n📊 ${detail}`;
              }
              void this.sendReply(chatId, progressText).catch(() => {});
            }
          } catch {
            // Sampling must never break the turn.
          }
        }, this.progressPollIntervalMs);
        progressTimer.unref?.();
      }

      const requesterSenderId = options.isLoop
        ? undefined
        : senderKeyFor(
            msg.channel || this.channel.name,
            msg.senderId || msg.rawSenderId || "",
          ) || undefined;

      const result = await this.backend.sendTurn({
        chatId,
        sessionId: stored?.sessionId || undefined,
        cwd,
        text,
        attachments,
        model,
        effort,
        approvalMode,
        requesterSenderId,
        callbacks: liveProgress
          ? { onToolCall: (event) => liveProgress.onToolCall(event) }
          : undefined,
      });

      const wasResetDuringTurn =
        this.getSessionGeneration(chatId) !== turnGeneration;
      const wasUserCancelled =
        this.cancelledByUser.delete(chatId) ||
        result.stopReason === "cancelled";

      if (wasResetDuringTurn) {
        await liveProgress?.finish("cancelled");
        return;
      }

      const isFirstCompleted =
        !options.isLoop && !stored?.onboarded && !wasUserCancelled;

      await this.ensureSessionRecord(chatId, {
        sessionId: result.sessionId,
        cwd,
        approvalMode,
        busyMode: this.getChatBusyMode(chatId),
        ...(isFirstCompleted ? { onboarded: true } : {}),
      });

      const reactionsOn =
        this.reactionsEnabled(msg.channel) && Boolean(this.channel.react) && !options.isLoop;

      if (wasUserCancelled && !result.text.trim()) {
        await liveProgress?.finish("cancelled");
        if (reactionsOn) {
          this.channel.react!(chatId, msg.id, "🛑").catch(() => {});
        }
        return;
      }

      const { cleanText, mediaPaths } = extractOutboundMedia(result.text, cwd);
      const strippedText = stripIdeFileLinks(cleanText);
      const quotaNotice = await this.maybeGetLowQuotaNotice();
      // Keep media-only replies pristine; the one-shot tip rides on the first text answer.
      const onboardingFooter =
        isFirstCompleted && mediaPaths.length === 0
          ? `💡 已自动建立 [${this.resolveChannelGroup(chatId)}] 分组会话；发 /model 切换模型，发 /help 查看全部指令。`
          : "";
      const combinedText = [strippedText, quotaNotice, onboardingFooter]
        .filter(Boolean)
        .join("\n\n");
      const emptyResult = !combinedText && mediaPaths.length === 0;

      // Stop typing and watchdog before sending the final reply.
      if (progressTimer) {
        clearInterval(progressTimer);
        progressTimer = undefined;
      }
      stopTyping();

      // Finalize the live card first: deletes it cleanly (keep=false) or stamps
      // ✅ (keep=true) BEFORE the final answer lands beneath it.
      await liveProgress?.finish(wasUserCancelled ? "cancelled" : "completed");

      if (!emptyResult) {
        await this.sendReply(
          chatId,
          combinedText,
          options.isLoop ? undefined : msg.id,
          mediaPaths,
        );
      }

      if (reactionsOn) {
        // A user-cancelled or empty turn is a deliberate stop, not a successful reply.
        this.channel.react!(
          chatId,
          msg.id,
          wasUserCancelled || emptyResult ? "🛑" : "👍",
        ).catch(() => {});
      }
    } catch (err) {
      const wasResetDuringTurn =
        this.getSessionGeneration(chatId) !== turnGeneration;
      const wasUserCancelled =
        this.cancelledByUser.delete(chatId) && isCancellationError(err);

      if (wasResetDuringTurn || wasUserCancelled) {
        await liveProgress?.finish("cancelled");
      }

      if (!wasResetDuringTurn && !wasUserCancelled) {
        const message = err instanceof Error ? err.message : String(err);
        await liveProgress?.finish("failed", message);
        this.lastError = message;
        if (this.reactionsEnabled(msg.channel) && this.channel.react && !options.isLoop) {
          this.channel.react(chatId, msg.id, "👎").catch(() => {});
        }
        await this.sendReply(
          chatId,
          `Error: ${message.slice(0, 600)}`,
          options.isLoop ? undefined : msg.id,
        ).catch(() => {});
      }
    } finally {
      if (progressTimer) {
        clearInterval(progressTimer);
        progressTimer = undefined;
      }
      stopTyping();
    }
  }

  private async maybeGetLowQuotaNotice(): Promise<string> {
    if (this.config.quotaWarnThreshold <= 0) {
      return "";
    }
    const now = Date.now();
    if (
      !this.cachedQuota ||
      now - this.cachedQuota.fetchedAt > QUOTA_CHECK_INTERVAL_MS
    ) {
      try {
        this.cachedQuota = await this.quotaFetcher();
      } catch {
        return "";
      }
    }
    const q = this.cachedQuota;
    if (
      q.available &&
      typeof q.fiveHourRemainingPercent === "number" &&
      q.fiveHourRemainingPercent <= this.config.quotaWarnThreshold
    ) {
      return `[Notice: 5h Antigravity quota at ${Math.round(q.fiveHourRemainingPercent)}% remaining]`;
    }
    return "";
  }

  private async sendReply(
    chatId: string,
    text: string,
    replyToMessageId?: string,
    mediaPaths: string[] = [],
  ): Promise<void> {
    await this.channel.sendMessage({
      chatId,
      text: text || undefined,
      markdown: true,
      replyToMessageId,
      attachments:
        mediaPaths.length > 0
          ? mediaPaths.map((p) => ({ path: p }))
          : undefined,
    });
    this.lastOutboundAt = Date.now();
  }
}
