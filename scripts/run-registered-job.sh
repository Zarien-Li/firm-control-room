#!/usr/bin/env bash
set -euo pipefail
if [[ $# -lt 5 || "$4" != "--" ]]; then
  echo "usage: $0 RUN_ID PROJECT {local_cpu|remote_cpu|ssh} -- COMMAND [ARGS...]" >&2; exit 2
fi
run_id="$1" project="$2" kind="$3"; shift 4
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/scripts/firm-job.sh" register "$run_id" "$project" "$kind" "$*" >/dev/null
FIRM_JOB_PID="$$" "$root/scripts/firm-job.sh" start "$run_id" "$@" >/dev/null
child_pid=""
heartbeat_pid=""
timeout_pid=""
timed_out=0
heartbeat_sec="${FIRM_JOB_HEARTBEAT_SEC:-30}"
max_runtime_sec="${FIRM_JOB_MAX_RUNTIME_SEC:-43200}"
if ! [[ "$heartbeat_sec" =~ ^[0-9]+$ ]] || (( heartbeat_sec < 5 )); then
  echo "FIRM_JOB_HEARTBEAT_SEC must be an integer >= 5" >&2; exit 2
fi
if ! [[ "$max_runtime_sec" =~ ^[0-9]+$ ]]; then
  echo "FIRM_JOB_MAX_RUNTIME_SEC must be a non-negative integer" >&2; exit 2
fi
cleanup_helpers() {
  [[ -n "$heartbeat_pid" ]] && kill "$heartbeat_pid" 2>/dev/null || true
  [[ -n "$timeout_pid" ]] && kill "$timeout_pid" 2>/dev/null || true
}
finish() {
  code=$?; trap - EXIT
  cleanup_helpers
  if [[ $code -eq 0 ]]; then state=done; else state=failed; fi
  FIRM_JOB_PID="$$" "$root/scripts/firm-job.sh" "$state" "$run_id" >/dev/null || true
  exit "$code"
}
trap finish EXIT
"$@" &
child_pid=$!
(
  while kill -0 "$child_pid" 2>/dev/null; do
    sleep "$heartbeat_sec"
    kill -0 "$child_pid" 2>/dev/null || break
    FIRM_JOB_PID="$$" "$root/scripts/firm-job.sh" heartbeat "$run_id" >/dev/null || true
  done
) &
heartbeat_pid=$!
if (( max_runtime_sec > 0 )); then
  (
    sleep "$max_runtime_sec"
    kill -0 "$child_pid" 2>/dev/null || exit 0
    printf 'FIRM job %s exceeded max runtime %ss\n' "$run_id" "$max_runtime_sec" >&2
    kill -TERM "$child_pid" 2>/dev/null || true
    sleep 10
    kill -KILL "$child_pid" 2>/dev/null || true
  ) &
  timeout_pid=$!
fi
set +e
wait "$child_pid"
code=$?
set -e
exit "$code"
