import type { GatewayConfig } from "../../config.js";
import type {
  AcpSessionSummary,
  ApprovalMode,
  BusyMode,
  ChannelHealthStatus,
  HealthSnapshot,
  InboundAttachment,
  InboundMessage,
  PendingPermission,
  QuotaSummary,
  SessionInfo,
  ToolProgressMode,
} from "../../types.js";
import type { ExtendedAgentBackend } from "../router.js";
import type { LoopScheduler } from "../scheduler.js";
import type { GatewayStore } from "../store.js";

export type VerbosityLevel = "off" | "brief" | "full";

/**
 * Typed view of the router state a slash command needs. The router builds one
 * per command so extracted modules never reach into private fields directly.
 */
export interface RouterCommandContext {
  readonly config: GatewayConfig;
  readonly store: GatewayStore;
  readonly backend: ExtendedAgentBackend;
  readonly scheduler: LoopScheduler;
  readonly msg: InboundMessage;
  readonly chatId: string;
  readonly senderId: string;
  readonly cmd: string;
  readonly args: string;
  readonly busy: boolean;
  readonly version: string;
  readonly startedAt: number;

  sendReply(
    chatId: string,
    text: string,
    replyToMessageId?: string,
  ): Promise<void>;
  handleUserPrompt(
    msg: InboundMessage,
    text: string,
    attachments: InboundAttachment[],
  ): Promise<void>;

  isChannelConnected(): boolean;
  getChannelStatuses(): Record<string, ChannelHealthStatus>;
  resolveAuthSource(): string | undefined;
  resolveNativeAdapter(): { adapter: unknown; rawChatId: string };
  isAdminSender(): boolean;

  getVerbosity(): VerbosityLevel;
  setVerbosity(level: VerbosityLevel): void;
  getToolProgressMode(): ToolProgressMode;
  setToolProgressMode(mode: ToolProgressMode): void;
  getToolProgressKeep(): boolean;
  setToolProgressKeep(keep: boolean): void;
  shouldUseLiveProgressEdit(): boolean;

  getApprovalMode(): ApprovalMode;
  setApprovalMode(mode: ApprovalMode): Promise<void>;
  getBusyMode(): BusyMode;
  setBusyMode(mode: BusyMode): Promise<void>;
  getQueue(): string[];
  enqueuePrompt(prompt: string): number;
  clearQueue(): number;
  getPendingPermission(): PendingPermission | undefined;
  getHealthSnapshot(): HealthSnapshot;

  getLastPrompt(): string | undefined;
  resolveChannelGroup(): string;
  resolveChannelGroupFor(chatId: string): string;
  resolveDefaultCwd(): string;
  ensureSessionRecord(patch?: Partial<SessionInfo>): Promise<SessionInfo>;
  bumpSessionGeneration(): number;
  forgetChatState(): void;
  markCancelled(): void;
  unmarkCancelled(): void;
  markStopDrain(): void;
  unmarkStopDrain(): void;

  getCachedSessionList(): AcpSessionSummary[] | undefined;
  cacheSessionList(list: AcpSessionSummary[]): void;

  /** Fetches quota and records it for the low-quota notice footer. */
  fetchQuota(): Promise<QuotaSummary>;
}

