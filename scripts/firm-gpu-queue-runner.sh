#!/usr/bin/env bash
# FIRM_GPU_QUEUE_RUNNER: the sole executor of queue lifecycle transitions.
# It records process identity before exec and a terminal manifest before moving a run.
set -euo pipefail

QUEUE_ROOT="${FIRM_GPU_QUEUE_ROOT:-/home/lzy/AAAI_2026/gpu_queue}"
RUNNER_NAME="FIRM_GPU_QUEUE_RUNNER"
POLL_SEC="${FIRM_GPU_QUEUE_RUNNER_POLL_SEC:-15}"
HEADROOM_MIB="${FIRM_GPU_QUEUE_HEADROOM_MIB:-2048}"
RUNNER_PID_FILE="$QUEUE_ROOT/.firm-runner.pid"
RUNNER_HEARTBEAT="$QUEUE_ROOT/.firm-runner-heartbeat.json"

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

ensure_layout() {
  mkdir -p "$QUEUE_ROOT"/{pending,running,done,failed,cancelled}
}

json_write() {
  local path="$1"
  local payload="$2"
  local tmp="${path}.tmp.$$"
  printf '%s\n' "$payload" > "$tmp"
  mv "$tmp" "$path"
}

json_object() {
  python3 - "$@" <<'PY'
import json, sys
values = sys.argv[1:]
if len(values) % 2:
    raise SystemExit('json_object requires key/value pairs')
print(json.dumps(dict(zip(values[::2], values[1::2])), ensure_ascii=False, sort_keys=True))
PY
}

request_value() {
  local file="$1" key="$2"
  awk -F': *' -v wanted="$key" '$1 == wanted { sub(/^[^:]*: */, ""); print; exit }' "$file"
}

pid_start_ticks() {
  local pid="$1"
  [[ -r "/proc/$pid/stat" ]] || return 1
  awk '{print $22}' "/proc/$pid/stat"
}

write_heartbeat() {
  local pid="$$" start_ticks
  start_ticks="$(pid_start_ticks "$pid")"
  json_write "$RUNNER_HEARTBEAT" "$(json_object \
    runner "$RUNNER_NAME" pid "$pid" sampled_at "$(now_iso)" \
    pid_start_ticks "$start_ticks" protocol_version "1")"
}

validate_request() {
  local run_dir="$1"
  local request="$run_dir/REQUEST.md"
  local command="$run_dir/command.sh"
  [[ -f "$request" && -x "$command" ]] || return 1
  grep -Eq '^set -euo pipefail[[:space:]]*$' "$command" || return 1
  local expected
  expected="$(request_value "$request" expected_vram_mib || true)"
  [[ "$expected" =~ ^[1-9][0-9]*$ ]]
}

