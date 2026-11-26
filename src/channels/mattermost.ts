import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GatewayConfig, MattermostConfig } from "../config.js";
import type {
  AttachmentKind,
  ChannelAdapter,
  InboundAttachment,
  InboundMessage,
  OutboundAttachment,
  OutboundMessage,
} from "../types.js";
import { BaseChannelAdapter, type InboundHandler } from "./base.js";
import {
  BoundedDedupeCache,
  MAX_INLINE_MEDIA_BYTES,
  chunkText,
  isMentioned,
  readResponseWithinLimit,
  reconnectDelayMs,
  saveInboundMedia,
  sleepWithAbort,
} from "./utils.js";

const MATTERMOST_TEXT_LIMIT = 15_000;

export interface MattermostWebSocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type MattermostWebSocketCtor = new (url: string) => MattermostWebSocketLike;

export interface MattermostAdapterOptions {
  fetchImpl?: typeof fetch;
  WebSocketCtor?: MattermostWebSocketCtor;
}

interface MattermostPost {
  id?: string;
  channel_id?: string;
  user_id?: string;
  message?: string;
  root_id?: string;
  file_ids?: string[];
  create_at?: number;
}

interface MattermostWsFrame {
  event?: string;
  data?: {
    channel_type?: string;
    post?: string | MattermostPost;
  };
}

function attachmentKindFor(mimeType?: string): AttachmentKind {
  const type = mimeType?.toLowerCase() ?? "";
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

function filenameFromDisposition(header: string | null): string | undefined {
  if (!header) {
    return undefined;
  }
  const match =
    /filename\*=UTF-8''([^;]+)/i.exec(header) ??
    /filename="([^"]+)"/i.exec(header) ??
    /filename=([^;]+)/i.exec(header);
  const raw = match?.[1]?.trim();
  if (!raw) {
    return undefined;
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
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
  return "Mattermost websocket error";
}

function resolveWebSocketCtor(): MattermostWebSocketCtor {
  const ctor = (globalThis as { WebSocket?: MattermostWebSocketCtor }).WebSocket;
  if (!ctor) {
    throw new Error("Mattermost adapter requires a WebSocket implementation (Node 22+)");
  }
  return ctor;
}

export class MattermostChannelAdapter extends BaseChannelAdapter {
  readonly name = "mattermost";

  private readonly cfg: MattermostConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly WebSocketCtor: MattermostWebSocketCtor;
  private readonly mediaDir: string;
  private readonly groupMentionPatterns: string[];
  private readonly dedupe = new BoundedDedupeCache();

  private botUserId = "";
  private botUsername = "";
  private ws?: MattermostWebSocketLike;
  private stopped = false;
  private lifecycle = new AbortController();
  private connectionLoop?: Promise<void>;

  constructor(config: GatewayConfig, options: MattermostAdapterOptions = {}) {
    super();
    if (!config.mattermost) {
      throw new Error("Mattermost adapter requires config.mattermost");
    }
    this.cfg = config.mattermost;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.WebSocketCtor = options.WebSocketCtor ?? resolveWebSocketCtor();
    this.mediaDir = path.join(config.dataDir, "media");
    this.groupMentionPatterns = [...config.groupMentionPatterns];
  }

  async start(onMessage: InboundHandler): Promise<void> {
    if (this.connectionLoop) {
      return;
    }
    this.handler = onMessage;
    this.stopped = false;
    this.lifecycle = new AbortController();
    try {
      await this.ensureIdentity();
    } catch (err) {
      this.noteError(err);
    }
    if (this.stopped) {
      return;
    }
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
    this.handler = undefined;
    this.setConnected(false);
  }

  async sendMessage(msg: OutboundMessage): Promise<{ messageId?: string }> {
    const fileIds: string[] = [];
    for (const attachment of msg.attachments ?? []) {
      fileIds.push(await this.uploadAttachment(msg.chatId, attachment));
    }

    const chunks = chunkText(msg.text ?? "", MATTERMOST_TEXT_LIMIT);
    const posts = chunks.length > 0 ? chunks : fileIds.length > 0 ? [""] : [];
    let messageId: string | undefined;
    for (let i = 0; i < posts.length; i += 1) {
      messageId =
        (await this.createPost(
          msg.chatId,
          posts[i],
          i === 0 ? fileIds : [],
          msg.replyToMessageId,
        )) ?? messageId;
    }

    this.noteOutbound();
    return { messageId };
  }

