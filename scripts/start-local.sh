#!/usr/bin/env bash
set -euo pipefail

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck source=/dev/null
source "$NVM_DIR/nvm.sh"
nvm use 26 >/dev/null

cd "$(dirname "$0")/.."
exec npm run start:local
