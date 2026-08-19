import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

const REMOTE_COLLECTOR = String.raw`
import json
import os
import re
import sys
from datetime import datetime, timezone

root = os.path.abspath(sys.argv[1])
states = [
    ("pending", ".submitted"),
    ("running", ".started"),
    ("done", ".ready"),
    ("failed", ".ready"),
    ("cancelled", ".ready"),
]

def safe_text(path, limit=262144):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return handle.read(limit)
    except (FileNotFoundError, IsADirectoryError, PermissionError):
        return ""

def safe_json(path, limit=262144):
    try:
        if os.path.getsize(path) > limit:
            return None
        with open(path, "r", encoding="utf-8") as handle:
            value = json.load(handle)
            return value if isinstance(value, dict) else None
    except (FileNotFoundError, json.JSONDecodeError, PermissionError, OSError):
        return None

def fields(text):
    values = {}
    for line in text.splitlines():
        match = re.match(r"^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$", line)
        if match:
            values[match.group(1).lower()] = match.group(2)
    return values

items = []
invalid = []
for state, signal in states:
    state_dir = os.path.join(root, state)
    try:
        entries = sorted(os.scandir(state_dir), key=lambda entry: entry.name)
    except (FileNotFoundError, PermissionError):
        continue
    for entry in entries[:2000]:
        if not entry.is_dir(follow_symlinks=False):
            continue
        signal_path = os.path.join(entry.path, signal)
        if not os.path.isfile(signal_path):
            invalid.append({"runId": entry.name, "state": state, "reason": "signal_missing"})
            continue
        request_text = safe_text(os.path.join(entry.path, "REQUEST.md"))
        result_text = safe_text(os.path.join(entry.path, "RESULT.md"))
        request = fields(request_text)
        result = fields(result_text)
        status_json = safe_json(os.path.join(entry.path, "status.json"))
        terminal_json = safe_json(os.path.join(entry.path, "terminal.json"))
        worker_alive = None
        if state == "running" and isinstance(status_json, dict):
            worker_pid = status_json.get("container_pid")
            if isinstance(worker_pid, int) and worker_pid > 0:
                worker_alive = os.path.exists(f"/proc/{worker_pid}")
        telemetry_json = safe_json(os.path.join(entry.path, "telemetry.json"))
        if telemetry_json is None:
            telemetry_json = safe_json(os.path.join(entry.path, "TELEMETRY.json"))
        if telemetry_json is None and isinstance(status_json, dict):
            nested = status_json.get("telemetry")
            telemetry_json = nested if isinstance(nested, dict) else None
        signal_at = datetime.fromtimestamp(
            os.path.getmtime(signal_path), timezone.utc
        ).isoformat()
        items.append({
            "runId": entry.name,
            "state": state,
            "signal": signal,
            "signalAt": signal_at,
            "remotePath": entry.path,
            "project": result.get("project") or request.get("project"),
            "priority": request.get("priority"),
            "gpuType": request.get("gpu_type"),
            "gpuCount": request.get("gpu_count"),
            "estimatedTime": request.get("estimated_time"),
            "maxTime": request.get("max_time"),
            "purpose": request.get("purpose"),
            "readiness": {
                "status": request.get("readiness"),
                "codeReady": request.get("code_ready"),
                "dependenciesReady": request.get("dependencies_ready"),
                "dataReady": request.get("data_ready"),
                "preprocessingComplete": request.get("preprocessing_complete"),
                "configFrozen": request.get("config_frozen"),
                "cpuSmokePassed": request.get("cpu_smoke_passed"),
                "telemetryReady": request.get("telemetry_ready"),
                "firstGpuAction": request.get("first_gpu_action"),
                "expectedComputeUtilization": request.get("expected_compute_utilization"),
                "expectedProgressMarker": request.get("expected_progress_marker"),
                "preparationException": request.get("preparation_exception"),
            },
            "resultStatus": result.get("status"),
            "summary": result.get("summary"),
            "nextAction": result.get("next_action_for_project_session"),
            "statusDetail": status_json,
            "terminalDetail": terminal_json,
            "workerAlive": worker_alive,
            "telemetry": telemetry_json,
        })

print(json.dumps({
    "collectedAt": datetime.now(timezone.utc).isoformat(),
    "root": root,
    "items": items,
    "invalid": invalid[:200],
}, ensure_ascii=False))
`;

function quoteRemote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function remoteCommand(root, dockerContainer = null) {
  const script = Buffer.from(REMOTE_COLLECTOR).toString('base64');
  const launcher = `import base64;exec(base64.b64decode('${script}'))`;
  const python = `python3 -c ${quoteRemote(launcher)} ${quoteRemote(root)}`;
  return dockerContainer
    ? `docker exec ${quoteRemote(dockerContainer)} ${python}`
    : python;
}

