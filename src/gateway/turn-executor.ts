import { stripIdeFileLinks } from "../channels/format.js";
import { senderKeyFor, type GatewayConfig } from "../config.js";
import { extractOutboundMedia } from "../photon/format.js";
import type {
  ApprovalMode,
  BusyMode,
  InboundAttachment,
  InboundMessage,
  OutboundActionButton,
  SessionInfo,
  ToolProgressMode,
} from "../types.js";
import { formatUptime, type VerbosityLevel } from "./commands/system.js";
import { LiveProgressTracker, sanitizeToolTitle } from "./progress.js";
import type { ExtendedAgentBackend, ExtendedChannelAdapter } from "./router.js";
import type { GatewayStore } from "./store.js";

export interface TurnExecutionOptions {
  overrideCwd?: string;
  isLoop?: boolean;
  loopJobId?: string;
}

export interface TurnExecutorHost {
  readonly config: GatewayConfig;
  readonly channel: ExtendedChannelAdapter;
  readonly backend: ExtendedAgentBackend;
  readonly store: GatewayStore;
  readonly typingIntervalMs: number;
  readonly progressPollIntervalMs: number;

  rememberLastPrompt(chatId: string, prompt: string): void;
  withReplyQuote(msg: InboundMessage, text: string): string;
  getSessionGeneration(chatId: string): number;
  consumeStopDrain(chatId: string): boolean;
  consumeUserCancel(chatId: string): boolean;
  shiftChatQueue(chatId: string): string | undefined;
  reactionsEnabled(channelName: string): boolean;
  resolveDefaultCwd(chatId: string): string;
  resolveChannelGroup(chatId: string): string;
  getChatApprovalMode(chatId: string): ApprovalMode;
  getChatBusyMode(chatId: string): BusyMode;
  getChatVerbosity(chatId: string): VerbosityLevel;
  getChatToolProgressMode(chatId: string): ToolProgressMode;
  getChatToolProgressKeep(chatId: string): boolean;
  shouldUseLiveProgressEdit(chatId: string, channelName: string): boolean;
  ensureSessionRecord(chatId: string, patch?: Partial<SessionInfo>): Promise<SessionInfo>;
  maybeGetLowQuotaNotice(): Promise<string>;
  recordError(message: string): void;
  sendReply(
    chatId: string,
    text: string,
    replyToMessageId?: string,
    mediaPaths?: string[],
    actions?: OutboundActionButton[],
  ): Promise<void>;
}

function isCancellationError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(cancel|cancelled|canceled|aborted)\b/i.test(msg);
}

/**
 * Coordinates single-turn and queued-turn execution, typing keep-alive, live
 * tool-call progress cards, silence/stall watchdogs, isolated scheduled-loop
 * sessions, and outbound reply assembly.
 */
export class TurnExecutor {
  private readonly activeTurnChats = new Set<string>();
  private readonly activeTurnCleanups = new Set<() => void>();
  private readonly activeTurnFlushers = new Map<string, () => Promise<void>>();

  constructor(private readonly host: TurnExecutorHost) {}

  isChatActive(chatId: string): boolean {
    return this.activeTurnChats.has(chatId);
  }

  activeTurnCount(): number {
    return this.activeTurnChats.size;
  }

  /**
   * Flushes any buffered pre-tool / pre-interjection text for an active turn
   * before a live steering prompt is injected so bubbles stay cleanly separated.
   */
  async flushPendingOutput(chatId: string): Promise<void> {
    const flusher = this.activeTurnFlushers.get(chatId);
    if (flusher) {
      await flusher();
    }
  }

  /** Force-clear all active typing and progress intervals during shutdown. */
  stop(): void {
    for (const cleanup of [...this.activeTurnCleanups]) {
      try {
        cleanup();
      } catch {
        // Best-effort shutdown cleanup.
      }
    }
    this.activeTurnCleanups.clear();
    this.activeTurnFlushers.clear();
  }

