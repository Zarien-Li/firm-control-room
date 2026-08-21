import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { auditSnapshot } from './audit.js';
import { AutomationEngine } from './automation-engine.js';
import { BrokerClient } from './broker-client.js';
import { readRecentClaudeActivity } from './claude-history.js';
import { collectClaudeSessions, collectSnapshot } from './collectors.js';
import { loadConfig } from './config.js';
import { createEvidenceBundle, verifyEvidenceBundle } from './evidence.js';
import {
  clearItermDraft,
  selectItermChoice,
  sendItermMessage,
  submitItermDraft,
} from './iterm-status.js';
import { SessionError } from './session-manager.js';
import { deriveOperationalState } from './session-state.js';
import { createStore } from './store.js';
import { JobRegistry } from './job-registry.js';
import { activeJobs } from './job-wait.js';
import { CodexContinuityResolver } from './continuity-resolver.js';
import { ContinuitySupervisor } from './continuity-supervisor.js';

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
    externalSessionChooser: suppliedExternalSessionChooser,
    continuityResolver: suppliedContinuityResolver,
    continuitySupervisor: suppliedContinuitySupervisor,
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
        || [config.researchPromptPath, project.bootstrapFile || 'prompt.txt'].filter(Boolean),
    }));
  }
  const store = await createStore(config.dataDir, {
    scanRetention: config.historyRetention?.scans,
    gpuSnapshotRetention: config.historyRetention?.gpuSnapshots,
  });
  store.pruneHistory();
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
  const externalSessionChooser = suppliedExternalSessionChooser || ((session, current, target) => (
    selectItermChoice(
      session.tty?.startsWith('/dev/') ? session.tty : `/dev/${session.tty}`,
      current,
      target,
    )
  ));
  const jobRegistry = new JobRegistry({ store });
  const continuityResolver = suppliedContinuityResolver || (
    config.continuity?.enabled
      ? new CodexContinuityResolver({
        executable: config.continuity.codexExecutable,
        schemaPath: join(config.root, 'config', 'continuity-decision.schema.json'),
        model: config.continuity.model,
        timeoutMs: config.continuity.timeoutMs,
      })
      : null
  );
  const continuitySupervisor = suppliedContinuitySupervisor || (
    config.continuity?.enabled
      ? new ContinuitySupervisor({ config, store, resolver: continuityResolver })
      : null
  );
  const automationEngine = suppliedAutomationEngine || new AutomationEngine({
    config,
    store,
    sessionManager,
    discoverExternalSessions: externalSessionsCollector,
    externalSessionInput: externalSessionSender,
    externalSessionSubmit: externalSessionSubmitter,
    externalSessionClear: externalSessionClearer,
    externalSessionChoose: externalSessionChooser,
    jobRegistry,
    continuitySupervisor,
  });
  const publicDir = join(config.root, 'public');
  let scanPromise = null;
  let scanTimer = null;
  let automationTimer = null;
  let controlStatusPromise = null;
  let controlStatusCache = null;

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

  const fullCycle = scan;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/api/health') {
        const broker = await sessionManager.health?.();
        return sendJson(res, 200, {
          ok: true,
          mode: continuitySupervisor ? 'operations-and-continuity' : 'operations-only',
          autoCorrection: false,
          scientificAuthority: 'external-only',
          projectCount: config.projects.length,
          controlTargetCount: config.controlTargets.length,
          scanIntervalMs: config.scanIntervalMs,
          managedSessions: true,
          automation: {
            gpuQueueEnabled: config.gpuQueue.enabled,
            gpuQueueStatus: automationEngine.snapshot().status,
            gpuSchedulerAutoStart: config.gpuQueue.schedulerAutoStart,
            gpuSchedulerMonitor: automationEngine.monitorSnapshot?.() || {
              status: 'unknown', reason: 'monitor_probe_unavailable',
            },
            watchdogPollMs: config.watchdog.pollMs,
            researchMessageAuthority: continuitySupervisor ? 'continuity-only' : false,
          },
          continuity: continuitySupervisor?.snapshot() || { enabled: false, inflight: [] },
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
        const jobsSnapshot = automationEngine.jobsSnapshot?.() || jobRegistry.snapshot();
        return sendJson(res, 200, {
          status: discovered.status,
          terminalStatus: discovered.terminalStatus,
          items: discovered.items.map((session) => {
            const operational = deriveOperationalState(session, {
              events,
              outbox,
              schedulerMonitor: automationEngine.monitorSnapshot?.(),
              jobs: jobsSnapshot,
            });
            const projectActiveJobs = activeJobs(jobsSnapshot, session.projectId).map((job) => ({
              runId: job.runId,
              kind: job.kind,
              state: job.state,
              purpose: job.purpose || null,
              startedAt: job.startedAt || null,
              heartbeatAt: job.heartbeatAt || null,
            }));
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
              operationalDetails: operational.details,
              projectActiveJobs,
            };
          }),
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/control-status') {
        return sendJson(res, 200, await collectControlStatus(
          url.searchParams.get('refresh') === '1',
        ));
      }
      if (req.method === 'GET' && url.pathname === '/api/scans') {
        return sendJson(res, 200, store.list(url.searchParams.get('limit')));
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
      if (req.method === 'POST' && url.pathname === '/api/automation-cycle') {
        await readJson(req, { allowed: [] });
        return sendJson(res, 200, await automationEngine.cycle({ forceQueue: true }));
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
      for (const client of webSockets.clients) client.terminate();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      webSockets.close();
      await sessionManager.close();
      continuityResolver?.close?.();
      await continuitySupervisor?.idle?.();
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
