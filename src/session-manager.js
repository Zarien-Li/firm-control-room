import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { classifyItermTail } from './iterm-status.js';

export const SESSION_STATES = Object.freeze([
  'CREATING',
  'RUNNING',
  'RATE_LIMITED',
  'WAITING_INPUT',
  'STOPPING',
  'EXITED',
  'FAILED',
  'LOST',
]);
const ACTIVE_STATES = new Set(['RUNNING', 'RATE_LIMITED', 'WAITING_INPUT']);
const CLAUDE_READY_PATTERN = /(?:^|[\r\n])\s*❯(?!\s*\d+\.)[^\r\n]*/;
const CONFIRMATION_PATTERN = /do you want to proceed|would you like to|press enter to continue|enter to confirm|allow this action|quick safety check/i;
const WAITING_PATTERN = new RegExp(
  `${CLAUDE_READY_PATTERN.source}|${CONFIRMATION_PATTERN.source}`,
  'i',
);

function terminalText(value) {
  return String(value)
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

export class SessionError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'SessionError';
    this.code = code;
    this.status = status;
  }
}

function positiveInteger(value, name, maximum) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new SessionError('invalid_dimensions', `${name} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

export class SessionManager {
  constructor({
    projects,
    executable,
    args = [],
    controlDir,
    pty,
    bufferBytes = 1024 * 1024,
    now = () => new Date(),
    idFactory = randomUUID,
  }) {
    if (!Array.isArray(projects) || !projects.length) throw new Error('projects are required');
    if (typeof executable !== 'string' || !isAbsolute(executable)) {
      throw new Error('executable must be an absolute path');
    }
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      throw new Error('args must be a fixed string array');
    }
    if (typeof controlDir !== 'string' || !isAbsolute(controlDir)) {
      throw new Error('controlDir must be absolute');
    }
    if (!pty || typeof pty.spawn !== 'function') throw new Error('pty.spawn is required');
    if (typeof pty.name !== 'string' || !pty.name) throw new Error('pty.name is required');
    if (!pty.capabilities || typeof pty.capabilities.resize !== 'boolean') {
      throw new Error('pty.capabilities.resize is required');
    }
    this.projects = new Map(projects.map((project) => [project.id, project]));
    this.executable = executable;
    this.args = [...args];
    this.controlDir = controlDir;
    this.pty = pty;
    this.bufferBytes = positiveInteger(bufferBytes, 'bufferBytes', 64 * 1024 * 1024);
    this.now = now;
    this.idFactory = idFactory;
    this.sessions = new Map();
    mkdirSync(this.controlDir, { recursive: true, mode: 0o700 });
    this.#restore();
  }

  async start(projectId, dimensions = {}) {
    const project = this.projects.get(projectId);
    if (!project) throw new SessionError('project_not_found', 'Project is not configured', 404);
    if ([...this.sessions.values()].some((session) => (
      session.projectId === projectId && ACTIVE_STATES.has(session.status)
    ))) {
      throw new SessionError('session_already_running', 'This target already has a managed session', 409);
    }
    const cols = positiveInteger(dimensions.cols ?? 120, 'cols', 1000);
    const rows = positiveInteger(dimensions.rows ?? 32, 'rows', 1000);
    const targetArgs = Array.isArray(project.args) ? [...project.args] : [...this.args];
    const bootstrapFile = project.bootstrapFile || 'prompt.txt';
    const bootstrapBasePath = project.bootstrapBasePath || project.path;
    const requiredFiles = project.bootstrapRequiredFiles
      || ['CLAUDE-RESEARCH.md', bootstrapFile];
    const bootstrapEnabled = dimensions.bootstrap === true;
    let bootstrapPrompt = null;
    if (bootstrapEnabled) {
      const missing = requiredFiles.filter((name) => !existsSync(join(bootstrapBasePath, name)));
      const promptPath = join(bootstrapBasePath, bootstrapFile);
      if (missing.length) {
        throw new SessionError(
          'project_bootstrap_missing',
          `Automatic bootstrap requires: ${requiredFiles.join(', ')}`,
          409,
        );
      }
      bootstrapPrompt = readFileSync(promptPath, 'utf8').trim();
      if (!bootstrapPrompt || Buffer.byteLength(bootstrapPrompt) > 64 * 1024) {
        throw new SessionError(
          'invalid_project_prompt',
          `${bootstrapFile} must be non-empty and no larger than 64 KiB`,
          409,
        );
      }
    }
    const id = this.idFactory();
    const directory = join(this.controlDir, id);
    const transcriptPath = join(directory, 'transcript.ndjson');
    const outputPath = join(directory, 'output.bin');
    mkdirSync(directory, { recursive: false, mode: 0o700 });

    const session = {
      id,
      projectId,
      projectName: project.name,
      targetKind: project.kind || 'research',
      bootstrapFile,
      status: 'CREATING',
      pid: null,
      cols,
      rows,
      backend: this.pty.name,
      capabilities: { ...this.pty.capabilities },
      createdAt: this.now().toISOString(),
      lastActivityAt: this.now().toISOString(),
      lastOutputAt: null,
      waitingSince: null,
      waitReason: null,
      exitedAt: null,
      exitCode: null,
      signal: null,
      stopRequestedAt: null,
      transcriptPath,
      outputPath,
      terminal: null,
      buffer: Buffer.alloc(0),
      cursor: 0,
      recentOutput: '',
      stateTimer: null,
      rateLimitTimer: null,
      rateLimitResetAt: null,
      bootstrapPrompt,
      bootstrapStatus: bootstrapEnabled ? 'PENDING' : 'DISABLED',
      bootstrapSentAt: null,
      bootstrapNeedsRetry: false,
    };
    this.sessions.set(id, session);
    this.#persist(session);

    let terminal;
    try {
      terminal = this.pty.spawn(this.executable, targetArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: project.path,
        env: { ...process.env, TERM: 'xterm-256color' },
      });
    } catch (error) {
      session.status = 'FAILED';
      session.exitedAt = this.now().toISOString();
      this.#record(session, {
        type: 'spawn_error',
        at: session.exitedAt,
        message: error.message,
      });
      this.#persist(session);
      throw new SessionError('spawn_failed', 'Claude Code could not be started', 500);
    }

    session.status = 'RUNNING';
    session.pid = terminal.pid ?? null;
    session.terminal = terminal;
    this.#persist(session);
    this.#record(session, {
      type: 'start',
      at: session.createdAt,
      sessionId: id,
      projectId,
      executable: this.executable,
      args: targetArgs,
      backend: session.backend,
      capabilities: session.capabilities,
      cols,
      rows,
    });
    terminal.onData((data) => this.#onData(session, data));
    terminal.onExit((event) => this.#onExit(session, event));
    return this.#summary(session);
  }

  list() {
    return [...this.sessions.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((session) => this.#summary(session));
  }

  get(id) {
    const session = this.sessions.get(id);
    if (!session) throw new SessionError('session_not_found', 'Session was not found', 404);
    return session;
  }

  output(id, requestedCursor = 0) {
    const session = this.get(id);
    if (!Number.isSafeInteger(requestedCursor) || requestedCursor < 0) {
      throw new SessionError('invalid_cursor', 'cursor must be a non-negative safe integer');
    }
    const availableFrom = session.cursor - session.buffer.length;
    const from = Math.max(requestedCursor, availableFrom);
    const offset = Math.min(Math.max(from - availableFrom, 0), session.buffer.length);
    return {
      session: this.#summary(session),
      cursor: from,
      nextCursor: session.cursor,
      truncated: requestedCursor < availableFrom,
      data: session.buffer.subarray(offset).toString('utf8'),
    };
  }

  input(id, data) {
    const session = this.#running(id);
    if (typeof data !== 'string' || data.length === 0 || Buffer.byteLength(data) > 64 * 1024) {
      throw new SessionError('invalid_input', 'data must be a non-empty string no larger than 64 KiB');
    }
    this.#writeInput(session, data, 'manual');
    return this.#summary(session);
  }

  bootstrap(id) {
    const session = this.#running(id);
    if (session.bootstrapStatus === 'SENT' && !session.bootstrapNeedsRetry) {
      throw new SessionError('bootstrap_already_sent', 'Project prompt was already sent', 409);
    }
    const project = this.projects.get(session.projectId);
    const promptName = project.bootstrapFile || session.bootstrapFile || 'prompt.txt';
    const promptPath = join(project.bootstrapBasePath || project.path, promptName);
    if (!existsSync(promptPath)) {
      throw new SessionError('project_prompt_missing', `${promptName} is missing`, 409);
    }
    const prompt = readFileSync(promptPath, 'utf8').trim();
    if (!prompt || Buffer.byteLength(prompt) > 64 * 1024) {
      throw new SessionError('invalid_project_prompt', `${promptName} is invalid`, 409);
    }
    session.bootstrapPrompt = prompt;
    session.bootstrapStatus = 'PENDING';
    session.bootstrapNeedsRetry = false;
    this.#sendBootstrap(session, 'manual_request');
    return this.#summary(session);
  }

  interrupt(id) {
    const session = this.#running(id);
    session.terminal.write('\x03');
    this.#record(session, { type: 'interrupt', at: this.now().toISOString() });
    return this.#summary(session);
  }

  resize(id, cols, rows) {
    const session = this.#running(id);
    if (!session.capabilities.resize) {
      throw new SessionError(
        'unsupported_capability',
        `PTY backend ${session.backend} does not support resize`,
        501,
      );
    }
    const nextCols = positiveInteger(cols, 'cols', 1000);
    const nextRows = positiveInteger(rows, 'rows', 1000);
    session.terminal.resize(nextCols, nextRows);
    session.cols = nextCols;
    session.rows = nextRows;
    this.#record(session, {
      type: 'resize',
      at: this.now().toISOString(),
      cols: session.cols,
      rows: session.rows,
    });
    return this.#summary(session);
  }

  stop(id) {
    const session = this.#running(id);
    session.status = 'STOPPING';
    session.stopRequestedAt = this.now().toISOString();
    this.#persist(session);
    session.terminal.kill('SIGTERM');
    this.#record(session, { type: 'stop_requested', at: this.now().toISOString() });
    return this.#summary(session);
  }

  async close({ terminate = false } = {}) {
    if (!terminate) return;
    for (const session of this.sessions.values()) {
      if (ACTIVE_STATES.has(session.status)) session.terminal?.kill('SIGTERM');
    }
  }

  #running(id) {
    const session = this.get(id);
    if (!ACTIVE_STATES.has(session.status)) {
      throw new SessionError('session_not_running', 'Session is not running', 409);
    }
    return session;
  }

  #onData(session, value) {
    const activityAt = this.now().toISOString();
    const data = Buffer.from(value);
    session.cursor += data.length;
    session.buffer = Buffer.concat([session.buffer, data]);
    if (session.buffer.length > this.bufferBytes) {
      session.buffer = session.buffer.subarray(session.buffer.length - this.bufferBytes);
    }
    appendFileSync(session.outputPath, data, { mode: 0o600 });
    if (session.status !== 'STOPPING') session.status = 'RUNNING';
    session.lastActivityAt = activityAt;
    session.lastOutputAt = activityAt;
    session.waitingSince = null;
    session.waitReason = null;
    session.recentOutput = `${session.recentOutput}${terminalText(value)}`.slice(-4096);
    if (/not logged in|please run \/login|run \/login/i.test(session.recentOutput)) {
      session.bootstrapNeedsRetry = session.bootstrapStatus === 'SENT';
    }
    if (session.stateTimer) clearTimeout(session.stateTimer);
    if (session.rateLimitTimer) clearTimeout(session.rateLimitTimer);
    const terminalState = classifyItermTail(session.recentOutput, { now: this.now() });
    if (terminalState.state === 'RATE_LIMITED') {
      session.status = 'RATE_LIMITED';
      session.rateLimitResetAt = terminalState.resetAt;
      session.waitReason = 'provider_rate_limit';
      const delay = Math.max(0, Date.parse(terminalState.resetAt) - this.now().getTime()) + 250;
      session.rateLimitTimer = setTimeout(() => {
        session.rateLimitTimer = null;
        if (session.status !== 'RATE_LIMITED'
            || session.rateLimitResetAt !== terminalState.resetAt) return;
        session.status = 'WAITING_INPUT';
        session.waitingSince = this.now().toISOString();
        session.waitReason = 'provider_rate_limit_reset_elapsed';
        this.#persist(session);
        this.#record(session, {
          type: 'state', at: this.now().toISOString(), status: session.status,
          reason: 'provider_rate_limit_reset_elapsed', resetAt: terminalState.resetAt,
        });
      }, delay);
      session.rateLimitTimer.unref?.();
    } else {
      session.rateLimitResetAt = terminalState.lastRateLimitResetAt || null;
      session.stateTimer = setTimeout(() => {
      session.stateTimer = null;
      if (session.status === 'RUNNING' && WAITING_PATTERN.test(session.recentOutput.trimEnd())) {
        session.status = 'WAITING_INPUT';
        session.waitingSince = this.now().toISOString();
        session.waitReason = CONFIRMATION_PATTERN.test(session.recentOutput)
          ? 'interactive_confirmation' : 'claude_prompt';
        this.#persist(session);
        this.#record(session, {
          type: 'state',
          at: this.now().toISOString(),
          status: session.status,
          reason: 'interactive_prompt_observed',
        });
        if (session.bootstrapStatus === 'PENDING'
            && CLAUDE_READY_PATTERN.test(session.recentOutput.trimEnd())) {
          this.#sendBootstrap(session, 'claude_ready_prompt');
        }
      }
      }, 250);
      session.stateTimer.unref?.();
    }
    this.#persist(session);
    this.#record(session, {
      type: 'output',
      at: this.now().toISOString(),
      cursor: session.cursor,
      data: value,
    });
  }

  #onExit(session, event = {}) {
    if (session.status === 'EXITED') return;
    if (session.stateTimer) clearTimeout(session.stateTimer);
    session.stateTimer = null;
    if (session.rateLimitTimer) clearTimeout(session.rateLimitTimer);
    session.rateLimitTimer = null;
    session.rateLimitResetAt = null;
    session.status = 'EXITED';
    session.exitedAt = this.now().toISOString();
    session.exitCode = Number.isInteger(event.exitCode) ? event.exitCode : null;
    session.signal = event.signal ?? null;
    session.terminal = null;
    this.#persist(session);
    this.#record(session, {
      type: 'exit',
      at: session.exitedAt,
      exitCode: session.exitCode,
      signal: session.signal,
      stopRequestedAt: session.stopRequestedAt || null,
    });
  }

  #writeInput(session, data, source) {
    const splitSubmit = data.endsWith('\r') && Buffer.byteLength(data) > 256;
    session.terminal.write(splitSubmit ? data.slice(0, -1) : data);
    if (splitSubmit) {
      const submitTimer = setTimeout(() => {
        if (!ACTIVE_STATES.has(session.status) || !session.terminal) return;
        session.terminal.write('\r');
        this.#record(session, {
          type: 'input_submit',
          source,
          at: this.now().toISOString(),
        });
      }, 75);
      submitTimer.unref?.();
    }
    if (session.stateTimer) clearTimeout(session.stateTimer);
    session.stateTimer = null;
    if (session.rateLimitTimer) clearTimeout(session.rateLimitTimer);
    session.rateLimitTimer = null;
    session.rateLimitResetAt = null;
    session.recentOutput = '';
    session.status = 'RUNNING';
    session.lastActivityAt = this.now().toISOString();
    session.waitingSince = null;
    session.waitReason = null;
    this.#persist(session);
    this.#record(session, {
      type: 'input',
      source,
      at: this.now().toISOString(),
      bytes: Buffer.byteLength(data),
      containsNewline: /[\r\n]/.test(data),
      splitSubmit,
    });
  }

  #sendBootstrap(session, reason) {
    if (!session.bootstrapPrompt || session.bootstrapStatus === 'SENT') return;
    const data = `${session.bootstrapPrompt}\r`;
    session.bootstrapStatus = 'SENT';
    session.bootstrapSentAt = this.now().toISOString();
    this.#writeInput(session, data, 'project_prompt');
    this.#record(session, {
      type: 'bootstrap',
      at: session.bootstrapSentAt,
      reason,
      bytes: Buffer.byteLength(session.bootstrapPrompt),
    });
    session.bootstrapPrompt = null;
    this.#persist(session);
  }

  #record(session, event) {
    const line = `${JSON.stringify(event)}\n`;
    try {
      appendFileSync(session.transcriptPath, line, { mode: 0o600 });
    } catch (error) {
      console.error(`Transcript write failed for ${session.id}:`, error);
    }
  }

  #persist(session) {
    const statePath = join(this.controlDir, session.id, 'state.json');
    const temporary = `${statePath}.${process.pid}.tmp`;
    const value = JSON.stringify(this.#summary(session), null, 2);
    writeFileSync(temporary, `${value}\n`, { mode: 0o600 });
    renameSync(temporary, statePath);
  }

  #restore() {
    for (const entry of readdirSync(this.controlDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(this.controlDir, entry.name);
      const statePath = join(directory, 'state.json');
      if (!existsSync(statePath)) continue;
      try {
        const saved = JSON.parse(readFileSync(statePath, 'utf8'));
        if (!SESSION_STATES.includes(saved.status)) continue;
        const outputPath = join(directory, 'output.bin');
        const allOutput = existsSync(outputPath) ? readFileSync(outputPath) : Buffer.alloc(0);
        const buffer = allOutput.subarray(Math.max(0, allOutput.length - this.bufferBytes));
        const session = {
          ...saved,
          transcriptPath: join(directory, 'transcript.ndjson'),
          outputPath,
          terminal: null,
          buffer,
          cursor: allOutput.length,
          recentOutput: '',
          stateTimer: null,
          rateLimitTimer: null,
          lastActivityAt: saved.lastActivityAt || saved.createdAt || null,
          lastOutputAt: saved.lastOutputAt || null,
          waitingSince: saved.waitingSince || null,
          waitReason: saved.waitReason || null,
        };
        if (['CREATING', 'RUNNING', 'RATE_LIMITED', 'WAITING_INPUT', 'STOPPING'].includes(session.status)) {
          session.status = 'LOST';
          session.exitedAt = this.now().toISOString();
          this.#record(session, {
            type: 'lost',
            at: session.exitedAt,
            reason: 'broker_restarted_without_pty_handle',
            pid: session.pid,
          });
          this.#persist(session);
        }
        this.sessions.set(session.id, session);
      } catch (error) {
        console.error(`Session state restore failed for ${entry.name}:`, error);
      }
    }
  }

  #summary(session) {
    return {
      id: session.id,
      projectId: session.projectId,
      projectName: session.projectName,
      targetKind: session.targetKind || this.projects.get(session.projectId)?.kind || 'research',
      status: session.status,
      pid: session.pid,
      backend: session.backend,
      capabilities: { ...session.capabilities },
      cols: session.cols,
      rows: session.rows,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt || null,
      lastOutputAt: session.lastOutputAt || null,
      waitingSince: session.waitingSince || null,
      waitReason: session.waitReason || null,
      rateLimitResetAt: session.rateLimitResetAt || null,
      exitedAt: session.exitedAt,
      exitCode: session.exitCode,
      signal: session.signal,
      cursor: session.cursor,
      transcriptPath: session.transcriptPath,
      bootstrapStatus: session.bootstrapStatus || 'DISABLED',
      bootstrapSentAt: session.bootstrapSentAt || null,
      bootstrapNeedsRetry: Boolean(session.bootstrapNeedsRetry),
    };
  }
}
