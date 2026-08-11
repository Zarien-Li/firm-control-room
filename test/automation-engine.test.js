import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AutomationEngine } from '../src/automation-engine.js';
import { createStore } from '../src/store.js';

function config() {
  return {
    projects: [{ id: 'ACL_1' }, { id: 'ACL_4' }],
    gpuQueue: {
      enabled: true,
      pollMs: 1000,
      schedulerAutoStart: true,
    },
    watchdog: { waitingMs: 60_000, stopReviewStableMs: 10_000 },
    goalLoop: { graceMs: 10_000, cooldownMs: 60_000, maxContinuesPerDay: 6 },
  };
}

class FakeSessions {
  constructor(sessions = []) {
    this.sessions = sessions;
    this.inputs = [];
    this.starts = [];
    this.bootstraps = [];
  }

  async list() { return this.sessions; }

  async input(id, data) {
    this.inputs.push({ id, data });
    const session = this.sessions.find((item) => item.id === id);
    if (session) session.status = 'RUNNING';
    return session;
  }

  async start(projectId) {
    this.starts.push(projectId);
    const session = {
      id: `started-${projectId}`,
      projectId,
      projectName: projectId,
      status: 'RUNNING',
      bootstrapStatus: 'PENDING',
    };
    this.sessions.push(session);
    return session;
  }

  async bootstrap(id) {
    this.bootstraps.push(id);
    const session = this.sessions.find((item) => item.id === id);
    session.bootstrapStatus = 'SENT';
    session.status = 'RUNNING';
    return session;
  }
}

