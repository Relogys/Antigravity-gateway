# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

## [0.4.1] - 2026-11-26

### Security (Zero CodeQL High Alerts)

- **Eliminated polynomial ReDoS in HTTP Authorization parsers**: Replaced backtracking `/^(Bearer|HMAC)\s+(.+)$/i` regexes across `HealthServer`, `Webhook`, `Microsoft Teams`, and `Google Chat` with a shared linear-time `O(n)` `extractAuthSchemeToken()` helper in `src/channels/utils.ts` (resolves CodeQL `#1`, `#2`, `#3`, `#11`).
- **Bounded remote QQBot heartbeat intervals**: Enforced strict `[1s, 300s]` finite bounds on remote `heartbeat_interval` frames in `src/channels/qqbot.ts` so hostile or overflowed server intervals cannot cause 32-bit `setInterval` timer exhaustion (resolves CodeQL `#4`).
- **Hardened secret-audit placeholder domain checks**: Replaced `.includes("example.com")` / `.includes("example.org")` substring checks in `scripts/audit-secrets.mjs` with exact RFC 2606 parsed URL hostname / email domain matching so lookalike hosts like `https://example.com.attacker.net` can never bypass leak scanning (resolves CodeQL `#8`, `#9`, `#10`).
- **Clean startup log taint isolation**: Logged the OS-bound socket address from `HealthServer.getBoundAddress()` and explicit approval mode label constants in `src/index.ts` instead of raw environment-derived fields (resolves CodeQL `#6`, `#7`).
- **Docs-only CI matrix fix**: Incorporated PR `#9` so `Node 22` and `Node 24` status checks always report cleanly on Markdown-only PRs.

## [0.4.0] - 2026-11-26

### Session Reliability & Real-World Gateway Hardening

- **Stale ACP session self-healing**: `AgyAgentBackend` now automatically detects pruned or expired upstream ACP sessions (`session not found` / `unknown session` / `-32002`) during `loadSession` and pre-stream `prompt`, seamlessly creating a fresh session (re-applying saved model/effort/mode) instead of wedging the chat after restarts or idle evictions.
- **Isolated cron/loop execution**: Scheduled `/loop` prompts now run under an isolated per-job backend session key and release their ephemeral session on completion — preventing background schedules from clobbering, resetting, or polluting interactive conversation history or `cwd` in `state.json`.
- **Zero leaked typing/progress timers on shutdown**: `GatewayRouter.stop()` now drains all active typing indicators and progress polling handles cleanly during shutdown.

### Agent Harness Power Features

- **Full 5-field cron & daily schedules**: Upgraded `LoopScheduler` to support full standard 5-field cron expressions (`*`, `*/n`, ranges `1-5`, lists, stepped ranges, Sunday `0`/`7`, Vixie DOM/DOW semantics) alongside `HH:MM`, and exposed `/loop daily <HH:MM> <prompt>` and `/loop cron "<expr>" <prompt>` in chat.
- **Mobile-friendly workspace bookmarks (`/cwd @alias`)**: Added `WORKSPACE_ALIASES` env support plus persistent `/cwd save <alias> [path]`, `/cwd rm <alias>`, `/cwd list`, and one-tap `/cwd @<alias>` switching.
- **Portable secret-free backup & migration (`pnpm cli export` / `import`)**: Versioned JSON bundle for sessions, scheduled loops, and workspace bookmarks (excluding `.env` and auth lists by default), with `--dry-run` preview and `--remap-cwd <from>=<to>` cross-OS path rewriting.

### Observability, Diagnostics & Zero-Friction Installers

