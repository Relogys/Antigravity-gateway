import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  AcpSessionSummary,
  AgentTurnCallbacks,
  AgentTurnResult,
  ApprovalMode,
  InboundAttachment,
  ModelCatalogEntry,
} from "../types.js";

const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MiB
const INIT_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 1500;
const EFFORT_TOKENS = new Set(["low", "medium", "high", "xhigh", "max"]);

const WINDOWS_RUNTIME_ENV_KEYS = [
  "SYSTEMROOT",
  "SystemRoot",
  "COMSPEC",
  "TEMP",
  "TMP",
  "PATHEXT",
  "WINDIR",
  "PATH",
  "Path",
] as const;

/**
 * Gateway/channel credential and internal-config variable families that must
 * never leak into the spawned agent process (it can log its env to telemetry).
 */
const SENSITIVE_ENV_PREFIXES = [
  "SPECTRUM_",
  "PHOTON_",
  "TELEGRAM_",
  "DISCORD_",
  "SLACK_",
  "FEISHU_",
  "DINGTALK_",
  "ONEBOT_",
  "WEBHOOK_",
  "WECOM_",
  "QQBOT_",
  "MATRIX_",
  "MATTERMOST_",
  "LINE_",
  "IRC_",
  "WHATSAPP_",
  "ZULIP_",
  "ROCKETCHAT_",
  "SIGNAL_",
  "TEAMS_",
  "GOOGLECHAT_",
  "HEALTH_",
  "TOOL_PROGRESS_",
  "PROGRESS_SILENCE_",
  "SESSION_STALL_",
] as const;

const SENSITIVE_ENV_EXACT_KEYS = new Set([
  "ANTIGRAVITY_CSRF_TOKEN",
  "ANTIGRAVITY_LS_ADDRESS",
  "ALLOWED_SENDERS",
  "ADMIN_SENDERS",
  "ALLOW_GROUPS",
  "GROUP_MENTION_PATTERNS",
  "AGY_PASSTHROUGH_ENV",
  "QUOTA_WARN_THRESHOLD",
  "TURN_MAX_RETRIES",
  "INGRESS_DEBOUNCE_MS",
  "AUTO_BOOTSTRAP_CHANNEL_SESSION",
]);

/** True for any gateway/channel credential or internal config env variable. */
export function isSensitiveGatewayEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (SENSITIVE_ENV_EXACT_KEYS.has(upper)) {
    return true;
  }
  return SENSITIVE_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * Build a child-process env that strips gateway/channel credentials and keeps
 * Windows runtime variables intact. Dropping SYSTEMROOT/TEMP makes Python
 * agents fail with WinError 10106. Keys in `passthroughKeys` (case-insensitive)
 * opt back in even when they match a sensitive family.
 */
