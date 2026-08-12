import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyGpuEfficiency,
  collectGpuQueue,
  gpuQueueInternals,
  normalizeGpuQueueSnapshot,
  normalizeSubmissionReadiness,
} from '../src/gpu-queue.js';

test('GPU submission readiness requires preparation before allocation', () => {
  const ready = normalizeSubmissionReadiness({
    status: 'compute_ready',
    codeReady: 'true',
    dependenciesReady: 'true',
    dataReady: 'true',
    preprocessingComplete: 'true',
    configFrozen: 'true',
    cpuSmokePassed: 'passed',
    telemetryReady: 'yes',
    firstGpuAction: 'model_load',
  });
  assert.equal(ready.state, 'READY');
  assert.deepEqual(ready.missing, []);

  const notReady = normalizeSubmissionReadiness({
    status: 'compute_ready',
    codeReady: 'true',
    dependenciesReady: 'false',
    firstGpuAction: 'download',
  });
  assert.equal(notReady.state, 'NOT_READY');
  assert.ok(notReady.missing.includes('dependenciesReady'));
  assert.ok(notReady.missing.includes('firstGpuAction'));

  assert.equal(normalizeSubmissionReadiness(null).state, 'UNDECLARED');
});

test('normalizeGpuQueueSnapshot counts authoritative states and bounds fields', () => {
  const result = normalizeGpuQueueSnapshot({
    collectedAt: '2026-08-11T00:00:00Z',
    root: '/queue',
    items: [
      { runId: 'ACL_1_smoke', state: 'pending', remotePath: '/queue/pending/ACL_1_smoke' },
      { runId: 'ACL_4_eval', state: 'done', project: 'ACL_4', summary: 'ok' },
      { runId: 'bad', state: 'unknown' },
    ],
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.counts, {
    pending: 1,
    running: 0,
    done: 1,
    failed: 0,
    cancelled: 0,
  });
});

test('GPU efficiency classification is phase-aware and never treats setup as a stall', () => {
  const result = normalizeGpuQueueSnapshot({
    collectedAt: '2026-08-11T00:10:00Z',
    root: '/queue',
    items: [{
      runId: 'ACL_1_setup', state: 'running', gpuCount: '1',
      telemetry: {
        phase: 'model_load', sampledAt: '2026-08-11T00:10:00Z', windowSec: 600,
        gpus: [{ index: 0, utilizationGpuPct: 1, processCount: 1 }],
      },
    }],
  });
  assert.equal(result.items[0].efficiency.state, 'NON_COMPUTE');
});

test('GPU efficiency trusts the authoritative worker PID over hidden nvidia-smi process rows', () => {
  const result = classifyGpuEfficiency({
    state: 'running', gpuCount: '1', workerAlive: true,
    telemetry: {
      phase: 'compute', sampledAt: '2026-08-11T00:10:00Z',
      progressAt: '2026-08-11T00:09:50Z', windowSec: 300,
      gpus: [{ utilizationGpuPct: 85, processCount: 0 }],
    },
  }, Date.parse('2026-08-11T00:10:00Z'));
  assert.equal(result.state, 'HEALTHY');
});

test('GPU efficiency reports a dead authoritative worker as blocked', () => {
  const result = classifyGpuEfficiency({
    state: 'running', gpuCount: '1', workerAlive: false,
    telemetry: {
      phase: 'compute', sampledAt: '2026-08-11T00:10:00Z', windowSec: 300,
      gpus: [{ utilizationGpuPct: 0, processCount: 0 }],
    },
  }, Date.parse('2026-08-11T00:10:00Z'));
  assert.equal(result.state, 'BLOCKED');
  assert.equal(result.reason, 'no_gpu_process_for_120s');
});

test('GPU efficiency distinguishes progressing low utilization from a stalled run', () => {
  const base = {
    state: 'running', gpuCount: '1',
    telemetry: {
      phase: 'compute', sampledAt: '2026-08-11T00:10:00Z', windowSec: 600,
      gpus: [{ index: 0, utilizationGpuPct: 3, processCount: 1 }],
    },
  };
  assert.equal(classifyGpuEfficiency({
    ...base,
    telemetry: { ...base.telemetry, progressAt: '2026-08-11T00:09:50Z' },
  }, Date.parse('2026-08-11T00:10:00Z')).state, 'INEFFICIENT');
  assert.equal(classifyGpuEfficiency({
    ...base,
    telemetry: { ...base.telemetry, progressAt: '2026-08-11T00:00:00Z' },
  }, Date.parse('2026-08-11T00:10:00Z')).state, 'STALLED');
});

test('GPU efficiency detects resource mismatch without authorizing termination', () => {
  const result = classifyGpuEfficiency({
    state: 'running', gpuCount: '4',
    telemetry: {
      phase: 'compute', sampledAt: '2026-08-11T00:10:00Z',
      progressAt: '2026-08-11T00:09:50Z', windowSec: 300,
      gpus: [
        { utilizationGpuPct: 60, processCount: 1 },
        { utilizationGpuPct: 0, processCount: 0 },
        { utilizationGpuPct: 0, processCount: 0 },
        { utilizationGpuPct: 0, processCount: 0 },
      ],
    },
  }, Date.parse('2026-08-11T00:10:00Z'));
  assert.equal(result.state, 'RESOURCE_MISMATCH');
  assert.match(result.recommendation, /Verify distributed launch/);
  assert.doesNotMatch(result.recommendation, /terminate|kill/i);
});

test('collectGpuQueue uses fixed SSH options and parses JSON output', async () => {
  let invocation;
  const execFile = async (executable, args, options) => {
    invocation = { executable, args, options };
    return {
      stdout: JSON.stringify({
        collectedAt: '2026-08-11T00:00:00Z',
        root: '/queue',
        items: [{ runId: 'ACL_1_smoke', state: 'running', signal: '.started' }],
        invalid: [],
      }),
    };
  };
  const result = await collectGpuQueue({
    enabled: true,
    sshExecutable: '/usr/bin/ssh',
    host: 'scheduler.example',
    port: 22222,
    root: '/queue',
    timeoutMs: 5000,
  }, { execFile });
  assert.equal(result.counts.running, 1);
  assert.equal(invocation.executable, '/usr/bin/ssh');
  assert.deepEqual(invocation.args.slice(0, 7), [
    '-p', '22222', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'scheduler.example',
  ]);
  assert.match(invocation.args[7], /^python3 -c /);
  assert.doesNotMatch(invocation.args[7], /mlx worker|\bkill\b|\brm\b/);
});

test('remote collector command quotes queue roots', () => {
  const command = gpuQueueInternals.remoteCommand("/queue/space's");
  assert.match(command, /python3 -c/);
  assert.match(command, /'"'"'/);
});

test('remote collector can read a queue inside a fixed Docker container', () => {
  const command = gpuQueueInternals.remoteCommand('/inside/queue', 'research-container');
  assert.match(command, /^docker exec 'research-container' python3 -c /);
  assert.match(command, /'\/inside\/queue'/);
  assert.doesNotMatch(command, /\b(?:kill|rm)\b/);
});