async function fixture(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'firm-automation-'));
  const store = await createStore(directory);
  try {
    await fn(store);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('submitted GPU request wakes one waiting managed scheduler exactly once', async () => {
  await fixture(async (store) => {
    const sessions = new FakeSessions([{
      id: 'scheduler-1',
      projectId: 'GPU_SCHEDULER',
      projectName: 'GPU Scheduler',
      status: 'WAITING_INPUT',
      bootstrapStatus: 'SENT',
      waitingSince: '2026-08-11T00:00:00Z',
    }]);
    const queueCollector = async () => ({
      status: 'ok',
      collectedAt: '2026-08-11T00:01:00Z',
      root: '/queue',
      counts: { pending: 1, running: 0, done: 0, failed: 0, cancelled: 0 },
      invalid: [],
      items: [{
        runId: 'ACL_1_smoke_20260811_000000',
        state: 'pending',
        signal: '.submitted',
        remotePath: '/queue/pending/ACL_1_smoke_20260811_000000',
      }],
    });
    const engine = new AutomationEngine({
      config: config(), store, sessionManager: sessions, queueCollector,
      now: () => new Date('2026-08-11T00:01:00Z'),
    });
    await engine.cycle({ forceQueue: true });
    assert.equal(sessions.inputs.length, 1);
    assert.match(sessions.inputs[0].data, /operational wake-up only/i);
    assert.equal(store.listAutomationEvents(10)
      .find((event) => event.eventType === 'GPU_REQUEST_SUBMITTED').status, 'DELIVERED');
    await engine.cycle({ forceQueue: true });
    assert.equal(sessions.inputs.length, 1);
  });
});

test('missing global Scheduler monitor triggers recovery and resolves after verification', async () => {
  await fixture(async (store) => {
    const sessions = new FakeSessions([{
      id: 'scheduler-monitor',
      projectId: 'GPU_SCHEDULER',
      projectName: 'GPU Scheduler',
      status: 'WAITING_INPUT',
      bootstrapStatus: 'SENT',
      waitingSince: '2026-08-11T00:00:00Z',
    }]);
    const monitorConfig = config();
    monitorConfig.gpuQueue.schedulerMonitorPidFile = '/tmp/test-global-monitor.pid';
    let health = {
      status: 'missing', reason: 'process_not_found',
      pidFile: monitorConfig.gpuQueue.schedulerMonitorPidFile, pid: 123,
    };
    const engine = new AutomationEngine({
      config: monitorConfig,
      store,
      sessionManager: sessions,
      queueCollector: async () => ({
        status: 'ok', collectedAt: '2026-08-11T00:00:00Z', root: '/queue',
        counts: { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 },
        invalid: [], items: [],
      }),
      schedulerMonitorProbe: async () => health,
      now: () => new Date('2026-08-11T00:00:00Z'),
    });

    await engine.cycle({ forceQueue: true });
    assert.equal(sessions.inputs.length, 1);
    assert.match(sessions.inputs[0].data, /Restore exactly one global monitor now/);
    let event = store.listAutomationEvents(10)
      .find((item) => item.eventType === 'GPU_SCHEDULER_MONITOR_MISSING');
    assert.equal(event.status, 'DELIVERED');

    health = { status: 'healthy', reason: 'monitor_process_verified', pid: 456 };
    await engine.cycle({ forceQueue: true });
    event = store.getAutomationEvent(event.eventKey);
    assert.equal(event.status, 'RESOLVED');
    assert.equal(event.note, 'monitor_recovered_pid_456');
  });
});

test('low GPU utilization creates a diagnostic scheduler event but never kills a worker', async () => {
  await fixture(async (store) => {
    const sessions = new FakeSessions([{
      id: 'scheduler-efficiency', projectId: 'GPU_SCHEDULER', projectName: 'GPU Scheduler',
      status: 'WAITING_INPUT', bootstrapStatus: 'SENT', waitingSince: '2026-08-11T00:00:00Z',
    }]);
    const queueCollector = async () => ({
      status: 'ok', collectedAt: '2026-08-11T00:10:00Z', root: '/queue', invalid: [],
      counts: { pending: 0, running: 1, done: 0, failed: 0, cancelled: 0 },
      items: [{
        runId: 'ACL_1_train', state: 'running', remotePath: '/queue/running/ACL_1_train',
        telemetry: { phase: 'compute', progressMarker: 'step 50' },
        efficiency: {
          state: 'INEFFICIENT', severity: 'warn', reason: 'low_utilization_with_progress',
          averageUtilizationPct: 3, recommendation: 'Tune batching while preserving the run.',
        },
      }],
    });
    const engine = new AutomationEngine({
      config: config(), store, sessionManager: sessions, queueCollector,
    });
    await engine.cycle({ forceQueue: true });
    assert.equal(sessions.inputs.length, 1);
    assert.match(sessions.inputs[0].data, /GPU EFFICIENCY/);
    assert.match(sessions.inputs[0].data, /3\.0%/);
    assert.match(sessions.inputs[0].data, /Never terminate or resize/i);
    assert.equal(sessions.starts.length, 0);
  });
});

test('ready GPU result remains in inbox when no project session is waiting', async () => {
  await fixture(async (store) => {
    const sessions = new FakeSessions([]);
    const queueCollector = async () => ({
      status: 'ok',
      collectedAt: '2026-08-11T00:01:00Z',
      root: '/queue',
      counts: { pending: 0, running: 0, done: 1, failed: 0, cancelled: 0 },
      invalid: [],
      items: [{
        runId: 'ACL_4_eval_20260811_000000',
        project: 'ACL_4',
        state: 'done',
        signal: '.ready',
        remotePath: '/queue/done/ACL_4_eval_20260811_000000',
      }],
    });
    const engine = new AutomationEngine({
      config: config(), store, sessionManager: sessions, queueCollector,
    });
    await engine.cycle({ forceQueue: true });
    const event = store.listAutomationEvents(10)[0];
    assert.equal(event.targetId, 'ACL_4');
    assert.equal(event.status, 'HELD');
    assert.equal(event.note, 'no_waiting_managed_session');
    assert.equal(sessions.starts.length, 0);
  });
});

test('external scheduler prevents automatic duplicate scheduler start', async () => {
  await fixture(async (store) => {
    const sessions = new FakeSessions([]);
    const queueCollector = async () => ({
      status: 'ok',
      collectedAt: '2026-08-11T00:01:00Z',
      root: '/queue',
      counts: { pending: 1, running: 0, done: 0, failed: 0, cancelled: 0 },
      invalid: [],
      items: [{
        runId: 'ACL_1_smoke_20260811_000000',
        state: 'pending',
        remotePath: '/queue/pending/ACL_1_smoke_20260811_000000',
      }],
    });
    const engine = new AutomationEngine({
      config: config(),
      store,
      sessionManager: sessions,
      queueCollector,
      discoverExternalSessions: async () => ({
        items: [{ controlId: 'GPU_SCHEDULER', pid: 123 }],
      }),
    });
    await engine.cycle({ forceQueue: true });
    assert.equal(sessions.starts.length, 0);
    assert.equal(
      store.listAutomationEvents(10)[0].note,
      'scheduler_is_external_and_cannot_be_injected',
    );
  });
});

test('watchdog records long waits but does not inject a research continuation', async () => {
  await fixture(async (store) => {
    const sessions = new FakeSessions([{
      id: 'research-1',
      projectId: 'ACL_1',
      projectName: 'ACL 1',
      status: 'WAITING_INPUT',
      bootstrapStatus: 'SENT',
      waitingSince: '2026-08-11T00:00:00Z',
    }]);
    const engine = new AutomationEngine({
      config: config(),
      store,
      sessionManager: sessions,
      queueCollector: async () => ({
        status: 'ok', collectedAt: '2026-08-11T00:02:00Z', root: '/queue', items: [],
        invalid: [], counts: { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 },
      }),
      now: () => new Date('2026-08-11T00:02:00Z'),
    });
    await engine.cycle({ forceQueue: true });
    const event = store.listAutomationEvents(10)[0];
    assert.equal(event.eventType, 'LONG_WAITING_INPUT');
    assert.equal(event.status, 'PENDING');
    assert.equal(sessions.inputs.length, 0);
  });
});

test('external stop detection triggers once per transition into a normal input point', async () => {
  await fixture(async (store) => {
    const stopped = [];
    let now = new Date('2026-08-11T00:02:00Z');
    const external = {
      pid: 12345,
      projectId: 'ACL_1',
      tty: '/dev/ttys018',
      terminal: { state: 'WORKING', tailHash: 'work-a' },
    };
    const engine = new AutomationEngine({
      config: config(),
      store,
      sessionManager: new FakeSessions([]),
      queueCollector: async () => ({
        status: 'ok', collectedAt: '2026-08-11T00:02:00Z', root: '/queue', items: [],
        invalid: [], counts: { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 },
      }),
      discoverExternalSessions: async () => ({ items: [external] }),
      onExternalSessionStopped: async (stop) => stopped.push(stop),
      now: () => now,
    });

    await engine.cycle({ forceQueue: true });
    assert.equal(stopped.length, 0);
    external.terminal = { state: 'WAITING_INPUT', tailHash: 'wait-a' };
    await engine.cycle({ forceQueue: true });
    assert.equal(stopped.length, 0, 'a transient input prompt must not trigger review');
    now = new Date('2026-08-11T00:02:11Z');
    await engine.cycle({ forceQueue: true });
    assert.equal(stopped.length, 1);
    assert.equal(stopped[0].previousState, 'WORKING');
    await engine.cycle({ forceQueue: true });
    assert.equal(stopped.length, 1, 'the same waiting episode must not be reviewed twice');
    external.terminal = { state: 'WORKING', tailHash: 'work-b' };
    await engine.cycle({ forceQueue: true });
    external.terminal = { state: 'WAITING_INPUT', tailHash: 'wait-b' };
    await engine.cycle({ forceQueue: true });
    now = new Date('2026-08-11T00:02:22Z');
    await engine.cycle({ forceQueue: true });
    assert.equal(stopped.length, 2);
  });
});

test('a fast work cycle between polls is detected from new waiting evidence', async () => {
  await fixture(async (store) => {
    const stopped = [];
    let now = new Date('2026-08-11T00:00:00Z');
    const external = {
      pid: 12345, projectId: 'ACL_1', tty: '/dev/ttys018',
      terminal: { state: 'WAITING_INPUT', tailHash: 'wait-a' },
      heartbeat: {
        status: 'ok', historyWriteAt: '2026-08-11T00:00:00.000Z',
        lastProgressAt: '2026-08-11T00:00:00.000Z', toolProcessCount: 0,
      },
    };
    const engine = new AutomationEngine({
      config: config(), store, sessionManager: new FakeSessions([]),
      queueCollector: async () => ({
        status: 'ok', collectedAt: now.toISOString(), root: '/queue', items: [],
        invalid: [], counts: { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 },
      }),
      discoverExternalSessions: async () => ({
        status: 'ok', terminalStatus: 'ok', items: [external],
      }),
      onExternalSessionStopped: async (stop) => stopped.push(stop),
      now: () => now,
    });

    await engine.cycle({ forceQueue: true });
    now = new Date('2026-08-11T00:00:11Z');
    await engine.cycle({ forceQueue: true });
    assert.equal(stopped.length, 1);

    // Claude starts and finishes between watchdog polls. Both observed states are WAITING_INPUT.
    external.terminal = { state: 'WAITING_INPUT', tailHash: 'wait-b' };
    external.heartbeat = {
      ...external.heartbeat,
      historyWriteAt: '2026-08-11T00:00:20.000Z',
      lastProgressAt: '2026-08-11T00:00:20.000Z',
    };
    now = new Date('2026-08-11T00:00:21Z');
    await engine.cycle({ forceQueue: true });
    assert.equal(stopped.length, 1, 'the new prompt must still pass the stability window');
    now = new Date('2026-08-11T00:00:32Z');
    await engine.cycle({ forceQueue: true });
    assert.equal(stopped.length, 2);

    external.terminal = { state: 'WAITING_INPUT', tailHash: 'render-only-change' };
    now = new Date('2026-08-11T00:00:45Z');
    await engine.cycle({ forceQueue: true });
    assert.equal(stopped.length, 2, 'terminal re-rendering without new history is not a new episode');
  });
});

test('stable UNKNOWN output triggers immediate review without unsafe continuation authority', async () => {
  await fixture(async (store) => {
    const stopped = [];
    let now = new Date('2026-08-11T00:00:00Z');
    const external = {
      pid: 12345, projectId: 'ACL_1', tty: '/dev/ttys018',
      terminal: { state: 'UNKNOWN', tailHash: 'unchanged-tail' },
    };
    const stalledConfig = config();
    stalledConfig.watchdog.unknownStallMs = 3 * 60 * 1000;
    const engine = new AutomationEngine({
      config: stalledConfig,
      store,
      sessionManager: new FakeSessions([]),
      queueCollector: async () => ({
        status: 'ok', collectedAt: now.toISOString(), root: '/queue', items: [],
        invalid: [], counts: { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 },
      }),
      discoverExternalSessions: async () => ({ items: [external] }),
      onExternalSessionStopped: async (stop) => stopped.push(stop),
      now: () => now,
    });

    await engine.cycle({ forceQueue: true });
    now = new Date('2026-08-11T00:03:01Z');
    await engine.cycle({ forceQueue: true });
    assert.equal(stopped.length, 1);
    assert.equal(stopped[0].safeToContinue, false);
    assert.equal(stopped[0].stopReason, 'stable_unknown_no_output');
    const event = store.listAutomationEvents(10)
      .find((item) => item.eventType === 'SESSION_OUTPUT_STALLED');
    assert.equal(event.status, 'PENDING');
    assert.equal(event.source.deliveryPolicy, 'manual');
  });
});

test('a fake WORKING spinner with no effective progress triggers review-only liveness audit', async () => {
  await fixture(async (store) => {
    const stopped = [];
    let now = new Date('2026-08-11T00:00:00Z');
    const external = {
      pid: 23456, projectId: 'ACL_1', tty: '/dev/ttys018',
      terminal: { state: 'WORKING', tailHash: 'spinner-keeps-rendering' },
      heartbeat: {
        status: 'ok', lastProgressAt: '2026-08-10T23:30:00.000Z',
        toolProcessCount: 0, activeToolProcessCount: 0, toolKinds: [],
        toolFingerprint: 'empty',
      },
    };
    const stalledConfig = config();
    stalledConfig.watchdog.progressStallMs = 60 * 1000;
    stalledConfig.watchdog.toolProgressStallMs = 5 * 60 * 1000;
    const engine = new AutomationEngine({
      config: stalledConfig,
      store,
      sessionManager: new FakeSessions([]),
      queueCollector: async () => ({
        status: 'ok', collectedAt: now.toISOString(), root: '/queue', items: [],
        invalid: [], counts: { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 },
      }),
      discoverExternalSessions: async () => ({
        status: 'ok', terminalStatus: 'ok', items: [external],
      }),
      onExternalSessionStopped: async (stop) => stopped.push(stop),
      now: () => now,
    });

    await engine.cycle({ forceQueue: true });
    now = new Date('2026-08-11T00:01:01Z');
    await engine.cycle({ forceQueue: true });
    assert.equal(stopped.length, 1);
    assert.equal(stopped[0].safeToContinue, false);
    assert.equal(stopped[0].stopReason, 'effective_progress_stalled');
    assert.equal(store.listAutomationEvents(10)
      .find((item) => item.eventType === 'SESSION_PROGRESS_STALLED').status, 'PENDING');

    external.heartbeat = {
      ...external.heartbeat,
      lastProgressAt: '2026-08-11T00:01:02.000Z',
    };
    now = new Date('2026-08-11T00:01:03Z');
    await engine.cycle({ forceQueue: true });
    assert.equal(store.listAutomationEvents(10)
      .find((item) => item.eventType === 'SESSION_PROGRESS_STALLED').status, 'RESOLVED');
  });
});

test('a real tool process receives the longer progress window', async () => {
  await fixture(async (store) => {
    const stopped = [];
    let now = new Date('2026-08-11T00:00:00Z');
    const external = {
      pid: 34567, projectId: 'ACL_1', tty: '/dev/ttys018',
      terminal: { state: 'WORKING', tailHash: 'training' },
      heartbeat: {
        status: 'ok', lastProgressAt: '2026-08-10T23:30:00.000Z',
        toolProcessCount: 1, activeToolProcessCount: 1, toolKinds: ['python'],
        toolFingerprint: 'python-34568',
      },
    };
    const stalledConfig = config();
    stalledConfig.watchdog.progressStallMs = 60 * 1000;
    stalledConfig.watchdog.toolProgressStallMs = 5 * 60 * 1000;
    const engine = new AutomationEngine({
      config: stalledConfig, store, sessionManager: new FakeSessions([]),
      queueCollector: async () => ({
        status: 'ok', collectedAt: now.toISOString(), root: '/queue', items: [],
        invalid: [], counts: { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 },
      }),
      discoverExternalSessions: async () => ({
        status: 'ok', terminalStatus: 'ok', items: [external],
      }),
      onExternalSessionStopped: async (stop) => stopped.push(stop),
      now: () => now,
    });
    await engine.cycle({ forceQueue: true });
    now = new Date('2026-08-11T00:01:01Z');
    await engine.cycle({ forceQueue: true });
    assert.equal(stopped.length, 0);
    now = new Date('2026-08-11T00:05:01Z');
    await engine.cycle({ forceQueue: true });
    assert.equal(stopped.length, 1);
  });
});

test('collector degradation is visible and resolves independently of project science', async () => {
  await fixture(async (store) => {
    let degraded = true;
    const engine = new AutomationEngine({
      config: config(), store, sessionManager: new FakeSessions([]),
      queueCollector: async () => ({
        status: 'ok', collectedAt: '2026-08-11T00:00:00Z', root: '/queue', items: [],
        invalid: [], counts: { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 },
      }),
      discoverExternalSessions: async () => degraded ? ({
        status: 'ok', terminalStatus: 'degraded', terminalReason: 'osascript_failed', items: [],
      }) : ({ status: 'ok', terminalStatus: 'ok', items: [] }),
      now: () => new Date('2026-08-11T00:00:00Z'),
    });
    await engine.cycle({ forceQueue: true });
    let event = store.listAutomationEvents(10)
      .find((item) => item.eventType === 'SESSION_COLLECTOR_DEGRADED');
    assert.equal(event.status, 'PENDING');
    assert.equal(event.targetId, 'CONTROL_ROOM');
    degraded = false;
    await engine.cycle({ forceQueue: true });
    event = store.listAutomationEvents(10)
      .find((item) => item.eventType === 'SESSION_COLLECTOR_DEGRADED');
    assert.equal(event.status, 'RESOLVED');
  });
});

test('trusted operational event reaches one verified external iTerm session', async () => {
  await fixture(async (store) => {
    store.createAutomationEvent({
      eventKey: 'gpu:ACL_1_eval:done',
      category: 'gpu_queue',
      eventType: 'GPU_RESULT_READY',
      targetId: 'ACL_1',
      runId: 'ACL_1_eval',
      severity: 'info',
      title: 'GPU result ready',
      message: 'Read the authoritative result.',
      source: {
        deliveryPolicy: 'auto_notify',
        queueItem: { runId: 'ACL_1_eval', state: 'done', remotePath: '/queue/done/ACL_1_eval' },
      },
    });
    store.createAutomationEvent({
      eventKey: 'gpu:ACL_1_eval_2:done',
      category: 'gpu_queue',
      eventType: 'GPU_RESULT_READY',
      targetId: 'ACL_1',
      runId: 'ACL_1_eval_2',
      severity: 'info',
      title: 'Second GPU result ready',
      message: 'Read the second authoritative result.',
      source: {
        deliveryPolicy: 'auto_notify',
        queueItem: {
          runId: 'ACL_1_eval_2', state: 'done', remotePath: '/queue/done/ACL_1_eval_2',
        },
      },
    });
    const sent = [];
    const externalSession = {
      pid: 12345,
      projectId: 'ACL_1',
      tty: '/dev/ttys018',
      terminal: { state: 'WAITING_INPUT', tailHash: 'tail-a' },
      heartbeat: { historyCursor: 'session.jsonl:10:event-a', deliveryMarkers: [] },
    };
    const engine = new AutomationEngine({
      config: config(),
      store,
      sessionManager: new FakeSessions([]),
      queueCollector: async () => ({
        status: 'ok', collectedAt: '2026-08-11T00:02:00Z', root: '/queue', items: [],
        invalid: [], counts: { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 },
      }),
      discoverExternalSessions: async () => ({ items: [externalSession] }),
      externalSessionInput: async (session, message) => sent.push({ session, message }),
      now: () => new Date('2026-08-11T00:02:00Z'),
    });
    await engine.cycle({ forceQueue: true });
    assert.equal(sent.length, 1);
    assert.match(sent[0].message, /GPU RESULT/);
    const marker = sent[0].message.match(/\[FIRM DELIVERY ([^\]]+)\]/)[1];
    assert.equal(
      store.listAutomationEvents(10).find((item) => item.eventKey === 'gpu:ACL_1_eval:done').status,
      'SENT',
    );
    externalSession.heartbeat = {
      historyCursor: 'session.jsonl:100:event-b', deliveryMarkers: [marker],
    };
    await engine.cycle({ forceQueue: true });
    assert.equal(sent.length, 1, 'a second event must wait for the active work cycle to finish');
    const events = store.listAutomationEvents(10)
      .filter((item) => item.targetId === 'ACL_1');
    assert.equal(events.filter((item) => item.status === 'DELIVERED').length, 1);
    assert.equal(
      events.find((item) => item.status === 'DELIVERED').note,
      'claude_history_acknowledged_delivery',
    );
  });
});

