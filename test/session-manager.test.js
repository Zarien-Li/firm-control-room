import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionError, SessionManager } from '../src/session-manager.js';
import { FakePty } from './fake-pty.js';

test('SessionManager only starts configured projects with the fixed executable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'firm-session-manager-'));
  const pty = new FakePty();
  const manager = new SessionManager({
    projects: [{ id: 'ACL_1', name: 'ACL_1', path: join(root, 'ACL_1') }],
    executable: '/fixed/bin/claude',
    args: ['--append-system-prompt-file', 'CLAUDE-RESEARCH.md'],
    controlDir: join(root, 'control'),
    bufferBytes: 5,
    pty,
    idFactory: () => 'session-1',
  });
  try {
    await assert.rejects(
      manager.start('NOT_CONFIGURED'),
      (error) => error instanceof SessionError && error.code === 'project_not_found',
    );
    const session = await manager.start('ACL_1', { cols: 90, rows: 24 });
    assert.equal(session.id, 'session-1');
    assert.equal(session.backend, 'fake-pty');
    assert.deepEqual(session.capabilities, { resize: true });
    assert.deepEqual(pty.calls[0].args, ['--append-system-prompt-file', 'CLAUDE-RESEARCH.md']);
    assert.equal(pty.calls[0].executable, '/fixed/bin/claude');
    assert.equal(pty.calls[0].options.cwd, join(root, 'ACL_1'));

    const terminal = pty.terminals[0];
    terminal.emitData('abc');
    terminal.emitData('def');
    assert.deepEqual(manager.output(session.id, 0), {
      session: manager.list()[0],
      cursor: 1,
      nextCursor: 6,
      truncated: true,
      data: 'bcdef',
    });

    manager.input(session.id, 'secret prompt\n');
    assert.deepEqual(terminal.writes, ['secret prompt\n']);
    manager.resize(session.id, 100, 40);
    assert.deepEqual(terminal.resizes, [{ cols: 100, rows: 40 }]);
    manager.stop(session.id);
    assert.equal(manager.list()[0].status, 'EXITED');
    assert.equal(manager.list()[0].exitCode, 143);

    await manager.close();
    const transcript = await readFile(join(root, 'control/session-1/transcript.ndjson'), 'utf8');
    assert.match(transcript, /"type":"output"/);
    assert.match(transcript, /"type":"input".*"bytes":14/);
    assert.doesNotMatch(transcript, /secret prompt/);
    assert.match(transcript, /"type":"exit".*"exitCode":143/);
  } finally {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('SessionManager automatically sends the fixed project prompt only after Claude is ready', async () => {
  const root = await mkdtemp(join(tmpdir(), 'firm-session-bootstrap-'));
  const projectPath = join(root, 'ACL_1');
  await mkdir(projectPath);
  await writeFile(join(projectPath, 'CLAUDE-RESEARCH.md'), '# research system prompt\n');
  await writeFile(join(projectPath, 'prompt.txt'), 'locked research prompt\n');
  const pty = new FakePty();
  const manager = new SessionManager({
    projects: [{ id: 'ACL_1', name: 'ACL_1', path: projectPath }],
    executable: '/fixed/claude',
    args: ['--append-system-prompt-file', 'CLAUDE-RESEARCH.md'],
    controlDir: join(root, 'control'),
    pty,
  });
  try {
    const session = await manager.start('ACL_1', { bootstrap: true });
    pty.terminals[0].emitData('Do you want to proceed?');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(pty.terminals[0].writes, []);
    pty.terminals[0].emitData('\n❯ ');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(pty.terminals[0].writes, ['locked research prompt\r']);
    assert.equal(manager.list()[0].bootstrapStatus, 'SENT');
    assert.throws(() => manager.bootstrap(session.id), { code: 'bootstrap_already_sent' });
  } finally {
    await manager.close({ terminate: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('SessionManager recognizes the modern Claude suggested prompt but not trust menu choices', async () => {
  const root = await mkdtemp(join(tmpdir(), 'firm-modern-ready-'));
  await writeFile(join(root, 'CLAUDE-RESEARCH.md'), '# system\n');
  await writeFile(join(root, 'prompt.txt'), 'fixed prompt\n');
  const pty = new FakePty();
  const manager = new SessionManager({
    projects: [{ id: 'P', name: 'P', path: root }], executable: '/fixed/claude',
    args: ['--append-system-prompt-file', 'CLAUDE-RESEARCH.md'],
    controlDir: join(root, 'control'), pty,
  });
  try {
    await manager.start('P', { bootstrap: true });
    pty.terminals[0].emitData('Quick safety check\n❯ 1. Yes, I trust this folder\n  2. No, exit\n');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(pty.terminals[0].writes, []);
    assert.equal(manager.list()[0].waitReason, 'interactive_confirmation');
    manager.input(manager.list()[0].id, '\r');
    pty.terminals[0].emitData('Welcome\n❯ Try "edit <filepath> to..."\n────────\nmanual mode on\n');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(pty.terminals[0].writes, ['\r', 'fixed prompt\r']);
    assert.equal(manager.list()[0].bootstrapStatus, 'SENT');
  } finally {
    await manager.close({ terminate: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('SessionManager submits long bracketed-paste prompts with a separate Enter write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'firm-long-bootstrap-'));
  const prompt = `long fixed contract ${'x'.repeat(400)}`;
  await writeFile(join(root, 'CLAUDE-RESEARCH.md'), '# system\n');
  await writeFile(join(root, 'prompt.txt'), `${prompt}\n`);
  const pty = new FakePty();
  const manager = new SessionManager({
    projects: [{ id: 'P', name: 'P', path: root }], executable: '/fixed/claude',
    controlDir: join(root, 'control'), pty,
  });
  try {
    await manager.start('P', { bootstrap: true });
    pty.terminals[0].emitData('\r❯ Try "something"\r');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(pty.terminals[0].writes, [prompt, '\r']);
    pty.terminals[0].emitData('Not logged in · Please run /login\r❯ ');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(manager.list()[0].bootstrapNeedsRetry, true);
    manager.bootstrap(manager.list()[0].id);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(pty.terminals[0].writes, [prompt, '\r', prompt, '\r']);
    assert.equal(manager.list()[0].bootstrapNeedsRetry, false);
  } finally {
    await manager.close({ terminate: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('SessionManager launches the GPU scheduler with bare Claude and its dedicated prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'firm-scheduler-bootstrap-'));
  await writeFile(join(root, 'CLAUDE.md'), '# scheduler authority\n');
  await writeFile(join(root, 'GPU_QUEUE_SPEC.md'), '# queue\n');
  await writeFile(join(root, 'GPU_SCHEDULER_START_PROMPT.md'), 'manage the GPU queue\n');
  const pty = new FakePty();
  const manager = new SessionManager({
    projects: [{
      id: 'GPU_SCHEDULER',
      name: 'GPU Scheduler',
      kind: 'control',
      path: root,
      args: [],
      bootstrapFile: 'GPU_SCHEDULER_START_PROMPT.md',
      bootstrapRequiredFiles: ['CLAUDE.md', 'GPU_QUEUE_SPEC.md', 'GPU_SCHEDULER_START_PROMPT.md'],
    }],
    executable: '/fixed/claude',
    args: ['--append-system-prompt-file', 'CLAUDE-RESEARCH.md'],
    controlDir: join(root, 'control'),
    pty,
  });
  try {
    const session = await manager.start('GPU_SCHEDULER', { bootstrap: true });
    assert.deepEqual(pty.calls[0].args, []);
    assert.equal(session.targetKind, 'control');
    await assert.rejects(manager.start('GPU_SCHEDULER'), { code: 'session_already_running' });
    pty.terminals[0].emitData('\n❯ ');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(pty.terminals[0].writes, ['manage the GPU queue\r']);
  } finally {
    await manager.close({ terminate: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('SessionManager rejects invalid input and dimensions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'firm-session-validation-'));
  const manager = new SessionManager({
    projects: [{ id: 'P', name: 'P', path: root }],
    executable: '/fixed/claude',
    controlDir: join(root, 'control'),
    pty: new FakePty(),
  });
  try {
    await assert.rejects(manager.start('P', { cols: 0 }), { code: 'invalid_dimensions' });
    const session = await manager.start('P');
    assert.throws(() => manager.input(session.id, ''), { code: 'invalid_input' });
    assert.throws(() => manager.output(session.id, -1), { code: 'invalid_cursor' });
    manager.stop(session.id);
    assert.throws(() => manager.input(session.id, 'x'), { code: 'session_not_running' });
  } finally {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('SessionManager reports unsupported resize without changing dimensions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'firm-session-capability-'));
  const manager = new SessionManager({
    projects: [{ id: 'P', name: 'P', path: root }],
    executable: '/fixed/claude',
    controlDir: join(root, 'control'),
    pty: new FakePty({ name: 'macos-script', resize: false }),
  });
  try {
    const session = await manager.start('P', { cols: 80, rows: 24 });
    assert.deepEqual(
      { backend: session.backend, capabilities: session.capabilities },
      { backend: 'macos-script', capabilities: { resize: false } },
    );
    assert.throws(
      () => manager.resize(session.id, 100, 40),
      (error) => error instanceof SessionError
        && error.code === 'unsupported_capability'
        && error.status === 501,
    );
    assert.deepEqual(
      { cols: manager.list()[0].cols, rows: manager.list()[0].rows },
      { cols: 80, rows: 24 },
    );
    assert.deepEqual(manager.get(session.id).terminal.resizes, []);
  } finally {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('SessionManager persists output offsets and marks unattached sessions LOST after broker restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'firm-session-restore-'));
  const options = {
    projects: [{ id: 'P', name: 'P', path: root }],
    executable: '/fixed/claude',
    controlDir: join(root, 'control'),
    bufferBytes: 5,
  };
  const firstPty = new FakePty();
  const first = new SessionManager({
    ...options,
    pty: firstPty,
    idFactory: () => 'restored-session',
  });
  try {
    const created = await first.start('P');
    firstPty.terminals[0].emitData('1234567');
    await first.close();
    assert.deepEqual(firstPty.terminals[0].kills, []);

    const restored = new SessionManager({ ...options, pty: new FakePty() });
    const summary = restored.list()[0];
    assert.equal(summary.id, created.id);
    assert.equal(summary.pid, created.pid);
    assert.equal(summary.status, 'LOST');
    assert.equal(summary.cursor, 7);
    assert.deepEqual(restored.output(created.id, 0), {
      session: summary,
      cursor: 2,
      nextCursor: 7,
      truncated: true,
      data: '34567',
    });
  } finally {
    await first.close({ terminate: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('SessionManager only enters WAITING_INPUT after an explicit interactive prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'firm-session-state-'));
  const pty = new FakePty();
  const manager = new SessionManager({
    projects: [{ id: 'P', name: 'P', path: root }],
    executable: '/fixed/claude',
    controlDir: join(root, 'control'),
    pty,
  });
  try {
    const session = await manager.start('P');
    pty.terminals[0].emitData('tool is still running\n');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(manager.list()[0].status, 'RUNNING');

    pty.terminals[0].emitData('\x1b[35m❯\x1b[0m ');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(manager.list()[0].status, 'WAITING_INPUT');

    manager.input(session.id, 'continue\r');
    assert.equal(manager.list()[0].status, 'RUNNING');
    manager.stop(session.id);
  } finally {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }
});
