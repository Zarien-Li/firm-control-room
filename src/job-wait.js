import { ACTIVE_JOB_STATES } from './job-registry.js';

export function jobBelongsToTarget(item, targetId) {
  if (!item || !targetId) return false;
  return item.projectId === targetId || item.project === targetId
    || item.runId === targetId || String(item.runId || '').startsWith(`${targetId}_`);
}

export function activeJobs(registry, targetId) {
  return (registry?.items || []).filter((item) => (
    ACTIVE_JOB_STATES.has(item.state) && jobBelongsToTarget(item, targetId)
  ));
}

export function jobWaitStatus(session, registry) {
  const targetId = session?.projectId || null;
  const declared = new Set(session?.heartbeat?.waitingForJobRunIds || []);
  const active = activeJobs(registry, targetId);
  const matched = active.filter((item) => declared.has(item.runId));
  const allJobs = registry?.items || [];
  const declaredJobs = allJobs.filter((item) => declared.has(item.runId));
  const ownedDeclaredJobs = declaredJobs.filter((item) => jobBelongsToTarget(item, targetId));
  const terminalDeclaredJobs = ownedDeclaredJobs.filter((item) => !ACTIVE_JOB_STATES.has(item.state));
  const knownDeclaredRunIds = new Set(declaredJobs.map((item) => item.runId));
  return {
    waiting: targetId !== null && declared.size > 0 && matched.length > 0,
    declaredRunIds: [...declared], activeRunIds: active.map((item) => item.runId),
    matchedRunIds: matched.map((item) => item.runId), matchedJobs: matched,
    terminalDeclaredRunIds: terminalDeclaredJobs.map((item) => item.runId),
    missingDeclaredRunIds: [...declared].filter((runId) => !knownDeclaredRunIds.has(runId)),
    foreignDeclaredRunIds: declaredJobs
      .filter((item) => !jobBelongsToTarget(item, targetId))
      .map((item) => item.runId),
  };
}