export const HELP_TEXT = [
  "Antigravity Gateway Commands:",
  "Always available (even while busy):",
  "• /stop — Cancel active turn",
  "• /new [title] (/reset) — Start a fresh session (optionally titled)",
  "• /status — Show session, model, busy & queue state",
  "• /ping — Health check (uptime & connection state)",
  "• /usage — Check Antigravity quota (0 tokens)",
  "• /queue (/q) [prompt|list|clear] — Manage prompt queue",
  "• /steer (/s) <prompt> — Interrupt & redirect active turn",
  "• /busy [queue|interrupt|steer] — Set busy-turn policy",
  "• /approve [once|session|always] | /deny — Resolve tool permission",
  "• /yolo — Toggle auto-approval mode",
  "• /verbose [off|brief|full] — Progress-pulse verbosity",
  "• /progress [auto|edit|silence|off|keep|delete] — Live tool-call progress & cleanup policy",
  "• /sethome — Set this chat as the recovery home",
  "• /channels — Show active channels & connection state",
  "• /whoami | /version | /help",
  "",
  "Session & Config (when idle):",
  "• /retry — Re-run the last prompt in this chat",
  "• /model [slug] — View or switch model",
  "• /effort [low|medium|high|xhigh] — Set reasoning effort",
  "• /mode [default|accept-edits|auto|plan] — Set ACP mode",
  "• /approvals [auto|interactive|sandbox] — Set permission mode",
  "• /sessions [channel|all] — List sessions (defaults to this channel group)",
  "• /groups — Summarize every IM channel session group",
  "• /resume [id|index] — Resume a saved session",
  "• /title [name] — View or rename session",
  "• /compact (/compress) — Summarize & compact context",
  "• /cwd [path|@alias|save|rm|list] — Switch or bookmark working directories",
  "• /discard — Discard session & queue",
  "• /loop [list|add <dur>|daily <HH:MM>|cron <expr>|rm|pause|resume]",
  "• /remind <dur> <text> — One-way reminder push",
  "",
  "Photon iMessage native:",
  "• /poll <q> | <opt1> | <opt2> — Create native iMessage poll",
  "• /bg [preset|clear|list] — Set or clear chat background (24 presets)",
  "• /unsend — Retract bot's last iMessage (~2m window)",
  "• /card — Share native bot contact card",
].join("\n");

export function formatUptime(ms: number): string {
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

/** True for `-h`, `--h`, `--help`, `help`, `?` (case-insensitive). */
export function isHelpFlag(s: string): boolean {
  return /^(?:-h|--h|--help|help|\?)$/i.test(s.trim());
}

/** True for `list` / `ls` (case-insensitive). */
export function isListFlag(s: string): boolean {
  return /^(?:list|ls)$/i.test(s.trim());
}

export function formatChannelsReport(
  entries: ChannelHealthStatus[],
  currentChannel: string,
): string {
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
    if (c.lastHeartbeatAt !== undefined) {
      const streamTag = c.heartbeatStream ? ` [${c.heartbeatStream}]` : "";
      parts.push(`hb ${ago(c.lastHeartbeatAt)}${streamTag}`);
    } else if (c.heartbeatStream) {
      parts.push(`hb [${c.heartbeatStream}]`);
    }
    if (c.lastError && !c.connected) {
      parts.push(`error: ${c.lastError.slice(0, 100)}`);
    }
    return `• ${parts.join(" | ")}`;
  });
  return `Channels (${entries.length}):\n${lines.join("\n")}`;
}

const SYSTEM_COMMANDS = new Set([
  "help",
  "commands",
  "channels",
  "version",
  "v",
  "whoami",
  "ping",
  "sethome",
  "verbose",
  "progress",
]);

