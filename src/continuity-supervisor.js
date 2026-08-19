import { createHash } from 'node:crypto';
import { deriveOperationalState } from './session-state.js';
import { activeJobs } from './job-wait.js';

const ELIGIBLE_STATES = new Set(['READY_FOR_INPUT', 'CONSTRUCTION_ACTIVE', 'ROUTINE_CHOICE']);

function episodeIdentity(session) {
  return String(session.heartbeat?.episodeId
    || session.heartbeat?.historyCursor
    || session.terminal?.tailHash
    || `${session.pid}:${session.terminal?.state || 'unknown'}`);
}

function episodeKey(session) {
  return createHash('sha256').update(episodeIdentity(session)).digest('hex').slice(0, 24);
}

function retryAt(note) {
  const match = String(note || '').match(/retry_at=([^;]+)/);
  const value = match ? Date.parse(match[1]) : NaN;
  return Number.isFinite(value) ? value : null;
}

export class ContinuitySupervisor {
  constructor({ config, store, resolver, now = () => new Date() }) {
    this.config = config;
    this.store = store;
    this.resolver = resolver;
    this.now = now;
    this.projects = new Map(config.projects.map((project) => [project.id, project]));
    this.inflight = new Map();
    this.firstReadyAt = new Map();
  }

  snapshot() {
    return {
      enabled: this.config.continuity?.enabled === true,
      inflight: [...this.inflight.keys()],
    };
  }

  async idle() {
    await Promise.allSettled([...this.inflight.values()]);
  }

  observe({ sessions, jobs, events, outbox, schedulerMonitor }) {
    if (!this.config.continuity?.enabled || !this.resolver) return;
    const byProject = new Map();
    for (const session of sessions || []) {
      if (!session.projectId || !this.projects.has(session.projectId)) continue;
      if (!byProject.has(session.projectId)) byProject.set(session.projectId, []);
      byProject.get(session.projectId).push(session);
    }

    for (const [projectId, candidates] of byProject) {
      if (candidates.length !== 1) {
        this.#recordAmbiguousOwner(projectId, candidates);
        continue;
      }
      const session = candidates[0];
      const operational = deriveOperationalState(session, {
        jobs, events, outbox, schedulerMonitor,
      });
      const key = `${projectId}:${session.pid}`;
      const terminalReady = ['WAITING_INPUT', 'ROUTINE_CHOICE'].includes(session.terminal?.state);
      const operationalState = session.terminal?.state === 'ROUTINE_CHOICE'
        ? 'ROUTINE_CHOICE' : operational.state;
      const eligible = terminalReady && ELIGIBLE_STATES.has(operationalState)
        && Number(session.heartbeat?.activeToolProcessCount || 0) === 0;
      if (!eligible) {
        this.firstReadyAt.delete(key);
        continue;
      }

      const now = this.now().getTime();
      const assistantAt = Date.parse(session.heartbeat?.latestAssistantAt || '');
      const observedAt = this.firstReadyAt.get(key) || now;
      this.firstReadyAt.set(key, observedAt);
      const readyAt = Number.isFinite(assistantAt) ? Math.min(assistantAt, observedAt) : observedAt;
      if (now - readyAt < this.config.continuity.settleMs) continue;

      const episode = episodeIdentity(session);
      const eventKey = `continuity:${projectId}:${session.pid}:${episodeKey(session)}`;
      let event = this.store.createAutomationEvent({
        eventKey,
        category: 'research_continuity',
        eventType: 'CONTINUITY_REVIEW_REQUESTED',
        targetId: projectId,
        severity: 'info',
        title: `Continuity decision requested: ${projectId}`,
        message: 'A stable research input point has no active matching work and needs one AI PI continuity decision.',
        source: {
          deliveryPolicy: 'none',
          pid: session.pid,
          tty: session.tty,
          episode,
          operationalState,
        },
      });
      if (event.status === 'RESOLVED' || event.status === 'DELIVERED') continue;
      const due = retryAt(event.note);
      if (due && now < due) continue;
      if (this.inflight.has(eventKey)) continue;
      if (this.inflight.size >= this.config.continuity.maxConcurrent) continue;

      const task = this.#decide({ event, project: this.projects.get(projectId), session,
        operationalState, activeJobs: activeJobs(jobs, projectId) })
        .finally(() => this.inflight.delete(eventKey));
      this.inflight.set(eventKey, task);
    }
  }

  #recordAmbiguousOwner(projectId, sessions) {
    if (sessions.length < 2) return;
    this.store.createAutomationEvent({
      eventKey: `continuity:${projectId}:ambiguous-owner`,
      category: 'research_continuity',
      eventType: 'CONTINUITY_SESSION_AMBIGUOUS',
      targetId: projectId,
      severity: 'error',
      title: `Multiple live research sessions: ${projectId}`,
      message: 'Continuity is held because more than one live process maps to the same project.',
      source: {
        deliveryPolicy: 'none',
        sessions: sessions.map((session) => ({ pid: session.pid, tty: session.tty })),
      },
    });
  }

  async #decide({ event, project, session, operationalState, activeJobs: projectJobs }) {
    try {
      const decision = await this.resolver.resolve({
        project, session, operationalState, activeJobs: projectJobs,
      });
      if (decision.action === 'continue') {
        this.store.createAutomationEvent({
          eventKey: `${event.eventKey}:resume`,
          category: 'research_continuity',
          eventType: 'CONTINUITY_RESUME_READY',
          targetId: project.id,
          severity: 'info',
          title: `Research continuity ready: ${project.id}`,
          message: decision.message,
          source: {
            deliveryPolicy: 'auto_notify',
            continuityDecision: decision,
            pid: session.pid,
            episode: event.source?.episode || null,
          },
        });
        this.store.setAutomationEvent(event.id, {
          status: 'RESOLVED',
          note: `decision=continue; reason=${decision.reason}`,
        });
        return;
      }
      if (decision.action === 'choose') {
        this.store.createAutomationEvent({
          eventKey: `${event.eventKey}:choice`,
          category: 'research_continuity',
          eventType: 'CONTINUITY_CHOICE_READY',
          targetId: project.id,
          severity: 'info',
          title: `Routine research choice ready: ${project.id}`,
          message: decision.reason,
          source: {
            deliveryPolicy: 'auto_notify',
            continuityDecision: decision,
            pid: session.pid,
            episode: event.source?.episode || null,
            optionNumber: decision.optionNumber,
            selectedOptionNumber: session.terminal?.selectedOptionNumber || 1,
          },
        });
        this.store.setAutomationEvent(event.id, {
          status: 'RESOLVED',
          note: `decision=choose; option=${decision.optionNumber}; reason=${decision.reason}`,
        });
        return;
      }
      if (decision.action === 'owner_required') {
        this.store.createAutomationEvent({
          eventKey: `${event.eventKey}:owner-required`,
          category: 'research_continuity',
          eventType: 'CONTINUITY_OWNER_REQUIRED',
          targetId: project.id,
          severity: 'warn',
          title: `Owner action genuinely required: ${project.id}`,
          message: decision.reason,
          source: { deliveryPolicy: 'manual', pid: session.pid },
        });
      }
      this.store.setAutomationEvent(event.id, {
        status: 'RESOLVED',
        note: `decision=${decision.action}; reason=${decision.reason}`,
      });
    } catch (error) {
      const next = new Date(this.now().getTime() + this.config.continuity.retryMs).toISOString();
      this.store.setAutomationEvent(event.id, {
        status: 'HELD',
        note: `retry_at=${next}; resolver_error=${String(error.message || error).slice(0, 500)}`,
      });
    }
  }
}
