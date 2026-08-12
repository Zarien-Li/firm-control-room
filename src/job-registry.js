import { createHash, randomUUID } from 'node:crypto';

export const JOB_KINDS = new Set(['gpu', 'local_cpu', 'remote_cpu', 'ssh']);
export const JOB_STATES = new Set(['pending', 'running', 'done', 'failed', 'cancelled']);
export const ACTIVE_JOB_STATES = new Set(['pending', 'running']);
export const TERMINAL_JOB_STATES = new Set(['done', 'failed', 'cancelled']);
const TRANSITIONS = Object.freeze({
  pending: new Set(['pending', 'running', 'failed', 'cancelled']),
  running: new Set(['running', 'done', 'failed', 'cancelled']),
  done: new Set(['done']), failed: new Set(['failed']), cancelled: new Set(['cancelled']),
});

function requiredString(value, name) {
  const result = String(value || '').trim();
  if (!result) throw new Error(`invalid_job_${name}`);
  return result;
}

function timestamp(value, fallback) {
  if (value && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return fallback;
}

function encodeCursor(job) {
  if (!job) return null;
  return Buffer.from(JSON.stringify({ sortAt: job.finishedAt || job.updatedAt, runId: job.runId }))
    .toString('base64url');
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const cursor = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (!cursor.sortAt || !cursor.runId) throw new Error();
    return { updatedAt: cursor.sortAt, runId: cursor.runId };
  } catch {
    throw new Error('invalid_job_cursor');
  }
}

export class JobRegistry {
  constructor({ store, now = () => new Date() }) {
    this.store = store;
    this.now = now;
  }

  register(input) {
    const now = this.now().toISOString();
    const runId = requiredString(input.runId || `firm-${randomUUID()}`, 'run_id');
    if (!/^[A-Za-z0-9._:-]+$/.test(runId)) throw new Error('invalid_job_run_id');
    const existing = this.store.getJob(runId);
    if (existing) return existing;
    const kind = requiredString(input.kind, 'kind');
    if (!JOB_KINDS.has(kind)) throw new Error('invalid_job_kind');
    const state = input.state || 'pending';
    if (!JOB_STATES.has(state)) throw new Error('invalid_job_state');
    if (kind !== 'gpu' && state === 'running'
        && (!input.pid || !input.pidStartToken || !input.commandFingerprint)) {
      throw new Error('job_process_identity_required');
    }
    const job = this.store.saveJob({
      runId, projectId: requiredString(input.projectId, 'project_id'), kind,
      executor: requiredString(input.executor || kind, 'executor'), state,
      host: input.host || null, pid: input.pid ?? null,
      pidStartToken: input.pidStartToken || null,
      commandFingerprint: input.commandFingerprint || null,
      purpose: input.purpose || '', submittedAt: timestamp(input.submittedAt, now),
      startedAt: state === 'running' ? timestamp(input.startedAt, now) : input.startedAt || null,
      heartbeatAt: timestamp(input.heartbeatAt, now),
      finishedAt: TERMINAL_JOB_STATES.has(state) ? timestamp(input.finishedAt, now) : null,
      progress: input.progress || null, result: input.result || null,
      metadata: {
        ...(input.metadata || {}),
        lifecycleObserved: input.metadata?.lifecycleObserved
          ?? ACTIVE_JOB_STATES.has(state),
      },
      source: input.source || 'api', revision: 1,
    });
    this.store.addJobEvent({
      eventKey: `job:${runId}:registered`, runId, eventType: 'registered',
      fromState: null, toState: state, at: now, payload: { source: job.source },
    });
    return job;
  }

  update(runId, patch) {
    const current = this.store.getJob(requiredString(runId, 'run_id'));
    if (!current) throw new Error('job_not_found');
    const nextState = patch.state || current.state;
    if (!JOB_STATES.has(nextState) || !TRANSITIONS[current.state].has(nextState)) {
      throw new Error(`invalid_job_transition:${current.state}->${nextState}`);
    }
    const identity = {
      pid: patch.pid ?? current.pid,
      pidStartToken: patch.pidStartToken ?? current.pidStartToken,
      commandFingerprint: patch.commandFingerprint ?? current.commandFingerprint,
    };
    if (current.kind !== 'gpu' && nextState === 'running'
        && (!identity.pid || !identity.pidStartToken || !identity.commandFingerprint)) {
      throw new Error('job_process_identity_required');
    }
    if (identity.pid !== null && (!Number.isInteger(identity.pid) || identity.pid < 1)) {
      throw new Error('invalid_job_pid');
    }
    if (identity.commandFingerprint
        && !/^[a-f0-9]{64}$/.test(identity.commandFingerprint)) {
      throw new Error('invalid_job_command_fingerprint');
    }
    if (current.pid !== null && patch.pid !== undefined && patch.pid !== current.pid) {
      throw new Error('job_process_identity_mismatch:pid');
    }
    if (current.pidStartToken && patch.pidStartToken !== undefined
        && patch.pidStartToken !== current.pidStartToken) {
      throw new Error('job_process_identity_mismatch:start_token');
    }
    if (current.commandFingerprint && patch.commandFingerprint !== undefined
        && patch.commandFingerprint !== current.commandFingerprint) {
      throw new Error('job_process_identity_mismatch:command');
    }
    const now = this.now().toISOString();
    const changed = nextState !== current.state;
    const next = this.store.saveJob({
      ...current, ...patch, runId: current.runId,
      projectId: current.projectId, kind: current.kind, executor: current.executor,
      state: nextState, startedAt: current.startedAt
        || (nextState === 'running' ? timestamp(patch.startedAt, now) : null),
      heartbeatAt: timestamp(patch.heartbeatAt, now),
      finishedAt: current.finishedAt
        || (TERMINAL_JOB_STATES.has(nextState) ? timestamp(patch.finishedAt, now) : null),
      progress: patch.progress === undefined ? current.progress : patch.progress,
      result: patch.result === undefined ? current.result : patch.result,
      metadata: patch.replaceMetadata ? (patch.metadata || {})
        : { ...current.metadata, ...(patch.metadata || {}) },
      revision: current.revision + 1,
    });
    if (changed || patch.recordEvent !== false) {
      this.store.addJobEvent({
        eventKey: changed ? `job:${runId}:state:${nextState}` : `job:${runId}:update:${next.revision}`,
        runId, eventType: changed ? 'state_changed' : 'updated',
        fromState: current.state, toState: nextState, at: now,
        payload: { source: patch.source || current.source },
      });
    }
    return next;
  }

