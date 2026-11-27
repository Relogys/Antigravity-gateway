import fs from "node:fs";
import path from "node:path";
import { fetchAgyQuota, formatQuotaSummary } from "../acp/quota.js";
import { splitQualifiedChatId } from "../channels/hub.js";
import {
  getChannelAllowedUsers,
  isPhotonChannel,
  normalizeUserId,
  senderKeyFor,
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
  PendingPermission,
  QuotaSummary,
  SessionInfo,
} from "../types.js";
import {
  LoopScheduler,
  formatDurationMs,
  parseDurationMs,
} from "./scheduler.js";
import type { GatewayStore } from "./store.js";

const DEFAULT_TYPING_INTERVAL_MS = 5000;
const QUOTA_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const GATEWAY_VERSION = "0.1.0";
const MAX_SESSION_LIST_CACHE = 500;

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
  ): Promise<{ model: string; effort?: string }>;
  setEffort?(chatId: string, effort: string): Promise<void>;
  getAvailableModels?(): string[];
  getAvailableEfforts?(): string[];
  getAvailableModes?(): string[];
  setApprovalMode?(chatId: string, mode: ApprovalMode): void;
  getApprovalMode?(chatId: string): ApprovalMode;
  getPendingPermission?(chatId: string): PendingPermission | undefined;
  resolvePermission?(
    chatId: string,
    decision: "once" | "session" | "always" | "deny",
  ): boolean;
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
}

export interface GatewayRouterDeps {
  config: GatewayConfig;
  channel: ExtendedChannelAdapter;
  backend: ExtendedAgentBackend;
  store: GatewayStore;
  scheduler: LoopScheduler;
  quotaFetcher?: () => Promise<QuotaSummary>;
  version?: string;
  /** Typing refresh cadence during long ACP turns (default 5000ms; 0 disables). */
  typingIntervalMs?: number;
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
  "help",
  "commands",
  "version",
  "v",
]);

const HELP_TEXT = [
  "Antigravity Gateway Commands:",
  "Always available (even while busy):",
  "• /stop — Cancel active turn",
  "• /new (/reset) — Start a fresh session",
  "• /status — Show session, model, busy & queue state",
  "• /usage — Check Antigravity quota (0 tokens)",
  "• /queue (/q) [prompt|list|clear] — Manage prompt queue",
  "• /steer (/s) <prompt> — Interrupt & redirect active turn",
  "• /busy [queue|interrupt|steer] — Set busy-turn policy",
  "• /approve [once|session|always] | /deny — Resolve tool permission",
  "• /yolo — Toggle auto-approval mode",
  "• /channels — Show active channels & connection state",
  "• /whoami | /version | /help",
  "",
  "Session & Config (when idle):",
  "• /model [slug] — View or switch model",
  "• /effort [low|medium|high|xhigh] — Set reasoning effort",
  "• /mode [default|accept-edits|auto|plan] — Set ACP mode",
  "• /approvals [auto|interactive|sandbox] — Set permission mode",
  "• /sessions | /resume [id|index] — List or resume sessions",
  "• /title [name] — View or rename session",
  "• /compact (/compress) — Summarize & compact context",
  "• /cwd [path] — View or change working directory",
  "• /discard — Discard session & queue",
  "• /loop [list|add <dur> <prompt>|rm <id>|pause <id>|resume <id>]",
  "• /remind <dur> <text> — One-way reminder push",
].join("\n");