/** Handles system/info commands. Returns `true` when the command was consumed. */
export async function handleSystemCommand(
  ctx: RouterCommandContext,
  cmd: string,
): Promise<boolean> {
  if (!SYSTEM_COMMANDS.has(cmd)) {
    return false;
  }

  const { chatId, msg, args } = ctx;

  switch (cmd) {
    case "help":
    case "commands":
      await ctx.sendReply(chatId, HELP_TEXT, msg.id);
      return true;

    case "channels":
      await ctx.sendReply(
        chatId,
        formatChannelsReport(Object.values(ctx.getChannelStatuses()), msg.channel),
        msg.id,
      );
      return true;

    case "version":
    case "v":
      await ctx.sendReply(
        chatId,
        `antigravity-gateway v${ctx.version} | Node ${process.version}`,
        msg.id,
      );
      return true;

    case "whoami": {
      const source = ctx.resolveAuthSource() ?? "unknown";
      await ctx.sendReply(
        chatId,
        [
          `Sender: ${ctx.senderId}`,
          `Channel: ${msg.channel}`,
          `Chat: ${chatId} (${msg.isGroup ? "group" : "dm"})`,
          `Service: ${msg.service ?? "unknown"}`,
          `Auth: ${source}`,
        ].join("\n"),
        msg.id,
      );
      return true;
    }

    case "ping": {
      if (isHelpFlag(args)) {
        await ctx.sendReply(
          chatId,
          "Usage: /ping — Report gateway uptime and channel connection state.",
          msg.id,
        );
        return true;
      }
      await ctx.sendReply(
        chatId,
        `🏓 Pong! channel=${msg.channel} | uptime=${formatUptime(Date.now() - ctx.startedAt)} | connected=${ctx.isChannelConnected()}`,
        msg.id,
      );
      return true;
    }

    case "sethome": {
      if (isHelpFlag(args)) {
        await ctx.sendReply(
          chatId,
          "Usage: /sethome — Set this conversation as the recovery home chat.",
          msg.id,
        );
        return true;
      }
      await ctx.store.setHomeChatId(chatId);
      await ctx.sendReply(
        chatId,
        `🏠 Home chat set to this conversation (${chatId}).`,
        msg.id,
      );
      return true;
    }

    case "verbose": {
      const current = ctx.getVerbosity();
      if (!args || isHelpFlag(args)) {
        await ctx.sendReply(
          chatId,
          [
            `Verbosity: ${current}`,
            "Usage: /verbose [off|brief|full]",
            "off — silence periodic progress pulses (stall alerts stay on)",
            "brief — concise progress pulses (default)",
            "full — add tool count, model, effort & retry detail",
          ].join("\n"),
          msg.id,
        );
        return true;
      }
      const next = args.toLowerCase();
      if (next !== "off" && next !== "brief" && next !== "full") {
        await ctx.sendReply(
          chatId,
          "Invalid verbosity. Use: /verbose [off|brief|full]",
          msg.id,
        );
        return true;
      }
      ctx.setVerbosity(next);
      await ctx.sendReply(chatId, `Verbosity set to: ${next}`, msg.id);
      return true;
    }

    case "progress": {
      const usage = "Usage: /progress [auto|edit|silence|off|keep|delete]";
      const mode = ctx.getToolProgressMode();
      const keep = ctx.getToolProgressKeep();
      const liveEdit = ctx.shouldUseLiveProgressEdit();
      const interval = ctx.config.toolProgressEditIntervalMs ?? 1500;

      if (!args || isHelpFlag(args)) {
        await ctx.sendReply(
          chatId,
          [
            `Tool progress: mode=${mode} | live-edit=${liveEdit ? "yes" : "no — silence pulses"} | on-finish=${keep ? "keep" : "delete"}`,
            `Edit interval: ${interval}ms`,
            usage,
            "auto — edit in place on editable channels, silence pulses on iMessage",
            "edit — always edit a single live message in place",
            "silence — periodic silence pulses only",
            "off — no progress (stall alerts stay on)",
            "keep / delete — keep or delete the final tool summary",
          ].join("\n"),
          msg.id,
        );
        return true;
      }

      const tokens = args.toLowerCase().split(/\s+/).filter(Boolean);
      const validModes = new Set<ToolProgressMode>(["auto", "edit", "silence", "off"]);
      let nextMode: ToolProgressMode | undefined;
      let nextKeep: boolean | undefined;
      for (const token of tokens) {
        if (validModes.has(token as ToolProgressMode)) {
          nextMode = token as ToolProgressMode;
        } else if (token === "keep") {
          nextKeep = true;
        } else if (token === "delete" || token === "clean") {
          nextKeep = false;
        } else {
          await ctx.sendReply(chatId, `Invalid option: ${token}\n${usage}`, msg.id);
          return true;
        }
      }

      if (nextMode) {
        ctx.setToolProgressMode(nextMode);
      }
      if (nextKeep !== undefined) {
        ctx.setToolProgressKeep(nextKeep);
      }

      const effectiveMode = ctx.getToolProgressMode();
      const effectiveKeep = ctx.getToolProgressKeep();
      await ctx.sendReply(
        chatId,
        `⚙️ Tool progress updated: mode=${effectiveMode} | on-finish=${effectiveKeep ? "keep" : "delete"}`,
        msg.id,
      );
      return true;
    }
  }

  return false;
}