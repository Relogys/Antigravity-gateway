import { randomUUID } from "node:crypto";

const DEFAULT_SILENCE_THRESHOLD_MS = 10 * 60 * 1000;
const DEFAULT_PROBE_INTERVAL_MS = 60 * 1000;
const DEFAULT_PROBE_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 180 * 1000;

export type ProbeOutcome =
  | "ok"
  | "skipped"
  | "zombie"
  | "offline"
  | "heartbeat_timeout";

export interface StreamStalenessWatchdogOptions {
  silenceThresholdMs?: number;
  probeIntervalMs?: number;
  probeCooldownMs?: number;
  probeSpaceId?: string;
  /** Transport heartbeat timeout in ms (default 180_000; 0 disables the probe). */
  heartbeatTimeoutMs?: number;
  probeFn: (spaceId: string, probeMessageId: string) => Promise<unknown>;
  onZombieDetected: (info: {
    silentMs: number;
    probeMessageId: string;
    spaceId: string;
  }) => void | Promise<void>;
  onHeartbeatTimeout?: (info: {
    silentHeartbeatMs: number;
  }) => void | Promise<void>;
  nowFn?: () => number;
}

const NOT_FOUND_ERROR_RE =
  /\bnot[_\s-]?found\b|\b5\s+not_found\b|\bdoes not exist\b|\bmissing\b|\b404\b/i;

const TRANSPORT_OFFLINE_RE =
  /\b(unavailable|deadline_exceeded|timed?\s*out|econnrefused|econnreset|enotfound|etimedout|ehostunreach|network|socket|disconnected|unauthenticated|permission_denied|cancelled|canceled|aborted)\b/i;

/**
 * Classify a probe rejection:
 * - Application-level "not found" proves the gRPC unary channel is alive while
 *   the inbound stream stayed silent (zombie half-open stream).
 * - Network/auth/timeout failures indicate an offline/reconnecting transport
 *   and must not trigger a zombie restart.
 */
export function isProbeChannelAliveRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return NOT_FOUND_ERROR_RE.test(String(error ?? ""));
  }

  const record = error as {
    code?: unknown;
    status?: unknown;
    message?: unknown;
    name?: unknown;
  };
  const code = record.code;
  const status = record.status;
  const msg = String(record.message ?? "");

  // gRPC status 5 = NOT_FOUND
  if (code === 5 || status === 5 || code === "NOT_FOUND") {
    return true;
  }

  // gRPC transport/auth codes (UNAVAILABLE=14, DEADLINE_EXCEEDED=4, UNAUTHENTICATED=16, CANCELLED=1)
  if (code === 14 || code === 4 || code === 16 || code === 1) {
    return false;
  }

  if (NOT_FOUND_ERROR_RE.test(msg)) {
    return true;
  }

  if (TRANSPORT_OFFLINE_RE.test(msg) || TRANSPORT_OFFLINE_RE.test(String(code ?? ""))) {
    return false;
  }

  return false;
}

/**
 * Detects half-open / zombie gRPC inbound streams by running a lightweight unary
 * lookup when the stream stays silent beyond `silenceThresholdMs`.
 */
export class StreamStalenessWatchdog {
  private readonly silenceThresholdMs: number;
  private readonly probeIntervalMs: number;
  private readonly probeCooldownMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly probeFn: StreamStalenessWatchdogOptions["probeFn"];
  private readonly onZombieDetected: StreamStalenessWatchdogOptions["onZombieDetected"];
  private readonly onHeartbeatTimeout?: StreamStalenessWatchdogOptions["onHeartbeatTimeout"];
  private readonly nowFn: () => number;

  private probeSpaceId?: string;
  private lastInboundAt: number;
  private lastHeartbeatAt: number;
  private lastHeartbeatTimeoutAt?: number;
  private lastProbeAt?: number;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private checking = false;

