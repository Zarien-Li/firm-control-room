import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { auditSnapshot } from './audit.js';
import { AutomationEngine } from './automation-engine.js';
import { BrokerClient } from './broker-client.js';
import { readClaudeHistoryHeartbeat, readRecentClaudeActivity } from './claude-history.js';
import { collectClaudeSessions, collectSnapshot } from './collectors.js';
import { loadConfig } from './config.js';
import { createEvidenceBundle, verifyEvidenceBundle } from './evidence.js';
import {
  clearItermDraft,
  dismissItermChoice,
  sendItermMessage,
  submitItermDraft,
} from './iterm-status.js';
import { SessionError } from './session-manager.js';
import { deriveOperationalState } from './session-state.js';
import {
  buildReanchorPrompt,
  buildSemanticPacket,
  reanchorEligible,
  runCodexSemanticAudit,
  semanticPacketHash,
} from './semantic-audit.js';
import { createStore } from './store.js';
import { JobRegistry } from './job-registry.js';

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};
const vendorFiles = Object.freeze({
  '/vendor/xterm.js': join('node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'),
  '/vendor/xterm.css': join('node_modules', '@xterm', 'xterm', 'css', 'xterm.css'),
  '/vendor/addon-fit.js': join('node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js'),
});

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function sendError(res, status, code, message) {
  return sendJson(res, status, { error: { code, message } });
}

function interventionView(store, intervention) {
  const audit = store.getSemanticAudit(intervention.semanticAuditId)?.audit;
  const evidence = (audit?.evidence || [])
    .filter((item) => item.verified === true)
    .map(({ source, sourceKind, sourceLabel, quote, reason }) => ({
      source, sourceKind, sourceLabel, quote, reason,
    }));
  return {
    ...intervention,
    evidence,
    grounding: audit?.grounding ? {
      verifiedCount: audit.grounding.verifiedCount,
      hasAuthority: audit.grounding.hasAuthority,
      hasSession: audit.grounding.hasSession,
      eligible: audit.grounding.eligible,
    } : null,
  };
}

function compactActivityText(value, maximum = 900) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

function compactIncomingText(value, maximum = 600) {
  let text = String(value || '');
  const crossSession = text.match(/<cross-session-message[^>]*>([\s\S]*?)<\/cross-session-message>/i);
  if (crossSession) text = crossSession[1];
  text = text
    .replace(/^Another Claude session sent a message:\s*/i, '')
    .replace(/This came from another Claude session[\s\S]*$/i, '')
    .replace(/<[^>]+>/g, ' ');
  return compactActivityText(text, maximum);
}

function externalContinuationPrompt() {
  return [
    '[FIRM USER-APPROVED CONTINUATION]',
    '继续自主推进当前已锁定研究目标。以当前可信证据和最新 active research skills 为依据，在同一 turn 内连续完成一组相互连贯的高价值动作；每完成一个常规动作后重新判断并继续下一个独立动作。',
    'GPU 尚未 compute-ready 时，继续完成所有可并行的 CPU、代码、数据、解释和 baseline 工作。',
    '所有未来 GPU 作业必须先准备 compute-ready 的远端 command 文件，再调用 FIRM 仓库中的 scripts/submit-gpu-request.sh；不得自行选择 CUDA_VISIBLE_DEVICES 或通过 SSH/Docker 直接启动新 GPU worker。后续等待标记必须使用提交工具返回的规范 RUN_ID。',
    '所有本地 CPU、远端 CPU、SSH 和其他长任务必须通过 scripts/run-registered-job.sh 启动，或通过 /api/jobs 显式注册和更新；不得让 FIRM 猜测进程状态。',
    '只有在所有独立工作都完成、且唯一阻塞是 Registry 中仍为 pending/running 的任务时，才以精确机器标记 [FIRM WAITING_FOR_JOB run_id=<active_run_id>] 结束；GPU 旧标记仍兼容，但不得为已失败、已完成、缺失或仅计划中的请求输出等待标记。',
    '不要因为完成一次实验、状态记录、请求包、代码修复或证据读取就结束本 turn；不要扩大 sealed arena，不把候选失败改写成 analysis-paper identity，不要返回常规菜单。',
    '仅在真实权限、不可逆操作、异常资源请求或必须由 PI 决定的科学歧义时暂停。',
  ].join('\n');
}

async function readJson(req, { allowed, required = [] }) {
  const contentType = req.headers['content-type'] || '';
  if (!/^application\/json(?:;|$)/i.test(contentType)) {
    throw new SessionError('unsupported_media_type', 'Content-Type must be application/json', 415);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128 * 1024) throw new SessionError('body_too_large', 'JSON body exceeds 128 KiB', 413);
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new SessionError('invalid_json', 'Request body must contain valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SessionError('invalid_body', 'Request body must be a JSON object');
  }
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new SessionError('unknown_field', `Unknown field: ${unknown}`);
  const missing = required.find((key) => !(key in value));
  if (missing) throw new SessionError('missing_field', `Missing field: ${missing}`);
  return value;
}

