import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatPidPayload,
  isGatewayProcess,
  parsePidContent,
  readPidFile,
  readPidMetadata,
  resolveDaemonPaths,
} from "../src/cli.js";
import { matchesGatewayCommandLine } from "../src/pid.js";
import {
  LAUNCHD_LABEL,
  SYSTEMD_UNIT_NAME,
  WINDOWS_TASK_NAME,
  buildLaunchdPlist,
  buildSystemdUnit,
  resolveServicePaths,
  runServiceCommand,
} from "../src/service.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-w12-svc-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("Cross-platform service templates (macOS launchd & Linux systemd)", () => {
  it("generates a valid Apple Silicon-aware launchd LaunchAgent plist with XML escaping", () => {
    const plist = buildLaunchdPlist({
      nodeBin: "/opt/homebrew/bin/node",
      entryScript: "/Users/alice/Antigravity & Friends/dist/index.js",
      workingDir: "/Users/alice/Antigravity & Friends",
      logFile: "/Users/alice/logs/gateway<1>.log",
      dataDir: "/Users/alice/data",
      throttleIntervalSec: 10,
    });

    expect(plist).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toContain("<string>/opt/homebrew/bin/node</string>");
    expect(plist).toContain(
      "<string>/Users/alice/Antigravity &amp; Friends/dist/index.js</string>",
    );
    expect(plist).toContain("<string>/Users/alice/logs/gateway&lt;1&gt;.log</string>");
    expect(plist).toContain("/opt/homebrew/bin");
    expect(plist).toContain("/usr/local/bin");
    expect(plist).toContain("<key>SuccessfulExit</key>");
    expect(plist).toContain("<false/>");
    expect(plist).toContain("<integer>10</integer>");
    expect(plist).toContain("<key>DATA_DIR</key>");
  });

  it("generates a valid Linux systemd --user unit quoting spaces and escaping percent signs", () => {
    const unit = buildSystemdUnit({
      nodeBin: "/usr/bin/node",
      entryScript: "/srv/my gateway/dist/index.js",
      workingDir: "/srv/my gateway",
      envFile: "/srv/my gateway/.env",
      logFile: "/var/log/gw%20/gateway.log",
    });

    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("[Install]");
    expect(unit).toContain('WorkingDirectory="/srv/my gateway"');
    expect(unit).toContain('EnvironmentFile=-"/srv/my gateway/.env"');
    expect(unit).toContain('ExecStart=/usr/bin/node "/srv/my gateway/dist/index.js"');
    expect(unit).toContain("StandardOutput=append:/var/log/gw%%20/gateway.log");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("NoNewPrivileges=true");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("resolves native service paths per OS platform", () => {
    const mac = resolveServicePaths("darwin", "/Users/dev", "/repo");
    expect(mac.kind).toBe("launchd");
    if (mac.kind === "launchd") {
      expect(mac.label).toBe(LAUNCHD_LABEL);
      expect(mac.serviceFile).toContain(path.join("Library", "LaunchAgents"));
    }

    const linux = resolveServicePaths("linux", "/home/dev", "/repo");
    expect(linux.kind).toBe("systemd");
    if (linux.kind === "systemd") {
      expect(linux.unitName).toBe(SYSTEMD_UNIT_NAME);
      expect(linux.serviceFile).toContain(path.join(".config", "systemd", "user"));
    }

    const win = resolveServicePaths("win32", "C:\\Users\\dev", "C:\\repo");
    expect(win.kind).toBe("windows-task");
    if (win.kind === "windows-task") {
      expect(win.taskName).toBe(WINDOWS_TASK_NAME);
      expect(win.installScript).toContain("install-task.ps1");
    }

    const other = resolveServicePaths("freebsd", "/home/dev", "/repo");
    expect(other.kind).toBe("unsupported");
  });

  it("prints darwin and linux service definitions cleanly via `service print --platform`", async () => {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    const ctx = {
      repoRoot: "/opt/antigravity-gateway",
      distEntry: "/opt/antigravity-gateway/dist/index.js",
      dataDir: "/opt/antigravity-gateway/data",
      logFile: "/opt/antigravity-gateway/logs/gateway.log",
      nodeBin: "/opt/homebrew/bin/node",
      homeDir: "/Users/dev",
      platform: "win32" as NodeJS.Platform,
    };

    const macExit = await runServiceCommand(["print", "--platform", "darwin"], ctx);
    expect(macExit).toBe(0);
    expect(chunks.join("")).toContain("<plist version=\"1.0\">");

    chunks.length = 0;
    const linuxExit = await runServiceCommand(["print", "--platform=linux"], ctx);
    expect(linuxExit).toBe(0);
    expect(chunks.join("")).toContain("WantedBy=default.target");
  });
});

