#!/usr/bin/env bash
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This script is for macOS (launchd). On Linux use scripts/install-systemd.sh." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

if [ ! -f "$REPO_ROOT/dist/index.js" ] || [ ! -f "$REPO_ROOT/dist/cli.js" ]; then
  echo "Building Antigravity Gateway..."
  pnpm build
fi

node "$REPO_ROOT/dist/cli.js" service install
