import assert from 'node:assert/strict';
import test from 'node:test';
import { activeGpuRuns, gpuItemBelongsToTarget, gpuWaitStatus } from '../src/gpu-wait.js';

test('GPU wait requires an exact declared active run owned by the project', () => {
  const queue = { items: [
    { runId: 'ACL_1_train_1', project: 'ACL_1', state: 'running' },
    { runId: 'ACL_1_old', project: 'ACL_1', state: 'done' },
    { runId: 'ACL_4_train_1', project: 'ACL_4', state: 'pending' },
  ] };
  const session = {
    projectId: 'ACL_1',
    heartbeat: { waitingForGpuRunIds: ['ACL_1_train_1'] },
  };
  assert.equal(gpuWaitStatus(session, queue).waiting, true);
  assert.deepEqual(gpuWaitStatus(session, queue).matchedRunIds, ['ACL_1_train_1']);
  assert.equal(gpuWaitStatus({
    ...session, heartbeat: { waitingForGpuRunIds: ['ACL_1_old'] },
  }, queue).waiting, false);
  assert.equal(gpuWaitStatus({
    ...session, heartbeat: { waitingForGpuRunIds: ['ACL_4_train_1'] },
  }, queue).waiting, false);
  assert.deepEqual(activeGpuRuns(queue, 'ACL_1').map((item) => item.runId), ['ACL_1_train_1']);
  assert.equal(gpuItemBelongsToTarget(queue.items[2], 'ACL_1'), false);
});
