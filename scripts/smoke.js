import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { SessionManager } from '../src/session-manager.js';
import { FakePty } from '../test/fake-pty.js';

const dataDir = await mkdtemp(join(tmpdir(), 'firm-smoke-'));
const projects = Array.from({ length: 5 }, (_, index) => ({
  id: `synthetic-${index + 1}`,
  name: `Synthetic ${index + 1}`,
  path: join(dataDir, `missing-project-${index + 1}`),
  expected: { branch: 'main', maxDirtyFiles: 0, tmuxRequired: false },
}));
const pty = new FakePty();
const sessionManager = new SessionManager({
  projects,
  executable: '/fixed/claude',
  controlDir: join(dataDir, 'control-plane', 'sessions'),
  pty,
});
const app = await createApp({
  dataDir,
  projects,
  host: '127.0.0.1',
  port: 0,
  sessionManager,
});

try {
  const address = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const healthResponse = await fetch(`${base}/api/health`);
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.mode, 'operations-only');
  assert.equal(health.autoCorrection, false);
  assert.equal(health.scientificAuthority, 'external-only');
  assert.equal(health.automation.researchMessageAuthority, false);
  assert.equal(health.projectCount, 5);

  const scanResponse = await fetch(`${base}/api/scan`, { method: 'POST' });
  assert.equal(scanResponse.status, 201);
  const scan = await scanResponse.json();
  assert.equal(scan.snapshot.projects.length, 5);
  assert.equal(scan.audit.autoCorrection, false);
  assert.match(scan.evidenceHash, /^[a-f0-9]{64}$/);

  const historyResponse = await fetch(`${base}/api/scans`);
  const history = await historyResponse.json();
  assert.equal(history.length, 1);
  const verifyResponse = await fetch(`${base}/api/evidence/${scan.id}`);
  assert.equal((await verifyResponse.json()).valid, true);
  const uiResponse = await fetch(`${base}/`);
  assert.equal(uiResponse.status, 200);
  const ui = await uiResponse.text();
  assert.match(ui, /FIRM Control Room/);
  assert.match(ui, /id="terminal"/);
  assert.doesNotMatch(ui, /<textarea|<pre id="terminal-output"/);
  assert.equal((await fetch(`${base}/vendor/xterm.js`)).status, 200);
  assert.equal((await fetch(`${base}/vendor/addon-fit.js`)).status, 200);
  assert.equal((await fetch(`${base}/vendor/xterm.css`)).status, 200);
  const sessionResponse = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: 'synthetic-1', cols: 80, rows: 24, bootstrap: false }),
  });
  assert.equal(sessionResponse.status, 201);
  const session = await sessionResponse.json();
  pty.terminals[0].emitData('smoke terminal output');
  const outputResponse = await fetch(`${base}/api/sessions/${session.id}/output?cursor=0`);
  assert.equal((await outputResponse.json()).data, 'smoke terminal output');
  const stopResponse = await fetch(`${base}/api/sessions/${session.id}/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(stopResponse.status, 202);
  console.log(`smoke ok: scan #${scan.id}, evidence ${scan.evidenceHash}`);
} finally {
  await app.close();
  const evidenceRoot = join(dataDir, 'evidence');
  try {
    for (const entry of await readdir(evidenceRoot)) await chmod(join(evidenceRoot, entry), 0o755);
  } catch {}
  await rm(dataDir, { recursive: true, force: true });
}