export async function createApp(overrides = {}) {
  const {
    sessionManager: suppliedSessionManager,
    brokerClient: suppliedBrokerClient,
    automationEngine: suppliedAutomationEngine,
    externalSessionsCollector: suppliedExternalSessionsCollector,
    externalSessionSender: suppliedExternalSessionSender,
    externalSessionSubmitter: suppliedExternalSessionSubmitter,
    externalSessionClearer: suppliedExternalSessionClearer,
    externalSessionChoiceDismisser: suppliedExternalSessionChoiceDismisser,
    ...configOverrides
  } = overrides;
  const config = { ...(await loadConfig()), ...configOverrides };
  if (configOverrides.projects && !configOverrides.sessionTargets) {
    config.controlTargets = configOverrides.controlTargets || [];
    config.sessionTargets = configOverrides.projects.map((project) => ({
      ...project,
      kind: project.kind || 'research',
      args: project.args || config.claudeArgs,
      bootstrapFile: project.bootstrapFile || 'prompt.txt',
      bootstrapRequiredFiles: project.bootstrapRequiredFiles
        || ['CLAUDE-RESEARCH.md', project.bootstrapFile || 'prompt.txt'],
    }));
  }
  const store = await createStore(config.dataDir);
  const sessionManager = suppliedSessionManager
    || suppliedBrokerClient
    || new BrokerClient({ socketPath: config.brokerSocketPath });
  const externalSessionsCollector = suppliedExternalSessionsCollector || (() => (
    collectClaudeSessions(config.projects, {
      controlSessionPaths: config.controlSessionPaths,
      collectLiveness: true,
      claudeProjectsDir: config.claudeProjectsDir,
    })
  ));
  const externalSessionSender = suppliedExternalSessionSender || ((session, message) => (
    sendItermMessage(session.tty?.startsWith('/dev/') ? session.tty : `/dev/${session.tty}`, message)
  ));
  const externalSessionSubmitter = suppliedExternalSessionSubmitter || ((session) => (
    submitItermDraft(session.tty?.startsWith('/dev/') ? session.tty : `/dev/${session.tty}`)
  ));
  const externalSessionClearer = suppliedExternalSessionClearer || ((session) => (
    clearItermDraft(session.tty?.startsWith('/dev/') ? session.tty : `/dev/${session.tty}`)
  ));
  const externalSessionChoiceDismisser = suppliedExternalSessionChoiceDismisser || ((session) => (
    dismissItermChoice(session.tty?.startsWith('/dev/') ? session.tty : `/dev/${session.tty}`)
  ));
  const stopReviewInFlight = new Map();
  const jobRegistry = new JobRegistry({ store });
  const automationEngine = suppliedAutomationEngine || new AutomationEngine({
    config,
    store,
    sessionManager,
    discoverExternalSessions: externalSessionsCollector,
    externalSessionInput: externalSessionSender,
    externalSessionSubmit: externalSessionSubmitter,
    externalSessionClear: externalSessionClearer,
    externalSessionDismissChoice: externalSessionChoiceDismisser,
    // A normal Claude input prompt is a liveness event, not a scientific review
    // event. Project sessions own milestone Codex calls; portfolio review is
    // handled separately from the Goal Loop.
    onExternalSessionStopped: null,
    jobRegistry,
  });
  const publicDir = join(config.root, 'public');
  let scanPromise = null;
  let semanticPromise = null;
  let semanticTail = Promise.resolve();
  let immediateSemanticTail = Promise.resolve();
  let scanTimer = null;
  let automationTimer = null;
  let controlStatusPromise = null;
  let controlStatusCache = null;

  function collectProfessorStatus() {
    const audits = store.listSemanticAudits(1000);
    const latestByProject = new Map();
    for (const audit of audits) {
      if (!latestByProject.has(audit.projectId)) latestByProject.set(audit.projectId, audit);
    }
    const pendingInterventions = store.listInterventions(1000)
      .filter((item) => ['PROPOSED', 'HELD'].includes(item.status));
    const latestScan = store.list(1)[0] || null;
    const lastCodexAudit = audits.find((item) => item.status === 'completed') || null;
    const nextRunAt = latestScan && config.scanIntervalMs > 0
      ? new Date(Date.parse(latestScan.collectedAt) + config.scanIntervalMs).toISOString()
      : null;
    return {
      status: semanticPromise ? 'RUNNING'
        : !config.codexAuditEnabled ? 'DISABLED'
          : !config.codexExecutable ? 'UNAVAILABLE' : 'ACTIVE',
      mode: 'stateless-codex',
      stateless: true,
      intervalMs: config.scanIntervalMs,
      collectedAt: new Date().toISOString(),
      lastScanAt: latestScan?.collectedAt || null,
      lastCodexAt: lastCodexAudit?.createdAt || null,
      nextRunAt,
      pendingInterventions: pendingInterventions.length,
      projectStates: config.projects.map((project) => {
        const audit = latestByProject.get(project.id);
        return {
          projectId: project.id,
          verdict: audit?.audit?.verdict || (audit?.status === 'idle' ? 'IDLE' : 'PENDING'),
          driftTypes: audit?.audit?.drift_type || [],
          status: audit?.status || 'pending',
          semanticAuditId: audit?.id || null,
          packetHash: audit?.packetHash || null,
          updatedAt: audit?.createdAt || null,
        };
      }),
    };
  }

  async function collectControlStatus(force = false) {
    if (!force && controlStatusCache
        && Date.now() - Date.parse(controlStatusCache.collectedAt) < 10_000) {
      return controlStatusCache;
    }
    if (controlStatusPromise) return controlStatusPromise;
    controlStatusPromise = (async () => {
      const target = config.controlTargets[0];
      if (!target) return { status: 'unavailable', collectedAt: new Date().toISOString() };
      const [activity, managedSessions, discovered] = await Promise.all([
        readRecentClaudeActivity(target.path, {
          claudeProjectsDir: config.claudeProjectsDir,
          lookbackMs: 24 * 60 * 60 * 1000,
        }),
        sessionManager.list(),
        collectClaudeSessions(config.projects, {
          controlSessionPaths: config.controlSessionPaths,
        }),
      ]);
      const managed = managedSessions.find((session) => (
        session.projectId === target.id && ['RUNNING', 'WAITING_INPUT'].includes(session.status)
      ));
      const external = discovered.items.find((session) => session.controlId === target.id);
      const assistantMessages = activity.messages?.filter((message) => message.role === 'assistant') || [];
      const incomingMessages = activity.messages?.filter((message) => message.role === 'user') || [];
      const lastAssistant = assistantMessages.at(-1) || null;
      const lastIncoming = incomingMessages.at(-1) || null;
      const assistantAt = lastAssistant?.timestamp ? Date.parse(lastAssistant.timestamp) : NaN;
      const incomingAt = lastIncoming?.timestamp ? Date.parse(lastIncoming.timestamp) : NaN;
      const queue = automationEngine.snapshot();
      controlStatusCache = {
        status: managed ? managed.status : external ? 'EXTERNAL' : 'STOPPED',
        collectedAt: new Date().toISOString(),
        pid: managed?.pid || external?.pid || null,
        managedSessionId: managed?.id || null,
        latestActivityAt: activity.latestAt,
        activityStatus: activity.status,
        lastAction: lastAssistant ? {
          at: lastAssistant.timestamp || activity.latestAt,
          text: compactActivityText(lastAssistant.text),
        } : null,
        lastIncoming: lastIncoming ? {
          at: lastIncoming.timestamp || activity.latestAt,
          text: compactIncomingText(lastIncoming.text),
        } : null,
        awaitingResponse: Number.isFinite(incomingAt)
          && (!Number.isFinite(assistantAt) || incomingAt > assistantAt),
        pendingRuns: (queue.items || [])
          .filter((item) => item.state === 'pending')
          .map((item) => item.runId),
        runningRuns: (queue.items || [])
          .filter((item) => item.state === 'running')
          .map((item) => item.runId),
        monitor: automationEngine.monitorSnapshot?.() || {
          status: 'unknown', reason: 'monitor_probe_unavailable',
        },
      };
      return controlStatusCache;
    })();
    try {
      return await controlStatusPromise;
    } finally {
      controlStatusPromise = null;
    }
  }

  async function scan() {
    if (scanPromise) return scanPromise;
    scanPromise = (async () => {
      const snapshot = await collectSnapshot(config.projects, new Date(), {
        controlSessionPaths: config.controlSessionPaths,
      });
      const audit = auditSnapshot(snapshot);
      const evidence = await createEvidenceBundle(config.dataDir, snapshot, audit);
      const id = store.save(snapshot, audit, evidence);
      return { id, snapshot, audit, evidenceHash: evidence.bundleHash };
    })();
    try {
      return await scanPromise;
    } finally {
      scanPromise = null;
    }
  }

  function queueImmediateStopReview(stop) {
    const reviewKey = `${stop.projectId}:${stop.pid}:${stop.episodeId || stop.tailHash}`;
    const verifiedPrompt = stop.safeToContinue !== false;
    const event = store.createAutomationEvent({
      eventKey: `stop-review:${reviewKey}`,
      category: 'professor_review',
      eventType: 'STOP_REVIEW_QUEUED',
      targetId: stop.projectId,
      severity: 'info',
      title: `Immediate liveness review: ${stop.projectId}`,
      message: verifiedPrompt
        ? 'The project reached a normal input point; a project-scoped Codex review was queued immediately.'
        : 'The project stopped producing recognizable output; Codex review was queued, but continuation remains blocked until a normal prompt is verified.',
      source: { deliveryPolicy: 'none', stop },
    });
    if (!['PENDING', 'HELD'].includes(event.status) || stopReviewInFlight.has(reviewKey)) {
      return event;
    }
    if (event.status === 'HELD') {
      store.setAutomationEvent(event.id, { status: 'PENDING', note: 'retrying_immediate_stop_review' });
    }
    const job = (async () => {
      try {
        const scanResult = await scan();
        const semantic = await runImmediateSemanticCycle(scanResult, stop.projectId);
        const result = semantic.results?.find((item) => item.projectId === stop.projectId);
        const verdict = result?.audit?.verdict || null;
        store.setAutomationEvent(event.id, {
          status: 'RESOLVED',
          note: `immediate_stop_review_${verdict || result?.status || semantic.status}`,
        });
        if (verifiedPrompt && result?.status === 'completed' && ['PASS', 'WARN'].includes(verdict)) {
          await automationEngine.continueReviewedStop?.(stop, { verdict });
        }
      } catch (error) {
        store.setAutomationEvent(event.id, {
          status: 'HELD',
          note: `immediate_stop_review_failed:${String(error.message || error).slice(0, 300)}`,
        });
      } finally {
        stopReviewInFlight.delete(reviewKey);
      }
    })();
    stopReviewInFlight.set(reviewKey, job);
    return event;
  }

  async function dispatchIntervention(interventionId, requestedSessionId = null, automatic = false) {
    const intervention = store.getIntervention(interventionId);
    if (!intervention) throw new SessionError('intervention_not_found', 'Intervention was not found', 404);
    if (!['PROPOSED', 'HELD'].includes(intervention.status)) {
      throw new SessionError('intervention_not_pending', 'Intervention is not pending', 409);
    }
    const sourceAudit = store.getSemanticAudit(intervention.semanticAuditId)?.audit;
    if (!reanchorEligible(sourceAudit)) {
      store.setIntervention(intervention.id, {
        status: 'CLEARED',
        note: 'blocked_at_dispatch_without_programmatically_grounded_evidence',
      });
      throw new SessionError(
        'intervention_evidence_not_grounded',
        'Intervention no longer has verified authority and recent-session evidence',
        409,
      );
    }
    if (automatic) {
      const previous = store.lastSentIntervention(intervention.projectId);
      if (previous?.sentAt
          && Date.now() - Date.parse(previous.sentAt) < config.reanchorCooldownMs) {
        return store.setIntervention(intervention.id, {
          status: 'HELD',
          note: 'automatic_cooldown_active',
        });
      }
    }
    const sessions = await sessionManager.list();
    const candidates = sessions.filter((session) => (
      session.projectId === intervention.projectId && session.status === 'WAITING_INPUT'
    ));
    const session = requestedSessionId
      ? candidates.find((candidate) => candidate.id === requestedSessionId)
      : candidates.length === 1 ? candidates[0] : null;
    if (!session) {
      if (automatic) {
        return store.setIntervention(intervention.id, {
          status: 'HELD',
          note: candidates.length > 1 ? 'multiple_waiting_sessions' : 'no_waiting_managed_session',
        });
      }
      throw new SessionError(
        'waiting_session_required',
        'Exactly one waiting managed session, or an explicit matching sessionId, is required',
        409,
      );
    }
    const safePrompt = buildReanchorPrompt({ id: intervention.projectId }, sourceAudit);
    await sessionManager.input(session.id, `${safePrompt}\r`);
    return store.setIntervention(intervention.id, {
      status: 'SENT',
      sessionId: session.id,
      sentAt: new Date().toISOString(),
      note: automatic ? 'automatic_guarded_reanchor' : 'user_approved_reanchor',
    });
  }

  async function executeSemanticCycle(scanResult, onlyProjectId = null) {
      if (!config.codexAuditEnabled) return { status: 'disabled', results: [] };
      if (!config.codexExecutable) return { status: 'unavailable', results: [], error: 'codex_not_found' };
      const targets = config.projects.filter((project) => !onlyProjectId || project.id === onlyProjectId);
      const results = [];
      for (const project of targets) {
        const heartbeat = await readClaudeHistoryHeartbeat(project.path, {
          claudeProjectsDir: config.claudeProjectsDir,
        });
        const activeJobRunIds = (automationEngine.jobsSnapshot?.()?.items || [])
          .filter((item) => (
            ['pending', 'running'].includes(item.state)
            && (item.projectId === project.id || item.runId === project.id
              || String(item.runId || '').startsWith(`${project.id}_`))
          ))
          .map((item) => item.runId);
        if (heartbeat.constructionLease?.active
            || heartbeat.waitingForJobRunIds?.length || activeJobRunIds.length) {
          results.push({
            projectId: project.id,
            status: 'deferred',
            error: heartbeat.constructionLease?.active
              ? 'construction_lease_active' : 'registered_job_active',
            constructionLease: heartbeat.constructionLease,
            waitingForJobRunIds: heartbeat.waitingForJobRunIds || [],
            activeJobRunIds,
          });
          continue;
        }
        const previous = store.latestSemanticAudit(project.id);
        const activity = await readRecentClaudeActivity(project.path, {
          claudeProjectsDir: config.claudeProjectsDir,
          lookbackMs: config.codexAuditLookbackMs,
          maxMessages: 16,
          maxTextChars: 12 * 1024,
          maxMessageChars: 3 * 1024,
        });
        if (activity.status !== 'ok') {
          if (previous?.status === activity.status && previous.error === activity.reason) {
            results.push({ ...previous, cached: true });
            continue;
          }
          const result = { status: activity.status, error: activity.reason, audit: null };
          const id = store.saveSemanticAudit(scanResult.id, project.id, result);
          results.push({ id, projectId: project.id, ...result });
          continue;
        }
        const snapshotProject = scanResult.snapshot.projects.find((item) => item.id === project.id);
        if (!snapshotProject) continue;
        const packet = buildSemanticPacket(project, snapshotProject, activity, scanResult.audit);
        const packetHash = semanticPacketHash(packet);
        if (previous?.status === 'completed' && previous.packetHash === packetHash && previous.audit) {
          let intervention = null;
          if (config.reanchorMode !== 'off' && reanchorEligible(previous.audit)) {
            intervention = store.createIntervention(
              previous.id,
              project.id,
              buildReanchorPrompt(snapshotProject, previous.audit),
              'restored_from_unchanged_high_confidence_audit',
            );
            if (config.reanchorMode === 'auto'
                && ['PROPOSED', 'HELD'].includes(intervention?.status)) {
              intervention = await dispatchIntervention(intervention.id, null, true);
            }
          } else {
            intervention = store.clearPendingIntervention(project.id, {
              semanticAuditId: previous.id,
              packetHash: previous.packetHash,
              verdict: previous.audit.verdict,
            });
          }
          results.push({ ...previous, cached: true, intervention });
          continue;
        }
        const result = await runCodexSemanticAudit({ config, project, packet });
        const id = store.saveSemanticAudit(scanResult.id, project.id, result);
        let intervention = null;
        if (config.reanchorMode !== 'off' && reanchorEligible(result.audit)) {
          intervention = store.createIntervention(
            id,
            project.id,
            buildReanchorPrompt(snapshotProject, result.audit),
            'generated_from_high_confidence_codex_shadow_audit',
          );
          if (config.reanchorMode === 'auto') {
            intervention = await dispatchIntervention(intervention.id, null, true);
          }
        } else if (result.status === 'completed' && result.audit) {
          intervention = store.clearPendingIntervention(project.id, {
            semanticAuditId: id,
            packetHash: result.packetHash,
            verdict: result.audit.verdict,
          });
        }
        results.push({ id, projectId: project.id, ...result, intervention });
      }
      return { status: 'completed', results };
  }

  function runSemanticCycle(scanResult, onlyProjectId = null) {
    const run = semanticTail
      .catch(() => undefined)
      .then(() => executeSemanticCycle(scanResult, onlyProjectId));
    semanticTail = run;
    semanticPromise = run;
    return run.finally(() => {
      if (semanticPromise === run) semanticPromise = null;
    });
  }

  function runImmediateSemanticCycle(scanResult, projectId) {
    const run = immediateSemanticTail
      .catch(() => undefined)
      .then(() => executeSemanticCycle(scanResult, projectId));
    immediateSemanticTail = run;
    return run;
  }

  async function fullCycle() {
    const scanResult = await scan();
    const semantic = await runSemanticCycle(scanResult);
    return { ...scanResult, semantic };
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/api/health') {
        const broker = await sessionManager.health?.();
        return sendJson(res, 200, {
          ok: true,
          mode: 'shadow-read-only',
          autoCorrection: false,
          projectCount: config.projects.length,
          controlTargetCount: config.controlTargets.length,
          scanIntervalMs: config.scanIntervalMs,
          managedSessions: true,
          codexAuditEnabled: config.codexAuditEnabled,
          codexAvailable: Boolean(config.codexExecutable),
          reanchorMode: config.reanchorMode,
          automation: {
            gpuQueueEnabled: config.gpuQueue.enabled,
            gpuQueueStatus: automationEngine.snapshot().status,
            gpuSchedulerAutoStart: config.gpuQueue.schedulerAutoStart,
            gpuSchedulerMonitor: automationEngine.monitorSnapshot?.() || {
              status: 'unknown', reason: 'monitor_probe_unavailable',
            },
            codexProfessor: {
              mode: config.professor?.mode || 'stateless-codex',
              intervalMs: config.professor?.intervalMs || config.scanIntervalMs,
              running: Boolean(semanticPromise),
              immediateStopReviews: stopReviewInFlight.size,
            },
            watchdogPollMs: config.watchdog.pollMs,
            stopReviewStableMs: config.watchdog.stopReviewStableMs,
            activeGoalLoops: config.goalLoop?.enabled === true
              ? store.listAutomationPolicies().filter((item) => item.enabled).length : 0,
            goalLoopEnabled: config.goalLoop?.enabled === true,
          },
          broker: broker || { embeddedTestDouble: true },
          node: process.version,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/projects') {
        return sendJson(res, 200, config.projects.map(({
          id, name, path, sessionPathAliases, expected,
        }) => ({
          id, name, path, sessionPathAliases, expected,
        })));
      }
      if (req.method === 'GET' && url.pathname === '/api/session-targets') {
        return sendJson(res, 200, config.sessionTargets.map((target) => ({
          id: target.id,
          name: target.name,
          kind: target.kind,
          path: target.path,
        })));
      }
      if (req.method === 'GET' && url.pathname === '/api/external-sessions') {
        const discovered = await externalSessionsCollector();
        const events = store.listAutomationEvents(1000);
        const outbox = store.listOutboxMessages(1000);
        const policies = new Map(store.listAutomationPolicies()
          .map((policy) => [policy.targetId, policy]));
        return sendJson(res, 200, {
          status: discovered.status,
          terminalStatus: discovered.terminalStatus,
          items: discovered.items.map((session) => {
            const rollingSince = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
            const budgetEpoch = config.goalLoop?.budgetEpoch;
            const since = [rollingSince, budgetEpoch, session.terminal?.lastRateLimitResetAt]
              .filter((value) => value && Number.isFinite(Date.parse(value)))
              .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
            const recentGoal = session.projectId
              ? store.recentGoalActions(session.projectId, since)
              : { count: 0 };
            const operational = deriveOperationalState(session, {
              events,
              outbox,
              goalPolicy: policies.get(session.projectId),
              goalBudgetReached: recentGoal.count >= config.goalLoop.maxContinuesPerDay,
              schedulerMonitor: automationEngine.monitorSnapshot?.(),
              jobs: automationEngine.jobsSnapshot?.() || jobRegistry.snapshot(),
            });
            return {
              pid: session.pid,
              projectId: session.projectId,
              controlId: session.controlId,
              mappingStatus: session.mappingStatus,
              tty: session.tty,
              terminal: session.terminal,
              heartbeat: session.heartbeat || null,
              operationalState: operational.state,
              operationalReason: operational.reason,
            };
          }),
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/control-status') {
        return sendJson(res, 200, await collectControlStatus(
          url.searchParams.get('refresh') === '1',
        ));
      }
      if (req.method === 'GET' && url.pathname === '/api/professor-status') {
        return sendJson(res, 200, await collectProfessorStatus());
      }
      if (req.method === 'GET' && url.pathname === '/api/scans') {
        return sendJson(res, 200, store.list(url.searchParams.get('limit')));
      }
      if (req.method === 'GET' && url.pathname === '/api/semantic-audits') {
        return sendJson(
          res,
          200,
          store.listSemanticAudits(url.searchParams.get('limit'), url.searchParams.get('projectId')),
        );
      }
      if (req.method === 'GET' && url.pathname === '/api/interventions') {
        return sendJson(
          res,
          200,
          store.listInterventions(url.searchParams.get('limit'))
            .map((item) => interventionView(store, item)),
        );
      }
      if (req.method === 'GET' && url.pathname === '/api/jobs') {
        const limitValue = url.searchParams.get('limit');
        const limit = limitValue === null ? 25 : Number(limitValue);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
          throw new SessionError('invalid_job_limit', 'limit must be an integer from 1 to 200', 400);
        }
        const historyOnly = url.searchParams.get('view') === 'history';
        try {
          return sendJson(res, 200, jobRegistry.snapshot({
            terminalLimit: limit, cursor: url.searchParams.get('cursor'), historyOnly,
          }));
        } catch (error) {
          throw new SessionError('invalid_job_cursor', error.message, 400);
        }
      }
      const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (req.method === 'GET' && jobMatch) {
        const runId = decodeURIComponent(jobMatch[1]);
        const job = jobRegistry.get(runId);
        return job ? sendJson(res, 200, { job, events: jobRegistry.events(runId) })
          : sendError(res, 404, 'job_not_found', 'Job was not found');
      }
      if (req.method === 'POST' && url.pathname === '/api/jobs') {
        const body = await readJson(req, { allowed: [
          'runId', 'projectId', 'kind', 'executor', 'state', 'host', 'pid',
          'pidStartToken', 'commandFingerprint', 'purpose', 'submittedAt',
          'startedAt', 'heartbeatAt', 'finishedAt', 'progress', 'result', 'metadata', 'source',
        ], required: ['projectId', 'kind'] });
        if (!config.projects.some((project) => project.id === body.projectId)) {
          throw new SessionError('project_not_found', 'Project is not configured', 404);
        }
        try { return sendJson(res, 201, jobRegistry.register(body)); }
        catch (error) { throw new SessionError('invalid_job', error.message, 400); }
      }
      const jobStatusMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/status$/);
      if (req.method === 'POST' && jobStatusMatch) {
        const body = await readJson(req, { allowed: [
          'state', 'host', 'pid', 'pidStartToken', 'commandFingerprint', 'heartbeatAt', 'finishedAt',
          'progress', 'result', 'metadata', 'source',
        ] });
        try { return sendJson(res, 200, jobRegistry.update(decodeURIComponent(jobStatusMatch[1]), body)); }
        catch (error) {
          throw new SessionError(error.message === 'job_not_found' ? 'job_not_found' : 'invalid_job_update', error.message, error.message === 'job_not_found' ? 404 : 409);
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/automation-events') {
        return sendJson(
          res,
          200,
          store.listAutomationEvents(url.searchParams.get('limit')),
        );
      }
      if (req.method === 'GET' && url.pathname === '/api/message-outbox') {
        return sendJson(res, 200, store.listOutboxMessages(url.searchParams.get('limit')));
      }
      if (req.method === 'GET' && url.pathname === '/api/session-episodes') {
        return sendJson(res, 200, store.listSessionEpisodes(url.searchParams.get('limit')));
      }
      if (req.method === 'GET' && url.pathname === '/api/automation-policies') {
        const policies = store.listAutomationPolicies().map((policy) => (
          config.goalLoop?.enabled === true ? policy : { ...policy, enabled: false, objective: '' }
        ));
        return sendJson(res, 200, policies);
      }
      if (req.method === 'GET' && url.pathname === '/api/project-progress') {
        return sendJson(res, 200, store.listProjectProgress());
      }
      const scanMatch = url.pathname.match(/^\/api\/scans\/(\d+)$/);
      if (req.method === 'GET' && scanMatch) {
        const item = store.get(scanMatch[1]);
        return item
          ? sendJson(res, 200, item)
          : sendError(res, 404, 'scan_not_found', 'Scan was not found');
      }
      const evidenceMatch = url.pathname.match(/^\/api\/evidence\/(\d+)$/);
      if (req.method === 'GET' && evidenceMatch) {
        const item = store.get(evidenceMatch[1]);
        if (!item) return sendError(res, 404, 'scan_not_found', 'Scan was not found');
        return sendJson(res, 200, await verifyEvidenceBundle(item.evidencePath));
      }
      if (req.method === 'POST' && url.pathname === '/api/scan') {
        const result = await scan();
        return sendJson(res, 201, result);
      }
      if (req.method === 'POST' && url.pathname === '/api/semantic-audit') {
        const body = await readJson(req, { allowed: ['projectId'] });
        if (body.projectId && !config.projects.some((project) => project.id === body.projectId)) {
          throw new SessionError('project_not_found', 'Project is not configured', 404);
        }
        const scanResult = await scan();
        return sendJson(res, 202, await runSemanticCycle(scanResult, body.projectId || null));
      }
      if (req.method === 'POST' && url.pathname === '/api/automation-cycle') {
        await readJson(req, { allowed: [] });
        return sendJson(res, 200, await automationEngine.cycle({ forceQueue: true }));
      }
      const externalContinueMatch = url.pathname.match(/^\/api\/external-sessions\/([^/]+)\/continue$/);
      if (req.method === 'POST' && externalContinueMatch) {
        await readJson(req, { allowed: [] });
        const projectId = decodeURIComponent(externalContinueMatch[1]);
        if (!config.projects.some((project) => project.id === projectId)) {
          throw new SessionError('project_not_found', 'Project is not configured', 404);
        }
        const discovered = await externalSessionsCollector();
        const candidates = discovered.items.filter((session) => session.projectId === projectId);
        if (candidates.length !== 1 || candidates[0].terminal?.state !== 'WAITING_INPUT') {
          throw new SessionError(
            'external_session_not_waiting',
            'Exactly one external iTerm Claude session at a normal input prompt is required',
            409,
          );
        }
        const result = await automationEngine.continueExternalSession(
          candidates[0],
          externalContinuationPrompt(),
        );
        return sendJson(res, 202, { ...result, projectId });
      }
      const automationPolicyMatch = url.pathname.match(/^\/api\/automation-policies\/([^/]+)$/);
      if (req.method === 'POST' && automationPolicyMatch) {
        const targetId = decodeURIComponent(automationPolicyMatch[1]);
        if (!config.projects.some((project) => project.id === targetId)) {
          throw new SessionError('project_not_found', 'Project is not configured', 404);
        }
        const body = await readJson(req, {
          allowed: ['enabled', 'objective'],
          required: ['enabled', 'objective'],
        });
        if (typeof body.enabled !== 'boolean') {
          throw new SessionError('invalid_goal_policy', 'enabled must be a boolean');
        }
        if (body.enabled && config.goalLoop?.enabled !== true) {
          throw new SessionError(
            'goal_loop_globally_disabled',
            'Automatic Goal Loop injection is globally disabled; use routine-choice handling or an explicit manual continuation.',
            409,
          );
        }
        if (typeof body.objective !== 'string' || body.objective.length > 4000
            || (body.enabled && !body.objective.trim())) {
          throw new SessionError(
            'invalid_goal_policy',
            'objective must be non-empty when enabled and no larger than 4000 characters',
          );
        }
        const policy = store.setAutomationPolicy(targetId, {
          enabled: body.enabled,
          objective: body.objective.trim(),
        });
        await automationEngine.cycle();
        return sendJson(res, 200, policy);
      }
      const projectProgressMatch = url.pathname.match(/^\/api\/project-progress\/([^/]+)$/);
      if (req.method === 'POST' && projectProgressMatch) {
        const targetId = decodeURIComponent(projectProgressMatch[1]);
        if (!config.projects.some((project) => project.id === targetId)) {
          throw new SessionError('project_not_found', 'Project is not configured', 404);
        }
        const body = await readJson(req, {
          allowed: ['stage', 'summary', 'reviewedAt', 'source'],
          required: ['summary', 'reviewedAt'],
        });
        if (typeof body.summary !== 'string' || !body.summary.trim()
            || body.summary.length > 600) {
          throw new SessionError(
            'invalid_project_progress',
            'summary must contain 1-600 characters',
          );
        }
        if (body.stage !== undefined
            && (typeof body.stage !== 'string' || body.stage.length > 80)) {
          throw new SessionError('invalid_project_progress', 'stage must contain at most 80 characters');
        }
        if (typeof body.reviewedAt !== 'string' || !Number.isFinite(Date.parse(body.reviewedAt))) {
          throw new SessionError('invalid_project_progress', 'reviewedAt must be an ISO-8601 timestamp');
        }
        if (body.source !== undefined
            && (typeof body.source !== 'string' || !body.source.trim() || body.source.length > 80)) {
          throw new SessionError('invalid_project_progress', 'source must contain 1-80 characters');
        }
        return sendJson(res, 200, store.setProjectProgress(targetId, {
          stage: String(body.stage || '').trim(),
          summary: body.summary.trim(),
          reviewedAt: new Date(body.reviewedAt).toISOString(),
          source: String(body.source || 'portfolio-review').trim(),
        }));
      }
      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        return sendJson(res, 200, await sessionManager.list());
      }
      if (req.method === 'POST' && url.pathname === '/api/sessions') {
        const body = await readJson(req, {
          allowed: ['projectId', 'cols', 'rows', 'bootstrap'],
          required: ['projectId'],
        });
        if (typeof body.projectId !== 'string' || !body.projectId) {
          throw new SessionError('invalid_project_id', 'projectId must be a non-empty string');
        }
        const target = config.sessionTargets.find((item) => item.id === body.projectId);
        if (!target) throw new SessionError('project_not_found', 'Target is not configured', 404);
        const discovered = await externalSessionsCollector();
        const external = discovered.items.find((session) => (
          target.kind === 'control'
            ? session.controlId === target.id
            : session.projectId === target.id
        ));
        if (external) {
          throw new SessionError(
            'target_already_running_external',
            `A Claude session for ${target.name} is already running as PID ${external.pid}`,
            409,
          );
        }
        return sendJson(res, 201, await sessionManager.start(body.projectId, {
          cols: body.cols,
          rows: body.rows,
          bootstrap: body.bootstrap !== false,
        }));
      }
      const outputMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/output$/);
      if (req.method === 'GET' && outputMatch) {
        const rawCursor = url.searchParams.get('cursor');
        const cursor = rawCursor === null ? 0 : Number(rawCursor);
        return sendJson(
          res,
          200,
          await sessionManager.output(decodeURIComponent(outputMatch[1]), cursor),
        );
      }
      const inputMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/input$/);
      if (req.method === 'POST' && inputMatch) {
        const body = await readJson(req, { allowed: ['data'], required: ['data'] });
        return sendJson(
          res,
          200,
          await sessionManager.input(decodeURIComponent(inputMatch[1]), body.data),
        );
      }
      const resizeMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/resize$/);
      if (req.method === 'POST' && resizeMatch) {
        const body = await readJson(req, {
          allowed: ['cols', 'rows'],
          required: ['cols', 'rows'],
        });
        return sendJson(
          res,
          200,
          await sessionManager.resize(decodeURIComponent(resizeMatch[1]), body.cols, body.rows),
        );
      }
      const bootstrapMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/bootstrap$/);
      if (req.method === 'POST' && bootstrapMatch) {
        await readJson(req, { allowed: [] });
        return sendJson(
          res,
          200,
          await sessionManager.bootstrap(decodeURIComponent(bootstrapMatch[1])),
        );
      }
      const interruptMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/interrupt$/);
      if (req.method === 'POST' && interruptMatch) {
        await readJson(req, { allowed: [] });
        return sendJson(
          res,
          200,
          await sessionManager.interrupt(decodeURIComponent(interruptMatch[1])),
        );
      }
      const stopMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/stop$/);
      if (req.method === 'POST' && stopMatch) {
        const body = await readJson(req, { allowed: [] });
        return sendJson(
          res,
          202,
          await sessionManager.stop(decodeURIComponent(stopMatch[1]), body),
        );
      }
      const interventionSendMatch = url.pathname.match(/^\/api\/interventions\/(\d+)\/send$/);
      if (req.method === 'POST' && interventionSendMatch) {
        const body = await readJson(req, { allowed: ['sessionId'] });
        return sendJson(
          res,
          200,
          await dispatchIntervention(interventionSendMatch[1], body.sessionId || null, false),
        );
      }
      const interventionDismissMatch = url.pathname.match(/^\/api\/interventions\/(\d+)\/dismiss$/);
      if (req.method === 'POST' && interventionDismissMatch) {
        const body = await readJson(req, { allowed: ['note'] });
        const item = store.getIntervention(interventionDismissMatch[1]);
        if (!item) throw new SessionError('intervention_not_found', 'Intervention was not found', 404);
        if (item.status !== 'PROPOSED' && item.status !== 'HELD') {
          throw new SessionError('intervention_not_pending', 'Intervention is not pending', 409);
        }
        return sendJson(res, 200, store.setIntervention(item.id, {
          status: 'DISMISSED',
          note: typeof body.note === 'string' ? body.note.slice(0, 1000) : 'dismissed_by_user',
        }));
      }
      const automationSendMatch = url.pathname.match(/^\/api\/automation-events\/(\d+)\/send$/);
      if (req.method === 'POST' && automationSendMatch) {
        const body = await readJson(req, { allowed: ['sessionId'] });
        try {
          return sendJson(
            res,
            200,
            await automationEngine.deliver(automationSendMatch[1], body.sessionId || null),
          );
        } catch (error) {
          throw new SessionError('automation_delivery_failed', error.message, 409);
        }
      }
      const automationDismissMatch = url.pathname.match(/^\/api\/automation-events\/(\d+)\/dismiss$/);
      if (req.method === 'POST' && automationDismissMatch) {
        const body = await readJson(req, { allowed: ['note'] });
        const item = store.listAutomationEvents(1000)
          .find((event) => event.id === Number(automationDismissMatch[1]));
        if (!item) throw new SessionError('automation_event_not_found', 'Event was not found', 404);
        if (!['PENDING', 'HELD'].includes(item.status)) {
          throw new SessionError('automation_event_not_pending', 'Event is not pending', 409);
        }
        return sendJson(res, 200, store.setAutomationEvent(item.id, {
          status: 'DISMISSED',
          note: typeof body.note === 'string' ? body.note.slice(0, 1000) : 'dismissed_by_user',
        }));
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendError(res, 405, 'method_not_allowed', 'Method is not allowed');
      }
      const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const safePath = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, '');
      const filePath = vendorFiles[url.pathname]
        ? join(config.root, vendorFiles[url.pathname])
        : join(publicDir, safePath);
      const body = await readFile(filePath);
      res.writeHead(200, {
        'content-type': mime[extname(safePath)] || 'application/octet-stream',
        'content-length': body.length,
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'",
        'x-content-type-options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      if (error instanceof SessionError) {
        return sendError(res, error.status, error.code, error.message);
      }
      if (error instanceof URIError) return sendError(res, 400, 'invalid_path', 'Path is malformed');
      if (error.code === 'ENOENT') return sendError(res, 404, 'not_found', 'Resource was not found');
      console.error(error);
      return sendError(res, 500, 'internal_error', 'Internal server error');
    }
  });
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws/terminal') {
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(req, socket, head, (ws) => webSockets.emit('connection', ws));
  });
  webSockets.on('connection', (ws) => {
    let attachedId = null;
    let cursor = 0;
    let pumping = false;
    const send = (value) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(value));
    };
    const pump = async () => {
      if (!attachedId || pumping) return;
      pumping = true;
      try {
        const result = await sessionManager.output(attachedId, cursor);
        cursor = result.nextCursor;
        send({ type: 'output', ...result });
      } catch (error) {
        send({ type: 'error', error: { code: error.code, message: error.message } });
      } finally {
        pumping = false;
      }
    };
    const timer = setInterval(pump, 100);
    ws.on('message', async (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === 'attach') {
          attachedId = message.sessionId;
          cursor = Number.isSafeInteger(message.offset) && message.offset >= 0 ? message.offset : 0;
          await pump();
        } else if (message.type === 'input' && attachedId) {
          await sessionManager.input(attachedId, message.data);
        } else if (message.type === 'resize' && attachedId) {
          await sessionManager.resize(attachedId, message.cols, message.rows);
        } else if (message.type === 'stop' && attachedId) {
          await sessionManager.stop(attachedId);
        } else {
          throw new SessionError('invalid_ws_message', 'Unsupported WebSocket message');
        }
      } catch (error) {
        send({ type: 'error', error: { code: error.code, message: error.message } });
      }
    });
    ws.once('close', () => clearInterval(timer));
  });

  // Normal prompt transitions are operational evidence, not review triggers.
  // Resolve legacy stop-review events instead of reviving the old policy.
  for (const event of store.listPendingAutomationEvents(1000)) {
    if (event.eventType === 'STOP_REVIEW_QUEUED' && event.source?.stop) {
      store.setAutomationEvent(event.id, {
        status: 'RESOLVED', note: 'normal_prompt_review_policy_disabled',
      });
    }
  }

  return {
    server,
    config,
    store,
    sessionManager,
    scan,
    fullCycle,
    runSemanticCycle,
    automationEngine,
    async listen(port = config.port, host = config.host) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      if (config.scanIntervalMs > 0) {
        scanTimer = setInterval(() => {
          fullCycle().catch((error) => console.error('Scheduled control-room cycle failed:', error));
        }, config.scanIntervalMs);
        scanTimer.unref();
      }
      if (config.watchdog.pollMs > 0) {
        automationTimer = setInterval(() => {
          automationEngine.cycle().catch((error) => console.error('Automation cycle failed:', error));
        }, config.watchdog.pollMs);
        automationTimer.unref();
      }
      return server.address();
    },
    async close() {
      if (scanTimer) {
        clearInterval(scanTimer);
        scanTimer = null;
      }
      if (automationTimer) {
        clearInterval(automationTimer);
        automationTimer = null;
      }
      if (stopReviewInFlight.size) {
        await Promise.allSettled([...stopReviewInFlight.values()]);
      }
      for (const client of webSockets.clients) client.terminate();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      webSockets.close();
      await sessionManager.close();
      store.close();
    },
  };
}

async function main() {
  const app = await createApp();
  const address = await app.listen();
  console.log(`FIRM Control Room listening on http://${address.address}:${address.port}`);
  console.log(app.config.scanIntervalMs > 0
    ? `Scheduled read-only scan interval: ${app.config.scanIntervalMs} ms`
    : 'Scheduled read-only scans disabled');
  try {
    const initial = await app.fullCycle();
    console.log(`Initial read-only scan #${initial.id}: ${initial.evidenceHash}`);
  } catch (error) {
    console.error('Initial scan failed:', error);
  }
  try {
    const automation = await app.automationEngine.cycle({ forceQueue: true });
    console.log(`Initial automation cycle: GPU queue ${automation.queue.status}`);
  } catch (error) {
    console.error('Initial automation cycle failed:', error);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
