import { createHash } from 'node:crypto';
import { collectGpuQueue, emptyGpuQueueSnapshot } from './gpu-queue.js';
import { JobRegistry } from './job-registry.js';
import { jobWaitStatus } from './job-wait.js';
import { probeSchedulerMonitor } from './scheduler-monitor.js';

const ACTIVE_SESSION_STATES = new Set(['RUNNING', 'RATE_LIMITED', 'WAITING_INPUT']);
const TERMINAL_QUEUE_STATES = new Set(['done', 'failed', 'cancelled']);

function eventSeverity(state) {
  if (state === 'failed') return 'error';
  if (state === 'cancelled') return 'warn';
  return 'info';
}

function eventProject(item, projectIds) {
  if (item.project && projectIds.has(item.project)) return item.project;
  return [...projectIds]
    .sort((a, b) => b.length - a.length)
    .find((projectId) => item.runId === projectId || item.runId.startsWith(`${projectId}_`)) || null;
}

function queuePrompt(event) {
  const item = event.source?.queueItem || {};
  if (event.eventType === 'JOB_RESULT_READY') {
    const job = event.source?.job || {};
    return [
      '[FIRM OPERATIONAL EVENT — REGISTERED JOB RESULT]',
      `Job ${event.runId} reached authoritative state: ${job.state}`,
      `Executor: ${job.executor || 'unknown'}; kind: ${job.kind || 'unknown'}`,
      'Read the registered result and preserve raw evidence. This notification does not prescribe scientific interpretation or a new method.',
    ].join('\n');
  }
  if (event.eventType === 'GPU_PREPARATION_REQUIRED') {
    const readiness = item.submissionReadiness || { state: 'NOT_READY', missing: [] };
    return [
      '[FIRM OPERATIONAL EVENT — GPU PREPARATION REQUIRED]',
      `Run: ${event.runId}`,
      `Missing preparation evidence: ${(readiness.missing || []).join(', ') || 'unspecified'}`,
      'Repair only the declared preparation defect, then resubmit through the canonical helper. Do not reinterpret the science or start a different experiment.',
    ].join('\n');
  }
  if (event.eventType === 'GPU_SCHEDULER_MONITOR_MISSING') {
    const health = event.source?.monitorHealth || {};
    return [
      '[FIRM OPERATIONAL EVENT — GPU SCHEDULER MONITOR]',
      'The scheduler-owned global monitor is not healthy.',
      `Reason: ${health.reason || 'unknown'}`,
      `PID file: ${health.pidFile || 'not configured'}`,
      'Re-read GPU_SCHEDULER_START_PROMPT.md and the Global Scheduler Monitor sections in GPU_QUEUE_SPEC.md and CLAUDE.md.',
      'Restore exactly one global monitor now, verify its PID and initial normalized snapshot, then remain in MONITORING_IDLE.',
      'FIRM is reporting an operational liveness failure only. Do not change project science or terminate workers from utilization alone.',
    ].join('\n');
  }
  if (event.eventType === 'GPU_EFFICIENCY_ALERT') {
    const efficiency = item.efficiency || {};
    return [
      '[FIRM OPERATIONAL EVENT — GPU EFFICIENCY]',
      `Run: ${event.runId}`,
      `Phase: ${item.telemetry?.phase || 'unknown'}`,
      `Classification: ${efficiency.state || 'UNMEASURED'} (${efficiency.reason || 'no_reason'})`,
      `Average GPU utilization: ${Number.isFinite(efficiency.averageUtilizationPct) ? `${efficiency.averageUtilizationPct.toFixed(1)}%` : 'unmeasured'}`,
      `Progress marker: ${item.telemetry?.progressMarker || 'none'}`,
      efficiency.recommendation || 'Inspect the worker and publish phase-aware telemetry.',
      'This is a diagnostic request. Never terminate or resize a worker solely because utilization is low; confirm phase, progress, logs, and workload intent first.',
    ].join('\n');
  }
  if (event.eventType === 'GPU_REQUEST_SUBMITTED') {
    const readiness = item.submissionReadiness || { state: 'UNDECLARED', missing: [] };
    return [
      '[FIRM OPERATIONAL EVENT — GPU QUEUE]',
      `A GPU request was submitted: ${event.runId}`,
      `Remote queue path: ${item.remotePath}`,
      `Submission readiness: ${readiness.state}`,
      `Missing readiness evidence: ${(readiness.missing || []).join(', ') || 'none'}`,
      `First GPU action: ${readiness.firstGpuAction || 'undeclared'}`,
      'Inspect REQUEST.md and command.sh, then follow GPU_SUBMISSION_READINESS.md, GPU_QUEUE_SPEC.md, and the Scheduler contract exactly.',
      readiness.state === 'READY'
        ? 'Readiness metadata passed structural validation; independently confirm the artifacts and command before launch.'
        : 'Do not launch this request. Leave it pending and tell the project which preparation evidence is missing.',
      'This is an operational wake-up only. Do not reinterpret the project science or change its research direction.',
    ].join('\n');
  }
  return [
    '[FIRM OPERATIONAL EVENT — GPU RESULT]',
    `GPU run ${event.runId} reached queue state: ${item.state}`,
    `Remote result path: ${item.remotePath}/RESULT.md`,
    'Read the authoritative RESULT.md through the established Merlin access, preserve raw evidence, and continue under the project research contract.',
    'This notification does not prescribe the scientific interpretation or the next method.',
  ].join('\n');
}

function automationPrompt(event) {
  return queuePrompt(event);
}

function goalPrompt(policy) {
  return [
    '[FIRM USER-APPROVED CONTINUATION RESPONSE]',
    'Resolve only the ordinary question or option in your immediately preceding message from evidence already present. Stay inside the current construction episode; do not begin a new method, call Codex, or restate the project objective because of this response.',
  ].join('\n');
}

function selfResolveChoicePrompt() {
  return [
    '[FIRM USER-APPROVED ROUTINE-CHOICE RESPONSE]',
    'Your immediately preceding menu contains ordinary research or engineering alternatives, not a human-owned permission decision.',
    'Using the evidence already in this session, choose the highest-value option yourself and execute it now. Do not return the same menu or ask the user to ratify a routine choice.',
    'Do not reinterpret the paper identity, broaden scope, grant permissions, perform irreversible operations, or authorize exceptional resources through this response.',
  ].join('\n');
}

function selfResolveQuestionPrompt() {
  return [
    '[FIRM USER-APPROVED ROUTINE-QUESTION RESPONSE]',
    'Answer the ordinary research or engineering question in your immediately preceding message from evidence already in this session, choose the highest-value action, and execute it.',
    'Stay inside any active construction episode. Do not begin a new method, call Codex, restate the project objective, or ask the user to ratify a routine decision because of this response.',
    'If the question actually requires permission, an irreversible action, exceptional resources, or a user-owned change of scope or contribution type, state only that concrete boundary and wait.',
  ].join('\n');
}

function routineQuestion(text) {
  const value = String(text || '')
    .replace(/\[FIRM (?:WAITING_FOR_JOB|CONSTRUCTION_LEASE)[^\]]*\]/g, '')
    .trim();
  if (!value || !/(?:[?？]\s*$|(?:请|需要|等待)(?:你|您)(?:决定|选择|确认)[。.!！]?\s*$)/u.test(value)) {
    return false;
  }
  return !/(?:permission|authorize|approval|approve|delete|archive|withdraw|submit|purchase|paper identity|contribution type|new seed|venue change|权限|授权|批准|许可|删除|归档|投稿|撤稿|付费|更换\s*seed|贡献类型|论文身份|更换会议)/i.test(value.slice(-1200));
}

function acceptsExternalOperationalInput(session) {
  return session.terminal?.state === 'WAITING_INPUT'
    || (session.terminal?.state === 'WORKING' && session.terminal?.acceptsQueuedInput === true);
}

function acceptsManagedOperationalInput(session) {
  if (session.bootstrapNeedsRetry) return false;
  if (session.status === 'WAITING_INPUT') return true;
  return session.status === 'RUNNING' && session.bootstrapStatus === 'SENT';
}

function deliveryKey(eventKey) {
  return `firm-${createHash('sha256').update(eventKey).digest('hex').slice(0, 24)}`;
}

function acknowledgedPrompt(prompt, messageKey) {
  return `[FIRM DELIVERY ${messageKey}]\n${prompt}`;
}

