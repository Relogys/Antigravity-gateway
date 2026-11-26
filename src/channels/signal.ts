import type { GatewayConfig } from "../config.js";
import type {
  AttachmentKind,
  ChannelAdapter,
  InboundAttachment,
  OutboundMessage,
} from "../types.js";
import { BaseChannelAdapter, type InboundHandler } from "./base.js";
import {
  BoundedDedupeCache,
  chunkText,
  isMentioned,
  reconnectDelayMs,
  sleepWithAbort,
} from "./utils.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const GROUP_PREFIX = "group:";
const MAX_TEXT_CHARS = 4000;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;

export interface SignalConfig {
  enabled: boolean;
  apiUrl: string;
  account: string;
  pollIntervalMs: number;
}

export interface SignalSocketLike {
  readonly readyState: number;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: any) => void): void;
}

export type SignalWebSocketCtor = new (url: string) => SignalSocketLike;

export interface SignalAdapterOptions {
  WebSocketCtor?: SignalWebSocketCtor;
  fetchImpl?: typeof fetch;
  /** Reconnect delay override for normal WebSocket closes (defaults to exponential backoff). */
  reconnectDelay?: (attempt: number) => number;
  /** Max wait in `start()` for the transport to come up (default 10s). */
  startupTimeoutMs?: number;
}

interface SignalAttachmentInfo {
  contentType?: string;
  filename?: string;
  size?: number;
  id?: string;
}

interface SignalGroupInfo {
  groupId?: string;
}

interface SignalDataMessage {
  timestamp?: number;
  message?: string;
  groupInfo?: SignalGroupInfo;
  attachments?: SignalAttachmentInfo[];
}

interface SignalEnvelope {
  source?: string;
  sourceNumber?: string;
  sourceUuid?: string;
  sourceName?: string;
  timestamp?: number;
  dataMessage?: SignalDataMessage;
}

interface SignalReceiveItem {
  envelope?: SignalEnvelope;
}

interface ConnectOutcome {
  opened: boolean;
  normal: boolean;
}

function signalConfigOf(config: GatewayConfig): SignalConfig | undefined {
  return (config as GatewayConfig & { signal?: SignalConfig }).signal;
}

function attachmentKindFor(mimeType: string | undefined): AttachmentKind {
  const type = (mimeType ?? "").toLowerCase();
  if (type.startsWith("image/")) {
    return "image";
  }
  if (type.startsWith("audio/")) {
    return "audio";
  }
  if (type.startsWith("video/")) {
    return "video";
  }
  return "file";
}

function websocketErrorText(event: any): string {
  if (event instanceof Error) {
    return event.message;
  }
  if (event && typeof event === "object" && typeof event.message === "string") {
    return event.message;
  }
  return "Signal WebSocket error";
}

function websocketCloseCode(event: any): number | undefined {
  return event && typeof event === "object" && typeof event.code === "number"
    ? event.code
    : undefined;
}

/**
 * Signal adapter for a self-hosted signal-cli-rest-api instance.
 *
 * Receives envelopes over the `/v1/receive/{account}` WebSocket and falls back to
 * long-polling that same endpoint when the socket fails or closes abnormally.
 */
export class SignalChannelAdapter extends BaseChannelAdapter {
  readonly name = "signal";

  private readonly cfg: SignalConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly reconnectDelay: (attempt: number) => number;
  private readonly groupMentionPatterns: string[];
  private readonly dedupe = new BoundedDedupeCache();

  private abort?: AbortController;
  private loop?: Promise<void>;
  private socket?: SignalSocketLike;

  constructor(
    private readonly config: GatewayConfig,
    private readonly options: SignalAdapterOptions = {},
  ) {
    super();
    const cfg = signalConfigOf(config);
    if (!cfg) {
      throw new Error("Signal is not configured (SIGNAL_API_URL, SIGNAL_ACCOUNT)");
    }
    this.cfg = cfg;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.reconnectDelay = options.reconnectDelay ?? ((attempt) => reconnectDelayMs(attempt));
    this.groupMentionPatterns = [...config.groupMentionPatterns];
  }

  async start(onMessage: InboundHandler): Promise<void> {
    if (this.abort) {
      return;
    }
    this.handler = onMessage;
    const abort = new AbortController();
    this.abort = abort;

    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    this.loop = this.runLoop(abort.signal, markReady);

    const timeoutMs = this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    await Promise.race([ready, sleepWithAbort(timeoutMs, abort.signal)]);
  }

  async stop(): Promise<void> {
    const abort = this.abort;
    this.abort = undefined;
    abort?.abort();
    this.setConnected(false);
    const ws = this.socket;
    this.socket = undefined;
    try {
      ws?.close(1000, "shutdown");
    } catch {
      // ignore
    }
    const loop = this.loop;
    this.loop = undefined;
    if (loop) {
      try {
        await loop;
      } catch {
        // loop errors are already recorded
      }
    }
    this.dedupe.clear();
    this.handler = undefined;
  }

