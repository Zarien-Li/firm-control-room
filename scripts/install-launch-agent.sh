#!/usr/bin/env bash
set -euo pipefail

WEB_LABEL="com.firm.control-room"
BROKER_LABEL="com.firm.control-room.broker"
DOMAIN="gui/$(id -u)"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME="$HOME/.local/lib/firm-control-room"
STATE="$HOME/.local/state/firm-control-room"
WEB_SOURCE="$REPO/scripts/${WEB_LABEL}.plist"
BROKER_SOURCE="$REPO/scripts/${BROKER_LABEL}.plist"
WEB_TARGET="$HOME/Library/LaunchAgents/${WEB_LABEL}.plist"
BROKER_TARGET="$HOME/Library/LaunchAgents/${BROKER_LABEL}.plist"
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
  echo "FIRM service installation requires Node.js 26+" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$RUNTIME" "$STATE"

# Stop the previous Web and broker services before replacing runtime files or
# compacting SQLite. launchd will be the only process supervisor after install.
launchctl bootout "$DOMAIN/$WEB_LABEL" 2>/dev/null || true
launchctl bootout "$DOMAIN/$BROKER_LABEL" 2>/dev/null || true
for _ in {1..10}; do
  if ! launchctl print "$DOMAIN/$WEB_LABEL" >/dev/null 2>&1 \
      && ! launchctl print "$DOMAIN/$BROKER_LABEL" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# LaunchAgents cannot reliably traverse macOS-protected Documents/Desktop paths.
# Install a private runtime copy and keep mutable state outside the code tree.
rsync -a --delete \
  --exclude var \
  --exclude .git \
  "$REPO/" "$RUNTIME/"

touch "$RUNTIME/.env.local"

chmod +x \
  "$RUNTIME/scripts/firm-supervisor.command" \
  "$RUNTIME/scripts/firm-broker.command"

if [[ ! -f "$STATE/history.sqlite" && -d "$REPO/var" ]]; then
  rsync -a "$REPO/var/" "$STATE/"
fi

set_env() {
  key="$1"
  value="$2"
  file="$3"
  if grep -q "^${key}=" "$file"; then
    sed -i '' -e "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}
set_env FIRM_CONFIG "$RUNTIME/local/projects.json" "$RUNTIME/.env.local"
set_env FIRM_DATA_DIR "$STATE" "$RUNTIME/.env.local"
set_env FIRM_CONTROL_SESSION_PATHS "$RUNTIME/local/GPU_SCHEDULER" "$RUNTIME/.env.local"
set_env FIRM_BROKER_SOCKET "$STATE/control-plane/broker.sock" "$RUNTIME/.env.local"
set_env FIRM_BROKER_AUTOSTART false "$RUNTIME/.env.local"
set_env FIRM_SCAN_RETENTION 50 "$RUNTIME/.env.local"
set_env FIRM_GPU_SNAPSHOT_RETENTION 200 "$RUNTIME/.env.local"
set_env FIRM_GPU_SCHEDULER_AUTO_START true "$RUNTIME/.env.local"
set_env FIRM_GPU_QUEUE_RUNNER_ENSURE true "$RUNTIME/.env.local"

# Machine-local settings are intentionally ignored by Git. Reapply them after
# every upgrade so portable defaults never overwrite host-specific paths or credentials.
if [[ -f "$REPO/local/runtime.env" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || {
      echo "Invalid local runtime setting: $key" >&2
      exit 1
    }
    set_env "$key" "$value" "$RUNTIME/.env.local"
  done < "$REPO/local/runtime.env"
fi

"$NODE" --env-file="$RUNTIME/.env.local" "$RUNTIME/scripts/compact-history.js"

sed "s|__HOME__|$HOME|g" "$WEB_SOURCE" > "$WEB_TARGET"
sed "s|__HOME__|$HOME|g" "$BROKER_SOURCE" > "$BROKER_TARGET"

# launchd does not inherit an interactive Homebrew/nvm PATH. Persist the exact
# executable selected above so Web and Broker restart with the tested Node runtime.
set_launchd_env() {
  local plist="$1"
  local key="$2"
  local value="$3"
  /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables dict" "$plist" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Delete :EnvironmentVariables:${key}" "$plist" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:${key} string ${value}" "$plist"
}
set_launchd_env "$WEB_TARGET" FIRM_NODE_EXECUTABLE "$NODE"
set_launchd_env "$BROKER_TARGET" FIRM_NODE_EXECUTABLE "$NODE"
chmod 600 "$WEB_TARGET" "$BROKER_TARGET"

bootstrap() {
  label="$1"
  target="$2"
  for attempt in 1 2 3; do
    if launchctl bootstrap "$DOMAIN" "$target"; then
      launchctl enable "$DOMAIN/$label"
      return 0
    fi
    if [[ "$attempt" == 3 ]]; then
      echo "Failed to bootstrap $DOMAIN/$label after $attempt attempts" >&2
      return 1
    fi
    sleep 1
  done
}
bootstrap "$BROKER_LABEL" "$BROKER_TARGET"
bootstrap "$WEB_LABEL" "$WEB_TARGET"

echo "Installed and started $DOMAIN/$BROKER_LABEL and $DOMAIN/$WEB_LABEL"
