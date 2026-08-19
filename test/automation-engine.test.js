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

test('a not-ready GPU request notifies the project once while ready pending is silent', async () => {
  await fixture(async (store) => {
    const sent = [];
    const session = {
      pid: 101, projectId: 'ACL_1', tty: '/dev/ttys018',
      terminal: { state: 'WAITING_INPUT', tailHash: 'ready' },
      heartbeat: { historyCursor: 's:1:a', deliveryMarkers: [] },
    };
    const engine = new AutomationEngine({
      config: config(), store, sessionManager: new FakeSessions([]),
      discoverExternalSessions: async () => ({ items: [session] }),
      externalSessionInput: async (_session, message) => sent.push(message),
      queueCollector: async () => ({
        status: 'ok', collectedAt: '2026-08-11T00:01:00Z', root: '/queue', invalid: [],
        counts: { pending: 1, running: 0, done: 0, failed: 0, cancelled: 0 },
        items: [{
          runId: 'ACL_1_bad_request', project: 'ACL_1', state: 'pending',
          remotePath: '/queue/pending/ACL_1_bad_request',
          submissionReadiness: { state: 'NOT_READY', missing: ['prepared_artifacts'] },
        }],
      }),
    });
    await engine.cycle({ forceQueue: true });
    assert.equal(sent.length, 1);
    assert.match(sent[0], /"eventType":"GPU_PREPARATION_REQUIRED"/);
    assert.match(sent[0], /prepared_artifacts/);
  });
});

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
    assert.match(sessions.inputs[0].data, /"eventType":"GPU_REQUEST_SUBMITTED"/);
    assert.equal(store.listAutomationEvents(10)
      .find((event) => event.eventType === 'GPU_REQUEST_SUBMITTED').status, 'DELIVERED');
    await engine.cycle({ forceQueue: true });
    assert.equal(sessions.inputs.length, 1);
  });
});

test('operational GPU events queue into an already running managed scheduler', async () => {
  await fixture(async (store) => {
    const sessions = new FakeSessions([{
      id: 'scheduler-running', projectId: 'GPU_SCHEDULER', projectName: 'GPU Scheduler',
      status: 'RUNNING', bootstrapStatus: 'SENT',
    }]);
    const engine = new AutomationEngine({
      config: config(), store, sessionManager: sessions,
      queueCollector: async () => ({
        status: 'ok', collectedAt: '2026-08-11T00:01:00Z', root: '/queue', invalid: [],
        counts: { pending: 1, running: 0, done: 0, failed: 0, cancelled: 0 },
        items: [{
          runId: 'ACL_1_running_scheduler', state: 'pending', signal: '.submitted',
          remotePath: '/queue/pending/ACL_1_running_scheduler',
        }],
      }),
    });
    await engine.cycle({ forceQueue: true });
    assert.equal(sessions.inputs.length, 1);
    assert.match(sessions.inputs[0].data, /ACL_1_running_scheduler/);
  });
});

test('persistent GPU Scheduler control is restored even without a new queue event', async () => {
  await fixture(async (store) => {
    const sessions = new FakeSessions([]);
    const base = config();
    const engine = new AutomationEngine({
      config: { ...base, controlTargets: [{ id: 'GPU_SCHEDULER' }] },
      store,
      sessionManager: sessions,
      queueCollector: async () => ({
        status: 'ok', collectedAt: '2026-08-11T00:00:00Z', root: '/queue', items: [],
        invalid: [], counts: { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 },
      }),
      discoverExternalSessions: async () => ({ items: [] }),
      now: () => new Date('2026-08-11T00:00:00Z'),
    });

    await engine.cycle({ forceQueue: true });
    await engine.cycle({ forceQueue: true });
    assert.deepEqual(sessions.starts, ['GPU_SCHEDULER']);
    assert.equal(store.listAutomationEvents(20).some((item) => (
      item.eventType === 'CONTROL_SESSION_RESTORED'
    )), true);
  });
});

