import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { QuotaBucket, QuotaGroup, QuotaSummary } from "../types.js";

const execFileAsync = promisify(execFile);

interface RawUsageBucket {
  id?: string;
  name?: string;
  description?: string;
  window?: string;
  remaining_fraction?: number;
  reset_time?: string;
}

interface RawUsageGroup {
  name?: string;
  description?: string;
  buckets?: RawUsageBucket[];
}

interface RawUsageEnvelope {
  status?: string;
  error?: string;
  response?: string;
  command?: {
    name?: string;
    data?: {
      groups?: RawUsageGroup[];
    };
  };
}

const quotaCache = new Map<string, QuotaSummary>();

export function clearQuotaCache(): void {
  quotaCache.clear();
}

function normalizeBuckets(rawBuckets: RawUsageBucket[] | undefined): QuotaBucket[] {
  if (!Array.isArray(rawBuckets)) {
    return [];
  }
  return rawBuckets
    .filter((b): b is RawUsageBucket => Boolean(b && typeof b === "object"))
    .map((b) => {
      const fraction =
        typeof b.remaining_fraction === "number" && Number.isFinite(b.remaining_fraction)
          ? Math.max(0, Math.min(1, b.remaining_fraction))
          : 0;
      return {
        id: b.id ?? "",
        name: b.name ?? b.id ?? "Unknown",
        window: b.window ?? "",
        remainingFraction: fraction,
        remainingPercent: Math.round(fraction * 100),
        resetTime: b.reset_time ?? "",
        description: b.description,
      };
    });
}

export function parseUsageJson(rawStdout: string, fetchedAt = Date.now()): QuotaSummary {
  const trimmed = rawStdout.trim();
  if (!trimmed) {
    return {
      available: false,
      fetchedAt,
      groups: [],
      error: "Empty output from agy /usage",
    };
  }

  let parsed: RawUsageEnvelope;
  try {
    parsed = JSON.parse(trimmed) as RawUsageEnvelope;
  } catch (err) {
    return {
      available: false,
      fetchedAt,
      groups: [],
      error: `Failed to parse agy /usage JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (parsed.status && parsed.status !== "SUCCESS") {
    return {
      available: false,
      fetchedAt,
      groups: [],
      rawText: parsed.response,
      error: parsed.error || `agy /usage returned status ${parsed.status}`,
    };
  }

  const rawGroups = parsed.command?.data?.groups;
  if (!Array.isArray(rawGroups)) {
    return {
      available: false,
      fetchedAt,
      groups: [],
      rawText: parsed.response,
      error: "No quota groups returned (likely API key mode)",
    };
  }

  const groups: QuotaGroup[] = rawGroups.map((g) => ({
    name: g.name ?? "Models",
    description: g.description,
    buckets: normalizeBuckets(g.buckets),
  }));

  // Prefer the Gemini Models group for headline 5h / weekly numbers, falling back to first group
  const primaryGroup =
    groups.find((g) => g.name.toLowerCase().includes("gemini")) ?? groups[0];
  const fiveHour = primaryGroup?.buckets.find((b) => b.window === "5h");
  const weekly = primaryGroup?.buckets.find((b) => b.window === "weekly");

  return {
    available: true,
    fetchedAt,
    groups,
    fiveHourRemainingPercent: fiveHour?.remainingPercent,
    fiveHourResetTime: fiveHour?.resetTime,
    weeklyRemainingPercent: weekly?.remainingPercent,
    weeklyResetTime: weekly?.resetTime,
    rawText: parsed.response,
  };
}

export async function fetchAgyQuota(
  agyBin: string,
  options: {
    env?: NodeJS.ProcessEnv;
    forceRefresh?: boolean;
    cacheTtlMs?: number;
  } = {},
): Promise<QuotaSummary> {
  const cacheTtlMs = options.cacheTtlMs ?? 60_000;
  const env = options.env ?? process.env;
  const cacheKey = `${agyBin}::${env.GEMINI_API_KEY ? "apikey" : "oauth"}`;

  if (!options.forceRefresh && cacheTtlMs > 0) {
    const cached = quotaCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < cacheTtlMs) {
      return cached;
    }
  }

  try {
    const { stdout } = await execFileAsync(
      agyBin,
      ["-p", "/usage", "--output-format", "json"],
      {
        env,
        timeout: 15_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
    );
    const summary = parseUsageJson(stdout);
    quotaCache.set(cacheKey, summary);
    return summary;
  } catch (err) {
    const execErr = err as Error & { code?: number | string; stdout?: string; stderr?: string };
    // agy -p /usage exits with code 2 when authenticated via GEMINI_API_KEY
    if (execErr.stdout && execErr.stdout.trim().startsWith("{")) {
      const parsed = parseUsageJson(execErr.stdout);
      quotaCache.set(cacheKey, parsed);
      return parsed;
    }
    const reason =
      execErr.code === 2
        ? "Quota tracking unavailable (GEMINI_API_KEY mode)"
        : execErr.stderr?.trim() || execErr.message || "Failed to query agy /usage";
    const summary: QuotaSummary = {
      available: false,
      fetchedAt: Date.now(),
      groups: [],
      error: reason,
    };
    quotaCache.set(cacheKey, summary);
    return summary;
  }
}

function formatResetHint(resetTime: string): string {
  if (!resetTime || resetTime.startsWith("1970-01-01")) {
    return "full";
  }
  const ms = Date.parse(resetTime);
  if (!Number.isFinite(ms)) {
    return resetTime;
  }
  const diffMs = ms - Date.now();
  if (diffMs <= 0) {
    return "resetting now";
  }
  const totalMinutes = Math.round(diffMs / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const mins = totalMinutes % 60;
  if (days > 0) {
    return `resets in ${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `resets in ${hours}h ${mins}m`;
  }
  return `resets in ${mins}m`;
}

export function formatQuotaSummary(summary: QuotaSummary): string {
  if (!summary.available) {
    return `Quota unavailable: ${summary.error ?? "unknown error"}`;
  }
  if (summary.groups.length === 0) {
    return "No quota data returned.";
  }

  const lines: string[] = ["Antigravity Quota:"];
  for (const group of summary.groups) {
    lines.push(`• ${group.name}`);
    for (const b of group.buckets) {
      const label = b.window === "5h" ? "5h" : b.window === "weekly" ? "Weekly" : b.name;
      lines.push(`  - ${label}: ${b.remainingPercent}% remaining (${formatResetHint(b.resetTime)})`);
    }
  }
  return lines.join("\n");
}