export function buildChildProcessEnv(
  baseEnv: NodeJS.ProcessEnv,
  overrides: Record<string, string | undefined> = {},
  passthroughKeys: readonly string[] = [],
): NodeJS.ProcessEnv {
  const passthrough = new Set(passthroughKeys.map((key) => key.toUpperCase()));
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) {
      continue;
    }
    if (isSensitiveGatewayEnvKey(key) && !passthrough.has(key.toUpperCase())) {
      continue;
    }
    env[key] = value;
  }

  for (const key of WINDOWS_RUNTIME_ENV_KEYS) {
    const value = baseEnv[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  env.PYTHONUTF8 = baseEnv.PYTHONUTF8 ?? "1";

  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  return env;
}

export interface AgyAcpClientOptions {
  agyBin: string;
  defaultCwd: string;
  approvalMode: ApprovalMode;
  geminiApiKey?: string;
  extraArgs?: string[];
  clientName?: string;
  clientVersion?: string;
  onStderr?: (line: string) => void;
  /** Gateway env keys to forward to the child despite the sensitive-key filter. */
  passthroughEnv?: string[];
}

export interface SessionConfigOption {
  id: string;
  name: string;
  category?: string;
  type: string;
  currentValue?: string | boolean;
  options?: Array<{ value: string; name: string; description?: string }>;
}

export interface NewSessionInfo {
  sessionId: string;
  models?: {
    currentModelId?: string;
    availableModels?: Array<{ modelId: string; name?: string }>;
  };
  modes?: {
    currentModeId?: string;
    availableModes?: Array<{ id: string; name?: string; description?: string }>;
  };
  configOptions?: SessionConfigOption[];
}

export type AcpPermissionHandler = (
  req: acp.RequestPermissionRequest,
) => Promise<acp.RequestPermissionResponse>;

interface ActiveTurnState {
  sessionId: string;
  textChunks: string[];
  callbacks?: AgentTurnCallbacks;
  permissionHandler?: AcpPermissionHandler;
  reject: (err: Error) => void;
}

export class AgyAcpClient {
  private proc: ChildProcess | null = null;
  private connection: acp.ClientConnection | null = null;
  private startPromise: Promise<acp.ClientConnection> | null = null;
  private initResult: acp.InitializeResponse | null = null;
  private readonly activeTurns = new Map<string, ActiveTurnState>();
  private readonly replayingSessions = new Set<string>();
  private readonly sessionPermissionHandlers = new Map<string, AcpPermissionHandler>();

  private cachedAvailableModels: string[] = [];
  private cachedBaseModels: string[] = [];
  private cachedEfforts: string[] = ["low", "medium", "high", "xhigh"];
  private cachedModes: string[] = ["default", "accept-edits", "auto", "plan"];
  private cachedConfigOptions: SessionConfigOption[] = [];
  private cachedModelCatalog: ModelCatalogEntry[] = [];
  private catalogPromise: Promise<ModelCatalogEntry[]> | null = null;

  constructor(private readonly options: AgyAcpClientOptions) {}

  isRunning(): boolean {
    return this.connection !== null && this.proc !== null && this.proc.exitCode === null;
  }

  getInitializeResult(): acp.InitializeResponse | null {
    return this.initResult;
  }

  getAvailableModels(): string[] {
    return [...this.cachedAvailableModels];
  }

  getAvailableBaseModels(): string[] {
    return [...this.cachedBaseModels];
  }

  getAvailableEfforts(): string[] {
    return [...this.cachedEfforts];
  }

  getAvailableModes(): string[] {
    return [...this.cachedModes];
  }

  getConfigOptions(): SessionConfigOption[] {
    return [...this.cachedConfigOptions];
  }

  /** Shallow copy of the live model catalog hydrated from the most recent session metadata. */
  getModelCatalog(): ModelCatalogEntry[] {
    return [...this.cachedModelCatalog];
  }

  /**
   * Returns the live model catalog, hydrating it once via a throwaway single-flight
   * `newSession(cwd)` if it is still empty. Never throws when ACP is offline: falls
   * back to whatever metadata (possibly nothing) has been cached so far.
   */
  async ensureCatalogLoaded(cwd: string): Promise<ModelCatalogEntry[]> {
    if (this.cachedModelCatalog.length > 0) {
      return this.getModelCatalog();
    }
    if (this.catalogPromise) {
      return this.catalogPromise;
    }

    const run = (async () => {
      try {
        await this.ensureStarted();
        const info = await this.newSession(cwd);
        if (this.cachedModelCatalog.length === 0) {
          this.cacheSessionMetadata(info);
        }
        if (info?.sessionId) {
          await this.closeSession(info.sessionId).catch(() => undefined);
        }
      } catch {
        // ACP offline / handshake failure: degrade gracefully to cached/empty.
      }
      return this.getModelCatalog();
    })();

    this.catalogPromise = run.finally(() => {
      this.catalogPromise = null;
    });
    return this.catalogPromise;
  }

  setSessionPermissionHandler(
    sessionId: string,
    handler: AcpPermissionHandler | undefined,
  ): void {
    if (handler) {
      this.sessionPermissionHandlers.set(sessionId, handler);
    } else {
      this.sessionPermissionHandlers.delete(sessionId);
    }
  }

  async ensureStarted(): Promise<acp.ClientConnection> {
    if (this.connection && this.proc && this.proc.exitCode === null && !this.proc.killed) {
      return this.connection;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.spawnAndInitialize().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async spawnAndInitialize(): Promise<acp.ClientConnection> {
    const args = ["acp"];
    if (this.options.approvalMode === "auto") {
      args.push("--dangerously-skip-permissions");
    } else if (this.options.approvalMode === "sandbox") {
      args.push("--sandbox");
    }
    if (this.options.extraArgs && this.options.extraArgs.length > 0) {
      args.push(...this.options.extraArgs);
    }

    const env = buildChildProcessEnv(
      process.env,
      { GEMINI_API_KEY: this.options.geminiApiKey },
      this.options.passthroughEnv,
    );

    const proc = spawn(this.options.agyBin, args, {
      cwd: this.options.defaultCwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    if (!proc.stdin || !proc.stdout) {
      proc.kill();
      throw new Error("Failed to open stdio pipes for agy acp process");
    }

    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text && this.options.onStderr) {
        this.options.onStderr(text);
      }
    });

    const input = Writable.toWeb(proc.stdin);
    const output = Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    const clientApp = acp
      .client({
        name: this.options.clientName ?? "antigravity-gateway",
      })
      .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
        const turn = this.activeTurns.get(ctx.params.sessionId);
        const handler =
          turn?.permissionHandler ??
          this.sessionPermissionHandlers.get(ctx.params.sessionId);
        if (handler) {
          return handler(ctx.params);
        }
        return this.defaultPermissionOutcome(ctx.params);
      })
      .onNotification(acp.methods.client.session.update, async (ctx) => {
        await this.handleSessionUpdate(ctx.params);
      });

    const connection = clientApp.connect(stream);
    this.proc = proc;
    this.connection = connection;

    const handleDisconnect = (reason: string) => {
      if (this.proc === proc) {
        this.proc = null;
      }
      if (this.connection === connection) {
        this.connection = null;
      }
      for (const [sid, turn] of this.activeTurns.entries()) {
        this.activeTurns.delete(sid);
        turn.reject(new Error(`agy acp process exited unexpectedly: ${reason}`));
      }
    };

    proc.once("error", (err) => {
      handleDisconnect(err.message);
    });
    proc.once("exit", (code, signal) => {
      handleDisconnect(`code=${code ?? "null"} signal=${signal ?? "null"}`);
    });
    connection.closed.then(
      () => handleDisconnect("connection closed"),
      (err) => handleDisconnect(err instanceof Error ? err.message : String(err)),
    );

    let initTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const initResult = await Promise.race([
        connection.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
          },
        }),
        new Promise<never>((_resolve, reject) => {
          initTimer = setTimeout(
            () => reject(new Error("agy acp initialize timed out")),
            INIT_TIMEOUT_MS,
          );
          initTimer.unref?.();
        }),
      ]);
      this.initResult = initResult;
      return connection;
    } catch (err) {
      handleDisconnect(err instanceof Error ? err.message : String(err));
      connection.close();
      if (proc.exitCode === null && !proc.killed) {
        proc.kill();
      }
      throw err;
    } finally {
      if (initTimer) {
        clearTimeout(initTimer);
      }
    }
  }

  private defaultPermissionOutcome(
    req: acp.RequestPermissionRequest,
  ): acp.RequestPermissionResponse {
    if (this.options.approvalMode === "auto") {
      const allow =
        req.options.find((o) => o.kind === "allow_always") ??
        req.options.find((o) => o.kind === "allow_once");
      if (allow) {
        return { outcome: { outcome: "selected", optionId: allow.optionId } };
      }
    }
    const reject =
      req.options.find((o) => o.kind === "reject_once") ??
      req.options.find((o) => o.kind === "reject_always");
    if (reject) {
      return { outcome: { outcome: "selected", optionId: reject.optionId } };
    }
    return { outcome: { outcome: "cancelled" } };
  }

  private async handleSessionUpdate(notification: acp.SessionNotification): Promise<void> {
    const { sessionId, update } = notification;
    if (this.replayingSessions.has(sessionId)) {
      return;
    }

    const turn = this.activeTurns.get(sessionId);
    if (!turn) {
      return;
    }

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        if (update.content.type === "text" && update.content.text) {
          turn.textChunks.push(update.content.text);
          await turn.callbacks?.onTextDelta?.(update.content.text);
        }
        break;
      }
      case "agent_thought_chunk": {
        if (update.content.type === "text" && update.content.text) {
          await turn.callbacks?.onThoughtDelta?.(update.content.text);
        }
        break;
      }
      case "tool_call": {
        await turn.callbacks?.onToolCall?.({
          toolCallId: update.toolCallId,
          title: update.title,
          status: update.status ?? "pending",
          kind: update.kind ?? undefined,
        });
        break;
      }
      case "tool_call_update": {
        await turn.callbacks?.onToolCall?.({
          toolCallId: update.toolCallId,
          title: update.title ?? update.toolCallId,
          status: update.status ?? "in_progress",
          kind: update.kind ?? undefined,
        });
        break;
      }
      default:
        break;
    }
  }

  private cacheSessionMetadata(raw: NewSessionInfo): void {
    if (raw.models?.availableModels) {
      this.cachedAvailableModels = raw.models.availableModels.map((m) => m.modelId);
    }
    if (raw.modes?.availableModes) {
      this.cachedModes = raw.modes.availableModes.map((m) => m.id);
    }
    if (Array.isArray(raw.configOptions)) {
      this.cachedConfigOptions = raw.configOptions;
      const modelOpt = raw.configOptions.find((c) => c.id === "model");
      if (modelOpt?.options) {
        this.cachedBaseModels = modelOpt.options.map((o) => o.value);
      }
      const effortOpt = raw.configOptions.find((c) => c.id === "thought_level");
      if (effortOpt?.options) {
        this.cachedEfforts = effortOpt.options.map((o) => o.value);
      }
      const modeOpt = raw.configOptions.find((c) => c.id === "mode");
      if (modeOpt?.options) {
        this.cachedModes = modeOpt.options.map((o) => o.value);
      }
    } else if (
      this.cachedBaseModels.length === 0 &&
      this.cachedAvailableModels.length > 0
    ) {
      // No explicit configOptions model entry: fall back to the available slugs as bases.
      this.cachedBaseModels = [...this.cachedAvailableModels];
    }

    const catalog = this.buildModelCatalog(raw);
    if (catalog.length > 0) {
      this.cachedModelCatalog = catalog;
    }
  }

  private buildModelCatalog(raw: NewSessionInfo): ModelCatalogEntry[] {
    const available = raw.models?.availableModels ?? [];
    const modelOpt = Array.isArray(raw.configOptions)
      ? raw.configOptions.find((c) => c.id === "model")
      : undefined;

    if (modelOpt?.options && modelOpt.options.length > 0) {
      return modelOpt.options.map((o) => ({
        id: o.value,
        name: o.name ?? o.value,
        efforts: this.availableEffortsForBase(o.value, available),
      }));
    }

    if (available.length > 0) {
      return available.map((m) => ({
        id: m.modelId,
        name: m.name ?? m.modelId,
      }));
    }

    return [];
  }

  private availableEffortsForBase(
    base: string,
    available: Array<{ modelId: string }>,
  ): string[] {
    const prefix = `${base}-`;
    const efforts: string[] = [];
    for (const model of available) {
      if (!model.modelId.startsWith(prefix)) {
        continue;
      }
      const suffix = model.modelId.slice(prefix.length).toLowerCase();
      if (EFFORT_TOKENS.has(suffix) && !efforts.includes(suffix)) {
        efforts.push(suffix);
      }
    }
    return efforts.length > 0 ? efforts : [...this.cachedEfforts];
  }

  async newSession(cwd: string): Promise<NewSessionInfo> {
    const conn = await this.ensureStarted();
    const res = (await conn.agent.request(acp.methods.agent.session.new, {
      cwd,
      mcpServers: [],
    })) as unknown as NewSessionInfo;
    this.cacheSessionMetadata(res);
    return res;
  }

  async loadSession(sessionId: string, cwd: string): Promise<void> {
    const conn = await this.ensureStarted();
    this.replayingSessions.add(sessionId);
    try {
      const res = (await conn.agent.request(acp.methods.agent.session.load, {
        sessionId,
        cwd,
        mcpServers: [],
      })) as unknown as Partial<NewSessionInfo> | void;
      if (res && typeof res === "object") {
        this.cacheSessionMetadata({ sessionId, ...res });
      }
    } finally {
      this.replayingSessions.delete(sessionId);
    }
  }

  async resumeSession(sessionId: string, cwd: string): Promise<void> {
    const conn = await this.ensureStarted();
    const res = (await conn.agent.request(acp.methods.agent.session.resume, {
      sessionId,
      cwd,
      mcpServers: [],
    })) as unknown as Partial<NewSessionInfo> | void;
    if (res && typeof res === "object") {
      this.cacheSessionMetadata({ sessionId, ...res });
    }
  }

  async listSessions(cwd?: string): Promise<AcpSessionSummary[]> {
    const conn = await this.ensureStarted();
    if (!this.initResult?.agentCapabilities?.sessionCapabilities?.list) {
      return [];
    }
    const res = await conn.agent.request(acp.methods.agent.session.list, {
      cwd,
    });
    return (res.sessions ?? []).map((s) => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title ?? undefined,
      updatedAt: s.updatedAt ?? undefined,
    }));
  }

  async closeSession(sessionId: string): Promise<void> {
    if (!this.isRunning() || !this.connection) {
      return;
    }
    if (!this.initResult?.agentCapabilities?.sessionCapabilities?.close) {
      return;
    }
    await this.connection.agent.request(acp.methods.agent.session.close, {
      sessionId,
    });
  }

  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void> {
    const conn = await this.ensureStarted();
    const res = (await conn.agent.request(
      acp.methods.agent.session.setConfigOption,
      {
        sessionId,
        configId,
        value,
      },
    )) as unknown as { configOptions?: SessionConfigOption[] } | void;
    if (res && Array.isArray(res.configOptions)) {
      this.cacheSessionMetadata({ sessionId, configOptions: res.configOptions });
    }
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    const conn = await this.ensureStarted();
    await conn.agent.request(acp.methods.agent.session.setMode, {
      sessionId,
      modeId,
    });
  }

  async prompt(
    sessionId: string,
    input: {
      text: string;
      attachments?: InboundAttachment[];
      callbacks?: AgentTurnCallbacks;
      permissionHandler?: AcpPermissionHandler;
    },
  ): Promise<AgentTurnResult> {
    const conn = await this.ensureStarted();
    const blocks = await this.buildPromptBlocks(input.text, input.attachments);

    let rejectActiveTurn: (err: Error) => void = () => undefined;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      rejectActiveTurn = reject;
    });

    const turnState: ActiveTurnState = {
      sessionId,
      textChunks: [],
      callbacks: input.callbacks,
      permissionHandler: input.permissionHandler,
      reject: rejectActiveTurn,
    };
    this.activeTurns.set(sessionId, turnState);

    try {
      const response = await Promise.race([
        conn.agent.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: blocks,
        }),
        abortPromise,
      ]);
      return {
        sessionId,
        text: turnState.textChunks.join(""),
        stopReason: response.stopReason,
      };
    } finally {
      if (this.activeTurns.get(sessionId) === turnState) {
        this.activeTurns.delete(sessionId);
      }
    }
  }

  async cancel(sessionId: string): Promise<void> {
    if (!this.isRunning() || !this.connection) {
      return;
    }
    await this.connection.agent.notify(acp.methods.agent.session.cancel, {
      sessionId,
    });
  }

  async stop(): Promise<void> {
    const conn = this.connection;
    const proc = this.proc;
    this.connection = null;
    this.proc = null;
    this.replayingSessions.clear();
    this.sessionPermissionHandlers.clear();

    for (const [sid, turn] of this.activeTurns.entries()) {
      this.activeTurns.delete(sid);
      turn.reject(new Error("ACP client stopped"));
    }

    if (conn) {
      conn.close();
    }
    if (proc && proc.exitCode === null) {
      const exited = new Promise<void>((resolve) => {
        proc.once("exit", () => resolve());
        proc.once("error", () => resolve());
      });
      if (!proc.killed) {
        proc.kill();
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            if (proc.exitCode === null && process.platform !== "win32") {
              try {
                proc.kill("SIGKILL");
              } catch {
                // ignore
              }
            }
            resolve();
          }, STOP_GRACE_MS);
          timer.unref?.();
        }),
      ]);
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async buildPromptBlocks(
    text: string,
    attachments: InboundAttachment[] = [],
  ): Promise<acp.ContentBlock[]> {
    const blocks: acp.ContentBlock[] = [];
    const notes: string[] = [];

    for (const att of attachments) {
      const isImage =
        att.type === "image" || (att.mimeType?.toLowerCase().startsWith("image/") ?? false);

      if (isImage) {
        let buf = att.data;
        if (!buf && att.localPath) {
          try {
            const stat = await fs.stat(att.localPath);
            if (stat.size <= MAX_INLINE_IMAGE_BYTES) {
              buf = await fs.readFile(att.localPath);
            }
          } catch {
            buf = undefined;
          }
        } else if (!buf && att.read) {
          try {
            buf = await att.read();
          } catch {
            buf = undefined;
          }
        }

        if (buf && buf.byteLength <= MAX_INLINE_IMAGE_BYTES) {
          blocks.push({
            type: "image",
            mimeType: att.mimeType || "image/png",
            data: buf.toString("base64"),
          });
          if (att.localPath) {
            notes.push(`[Image "${att.name ?? "image"}" also cached at: ${att.localPath}]`);
          }
          continue;
        }
      }

      const details = [
        att.name ?? att.type,
        att.mimeType,
        att.sizeBytes ? `${att.sizeBytes} bytes` : undefined,
      ]
        .filter(Boolean)
        .join(", ");
      const pathPart = att.localPath ? ` — local path: ${att.localPath}` : "";
      notes.push(`[Attached ${att.type}: ${details}${pathPart}]`);
    }

    const combinedText = [text.trim(), ...notes].filter(Boolean).join("\n\n");
    blocks.push({
      type: "text",
      text: combinedText || " ",
    });

    return blocks;
  }
}