test('opt-in Goal Loop continues only at a normal Claude prompt', async () => {
  await fixture(async (store) => {
    store.setAutomationPolicy('ACL_1', {
      enabled: true,
      objective: 'Complete ACL_1 to an honest submission-ready paper.',
    });
    const sessions = new FakeSessions([{
      id: 'research-goal-1',
      projectId: 'ACL_1',
      projectName: 'ACL 1',
      status: 'WAITING_INPUT',
      bootstrapStatus: 'SENT',
      waitingSince: '2026-08-11T00:00:00Z',
      waitReason: 'claude_prompt',
    }]);
    const engine = new AutomationEngine({
      config: config(),
      store,
      sessionManager: sessions,
      queueCollector: async () => ({
        status: 'ok', collectedAt: '2026-08-11T00:02:00Z', root: '/queue', items: [],
        invalid: [], counts: { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 },
      }),
      now: () => new Date('2026-08-11T00:02:00Z'),
    });
    await engine.cycle({ forceQueue: true });
    assert.equal(sessions.inputs.length, 1);
    assert.match(sessions.inputs[0].data, /USER-APPROVED GOAL LOOP/);
    assert.match(sessions.inputs[0].data, /submission-ready paper/);
    const event = store.listAutomationEvents(10)
      .find((item) => item.eventType === 'GOAL_CONTINUED');
    assert.equal(event.status, 'DELIVERED');
  });
});

