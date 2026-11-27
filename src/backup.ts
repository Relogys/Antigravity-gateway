import type { GatewayStore } from "./gateway/store.js";
import type { BoundChannelRecord, LoopJob, SessionInfo } from "./types.js";

export const BACKUP_FORMAT_VERSION = 1;

export interface PathRemapRule {
  from: string;
  to: string;
}

export interface GatewayBackupBundle {
  formatVersion: number;
  exportedAt: string;
  gatewayVersion?: string;
  homeChatId?: string;
  sessions: SessionInfo[];
  loops: LoopJob[];
  workspaces: Record<string, string>;
  boundChannels: BoundChannelRecord[];
  /** Only included when explicitly opted in via `--include-auth`. */
  approvedSenders?: string[];
}

export interface ExportBundleOptions {
  gatewayVersion?: string;
  includeAuth?: boolean;
}

export interface ImportBundleOptions {
  dryRun?: boolean;
  overwrite?: boolean;
  includeAuth?: boolean;
  remapCwd?: PathRemapRule[];
}

export interface ImportBundleSummary {
  dryRun: boolean;
  sessionsAdded: number;
  sessionsUpdated: number;
  sessionsSkipped: number;
  loopsAdded: number;
  loopsUpdated: number;
  loopsSkipped: number;
  workspacesImported: number;
  approvedSendersAdded: number;
  pathsRemapped: number;
}

/** Parse a `--remap-cwd <from>=<to>` flag into a PathRemapRule. */
export function parseRemapRule(raw: string): PathRemapRule | null {
  const eq = raw.indexOf("=");
  if (eq <= 0) return null;
  const from = raw.slice(0, eq).trim();
  const to = raw.slice(eq + 1).trim();
  if (!from || !to) return null;
  return { from, to };
}

/**
 * Remap a directory path across OSes/machines (e.g. `E:\work\proj` -> `/Users/dev/proj`).
 * Matches case-insensitively on Windows-style prefixes and preserves trailing subpath segments.
 */
export function remapDirectoryPath(
  dir: string | undefined,
  rules: readonly PathRemapRule[],
): { value: string | undefined; remapped: boolean } {
  if (!dir || rules.length === 0) {
    return { value: dir, remapped: false };
  }
  const normDir = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  for (const rule of rules) {
    const normFrom = rule.from.replace(/\\/g, "/").replace(/\/+$/, "");
    const normTo = rule.to.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!normFrom) continue;
    const isWinPrefix = /^[a-z]:\//i.test(normFrom);
    const haystack = isWinPrefix ? normDir.toLowerCase() : normDir;
    const needle = isWinPrefix ? normFrom.toLowerCase() : normFrom;
    if (haystack === needle) {
      return { value: rule.to, remapped: true };
    }
    if (haystack.startsWith(`${needle}/`)) {
      const rest = normDir.slice(normFrom.length);
      const sep = rule.to.includes("\\") ? "\\" : "/";
      const joined = `${normTo}${rest}`.replace(/[\\/]+/g, sep);
      return { value: joined, remapped: true };
    }
  }
  return { value: dir, remapped: false };
}

/**
 * Export a portable, secret-free JSON backup of sessions, scheduled loops,
 * workspace bookmarks, and channel bindings. Never exports `.env` or tokens;
 * `approvedSenders` are excluded unless `includeAuth: true`.
 */
export function exportGatewayBundle(
  store: GatewayStore,
  options: ExportBundleOptions = {},
): GatewayBackupBundle {
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    ...(options.gatewayVersion ? { gatewayVersion: options.gatewayVersion } : {}),
    ...(store.getHomeChatId() ? { homeChatId: store.getHomeChatId() } : {}),
    sessions: store.listSessions(),
    loops: store.getLoops(),
    workspaces: store.getWorkspaces(),
    boundChannels: store.getBoundChannels(),
    ...(options.includeAuth ? { approvedSenders: store.listApprovedSenders() } : {}),
  };
}