- **Prometheus `/metrics` endpoint & structured JSON logging**: `HealthServer` now exposes bounded-cardinality Prometheus metrics at `GET /metrics` (no sender/chat IDs; respects `HEALTH_TOKEN`), and `RotatingFileLogger` supports `LOG_FORMAT=json` with recursive secret redaction.
- **Actionable `pnpm cli doctor`**: Displays redacted Zod field-level `.env` validation errors, honors `HEALTH_TOKEN`, flags unauthenticated non-loopback health bindings, inspects PID identity & native OS service status, and adds `--json` output plus opt-in `--probe-acp` live handshake checks.
- **Checksum-verified one-line installers & smart docs-only CI**: Added `scripts/install.sh` (macOS/Linux) and `scripts/install.ps1` (Windows) verifying `SHA256SUMS.txt` against GitHub Releases, optional npm `--provenance` publishing in `release.yml`, `@types/node` major-version Dependabot pin, and a fast `changes` gate in `ci.yml` so Markdown/LICENSE-only PRs skip heavy multi-OS/Docker matrices while keeping secret scanning active.

## [0.3.0] - 2026-11-26

### Cross-Platform Support (macOS / Linux / Windows)

- **macOS (`launchd`) & Apple Silicon first-class support**: Added native `launchd` LaunchAgent generation (`~/Library/LaunchAgents/com.antigravity.gateway.plist`) with Homebrew `/opt/homebrew/bin` + `/usr/local/bin` PATH wiring, crash-only `KeepAlive`, and `scripts/install-launchd.sh` / `scripts/uninstall-launchd.sh`.
- **Linux (`systemd --user`) support**: Added user-unit generation (`~/.config/systemd/user/antigravity-gateway.service`) with `Restart=on-failure`, `NoNewPrivileges=true`, and `scripts/install-systemd.sh` / `scripts/uninstall-systemd.sh`.
- **Portable POSIX supervisor (`scripts/start-gateway.sh`)**: Bash crash-backoff supervisor (`2s`→`60s` exponential delay, 5 MB log rotation, `--one-shot` flag) mirroring `scripts/start-gateway.ps1` for macOS and Linux.
- **Unified native service CLI (`pnpm cli service`)**: Added `pnpm cli service [install|uninstall|status|print]` (with `--platform darwin|linux` preview) dispatching to `launchd` on macOS, `systemd --user` on Linux, and Task Scheduler on Windows.
- **macOS CI matrix & LF hygiene**: Added `verify-macos` (`macos-latest` Apple Silicon, Node 24) to `.github/workflows/ci.yml`, added `.gitattributes` to enforce LF line endings on scripts/source and CRLF on `.ps1`, fixed Windows CRLF shebang parsing in `.github/actions/notify/send.mjs`, and upgraded CodeQL to `v4`.

### Security & Operational Hardening

- **Non-loopback Webhook anti-replay by default**: `WEBHOOK_REQUIRE_TIMESTAMP` now defaults to `true` whenever `WEBHOOK_HOST` binds beyond loopback (still `false` on `127.0.0.1`/`localhost`/`::1` and explicitly overridable).
- **Hardened `HealthServer` (`/status`)**: All `lastError` diagnostic strings are passed through `redactSecrets()`, optional `HEALTH_TOKEN` enforces timing-safe Bearer auth on `GET /status` (keeping `/healthz` and `/readyz` open for probes), and unauthenticated non-loopback `/status` responses omit raw `lastError` details.
- **PID identity verification**: `data/gateway.pid` now writes structured JSON (`{ pid, startedAt, entry }`, backward-compatible with legacy integer PID files) and verifies the target process command line before signaling in `pnpm cli stop` so OS-recycled PIDs are never killed; startup now exits non-zero with log tail if the PID file fails to appear.
- **Global-install safe log directory**: Added `LOG_DIR` override and automatic fallback to `<DATA_DIR>/logs/gateway.log` when installed inside read-only `node_modules`.

## [0.2.0] - 2026-11-26

### Security & Reliability

