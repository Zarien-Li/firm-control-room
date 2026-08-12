import { argvFingerprint, processStartToken } from './process-identity.js';

const baseUrl = process.env.FIRM_URL || 'http://127.0.0.1:8787';
const [action, ...args] = process.argv.slice(2);

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message || `HTTP ${response.status}`);
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (action === 'register') {
  const [runId, projectId, kind, purpose = ''] = args;
  if (!runId || !projectId || !kind) throw new Error('register requires RUN_ID PROJECT KIND [PURPOSE]');
  await post('/api/jobs', {
    runId, projectId, kind, executor: 'firm-wrapper', purpose, source: 'firm-job.js',
  });
} else if (['start', 'heartbeat', 'done', 'failed', 'cancelled'].includes(action)) {
  const [runId, ...commandArgv] = args;
  if (!runId) throw new Error(`${action} requires RUN_ID`);
  const state = ['start', 'heartbeat'].includes(action) ? 'running' : action;
  const pid = Number(process.env.FIRM_JOB_PID || process.ppid);
  await post(`/api/jobs/${encodeURIComponent(runId)}/status`, {
    state, pid, pidStartToken: process.env.FIRM_JOB_PID_START_TOKEN || processStartToken(pid),
    ...(commandArgv.length ? { commandFingerprint: argvFingerprint(commandArgv) } : {}),
    source: 'firm-job.js',
  });
} else {
  throw new Error('usage: firm-job.sh register RUN_ID PROJECT {local_cpu|remote_cpu|ssh} [PURPOSE] | start RUN_ID COMMAND [ARGS...] | {heartbeat|done|failed|cancelled} RUN_ID');
}
