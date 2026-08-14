import { readFile, readlink, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, join, normalize, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { collectItermStatuses } from './iterm-status.js';
import { readClaudeHistoryHeartbeat } from './claude-history.js';
import { parseResearchMaturity } from './research-maturity.js';

const exec = promisify(execFile);
export const ALLOWED_FILES = Object.freeze([
  'PROJECT_IDENTITY.json',
  'PROGRAM_ORIGIN.md',
  'SEED.md',
  'PIPELINE_STATE.md',
  'CLAUDE.md',
  'prompt.txt',
]);
const execOptions = {
  timeout: 5000,
  maxBuffer: 1024 * 1024,
  encoding: 'utf8',
  env: process.env,
};
const PROJECT_PROGRESS_FILES = Object.freeze([
  'PIPELINE_STATE.md',
  'BASELINE_REPRO.md',
  'GPU_READINESS_STATUS.md',
  'GPU_SUBMISSION_READINESS_STATUS.md',
  'RESULT.md',
  join('paper', 'DRAFT.md'),
  join('paper', 'main.tex'),
]);

async function run(command, args, cwd) {
  try {
    const { stdout, stderr } = await exec(command, args, { ...execOptions, cwd });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout || '').trim(),
      stderr: String(error.stderr || error.message || '').trim(),
      code: error.code,
    };
  }
}

function pathContains(prefix, candidate) {
  const base = normalize(resolve(prefix));
  const value = normalize(resolve(candidate));
  return value === base || value.startsWith(`${base}${sep}`);
}

function commandExecutable(command) {
  const trimmed = command.trim();
  if (!trimmed) return '';
  if (trimmed[0] === '"' || trimmed[0] === "'") {
    const quote = trimmed[0];
    const end = trimmed.indexOf(quote, 1);
    return end > 0 ? trimmed.slice(1, end) : trimmed.slice(1);
  }
  return trimmed.split(/\s+/, 1)[0];
}

export function parsePsOutput(stdout) {
  return String(stdout || '').split('\n').map((line) => {
    const enriched = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([0-9:-]+)\s+([0-9.]+)\s+(\S+)\s+(.+?)\s*$/,
    );
    const enrichedTty = enriched
      && /^(?:\?|\?\?|console|tty\S*|pts\/\d+)$/i.test(enriched[3]);
    const withTty = enrichedTty ? null : line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/);
    const hasTty = withTty && /^(?:\?|\?\?|console|tty\S*|pts\/\d+)$/i.test(withTty[3]);
    const match = enrichedTty ? enriched
      : hasTty ? withTty : line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (!match) return null;
    const command = enrichedTty ? match[7] : hasTty ? match[4] : match[3];
    const executable = commandExecutable(command);
    const executableName = basename(executable);
    const isClaude = executableName === 'claude'
      || (executableName === 'node'
        && /(?:^|[/\\])(?:@anthropic-ai[/\\]claude-code[/\\])?cli\.js(?:\s|$)/i.test(command));
    return {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      tty: (enrichedTty || hasTty) && !/^\?+$/.test(match[3]) ? match[3] : null,
      elapsed: enrichedTty ? match[4] : null,
      cpuPct: enrichedTty ? Number(match[5]) : null,
      processState: enrichedTty ? match[6] : null,
      command,
      executable,
      isClaude,
    };
  }).filter(Boolean);
}

function processDescendants(pid, processes) {
  const byParent = new Map();
  for (const process of processes) {
    if (!byParent.has(process.ppid)) byParent.set(process.ppid, []);
    byParent.get(process.ppid).push(process);
  }
  const descendants = [];
  const queue = [...(byParent.get(pid) || [])];
  const seen = new Set();
  while (queue.length) {
    const process = queue.shift();
    if (seen.has(process.pid)) continue;
    seen.add(process.pid);
    descendants.push(process);
    queue.push(...(byParent.get(process.pid) || []));
  }
  return descendants;
}

function isPersistentClaudeInfrastructure(process) {
  if (process.isClaude) return true;
  return /(?:\bcaffeinate\b|\bmcp-server\b|model-context-protocol|server-sequential-thinking|glm_mcp_clone\.server|zai-mcp-server|codex-code-mode-host)/i
    .test(process.command);
}

