#!/usr/bin/env bash
set -u

RUNTIME="$HOME/.local/lib/firm-control-room"
STATE="$HOME/.local/state/firm-control-room"
PID_FILE="$STATE/supervisor.pid"
NODE="${FIRM_NODE_EXECUTABLE:-}"
if [[ -z "$NODE" && -s "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck source=/dev/null
  source "$HOME/.nvm/nvm.sh"
  NODE="$(nvm which 26 2>/dev/null || true)"
fi
if [[ -z "$NODE" ]]; then
  NODE="$(command -v node || true)"
fi
if [[ -z "$NODE" || ! -x "$NODE" ]]; then
  printf '%s FIRM could not locate Node.js 26+\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    >> "$STATE/supervisor.log"
  exit 1
fi

mkdir -p "$STATE"
if [[ -f "$PID_FILE" ]]; then
  prior="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ "$prior" =~ ^[0-9]+$ ]] && kill -0 "$prior" 2>/dev/null; then
    exit 0
  fi
fi
echo $$ > "$PID_FILE"
cleanup() {
  rm -f "$PID_FILE"
  exit 0
}
trap cleanup EXIT INT TERM

cd "$RUNTIME" || exit 1
while true; do
  "$NODE" --env-file="$RUNTIME/.env.local" "$RUNTIME/src/start.js"
  status=$?
  printf '%s FIRM exited with status %s; restarting in 5 seconds\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$status" \
    >> "$STATE/supervisor.log"
  sleep 5
done