export function validateBackupBundle(raw: unknown): GatewayBackupBundle {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid backup bundle: expected a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error(
      `Unsupported backup formatVersion: ${String(obj.formatVersion)} (expected ${BACKUP_FORMAT_VERSION})`,
    );
  }
  if (!Array.isArray(obj.sessions) || !Array.isArray(obj.loops)) {
    throw new Error("Invalid backup bundle: missing sessions or loops arrays");
  }
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: typeof obj.exportedAt === "string" ? obj.exportedAt : new Date().toISOString(),
    gatewayVersion: typeof obj.gatewayVersion === "string" ? obj.gatewayVersion : undefined,
    homeChatId: typeof obj.homeChatId === "string" ? obj.homeChatId : undefined,
    sessions: obj.sessions.filter(
      (s): s is SessionInfo =>
        Boolean(s) && typeof s === "object" && typeof (s as SessionInfo).chatId === "string",
    ),
    loops: obj.loops.filter(
      (l): l is LoopJob =>
        Boolean(l) &&
        typeof l === "object" &&
        typeof (l as LoopJob).id === "string" &&
        typeof (l as LoopJob).chatId === "string" &&
        typeof (l as LoopJob).prompt === "string",
    ),
    workspaces:
      obj.workspaces && typeof obj.workspaces === "object" && !Array.isArray(obj.workspaces)
        ? Object.fromEntries(
            Object.entries(obj.workspaces as Record<string, unknown>).filter(
              ([k, v]) => typeof k === "string" && typeof v === "string",
            ) as Array<[string, string]>,
          )
        : {},
    boundChannels: Array.isArray(obj.boundChannels)
      ? (obj.boundChannels.filter(
          (b) => Boolean(b) && typeof b === "object" && typeof (b as BoundChannelRecord).channel === "string",
        ) as BoundChannelRecord[])
      : [],
    approvedSenders: Array.isArray(obj.approvedSenders)
      ? obj.approvedSenders.filter((s): s is string => typeof s === "string")
      : undefined,
  };
}

/**
 * Import a portable backup bundle into `GatewayStore` with optional `--dry-run`
 * preview and cross-OS `--remap-cwd` rewriting.
 */
export async function importGatewayBundle(
  store: GatewayStore,
  rawBundle: unknown,
  options: ImportBundleOptions = {},
): Promise<ImportBundleSummary> {
  const bundle = validateBackupBundle(rawBundle);
  const dryRun = options.dryRun === true;
  const overwrite = options.overwrite === true;
  const rules = options.remapCwd ?? [];

  const summary: ImportBundleSummary = {
    dryRun,
    sessionsAdded: 0,
    sessionsUpdated: 0,
    sessionsSkipped: 0,
    loopsAdded: 0,
    loopsUpdated: 0,
    loopsSkipped: 0,
    workspacesImported: 0,
    approvedSendersAdded: 0,
    pathsRemapped: 0,
  };

  for (const session of bundle.sessions) {
    const existing = store.getSession(session.chatId);
    const remapped = remapDirectoryPath(session.cwd, rules);
    if (remapped.remapped) {
      summary.pathsRemapped += 1;
    }
    const nextSession: SessionInfo = {
      ...session,
      cwd: remapped.value ?? session.cwd,
    };

    if (!existing) {
      summary.sessionsAdded += 1;
      if (!dryRun) {
        await store.upsertSession(nextSession);
      }
    } else if (overwrite) {
      summary.sessionsUpdated += 1;
      if (!dryRun) {
        await store.upsertSession(nextSession);
      }
    } else {
      summary.sessionsSkipped += 1;
    }
  }

  const existingLoops = new Map(store.getLoops().map((l) => [l.id, l]));
  for (const loop of bundle.loops) {
    const existing = existingLoops.get(loop.id);
    const remapped = remapDirectoryPath(loop.cwd, rules);
    if (remapped.remapped) {
      summary.pathsRemapped += 1;
    }
    const nextLoop: LoopJob = {
      ...loop,
      ...(remapped.value !== undefined ? { cwd: remapped.value } : {}),
    };

    if (!existing) {
      summary.loopsAdded += 1;
      if (!dryRun) {
        await store.upsertLoop(nextLoop);
      }
    } else if (overwrite) {
      summary.loopsUpdated += 1;
      if (!dryRun) {
        await store.upsertLoop(nextLoop);
      }
    } else {
      summary.loopsSkipped += 1;
    }
  }

  for (const [alias, dir] of Object.entries(bundle.workspaces)) {
    const existing = store.getWorkspace(alias);
    if (existing && !overwrite) {
      continue;
    }
    const remapped = remapDirectoryPath(dir, rules);
    if (remapped.remapped) {
      summary.pathsRemapped += 1;
    }
    summary.workspacesImported += 1;
    if (!dryRun) {
      await store.setWorkspace(alias, remapped.value ?? dir);
    }
  }

  for (const binding of bundle.boundChannels) {
    if (!dryRun) {
      await store.ensureChannelBinding(binding.channel);
    }
  }

  if (bundle.homeChatId && (!store.getHomeChatId() || overwrite)) {
    if (!dryRun) {
      await store.setHomeChatId(bundle.homeChatId);
    }
  }

  if (options.includeAuth && bundle.approvedSenders) {
    for (const sender of bundle.approvedSenders) {
      if (!store.isApprovedSender(sender)) {
        summary.approvedSendersAdded += 1;
        if (!dryRun) {
          await store.addApprovedSender(sender);
        }
      }
    }
  }

  return summary;
}