test('managed Goal Loop accepts a verified active GPU wait from Claude history', async () => {
  await fixture(async (store) => {
    store.setAutomationPolicy('ACL_1', {
      enabled: true,
      objective: 'Complete ACL_1 to an honest submission-ready paper.',
    });
    const sessions = new FakeSessions([{
      id: 'research-goal-gpu-wait',
      projectId: 'ACL_1',
      projectName: 'ACL 1',
      pid: 12345,
      status: 'WAITING_INPUT',
      bootstrapStatus: 'SENT',
      waitingSince: '2026-08-11T00:00:00Z',
      waitReason: 'claude_prompt',
    }]);
    const engine = new AutomationEngine({
      config: config(),
      store,
      sessionManager: sessions,
      queueCollector: async () => ({
        status: 'ok', collectedAt: '2026-08-11T00:02:00Z', root: '/queue', invalid: [],
        counts: { pending: 0, running: 1, done: 0, failed: 0, cancelled: 0 },
        items: [{
          runId: 'ACL_1_train_1', project: 'ACL_1', state: 'running',
          remotePath: '/queue/running/ACL_1_train_1',
        }],
      }),
      discoverExternalSessions: async () => ({ items: [{
        pid: 12345,
        projectId: 'ACL_1',
        heartbeat: { waitingForGpuRunIds: ['ACL_1_train_1'] },
      }] }),
      now: () => new Date('2026-08-11T00:02:00Z'),
    });
    await engine.cycle({ forceQueue: true });
    assert.equal(sessions.inputs.length, 0);
    assert.equal(store.listAutomationEvents(10).some((item) => (
      item.eventType === 'GOAL_CONTINUED'
    )), false);
  });
});

