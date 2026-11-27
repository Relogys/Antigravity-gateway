import crypto from "node:crypto";
import type { ChannelAdapter, LoopJob } from "../types.js";
import { DeadTargetRegistry } from "./guards.js";
import type { GatewayStore } from "./store.js";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MIN_DURATION_MS = 1000;
const MAX_DURATION_MS = 365 * 24 * 60 * 60 * 1000;

export interface StoredLoopJob extends LoopJob {
  kind?: "loop" | "remind";
  oneShot?: boolean;
}

export interface ParsedScheduleSpec {
  kind: "loop" | "remind";
  intervalMs?: number;
  cron?: string;
  prompt: string;
  oneShot: boolean;
}

export interface LoopSchedulerDeps {
  store: GatewayStore;
  channel: ChannelAdapter;
  runPrompt?: (job: StoredLoopJob) => Promise<string | void>;
  deadTargets?: DeadTargetRegistry;
}

const UNIT_MS: Record<string, number> = {
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  m: 60 * 1000,
  min: 60 * 1000,
  mins: 60 * 1000,
  minute: 60 * 1000,
  minutes: 60 * 1000,
  h: 60 * 60 * 1000,
  hr: 60 * 60 * 1000,
  hrs: 60 * 60 * 1000,
  hour: 60 * 60 * 1000,
  hours: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
};

/**
 * Parse human duration strings such as "45s", "30m", "2h", "1d", or "1h30m".
 */
export function parseDurationMs(raw: string): number | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  const tokenRegex = /(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|min|m|hours?|hrs?|hr|h|days?|d)/g;
  let totalMs = 0;
  let consumed = "";
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(trimmed)) !== null) {
    const value = Number.parseFloat(match[1]);
    const unit = UNIT_MS[match[2]];
    if (!Number.isFinite(value) || value <= 0 || !unit) {
      return null;
    }
    totalMs += value * unit;
    consumed += match[0];
  }

  // Reject unparsed leftover characters
  if (consumed.replace(/\s+/g, "") !== trimmed.replace(/\s+/g, "")) {
    return null;
  }

  const rounded = Math.round(totalMs);
  if (rounded < MIN_DURATION_MS || rounded > MAX_DURATION_MS) {
    return null;
  }
  return rounded;
}

export function formatDurationMs(ms: number): string {
  if (ms % (24 * 60 * 60 * 1000) === 0) {
    return `${ms / (24 * 60 * 60 * 1000)}d`;
  }
  if (ms % (60 * 60 * 1000) === 0) {
    return `${ms / (60 * 60 * 1000)}h`;
  }
  if (ms % (60 * 1000) === 0) {
    return `${ms / (60 * 1000)}m`;
  }
  return `${Math.round(ms / 1000)}s`;
}

/**
 * Compute next fire timestamp (ms) for a simple daily HH:MM or "min hour * * *" cron.
 */
export function computeNextCronTimestamp(cron: string, fromMs = Date.now()): number | null {
  const trimmed = cron.trim();
  let hour: number;
  let minute: number;

  const hhmm = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (hhmm) {
    hour = Number.parseInt(hhmm[1], 10);
    minute = Number.parseInt(hhmm[2], 10);
  } else {
    const parts = trimmed.split(/\s+/);
    if (parts.length !== 5 || parts[2] !== "*" || parts[3] !== "*" || parts[4] !== "*") {
      return null;
    }
    if (!/^\d{1,2}$/.test(parts[0]) || !/^\d{1,2}$/.test(parts[1])) {
      return null;
    }
    minute = Number.parseInt(parts[0], 10);
    hour = Number.parseInt(parts[1], 10);
  }

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }

  const candidate = new Date(fromMs);
  candidate.setSeconds(0, 0);
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() <= fromMs) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate.getTime();
}

/**
 * Parse natural schedule expressions:
 * - "every <dur> <prompt>"
 * - "remind <dur> <text>"
 * - "daily <HH:MM> <prompt>"
 */
