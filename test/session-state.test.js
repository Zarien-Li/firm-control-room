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
    goalBudgetReached: true,
  }).state, 'POLICY_HELD');
  assert.equal(deriveOperationalState(session('WORKING'), {
    goalBudgetReached: true,
  }).state, 'MODEL_WORKING');
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

test('a verified active GPU dependency is an acceptable waiting state', () => {
  const value = deriveOperationalState({
    projectId: 'P',
    terminal: { state: 'WAITING_INPUT' },
    heartbeat: {
      status: 'ok', activeToolProcessCount: 0,
      waitingForGpuRunIds: ['P_train_1'],
    },
  }, {
    goalPolicy: { enabled: true },
    events: [{ targetId: 'P', status: 'PENDING', eventType: 'STOP_REVIEW_QUEUED' }],
    queue: { items: [{ runId: 'P_train_1', project: 'P', state: 'running' }] },
  });
  assert.equal(value.state, 'WAITING_FOR_GPU');
  assert.match(value.reason, /P_train_1/);
});
