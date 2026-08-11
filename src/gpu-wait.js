const ACTIVE_GPU_STATES = new Set(['pending', 'running']);

export function gpuItemBelongsToTarget(item, targetId) {
  if (!item || !targetId) return false;
  return item.project === targetId
    || item.runId === targetId
    || String(item.runId || '').startsWith(`${targetId}_`);
}

export function activeGpuRuns(queue, targetId) {
  return (queue?.items || []).filter((item) => (
    ACTIVE_GPU_STATES.has(item.state) && gpuItemBelongsToTarget(item, targetId)
  ));
}

export function gpuWaitStatus(session, queue) {
  const targetId = session?.projectId || null;
  const declared = new Set(session?.heartbeat?.waitingForGpuRunIds || []);
  const active = activeGpuRuns(queue, targetId);
  const matched = active.filter((item) => declared.has(item.runId));
  return {
    waiting: targetId !== null && declared.size > 0 && matched.length > 0,
    declaredRunIds: [...declared],
    activeRunIds: active.map((item) => item.runId),
    matchedRunIds: matched.map((item) => item.runId),
  };
}

export const gpuWaitInternals = Object.freeze({ ACTIVE_GPU_STATES });
