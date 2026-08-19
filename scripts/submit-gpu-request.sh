#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -f "$ROOT/.env.local" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ROOT/.env.local"
  set +a
fi

: "${FIRM_GPU_QUEUE_HOST:?Set FIRM_GPU_QUEUE_HOST in the environment or .env.local}"
: "${FIRM_GPU_QUEUE_DOCKER_CONTAINER:?Set FIRM_GPU_QUEUE_DOCKER_CONTAINER in the environment or .env.local}"
: "${FIRM_GPU_QUEUE_ROOT:?Set FIRM_GPU_QUEUE_ROOT in the environment or .env.local}"

HOST="$FIRM_GPU_QUEUE_HOST"
PORT="${FIRM_GPU_QUEUE_SSH_PORT:-22}"
CONTAINER="$FIRM_GPU_QUEUE_DOCKER_CONTAINER"
QUEUE_ROOT="$FIRM_GPU_QUEUE_ROOT"
ALLOWED_PROJECTS="${FIRM_GPU_QUEUE_ALLOWED_PROJECTS:-}"
REMOTE_PROJECT_ROOT="${FIRM_GPU_QUEUE_PROJECT_ROOT:-}"
GPU_TYPE="${FIRM_GPU_QUEUE_GPU_TYPE:-NVIDIA GPU}"

usage() {
  cat <<'EOF'
Usage: submit-gpu-request.sh \
  --project ACL_2 \
  --purpose matched_eval \
  --project-dir /home/lzy/AAAI_2026/ACL_2/composable_peft \
  --remote-command-file /home/lzy/AAAI_2026/ACL_2/composable_peft/gpu_jobs/matched_eval.sh \
  --estimated-time 2h --max-time 4h \
  --expected-vram-mib 24000 \
  --expected-utilization 70-100% \
  --progress-marker 'step=<n>/<total>'

The remote command file must already be compute-ready. It must not select GPU ids,
launch Docker, install/download dependencies, or perform ordinary preprocessing.
The command prints the canonical RUN_ID after atomically publishing .submitted.
EOF
}

PROJECT=""
PURPOSE=""
PROJECT_DIR=""
COMMAND_FILE=""
PRIORITY="normal"
GPU_COUNT="1"
ESTIMATED_TIME=""
MAX_TIME=""
FIRST_GPU_ACTION="model_load"
EXPECTED_UTILIZATION=""
PROGRESS_MARKER=""
PREPARATION_EXCEPTION="none"
EXPECTED_VRAM_MIB=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="${2:-}"; shift 2 ;;
    --purpose) PURPOSE="${2:-}"; shift 2 ;;
    --project-dir) PROJECT_DIR="${2:-}"; shift 2 ;;
    --remote-command-file) COMMAND_FILE="${2:-}"; shift 2 ;;
    --priority) PRIORITY="${2:-}"; shift 2 ;;
    --gpu-count) GPU_COUNT="${2:-}"; shift 2 ;;
    --estimated-time) ESTIMATED_TIME="${2:-}"; shift 2 ;;
    --max-time) MAX_TIME="${2:-}"; shift 2 ;;
    --first-gpu-action) FIRST_GPU_ACTION="${2:-}"; shift 2 ;;
    --expected-utilization) EXPECTED_UTILIZATION="${2:-}"; shift 2 ;;
    --expected-vram-mib) EXPECTED_VRAM_MIB="${2:-}"; shift 2 ;;
    --progress-marker) PROGRESS_MARKER="${2:-}"; shift 2 ;;
    --preparation-exception) PREPARATION_EXCEPTION="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -n "$ALLOWED_PROJECTS" ]]; then
  case ",${ALLOWED_PROJECTS// /}," in
    *",$PROJECT,"*) ;;
    *) echo "Unsupported project: $PROJECT" >&2; exit 2 ;;
  esac