function remoteRunnerEnsureCommand(root, dockerContainer = null, runnerPath = null) {
  const runner = runnerPath || `${root.replace(/\/$/, '')}/firm_gpu_queue_runner.sh`;
  const command = `${quoteRemote(runner)} --ensure`;
  return dockerContainer
    ? `docker exec ${quoteRemote(dockerContainer)} ${command}`
    : command;
}

export function emptyGpuQueueSnapshot(status = 'disabled', error = null) {
  return {
    status,
    error,
    collectedAt: new Date().toISOString(),
    root: null,
    items: [],
    invalid: [],
    counts: { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 },
  };
}

const NON_COMPUTE_PHASES = new Set([
  'provisioning', 'setup', 'download', 'compile', 'model_load', 'warmup', 'teardown',
]);

function finiteNumber(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}

function normalizeTelemetry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const gpus = Array.isArray(value.gpus) ? value.gpus.slice(0, 32).map((gpu, index) => ({
    index: finiteNumber(gpu?.index, 0, 1024) ?? index,
    utilizationGpuPct: finiteNumber(gpu?.utilizationGpuPct ?? gpu?.utilization_gpu_pct, 0, 100),
    memoryUsedMiB: finiteNumber(gpu?.memoryUsedMiB ?? gpu?.memory_used_mib, 0),
    memoryTotalMiB: finiteNumber(gpu?.memoryTotalMiB ?? gpu?.memory_total_mib, 1),
    processCount: finiteNumber(gpu?.processCount ?? gpu?.process_count, 0, 10000),
    powerW: finiteNumber(gpu?.powerW ?? gpu?.power_w, 0, 10000),
  })) : [];
  const throughput = value.throughput && typeof value.throughput === 'object'
    ? {
      name: String(value.throughput.name || '').slice(0, 80) || null,
      value: finiteNumber(value.throughput.value, 0),
      unit: String(value.throughput.unit || '').slice(0, 40) || null,
    } : null;
  return {
    phase: String(value.phase || 'unknown').toLowerCase().slice(0, 40),
    sampledAt: typeof value.sampledAt === 'string' ? value.sampledAt : null,
    progressAt: typeof value.progressAt === 'string' ? value.progressAt : null,
    windowSec: finiteNumber(value.windowSec ?? value.window_sec, 0, 86400),
    progressMarker: String(value.progressMarker || value.progress_marker || '').slice(0, 240) || null,
    gpus,
    throughput,
    source: String(value.source || 'scheduler').slice(0, 80),
  };
}

function normalizeTerminalManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = String(value.state || '').toLowerCase();
  if (!['done', 'failed', 'cancelled'].includes(state)) return null;
  const exitCode = finiteNumber(value.exit_code ?? value.exitCode, 0, 255);
  return {
    protocolVersion: finiteNumber(value.protocol_version ?? value.protocolVersion, 1, 1000),
    runner: String(value.runner || '').slice(0, 100) || null,
    state,
    exitCode,
    finishedAt: typeof value.finished_at === 'string' ? value.finished_at
      : (typeof value.finishedAt === 'string' ? value.finishedAt : null),
    pid: finiteNumber(value.container_pid ?? value.pid, 1),
    pidStartTicks: String((value.pid_start_ticks ?? value.pidStartTicks) || '').slice(0, 100) || null,
    commandFingerprint: /^[a-f0-9]{64}$/.test(String(
      value.command_fingerprint ?? value.commandFingerprint ?? '',
    )) ? String(value.command_fingerprint ?? value.commandFingerprint) : null,
  };
}

function numericGpuCount(value) {
  const match = String(value || '').match(/\d+/);
  return match ? Number(match[0]) : null;
}

const READY_FIELD_NAMES = Object.freeze([
  'codeReady',
  'dependenciesReady',
  'dataReady',
  'preprocessingComplete',
  'configFrozen',
  'cpuSmokePassed',
  'telemetryReady',
]);

const FIRST_GPU_ACTIONS = new Set([
  'model_load', 'compute', 'resume_compute', 'gpu_required_compile',
]);

function readinessBoolean(value) {
  if (typeof value === 'boolean') return value;
  return /^(?:1|true|yes|ready|passed)$/i.test(String(value || '').trim());
}

