import { randomUUID } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import type { GatewayConfig, IrcConfig } from "../config.js";
import type { ChannelAdapter, OutboundMessage } from "../types.js";
import { BaseChannelAdapter, type InboundHandler } from "./base.js";
import {
  BoundedDedupeCache,
  isMentioned,
  reconnectDelayMs,
  sleepWithAbort,
} from "./utils.js";

const IRC_MAX_LINE_BYTES = 400;
const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const DEDUPE_TTL_MS = 10_000;

/** Minimal socket surface satisfied by `net.Socket` and `tls.TLSSocket`. */
export interface IrcSocketLike {
  on(event: string, listener: (...args: any[]) => void): unknown;
  write(data: string, callback?: (err?: Error) => void): boolean;
  end(): void;
  destroy(): void;
}

export type IrcSocketFactory = (host: string, port: number, useTls: boolean) => IrcSocketLike;

export interface IrcAdapterOptions {
  socketFactory?: IrcSocketFactory;
  /** Reconnect delay override (defaults to exponential `reconnectDelayMs`). */
  reconnectDelay?: (attempt: number) => number;
  /** Max wait in `start()` for the first transport connection (default 5s). */
  startupTimeoutMs?: number;
}

export interface ParsedIrcLine {
  prefix?: string;
  nick?: string;
  command: string;
  params: string[];
  trailing?: string;
}

/**
 * Parse one IRC line (`[@tags] [:prefix] COMMAND params... [:trailing]`).
 * Returns `null` for blank lines or lines without a command.
 */
