import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrokerClient } from '../src/broker-client.js';
import { createBrokerServer } from '../src/broker-rpc.js';
import { createPtyBackend } from '../src/pty-backend.js';
import { createApp } from '../src/server.js';
import { SessionManager } from '../src/session-manager.js';

const root = await mkdtemp(join(tmpdir(), 'firm-real-restart-'));
await writeFile(join(root, 'CLAUDE-RESEARCH.md'), '# restart acceptance system prompt\n');
await writeFile(join(root, 'prompt.txt'), 'restart acceptance prompt\n');
const executable = '/bin/cat';
const project = { id: 'REAL', name: 'Real PTY acceptance', path: root, expected: {} };
const socketPath = join(root, 'control-plane', 'broker.sock');
const pty = await createPtyBackend({ executable });
const manager = new SessionManager({
  projects: [project],
  executable,
  controlDir: join(root, 'control-plane', 'sessions'),
  pty,
});
const broker = await createBrokerServer({ socketPath, manager });
const client = new BrokerClient({ socketPath });
let first;
let second;
let session;

async function waitForOutput(id, cursor, expected) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const output = await client.output(id, cursor);
    if (output.data.includes(expected)) return output;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for real PTY output: ${expected}`);
}

async function waitForExit(id) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const item = (await client.list()).find((candidate) => candidate.id === id);
    if (item?.status === 'EXITED') return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for real PTY exit');
}

try {
  first = await createApp({
    dataDir: join(root, 'web-data'),
    projects: [project],
    scanIntervalMs: 0,
    brokerClient: client,
  });
  const firstAddress = await first.listen(0, '127.0.0.1');
  const firstBase = `http://127.0.0.1:${firstAddress.port}`;
  const createdResponse = await fetch(`${firstBase}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: 'REAL', cols: 80, rows: 24 }),
  });
  assert.equal(createdResponse.status, 201);
  session = await createdResponse.json();
  await client.input(session.id, 'before-restart\r');
  const before = await waitForOutput(session.id, 0, 'before-restart');

  await first.close();
  first = null;
  process.kill(session.pid, 0);

  second = await createApp({
    dataDir: join(root, 'web-data'),
    projects: [project],
    scanIntervalMs: 0,
    brokerClient: client,
  });
  const secondAddress = await second.listen(0, '127.0.0.1');
  const secondBase = `http://127.0.0.1:${secondAddress.port}`;
  const sessions = await (await fetch(`${secondBase}/api/sessions`)).json();
  assert.equal(sessions[0].id, session.id);
  assert.equal(sessions[0].pid, session.pid);
  assert.ok(sessions[0].cursor >= before.nextCursor);

  await client.input(session.id, 'after-restart\r');
  await waitForOutput(session.id, sessions[0].cursor, 'after-restart');
  console.log(`real restart acceptance ok: session=${session.id} pid=${session.pid}`);
} finally {
  if (first) await first.close();
  if (second) await second.close();
  if (session) {
    await client.stop(session.id).catch(() => {});
    await waitForExit(session.id).catch(() => {});
  }
  await broker.close();
  await rm(root, { recursive: true, force: true });
}
