import crypto from "node:crypto";
import type {
  ApprovalMode,
  PendingPermission,
  PermissionOption,
} from "../types.js";

export type PermissionDecision = "once" | "session" | "always" | "deny";

export interface PermissionRequestInput {
  sessionId: string;
  toolCallId: string;
  title: string;
  kind?: string;
  options: PermissionOption[];
}

export type PermissionNotifyCallback = (
  perm: PendingPermission,
) => Promise<void> | void;

const SANDBOX_AUTO_ALLOW_KINDS = new Set([
  "read",
  "edit",
  "search",
  "think",
  "fetch",
]);

export function pickAllowOptionId(
  options: PermissionOption[],
  preferAlways: boolean,
): string | null {
  if (options.length === 0) {
    return null;
  }
  const preferredOrder = preferAlways
    ? ["allow_always", "allow_once"]
    : ["allow_once", "allow_always"];

  for (const kind of preferredOrder) {
    const match = options.find((opt) => opt.kind === kind);
    if (match) {
      return match.optionId;
    }
  }
  return null;
}

export function pickRejectOptionId(options: PermissionOption[]): string | null {
  for (const kind of ["reject_once", "reject_always"]) {
    const match = options.find((opt) => opt.kind === kind);
    if (match) {
      return match.optionId;
    }
  }
  return null;
}

interface StoredPermission {
  perm: PendingPermission;
  timer: NodeJS.Timeout;
  settled: boolean;
}

export class PermissionManager {
  private readonly pending = new Map<string, StoredPermission>();
  private readonly timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 5 * 60_000;
  }

  async handlePermissionRequest(
    chatId: string,
    mode: ApprovalMode,
    req: PermissionRequestInput,
    notifyCallback?: PermissionNotifyCallback,
  ): Promise<string | null> {
    if (mode === "auto") {
      return pickAllowOptionId(req.options, true);
    }

    if (mode === "sandbox") {
      const kind = req.kind?.toLowerCase();
      if (kind && SANDBOX_AUTO_ALLOW_KINDS.has(kind)) {
        return pickAllowOptionId(req.options, false);
      }
      if (!notifyCallback) {
        return pickRejectOptionId(req.options);
      }
    }

    if (!notifyCallback) {
      return pickRejectOptionId(req.options);
    }

    // Cancel any stale pending request for this chat before registering the new one
    this.cancelAllForChat(chatId);

    return new Promise<string | null>((resolvePromise) => {
      let settled = false;

      const finish = (optionId: string | null) => {
        if (settled) {
          return;
        }
        settled = true;
        const current = this.pending.get(chatId);
        if (current && current.perm.id === perm.id) {
          clearTimeout(current.timer);
          current.settled = true;
          this.pending.delete(chatId);
        }
        resolvePromise(optionId);
      };

      const perm: PendingPermission = {
        id: crypto.randomUUID(),
        chatId,
        sessionId: req.sessionId,
        toolCallId: req.toolCallId,
        title: req.title,
        kind: req.kind,
        options: req.options,
        createdAt: Date.now(),
        resolve: finish,
      };

      const timer = setTimeout(() => {
        finish(pickRejectOptionId(req.options));
      }, this.timeoutMs);
      timer.unref?.();

      this.pending.set(chatId, { perm, timer, settled: false });

      Promise.resolve(notifyCallback(perm)).catch(() => {
        finish(pickRejectOptionId(req.options));
      });
    });
  }

  resolve(chatId: string, decision: PermissionDecision): boolean {
    const entry = this.pending.get(chatId);
    if (!entry || entry.settled) {
      return false;
    }

    const { options } = entry.perm;
    let optionId: string | null;
    if (decision === "deny") {
      optionId = pickRejectOptionId(options);
    } else if (decision === "once") {
      optionId = pickAllowOptionId(options, false);
    } else {
      optionId = pickAllowOptionId(options, true);
    }

    entry.perm.resolve(optionId);
    return true;
  }

  getPending(chatId: string): PendingPermission | undefined {
    return this.pending.get(chatId)?.perm;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  cancelAllForChat(chatId: string): void {
    const entry = this.pending.get(chatId);
    if (!entry) {
      return;
    }
    entry.perm.resolve(pickRejectOptionId(entry.perm.options));
  }

  cancelAll(): void {
    for (const chatId of Array.from(this.pending.keys())) {
      this.cancelAllForChat(chatId);
    }
  }
}
