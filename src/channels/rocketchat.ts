import type { GatewayConfig, RocketChatConfig } from "../config.js";
import type { ChannelAdapter, InboundMessage, OutboundMessage } from "../types.js";
import { BaseChannelAdapter, type InboundHandler } from "./base.js";
import {
  BoundedDedupeCache,
  chunkText,
  isMentioned,
  reconnectDelayMs,
  sleepWithAbort,
} from "./utils.js";

const ROCKETCHAT_TEXT_LIMIT = 4000;

export interface RocketChatWebSocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type RocketChatWebSocketCtor = new (url: string) => RocketChatWebSocketLike;

export interface RocketChatAdapterOptions {
  fetchImpl?: typeof fetch;
  WebSocketCtor?: RocketChatWebSocketCtor;
}

interface DdpFrame {
  msg?: string;
  id?: string;
  collection?: string;
  fields?: { eventName?: string; args?: unknown[] };
  result?: { id?: string; token?: string; me?: { _id?: string; username?: string; name?: string } };
  error?: unknown;
  reason?: string;
}

interface RocketChatMessage {
  _id?: string;
  rid?: string;
  msg?: string;
  u?: { _id?: string; username?: string; name?: string };
  ts?: string | number;
  tmid?: string;
  roomType?: string;
}

interface RocketChatPostResponse {
  success?: boolean;
  message?: { _id?: string };
}

function websocketErrorText(event: unknown): string {
  if (event instanceof Error) {
    return event.message;
  }
  if (
    event &&
    typeof event === "object" &&
    "message" in event &&
    typeof (event as { message?: unknown }).message === "string"
  ) {
    return (event as { message: string }).message;
  }
  return "Rocket.Chat websocket error";
}

function resolveWebSocketCtor(): RocketChatWebSocketCtor {
  const ctor = (globalThis as { WebSocket?: RocketChatWebSocketCtor }).WebSocket;
  if (!ctor) {
    throw new Error("Rocket.Chat adapter requires a WebSocket implementation (Node 22+)");
  }
  return ctor;
}

/**
 * Rocket.Chat adapter: DDP over WebSocket for inbound (`stream-room-messages`)
 * and REST v1 for outbound (`chat.postMessage`), so it works behind NAT.
 */
export class RocketChatChannelAdapter extends BaseChannelAdapter {
  readonly name = "rocketchat";

  private readonly cfg: RocketChatConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly WebSocketCtor: RocketChatWebSocketCtor;
  private readonly groupMentionPatterns: string[];
  private readonly dedupe = new BoundedDedupeCache();

  private botUsername = "";
  private ws?: RocketChatWebSocketLike;
  private stopped = false;
  private lifecycle = new AbortController();
  private connectionLoop?: Promise<void>;

  constructor(config: GatewayConfig, options: RocketChatAdapterOptions = {}) {
    super();
    if (!config.rocketchat) {
      throw new Error("Rocket.Chat adapter requires config.rocketchat");
    }
    this.cfg = config.rocketchat;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.WebSocketCtor = options.WebSocketCtor ?? resolveWebSocketCtor();
    this.groupMentionPatterns = [...config.groupMentionPatterns];
  }

  async start(onMessage: InboundHandler): Promise<void> {
    if (this.connectionLoop) {
      return;
    }
    this.handler = onMessage;
    this.stopped = false;
    this.lifecycle = new AbortController();
    this.connectionLoop = this.runConnectionLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.lifecycle.abort();
    const ws = this.ws;
    this.ws = undefined;
    try {
      ws?.close();
    } catch {
      // already closed
    }
    const loop = this.connectionLoop;
    this.connectionLoop = undefined;
    if (loop) {
      await loop.catch(() => undefined);
    }
    this.dedupe.clear();
    this.handler = undefined;
    this.setConnected(false);
  }

  async sendMessage(msg: OutboundMessage): Promise<{ messageId?: string }> {
    let messageId: string | undefined;
    for (const chunk of chunkText(msg.text ?? "", ROCKETCHAT_TEXT_LIMIT)) {
      const payload: Record<string, unknown> = { roomId: msg.chatId, text: chunk };
      if (msg.replyToMessageId) {
        payload.tmid = msg.replyToMessageId;
      }
      const res = await this.fetchImpl(`${this.baseUrl()}/api/v1/chat.postMessage`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-User-Id": this.cfg.userId,
          "X-Auth-Token": this.cfg.authToken,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        throw new Error(`Rocket.Chat send failed with HTTP ${res.status}`);
      }
      const body = (await res.json().catch(() => ({}))) as RocketChatPostResponse;
      if (body.success === false) {
        throw new Error("Rocket.Chat send failed");
      }
      if (body.message?._id) {
        messageId = body.message._id;
      }
    }

    this.noteOutbound();
    return { messageId };
  }

  private async runConnectionLoop(): Promise<void> {
    const signal = this.lifecycle.signal;
    let attempt = 0;

    while (!this.stopped) {
      let opened = false;
      try {
        opened = await this.connectOnce();
      } catch (err) {
        if (this.stopped) {
          break;
        }
        this.noteError(err);
      }
      if (this.stopped) {
        break;
      }
      if (opened) {
        attempt = 0;
      }
      await sleepWithAbort(reconnectDelayMs(attempt), signal);
      attempt += 1;
    }
  }

