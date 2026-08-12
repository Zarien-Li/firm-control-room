#!/usr/bin/env bash
set -euo pipefail
if [[ $# -lt 5 || "$4" != "--" ]]; then
  echo "usage: $0 RUN_ID PROJECT {local_cpu|remote_cpu|ssh} -- COMMAND [ARGS...]" >&2; exit 2
fi
run_id="$1" project="$2" kind="$3"; shift 4
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/scripts/firm-job.sh" register "$run_id" "$project" "$kind" "$*" >/dev/null
FIRM_JOB_PID="$$" "$root/scripts/firm-job.sh" start "$run_id" "$@" >/dev/null
finish() {
  code=$?; trap - EXIT
  if [[ $code -eq 0 ]]; then state=done; else state=failed; fi
  FIRM_JOB_PID="$$" "$root/scripts/firm-job.sh" "$state" "$run_id" >/dev/null || true
  exit "$code"
}
trap finish EXIT
"$@"