describe("PID metadata & process identity verification", () => {
  it("parses both structured JSON PID files and legacy integer PID files", () => {
    const dir = createTempDir();
    const jsonPidPath = path.join(dir, "json.pid");
    const legacyPidPath = path.join(dir, "legacy.pid");

    fs.writeFileSync(
      jsonPidPath,
      formatPidPayload(4242, "/srv/gateway/dist/index.js", "2026-11-26T00:00:00.000Z"),
      "utf8",
    );
    fs.writeFileSync(legacyPidPath, "  9876 \n", "utf8");

    expect(readPidFile(jsonPidPath)).toBe(4242);
    expect(readPidMetadata(jsonPidPath)).toEqual({
      pid: 4242,
      startedAt: "2026-11-26T00:00:00.000Z",
      entry: "/srv/gateway/dist/index.js",
    });

    expect(readPidFile(legacyPidPath)).toBe(9876);
    expect(readPidMetadata(legacyPidPath)).toEqual({ pid: 9876 });

    expect(parsePidContent('{"pid":0}')).toBeNull();
    expect(parsePidContent('{"pid":"abc"}')).toBeNull();
    expect(parsePidContent("{invalid json")).toBeNull();
  });

  it("matches gateway Node command lines and rejects recycled unrelated processes", async () => {
    expect(
      matchesGatewayCommandLine(
        "/opt/homebrew/bin/node /Users/dev/Antigravity-gateway/dist/index.js",
        "/Users/dev/Antigravity-gateway/dist/index.js",
      ),
    ).toBe(true);
    expect(
      matchesGatewayCommandLine(
        "C:\\Program Files\\nodejs\\node.exe C:\\srv\\antigravity-gateway\\dist\\index.js",
      ),
    ).toBe(true);
    // Must NOT match an unrelated Node app that merely happens to run `dist/index.js` or `index.js`
    expect(
      matchesGatewayCommandLine(
        "/usr/local/bin/node /srv/other-unrelated-app/dist/index.js",
        "/Users/dev/Antigravity-gateway/dist/index.js",
      ),
    ).toBe(false);
    expect(
      matchesGatewayCommandLine("/usr/local/bin/node /srv/other-unrelated-app/dist/index.js"),
    ).toBe(false);
    expect(matchesGatewayCommandLine("/usr/sbin/sshd -D")).toBe(false);
    expect(matchesGatewayCommandLine("python3 worker.py")).toBe(false);

    // Live current process with an unrelated inspected command line must be rejected (PID reuse protection)
    const reused = await isGatewayProcess(
      { pid: process.pid, entry: "/opt/gateway/dist/index.js" },
      async () => "/Applications/Safari.app/Contents/MacOS/Safari",
    );
    expect(reused).toBe(false);

    // Live current process with a matching gateway command line is accepted
    const genuine = await isGatewayProcess(
      { pid: process.pid, entry: "/opt/gateway/dist/index.js" },
      async () => "/usr/local/bin/node /opt/gateway/dist/index.js",
    );
    expect(genuine).toBe(true);

    // When OS command-line inspection is unavailable, fail closed by default (safe stop)
    const unverifiedDefault = await isGatewayProcess(
      { pid: process.pid, entry: "/opt/gateway/dist/index.js" },
      async () => null,
    );
    expect(unverifiedDefault).toBe(false);

    // Explicit opt-in allowUnverified returns true for alive processes when inspector is unavailable
    const unverifiedAllowed = await isGatewayProcess(
      { pid: process.pid, entry: "/opt/gateway/dist/index.js" },
      { allowUnverified: true, inspectCommandLine: async () => null },
    );
    expect(unverifiedAllowed).toBe(true);
  });
});

describe("Global-install safe daemon log path resolution", () => {
  it("uses explicit LOG_DIR when set", () => {
    const res = resolveDaemonPaths("/var/lib/agy/data", {
      logDir: "/var/log/agy",
      repoRoot: "/usr/lib/node_modules/antigravity-gateway",
    });
    expect(res.logFile).toBe(path.join(path.resolve("/var/log/agy"), "gateway.log"));
  });

  it("falls back to <dataDir>/logs/gateway.log when installed inside node_modules or read-only repo", () => {
    const insideNm = resolveDaemonPaths("/home/alice/.agy-data", {
      repoRoot: "/usr/local/lib/node_modules/antigravity-gateway",
      isWritable: () => true,
    });
    expect(insideNm.logFile).toBe(path.join("/home/alice/.agy-data", "logs", "gateway.log"));

    const readOnly = resolveDaemonPaths("/home/alice/.agy-data", {
      repoRoot: "/opt/antigravity-gateway",
      isWritable: () => false,
    });
    expect(readOnly.logFile).toBe(path.join("/home/alice/.agy-data", "logs", "gateway.log"));
  });

  it("uses <repoRoot>/logs/gateway.log for normal writable source checkouts", () => {
    const local = resolveDaemonPaths("/repo/data", {
      repoRoot: "/repo",
      isWritable: () => true,
    });
    expect(local.logFile).toBe(path.join(path.resolve("/repo"), "logs", "gateway.log"));
  });
});

describe("POSIX shell scripts hygiene", () => {
  const posixScripts = [
    "scripts/start-gateway.sh",
    "scripts/install-launchd.sh",
    "scripts/uninstall-launchd.sh",
    "scripts/install-systemd.sh",
    "scripts/uninstall-systemd.sh",
  ];

  it("ships all macOS/Linux scripts with LF line endings and portable paths", () => {
    const repoRoot = path.resolve(import.meta.dirname, "..");
    for (const rel of posixScripts) {
      const full = path.join(repoRoot, rel);
      expect(fs.existsSync(full), `missing ${rel}`).toBe(true);
      const text = fs.readFileSync(full, "utf8");
      expect(text.startsWith("#!/usr/bin/env bash\n"), `${rel} must start with LF bash shebang`).toBe(
        true,
      );
      expect(text.includes("\r\n"), `${rel} must use LF line endings`).toBe(false);
    }
  });
});
