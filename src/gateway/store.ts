import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { normalizeStoreSenderKey } from "../config.js";
import type { BoundChannelRecord, LoopJob, SessionInfo } from "../types.js";

const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_LENGTH = 8;
const PAIRING_TTL_MS = 60 * 60 * 1000; // 1 hour
const PAIRING_RATE_LIMIT_MS = 10 * 60 * 1000; // 10 minutes per sender
const MAX_PENDING_PAIRINGS = 3;
const MAX_PAIRING_FAILED_ATTEMPTS = 5;
const PAIRING_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_MIN_BACKOFF_MS = 15;
const LOCK_MAX_BACKOFF_MS = 100;
const MAX_STALE_LOCK_RECOVERIES = 5;

/** Schema version of `<dataDir>/state.json` written by this build. */
export const CURRENT_STATE_VERSION = 1;

export interface PendingPairing {
  code: string;
  senderId: string;
  createdAt: number;
  expiresAt: number;
  lastNotifiedAt: number;
}

export interface PairingIssueResult {
  code?: string;
  expiresAt?: number;
  shouldNotify: boolean;
  reason: "created" | "rate_limited" | "max_pending";
}

export interface PairingApprovalResult {
  ok: boolean;
  senderId?: string;
  reason: "approved" | "invalid_code" | "expired" | "locked";
  remainingAttempts?: number;
  retryAfterMs?: number;
}

export interface PersistedState {
  version: number;
  sessions: Record<string, SessionInfo>;
  approvedSenders: string[];
  pendingPairings: PendingPairing[];
  pairingFailedAttempts: number;
  pairingLockedUntil?: number;
  loops: LoopJob[];
  homeChatId?: string;
  boundChannels: Record<string, BoundChannelRecord>;
}

class UnsupportedStateVersionError extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize a parsed `state.json` payload into the current schema shape.
 * Legacy unversioned/v0 files are lifted to {@link CURRENT_STATE_VERSION}; files
 * written by a newer build are rejected instead of being silently downgraded.
 */
export function migratePersistedState(raw: unknown): Partial<PersistedState> {
  if (!isPlainObject(raw)) {
    throw new Error("Invalid state.json: expected a JSON object");
  }

  const version = raw.version;
  if (version !== undefined && typeof version !== "number") {
    throw new Error("Invalid state.json: schema version must be a number");
  }
  if (typeof version === "number" && version > CURRENT_STATE_VERSION) {
    throw new UnsupportedStateVersionError(
      `Unsupported state.json schema version ${version} (max supported: ${CURRENT_STATE_VERSION})`,
    );
  }

  // v0 (unversioned) and v1 share the same field names; only the marker differs.
  return {
    version: CURRENT_STATE_VERSION,
    sessions: isPlainObject(raw.sessions)
      ? ({ ...raw.sessions } as Record<string, SessionInfo>)
      : {},
    approvedSenders: Array.isArray(raw.approvedSenders)
      ? raw.approvedSenders.filter((sender): sender is string => typeof sender === "string")
      : [],
    pendingPairings: Array.isArray(raw.pendingPairings)
      ? (raw.pendingPairings.filter(isPlainObject) as unknown as PendingPairing[])
      : [],
    pairingFailedAttempts:
      typeof raw.pairingFailedAttempts === "number" ? raw.pairingFailedAttempts : 0,
    pairingLockedUntil:
      typeof raw.pairingLockedUntil === "number" ? raw.pairingLockedUntil : undefined,
    loops: Array.isArray(raw.loops) ? (raw.loops.filter(isPlainObject) as unknown as LoopJob[]) : [],
    homeChatId:
      typeof raw.homeChatId === "string" && raw.homeChatId.length > 0
        ? raw.homeChatId
        : undefined,
    boundChannels: isPlainObject(raw.boundChannels)
      ? ({ ...raw.boundChannels } as Record<string, BoundChannelRecord>)
      : {},
  };
}

function emptyState(): PersistedState {
  return {
    version: CURRENT_STATE_VERSION,
    sessions: {},
    approvedSenders: [],
    pendingPairings: [],
    pairingFailedAttempts: 0,
    loops: [],
    boundChannels: {},
  };
}

