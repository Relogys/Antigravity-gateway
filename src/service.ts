import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const LAUNCHD_LABEL = "com.antigravity.gateway";
export const SYSTEMD_UNIT_NAME = "antigravity-gateway.service";
export const WINDOWS_TASK_NAME = "AntigravityGateway";

const DEFAULT_MACOS_PATH =
  "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export interface LaunchdPlistOptions {
  label?: string;
  nodeBin: string;
  entryScript: string;
  workingDir: string;
  logFile: string;
  errorLogFile?: string;
  extraPath?: string;
  dataDir?: string;
  logDir?: string;
  throttleIntervalSec?: number;
}

export interface SystemdUnitOptions {
  description?: string;
  nodeBin: string;
  entryScript: string;
  workingDir: string;
  envFile?: string;
  logFile?: string;
  restartSec?: number;
}

export type ResolvedServiceDescriptor =
  | { kind: "launchd"; label: string; serviceFile: string }
  | { kind: "systemd"; unitName: string; serviceFile: string }
  | {
      kind: "windows-task";
      taskName: string;
      installScript: string;
      uninstallScript: string;
    }
  | { kind: "unsupported"; platform: string };

export interface ServiceCommandContext {
  repoRoot: string;
  distEntry: string;
  dataDir: string;
  logFile: string;
  logDir?: string;
  platform?: NodeJS.Platform;
  homeDir?: string;
  nodeBin?: string;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function quoteSystemdValue(value: string): string {
  const escapedPercent = value.replace(/%/g, "%%");
  if (/[\s"'\\]/.test(escapedPercent)) {
    const inner = escapedPercent.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${inner}"`;
  }
  return escapedPercent;
}

/**
 * Build a macOS `launchd` LaunchAgent XML property list (`~/Library/LaunchAgents/`).
 * Includes `/opt/homebrew/bin` and `/usr/local/bin` in PATH so Apple Silicon and
 * Intel Homebrew installations of Node.js and `agy` work under `launchd`.
 */
export function buildLaunchdPlist(opts: LaunchdPlistOptions): string {
  const label = opts.label ?? LAUNCHD_LABEL;
  const errorLogFile = opts.errorLogFile ?? opts.logFile;
  const throttle = opts.throttleIntervalSec ?? 5;

  const pathParts = [
    path.dirname(opts.nodeBin),
    ...(opts.extraPath ? opts.extraPath.split(":").filter(Boolean) : []),
    ...DEFAULT_MACOS_PATH.split(":"),
  ];
  const dedupedPath = [...new Set(pathParts.filter(Boolean))].join(":");

  const envEntries: Array<[string, string]> = [["PATH", dedupedPath]];
  if (opts.dataDir) {
    envEntries.push(["DATA_DIR", opts.dataDir]);
  }
  if (opts.logDir) {
    envEntries.push(["LOG_DIR", opts.logDir]);
  }

  const envXml = envEntries
    .map(
      ([k, v]) =>
        `    <key>${escapeXml(k)}</key>\n    <string>${escapeXml(v)}</string>`,
    )
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${escapeXml(label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${escapeXml(opts.nodeBin)}</string>`,
    `    <string>${escapeXml(opts.entryScript)}</string>`,
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${escapeXml(opts.workingDir)}</string>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>ThrottleInterval</key>",
    `  <integer>${Math.max(1, Math.floor(throttle))}</integer>`,
    "  <key>StandardOutPath</key>",
    `  <string>${escapeXml(opts.logFile)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${escapeXml(errorLogFile)}</string>`,
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    envXml,
    "  </dict>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/**
 * Build a Linux `systemd --user` service unit (`~/.config/systemd/user/`).
 */
export function buildSystemdUnit(opts: SystemdUnitOptions): string {
  const description = opts.description ?? "Antigravity Multi-Channel Gateway";
  const restartSec = Math.max(1, Math.floor(opts.restartSec ?? 5));
  const execStart = `${quoteSystemdValue(opts.nodeBin)} ${quoteSystemdValue(opts.entryScript)}`;

  const lines = [
    "[Unit]",
    `Description=${description}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${quoteSystemdValue(opts.workingDir)}`,
    ...(opts.envFile
      ? [`EnvironmentFile=-${quoteSystemdValue(opts.envFile)}`]
      : []),
    `ExecStart=${execStart}`,
    "Restart=on-failure",
    `RestartSec=${restartSec}`,
    "NoNewPrivileges=true",
    ...(opts.logFile
      ? [
          `StandardOutput=append:${quoteSystemdValue(opts.logFile)}`,
          `StandardError=append:${quoteSystemdValue(opts.logFile)}`,
        ]
      : []),
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ];
  return lines.join("\n");
}

export function resolveServicePaths(
  platform: NodeJS.Platform,
  homeDir: string,
  repoRoot: string,
): ResolvedServiceDescriptor {
  if (platform === "darwin") {
    return {
      kind: "launchd",
      label: LAUNCHD_LABEL,
      serviceFile: path.join(
        homeDir,
        "Library",
        "LaunchAgents",
        `${LAUNCHD_LABEL}.plist`,
      ),
    };
  }
  if (platform === "linux") {
    return {
      kind: "systemd",
      unitName: SYSTEMD_UNIT_NAME,
      serviceFile: path.join(
        homeDir,
        ".config",
        "systemd",
        "user",
        SYSTEMD_UNIT_NAME,
      ),
    };
  }
  if (platform === "win32") {
    return {
      kind: "windows-task",
      taskName: WINDOWS_TASK_NAME,
      installScript: path.join(repoRoot, "scripts", "install-task.ps1"),
      uninstallScript: path.join(repoRoot, "scripts", "uninstall-task.ps1"),
    };
  }
  return { kind: "unsupported", platform };
}

function parsePlatformFlag(args: string[]): NodeJS.Platform | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    const val =
      arg === "--platform" || arg === "-p"
        ? args[i + 1]
        : arg.startsWith("--platform=")
          ? arg.slice("--platform=".length)
          : undefined;
    if (!val) continue;
    const norm = val.trim().toLowerCase();
    if (norm === "macos" || norm === "darwin") return "darwin";
    if (norm === "linux") return "linux";
    if (norm === "win32" || norm === "windows") return "win32";
  }
  return undefined;
}

function printServiceUsage(): void {
  console.log(`Usage:
  pnpm cli service print [--platform darwin|linux]
                              Print the generated launchd plist or systemd unit (no host changes)
  pnpm cli service install    Install & start native autostart service (macOS launchd / Linux systemd / Windows Task)
  pnpm cli service uninstall  Stop & remove native autostart service
  pnpm cli service status     Check native autostart service status
`);
}

export async function runServiceCommand(
  args: string[],
  ctx: ServiceCommandContext,
): Promise<number> {
  const sub = (args[0] ?? "status").toLowerCase();
  if (sub === "help" || sub === "-h" || sub === "--help") {
    printServiceUsage();
    return 0;
  }

  const platformOverride = parsePlatformFlag(args.slice(1));
  const targetPlatform =
    sub === "print" && platformOverride
      ? platformOverride
      : (ctx.platform ?? process.platform);
  const homeDir = ctx.homeDir ?? os.homedir();
  const nodeBin = ctx.nodeBin ?? process.execPath;
  const descriptor = resolveServicePaths(targetPlatform, homeDir, ctx.repoRoot);

  if (sub === "print") {
    if (descriptor.kind === "launchd") {
      process.stdout.write(
        buildLaunchdPlist({
          label: descriptor.label,
          nodeBin,
          entryScript: ctx.distEntry,
          workingDir: ctx.repoRoot,
          logFile: ctx.logFile,
          dataDir: ctx.dataDir,
          logDir: ctx.logDir,
        }),
      );
      return 0;
    }
    if (descriptor.kind === "systemd") {
      process.stdout.write(
        buildSystemdUnit({
          nodeBin,
          entryScript: ctx.distEntry,
          workingDir: ctx.repoRoot,
          envFile: path.join(ctx.repoRoot, ".env"),
          logFile: ctx.logFile,
        }),
      );
      return 0;
    }
    if (descriptor.kind === "windows-task") {
      console.log(`Windows Scheduled Task: ${descriptor.taskName}`);
      console.log(`  Install script:   ${descriptor.installScript}`);
      console.log(`  Uninstall script: ${descriptor.uninstallScript}`);
      console.log("Tip: pass --platform darwin or --platform linux to inspect POSIX templates.");
      return 0;
    }
    console.error(`Unsupported platform: ${descriptor.platform}`);
    return 1;
  }

  if (sub === "install") {
    if (!fs.existsSync(ctx.distEntry)) {
      console.error(`Built entry point not found: ${ctx.distEntry}`);
      console.error("Build the gateway first: pnpm build");
      return 1;
    }

    if (descriptor.kind === "launchd") {
      fs.mkdirSync(path.dirname(descriptor.serviceFile), { recursive: true });
      fs.mkdirSync(path.dirname(ctx.logFile), { recursive: true });
      const plist = buildLaunchdPlist({
        label: descriptor.label,
        nodeBin,
        entryScript: ctx.distEntry,
        workingDir: ctx.repoRoot,
        logFile: ctx.logFile,
        dataDir: ctx.dataDir,
        logDir: ctx.logDir,
      });
      fs.writeFileSync(descriptor.serviceFile, plist, "utf8");
      const uid = typeof process.getuid === "function" ? process.getuid() : 501;
      const domain = `gui/${uid}`;
      await execFileAsync("launchctl", ["bootout", `${domain}/${descriptor.label}`]).catch(
        () => {},
      );
      await execFileAsync("launchctl", ["bootstrap", domain, descriptor.serviceFile]);
      await execFileAsync("launchctl", [
        "kickstart",
        "-k",
        `${domain}/${descriptor.label}`,
      ]).catch(() => {});
      console.log(`Installed & started macOS LaunchAgent: ${descriptor.serviceFile}`);
      console.log(`Logs: ${ctx.logFile}`);
      return 0;
    }

    if (descriptor.kind === "systemd") {
      fs.mkdirSync(path.dirname(descriptor.serviceFile), { recursive: true });
      fs.mkdirSync(path.dirname(ctx.logFile), { recursive: true });
      const unit = buildSystemdUnit({
        nodeBin,
        entryScript: ctx.distEntry,
        workingDir: ctx.repoRoot,
        envFile: path.join(ctx.repoRoot, ".env"),
        logFile: ctx.logFile,
      });
      fs.writeFileSync(descriptor.serviceFile, unit, "utf8");
      await execFileAsync("systemctl", ["--user", "daemon-reload"]);
      await execFileAsync("systemctl", [
        "--user",
        "enable",
        "--now",
        descriptor.unitName,
      ]);
      console.log(`Installed & started systemd user service: ${descriptor.serviceFile}`);
      console.log(`Logs: ${ctx.logFile}`);
      return 0;
    }

    if (descriptor.kind === "windows-task") {
      const { stdout, stderr } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", descriptor.installScript],
        { windowsHide: true },
      );
      if (stdout.trim()) console.log(stdout.trim());
      if (stderr.trim()) console.error(stderr.trim());
      return 0;
    }

    console.error(`Unsupported platform: ${descriptor.platform}`);
    return 1;
  }

  if (sub === "uninstall") {
    if (descriptor.kind === "launchd") {
      const uid = typeof process.getuid === "function" ? process.getuid() : 501;
      await execFileAsync("launchctl", [
        "bootout",
        `gui/${uid}/${descriptor.label}`,
      ]).catch(() => {});
      fs.rmSync(descriptor.serviceFile, { force: true });
      console.log(`Removed macOS LaunchAgent: ${descriptor.serviceFile}`);
      return 0;
    }

    if (descriptor.kind === "systemd") {
      await execFileAsync("systemctl", [
        "--user",
        "disable",
        "--now",
        descriptor.unitName,
      ]).catch(() => {});
      fs.rmSync(descriptor.serviceFile, { force: true });
      await execFileAsync("systemctl", ["--user", "daemon-reload"]).catch(() => {});
      console.log(`Removed systemd user service: ${descriptor.serviceFile}`);
      return 0;
    }

    if (descriptor.kind === "windows-task") {
      const { stdout, stderr } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", descriptor.uninstallScript],
        { windowsHide: true },
      );
      if (stdout.trim()) console.log(stdout.trim());
      if (stderr.trim()) console.error(stderr.trim());
      return 0;
    }

    console.error(`Unsupported platform: ${descriptor.platform}`);
    return 1;
  }

  if (sub === "status") {
    if (descriptor.kind === "launchd") {
      const installed = fs.existsSync(descriptor.serviceFile);
      console.log(`Platform: macOS launchd (${descriptor.label})`);
      console.log(`Plist:    ${descriptor.serviceFile} (${installed ? "installed" : "not installed"})`);
      if (!installed) return 0;
      const uid = typeof process.getuid === "function" ? process.getuid() : 501;
      try {
        const { stdout } = await execFileAsync("launchctl", [
          "print",
          `gui/${uid}/${descriptor.label}`,
        ]);
        const stateLine = stdout
          .split(/\r?\n/)
          .find((l) => l.includes("state =") || l.includes("pid ="));
        if (stateLine) console.log(`Status:   ${stateLine.trim()}`);
      } catch {
        console.log("Status:   not loaded");
      }
      return 0;
    }

    if (descriptor.kind === "systemd") {
      const installed = fs.existsSync(descriptor.serviceFile);
      console.log(`Platform: Linux systemd --user (${descriptor.unitName})`);
      console.log(`Unit:     ${descriptor.serviceFile} (${installed ? "installed" : "not installed"})`);
      if (!installed) return 0;
      try {
        const { stdout } = await execFileAsync("systemctl", [
          "--user",
          "is-active",
          descriptor.unitName,
        ]);
        console.log(`Status:   ${stdout.trim()}`);
      } catch (err) {
        const out = (err as { stdout?: string }).stdout?.trim() || "inactive";
        console.log(`Status:   ${out}`);
      }
      return 0;
    }

    if (descriptor.kind === "windows-task") {
      console.log(`Platform: Windows Scheduled Task (${descriptor.taskName})`);
      try {
        const { stdout } = await execFileAsync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `$t = Get-ScheduledTask -TaskName '${descriptor.taskName}' -ErrorAction SilentlyContinue; if ($t) { $t.State } else { 'NotInstalled' }`,
          ],
          { windowsHide: true },
        );
        console.log(`Status:   ${stdout.trim() || "Unknown"}`);
      } catch {
        console.log("Status:   unavailable");
      }
      return 0;
    }

    console.error(`Unsupported platform: ${descriptor.platform}`);
    return 1;
  }

  console.error(`Unknown service subcommand: ${sub}\n`);
  printServiceUsage();
  return 1;
}
