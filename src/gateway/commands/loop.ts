import {
  computeNextCronTimestamp,
  formatDurationMs,
  parseDurationMs,
  parseScheduleSpec,
} from "../scheduler.js";
import { isHelpFlag, type RouterCommandContext } from "./system.js";

const LOOP_COMMANDS = new Set(["loop", "remind"]);

const LOOP_USAGE = [
  'Usage: /loop [list|add <dur> <prompt>|daily <HH:MM> <prompt>|cron "<m h dom mon dow>" <prompt>|rm <id>|pause <id>|resume <id>]',
  "Examples:",
  "  /loop add 30m check CI status",
  "  /loop daily 09:00 summarize overnight commits",
  '  /loop cron "0 9 * * 1-5" morning standup digest',
].join("\n");

/** Handles `/loop` and `/remind`. Returns `true` when the command was consumed. */
export async function handleLoopCommand(
  ctx: RouterCommandContext,
  cmd: string,
): Promise<boolean> {
  if (!LOOP_COMMANDS.has(cmd)) {
    return false;
  }

  if (cmd === "remind") {
    await handleRemind(ctx);
  } else {
    await handleLoop(ctx);
  }
  return true;
}

async function handleRemind(ctx: RouterCommandContext): Promise<void> {
  const { chatId, msg, args } = ctx;
  if (isHelpFlag(args)) {
    await ctx.sendReply(
      chatId,
      "Usage: /remind <duration> <text> — One-way reminder push (e.g. /remind 15m stand up).",
      msg.id,
    );
    return;
  }
  const m = /^(\S+)\s+([\s\S]+)$/.exec(args);
  if (!m) {
    await ctx.sendReply(chatId, "Usage: /remind <duration> <text>", msg.id);
    return;
  }
  const durationMs = parseDurationMs(m[1]);
  const text = m[2].trim();
  if (!durationMs || !text) {
    await ctx.sendReply(
      chatId,
      "Invalid duration. Examples: 30s, 15m, 2h, 1d.",
      msg.id,
    );
    return;
  }
  const job = await ctx.scheduler.addReminder(chatId, durationMs, text);
  await ctx.sendReply(
    chatId,
    `⏰ Reminder [${job.id}] scheduled in ${formatDurationMs(durationMs)}.`,
    msg.id,
  );
}

async function handleLoop(ctx: RouterCommandContext): Promise<void> {
  const { chatId, msg, args } = ctx;
  if (isHelpFlag(args)) {
    await ctx.sendReply(chatId, LOOP_USAGE, msg.id);
    return;
  }
  if (!args || args.toLowerCase() === "list") {
    const jobs = ctx.scheduler.listJobs(chatId);
    if (jobs.length === 0) {
      await ctx.sendReply(chatId, "No scheduled loops for this chat.", msg.id);
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
    await ctx.sendReply(chatId, `Loops:\n${lines.join("\n")}`, msg.id);
    return;
  }

  const parts = args.split(/\s+/);
  const sub = parts[0].toLowerCase();

  if (sub === "daily" || sub === "cron") {
    const spec = parseScheduleSpec(args);
    if (!spec || !spec.cron) {
      await ctx.sendReply(
        chatId,
        sub === "daily"
          ? "Invalid daily schedule. Example: /loop daily 09:00 summarize overnight git commits"
          : 'Invalid 5-field cron schedule. Example: /loop cron "0 9 * * 1-5" morning standup',
        msg.id,
      );
      return;
    }
    const cwd = ctx.resolveDefaultCwd();
    const job = await ctx.scheduler.addLoop({
      chatId,
      prompt: spec.prompt,
      cron: spec.cron,
      cwd,
    });
    const nextHint = job.nextRunAt ? ` (next: ${new Date(job.nextRunAt).toISOString()})` : "";
    await ctx.sendReply(
      chatId,
      `🔁 Loop [${job.id}] added: ${sub === "daily" ? `daily ${spec.cron}` : `cron ${spec.cron}`}${nextHint}.`,
      msg.id,
    );
    return;
  }

  if (sub === "add" || sub === "every") {
    const restAfterAdd = args.replace(/^(?:add|every)\s+/i, "").trim();
    if (/^(?:daily|cron)\s+/i.test(restAfterAdd)) {
      const spec = parseScheduleSpec(restAfterAdd);
      if (!spec || !spec.cron) {
        await ctx.sendReply(chatId, LOOP_USAGE, msg.id);
        return;
      }
      const cwd = ctx.resolveDefaultCwd();
      const job = await ctx.scheduler.addLoop({
        chatId,
        prompt: spec.prompt,
        cron: spec.cron,
        cwd,
      });
      await ctx.sendReply(
        chatId,
        `🔁 Loop [${job.id}] added: cron ${spec.cron}.`,
        msg.id,
      );
      return;
    }

    const m = /^(?:add|every)\s+(\S+)\s+([\s\S]+)$/i.exec(args);
    if (!m) {
      await ctx.sendReply(chatId, "Usage: /loop add <duration> <prompt>", msg.id);
      return;
    }
    const rawSched = m[1];
    const prompt = m[2].trim();
    if (/^\d{1,2}:\d{2}$/.test(rawSched) && computeNextCronTimestamp(rawSched) !== null && prompt) {
      const cwd = ctx.resolveDefaultCwd();
      const job = await ctx.scheduler.addLoop({
        chatId,
        prompt,
        cron: rawSched,
        cwd,
      });
      await ctx.sendReply(
        chatId,
        `🔁 Loop [${job.id}] added: daily ${rawSched}.`,
        msg.id,
      );
      return;
    }

    const intervalMs = parseDurationMs(rawSched);
    if (!intervalMs || !prompt) {
      await ctx.sendReply(
        chatId,
        "Invalid duration or empty prompt. Examples: 30m, 2h, 1d, or /loop daily 09:00 <prompt>.",
        msg.id,
      );
      return;
    }
    const cwd = ctx.resolveDefaultCwd();
    const job = await ctx.scheduler.addLoop({
      chatId,
      prompt,
      intervalMs,
      cwd,
    });
    await ctx.sendReply(
      chatId,
      `🔁 Loop [${job.id}] added: every ${formatDurationMs(intervalMs)}.`,
      msg.id,
    );
    return;
  }

  if (sub === "rm" || sub === "del" || sub === "delete" || sub === "remove") {
    const id = parts[1];
    if (!id) {
      await ctx.sendReply(chatId, "Usage: /loop rm <id>", msg.id);
      return;
    }
    const owned = ctx.scheduler.listJobs(chatId).some((j) => j.id === id);
    const removed = owned ? await ctx.scheduler.removeLoop(id) : false;
    await ctx.sendReply(
      chatId,
      removed ? `Removed loop [${id}].` : `Loop [${id}] not found.`,
      msg.id,
    );
    return;
  }

  if (sub === "pause" || sub === "resume") {
    const id = parts[1];
    if (!id) {
      await ctx.sendReply(chatId, `Usage: /loop ${sub} <id>`, msg.id);
      return;
    }
    const enabled = sub === "resume";
    const owned = ctx.scheduler.listJobs(chatId).some((j) => j.id === id);
    const updated = owned ? await ctx.scheduler.toggleLoop(id, enabled) : null;
    await ctx.sendReply(
      chatId,
      updated
        ? `${enabled ? "Resumed" : "Paused"} loop [${id}].`
        : `Loop [${id}] not found.`,
      msg.id,
    );
    return;
  }

  await ctx.sendReply(chatId, LOOP_USAGE, msg.id);
}