function delay(ms: number): Promise<void> {
  // Lock waiting must not depend on the (possibly fake) global timer clock.
  return sleep(ms);
}

/**
 * Lock paths currently held by *this* process. A same-pid lockfile that is not
 * tracked here is a leftover from a failed cleanup and can be reclaimed.
 */
const heldLockPaths = new Set<string>();

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH is the only signal that the pid is definitively gone (EPERM => alive).
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Resolve the channel group a stored session belongs to.
 * Prefers the explicit `channelGroup`, then the `<channel>::` chatId prefix,
 * and finally "photon" for unqualified legacy Photon chat ids.
 */
function sessionChannelGroup(session: SessionInfo): string {
  if (session.channelGroup) {
    return session.channelGroup.toLowerCase();
  }
  const sepIdx = session.chatId.indexOf("::");
  if (sepIdx > 0) {
    return session.chatId.slice(0, sepIdx).toLowerCase();
  }
  return "photon";
}

function generatePairingCode(): string {
  let code = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += PAIRING_ALPHABET[crypto.randomInt(0, PAIRING_ALPHABET.length)];
  }
  return code;
}

function timingSafeCodeMatch(a: string, b: string): boolean {
  const da = crypto.createHash("sha256").update(a, "utf8").digest();
  const db = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(da, db);
}

/**
 * Atomic JSON state store persisted at `<dataDir>/state.json`.
 * Manages chat sessions, pairing allowlist/codes, scheduled loops, and home chat.
 *
 * Writes are guarded by a lightweight cross-process lockfile, keep a
 * `state.json.bak` snapshot of the previous on-disk state, and recover from a
 * corrupt/truncated primary file without losing the last good snapshot.
 */
export class GatewayStore {
  private readonly filePath: string;
  private readonly backupFilePath: string;
  private readonly lockFilePath: string;
  private state: PersistedState = emptyState();
  private saveChain: Promise<void> = Promise.resolve();
  private recoveredFromBackup = false;
  /** Snapshot content this instance last wrote successfully. */
  private lastWrittenContent?: string;
  private readonly lockContext = new AsyncLocalStorage<true>();

  constructor(private readonly dataDir: string) {
    this.filePath = path.join(dataDir, "state.json");
    this.backupFilePath = path.join(dataDir, "state.json.bak");
    this.lockFilePath = path.join(dataDir, "state.json.lock");
  }

  get stateFilePath(): string {
    return this.filePath;
  }

  get backupStateFilePath(): string {
    return this.backupFilePath;
  }

  /** True when the last {@link load} rebuilt state from `state.json.bak`. */
  wasRecoveredFromBackup(): boolean {
    return this.recoveredFromBackup;
  }

