import { createHash } from 'node:crypto';
import { collectGpuQueue, emptyGpuQueueSnapshot } from './gpu-queue.js';
import { JobRegistry } from './job-registry.js';
import { probeSchedulerMonitor } from './scheduler-monitor.js';

const ACTIVE_SESSION_STATES = new Set(['RUNNING', 'RATE_LIMITED', 'PROVIDER_TRANSIENT', 'WAITING_INPUT']);
const INPUT_STATES = new Set([
  'WAITING_INPUT', 'ROUTINE_CHOICE', 'BOUNDARY_CHOICE', 'INTERACTIVE_CONFIRMATION',
]);
const TERMINAL_QUEUE_STATES = new Set(['done', 'failed', 'cancelled']);
const AUTO_DELIVERY_TYPES = new Set([
  'CONTINUITY_RESUME_READY',
  'CONTINUITY_CHOICE_READY',
  'JOB_RESULT_READY',
  'GPU_PREPARATION_REQUIRED',
  'GPU_REQUEST_SUBMITTED',
  'GPU_SCHEDULER_MONITOR_MISSING',
  'GPU_EFFICIENCY_ALERT',
  'GPU_RESULT_READY',
]);

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
  const envelope = {
    schema: 'firm.operational-event.v1',
    eventId: event.id,
    eventType: event.eventType,
    projectId: event.targetId || null,
    runId: event.runId || null,
  };
  if (event.eventType === 'CONTINUITY_RESUME_READY') {
    return `[FIRM CONTINUITY ${event.source?.episode || event.id}]\n${event.message}`;
  }
  if (event.eventType === 'JOB_RESULT_READY') {
    const job = event.source?.job || {};
    return `[FIRM_JOB_EVENT] ${JSON.stringify({
      ...envelope,
      state: job.state || null,
      kind: job.kind || null,
      executor: job.executor || null,
      result: job.result || null,
    })}`;
  }
  if (event.eventType === 'GPU_PREPARATION_REQUIRED') {
    const readiness = item.submissionReadiness || { state: 'NOT_READY', missing: [] };
    return `[FIRM_JOB_EVENT] ${JSON.stringify({
      ...envelope,
      state: readiness.state,
      missing: readiness.missing || [],
      remotePath: item.remotePath || null,
    })}`;
  }
  return `[FIRM_CONTROL_EVENT] ${JSON.stringify({
    ...envelope,
    queueState: item.state || null,
    remotePath: item.remotePath || null,
    readiness: item.submissionReadiness || null,
    telemetry: item.telemetry || null,
    efficiency: item.efficiency || null,
    monitorHealth: event.source?.monitorHealth || null,
  })}`;
}

function automationPrompt(event) { return queuePrompt(event); }

function acceptsExternalOperationalInput(session) {
  return session.terminal?.state === 'WAITING_INPUT'
    || (session.terminal?.state === 'WORKING' && session.terminal?.acceptsQueuedInput === true);
}

