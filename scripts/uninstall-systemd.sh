#!/usr/bin/env bash
set -euo pipefail

if [ "$(uname -s)" != "Linux" ]; then
  echo "This script is for Linux (systemd --user)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

if [ -f "$REPO_ROOT/dist/cli.js" ]; then
  node "$REPO_ROOT/dist/cli.js" service uninstall
  exit 0
fi

UNIT="antigravity-gateway.service"
UNIT_PATH="$HOME/.config/systemd/user/$UNIT"
systemctl --user disable --now "$UNIT" 2>/dev/null || true
rm -f "$UNIT_PATH"
systemctl --user daemon-reload 2>/dev/null || true
echo "Removed systemd user service: $UNIT_PATH"
