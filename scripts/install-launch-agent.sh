#!/usr/bin/env bash
set -euo pipefail

LABEL="com.firm.control-room"
DOMAIN="gui/$(id -u)"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME="$HOME/.local/lib/firm-control-room"
STATE="$HOME/.local/state/firm-control-room"
SOURCE="$REPO/scripts/${LABEL}.plist"
TARGET="$HOME/Library/LaunchAgents/${LABEL}.plist"

mkdir -p "$HOME/Library/LaunchAgents" "$RUNTIME" "$STATE"

# LaunchAgents cannot reliably traverse macOS-protected Documents/Desktop paths.
# Install a private runtime copy and keep mutable state outside the code tree.
rsync -a --delete \
  --exclude var \
  --exclude .git \
  "$REPO/" "$RUNTIME/"

chmod +x \
  "$RUNTIME/scripts/firm-supervisor.command" \
  "$RUNTIME/scripts/launch-firm-if-needed.sh"

if [[ ! -f "$STATE/history.sqlite" && -d "$REPO/var" ]]; then
  rsync -a "$REPO/var/" "$STATE/"
fi

sed -i '' \
  -e "s|^FIRM_CONFIG=.*|FIRM_CONFIG=$RUNTIME/local/projects.json|" \
  -e "s|^FIRM_DATA_DIR=.*|FIRM_DATA_DIR=$STATE|" \
  -e "s|^FIRM_CONTROL_SESSION_PATHS=.*|FIRM_CONTROL_SESSION_PATHS=$RUNTIME/local/GPU_SCHEDULER|" \
  "$RUNTIME/.env.local"

sed "s|__HOME__|$HOME|g" "$SOURCE" > "$TARGET"
chmod 600 "$TARGET"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$TARGET"
launchctl enable "$DOMAIN/$LABEL"
launchctl kickstart -k "$DOMAIN/$LABEL"

echo "Installed and started $DOMAIN/$LABEL"