  async load(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });

    const raw = await this.readFileIfPresent(this.filePath);
    if (raw === undefined) {
      if (await this.tryRestoreBackup()) {
        return;
      }
      this.state = emptyState();
      return;
    }

    try {
      this.state = this.hydrateState(migratePersistedState(JSON.parse(raw)));
    } catch (err) {
      if (err instanceof UnsupportedStateVersionError) {
        throw err;
      }
      await this.quarantineCorruptFile();
      if (await this.tryRestoreBackup()) {
        return;
      }
      throw err;
    }
  }

  save(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2);
    const next = this.saveChain.then(() => this.writeAtomic(snapshot));
    // Keep queue alive even if one write fails
    this.saveChain = next.catch(() => {});
    return next;
  }

  /**
   * Read-modify-write a fresh snapshot under the cross-process lock so CLI
   * invocations never clobber a concurrently running daemon.
   */
  async mutateAtomic<T>(fn: () => T | Promise<T>): Promise<T> {
    await fs.mkdir(this.dataDir, { recursive: true });
    return this.withFileLock(async () => {
      await this.load();
      const result = await fn();
      await this.persistLocked(JSON.stringify(this.state, null, 2));
      return result;
    });
  }

  private hydrateState(parsed: Partial<PersistedState>): PersistedState {
    const approved = new Set<string>();
    for (const sender of parsed.approvedSenders ?? []) {
      const norm = normalizeStoreSenderKey(sender);
      if (norm) {
        approved.add(norm);
      }
    }

    const now = Date.now();
    const pending = (parsed.pendingPairings ?? []).filter(
      (entry) =>
        typeof entry?.code === "string" &&
        typeof entry?.senderId === "string" &&
        typeof entry?.expiresAt === "number" &&
        entry.expiresAt > now,
    );

    return {
      version: CURRENT_STATE_VERSION,
      sessions:
        parsed.sessions && typeof parsed.sessions === "object" ? { ...parsed.sessions } : {},
      approvedSenders: [...approved],
      pendingPairings: pending,
      pairingFailedAttempts:
        typeof parsed.pairingFailedAttempts === "number" ? parsed.pairingFailedAttempts : 0,
      pairingLockedUntil:
        typeof parsed.pairingLockedUntil === "number" ? parsed.pairingLockedUntil : undefined,
      loops: Array.isArray(parsed.loops) ? [...parsed.loops] : [],
      homeChatId:
        typeof parsed.homeChatId === "string" && parsed.homeChatId.length > 0
          ? parsed.homeChatId
          : undefined,
      boundChannels:
        parsed.boundChannels && typeof parsed.boundChannels === "object"
          ? Object.fromEntries(
              Object.entries(parsed.boundChannels).filter(
                ([, value]) =>
                  value &&
                  typeof value === "object" &&
                  typeof (value as BoundChannelRecord).channel === "string",
              ),
            )
          : {},
    };
  }

  private async readFileIfPresent(file: string): Promise<string | undefined> {
    try {
      return await fs.readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw err;
    }
  }

  /** Rebuild in-memory state from `state.json.bak`, restoring it as the primary file. */
  private async tryRestoreBackup(): Promise<boolean> {
    const raw = await this.readFileIfPresent(this.backupFilePath).catch(() => undefined);
    if (raw === undefined) {
      return false;
    }

    let migrated: Partial<PersistedState>;
    try {
      migrated = migratePersistedState(JSON.parse(raw));
    } catch {
      return false;
    }

    this.state = this.hydrateState(migrated);
    try {
      await this.writeAtomic(raw);
    } catch {
      // Recovery still succeeds in memory even if the primary file cannot be rewritten.
    }
    this.recoveredFromBackup = true;
    return true;
  }

  private async quarantineCorruptFile(): Promise<void> {
    const quarantinePath = `${this.filePath}.corrupt.${Date.now()}`;
    try {
      await fs.rename(this.filePath, quarantinePath);
    } catch {
      await fs.copyFile(this.filePath, quarantinePath).catch(() => {});
      await fs.rm(this.filePath, { force: true }).catch(() => {});
    }
  }

  private async writeAtomic(content: string): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    await this.withFileLock(() => this.persistLocked(content));
  }

  /** Must run while the state lock is held (reentrant or freshly acquired). */
  private async persistLocked(content: string): Promise<void> {
    // Keep a known-good snapshot of state written by someone else (e.g. a daemon
    // restart or another process) before overwriting it. Re-writing this
    // instance's own last snapshot does not need another rollback copy.
    const existing = await this.readFileIfPresent(this.filePath).catch(() => undefined);
    if (existing !== undefined && existing !== this.lastWrittenContent) {
      await fs.copyFile(this.filePath, this.backupFilePath).catch(() => {});
    }

    const tmpName = `state.json.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    const tmpPath = path.join(this.dataDir, tmpName);
    try {
      await fs.writeFile(tmpPath, content, { encoding: "utf8", mode: 0o600 });
      await this.renameWithRetry(tmpPath, this.filePath);
      this.lastWrittenContent = content;
    } catch (err) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
  }

  private async renameWithRetry(src: string, dest: string): Promise<void> {
    // Windows scanners can hold the destination briefly; budget ~0.4s of retries.
    const delays = [10, 25, 50, 100, 200];
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rename(src, dest);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (
          process.platform === "win32" &&
          (code === "EPERM" || code === "EBUSY" || code === "EACCES") &&
          attempt < delays.length
        ) {
          // Real time, not the global timer clock: rename retries must still
          // progress when callers (or tests) fake timers.
          await delay(delays[attempt]);
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Run `fn` while holding the cross-process state lock. Calls nested inside an
   * already-locked async context reuse that lock instead of deadlocking.
   */
  private async withFileLock<T>(
    fn: () => Promise<T>,
    options: { staleMs?: number; timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.lockContext.getStore()) {
      return fn();
    }

    const release = await this.acquireFileLock(options);
    try {
      return await this.lockContext.run(true, fn);
    } finally {
      await release();
    }
  }

  private async acquireFileLock(
    options: { staleMs?: number; timeoutMs?: number } = {},
  ): Promise<() => Promise<void>> {
    const staleMs = options.staleMs ?? LOCK_STALE_MS;
    const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
    const startedAt = Date.now();
    let waitMs = LOCK_MIN_BACKOFF_MS;
    let staleRecoveries = 0;

    for (;;) {
      let handle: FileHandle;
      try {
        handle = await fs.open(this.lockFilePath, "wx", 0o600);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          throw err;
        }
        if (await this.isLockStale(staleMs)) {
          staleRecoveries += 1;
          if (staleRecoveries > MAX_STALE_LOCK_RECOVERIES) {
            throw new Error(
              `Unable to clear stale state lock at ${this.lockFilePath}`,
            );
          }
          await this.removeLockFile();
          continue;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          throw new Error(
            `Timed out after ${timeoutMs}ms waiting for state lock at ${this.lockFilePath}`,
          );
        }
        await delay(waitMs);
        waitMs = Math.min(
          LOCK_MAX_BACKOFF_MS,
          waitMs + LOCK_MIN_BACKOFF_MS + Math.floor(Math.random() * LOCK_MIN_BACKOFF_MS),
        );
        continue;
      }

      try {
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }),
          "utf8",
        );
      } catch (err) {
        await handle.close().catch(() => {});
        await fs.rm(this.lockFilePath, { force: true }).catch(() => {});
        throw err;
      }

      heldLockPaths.add(this.lockFilePath);
      let released = false;
      return async () => {
        if (released) {
          return;
        }
        released = true;
        await handle.close().catch(() => {});
        await this.removeLockFile();
        // Only after the cleanup attempt: a same-pid lockfile that survived is
        // treated as reclaimable instead of blocking this process forever.
        heldLockPaths.delete(this.lockFilePath);
      };
    }
  }

  /** Best-effort lockfile removal; Windows can briefly refuse deletes after close. */
  private async removeLockFile(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await fs.rm(this.lockFilePath, { force: true });
        return;
      } catch {
        await delay(5);
      }
    }
  }

  private async isLockStale(staleMs: number): Promise<boolean> {
    let mtimeMs: number;
    try {
      mtimeMs = (await fs.stat(this.lockFilePath)).mtimeMs;
    } catch {
      // Lock vanished between open() and stat() — retry immediately.
      return true;
    }

    let meta: { pid?: unknown; acquiredAt?: unknown } | undefined;
    try {
      const parsed = JSON.parse(await fs.readFile(this.lockFilePath, "utf8")) as unknown;
      if (isPlainObject(parsed)) {
        meta = parsed;
      }
    } catch {
      meta = undefined;
    }

    const pid = typeof meta?.pid === "number" ? meta.pid : undefined;
    if (pid !== undefined && pid !== process.pid && !isProcessAlive(pid)) {
      return true;
    }
    // A lockfile owned by this pid but not held by any acquisition is a
    // leftover from a cleanup that could not delete it.
    if (pid === process.pid && !heldLockPaths.has(this.lockFilePath)) {
      return true;
    }

    const acquiredAt =
      typeof meta?.acquiredAt === "number" ? meta.acquiredAt : mtimeMs;
    return Date.now() - acquiredAt > staleMs;
  }

  getSession(chatId: string): SessionInfo | undefined {
    const existing = this.state.sessions[chatId];
    return existing ? { ...existing } : undefined;
  }

  listSessions(): SessionInfo[] {
    return Object.values(this.state.sessions)
      .map((s) => ({ ...s }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Sessions sorted by `updatedAt` desc, optionally filtered to a channel group.
   * A session belongs to a group via its `channelGroup`, the `<channel>::` chatId
   * prefix, or "photon" for unqualified legacy chat ids.
   */
  listSessionsByChannel(channelGroup?: string): SessionInfo[] {
    const all = this.listSessions();
    if (!channelGroup) {
      return all;
    }
    const target = channelGroup.trim().toLowerCase();
    return all.filter((session) => sessionChannelGroup(session) === target);
  }

  /**
   * Register a channel as a bound session group (idempotent). Returns whether the
   * binding was newly created so callers can log first-time bindings.
   */
  async ensureChannelBinding(
    channel: string,
  ): Promise<{ isNew: boolean; record: BoundChannelRecord }> {
    const name = channel.trim().toLowerCase();
    if (!name) {
      return {
        isNew: false,
        record: { channel: name, groupName: name, firstBoundAt: Date.now() },
      };
    }
    const existing = this.state.boundChannels[name];
    if (existing) {
      return { isNew: false, record: { ...existing } };
    }
    const record: BoundChannelRecord = {
      channel: name,
      groupName: name,
      firstBoundAt: Date.now(),
    };
    this.state.boundChannels[name] = record;
    await this.save();
    return { isNew: true, record: { ...record } };
  }

  getBoundChannels(): BoundChannelRecord[] {
    return Object.values(this.state.boundChannels).map((record) => ({ ...record }));
  }

  async upsertSession(info: SessionInfo): Promise<void> {
    this.state.sessions[info.chatId] = { ...info };
    await this.save();
  }

  async deleteSession(chatId: string): Promise<boolean> {
    if (!(chatId in this.state.sessions)) {
      return false;
    }
    delete this.state.sessions[chatId];
    await this.save();
    return true;
  }

  isApprovedSender(senderId: string): boolean {
    const norm = normalizeStoreSenderKey(senderId);
    if (!norm) {
      return false;
    }
    return this.state.approvedSenders.includes(norm);
  }

  async addApprovedSender(senderId: string): Promise<boolean> {
    const norm = normalizeStoreSenderKey(senderId);
    if (!norm) {
      return false;
    }
    if (this.state.approvedSenders.includes(norm)) {
      return false;
    }
    this.state.approvedSenders.push(norm);
    await this.save();
    return true;
  }

  async revokeApprovedSender(senderId: string): Promise<boolean> {
    const norm = normalizeStoreSenderKey(senderId);
    if (!norm) {
      return false;
    }
    const before = this.state.approvedSenders.length;
    this.state.approvedSenders = this.state.approvedSenders.filter(
      (item) => item !== norm,
    );
    if (this.state.approvedSenders.length === before) {
      return false;
    }
    await this.save();
    return true;
  }

  listApprovedSenders(): string[] {
    return [...this.state.approvedSenders];
  }

  private pruneExpiredPairings(now: number): boolean {
    const before = this.state.pendingPairings.length;
    this.state.pendingPairings = this.state.pendingPairings.filter(
      (entry) => entry.expiresAt > now,
    );
    return this.state.pendingPairings.length !== before;
  }

  async createOrGetPairing(senderId: string): Promise<PairingIssueResult> {
    const norm = normalizeStoreSenderKey(senderId);
    if (!norm) {
      return { shouldNotify: false, reason: "max_pending" };
    }

    const now = Date.now();
    const pruned = this.pruneExpiredPairings(now);

    const existing = this.state.pendingPairings.find(
      (entry) => entry.senderId === norm,
    );
    if (existing) {
      if (now - existing.lastNotifiedAt < PAIRING_RATE_LIMIT_MS) {
        if (pruned) {
          await this.save();
        }
        return {
          code: existing.code,
          expiresAt: existing.expiresAt,
          shouldNotify: false,
          reason: "rate_limited",
        };
      }
      existing.lastNotifiedAt = now;
      await this.save();
      return {
        code: existing.code,
        expiresAt: existing.expiresAt,
        shouldNotify: true,
        reason: "created",
      };
    }

    if (this.state.pendingPairings.length >= MAX_PENDING_PAIRINGS) {
      if (pruned) {
        await this.save();
      }
      return { shouldNotify: false, reason: "max_pending" };
    }

    let code = generatePairingCode();
    const existingCodes = new Set(
      this.state.pendingPairings.map((p) => p.code),
    );
    while (existingCodes.has(code)) {
      code = generatePairingCode();
    }

    const entry: PendingPairing = {
      code,
      senderId: norm,
      createdAt: now,
      expiresAt: now + PAIRING_TTL_MS,
      lastNotifiedAt: now,
    };
    this.state.pendingPairings.push(entry);
    await this.save();

    return {
      code: entry.code,
      expiresAt: entry.expiresAt,
      shouldNotify: true,
      reason: "created",
    };
  }

  async approvePairing(code: string): Promise<PairingApprovalResult> {
    const normalizedCode = code.trim().toUpperCase();
    const now = Date.now();

    if (
      this.state.pairingLockedUntil !== undefined &&
      this.state.pairingLockedUntil > now
    ) {
      return {
        ok: false,
        reason: "locked",
        retryAfterMs: this.state.pairingLockedUntil - now,
      };
    }

    if (
      this.state.pairingLockedUntil !== undefined &&
      this.state.pairingLockedUntil <= now
    ) {
      this.state.pairingLockedUntil = undefined;
      this.state.pairingFailedAttempts = 0;
    }

    let idx = -1;
    for (let i = 0; i < this.state.pendingPairings.length; i += 1) {
      if (timingSafeCodeMatch(this.state.pendingPairings[i]!.code, normalizedCode)) {
        idx = i;
      }
    }

    if (idx === -1) {
      this.pruneExpiredPairings(now);
      return await this.recordFailedApproval(now, "invalid_code");
    }

    const entry = this.state.pendingPairings[idx];
    if (entry.expiresAt <= now) {
      this.state.pendingPairings.splice(idx, 1);
      return await this.recordFailedApproval(now, "expired");
    }

    this.state.pendingPairings.splice(idx, 1);
    this.state.pairingFailedAttempts = 0;
    this.state.pairingLockedUntil = undefined;

    const senderNorm = normalizeStoreSenderKey(entry.senderId);
    if (senderNorm && !this.state.approvedSenders.includes(senderNorm)) {
      this.state.approvedSenders.push(senderNorm);
    }

    await this.save();
    return {
      ok: true,
      senderId: senderNorm || entry.senderId,
      reason: "approved",
    };
  }

  private async recordFailedApproval(
    now: number,
    baseReason: "invalid_code" | "expired",
  ): Promise<PairingApprovalResult> {
    this.state.pairingFailedAttempts += 1;
    if (this.state.pairingFailedAttempts >= MAX_PAIRING_FAILED_ATTEMPTS) {
      this.state.pairingLockedUntil = now + PAIRING_LOCKOUT_MS;
      await this.save();
      return {
        ok: false,
        reason: "locked",
        remainingAttempts: 0,
        retryAfterMs: PAIRING_LOCKOUT_MS,
      };
    }

    await this.save();
    return {
      ok: false,
      reason: baseReason,
      remainingAttempts:
        MAX_PAIRING_FAILED_ATTEMPTS - this.state.pairingFailedAttempts,
    };
  }

  listPendingPairings(): PendingPairing[] {
    const now = Date.now();
    return this.state.pendingPairings
      .filter((entry) => entry.expiresAt > now)
      .map((entry) => ({ ...entry }));
  }

  async clearPendingPairings(): Promise<number> {
    const count = this.state.pendingPairings.length;
    this.state.pendingPairings = [];
    this.state.pairingFailedAttempts = 0;
    this.state.pairingLockedUntil = undefined;
    await this.save();
    return count;
  }

  getLoops(): LoopJob[] {
    return this.state.loops.map((job) => ({ ...job }));
  }

  async upsertLoop(job: LoopJob): Promise<void> {
    const idx = this.state.loops.findIndex((item) => item.id === job.id);
    if (idx === -1) {
      this.state.loops.push({ ...job });
    } else {
      this.state.loops[idx] = { ...job };
    }
    await this.save();
  }

  async deleteLoop(id: string): Promise<boolean> {
    const before = this.state.loops.length;
    this.state.loops = this.state.loops.filter((item) => item.id !== id);
    if (this.state.loops.length === before) {
      return false;
    }
    await this.save();
    return true;
  }

  getHomeChatId(): string | undefined {
    return this.state.homeChatId;
  }

  async setHomeChatId(chatId: string | undefined): Promise<void> {
    this.state.homeChatId = chatId;
    await this.save();
  }
}