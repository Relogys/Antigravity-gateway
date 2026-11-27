import fs from "node:fs";
import path from "node:path";
import type {
  PermissionDecision,
  PermissionResolveActor,
} from "../../acp/permissions.js";
import { formatQuotaSummary } from "../../acp/quota.js";
import { CHANNEL_NAMES, type ChannelName } from "../../config.js";
import type {
  ApprovalMode,
  ModelCatalogEntry,
  SessionInfo,
} from "../../types.js";
import {
  formatUptime,
  isHelpFlag,
  isListFlag,
  type RouterCommandContext,
} from "./system.js";

const SESSION_COMMANDS = new Set([
  "stop",
  "cancel",
  "new",
  "reset",
  "discard",
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
  "retry",
  "model",
  "effort",
  "mode",
  "approvals",
  "sessions",
  "groups",
  "resume",
  "title",
  "compact",
  "compress",
  "cwd",
]);

const PERMISSION_MISMATCH_REPLY = (requester?: string) =>
  `⛔ Only the original requester (${requester}) or a configured admin can approve/deny this group request.`;

function buildActor(ctx: RouterCommandContext): PermissionResolveActor {
  return {
    senderId: ctx.senderId,
    isGroup: ctx.msg.isGroup,
    isAdmin: ctx.isAdminSender(),
  };
}

/**
 * Resolves a pending permission with the actor-aware path when available.
 * Returns `false` only for a group requester mismatch (already replied to).
 */
async function resolvePermission(
  ctx: RouterCommandContext,
  decision: PermissionDecision,
): Promise<{ handled: boolean; resolved: boolean }> {
  const actor = buildActor(ctx);
  const backend = ctx.backend;

  if (backend.resolvePermissionWithResult) {
    const result = backend.resolvePermissionWithResult(ctx.chatId, decision, actor);
    if (!result.ok && result.reason === "requester_mismatch") {
      await ctx.sendReply(
        ctx.chatId,
        PERMISSION_MISMATCH_REPLY(result.requesterSenderId),
        ctx.msg.id,
      );
      return { handled: false, resolved: false };
    }
    return { handled: true, resolved: result.ok };
  }

  const resolved = backend.resolvePermission?.(ctx.chatId, decision, actor) ?? false;
  return { handled: true, resolved };
}