function formatUptime(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

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

  /**
   * Called by AgyAgentBackend's permissionNotifier to alert the user in iMessage.
   */
  async notifyPermission(
    chatId: string,
    perm: PendingPermission,
  ): Promise<void> {
    const lines = [
      `⚠️ Permission requested: ${perm.title}${perm.kind ? ` (${perm.kind})` : ""}`,
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
        await this.handleSlashCommand(msg, senderId, cmd, args);
        return;
      }

      if (!bodyText && msg.attachments.length === 0) {
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
    const existing = this.store.getSession(job.chatId);
    const cwd = job.cwd ?? existing?.cwd ?? this.config.defaultCwd;
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

  private readReceiptsEnabled(channel: string): boolean {
    return isPhotonChannel(channel) ? (this.config.photon?.readReceipts ?? true) : true;
  }

  private reactionsEnabled(channel: string): boolean {
    return isPhotonChannel(channel) ? (this.config.photon?.reactions ?? true) : true;
  }

  private formatChannelsReport(currentChannel: string): string {
    const entries = Object.values(this.getChannelStatuses());
    if (entries.length === 0) {
      return "No channels registered.";
    }
    const now = Date.now();
    const ago = (ts?: number) => (ts ? `${formatUptime(now - ts)} ago` : "never");
    const lines = entries.map((c) => {
      const parts = [
        `${c.connected ? "✅" : "❌"} ${c.name}${c.name === currentChannel ? " (this chat)" : ""} — ${c.connected ? "connected" : "disconnected"}`,
        `in ${ago(c.lastInboundAt)}`,
        `out ${ago(c.lastOutboundAt)}`,
      ];
      if (c.lastError && !c.connected) {
        parts.push(`error: ${c.lastError.slice(0, 100)}`);
      }
      return `• ${parts.join(" | ")}`;
    });
    return `Channels (${entries.length}):\n${lines.join("\n")}`;
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

  private async ensureSessionRecord(
    chatId: string,
    patch: Partial<SessionInfo> = {},
  ): Promise<SessionInfo> {
    const existing = this.store.getSession(chatId);
    const now = Date.now();
    const merged: SessionInfo = {
      chatId,
      sessionId: existing?.sessionId ?? "",
      cwd: existing?.cwd ?? this.config.defaultCwd,
      model: existing?.model ?? this.config.defaultModel,
      effort: existing?.effort ?? this.config.defaultEffort,
      mode: existing?.mode,
      approvalMode: existing?.approvalMode ?? this.getChatApprovalMode(chatId),
      busyMode: existing?.busyMode ?? this.getChatBusyMode(chatId),
      title: existing?.title,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...patch,
    };
    await this.store.upsertSession(merged);
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

    switch (cmd) {
      case "help":
      case "commands":
        await this.sendReply(chatId, HELP_TEXT, msg.id);
        return;

      case "channels":
        await this.sendReply(chatId, this.formatChannelsReport(msg.channel), msg.id);
        return;

      case "version":
      case "v":
        await this.sendReply(
          chatId,
          `antigravity-gateway v${this.version} | Node ${process.version}`,
          msg.id,
        );
        return;

      case "whoami": {
        const source =
          this.resolveAuthSource(msg.channel, msg.senderId || msg.rawSenderId || "", senderId) ??
          "unknown";
        await this.sendReply(
          chatId,
          [
            `Sender: ${senderId}`,
            `Channel: ${msg.channel}`,
            `Chat: ${chatId} (${msg.isGroup ? "group" : "dm"})`,
            `Service: ${msg.service ?? "unknown"}`,
            `Auth: ${source}`,
          ].join("\n"),
          msg.id,
        );
        return;
      }

      case "stop":
      case "cancel": {
        this.cancelledByUser.add(chatId);
        this.stopDrainChats.add(chatId);
        const stopped = await this.backend.cancelTurn(chatId);
        if (!stopped) {
          this.cancelledByUser.delete(chatId);
          this.stopDrainChats.delete(chatId);
        }
        await this.sendReply(
          chatId,
          stopped ? "⏹️ Stopped active turn." : "No active turn is running.",
          msg.id,
        );
        return;
      }

      case "new":
      case "reset": {
        this.bumpSessionGeneration(chatId);
        this.clearChatQueue(chatId);
        this.stopDrainChats.delete(chatId);
        if (busy) {
          this.cancelledByUser.add(chatId);
          await this.backend.cancelTurn(chatId);
        }
        const prev = this.store.getSession(chatId);
        await this.backend.resetSession(chatId);
        await this.store.deleteSession(chatId);
        if (prev && prev.cwd !== this.config.defaultCwd) {
          await this.ensureSessionRecord(chatId, {
            sessionId: "",
            cwd: prev.cwd,
            model: prev.model,
            effort: prev.effort,
            mode: prev.mode,
            approvalMode: prev.approvalMode,
            busyMode: prev.busyMode,
            title: undefined,
          });
        }
        await this.sendReply(chatId, "🆕 Started a fresh session.", msg.id);
        return;
      }

      case "discard": {
        this.bumpSessionGeneration(chatId);
        this.clearChatQueue(chatId);
        this.stopDrainChats.delete(chatId);
        this.sessionListCache.delete(chatId);
        this.fallbackBusyModes.delete(chatId);
        this.fallbackApprovalModes.delete(chatId);
        this.hydratedChats.delete(chatId);
        if (busy) {
          this.cancelledByUser.add(chatId);
          await this.backend.cancelTurn(chatId);
        }
        await this.backend.resetSession(chatId);
        await this.store.deleteSession(chatId);
        await this.sendReply(chatId, "🗑️ Discarded session and queue.", msg.id);
        return;
      }

      case "status": {
        const stored = this.store.getSession(chatId);
        const live = this.backend.getSessionInfo?.(chatId);
        const sessionId = live?.sessionId || stored?.sessionId || "(none)";
        const model = live?.model || stored?.model || this.config.defaultModel || "default";
        const effort = live?.effort || stored?.effort || this.config.defaultEffort || "default";
        const mode = live?.mode || stored?.mode || "default";
        const cwd = live?.cwd || stored?.cwd || this.config.defaultCwd;
        const queueLen = this.getChatQueue(chatId).length;
        const pendingPerm = this.backend.getPendingPermission?.(chatId);
        const snap = this.getHealthSnapshot();
        await this.sendReply(
          chatId,
          [
            `Status: ${snap.status} (uptime ${formatUptime(snap.uptimeMs)})`,
            `Turn: ${busy ? "busy" : "idle"} | Queue: ${queueLen}`,
            `Session: ${sessionId === "(none)" ? "(none)" : sessionId.slice(0, 12)}`,
            stored?.title ? `Title: ${stored.title}` : undefined,
            `Model: ${model} | Effort: ${effort} | Mode: ${mode}`,
            `Approvals: ${this.getChatApprovalMode(chatId)} | Busy policy: ${this.getChatBusyMode(chatId)}`,
            `CWD: ${cwd}`,
            `Active loops: ${snap.activeLoops}${pendingPerm ? ` | Pending approval: ${pendingPerm.title}` : ""}`,
          ]
            .filter(Boolean)
            .join("\n"),
          msg.id,
        );
        return;
      }

      case "usage": {
        const summary = await this.quotaFetcher();
        this.cachedQuota = summary;
        await this.sendReply(chatId, formatQuotaSummary(summary), msg.id);
        return;
      }

      case "queue":
      case "q": {
        if (!args || args.toLowerCase() === "list") {
          const q = this.getChatQueue(chatId);
          if (q.length === 0) {
            await this.sendReply(chatId, "Queue is empty.", msg.id);
          } else {
            const lines = q.map((item, idx) => `${idx + 1}. ${item.slice(0, 120)}`);
            await this.sendReply(chatId, `Queued prompts (${q.length}):\n${lines.join("\n")}`, msg.id);
          }
          return;
        }
        if (args.toLowerCase() === "clear") {
          const cleared = this.clearChatQueue(chatId);
          await this.sendReply(chatId, `Cleared ${cleared} queued prompt(s).`, msg.id);
          return;
        }
        if (busy) {
          const pos = this.enqueueChatPrompt(chatId, args);
          await this.sendReply(chatId, `Queued at #${pos}.`, msg.id);
        } else {
          await this.handleUserPrompt(msg, args, []);
        }
        return;
      }

      case "steer":
      case "s": {
        if (!args) {
          await this.sendReply(chatId, "Usage: /steer <prompt>", msg.id);
          return;
        }
        if (!busy) {
          await this.handleUserPrompt(msg, args, []);
          return;
        }
        this.clearChatQueue(chatId);
        this.enqueueChatPrompt(chatId, args);
        this.cancelledByUser.add(chatId);
        await this.backend.cancelTurn(chatId);
        await this.sendReply(chatId, "↪️ Redirecting active turn...", msg.id);
        return;
      }

      case "busy": {
        if (!args) {
          await this.sendReply(
            chatId,
            `Current busy mode: ${this.getChatBusyMode(chatId)} (options: queue, interrupt, steer)`,
            msg.id,
          );
          return;
        }
        const next = args.toLowerCase();
        if (next !== "queue" && next !== "interrupt" && next !== "steer") {
          await this.sendReply(
            chatId,
            "Invalid busy mode. Use: /busy [queue|interrupt|steer]",
            msg.id,
          );
          return;
        }
        await this.setChatBusyMode(chatId, next);
        await this.sendReply(chatId, `Busy mode set to: ${next}`, msg.id);
        return;
      }

      case "approve": {
        const arg = (args || "once").toLowerCase();
        if (arg !== "once" && arg !== "session" && arg !== "always") {
          await this.sendReply(
            chatId,
            "Usage: /approve [once|session|always]",
            msg.id,
          );
          return;
        }
        const resolved = this.backend.resolvePermission?.(chatId, arg) ?? false;
        await this.sendReply(
          chatId,
          resolved ? `✅ Approved (${arg}).` : "No pending permission request.",
          msg.id,
        );
        return;
      }

      case "deny": {
        const resolved = this.backend.resolvePermission?.(chatId, "deny") ?? false;
        await this.sendReply(
          chatId,
          resolved
            ? `❌ Denied${args ? `: ${args}` : "."}`
            : "No pending permission request.",
          msg.id,
        );
        return;
      }

      case "yolo": {
        const current = this.getChatApprovalMode(chatId);
        const next: ApprovalMode = current === "auto" ? "interactive" : "auto";
        await this.setChatApprovalMode(chatId, next);
        await this.sendReply(
          chatId,
          next === "auto"
            ? "⚡ Approval mode set to auto (YOLO enabled for this chat)."
            : "🛡️ Approval mode restored to interactive.",
          msg.id,
        );
        return;
      }

      case "model": {
        const current =
          this.backend.getSessionInfo?.(chatId)?.model ??
          this.store.getSession(chatId)?.model ??
          this.config.defaultModel ??
          "(server default)";
        if (!args) {
          const available = this.backend.getAvailableModels?.() ?? [];
          const listText =
            available.length > 0
              ? `\nAvailable: ${available.slice(0, 15).join(", ")}${available.length > 15 ? ` (+${available.length - 15} more)` : ""}`
              : "";
          await this.sendReply(chatId, `Current model: ${current}${listText}`, msg.id);
          return;
        }
        if (this.backend.setModel) {
          const updated = await this.backend.setModel(chatId, args);
          await this.ensureSessionRecord(chatId, {
            model: updated.model,
            ...(updated.effort ? { effort: updated.effort } : {}),
          });
          await this.sendReply(
            chatId,
            `Model set to: ${updated.model}${updated.effort ? ` (effort: ${updated.effort})` : ""}`,
            msg.id,
          );
        } else if (this.backend.setConfigOption) {
          await this.backend.setConfigOption(chatId, "model", args);
          await this.ensureSessionRecord(chatId, { model: args });
          await this.sendReply(chatId, `Model set to: ${args}`, msg.id);
        } else {
          await this.ensureSessionRecord(chatId, { model: args });
          await this.sendReply(chatId, `Model set to: ${args}`, msg.id);
        }
        return;
      }

      case "effort": {
        const current =
          this.backend.getSessionInfo?.(chatId)?.effort ??
          this.store.getSession(chatId)?.effort ??
          this.config.defaultEffort ??
          "(default)";
        if (!args) {
          const available = this.backend.getAvailableEfforts?.() ?? [
            "low",
            "medium",
            "high",
            "xhigh",
          ];
          await this.sendReply(
            chatId,
            `Current effort: ${current}\nAvailable: ${available.join(", ")}`,
            msg.id,
          );
          return;
        }
        const level = args.toLowerCase();
        if (!["low", "medium", "high", "xhigh"].includes(level)) {
          await this.sendReply(
            chatId,
            "Invalid effort. Use: /effort [low|medium|high|xhigh]",
            msg.id,
          );
          return;
        }
        if (this.backend.setEffort) {
          await this.backend.setEffort(chatId, level);
        } else if (this.backend.setConfigOption) {
          await this.backend.setConfigOption(chatId, "thought_level", level);
        }
        await this.ensureSessionRecord(chatId, { effort: level });
        await this.sendReply(chatId, `Effort set to: ${level}`, msg.id);
        return;
      }

      case "mode": {
        const current =
          this.backend.getSessionInfo?.(chatId)?.mode ??
          this.store.getSession(chatId)?.mode ??
          "default";
        if (!args) {
          const available = this.backend.getAvailableModes?.() ?? [
            "default",
            "accept-edits",
            "auto",
            "plan",
          ];
          await this.sendReply(
            chatId,
            `Current mode: ${current}\nAvailable: ${available.join(", ")}`,
            msg.id,
          );
          return;
        }
        const nextMode = args.toLowerCase();
        if (!["default", "accept-edits", "auto", "plan"].includes(nextMode)) {
          await this.sendReply(
            chatId,
            "Invalid mode. Use: /mode [default|accept-edits|auto|plan]",
            msg.id,
          );
          return;
        }
        if (this.backend.setMode) {
          await this.backend.setMode(chatId, nextMode);
        } else if (this.backend.setConfigOption) {
          await this.backend.setConfigOption(chatId, "mode", nextMode);
        }
        await this.ensureSessionRecord(chatId, { mode: nextMode });
        await this.sendReply(chatId, `Mode set to: ${nextMode}`, msg.id);
        return;
      }

      case "approvals": {
        if (!args) {
          await this.sendReply(
            chatId,
            `Current approval mode: ${this.getChatApprovalMode(chatId)} (options: auto, interactive, sandbox)`,
            msg.id,
          );
          return;
        }
        const next = args.toLowerCase();
        if (next !== "auto" && next !== "interactive" && next !== "sandbox") {
          await this.sendReply(
            chatId,
            "Invalid approval mode. Use: /approvals [auto|interactive|sandbox]",
            msg.id,
          );
          return;
        }
        await this.setChatApprovalMode(chatId, next);
        await this.sendReply(chatId, `Approval mode set to: ${next}`, msg.id);
        return;
      }

      case "sessions": {
        const cwd = this.store.getSession(chatId)?.cwd ?? this.config.defaultCwd;
        const list = await this.backend.listSessions(cwd);
        const sliced = list.slice(0, 10);
        this.cacheSessionList(chatId, sliced);
        if (sliced.length === 0) {
          await this.sendReply(chatId, "No saved sessions found.", msg.id);
          return;
        }
        const lines = sliced.map((s, idx) => {
          const shortId = s.sessionId.slice(0, 10);
          const label = s.title ? ` — ${s.title}` : "";
          return `${idx + 1}. ${shortId}${label}`;
        });
        await this.sendReply(
          chatId,
          `Sessions (use /resume <index|id>):\n${lines.join("\n")}`,
          msg.id,
        );
        return;
      }

      case "resume": {
        if (!args) {
          await this.sendReply(chatId, "Usage: /resume <id|index>", msg.id);
          return;
        }
        const cwd = this.store.getSession(chatId)?.cwd ?? this.config.defaultCwd;
        let targetId = args;
        let targetCwd = cwd;
        let targetTitle: string | undefined;

        if (/^\d+$/.test(args)) {
          let cached = this.sessionListCache.get(chatId);
          if (!cached) {
            cached = (await this.backend.listSessions(cwd)).slice(0, 10);
            this.cacheSessionList(chatId, cached);
          }
          const idx = Number.parseInt(args, 10) - 1;
          const picked = cached[idx];
          if (!picked) {
            await this.sendReply(chatId, `Session index ${args} not found.`, msg.id);
            return;
          }
          targetId = picked.sessionId;
          targetCwd = picked.cwd || cwd;
          targetTitle = picked.title;
        }

        if (this.backend.attachSession) {
          await this.backend.attachSession(chatId, targetId, targetCwd);
        }
        await this.ensureSessionRecord(chatId, {
          sessionId: targetId,
          cwd: targetCwd,
          ...(targetTitle ? { title: targetTitle } : {}),
        });
        await this.sendReply(
          chatId,
          `Resumed session ${targetId.slice(0, 12)}.`,
          msg.id,
        );
        return;
      }

      case "title": {
        const stored = this.store.getSession(chatId);
        if (!args) {
          await this.sendReply(
            chatId,
            stored?.title ? `Session title: ${stored.title}` : "No session title set.",
            msg.id,
          );
          return;
        }
        await this.ensureSessionRecord(chatId, { title: args });
        await this.sendReply(chatId, `Session title updated: ${args}`, msg.id);
        return;
      }

      case "compact":
      case "compress": {
        const stored = this.store.getSession(chatId);
        if (!stored?.sessionId) {
          await this.sendReply(chatId, "No active session to compact.", msg.id);
          return;
        }
        await this.handleUserPrompt(
          msg,
          "Concisely summarize our conversation, key decisions, and open tasks so far so context remains compact.",
          [],
        );
        return;
      }

      case "cwd": {
        const currentCwd =
          this.store.getSession(chatId)?.cwd ?? this.config.defaultCwd;
        if (!args) {
          await this.sendReply(chatId, `Current working directory: ${currentCwd}`, msg.id);
          return;
        }
        const resolved = path.resolve(currentCwd, args);
        try {
          const stat = fs.statSync(resolved);
          if (!stat.isDirectory()) {
            await this.sendReply(chatId, `Not a directory: ${resolved}`, msg.id);
            return;
          }
        } catch {
          await this.sendReply(chatId, `Directory does not exist: ${resolved}`, msg.id);
          return;
        }
        this.bumpSessionGeneration(chatId);
        await this.ensureSessionRecord(chatId, { cwd: resolved, sessionId: "" });
        await this.backend.resetSession(chatId);
        await this.sendReply(
          chatId,
          `Working directory set to: ${resolved} (new session will start here).`,
          msg.id,
        );
        return;
      }

      case "loop": {
        await this.handleLoopCommand(msg, args);
        return;
      }

      case "remind": {
        const m = /^(\S+)\s+([\s\S]+)$/.exec(args);
        if (!m) {
          await this.sendReply(chatId, "Usage: /remind <duration> <text>", msg.id);
          return;
        }
        const durationMs = parseDurationMs(m[1]);
        const text = m[2].trim();
        if (!durationMs || !text) {
          await this.sendReply(
            chatId,
            "Invalid duration. Examples: 30s, 15m, 2h, 1d.",
            msg.id,
          );
          return;
        }
        const job = await this.scheduler.addReminder(chatId, durationMs, text);
        await this.sendReply(
          chatId,
          `⏰ Reminder [${job.id}] scheduled in ${formatDurationMs(durationMs)}.`,
          msg.id,
        );
        return;
      }

      default:
        await this.sendReply(
          chatId,
          `Unknown command: /${cmd}. Send /help for available commands.`,
          msg.id,
        );
    }
  }

  private async handleLoopCommand(
    msg: InboundMessage,
    args: string,
  ): Promise<void> {
    const { chatId } = msg;
    if (!args || args.toLowerCase() === "list") {
      const jobs = this.scheduler.listJobs(chatId);
      if (jobs.length === 0) {
        await this.sendReply(chatId, "No scheduled loops for this chat.", msg.id);
        return;
      }
      const lines = jobs.map((job) => {
        const sched = job.intervalMs
          ? `every ${formatDurationMs(job.intervalMs)}`
          : job.cron
            ? `cron ${job.cron}`
            : "scheduled";
        const state = job.enabled ? "active" : "paused";
        const kindTag = job.kind === "remind" ? "[remind]" : "[loop]";
        return `• ${job.id} ${kindTag} (${state}, ${sched}): ${job.prompt.slice(0, 80)}`;
      });
      await this.sendReply(chatId, `Loops:\n${lines.join("\n")}`, msg.id);
      return;
    }

    const parts = args.split(/\s+/);
    const sub = parts[0].toLowerCase();

    if (sub === "add" || sub === "every") {
      const m = /^(?:add|every)\s+(\S+)\s+([\s\S]+)$/i.exec(args);
      if (!m) {
        await this.sendReply(
          chatId,
          "Usage: /loop add <duration> <prompt>",
          msg.id,
        );
        return;
      }
      const intervalMs = parseDurationMs(m[1]);
      const prompt = m[2].trim();
      if (!intervalMs || !prompt) {
        await this.sendReply(
          chatId,
          "Invalid duration or empty prompt. Examples: 30m, 2h, 1d.",
          msg.id,
        );
        return;
      }
      const cwd = this.store.getSession(chatId)?.cwd ?? this.config.defaultCwd;
      const job = await this.scheduler.addLoop({
        chatId,
        prompt,
        intervalMs,
        cwd,
      });
      await this.sendReply(
        chatId,
        `🔁 Loop [${job.id}] added: every ${formatDurationMs(intervalMs)}.`,
        msg.id,
      );
      return;
    }

    if (sub === "rm" || sub === "del" || sub === "delete" || sub === "remove") {
      const id = parts[1];
      if (!id) {
        await this.sendReply(chatId, "Usage: /loop rm <id>", msg.id);
        return;
      }
      const owned = this.scheduler.listJobs(chatId).some((j) => j.id === id);
      const removed = owned ? await this.scheduler.removeLoop(id) : false;
      await this.sendReply(
        chatId,
        removed ? `Removed loop [${id}].` : `Loop [${id}] not found.`,
        msg.id,
      );
      return;
    }

    if (sub === "pause" || sub === "resume") {
      const id = parts[1];
      if (!id) {
        await this.sendReply(chatId, `Usage: /loop ${sub} <id>`, msg.id);
        return;
      }
      const enabled = sub === "resume";
      const owned = this.scheduler.listJobs(chatId).some((j) => j.id === id);
      const updated = owned ? await this.scheduler.toggleLoop(id, enabled) : null;
      await this.sendReply(
        chatId,
        updated
          ? `${enabled ? "Resumed" : "Paused"} loop [${id}].`
          : `Loop [${id}] not found.`,
        msg.id,
      );
      return;
    }

    await this.sendReply(
      chatId,
      "Usage: /loop [list|add <dur> <prompt>|rm <id>|pause <id>|resume <id>]",
      msg.id,
    );
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
    this.activeTurnChats.add(chatId);

    try {
      let currentMsg = msg;
      let currentText = text;
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
    if (this.channel.sendTyping) {
      this.channel.sendTyping(chatId, true).catch(() => {});
      if (this.typingIntervalMs > 0) {
        typingTimer = setInterval(() => {
          void this.channel.sendTyping?.(chatId, true).catch(() => {});
        }, this.typingIntervalMs);
        typingTimer.unref?.();
      }
    }

    const stored = this.store.getSession(chatId);
    const cwd = options.overrideCwd ?? stored?.cwd ?? this.config.defaultCwd;
    const approvalMode = this.getChatApprovalMode(chatId);
    const model = stored?.model ?? this.config.defaultModel;
    const effort = stored?.effort ?? this.config.defaultEffort;

    try {
      const result = await this.backend.sendTurn({
        chatId,
        sessionId: stored?.sessionId || undefined,
        cwd,
        text,
        attachments,
        model,
        effort,
        approvalMode,
      });

      const wasResetDuringTurn =
        this.getSessionGeneration(chatId) !== turnGeneration;
      const wasUserCancelled =
        this.cancelledByUser.delete(chatId) ||
        result.stopReason === "cancelled";

      if (wasResetDuringTurn) {
        return;
      }

      await this.ensureSessionRecord(chatId, {
        sessionId: result.sessionId,
        cwd,
        approvalMode,
        busyMode: this.getChatBusyMode(chatId),
      });

      if (wasUserCancelled && !result.text.trim()) {
        return;
      }

      const { cleanText, mediaPaths } = extractOutboundMedia(result.text, cwd);
      const quotaNotice = await this.maybeGetLowQuotaNotice();
      const combinedText = [cleanText, quotaNotice].filter(Boolean).join("\n\n");

      if (combinedText || mediaPaths.length > 0) {
        await this.sendReply(
          chatId,
          combinedText,
          options.isLoop ? undefined : msg.id,
          mediaPaths,
        );
      }

      if (this.reactionsEnabled(msg.channel) && this.channel.react && !options.isLoop) {
        this.channel.react(chatId, msg.id, "👍").catch(() => {});
      }
    } catch (err) {
      const wasResetDuringTurn =
        this.getSessionGeneration(chatId) !== turnGeneration;
      const wasUserCancelled =
        this.cancelledByUser.delete(chatId) && isCancellationError(err);

      if (!wasResetDuringTurn && !wasUserCancelled) {
        const message = err instanceof Error ? err.message : String(err);
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
      if (typingTimer) {
        clearInterval(typingTimer);
      }
      this.channel.sendTyping?.(chatId, false).catch(() => {});
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
