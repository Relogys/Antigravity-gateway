import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeSenderId } from "../config.js";
import type { LoopJob, SessionInfo } from "../types.js";

const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_LENGTH = 8;
const PAIRING_TTL_MS = 60 * 60 * 1000; // 1 hour
const PAIRING_RATE_LIMIT_MS = 10 * 60 * 1000; // 10 minutes per sender
const MAX_PENDING_PAIRINGS = 3;
const MAX_PAIRING_FAILED_ATTEMPTS = 5;
const PAIRING_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

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

interface PersistedState {
  version: 1;
  sessions: Record<string, SessionInfo>;
  approvedSenders: string[];
  pendingPairings: PendingPairing[];
  pairingFailedAttempts: number;
  pairingLockedUntil?: number;
  loops: LoopJob[];
  homeChatId?: string;
}

function emptyState(): PersistedState {
  return {
    version: 1,
    sessions: {},
    approvedSenders: [],
    pendingPairings: [],
    pairingFailedAttempts: 0,
    loops: [],
  };
}

function generatePairingCode(): string {
  let code = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += PAIRING_ALPHABET[crypto.randomInt(0, PAIRING_ALPHABET.length)];
  }
  return code;
}

/**
 * Atomic JSON state store persisted at `<dataDir>/state.json`.
 * Manages chat sessions, pairing allowlist/codes, scheduled loops, and home chat.
 */
export class GatewayStore {
  private readonly filePath: string;
  private state: PersistedState = emptyState();
  private saveChain: Promise<void> = Promise.resolve();

  constructor(private readonly dataDir: string) {
    this.filePath = path.join(dataDir, "state.json");
  }

  get stateFilePath(): string {
    return this.filePath;
  }

  async load(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      const approved = new Set<string>();
      for (const sender of parsed.approvedSenders ?? []) {
        const norm = normalizeSenderId(sender);
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

      this.state = {
        version: 1,
        sessions:
          parsed.sessions && typeof parsed.sessions === "object"
            ? { ...parsed.sessions }
            : {},
        approvedSenders: [...approved],
        pendingPairings: pending,
        pairingFailedAttempts:
          typeof parsed.pairingFailedAttempts === "number"
            ? parsed.pairingFailedAttempts
            : 0,
        pairingLockedUntil:
          typeof parsed.pairingLockedUntil === "number"
            ? parsed.pairingLockedUntil
            : undefined,
        loops: Array.isArray(parsed.loops) ? [...parsed.loops] : [],
        homeChatId:
          typeof parsed.homeChatId === "string" && parsed.homeChatId.length > 0
            ? parsed.homeChatId
            : undefined,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.state = emptyState();
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

  private async writeAtomic(content: string): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    const tmpName = `state.json.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    const tmpPath = path.join(this.dataDir, tmpName);
    try {
      await fs.writeFile(tmpPath, content, { encoding: "utf8", mode: 0o600 });
      await fs.rename(tmpPath, this.filePath);
    } catch (err) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
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
    const norm = normalizeSenderId(senderId);
    if (!norm) {
      return false;
    }
    return this.state.approvedSenders.includes(norm);
  }

  async addApprovedSender(senderId: string): Promise<boolean> {
    const norm = normalizeSenderId(senderId);
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
    const norm = normalizeSenderId(senderId);
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
    const norm = normalizeSenderId(senderId);
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

    const idx = this.state.pendingPairings.findIndex(
      (entry) => entry.code === normalizedCode,
    );

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

    const senderNorm = normalizeSenderId(entry.senderId);
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