export function parseIrcLine(rawLine: string): ParsedIrcLine | null {
  let line = rawLine.replace(/[\r\n]+$/, "").trimStart();
  if (!line) {
    return null;
  }

  if (line.startsWith("@")) {
    const space = line.indexOf(" ");
    if (space === -1) {
      return null;
    }
    line = line.slice(space + 1).trimStart();
  }

  let prefix: string | undefined;
  if (line.startsWith(":")) {
    const space = line.indexOf(" ");
    if (space === -1) {
      return null;
    }
    prefix = line.slice(1, space);
    line = line.slice(space + 1).trimStart();
    if (!prefix) {
      return null;
    }
  }

  const params: string[] = [];
  let trailing: string | undefined;
  let i = 0;
  while (i < line.length) {
    while (i < line.length && line[i] === " ") {
      i += 1;
    }
    if (i >= line.length) {
      break;
    }
    if (line[i] === ":") {
      trailing = line.slice(i + 1);
      break;
    }
    let end = i;
    while (end < line.length && line[end] !== " ") {
      end += 1;
    }
    params.push(line.slice(i, end));
    i = end;
  }

  const command = params.shift();
  if (!command) {
    return null;
  }

  let nick: string | undefined;
  if (prefix) {
    const bang = prefix.indexOf("!");
    const at = prefix.indexOf("@");
    let cut = -1;
    if (bang !== -1 && at !== -1) {
      cut = Math.min(bang, at);
    } else if (bang !== -1) {
      cut = bang;
    } else if (at !== -1) {
      cut = at;
    }
    if (cut > 0) {
      nick = prefix.slice(0, cut);
    }
  }

  return {
    ...(prefix !== undefined ? { prefix } : {}),
    ...(nick !== undefined ? { nick } : {}),
    command,
    params,
    ...(trailing !== undefined ? { trailing } : {}),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasAtMention(text: string, nick: string): boolean {
  const pattern = new RegExp(`(^|\\s)@${escapeRegExp(nick)}(?=$|[\\s:,.!?;])`, "i");
  return pattern.test(text);
}

/** Hard-wrap text so every line stays within `maxBytes` UTF-8 bytes (never splits a code point). */
function splitIrcBytes(text: string, maxBytes: number): string[] {
  const lines: string[] = [];
  let current = "";
  let size = 0;
  for (const char of text) {
    const bytes = Buffer.byteLength(char, "utf8");
    if (size + bytes > maxBytes && current.length > 0) {
      lines.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += bytes;
  }
  if (current.length > 0) {
    lines.push(current);
  }
  return lines;
}

function defaultSocketFactory(host: string, port: number, useTls: boolean): IrcSocketLike {
  return (
    useTls ? tls.connect({ host, port, servername: host }) : net.createConnection({ host, port })
  ) as unknown as IrcSocketLike;
}

export class IrcChannelAdapter extends BaseChannelAdapter {
  readonly name = "irc";

  private readonly ircConfig: IrcConfig;
  private readonly dedupe = new BoundedDedupeCache({
    ttlMs: DEDUPE_TTL_MS,
    maxEntries: 2000,
  });
  private abort?: AbortController;
  private socket?: IrcSocketLike;
  private registered = false;

  constructor(
    private readonly config: GatewayConfig,
    private readonly options: IrcAdapterOptions = {},
  ) {
    super();
    const cfg = config.irc;
    if (!cfg) {
      throw new Error("IRC channel is not configured (IRC_HOST)");
    }
    this.ircConfig = cfg;
  }

  async start(onMessage: InboundHandler): Promise<void> {
    this.handler = onMessage;
    this.abort = new AbortController();
    const signal = this.abort.signal;

    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    void this.runLoop(signal, markReady);

    const timeoutMs = this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    await Promise.race([ready, sleepWithAbort(timeoutMs, signal)]);
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    this.abort = undefined;
    this.setConnected(false);
    const socket = this.socket;
    this.socket = undefined;
    this.registered = false;
    if (socket) {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
    this.handler = undefined;
  }

  private async runLoop(signal: AbortSignal, markReady: () => void): Promise<void> {
    let attempt = 0;
    while (!signal.aborted) {
      const opened = await this.connectOnce(signal, markReady);
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

  /** Resolves (true if the transport ever connected) when the socket closes. */
  private connectOnce(signal: AbortSignal, markReady: () => void): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const cfg = this.ircConfig;
      let socket: IrcSocketLike;
      try {
        socket = (this.options.socketFactory ?? defaultSocketFactory)(
          cfg.host,
          cfg.port,
          cfg.tls,
        );
      } catch (err) {
        this.noteError(err);
        resolve(false);
        return;
      }
      this.socket = socket;

      let opened = false;
      let done = false;
      let buffer = "";

      const finish = () => {
        if (done) {
          return;
        }
        done = true;
        signal.removeEventListener("abort", onAbort);
        if (this.socket === socket) {
          this.socket = undefined;
          this.registered = false;
          this.setConnected(false);
        }
        resolve(opened);
      };
      const onAbort = () => {
        try {
          socket.destroy();
        } catch {
          // ignore
        }
        finish();
      };
      signal.addEventListener("abort", onAbort, { once: true });

      const onConnect = () => {
        opened = true;
        if (this.socket === socket) {
          this.setConnected(true);
        }
        if (!this.registered) {
          this.registered = true;
          if (cfg.password) {
            this.write(socket, `PASS ${cfg.password}\r\n`);
          }
          this.write(socket, `NICK ${cfg.nick}\r\n`);
          this.write(socket, `USER ${cfg.nick} 0 * :Antigravity Gateway\r\n`);
        }
        markReady();
      };

      socket.on("connect", onConnect);
      socket.on("secureConnect", onConnect);
      socket.on("data", (data: Buffer | string) => {
        buffer += typeof data === "string" ? data : data.toString("utf8");
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const rawLine = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (rawLine) {
            this.handleLine(rawLine);
          }
          newline = buffer.indexOf("\n");
        }
      });
      socket.on("error", (err: unknown) => this.noteError(err));
      socket.on("close", finish);
      socket.on("end", finish);
    });
  }

  private write(socket: IrcSocketLike, data: string): void {
    try {
      socket.write(data);
    } catch (err) {
      this.noteError(err);
    }
  }

  /** Handle one raw IRC line (registration numerics, PING, and PRIVMSG). */
  private handleLine(rawLine: string): void {
    const parsed = parseIrcLine(rawLine);
    if (!parsed) {
      return;
    }
    const command = parsed.command.toUpperCase();
    if (command === "PING") {
      const token = parsed.trailing ?? parsed.params[0] ?? "";
      const socket = this.socket;
      if (socket) {
        this.write(socket, `PONG :${token}\r\n`);
      }
      return;
    }
    if (command === "001") {
      const socket = this.socket;
      if (socket) {
        for (const channel of this.ircConfig.channels) {
          const target = channel.trim();
          if (target) {
            this.write(socket, `JOIN ${target}\r\n`);
          }
        }
      }
      return;
    }
    if (command === "PRIVMSG") {
      void this.handlePrivmsg(rawLine, parsed);
    }
  }

  private async handlePrivmsg(rawLine: string, parsed: ParsedIrcLine): Promise<void> {
    const sender = parsed.nick;
    const target = parsed.params[0];
    if (!sender || !target) {
      return;
    }
    const self = this.ircConfig.nick;
    const selfLower = self.toLowerCase();
    if (sender.toLowerCase() === selfLower) {
      return;
    }

    const original = parsed.trailing ?? "";
    const isChannel = target.startsWith("#") || target.startsWith("&");
    let chatId: string;
    let isGroup: boolean;
    let text = original;
    let mentionsBot: boolean;

    if (isChannel) {
      if (this.dedupe.seen(rawLine)) {
        return;
      }
      chatId = target;
      isGroup = true;
      const nickPrefix = new RegExp(`^${escapeRegExp(self)}:\\s*`, "i");
      mentionsBot =
        nickPrefix.test(original) ||
        hasAtMention(original, self) ||
        isMentioned(original, this.config.groupMentionPatterns);
      text = original.replace(nickPrefix, "");
    } else {
      if (target.toLowerCase() !== selfLower) {
        return;
      }
      if (this.dedupe.seen(rawLine)) {
        return;
      }
      chatId = sender;
      isGroup = false;
      mentionsBot = true;
    }

    if (!text.trim()) {
      return;
    }

    await this.emit({
      id: randomUUID(),
      channel: this.name,
      chatId,
      senderId: sender,
      isGroup,
      text,
      attachments: [],
      timestamp: Date.now(),
      mentionsBot,
      raw: parsed,
    });
  }

  async sendMessage(msg: OutboundMessage): Promise<{ messageId?: string } | void> {
    const socket = this.socket;
    if (!socket || !this.connected) {
      throw new Error("IRC is not connected");
    }
    const chatId = String(msg.chatId ?? "").replace(/\s+/g, "");
    if (!chatId) {
      throw new Error("IRC chatId is required");
    }
    const text = String(msg.text ?? "")
      .replace(/[\r\n]+/g, " ")
      .trim();
    if (!text) {
      return;
    }
    for (const line of splitIrcBytes(text, IRC_MAX_LINE_BYTES)) {
      this.write(socket, `PRIVMSG ${chatId} :${line}\r\n`);
    }
    this.noteOutbound();
  }
}

export function createAdapter(config: GatewayConfig): ChannelAdapter {
  return new IrcChannelAdapter(config);
}