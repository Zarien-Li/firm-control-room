import assert from 'node:assert/strict';
import test from 'node:test';
import { jobWaitStatus } from '../src/job-wait.js';

test('generic wait requires a declared active registered job owned by the project', () => {
  const registry = { items: [
    { runId: 'cpu-1', projectId: 'ACL_2', kind: 'local_cpu', state: 'running' },
    { runId: 'other', projectId: 'ACL_3', kind: 'ssh', state: 'running' },
  ] };
  const result = jobWaitStatus({
    projectId: 'ACL_2', heartbeat: { waitingForJobRunIds: ['cpu-1', 'other'] },
  }, registry);
  assert.deepEqual(result.matchedRunIds, ['cpu-1']);
  assert.equal(result.waiting, true);
});

test('terminal, missing, and foreign declarations never satisfy an active wait', () => {
  const result = jobWaitStatus({
    projectId: 'ACL_2', heartbeat: {
      waitingForJobRunIds: ['done-1', 'missing-1', 'foreign-1'],
    },
  }, { items: [
    { runId: 'done-1', projectId: 'ACL_2', kind: 'gpu', state: 'done' },
    { runId: 'foreign-1', projectId: 'ACL_3', kind: 'gpu', state: 'running' },
  ] });
  assert.equal(result.waiting, false);
  assert.deepEqual(result.terminalDeclaredRunIds, ['done-1']);
  assert.deepEqual(result.missingDeclaredRunIds, ['missing-1']);
  assert.deepEqual(result.foreignDeclaredRunIds, ['foreign-1']);
});