select_gpus() {
  local gpu_count="$1" required_mib="$2"
  local selected=()
  local line index used total free
  while IFS=',' read -r index used total; do
    index="${index//[[:space:]]/}"
    used="${used//[[:space:]]/}"
    total="${total//[[:space:]]/}"
    [[ "$index" =~ ^[0-9]+$ && "$used" =~ ^[0-9]+$ && "$total" =~ ^[0-9]+$ ]] || continue
    free=$((total - used - HEADROOM_MIB))
    if (( free >= required_mib )); then
      selected+=("$index")
      (( ${#selected[@]} >= gpu_count )) && break
    fi
  done < <(nvidia-smi --query-gpu=index,memory.used,memory.total --format=csv,noheader,nounits)
  if (( ${#selected[@]} < gpu_count )); then
    return 1
  fi
  (IFS=,; printf '%s' "${selected[*]}")
}

write_launch_status() {
  local run_dir="$1" gpu_ids="$2" pid="$3" start_ticks="$4" fingerprint="$5" started_at="$6"
  local request="$run_dir/REQUEST.md"
  local run_id project purpose expected
  run_id="$(request_value "$request" run_id)"
  project="$(request_value "$request" project)"
  purpose="$(request_value "$request" purpose)"
  expected="$(request_value "$request" expected_vram_mib)"
  python3 - "$run_dir/status.json" "$run_id" "$project" "$purpose" "$gpu_ids" "$pid" "$start_ticks" "$fingerprint" "$started_at" "$expected" <<'PY'
import json, os, sys
path, run_id, project, purpose, ids, pid, ticks, fingerprint, started_at, expected = sys.argv[1:]
payload = {
    'protocol_version': 1,
    'runner': 'FIRM_GPU_QUEUE_RUNNER',
    'run_id': run_id,
    'project': project,
    'purpose': purpose,
    'disposition': 'LAUNCH',
    'gpu_ids': [int(value) for value in ids.split(',') if value],
    'expected_vram_mib_per_gpu': int(expected),
    'container_pid': int(pid),
    'pid_start_ticks': ticks,
    'command_fingerprint': fingerprint,
    'owned': True,
    'started_at': started_at,
}
tmp = f'{path}.tmp.{os.getpid()}'
with open(tmp, 'w', encoding='utf-8') as handle:
    json.dump(payload, handle, ensure_ascii=False, sort_keys=True)
    handle.write('\n')
os.replace(tmp, path)
PY
}

finalize_run() {
  local run_dir="$1" exit_code="$2" finished_at="$3"
  local request="$run_dir/REQUEST.md"
  local status="$run_dir/status.json"
  local run_id project pid ticks fingerprint state summary
  run_id="$(request_value "$request" run_id)"
  project="$(request_value "$request" project)"
  pid="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("container_pid", ""))' "$status")"
  ticks="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("pid_start_ticks", ""))' "$status")"
  fingerprint="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("command_fingerprint", ""))' "$status")"
  if [[ "$exit_code" == "0" ]]; then
    state="done"
    summary="scheduler-owned command exited successfully"
  else
    state="failed"
    summary="scheduler-owned command exited with code $exit_code"
  fi
  python3 - "$run_dir/terminal.json" "$run_id" "$project" "$state" "$exit_code" "$finished_at" "$pid" "$ticks" "$fingerprint" <<'PY'
import json, os, sys
path, run_id, project, state, code, finished_at, pid, ticks, fingerprint = sys.argv[1:]
payload = {
    'protocol_version': 1,
    'runner': 'FIRM_GPU_QUEUE_RUNNER',
    'run_id': run_id,
    'project': project,
    'state': state,
    'exit_code': int(code),
    'finished_at': finished_at,
    'container_pid': int(pid),
    'pid_start_ticks': ticks,
    'command_fingerprint': fingerprint,
}
tmp = f'{path}.tmp.{os.getpid()}'
with open(tmp, 'w', encoding='utf-8') as handle:
    json.dump(payload, handle, ensure_ascii=False, sort_keys=True)
    handle.write('\n')
os.replace(tmp, path)
PY
  if [[ ! -f "$run_dir/RESULT.md" ]]; then
    printf 'project: %s\nstatus: %s\nsummary: %s\nnext_action_for_project_session: inspect the declared outputs and terminal manifest before choosing follow-up work.\n' \
      "$project" "$state" "$summary" > "$run_dir/RESULT.md"
  fi
  local final_dir="$QUEUE_ROOT/$state/$run_id"
  [[ ! -e "$final_dir" ]] || { echo "terminal destination exists: $final_dir" >&2; return 1; }
  mv "$run_dir" "$final_dir"
  touch "$final_dir/.ready"
}

launch_run() {
  local run_dir="$1" gpu_ids="$2"
  local request="$run_dir/REQUEST.md"
  local command="$run_dir/command.sh"
  local started_at pid ticks fingerprint exit_code
  ensure_layout
  started_at="$(now_iso)"
  fingerprint="$(sha256sum "$command" | awk '{print $1}')"
  # This shell is the scheduler-owned worker; its identity is persisted before exec.
  write_launch_status "$run_dir" "$gpu_ids" "$$" "$(pid_start_ticks "$$")" "$fingerprint" "$started_at"
  set +e
  CUDA_VISIBLE_DEVICES="$gpu_ids" bash "$command" > "$run_dir/launch.log" 2>&1
  exit_code=$?
  set -e
  finalize_run "$run_dir" "$exit_code" "$(now_iso)"
}

recover_owned_orphans() {
  local run_dir status pid recorded_ticks actual_ticks
  for run_dir in "$QUEUE_ROOT"/running/*; do
    [[ -d "$run_dir" ]] || continue
    status="$run_dir/status.json"
    [[ -f "$status" ]] || continue
    [[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("runner", ""))' "$status")" == "$RUNNER_NAME" ]] || continue
    pid="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("container_pid", ""))' "$status")"
    recorded_ticks="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("pid_start_ticks", ""))' "$status")"
    actual_ticks="$(pid_start_ticks "$pid" 2>/dev/null || true)"
    if [[ -n "$actual_ticks" && "$actual_ticks" == "$recorded_ticks" ]]; then
      continue
    fi
    # A protocol-owned process disappeared without its finalizer. This is executor failure,
    # not a scientific result, and must be visible rather than held as a fake running job.
    finalize_run "$run_dir" "125" "$(now_iso)"
  done
}

dispatch_pending() {
  local pending run_id request count required gpu_ids running
  for pending in "$QUEUE_ROOT"/pending/*; do
    [[ -d "$pending" && -f "$pending/.submitted" ]] || continue
    request="$pending/REQUEST.md"
    if ! validate_request "$pending"; then
      json_write "$pending/status.json" "$(json_object disposition HOLD reason invalid_or_incomplete_request sampled_at "$(now_iso)")"
      continue
    fi
    count="$(request_value "$request" gpu_count)"
    required="$(request_value "$request" expected_vram_mib)"
    gpu_ids="$(select_gpus "$count" "$required" || true)"
    [[ -n "$gpu_ids" ]] || continue
    run_id="$(request_value "$request" run_id)"
    running="$QUEUE_ROOT/running/$run_id"
    mv "$pending" "$running"
    touch "$running/.started"
    nohup "$0" --launch "$running" "$gpu_ids" > "$running/runner.log" 2>&1 &
  done
}

serve() {
  ensure_layout
  while true; do
    printf '%s\n' "$$" > "$RUNNER_PID_FILE"
    write_heartbeat
    recover_owned_orphans
    dispatch_pending
    sleep "$POLL_SEC"
  done
}

ensure_service() {
  ensure_layout
  local running_pid="" recorded_ticks="" actual_ticks=""
  if [[ -f "$RUNNER_HEARTBEAT" ]]; then
    running_pid="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("pid", ""))' "$RUNNER_HEARTBEAT" 2>/dev/null || true)"
    recorded_ticks="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("pid_start_ticks", ""))' "$RUNNER_HEARTBEAT" 2>/dev/null || true)"
  fi
  actual_ticks="$(pid_start_ticks "$running_pid" 2>/dev/null || true)"
  if [[ "$running_pid" =~ ^[1-9][0-9]*$ && -n "$recorded_ticks" && "$actual_ticks" == "$recorded_ticks" ]]; then
    exit 0
  fi
  nohup "$0" --serve > "$QUEUE_ROOT/firm-runner.log" 2>&1 &
  disown || true
}

case "${1:---serve}" in
  --serve) serve ;;
  --ensure) ensure_service ;;
  --launch) launch_run "$2" "$3" ;;
  *) echo "usage: $0 [--serve|--ensure|--launch RUN_DIR GPU_IDS]" >&2; exit 2 ;;
esac