  /** Resolves once the socket closes; the outer loop reconnects with backoff. */
  private connectOnce(): Promise<boolean> {
    return new Promise((resolve) => {
      let ws: RocketChatWebSocketLike;
      try {
        ws = new this.WebSocketCtor(this.webSocketUrl());
      } catch (err) {
        this.noteError(err);
        resolve(false);
        return;
      }
      this.ws = ws;
      let opened = false;
      let settled = false;
      const signal = this.lifecycle.signal;
      const settle = (): void => {
        if (!settled) {
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolve(opened);
        }
      };
      const onAbort = (): void => {
        try {
          ws.close();
        } catch {
          // already closed
        }
        settle();
      };
      signal.addEventListener("abort", onAbort, { once: true });

      ws.onopen = () => {
        if (this.stopped) {
          return;
        }
        opened = true;
        this.sendFrame(ws, { msg: "connect", version: "1", support: ["1"] });
      };
      ws.onmessage = (event) => {
        void this.handleFrame(ws, event?.data).catch((err) => this.noteError(err));
      };
      ws.onerror = (event) => {
        this.noteError(websocketErrorText(event));
      };
      ws.onclose = () => {
        if (this.ws === ws) {
          this.ws = undefined;
          this.setConnected(false);
        }
        settle();
      };

      if (this.stopped) {
        try {
          ws.close();
        } catch {
          // already closed
        }
        settle();
      }
    });
  }

  private async handleFrame(ws: RocketChatWebSocketLike, data: unknown): Promise<void> {
    const raw =
      typeof data === "string"
        ? data
        : data instanceof ArrayBuffer
          ? Buffer.from(data).toString("utf8")
          : "";
    if (!raw) {
      return;
    }

    let frame: DdpFrame;
    try {
      frame = JSON.parse(raw) as DdpFrame;
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object") {
      return;
    }

    if (frame.msg === "connected") {
      this.sendFrame(ws, {
        msg: "method",
        method: "login",
        id: "login-1",
        params: [{ resume: this.cfg.authToken }],
      });
      return;
    }
    if (frame.msg === "ping") {
      this.sendFrame(ws, { msg: "pong" });
      return;
    }
    if (frame.msg === "result" && frame.id === "login-1") {
      if (frame.error) {
        this.noteError(`Rocket.Chat login failed: ${JSON.stringify(frame.error)}`);
        try {
          ws.close();
        } catch {
          // already closed
        }
        return;
      }
      const username = frame.result?.me?.username;
      if (typeof username === "string" && username) {
        this.botUsername = username;
      }
      this.setConnected(true);
      this.sendFrame(ws, {
        msg: "method",
        method: "stream-room-messages",
        id: "sub-1",
        params: ["__my_messages__", false],
      });
      return;
    }
    if (frame.msg === "changed" && frame.collection === "stream-room-messages") {
      const message = frame.fields?.args?.[0];
      await this.handleRoomMessage(message);
      return;
    }
    if (frame.msg === "error") {
      const detail = frame.reason ?? (frame.error ? JSON.stringify(frame.error) : "unknown error");
      this.noteError(`Rocket.Chat DDP error: ${detail}`);
    }
  }

  private async handleRoomMessage(value: unknown): Promise<void> {
    if (!value || typeof value !== "object") {
      return;
    }
    const message = value as RocketChatMessage;
    const senderId = message.u?._id;
    if (!message._id || !message.rid || !senderId) {
      return;
    }
    if (senderId === this.cfg.userId) {
      return;
    }
    if (this.dedupe.seen(message._id)) {
      return;
    }

    const isGroup = message.roomType !== "d";
    const text = message.msg ?? "";
    const mentioned = isMentioned(text, this.mentionPatterns());
    if (this.cfg.requireMention && isGroup && !mentioned) {
      return;
    }

    const inbound: InboundMessage = {
      id: message._id,
      channel: this.name,
      chatId: message.rid,
      senderId,
      rawSenderId: senderId,
      isGroup,
      text,
      attachments: [],
      replyToMessageId: message.tmid || undefined,
      timestamp: this.parseTimestamp(message.ts),
      mentionsBot: mentioned,
      raw: message,
    };
    await this.emit(inbound);
  }

  private mentionPatterns(): string[] {
    const patterns = [...this.groupMentionPatterns];
    if (this.botUsername) {
      patterns.push(`@${this.botUsername}`);
    }
    return patterns;
  }

  private parseTimestamp(ts: string | number | undefined): number {
    if (typeof ts === "number") {
      return ts;
    }
    if (typeof ts === "string") {
      const parsed = Date.parse(ts);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return Date.now();
  }

  private sendFrame(ws: RocketChatWebSocketLike, frame: Record<string, unknown>): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch (err) {
      this.noteError(err);
    }
  }

  private webSocketUrl(): string {
    const raw = this.cfg.url.trim();
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    const url = new URL(withScheme);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/websocket`;
    url.search = "";
    url.hash = "";
    return url.toString();
  }

  private baseUrl(): string {
    return this.cfg.url.trim().replace(/\/+$/, "");
  }
}

export function createAdapter(config: GatewayConfig): ChannelAdapter {
  return new RocketChatChannelAdapter(config);
}