#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -f "$ROOT/.env.local" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ROOT/.env.local"
  set +a
fi

: "${FIRM_GPU_QUEUE_HOST:?Set FIRM_GPU_QUEUE_HOST in .env.local}"
: "${FIRM_GPU_QUEUE_DOCKER_CONTAINER:?Set FIRM_GPU_QUEUE_DOCKER_CONTAINER in .env.local}"
: "${FIRM_GPU_QUEUE_ROOT:?Set FIRM_GPU_QUEUE_ROOT in .env.local}"

HOST="$FIRM_GPU_QUEUE_HOST"
PORT="${FIRM_GPU_QUEUE_SSH_PORT:-22}"
CONTAINER="$FIRM_GPU_QUEUE_DOCKER_CONTAINER"
QUEUE="$FIRM_GPU_QUEUE_ROOT"
SOURCE="$ROOT/scripts/firm-gpu-queue-runner.sh"
TARGET="$QUEUE/firm_gpu_queue_runner.sh"

ssh -p "$PORT" -o BatchMode=yes -o ConnectTimeout=10 "$HOST" \
  "docker exec -i '$CONTAINER' tee '$TARGET' >/dev/null && docker exec '$CONTAINER' chmod 0755 '$TARGET'" < "$SOURCE"
ssh -p "$PORT" -o BatchMode=yes -o ConnectTimeout=10 "$HOST" \
  "docker exec '$CONTAINER' '$TARGET' --ensure"
printf 'FIRM GPU queue runner deployed and ensured at %s\n' "$TARGET"
