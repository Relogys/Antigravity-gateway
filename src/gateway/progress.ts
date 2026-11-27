import type { OutboundMessage, ToolCallEvent } from "../types.js";

export interface LiveProgressChannel {
  sendMessage(msg: OutboundMessage): Promise<{ messageId?: string } | void>;
  editMessage?(
    chatId: string,
    messageId: string,
    text: string,
    options?: { markdown?: boolean },
  ): Promise<void>;
  deleteMessage?(chatId: string, messageId: string): Promise<void>;
}

export interface LiveProgressTrackerOptions {
  chatId: string;
  modelLabel: string;
  channel: LiveProgressChannel;
  /** false (default) deletes the progress message on turn finish; true keeps a compact summary. */
  keepOnComplete: boolean;
  /** Minimum ms between live in-place edits (default 1500). */
  editIntervalMs?: number;
  /** Controls detail density: "off" disables live card; "brief" (default) shows up to 5 recent tools; "full" shows up to 8 + phase. */
  verbosity?: "off" | "brief" | "full";
  /** Optional replyToMessageId to anchor the progress card to the user's message. */
  replyToMessageId?: string;
  /** Max visible recent tool lines (defaults to 5 for brief, 8 for full). */
  maxVisibleTools?: number;
  /** Injectable clock for deterministic tests. */
  nowFn?: () => number;
}

export type LiveProgressOutcome = "completed" | "cancelled" | "failed";

type LivePhase = "thinking" | "tool" | "streaming" | "retrying";

interface ToolRecord {
  id: string;
  title: string;
  status: string;
}

const DEFAULT_EDIT_INTERVAL_MS = 1500;
const BRIEF_VISIBLE_TOOLS = 5;
const FULL_VISIBLE_TOOLS = 8;
const DEFAULT_TITLE_LEN = 48;
const MAX_NOTE_LEN = 200;

const COMPLETED_STATUSES = new Set(["completed", "done", "succeeded", "ok"]);
const FAILED_STATUSES = new Set(["failed", "error", "denied", "cancelled", "canceled"]);

const PHASE_LABELS: Record<LivePhase, string> = {
  thinking: "思考",
  tool: "工具",
  streaming: "输出",
  retrying: "重试",
};

const IDE_FILE_LINK = /\[([^\]]*)\]\((file:\/\/[^\s)]+)\)/g;

function truncateCodePoints(text: string, maxLen: number): string {
  const limit = Math.max(1, Math.floor(maxLen));
  const points = Array.from(text);
  if (points.length <= limit) {
    return text;
  }
  if (limit === 1) {
    return "…";
  }
  return `${points.slice(0, limit - 1).join("")}…`;
}

