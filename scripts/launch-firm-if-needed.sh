#!/usr/bin/env bash
set -u

RUNTIME="$HOME/.local/lib/firm-control-room"
STATE="$HOME/.local/state/firm-control-room"
PID_FILE="$STATE/supervisor.pid"

# A live supervisor may be restarting the Web process during the health probe.
# Do not open another Terminal window while that owner is still alive.
if [[ -f "$PID_FILE" ]]; then
  prior="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ "$prior" =~ ^[0-9]+$ ]] && kill -0 "$prior" 2>/dev/null; then
    exit 0
  fi
fi

if /usr/bin/curl -fsS --connect-timeout 2 --max-time 3 \
  http://127.0.0.1:8787/api/health >/dev/null 2>&1; then
  exit 0
fi

# A .command file runs under a foreground terminal permission domain. That is
# required for the iTerm Apple Events used to inspect and resume Claude panes.
/usr/bin/open "$RUNTIME/scripts/firm-supervisor.command"
