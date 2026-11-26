import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GatewayConfig } from "../config.js";
import type {
  AttachmentKind,
  ChannelAdapter,
  InboundAttachment,
  OutboundAttachment,
  OutboundMessage,
} from "../types.js";
import { BaseChannelAdapter, type InboundHandler } from "./base.js";
import {
  BoundedDedupeCache,
  chunkText,
  downloadToBuffer,
  errorMessage,
  isMentioned,
  reconnectDelayMs,
  saveInboundMedia,
  sleepWithAbort,
} from "./utils.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const MAX_TEXT = 3500;
const WS_OPEN = 1;

/** Minimal WebSocket surface used here (satisfied by the Node >= 22 global `WebSocket`). */
export interface OneBotSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: any) => void): void;
}
export type OneBotWebSocketCtor = new (url: string) => OneBotSocketLike;

export interface OneBotAdapterOptions {
  WebSocketCtor?: OneBotWebSocketCtor;
  /** Reconnect delay override (defaults to exponential `reconnectDelayMs`). */
  reconnectDelay?: (attempt: number) => number;
  /** Max wait in `start()` for the first connection before returning (default 10s). */
  startupTimeoutMs?: number;
  /** API call timeout (default 15s). */
  actionTimeoutMs?: number;
  /** Media downloader (defaults to `downloadToBuffer`). */
  download?: (url: string) => Promise<Buffer>;
  mediaDir?: string;
}

export interface OneBotSegment {
  type: string;
  data: Record<string, any>;
}

export interface ParsedCqMessage {
  text: string;
  mentionsBot: boolean;
  mentionsAll: boolean;
  replyToMessageId?: string;
  attachments: Array<{ type: AttachmentKind; url?: string; file?: string; name?: string }>;
}