test('opt-in Goal Loop safely continues one verified external iTerm session', async () => {
  await fixture(async (store) => {
    store.setAutomationPolicy('ACL_1', {
      enabled: true,
      objective: 'Complete ACL_1 to an honest submission-ready paper.',
    });
    let now = new Date('2026-08-11T00:00:00Z');
    const sent = [];
    const externalSession = {
      pid: 12345,
      projectId: 'ACL_1',
      tty: '/dev/ttys018',
      terminal: { state: 'WAITING_INPUT', tailHash: 'tail-a' },
      heartbeat: { historyCursor: 'session.jsonl:10:event-a', deliveryMarkers: [] },
    };
    const engine = new AutomationEngine({
      config: config(),
      store,
      sessionManager: new FakeSessions([]),
      queueCollector: async () => ({
        status: 'ok', collectedAt: now.toISOString(), root: '/queue', items: [],
        invalid: [], counts: { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 },
      }),
      discoverExternalSessions: async () => ({ items: [externalSession] }),
      externalSessionInput: async (session, message) => sent.push({ session, message }),
      now: () => now,
    });

    await engine.cycle({ forceQueue: true });
    assert.equal(sent.length, 0, 'the external wait must pass through the grace period');

    now = new Date('2026-08-11T00:00:11Z');
    await engine.cycle({ forceQueue: true });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].session.pid, 12345);
    assert.match(sent[0].message, /USER-APPROVED GOAL LOOP/);
    assert.match(sent[0].message, /submission-ready paper/);
    assert.match(sent[0].message, /sequence of high-value actions/i);
    assert.match(sent[0].message, /Do not end the turn merely/i);
    assert.equal(store.listAutomationEvents(10)
      .find((item) => item.eventType === 'GOAL_CONTINUED').status, 'SENT');

    now = new Date('2026-08-11T00:00:22Z');
    externalSession.heartbeat = {
      historyCursor: 'session.jsonl:100:event-b',
      deliveryMarkers: [sent[0].message.match(/\[FIRM DELIVERY ([^\]]+)\]/)[1]],
    };
    await engine.cycle({ forceQueue: true });
    assert.equal(sent.length, 1, 'the same external prompt must not be injected twice');
    assert.equal(store.listAutomationEvents(10)
      .find((item) => item.eventType === 'GOAL_CONTINUED').status, 'DELIVERED');

    now = new Date('2026-08-11T00:00:40Z');
    externalSession.terminal = { state: 'WAITING_INPUT', tailHash: 'tail-after-assistant' };
    externalSession.heartbeat = {
      historyCursor: 'session.jsonl:200:event-c', deliveryMarkers: [
        sent[0].message.match(/\[FIRM DELIVERY ([^\]]+)\]/)[1],
      ],
      historyEventType: 'assistant',
      latestAssistantAt: '2026-08-11T00:00:30Z',
      lastProgressAt: '2026-08-11T00:00:30Z',
    };
    await engine.cycle({ forceQueue: true });
    assert.equal(sent.length, 1, 'a new stable wait still observes the grace period');
    now = new Date('2026-08-11T00:00:51Z');
    await engine.cycle({ forceQueue: true });
    assert.equal(sent.length, 2, 'a proven completed turn bypasses wall-clock cooldown');
  });
});

