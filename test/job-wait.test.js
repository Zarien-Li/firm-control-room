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
