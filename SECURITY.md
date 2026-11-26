# Security Policy

Antigravity Gateway bridges personal messaging platforms to a local Antigravity
(`agy acp`) agent. Because it relays real conversations and can trigger tool
execution, the project treats authentication, network exposure, and secret
handling as first-class concerns. This document describes the security model and
how to report problems responsibly.

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1   | :x:                |

Security fixes are applied to the latest release line. Always run the newest
tagged version.

## Reporting a Vulnerability

Please **do not** open a public issue, pull request, or discussion for a
security problem.

Use GitHub's private vulnerability reporting for this repository:

1. Open the repository's **Security** tab.
2. Choose **Advisories** → **Report a vulnerability**.
3. Describe the issue privately to the maintainers.

A useful report includes:

- Affected version, commit, or release tag.
- The channel/platform and configuration involved (redact all credentials).
- Reproduction steps or a proof of concept.
- Impact assessment and any suggested remediation.

We aim to acknowledge reports within 3 business days and to share a remediation
plan within 10 business days. We follow coordinated disclosure and will credit
reporters who wish to be named. Please give us a reasonable window (up to 90
days) before public disclosure.

When testing, act in good faith: only use accounts, bots, servers, and data you
own or are explicitly authorized to test. Do not run denial-of-service tests,
access other people's messages, or probe third-party infrastructure.

## Security Model

### Fail-closed sender authorization

Every inbound message is authorized against a union of three sources, and any
message that matches none of them is dropped:

1. **Per-channel allowlists** — `<CHANNEL>_ALLOWED_USERS`, a comma-separated list
   of platform user ids. Entries are trimmed and lowercased.
2. **Global allowlist** — `ALLOWED_SENDERS`. Photon entries are E.164 phone
   numbers or Apple ID emails; all other channels use `<channel>:<userId>`
   (for example `telegram:<userId>`), so ids can never collide across platforms.
3. **Paired senders** — anyone approved through the pairing flow (see below).

An empty allowlist means **nobody** is authorized; there is no implicit trust.
Group traffic is denied by default (`ALLOW_GROUPS=false`), requires an explicit
bot mention, and Discord guilds additionally require `DISCORD_ALLOW_GUILDS`.

### Pairing codes and lockouts

An unauthorized direct message triggers a pending pairing challenge instead of
being processed:

- Codes are **8 characters** drawn from an unambiguous alphabet (no `0`, `O`,
  `1`, or `I`), generated with a cryptographically secure RNG.
- Codes expire after **1 hour**; at most **3 pending** requests are tracked per
  store, and re-notification per sender is rate-limited to once per 10 minutes.
- Approving a code happens out of band through the admin CLI
  (`pnpm cli pair approve <code>`); approved senders are namespaced per channel.
- **5 failed approval attempts** lock further attempts for **15 minutes**,
  blunting brute-force guessing of the 8-character space.
- Revoke access with `pnpm cli pair revoke <channel>:<userId>`.

### Network exposure: loopback by default

- Most transports are outbound-only (long polling, WebSocket, TLS) and require
  **no inbound ports**.
- The health server is disabled by default. When enabled it binds to
  `127.0.0.1` and serves read-only JSON (no secrets or message content).
- Callback receivers that must accept inbound HTTP — `webhook`, `wecom`,
  `line`, `whatsapp`, `teams`, and `googlechat` — also bind to `127.0.0.1` by
  default.
- `webhook` refuses to bind to a non-loopback host unless `WEBHOOK_TOKEN` or
  `WEBHOOK_SECRET` is configured.
- Do not expose these ports directly to the internet. If remote delivery is
  required, place a TLS-terminating reverse proxy or tunnel with its own
  authentication in front and override the host deliberately.

### Timing-safe callback verification

Inbound HTTP callbacks are verified before dispatch. Signature and token
comparisons use Node's `crypto.timingSafeEqual` with explicit length checks, and
a missing secret or missing signature header is rejected (fail closed):

- `webhook` — Bearer token and/or `X-Webhook-Signature: sha256=<hmac-hex>`
  (HMAC-SHA256 of the raw body).
- `whatsapp` — `hub.verify_token` GET challenge plus `X-Hub-Signature-256`
  (HMAC-SHA256) using `WHATSAPP_APP_SECRET`.
- `line` — `X-Line-Signature` (Base64 HMAC-SHA256) using `LINE_CHANNEL_SECRET`.
- `teams` — `Authorization: HMAC <base64>` (HMAC-SHA256) using
  `TEAMS_WEBHOOK_SECRET` for outgoing webhooks.
- `wecom` — SHA1 `msg_signature` + `timestamp` + `nonce` verification and
  AES-256-CBC decryption with `WECOM_ENCODING_AES_KEY`.
- `googlechat` — `GOOGLECHAT_VERIFICATION_TOKEN` matched against the event token
  or a Bearer header.

Configure the matching secret/token for every callback receiver so unsigned or
tampered requests are rejected.

### Secret hygiene and repository audits

- Real credentials belong only in a local `.env` file, which is gitignored.
  Commit only `.env.example`, using blank values or `your-...` placeholders.
- Blank strings and `your-...` placeholders are treated as "unset" at load
  time, so a copied example file never enables a channel or weakens validation.
- Run `pnpm audit:secrets` before committing. The script scans all tracked and
  staged files for personal OS paths, Google API keys, private-key blocks, real
  Spectrum credential assignments, and any literal value present in the local
  `.env`. It also fails if a secret-bearing `.env` file is tracked.
- If a credential is ever committed, treat it as compromised: revoke/rotate it
  with the platform, then purge it from history. Removing the file in a later
  commit is not sufficient.
- Use dedicated bot accounts with the minimum scopes needed, and prefer
  per-channel allowlists over broad access.

### Runtime safeguards

- Outbound `MEDIA:<path>` attachments are blocked from `.env*`, `.ssh`, and
  private-key material so the agent cannot exfiltrate local secrets.
- A single-instance PID lock prevents two gateways from racing over the same
  state directory.
- The data directory holds sessions, queues, and pairing state. Treat it as
  sensitive: restrict filesystem permissions and never publish it.

## Hardening Checklist

- [ ] Configure an explicit allowlist for every enabled channel.
- [ ] Keep group access disabled unless required; rely on mention gating.
- [ ] Leave health and webhook listeners on `127.0.0.1`; front with TLS + auth
      if remote access is unavoidable.
- [ ] Set webhook tokens and each platform's signing secret/verification token.
- [ ] Run `pnpm audit:secrets` locally and in CI; keep dependencies updated.
- [ ] Review logs and health output for accidental exposure of user data.

## Scope

In scope: vulnerabilities in this repository's code, configuration defaults, and
documentation. Out of scope: defects in third-party platform APIs, the
Antigravity `agy` CLI, and risks caused solely by operator misconfiguration
(such as intentionally exposing a loopback port without authentication).