export function normalizeSubmissionReadiness(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { state: 'UNDECLARED', missing: [...READY_FIELD_NAMES, 'readiness', 'firstGpuAction'] };
  }
  const declared = Object.values(value).some((entry) => entry !== null && entry !== undefined && entry !== '');
  if (!declared) {
    return { state: 'UNDECLARED', missing: [...READY_FIELD_NAMES, 'readiness', 'firstGpuAction'] };
  }
  const flags = Object.fromEntries(READY_FIELD_NAMES.map((name) => [name, readinessBoolean(value[name])]));
  const missing = READY_FIELD_NAMES.filter((name) => !flags[name]);
  const status = String(value.status || '').trim().toLowerCase();
  const firstGpuAction = String(value.firstGpuAction || '').trim().toLowerCase();
  if (status !== 'compute_ready') missing.push('readiness');
  if (!FIRST_GPU_ACTIONS.has(firstGpuAction)) missing.push('firstGpuAction');
  const preparationException = String(value.preparationException || '').trim().slice(0, 1000) || null;
  if (firstGpuAction === 'gpu_required_compile'
      && (!preparationException || /^none$/i.test(preparationException))) {
    missing.push('preparationException');
  }
  return {
    state: missing.length ? 'NOT_READY' : 'READY',
    missing: [...new Set(missing)],
    ...flags,
    firstGpuAction: firstGpuAction || null,
    expectedComputeUtilization: String(value.expectedComputeUtilization || '').slice(0, 120) || null,
    expectedProgressMarker: String(value.expectedProgressMarker || '').slice(0, 240) || null,
    preparationException,
  };
}

function isoAgeMs(value, nowMs) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? Math.max(0, nowMs - timestamp) : null;
}

export function classifyGpuEfficiency(item, now = Date.now()) {
  if (item.state !== 'running') {
    return { state: 'N/A', severity: 'info', reason: 'run_not_active', recommendation: null };
  }
  const telemetry = item.telemetry;
  if (!telemetry) {
    return {
      state: 'UNMEASURED', severity: 'info', reason: 'telemetry_missing',
      recommendation: 'Scheduler should publish phase-aware telemetry; do not infer efficiency yet.',
    };
  }
  if (NON_COMPUTE_PHASES.has(telemetry.phase)) {
    return {
      state: 'NON_COMPUTE', severity: 'info', reason: `phase_${telemetry.phase}`,
      recommendation: 'Exclude this setup phase from utilization judgments.',
    };
  }
  const measured = telemetry.gpus.filter((gpu) => gpu.utilizationGpuPct !== null);
  if (!measured.length) {
    return {
      state: 'UNMEASURED', severity: 'info', reason: 'gpu_samples_missing',
      recommendation: 'Collect nvidia-smi samples before making a resource decision.',
    };
  }
  const averageUtilizationPct = measured.reduce((sum, gpu) => sum + gpu.utilizationGpuPct, 0)
    / measured.length;
  const memory = measured.filter((gpu) => gpu.memoryUsedMiB !== null && gpu.memoryTotalMiB !== null);
  const averageMemoryPct = memory.length
    ? memory.reduce((sum, gpu) => sum + (100 * gpu.memoryUsedMiB / gpu.memoryTotalMiB), 0)
      / memory.length
    : null;
  const hasProcessSamples = measured.every((gpu) => gpu.processCount !== null);
  const processTotal = measured.reduce((sum, gpu) => sum + (gpu.processCount || 0), 0);
  const expected = numericGpuCount(item.gpuCount);
  const active = measured.filter((gpu) => gpu.utilizationGpuPct >= 5 || (gpu.processCount || 0) > 0).length;
  const progressAgeMs = isoAgeMs(telemetry.progressAt, now);
  const sampleAgeMs = isoAgeMs(telemetry.sampledAt, now);
  const common = { averageUtilizationPct, averageMemoryPct, activeGpus: active, expectedGpus: expected };
  if (item.workerAlive === false && hasProcessSamples && processTotal === 0
      && (telemetry.windowSec >= 120 || sampleAgeMs >= 120_000)) {
    return {
      ...common, state: 'BLOCKED', severity: 'error', reason: 'no_gpu_process_for_120s',
      recommendation: 'Inspect worker health and launch logs; do not stop solely from utilization.',
    };
  }
  if (expected && expected > 1 && active < expected) {
    return {
      ...common, state: 'RESOURCE_MISMATCH', severity: 'warn', reason: 'requested_gpus_not_active',
      recommendation: 'Verify distributed launch or reduce the requested GPU count after confirming workload intent.',
    };
  }
  if (measured.length > 1) {
    const utils = measured.map((gpu) => gpu.utilizationGpuPct);
    const high = Math.max(...utils);
    const low = Math.min(...utils);
    if (high >= 15 && (low === 0 || high / Math.max(low, 1) > 3)) {
      return {
        ...common, state: 'IMBALANCED', severity: 'warn', reason: 'per_gpu_utilization_ratio_over_3x',
        recommendation: 'Inspect sharding, data distribution, and synchronization before changing allocation.',
      };
    }
  }
  if (averageUtilizationPct < 5
      && telemetry.windowSec >= 300
      && (progressAgeMs === null || progressAgeMs >= 300_000)) {
    return {
      ...common, state: 'STALLED', severity: 'error', reason: 'low_utilization_without_progress_for_5m',
      recommendation: 'Inspect I/O, dataloader, deadlock, and worker logs; require evidence before termination.',
    };
  }
  if (averageUtilizationPct < 15) {
    return {
      ...common, state: 'INEFFICIENT', severity: 'warn', reason: 'low_utilization_with_progress',
      recommendation: 'Tune batching, preprocessing, data locality, or GPU allocation while preserving the run.',
    };
  }
  return {
    ...common, state: 'HEALTHY', severity: 'info', reason: 'compute_phase_progressing',
    recommendation: null,
  };
}