  async sendTyping(chatId: string, active: boolean): Promise<void> {
    if (!active) {
      return;
    }
    const res = await this.fetchImpl(`${this.baseUrl()}/api/v4/users/me/typing`, {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ channel_id: chatId }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`Mattermost typing failed with HTTP ${res.status}`);
    }
  }

  async react(_chatId: string, messageId: string, emoji: string): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl()}/api/v4/reactions`, {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        user_id: this.botUserId,
        post_id: messageId,
        emoji_name: emoji.replace(/^:+|:+$/g, ""),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`Mattermost reaction failed with HTTP ${res.status}`);
    }
  }

  private async ensureIdentity(): Promise<void> {
    if (this.botUserId) {
      return;
    }
    const res = await this.fetchImpl(`${this.baseUrl()}/api/v4/users/me`, {
      headers: this.authHeaders(),
      signal: AbortSignal.any([AbortSignal.timeout(15_000), this.lifecycle.signal]),
    });
    if (!res.ok) {
      throw new Error(`Mattermost users/me failed with HTTP ${res.status}`);
    }
    const me = (await res.json()) as { id?: string; username?: string };
    if (!me.id) {
      throw new Error("Mattermost users/me response missing id");
    }
    this.botUserId = me.id;
    this.botUsername = me.username ?? "";
  }

  private async runConnectionLoop(): Promise<void> {
    const signal = this.lifecycle.signal;
    let attempt = 0;

    while (!this.stopped) {
      let opened = false;
      try {
        await this.ensureIdentity();
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

  private connectOnce(): Promise<boolean> {
    return new Promise((resolve) => {
      let ws: MattermostWebSocketLike;
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
        this.setConnected(true);
        try {
          ws.send(
            JSON.stringify({
              seq: 1,
              action: "authentication_challenge",
              data: { token: this.cfg.botToken },
            }),
          );
        } catch (err) {
          this.noteError(err);
        }
      };
      ws.onmessage = (event) => {
        void this.handleWebSocketMessage(event?.data);
      };
      ws.onerror = (event) => {
        this.noteError(websocketErrorText(event));
      };
      ws.onclose = () => {
        if (this.ws === ws) {
          this.ws = undefined;
        }
        this.setConnected(false);
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

  private async handleWebSocketMessage(data: unknown): Promise<void> {
    const raw =
      typeof data === "string"
        ? data
        : data instanceof ArrayBuffer
          ? Buffer.from(data).toString("utf8")
          : "";
    if (!raw) {
      return;
    }

    let frame: MattermostWsFrame;
    try {
      frame = JSON.parse(raw) as MattermostWsFrame;
    } catch {
      return;
    }
    if (!frame || frame.event !== "posted" || !frame.data) {
      return;
    }

    const rawPost = frame.data.post;
    let post: MattermostPost | undefined;
    if (typeof rawPost === "string") {
      try {
        post = JSON.parse(rawPost) as MattermostPost;
      } catch {
        return;
      }
    } else if (rawPost && typeof rawPost === "object") {
      post = rawPost;
    }
    if (!post?.id || !post.channel_id || !post.user_id) {
      return;
    }
    if (this.botUserId && post.user_id === this.botUserId) {
      return;
    }
    if (this.dedupe.seen(post.id)) {
      return;
    }

    const isGroup = frame.data.channel_type ? frame.data.channel_type !== "D" : true;
    const text = post.message ?? "";
    const attachments: InboundAttachment[] = [];
    for (const fileId of post.file_ids ?? []) {
      if (typeof fileId !== "string" || !fileId) {
        continue;
      }
      try {
        const file = await this.downloadFile(fileId);
        const localPath = await saveInboundMedia(this.mediaDir, this.name, post.id, file.name, file.data);
        attachments.push({
          type: attachmentKindFor(file.mimeType),
          mimeType: file.mimeType,
          name: file.name,
          sizeBytes: file.data.byteLength,
          localPath,
        });
      } catch (err) {
        this.noteError(err);
      }
    }

    if (this.stopped) {
      return;
    }

    const msg: InboundMessage = {
      id: post.id,
      channel: this.name,
      chatId: post.channel_id,
      senderId: post.user_id,
      rawSenderId: post.user_id,
      isGroup,
      text,
      attachments,
      replyToMessageId: post.root_id || undefined,
      timestamp: post.create_at ?? Date.now(),
      mentionsBot: isMentioned(text, this.mentionPatterns()),
      raw: post,
    };
    await this.emit(msg);
  }

  private mentionPatterns(): string[] {
    const patterns = [...this.groupMentionPatterns];
    if (this.botUsername) {
      patterns.push(`@${this.botUsername}`);
    }
    return patterns;
  }

  private async downloadFile(
    fileId: string,
  ): Promise<{ data: Buffer; mimeType?: string; name: string }> {
    const res = await this.fetchImpl(
      `${this.baseUrl()}/api/v4/files/${encodeURIComponent(fileId)}`,
      {
        headers: this.authHeaders(),
        signal: AbortSignal.any([AbortSignal.timeout(30_000), this.lifecycle.signal]),
      },
    );
    if (!res.ok) {
      throw new Error(`Mattermost file download failed with HTTP ${res.status}`);
    }
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_INLINE_MEDIA_BYTES) {
      throw new Error(`Mattermost file exceeds ${MAX_INLINE_MEDIA_BYTES} bytes`);
    }
    const data = await readResponseWithinLimit(res, MAX_INLINE_MEDIA_BYTES);
    return {
      data,
      mimeType: res.headers.get("content-type") ?? undefined,
      name: filenameFromDisposition(res.headers.get("content-disposition")) ?? `file-${fileId}`,
    };
  }

  private async createPost(
    channelId: string,
    message: string,
    fileIds: string[],
    rootId?: string,
  ): Promise<string | undefined> {
    const body: { channel_id: string; message: string; root_id?: string; file_ids?: string[] } = {
      channel_id: channelId,
      message,
    };
    if (rootId) {
      body.root_id = rootId;
    }
    if (fileIds.length > 0) {
      body.file_ids = fileIds;
    }
    const res = await this.fetchImpl(`${this.baseUrl()}/api/v4/posts`, {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`Mattermost create post failed with HTTP ${res.status}`);
    }
    const created = (await res.json().catch(() => ({}))) as { id?: string };
    return created.id;
  }

  private async uploadAttachment(
    channelId: string,
    attachment: OutboundAttachment,
  ): Promise<string> {
    const data = await this.readAttachment(attachment);
    const name =
      attachment.name ?? (attachment.path ? path.basename(attachment.path) : "attachment.bin");
    const form = new FormData();
    form.append("channel_id", channelId);
    form.append(
      "files",
      new Blob([new Uint8Array(data)], { type: attachment.mimeType ?? "application/octet-stream" }),
      name,
    );
    const res = await this.fetchImpl(`${this.baseUrl()}/api/v4/files`, {
      method: "POST",
      headers: this.authHeaders(),
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`Mattermost file upload failed with HTTP ${res.status}`);
    }
    const body = (await res.json().catch(() => ({}))) as { file_infos?: { id?: string }[] };
    const fileId = body.file_infos?.[0]?.id;
    if (!fileId) {
      throw new Error("Mattermost file upload response missing file id");
    }
    return fileId;
  }

  private async readAttachment(attachment: OutboundAttachment): Promise<Buffer> {
    if (attachment.buffer) {
      return attachment.buffer;
    }
    if (attachment.path) {
      return readFile(attachment.path);
    }
    if (attachment.url) {
      const res = await this.fetchImpl(attachment.url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        throw new Error(`Attachment fetch failed with HTTP ${res.status}`);
      }
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > MAX_INLINE_MEDIA_BYTES) {
        throw new Error(`Download exceeds ${MAX_INLINE_MEDIA_BYTES} bytes`);
      }
      return readResponseWithinLimit(res, MAX_INLINE_MEDIA_BYTES);
    }
    throw new Error("Outbound attachment has no data source");
  }

  private webSocketUrl(): string {
    const raw = this.cfg.baseUrl.trim();
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    const url = new URL(withScheme);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/v4/websocket`;
    url.search = "";
    url.hash = "";
    return url.toString();
  }

  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.cfg.botToken}`, ...extra };
  }

  private baseUrl(): string {
    return this.cfg.baseUrl.trim().replace(/\/+$/, "");
  }
}

export function createAdapter(config: GatewayConfig): ChannelAdapter {
  return new MattermostChannelAdapter(config);
}