- **Subprocess environment isolation**: `buildChildProcessEnv` now strips credentials and configuration keys for all 20 IM channel families (plus internal gateway tokens) before spawning `agy acp`, while preserving OS runtime variables and supporting an explicit `AGY_PASSTHROUGH_ENV` allowlist.
- **Requester-bound group approvals & admin-gated `/yolo`**: Pending tool permissions now record `requesterSenderId`. In group chats, only the originating requester or a configured `ADMIN_SENDERS` member can `/approve` or `/deny` (non-requesters are rejected without cancelling the pending prompt), and `/yolo` is restricted to `ADMIN_SENDERS` in groups.
- **Google Chat OIDC RS256 JWT verification**: Added native `node:crypto` RS256 Bearer JWT verification (`GOOGLECHAT_AUDIENCE` + cached Google JWKS with automatic key-rotation refresh), retaining static token support only for legacy/dev configurations.
- **Webhook anti-replay & sender pinning**: Added `X-Webhook-Timestamp` freshness validation (`WEBHOOK_REPLAY_WINDOW_SEC`, default `300s`), `X-Webhook-Id` delivery deduplication (`409` on replay after auth), optional strict enforcement (`WEBHOOK_REQUIRE_TIMESTAMP=true`), and `WEBHOOK_FIXED_SENDER` to override client-supplied `senderId`.
- **Store cross-process lock, `.bak` recovery & schema migration**: `GatewayStore` now coordinates writes via an exclusive lockfile with stale-PID recovery, rolls the previous `state.json` to `state.json.bak` before atomic replacement, quarantines corrupt JSON files while auto-recovering from `.bak`, and validates/migrates schema versions.
- **Reminder retry without silent loss**: One-shot `/remind` tasks now retry transient delivery failures with exponential backoff (up to 3 attempts) instead of deleting the job on the first send error; permanent dead targets stop cleanly.
- **Liveness vs readiness health split**: `GET /healthz` now returns `200` while the gateway is ready and at least one configured channel is connected (preventing single-channel outages from causing container restart loops), while `GET /readyz` strictly requires all channels connected.

### Architecture & CI/CD

- **Modular slash-command architecture**: Extracted `/help`, `/channels`, `/progress`, session/model/approval commands, loop/reminder commands, and Photon native commands into dedicated modules under `src/gateway/commands/`, reducing `src/gateway/router.ts` by over 1,000 lines.
- **Expanded CI, security scanning & release automation**: Added `windows-latest` Node 24 verification and Docker build checks to `.github/workflows/ci.yml`, CodeQL + secret/dependency scanning in `.github/workflows/security.yml`, Dependabot updates (`.github/dependabot.yml`), automated `v*.*.*` release publishing to GHCR (`linux/amd64` + `linux/arm64`) and GitHub Release tarballs with `SHA256SUMS.txt` (`.github/workflows/release.yml`), and a reusable anti-replay signed `.github/actions/notify` composite action.

### Added

#### Wave 10 — Cross-platform Markdown rendering, live progress & Photon 1.0

- **Cross-platform Markdown rendering**: Photon/iMessage now keeps native
  UTF-16 Markdown styling even for replies containing URLs, falls back to plain
  text on render errors, and formats wide tables as mobile-friendly cards.
  `PHOTON_MAX_CHUNK_CHARS` (default `1600`) caps bubble size so long messages
  never fold/collapse on iOS. Telegram sends native HTML
  (`parse_mode: "HTML"`) with automatic plain-text retry on parse errors and
  gains `editMessage` / `deleteMessage`. Discord and Slack implement
  `deleteMessage`; IRC, LINE, Signal, and OneBot convert Markdown to readable
  plain text.
- **Global IDE link sanitization**: `file:///` links are stripped from outbound
  replies on all 20 channels, so local workspace paths never leak into chat.