export function parseScheduleSpec(input: string): ParsedScheduleSpec | null {
  const trimmed = input.trim();
  const everyMatch = /^every\s+(\S+)\s+([\s\S]+)$/i.exec(trimmed);
  if (everyMatch) {
    const intervalMs = parseDurationMs(everyMatch[1]);
    const prompt = everyMatch[2].trim();
    if (!intervalMs || !prompt) return null;
    return { kind: "loop", intervalMs, prompt, oneShot: false };
  }

  const remindMatch = /^remind\s+(\S+)\s+([\s\S]+)$/i.exec(trimmed);
  if (remindMatch) {
    const intervalMs = parseDurationMs(remindMatch[1]);
    const prompt = remindMatch[2].trim();
    if (!intervalMs || !prompt) return null;
    return { kind: "remind", intervalMs, prompt, oneShot: true };
  }

  const dailyMatch = /^daily\s+(\d{1,2}:\d{2})\s+([\s\S]+)$/i.exec(trimmed);
  if (dailyMatch) {
    const cron = dailyMatch[1];
    if (computeNextCronTimestamp(cron) === null) return null;
    const prompt = dailyMatch[2].trim();
    if (!prompt) return null;
    return { kind: "loop", cron, prompt, oneShot: false };
  }

  return null;
}

/**
 * Lightweight interval/daily timer engine backed by GatewayStore.
 * Supports one-way reminder pushes (no AI call) and recurring prompt loops.
 */
export class LoopScheduler {
  private readonly store: GatewayStore;
  private readonly channel: ChannelAdapter;
  private readonly deadTargets: DeadTargetRegistry;
  private runPrompt?: (job: StoredLoopJob) => Promise<string | void>;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Set<string>();
  private started = false;

  constructor(deps: LoopSchedulerDeps) {
    this.store = deps.store;
    this.channel = deps.channel;
    this.deadTargets = deps.deadTargets ?? new DeadTargetRegistry();
    this.runPrompt = deps.runPrompt;
  }

  getDeadTargetRegistry(): DeadTargetRegistry {
    return this.deadTargets;
  }

  setPromptRunner(fn: (job: StoredLoopJob) => Promise<string | void>): void {
    this.runPrompt = fn;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    for (const job of this.listJobs()) {
      if (job.enabled) {
        this.scheduleJob(job);
      }
    }
  }

