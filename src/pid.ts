import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PidMetadata {
  pid: number;
  startedAt?: string;
  entry?: string;
}

/** Format structured JSON PID metadata while keeping human-readability. */
export function formatPidPayload(
  pid: number,
  entry?: string,
  startedAt: string = new Date().toISOString(),
): string {
  const payload: PidMetadata = {
    pid,
    startedAt,
    ...(entry ? { entry } : {}),
  };
  return `${JSON.stringify(payload)}\n`;
}

/**
 * Parse either the structured JSON PID format (`{"pid":123,"startedAt":...,"entry":...}`)
 * or a legacy plain-integer PID file (`123\n`).
 */
export function parsePidContent(raw: string): PidMetadata | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (/^\d+$/.test(trimmed)) {
    const pid = Number.parseInt(trimmed, 10);
    return Number.isSafeInteger(pid) && pid > 0 ? { pid } : null;
  }
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const pid = parsed.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
      return null;
    }
    return {
      pid,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : undefined,
      entry: typeof parsed.entry === "string" ? parsed.entry : undefined,
    };
  } catch {
    return null;
  }
}

export function readPidMetadata(pidFile: string): PidMetadata | null {
  try {
    return parsePidContent(fs.readFileSync(pidFile, "utf8"));
  } catch {
    return null;
  }
}

export function readPidFile(pidFile: string): number | null {
  return readPidMetadata(pidFile)?.pid ?? null;
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Check whether an inspected OS command line matches an Antigravity Gateway
 * Node.js process (used to avoid signaling an unrelated process after PID reuse).
 */
export function matchesGatewayCommandLine(
  commandLine: string,
  expectedEntry?: string,
): boolean {
  const normalized = commandLine.replace(/\\/g, "/").toLowerCase();
  if (!normalized.trim()) {
    return false;
  }
  const hasRuntime =
    /\bnode(\.exe)?\b/.test(normalized) || /\btsx(\.cmd)?\b/.test(normalized);
  if (!hasRuntime) {
    return false;
  }
  if (expectedEntry) {
    const normEntry = expectedEntry.replace(/\\/g, "/").toLowerCase();
    // Require exact path match (never match bare "index.js" which could belong to another Node app).
    if (normalized.includes(normEntry)) {
      return true;
    }
    // Also tolerate relative invocations matching the final 3 segments (e.g. "antigravity-gateway/dist/index.js").
    const tail = normEntry.split("/").filter(Boolean).slice(-3).join("/");
    if (tail.includes("/") && normalized.includes(tail)) {
      return true;
    }
    return false;
  }
  // Legacy plain-integer PID files have no `entry`: require the package/repo marker
  // alongside the gateway entrypoint rather than matching any arbitrary `dist/index.js`.
  return (
    normalized.includes("antigravity-gateway") &&
    (normalized.includes("dist/index.js") || normalized.includes("src/index.ts"))
  );
}

type CommandLineProbe =
  | { status: "ok"; commandLine: string }
  | { status: "empty" }
  | { status: "unavailable" };

async function readProcessCommandLine(pid: number): Promise<CommandLineProbe> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { status: "empty" };
  }
  if (process.platform === "linux") {
    try {
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`);
      const text = raw.toString("utf8").replace(/\0+/g, " ").trim();
      return text ? { status: "ok", commandLine: text } : { status: "empty" };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === "ENOENT" ? { status: "empty" } : { status: "unavailable" };
    }
  }
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
        ],
        { timeout: 3_000, windowsHide: true },
      );
      const text = stdout.trim();
      return text ? { status: "ok", commandLine: text } : { status: "empty" };
    } catch {
      return { status: "unavailable" };
    }
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], {
      timeout: 2_000,
    });
    const text = stdout.trim();
    return text ? { status: "ok", commandLine: text } : { status: "empty" };
  } catch {
    return { status: "unavailable" };
  }
}

export interface IsGatewayProcessOptions {
  /** Whether an unavailable OS inspector should fail closed (`false`) or open (`true`, default `false`). */
  allowUnverified?: boolean;
  inspectCommandLine?: (pid: number) => Promise<string | null>;
}

/**
 * Best-effort verification that `meta.pid` is alive AND actually belongs to the
 * Antigravity Gateway rather than an OS-recycled unrelated process.
 * Fails closed (`false`) by default when the process command line cannot be
 * verified, preventing `stop` from signaling an unrelated recycled PID.
 */
export async function isGatewayProcess(
  meta: PidMetadata,
  optionsOrInspector?:
    | IsGatewayProcessOptions
    | ((pid: number) => Promise<string | null>),
): Promise<boolean> {
  if (!isPidAlive(meta.pid)) {
    return false;
  }

  const opts: IsGatewayProcessOptions =
    typeof optionsOrInspector === "function"
      ? { inspectCommandLine: optionsOrInspector }
      : (optionsOrInspector ?? {});

  let probe: CommandLineProbe;
  if (opts.inspectCommandLine) {
    const cmd = await opts.inspectCommandLine(meta.pid).catch(() => null);
    probe = cmd ? { status: "ok", commandLine: cmd } : { status: "unavailable" };
  } else {
    probe = await readProcessCommandLine(meta.pid);
  }

  if (probe.status === "ok") {
    return matchesGatewayCommandLine(probe.commandLine, meta.entry);
  }
  if (probe.status === "empty") {
    return false;
  }
  return opts.allowUnverified === true;
}