  /** Receive endpoint for both polling and the derived WebSocket URL (`account` percent-encoded). */
  buildReceiveUrl(): string {
    return `${this.cfg.apiUrl.replace(/\/+$/, "")}/v1/receive/${encodeURIComponent(this.cfg.account)}`;
  }

  /** WebSocket variant of the receive endpoint (http -> ws, https -> wss). */
  buildWebSocketUrl(): string {
    const url = new URL(this.buildReceiveUrl());
    if (url.protocol === "http:") {
      url.protocol = "ws:";
    } else if (url.protocol === "https:") {
      url.protocol = "wss:";
    }
    return url.toString();
  }

  private sendUrl(): string {
    return `${this.cfg.apiUrl.replace(/\/+$/, "")}/v2/send`;
  }

  private pollIntervalMs(): number {
    const value = this.cfg.pollIntervalMs;
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_POLL_INTERVAL_MS;
  }

  private resolveWebSocketCtor(): SignalWebSocketCtor | undefined {
    return this.options.WebSocketCtor ?? (globalThis as { WebSocket?: SignalWebSocketCtor }).WebSocket;
  }

  private async runLoop(signal: AbortSignal, markReady: () => void): Promise<void> {
    let attempt = 0;
    let polling = false;
    while (!signal.aborted) {
      if (polling) {
        await this.pollLoop(signal, markReady);
        return;
      }
      const Ctor = this.resolveWebSocketCtor();
      if (!Ctor) {
        this.noteError("No WebSocket implementation available; falling back to HTTP polling");
        polling = true;
        continue;
      }
      const outcome = await this.connectOnce(Ctor, signal, markReady);
      if (signal.aborted) {
        return;
      }
      if (!outcome.normal) {
        polling = true;
        continue;
      }
      if (outcome.opened) {
        attempt = 0;
      }
      await sleepWithAbort(this.reconnectDelay(attempt), signal);
      attempt += 1;
    }
  }

  /** Resolves once the socket closes or fails; a non-normal close switches to polling. */
  private connectOnce(
    Ctor: SignalWebSocketCtor,
    signal: AbortSignal,
    markReady: () => void,
  ): Promise<ConnectOutcome> {
    return new Promise<ConnectOutcome>((resolve) => {
      let ws: SignalSocketLike;
      try {
        ws = new Ctor(this.buildWebSocketUrl());
      } catch (err) {
        this.noteError(err);
        resolve({ opened: false, normal: false });
        return;
      }
      this.socket = ws;
      let opened = false;
      let failed = false;
      let settled = false;

      const finish = (normal: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (this.socket === ws) {
          this.socket = undefined;
          this.setConnected(false);
        }
        resolve({ opened, normal: normal && !failed });
      };
      const onAbort = (): void => {
        try {
          ws.close(1000, "shutdown");
        } catch {
          // ignore
        }
        finish(true);
      };
      signal.addEventListener("abort", onAbort, { once: true });

      ws.addEventListener("open", () => {
        opened = true;
        this.setConnected(true);
        markReady();
      });
      ws.addEventListener("message", (event: any) => {
        void this.handleFrame(event?.data).catch((err) => this.noteError(err));
      });
      ws.addEventListener("error", (event: any) => {
        failed = true;
        this.noteError(websocketErrorText(event));
        try {
          ws.close();
        } catch {
          // ignore
        }
        finish(false);
      });
      ws.addEventListener("close", (event: any) => {
        finish(websocketCloseCode(event) === 1000);
      });

      if (signal.aborted) {
        onAbort();
      }
    });
  }

  private async pollLoop(signal: AbortSignal, markReady: () => void): Promise<void> {
    markReady();
    this.setConnected(true);
    while (!signal.aborted) {
      try {
        const res = await this.fetchImpl(this.buildReceiveUrl(), { method: "GET", signal });
        if (!res.ok) {
          throw new Error(`Signal receive poll failed with HTTP ${res.status}`);
        }
        const payload = (await res.json()) as unknown;
        if (signal.aborted) {
          return;
        }
        this.setConnected(true);
        await this.handlePayload(payload);
      } catch (err) {
        if (signal.aborted) {
          return;
        }
        this.noteError(err);
      }
      if (signal.aborted) {
        return;
      }
      await sleepWithAbort(this.pollIntervalMs(), signal);
    }
  }

