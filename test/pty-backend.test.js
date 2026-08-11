import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  createNodePtyBackend,
  createPtyBackend,
  createScriptBackend,
} from '../src/pty-backend.js';

function fakeChild(pid = 4321) {
  return Object.assign(new EventEmitter(), {
    pid,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
}

test('macOS script backend uses fixed argv, streams IO, and kills only its process group', () => {
  const child = fakeChild();
  const spawnCalls = [];
  const killCalls = [];
  const backend = createScriptBackend({
    executable: '/fixed/bin/claude',
    spawnProcess(command, args, options) {
      spawnCalls.push({ command, args, options });
      return child;
    },
    killProcess(pid, signal) {
      killCalls.push({ pid, signal });
    },
  });

  assert.equal(backend.name, 'macos-script');
  assert.deepEqual(backend.capabilities, { resize: false });
  assert.throws(() => backend.spawn('/other/claude', [], {}), /fixed executable/);
  assert.throws(() => backend.spawn('/fixed/bin/claude', ['--flag'], {}), /does not accept/);

  const terminal = backend.spawn('/fixed/bin/claude', [], {
    cwd: '/fixed/project',
    env: { TERM: 'xterm-256color' },
  });
  assert.deepEqual(spawnCalls[0].command, '/usr/bin/script');
  assert.deepEqual(spawnCalls[0].args, ['-q', '/dev/null', '/fixed/bin/claude']);
  assert.equal(spawnCalls[0].options.cwd, '/fixed/project');
  assert.equal(spawnCalls[0].options.detached, true);
  assert.equal(spawnCalls[0].options.shell, false);

  let output = '';
  let exit;
  terminal.onData((data) => { output += data; });
  terminal.onExit((event) => { exit = event; });
  child.stdout.write('stdout');
  child.stderr.write('stderr');
  terminal.write('manual input\n');
  assert.equal(child.stdin.read().toString(), 'manual input\n');
  assert.equal(output, 'stdoutstderr');
  assert.equal(terminal.resize(100, 40), false);
  terminal.kill('SIGTERM');
  assert.deepEqual(killCalls, [{ pid: -4321, signal: 'SIGTERM' }]);
  child.emit('exit', 0, null);
  assert.deepEqual(exit, { exitCode: 0, signal: null });
});

test('backend selection uses node-pty and repairs the macOS spawn-helper mode', async () => {
  const terminal = {};
  const nodePty = { spawn: () => terminal };
  const direct = createNodePtyBackend(nodePty);
  assert.equal(direct.name, 'node-pty');
  assert.deepEqual(direct.capabilities, { resize: true });
  assert.equal(direct.spawn('/fixed/claude', [], {}), terminal);

  const selected = await createPtyBackend({
    executable: '/fixed/claude',
    platform: 'linux',
    loadNodePty: async () => nodePty,
  });
  assert.equal(selected.name, 'node-pty');

  const chmodCalls = [];
  const selectedMac = await createPtyBackend({
    executable: '/fixed/claude',
    platform: 'darwin',
    arch: 'arm64',
    spawnHelperPath: '/fixed/node-pty/spawn-helper',
    chmodFile: async (path, mode) => chmodCalls.push({ path, mode }),
    loadNodePty: async () => nodePty,
  });
  assert.equal(selectedMac.name, 'node-pty');
  assert.deepEqual(selectedMac.capabilities, { resize: true });
  assert.deepEqual(chmodCalls, [{ path: '/fixed/node-pty/spawn-helper', mode: 0o755 }]);
});