function isLiveRemoteTool(process) {
  return /(?:^|[\s/'"])(?:ssh|scp|sftp|rsync)(?:\s|$)/i.test(process.command);
}

function toolProcessHeartbeat(pid, processes) {
  const tools = processDescendants(pid, processes)
    .filter((process) => !isPersistentClaudeInfrastructure(process));
  const active = tools.filter((process) => (
    /[RD]/.test(process.processState || '')
    || (Number.isFinite(process.cpuPct) && process.cpuPct >= 0.5)
    // ssh commonly sleeps locally while the remote training/evaluation process
    // is busy. Its continued presence is a live dependency, not an idle prompt.
    || isLiveRemoteTool(process)
  ));
  const kinds = [...new Set(tools.map((process) => basename(process.executable || process.command)))]
    .filter(Boolean).slice(0, 8);
  return {
    toolProcessCount: tools.length,
    activeToolProcessCount: active.length,
    toolKinds: kinds,
    toolFingerprint: sha256(tools
      .map((process) => `${process.pid}:${process.ppid}:${basename(process.executable || '')}`)
      .sort().join('|')).slice(0, 16),
  };
}

async function projectProgressHeartbeat(projectPath, statFn = stat) {
  let newest = null;
  for (const name of PROJECT_PROGRESS_FILES) {
    try {
      const info = await statFn(join(projectPath, name));
      if (!newest || info.mtimeMs > newest.mtimeMs) newest = { name, mtimeMs: info.mtimeMs };
    } catch {
      // Missing optional artifacts are normal.
    }
  }
  return newest ? {
    latestWriteAt: new Date(newest.mtimeMs).toISOString(),
    sourceFile: newest.name,
  } : { latestWriteAt: null, sourceFile: null };
}

async function sessionHeartbeat(session, project, processes, options) {
  const historyReader = options.historyHeartbeatReader || readClaudeHistoryHeartbeat;
  const [history, projectFiles] = await Promise.all([
    historyReader(project.path, { claudeProjectsDir: options.claudeProjectsDir }),
    projectProgressHeartbeat(project.path, options.statFn || stat),
  ]);
  const processHeartbeat = toolProcessHeartbeat(session.pid, processes);
  const progressTimes = [history.latestWriteAt, projectFiles.latestWriteAt]
    .filter(Boolean).sort();
  const episodeBasis = history.latestEventId
    ? `${project.id}:${session.pid}:${history.sourceFile}:${history.latestEventId}`
    : `${project.id}:${session.pid}:${history.cursor || session.terminal?.tailHash || 'unobserved'}`;
  return {
    status: history.status === 'unavailable' && !projectFiles.latestWriteAt
      ? 'degraded' : 'ok',
    collectedAt: new Date().toISOString(),
    historyStatus: history.status,
    historyWriteAt: history.latestWriteAt,
    historySourceFile: history.sourceFile,
    historySizeBytes: history.sizeBytes ?? null,
    historyCursor: history.cursor || null,
    historyEventId: history.latestEventId || null,
    historyEventType: history.latestEventType || null,
    latestAssistantAt: history.latestAssistantAt || null,
    latestAssistantText: history.latestAssistantText || null,
    waitingForJobRunIds: history.waitingForJobRunIds || [],
    constructionLease: history.constructionLease || null,
    deliveryMarkers: history.deliveryMarkers || [],
    episodeId: sha256(episodeBasis).slice(0, 24),
    projectWriteAt: projectFiles.latestWriteAt,
    projectSourceFile: projectFiles.sourceFile,
    lastProgressAt: progressTimes.at(-1) || null,
    ...processHeartbeat,
  };
}

function claudeMainProcesses(processes) {
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  return processes.filter((process) => {
    if (!process.isClaude) return false;
    let parent = byPid.get(process.ppid);
    while (parent) {
      if (parent.isClaude) return false;
      parent = byPid.get(parent.ppid);
    }
    return true;
  });
}

function parseLsofCwd(stdout) {
  const pathLine = String(stdout || '').split('\n').find((line) => line.startsWith('n'));
  return pathLine ? pathLine.slice(1) : null;
}

async function readProcessCwd(pid, options = {}) {
  const platform = options.platform || process.platform;
  if (platform === 'linux') {
    try {
      const cwd = await (options.readlinkFn || readlink)(`/proc/${pid}/cwd`);
      return { status: 'ok', cwd };
    } catch (error) {
      return { status: 'degraded', cwd: null, reason: 'proc_cwd_unreadable', detail: error.code || error.message };
    }
  }
  if (platform === 'darwin') {
    const result = await (options.runCommand || run)('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    const cwd = result.ok ? parseLsofCwd(result.stdout) : null;
    return cwd
      ? { status: 'ok', cwd }
      : { status: 'degraded', cwd: null, reason: 'lsof_cwd_unreadable', detail: result.stderr || result.code };
  }
  return { status: 'degraded', cwd: null, reason: 'cwd_platform_unsupported', detail: platform };
}

function projectPrefixes(project) {
  return [
    { path: project.path, source: 'path' },
    ...(project.sessionPathAliases || []).map((path) => ({ path, source: 'sessionPathAlias' })),
  ];
}

export function mapSessionToProjects(session, projects) {
  if (!session.cwd) {
    return { ...session, mappingStatus: 'unmapped', projectId: null, matches: [], locationDrift: false };
  }
  const matches = projects.flatMap((project) => projectPrefixes(project)
    .filter((prefix) => pathContains(prefix.path, session.cwd))
    .map((prefix) => ({
      projectId: project.id,
      projectPath: project.path,
      matchedPath: normalize(resolve(prefix.path)),
      matchSource: prefix.source,
      prefixLength: normalize(resolve(prefix.path)).length,
    })));
  const longest = matches.length ? Math.max(...matches.map((match) => match.prefixLength)) : -1;
  const winners = matches.filter((match) => match.prefixLength === longest);
  const projectIds = [...new Set(winners.map((match) => match.projectId))];
  const unique = projectIds.length === 1;
  const winner = unique ? winners.find((match) => match.projectId === projectIds[0]) : null;
  return {
    ...session,
    mappingStatus: !winners.length ? 'unmapped' : unique ? 'mapped' : 'ambiguous',
    projectId: winner?.projectId ?? null,
    matchedPath: winner?.matchedPath ?? null,
    matchSource: winner?.matchSource ?? null,
    matches: winners,
    locationDrift: Boolean(winner && !pathContains(winner.projectPath, session.cwd)),
  };
}

function markControlSession(session, controlSessionPaths = []) {
  if (session.mappingStatus !== 'unmapped' || !session.cwd) return session;
  const cwd = normalize(resolve(session.cwd));
  const matchedPath = controlSessionPaths
    .map((path) => normalize(resolve(path)))
    .find((path) => cwd === path);
  return matchedPath ? {
    ...session,
    mappingStatus: 'control',
    controlId: 'GPU_SCHEDULER',
    matchedPath,
  } : session;
}

function paneForProcess(process, processes, panes) {
  const paneByPid = new Map(panes.map((pane) => [pane.pid, pane]));
  const processByPid = new Map(processes.map((item) => [item.pid, item]));
  let current = process;
  const seen = new Set();
  while (current && !seen.has(current.pid)) {
    seen.add(current.pid);
    if (paneByPid.has(current.pid)) return paneByPid.get(current.pid);
    current = processByPid.get(current.ppid);
  }
  return null;
}

export async function collectClaudeSessions(projects, options = {}) {
  const runner = options.runCommand || run;
  const ps = await runner('ps', [
    '-axo', 'pid=,ppid=,tty=,etime=,%cpu=,stat=,command=',
  ]);
  if (!ps.ok) {
    return {
      status: 'degraded',
      reason: ps.code === 'ENOENT' ? 'ps_not_installed' : 'ps_unavailable',
      total: 0,
      mapped: 0,
      control: 0,
      unmapped: 0,
      ambiguous: 0,
      items: [],
      processes: [],
    };
  }
  const processes = parsePsOutput(ps.stdout);
  const mains = claudeMainProcesses(processes);
  const iterm = options.collectItermStatuses
    ? await options.collectItermStatuses()
    : options.runCommand
      ? { status: 'unavailable', reason: 'test_or_custom_runner', items: [] }
      : await collectItermStatuses({ platform: options.platform });
  const itermByTty = new Map((iterm.items || []).map((item) => [item.tty, item]));
  const discovered = await Promise.all(mains.map(async (item) => {
    const cwdResult = await readProcessCwd(item.pid, options);
    const mapped = markControlSession(mapSessionToProjects({
      pid: item.pid,
      ppid: item.ppid,
      tty: item.tty,
      command: item.command,
      cwd: cwdResult.cwd,
      cwdStatus: cwdResult.status,
      cwdReason: cwdResult.reason ?? null,
      pane: null,
      terminal: item.tty && itermByTty.has(`/dev/${item.tty}`)
        ? itermByTty.get(`/dev/${item.tty}`)
        : item.tty && itermByTty.has(item.tty) ? itermByTty.get(item.tty) : null,
    }, projects), options.controlSessionPaths);
    if (!options.collectLiveness || mapped.mappingStatus !== 'mapped') return mapped;
    const project = projects.find((candidate) => candidate.id === mapped.projectId);
    if (!project) return mapped;
    return {
      ...mapped,
      heartbeat: await sessionHeartbeat(mapped, project, processes, options),
    };
  }));
  return {
    status: 'ok',
    reason: null,
    total: discovered.length,
    mapped: discovered.filter((session) => session.mappingStatus === 'mapped').length,
    control: discovered.filter((session) => session.mappingStatus === 'control').length,
    unmapped: discovered.filter((session) => session.mappingStatus === 'unmapped').length,
    ambiguous: discovered.filter((session) => session.mappingStatus === 'ambiguous').length,
    items: discovered,
    processes,
    terminalStatus: iterm.status,
    terminalReason: iterm.reason,
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function readAllowedFile(project, name) {
  const sourceName = name === 'prompt.txt'
    ? (project.bootstrapFile || name)
    : name;
  const path = join(project.path, sourceName);
  try {
    const content = await readFile(path, 'utf8');
    return {
      name,
      sourceName,
      path,
      status: 'ok',
      bytes: Buffer.byteLength(content),
      sha256: sha256(content),
      content,
    };
  } catch (error) {
    return {
      name,
      sourceName,
      path,
      status: 'missing',
      reason: error.code === 'ENOENT' ? 'file_missing' : 'file_unreadable',
      detail: error.code || error.message,
      bytes: null,
      sha256: null,
      content: null,
    };
  }
}

function parseIdentity(file) {
  if (file.status !== 'ok') return { status: 'unavailable', reason: file.reason };
  try {
    const value = JSON.parse(file.content);
    const origin = value.origin || {};
    const current = value.current || {};
    return {
      status: 'ok',
      projectId: value.project_id ?? null,
      identityVersion: value.identity_version ?? null,
      arena: origin.research_arena ?? current.research_arena ?? null,
      canonicalObject: origin.canonical_object ?? origin.research_object
        ?? current.canonical_object ?? current.research_object ?? null,
      primaryOutcome: origin.primary_outcome ?? origin.value_metric
        ?? current.primary_outcome ?? current.value_metric ?? null,
      secondaryConstraints: origin.secondary_constraints ?? current.secondary_constraints ?? null,
      outsideScope: value.outside_scope ?? origin.outside_scope ?? current.outside_scope ?? null,
      currentStatus: current.status ?? value.transition_authority?.status ?? null,
      value,
    };
  } catch (error) {
    return { status: 'degraded', reason: 'invalid_identity_json', detail: error.message };
  }
}

function parseProgramAuthority(file) {
  if (file?.status !== 'ok') return {};
  const labels = {
    arena: ['Research arena', '研究场域'],
    canonicalObject: ['Canonical object', 'canonical object'],
    primaryOutcome: ['Primary outcome', 'primary outcome'],
    secondaryConstraints: ['Secondary constraints', 'secondary constraints'],
    evidenceSurface: ['Standard evidence surface', '标准证据面'],
    baselineCommunity: ['Baseline community', 'baseline community'],
    outsideScope: ['Explicitly outside scope', '明确不做'],
  };
  const lines = String(file.content).split('\n').map((line) => line.trim());
  return Object.fromEntries(Object.entries(labels).flatMap(([field, candidates]) => {
    const line = lines.find((value) => candidates.some((label) => (
      value.toLowerCase().startsWith(`- ${label.toLowerCase()}:`)
    )));
    if (!line) return [];
    return [[field, line.slice(line.indexOf(':') + 1).trim().replace(/^`|`$/g, '')]];
  }));
}

export async function collectTmux() {
  const result = await run('tmux', [
    'list-panes', '-a',
    '-F', '#{pane_id}\t#{pane_pid}\t#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_current_path}\t#{pane_current_command}',
  ]);
  if (!result.ok) {
    const missing = result.code === 'ENOENT';
    return {
      status: 'degraded',
      available: false,
      reason: missing ? 'tmux_not_installed' : 'tmux_server_unavailable',
      panes: [],
    };
  }
  const panes = result.stdout ? result.stdout.split('\n').map((line) => {
    const [target, pid, session, window, pane, cwd, command] = line.split('\t');
    return { target, pid: Number(pid), session, window: Number(window), pane: Number(pane), cwd, command };
  }) : [];
  return { status: 'ok', available: true, panes };
}

async function capturePaneTail(pane, lines = 80) {
  const result = await run('tmux', ['capture-pane', '-p', '-t', pane.target, '-S', `-${lines}`]);
  if (!result.ok) {
    return {
      status: 'degraded',
      reason: 'pane_capture_failed',
      detail: result.stderr,
      ...pane,
      tail: null,
      tailSha256: null,
    };
  }
  return {
    status: 'ok',
    ...pane,
    tail: result.stdout,
    tailSha256: sha256(result.stdout),
    capturedLines: result.stdout ? result.stdout.split('\n').length : 0,
  };
}

export async function collectSnapshot(projects, now = new Date(), options = {}) {
  const [tmux, sessionResult] = await Promise.all([
    options.collectTmux ? options.collectTmux() : collectTmux(),
    collectClaudeSessions(projects, options),
  ]);
  const sessions = await Promise.all(sessionResult.items.map(async (session) => {
    if (!tmux.available) return session;
    const pane = paneForProcess(session, sessionResult.processes, tmux.panes);
    return pane ? { ...session, pane: await capturePaneTail(pane) } : session;
  }));
  const projectData = await Promise.all(projects.map(async (project) => {
    const files = await Promise.all(ALLOWED_FILES.map((name) => readAllowedFile(project, name)));
    const projectSessions = sessions.filter((session) => session.projectId === project.id);
    const panes = projectSessions.map((session) => session.pane).filter(Boolean);
    const identityFile = files.find((file) => file.name === 'PROJECT_IDENTITY.json');
    const programFile = files.find((file) => file.name === 'PROGRAM_ORIGIN.md');
    const stateFile = files.find((file) => file.name === 'PIPELINE_STATE.md');
    const parsedIdentity = parseIdentity(identityFile);
    const programAuthority = parseProgramAuthority(programFile);
    return {
      id: project.id,
      name: project.name,
      path: project.path,
      expected: project.expected || {},
      identity: parsedIdentity.status === 'ok' ? {
        ...parsedIdentity,
        arena: parsedIdentity.arena || programAuthority.arena || null,
        canonicalObject: parsedIdentity.canonicalObject || programAuthority.canonicalObject || null,
        primaryOutcome: programAuthority.primaryOutcome || parsedIdentity.primaryOutcome || null,
        secondaryConstraints: programAuthority.secondaryConstraints
          || parsedIdentity.secondaryConstraints || null,
        evidenceSurface: programAuthority.evidenceSurface || null,
        baselineCommunity: programAuthority.baselineCommunity || null,
        outsideScope: parsedIdentity.outsideScope || programAuthority.outsideScope || null,
      } : parsedIdentity,
      files,
      researchMaturity: parseResearchMaturity(
        stateFile?.status === 'ok' ? stateFile.content : '',
      ),
      sessions: projectSessions,
      tmux: {
        status: tmux.status,
        available: tmux.available,
        reason: tmux.reason ?? null,
        panes,
      },
    };
  }));
  return {
    schemaVersion: 3,
    collectedAt: now.toISOString(),
    mode: 'shadow-read-only',
    collectionPolicy: {
      files: [...ALLOWED_FILES],
      commands: ['ps -axo pid=,ppid=,tty=,command=', 'lsof -a -p <pid> -d cwd -Fn (macOS)', 'readlink /proc/<pid>/cwd (Linux)', 'osascript iTerm status snapshot (macOS)', 'tmux list-panes', 'tmux capture-pane'],
      prohibited: ['git', 'nvidia-smi', 'GPU queue mutation', 'project mutation'],
    },
    sessions: {
      status: sessionResult.status,
      reason: sessionResult.reason,
      total: sessions.length,
      mapped: sessions.filter((session) => session.mappingStatus === 'mapped').length,
      control: sessions.filter((session) => session.mappingStatus === 'control').length,
      unmapped: sessions.filter((session) => session.mappingStatus === 'unmapped').length,
      ambiguous: sessions.filter((session) => session.mappingStatus === 'ambiguous').length,
      items: sessions,
    },
    projects: projectData,
  };
}
