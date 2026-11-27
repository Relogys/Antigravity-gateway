import { isPhotonChannel } from "../../config.js";
import { PHOTON_BACKGROUND_PRESETS } from "../../photon/adapter.js";
import type { PhotonNativeCapabilities } from "../../types.js";

/** Slash commands that only make sense on the Photon iMessage channel. */
export const PHOTON_NATIVE_COMMANDS = new Set(["poll", "bg", "unsend", "card"]);

const POLL_USAGE =
  "Usage: /poll <question> | <option 1> | <option 2> [| <option 3>...]";
const BG_USAGE = "Usage: /bg <preset|clear|list>";
const CARD_USAGE =
  "Usage: /card — Share the bot's native iMessage contact card (Name & Photo) to this chat.";
const UNSEND_USAGE =
  "Usage: /unsend — Retract the bot's last sent iMessage in this chat (within Apple's ~2-minute window).";

/** True for `-h`, `--h`, `--help`, `help` (case-insensitive, trimmed). */
function isHelpFlag(value: string): boolean {
  return /^(?:-h|--h|--help|help)$/i.test(value.trim());
}

/** True for `list`, `ls`, `-l`, `--list` (case-insensitive, trimmed). */
function isBgListFlag(value: string): boolean {
  return /^(?:list|ls|-l|--list)$/i.test(value.trim());
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Structural check for adapters that expose the Photon iMessage native surface
 * (polls, chat backgrounds, contact cards, unsend). Never trusts `name` alone.
 */
export function isPhotonNativeAdapter(
  adapter: unknown,
): adapter is PhotonNativeCapabilities {
  if (!adapter || typeof adapter !== "object") {
    return false;
  }
  const candidate = adapter as Record<string, unknown>;
  return (
    typeof candidate.sendPoll === "function" &&
    typeof candidate.setBackground === "function" &&
    typeof candidate.shareContactCard === "function" &&
    typeof candidate.unsendLastMessage === "function"
  );
}

export interface PhotonNativeCommandContext {
  cmd: string;
  args: string;
  chatId: string;
  rawChatId: string;
  channelName: string;
  replyToMessageId?: string;
  adapter?: unknown;
  sendReply: (
    chatId: string,
    text: string,
    replyToMessageId?: string,
  ) => Promise<void>;
}

function formatBackgroundList(): string {
  const groups = new Map<string, string[]>([
    ["sky", []],
    ["water", []],
    ["aurora", []],
    ["color", []],
  ]);
  for (const preset of PHOTON_BACKGROUND_PRESETS) {
    const group = /^(sky|water|aurora|color)/.exec(preset)?.[1] ?? "color";
    groups.get(group)!.push(preset);
  }

  const lines = [`Chat background presets (${PHOTON_BACKGROUND_PRESETS.length}):`];
  for (const [group, items] of groups) {
    if (items.length > 0) {
      lines.push(`${group}: ${items.join(", ")}`);
    }
  }
  lines.push("clear — remove the current background");
  lines.push(BG_USAGE);
  return lines.join("\n");
}

async function sendCommandHelp(
  ctx: PhotonNativeCommandContext,
  cmd: string,
): Promise<void> {
  const help =
    cmd === "poll"
      ? POLL_USAGE
      : cmd === "bg"
        ? `${BG_USAGE}\nTip: run /bg list to see all ${PHOTON_BACKGROUND_PRESETS.length} presets.`
        : cmd === "card"
          ? CARD_USAGE
          : UNSEND_USAGE;
  await ctx.sendReply(ctx.chatId, help, ctx.replyToMessageId);
}

async function runPoll(
  ctx: PhotonNativeCommandContext,
  adapter: PhotonNativeCapabilities,
): Promise<void> {
  const parts = ctx.args
    .split(/[|｜]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length < 3) {
    await ctx.sendReply(ctx.chatId, POLL_USAGE, ctx.replyToMessageId);
    return;
  }

  const question = parts[0];
  const options = parts.slice(1);
  try {
    await adapter.sendPoll(ctx.rawChatId, question, options);
    await ctx.sendReply(
      ctx.chatId,
      `📊 Poll created: ${question} (${options.length} options)`,
      ctx.replyToMessageId,
    );
  } catch (err) {
    await ctx.sendReply(
      ctx.chatId,
      `⚠️ Could not create poll: ${errorMessage(err)}`,
      ctx.replyToMessageId,
    );
  }
}

async function runBackground(
  ctx: PhotonNativeCommandContext,
  adapter: PhotonNativeCapabilities,
): Promise<void> {
  const arg = ctx.args.trim();
  if (!arg || isBgListFlag(arg)) {
    await ctx.sendReply(ctx.chatId, formatBackgroundList(), ctx.replyToMessageId);
    return;
  }

  if (arg.toLowerCase() === "clear") {
    try {
      await adapter.setBackground(ctx.rawChatId, "clear");
      await ctx.sendReply(ctx.chatId, "🎨 Chat background cleared.", ctx.replyToMessageId);
    } catch (err) {
      await ctx.sendReply(ctx.chatId, `⚠️ ${errorMessage(err)}`, ctx.replyToMessageId);
    }
    return;
  }

  try {
    await adapter.setBackground(ctx.rawChatId, arg);
    await ctx.sendReply(
      ctx.chatId,
      `🎨 Chat background updated to: ${arg}`,
      ctx.replyToMessageId,
    );
  } catch (err) {
    await ctx.sendReply(ctx.chatId, `⚠️ ${errorMessage(err)}`, ctx.replyToMessageId);
  }
}

async function runCard(
  ctx: PhotonNativeCommandContext,
  adapter: PhotonNativeCapabilities,
): Promise<void> {
  try {
    await adapter.shareContactCard(ctx.rawChatId);
    await ctx.sendReply(
      ctx.chatId,
      "🪪 Native contact card shared to this chat.",
      ctx.replyToMessageId,
    );
  } catch (err) {
    await ctx.sendReply(
      ctx.chatId,
      `⚠️ Could not share contact card: ${errorMessage(err)}`,
      ctx.replyToMessageId,
    );
  }
}

async function runUnsend(
  ctx: PhotonNativeCommandContext,
  adapter: PhotonNativeCapabilities,
): Promise<void> {
  try {
    const res = await adapter.unsendLastMessage(ctx.rawChatId);
    if (res.ok) {
      await ctx.sendReply(ctx.chatId, "↩️ Retracted last message.", ctx.replyToMessageId);
    } else {
      await ctx.sendReply(
        ctx.chatId,
        `⚠️ Could not unsend: ${res.reason ?? "unknown error"}`,
        ctx.replyToMessageId,
      );
    }
  } catch (err) {
    await ctx.sendReply(
      ctx.chatId,
      `⚠️ Could not unsend: ${errorMessage(err)}`,
      ctx.replyToMessageId,
    );
  }
}

/**
 * Dispatches `/poll`, `/bg`, `/card`, and `/unsend`. Returns `true` when the
 * command belongs to this group (handled or rejected), `false` otherwise.
 */
export async function handlePhotonNativeCommand(
  ctx: PhotonNativeCommandContext,
): Promise<boolean> {
  const cmd = ctx.cmd.toLowerCase();
  if (!PHOTON_NATIVE_COMMANDS.has(cmd)) {
    return false;
  }

  const help = isHelpFlag(ctx.args);
  const adapter = isPhotonNativeAdapter(ctx.adapter) ? ctx.adapter : undefined;
  const channelOk = isPhotonChannel(ctx.channelName);

  if (!channelOk || !adapter) {
    if (help) {
      await sendCommandHelp(ctx, cmd);
    } else {
      await ctx.sendReply(
        ctx.chatId,
        `/${cmd} is only supported on the Photon iMessage channel.`,
        ctx.replyToMessageId,
      );
    }
    return true;
  }

  if (help) {
    await sendCommandHelp(ctx, cmd);
    return true;
  }

  switch (cmd) {
    case "poll":
      await runPoll(ctx, adapter);
      break;
    case "bg":
      await runBackground(ctx, adapter);
      break;
    case "card":
      await runCard(ctx, adapter);
      break;
    case "unsend":
      await runUnsend(ctx, adapter);
      break;
  }
  return true;
}