function goalBudgetSince(config, now, sessionEpoch = null) {
  const rolling = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const epoch = config.goalLoop?.budgetEpoch;
  return [rolling, epoch, sessionEpoch]
    .filter((value) => value && Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
}

export class AutomationEngine {
  constructor({
    config,
    store,
    sessionManager,
    queueCollector = collectGpuQueue,
    discoverExternalSessions = async () => ({ items: [] }),
    externalSessionInput = null,
    externalSessionSubmit = null,
    externalSessionClear = null,
    externalSessionDismissChoice = null,
    onExternalSessionStopped = null,
    schedulerMonitorProbe = probeSchedulerMonitor,
    jobRegistry = null,
    now = () => new Date(),
  }) {
    this.config = config;
    this.store = store;
    this.sessionManager = sessionManager;
    this.queueCollector = queueCollector;
    this.discoverExternalSessions = discoverExternalSessions;
    this.externalSessionInput = externalSessionInput;
    this.externalSessionSubmit = externalSessionSubmit;
    this.externalSessionClear = externalSessionClear;
    this.externalSessionDismissChoice = externalSessionDismissChoice;
    this.onExternalSessionStopped = onExternalSessionStopped;
    this.schedulerMonitorProbe = schedulerMonitorProbe;
    this.jobRegistry = jobRegistry || new JobRegistry({ store, now });
    this.now = now;
    this.projectIds = new Set(config.projects.map((project) => project.id));
    this.queue = store.latestGpuQueueSnapshot()?.snapshot
      || emptyGpuQueueSnapshot(config.gpuQueue.enabled ? 'pending' : 'disabled');
    this.cyclePromise = null;
    this.lastQueuePollAt = 0;
    this.externalWaitingSince = new Map();
    this.externalDispatches = new Map();
    this.externalTerminalStates = new Map();
    this.externalStopCandidates = new Map();
    this.externalUnknownCandidates = new Map();
    this.externalProgressCandidates = new Map();
    this.externalInteractionActions = new Map();
    this.externalSnapshot = null;
    this.externalCollectorAlertKey = null;
    this.schedulerMonitorAlertKey = null;
    this.schedulerMonitorHealth = {
      status: config.gpuQueue?.schedulerMonitorPidFile ? 'unknown' : 'disabled',
      reason: config.gpuQueue?.schedulerMonitorPidFile
        ? 'not_yet_probed' : 'pid_file_not_configured',
    };
  }

  snapshot() {
    return this.queue;
  }

  jobsSnapshot() {
    return this.jobRegistry.snapshot();
  }

  monitorSnapshot() {
    return { ...this.schedulerMonitorHealth };
  }

  async cycle({ forceQueue = false } = {}) {
    if (this.cyclePromise) return this.cyclePromise;
    this.cyclePromise = this.#cycle(forceQueue);
    try {
      return await this.cyclePromise;
    } finally {
      this.cyclePromise = null;
    }
  }

  async #cycle(forceQueue) {
    this.externalSnapshot = null;
    const now = this.now().getTime();
    if (forceQueue || now - this.lastQueuePollAt >= this.config.gpuQueue.pollMs) {
      this.queue = await this.queueCollector(this.config.gpuQueue);
      this.lastQueuePollAt = now;
      this.store.saveGpuQueueSnapshot(this.queue);
      if (this.queue.status === 'ok') {
        this.jobRegistry.syncGpuQueue(this.queue, (item) => eventProject(item, this.projectIds));
        this.#ingestQueue(this.queue);
      }
    }
    await this.#ensurePersistentControls();
    await this.#watchSchedulerMonitor();
    this.#ingestJobs(this.jobsSnapshot());
    await this.#watchSessions();
    await this.#watchExternalStops();
    await this.#deliverPending();
    await this.#runGoalLoop();
    return {
      queue: this.queue,
      events: this.store.listAutomationEvents(200),
    };
  }

  async #externalSessions() {
    this.externalSnapshot ||= await this.discoverExternalSessions();
    return this.externalSnapshot;
  }

  async #ensurePersistentControls() {
    if (!this.config.gpuQueue?.schedulerAutoStart) return;
    const targets = this.config.controlTargets || [];
    if (!targets.some((target) => target.id === 'GPU_SCHEDULER')) return;
    const sessions = await this.sessionManager.list();
    if (sessions.some((session) => (
      session.projectId === 'GPU_SCHEDULER' && ACTIVE_SESSION_STATES.has(session.status)
    ))) return;
    const external = await this.#externalSessions();
    if (external.items?.some((session) => (
      session.controlId === 'GPU_SCHEDULER' && session.terminal
    ))) return;
    try {
      const started = await this.sessionManager.start('GPU_SCHEDULER', {
        cols: 120,
        rows: 32,
        bootstrap: true,
      });
      this.store.createAutomationEvent({
        eventKey: `control:GPU_SCHEDULER:persistent:${started.id}`,
        category: 'session_watchdog', eventType: 'CONTROL_SESSION_RESTORED',
        targetId: 'GPU_SCHEDULER', severity: 'info', status: 'RESOLVED',
        title: 'GPU Scheduler control session restored',
        message: 'The persistent GPU Scheduler session was missing and has been restarted.',
        source: { deliveryPolicy: 'none', sessionId: started.id },
        note: 'persistent_control_invariant_restored',
      });
    } catch (error) {
      this.store.createAutomationEvent({
        eventKey: `control:GPU_SCHEDULER:restore_failed:${this.now().toISOString()}`,
        category: 'session_watchdog', eventType: 'CONTROL_SESSION_RESTORE_FAILED',
        targetId: 'GPU_SCHEDULER', severity: 'error',
        title: 'GPU Scheduler control session could not be restored',
        message: 'FIRM failed to restore the required persistent GPU Scheduler session.',
        source: { deliveryPolicy: 'manual' },
        note: String(error.message || error).slice(0, 500),
      });
    }
  }

  async #watchSchedulerMonitor() {
    const pidFile = this.config.gpuQueue?.schedulerMonitorPidFile;
    if (!this.config.gpuQueue?.enabled || !pidFile) return;
    const health = await this.schedulerMonitorProbe(pidFile);
    this.schedulerMonitorHealth = { ...health, checkedAt: this.now().toISOString() };
    if (health.status === 'healthy') {
      if (this.schedulerMonitorAlertKey) {
        const event = this.store.getAutomationEvent(this.schedulerMonitorAlertKey);
        if (event && event.status !== 'RESOLVED') {
          this.store.setAutomationEvent(event.id, {
            status: 'RESOLVED',
            note: `monitor_recovered_pid_${health.pid}`,
          });
        }
      }
      this.schedulerMonitorAlertKey = null;
      return;
    }
    if (health.status === 'disabled' || this.schedulerMonitorAlertKey) return;
    this.schedulerMonitorAlertKey = `gpu:scheduler-monitor:missing:${this.now().toISOString()}`;
    this.store.createAutomationEvent({
      eventKey: this.schedulerMonitorAlertKey,
      category: 'gpu_scheduler',
      eventType: 'GPU_SCHEDULER_MONITOR_MISSING',
      targetId: 'GPU_SCHEDULER',
      severity: 'error',
      title: 'GPU Scheduler global monitor is missing',
      message: 'FIRM could not verify the one required scheduler-owned global monitor.',
      source: { deliveryPolicy: 'auto_notify', monitorHealth: health },
    });
  }

  async #watchExternalStops() {
    const external = await this.#externalSessions();
    await this.#reconcileExternalOutbox(external.items || []);
    const handledInteractions = await this.#reconcileForegroundInteractions(external.items || []);
    const collectorProblems = [
      external.status && external.status !== 'ok'
        ? `process:${external.status}:${external.reason || 'unknown'}` : null,
      external.terminalStatus && external.terminalStatus !== 'ok'
        ? `terminal:${external.terminalStatus}:${external.terminalReason || 'unknown'}` : null,
    ].filter(Boolean);
    if (collectorProblems.length) {
      if (!this.externalCollectorAlertKey) {
        this.externalCollectorAlertKey = `session:collector:degraded:${this.now().toISOString()}`;
        this.store.createAutomationEvent({
          eventKey: this.externalCollectorAlertKey,
          category: 'session_watchdog',
          eventType: 'SESSION_COLLECTOR_DEGRADED',
          targetId: 'CONTROL_ROOM',
          severity: 'error',
          title: 'External Claude session collector is degraded',
          message: 'FIRM cannot currently prove external session liveness. This is a monitoring outage, not evidence that research is progressing or stopped.',
          source: { deliveryPolicy: 'manual', problems: collectorProblems },
        });
      }
    } else if (this.externalCollectorAlertKey) {
      this.#resolveEvent(this.externalCollectorAlertKey, 'session_collector_recovered');
      this.externalCollectorAlertKey = null;
    }
    if (!collectorProblems.length) {
      for (const event of this.store.listPendingAutomationEvents(1000).filter((candidate) => (
        candidate.eventType === 'SESSION_COLLECTOR_DEGRADED'
      ))) {
        this.store.setAutomationEvent(event.id, {
          status: 'RESOLVED', note: 'collector_health_verified_after_restart',
        });
      }
    }
    const seen = new Set();
    for (const session of external.items || []) {
      if (!session.projectId || !this.projectIds.has(session.projectId)) continue;
      const key = `${session.projectId}:${session.pid}`;
      seen.add(key);
      const current = session.terminal?.state || 'UNKNOWN';
      const currentProgressAt = Date.parse(session.heartbeat?.lastProgressAt || '');
      const currentAssistantAt = Date.parse(session.heartbeat?.latestAssistantAt || '');
      for (const event of this.store.listPendingAutomationEvents(1000).filter((candidate) => (
        candidate.targetId === session.projectId
        && ['SESSION_PROGRESS_STALLED', 'SESSION_ACCEPTED_INPUT_STALLED'].includes(candidate.eventType)
      ))) {
        if (event.eventType === 'SESSION_PROGRESS_STALLED') {
          const stalledAt = Date.parse(event.source?.lastProgressAt || '');
          if (Number.isFinite(currentProgressAt) && Number.isFinite(stalledAt)
              && currentProgressAt > stalledAt) {
            this.store.setAutomationEvent(event.id, {
              status: 'RESOLVED', note: 'durable_progress_evidence_advanced',
            });
          }
          continue;
        }
        const message = event.source?.messageKey
          ? this.store.getOutboxMessage(event.source.messageKey) : null;
        const sentAt = Date.parse(message?.sentAt || message?.sendingAt || '');
        if (Number.isFinite(currentAssistantAt) && Number.isFinite(sentAt)
            && currentAssistantAt > sentAt) {
          this.store.setAutomationEvent(event.id, {
            status: 'RESOLVED', note: 'durable_assistant_progress_after_delivery',
          });
        }
      }
      if (session.heartbeat?.episodeId) {
        this.store.observeSessionEpisode({
          episodeId: session.heartbeat.episodeId,
          targetId: session.projectId,
          sessionPid: session.pid,
          terminalState: current,
          historyCursor: session.heartbeat.historyCursor || null,
          tailHash: session.terminal?.tailHash || null,
          observedAt: this.now().toISOString(),
          source: {
            historyEventId: session.heartbeat.historyEventId || null,
            historyEventType: session.heartbeat.historyEventType || null,
          },
        });
      }
      const previous = this.externalTerminalStates.get(key);
      this.externalTerminalStates.set(key, current);
      if (handledInteractions.has(key)) {
        this.externalStopCandidates.delete(key);
        this.externalWaitingSince.delete(key);
        continue;
      }
      const tailHash = session.terminal?.tailHash || 'unknown';
      const priorUnknown = this.externalUnknownCandidates.get(key);
      if (current === 'UNKNOWN') {
        let candidate = priorUnknown;
        if (!candidate || candidate.tailHash !== tailHash) {
          if (candidate?.eventKey) this.#resolveEvent(candidate.eventKey, 'terminal_output_changed');
          candidate = {
            tailHash,
            firstSeenAt: this.now().getTime(),
            dispatched: false,
            eventKey: `session:${key}:unknown_stall:${tailHash}`,
          };
          this.externalUnknownCandidates.set(key, candidate);
        }
        const stallMs = this.config.watchdog.unknownStallMs ?? 3 * 60 * 1000;
        if (!candidate.dispatched && this.now().getTime() - candidate.firstSeenAt >= stallMs) {
          candidate.dispatched = true;
          this.store.createAutomationEvent({
            eventKey: candidate.eventKey,
            category: 'session_watchdog',
            eventType: 'SESSION_OUTPUT_STALLED',
            targetId: session.projectId,
            severity: 'warn',
            title: `Claude output stalled: ${session.projectId}`,
            message: 'The terminal remained UNKNOWN with an unchanged bounded tail. Review immediately, but do not inject input until a normal prompt is verified.',
            source: {
              deliveryPolicy: 'manual', pid: session.pid, tty: session.tty,
              tailHash, firstSeenAt: new Date(candidate.firstSeenAt).toISOString(),
            },
          });
          if (typeof this.onExternalSessionStopped === 'function') {
            await this.onExternalSessionStopped({
              projectId: session.projectId,
              pid: session.pid,
              tty: session.tty,
              previousState: previous || 'UNKNOWN',
              detectedAt: this.now().toISOString(),
              tailHash,
              safeToContinue: false,
              stopReason: 'stable_unknown_no_output',
            });
          }
        }
      } else if (priorUnknown) {
        if (priorUnknown.eventKey) {
          this.#resolveEvent(priorUnknown.eventKey, `terminal_became_${current.toLowerCase()}`);
        }
        this.externalUnknownCandidates.delete(key);
      }
      const heartbeat = session.heartbeat;
      const priorProgress = this.externalProgressCandidates.get(key);
      const progressAt = heartbeat?.lastProgressAt ? Date.parse(heartbeat.lastProgressAt) : NaN;
      const progressEligible = ['WORKING', 'UNKNOWN'].includes(current)
        && heartbeat?.status === 'ok' && Number.isFinite(progressAt);
      if (progressEligible) {
        const fingerprint = `${heartbeat.lastProgressAt}:${heartbeat.toolFingerprint || 'no-tools'}`;
        let candidate = priorProgress;
        if (!candidate || candidate.fingerprint !== fingerprint) {
          if (candidate?.eventKey) this.#resolveEvent(candidate.eventKey, 'effective_progress_resumed');
          candidate = {
            fingerprint,
            firstObservedAt: this.now().getTime(),
            dispatched: false,
            eventKey: `session:${key}:progress_stall:${fingerprint}`,
          };
          this.externalProgressCandidates.set(key, candidate);
        }
        const hasTool = (heartbeat.activeToolProcessCount || 0) > 0;
        const stallMs = hasTool
          ? this.config.watchdog.toolProgressStallMs ?? 30 * 60 * 1000
          : this.config.watchdog.progressStallMs ?? 8 * 60 * 1000;
        const observedSince = Math.max(progressAt, candidate.firstObservedAt);
        const unknownAlreadyDispatched = current === 'UNKNOWN'
          && this.externalUnknownCandidates.get(key)?.dispatched;
        if (!candidate.dispatched && !unknownAlreadyDispatched
            && this.now().getTime() - observedSince >= stallMs) {
          candidate.dispatched = true;
          this.store.createAutomationEvent({
            eventKey: candidate.eventKey,
            category: 'session_watchdog',
            eventType: 'SESSION_PROGRESS_STALLED',
            targetId: session.projectId,
            severity: 'warn',
            title: `No effective progress heartbeat: ${session.projectId}`,
            message: 'Claude appears active, but history, key research artifacts, and tool-process evidence have not advanced. Review the project without injecting input or interrupting work.',
            source: {
              deliveryPolicy: 'manual', pid: session.pid, tty: session.tty,
              terminalState: current,
              lastProgressAt: heartbeat.lastProgressAt,
              toolProcessCount: heartbeat.toolProcessCount || 0,
              activeToolProcessCount: heartbeat.activeToolProcessCount || 0,
              toolKinds: heartbeat.toolKinds || [],
            },
          });
          if (typeof this.onExternalSessionStopped === 'function') {
            await this.onExternalSessionStopped({
              projectId: session.projectId,
              pid: session.pid,
              tty: session.tty,
              previousState: current,
              detectedAt: this.now().toISOString(),
              tailHash,
              safeToContinue: false,
              stopReason: 'effective_progress_stalled',
              heartbeat,
            });
          }
        }
      } else if (priorProgress) {
        if (priorProgress.eventKey) {
          this.#resolveEvent(priorProgress.eventKey, `progress_watch_became_${current.toLowerCase()}`);
        }
        this.externalProgressCandidates.delete(key);
      }
      const jobWait = jobWaitStatus(session, this.jobsSnapshot());
      if (current === 'WAITING_INPUT' && jobWait.waiting) {
        this.externalStopCandidates.delete(key);
        this.externalWaitingSince.delete(key);
        this.store.createAutomationEvent({
          eventKey: `job-wait:${session.projectId}:${jobWait.matchedRunIds.sort().join(',')}`,
          category: 'session_watchdog', eventType: 'JOB_WAIT_ACCEPTED',
          targetId: session.projectId, severity: 'info', status: 'RESOLVED',
          title: `Legitimate registered-job wait: ${session.projectId}`,
          message: `The project explicitly declared a wait on active registered job(s): ${jobWait.matchedRunIds.join(', ')}.`,
          source: {
            deliveryPolicy: 'none', pid: session.pid,
            runIds: jobWait.matchedRunIds,
          },
          note: 'goal_and_stop_review_suppressed_until_gpu_terminal_state',
        });
        for (const event of this.store.listPendingAutomationEvents(1000).filter((candidate) => (
          candidate.targetId === session.projectId
          && candidate.eventType === 'STOP_REVIEW_QUEUED'
        ))) {
          this.store.setAutomationEvent(event.id, {
            status: 'RESOLVED', note: 'superseded_by_verified_gpu_wait',
          });
        }
        continue;
      }
      if (current !== 'WAITING_INPUT') {
        this.externalStopCandidates.delete(key);
        continue;
      }
      const waitingEvidenceAt = session.heartbeat?.episodeId
        || session.heartbeat?.historyCursor
        || session.heartbeat?.historyWriteAt
        || session.heartbeat?.lastProgressAt || null;
      const existingStop = this.externalStopCandidates.get(key);
      const evidenceAdvanced = Boolean(
        existingStop?.waitingEvidenceAt && waitingEvidenceAt
        && existingStop.waitingEvidenceAt !== waitingEvidenceAt,
      );
      const distinctWaitingEpisode = previous !== 'WAITING_INPUT'
        || !existingStop
        || (existingStop.stop.tailHash !== tailHash && evidenceAdvanced);
      if (distinctWaitingEpisode) {
        this.externalStopCandidates.set(key, {
          firstSeenAt: this.now().getTime(),
          dispatched: false,
          waitingEvidenceAt,
          stop: {
            projectId: session.projectId,
            pid: session.pid,
            tty: session.tty,
            previousState: previous || 'UNSEEN',
            detectedAt: this.now().toISOString(),
            tailHash: session.terminal?.tailHash || 'unknown',
            episodeId: session.heartbeat?.episodeId || null,
          },
        });
      }
      const candidate = this.externalStopCandidates.get(key);
      if (!candidate || candidate.dispatched) continue;
      const stableMs = this.config.watchdog.stopReviewStableMs ?? 15 * 1000;
      if (this.now().getTime() - candidate.firstSeenAt < stableMs) continue;
      candidate.dispatched = true;
      if (typeof this.onExternalSessionStopped === 'function') {
        await this.onExternalSessionStopped(candidate.stop);
      }
    }
    for (const key of this.externalTerminalStates.keys()) {
      if (!seen.has(key)) {
        this.externalTerminalStates.delete(key);
        this.externalStopCandidates.delete(key);
        const unknown = this.externalUnknownCandidates.get(key);
        if (unknown?.eventKey) this.#resolveEvent(unknown.eventKey, 'session_no_longer_present');
        this.externalUnknownCandidates.delete(key);
        const progress = this.externalProgressCandidates.get(key);
        if (progress?.eventKey) this.#resolveEvent(progress.eventKey, 'session_no_longer_present');
        this.externalProgressCandidates.delete(key);
      }
    }
  }

  async #reconcileForegroundInteractions(sessions) {
    const handled = new Set();
    for (const session of sessions) {
      if (!session.projectId || !this.projectIds.has(session.projectId)) continue;
      const key = `${session.projectId}:${session.pid}`;
      const terminal = session.terminal || {};
      const prior = this.externalInteractionActions.get(key);
      const priorStillVisible = prior?.kind === 'acked_draft'
        ? terminal.state === 'DRAFT_PENDING_ENTER'
          && terminal.draftDeliveryMarker === prior.marker
        : prior?.kind === 'routine_choice'
          ? terminal.state === 'ROUTINE_CHOICE'
          : prior?.kind === 'routine_question'
            ? terminal.state === 'WAITING_INPUT'
              && session.heartbeat?.latestAssistantAt === prior.latestAssistantAt
          : false;
      if (prior && !priorStillVisible) {
        const event = this.store.getAutomationEvent(prior.eventKey);
        if (event && ['PENDING', 'HELD', 'SENT'].includes(event.status)) {
          this.store.setAutomationEvent(event.id, {
            status: 'RESOLVED', note: 'foreground_interaction_advanced',
          });
        }
        this.externalInteractionActions.delete(key);
      }

      if (terminal.state === 'DRAFT_PENDING_ENTER') {
        handled.add(key);
        const marker = terminal.draftDeliveryMarker || null;
        const message = marker ? this.store.getOutboxMessage(marker) : null;
        if (!marker || !message || message.status !== 'ACKED') continue;
        const eventKey = `interaction:${session.projectId}:${session.pid}:acked-draft:${marker}`;
        if (terminal.modelWorking) continue;
        if (prior?.eventKey === eventKey) {
          const retryDelayMs = this.config.goalLoop.enterRetryMs ?? 2_000;
          if (this.now().getTime() - prior.lastAttemptAt < retryDelayMs) continue;
          if (prior.attempts >= 3) {
            this.store.createAutomationEvent({
              eventKey: `${eventKey}:clear-exhausted`, category: 'session_control',
              eventType: 'ACKED_DELIVERY_DRAFT_CLEAR_EXHAUSTED',
              targetId: session.projectId, severity: 'error',
              title: `Duplicate draft could not be cleared: ${session.projectId}`,
              message: 'The same acknowledged marker remained in the editor after three whole-input clear attempts.',
              source: { deliveryPolicy: 'manual', pid: session.pid, messageKey: marker },
            });
            continue;
          }
        }
        if (typeof this.externalSessionClear !== 'function') {
          this.store.createAutomationEvent({
            eventKey, category: 'session_control', eventType: 'ACKED_DELIVERY_DRAFT_VISIBLE',
            targetId: session.projectId, severity: 'error',
            title: `Acknowledged delivery remains in the prompt: ${session.projectId}`,
            message: 'The delivery is already present in Claude history, so it must be cleared rather than submitted again.',
            source: { deliveryPolicy: 'manual', pid: session.pid, messageKey: marker },
          });
          continue;
        }
        try {
          await this.externalSessionClear(session);
          this.store.createAutomationEvent({
            eventKey, category: 'session_control', eventType: 'ACKED_DELIVERY_DRAFT_CLEARED',
            targetId: session.projectId, severity: 'warn', status: 'SENT',
            title: `Cleared duplicate acknowledged draft: ${session.projectId}`,
            message: 'A FIRM delivery already acknowledged in Claude history was still visible in the editor and was cleared without resubmission.',
            source: { deliveryPolicy: 'none', pid: session.pid, messageKey: marker },
          });
          this.externalInteractionActions.set(key, {
            eventKey, kind: 'acked_draft', marker,
            attempts: (prior?.attempts || 0) + 1,
            lastAttemptAt: this.now().getTime(),
          });
        } catch (error) {
          this.store.createAutomationEvent({
            eventKey, category: 'session_control', eventType: 'ACKED_DELIVERY_DRAFT_CLEAR_FAILED',
            targetId: session.projectId, severity: 'error',
            title: `Could not clear duplicate draft: ${session.projectId}`,
            message: 'The acknowledged draft remains visible; no duplicate submission was attempted.',
            source: { deliveryPolicy: 'manual', pid: session.pid, messageKey: marker },
            note: String(error.message || error).slice(0, 500),
          });
        }
        continue;
      }

      if (terminal.state === 'WAITING_INPUT'
          && routineQuestion(session.heartbeat?.latestAssistantText)) {
        handled.add(key);
        const latestAssistantAt = session.heartbeat?.latestAssistantAt || 'unknown';
        const questionIdentity = createHash('sha256').update(JSON.stringify({
          latestAssistantAt,
          text: session.heartbeat?.latestAssistantText,
        })).digest('hex').slice(0, 24);
        const eventKey = `interaction:${session.projectId}:${session.pid}:question:${questionIdentity}`;
        if (prior?.eventKey === eventKey) continue;
        const event = this.store.createAutomationEvent({
          eventKey, category: 'session_control', eventType: 'ROUTINE_QUESTION_RETURNED_TO_CLAUDE',
          targetId: session.projectId, severity: 'info',
          title: `Returned routine question to Claude: ${session.projectId}`,
          message: 'Claude asked an ordinary research or engineering question, so FIRM returned it for self-resolution without supplying a new goal or scientific direction.',
          source: { deliveryPolicy: 'none', pid: session.pid },
        });
        const delivery = await this.#sendExternalAcknowledged({
          event, session, prompt: selfResolveQuestionPrompt(),
          note: 'routine_question_returned_to_claude',
        });
        if (delivery.status !== 'failed') {
          this.externalInteractionActions.set(key, {
            eventKey, kind: 'routine_question', latestAssistantAt,
            attempts: 1, lastAttemptAt: this.now().getTime(),
          });
        }
        continue;
      }

      if (terminal.state !== 'ROUTINE_CHOICE') continue;
      handled.add(key);
      const choiceIdentity = createHash('sha256').update(JSON.stringify({
        selectedOptionNumber: terminal.selectedOptionNumber,
        selectedOptionText: terminal.selectedOptionText,
        recommendedSelected: terminal.recommendedSelected,
      })).digest('hex').slice(0, 24);
      const eventKey = `interaction:${session.projectId}:${session.pid}:choice:${choiceIdentity}`;
      if (prior?.eventKey === eventKey) {
        const retryDelayMs = this.config.goalLoop.enterRetryMs ?? 2_000;
        if (this.now().getTime() - prior.lastAttemptAt < retryDelayMs) continue;
        if (prior.attempts >= 3) {
          this.store.createAutomationEvent({
            eventKey: `${eventKey}:selection-exhausted`, category: 'session_control',
            eventType: 'ROUTINE_RECOMMENDATION_ACCEPT_EXHAUSTED',
            targetId: session.projectId, severity: 'error',
            title: `Routine choice did not advance: ${session.projectId}`,
            message: 'The same Claude recommendation remained selected after three Enter attempts.',
            source: { deliveryPolicy: 'manual', pid: session.pid },
          });
          continue;
        }
      }
      if (terminal.recommendedSelected) {
        if (typeof this.externalSessionSubmit !== 'function') continue;
        try {
          await this.externalSessionSubmit(session);
          this.store.createAutomationEvent({
            eventKey, category: 'session_control', eventType: 'ROUTINE_RECOMMENDATION_ACCEPTED',
            targetId: session.projectId, severity: 'info', status: 'SENT',
            title: `Accepted Claude's routine recommendation: ${session.projectId}`,
            message: `Claude marked option ${terminal.selectedOptionNumber} as Recommended; FIRM confirmed that option and will verify interaction progress.`,
            source: {
              deliveryPolicy: 'none', pid: session.pid,
              selectedOptionNumber: terminal.selectedOptionNumber,
              selectedOptionText: terminal.selectedOptionText,
            },
          });
          this.externalInteractionActions.set(key, {
            eventKey, kind: 'routine_choice',
            attempts: (prior?.attempts || 0) + 1,
            lastAttemptAt: this.now().getTime(),
          });
        } catch (error) {
          this.store.createAutomationEvent({
            eventKey, category: 'session_control', eventType: 'ROUTINE_RECOMMENDATION_ACCEPT_FAILED',
            targetId: session.projectId, severity: 'error',
            title: `Could not confirm routine recommendation: ${session.projectId}`,
            message: 'Claude remains at its routine choice menu.',
            source: { deliveryPolicy: 'manual', pid: session.pid },
            note: String(error.message || error).slice(0, 500),
          });
        }
        continue;
      }

      if (!this.externalSessionDismissChoice || !this.externalSessionInput) continue;
      try {
        await this.externalSessionDismissChoice(session);
        const event = this.store.createAutomationEvent({
          eventKey, category: 'session_control', eventType: 'ROUTINE_CHOICE_RETURNED_TO_CLAUDE',
          targetId: session.projectId, severity: 'info',
          title: `Returned routine choice to Claude: ${session.projectId}`,
          message: 'The menu had no recommended selection, so FIRM dismissed it and instructed Claude to decide from existing evidence.',
          source: { deliveryPolicy: 'none', pid: session.pid },
        });
        await this.#sendExternalAcknowledged({
          event, session, prompt: selfResolveChoicePrompt(),
          note: 'routine_choice_returned_to_claude',
        });
        this.externalInteractionActions.set(key, {
          eventKey, kind: 'routine_choice', attempts: 1,
          lastAttemptAt: this.now().getTime(),
        });
      } catch (error) {
        this.store.createAutomationEvent({
          eventKey, category: 'session_control', eventType: 'ROUTINE_CHOICE_SELF_RESOLUTION_FAILED',
          targetId: session.projectId, severity: 'error',
          title: `Could not return routine choice to Claude: ${session.projectId}`,
          message: 'The ordinary choice remains unresolved.',
          source: { deliveryPolicy: 'manual', pid: session.pid },
          note: String(error.message || error).slice(0, 500),
        });
      }
    }
    return handled;
  }

  async #reconcileExternalOutbox(sessions) {
    const unacknowledged = this.store.listUnacknowledgedOutbox(5000);
    for (const message of unacknowledged) {
      if (!message.sessionPid || message.status === 'QUEUED') continue;
      const session = sessions.find((candidate) => (
        candidate.pid === message.sessionPid && (
          candidate.projectId === message.targetId || candidate.controlId === message.targetId
        )
      ));
      if (!session) {
        if (message.status === 'SENT_AWAITING_ACK') {
          this.store.failOutboxMessage(message.id, {
            status: 'UNCERTAIN',
            error: 'target_session_disappeared_before_history_ack',
          });
        }
        continue;
      }
      if ((session.heartbeat?.deliveryMarkers || []).includes(message.messageKey)) {
        const acknowledged = this.store.acknowledgeOutboxMessage(message.id, {
          at: this.now().toISOString(),
          cursor: session.heartbeat?.historyCursor || null,
        });
        for (const older of this.store.listUnacknowledgedOutbox(5000).filter((candidate) => (
          candidate.id < acknowledged.id
          && candidate.targetId === acknowledged.targetId
          && candidate.sessionPid === acknowledged.sessionPid
        ))) {
          const superseded = this.store.failOutboxMessage(older.id, {
            status: 'SUPERSEDED',
            error: `superseded_by_acknowledged_delivery:${acknowledged.messageKey}`,
          });
          if (superseded?.automationEventId) {
            const olderEvent = this.store.getAutomationEventById(superseded.automationEventId);
            if (olderEvent && ['PENDING', 'HELD', 'SENT'].includes(olderEvent.status)) {
              this.store.setAutomationEvent(olderEvent.id, {
                status: 'RESOLVED',
                note: `superseded_by_acknowledged_delivery:${acknowledged.messageKey}`,
              });
            }
          }
        }
        if (!acknowledged?.automationEventId) continue;
        const event = this.store.getAutomationEventById(acknowledged.automationEventId);
        if (!event || event.status === 'DELIVERED') continue;
        this.store.setAutomationEvent(event.id, {
          status: 'DELIVERED',
          sessionId: message.sessionId,
          deliveredAt: acknowledged.ackedAt,
          note: 'claude_history_acknowledged_delivery',
        });
        continue;
      }

      const marker = session.terminal?.draftDeliveryMarker || null;
      const collapsedPasteMatches = !marker
        && session.terminal?.collapsedPasteDraft === true
        && unacknowledged.filter((candidate) => (
          candidate.sessionPid === message.sessionPid
          && candidate.targetId === message.targetId
          && ['SENT_AWAITING_ACK', 'UNCERTAIN'].includes(candidate.status)
        )).length === 1;
      const lastEnterAt = Date.parse(message.lastEnterAt || message.sentAt || message.sendingAt || '');
      const retryDelayMs = this.config.goalLoop.enterRetryMs ?? 2_000;
      if ((marker !== message.messageKey && !collapsedPasteMatches)
          || !['SENT_AWAITING_ACK', 'UNCERTAIN'].includes(message.status)
          || typeof this.externalSessionSubmit !== 'function'
          || (Number.isFinite(lastEnterAt) && this.now().getTime() - lastEnterAt < retryDelayMs)) {
        continue;
      }
      if (message.enterAttempts >= 3) {
        this.store.createAutomationEvent({
          eventKey: `delivery:${message.messageKey}:enter_retry_exhausted`,
          category: 'session_control', eventType: 'DELIVERY_ENTER_RETRY_EXHAUSTED',
          targetId: message.targetId, severity: 'error',
          title: `Delivery remains unsubmitted: ${message.targetId}`,
          message: 'The tracked draft is still visible after three Enter-only retries.',
          source: { deliveryPolicy: 'manual', messageKey: message.messageKey, pid: message.sessionPid },
        });
        continue;
      }
      try {
        await this.externalSessionSubmit(session);
        this.store.recordOutboxEnterRetry(message.id, this.now().toISOString());
      } catch (error) {
        this.store.failOutboxMessage(message.id, {
          status: 'UNCERTAIN',
          error: `enter_retry_failed:${String(error.message || error).slice(0, 400)}`,
        });
      }
    }
  }

  async #sendExternalAcknowledged({ event, session, prompt, note }) {
    const messageKey = deliveryKey(event.eventKey);
    const existing = this.store.listUnacknowledgedOutbox(5000).find((message) => (
      message.targetId === event.targetId && message.sessionPid === session.pid
      && ['QUEUED', 'SENDING', 'SENT_AWAITING_ACK'].includes(message.status)
    ));
    if (existing && existing.messageKey !== messageKey) {
      this.#holdEvent(event, `blocked_by_pending_delivery:${existing.messageKey}`);
      return { status: 'blocked_by_pending_delivery', message: existing };
    }
    const payloadText = acknowledgedPrompt(prompt, messageKey);
    let message = this.store.createOutboxMessage({
      messageKey,
      targetId: event.targetId,
      category: event.category,
      automationEventId: event.id,
      sessionPid: session.pid,
      tty: session.tty,
      payloadText,
      payloadHash: createHash('sha256').update(payloadText).digest('hex'),
      baselineCursor: session.heartbeat?.historyCursor || null,
    });
    if (message.status === 'ACKED') return { status: 'acknowledged', message };
    if (['SENDING', 'SENT_AWAITING_ACK', 'UNCERTAIN'].includes(message.status)) {
      return { status: message.status.toLowerCase(), message };
    }
    if (message.status !== 'QUEUED') return { status: message.status.toLowerCase(), message };

    const claimed = this.store.claimOutboxMessage(message.id, this.now().toISOString());
    if (!claimed.claimed) return { status: claimed.message.status.toLowerCase(), message: claimed.message };
    message = claimed.message;
    try {
      await this.externalSessionInput(session, message.payloadText);
      message = this.store.markOutboxSent(message.id, this.now().toISOString());
      this.store.setAutomationEvent(event.id, {
        status: 'SENT',
        note: `${note}:awaiting_claude_history_ack`,
      });
      this.#markExternalDispatch(event.targetId, session, message.messageKey);
      return { status: 'sent_awaiting_ack', message };
    } catch (error) {
      message = this.store.failOutboxMessage(message.id, {
        status: 'FAILED',
        error: String(error.message || error).slice(0, 500),
      });
      this.#holdEvent(event, `external_delivery_failed:${message.error}`);
      return { status: 'failed', message };
    }
  }

  #ingestQueue(snapshot) {
    for (const item of snapshot.items) {
      if (item.state === 'pending') {
        const readiness = item.submissionReadiness || { state: 'UNDECLARED' };
        this.store.createAutomationEvent({
          eventKey: `gpu:${item.runId}:submitted`,
          category: 'gpu_queue',
          eventType: 'GPU_REQUEST_SUBMITTED',
          targetId: 'GPU_SCHEDULER',
          runId: item.runId,
          severity: readiness.state === 'READY' ? 'info'
            : readiness.state === 'NOT_READY' ? 'error' : 'warn',
          title: `${readiness.state}: ${item.runId}`,
          message: readiness.state === 'READY'
            ? 'A compute-ready request is waiting for scheduler verification.'
            : 'The request must not launch until submission readiness is repaired.',
          source: { deliveryPolicy: 'auto_notify', queueItem: item },
        });
        const projectId = eventProject(item, this.projectIds);
      if (projectId && readiness.state === 'NOT_READY') {
          this.store.createAutomationEvent({
            eventKey: `gpu:${item.runId}:preparation_required`,
            category: 'gpu_queue', eventType: 'GPU_PREPARATION_REQUIRED',
            targetId: projectId, runId: item.runId, severity: 'error',
            title: `GPU preparation required: ${item.runId}`,
            message: 'The request has a concrete preparation defect that the project must repair.',
            source: { deliveryPolicy: 'auto_notify', queueItem: item },
          });
        }
      }
      if (item.state === 'running') {
        this.#resolveEvent(`gpu:${item.runId}:submitted`, 'scheduler_accepted_request');
        this.#resolveEvent(`gpu:${item.runId}:preparation_required`, 'scheduler_accepted_repaired_request');
        const efficiency = item.efficiency || {};
        const alertStates = new Set([
          'BLOCKED', 'STALLED', 'INEFFICIENT', 'RESOURCE_MISMATCH', 'IMBALANCED',
        ]);
        if (alertStates.has(efficiency.state)) {
          this.store.createAutomationEvent({
            eventKey: `gpu:${item.runId}:efficiency:${efficiency.state}`,
            category: 'gpu_efficiency',
            eventType: 'GPU_EFFICIENCY_ALERT',
            targetId: 'GPU_SCHEDULER',
            runId: item.runId,
            severity: efficiency.severity || 'warn',
            title: `${efficiency.state}: ${item.runId}`,
            message: efficiency.recommendation || 'The running worker needs an efficiency diagnosis.',
            source: { deliveryPolicy: 'auto_notify', queueItem: item },
          });
        }
      }
      if (TERMINAL_QUEUE_STATES.has(item.state)) {
        this.#resolveEvent(`gpu:${item.runId}:submitted`, `queue_reached_${item.state}`);
        this.#resolveEvent(`gpu:${item.runId}:preparation_required`, `queue_reached_${item.state}`);
        for (const state of ['BLOCKED', 'STALLED', 'INEFFICIENT', 'RESOURCE_MISMATCH', 'IMBALANCED']) {
          this.#resolveEvent(`gpu:${item.runId}:efficiency:${state}`, `queue_reached_${item.state}`);
        }
        // GPU Queue is an executor only. Result delivery is owned by Job Registry.
        this.#resolveEvent(`gpu:${item.runId}:${item.state}`, 'legacy_gpu_result_path_removed');
      }
    }
  }

  #ingestJobs(snapshot) {
    for (const job of snapshot.items || []) {
      if (job.state === 'cancelled'
          || job.metadata?.notify === false || job.metadata?.lifecycleObserved !== true
          || !TERMINAL_QUEUE_STATES.has(job.state)) {
        if (TERMINAL_QUEUE_STATES.has(job.state)) {
          this.#resolveEvent(`job:${job.runId}:${job.state}:result`, 'historical_terminal_import_not_notifiable');
        }
        continue;
      }
      this.store.createAutomationEvent({
        eventKey: `job:${job.runId}:${job.state}:result`,
        category: 'job_registry', eventType: 'JOB_RESULT_READY',
        targetId: job.projectId, runId: job.runId,
        severity: eventSeverity(job.state),
        title: `Registered job ${job.state}: ${job.runId}`,
        message: `The authoritative ${job.kind} job result is ready for ${job.projectId}.`,
        source: { deliveryPolicy: 'auto_notify', job },
      });
    }
  }

  #resolveEvent(eventKey, note) {
    const event = this.store.getAutomationEvent(eventKey);
    if (!event || !['PENDING', 'HELD', 'SENT'].includes(event.status)) return;
    for (const message of this.store.listUnacknowledgedOutbox(5000).filter((candidate) => (
      candidate.automationEventId === event.id
    ))) {
      this.store.failOutboxMessage(message.id, {
        status: 'SUPERSEDED', error: `event_resolved:${note}`,
      });
    }
    this.store.setAutomationEvent(event.id, { status: 'RESOLVED', note });
  }

  #holdEvent(event, note, sessionId = null) {
    if (event.status === 'HELD' && event.note === note && event.sessionId === sessionId) return event;
    return this.store.setAutomationEvent(event.id, { status: 'HELD', note, sessionId });
  }

  #externalDispatchBlocked(targetId, session) {
    const dispatch = this.externalDispatches.get(targetId);
    const resetAt = Date.parse(session.terminal?.lastRateLimitResetAt || '');
    if (dispatch && Number.isFinite(resetAt) && resetAt > dispatch.deliveredAt) {
      this.externalDispatches.delete(targetId);
      for (const event of this.store.listPendingAutomationEvents(1000).filter((candidate) => (
        candidate.targetId === targetId
        && candidate.eventType === 'SESSION_ACCEPTED_INPUT_STALLED'
      ))) {
        this.store.setAutomationEvent(event.id, {
          status: 'RESOLVED', note: 'provider_limit_reset_started_new_delivery_epoch',
        });
      }
    }
    const durableDispatch = this.store.listUnacknowledgedOutbox(5000).find((message) => (
      message.targetId === targetId && message.sessionPid === session.pid
      && ['QUEUED', 'SENDING', 'SENT_AWAITING_ACK'].includes(message.status)
    ));
    if (durableDispatch) return true;
    const activeDispatch = this.externalDispatches.get(targetId);
    if (!activeDispatch) return false;
    if (activeDispatch.pid !== session.pid) {
      this.externalDispatches.delete(targetId);
      return false;
    }
    const elapsed = this.now().getTime() - activeDispatch.deliveredAt;
    if (session.terminal?.state === 'WORKING') {
      activeDispatch.seenWorking = true;
      return true;
    }
    if (session.terminal?.state !== 'WAITING_INPUT') return true;
    const assistantAt = Date.parse(session.heartbeat?.latestAssistantAt || '');
    const assistantAdvanced = Number.isFinite(assistantAt) && assistantAt > activeDispatch.deliveredAt;
    const completedFastCycle = assistantAdvanced
      && session.terminal.tailHash !== activeDispatch.tailHash
      && elapsed >= this.config.goalLoop.graceMs;
    if (activeDispatch.seenWorking || completedFastCycle) {
      this.externalDispatches.delete(targetId);
      for (const event of this.store.listPendingAutomationEvents(1000).filter((candidate) => (
        candidate.targetId === targetId
        && candidate.eventType === 'SESSION_ACCEPTED_INPUT_STALLED'
      ))) {
        this.store.setAutomationEvent(event.id, {
          status: 'RESOLVED', note: 'assistant_progress_resumed_after_delivery',
        });
      }
      return false;
    }
    const postAckStallMs = this.config.goalLoop.postAckStallMs ?? 60_000;
    if (elapsed >= postAckStallMs) {
      const priorStalls = this.store.listAutomationEvents(1000).filter((candidate) => (
        candidate.targetId === targetId
        && candidate.eventType === 'SESSION_ACCEPTED_INPUT_STALLED'
        && candidate.status !== 'RESOLVED'
      ));
      this.store.createAutomationEvent({
        eventKey: `delivery:${activeDispatch.messageKey || targetId}:accepted_input_stalled`,
        category: 'session_watchdog', eventType: 'SESSION_ACCEPTED_INPUT_STALLED',
        targetId, severity: 'warn',
        title: `Accepted input produced no assistant event: ${targetId}`,
        message: 'The accepted continuation produced no assistant event; automatic retries remain held until assistant progress is observed.',
        source: {
          deliveryPolicy: 'manual', pid: session.pid,
          messageKey: activeDispatch.messageKey || null, elapsedMs: elapsed,
        },
      });
    }
    return true;
  }

  #markExternalDispatch(targetId, session, messageKey = null) {
    this.externalDispatches.set(targetId, {
      pid: session.pid,
      tailHash: session.terminal?.tailHash || null,
      deliveredAt: this.now().getTime(),
      seenWorking: false,
      messageKey,
    });
  }

  async #watchSessions() {
    const sessions = await this.sessionManager.list();
    const now = this.now().getTime();
    for (const session of sessions) {
      if (session.status === 'WAITING_INPUT' && session.bootstrapStatus === 'PENDING') {
        try {
          await this.sessionManager.bootstrap(session.id);
          this.store.createAutomationEvent({
            eventKey: `session:${session.id}:bootstrap_recovered`,
            category: 'session_watchdog',
            eventType: 'BOOTSTRAP_RECOVERED',
            targetId: session.projectId,
            severity: 'info',
            status: 'RESOLVED',
            title: `Recovered startup prompt: ${session.projectName}`,
            message: 'The watchdog delivered a pending fixed bootstrap prompt at the Claude ready prompt.',
            source: { deliveryPolicy: 'none', sessionId: session.id },
          });
        } catch (error) {
          this.store.createAutomationEvent({
            eventKey: `session:${session.id}:bootstrap_failed`,
            category: 'session_watchdog',
            eventType: 'BOOTSTRAP_FAILED',
            targetId: session.projectId,
            severity: 'error',
            title: `Startup prompt blocked: ${session.projectName}`,
            message: 'Claude is waiting, but the fixed project bootstrap prompt could not be delivered.',
            source: { deliveryPolicy: 'manual', sessionId: session.id },
            note: String(error.message || error).slice(0, 500),
          });
        }
      }
      const waitingSince = session.waitingSince ? Date.parse(session.waitingSince) : NaN;
      if (session.projectId !== 'GPU_SCHEDULER'
          && session.status === 'WAITING_INPUT'
          && Number.isFinite(waitingSince)
          && now - waitingSince >= this.config.watchdog.waitingMs) {
        this.store.createAutomationEvent({
          eventKey: `session:${session.id}:long_wait`,
          category: 'session_watchdog',
          eventType: 'LONG_WAITING_INPUT',
          targetId: session.projectId,
          severity: 'warn',
          title: `Session awaiting attention: ${session.projectName}`,
          message: 'The managed session has remained at an input prompt beyond the watchdog threshold.',
          source: { deliveryPolicy: 'manual', sessionId: session.id, waitingSince: session.waitingSince },
        });
      } else {
        this.#resolveEvent(`session:${session.id}:long_wait`, 'session_no_longer_waiting');
      }
      const unexpectedExit = session.status === 'EXITED'
        && session.exitCode !== null
        && ![0, 130, 143].includes(session.exitCode)
        && !session.stopRequestedAt;
      if (['LOST', 'FAILED'].includes(session.status) || unexpectedExit) {
        this.store.createAutomationEvent({
          eventKey: `session:${session.id}:unhealthy:${session.status}`,
          category: 'session_watchdog',
          eventType: 'SESSION_UNHEALTHY',
          targetId: session.projectId,
          severity: 'error',
          title: `Managed session ${session.status.toLowerCase()}: ${session.projectName}`,
          message: 'The managed Claude process needs an operational recovery decision.',
          source: { deliveryPolicy: 'manual', session },
        });
      } else {
        for (const status of ['LOST', 'FAILED', 'EXITED']) {
          this.#resolveEvent(
            `session:${session.id}:unhealthy:${status}`,
            'session_state_is_not_unexpectedly_unhealthy',
          );
        }
      }
    }
  }

  async #deliverPending() {
    const events = this.store.listPendingAutomationEvents(500)
      .filter((event) => event.source?.deliveryPolicy === 'auto_notify');
    if (!events.length) return;
    let sessions = await this.sessionManager.list();
    let external = null;
    const deliveredTargets = new Set();
    for (const event of events) {
      if (deliveredTargets.has(event.targetId)) continue;
      let candidates = sessions.filter((session) => (
        session.projectId === event.targetId
        && acceptsManagedOperationalInput(session)
      ));
      if (candidates.length === 1) {
        try {
          await this.sessionManager.input(candidates[0].id, `${automationPrompt(event)}\r`);
          this.store.setAutomationEvent(event.id, {
            status: 'DELIVERED',
            sessionId: candidates[0].id,
            deliveredAt: this.now().toISOString(),
            note: 'automatic_operational_notification',
          });
          deliveredTargets.add(event.targetId);
        } catch (error) {
          this.#holdEvent(event, `delivery_failed:${String(error.message || error).slice(0, 300)}`);
        }
        continue;
      }
      if (candidates.length > 1) {
        this.#holdEvent(event, 'multiple_waiting_managed_sessions');
        continue;
      }
      const authBlocked = sessions.some((session) => (
        session.projectId === event.targetId && session.bootstrapNeedsRetry
      ));
      if (authBlocked) {
        this.#holdEvent(event, 'target_authentication_required');
        continue;
      }

      external ||= await this.#externalSessions();
      const externalCandidates = (external.items || []).filter((session) => (
        (event.targetId === 'GPU_SCHEDULER'
          ? session.controlId === event.targetId
          : session.projectId === event.targetId)
        && acceptsExternalOperationalInput(session)
      ));
      if (externalCandidates.length === 1 && this.externalSessionInput) {
        if (this.#externalDispatchBlocked(event.targetId, externalCandidates[0])) continue;
        const result = await this.#sendExternalAcknowledged({
          event,
          session: externalCandidates[0],
          prompt: automationPrompt(event),
          note: 'external_iterm_operational_notification',
        });
        if (result.status !== 'failed') deliveredTargets.add(event.targetId);
        continue;
      }
      if (externalCandidates.length > 1) {
        this.#holdEvent(event, 'multiple_waiting_external_sessions');
        continue;
      }

      if (event.targetId === 'GPU_SCHEDULER') {
        const disposition = await this.#maybeStartControl(sessions, event);
        if (disposition !== 'unchanged') continue;
        sessions = await this.sessionManager.list();
      }
      if (!this.externalSessionInput && (external.items || []).some((session) => (
        event.targetId === 'GPU_SCHEDULER'
          ? session.controlId === event.targetId
          : session.projectId === event.targetId
      ))) {
        this.#holdEvent(event, 'external_delivery_adapter_unavailable');
      } else {
        const authBlocked = sessions.some((session) => (
          session.projectId === event.targetId && session.bootstrapNeedsRetry
        ));
        this.#holdEvent(
          event,
          authBlocked ? 'target_authentication_required'
            : candidates.length > 1 ? 'multiple_waiting_managed_sessions'
              : 'no_waiting_managed_session',
        );
      }
    }
  }

  async #maybeStartControl(sessions, event) {
    const targetId = event.targetId;
    if (targetId !== 'GPU_SCHEDULER') return 'unchanged';
    const autoStart = this.config.gpuQueue.schedulerAutoStart;
    if (!autoStart) return 'unchanged';
    if (sessions.some((session) => (
      session.projectId === targetId && ACTIVE_SESSION_STATES.has(session.status)
    ))) return 'unchanged';
    const external = await this.#externalSessions();
    if (external.items?.some((session) => session.controlId === targetId)) {
      this.#holdEvent(event, 'scheduler_is_external_and_cannot_be_injected');
      return 'external';
    }
    try {
      const started = await this.sessionManager.start(targetId, {
        cols: 120,
        rows: 32,
        bootstrap: true,
      });
      this.#holdEvent(
        event,
        'scheduler_auto_started_waiting_for_ready_prompt',
        started.id,
      );
      return 'started';
    } catch (error) {
      this.#holdEvent(
        event,
        `scheduler_auto_start_failed:${String(error.message || error).slice(0, 300)}`,
      );
      return 'failed';
    }
  }

  async #runGoalLoop() {
    if (this.config.goalLoop?.enabled !== true) return;
    const policies = this.store.listAutomationPolicies().filter((policy) => policy.enabled);
    if (!policies.length) return;
    let sessions = await this.sessionManager.list();
    let external = null;
    for (const policy of policies) {
      if (!this.projectIds.has(policy.targetId)) continue;
      const managed = sessions.find((session) => (
        session.projectId === policy.targetId && ACTIVE_SESSION_STATES.has(session.status)
      ));
      if (!managed) {
        external ||= await this.#externalSessions();
        const externalSession = external.items?.find((session) => session.projectId === policy.targetId);
        if (externalSession) {
          const waitingKey = `${policy.targetId}:${externalSession.pid}`;
          if (jobWaitStatus(externalSession, this.jobsSnapshot()).waiting) {
            this.externalWaitingSince.delete(waitingKey);
            continue;
          }
          if (Number(externalSession.heartbeat?.activeToolProcessCount || 0) > 0) {
            this.externalWaitingSince.delete(waitingKey);
            continue;
          }
          if (this.#externalDispatchBlocked(policy.targetId, externalSession)) {
            if (externalSession.terminal?.state !== 'WAITING_INPUT') {
              this.externalWaitingSince.delete(waitingKey);
            }
            continue;
          }
          if (externalSession.terminal?.state !== 'WAITING_INPUT') {
            this.externalWaitingSince.delete(waitingKey);
            if (externalSession.terminal?.state === 'CONFIRMATION') {
              this.store.createAutomationEvent({
                eventKey: `goal:${waitingKey}:confirmation:${externalSession.terminal.tailHash || 'unknown'}`,
                category: 'goal_loop', eventType: 'GOAL_CONFIRMATION_REQUIRED',
                targetId: policy.targetId, severity: 'warn',
                title: `${policy.targetId} requires interactive confirmation`,
                message: 'Goal Loop does not answer trust, permission, or approval prompts.',
                source: { deliveryPolicy: 'manual', pid: externalSession.pid },
              });
            }
            continue;
          }
          const waiting = this.externalWaitingSince.get(waitingKey);
          const tailHash = externalSession.terminal?.tailHash || 'unknown';
          if (!waiting || waiting.tailHash !== tailHash) {
            this.externalWaitingSince.set(waitingKey, {
              firstSeenAt: this.now().getTime(),
              tailHash,
            });
            continue;
          }
          if (this.now().getTime() - waiting.firstSeenAt < this.config.goalLoop.graceMs) continue;
          if (!this.externalSessionInput) {
            this.store.createAutomationEvent({
              eventKey: `goal:${policy.targetId}:external_session`,
              category: 'goal_loop', eventType: 'GOAL_EXTERNAL_SESSION',
              targetId: policy.targetId, severity: 'info', status: 'HELD',
              title: `Goal Loop cannot control external ${policy.targetId}`,
              message: 'The project is running outside the persistent broker and no safe iTerm relay is available.',
              source: { deliveryPolicy: 'manual', pid: externalSession.pid },
              note: 'migrate_project_to_managed_session_for_goal_loop',
            });
            continue;
          }
          const pendingIntervention = this.store.listInterventions(1000).some((item) => (
            item.projectId === policy.targetId && ['PROPOSED', 'HELD'].includes(item.status)
          ));
          const blockingEvent = this.store.listPendingAutomationEvents(1000).find((item) => (
            item.targetId === policy.targetId && item.category !== 'goal_loop'
            && (item.severity === 'error' || item.eventType === 'JOB_RESULT_READY')
          ));
          if (pendingIntervention || blockingEvent) continue;
          const since = goalBudgetSince(
            this.config,
            this.now(),
            externalSession.terminal?.lastRateLimitResetAt,
          );
          const recent = this.store.recentGoalActions(policy.targetId, since);
          if (recent.count >= this.config.goalLoop.maxContinuesPerDay) continue;
          // Delivery acknowledgement prevents duplicate input, while the cooldown
          // prevents blind retries. A new assistant turn is a new input point and
          // may contain routine options that Claude must resolve autonomously.
          const latestAssistantAt = Date.parse(externalSession.heartbeat?.latestAssistantAt || '');
          const assistantAdvanced = recent.lastDeliveredAt
            && Number.isFinite(latestAssistantAt)
            && latestAssistantAt > Date.parse(recent.lastDeliveredAt);
          if (recent.lastDeliveredAt && !assistantAdvanced
              && this.now().getTime() - Date.parse(recent.lastDeliveredAt)
                < this.config.goalLoop.cooldownMs) {
            continue;
          }
          const event = this.store.createAutomationEvent({
            eventKey: `goal:external:${externalSession.pid}:${externalSession.terminal.tailHash}:continue`,
            category: 'goal_loop', eventType: 'GOAL_CONTINUED',
            targetId: policy.targetId, severity: 'info',
            title: `Goal Loop continued external ${policy.targetId}`,
            message: 'A fixed, scope-preserving continuation was sent to a verified iTerm input prompt.',
            source: { deliveryPolicy: 'none', pid: externalSession.pid },
          });
          if (!['PENDING', 'HELD'].includes(event.status)) continue;
          const delivery = await this.#sendExternalAcknowledged({
            event,
            session: externalSession,
            prompt: goalPrompt(policy),
            note: 'goal_loop_external_iterm_continue',
          });
          if (delivery.status !== 'failed') {
            this.externalWaitingSince.delete(waitingKey);
          }
          continue;
        }
        try {
          const started = await this.sessionManager.start(policy.targetId, {
            cols: 120,
            rows: 32,
            bootstrap: true,
          });
          sessions = await this.sessionManager.list();
          this.store.createAutomationEvent({
            eventKey: `goal:${policy.targetId}:started:${started.id}`,
            category: 'goal_loop',
            eventType: 'GOAL_SESSION_STARTED',
            targetId: policy.targetId,
            severity: 'info',
            status: 'RESOLVED',
            title: `Goal Loop started ${policy.targetId}`,
            message: 'A managed research session was started with the fixed project bootstrap.',
            source: { deliveryPolicy: 'none', sessionId: started.id },
          });
        } catch (error) {
          this.store.createAutomationEvent({
            eventKey: `goal:${policy.targetId}:start_failed`,
            category: 'goal_loop',
            eventType: 'GOAL_START_FAILED',
            targetId: policy.targetId,
            severity: 'error',
            title: `Goal Loop could not start ${policy.targetId}`,
            message: 'The fixed managed session could not be started.',
            source: { deliveryPolicy: 'manual' },
            note: String(error.message || error).slice(0, 500),
          });
        }
        continue;
      }
      // Managed PTYs still write normal Claude history. Use that assistant-only
      // evidence for GPU waits so echoed prompts cannot forge a wait marker.
      external ||= await this.#externalSessions();
      const managedHistory = external.items?.find((session) => (
        session.projectId === policy.targetId
        && (managed.pid == null || session.pid === managed.pid)
      ));
      if (jobWaitStatus(managedHistory, this.jobsSnapshot()).waiting) continue;
      if (Number(managedHistory?.heartbeat?.activeToolProcessCount || 0) > 0) continue;
      if (managed.status !== 'WAITING_INPUT' || managed.bootstrapStatus !== 'SENT') continue;
      const waitingSince = managed.waitingSince ? Date.parse(managed.waitingSince) : NaN;
      if (!Number.isFinite(waitingSince)
          || this.now().getTime() - waitingSince < this.config.goalLoop.graceMs) continue;
      if (managed.waitReason !== 'claude_prompt') {
        this.store.createAutomationEvent({
          eventKey: `goal:${managed.id}:${managed.waitingSince}:confirmation`,
          category: 'goal_loop',
          eventType: 'GOAL_CONFIRMATION_REQUIRED',
          targetId: policy.targetId,
          severity: 'warn',
          title: `${policy.targetId} requires interactive confirmation`,
          message: 'Goal Loop does not answer trust, permission, or approval prompts.',
          source: { deliveryPolicy: 'manual', sessionId: managed.id },
        });
        continue;
      }
      const pendingIntervention = this.store.listInterventions(1000).some((item) => (
        item.projectId === policy.targetId && ['PROPOSED', 'HELD'].includes(item.status)
      ));
      const blockingEvent = this.store.listPendingAutomationEvents(1000).find((item) => (
        item.targetId === policy.targetId
        && item.category !== 'goal_loop'
        && (item.severity === 'error' || item.eventType === 'JOB_RESULT_READY')
      ));
      if (pendingIntervention || blockingEvent) {
        this.store.createAutomationEvent({
          eventKey: `goal:${managed.id}:${managed.waitingSince}:blocked`,
          category: 'goal_loop',
          eventType: 'GOAL_BLOCKED_BY_INBOX',
          targetId: policy.targetId,
          severity: 'warn',
          title: `${policy.targetId} Goal Loop paused for review`,
          message: 'A research-boundary intervention or high-priority operational event requires attention first.',
          source: {
            deliveryPolicy: 'manual',
            sessionId: managed.id,
            blocker: pendingIntervention ? 'codex_intervention' : blockingEvent?.eventKey,
          },
        });
        continue;
      }
      const since = goalBudgetSince(this.config, this.now());
      const recent = this.store.recentGoalActions(policy.targetId, since);
      if (recent.count >= this.config.goalLoop.maxContinuesPerDay) {
        this.store.createAutomationEvent({
          eventKey: `goal:${policy.targetId}:daily_budget:${since.slice(0, 10)}`,
          category: 'goal_loop',
          eventType: 'GOAL_DAILY_BUDGET_REACHED',
          targetId: policy.targetId,
          severity: 'warn',
          title: `${policy.targetId} reached its Goal Loop daily limit`,
          message: 'Automatic continuation stopped before unbounded token use.',
          source: { deliveryPolicy: 'manual', count: recent.count },
        });
        continue;
      }
      if (recent.lastDeliveredAt
          && this.now().getTime() - Date.parse(recent.lastDeliveredAt) < this.config.goalLoop.cooldownMs) {
        continue;
      }
      const event = this.store.createAutomationEvent({
        eventKey: `goal:${managed.id}:${managed.waitingSince}:continue`,
        category: 'goal_loop',
        eventType: 'GOAL_CONTINUED',
        targetId: policy.targetId,
        severity: 'info',
        title: `Goal Loop continued ${policy.targetId}`,
        message: 'A fixed, scope-preserving continuation was sent at a normal Claude input prompt.',
        source: { deliveryPolicy: 'none', sessionId: managed.id },
      });
      if (!['PENDING', 'HELD'].includes(event.status)) continue;
      const prompt = goalPrompt(policy);
      try {
        await this.sessionManager.input(managed.id, `${prompt}\r`);
        this.store.setAutomationEvent(event.id, {
          status: 'DELIVERED',
          sessionId: managed.id,
          deliveredAt: this.now().toISOString(),
          note: 'goal_loop_scope_preserving_continue',
        });
      } catch (error) {
        this.#holdEvent(event, `goal_continue_failed:${String(error.message || error).slice(0, 300)}`);
      }
    }
  }

  async continueReviewedStop(stop, review = {}) {
    const policy = this.store.listAutomationPolicies()
      .find((item) => item.targetId === stop.projectId && item.enabled);
    if (!policy) return { status: 'goal_disabled' };
    if (!['PASS', 'WARN'].includes(review.verdict)) {
      return { status: 'review_not_cleared', verdict: review.verdict || null };
    }
    if (!this.externalSessionInput) return { status: 'external_input_unavailable' };

    const pendingIntervention = this.store.listInterventions(1000).some((item) => (
      item.projectId === stop.projectId && ['PROPOSED', 'HELD'].includes(item.status)
    ));
    const blockingEvent = this.store.listPendingAutomationEvents(1000).find((item) => (
      item.targetId === stop.projectId
      && item.category !== 'goal_loop'
      && (item.severity === 'error' || item.eventType === 'JOB_RESULT_READY')
    ));
    if (pendingIntervention || blockingEvent) {
      return {
        status: 'blocked',
        blocker: pendingIntervention ? 'codex_intervention' : blockingEvent.eventKey,
      };
    }

    const since = goalBudgetSince(this.config, this.now());
    const recent = this.store.recentGoalActions(stop.projectId, since);
    if (recent.count >= this.config.goalLoop.maxContinuesPerDay) {
      this.store.createAutomationEvent({
        eventKey: `goal:${stop.projectId}:daily_budget:${since.slice(0, 10)}`,
        category: 'goal_loop', eventType: 'GOAL_DAILY_BUDGET_REACHED',
        targetId: stop.projectId, severity: 'warn',
        title: `${stop.projectId} reached its Goal Loop daily limit`,
        message: 'Automatic continuation stopped before unbounded token use.',
        source: { deliveryPolicy: 'manual', count: recent.count },
      });
      return { status: 'daily_budget_reached', count: recent.count };
    }

    this.externalSnapshot = null;
    const external = await this.#externalSessions();
    const candidates = (external.items || []).filter((session) => (
      session.projectId === stop.projectId && session.pid === stop.pid
    ));
    if (candidates.length !== 1) return { status: 'session_changed' };
    const session = candidates[0];
    const jobWait = jobWaitStatus(session, this.jobsSnapshot());
    if (jobWait.waiting) {
      return { status: 'waiting_for_job', runIds: jobWait.matchedRunIds };
    }
    if (session.terminal?.state !== 'WAITING_INPUT') {
      return { status: 'session_already_running', terminalState: session.terminal?.state || 'UNKNOWN' };
    }

    // A witnessed WORKING -> WAITING transition proves the prior dispatch completed.
    // This reviewed stop may bypass the ordinary cooldown, but never the daily budget.
    if (stop.previousState === 'WORKING') {
      this.externalDispatches.delete(stop.projectId);
    } else if (this.#externalDispatchBlocked(stop.projectId, session)) {
      return { status: 'dispatch_latched' };
    }

    const event = this.store.createAutomationEvent({
      eventKey: `goal:reviewed-stop:${stop.projectId}:${stop.pid}:${stop.episodeId || stop.tailHash}:continue`,
      category: 'goal_loop', eventType: 'GOAL_CONTINUED',
      targetId: stop.projectId, severity: 'info',
      title: `Reviewed stop continued: ${stop.projectId}`,
      message: 'Codex cleared this stopping point and Goal Loop resumed it without waiting for the ordinary cooldown.',
      source: {
        deliveryPolicy: 'none', pid: stop.pid, stopTailHash: stop.tailHash,
        stopEpisodeId: stop.episodeId || null,
        reviewVerdict: review.verdict,
      },
    });
    if (!['PENDING', 'HELD'].includes(event.status)) return { status: 'already_dispatched' };
    const delivery = await this.#sendExternalAcknowledged({
      event,
      session,
      prompt: goalPrompt(policy),
      note: `reviewed_stop_${review.verdict.toLowerCase()}_continue`,
    });
    if (delivery.status !== 'failed') {
      this.externalWaitingSince.delete(`${stop.projectId}:${stop.pid}`);
      return {
        status: delivery.status === 'acknowledged' ? 'continued' : 'awaiting_history_ack',
        eventId: event.id,
        messageKey: delivery.message.messageKey,
      };
    }
    return { status: 'delivery_failed', eventId: event.id };
  }

  async continueExternalSession(session, prompt) {
    if (!this.externalSessionInput) return { status: 'external_input_unavailable' };
    if (session.terminal?.state !== 'WAITING_INPUT') {
      return { status: 'session_not_waiting', terminalState: session.terminal?.state || 'UNKNOWN' };
    }
    const pending = this.store.listUnacknowledgedOutbox(5000).find((message) => (
      message.targetId === session.projectId && message.sessionPid === session.pid
      && ['QUEUED', 'SENDING', 'SENT_AWAITING_ACK'].includes(message.status)
    ));
    if (pending) {
      return { status: 'blocked_by_pending_delivery', messageKey: pending.messageKey };
    }
    const episodeId = session.heartbeat?.episodeId || session.terminal?.tailHash || 'unknown';
    const event = this.store.createAutomationEvent({
      eventKey: `session:manual-continue:${session.projectId}:${session.pid}:${episodeId}`,
      category: 'session_control',
      eventType: 'MANUAL_CONTINUATION',
      targetId: session.projectId,
      severity: 'info',
      title: `Manual continuation: ${session.projectId}`,
      message: 'The user requested a fixed continuation at a verified Claude input prompt.',
      source: { deliveryPolicy: 'none', pid: session.pid, episodeId },
    });
    const delivery = await this.#sendExternalAcknowledged({
      event,
      session,
      prompt,
      note: 'user_requested_external_continuation',
    });
    return {
      status: delivery.status,
      eventId: event.id,
      messageKey: delivery.message?.messageKey || null,
    };
  }

  async deliver(eventId, requestedSessionId = null) {
    const event = this.store.listAutomationEvents(1000)
      .find((candidate) => candidate.id === Number(eventId));
    if (!event) throw new Error('Automation event was not found');
    if (!['PENDING', 'HELD'].includes(event.status)) throw new Error('Automation event is not pending');
    if (!event.targetId) throw new Error('Automation event has no mapped target');
    const sessions = await this.sessionManager.list();
    const candidates = sessions.filter((session) => (
      session.projectId === event.targetId
      && session.status === 'WAITING_INPUT'
      && !session.bootstrapNeedsRetry
    ));
    const session = requestedSessionId
      ? candidates.find((candidate) => candidate.id === requestedSessionId)
      : candidates.length === 1 ? candidates[0] : null;
    if (!session) {
      const authBlocked = sessions.some((candidate) => (
        candidate.projectId === event.targetId && candidate.bootstrapNeedsRetry
      ));
      throw new Error(authBlocked
        ? 'Target authentication is required before delivery'
        : 'Exactly one waiting managed target session is required');
    }
    await this.sessionManager.input(session.id, `${automationPrompt(event)}\r`);
    return this.store.setAutomationEvent(event.id, {
      status: 'DELIVERED',
      sessionId: session.id,
      deliveredAt: this.now().toISOString(),
      note: 'user_approved_operational_notification',
    });
  }
}

export const automationInternals = Object.freeze({
  eventProject, queuePrompt, automationPrompt, goalPrompt, selfResolveChoicePrompt,
  acceptsExternalOperationalInput, acceptsManagedOperationalInput,
  deliveryKey, acknowledgedPrompt,
});
