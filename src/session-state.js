import { gpuWaitStatus } from './gpu-wait.js';

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
  queue = null,
} = {}) {
  const targetId = session.projectId || session.controlId || null;
  const terminalState = session.terminal?.state || 'UNKNOWN';
  const heartbeat = session.heartbeat || null;
  const activeEvents = events.filter((event) => (
    event.targetId === targetId && ['PENDING', 'HELD', 'SENT'].includes(event.status)
  ));
  const pendingDelivery = outbox.find((message) => (
    message.targetId === targetId
    && ['QUEUED', 'SENDING', 'SENT_AWAITING_ACK', 'UNCERTAIN'].includes(message.status)
  ));

  if (heartbeat?.status === 'degraded' || !session.terminal) {
    return state('OBSERVABILITY_DEGRADED', 'History or terminal evidence is unavailable.');
  }
  if (terminalState === 'CONFIRMATION') {
    return state('CONFIRMATION_REQUIRED', 'Claude is waiting for a human permission decision.');
  }
  if (terminalState === 'DRAFT_PENDING_ENTER') {
    return state('DRAFT_PENDING_ENTER', session.terminal?.draftDeliveryMarker
      ? `Tracked delivery ${session.terminal.draftDeliveryMarker} is pasted but not submitted.`
      : 'Text is present at the Claude prompt but has not been submitted.');
  }
  if (pendingDelivery) {
    return state('MESSAGE_PENDING_ACK', `Delivery ${pendingDelivery.messageKey} is not history-acknowledged.`);
  }
  const gpuWait = gpuWaitStatus(session, queue);
  if (terminalState === 'WAITING_INPUT' && gpuWait.waiting) {
    return state(
      'WAITING_FOR_GPU',
      `Waiting for active GPU run${gpuWait.matchedRunIds.length > 1 ? 's' : ''}: ${gpuWait.matchedRunIds.join(', ')}.`,
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
      && !(queue?.items || []).some((item) => ['pending', 'running'].includes(item.state))) {
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
