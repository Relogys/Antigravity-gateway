#!/usr/bin/env bash
set -euo pipefail

ONE_SHOT=0
for arg in "$@"; do
  case "$arg" in
    --one-shot|-1)
      ONE_SHOT=1
      ;;
    -h|--help)
      echo "Usage: $0 [--one-shot]"
      echo "Supervises Antigravity Gateway with exponential crash backoff (2s..60s) and 5MB log rotation."
      exit 0
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

LOGS_DIR="${LOG_DIR:-$REPO_ROOT/logs}"
mkdir -p "$LOGS_DIR"

GATEWAY_LOG="$LOGS_DIR/gateway.log"
SUPERVISOR_LOG="$LOGS_DIR/supervisor.log"
DIST_ENTRY="$REPO_ROOT/dist/index.js"
MAX_LOG_BYTES=$((5 * 1024 * 1024))

if [ ! -f "$DIST_ENTRY" ]; then
  echo "Building Antigravity Gateway..."
  pnpm build
fi

log_supervisor() {
  printf '%s %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$1" >> "$SUPERVISOR_LOG"
}

file_size_bytes() {
  local target="$1"
  if stat -f%z "$target" >/dev/null 2>&1; then
    stat -f%z "$target"
  elif stat -c%s "$target" >/dev/null 2>&1; then
    stat -c%s "$target"
  else
    wc -c < "$target" | tr -d ' '
  fi
}

rotate_gateway_log() {
  if [ ! -f "$GATEWAY_LOG" ]; then
    return
  fi
  local size
  size="$(file_size_bytes "$GATEWAY_LOG")"
  if [ "${size:-0}" -le "$MAX_LOG_BYTES" ]; then
    return
  fi
  rm -f "$GATEWAY_LOG.3"
  if [ -f "$GATEWAY_LOG.2" ]; then
    mv -f "$GATEWAY_LOG.2" "$GATEWAY_LOG.3"
  fi
  if [ -f "$GATEWAY_LOG.1" ]; then
    mv -f "$GATEWAY_LOG.1" "$GATEWAY_LOG.2"
  fi
  mv -f "$GATEWAY_LOG" "$GATEWAY_LOG.1"
  log_supervisor "Rotated gateway.log (exceeded 5MB)."
}

CHILD_PID=""
STOPPING=0

handle_signal() {
  STOPPING=1
  if [ -n "$CHILD_PID" ] && kill -0 "$CHILD_PID" 2>/dev/null; then
    log_supervisor "Forwarding termination signal to gateway PID $CHILD_PID."
    kill -TERM "$CHILD_PID" 2>/dev/null || true
    wait "$CHILD_PID" 2>/dev/null || true
  fi
  exit 0
}

trap handle_signal INT TERM

DELAY=2
while true; do
  rotate_gateway_log
  log_supervisor "Launching: node $DIST_ENTRY"
  echo "Launching gateway (logs: $GATEWAY_LOG)"

  STARTED_AT="$(date +%s)"
  set +e
  node "$DIST_ENTRY" >> "$GATEWAY_LOG" 2>&1 &
  CHILD_PID=$!
  wait "$CHILD_PID"
  EXIT_CODE=$?
  set -e
  CHILD_PID=""

  if [ "$STOPPING" -eq 1 ]; then
    exit 0
  fi

  NOW="$(date +%s)"
  RAN_SECONDS=$((NOW - STARTED_AT))

  if [ "$EXIT_CODE" -eq 0 ]; then
    log_supervisor "Gateway exited cleanly after ${RAN_SECONDS}s."
    echo "Gateway exited cleanly."
    exit 0
  fi

  log_supervisor "Gateway crashed with exit code ${EXIT_CODE} after ${RAN_SECONDS}s."
  if [ "$ONE_SHOT" -eq 1 ]; then
    log_supervisor "OneShot set; exiting without restart."
    echo "Gateway crashed (exit code $EXIT_CODE); --one-shot set, not restarting."
    exit "$EXIT_CODE"
  fi

  if [ "$RAN_SECONDS" -gt 60 ]; then
    DELAY=2
  fi
  log_supervisor "Restarting in ${DELAY}s."
  echo "Gateway crashed (exit code $EXIT_CODE); restarting in ${DELAY}s..."
  sleep "$DELAY"
  DELAY=$((DELAY * 2))
  if [ "$DELAY" -gt 60 ]; then
    DELAY=60
  fi
done
