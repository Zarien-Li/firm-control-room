import { activeJobs, jobWaitStatus } from './job-wait.js';

export function deriveOperationalState(session, {
  events = [],
  outbox = [],
  schedulerMonitor = null,
  jobs = null,
} = {}) {
  const targetId = session.projectId || session.controlId || null;
  const terminalState = session.terminal?.state || 'UNKNOWN';
  const heartbeat = session.heartbeat || null;
  const activeEvents = events.filter((event) => (
    event.targetId === targetId && ['PENDING', 'HELD', 'SENT'].includes(event.status)
  ));
  const pendingDelivery = outbox.find((message) => (
    message.targetId === targetId
    && ['QUEUED', 'SENDING', 'SENT_AWAITING_ACK'].includes(message.status)
  ));

  if (heartbeat?.status === 'degraded' || !session.terminal) {
    return state('OBSERVABILITY_DEGRADED', 'History or terminal evidence is unavailable.');
  }
  if (terminalState === 'CONFIRMATION') {
    return state('CONFIRMATION_REQUIRED', 'Claude is waiting at an execution-safety confirmation.');
  }
  if (terminalState === 'ROUTINE_CHOICE') {
    return state(
      'ROUTINE_CHOICE_PENDING',
      session.terminal?.recommendedSelected
        ? `Claude is waiting to confirm its recommended option ${session.terminal.selectedOptionNumber}.`
        : 'Claude presented an ordinary choice that must be returned to Claude for self-resolution.',
    );
  }
  if (terminalState === 'RATE_LIMITED') {
    return state(
      'RATE_LIMITED',
      session.terminal?.resetAt
        ? `Provider usage limit resets at ${session.terminal.resetAt}.`
        : 'Provider usage limit is active; waiting for its reset time.',
    );
  }
  if (terminalState === 'PROVIDER_TRANSIENT') {
    return state(
      'PROVIDER_TRANSIENT',
      'Provider is temporarily unavailable. FIRM records this fact and does not inject text or retry the research turn.',
    );
  }
  if (terminalState === 'DRAFT_PENDING_ENTER') {
    return state('DRAFT_PENDING_ENTER', session.terminal?.draftDeliveryMarker
      ? `Tracked delivery ${session.terminal.draftDeliveryMarker} is pasted but not submitted.`
      : 'Text is present at the Claude prompt but has not been submitted.');
  }
  if (pendingDelivery) {
    return state('MESSAGE_PENDING_ACK', `Delivery ${pendingDelivery.messageKey} is not history-acknowledged.`);
  }
  const jobWait = jobWaitStatus(session, jobs);
  if (terminalState === 'WAITING_INPUT' && jobWait.waiting) {
    return state(
      'WAITING_FOR_JOB',
      `Waiting for active registered job${jobWait.matchedRunIds.length > 1 ? 's' : ''}: ${jobWait.matchedRunIds.join(', ')}.`,
      {
        declaredRunIds: jobWait.declaredRunIds,
        matchedJobs: jobWait.matchedJobs.map(compactJob),
        staleDeclaredRunIds: [
          ...jobWait.terminalDeclaredRunIds,
          ...jobWait.missingDeclaredRunIds,
          ...jobWait.foreignDeclaredRunIds,
        ],
      },
    );
  }
  const authoritativeActive = activeJobs(jobs, targetId);
  if (heartbeat?.constructionLease?.active) {
    return state(
      'CONSTRUCTION_ACTIVE',
      `Construction episode ${heartbeat.constructionLease.id} owns the research turn; generic continuation and external scientific review are suppressed.`,
    );
  }
  if (activeEvents.some((event) => event.eventType === 'SESSION_PROGRESS_STALLED')) {
    return state('PROGRESS_STALLED', 'No effective progress heartbeat has advanced.');
  }
  if (activeEvents.some((event) => event.eventType === 'SESSION_OUTPUT_STALLED')) {
    return state('OUTPUT_STALLED', 'The bounded terminal tail has not changed and its state is uncertain.');
  }
  if (session.controlId === 'GPU_SCHEDULER' && terminalState === 'WAITING_INPUT'
      && schedulerMonitor?.status === 'healthy'
      && !activeJobs(jobs, targetId).length) {
    return state('MONITORING_IDLE', 'The scheduler monitor is healthy and the queue is empty.');
  }
  if (terminalState === 'WAITING_INPUT' && Number(heartbeat?.activeToolProcessCount || 0) > 0) {
    return state('TOOL_DRAINING', 'The prompt is visible while descendant tools are still present.');
  }
  if (terminalState === 'WAITING_INPUT') {
    const details = {
      undeclaredActiveJobs: authoritativeActive.map(compactJob),
      staleDeclaredRunIds: [
        ...jobWait.terminalDeclaredRunIds,
        ...jobWait.missingDeclaredRunIds,
        ...jobWait.foreignDeclaredRunIds,
      ],
    };
    return state('READY_FOR_INPUT', 'Claude is at a verified input prompt.', details);
  }
  if (terminalState === 'WORKING' && Number(heartbeat?.activeToolProcessCount || 0) > 0) {
    return state('TOOL_RUNNING', 'Claude has an active descendant tool process.');
  }
  if (terminalState === 'WORKING') {
    return state('MODEL_WORKING', 'Claude is producing or processing the current turn.');
  }
  return state('STATE_UNCERTAIN', 'Available evidence does not prove a safe operational state.');
}

function compactJob(job) {
  return {
    runId: job.runId,
    kind: job.kind,
    state: job.state,
    purpose: job.purpose || null,
  };
}

function state(name, reason, details = null) {
  return { state: name, reason, details };
}
