import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ContinuitySupervisor } from '../src/continuity-supervisor.js';
import { createStore } from '../src/store.js';

function config(path) {
  return {
    projects: [{ id: 'P', name: 'P', path }],
    continuity: { enabled: true, settleMs: 0, retryMs: 10_000, maxConcurrent: 2 },
  };
}

function waitingSession(overrides = {}) {
  const { heartbeat = {}, terminal = {}, ...rest } = overrides;
  return {
    pid: 42, projectId: 'P', tty: '/dev/ttys042',
    terminal: { state: 'WAITING_INPUT', tailHash: 'tail-a', ...terminal },
    heartbeat: {
      episodeId: 'episode-a', historyCursor: 'history:1',
      latestAssistantAt: '2026-08-11T00:00:00Z',
      latestAssistantText: 'The previous step is complete.',
      waitingForJobRunIds: [], activeToolProcessCount: 0,
      ...heartbeat,
    },
    ...rest,
  };
}

async function fixture(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'firm-continuity-test-'));
  const store = await createStore(directory);
  try {
    await fn(store, directory);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('stable idle episode gets exactly one AI decision and one durable resume event', async () => {
  await fixture(async (store, directory) => {
    let calls = 0;
    const supervisor = new ContinuitySupervisor({
      config: config(directory), store,
      resolver: { resolve: async () => {
        calls += 1;
        return { action: 'continue', message: 'Continue the current research episode.', reason: 'incomplete', optionNumber: null };
      } },
      now: () => new Date('2026-08-11T00:01:00Z'),
    });
    const packet = {
      sessions: [waitingSession()], jobs: { items: [] }, events: [], outbox: [],
      schedulerMonitor: { status: 'healthy' },
    };
    supervisor.observe(packet);
    await supervisor.idle();
    supervisor.observe(packet);
    await supervisor.idle();
    assert.equal(calls, 1);
    const event = store.listAutomationEvents(20)
      .find((item) => item.eventType === 'CONTINUITY_RESUME_READY');
    assert.equal(event.status, 'PENDING');
    assert.equal(event.source.deliveryPolicy, 'auto_notify');
    assert.equal(event.message, 'Continue the current research episode.');
  });
});

test('an exact active registered-job wait remains silent and never calls AI', async () => {
  await fixture(async (store, directory) => {
    let calls = 0;
    const supervisor = new ContinuitySupervisor({
      config: config(directory), store,
      resolver: { resolve: async () => { calls += 1; } },
      now: () => new Date('2026-08-11T00:01:00Z'),
    });
    supervisor.observe({
      sessions: [waitingSession({ heartbeat: { waitingForJobRunIds: ['P_train'] } })],
      jobs: { items: [{ runId: 'P_train', projectId: 'P', state: 'running' }] },
      events: [], outbox: [], schedulerMonitor: { status: 'healthy' },
    });
    await supervisor.idle();
    assert.equal(calls, 0);
    assert.equal(store.listAutomationEvents(20).length, 0);
  });
});

test('a stopped construction lease is resumed without opening a new route', async () => {
  await fixture(async (store, directory) => {
    let received = null;
    const supervisor = new ContinuitySupervisor({
      config: config(directory), store,
      resolver: { resolve: async (input) => {
        received = input;
        return { action: 'continue', message: 'Resume the current lease.', reason: 'lease incomplete', optionNumber: null };
      } },
      now: () => new Date('2026-08-11T00:01:00Z'),
    });
    supervisor.observe({
      sessions: [waitingSession({
        heartbeat: { constructionLease: { id: 'v1', active: true }, activeToolProcessCount: 0 },
      })],
      jobs: { items: [] }, events: [], outbox: [], schedulerMonitor: {},
    });
    await supervisor.idle();
    assert.equal(received.operationalState, 'CONSTRUCTION_ACTIVE');
    assert.equal(store.listAutomationEvents(20)
      .some((item) => item.eventType === 'CONTINUITY_RESUME_READY'), true);
  });
});

test('an ordinary choice is decided once and emitted as a bound choice action', async () => {
  await fixture(async (store, directory) => {
    let calls = 0;
    const supervisor = new ContinuitySupervisor({
      config: config(directory), store,
      resolver: { resolve: async () => {
        calls += 1;
        return { action: 'choose', message: '', reason: 'option two preserves the current route', optionNumber: 2 };
      } },
      now: () => new Date('2026-08-11T00:01:00Z'),
    });
    const packet = {
      sessions: [waitingSession({
        terminal: { state: 'ROUTINE_CHOICE', selectedOptionNumber: 1 },
      })],
      jobs: { items: [] }, events: [], outbox: [], schedulerMonitor: {},
    };
    supervisor.observe(packet);
    await supervisor.idle();
    supervisor.observe(packet);
    await supervisor.idle();
    assert.equal(calls, 1);
    const event = store.listAutomationEvents(20)
      .find((item) => item.eventType === 'CONTINUITY_CHOICE_READY');
    assert.equal(event.status, 'PENDING');
    assert.equal(event.source.pid, 42);
    assert.equal(event.source.episode, 'episode-a');
    assert.equal(event.source.selectedOptionNumber, 1);
    assert.equal(event.source.optionNumber, 2);
  });
});