  syncGpuQueue(snapshot, projectResolver = (item) => item.project) {
    if (snapshot?.status !== 'ok') return this.snapshot();
    for (const item of snapshot.items || []) {
      const projectId = projectResolver(item);
      if (!projectId) continue;
      const current = this.store.getJob(item.runId);
      if (!current) {
        this.register({
          runId: item.runId, projectId, kind: 'gpu', executor: 'gpu_queue',
          state: item.state, host: item.host || item.telemetry?.host || null,
          purpose: item.purpose || '', submittedAt: item.submittedAt || item.signalAt,
          startedAt: item.startedAt || (item.state === 'running' ? item.signalAt : null),
          finishedAt: item.finishedAt || (TERMINAL_JOB_STATES.has(item.state) ? item.signalAt : null),
          progress: item.telemetry?.progressMarker ? { marker: item.telemetry.progressMarker } : null,
          result: TERMINAL_JOB_STATES.has(item.state) ? { remotePath: item.remotePath } : null,
          metadata: { remotePath: item.remotePath, signalAt: item.signalAt,
            phase: item.telemetry?.phase || null, submissionReadiness: item.submissionReadiness || null,
            efficiency: item.efficiency || null,
            lifecycleObserved: ACTIVE_JOB_STATES.has(item.state) }, source: 'gpu_queue',
        });
      } else if (!TERMINAL_JOB_STATES.has(current.state) || current.state === item.state) {
        const queueState = current.state === 'running' && item.state === 'pending'
          ? current.state : item.state;
        const metadata = { remotePath: item.remotePath, signalAt: item.signalAt,
          phase: item.telemetry?.phase || null, submissionReadiness: item.submissionReadiness || null,
          efficiency: item.efficiency || null,
          lifecycleObserved: current.metadata?.lifecycleObserved
            ?? ACTIVE_JOB_STATES.has(current.state) };
        const progress = item.telemetry?.progressMarker
          ? { marker: item.telemetry.progressMarker } : current.progress;
        const result = TERMINAL_JOB_STATES.has(item.state)
          ? { remotePath: item.remotePath } : current.result;
        if (queueState === current.state
            && JSON.stringify(metadata) === JSON.stringify(current.metadata)
            && JSON.stringify(progress) === JSON.stringify(current.progress)
            && JSON.stringify(result) === JSON.stringify(current.result)
            && (item.host || current.host) === current.host) continue;
        this.update(item.runId, {
          state: queueState, host: item.host || current.host,
          progress, result, metadata, replaceMetadata: true,
          recordEvent: false, source: 'gpu_queue',
        });
      }
    }
    return this.snapshot();
  }

  snapshot({ terminalLimit = 25, cursor = null, historyOnly = false } = {}) {
    const decoded = decodeCursor(cursor);
    const terminal = this.store.listTerminalJobs({ limit: terminalLimit, cursor: decoded });
    const active = historyOnly ? [] : this.store.listActiveJobs();
    const items = [...active, ...terminal.items];
    const counts = Object.fromEntries([...JOB_STATES].map((state) => [state, 0]));
    for (const row of this.store.countJobsByState()) counts[row.state] = row.count;
    return {
      status: 'ok', collectedAt: this.now().toISOString(), counts, items,
      page: {
        activeIncluded: !historyOnly, activeCount: active.length,
        terminalLimit, terminalReturned: terminal.items.length,
        nextCursor: terminal.hasMore ? encodeCursor(terminal.items.at(-1)) : null,
      },
    };
  }

  get(runId) { return this.store.getJob(runId); }
  events(runId) { return this.store.listJobEvents(runId); }
}

export function commandFingerprint(command) {
  return createHash('sha256').update(String(command || '')).digest('hex');
}
