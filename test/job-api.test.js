import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server.js';
import { SessionManager } from '../src/session-manager.js';
import { FakePty } from './fake-pty.js';

test('jobs API defaults to active plus recent and exposes cursor history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'firm-job-api-'));
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
    const create = (runId, state) => fetch(`${base}/api/jobs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId, projectId: 'P', kind: 'local_cpu', state }),
    });
    await create('active', 'pending');
    for (let index = 0; index < 30; index += 1) await create(`done-${index}`, 'done');
    const first = await fetch(`${base}/api/jobs?limit=7`).then((response) => response.json());
    assert.equal(first.items.some((job) => job.runId === 'active'), true);
    assert.equal(first.items.filter((job) => job.state === 'done').length, 7);
    const second = await fetch(`${base}/api/jobs?view=history&limit=7&cursor=${encodeURIComponent(first.page.nextCursor)}`)
      .then((response) => response.json());
    assert.equal(second.page.activeIncluded, false);
    assert.equal(second.items.length, 7);
    assert.equal(second.items.some((job) => job.runId === 'active'), false);
    const removedLegacyApi = await fetch(`${base}/api/gpu-queue`);
    assert.equal(removedLegacyApi.status, 404);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
