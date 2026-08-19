#!/usr/bin/env bash
set -euo pipefail

RUNTIME="$HOME/.local/lib/firm-control-room"
STATE="$HOME/.local/state/firm-control-room"
NODE="${FIRM_NODE_EXECUTABLE:-}"
if [[ -z "$NODE" && -s "$HOME/.nvm/nvm.sh" ]]; then
  unset npm_config_prefix
  # shellcheck source=/dev/null
  source "$HOME/.nvm/nvm.sh"
  NODE="$(nvm which 26 2>/dev/null || true)"
fi
if [[ -z "$NODE" ]]; then
  NODE="$(command -v node || true)"
fi
if [[ -z "$NODE" || ! -x "$NODE" ]]; then
  printf '%s FIRM broker could not locate Node.js 26+\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    >> "$STATE/broker-service.log"
  exit 1
fi

mkdir -p "$STATE"
cd "$RUNTIME"
exec "$NODE" --env-file="$RUNTIME/.env.local" "$RUNTIME/src/broker.js"
