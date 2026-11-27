#!/usr/bin/env bash
set -euo pipefail

# Checksum-verified installer for macOS (Apple Silicon / Intel) & Linux.
# Downloads the prebuilt release tarball + SHA256SUMS.txt from GitHub Releases,
# verifies SHA-256 integrity, and installs `antigravity-gateway` globally via npm.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Relogys/Antigravity-gateway/main/scripts/install.sh | bash
#   curl -fsSL ... | bash -s -- --version v0.4.0

REPO="Relogys/Antigravity-gateway"
TAG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --version|-v)
      TAG="${2:-}"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 [--version vX.Y.Z]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: required command '$1' is not installed." >&2
    exit 1
  fi
}

require_cmd curl
require_cmd node
require_cmd npm

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
  echo "Error: Node.js >= 22 is required (found $(node -v))." >&2
  exit 1
fi

if [ -z "$TAG" ]; then
  echo "Resolving latest release from github.com/$REPO ..."
  TAG="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | node -e "const d = JSON.parse(require('fs').readFileSync(0,'utf8')); if (!d.tag_name) process.exit(1); console.log(d.tag_name);")"
fi

VERSION="${TAG#v}"
TARBALL="antigravity-gateway-${VERSION}.tgz"
BASE_URL="https://github.com/$REPO/releases/download/$TAG"

TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

echo "Downloading $TARBALL and SHA256SUMS.txt ($TAG)..."
curl -fsSL "$BASE_URL/$TARBALL" -o "$TMP_DIR/$TARBALL"
curl -fsSL "$BASE_URL/SHA256SUMS.txt" -o "$TMP_DIR/SHA256SUMS.txt"

echo "Verifying SHA-256 checksum..."
(
  cd "$TMP_DIR"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -c SHA256SUMS.txt
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c SHA256SUMS.txt
  else
    echo "Error: neither shasum nor sha256sum found." >&2
    exit 1
  fi
)

echo "Installing antigravity-gateway ($TAG) globally..."
npm install -g "$TMP_DIR/$TARBALL"

echo ""
echo "Installed antigravity-gateway $TAG successfully!"
echo "Next steps:"
echo "  antigravity-gateway init       # Interactive setup wizard"
echo "  antigravity-gateway doctor     # Verify Node, agy, channels & permissions"
echo "  antigravity-gateway service install  # Optional: macOS launchd / Linux systemd autostart"
