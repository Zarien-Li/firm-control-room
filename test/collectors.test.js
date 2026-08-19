import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ALLOWED_FILES,
  collectClaudeSessions,
  collectSnapshot,
  mapSessionToProjects,
  parsePsOutput,
} from '../src/collectors.js';
import { loadConfig } from '../src/config.js';

test('public default config falls back to the portable example project', async () => {
  const config = await loadConfig();
  assert.deepEqual(config.projects.map((project) => project.id), ['project-alpha']);
  assert.match(config.projects[0].path, /research\/project-alpha$/);
  assert.deepEqual(config.claudeArgs, ['--append-system-prompt-file', 'CLAUDE-RESEARCH.md']);
  assert.equal(config.sessionTargets.length, 1);
  assert.deepEqual(config.controlTargets, []);
  assert.equal(config.gpuQueue.enabled, false);
  assert.equal(config.gpuQueue.runnerEnsureEnabled, true);
  assert.equal(config.gpuQueue.schedulerMonitorPidFile, null);
  assert.equal(config.scanIntervalMs, 2.5 * 60 * 60 * 1000);
  assert.equal(config.continuity.enabled, false);
  assert.equal(config.continuity.codexExecutable, null);
});

test('GPU Scheduler prompt requires one persistent deduplicated global monitor', async () => {
  const prompt = await readFile(new URL('../config/GPU_SCHEDULER_START_PROMPT.md', import.meta.url), 'utf8');
  assert.match(prompt, /exactly one scheduler-owned global monitor alive across both idle and active periods/);
  assert.match(prompt, /FIRM is an independent watchdog and wake-up path, not a replacement/);
  assert.match(prompt, /MONITORING_IDLE/);
  assert.doesNotMatch(prompt, /When no request is running, do not keep a Claude Code background monitor alive/);
});