- **Live editable tool-call progress**: editable channels (Telegram, Discord,
  Slack, …) show one compact progress card updated in place during long turns
  (throttled by `TOOL_PROGRESS_EDIT_INTERVAL_MS`, default `1500`, with clean
  ≤48-character tool titles). `TOOL_PROGRESS_KEEP=false` (default) deletes the
  card when the final reply arrives; `true` keeps a compact completed summary.
  `TOOL_PROGRESS_MODE=auto|edit|silence|off` selects live edits, silence pulses
  (used on iMessage to avoid Apple's 5-edit cap), or no card.
- **New `/progress` command**: `/progress [auto|edit|silence|off|keep|delete]`
  is always available (with `-h` help) to inspect or switch progress mode and
  the final card disposition at runtime.
- **Photon 1.0 (`spectrum-ts@^12.16.0`) native upgrades**: startup cancellation
  via `Spectrum({ signal })`, detailed `onHeartbeat(hb)` stream telemetry
  (`stream` / `lineId`), `senderDeviceId` metadata, and inbound parsing for
  iMessage polls (`poll` / `poll_option`), Mini App cards (`app`), and group
  events (`addMember`, `removeMember`, `rename`, `avatar`, `leaveSpace`).
- **Photon iMessage slash commands**: `/poll <question> | <opt1> | <opt2>`
  (native polls), `/bg [preset|clear|list]` (24 built-in backgrounds),
  `/unsend` (unsend the last outbound message, ~2-minute Apple window), and
  `/card` (native "Share Name and Photo" contact card).

#### Wave 5 & Wave 6 — Onboarding, reliability & containers

- Photon iMessage **dual-layer heartbeat**: a transport heartbeat watchdog
  (`PHOTON_HEARTBEAT_TIMEOUT_MS`, default `180000`) combined with an
  application-level probe (`PHOTON_PROBE_SPACE_ID`) and zombie-inbound
  detection, so half-open gRPC streams are detected and reconnected after long
  idle periods.
- **Daemon lifecycle CLI**: `pnpm cli start | stop | restart | logs` with a PID
  file, stale-lock cleanup, graceful `SIGTERM` (with a Windows `taskkill`
  fallback), background log capture, and foreground mode.
- Crash-backoff supervisor `scripts/start-gateway.ps1` (2s→60s exponential
  restart delay, 5 MB log rotation) and Windows Scheduled Task autostart via
  `scripts/install-task.ps1`.
- Rotating, redacting file logger (`RotatingFileLogger`): size-based rotation
  (`gateway.log` → `.1` → `.3`) that masks bearer tokens, Slack/Discord/Telegram
  tokens, provider API keys, and Spectrum project secrets before writing.
- **Cross-channel inbound image bridge**: images from Photon, Telegram,
  Discord, WhatsApp, and Matrix are downloaded, cached, and forwarded to `agy`
  as native image attachments; the outbound media guard still blocks
  `.env*`/`.ssh`/private-key paths.
- Native **reaction lifecycle and read receipts**: `已读` (read) → `👀`
  while working → `👍` on success / `👎` on error, with periodically refreshed
  typing indicators during long turns.
- Interactive first-run onboarding wizard entry point (`pnpm setup`, alias
  `pnpm cli init`) with a documented manual fallback (`pnpm install` +
  `.env.example`).
- `docs/QUICKSTART.md`: bilingual 3-minute quick start, per-platform credential
  recipes (Photon, Telegram, Discord, Slack, Feishu/Lark, DingTalk, OneBot, plus
  WhatsApp/Teams/Signal/Matrix/Webhook pointers), a daily-operations cheat
  sheet, and a troubleshooting FAQ.
- **Docker support**: multi-stage `Dockerfile` on `node:24-slim` (corepack
  pnpm, frozen-lockfile install, non-root `node` user, `/healthz`
  `HEALTHCHECK`), `docker-compose.yml` (read-only `.env`, `./data` volume,
  loopback-only `127.0.0.1:18790`, `restart: unless-stopped`), and
  `.dockerignore`.

#### CI, documentation & cross-channel tests

- GitHub Actions CI workflow (`.github/workflows/ci.yml`) that runs on pushes to
  `main` and on pull requests, on a Node.js `[22, 24]` matrix with pnpm caching.
  Each job installs from the frozen lockfile, then runs typecheck, build, the
  full test suite, and the secret audit.
- `SECURITY.md` documenting the fail-closed authorization model, 8-character
  pairing codes with lockouts, loopback-default listeners, timing-safe webhook
  verification, secret hygiene, and coordinated vulnerability disclosure.
- `CHANGELOG.md` (this file).
- Cross-channel test coverage (`tests/multichannel-20.test.ts`) asserting that
  all 20 channels enable, construct, isolate their allowlists, round-trip
  qualified chat ids, and route outbound/inbound messages through the hub.

### Changed

- Documented Wave 10 in `README.md` (rendering matrix, live-progress env vars,
  `/progress`, Photon native commands, `PHOTON_MAX_CHUNK_CHARS`) and
  `docs/QUICKSTART.md` (a "Rich rendering & live progress" section plus FAQ
  entries for folded iMessage bubbles and a missing progress card).
- Redesigned the README top-level Quick Start around a 4-step copy-paste
  onboarding flow (`pnpm setup` → `pnpm build` → `pnpm cli doctor` →
  `pnpm cli start`), with a prominent link to `docs/QUICKSTART.md`, a Docker
  subsection, and a summary of the new read-receipt, heartbeat, image-vision,
  daemon CLI, and container capabilities.

### Security

- Documented and pinned the default-deny posture for every transport, including
  loopback-only health and callback servers and constant-time signature checks.

## 0.1.0 - 2026-11-26

First public release. The gateway evolved from a single iMessage bridge into a
20-channel hub while keeping one fail-closed authorization path.

### Added

#### Core gateway (Photon iMessage + Antigravity ACP v1)

- Photon Spectrum iMessage transport with read receipts, reactions, media
  handling, and inbound-first delivery support.
- Antigravity `agy acp` backend over the Agent Client Protocol (ACP v1), using
  the local cached `agy` session or `GEMINI_API_KEY`.
- Read-only local health server (`GET /healthz`, `GET /status`) bound to
  `127.0.0.1`.
- Session manager with serialized turns, prompt queueing, busy modes
  (queue/interrupt/steer), and cancellation.
- Loop scheduler and reminders (`/loop`, `/remind`) persisted across restarts.
- Admin CLI (`pnpm cli`) for doctor checks, one-off sends, pairing approvals and
  revocations, quota checks, and live status.
- Slash commands for session, model, effort, mode, approvals, queue, and
  scheduled automation control.

#### Multi-channel hub (8 channels)

- `MultiChannelHub` running many adapters concurrently behind one interface,
  with channel-qualified chat ids, per-channel health snapshots, and isolated
  start failures.
- New adapters: Telegram, Discord, Slack (Socket Mode), Feishu/Lark, DingTalk
  (Stream mode), OneBot v11 / QQ, and a generic HTTP/webhook adapter.
- Per-channel allowlists (`<CHANNEL>_ALLOWED_USERS`) and channel-namespaced
  global `ALLOWED_SENDERS` entries.
- Fail-closed DM pairing with 8-character codes, expiry, rate limiting, and
  lockouts; channel-aware `/channels` and `/whoami` reports.

#### Expansion to 14 channels

- Added WeCom/WeChat Work, QQ Bot, Matrix, Mattermost, LINE Messaging API, and
  IRC adapters.
- Loopback-only callback receivers for WeCom and LINE with signature
  verification and passive replies.
- Expanded health reporting to list every active channel with last
  inbound/outbound timestamps and errors.

#### Expansion to 20 channels

- Added WhatsApp Cloud API (Meta Graph API), Zulip, Rocket.Chat, Signal (via
  `signal-cli-rest-api`), Microsoft Teams, and Google Chat adapters.
- Signed callbacks across webhook platforms: WhatsApp `X-Hub-Signature-256`,
  Teams `Authorization: HMAC`, Google Chat verification token, plus existing
  WeCom and LINE verification.
- Six loopback-default callback receivers (`webhook`, `wecom`, `line`,
  `whatsapp`, `teams`, `googlechat`) alongside the health server.
- `pnpm audit:secrets` repository scanner plus `.env.example` placeholder
  conventions (`your-...` values are treated as unset).

### Security

- Default-deny authorization for all channels; empty allowlists authorize no
  one.
- Group access disabled by default and gated on explicit mentions.
- Timing-safe HMAC/signature comparisons with length checks for inbound
  callbacks.
- Outbound media guard blocking `.env*`, `.ssh`, and private-key material.
- Single-instance PID lock and secret audit to reduce accidental exposure.

