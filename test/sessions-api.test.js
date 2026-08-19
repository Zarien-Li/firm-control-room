import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server.js';
import { SessionManager } from '../src/session-manager.js';
import { createStore } from '../src/store.js';
import { FakePty } from './fake-pty.js';

test('portfolio review progress is persisted and exposed for project cards', async () => {
  const root = await mkdtemp(join(tmpdir(), 'firm-project-progress-'));
  const project = { id: 'P', name: 'P', path: root, expected: {} };
  const manager = new SessionManager({
    projects: [project], executable: '/fixed/claude', controlDir: join(root, 'control'),
    pty: new FakePty(),
  });
  const app = await createApp({
    dataDir: join(root, 'data'), projects: [project], codexAuditEnabled: false,
    gpuQueue: { enabled: false, pollMs: 1000, schedulerAutoStart: false },
    sessionManager: manager,
  });
  try {
    const address = await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${address.port}`;
    const saved = await fetch(`${base}/api/project-progress/P`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        stage: 'construction-v1',
        summary: 'v1 is training against the nearest rival; utility check is pending.',
        reviewedAt: '2026-08-12T00:00:00Z',
        source: 'five-hour-portfolio-review',
      }),
    });
    assert.equal(saved.status, 200);
    const list = await fetch(`${base}/api/project-progress`).then((response) => response.json());
    assert.equal(list.length, 1);
    assert.equal(list[0].targetId, 'P');
    assert.equal(list[0].stage, 'construction-v1');
    assert.match(list[0].summary, /nearest rival/);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a newly stopped external project does not turn liveness into scientific review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'firm-stop-review-'));
  const project = { id: 'P', name: 'P', path: root, expected: {} };
  const manager = new SessionManager({
    projects: [project], executable: '/fixed/claude', controlDir: join(root, 'control'),
    pty: new FakePty(),
  });
  const external = {
    pid: 42, projectId: 'P', mappingStatus: 'mapped', tty: 'ttys019',
    terminal: {
      state: 'WAITING_INPUT', reason: 'claude_input_prompt_visible', tailHash: 'wait-a',
    },
  };
  const app = await createApp({
    dataDir: join(root, 'data'),
    projects: [project],
    scanIntervalMs: 2.5 * 60 * 60 * 1000,
    codexAuditEnabled: false,
    gpuQueue: { enabled: false, pollMs: 1000, schedulerAutoStart: false },
    watchdog: { pollMs: 15_000, waitingMs: 60_000, stopReviewStableMs: 0 },
    sessionManager: manager,
    externalSessionsCollector: async () => ({
      status: 'ok', terminalStatus: 'ok', items: [external],
    }),
  });
  try {
    await app.automationEngine.cycle({ forceQueue: true });
    const events = app.store.listAutomationEvents(10)
      .filter((item) => item.eventType === 'STOP_REVIEW_QUEUED');
    assert.equal(events.length, 0);
    await app.automationEngine.cycle({ forceQueue: true });
    assert.equal(
      app.store.listAutomationEvents(10)
        .filter((item) => item.eventType === 'STOP_REVIEW_QUEUED').length,
      0,
    );
  } finally {
    await app.close();
    const evidenceRoot = join(root, 'data', 'evidence');
    const evidenceDirectories = await readdir(evidenceRoot).catch(() => []);
    for (const name of evidenceDirectories) {
      await chmod(join(evidenceRoot, name), 0o755);
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('a restart resolves a legacy stop review instead of reviving obsolete policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'firm-stop-review-restart-'));
  const project = { id: 'P', name: 'P', path: root, expected: {} };
  let seedStore = await createStore(join(root, 'data'));
  seedStore.createAutomationEvent({
    eventKey: 'stop-review:P:42:wait-restart',
    category: 'professor_review', eventType: 'STOP_REVIEW_QUEUED',
    targetId: 'P', severity: 'info', title: 'Interrupted review',
    message: 'The process stopped before the review completed.',
    source: {
      deliveryPolicy: 'none',
      stop: {
        projectId: 'P', pid: 42, tty: 'ttys019', previousState: 'WORKING',
        detectedAt: '2026-08-11T00:00:00Z', tailHash: 'wait-restart',
      },
    },
  });
  seedStore.close();
  seedStore = null;
  const manager = new SessionManager({
    projects: [project], executable: '/fixed/claude', controlDir: join(root, 'control'),
    pty: new FakePty(),
  });
  const app = await createApp({
    dataDir: join(root, 'data'), projects: [project], scanIntervalMs: 0,
    codexAuditEnabled: false,
    gpuQueue: { enabled: false, pollMs: 1000, schedulerAutoStart: false },
    sessionManager: manager,
  });
  try {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const event = app.store.getAutomationEvent('stop-review:P:42:wait-restart');
      if (event?.status === 'RESOLVED') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const event = app.store.getAutomationEvent('stop-review:P:42:wait-restart');
    assert.equal(event.status, 'RESOLVED');
    assert.equal(event.note, 'normal_prompt_review_policy_disabled');
  } finally {
    await app.close();
    const evidenceRoot = join(root, 'data', 'evidence');
    const evidenceDirectories = await readdir(evidenceRoot).catch(() => []);
    for (const name of evidenceDirectories) {
      await chmod(join(evidenceRoot, name), 0o755);
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('managed session API validates JSON and exposes the PTY lifecycle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'firm-session-api-'));
  const project = { id: 'ACL_1', name: 'ACL_1', path: join(root, 'ACL_1'), expected: {} };
  const pty = new FakePty();
  const manager = new SessionManager({
    projects: [project],
    executable: '/fixed/claude',
    controlDir: join(root, 'control'),
    pty,
    idFactory: () => 'api-session',
  });
  const app = await createApp({
    dataDir: join(root, 'data'),
    projects: [project],
    scanIntervalMs: 0,
    sessionManager: manager,
  });
  try {
    const address = await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${address.port}`;
    const post = (path, body, headers = { 'content-type': 'application/json' }) => fetch(
      `${base}${path}`,
      { method: 'POST', headers, body },
    );

    let response = await post('/api/sessions', '{');
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'invalid_json');

    response = await post('/api/sessions', JSON.stringify({ projectId: 'ACL_1', command: 'sh' }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'unknown_field');

    response = await post('/api/sessions', JSON.stringify({
      projectId: 'ACL_1',
      cols: 80,
      rows: 25,
      bootstrap: false,
    }));
    assert.equal(response.status, 201);
    const created = await response.json();
    assert.equal(created.id, 'api-session');
    assert.equal(created.backend, 'fake-pty');
    assert.deepEqual(created.capabilities, { resize: true });
    assert.equal(pty.calls[0].executable, '/fixed/claude');
    assert.deepEqual(pty.calls[0].args, []);

    pty.terminals[0].emitData('hello');
    response = await fetch(`${base}/api/sessions/api-session/output?cursor=0`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data, 'hello');

    response = await post('/api/sessions/api-session/input', JSON.stringify({ data: 'manual\n' }));
    assert.equal(response.status, 200);
    assert.deepEqual(pty.terminals[0].writes, ['manual\n']);

    response = await post('/api/sessions/api-session/resize', JSON.stringify({ cols: 99, rows: 31 }));
    assert.equal(response.status, 200);
    assert.deepEqual(pty.terminals[0].resizes, [{ cols: 99, rows: 31 }]);

    response = await post('/api/sessions/api-session/stop', '{}');
    assert.equal(response.status, 202);
    response = await fetch(`${base}/api/sessions`);
    const sessions = await response.json();
    assert.equal(sessions[0].status, 'EXITED');
    assert.equal(sessions[0].exitCode, 143);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('managed session API uses stable not-found and media-type error codes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'firm-session-api-errors-'));
  const project = { id: 'P', name: 'P', path: root, expected: {} };
  const manager = new SessionManager({
    projects: [project],
    executable: '/fixed/claude',
    controlDir: join(root, 'control'),
    pty: new FakePty(),
  });
  const app = await createApp({
    dataDir: join(root, 'data'),
    projects: [project],
    scanIntervalMs: 0,
    sessionManager: manager,
  });
  try {
    const address = await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${address.port}`;
    let response = await fetch(`${base}/api/sessions/missing/output`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'session_not_found');
    response = await fetch(`${base}/api/sessions`, { method: 'POST', body: '{}' });
    assert.equal(response.status, 415);
    assert.equal((await response.json()).error.code, 'unsupported_media_type');
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('managed session API exposes unsupported backend capabilities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'firm-session-api-capability-'));
  const project = { id: 'P', name: 'P', path: root, expected: {} };
  const manager = new SessionManager({
    projects: [project],
    executable: '/fixed/claude',
    controlDir: join(root, 'control'),
    pty: new FakePty({ name: 'macos-script', resize: false }),
  });
  const app = await createApp({
    dataDir: join(root, 'data'),
    projects: [project],
    scanIntervalMs: 0,
    sessionManager: manager,
  });
  try {
    const address = await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${address.port}`;
    let response = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'P', cols: 80, rows: 24, bootstrap: false }),
    });
    const session = await response.json();
    assert.equal(session.backend, 'macos-script');
    assert.deepEqual(session.capabilities, { resize: false });

    response = await fetch(`${base}/api/sessions/${session.id}/resize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cols: 100, rows: 40 }),
    });
    assert.equal(response.status, 501);
    assert.equal((await response.json()).error.code, 'unsupported_capability');
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