function unescapeCqText(s: string): string {
  return s.replace(/&#91;/g, "[").replace(/&#93;/g, "]").replace(/&amp;/g, "&");
}

function unescapeCqParam(s: string): string {
  return unescapeCqText(s.replace(/&#44;/g, ","));
}

/** Convert a CQ-code string (`hi [CQ:at,qq=1] [CQ:image,url=...]`) into OneBot segments. */
export function cqStringToSegments(raw: string): OneBotSegment[] {
  const segments: OneBotSegment[] = [];
  const re = /\[CQ:([A-Za-z0-9_]+)((?:,[^,\]]*)*)\]/g;
  let last = 0;
  let match: RegExpExecArray | null = re.exec(raw);
  while (match !== null) {
    if (match.index > last) {
      segments.push({ type: "text", data: { text: unescapeCqText(raw.slice(last, match.index)) } });
    }
    const data: Record<string, string> = {};
    for (const part of match[2].split(",").filter(Boolean)) {
      const eq = part.indexOf("=");
      if (eq > 0) {
        data[part.slice(0, eq)] = unescapeCqParam(part.slice(eq + 1));
      }
    }
    segments.push({ type: match[1], data });
    last = match.index + match[0].length;
    match = re.exec(raw);
  }
  if (last < raw.length) {
    segments.push({ type: "text", data: { text: unescapeCqText(raw.slice(last)) } });
  }
  return segments;
}

/**
 * Parse an OneBot v11 message — either the CQ-code string format or the array segment
 * format — into plain text, mention flags, reply target and media attachments.
 */
export function parseCqMessage(
  rawOrSegments: string | OneBotSegment[] | undefined | null,
  selfId?: string | number,
): ParsedCqMessage {
  const segments: OneBotSegment[] =
    typeof rawOrSegments === "string"
      ? cqStringToSegments(rawOrSegments)
      : Array.isArray(rawOrSegments)
        ? rawOrSegments
        : [];
  const self = selfId === undefined || selfId === "" ? undefined : String(selfId);

  let text = "";
  let mentionsBot = false;
  let mentionsAll = false;
  let replyToMessageId: string | undefined;
  const attachments: ParsedCqMessage["attachments"] = [];

  for (const seg of segments) {
    const data = seg?.data ?? {};
    switch (seg?.type) {
      case "text":
        text += String(data.text ?? "");
        break;
      case "at": {
        const qq = String(data.qq ?? "");
        if (qq === "all") {
          mentionsAll = true;
        } else if (self && qq === self) {
          mentionsBot = true;
        } else if (qq) {
          text += `@${qq}`;
        }
        break;
      }
      case "reply":
        if (data.id !== undefined && data.id !== "") {
          replyToMessageId = String(data.id);
        }
        break;
      case "image":
        attachments.push({
          type: "image",
          url: typeof data.url === "string" ? data.url : undefined,
          file: typeof data.file === "string" ? data.file : undefined,
          name: typeof data.file === "string" ? data.file : undefined,
        });
        break;
      case "record":
        attachments.push({ type: "audio", url: data.url, file: data.file, name: data.file });
        break;
      case "video":
        attachments.push({ type: "video", url: data.url, file: data.file, name: data.file });
        break;
      case "file":
        attachments.push({
          type: "file",
          url: data.url,
          file: data.file,
          name: data.name ?? data.file,
        });
        break;
      default:
        break;
    }
  }
  return {
    text: text.replace(/[ \t]{2,}/g, " ").trim(),
    mentionsBot,
    mentionsAll,
    replyToMessageId,
    attachments,
  };
}

/** Encode/decode the RAW chat id used by this adapter. */
export function encodeOneBotChatId(kind: "private" | "group", id: string | number): string {
  return `${kind}:${id}`;
}

export function decodeOneBotChatId(chatId: string): { kind: "private" | "group"; id: string } {
  const idx = chatId.indexOf(":");
  if (idx > 0) {
    const kind = chatId.slice(0, idx);
    if (kind === "private" || kind === "group") {
      return { kind, id: chatId.slice(idx + 1) };
    }
  }
  return { kind: "private", id: chatId };
}

function numericId(id: string): number | string {
  const n = Number(id);
  return Number.isSafeInteger(n) ? n : id;
}

function looksLikeImage(att: OutboundAttachment): boolean {
  if (att.mimeType?.startsWith("image/")) {
    return true;
  }
  return /\.(png|jpe?g|gif|webp|bmp)(\?|$)/i.test(att.name ?? att.path ?? att.url ?? "");
}

interface PendingAction {
  resolve: (data: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class OneBotChannelAdapter extends BaseChannelAdapter {
  readonly name = "onebot";

  private readonly dedupe = new BoundedDedupeCache();
  private readonly pending = new Map<string, PendingAction>();
  private readonly mediaDir: string;
  private abort?: AbortController;
  private socket?: OneBotSocketLike;
  private selfId?: string;

  constructor(
    private readonly config: GatewayConfig,
    private readonly options: OneBotAdapterOptions = {},
  ) {
    super();
    this.selfId = config.onebot?.selfId;
    this.mediaDir = options.mediaDir ?? path.join(config.dataDir, "media");
  }

  /** Build the connection URL (`?access_token=` appended when configured). */
  buildUrl(): string {
    const cfg = this.config.onebot;
    if (!cfg) {
      throw new Error("OneBot is not configured (ONEBOT_WS_URL)");
    }
    if (!cfg.accessToken) {
      return cfg.wsUrl;
    }
    const url = new URL(cfg.wsUrl);
    if (!url.searchParams.has("access_token")) {
      url.searchParams.set("access_token", cfg.accessToken);
    }
    return url.toString();
  }

  async start(onMessage: InboundHandler): Promise<void> {
    const url = this.buildUrl();
    this.handler = onMessage;
    this.abort = new AbortController();
    const signal = this.abort.signal;

    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    void this.runLoop(url, signal, markReady);

    const timeoutMs = this.options.startupTimeoutMs ?? 10_000;
    await Promise.race([ready, sleepWithAbort(timeoutMs, signal)]);
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    this.abort = undefined;
    this.setConnected(false);
    try {
      this.socket?.close(1000, "shutdown");
    } catch {
      // ignore
    }
    this.socket = undefined;
    this.failPending(new Error("OneBot adapter stopped"));
    this.handler = undefined;
  }

  private async runLoop(url: string, signal: AbortSignal, markReady: () => void): Promise<void> {
    let attempt = 0;
    while (!signal.aborted) {
      const opened = await this.connectOnce(url, signal, markReady);
      if (opened) {
        attempt = 0;
      }
      if (signal.aborted) {
        break;
      }
      const delay = this.options.reconnectDelay?.(attempt) ?? reconnectDelayMs(attempt);
      attempt += 1;
      await sleepWithAbort(delay, signal);
    }
  }

  /** Resolves (true if the socket ever opened) when the socket closes. */
  private connectOnce(url: string, signal: AbortSignal, markReady: () => void): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const Ctor = this.options.WebSocketCtor ?? ((globalThis as any).WebSocket as OneBotWebSocketCtor);
      if (!Ctor) {
        this.noteError("No WebSocket implementation available (Node >= 22 required)");
        resolve(false);
        return;
      }
      let ws: OneBotSocketLike;
      try {
        ws = new Ctor(url);
      } catch (err) {
        this.noteError(err);
        resolve(false);
        return;
      }
      this.socket = ws;
      let opened = false;
      let done = false;
      const finish = () => {
        if (done) {
          return;
        }
        done = true;
        signal.removeEventListener("abort", onAbort);
        if (this.socket === ws) {
          this.socket = undefined;
          this.setConnected(false);
        }
        this.failPending(new Error("OneBot connection closed"));
        resolve(opened);
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
        opened = true;
        this.setConnected(true);
        markReady();
      });
      ws.addEventListener("message", (ev: any) => {
        void this.handleFrame(ev?.data).catch((err) => this.noteError(err));
      });
      ws.addEventListener("error", (ev: any) => {
        this.noteError(ev?.message ?? ev?.error ?? "OneBot WebSocket error");
      });
      ws.addEventListener("close", finish);
    });
  }

  private failPending(err: Error): void {
    for (const [echo, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(echo);
    }
  }

  /** Handle one raw WebSocket frame (API response or event). Exposed for tests. */
  async handleFrame(raw: unknown): Promise<void> {
    const text = typeof raw === "string" ? raw : Buffer.from(raw as ArrayBuffer).toString("utf8");
    let frame: any;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (frame && frame.echo !== undefined && this.pending.has(String(frame.echo))) {
      const p = this.pending.get(String(frame.echo)) as PendingAction;
      this.pending.delete(String(frame.echo));
      clearTimeout(p.timer);
      if (frame.status === "ok" || frame.retcode === 0) {
        p.resolve(frame.data);
      } else {
        p.reject(
          new Error(
            `OneBot action failed (retcode ${frame.retcode}): ${frame.wording ?? frame.message ?? frame.msg ?? "unknown"}`,
          ),
        );
      }
      return;
    }
    if (frame?.self_id !== undefined && !this.selfId) {
      this.selfId = String(frame.self_id);
    }
    if (frame?.post_type === "message") {
      await this.handleMessageEvent(frame);
    }
  }

  /** Process one OneBot v11 message event. Exposed for tests. */
  async handleMessageEvent(ev: any): Promise<void> {
    if (ev?.user_id === undefined || ev.message_id === undefined) {
      return;
    }
    const self = this.config.onebot?.selfId ?? this.selfId ?? (ev.self_id !== undefined ? String(ev.self_id) : undefined);
    const senderId = String(ev.user_id);
    if (self && senderId === self) {
      return;
    }
    const isGroup = ev.message_type === "group";
    if (!isGroup && ev.message_type !== "private") {
      return;
    }
    if (isGroup && ev.group_id === undefined) {
      return;
    }
    const messageId = String(ev.message_id);
    if (this.dedupe.seen(messageId)) {
      return;
    }

    const parsed = parseCqMessage(ev.message ?? ev.raw_message, self);
    const attachments: InboundAttachment[] = [];
    for (const [i, att] of parsed.attachments.entries()) {
      const base: InboundAttachment = { type: att.type, name: att.name, url: att.url };
      if (att.url && /^https?:\/\//i.test(att.url)) {
        try {
          const data = await (this.options.download ?? downloadToBuffer)(att.url);
          const localPath = await saveInboundMedia(
            this.mediaDir,
            this.name,
            messageId,
            att.name ?? `${att.type}-${i}`,
            data,
          );
          base.localPath = localPath;
          base.sizeBytes = data.byteLength;
        } catch (err) {
          this.noteError(err);
        }
      }
      attachments.push(base);
    }

    if (!parsed.text && attachments.length === 0) {
      return;
    }
    const mentionsBot =
      !isGroup || parsed.mentionsBot || isMentioned(parsed.text, this.config.groupMentionPatterns);

    await this.emit({
      id: messageId,
      channel: this.name,
      chatId: isGroup
        ? encodeOneBotChatId("group", ev.group_id)
        : encodeOneBotChatId("private", ev.user_id),
      senderId,
      isGroup,
      text: parsed.text,
      attachments,
      replyToMessageId: parsed.replyToMessageId,
      timestamp: ev.time ? Number(ev.time) * 1000 : Date.now(),
      mentionsBot,
      raw: ev,
    });
  }

  /** Send an OneBot action and await its echo'd response. */
  async callApi(action: string, params: Record<string, unknown>): Promise<any> {
    const ws = this.socket;
    if (!ws || ws.readyState !== WS_OPEN) {
      throw new Error("OneBot WebSocket is not connected");
    }
    const echo = randomUUID();
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot action ${action} timed out`));
      }, this.options.actionTimeoutMs ?? 15_000);
      this.pending.set(echo, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ action, params, echo }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(err instanceof Error ? err : new Error(errorMessage(err)));
      }
    });
  }

  async sendMessage(msg: OutboundMessage): Promise<{ messageId?: string } | void> {
    const target = decodeOneBotChatId(msg.chatId);
    const targetParams =
      target.kind === "group"
        ? { group_id: numericId(target.id) }
        : { user_id: numericId(target.id) };
    const action = target.kind === "group" ? "send_group_msg" : "send_private_msg";

    let lastId: string | undefined;
    let replyTo = msg.replyToMessageId;
    const send = async (message: OneBotSegment[]) => {
      const data = await this.callApi(action, { ...targetParams, message });
      if (data?.message_id !== undefined) {
        lastId = String(data.message_id);
      }
    };

    for (const chunk of chunkText(msg.text ?? "", MAX_TEXT)) {
      const segs: OneBotSegment[] = [];
      if (replyTo) {
        segs.push({ type: "reply", data: { id: replyTo } });
        replyTo = undefined;
      }
      segs.push({ type: "text", data: { text: chunk } });
      await send(segs);
    }

    for (const att of msg.attachments ?? []) {
      const data = await this.loadAttachment(att);
      const b64 = `base64://${data.toString("base64")}`;
      if (looksLikeImage(att)) {
        const segs: OneBotSegment[] = [];
        if (replyTo) {
          segs.push({ type: "reply", data: { id: replyTo } });
          replyTo = undefined;
        }
        segs.push({ type: "image", data: { file: b64 } });
        await send(segs);
      } else {
        const name = att.name ?? (att.path ? path.basename(att.path) : "attachment");
        await this.callApi(
          target.kind === "group" ? "upload_group_file" : "upload_private_file",
          { ...targetParams, file: b64, name },
        );
      }
    }

    this.noteOutbound();
    return { messageId: lastId };
  }

  private async loadAttachment(att: OutboundAttachment): Promise<Buffer> {
    if (att.buffer) {
      return att.buffer;
    }
    if (att.path) {
      return readFile(att.path);
    }
    if (att.url) {
      return (this.options.download ?? downloadToBuffer)(att.url);
    }
    throw new Error("Outbound attachment has no buffer, path, or url");
  }
}

export function createAdapter(config: GatewayConfig): ChannelAdapter {
  return new OneBotChannelAdapter(config);
}