test('a newer healthy managed session resolves stale target-level unhealthy events', async () => {
  await fixture(async (store) => {
    const failed = {
      id: 'scheduler-old', projectId: 'GPU_SCHEDULER', projectName: 'GPU Scheduler',
      status: 'LOST', createdAt: '2026-08-10T00:00:00.000Z',
    };
    const healthy = {
      id: 'scheduler-new', projectId: 'GPU_SCHEDULER', projectName: 'GPU Scheduler',
      status: 'RUNNING', createdAt: '2026-08-11T00:00:00.000Z',
    };
    store.createAutomationEvent({
      eventKey: 'session:scheduler-old:unhealthy:LOST',
      category: 'session_watchdog', eventType: 'SESSION_UNHEALTHY',
      targetId: 'GPU_SCHEDULER', severity: 'error', title: 'Old scheduler lost',
      message: 'Old scheduler failed.', source: { deliveryPolicy: 'manual', session: failed },
    });
    const engine = new AutomationEngine({
      config: config(), store,
      sessionManager: new FakeSessions([failed, healthy]),
      discoverExternalSessions: async () => ({ items: [] }),
    });

    await engine.cycle();

    const event = store.getAutomationEvent('session:scheduler-old:unhealthy:LOST');
    assert.equal(event.status, 'RESOLVED');
    assert.equal(event.sessionId, healthy.id);
    assert.equal(event.note, 'superseded_by_newer_healthy_managed_session');
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
    assert.match(sessions.inputs[0].data, /"eventType":"GPU_SCHEDULER_MONITOR_MISSING"/);
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
    assert.match(sessions.inputs[0].data, /"eventType":"GPU_EFFICIENCY_ALERT"/);
    assert.match(sessions.inputs[0].data, /"averageUtilizationPct":3/);
    assert.equal(sessions.starts.length, 0);
  });
});

test('observed GPU transition remains in inbox when no project session is waiting', async () => {
  await fixture(async (store) => {
    const sessions = new FakeSessions([]);
    let state = 'running';
    const queueCollector = async () => ({
      status: 'ok',
      collectedAt: '2026-08-11T00:01:00Z',
      root: '/queue',
      counts: { pending: 0, running: state === 'running' ? 1 : 0, done: state === 'done' ? 1 : 0, failed: 0, cancelled: 0 },
      invalid: [],
      items: [{
        runId: 'ACL_4_eval_20260811_000000',
        project: 'ACL_4',
        state,
        signal: '.ready',
        remotePath: '/queue/done/ACL_4_eval_20260811_000000',
      }],
    });
    const engine = new AutomationEngine({
      config: config(), store, sessionManager: sessions, queueCollector,
    });
    await engine.cycle({ forceQueue: true });
    state = 'done';
    await engine.cycle({ forceQueue: true });
    const event = store.listAutomationEvents(10)[0];
    assert.equal(event.targetId, 'ACL_4');
    assert.equal(event.status, 'HELD');
    assert.equal(event.note, 'no_waiting_managed_session');
    assert.equal(sessions.starts.length, 0);
  });
});

test('cancelled GPU requests stay silent to research sessions', async () => {
  await fixture(async (store) => {
    const sent = [];
    const session = {
      pid: 112, projectId: 'ACL_1', tty: '/dev/ttys112',
      terminal: { state: 'WAITING_INPUT', tailHash: 'cancelled' },
      heartbeat: { historyCursor: 's:1', deliveryMarkers: [] },
    };
    const engine = new AutomationEngine({
      config: config(), store, sessionManager: new FakeSessions([]),
      discoverExternalSessions: async () => ({ items: [session] }),
      externalSessionInput: async (_session, message) => sent.push(message),
      queueCollector: async () => ({
        status: 'ok', collectedAt: '2026-08-11T00:01:00Z', root: '/queue', invalid: [],
        counts: { pending: 0, running: 0, done: 0, failed: 0, cancelled: 1 },
        items: [{
          runId: 'ACL_1_cancelled', project: 'ACL_1', state: 'cancelled',
          remotePath: '/queue/cancelled/ACL_1_cancelled',
        }],
      }),
    });
    await engine.cycle({ forceQueue: true });
    assert.equal(sent.length, 0);
    assert.equal(store.listAutomationEvents(20).some((item) => (
      item.targetId === 'ACL_1' && item.eventType === 'GPU_RESULT_READY'
    )), false);
  });
});