export function normalizeGpuQueueSnapshot(value) {
  if (!value || !Array.isArray(value.items)) throw new Error('GPU queue payload is invalid');
  const allowedStates = new Set(['pending', 'running', 'done', 'failed', 'cancelled']);
  const items = value.items
    .filter((item) => item && typeof item.runId === 'string' && allowedStates.has(item.state))
    .map((item) => {
      const normalized = {
      runId: item.runId.slice(0, 300),
      state: item.state,
      signal: String(item.signal || '').slice(0, 40),
      signalAt: item.signalAt || null,
      remotePath: String(item.remotePath || '').slice(0, 2000),
      project: typeof item.project === 'string' ? item.project.slice(0, 100) : null,
      priority: typeof item.priority === 'string' ? item.priority.slice(0, 40) : null,
      gpuType: typeof item.gpuType === 'string' ? item.gpuType.slice(0, 100) : null,
      gpuCount: typeof item.gpuCount === 'string' ? item.gpuCount.slice(0, 20) : null,
      estimatedTime: typeof item.estimatedTime === 'string' ? item.estimatedTime.slice(0, 100) : null,
      maxTime: typeof item.maxTime === 'string' ? item.maxTime.slice(0, 100) : null,
      purpose: typeof item.purpose === 'string' ? item.purpose.slice(0, 500) : null,
      submissionReadiness: normalizeSubmissionReadiness(item.readiness),
      resultStatus: typeof item.resultStatus === 'string' ? item.resultStatus.slice(0, 40) : null,
      summary: typeof item.summary === 'string' ? item.summary.slice(0, 4000) : null,
      nextAction: typeof item.nextAction === 'string' ? item.nextAction.slice(0, 4000) : null,
      statusDetail: item.statusDetail && typeof item.statusDetail === 'object'
        ? item.statusDetail : null,
      terminal: normalizeTerminalManifest(item.terminalDetail),
      workerAlive: typeof item.workerAlive === 'boolean' ? item.workerAlive : null,
      telemetry: normalizeTelemetry(item.telemetry),
      };
      normalized.terminalIntegrity = normalized.terminal
        ? normalized.terminal.state === normalized.state ? 'MATCH' : 'MISMATCH'
        : null;
      normalized.efficiency = classifyGpuEfficiency(
        normalized,
        Date.parse(value.collectedAt || '') || Date.now(),
      );
      return normalized;
    });
  const counts = { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
  for (const item of items) counts[item.state] += 1;
  return {
    status: 'ok',
    error: null,
    collectedAt: value.collectedAt || new Date().toISOString(),
    root: typeof value.root === 'string' ? value.root : null,
    items,
    invalid: Array.isArray(value.invalid) ? value.invalid.slice(0, 200) : [],
    counts,
  };
}

export async function collectGpuQueue(config, options = {}) {
  if (!config.enabled) return emptyGpuQueueSnapshot('disabled');
  if (!config.sshExecutable) return emptyGpuQueueSnapshot('unavailable', 'ssh_not_found');
  const run = options.execFile || execFile;
  const args = [
    '-p', String(config.port),
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${Math.max(1, Math.ceil(config.timeoutMs / 1000))}`,
    config.host,
    remoteCommand(config.root, config.dockerContainer),
  ];
  try {
    if (config.runnerEnsureEnabled) {
      await run(config.sshExecutable, [
        '-p', String(config.port),
        '-o', 'BatchMode=yes',
        '-o', `ConnectTimeout=${Math.max(1, Math.ceil(config.timeoutMs / 1000))}`,
        config.host,
        remoteRunnerEnsureCommand(config.root, config.dockerContainer, config.runnerPath),
      ], {
        timeout: config.timeoutMs,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
      });
    }
    const { stdout } = await run(config.sshExecutable, args, {
      timeout: config.timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    });
    return normalizeGpuQueueSnapshot(JSON.parse(stdout));
  } catch (error) {
    return emptyGpuQueueSnapshot('unavailable', String(
      error.code === 'ETIMEDOUT' ? 'ssh_timeout' : error.message || error,
    ).slice(0, 1000));
  }
}

export const gpuQueueInternals = Object.freeze({ remoteCommand, remoteRunnerEnsureCommand });