function acceptsExternalEventInput(event, session) {
  if (event.eventType !== 'CONTINUITY_RESUME_READY') {
    return acceptsExternalOperationalInput(session);
  }
  const sameProcess = Number(event.source?.pid) === Number(session.pid);
  const sameEpisode = event.source?.episode
    && event.source.episode === session.heartbeat?.episodeId;
  return sameProcess && sameEpisode && session.terminal?.state === 'WAITING_INPUT';
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
    externalSessionChoose = null,
    schedulerMonitorProbe = probeSchedulerMonitor,
    jobRegistry = null,
    continuitySupervisor = null,
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
    this.externalSessionChoose = externalSessionChoose;
    this.schedulerMonitorProbe = schedulerMonitorProbe;
    this.jobRegistry = jobRegistry || new JobRegistry({ store, now });
    this.continuitySupervisor = continuitySupervisor;
    this.now = now;
    this.projectIds = new Set(config.projects.map((project) => project.id));
    this.queue = store.latestGpuQueueSnapshot()?.snapshot
      || emptyGpuQueueSnapshot(config.gpuQueue.enabled ? 'pending' : 'disabled');
    this.cyclePromise = null;
    this.lastQueuePollAt = 0;
    this.externalDispatches = new Map();
    this.externalTerminalStates = new Map();
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
    if (this.continuitySupervisor) {
      const external = await this.#externalSessions();
      this.continuitySupervisor.observe({
        sessions: external.items || [],
        jobs: this.jobsSnapshot(),
        events: this.store.listAutomationEvents(1000),
        outbox: this.store.listOutboxMessages(1000),
        schedulerMonitor: this.monitorSnapshot(),
      });
    }
    await this.#deliverPending();
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
      const tailHash = session.terminal?.tailHash || 'unknown';
      if (['PROVIDER_TRANSIENT', 'RATE_LIMITED'].includes(current)) {
        await this.#observeProviderWait(session, tailHash);
        continue;
      }
      if (handledInteractions.has(key)) {
        continue;
      }
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
        }
      } else if (priorProgress) {
        if (priorProgress.eventKey) {
          this.#resolveEvent(priorProgress.eventKey, `progress_watch_became_${current.toLowerCase()}`);
        }
        this.externalProgressCandidates.delete(key);
      }
      // ContinuitySupervisor owns stable input and routine-choice episodes.
      // The watchdog records liveness here without creating a second decision path.
      if (INPUT_STATES.has(current)) continue;
    }
    for (const key of this.externalTerminalStates.keys()) {
      if (!seen.has(key)) {
        this.externalTerminalStates.delete(key);
        const unknown = this.externalUnknownCandidates.get(key);
        if (unknown?.eventKey) this.#resolveEvent(unknown.eventKey, 'session_no_longer_present');
        this.externalUnknownCandidates.delete(key);
        const progress = this.externalProgressCandidates.get(key);
        if (progress?.eventKey) this.#resolveEvent(progress.eventKey, 'session_no_longer_present');
        this.externalProgressCandidates.delete(key);
      }
    }
  }

  async #observeProviderWait(session, tailHash) {
    const terminal = session.terminal || {};
    const isRateLimit = terminal.state === 'RATE_LIMITED';
    const fingerprint = isRateLimit
      ? terminal.resetAt || tailHash
      : terminal.providerFailureFingerprint || tailHash;
    const event = this.store.createAutomationEvent({
      eventKey: `provider-wait:${session.projectId}:${session.pid}:${terminal.state}:${fingerprint}`,
      category: 'session_control',
      eventType: isRateLimit ? 'PROVIDER_RATE_WAIT' : 'PROVIDER_TRANSIENT_WAIT',
      targetId: session.projectId,
      severity: 'info',
      status: 'RESOLVED',
      title: `${isRateLimit ? 'Rate limit' : 'Provider transient'} observed: ${session.projectId}`,
      message: 'Provider availability is an operational observation. FIRM does not inject research text, retries, or instructions into the Claude session.',
      source: { deliveryPolicy: 'none', pid: session.pid, terminalState: terminal.state,
        resetAt: terminal.resetAt || null, providerFailureFingerprint: terminal.providerFailureFingerprint || null },
      note: 'passive_provider_observation',
    });
    if (!isRateLimit || typeof this.externalSessionSubmit !== 'function') return;
    const resetAt = Date.parse(terminal.resetAt || '');
    if (!Number.isFinite(resetAt) || this.now().getTime() < resetAt) return;
    const resume = this.store.createAutomationEvent({
      eventKey: `provider-rate-resume:${session.projectId}:${session.pid}:${terminal.resetAt || tailHash}`,
      category: 'session_control', eventType: 'PROVIDER_RATE_RESUME_ENTER',
      targetId: session.projectId, severity: 'info',
      title: `Rate-limit resume attempt: ${session.projectId}`,
      message: 'FIRM issued one Enter-only continuation after the stated provider reset. No text was injected.',
      source: { deliveryPolicy: 'enter_only_once', pid: session.pid, resetAt: terminal.resetAt || null,
        observedEventId: event.id },
    });
    if (resume.status !== 'PENDING') return;
    // Persist before the irreversible keypress: supervisor restarts can never replay it.
    this.store.setAutomationEvent(resume.id, { status: 'SENT', note: 'enter_only_dispatch_started' });
    try {
      await this.externalSessionSubmit(session);
      this.store.setAutomationEvent(resume.id, {
        status: 'DELIVERED', sessionId: session.id || null,
        deliveredAt: this.now().toISOString(), note: 'enter_only_rate_resume',
      });
    } catch (error) {
      this.store.setAutomationEvent(resume.id, {
        status: 'HELD', note: `enter_only_rate_resume_failed:${String(error.message || error).slice(0, 300)}`,
      });
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
        && terminal.state === 'DRAFT_PENDING_ENTER'
        && terminal.draftDeliveryMarker === prior.marker;
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
          const retryDelayMs = this.config.watchdog.enterRetryMs ?? 2_000;
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
      const retryDelayMs = this.config.watchdog.enterRetryMs ?? 2_000;
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
      && session.terminal.tailHash !== activeDispatch.tailHash;
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
    const postAckStallMs = this.config.watchdog.postAckStallMs ?? 60_000;
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

    // Session ids are process instances, while watchdog health belongs to the
    // configured target. Once a newer healthy instance owns a target, an older
    // instance's failure is history rather than an actionable current fault.
    const healthyByTarget = new Map();
    for (const session of sessions) {
      if (!['RUNNING', 'WAITING_INPUT', 'RATE_LIMITED'].includes(session.status)) continue;
      const prior = healthyByTarget.get(session.projectId);
      if (!prior || Date.parse(session.createdAt || '') > Date.parse(prior.createdAt || '')) {
        healthyByTarget.set(session.projectId, session);
      }
    }
    for (const event of this.store.listPendingAutomationEvents(1000).filter((candidate) => (
      candidate.eventType === 'SESSION_UNHEALTHY'
    ))) {
      const replacement = healthyByTarget.get(event.targetId);
      const failed = event.source?.session;
      if (!replacement || !failed?.id || replacement.id === failed.id) continue;
      const replacementAt = Date.parse(replacement.createdAt || '');
      const failedAt = Date.parse(failed.createdAt || '');
      if (!Number.isFinite(replacementAt) || !Number.isFinite(failedAt) || replacementAt <= failedAt) {
        continue;
      }
      this.store.setAutomationEvent(event.id, {
        status: 'RESOLVED',
        sessionId: replacement.id,
        note: 'superseded_by_newer_healthy_managed_session',
      });
    }
  }

  async #deliverPending() {
    const events = this.store.listPendingAutomationEvents(500)
      .filter((event) => (
        event.source?.deliveryPolicy === 'auto_notify'
        && AUTO_DELIVERY_TYPES.has(event.eventType)
      ));
    if (!events.length) return;
    let sessions = await this.sessionManager.list();
    let external = null;
    const deliveredTargets = new Set();
    for (const event of events) {
      if (deliveredTargets.has(event.targetId)) continue;
      if (event.eventType === 'CONTINUITY_CHOICE_READY') {
        external ||= await this.#externalSessions();
        const projectSessions = (external.items || []).filter((session) => (
          session.projectId === event.targetId
        ));
        const candidates = projectSessions.filter((session) => (
          Number(event.source?.pid) === Number(session.pid)
          && event.source?.episode === session.heartbeat?.episodeId
          && session.terminal?.state === 'ROUTINE_CHOICE'
        ));
        if (candidates.length === 1 && this.externalSessionChoose) {
          const session = candidates[0];
          const currentChoice = Number(session.terminal?.selectedOptionNumber);
          const targetChoice = Number(event.source?.optionNumber);
          if (!Number.isSafeInteger(currentChoice) || currentChoice < 1
              || !Number.isSafeInteger(targetChoice) || targetChoice < 1) {
            this.#holdEvent(event, 'invalid_continuity_choice_coordinates');
            continue;
          }
          // Mark the event before sending key strokes. If iTerm reports an error
          // after a partial write, replaying arrows could select a different item.
          this.store.setAutomationEvent(event.id, {
            status: 'SENT',
            sessionId: `external:${session.pid}`,
            note: `continuity_choice_dispatching:${currentChoice}->${targetChoice}`,
          });
          try {
            await this.externalSessionChoose(session, currentChoice, targetChoice);
            this.store.setAutomationEvent(event.id, {
              status: 'DELIVERED',
              sessionId: `external:${session.pid}`,
              deliveredAt: this.now().toISOString(),
              note: `continuity_choice_submitted:${currentChoice}->${targetChoice}`,
            });
            deliveredTargets.add(event.targetId);
          } catch (error) {
            const detail = String(error.message || error).slice(0, 300);
            this.store.setAutomationEvent(event.id, {
              status: 'SENT',
              sessionId: `external:${session.pid}`,
              note: `continuity_choice_dispatch_uncertain:${detail}`,
            });
            this.store.createAutomationEvent({
              eventKey: `${event.eventKey}:dispatch-uncertain`,
              category: 'research_continuity',
              eventType: 'CONTINUITY_CHOICE_DISPATCH_UNCERTAIN',
              targetId: event.targetId,
              severity: 'error',
              title: `Routine choice dispatch uncertain: ${event.targetId}`,
              message: 'The iTerm choice action may have been partially applied and will not be replayed automatically.',
              source: {
                deliveryPolicy: 'manual', pid: session.pid,
                episode: event.source?.episode, currentChoice, targetChoice, detail,
              },
            });
          }
          continue;
        }
        if (candidates.length > 1) {
          this.#holdEvent(event, 'multiple_matching_continuity_choice_sessions');
          continue;
        }
        if (projectSessions.length) {
          this.#resolveEvent(event.eventKey, 'stale_continuity_choice_episode');
          continue;
        }
        this.#holdEvent(event, this.externalSessionChoose
          ? 'continuity_choice_session_not_found'
          : 'external_choice_adapter_unavailable');
        continue;
      }
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
        && acceptsExternalEventInput(event, session)
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

      if (event.eventType === 'CONTINUITY_RESUME_READY') {
        const current = (external.items || []).find((session) => (
          session.projectId === event.targetId
        ));
        if (current && (Number(event.source?.pid) !== Number(current.pid)
            || event.source?.episode !== current.heartbeat?.episodeId
            || current.terminal?.state !== 'WAITING_INPUT')) {
          this.#resolveEvent(event.eventKey, 'stale_continuity_episode');
          continue;
        }
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

  async deliver(eventId, requestedSessionId = null) {
    const event = this.store.listAutomationEvents(1000)
      .find((candidate) => candidate.id === Number(eventId));
    if (!event) throw new Error('Automation event was not found');
    if (!['PENDING', 'HELD'].includes(event.status)) throw new Error('Automation event is not pending');
    if (!AUTO_DELIVERY_TYPES.has(event.eventType)) {
      throw new Error('Only allowlisted operational or continuity events can be delivered');
    }
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
  eventProject, queuePrompt, automationPrompt,
  acceptsExternalOperationalInput, acceptsManagedOperationalInput,
  deliveryKey, acknowledgedPrompt,
});
