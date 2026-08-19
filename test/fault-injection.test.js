import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AutomationEngine } from '../src/automation-engine.js';
import { createStore } from '../src/store.js';

test('delayed ACK and noisy terminal transitions never duplicate an external command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'firm-fault-injection-'));
  const store = await createStore(directory);
  try {
    store.createAutomationEvent({
      eventKey: 'gpu:P:fault:done', category: 'gpu_queue', eventType: 'GPU_RESULT_READY',
      targetId: 'P', severity: 'info', title: 'Result', message: 'Read result.',
      source: {
        deliveryPolicy: 'auto_notify',
        queueItem: { runId: 'P_fault', state: 'done', remotePath: '/done/P_fault' },
      },
    });
    const session = {
      pid: 99, projectId: 'P', tty: '/dev/ttys099',
      terminal: { state: 'WAITING_INPUT', tailHash: 'wait-a' },
      heartbeat: {
        status: 'ok', episodeId: 'episode-a', historyCursor: 's.jsonl:10:e1',
        deliveryMarkers: [], lastProgressAt: '2026-08-11T00:00:00Z',
      },
    };
    let now = new Date('2026-08-11T00:00:00Z');
    const sent = [];
    const engine = new AutomationEngine({
      config: {
        projects: [{ id: 'P' }],
        gpuQueue: { enabled: false, pollMs: 1000, schedulerAutoStart: false },
        watchdog: {
          waitingMs: 60_000, stopReviewStableMs: 10_000,
          unknownStallMs: 1_000_000, progressStallMs: 1_000_000,
        },
      },
      store,
      sessionManager: { list: async () => [] },
      discoverExternalSessions: async () => ({ status: 'ok', terminalStatus: 'ok', items: [session] }),
      externalSessionInput: async (_session, message) => sent.push(message),
      now: () => now,
    });
    await engine.cycle({ forceQueue: true });
    assert.equal(sent.length, 1);
    const marker = sent[0].match(/\[FIRM DELIVERY ([^\]]+)\]/)[1];

    for (let index = 0; index < 40; index += 1) {
      now = new Date(now.getTime() + 1000);
      session.terminal = index % 2
        ? { state: 'WORKING', tailHash: `spinner-${index}` }
        : { state: 'UNKNOWN', tailHash: `spinner-${index}` };
      await engine.cycle({ forceQueue: true });
    }
    assert.equal(sent.length, 1, 'terminal noise before ACK must not cause another send');

    session.heartbeat = {
      ...session.heartbeat,
      historyCursor: 's.jsonl:100:e2',
      deliveryMarkers: [marker],
    };
    session.terminal = { state: 'WAITING_INPUT', tailHash: 'wait-b' };
    await engine.cycle({ forceQueue: true });
    assert.equal(store.getAutomationEvent('gpu:P:fault:done').status, 'DELIVERED');
    assert.equal(store.getOutboxMessage(marker).status, 'ACKED');
    assert.equal(sent.length, 1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