function collapseWhitespace(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function basenameFromHref(href: string): string {
  const withoutScheme = href.replace(/^file:\/\//i, "").split("#")[0] ?? "";
  let decoded = withoutScheme;
  try {
    decoded = decodeURIComponent(withoutScheme);
  } catch {
    decoded = withoutScheme;
  }
  const segments = decoded.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? "file";
}

function formatFileLink(label: string, href: string): string {
  const name = label.trim() || basenameFromHref(href);
  const range = /#L(\d+)(?:-L?(\d+))?$/.exec(href);
  if (!range || !range[1]) {
    return name;
  }
  const start = range[1];
  const end = range[2];
  if (!end || end === start) {
    return `${name}:${start}`;
  }
  return `${name}:${start}-${end}`;
}

function looksLikeShellScript(text: string): boolean {
  return (
    /^(?:PS>|\$)/.test(text) ||
    /invoke-restmethod/i.test(text) ||
    /(?:&&|\|\||;|\|)/.test(text)
  );
}

/** Keeps the first meaningful command of a noisy multi-statement script or pipeline. */
function summarizeShellScript(text: string): string {
  const body = text.replace(/^PS>\s*/i, "").replace(/^\$\s*/, "");
  const segments = body
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const chosen =
    segments.find((part) => !/^\$?[A-Za-z_][\w.]*\s*=/.test(part)) ?? segments[0] ?? body;
  return chosen.replace(/^\$+\s*/, "").trim();
}

function statusIcon(status: string): string {
  const normalized = (status ?? "").trim().toLowerCase();
  if (COMPLETED_STATUSES.has(normalized)) {
    return "✅";
  }
  if (FAILED_STATUSES.has(normalized)) {
    return "❌";
  }
  return "🔄";
}

/**
 * Turns a raw tool title (which may embed IDE links, newlines, or whole shell
 * scripts) into a single short display line that is safe for every channel.
 */
export function sanitizeToolTitle(raw: string, maxLen = DEFAULT_TITLE_LEN): string {
  const limit = Math.max(1, Math.floor(maxLen));
  const source = typeof raw === "string" ? raw : "";

  const withFileNames = source.replace(IDE_FILE_LINK, (_match, label: string, href: string) =>
    formatFileLink(label, href),
  );
  const collapsed = collapseWhitespace(withFileNames);
  if (!collapsed) {
    return "tool";
  }

  const readable = looksLikeShellScript(collapsed)
    ? collapseWhitespace(summarizeShellScript(collapsed))
    : collapsed;
  if (!readable) {
    return "tool";
  }
  return truncateCodePoints(readable, limit);
}

export class LiveProgressTracker {
  private readonly chatId: string;
  private readonly modelLabel: string;
  private readonly channel: LiveProgressChannel;
  private readonly keepOnComplete: boolean;
  private readonly editIntervalMs: number;
  private readonly verbosity: "off" | "brief" | "full";
  private readonly replyToMessageId?: string;
  private readonly maxVisibleTools: number;
  private readonly nowFn: () => number;
  private readonly startedAt: number;

  private readonly tools: ToolRecord[] = [];
  private readonly toolIndex = new Map<string, ToolRecord>();
  private toolCount = 0;
  private phase: LivePhase = "thinking";
  private phaseNote?: string;
  private revision = 0;

  private finished = false;
  private degraded = false;
  private editsUnavailable = false;
  private messageId?: string;
  private lastRenderedText?: string;
  private lastFlushAt = 0;
  private sendQueued = false;
  private editQueued = false;
  private timer?: ReturnType<typeof setTimeout>;

  /** Serializes every channel call so bursts can never race or duplicate the card. */
  private ioChain: Promise<void> = Promise.resolve();

  constructor(options: LiveProgressTrackerOptions) {
    this.chatId = options.chatId;
    this.modelLabel = options.modelLabel;
    this.channel = options.channel;
    this.keepOnComplete = options.keepOnComplete;
    this.editIntervalMs = Math.max(0, options.editIntervalMs ?? DEFAULT_EDIT_INTERVAL_MS);
    this.verbosity = options.verbosity ?? "brief";
    this.replyToMessageId = options.replyToMessageId;
    this.maxVisibleTools = Math.max(
      0,
      options.maxVisibleTools ??
        (this.verbosity === "full" ? FULL_VISIBLE_TOOLS : BRIEF_VISIBLE_TOOLS),
    );
    this.nowFn = options.nowFn ?? Date.now;
    this.startedAt = this.nowFn();
  }

  onPhaseChange(phase: LivePhase, note?: string): void {
    if (this.finished) {
      return;
    }
    const nextNote = note?.trim() || undefined;
    if (this.phase === phase && this.phaseNote === nextNote) {
      return;
    }
    this.phase = phase;
    this.phaseNote = nextNote;
    this.revision += 1;
    if (this.messageId) {
      this.scheduleFlush();
    }
  }

  onToolCall(event: ToolCallEvent): void {
    try {
      if (this.finished || this.verbosity === "off") {
        return;
      }
      const id = typeof event?.toolCallId === "string" ? event.toolCallId.trim() : "";
      if (!id) {
        return;
      }
      const existing = this.toolIndex.get(id);
      const rawTitle = typeof event.title === "string" ? event.title.trim() : "";
      const nextStatus = typeof event.status === "string" && event.status ? event.status : "running";

      if (existing) {
        existing.status = nextStatus;
        if (rawTitle) {
          existing.title = sanitizeToolTitle(rawTitle, DEFAULT_TITLE_LEN);
        }
      } else {
        const record: ToolRecord = {
          id,
          title: sanitizeToolTitle(event.title ?? "", DEFAULT_TITLE_LEN),
          status: nextStatus,
        };
        this.tools.push(record);
        this.toolIndex.set(id, record);
        this.toolCount += 1;
      }

      this.phase = "tool";
      this.revision += 1;
      this.scheduleFlush();
    } catch {
      // Progress rendering must never break the turn.
    }
  }

  renderRunning(): string {
    const header = `⚙️ **[${this.modelLabel}]** 处理中 (${this.elapsedSeconds()}s · ${this.toolCount} 次工具调用${this.phaseSuffix()})`;
    return [header, ...this.recentToolLines()].join("\n");
  }

  renderFinal(outcome: LiveProgressOutcome, summaryNote?: string): string {
    const seconds = this.elapsedSeconds();
    const count = `${this.toolCount} 次工具调用`;

    if (outcome === "completed") {
      const header = `✅ **[${this.modelLabel}]** 已完成 (${seconds}s · 共 ${count})`;
      return [header, ...this.recentToolLines()].join("\n");
    }
    if (outcome === "cancelled") {
      return `🛑 **[${this.modelLabel}]** 已取消 (${seconds}s · ${count})`;
    }

    const lines = [`❌ **[${this.modelLabel}]** 执行失败 (${seconds}s · ${count})`];
    const note = summaryNote ? collapseWhitespace(summaryNote) : "";
    if (note) {
      lines.push(truncateCodePoints(note, MAX_NOTE_LEN));
    }
    return lines.join("\n");
  }

  async finish(outcome: LiveProgressOutcome, summaryNote?: string): Promise<void> {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.clearTimer();

    await this.enqueueIo(async () => {
      const messageId = this.messageId;
      if (!messageId) {
        return;
      }
      const finalText = this.renderFinal(outcome, summaryNote);
      const compactText = finalText.split("\n")[0] ?? finalText;

      if (this.keepOnComplete) {
        if (this.channel.editMessage) {
          try {
            await this.channel.editMessage(this.chatId, messageId, finalText, { markdown: true });
            this.lastRenderedText = finalText;
          } catch {
            // Best-effort only.
          }
        }
        return;
      }

      if (this.channel.deleteMessage) {
        try {
          await this.channel.deleteMessage(this.chatId, messageId);
          return;
        } catch {
          // Fall back to a compact edit below.
        }
      }
      if (this.channel.editMessage) {
        try {
          await this.channel.editMessage(this.chatId, messageId, compactText, { markdown: true });
          this.lastRenderedText = compactText;
        } catch {
          // Best-effort only.
        }
      }
    });
  }

  getMessageId(): string | undefined {
    return this.messageId;
  }

  getToolCount(): number {
    return this.toolCount;
  }

  isActive(): boolean {
    return !this.finished;
  }

  private scheduleFlush(): void {
    if (this.finished || this.degraded || this.verbosity === "off") {
      return;
    }
    if (!this.messageId) {
      this.queueSend();
      return;
    }
    if (this.editQueued || this.editsUnavailable) {
      return;
    }
    if (this.renderRunning() === this.lastRenderedText) {
      this.clearTimer();
      return;
    }
    const remaining = this.editIntervalMs - (this.nowFn() - this.lastFlushAt);
    if (remaining <= 0) {
      this.queueEdit();
      return;
    }
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.finished || this.degraded) {
        return;
      }
      this.queueEdit();
    }, remaining);
    this.timer.unref?.();
  }

  private queueSend(): void {
    if (this.sendQueued || this.messageId) {
      return;
    }
    this.sendQueued = true;
    const text = this.renderRunning();
    const message: OutboundMessage = { chatId: this.chatId, text, markdown: true };
    if (this.replyToMessageId) {
      message.replyToMessageId = this.replyToMessageId;
    }

    void this.enqueueIo(async () => {
      try {
        const result = await this.channel.sendMessage(message);
        const id = result && typeof result === "object" ? result.messageId : undefined;
        if (id) {
          this.messageId = id;
          this.lastRenderedText = text;
          this.lastFlushAt = this.nowFn();
        } else {
          this.degraded = true;
        }
      } catch {
        this.degraded = true;
      } finally {
        this.sendQueued = false;
        if (this.messageId && !this.finished) {
          this.scheduleFlush();
        }
      }
    });
  }

  private queueEdit(): void {
    if (this.editQueued || this.degraded || !this.messageId) {
      return;
    }
    if (!this.channel.editMessage) {
      this.editsUnavailable = true;
      return;
    }
    const text = this.renderRunning();
    if (text === this.lastRenderedText) {
      return;
    }

    const messageId = this.messageId;
    const revision = this.revision;
    this.editQueued = true;
    this.clearTimer();

    void this.enqueueIo(async () => {
      try {
        await this.channel.editMessage?.(this.chatId, messageId, text, { markdown: true });
        this.lastRenderedText = text;
        this.lastFlushAt = this.nowFn();
      } catch {
        this.lastFlushAt = this.nowFn();
      } finally {
        this.editQueued = false;
        if (!this.finished && !this.degraded && this.revision !== revision) {
          this.scheduleFlush();
        }
      }
    });
  }

  private enqueueIo(task: () => Promise<void>): Promise<void> {
    const next = this.ioChain.then(task).catch(() => {});
    this.ioChain = next;
    return next;
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private elapsedSeconds(): number {
    return Math.max(0, Math.round((this.nowFn() - this.startedAt) / 1000));
  }

  private recentToolLines(): string[] {
    const total = this.tools.length;
    const visible =
      this.maxVisibleTools > 0 ? this.tools.slice(Math.max(0, total - this.maxVisibleTools)) : [];
    const lines: string[] = [];
    const hidden = total - visible.length;
    if (hidden > 0) {
      lines.push(`… 另有 ${hidden} 项更早调用`);
    }
    for (const tool of visible) {
      lines.push(`• ${statusIcon(tool.status)} ${tool.title}`);
    }
    return lines;
  }

  private phaseSuffix(): string {
    if (this.verbosity !== "full") {
      return "";
    }
    const note = this.phaseNote ? `: ${truncateCodePoints(this.phaseNote, 32)}` : "";
    return ` · 阶段 ${PHASE_LABELS[this.phase]}${note}`;
  }
}