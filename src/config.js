import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
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
  let codexExecutable = null;
  try {
    codexExecutable = await resolveExecutable(process.env.FIRM_CODEX_EXECUTABLE || 'codex');
  } catch {
    // The control plane still works when Codex is temporarily unavailable.
  }
  let sshExecutable = null;
  try {
    sshExecutable = await resolveExecutable(process.env.FIRM_SSH_EXECUTABLE || 'ssh');
  } catch {
    // Local session management remains usable when SSH is unavailable.
  }
  const codexAuditEnabled = !/^(?:0|false|off)$/i.test(
    String(process.env.FIRM_CODEX_AUDIT_ENABLED ?? 'true'),
  );
  const codexAuditTimeoutMs = Number(process.env.FIRM_CODEX_AUDIT_TIMEOUT_MS ?? 10 * 60 * 1000);
  const codexAuditLookbackMs = Number(process.env.FIRM_CODEX_AUDIT_LOOKBACK_MS ?? 5 * 60 * 60 * 1000);
  if (!Number.isFinite(codexAuditTimeoutMs) || codexAuditTimeoutMs < 1000) {
    throw new Error('FIRM_CODEX_AUDIT_TIMEOUT_MS must be at least 1000');
  }
  if (!Number.isFinite(codexAuditLookbackMs) || codexAuditLookbackMs < 60 * 1000) {
    throw new Error('FIRM_CODEX_AUDIT_LOOKBACK_MS must be at least 60000');
  }
  const reanchorMode = String(process.env.FIRM_REANCHOR_MODE || 'approval').toLowerCase();
  if (!['off', 'approval', 'auto'].includes(reanchorMode)) {
    throw new Error('FIRM_REANCHOR_MODE must be off, approval, or auto');
  }
  const reanchorCooldownMs = Number(
    process.env.FIRM_REANCHOR_COOLDOWN_MS ?? 10 * 60 * 60 * 1000,
  );
  if (!Number.isFinite(reanchorCooldownMs) || reanchorCooldownMs < 0) {
    throw new Error('FIRM_REANCHOR_COOLDOWN_MS must be a non-negative number');
  }
  const gpuQueueEnabled = !/^(?:0|false|off)$/i.test(
    String(process.env.FIRM_GPU_QUEUE_ENABLED ?? 'false'),
  );
  const gpuSchedulerAutoStart = !/^(?:0|false|off)$/i.test(
    String(process.env.FIRM_GPU_SCHEDULER_AUTO_START ?? 'false'),
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
  const stopReviewStableMs = Number(process.env.FIRM_STOP_REVIEW_STABLE_MS ?? 15 * 1000);
  const goalContinueGraceMs = Number(process.env.FIRM_GOAL_CONTINUE_GRACE_MS ?? 15 * 1000);
  const goalContinueCooldownMs = Number(
    process.env.FIRM_GOAL_CONTINUE_COOLDOWN_MS ?? 30 * 60 * 1000,
  );
  const goalMaxContinuesPerDay = Number(process.env.FIRM_GOAL_MAX_CONTINUES_PER_DAY ?? 48);
  for (const [name, value, minimum] of [
    ['FIRM_GPU_QUEUE_POLL_MS', gpuQueuePollMs, 1000],
    ['FIRM_GPU_QUEUE_TIMEOUT_MS', gpuQueueTimeoutMs, 1000],
    ['FIRM_WATCHDOG_POLL_MS', watchdogPollMs, 1000],
    ['FIRM_WATCHDOG_WAITING_MS', watchdogWaitingMs, 60 * 1000],
    ['FIRM_UNKNOWN_STALL_MS', unknownStallMs, 60 * 1000],
    ['FIRM_PROGRESS_STALL_MS', progressStallMs, 60 * 1000],
    ['FIRM_TOOL_PROGRESS_STALL_MS', toolProgressStallMs, 5 * 60 * 1000],
    ['FIRM_STOP_REVIEW_STABLE_MS', stopReviewStableMs, 5000],
    ['FIRM_GOAL_CONTINUE_GRACE_MS', goalContinueGraceMs, 10 * 1000],
    ['FIRM_GOAL_CONTINUE_COOLDOWN_MS', goalContinueCooldownMs, 60 * 1000],
  ]) {
    if (!Number.isFinite(value) || value < minimum) {
      throw new Error(`${name} must be at least ${minimum}`);
    }
  }
  if (!Number.isSafeInteger(goalMaxContinuesPerDay)
      || goalMaxContinuesPerDay < 1
      || goalMaxContinuesPerDay > 100) {
    throw new Error('FIRM_GOAL_MAX_CONTINUES_PER_DAY must be an integer from 1 to 100');
  }
  const defaultControlPaths = [...new Set(projects.map((project) => dirname(project.path)))];
  const controlSessionPaths = String(process.env.FIRM_CONTROL_SESSION_PATHS || '')
    .split(':')
    .filter(Boolean)
    .map((path) => resolve(expand(path)));
  const resolvedControlPaths = controlSessionPaths.length ? controlSessionPaths : defaultControlPaths;
  const claudeArgs = ['--append-system-prompt-file', 'CLAUDE-RESEARCH.md'];
  const controlTargets = gpuQueueEnabled && resolvedControlPaths.length ? [
    {
      id: 'GPU_SCHEDULER',
      name: 'GPU Scheduler',
      kind: 'control',
      path: resolvedControlPaths[0],
      args: [],
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
      bootstrapFile: 'prompt.txt',
      bootstrapRequiredFiles: ['CLAUDE-RESEARCH.md', 'prompt.txt'],
    })),
    ...controlTargets,
  ];
  const dataDir = resolve(process.env.FIRM_DATA_DIR || join(ROOT, 'var'));
  return {
    root: ROOT,
    configPath,
    projects,
    dataDir,
    host: process.env.FIRM_HOST || '127.0.0.1',
    port: Number(process.env.FIRM_PORT || 8787),
    scanIntervalMs,
    claudeExecutable,
    claudeArgs,
    codexExecutable,
    codexAuditEnabled,
    codexAuditTimeoutMs,
    codexAuditLookbackMs,
    codexAuditSchemaPath: join(ROOT, 'config', 'codex-audit.schema.json'),
    claudeProjectsDir: resolve(process.env.FIRM_CLAUDE_PROJECTS_DIR
      || join(homedir(), '.claude', 'projects')),
    reanchorMode,
    reanchorCooldownMs,
    gpuQueue: {
      enabled: gpuQueueEnabled,
      sshExecutable,
      host: process.env.FIRM_GPU_QUEUE_HOST || '',
      port: Number(process.env.FIRM_GPU_QUEUE_SSH_PORT || 22),
      root: process.env.FIRM_GPU_QUEUE_ROOT || '',
      pollMs: gpuQueuePollMs,
      timeoutMs: gpuQueueTimeoutMs,
      schedulerAutoStart: gpuSchedulerAutoStart,
      schedulerMonitorPidFile: resolve(
        process.env.FIRM_GPU_SCHEDULER_MONITOR_PID_FILE
          || '/tmp/gpu_scheduler_global_monitor.pid',
      ),
    },
    professor: { mode: 'stateless-codex', intervalMs: scanIntervalMs },
    watchdog: {
      pollMs: watchdogPollMs,
      waitingMs: watchdogWaitingMs,
      unknownStallMs,
      progressStallMs,
      toolProgressStallMs,
      stopReviewStableMs,
    },
    goalLoop: {
      graceMs: goalContinueGraceMs,
      cooldownMs: goalContinueCooldownMs,
      maxContinuesPerDay: goalMaxContinuesPerDay,
      enterRetryMs: 2_000,
      postAckStallMs: 60_000,
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
        || join(tmpdir(), `firm-control-room-${process.getuid?.() ?? 'user'}.sock`),
    ),
  };
}