  async executeTurn(
    msg: InboundMessage,
    text: string,
    attachments: InboundAttachment[],
    options: TurnExecutionOptions = {},
  ): Promise<void> {
    const { chatId } = msg;
    const isLoop = options.isLoop === true;
    if (!isLoop) {
      this.host.rememberLastPrompt(chatId, text);
      this.activeTurnChats.add(chatId);
    }

    try {
      let currentMsg = msg;
      let currentText = isLoop ? text : this.host.withReplyQuote(msg, text);
      let currentAttachments = attachments;
      let currentOptions = options;

      while (true) {
        const turnGeneration = this.host.getSessionGeneration(chatId);
        await this.runSingleTurn(
          currentMsg,
          currentText,
          currentAttachments,
          turnGeneration,
          currentOptions,
        );

        if (isLoop) {
          break;
        }
        if (this.host.consumeStopDrain(chatId)) {
          break;
        }
        const nextPrompt = this.host.shiftChatQueue(chatId);
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
      if (!isLoop) {
        this.activeTurnChats.delete(chatId);
      }
    }
  }

  private async runSingleTurn(
    msg: InboundMessage,
    text: string,
    attachments: InboundAttachment[],
    turnGeneration: number,
    options: TurnExecutionOptions = {},
  ): Promise<void> {
    const { chatId } = msg;
    const isLoop = options.isLoop === true;
    const backendChatId = isLoop
      ? `${chatId}::loop:${options.loopJobId ?? "job"}`
      : chatId;

    if (
      this.host.reactionsEnabled(msg.channel) &&
      this.host.channel.react &&
      !isLoop
    ) {
      this.host.channel.react(chatId, msg.id, "👀").catch(() => {});
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
        this.host.channel.sendTyping?.(chatId, false).catch(() => {});
      }
    };
    const cleanupTurnTimers = () => {
      if (progressTimer) {
        clearInterval(progressTimer);
        progressTimer = undefined;
      }
      stopTyping();
    };
    this.activeTurnCleanups.add(cleanupTurnTimers);

    if (this.host.channel.sendTyping && !isLoop) {
      typingActive = true;
      this.host.channel.sendTyping(chatId, true).catch(() => {});
      if (this.host.typingIntervalMs > 0) {
        typingTimer = setInterval(() => {
          void this.host.channel.sendTyping?.(chatId, true).catch(() => {});
        }, this.host.typingIntervalMs);
        typingTimer.unref?.();
      }
    }

    const stored = this.host.store.getSession(chatId);
    const cwd = options.overrideCwd ?? this.host.resolveDefaultCwd(chatId);
    const approvalMode = this.host.getChatApprovalMode(chatId);
    const model = stored?.model ?? this.host.config.defaultModel;
    const effort = stored?.effort ?? this.host.config.defaultEffort;

    const useLiveProgress =
      !isLoop && this.host.shouldUseLiveProgressEdit(chatId, msg.channel);
    const toolProgressMode = this.host.getChatToolProgressMode(chatId);
    const liveProgress = useLiveProgress
      ? new LiveProgressTracker({
          chatId,
          modelLabel: model ?? "default",
          channel: this.host.channel,
          keepOnComplete: this.host.getChatToolProgressKeep(chatId),
          editIntervalMs: this.host.config.toolProgressEditIntervalMs ?? 1500,
          verbosity: this.host.getChatVerbosity(chatId),
          replyToMessageId: msg.id,
        })
      : undefined;

    try {
      // Silence progress & stall watchdog (interactive turns only).
      if (
        !isLoop &&
        (this.host.config.progressSilenceMs > 0 ||
          this.host.config.sessionStallTimeoutMs > 0)
      ) {
        const verbosity = this.host.getChatVerbosity(chatId);
        const turnStartedAt = Date.now();
        let lastProgressNotifyAt = turnStartedAt;
        let stallNotified = false;
        progressTimer = setInterval(() => {
          try {
            const now = Date.now();
            const activity = this.host.backend.getTurnActivity?.(chatId);
            const elapsed = formatUptime(now - turnStartedAt);
            const modelLabel = activity?.model ?? model ?? "default";
            const lastActivityAt = activity?.lastActivityAt ?? turnStartedAt;

            if (
              this.host.config.sessionStallTimeoutMs > 0 &&
              !stallNotified &&
              now - lastActivityAt >= this.host.config.sessionStallTimeoutMs
            ) {
              stallNotified = true;
              lastProgressNotifyAt = now;
              const silentFor = formatUptime(now - lastActivityAt);
              void this.host
                .sendReply(
                  chatId,
                  `⚠️ 当前会话已静默 ${silentFor} 无模型/工具活动（模型：${modelLabel}）。发送 /stop 可取消当前任务，或 /new 开启新会话。`,
                )
                .catch(() => {});
              return;
            }

            if (verbosity === "off" || toolProgressMode === "off" || useLiveProgress) {
              return;
            }

            if (
              this.host.config.progressSilenceMs > 0 &&
              now - lastProgressNotifyAt >= this.host.config.progressSilenceMs
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
              void this.host.sendReply(chatId, progressText).catch(() => {});
            }
          } catch {
            // Sampling must never break the turn.
          }
        }, this.host.progressPollIntervalMs);
        progressTimer.unref?.();
      }

      const requesterSenderId = isLoop
        ? undefined
        : senderKeyFor(
            msg.channel || this.host.channel.name,
            msg.senderId || msg.rawSenderId || "",
          ) || undefined;

      const streamIntermediate =
        !isLoop && this.host.config.streamIntermediateReplies !== false;
      let pendingSegment = "";
      let sawTextDelta = false;
      let flushedSegmentCount = 0;
      let firstBubbleSent = false;
      let flushChain: Promise<void> = Promise.resolve();

      const flushPendingSegment = (): Promise<void> => {
        if (!streamIntermediate) {
          return flushChain;
        }
        if (this.host.getSessionGeneration(chatId) !== turnGeneration) {
          pendingSegment = "";
          return flushChain;
        }
        if (!pendingSegment.trim()) {
          // Drop whitespace-only pre-tool buffers so post-tool bubbles don't inherit leading blank lines.
          pendingSegment = "";
          return flushChain;
        }

        const rawSegment = pendingSegment;
        pendingSegment = "";

        const task = flushChain.then(async () => {
          if (this.host.getSessionGeneration(chatId) !== turnGeneration) {
            return;
          }
          const { cleanText, mediaPaths } = extractOutboundMedia(rawSegment, cwd);
          const strippedText = stripIdeFileLinks(cleanText);
          if (!strippedText && mediaPaths.length === 0) {
            return;
          }
          try {
            await this.host.sendReply(
              chatId,
              strippedText,
              firstBubbleSent ? undefined : msg.id,
              mediaPaths,
            );
            firstBubbleSent = true;
            flushedSegmentCount += 1;
            // Sending an outbound message clears typing indicators on iMessage/Telegram;
            // re-arm typing immediately so the user sees activity while tools run.
            if (typingActive) {
              this.host.channel.sendTyping?.(chatId, true).catch(() => {});
            }
          } catch (flushErr) {
            // Preserve the segment so the final turn reply can still deliver it.
            pendingSegment = rawSegment + pendingSegment;
            const errMsg = flushErr instanceof Error ? flushErr.message : String(flushErr);
            this.host.recordError(`Intermediate reply flush failed: ${errMsg}`);
          }
        });
        flushChain = task.catch(() => {});
        return task;
      };

      if (!isLoop) {
        this.activeTurnFlushers.set(chatId, flushPendingSegment);
      }

      const result = await this.host.backend.sendTurn({
        chatId: backendChatId,
        sessionId: isLoop ? undefined : stored?.sessionId || undefined,
        cwd,
        text,
        attachments,
        model,
        effort,
        approvalMode,
        requesterSenderId,
        callbacks:
          streamIntermediate || liveProgress
            ? {
                ...(streamIntermediate
                  ? {
                      onTextDelta: (delta: string) => {
                        sawTextDelta = true;
                        pendingSegment += delta;
                      },
                    }
                  : {}),
                onToolCall: async (event) => {
                  if (streamIntermediate) {
                    await flushPendingSegment();
                  }
                  if (liveProgress) {
                    await liveProgress.onToolCall(event);
                  }
                },
              }
            : undefined,
      });

      await flushChain;

      const wasResetDuringTurn =
        !isLoop && this.host.getSessionGeneration(chatId) !== turnGeneration;
      const wasUserCancelled =
        !isLoop &&
        (this.host.consumeUserCancel(chatId) || result.stopReason === "cancelled");

      if (wasResetDuringTurn) {
        await liveProgress?.finish("cancelled");
        return;
      }

      const isFirstCompleted = !isLoop && !stored?.onboarded && !wasUserCancelled;

      if (!isLoop) {
        await this.host.ensureSessionRecord(chatId, {
          sessionId: result.sessionId,
          cwd,
          approvalMode,
          busyMode: this.host.getChatBusyMode(chatId),
          ...(isFirstCompleted ? { onboarded: true } : {}),
        });
      }

      const reactionsOn =
        this.host.reactionsEnabled(msg.channel) &&
        Boolean(this.host.channel.react) &&
        !isLoop;

      const finalRawText =
        sawTextDelta && flushedSegmentCount > 0 ? pendingSegment : result.text;

      if (wasUserCancelled && !finalRawText.trim() && flushedSegmentCount === 0) {
        await liveProgress?.finish("cancelled");
        if (reactionsOn) {
          this.host.channel.react!(chatId, msg.id, "🛑").catch(() => {});
        }
        return;
      }

      const { cleanText, mediaPaths } = extractOutboundMedia(finalRawText, cwd);
      const strippedText = stripIdeFileLinks(cleanText);
      const quotaNotice = await this.host.maybeGetLowQuotaNotice();
      const onboardingFooter =
        isFirstCompleted && mediaPaths.length === 0
          ? `💡 已自动建立 [${this.host.resolveChannelGroup(chatId)}] 分组会话；发 /model 切换模型，发 /help 查看全部指令。`
          : "";
      const combinedText = [strippedText, quotaNotice, onboardingFooter]
        .filter(Boolean)
        .join("\n\n");
      const emptyResult = !combinedText && mediaPaths.length === 0;

      cleanupTurnTimers();

      await liveProgress?.finish(wasUserCancelled ? "cancelled" : "completed");

      if (!emptyResult) {
        await this.host.sendReply(
          chatId,
          combinedText,
          isLoop || firstBubbleSent ? undefined : msg.id,
          mediaPaths,
        );
      }

      if (reactionsOn) {
        this.host.channel
          .react!(
            chatId,
            msg.id,
            wasUserCancelled || (emptyResult && flushedSegmentCount === 0) ? "🛑" : "👍",
          )
          .catch(() => {});
      }
    } catch (err) {
      const wasResetDuringTurn =
        !isLoop && this.host.getSessionGeneration(chatId) !== turnGeneration;
      const wasUserCancelled =
        !isLoop && this.host.consumeUserCancel(chatId) && isCancellationError(err);

      if (wasResetDuringTurn || wasUserCancelled) {
        await liveProgress?.finish("cancelled");
      }

      if (!wasResetDuringTurn && !wasUserCancelled) {
        const message = err instanceof Error ? err.message : String(err);
        await liveProgress?.finish("failed", message);
        this.host.recordError(message);
        if (
          this.host.reactionsEnabled(msg.channel) &&
          this.host.channel.react &&
          !isLoop
        ) {
          this.host.channel.react(chatId, msg.id, "👎").catch(() => {});
        }
        await this.host
          .sendReply(
            chatId,
            `Error: ${message.slice(0, 600)}`,
            isLoop ? undefined : msg.id,
          )
          .catch(() => {});
      }
    } finally {
      if (!isLoop) {
        this.activeTurnFlushers.delete(chatId);
      }
      this.activeTurnCleanups.delete(cleanupTurnTimers);
      cleanupTurnTimers();
      if (isLoop) {
        await this.host.backend.resetSession(backendChatId).catch(() => {});
      }
    }
  }
}
