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
  reconnectDelayMs,
  sleepWithAbort,
} from "./utils.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const OAUTH_URL = "https://bots.qq.com/app/getAppAccessToken";
const API_BASE = "https://api.sgroup.qq.com";
const SANDBOX_API_BASE = "https://sandbox.api.sgroup.qq.com";
const MAX_TEXT = 2000;
const WS_OPEN = 1;
const MAX_CHAT_CACHE = 2000;

// Public Guild + direct message, group @ and C2C message intents.
const INTENTS = (1 << 30) | (1 << 25) | (1 << 12);

/** Minimal WebSocket surface implemented by the Node 24 global WebSocket. */
export interface QQBotSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: any) => void): void;
}

export type QQBotWebSocketCtor = new (url: string) => QQBotSocketLike;

export interface QQBotAdapterOptions {
  fetchImpl?: typeof fetch;
  WebSocketCtor?: QQBotWebSocketCtor;
  /** Reconnect delay override (defaults to exponential reconnectDelayMs). */
  reconnectDelay?: (attempt: number) => number;
  /** Optional heartbeat callback (the built-in timer is used when omitted). */
  onHeartbeatInterval?: (intervalMs: number, heartbeat: () => void) => void;
  /** Bounded wait for the first identified Gateway connection (default 10s). */
  startupTimeoutMs?: number;
  /** Heartbeat fallback if Hello omits heartbeat_interval (default 45s). */
  defaultHeartbeatMs?: number;
  /** Injectable timers keep heartbeat/reconnect tests deterministic. */
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  now?: () => number;
}

interface ChatState {
  lastMessageId?: string;
  sequence: number;
  outboundSequence: number;
}

interface QQApiResponse {
  id?: string;
  msg_id?: string;
  code?: number;
  message?: string;
  [key: string]: unknown;
}

function stringField(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function eventTimestamp(value: unknown): number {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds * 1000;
    }
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value * 1000;
  }
  return Date.now();
}

function attachmentKind(url: string, contentType: unknown): AttachmentKind {
  const mime = typeof contentType === "string" ? contentType : "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (/\.(png|jpe?g|gif|webp|bmp)(?:$|\?)/i.test(url)) return "image";
  if (/\.(amr|mp3|wav|ogg|silk)(?:$|\?)/i.test(url)) return "audio";
  if (/\.(mp4|mov|webm)(?:$|\?)/i.test(url)) return "video";
  return "file";
}

export class QQBotChannelAdapter extends BaseChannelAdapter {
  readonly name = "qqbot";

  private readonly dedupe = new BoundedDedupeCache();
  private readonly chats = new Map<string, ChatState>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private socket?: QQBotSocketLike;
  private abort?: AbortController;
  private heartbeat?: ReturnType<typeof setInterval>;
  private token?: { value: string; expiresAt: number };
  private tokenRequest?: Promise<string>;
  private lastSequence: number | null = null;

  constructor(
    private readonly config: GatewayConfig,
    private readonly options: QQBotAdapterOptions = {},
  ) {
    super();
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.now = options.now ?? Date.now;
  }

  private requireConfig() {
    const cfg = this.config.qqbot;
    if (!cfg) {
      throw new Error("QQBot channel is not configured (QQBOT_APP_ID / QQBOT_CLIENT_SECRET)");
    }
    return cfg;
  }

  private get apiBase(): string {
    return this.requireConfig().sandbox ? SANDBOX_API_BASE : API_BASE;
  }

  async start(onMessage: InboundHandler): Promise<void> {
    this.requireConfig();
    if (this.abort && !this.abort.signal.aborted) {
      throw new Error("QQBot adapter is already started");
    }
    this.handler = onMessage;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let startedOnce = false;
    const ready = () => {
      if (!startedOnce) {
        startedOnce = true;
        markStarted();
      }
    };
    void this.runGateway(signal, ready);
    await Promise.race([
      started,
      sleepWithAbort(this.options.startupTimeoutMs ?? 10_000, signal),
    ]);
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    this.abort = undefined;
    this.clearHeartbeat();
    this.setConnected(false);
    try {
      this.socket?.close(1000, "shutdown");
    } catch {
      // A closing socket may reject a second close; shutdown is still complete.
    }
    this.socket = undefined;
    this.handler = undefined;
  }

