# GPU Submission Readiness Contract

GPU time begins only after a project is compute-ready. The project PI owns preparation;
GPU Scheduler independently verifies it before launch.

## Project PI responsibility

Before publishing `.submitted`, complete every task that does not intrinsically require a GPU:

- finalize code, command-line arguments, configuration, seeds, output paths, and success criteria;
- install and import-check dependencies in the approved environment;
- download, verify, extract, index, tokenize, and preprocess data and model assets;
- run syntax checks plus the smallest meaningful CPU or control-node smoke test;
- make `command.sh` non-interactive, restart-safe, and immediately ready to load the model or compute;
- define progress and phase telemetry plus the expected utilization plan.

Do not submit a request merely to reserve capacity. Do not use allocated GPU time for ordinary
package installation, repository cloning, model/data download, configuration authoring, dataset
preprocessing, evaluator construction, or exploratory debugging.

## Required REQUEST.md fields

```yaml
readiness: compute_ready
code_ready: true
dependencies_ready: true
data_ready: true
preprocessing_complete: true
config_frozen: true
cpu_smoke_passed: true
telemetry_ready: true
first_gpu_action: model_load | compute | resume_compute | gpu_required_compile
expected_compute_utilization: <percent or measured range>
expected_progress_marker: <step, sample, batch, token, or checkpoint marker>
preparation_exception: none
```

All seven readiness booleans must be true. `first_gpu_action` describes the first meaningful worker
action after environment entry. `expected_compute_utilization` is a planning estimate, not a promise.

## Narrow exception

If a dependency genuinely requires the allocated GPU architecture for compilation or probing, use
`first_gpu_action: gpu_required_compile` and replace `preparation_exception: none` with the exact
bounded step, why it cannot run earlier, its time limit, and the command that follows it. Downloads,
general configuration, CPU preprocessing, and ordinary package installation are never exceptions.

## Scheduler decision

- `READY`: all required fields and artifacts are present; launch may proceed.
- `NOT_READY`: a field is false/missing or `command.sh` performs avoidable setup; do not launch.
- `UNDECLARED`: legacy request without readiness metadata; inspect and require an explicit readiness
  update before launch.

For `NOT_READY` or `UNDECLARED`, leave the request pending, record the missing evidence, and notify
the project. Do not silently repair scientific configuration or consume a worker while preparing it.