test('a Codex-cleared external stop bypasses ordinary cooldown but keeps the goal budget', async () => {
  await fixture(async (store) => {
    store.setAutomationPolicy('ACL_1', {
      enabled: true,
      objective: 'Complete ACL_1 to an honest submission-ready paper.',
    });
    store.createAutomationEvent({
      eventKey: 'goal:prior', category: 'goal_loop', eventType: 'GOAL_CONTINUED',
      targetId: 'ACL_1', severity: 'info', status: 'DELIVERED',
      title: 'Prior continuation', message: 'Prior continuation.',
      deliveredAt: '2026-08-11T00:00:00Z', source: { deliveryPolicy: 'none' },
    });
    const sent = [];
    const externalSession = {
      pid: 12345, projectId: 'ACL_1', tty: '/dev/ttys018',
      terminal: { state: 'WAITING_INPUT', tailHash: 'wait-reviewed' },
      heartbeat: { historyCursor: 'session.jsonl:10:event-a', deliveryMarkers: [] },
    };
    const engine = new AutomationEngine({
      config: config(), store, sessionManager: new FakeSessions([]),
      queueCollector: async () => ({
        status: 'ok', collectedAt: '2026-08-11T00:00:30Z', root: '/queue', items: [],
        invalid: [], counts: { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 },
      }),
      discoverExternalSessions: async () => ({ items: [externalSession] }),
      externalSessionInput: async (session, message) => sent.push({ session, message }),
      now: () => new Date('2026-08-11T00:00:30Z'),
    });

    const result = await engine.continueReviewedStop({
      projectId: 'ACL_1', pid: 12345, previousState: 'WORKING',
      tailHash: 'wait-reviewed',
    }, { verdict: 'PASS' });
    assert.equal(result.status, 'awaiting_history_ack');
    assert.equal(sent.length, 1, 'review clearance should bypass the 60-second test cooldown');
    assert.match(sent[0].message, /USER-APPROVED GOAL LOOP/);
    let event = store.listAutomationEvents(10)
      .find((item) => item.eventKey.includes('goal:reviewed-stop'));
    assert.equal(event.status, 'SENT');
    externalSession.heartbeat = {
      historyCursor: 'session.jsonl:100:event-b',
      deliveryMarkers: [result.messageKey],
    };
    await engine.cycle({ forceQueue: true });
    event = store.listAutomationEvents(10)
      .find((item) => item.eventKey.includes('goal:reviewed-stop'));
    assert.equal(event.status, 'DELIVERED');
    assert.equal(event.note, 'claude_history_acknowledged_delivery');
  });
});

test('a stop review that does not clear the project cannot continue it', async () => {
  await fixture(async (store) => {
    store.setAutomationPolicy('ACL_1', { enabled: true, objective: 'Complete ACL_1.' });
    const sent = [];
    const engine = new AutomationEngine({
      config: config(), store, sessionManager: new FakeSessions([]),
      discoverExternalSessions: async () => ({ items: [{
        pid: 12345, projectId: 'ACL_1', tty: '/dev/ttys018',
        terminal: { state: 'WAITING_INPUT', tailHash: 'wait-intervene' },
      }] }),
      externalSessionInput: async (session, message) => sent.push({ session, message }),
    });
    const result = await engine.continueReviewedStop({
      projectId: 'ACL_1', pid: 12345, previousState: 'WORKING',
      tailHash: 'wait-intervene',
    }, { verdict: 'INTERVENE' });
    assert.equal(result.status, 'review_not_cleared');
    assert.equal(sent.length, 0);
  });
});

test('Goal Loop never answers an interactive confirmation prompt', async () => {
  await fixture(async (store) => {
    store.setAutomationPolicy('ACL_1', { enabled: true, objective: 'Complete ACL_1.' });
    const sessions = new FakeSessions([{
      id: 'research-confirm-1',
      projectId: 'ACL_1',
      projectName: 'ACL 1',
      status: 'WAITING_INPUT',
      bootstrapStatus: 'SENT',
      waitingSince: '2026-08-11T00:00:00Z',
      waitReason: 'interactive_confirmation',
    }]);
    const engine = new AutomationEngine({
      config: config(),
      store,
      sessionManager: sessions,
      queueCollector: async () => ({
        status: 'ok', collectedAt: '2026-08-11T00:02:00Z', root: '/queue', items: [],
        invalid: [], counts: { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 },
      }),
      now: () => new Date('2026-08-11T00:02:00Z'),
    });
    await engine.cycle({ forceQueue: true });
    assert.equal(sessions.inputs.length, 0);
    assert.equal(
      store.listAutomationEvents(10).find((item) => (
        item.eventType === 'GOAL_CONFIRMATION_REQUIRED'
      )).status,
      'PENDING',
    );
  });
});