  /** Fetch and cache the official app access token, refreshing one minute before expiry. */
  private async getAccessToken(): Promise<string> {
    const cfg = this.requireConfig();
    if (this.token && this.token.expiresAt > this.now() + 60_000) {
      return this.token.value;
    }
    if (this.tokenRequest) {
      return this.tokenRequest;
    }
    this.tokenRequest = (async () => {
      const res = await this.fetchImpl(OAUTH_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId: cfg.appId, clientSecret: cfg.clientSecret }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json().catch(() => ({}))) as {
        access_token?: string;
        expires_in?: string | number;
        message?: string;
      };
      if (!res.ok || !body.access_token) {
        throw new Error(
          `QQBot access token request failed: ${body.message ?? `HTTP ${res.status}`}`,
        );
      }
      const expiresIn = Number(body.expires_in ?? 7200);
      if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
        throw new Error("QQBot access token response had an invalid expires_in");
      }
      const value = body.access_token;
      this.token = { value, expiresAt: this.now() + expiresIn * 1000 };
      return value;
    })();
    try {
      return await this.tokenRequest;
    } finally {
      this.tokenRequest = undefined;
    }
  }

  private async authHeaders(): Promise<Record<string, string>> {
    return { authorization: `QQBot ${await this.getAccessToken()}` };
  }

  private async gatewayUrl(): Promise<string> {
    const res = await this.fetchImpl(`${this.apiBase}/gateway`, {
      headers: await this.authHeaders(),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { url?: string; message?: string };
    if (!res.ok || !body.url || !/^wss?:\/\//i.test(body.url)) {
      throw new Error(`QQBot Gateway request failed: ${body.message ?? `HTTP ${res.status}`}`);
    }
    return body.url;
  }

  private async runGateway(signal: AbortSignal, ready: () => void): Promise<void> {
    let attempt = 0;
    while (!signal.aborted) {
      let identified = false;
      try {
        const url = await this.gatewayUrl();
        if (signal.aborted) {
          break;
        }
        identified = await this.connectOnce(url, signal, ready);
      } catch (err) {
        if (!signal.aborted) {
          this.noteError(err);
        }
      } finally {
        this.clearHeartbeat();
        if (!identified) {
          this.setConnected(false);
        }
      }
      ready();
      if (signal.aborted) {
        break;
      }
      if (identified) {
        attempt = 0;
      }
      const delay = this.options.reconnectDelay?.(attempt) ?? reconnectDelayMs(attempt);
      attempt += 1;
      await sleepWithAbort(delay, signal);
    }
  }

  /** Resolve true if Hello/Identify completed before the socket closed. */
  private connectOnce(url: string, signal: AbortSignal, ready: () => void): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const Ctor =
        this.options.WebSocketCtor ??
        (globalThis.WebSocket as unknown as QQBotWebSocketCtor | undefined);
      if (!Ctor) {
        this.noteError("No WebSocket implementation available (Node 24 required)");
        ready();
        resolve(false);
        return;
      }
      let ws: QQBotSocketLike;
      try {
        ws = new Ctor(url);
      } catch (err) {
        this.noteError(err);
        ready();
        resolve(false);
        return;
      }
      this.socket = ws;
      let identified = false;
      let finished = false;
      const finish = () => {
        if (finished) {
          return;
        }
        finished = true;
        signal.removeEventListener("abort", onAbort);
        this.clearHeartbeat();
        if (this.socket === ws) {
          this.socket = undefined;
          this.setConnected(false);
        }
        ready();
        resolve(identified);
      };
      const onAbort = () => {
        try {
          ws.close(1000, "shutdown");
        } catch {
          // ignore
        }
        finish();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      ws.addEventListener("open", () => {
        if (signal.aborted) {
          finish();
        }
      });
      ws.addEventListener("message", (event: any) => {
        void this.handleSocketFrame(event?.data, ws, signal)
          .then((helloIdentified) => {
            if (helloIdentified) {
              identified = true;
              ready();
            }
          })
          .catch((err) => this.noteError(err));
      });
      ws.addEventListener("error", (event: any) => {
        this.noteError(event?.message ?? event?.error ?? "QQBot WebSocket error");
      });
      ws.addEventListener("close", finish);
    });
  }

  private clearHeartbeat(): void {
    if (this.heartbeat !== undefined) {
      (this.options.clearInterval ?? globalThis.clearInterval)(this.heartbeat as never);
      this.heartbeat = undefined;
    }
  }

  private startHeartbeat(intervalMs: number, ws: QQBotSocketLike, signal: AbortSignal): void {
    this.clearHeartbeat();
    const delay = Math.max(1000, intervalMs || this.options.defaultHeartbeatMs || 45_000);
    const heartbeat = () => {
      if (signal.aborted || ws.readyState !== WS_OPEN) {
        return;
      }
      try {
        ws.send(JSON.stringify({ op: 1, d: this.lastSequence }));
      } catch (err) {
        this.noteError(err);
      }
    };
    if (this.options.onHeartbeatInterval) {
      this.options.onHeartbeatInterval(delay, heartbeat);
      return;
    }
    const setIntervalImpl = this.options.setInterval ?? globalThis.setInterval;
    this.heartbeat = setIntervalImpl(heartbeat, delay);
    const timer = this.heartbeat as unknown as { unref?: () => void };
    timer.unref?.();
  }

  private sendIdentify(ws: QQBotSocketLike, token: string): void {
    ws.send(
      JSON.stringify({
        op: 2,
        d: {
          token: `QQBot ${token}`,
          intents: INTENTS,
          shard: [0, 1],
          properties: {
            os: "node",
            browser: "antigravity-gateway",
            device: "antigravity-gateway",
          },
        },
      }),
    );
  }

  /** Process a raw Gateway frame. Exposed for protocol-level tests. */
  async handleFrame(raw: unknown): Promise<void> {
    if (!this.socket) {
      throw new Error("QQBot WebSocket is not connected");
    }
    await this.handleSocketFrame(raw, this.socket, this.abort?.signal ?? new AbortController().signal);
  }

  private async handleSocketFrame(raw: unknown, ws: QQBotSocketLike, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || this.socket !== ws) {
      return false;
    }
    let text: string;
    if (typeof raw === "string") {
      text = raw;
    } else if (raw instanceof ArrayBuffer) {
      text = Buffer.from(raw).toString("utf8");
    } else if (ArrayBuffer.isView(raw)) {
      text = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");
    } else if (raw instanceof Blob) {
      text = await raw.text();
    } else {
      return false;
    }

    let frame: any;
    try {
      frame = JSON.parse(text);
    } catch {
      return false;
    }
    if (!frame || typeof frame.op !== "number") {
      return false;
    }
    if (typeof frame.s === "number") {
      this.lastSequence = frame.s;
    }

    switch (frame.op) {
      case 10: {
        const token = await this.getAccessToken();
        if (signal.aborted || this.socket !== ws) {
          return false;
        }
        const interval = Number(frame.d?.heartbeat_interval);
        this.startHeartbeat(Number.isFinite(interval) ? interval : this.options.defaultHeartbeatMs ?? 45_000, ws, signal);
        this.sendIdentify(ws, token);
        this.setConnected(true);
        return true;
      }
      case 0:
        if (frame.t === "READY") {
          this.setConnected(true);
        } else {
          await this.handleDispatch(frame.t, frame.d);
        }
        return false;
      case 11:
        return false;
      case 7:
        // Reconnect: closing causes the single run loop to back off.
        try {
          ws.close(1012, "QQBot Gateway requested reconnect");
        } catch (err) {
          this.noteError(err);
        }
        return false;
      case 9:
        try {
          ws.close(1012, "QQBot invalid session");
        } catch (err) {
          this.noteError(err);
        }
        return false;
      default:
        return false;
    }
  }

  /** Process a QQ message dispatch event. Exposed for tests. */
  async handleDispatch(type: unknown, data: any): Promise<void> {
    if (typeof type !== "string" || !data || typeof data !== "object") {
      return;
    }
    let chatId: string;
    let senderId: string;
    let isGroup: boolean;
    switch (type) {
      case "C2C_MESSAGE_CREATE": {
        const openid = stringField(data.author?.user_openid ?? data.author?.id);
        if (!openid) return;
        chatId = `c2c:${openid}`;
        senderId = openid;
        isGroup = false;
        break;
      }
      case "GROUP_AT_MESSAGE_CREATE": {
        const groupOpenId = stringField(data.group_openid);
        senderId = stringField(data.author?.member_openid ?? data.author?.user_openid ?? data.author?.id);
        if (!groupOpenId || !senderId) return;
        chatId = `group:${groupOpenId}`;
        isGroup = true;
        break;
      }
      case "AT_MESSAGE_CREATE": {
        const channelId = stringField(data.channel_id);
        senderId = stringField(data.author?.id);
        if (!channelId || !senderId) return;
        chatId = `channel:${channelId}`;
        isGroup = true;
        break;
      }
      default:
        return;
    }
    const id = stringField(data.id);
    if (!id || this.dedupe.seen(id)) {
      return;
    }
    const state = this.rememberChat(chatId);
    state.lastMessageId = id;
    state.sequence += 1;

    let text = typeof data.content === "string" ? data.content.trim() : "";
    const attachments: InboundAttachment[] = [];
    for (const item of Array.isArray(data.attachments) ? data.attachments : []) {
      const rawUrl = stringField(item?.url);
      if (!rawUrl) continue;
      const url = rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
      if (!/^https?:\/\//i.test(url)) continue;
      attachments.push({
        type: attachmentKind(url, item.content_type),
        url,
        name: stringField(item.filename) || undefined,
        mimeType: typeof item.content_type === "string" ? item.content_type : undefined,
        sizeBytes: Number(item.size) > 0 ? Number(item.size) : undefined,
      });
    }
    if (!text && attachments.length === 0) {
      return;
    }

    await this.emit({
      id,
      channel: this.name,
      chatId,
      senderId,
      isGroup,
      text,
      attachments,
      timestamp: eventTimestamp(data.timestamp),
      mentionsBot: true,
      raw: data,
    });
  }

  private rememberChat(chatId: string): ChatState {
    let state = this.chats.get(chatId);
    if (!state) {
      state = { sequence: 0, outboundSequence: 0 };
    }
    this.chats.delete(chatId);
    this.chats.set(chatId, state);
    while (this.chats.size > MAX_CHAT_CACHE) {
      const oldest = this.chats.keys().next().value;
      if (oldest === undefined) break;
      this.chats.delete(oldest);
    }
    return state;
  }

  private outboundTarget(chatId: string): { pathname: string; passive: boolean } {
    const separator = chatId.indexOf(":");
    const kind = separator > 0 ? chatId.slice(0, separator) : "c2c";
    const id = separator > 0 ? chatId.slice(separator + 1) : chatId;
    if (!id) {
      throw new Error("QQBot chat id is empty");
    }
    const encoded = encodeURIComponent(id);
    switch (kind) {
      case "c2c":
        return { pathname: `/v2/users/${encoded}/messages`, passive: true };
      case "group":
        return { pathname: `/v2/groups/${encoded}/messages`, passive: true };
      case "channel":
        return { pathname: `/channels/${encoded}/messages`, passive: false };
      default:
        throw new Error(`QQBot chat id must start with c2c:, group:, or channel: (${kind})`);
    }
  }

  async sendMessage(msg: OutboundMessage): Promise<{ messageId?: string } | void> {
    if ((msg.attachments ?? []).length > 0) {
      throw new Error("QQBot outbound attachments require a separate media upload and are not supported");
    }
    const target = this.outboundTarget(msg.chatId);
    const state = this.rememberChat(msg.chatId);
    let lastId: string | undefined;
    for (const chunk of chunkText(msg.text ?? "", MAX_TEXT)) {
      const body: Record<string, unknown> = {
        content: chunk,
        msg_type: 0,
        msg_seq: ++state.outboundSequence,
      };
      if (msg.markdown) {
        body.msg_type = 2;
        body.markdown = { content: chunk };
      }
      if (target.passive) {
        const messageId = msg.replyToMessageId || state.lastMessageId;
        if (!messageId) {
          throw new Error("QQBot passive reply requires an earlier msg_id or replyToMessageId");
        }
        body.msg_id = messageId;
      }
      const res = await this.fetchImpl(`${this.apiBase}${target.pathname}`, {
        method: "POST",
        headers: {
          ...(await this.authHeaders()),
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      const responseBody = (await res.json().catch(() => ({}))) as QQApiResponse;
      if (!res.ok || (typeof responseBody.code === "number" && responseBody.code !== 0)) {
        throw new Error(
          `QQBot message send failed: ${responseBody.message ?? `HTTP ${res.status}`}`,
        );
      }
      lastId = stringField(responseBody.id || responseBody.msg_id) || lastId;
    }
    this.noteOutbound();
    return { messageId: lastId };
  }
}

export function createAdapter(config: GatewayConfig): ChannelAdapter {
  return new QQBotChannelAdapter(config);
}