  /** Handle one raw WebSocket frame (JSON envelope or array of envelopes). Exposed for tests. */
  async handleFrame(raw: unknown): Promise<void> {
    let text: string;
    if (typeof raw === "string") {
      text = raw;
    } else if (raw instanceof ArrayBuffer) {
      text = Buffer.from(raw).toString("utf8");
    } else if (ArrayBuffer.isView(raw)) {
      text = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");
    } else if (raw && typeof raw === "object") {
      await this.handlePayload(raw);
      return;
    } else {
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return;
    }
    await this.handlePayload(payload);
  }

  private async handlePayload(payload: unknown): Promise<void> {
    const items = Array.isArray(payload) ? payload : [payload];
    for (const item of items) {
      try {
        await this.handleReceiveItem(item);
      } catch (err) {
        this.noteError(err);
      }
    }
  }

  private async handleReceiveItem(item: unknown): Promise<void> {
    if (!item || typeof item !== "object") {
      return;
    }
    const wrapper = item as SignalReceiveItem;
    const envelope =
      wrapper.envelope && typeof wrapper.envelope === "object"
        ? wrapper.envelope
        : (item as SignalEnvelope);
    await this.handleEnvelope(envelope);
  }

  private async handleEnvelope(envelope: SignalEnvelope): Promise<void> {
    const data = envelope.dataMessage;
    if (!data || typeof data !== "object") {
      return;
    }
    const sourceNumber =
      typeof envelope.sourceNumber === "string" && envelope.sourceNumber
        ? envelope.sourceNumber
        : undefined;
    const sourceUuid =
      typeof envelope.sourceUuid === "string" && envelope.sourceUuid
        ? envelope.sourceUuid
        : undefined;
    if (
      sourceNumber === this.cfg.account ||
      (!sourceNumber && envelope.source === this.cfg.account)
    ) {
      return;
    }
    const senderId = sourceNumber ?? sourceUuid;
    if (!senderId) {
      return;
    }

    const groupId =
      typeof data.groupInfo?.groupId === "string" && data.groupInfo.groupId
        ? data.groupInfo.groupId
        : undefined;
    const isGroup = groupId !== undefined;
    const chatId = isGroup ? `${GROUP_PREFIX}${groupId}` : senderId;

    const rawTimestamp = Number(data.timestamp ?? envelope.timestamp);
    const timestamp = Number.isFinite(rawTimestamp) ? rawTimestamp : Date.now();
    if (this.dedupe.seen(`${timestamp}:${senderId}`)) {
      return;
    }

    const text = typeof data.message === "string" ? data.message : "";
    const attachments: InboundAttachment[] = [];
    for (const att of data.attachments ?? []) {
      if (!att || typeof att !== "object") {
        continue;
      }
      attachments.push({
        type: attachmentKindFor(att.contentType),
        name: typeof att.filename === "string" ? att.filename : undefined,
        mimeType: typeof att.contentType === "string" ? att.contentType : undefined,
        sizeBytes: typeof att.size === "number" ? att.size : undefined,
      });
    }
    if (!text.trim() && attachments.length === 0) {
      return;
    }

    await this.emit({
      id: `${timestamp}:${senderId}`,
      channel: this.name,
      chatId,
      senderId,
      isGroup,
      text,
      attachments,
      timestamp,
      mentionsBot: !isGroup || isMentioned(text, this.groupMentionPatterns),
      raw: envelope,
    });
  }

  async sendMessage(msg: OutboundMessage): Promise<{ messageId?: string } | void> {
    const chunks = chunkText(msg.text ?? "", MAX_TEXT_CHARS);
    if (chunks.length === 0) {
      return;
    }
    const recipients = [
      msg.chatId.startsWith(GROUP_PREFIX) ? msg.chatId.slice(GROUP_PREFIX.length) : msg.chatId,
    ];

    let messageId: string | undefined;
    for (const chunk of chunks) {
      const res = await this.postSend(chunk, recipients);
      const body = (await res.json().catch(() => undefined)) as
        | { timestamp?: string | number }
        | undefined;
      if (body?.timestamp !== undefined) {
        messageId = String(body.timestamp);
      }
    }

    this.noteOutbound();
    return messageId !== undefined ? { messageId } : undefined;
  }

  private async postSend(message: string, recipients: string[]): Promise<Response> {
    let res: Response;
    const signal = this.abort
      ? AbortSignal.any([AbortSignal.timeout(15_000), this.abort.signal])
      : AbortSignal.timeout(15_000);
    try {
      res = await this.fetchImpl(this.sendUrl(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, number: this.cfg.account, recipients }),
        signal,
      });
    } catch (err) {
      this.noteError(err);
      throw err;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const err = new Error(
        `Signal API responded HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      );
      this.noteError(err);
      throw err;
    }
    return res;
  }
}

export function createAdapter(config: GatewayConfig): ChannelAdapter {
  return new SignalChannelAdapter(config);
}