test('restart never duplicates a sent external message and later history evidence ACKs it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'firm-delivery-restart-'));
  let store;
  try {
    store = await createStore(directory);
    store.createAutomationEvent({
      eventKey: 'gpu:ACL_1_restart:done',
      category: 'gpu_queue',
      eventType: 'GPU_RESULT_READY',
      targetId: 'ACL_1',
      runId: 'ACL_1_restart',
      severity: 'info',
      title: 'GPU result ready',
      message: 'Read it.',
      source: {
        deliveryPolicy: 'auto_notify',
        queueItem: { runId: 'ACL_1_restart', state: 'done', remotePath: '/done' },
      },
    });
    const session = {
      pid: 77, projectId: 'ACL_1', tty: '/dev/ttys077',
      terminal: { state: 'WAITING_INPUT', tailHash: 'tail-restart' },
      heartbeat: { historyCursor: 's.jsonl:10:e1', deliveryMarkers: [] },
    };
    const sent = [];
    const options = {
      config: config(),
      sessionManager: new FakeSessions([]),
      queueCollector: async () => ({
        status: 'ok', collectedAt: '2026-08-11T00:00:00Z', root: '/queue', items: [],
        invalid: [], counts: { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 },
      }),
      discoverExternalSessions: async () => ({ items: [session] }),
      externalSessionInput: async (_session, message) => sent.push(message),
      now: () => new Date('2026-08-11T00:00:00Z'),
    };
    const first = new AutomationEngine({ ...options, store });
    await first.cycle({ forceQueue: true });
    assert.equal(sent.length, 1);
    const marker = sent[0].match(/\[FIRM DELIVERY ([^\]]+)\]/)[1];
    assert.equal(store.getAutomationEvent('gpu:ACL_1_restart:done').status, 'SENT');
    store.close();
    store = null;

    store = await createStore(directory);
    const restarted = new AutomationEngine({ ...options, store });
    await restarted.cycle({ forceQueue: true });
    assert.equal(sent.length, 1, 'a restart must not resend an unacknowledged delivery');
    session.heartbeat = {
      historyCursor: 's.jsonl:100:e2',
      deliveryMarkers: [marker],
    };
    await restarted.cycle({ forceQueue: true });
    assert.equal(store.getAutomationEvent('gpu:ACL_1_restart:done').status, 'DELIVERED');
    assert.equal(store.getOutboxMessage(marker).status, 'ACKED');
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a tracked pasted draft gets Enter-only recovery and blocks all duplicate payloads', async () => {
  await fixture(async (store) => {
    store.createAutomationEvent({
      eventKey: 'gpu:ACL_1_enter_recovery:done',
      category: 'gpu_queue', eventType: 'GPU_RESULT_READY', targetId: 'ACL_1',
      runId: 'ACL_1_enter_recovery', severity: 'info', title: 'Result ready',
      message: 'Read it.', source: {
        deliveryPolicy: 'auto_notify',
        queueItem: { runId: 'ACL_1_enter_recovery', state: 'done', remotePath: '/done' },
      },
    });
    let now = new Date('2026-08-11T00:00:00Z');
    const sent = [];
    const enters = [];
    const session = {
      pid: 88, projectId: 'ACL_1', tty: '/dev/ttys088',
      terminal: { state: 'WAITING_INPUT', tailHash: 'blank-a' },
      heartbeat: { historyCursor: 's.jsonl:10:e1', deliveryMarkers: [] },
    };
    const engine = new AutomationEngine({
      config: { ...config(), goalLoop: { ...config().goalLoop, enterRetryMs: 2_000 } },
      store, sessionManager: new FakeSessions([]),
      queueCollector: async () => ({
        status: 'ok', collectedAt: now.toISOString(), root: '/queue', items: [], invalid: [],
        counts: { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 },
      }),
      discoverExternalSessions: async () => ({ items: [session] }),
      externalSessionInput: async (_session, message) => sent.push(message),
      externalSessionSubmit: async (target) => enters.push(target.tty),
      now: () => now,
    });
    await engine.cycle({ forceQueue: true });
    assert.equal(sent.length, 1);
    const marker = sent[0].match(/\[FIRM DELIVERY ([^\]]+)\]/)[1];

    session.terminal = {
      state: 'DRAFT_PENDING_ENTER', tailHash: 'draft-a', draftDeliveryMarker: marker,
    };
    now = new Date('2026-08-11T00:00:03Z');
    const manual = await engine.continueExternalSession(session, 'do not duplicate');
    assert.equal(manual.status, 'session_not_waiting');
    await engine.cycle({ forceQueue: true });
    assert.equal(sent.length, 1, 'recovery must never paste a second payload');
    assert.deepEqual(enters, ['/dev/ttys088']);
    assert.equal(store.getOutboxMessage(marker).enterAttempts, 1);

    session.terminal = { state: 'WORKING', tailHash: 'working-a' };
    session.heartbeat = { historyCursor: 's.jsonl:100:e2', deliveryMarkers: [marker] };
    now = new Date('2026-08-11T00:00:04Z');
    await engine.cycle({ forceQueue: true });
    assert.equal(store.getOutboxMessage(marker).status, 'ACKED');
    assert.equal(store.getAutomationEvent('gpu:ACL_1_enter_recovery:done').status, 'DELIVERED');
  });
});

