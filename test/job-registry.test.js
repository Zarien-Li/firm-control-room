import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JobRegistry } from '../src/job-registry.js';
import { createStore } from '../src/store.js';

async function fixture() {
  const store = await createStore(await mkdtemp(join(tmpdir(), 'firm-jobs-')));
  const registry = new JobRegistry({ store, now: () => new Date('2026-08-12T00:00:00Z') });
  return { store, registry };
}

test('registry persists explicit lifecycle and rejects regressions', async () => {
  const { store, registry } = await fixture();
  registry.register({ runId: 'cpu-1', projectId: 'ACL_2', kind: 'local_cpu' });
  registry.update('cpu-1', {
    state: 'running', pid: 42, pidStartToken: 'ps-lstart:first',
    commandFingerprint: 'a'.repeat(64),
  });
  registry.update('cpu-1', { state: 'done', result: { path: '/tmp/result' } });
  assert.equal(registry.get('cpu-1').state, 'done');
  assert.equal(registry.events('cpu-1').filter((event) => event.eventType === 'state_changed').length, 2);
  assert.throws(() => registry.update('cpu-1', { state: 'running' }), /invalid_job_transition/);
  store.close();
});

test('GPU queue synchronizes into the registry but stale pending cannot regress running', async () => {
  const { store, registry } = await fixture();
  const snapshot = (state) => ({ status: 'ok', items: [{
    runId: 'ACL_3_train', project: 'ACL_3', state, remotePath: '/queue/x',
  }] });
  registry.syncGpuQueue(snapshot('running'));
  const eventCount = registry.events('ACL_3_train').length;
  registry.syncGpuQueue(snapshot('running'));
  assert.equal(registry.events('ACL_3_train').length, eventCount);
  registry.syncGpuQueue(snapshot('pending'));
  assert.equal(registry.get('ACL_3_train').state, 'running');
  store.close();
});

test('GPU queue accepts a terminal state when a short run finishes between polls', async () => {
  const { store, registry } = await fixture();
  registry.syncGpuQueue({ status: 'ok', items: [{
    runId: 'ACL_6_short', project: 'ACL_6', state: 'pending',
    remotePath: '/queue/pending/ACL_6_short',
  }] });
  registry.syncGpuQueue({ status: 'ok', items: [{
    runId: 'ACL_6_short', project: 'ACL_6', state: 'done',
    remotePath: '/queue/done/ACL_6_short', signalAt: '2026-08-12T00:00:10Z',
  }] });
  const job = registry.get('ACL_6_short');
  assert.equal(job.state, 'done');
  assert.equal(job.result.remotePath, '/queue/done/ACL_6_short');
  assert.equal(
    registry.events('ACL_6_short').filter((event) => event.eventType === 'state_changed').length,
    1,
  );
  store.close();
});

test('GPU queue preserves the terminal manifest as execution evidence', async () => {
  const { store, registry } = await fixture();
  registry.syncGpuQueue({ status: 'ok', items: [{
    runId: 'ACL_10_manifest', project: 'ACL_10', state: 'done', remotePath: '/queue/done/x',
    terminal: { state: 'done', exitCode: 0, runner: 'FIRM_GPU_QUEUE_RUNNER' },
  }] });
  assert.deepEqual(registry.get('ACL_10_manifest').result.terminal, {
    state: 'done', exitCode: 0, runner: 'FIRM_GPU_QUEUE_RUNNER',
  });
  store.close();
});

test('GPU queue requires two authoritative misses before failing a vanished active run', async () => {
  const { store, registry } = await fixture();
  registry.syncGpuQueue({ status: 'ok', items: [{
    runId: 'ACL_3_vanished', project: 'ACL_3', state: 'running', remotePath: '/queue/running/x',
  }] });
  registry.syncGpuQueue({ status: 'ok', items: [] });
  assert.equal(registry.get('ACL_3_vanished').state, 'running');
  assert.equal(registry.get('ACL_3_vanished').metadata.queueMissingObservations, 1);
  registry.syncGpuQueue({ status: 'ok', items: [] });
  assert.equal(registry.get('ACL_3_vanished').state, 'failed');
  assert.equal(
    registry.get('ACL_3_vanished').result.reason,
    'queue_entry_missing_from_two_authoritative_snapshots',
  );
  store.close();
});

test('a reappearing GPU run clears the missing-snapshot counter', async () => {
  const { store, registry } = await fixture();
  const running = { status: 'ok', items: [{
    runId: 'ACL_8_reappeared', project: 'ACL_8', state: 'running', remotePath: '/queue/running/y',
  }] };
  registry.syncGpuQueue(running);
  registry.syncGpuQueue({ status: 'ok', items: [] });
  registry.syncGpuQueue(running);
  assert.equal(registry.get('ACL_8_reappeared').state, 'running');
  assert.equal(registry.get('ACL_8_reappeared').metadata.queueMissingObservations, 0);
  store.close();
});

test('unknown liveness metadata never changes authoritative job state', async () => {
  const { store, registry } = await fixture();
  registry.register({
    runId: 'ssh-1', projectId: 'ACL_6', kind: 'ssh', state: 'running',
    pid: 88, pidStartToken: 'ps-lstart:first', commandFingerprint: 'c'.repeat(64),
  });
  registry.update('ssh-1', { metadata: { liveness: 'unknown', reason: 'host_unreachable' } });
  assert.equal(registry.get('ssh-1').state, 'running');
  store.close();
});

test('registered process identity rejects PID reuse and command replacement', async () => {
  const { store, registry } = await fixture();
  registry.register({ runId: 'cpu-identity', projectId: 'ACL_2', kind: 'local_cpu' });
  registry.update('cpu-identity', {
    state: 'running', pid: 123, pidStartToken: 'ps-lstart:first',
    commandFingerprint: 'a'.repeat(64),
  });
  assert.throws(() => registry.update('cpu-identity', {
    state: 'done', pid: 123, pidStartToken: 'ps-lstart:reused',
  }), /start_token/);
  assert.throws(() => registry.update('cpu-identity', {
    state: 'done', pid: 123, pidStartToken: 'ps-lstart:first',
    commandFingerprint: 'b'.repeat(64),
  }), /command/);
  assert.equal(registry.get('cpu-identity').state, 'running');
  store.close();
});

test('default snapshot includes every active job and pages bounded terminal history', async () => {
  const { store, registry } = await fixture();
  for (let index = 0; index < 3; index += 1) {
    registry.register({ runId: `active-${index}`, projectId: 'ACL_2', kind: 'ssh' });
  }
  for (let index = 0; index < 31; index += 1) {
    registry.register({ runId: `done-${String(index).padStart(2, '0')}`, projectId: 'ACL_2', kind: 'local_cpu', state: 'done' });
  }
  const first = registry.snapshot({ terminalLimit: 10 });
  assert.equal(first.items.filter((job) => ['pending', 'running'].includes(job.state)).length, 3);
  assert.equal(first.items.filter((job) => job.state === 'done').length, 10);
  assert.ok(first.page.nextCursor);
  const seen = new Set(first.items.filter((job) => job.state === 'done').map((job) => job.runId));
  let cursor = first.page.nextCursor;
  while (cursor) {
    const page = registry.snapshot({ terminalLimit: 10, cursor, historyOnly: true });
    for (const job of page.items) {
      assert.equal(seen.has(job.runId), false);
      seen.add(job.runId);
    }
    cursor = page.page.nextCursor;
  }
  assert.equal(seen.size, 31);
  store.close();
});