fi
[[ "$PURPOSE" =~ ^[a-z0-9][a-z0-9_-]{1,47}$ ]] || {
  echo "--purpose must match [a-z0-9][a-z0-9_-]{1,47}" >&2; exit 2;
}
[[ "$PROJECT_DIR" == /* ]] || { echo "--project-dir must be absolute" >&2; exit 2; }
if [[ -n "$REMOTE_PROJECT_ROOT" && "$PROJECT_DIR" != "$REMOTE_PROJECT_ROOT"/* ]]; then
  echo "--project-dir must be under $REMOTE_PROJECT_ROOT" >&2
  exit 2
fi
[[ "$COMMAND_FILE" == "$PROJECT_DIR"/* ]] || {
  echo "--remote-command-file must be inside --project-dir" >&2; exit 2;
}
[[ "$PRIORITY" =~ ^(low|normal|high)$ ]] || { echo "Invalid priority" >&2; exit 2; }
[[ "$GPU_COUNT" =~ ^[1-9][0-9]*$ ]] || { echo "Invalid gpu-count" >&2; exit 2; }
[[ "$EXPECTED_VRAM_MIB" =~ ^[1-9][0-9]*$ ]] || {
  echo "--expected-vram-mib must be a positive integer (per allocated GPU)" >&2; exit 2;
}
[[ "$FIRST_GPU_ACTION" =~ ^(model_load|compute|resume_compute|gpu_required_compile)$ ]] || {
  echo "Invalid first-gpu-action" >&2; exit 2;
}
for value in "$PROJECT_DIR" "$COMMAND_FILE" "$ESTIMATED_TIME" "$MAX_TIME" "$EXPECTED_UTILIZATION" "$PROGRESS_MARKER" "$PREPARATION_EXCEPTION" "$EXPECTED_VRAM_MIB"; do
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || {
    echo "Metadata values must be single-line" >&2; exit 2;
  }
  [[ "$value" != *"'"* ]] || {
    echo "Paths and metadata must not contain single quotes" >&2; exit 2;
  }
done
[[ -n "$ESTIMATED_TIME" && -n "$MAX_TIME" && -n "$EXPECTED_UTILIZATION" && -n "$PROGRESS_MARKER" ]] || {
  echo "estimated-time, max-time, expected-utilization, and progress-marker are required" >&2; exit 2;
}

STAMP="$(date -u +%Y%m%d_%H%M%S)"
RUN_ID="${PROJECT}_${PURPOSE}_${STAMP}"
CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

ssh -p "$PORT" -o BatchMode=yes -o ConnectTimeout=10 "$HOST" \
  "docker exec -i '$CONTAINER' bash -s -- \
    '$QUEUE_ROOT' '$RUN_ID' '$PROJECT' '$PURPOSE' '$PROJECT_DIR' '$COMMAND_FILE' \
    '$PRIORITY' '$GPU_COUNT' '$ESTIMATED_TIME' '$MAX_TIME' '$FIRST_GPU_ACTION' \
    '$EXPECTED_UTILIZATION' '$PROGRESS_MARKER' '$PREPARATION_EXCEPTION' '$CREATED_AT' '$GPU_TYPE' '$EXPECTED_VRAM_MIB'" <<'REMOTE'
set -euo pipefail
QUEUE_ROOT=$1
RUN_ID=$2
PROJECT=$3
PURPOSE=$4
PROJECT_DIR=$5
COMMAND_FILE=$6
PRIORITY=$7
GPU_COUNT=$8
ESTIMATED_TIME=$9
MAX_TIME=${10}
FIRST_GPU_ACTION=${11}
EXPECTED_UTILIZATION=${12}
PROGRESS_MARKER=${13}
PREPARATION_EXCEPTION=${14}
CREATED_AT=${15}
GPU_TYPE=${16}
EXPECTED_VRAM_MIB=${17}

[[ -d "$PROJECT_DIR" ]] || { echo "Project directory missing: $PROJECT_DIR" >&2; exit 3; }
[[ -f "$COMMAND_FILE" ]] || { echo "Command file missing: $COMMAND_FILE" >&2; exit 3; }
grep -Eq '^set -euo pipefail[[:space:]]*$' "$COMMAND_FILE" || {
  echo "command.sh must contain: set -euo pipefail" >&2; exit 3;
}
if grep -Eqi 'CUDA_VISIBLE_DEVICES|docker[[:space:]]+(exec|run)|pip[[:space:]]+install|conda[[:space:]]+install|apt(-get)?[[:space:]]+|git[[:space:]]+clone|(^|[;&|[:space:]])(curl|wget)[[:space:]]' "$COMMAND_FILE"; then
  echo "Command contains scheduler-owned GPU selection or non-compute preparation" >&2
  exit 3
fi

mkdir -p "$QUEUE_ROOT"/{pending,running,done,failed,cancelled}
FINAL="$QUEUE_ROOT/pending/$RUN_ID"
TMP="$QUEUE_ROOT/pending/.${RUN_ID}.tmp.$$"
[[ ! -e "$FINAL" ]] || { echo "Run already exists: $RUN_ID" >&2; exit 4; }
mkdir "$TMP"
cp "$COMMAND_FILE" "$TMP/command.sh"
chmod 0755 "$TMP/command.sh"
cat > "$TMP/REQUEST.md" <<EOF
run_id: $RUN_ID
project: $PROJECT
purpose: $PURPOSE
project_dir: $PROJECT_DIR
priority: $PRIORITY
created_at: $CREATED_AT
gpu_type: $GPU_TYPE
gpu_count: $GPU_COUNT
estimated_time: $ESTIMATED_TIME
max_time: $MAX_TIME
requires_gpu_parallel: $([[ "$GPU_COUNT" -gt 1 ]] && echo true || echo false)
readiness: compute_ready
code_ready: true
dependencies_ready: true
data_ready: true
preprocessing_complete: true
config_frozen: true
cpu_smoke_passed: true
telemetry_ready: true
first_gpu_action: $FIRST_GPU_ACTION
expected_compute_utilization: $EXPECTED_UTILIZATION
expected_vram_mib: $EXPECTED_VRAM_MIB
expected_progress_marker: $PROGRESS_MARKER
preparation_exception: $PREPARATION_EXCEPTION
EOF
mv "$TMP" "$FINAL"
touch "$FINAL/.submitted"
printf '%s\n' "$RUN_ID"
REMOTE

printf 'SUBMITTED RUN_ID=%s\n' "$RUN_ID"