test('manual continuation is rejected while the same project has an unacknowledged delivery', async () => {
  await fixture(async (store) => {
    const priorEvent = store.createAutomationEvent({
      eventKey: 'goal:prior-unacked', category: 'goal_loop', eventType: 'GOAL_CONTINUED',
      targetId: 'ACL_1', severity: 'info', title: 'Prior', message: 'Prior', source: {},
    });
    const prior = store.createOutboxMessage({
      messageKey: 'firm-prior', targetId: 'ACL_1', category: 'goal_loop',
      automationEventId: priorEvent.id, sessionPid: 99, tty: '/dev/ttys099',
      payloadText: '[FIRM DELIVERY firm-prior]\ncontinue', payloadHash: 'b'.repeat(64),
    });
    store.claimOutboxMessage(prior.id, '2026-08-11T00:00:00Z');
    store.markOutboxSent(prior.id, '2026-08-11T00:00:00Z');
    const sent = [];
    const engine = new AutomationEngine({
      config: config(), store, sessionManager: new FakeSessions([]),
      externalSessionInput: async (_session, message) => sent.push(message),
    });
    const result = await engine.continueExternalSession({
      pid: 99, projectId: 'ACL_1', tty: '/dev/ttys099',
      terminal: { state: 'WAITING_INPUT', tailHash: 'blank' },
      heartbeat: { historyCursor: 's:1' },
    }, 'second message');
    assert.equal(result.status, 'blocked_by_pending_delivery');
    assert.equal(result.messageKey, 'firm-prior');
    assert.equal(sent.length, 0);
  });
});

test('an ACK without assistant progress gets one bounded recovery and then hard-stops', async () => {
  await fixture(async (store) => {
    store.setAutomationPolicy('ACL_1', { enabled: true, objective: 'Finish ACL_1.' });
    let now = new Date('2026-08-11T00:00:00Z');
    const sent = [];
    const session = {
      pid: 101, projectId: 'ACL_1', tty: '/dev/ttys101',
      terminal: { state: 'WAITING_INPUT', tailHash: 'wait-0' },
      heartbeat: { historyCursor: 's:0', deliveryMarkers: [], latestAssistantAt: null },
    };
    const engine = new AutomationEngine({
      config: {
        ...config(),
        goalLoop: { ...config().goalLoop, postAckStallMs: 60_000 },
      },
      store, sessionManager: new FakeSessions([]),
      discoverExternalSessions: async () => ({ items: [session] }),
      externalSessionInput: async (_session, message) => sent.push(message),
      now: () => now,
    });
    await engine.cycle();
    now = new Date('2026-08-11T00:00:11Z');
    await engine.cycle();
    assert.equal(sent.length, 1);
    const firstMarker = sent[0].match(/\[FIRM DELIVERY ([^\]]+)\]/)[1];
    session.heartbeat = {
      historyCursor: 's:1', deliveryMarkers: [firstMarker], latestAssistantAt: null,
    };
    session.terminal = { state: 'WAITING_INPUT', tailHash: 'wait-1' };
    now = new Date('2026-08-11T00:01:12Z');
    await engine.cycle();
    assert.equal(sent.length, 1);
    assert.equal(store.listAutomationEvents(100).filter((item) => (
      item.eventType === 'SESSION_ACCEPTED_INPUT_STALLED'
    )).length, 1);
    now = new Date('2026-08-11T00:01:23Z');
    await engine.cycle();
    assert.equal(sent.length, 2, 'exactly one recovery continuation is allowed');

    const secondMarker = sent[1].match(/\[FIRM DELIVERY ([^\]]+)\]/)[1];
    session.heartbeat = {
      historyCursor: 's:2', deliveryMarkers: [firstMarker, secondMarker], latestAssistantAt: null,
    };
    session.terminal = { state: 'WAITING_INPUT', tailHash: 'wait-2' };
    now = new Date('2026-08-11T00:02:24Z');
    await engine.cycle();
    assert.equal(sent.length, 2);
    const stalls = store.listAutomationEvents(100).filter((item) => (
      item.eventType === 'SESSION_ACCEPTED_INPUT_STALLED'
    ));
    assert.equal(stalls.length, 2);
    assert.equal(stalls.some((item) => item.severity === 'error'), true);
  });
});

test('a verified GPU wait suppresses stop review and Goal Loop until the result is terminal', async () => {
  await fixture(async (store) => {
    store.setAutomationPolicy('ACL_1', { enabled: true, objective: 'Finish ACL_1.' });
    let now = new Date('2026-08-11T00:00:00Z');
    let queueState = 'running';
    const sent = [];
    const stopped = [];
    const session = {
      pid: 102, projectId: 'ACL_1', tty: '/dev/ttys102',
      terminal: { state: 'WAITING_INPUT', tailHash: 'gpu-wait-tail' },
      heartbeat: {
        historyCursor: 's:gpu-wait', deliveryMarkers: [],
        waitingForGpuRunIds: ['ACL_1_train_1'],
      },
    };
    const queueCollector = async () => ({
      status: 'ok', collectedAt: now.toISOString(), root: '/queue', invalid: [],
      counts: {
        pending: queueState === 'pending' ? 1 : 0,
        running: queueState === 'running' ? 1 : 0,
        done: queueState === 'done' ? 1 : 0,
        failed: 0, cancelled: 0,
      },
      items: [{
        runId: 'ACL_1_train_1', project: 'ACL_1', state: queueState,
        remotePath: `/queue/${queueState}/ACL_1_train_1`,
      }],
    });
    const engine = new AutomationEngine({
      config: config(), store, sessionManager: new FakeSessions([]), queueCollector,
      discoverExternalSessions: async () => ({ items: [session] }),
      externalSessionInput: async (_session, message) => sent.push(message),
      onExternalSessionStopped: async (stop) => stopped.push(stop),
      now: () => now,
    });
    await engine.cycle({ forceQueue: true });
    now = new Date('2026-08-11T00:00:20Z');
    await engine.cycle({ forceQueue: true });
    assert.equal(sent.length, 0);
    assert.equal(stopped.length, 0);
    assert.equal(store.listAutomationEvents(100).some((item) => (
      item.eventType === 'GPU_WAIT_ACCEPTED'
    )), true);

    queueState = 'done';
    now = new Date('2026-08-11T00:00:21Z');
    await engine.cycle({ forceQueue: true });
    assert.equal(sent.length, 1, 'terminal GPU result should wake the waiting project');
    assert.match(sent[0], /GPU RESULT/);
  });
});
