import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { BrokerClient } from '../src/broker-client.js';
import { createBrokerServer } from '../src/broker-rpc.js';
import { createApp } from '../src/server.js';
import { SessionManager } from '../src/session-manager.js';
import { FakePty } from './fake-pty.js';

function websocketOutput(url, sessionId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('WebSocket output timed out')), 3000);
    ws.once('open', () => ws.send(JSON.stringify({
      type: 'attach',
      sessionId,
      offset: 0,
    })));
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'output' && message.data) {
        clearTimeout(timer);
        ws.close();
        resolve(message);
      }
    });
    ws.once('error', reject);
  });
}

test('real Web restart keeps the broker session id and PID and WebSocket resumes output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'firm-web-restart-'));
  const project = { id: 'P', name: 'Project P', path: root, expected: {} };
  const pty = new FakePty();
  const manager = new SessionManager({
    projects: [project],
    executable: '/fixed/claude',
    controlDir: join(root, 'control', 'sessions'),
    pty,
    idFactory: () => 'persistent-session',
  });
  const socketPath = join(root, 'control', 'broker.sock');
  const broker = await createBrokerServer({ socketPath, manager });
  const client = new BrokerClient({ socketPath });
  let first;
  let second;
  try {
    first = await createApp({
      dataDir: join(root, 'web-data'),
      projects: [project],
      scanIntervalMs: 0,
      brokerClient: client,
    });
    const firstAddress = await first.listen(0, '127.0.0.1');
    const firstBase = `http://127.0.0.1:${firstAddress.port}`;
    const createResponse = await fetch(`${firstBase}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'P', cols: 80, rows: 24, bootstrap: false }),
    });
    const created = await createResponse.json();
    pty.terminals[0].emitData('before-web-restart');
    const bridged = await websocketOutput(
      `ws://127.0.0.1:${firstAddress.port}/ws/terminal`,
      created.id,
    );
    assert.equal(bridged.data, 'before-web-restart');

    await first.close();
    first = null;
    assert.deepEqual(pty.terminals[0].kills, []);

    second = await createApp({
      dataDir: join(root, 'web-data'),
      projects: [project],
      scanIntervalMs: 0,
      brokerClient: client,
    });
    const secondAddress = await second.listen(0, '127.0.0.1');
    const secondBase = `http://127.0.0.1:${secondAddress.port}`;
    const sessions = await (await fetch(`${secondBase}/api/sessions`)).json();
    assert.equal(sessions[0].id, created.id);
    assert.equal(sessions[0].pid, created.pid);
    assert.equal(sessions[0].cursor, Buffer.byteLength('before-web-restart'));

    await fetch(`${secondBase}/api/sessions/${created.id}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: 'after restart\r' }),
    });
    assert.deepEqual(pty.terminals[0].writes, ['after restart\r']);
  } finally {
    if (first) await first.close();
    if (second) await second.close();
    await client.stop('persistent-session').catch(() => {});
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});
