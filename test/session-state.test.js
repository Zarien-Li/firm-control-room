import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveOperationalState } from '../src/session-state.js';

function session(terminalState, heartbeat = {}) {
  return {
    projectId: 'P',
    terminal: { state: terminalState },
    heartbeat: { status: 'ok', toolProcessCount: 0, ...heartbeat },
  };
}

test('operational state separates model work, tools, review, policy, and delivery ACK', () => {
  assert.equal(deriveOperationalState(session('WORKING')).state, 'MODEL_WORKING');
  assert.equal(deriveOperationalState(session('WORKING', {
    toolProcessCount: 2, activeToolProcessCount: 1,
  })).state, 'TOOL_RUNNING');
  assert.equal(deriveOperationalState(session('WAITING_INPUT', {
    toolProcessCount: 2, activeToolProcessCount: 0,
  })).state, 'READY_FOR_INPUT');
  assert.equal(deriveOperationalState(session('WAITING_INPUT'), {
    events: [{ targetId: 'P', status: 'PENDING', eventType: 'STOP_REVIEW_QUEUED' }],
  }).state, 'WAITING_REVIEW');
  assert.equal(deriveOperationalState(session('UNKNOWN'), {
    events: [{ targetId: 'P', status: 'PENDING', eventType: 'SESSION_PROGRESS_STALLED' }],
  }).state, 'PROGRESS_STALLED');
  assert.equal(deriveOperationalState(session('WAITING_INPUT'), {
    goalPolicy: { enabled: true }, goalBudgetReached: true,
  }).state, 'POLICY_HELD');
  assert.equal(deriveOperationalState(session('WORKING'), {
    goalBudgetReached: true,
  }).state, 'MODEL_WORKING');
  assert.equal(deriveOperationalState({
    ...session('RATE_LIMITED'),
    terminal: { state: 'RATE_LIMITED', resetAt: '2026-08-11T16:17:28.000Z' },
  }).state, 'RATE_LIMITED');
  assert.equal(deriveOperationalState(session('WORKING'), {
    outbox: [{ targetId: 'P', messageKey: 'm1', status: 'SENT_AWAITING_ACK' }],
  }).state, 'MESSAGE_PENDING_ACK');
  assert.equal(deriveOperationalState({
    ...session('DRAFT_PENDING_ENTER'),
    terminal: { state: 'DRAFT_PENDING_ENTER', draftDeliveryMarker: 'firm-one' },
  }, {
    outbox: [{ targetId: 'P', messageKey: 'firm-one', status: 'SENT_AWAITING_ACK' }],
  }).state, 'DRAFT_PENDING_ENTER');
});

test('scheduler monitoring idle is an explicit healthy state', () => {
  const value = deriveOperationalState({
    controlId: 'GPU_SCHEDULER',
    terminal: { state: 'WAITING_INPUT' },
    heartbeat: { status: 'ok', toolProcessCount: 0 },
  }, {
    schedulerMonitor: { status: 'healthy' },
    queue: { items: [] },
  });
  assert.equal(value.state, 'MONITORING_IDLE');
});

test('a verified active registered dependency is an acceptable waiting state', () => {
  const value = deriveOperationalState({
    projectId: 'P',
    terminal: { state: 'WAITING_INPUT' },
    heartbeat: {
      status: 'ok', activeToolProcessCount: 0,
      waitingForJobRunIds: ['P_train_1'],
    },
  }, {
    goalPolicy: { enabled: true },
    events: [{ targetId: 'P', status: 'PENDING', eventType: 'STOP_REVIEW_QUEUED' }],
    jobs: { items: [{ runId: 'P_train_1', projectId: 'P', kind: 'gpu', state: 'running' }] },
  });
  assert.equal(value.state, 'WAITING_FOR_JOB');
  assert.match(value.reason, /P_train_1/);
});

test('an active construction lease suppresses generic continuation state', () => {
  const value = deriveOperationalState(session('WAITING_INPUT', {
    constructionLease: { id: 'method-v1', state: 'active', active: true },
  }), {
    goalPolicy: { enabled: true },
  });
  assert.equal(value.state, 'CONSTRUCTION_ACTIVE');
  assert.match(value.reason, /method-v1/);
});

test('an unrelated active project job cannot turn an input point into a job wait', () => {
  const value = deriveOperationalState({
    projectId: 'ACL_1',
    terminal: { state: 'WAITING_INPUT' },
    heartbeat: { status: 'ok', waitingForJobRunIds: [] },
  }, {
    jobs: { items: [{ runId: 'ACL_1_train', projectId: 'ACL_1', kind: 'gpu', state: 'running' }] },
  });
  assert.equal(value.state, 'READY_FOR_INPUT');
  assert.deepEqual(value.details.undeclaredActiveJobs, [{
    runId: 'ACL_1_train', kind: 'gpu', state: 'running', purpose: null,
  }]);
});

test('a disabled goal policy cannot create a policy hold', () => {
  const value = deriveOperationalState(session('WAITING_INPUT'), {
    goalPolicy: { enabled: false }, goalBudgetReached: true,
  });
  assert.equal(value.state, 'READY_FOR_INPUT');
});

test('terminal and missing declared runs are stale evidence, not an active wait', () => {
  const value = deriveOperationalState(session('WAITING_INPUT', {
    waitingForJobRunIds: ['P_done', 'P_missing'],
  }), {
    jobs: { items: [{ runId: 'P_done', projectId: 'P', kind: 'gpu', state: 'done' }] },
  });
  assert.equal(value.state, 'READY_FOR_INPUT');
  assert.deepEqual(value.details.staleDeclaredRunIds, ['P_done', 'P_missing']);
});

test('an uncertain transport is quarantined and does not block the session', () => {
  const value = deriveOperationalState({
    projectId: 'P', terminal: { state: 'WAITING_INPUT' },
    heartbeat: { status: 'ok', waitingForJobRunIds: [] },
  }, {
    outbox: [{ targetId: 'P', status: 'UNCERTAIN', messageKey: 'old' }],
    jobs: { items: [] },
  });
  assert.notEqual(value.state, 'MESSAGE_PENDING_ACK');
});