test('collector reads only the allowlisted files and retains SHA-256 evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'firm-collector-'));
  const projectPath = join(root, 'ACL_1');
  await mkdir(projectPath);
  try {
    const contents = {
      'PROJECT_IDENTITY.json': JSON.stringify({
        project_id: 'acl_1-test',
        identity_version: 'arena-locked',
        current: { status: 'locked' },
      }),
      'PROGRAM_ORIGIN.md': '# origin\n',
      'SEED.md': '# seed\n',
      'PIPELINE_STATE.md': '# pipeline\nlocked\n',
      'CLAUDE.md': '# policy\n',
      'prompt.txt': 'continue\n',
    };
    await Promise.all(Object.entries(contents)
      .map(([name, content]) => writeFile(join(projectPath, name), content)));
    await writeFile(join(projectPath, 'SECRET.txt'), 'must not be collected');

    const snapshot = await collectSnapshot([{
      id: 'ACL_1',
      name: 'ACL_1',
      path: projectPath,
      expected: { identityPrefix: 'acl_1-', sessionContains: 'ACL_1' },
    }], new Date('2026-01-01T00:00:00.000Z'), {
      runCommand: async () => ({ ok: false, code: 'EACCES', stderr: 'blocked' }),
      collectTmux: async () => ({
        status: 'degraded', available: false, reason: 'tmux_server_unavailable', panes: [],
      }),
    });

    assert.equal(snapshot.schemaVersion, 3);
    assert.deepEqual(snapshot.collectionPolicy.files, [...ALLOWED_FILES]);
    assert.deepEqual(snapshot.projects[0].files.map((file) => file.name), [...ALLOWED_FILES]);
    assert.ok(snapshot.projects[0].files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
    assert.equal(JSON.stringify(snapshot).includes('must not be collected'), false);
    assert.equal('gpu' in snapshot, false);
    assert.equal('state' in snapshot.projects[0], false);
    assert.equal(snapshot.projects[0].identity.projectId, 'acl_1-test');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('collector uses the configured project bootstrap as prompt evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'firm-bootstrap-evidence-'));
  try {
    const contents = {
      'PROJECT_IDENTITY.json': JSON.stringify({ current: { status: 'user_approved' } }),
      'PROGRAM_ORIGIN.md': '# origin\n',
      'SEED.md': '# seed\n',
      'PIPELINE_STATE.md': '# state\n',
      'CLAUDE.md': '# policy\n',
      'START_PROMPT.md': 'start from sealed origin\n',
    };
    await Promise.all(Object.entries(contents)
      .map(([name, content]) => writeFile(join(root, name), content)));
    const snapshot = await collectSnapshot([{
      id: 'ACL_1',
      name: 'ACL_1',
      path: root,
      bootstrapFile: 'START_PROMPT.md',
      sessionPathAliases: [],
      expected: {},
    }], new Date(), {
      collectTmux: async () => ({ status: 'degraded', available: false, reason: 'test', panes: [] }),
      runCommand: async () => ({ ok: true, stdout: '', stderr: '' }),
    });
    const prompt = snapshot.projects[0].files.find((file) => file.name === 'prompt.txt');
    assert.equal(prompt.status, 'ok');
    assert.equal(prompt.sourceName, 'START_PROMPT.md');
    assert.equal(prompt.content, 'start from sealed origin\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('collector merges modern identity fields with the sealed program authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'firm-modern-identity-'));
  await writeFile(join(root, 'PROJECT_IDENTITY.json'), JSON.stringify({
    project_id: 'acl_1-modern',
    identity_version: 'sealed',
    origin: { research_object: 'latent computation', value_metric: 'legacy metric' },
    outside_scope: ['benchmark creation'],
    current: { research_object: 'latent computation' },
    transition_authority: { status: 'user_approved' },
  }));
  await writeFile(join(root, 'PROGRAM_ORIGIN.md'), [
    '## Sealed Arena',
    '- Research arena: latent reasoning.',
    '- Canonical object: latent computation.',
    '- Primary outcome: standard-task accuracy at a fixed token budget.',
    '- Standard evidence surface: public reasoning tasks.',
    '- Baseline community: Coconut-class systems.',
  ].join('\n'));
  for (const name of ALLOWED_FILES.filter((name) => ![
    'PROJECT_IDENTITY.json', 'PROGRAM_ORIGIN.md',
  ].includes(name))) {
    await writeFile(join(root, name), `${name}\n`);
  }
  const snapshot = await collectSnapshot([{
    id: 'ACL_1', name: 'ACL_1', path: root, sessionPathAliases: [], expected: {},
  }], new Date(), {
    collectTmux: async () => ({ status: 'degraded', available: false, reason: 'test', panes: [] }),
    runCommand: async () => ({ ok: true, stdout: '', stderr: '' }),
  });
  assert.equal(snapshot.projects[0].identity.arena, 'latent reasoning.');
  assert.equal(snapshot.projects[0].identity.canonicalObject, 'latent computation');
  assert.equal(
    snapshot.projects[0].identity.primaryOutcome,
    'standard-task accuracy at a fixed token budget.',
  );
  assert.equal(snapshot.projects[0].identity.evidenceSurface, 'public reasoning tasks.');
  assert.equal(snapshot.projects[0].identity.currentStatus, 'user_approved');
});

test('ps parser recognizes real Claude launch forms and main process filtering preserves sessions', async () => {
  const ps = [
    '  100     1 ttys018 /usr/local/bin/claude --resume abc',
    '  101   100 ttys018 claude --internal-child',
    '  200     1 ?? /usr/bin/node /opt/@anthropic-ai/claude-code/cli.js',
    '  300     1 ?? /bin/sh -c claude',
  ].join('\n');
  const parsed = parsePsOutput(ps);
  assert.deepEqual(parsed.filter((item) => item.isClaude).map((item) => item.pid), [100, 101, 200]);
  assert.equal(parsed[0].tty, 'ttys018');

  const result = await collectClaudeSessions([], {
    platform: 'linux',
    runCommand: async () => ({ ok: true, stdout: ps, stderr: '' }),
    readlinkFn: async (path) => `/work/${path.match(/\d+/)[0]}`,
  });
  assert.deepEqual(result.items.map((item) => item.pid), [100, 200]);
  assert.equal(result.unmapped, 2);
});

test('liveness collector combines history, project writes, and non-infrastructure tool descendants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'firm-liveness-collector-'));
  const projectPath = join(root, 'ACL_1');
  await mkdir(projectPath);
  await writeFile(join(projectPath, 'PIPELINE_STATE.md'), '# live\n');
  const ps = [
    '100 1 ttys018 00:20 0.2 S+ /usr/local/bin/claude --continue',
    '110 100 ?? 00:05 82.4 R /usr/bin/python train.py',
    '111 100 ?? 00:20 0.0 S /usr/local/bin/codex mcp-server',
    '112 100 ?? 00:20 0.0 S /usr/bin/caffeinate -dims',
  ].join('\n');
  try {
    const parsed = parsePsOutput(ps);
    assert.equal(parsed[0].elapsed, '00:20');
    assert.equal(parsed[1].cpuPct, 82.4);
    assert.equal(parsed[1].processState, 'R');
    const result = await collectClaudeSessions([
      { id: 'ACL_1', path: projectPath, sessionPathAliases: [] },
    ], {
      platform: 'linux',
      collectLiveness: true,
      claudeProjectsDir: join(root, 'history'),
      runCommand: async () => ({ ok: true, stdout: ps, stderr: '' }),
      readlinkFn: async () => projectPath,
      historyHeartbeatReader: async () => ({
        status: 'ok', latestWriteAt: '2026-08-11T00:02:00.000Z', sourceFile: 'live.jsonl',
        latestAssistantAt: '2026-08-11T00:01:59.000Z',
        latestAssistantText: 'Should I run the matched comparison next?',
        constructionLease: { id: 'method-v1', state: 'active', active: true },
      }),
    });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].heartbeat.historyWriteAt, '2026-08-11T00:02:00.000Z');
    assert.equal(result.items[0].heartbeat.latestAssistantAt, '2026-08-11T00:01:59.000Z');
    assert.equal(result.items[0].heartbeat.latestAssistantText,
      'Should I run the matched comparison next?');
    assert.equal(result.items[0].heartbeat.constructionLease.id, 'method-v1');
    assert.equal(result.items[0].heartbeat.toolProcessCount, 1);
    assert.equal(result.items[0].heartbeat.activeToolProcessCount, 1);
    assert.deepEqual(result.items[0].heartbeat.toolKinds, ['python']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a sleeping ssh descendant remains an active remote tool dependency', async () => {
  const root = await mkdtemp(join(tmpdir(), 'firm-remote-tool-collector-'));
  const projectPath = join(root, 'ICASSP_6');
  await mkdir(projectPath);
  await writeFile(join(projectPath, 'PIPELINE_STATE.md'), '# live\n');
  const ps = [
    '100 1 ttys002 00:20 0.2 S+ /usr/local/bin/claude --continue',
    '110 100 ?? 00:05 0.0 Ss /bin/zsh -c ssh host sleep 480',
    '111 110 ?? 00:05 0.0 S /usr/bin/ssh host sleep 480',
    '112 100 ?? 00:20 0.0 S /usr/bin/python -m glm_mcp_clone.server --service web-reader',
  ].join('\n');
  try {
    const result = await collectClaudeSessions([
      { id: 'ICASSP_6', path: projectPath, sessionPathAliases: [] },
    ], {
      platform: 'linux',
      collectLiveness: true,
      claudeProjectsDir: join(root, 'history'),
      runCommand: async () => ({ ok: true, stdout: ps, stderr: '' }),
      readlinkFn: async () => projectPath,
      historyHeartbeatReader: async () => ({ status: 'ok' }),
    });
    assert.equal(result.items[0].heartbeat.toolProcessCount, 2);
    assert.equal(result.items[0].heartbeat.activeToolProcessCount, 2);
    assert.deepEqual(result.items[0].heartbeat.toolKinds.sort(), ['ssh', 'zsh']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('session mapping uses path boundaries and longest prefix while retaining unmapped sessions', () => {
  const projects = [
    { id: 'ROOT', path: '/work', sessionPathAliases: [] },
    { id: 'APP', path: '/canonical/app', sessionPathAliases: ['/work/app'] },
  ];
  const mapped = mapSessionToProjects({ pid: 1, cwd: '/work/app/packages/ui' }, projects);
  assert.equal(mapped.projectId, 'APP');
  assert.equal(mapped.matchSource, 'sessionPathAlias');
  assert.equal(mapped.locationDrift, true);

  const unmapped = mapSessionToProjects({ pid: 2, cwd: '/workspace-not-a-child' }, projects);
  assert.equal(unmapped.mappingStatus, 'unmapped');
  assert.equal(unmapped.projectId, null);
});

test('an exact portfolio-root Claude session is classified as a control session', async () => {
  const result = await collectClaudeSessions([
    { id: 'ACL_1', path: '/research/other/ACL_1', sessionPathAliases: [] },
  ], {
    controlSessionPaths: ['/research/other'],
    platform: 'darwin',
    // macOS cwd collection uses the command runner, so return an lsof-style cwd there.
    runCommand: async (command) => command === 'ps'
      ? { ok: true, stdout: '77 1 claude --append-system-prompt-file GPU_SCHEDULER.md', stderr: '' }
      : { ok: true, stdout: 'p77\nfcwd\nn/research/other', stderr: '' },
  });
  assert.equal(result.items[0].mappingStatus, 'control');
  assert.equal(result.items[0].controlId, 'GPU_SCHEDULER');
  assert.equal(result.control, 1);
  assert.equal(result.unmapped, 0);
});

test('equal longest aliases report ambiguous duplicate mapping', () => {
  const projects = [
    { id: 'A', path: '/a', sessionPathAliases: ['/shared/project'] },
    { id: 'B', path: '/b', sessionPathAliases: ['/shared/project'] },
  ];
  const session = mapSessionToProjects({ pid: 9, cwd: '/shared/project/run' }, projects);
  assert.equal(session.mappingStatus, 'ambiguous');
  assert.equal(session.projectId, null);
  assert.deepEqual(session.matches.map((match) => match.projectId), ['A', 'B']);
});

test('process and cwd access failures degrade without dropping discovered Claude sessions', async () => {
  const unavailable = await collectClaudeSessions([], {
    runCommand: async () => ({ ok: false, code: 'EACCES', stderr: 'blocked' }),
  });
  assert.equal(unavailable.status, 'degraded');
  assert.deepEqual(unavailable.items, []);

  const cwdUnavailable = await collectClaudeSessions([], {
    platform: 'linux',
    runCommand: async () => ({ ok: true, stdout: '42 1 claude', stderr: '' }),
    readlinkFn: async () => {
      const error = new Error('gone');
      error.code = 'ENOENT';
      throw error;
    },
  });
  assert.equal(cwdUnavailable.total, 1);
  assert.equal(cwdUnavailable.items[0].cwdStatus, 'degraded');
  assert.equal(cwdUnavailable.items[0].mappingStatus, 'unmapped');

  const mac = await collectClaudeSessions([{ id: 'A', path: '/work/a', sessionPathAliases: [] }], {
    platform: 'darwin',
    runCommand: async (command) => command === 'ps'
      ? { ok: true, stdout: '43 1 /usr/local/bin/claude', stderr: '' }
      : { ok: true, stdout: 'p43\nfcwd\nn/work/a/subdir', stderr: '' },
  });
  assert.equal(mac.items[0].cwd, '/work/a/subdir');
  assert.equal(mac.items[0].projectId, 'A');
});
