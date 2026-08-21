import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function expand(value) {
  const defaults = {
    FIRM_PROJECT_ROOT: dirname(ROOT),
    ARENA_LOCKED_ROOT: join(dirname(ROOT), 'replacements', 'arena_locked'),
    RESEARCH_PROJECT_ROOT: join(homedir(), 'research'),
  };
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => process.env[key] ?? defaults[key] ?? '');
}

async function resolveExecutable(value) {
  if (value.includes('/')) return resolve(value);
  for (const directory of String(process.env.PATH || '').split(':').filter(Boolean)) {
    const candidate = join(directory, value);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 继续检查 PATH 中的下一个目录。
    }
  }
  throw new Error(`Executable not found in PATH: ${value}`);
}

export async function loadConfig() {
  const defaultConfigPath = join(ROOT, 'config', 'projects.json');
  let configPath = resolve(process.env.FIRM_CONFIG || defaultConfigPath);
  if (!process.env.FIRM_CONFIG) {
    try {
      await access(configPath, constants.R_OK);
    } catch {
      configPath = join(ROOT, 'config', 'projects.example.json');
    }
  }
  const projects = JSON.parse(await readFile(configPath, 'utf8')).map((project) => ({
    ...project,
    path: resolve(expand(project.path)),
    sessionPathAliases: (project.sessionPathAliases || []).map((path) => resolve(expand(path))),
  }));
  const ids = new Set();
  for (const project of projects) {
    if (!project.id || !project.name || !project.path || ids.has(project.id)) {
      throw new Error(`Invalid or duplicate project configuration: ${project.id || '<missing>'}`);
    }
    if (!Array.isArray(project.sessionPathAliases)
        || project.sessionPathAliases.some((path) => typeof path !== 'string' || !path)) {
      throw new Error(`Invalid sessionPathAliases configuration: ${project.id}`);
    }
    if (project.bootstrapFile
        && !['prompt.txt', 'START_PROMPT.md'].includes(project.bootstrapFile)) {
      throw new Error(`Invalid bootstrapFile configuration: ${project.id}`);
    }
    ids.add(project.id);
  }
  if (!projects.length) throw new Error('Configuration must contain at least one project');
  const scanIntervalMs = Number(process.env.FIRM_SCAN_INTERVAL_MS ?? 2.5 * 60 * 60 * 1000);
  if (!Number.isFinite(scanIntervalMs) || scanIntervalMs < 0) {
    throw new Error('FIRM_SCAN_INTERVAL_MS must be a non-negative number');
  }
  const sessionBufferBytes = Number(process.env.FIRM_SESSION_BUFFER_BYTES ?? 1024 * 1024);
  if (!Number.isSafeInteger(sessionBufferBytes) || sessionBufferBytes < 1) {
    throw new Error('FIRM_SESSION_BUFFER_BYTES must be a positive safe integer');
  }
  const claudeExecutable = await resolveExecutable(process.env.FIRM_CLAUDE_EXECUTABLE || 'claude');
  let sshExecutable = null;
  try {
    sshExecutable = await resolveExecutable(process.env.FIRM_SSH_EXECUTABLE || 'ssh');
  } catch {
    // Local session management remains usable when SSH is unavailable.
  }
  const gpuQueueEnabled = !/^(?:0|false|off)$/i.test(
    String(process.env.FIRM_GPU_QUEUE_ENABLED ?? 'false'),
  );
  const gpuQueueDockerContainer = String(
    process.env.FIRM_GPU_QUEUE_DOCKER_CONTAINER || '',
  ).trim();
  if (gpuQueueDockerContainer
      && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(gpuQueueDockerContainer)) {
    throw new Error('FIRM_GPU_QUEUE_DOCKER_CONTAINER must be a Docker name or id');
  }
  const gpuSchedulerAutoStart = !/^(?:0|false|off)$/i.test(
    String(process.env.FIRM_GPU_SCHEDULER_AUTO_START ?? 'false'),
  );
  const gpuRunnerEnsureEnabled = !/^(?:0|false|off)$/i.test(
    String(process.env.FIRM_GPU_QUEUE_RUNNER_ENSURE ?? 'true'),
  );
  const gpuQueuePollMs = Number(process.env.FIRM_GPU_QUEUE_POLL_MS ?? 60 * 1000);
  const gpuQueueTimeoutMs = Number(process.env.FIRM_GPU_QUEUE_TIMEOUT_MS ?? 15 * 1000);
  const watchdogPollMs = Number(process.env.FIRM_WATCHDOG_POLL_MS ?? 15 * 1000);
  const watchdogWaitingMs = Number(process.env.FIRM_WATCHDOG_WAITING_MS ?? 15 * 60 * 1000);
  const unknownStallMs = Number(process.env.FIRM_UNKNOWN_STALL_MS ?? 3 * 60 * 1000);
  const progressStallMs = Number(process.env.FIRM_PROGRESS_STALL_MS ?? 8 * 60 * 1000);
  const toolProgressStallMs = Number(
    process.env.FIRM_TOOL_PROGRESS_STALL_MS ?? 30 * 60 * 1000,
  );
  for (const [name, value, minimum] of [
    ['FIRM_GPU_QUEUE_POLL_MS', gpuQueuePollMs, 1000],
    ['FIRM_GPU_QUEUE_TIMEOUT_MS', gpuQueueTimeoutMs, 1000],
    ['FIRM_WATCHDOG_POLL_MS', watchdogPollMs, 1000],
    ['FIRM_WATCHDOG_WAITING_MS', watchdogWaitingMs, 60 * 1000],
    ['FIRM_UNKNOWN_STALL_MS', unknownStallMs, 60 * 1000],
    ['FIRM_PROGRESS_STALL_MS', progressStallMs, 60 * 1000],
    ['FIRM_TOOL_PROGRESS_STALL_MS', toolProgressStallMs, 5 * 60 * 1000],
  ]) {
    if (!Number.isFinite(value) || value < minimum) {
      throw new Error(`${name} must be at least ${minimum}`);
    }
  }
  const continuityEnabled = !/^(?:0|false|off)$/i.test(
    String(process.env.FIRM_CONTINUITY_ENABLED ?? 'false'),
  );
  const continuitySettleMs = Number(process.env.FIRM_CONTINUITY_SETTLE_MS ?? 30 * 1000);
  const continuityTimeoutMs = Number(process.env.FIRM_CONTINUITY_TIMEOUT_MS ?? 5 * 60 * 1000);
  const continuityRetryMs = Number(process.env.FIRM_CONTINUITY_RETRY_MS ?? 60 * 1000);
  const continuityMaxConcurrent = Number(process.env.FIRM_CONTINUITY_MAX_CONCURRENT ?? 2);
  for (const [name, value, minimum] of [
    ['FIRM_CONTINUITY_SETTLE_MS', continuitySettleMs, 0],
    ['FIRM_CONTINUITY_TIMEOUT_MS', continuityTimeoutMs, 30 * 1000],
    ['FIRM_CONTINUITY_RETRY_MS', continuityRetryMs, 10 * 1000],
    ['FIRM_CONTINUITY_MAX_CONCURRENT', continuityMaxConcurrent, 1],
  ]) {
    if (!Number.isFinite(value) || value < minimum) {
      throw new Error(`${name} must be at least ${minimum}`);
    }
  }
  if (!Number.isSafeInteger(continuityMaxConcurrent)) {
    throw new Error('FIRM_CONTINUITY_MAX_CONCURRENT must be an integer');
  }
  let codexExecutable = null;
  if (continuityEnabled) {
    codexExecutable = await resolveExecutable(
      process.env.FIRM_CODEX_EXECUTABLE || '/Applications/ChatGPT.app/Contents/Resources/codex',
    );
  }
  const defaultControlPaths = [...new Set(projects.map((project) => dirname(project.path)))];
  const controlSessionPaths = String(process.env.FIRM_CONTROL_SESSION_PATHS || '')
    .split(':')
    .filter(Boolean)
    .map((path) => resolve(expand(path)));
  const resolvedControlPaths = controlSessionPaths.length ? controlSessionPaths : defaultControlPaths;
  const researchPromptPath = resolve(expand(
    process.env.FIRM_RESEARCH_PROMPT_PATH
      || join(homedir(), '.claude', 'CLAUDE-RESEARCH.md'),
  ));
  const claudeArgs = ['--append-system-prompt-file', researchPromptPath];
  const gpuSchedulerArgs = [
    '--effort',
    'low',
    '--dangerously-skip-permissions',
    '--disable-slash-commands',
    '--disallowedTools',
    'WebSearch,WebFetch,Edit,Write,NotebookEdit,Agent',
  ];
  const controlTargets = gpuQueueEnabled && gpuSchedulerAutoStart && resolvedControlPaths.length ? [
    {
      id: 'GPU_SCHEDULER',
      name: 'GPU Scheduler',
      kind: 'control',
      path: resolvedControlPaths[0],
      args: gpuSchedulerArgs,
      bootstrapFile: 'GPU_SCHEDULER_START_PROMPT.md',
      bootstrapRequiredFiles: [
        'CLAUDE.md',
        'GPU_QUEUE_SPEC.md',
        'GPU_SUBMISSION_READINESS.md',
        'GPU_TELEMETRY_PROTOCOL.md',
        'GPU_SCHEDULER_START_PROMPT.md',
      ],
    },
  ] : [];
  const sessionTargets = [
    ...projects.map((project) => ({
      ...project,
      kind: 'research',
      args: claudeArgs,
      bootstrapFile: project.bootstrapFile || 'prompt.txt',
      bootstrapRequiredFiles: [
        researchPromptPath,
        project.bootstrapFile || 'prompt.txt',
      ],
    })),
    ...controlTargets,
  ];
  const dataDir = resolve(process.env.FIRM_DATA_DIR || join(ROOT, 'var'));
  const scanRetention = Number(process.env.FIRM_SCAN_RETENTION ?? 50);
  const gpuSnapshotRetention = Number(process.env.FIRM_GPU_SNAPSHOT_RETENTION ?? 200);
  if (!Number.isSafeInteger(scanRetention) || scanRetention < 10) {
    throw new Error('FIRM_SCAN_RETENTION must be an integer of at least 10');
  }
  if (!Number.isSafeInteger(gpuSnapshotRetention) || gpuSnapshotRetention < 20) {
    throw new Error('FIRM_GPU_SNAPSHOT_RETENTION must be an integer of at least 20');
  }
  const brokerAutoStart = !/^(?:0|false|off)$/i.test(
    String(process.env.FIRM_BROKER_AUTOSTART ?? 'true'),
  );
  return {
    root: ROOT,
    configPath,
    projects,
    dataDir,
    historyRetention: { scans: scanRetention, gpuSnapshots: gpuSnapshotRetention },
    host: process.env.FIRM_HOST || '127.0.0.1',
    port: Number(process.env.FIRM_PORT || 8787),
    scanIntervalMs,
    claudeExecutable,
    claudeArgs,
    researchPromptPath,
    claudeProjectsDir: resolve(process.env.FIRM_CLAUDE_PROJECTS_DIR
      || join(homedir(), '.claude', 'projects')),
    gpuQueue: {
      enabled: gpuQueueEnabled,
      sshExecutable,
      host: process.env.FIRM_GPU_QUEUE_HOST || '',
      port: Number(process.env.FIRM_GPU_QUEUE_SSH_PORT || 22),
      root: process.env.FIRM_GPU_QUEUE_ROOT || '',
      dockerContainer: gpuQueueDockerContainer || null,
      pollMs: gpuQueuePollMs,
      timeoutMs: gpuQueueTimeoutMs,
      schedulerAutoStart: gpuSchedulerAutoStart,
      runnerEnsureEnabled: gpuRunnerEnsureEnabled,
      runnerPath: String(process.env.FIRM_GPU_QUEUE_RUNNER_PATH || '').trim() || null,
      schedulerMonitorPidFile: gpuRunnerEnsureEnabled ? null : resolve(
        process.env.FIRM_GPU_SCHEDULER_MONITOR_PID_FILE
          || '/tmp/gpu_scheduler_global_monitor.pid',
      ),
    },
    watchdog: {
      pollMs: watchdogPollMs,
      waitingMs: watchdogWaitingMs,
      unknownStallMs,
      progressStallMs,
      toolProgressStallMs,
      enterRetryMs: 2_000,
      postAckStallMs: 60_000,
    },
    continuity: {
      enabled: continuityEnabled,
      codexExecutable,
      model: String(process.env.FIRM_CONTINUITY_MODEL || '').trim() || null,
      settleMs: continuitySettleMs,
      timeoutMs: continuityTimeoutMs,
      retryMs: continuityRetryMs,
      maxConcurrent: continuityMaxConcurrent,
    },
    controlSessionPaths: resolvedControlPaths,
    controlTargets,
    sessionTargets,
    sessionControlDir: resolve(
      process.env.FIRM_SESSION_CONTROL_DIR || join(ROOT, 'var', 'control-plane', 'sessions'),
    ),
    sessionBufferBytes,
    brokerSocketPath: resolve(
      process.env.FIRM_BROKER_SOCKET
        || join(dataDir, 'control-plane', 'broker.sock'),
    ),
    brokerAutoStart,
  };
}