  stop(): void {
    this.started = false;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  listJobs(chatId?: string): StoredLoopJob[] {
    const all = this.store.getLoops() as StoredLoopJob[];
    if (!chatId) {
      return all;
    }
    return all.filter((job) => job.chatId === chatId);
  }

  activeCount(): number {
    return this.store.getLoops().filter((job) => job.enabled).length;
  }

  async addLoop(input: {
    chatId: string;
    prompt: string;
    intervalMs?: number;
    cron?: string;
    cwd?: string;
    kind?: "loop" | "remind";
    oneShot?: boolean;
  }): Promise<StoredLoopJob> {
    const now = Date.now();
    const id = crypto.randomBytes(3).toString("hex");
    const nextRunAt = this.computeNextRun(input.intervalMs, input.cron, now);

    const job: StoredLoopJob = {
      id,
      chatId: input.chatId,
      prompt: input.prompt,
      intervalMs: input.intervalMs,
      cron: input.cron,
      cwd: input.cwd,
      kind: input.kind ?? "loop",
      oneShot: input.oneShot ?? false,
      enabled: true,
      createdAt: now,
      nextRunAt: nextRunAt ?? undefined,
    };

    await this.store.upsertLoop(job);
    if (this.started) {
      this.scheduleJob(job);
    }
    return job;
  }

  async addReminder(
    chatId: string,
    intervalMs: number,
    text: string,
  ): Promise<StoredLoopJob> {
    return this.addLoop({
      chatId,
      prompt: text,
      intervalMs,
      kind: "remind",
      oneShot: true,
    });
  }

  async removeLoop(id: string): Promise<boolean> {
    this.clearTimer(id);
    return this.store.deleteLoop(id);
  }

  async toggleLoop(id: string, enabled: boolean): Promise<StoredLoopJob | null> {
    const existing = this.listJobs().find((job) => job.id === id);
    if (!existing) {
      return null;
    }

    const updated: StoredLoopJob = {
      ...existing,
      enabled,
      nextRunAt: enabled
        ? this.computeNextRun(existing.intervalMs, existing.cron, Date.now()) ??
          undefined
        : undefined,
    };

    await this.store.upsertLoop(updated);
    this.clearTimer(id);
    if (this.started && enabled) {
      this.scheduleJob(updated);
    }
    return updated;
  }

  private computeNextRun(
    intervalMs: number | undefined,
    cron: string | undefined,
    fromMs: number,
  ): number | null {
    if (typeof intervalMs === "number" && intervalMs > 0) {
      return fromMs + intervalMs;
    }
    if (cron) {
      return computeNextCronTimestamp(cron, fromMs);
    }
    return null;
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  private scheduleJob(job: StoredLoopJob): void {
    this.clearTimer(job.id);
    if (!this.started || !job.enabled) {
      return;
    }

    const now = Date.now();
    let targetMs = job.nextRunAt;
    if (!targetMs) {
      targetMs = this.computeNextRun(job.intervalMs, job.cron, now) ?? undefined;
    }
    if (!targetMs) {
      return;
    }

    // If overdue after downtime, fire shortly rather than busy-looping
    const rawDelay = Math.max(1000, targetMs - now);
    const delay = Math.min(rawDelay, MAX_TIMEOUT_MS);

    const timer = setTimeout(() => {
      this.timers.delete(job.id);
      if (!this.started) {
        return;
      }
      if (rawDelay > MAX_TIMEOUT_MS) {
        this.scheduleJob(job);
        return;
      }
      void this.executeJob(job.id);
    }, delay);

    this.timers.set(job.id, timer);
  }

  private async executeJob(id: string): Promise<void> {
    if (this.inFlight.has(id)) {
      return;
    }

    const job = this.listJobs().find((item) => item.id === id);
    if (!job || !job.enabled || !this.started) {
      return;
    }

    this.inFlight.add(id);
    const runAt = Date.now();

    try {
      // A dead target is skipped entirely: no AI call and no platform send.
      if (!this.deadTargets.isDead(job.chatId).dead) {
        try {
          if (job.kind === "remind") {
            await this.channel.sendMessage({
              chatId: job.chatId,
              text: `⏰ Reminder: ${job.prompt}`,
            });
            this.deadTargets.markAlive(job.chatId);
          } else if (this.runPrompt) {
            const result = await this.runPrompt(job);
            if (typeof result === "string" && result.trim().length > 0) {
              await this.channel.sendMessage({
                chatId: job.chatId,
                text: result,
                markdown: true,
              });
              this.deadTargets.markAlive(job.chatId);
            }
          }
        } catch (err) {
          const permanent = this.deadTargets.recordError(job.chatId, err);
          if (!permanent) {
            const msg = err instanceof Error ? err.message : String(err);
            await this.channel
              .sendMessage({
                chatId: job.chatId,
                text: `Loop [${job.id}] failed: ${msg}`,
              })
              .catch(() => {});
          }
        }
      }
    } finally {
      this.inFlight.delete(id);
    }

    // Re-read in case job was removed or paused during execution
    const latest = this.listJobs().find((item) => item.id === id);
    if (!latest) {
      return;
    }

    if (latest.oneShot || latest.kind === "remind") {
      await this.store.deleteLoop(id);
      return;
    }

    const nextRunAt = this.computeNextRun(
      latest.intervalMs,
      latest.cron,
      Date.now(),
    );
    const updated: StoredLoopJob = {
      ...latest,
      lastRunAt: runAt,
      nextRunAt: nextRunAt ?? undefined,
    };
    await this.store.upsertLoop(updated);
    if (this.started && updated.enabled) {
      this.scheduleJob(updated);
    }
  }
}