/** Handles session, model, permission, and queue commands. Returns `true` when consumed. */
export async function handleSessionCommand(
  ctx: RouterCommandContext,
  cmd: string,
): Promise<boolean> {
  if (!SESSION_COMMANDS.has(cmd)) {
    return false;
  }

  const { chatId, msg, args, busy } = ctx;

  switch (cmd) {
    case "stop":
    case "cancel": {
      ctx.markCancelled();
      ctx.markStopDrain();
      const stopped = await ctx.backend.cancelTurn(chatId);
      if (!stopped) {
        ctx.unmarkCancelled();
        ctx.unmarkStopDrain();
      }
      await ctx.sendReply(
        chatId,
        stopped ? "⏹️ Stopped active turn." : "No active turn is running.",
        msg.id,
      );
      return true;
    }

    case "new":
    case "reset": {
      if (isHelpFlag(args)) {
        await ctx.sendReply(
          chatId,
          "Usage: /new [title] — Start a fresh session, optionally titled within this channel group.",
          msg.id,
        );
        return true;
      }
      ctx.bumpSessionGeneration();
      ctx.clearQueue();
      ctx.unmarkStopDrain();
      if (busy) {
        ctx.markCancelled();
        await ctx.backend.cancelTurn(chatId);
      }
      const prev = ctx.store.getSession(chatId);
      await ctx.backend.resetSession(chatId);
      await ctx.store.deleteSession(chatId);
      const freshTitle = args.trim()
        ? `[${ctx.resolveChannelGroup()}] ${args.trim()}`
        : undefined;
      if (freshTitle) {
        await ctx.ensureSessionRecord({
          sessionId: "",
          ...(prev
            ? {
                cwd: prev.cwd,
                model: prev.model,
                effort: prev.effort,
                mode: prev.mode,
                approvalMode: prev.approvalMode,
                busyMode: prev.busyMode,
              }
            : {}),
          title: freshTitle,
        });
      } else if (prev && prev.cwd !== ctx.config.defaultCwd) {
        await ctx.ensureSessionRecord({
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
      await ctx.sendReply(
        chatId,
        freshTitle ? `🆕 Started a fresh session: ${freshTitle}` : "🆕 Started a fresh session.",
        msg.id,
      );
      return true;
    }

    case "discard": {
      ctx.bumpSessionGeneration();
      ctx.clearQueue();
      ctx.unmarkStopDrain();
      ctx.forgetChatState();
      if (busy) {
        ctx.markCancelled();
        await ctx.backend.cancelTurn(chatId);
      }
      await ctx.backend.resetSession(chatId);
      await ctx.store.deleteSession(chatId);
      await ctx.sendReply(chatId, "🗑️ Discarded session and queue.", msg.id);
      return true;
    }

    case "status": {
      const stored = ctx.store.getSession(chatId);
      const live = ctx.backend.getSessionInfo?.(chatId);
      const sessionId = live?.sessionId || stored?.sessionId || "(none)";
      const model =
        live?.model || stored?.model || ctx.config.defaultModel || "default";
      const effort =
        live?.effort || stored?.effort || ctx.config.defaultEffort || "default";
      const mode = live?.mode || stored?.mode || "default";
      const cwd = live?.cwd || stored?.cwd || ctx.config.defaultCwd;
      const queueLen = ctx.getQueue().length;
      const pendingPerm = ctx.getPendingPermission();
      const snap = ctx.getHealthSnapshot();
      await ctx.sendReply(
        chatId,
        [
          `Status: ${snap.status} (uptime ${formatUptime(snap.uptimeMs)})`,
          `Turn: ${busy ? "busy" : "idle"} | Queue: ${queueLen}`,
          `Session: ${sessionId === "(none)" ? "(none)" : sessionId.slice(0, 12)}`,
          stored?.title ? `Title: ${stored.title}` : undefined,
          `Model: ${model} | Effort: ${effort} | Mode: ${mode}`,
          `Approvals: ${ctx.getApprovalMode()} | Busy policy: ${ctx.getBusyMode()}`,
          `CWD: ${cwd}`,
          `Active loops: ${snap.activeLoops}${pendingPerm ? ` | Pending approval: ${pendingPerm.title}` : ""}`,
        ]
          .filter(Boolean)
          .join("\n"),
        msg.id,
      );
      return true;
    }

    case "usage": {
      const summary = await ctx.fetchQuota();
      await ctx.sendReply(chatId, formatQuotaSummary(summary), msg.id);
      return true;
    }

    case "queue":
    case "q": {
      if (isHelpFlag(args)) {
        await ctx.sendReply(
          chatId,
          "Usage: /queue [list|clear] or /queue <prompt> — inspect, clear, or enqueue prompts.",
          msg.id,
        );
        return true;
      }
      if (!args || args.toLowerCase() === "list") {
        const q = ctx.getQueue();
        if (q.length === 0) {
          await ctx.sendReply(chatId, "Queue is empty.", msg.id);
        } else {
          const lines = q.map((item, idx) => `${idx + 1}. ${item.slice(0, 120)}`);
          await ctx.sendReply(chatId, `Queued prompts (${q.length}):\n${lines.join("\n")}`, msg.id);
        }
        return true;
      }
      if (args.toLowerCase() === "clear") {
        const cleared = ctx.clearQueue();
        await ctx.sendReply(chatId, `Cleared ${cleared} queued prompt(s).`, msg.id);
        return true;
      }
      if (busy) {
        const pos = ctx.enqueuePrompt(args);
        await ctx.sendReply(chatId, `Queued at #${pos}.`, msg.id);
      } else {
        await ctx.handleUserPrompt(msg, args, []);
      }
      return true;
    }

    case "steer":
    case "s": {
      if (isHelpFlag(args)) {
        await ctx.sendReply(
          chatId,
          "Usage: /steer <prompt> — Interrupt & redirect the active turn.",
          msg.id,
        );
        return true;
      }
      if (!args) {
        await ctx.sendReply(chatId, "Usage: /steer <prompt>", msg.id);
        return true;
      }
      if (!busy) {
        await ctx.handleUserPrompt(msg, args, []);
        return true;
      }
      ctx.clearQueue();
      ctx.enqueuePrompt(args);
      ctx.markCancelled();
      await ctx.backend.cancelTurn(chatId);
      await ctx.sendReply(chatId, "↪️ Redirecting active turn...", msg.id);
      return true;
    }

    case "busy": {
      if (isHelpFlag(args)) {
        await ctx.sendReply(
          chatId,
          "Usage: /busy [queue|interrupt|steer] — Set the busy-turn policy.",
          msg.id,
        );
        return true;
      }
      if (!args) {
        await ctx.sendReply(
          chatId,
          `Current busy mode: ${ctx.getBusyMode()} (options: queue, interrupt, steer)`,
          msg.id,
        );
        return true;
      }
      const next = args.toLowerCase();
      if (next !== "queue" && next !== "interrupt" && next !== "steer") {
        await ctx.sendReply(
          chatId,
          "Invalid busy mode. Use: /busy [queue|interrupt|steer]",
          msg.id,
        );
        return true;
      }
      await ctx.setBusyMode(next);
      await ctx.sendReply(chatId, `Busy mode set to: ${next}`, msg.id);
      return true;
    }

    case "approve": {
      const arg = (args || "once").toLowerCase();
      if (arg !== "once" && arg !== "session" && arg !== "always") {
        await ctx.sendReply(chatId, "Usage: /approve [once|session|always]", msg.id);
        return true;
      }
      const result = await resolvePermission(ctx, arg);
      if (!result.handled) {
        return true;
      }
      await ctx.sendReply(
        chatId,
        result.resolved ? `✅ Approved (${arg}).` : "No pending permission request.",
        msg.id,
      );
      return true;
    }

    case "deny": {
      const result = await resolvePermission(ctx, "deny");
      if (!result.handled) {
        return true;
      }
      await ctx.sendReply(
        chatId,
        result.resolved
          ? `❌ Denied${args ? `: ${args}` : "."}`
          : "No pending permission request.",
        msg.id,
      );
      return true;
    }

    case "yolo": {
      if (msg.isGroup && !ctx.isAdminSender()) {
        await ctx.sendReply(
          chatId,
          "⛔ /yolo in group chats is restricted to configured ADMIN_SENDERS.",
          msg.id,
        );
        return true;
      }
      const current = ctx.getApprovalMode();
      const next: ApprovalMode = current === "auto" ? "interactive" : "auto";
      await ctx.setApprovalMode(next);
      await ctx.sendReply(
        chatId,
        next === "auto"
          ? "⚡ Approval mode set to auto (YOLO enabled for this chat)."
          : "🛡️ Approval mode restored to interactive.",
        msg.id,
      );
      return true;
    }

    case "retry": {
      if (isHelpFlag(args)) {
        await ctx.sendReply(
          chatId,
          "Usage: /retry — Re-run the last prompt sent in this chat.",
          msg.id,
        );
        return true;
      }
      const lastPrompt = ctx.getLastPrompt();
      if (!lastPrompt) {
        await ctx.sendReply(chatId, "No previous prompt to retry in this chat.", msg.id);
        return true;
      }
      await ctx.handleUserPrompt(msg, lastPrompt, []);
      return true;
    }

    case "model": {
      const liveInfo = ctx.backend.getSessionInfo?.(chatId);
      const current =
        liveInfo?.model ??
        ctx.store.getSession(chatId)?.model ??
        ctx.config.defaultModel ??
        "(server default)";
      const currentEffort =
        liveInfo?.effort ??
        ctx.store.getSession(chatId)?.effort ??
        ctx.config.defaultEffort ??
        "default";

      if (!args || isHelpFlag(args) || isListFlag(args)) {
        let catalog: ModelCatalogEntry[];
        const live = await ctx.backend.getModelCatalog?.();
        if (live && live.length > 0) {
          catalog = live;
        } else {
          catalog = (ctx.backend.getAvailableModels?.() ?? []).map((id) => ({
            id,
            name: id,
          }));
        }

        const currentEntry = catalog.find((m) => m.id === current);
        const currentLabel =
          currentEntry && currentEntry.name !== currentEntry.id
            ? `${currentEntry.name} (${current})`
            : current;

        const lines: string[] = [
          `🧠 Current model: ${currentLabel} | effort: ${currentEffort}`,
        ];
        if (catalog.length > 0) {
          lines.push("", `Available models (${catalog.length}):`);
          catalog.forEach((m, idx) => {
            lines.push(`${idx + 1}. ${m.name}${m.name !== m.id ? ` (${m.id})` : ""}`);
          });
        }
        lines.push(
          "",
          "Switch by number: /model 4",
          "Switch by keyword + effort: /model hydrogen xhigh",
          "Switch by full ID: /model gemini-4-neon-high",
          "Change effort only: /effort [low|medium|high|xhigh]",
        );
        await ctx.sendReply(chatId, lines.join("\n"), msg.id);
        return true;
      }

      try {
        if (ctx.backend.setModel) {
          const updated = await ctx.backend.setModel(chatId, args);
          await ctx.ensureSessionRecord({
            model: updated.model,
            ...(updated.effort ? { effort: updated.effort } : {}),
          });
          const hasLabel = Boolean(updated.label) && updated.label !== updated.model;
          const modelLine = hasLabel
            ? `Model set to: ${updated.label} (${updated.model})`
            : `Model set to: ${updated.model}`;
          const effortSuffix = updated.effort
            ? hasLabel
              ? ` | effort: ${updated.effort}`
              : ` (effort: ${updated.effort})`
            : "";
          await ctx.sendReply(chatId, `${modelLine}${effortSuffix}`, msg.id);
        } else if (ctx.backend.setConfigOption) {
          await ctx.backend.setConfigOption(chatId, "model", args);
          await ctx.ensureSessionRecord({ model: args });
          await ctx.sendReply(chatId, `Model set to: ${args}`, msg.id);
        } else {
          await ctx.ensureSessionRecord({ model: args });
          await ctx.sendReply(chatId, `Model set to: ${args}`, msg.id);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await ctx.sendReply(
          chatId,
          `⚠️ Couldn't switch model: ${reason}\nSend /model to see the numbered list.`,
          msg.id,
        );
      }
      return true;
    }

    case "effort": {
      const current =
        ctx.backend.getSessionInfo?.(chatId)?.effort ??
        ctx.store.getSession(chatId)?.effort ??
        ctx.config.defaultEffort ??
        "(default)";
      if (isHelpFlag(args)) {
        await ctx.sendReply(
          chatId,
          `Usage: /effort [low|medium|high|xhigh] — Set reasoning effort. Current: ${current}`,
          msg.id,
        );
        return true;
      }
      if (!args) {
        const available = ctx.backend.getAvailableEfforts?.() ?? [
          "low",
          "medium",
          "high",
          "xhigh",
        ];
        await ctx.sendReply(
          chatId,
          `Current effort: ${current}\nAvailable: ${available.join(", ")}`,
          msg.id,
        );
        return true;
      }
      const level = args.toLowerCase();
      if (!["low", "medium", "high", "xhigh"].includes(level)) {
        await ctx.sendReply(
          chatId,
          "Invalid effort. Use: /effort [low|medium|high|xhigh]",
          msg.id,
        );
        return true;
      }
      if (ctx.backend.setEffort) {
        await ctx.backend.setEffort(chatId, level);
      } else if (ctx.backend.setConfigOption) {
        await ctx.backend.setConfigOption(chatId, "thought_level", level);
      }
      await ctx.ensureSessionRecord({ effort: level });
      await ctx.sendReply(chatId, `Effort set to: ${level}`, msg.id);
      return true;
    }

    case "mode": {
      const current =
        ctx.backend.getSessionInfo?.(chatId)?.mode ??
        ctx.store.getSession(chatId)?.mode ??
        "default";
      if (isHelpFlag(args)) {
        await ctx.sendReply(
          chatId,
          `Usage: /mode [default|accept-edits|auto|plan] — Set ACP mode. Current: ${current}`,
          msg.id,
        );
        return true;
      }
      if (!args) {
        const available = ctx.backend.getAvailableModes?.() ?? [
          "default",
          "accept-edits",
          "auto",
          "plan",
        ];
        await ctx.sendReply(
          chatId,
          `Current mode: ${current}\nAvailable: ${available.join(", ")}`,
          msg.id,
        );
        return true;
      }
      const nextMode = args.toLowerCase();
      if (!["default", "accept-edits", "auto", "plan"].includes(nextMode)) {
        await ctx.sendReply(
          chatId,
          "Invalid mode. Use: /mode [default|accept-edits|auto|plan]",
          msg.id,
        );
        return true;
      }
      if (ctx.backend.setMode) {
        await ctx.backend.setMode(chatId, nextMode);
      } else if (ctx.backend.setConfigOption) {
        await ctx.backend.setConfigOption(chatId, "mode", nextMode);
      }
      await ctx.ensureSessionRecord({ mode: nextMode });
      await ctx.sendReply(chatId, `Mode set to: ${nextMode}`, msg.id);
      return true;
    }

    case "approvals": {
      if (isHelpFlag(args)) {
        await ctx.sendReply(
          chatId,
          "Usage: /approvals [auto|interactive|sandbox] — Set permission mode.",
          msg.id,
        );
        return true;
      }
      if (!args) {
        await ctx.sendReply(
          chatId,
          `Current approval mode: ${ctx.getApprovalMode()} (options: auto, interactive, sandbox)`,
          msg.id,
        );
        return true;
      }
      const next = args.toLowerCase();
      if (next !== "auto" && next !== "interactive" && next !== "sandbox") {
        await ctx.sendReply(
          chatId,
          "Invalid approval mode. Use: /approvals [auto|interactive|sandbox]",
          msg.id,
        );
        return true;
      }
      await ctx.setApprovalMode(next);
      await ctx.sendReply(chatId, `Approval mode set to: ${next}`, msg.id);
      return true;
    }

    case "groups": {
      if (isHelpFlag(args)) {
        await ctx.sendReply(
          chatId,
          "Usage: /groups — Summarize every IM channel session group and its session count.",
          msg.id,
        );
        return true;
      }
      const currentGroup = ctx.resolveChannelGroup().toLowerCase();
      const groups = new Set<string>();
      for (const record of ctx.store.getBoundChannels()) {
        groups.add((record.groupName || record.channel).toLowerCase());
      }
      for (const session of ctx.store.listSessions()) {
        groups.add(
          (session.channelGroup ??
            ctx.resolveChannelGroupFor(session.chatId)).toLowerCase(),
        );
      }
      groups.add(currentGroup);

      const lines = [...groups].sort().map((group) => {
        const count = ctx.store.listSessionsByChannel(group).length;
        const cwd = ctx.config.channelDefaultCwds?.[group as ChannelName];
        const cwdHint = cwd ? ` | cwd: ${cwd}` : "";
        const marker = group === currentGroup ? " (this channel)" : "";
        return `📂 ${group}${marker} — ${count} session(s)${cwdHint}`;
      });
      await ctx.sendReply(chatId, ["Session groups:", ...lines].join("\n"), msg.id);
      return true;
    }

    case "sessions": {
      if (isHelpFlag(args)) {
        await ctx.sendReply(
          chatId,
          "Usage: /sessions [channel|all] — List saved sessions (defaults to this channel's group; 'all' lists every group).",
          msg.id,
        );
        return true;
      }
      const currentGroup = ctx.resolveChannelGroup().toLowerCase();
      const cwd = ctx.resolveDefaultCwd();
      const list = await ctx.backend.listSessions(cwd);
      const sliced = list.slice(0, 10);
      ctx.cacheSessionList(sliced);

      const argLower = args.trim().toLowerCase();
      const knownGroups = new Set<string>();
      for (const record of ctx.store.getBoundChannels()) {
        knownGroups.add((record.groupName || record.channel).toLowerCase());
      }
      for (const session of ctx.store.listSessions()) {
        knownGroups.add(
          (session.channelGroup ??
            ctx.resolveChannelGroupFor(session.chatId)).toLowerCase(),
        );
      }

      const lines: string[] = [];
      const appendStored = (sessions: SessionInfo[]) => {
        for (const session of sessions) {
          const title = session.title ? ` — ${session.title}` : "";
          lines.push(`  • ${session.chatId}${title}`);
        }
      };
      const appendAcp = () => {
        if (sliced.length === 0) {
          return;
        }
        if (lines.length > 0) {
          lines.push("");
        }
        lines.push("ACP sessions (use /resume <index|id>):");
        sliced.forEach((s, idx) => {
          const shortId = s.sessionId.slice(0, 10);
          const label = s.title ? ` — ${s.title}` : "";
          lines.push(`${idx + 1}. ${shortId}${label}`);
        });
      };

      if (!argLower) {
        const stored = ctx.store.listSessionsByChannel(currentGroup);
        if (stored.length === 0) {
          lines.push(`📂 ${currentGroup}: no sessions yet.`);
        } else {
          lines.push(`📂 ${currentGroup}`);
          appendStored(stored);
        }
        appendAcp();
        lines.push(
          "",
          "Use /sessions all to list all channel groups, or /groups for summary.",
        );
      } else if (argLower === "all") {
        const stored = ctx.store.listSessions();
        if (stored.length === 0) {
          lines.push("No gateway sessions yet.");
        } else {
          const grouped = new Map<string, SessionInfo[]>();
          for (const session of stored) {
            const group = (
              session.channelGroup ??
              ctx.resolveChannelGroupFor(session.chatId)
            ).toLowerCase();
            const bucket = grouped.get(group);
            if (bucket) {
              bucket.push(session);
            } else {
              grouped.set(group, [session]);
            }
          }
          for (const [group, sessions] of grouped) {
            lines.push(`📂 ${group}`);
            appendStored(sessions);
          }
        }
        appendAcp();
      } else {
        const target = argLower;
        const isKnown =
          (CHANNEL_NAMES as readonly string[]).includes(target) ||
          knownGroups.has(target);
        if (!isKnown) {
          await ctx.sendReply(
            chatId,
            `Unknown channel group: ${args}. Send /groups to see available groups.`,
            msg.id,
          );
          return true;
        }
        const stored = ctx.store.listSessionsByChannel(target);
        lines.push(`📂 ${target}`);
        if (stored.length === 0) {
          lines.push("  (no sessions)");
        } else {
          appendStored(stored);
        }
        if (target === currentGroup) {
          appendAcp();
        }
      }

      await ctx.sendReply(chatId, lines.join("\n"), msg.id);
      return true;
    }

    case "resume": {
      if (isHelpFlag(args)) {
        await ctx.sendReply(
          chatId,
          "Usage: /resume <id|index> — Resume a saved session (send /sessions to list).",
          msg.id,
        );
        return true;
      }
      if (!args) {
        await ctx.sendReply(chatId, "Usage: /resume <id|index>", msg.id);
        return true;
      }
      const cwd = ctx.resolveDefaultCwd();
      let targetId = args;
      let targetCwd = cwd;
      let targetTitle: string | undefined;

      if (/^\d+$/.test(args)) {
        let cached = ctx.getCachedSessionList();
        if (!cached) {
          cached = (await ctx.backend.listSessions(cwd)).slice(0, 10);
          ctx.cacheSessionList(cached);
        }
        const idx = Number.parseInt(args, 10) - 1;
        const picked = cached[idx];
        if (!picked) {
          await ctx.sendReply(chatId, `Session index ${args} not found.`, msg.id);
          return true;
        }
        targetId = picked.sessionId;
        targetCwd = picked.cwd || cwd;
        targetTitle = picked.title;
      }

      if (ctx.backend.attachSession) {
        await ctx.backend.attachSession(chatId, targetId, targetCwd);
      }
      await ctx.ensureSessionRecord({
        sessionId: targetId,
        cwd: targetCwd,
        ...(targetTitle ? { title: targetTitle } : {}),
      });
      await ctx.sendReply(chatId, `Resumed session ${targetId.slice(0, 12)}.`, msg.id);
      return true;
    }

    case "title": {
      if (isHelpFlag(args)) {
        await ctx.sendReply(
          chatId,
          "Usage: /title [name] — View or rename this session.",
          msg.id,
        );
        return true;
      }
      const stored = ctx.store.getSession(chatId);
      if (!args) {
        await ctx.sendReply(
          chatId,
          stored?.title ? `Session title: ${stored.title}` : "No session title set.",
          msg.id,
        );
        return true;
      }
      await ctx.ensureSessionRecord({ title: args });
      await ctx.sendReply(chatId, `Session title updated: ${args}`, msg.id);
      return true;
    }

    case "compact":
    case "compress": {
      const stored = ctx.store.getSession(chatId);
      if (!stored?.sessionId) {
        await ctx.sendReply(chatId, "No active session to compact.", msg.id);
        return true;
      }
      await ctx.handleUserPrompt(
        msg,
        "Concisely summarize our conversation, key decisions, and open tasks so far so context remains compact.",
        [],
      );
      return true;
    }

    case "cwd": {
      if (isHelpFlag(args)) {
        await ctx.sendReply(
          chatId,
          "Usage: /cwd [path] — View or change the working directory.",
          msg.id,
        );
        return true;
      }
      const currentCwd = ctx.resolveDefaultCwd();
      if (!args) {
        await ctx.sendReply(chatId, `Current working directory: ${currentCwd}`, msg.id);
        return true;
      }
      const resolved = path.resolve(currentCwd, args);
      try {
        const stat = fs.statSync(resolved);
        if (!stat.isDirectory()) {
          await ctx.sendReply(chatId, `Not a directory: ${resolved}`, msg.id);
          return true;
        }
      } catch {
        await ctx.sendReply(chatId, `Directory does not exist: ${resolved}`, msg.id);
        return true;
      }
      ctx.bumpSessionGeneration();
      await ctx.ensureSessionRecord({ cwd: resolved, sessionId: "" });
      await ctx.backend.resetSession(chatId);
      await ctx.sendReply(
        chatId,
        `Working directory set to: ${resolved} (new session will start here).`,
        msg.id,
      );
      return true;
    }
  }

  return false;
}