test('a historical terminal GPU import cannot replay a project notification', async () => {
  await fixture(async (store) => {
    const sent = [];
    const engine = new AutomationEngine({
      config: config(), store, sessionManager: new FakeSessions([]),
      discoverExternalSessions: async () => ({ items: [{
        pid: 113, projectId: 'ACL_1', tty: '/dev/ttys113',
        terminal: { state: 'WAITING_INPUT', tailHash: 'historical' },
        heartbeat: { historyCursor: 's:1', deliveryMarkers: [] },
      }] }),
      externalSessionInput: async (_session, message) => sent.push(message),
      queueCollector: async () => ({
        status: 'ok', collectedAt: '2026-08-11T00:01:00Z', root: '/queue', invalid: [],
        counts: { pending: 0, running: 0, done: 1, failed: 0, cancelled: 0 },
        items: [{
          runId: 'ACL_1_historical_done', project: 'ACL_1', state: 'done',
          remotePath: '/queue/done/ACL_1_historical_done',
        }],
      }),
    });
    await engine.cycle({ forceQueue: true });
    assert.equal(sent.length, 0);
    assert.equal(store.listAutomationEvents(50).some((item) => (
      item.runId === 'ACL_1_historical_done'
      && ['GPU_RESULT_READY', 'JOB_RESULT_READY'].includes(item.eventType)
      && ['PENDING', 'HELD', 'SENT'].includes(item.status)
    )), false);
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
    assert.match(sent[0].message, /"eventType":"GPU_RESULT_READY"/);
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

test('continuity delivery is bound to the original stopped process and episode', async () => {
  await fixture(async (store) => {
    store.createAutomationEvent({
      eventKey: 'continuity:P:42:episode-a:resume',
      category: 'research_continuity', eventType: 'CONTINUITY_RESUME_READY',
      targetId: 'ACL_1', severity: 'info', title: 'Resume',
      message: 'Resume the current episode.',
      source: { deliveryPolicy: 'auto_notify', pid: 42, episode: 'episode-a' },
    });
    const session = {
      pid: 42, projectId: 'ACL_1', tty: '/dev/ttys042',
      terminal: { state: 'WAITING_INPUT', tailHash: 'tail-a' },
      heartbeat: { episodeId: 'episode-a', historyCursor: 'h:1', deliveryMarkers: [] },
    };
    const sent = [];
    const engine = new AutomationEngine({
      config: config(), store, sessionManager: new FakeSessions([]),
      discoverExternalSessions: async () => ({ items: [session] }),
      externalSessionInput: async (_session, message) => sent.push(message),
    });
    await engine.cycle();
    assert.equal(sent.length, 1);
    assert.match(sent[0], /\[FIRM CONTINUITY episode-a\]/);

    store.createAutomationEvent({
      eventKey: 'continuity:P:42:episode-b:resume',
      category: 'research_continuity', eventType: 'CONTINUITY_RESUME_READY',
      targetId: 'ACL_1', severity: 'info', title: 'Stale resume',
      message: 'This must not be sent.',
      source: { deliveryPolicy: 'auto_notify', pid: 42, episode: 'episode-b' },
    });
    session.heartbeat = { episodeId: 'episode-c', historyCursor: 'h:2', deliveryMarkers: [] };
    await engine.cycle();
    assert.equal(sent.length, 1);
    assert.equal(store.getAutomationEvent('continuity:P:42:episode-b:resume').status, 'RESOLVED');
  });
});

test('routine continuity choices are episode-bound and dispatched exactly once', async () => {
  await fixture(async (store) => {
    store.createAutomationEvent({
      eventKey: 'continuity:ACL_1:42:episode-a:choice',
      category: 'research_continuity', eventType: 'CONTINUITY_CHOICE_READY',
      targetId: 'ACL_1', severity: 'info', title: 'Choose', message: 'Choose option 2.',
      source: {
        deliveryPolicy: 'auto_notify', pid: 42, episode: 'episode-a',
        selectedOptionNumber: 1, optionNumber: 2,
      },
    });
    const session = {
      pid: 42, projectId: 'ACL_1', tty: '/dev/ttys042',
      terminal: { state: 'ROUTINE_CHOICE', selectedOptionNumber: 1, tailHash: 'menu-a' },
      heartbeat: { episodeId: 'episode-a', historyCursor: 'h:1', deliveryMarkers: [] },
    };
    const choices = [];
    const engine = new AutomationEngine({
      config: config(), store, sessionManager: new FakeSessions([]),
      discoverExternalSessions: async () => ({ items: [session] }),
      externalSessionChoose: async (_session, current, target) => choices.push({ current, target }),
    });
    await engine.cycle();
    await engine.cycle();
    assert.deepEqual(choices, [{ current: 1, target: 2 }]);
    const event = store.getAutomationEvent('continuity:ACL_1:42:episode-a:choice');
    assert.equal(event.status, 'DELIVERED');
    assert.equal(event.note, 'continuity_choice_submitted:1->2');
  });
});

test('stale routine choices never send terminal key strokes', async () => {
  await fixture(async (store) => {
    store.createAutomationEvent({
      eventKey: 'continuity:ACL_1:42:episode-old:choice',
      category: 'research_continuity', eventType: 'CONTINUITY_CHOICE_READY',
      targetId: 'ACL_1', severity: 'info', title: 'Choose', message: 'Stale choice.',
      source: {
        deliveryPolicy: 'auto_notify', pid: 42, episode: 'episode-old',
        selectedOptionNumber: 1, optionNumber: 2,
      },
    });
    const choices = [];
    const engine = new AutomationEngine({
      config: config(), store, sessionManager: new FakeSessions([]),
      discoverExternalSessions: async () => ({ items: [{
        pid: 42, projectId: 'ACL_1', tty: '/dev/ttys042',
        terminal: { state: 'ROUTINE_CHOICE', selectedOptionNumber: 1 },
        heartbeat: { episodeId: 'episode-new' },
      }] }),
      externalSessionChoose: async (...args) => choices.push(args),
    });
    await engine.cycle();
    assert.equal(choices.length, 0);
    assert.equal(
      store.getAutomationEvent('continuity:ACL_1:42:episode-old:choice').status,
      'RESOLVED',
    );
  });
});

test('an uncertain routine-choice dispatch is recorded once and never replayed', async () => {
  await fixture(async (store) => {
    store.createAutomationEvent({
      eventKey: 'continuity:ACL_1:42:episode-a:choice-failure',
      category: 'research_continuity', eventType: 'CONTINUITY_CHOICE_READY',
      targetId: 'ACL_1', severity: 'info', title: 'Choose', message: 'Choose option 2.',
      source: {
        deliveryPolicy: 'auto_notify', pid: 42, episode: 'episode-a',
        selectedOptionNumber: 1, optionNumber: 2,
      },
    });
    let calls = 0;
    const engine = new AutomationEngine({
      config: config(), store, sessionManager: new FakeSessions([]),
      discoverExternalSessions: async () => ({ items: [{
        pid: 42, projectId: 'ACL_1', tty: '/dev/ttys042',
        terminal: { state: 'ROUTINE_CHOICE', selectedOptionNumber: 1 },
        heartbeat: { episodeId: 'episode-a' },
      }] }),
      externalSessionChoose: async () => { calls += 1; throw new Error('osascript interrupted'); },
    });
    await engine.cycle();
    await engine.cycle();
    assert.equal(calls, 1);
    const event = store.getAutomationEvent('continuity:ACL_1:42:episode-a:choice-failure');
    assert.equal(event.status, 'SENT');
    assert.match(event.note, /dispatch_uncertain/);
    assert.equal(store.listAutomationEvents(20)
      .some((item) => item.eventType === 'CONTINUITY_CHOICE_DISPATCH_UNCERTAIN'), true);
  });
});

test('rate limits remain silent until one Enter-only continuation after reset', async () => {
  await fixture(async (store) => {
    let now = new Date('2026-08-11T00:00:00Z');
    const sent = [];
    const enters = [];
    const externalSession = {
      pid: 12345,
      projectId: 'ACL_1',
      tty: '/dev/ttys018',
      terminal: {
        state: 'RATE_LIMITED',
        resetAt: '2026-08-11T05:00:00.000Z',
        tailHash: 'rate-limit-wait',
      },
      heartbeat: { historyCursor: 'session.jsonl:10:event-a', deliveryMarkers: [] },
    };
    const engine = new AutomationEngine({
      config: config(),
      store,
      sessionManager: new FakeSessions([]),
      discoverExternalSessions: async () => ({ items: [externalSession] }),
      externalSessionInput: async (_session, message) => sent.push(message),
      externalSessionSubmit: async (session) => enters.push(session.tty),
      now: () => now,
    });

    await engine.cycle();
    now = new Date('2026-08-11T04:59:59Z');
    await engine.cycle();
    assert.equal(sent.length, 0);
    assert.deepEqual(enters, []);
    now = new Date('2026-08-11T05:00:01Z');
    await engine.cycle();
    await engine.cycle();
    assert.equal(sent.length, 0, 'rate-limit recovery must never inject text');
    assert.deepEqual(enters, ['/dev/ttys018'], 'the reset permits one keypress only');
    assert.equal(store.listAutomationEvents(100).filter((item) => (
      item.eventType === 'PROVIDER_RATE_RESUME_ENTER'
    )).length, 1);
    assert.equal(store.listAutomationEvents(100).some((item) => (
      item.eventType === 'STOP_REVIEW_QUEUED'
    )), false);
  });
});

test('provider transient bypasses scientific resolution without retry messages or keypresses', async () => {
  await fixture(async (store) => {
    const localConfig = config();
    localConfig.watchdog.stopReviewStableMs = 0;
    const sent = [];
    const enters = [];
    const session = {
      pid: 529, projectId: 'ACL_1', tty: '/dev/ttys529',
      terminal: {
        state: 'PROVIDER_TRANSIENT', tailHash: 'provider-529',
        terminalEvidence: 'API Error: 529 overloaded. Retrying in 30 seconds.',
        retryAfterSeconds: 30,
      },
      heartbeat: {
        historyCursor: 's:529', episodeId: 'provider-529', deliveryMarkers: [],
        latestAssistantText: 'API Error: 529 overloaded. Retrying in 30 seconds.',
      },
    };
    let now = new Date('2026-08-11T00:00:00Z');
    const engine = new AutomationEngine({
      config: localConfig, store, sessionManager: new FakeSessions([]),
      discoverExternalSessions: async () => ({ items: [session] }),
      externalSessionInput: async (_session, message) => sent.push(message),
      externalSessionSubmit: async () => enters.push('enter'),
      now: () => now,
    });
    await engine.cycle();
    now = new Date('2026-08-11T00:00:29Z');
    await engine.cycle();
    assert.equal(sent.length, 0);
    now = new Date('2026-08-11T00:00:31Z');
    await engine.cycle();
    assert.equal(sent.length, 0);
    assert.deepEqual(enters, []);
    assert.equal(store.listAutomationEvents(100).filter((item) => (
      item.eventType === 'PROVIDER_TRANSIENT_WAIT'
    )).length, 1, 'a transient is recorded once, not retried as a conversation');
    assert.equal(store.listAutomationEvents(100).some((item) => (
      item.eventType === 'AI_SESSION_RESOLUTION_WITHHELD'
    )), false);
  });
});

test('a restart cannot replay a rate-limit resume keypress', async () => {
  await fixture(async (store) => {
    const session = {
      pid: 610, projectId: 'ACL_1', tty: '/dev/ttys610',
      terminal: {
        state: 'RATE_LIMITED', resetAt: '2026-08-11T05:00:00.000Z', tailHash: 'rate-a',
      },
      heartbeat: { historyCursor: 's:610', deliveryMarkers: [] },
    };
    const enters = [];
    const options = {
      config: config(), store, sessionManager: new FakeSessions([]),
      discoverExternalSessions: async () => ({ items: [session] }),
      externalSessionInput: async () => { throw new Error('text injection is forbidden'); },
      externalSessionSubmit: async (target) => enters.push(target.tty),
      now: () => new Date('2026-08-11T05:00:01Z'),
    };
    await new AutomationEngine(options).cycle();
    await new AutomationEngine(options).cycle();
    assert.deepEqual(enters, ['/dev/ttys610']);
    const event = store.getAutomationEvent(
      'provider-rate-resume:ACL_1:610:2026-08-11T05:00:00.000Z',
    );
    assert.equal(event.status, 'DELIVERED');
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

test('an acknowledged marker still visible in the editor is cleared, never resubmitted', async () => {
  await fixture(async (store) => {
    const event = store.createAutomationEvent({
      eventKey: 'gpu:ACL_1_already_acked:done', category: 'gpu_queue',
      eventType: 'GPU_RESULT_READY', targetId: 'ACL_1', severity: 'info',
      title: 'Done', message: 'Read it.', source: {},
    });
    let message = store.createOutboxMessage({
      messageKey: 'firm-already-acked', targetId: 'ACL_1', category: 'gpu_queue',
      automationEventId: event.id, sessionPid: 108, tty: '/dev/ttys108',
      payloadText: '[FIRM DELIVERY firm-already-acked]\nread it',
      payloadHash: 'c'.repeat(64), baselineCursor: 's:0',
    });
    store.claimOutboxMessage(message.id, '2026-08-11T00:00:00Z');
    store.markOutboxSent(message.id, '2026-08-11T00:00:01Z');
    store.acknowledgeOutboxMessage(message.id, { at: '2026-08-11T00:00:02Z', cursor: 's:1' });
    const cleared = [];
    const submitted = [];
    const session = {
      pid: 108, projectId: 'ACL_1', tty: '/dev/ttys108',
      terminal: {
        state: 'DRAFT_PENDING_ENTER', tailHash: 'duplicate-draft',
        draftDeliveryMarker: 'firm-already-acked',
      },
      heartbeat: { historyCursor: 's:1', deliveryMarkers: ['firm-already-acked'] },
    };
    const engine = new AutomationEngine({
      config: config(), store, sessionManager: new FakeSessions([]),
      discoverExternalSessions: async () => ({ items: [session] }),
      externalSessionSubmit: async () => submitted.push('enter'),
      externalSessionClear: async (target) => cleared.push(target.tty),
    });
    await engine.cycle();
    assert.deepEqual(cleared, ['/dev/ttys108']);
    assert.deepEqual(submitted, []);
    const eventKey = 'interaction:ACL_1:108:acked-draft:firm-already-acked';
    assert.equal(store.getAutomationEvent(eventKey).eventType, 'ACKED_DELIVERY_DRAFT_CLEARED');
    session.terminal = {
      ...session.terminal, tailHash: 'render-only-change',
    };
    await engine.cycle();
    assert.equal(store.getAutomationEvent(eventKey).status, 'SENT',
      'render changes do not prove that the marker left the editor');
    session.terminal = { state: 'WAITING_INPUT', tailHash: 'blank-after-clear' };
    await engine.cycle();
    assert.equal(store.getAutomationEvent(eventKey).status, 'RESOLVED');
  });
});

test('durable assistant and progress evidence resolves stale watchdog events after restart', async () => {
  await fixture(async (store) => {
    const delivery = store.createAutomationEvent({
      eventKey: 'goal:durable-progress', category: 'goal_loop', eventType: 'GOAL_CONTINUED',
      targetId: 'ACL_1', severity: 'info', title: 'Continue', message: 'Continue', source: {},
    });
    let message = store.createOutboxMessage({
      messageKey: 'firm-durable', targetId: 'ACL_1', category: 'goal_loop',
      automationEventId: delivery.id, sessionPid: 110, tty: '/dev/ttys110',
      payloadText: '[FIRM DELIVERY firm-durable]\ncontinue', payloadHash: 'd'.repeat(64),
      baselineCursor: 's:0',
    });
    store.claimOutboxMessage(message.id, '2026-08-11T00:00:00Z');
    store.markOutboxSent(message.id, '2026-08-11T00:00:01Z');
    store.createAutomationEvent({
      eventKey: 'delivery:firm-durable:accepted_input_stalled',
      category: 'session_watchdog', eventType: 'SESSION_ACCEPTED_INPUT_STALLED',
      targetId: 'ACL_1', severity: 'warn', title: 'Stalled', message: 'Stalled',
      source: { messageKey: 'firm-durable' },
    });
    store.createAutomationEvent({
      eventKey: 'session:ACL_1:110:progress_stall:old',
      category: 'session_watchdog', eventType: 'SESSION_PROGRESS_STALLED',
      targetId: 'ACL_1', severity: 'warn', title: 'Stalled', message: 'Stalled',
      source: { lastProgressAt: '2026-08-11T00:00:00Z' },
    });
    const session = {
      pid: 110, projectId: 'ACL_1', tty: '/dev/ttys110',
      terminal: { state: 'WAITING_INPUT', tailHash: 'new-wait' },
      heartbeat: {
        historyCursor: 's:2', latestAssistantAt: '2026-08-11T00:00:03Z',
        lastProgressAt: '2026-08-11T00:00:03Z', deliveryMarkers: ['firm-durable'],
      },
    };
    const engine = new AutomationEngine({
      config: config(), store, sessionManager: new FakeSessions([]),
      discoverExternalSessions: async () => ({ items: [session] }),
      now: () => new Date('2026-08-11T00:00:04Z'),
    });
    await engine.cycle();
    assert.equal(store.getAutomationEvent(
      'delivery:firm-durable:accepted_input_stalled',
    ).status, 'RESOLVED');
    assert.equal(store.getAutomationEvent(
      'session:ACL_1:110:progress_stall:old',
    ).status, 'RESOLVED');
  });
});

test('registered-job wait bypasses AI resolution and terminal result still wakes Claude', async () => {
  await fixture(async (store) => {
    let now = new Date('2026-08-11T00:00:00Z');
    let queueState = 'running';
    const sent = [];
    const session = {
      pid: 102, projectId: 'ACL_1', tty: '/dev/ttys102',
      terminal: {
        state: 'WAITING_INPUT', tailHash: 'gpu-wait-tail',
        terminalEvidence: 'Waiting for registered run ACL_1_train_1.',
      },
      heartbeat: {
        historyCursor: 's:gpu-wait', episodeId: 'gpu-wait-episode', deliveryMarkers: [],
        latestAssistantText: 'Waiting for registered run ACL_1_train_1.',
        waitingForJobRunIds: ['ACL_1_train_1'],
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
      now: () => now,
    });
    await engine.cycle({ forceQueue: true });
    now = new Date('2026-08-11T00:00:20Z');
    await engine.cycle({ forceQueue: true });
    assert.equal(sent.length, 0);

    queueState = 'done';
    now = new Date('2026-08-11T00:00:21Z');
    await engine.cycle({ forceQueue: true });
    assert.equal(sent.length, 1, 'terminal GPU result should wake the waiting project');
    assert.match(sent[0], /"eventType":"JOB_RESULT_READY"/);
  });
});