  constructor(options: StreamStalenessWatchdogOptions) {
    this.silenceThresholdMs =
      options.silenceThresholdMs ?? DEFAULT_SILENCE_THRESHOLD_MS;
    this.probeIntervalMs = options.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    this.probeCooldownMs = options.probeCooldownMs ?? DEFAULT_PROBE_COOLDOWN_MS;
    this.heartbeatTimeoutMs =
      options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.probeSpaceId = options.probeSpaceId;
    this.probeFn = options.probeFn;
    this.onZombieDetected = options.onZombieDetected;
    this.onHeartbeatTimeout = options.onHeartbeatTimeout;
    this.nowFn = options.nowFn ?? Date.now;
    this.lastInboundAt = this.nowFn();
    this.lastHeartbeatAt = this.nowFn();
  }

  recordInbound(at?: number): void {
    this.lastInboundAt = at ?? this.nowFn();
  }

  /**
   * Records a transport heartbeat. This intentionally does NOT touch
   * `lastInboundAt`: a half-open stream can keep pulsing heartbeats while
   * dropping inbound messages, so inbound-silence detection must stay armed.
   */
  recordHeartbeat(at?: number): void {
    this.lastHeartbeatAt = at ?? this.nowFn();
  }

  setProbeSpaceId(spaceId: string): void {
    if (spaceId.trim()) {
      this.probeSpaceId = spaceId.trim();
    }
  }

  getState(): {
    lastInboundAt: number;
    lastHeartbeatAt: number;
    lastProbeAt?: number;
    probeSpaceId?: string;
    running: boolean;
  } {
    return {
      lastInboundAt: this.lastInboundAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastProbeAt: this.lastProbeAt,
      probeSpaceId: this.probeSpaceId,
      running: this.running,
    };
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.lastInboundAt = this.nowFn();
    this.lastHeartbeatAt = this.nowFn();
    this.timer = setInterval(() => {
      void this.checkOnce();
    }, this.probeIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async checkOnce(): Promise<ProbeOutcome> {
    if (this.checking) {
      return "skipped";
    }

    const now = this.nowFn();

    // Cold-start & transport protection: fire even before probeSpaceId is known,
    // since a gateway that never received an inbound message still needs to
    // notice a dead heartbeat stream.
    if (this.heartbeatTimeoutMs > 0) {
      const silentHeartbeatMs = now - this.lastHeartbeatAt;
      if (silentHeartbeatMs >= this.heartbeatTimeoutMs) {
        if (
          this.lastHeartbeatTimeoutAt !== undefined &&
          now - this.lastHeartbeatTimeoutAt < this.probeCooldownMs
        ) {
          return "skipped";
        }
        this.lastHeartbeatTimeoutAt = now;
        if (this.onHeartbeatTimeout) {
          await this.onHeartbeatTimeout({ silentHeartbeatMs });
        } else {
          await this.onZombieDetected({
            silentMs: silentHeartbeatMs,
            probeMessageId: `heartbeat-${randomUUID()}`,
            spaceId: this.probeSpaceId ?? "",
          });
        }
        return "heartbeat_timeout";
      }
    }

    const spaceId = this.probeSpaceId;
    if (!spaceId) {
      return "skipped";
    }

    const silentMs = now - this.lastInboundAt;
    if (silentMs < this.silenceThresholdMs) {
      return "ok";
    }

    if (
      this.lastProbeAt !== undefined &&
      now - this.lastProbeAt < this.probeCooldownMs
    ) {
      return "skipped";
    }

    this.checking = true;
    this.lastProbeAt = now;
    const probeMessageId = `probe-${randomUUID()}`;

    try {
      await this.probeFn(spaceId, probeMessageId);
      // Probe resolved on a healthy unary channel while stream stayed silent.
      await this.onZombieDetected({ silentMs, probeMessageId, spaceId });
      return "zombie";
    } catch (error) {
      if (isProbeChannelAliveRejection(error)) {
        await this.onZombieDetected({ silentMs, probeMessageId, spaceId });
        return "zombie";
      }
      return "offline";
    } finally {
      this.checking = false;
    }
  }
}
