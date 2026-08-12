import { activeJobs, jobWaitStatus } from './job-wait.js';

const REVIEW_EVENT_TYPES = new Set([
  'STOP_REVIEW_QUEUED',
  'SESSION_OUTPUT_STALLED',
  'SESSION_PROGRESS_STALLED',
]);

export function deriveOperationalState(session, {
  events = [],
  outbox = [],
  goalPolicy = null,
  goalBudgetReached = false,
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
    return state('CONFIRMATION_REQUIRED', 'Claude is waiting for a human permission decision.');
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
    );
  }
  const authoritativeActive = activeJobs(jobs, targetId);
  if (terminalState === 'WAITING_INPUT' && authoritativeActive.length > 0) {
    return state(
      'JOB_ACTIVE_UNDECLARED',
      `Authoritative registered job${authoritativeActive.length > 1 ? 's are' : ' is'} active, but Claude did not emit the exact wait marker: ${authoritativeActive.map((item) => item.runId).join(', ')}. Keep healthy work silent and suppress scientific review or generic continuation.`,
    );
  }
  if (heartbeat?.constructionLease?.active) {
    return state(
      'CONSTRUCTION_ACTIVE',
      `Construction episode ${heartbeat.constructionLease.id} owns the research turn; generic continuation and external scientific review are suppressed.`,
    );
  }
  if (activeEvents.some((event) => event.eventType === 'SESSION_PROGRESS_STALLED')) {
    return state('PROGRESS_STALLED', 'No effective progress heartbeat has advanced.');
  }
  if (activeEvents.some((event) => REVIEW_EVENT_TYPES.has(event.eventType))) {
    return state('WAITING_REVIEW', 'A stop or liveness episode is awaiting independent review.');
  }
  if (goalBudgetReached && terminalState === 'WAITING_INPUT') {
    return state('POLICY_HELD', 'Automatic continuation is held by the configured token budget.');
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
    return goalPolicy?.enabled
      ? state('READY_FOR_CONTINUATION', 'Claude is at a verified input prompt under an active goal policy.')
      : state('READY_FOR_INPUT', 'Claude is at a verified input prompt.');
  }
  if (terminalState === 'WORKING' && Number(heartbeat?.activeToolProcessCount || 0) > 0) {
    return state('TOOL_RUNNING', 'Claude has an active descendant tool process.');
  }
  if (terminalState === 'WORKING') {
    return state('MODEL_WORKING', 'Claude is producing or processing the current turn.');
  }
  return state('STATE_UNCERTAIN', 'Available evidence does not prove a safe operational state.');
}

function state(name, reason) {
  return { state: name, reason };
}

export const sessionStateInternals = Object.freeze({ REVIEW_EVENT_TYPES });
