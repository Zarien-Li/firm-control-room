# FIRM GPU Telemetry Protocol

This protocol is operational. It does not authorize scientific interpretation or worker termination.

For every directory under `gpu_queue/running/<RUN_ID>/`, GPU Scheduler publishes `telemetry.json` atomically at least once every 60 seconds while the worker is active:

```json
{
  "phase": "provisioning | setup | download | compile | model_load | warmup | compute | teardown | unknown",
  "sampledAt": "2026-08-11T00:00:00Z",
  "progressAt": "2026-08-11T00:00:00Z",
  "windowSec": 300,
  "progressMarker": "step=1200/5000 or eval_batch=8/40",
  "source": "gpu-scheduler",
  "gpus": [
    {
      "index": 0,
      "utilizationGpuPct": 72,
      "memoryUsedMiB": 31200,
      "memoryTotalMiB": 40960,
      "processCount": 1,
      "powerW": 265
    }
  ],
  "throughput": {
    "name": "tokens_per_second",
    "value": 1250,
    "unit": "tokens/s"
  }
}
```

## Collection rules

- Set `phase` from observed worker activity. Downloads, environment setup, compilation, model loading, warmup, and teardown are not compute inefficiency.
- Gather GPU samples from the actual worker, not the Merlin control host. Use the recorded worker access path and bounded `nvidia-smi --query-gpu=... --format=csv,noheader,nounits` calls.
- `progressAt` changes only when a real workload marker advances: step, batch, sample count, checkpoint, output count, or another command-specific unit.
- For generation/decode workloads, include an honest throughput measure when available; low SM utilization can be normal when tokens/s or samples/s is advancing.
- Write `telemetry.json.tmp`, validate it as JSON, then rename it to `telemetry.json`.
- Do not include secrets, model outputs, prompts, or unbounded logs.

## Diagnostic policy

FIRM may classify active work as `BLOCKED`, `STALLED`, `INEFFICIENT`, `RESOURCE_MISMATCH`, or `IMBALANCED`. These are requests for inspection, not kill instructions.

- Never terminate or resize a worker from GPU utilization alone.
- Confirm phase, progress marker, command logs, worker health, and the request's resource intent first.
- Prefer repairing data loading, batching, distributed launch, preprocessing, or allocation mismatch while preserving trustworthy outputs.
- Worker termination still follows the existing owned-worker cleanup protocol and remains exclusively within GPU Scheduler authority.
