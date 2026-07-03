#!/usr/bin/env bash
# Dev watch loop for evolver/scripts/bedrock-alias-watch.sh.
#
# Starts a local Slack receiver in the background (so the watch script
# can POST somewhere real) and re-runs the watch script every
# WATCH_INTERVAL seconds (default 60). The operator edits
# dev-fixtures/aws.html in real time and sees the resulting Slack
# payload printed in their terminal.
#
# Usage:
#   bash scripts/dev-watch.sh                       # 60s interval
#   WATCH_INTERVAL=10 bash scripts/dev-watch.sh     # 10s interval
#   make watch-fresh                                # clear state, then watch
#
# On Ctrl-C the receiver is killed and the loop exits cleanly.
#
# Layout (all under dev-fixtures/):
#   aws.html             — mock AWS doc (operator edits this)
#   messages_route.js     — mock KNOWN_BEDROCK_ALIASES table
#   state/                — watch state (gitignored)
#   .receiver.port        — receiver port (gitignored)
#   .receiver.pid         — receiver pid (gitignored)
#   receiver.log          — receiver log (gitignored, tailed in this terminal)

set -euo pipefail

WATCH_INTERVAL="${WATCH_INTERVAL:-60}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEV_DIR="$ROOT_DIR/dev-fixtures"
WATCH_SCRIPT="$SCRIPT_DIR/bedrock-alias-watch.sh"
RECEIVER_SCRIPT="$SCRIPT_DIR/dev-slack-receiver.js"
PORT_FILE="$DEV_DIR/.receiver.port"
PID_FILE="$DEV_DIR/.receiver.pid"
LOG_FILE="$DEV_DIR/receiver.log"

mkdir -p "$DEV_DIR/state"

# Kill any stale receiver from a previous run that didn't shut down
# cleanly. We match by command name (not by pid file) to avoid the
# PID-reuse risk — if the OS recycled the old pid for an unrelated
# process, a pid-based kill would terminate the wrong target. The
# receiver's listen(0) means the new instance gets a fresh port
# regardless, so stale processes are harmless aside from leaked memory.
pkill -f 'node.*dev-slack-receiver\.js' 2>/dev/null || true
# Give the OS a moment to release the pkill target.
sleep 0.1
rm -f "$PID_FILE" "$PORT_FILE"

RECEIVER_PID=""
TAIL_PID=""

cleanup() {
  echo ""
  echo "[dev-watch] shutting down..."
  if [[ -n "$TAIL_PID" ]] && kill -0 "$TAIL_PID" 2>/dev/null; then
    kill "$TAIL_PID" 2>/dev/null || true
  fi
  if [[ -n "$RECEIVER_PID" ]] && kill -0 "$RECEIVER_PID" 2>/dev/null; then
    kill "$RECEIVER_PID" 2>/dev/null || true
    sleep 0.2
    kill -9 "$RECEIVER_PID" 2>/dev/null || true
  fi
  rm -f "$PID_FILE" "$PORT_FILE"
  echo "[dev-watch] done"
}
trap cleanup EXIT INT TERM

# Start the Slack receiver in the background.
echo "[dev-watch] starting local Slack receiver..."
node "$RECEIVER_SCRIPT" \
  --port-file="$PORT_FILE" \
  --log-file="$LOG_FILE" \
  --log-prefix="[slack-receiver]" \
  >/dev/null 2>&1 &
RECEIVER_PID=$!
echo "$RECEIVER_PID" > "$PID_FILE"

# Wait for the receiver to write its port (max 2s).
for _ in {1..40}; do
  if [[ -s "$PORT_FILE" ]]; then break; fi
  sleep 0.05
done
if [[ ! -s "$PORT_FILE" ]]; then
  echo "[dev-watch] receiver failed to start — see $LOG_FILE"
  exit 1
fi

PORT="$(cat "$PORT_FILE")"

# Truncate the log so this run starts with a clean slate.
: > "$LOG_FILE"

# Tail the receiver log so the operator sees the payload in real time.
# This is separate from the watch script's own stderr output, so the
# terminal shows both: the script's "diff: …" log lines + the Slack
# payload that the script posted.
tail -n 0 -f "$LOG_FILE" &
TAIL_PID=$!

echo "[dev-watch] receiver listening on http://127.0.0.1:$PORT"
echo "[dev-watch] edit $DEV_DIR/aws.html to add/remove model IDs"
echo "[dev-watch] watch interval: ${WATCH_INTERVAL}s (override: WATCH_INTERVAL=10 bash scripts/dev-watch.sh)"
echo "[dev-watch] Ctrl-C to stop"
echo ""

i=0
while true; do
  i=$((i+1))
  echo "=== run $i at $(date -Iseconds) ==="
  # Run the watch script. A non-zero exit (e.g. AWS fetch fail) is
  # expected in some scenarios and shouldn't kill the watch loop.
  # DRY_RUN=0 is set explicitly so a stale DRY_RUN=1 in the operator's
  # shell env doesn't silently suppress the Slack post.
  STATE_DIR="$DEV_DIR/state" \
  MESSAGES_ROUTE_FILE="$DEV_DIR/messages_route.js" \
  AWS_BEDROCK_URL="file://$DEV_DIR/aws.html" \
  SLACK_WEBHOOK_URL="http://127.0.0.1:$PORT/slack" \
  DRY_RUN=0 \
    bash "$WATCH_SCRIPT" || echo "[dev-watch] watch script exited non-zero (continuing)"
  if [[ "$WATCH_INTERVAL" == "0" ]]; then
    # Single-run mode (used by `make watch-once`).
    break
  fi
  echo "[dev-watch] sleeping ${WATCH_INTERVAL}s... (Ctrl-C to stop)"
  sleep "$WATCH_INTERVAL"
done
