const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '—').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
}[char]));

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function request(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const attempts = method === 'GET' ? 3 : 1;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(path, { ...options, cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(`${body.error?.code || response.status}: ${body.error?.message || response.statusText}`);
      }
      return body;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await sleep(300 * (2 ** attempt));
    }
  }
  throw lastError;
}

const jsonOptions = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

let managedSessions = [];
let selectedSessionId = null;
let outputCursor = 0;
let terminalSocket = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let lastRenderPayload = null;
let automationPolicies = [];
let showIdleProjects = false;
let lastControlStatus = null;
let lastProfessorStatus = null;
let sessionTargetIds = new Set();
let externalSessionStates = [];
let dashboardRefreshPromise = null;

function formatTime(value) {
  if (!value) return '未知时间';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function projectFile(project, name) {
  return project.files?.find((file) => file.name === name)?.content || '';
}

function liveField(text, label) {
  const line = text.split('\n').find((value) => value.trim().toLowerCase().startsWith(`- ${label.toLowerCase()}`));
  return line ? line.slice(line.indexOf(':') + 1).trim() : null;
}

function semanticStatus(item) {
  if (item?.audit?.verdict) return { verdict: item.audit.verdict, text: item.audit.summary };
  if (!item) return { verdict: 'PENDING', text: '等待首次语义巡检' };
  if (item.status === 'idle') return { verdict: 'IDLE', text: '最近五小时无研究活动' };
  if (item.status === 'unavailable') return { verdict: 'OFFLINE', text: '尚无可读取的 Claude 会话历史' };
  if (item.status === 'failed') return { verdict: 'ERROR', text: 'Codex 巡检失败；研究会话未被修改' };
  return { verdict: 'PENDING', text: '巡检尚未完成' };
}

function verdictClass(verdict) {
  return `verdict-${String(verdict || 'UNKNOWN').toLowerCase()}`;
}

function automationNote(item) {
  const labels = {
    scheduler_is_external_and_cannot_be_injected: 'Scheduler 外部运行，等待控制台接管',
    no_waiting_managed_session: '目标会话当前不在输入点',
    scheduler_auto_started_waiting_for_ready_prompt: 'Scheduler 已启动，等待 ready',
    unmapped_project: '无法自动映射项目',
  };
  return labels[item.note] || item.note || '等待安全投递';
}

function externalSessionLabel(session) {
  const state = session?.operationalState || session?.terminal?.state || 'STATE_UNCERTAIN';
  const labels = {
    MODEL_WORKING: '模型工作中',
    TOOL_RUNNING: '工具运行中',
    READY_FOR_INPUT: '等待输入 · 继续',
    READY_FOR_CONTINUATION: 'Goal 待续跑',
    WAITING_REVIEW: '等待独立审查',
    POLICY_HELD: '策略暂停',
    MESSAGE_PENDING_ACK: '消息待确认',
    DRAFT_PENDING_ENTER: '续跑文本待提交',
    WAITING_FOR_JOB: '等待已注册任务',
    JOB_ACTIVE_UNDECLARED: '任务运行中（未声明等待）',
    RATE_LIMITED: '限额等待',
    TOOL_DRAINING: '工具仍在收尾',
    CONFIRMATION_REQUIRED: '等待权限确认',
    MONITORING_IDLE: '监控空闲',
    OBSERVABILITY_DEGRADED: '采集降级',
    PROGRESS_STALLED: '有效进展停滞',
    STATE_UNCERTAIN: '状态不确定',
  };
  return labels[state] || state;
}

function externalCanContinue(session) {
  return ['READY_FOR_INPUT', 'READY_FOR_CONTINUATION'].includes(session?.operationalState)
    || (!session?.operationalState && session?.terminal?.state === 'WAITING_INPUT');
}

function heartbeatLabel(heartbeat) {
  if (!heartbeat) return '等待有效进展采集';
  if (heartbeat.status !== 'ok') return `采集降级 · ${heartbeat.historyStatus || 'unknown'}`;
  const tools = Number(heartbeat.toolProcessCount || 0);
  return heartbeat.lastProgressAt
    ? `${formatTime(heartbeat.lastProgressAt)} · 工具 ${tools}`
    : `尚无历史或关键产物写入 · 工具 ${tools}`;
}

async function refreshExternalSessionStatus() {
  const result = await request('/api/external-sessions');
  externalSessionStates = result.items || [];
  for (const session of externalSessionStates) {
    if (!session.projectId) continue;
    const state = session.operationalState || session.terminal?.state || 'STATE_UNCERTAIN';
    const fact = document.querySelector(`[data-session-project="${CSS.escape(session.projectId)}"]`);
    if (fact) fact.textContent = `PID ${session.pid} · ${state}`;
    const progress = document.querySelector(`[data-heartbeat-project="${CSS.escape(session.projectId)}"]`);
    if (progress) progress.textContent = heartbeatLabel(session.heartbeat);
    const button = document.querySelector(`[data-continue-external="${CSS.escape(session.projectId)}"]`);
    if (!button) continue;
    button.textContent = externalSessionLabel(session);
    button.disabled = !externalCanContinue(session);
    button.classList.remove('external-working', 'external-waiting', 'external-confirmation', 'external-unknown');
    button.classList.add(`external-${externalCanContinue(session) ? 'waiting' : 'working'}`);
  }
}

function renderControlStatus(status) {
  if (!status || !$('#scheduler-activity')) return;
  lastControlStatus = status;
  const pending = status.pendingRuns || [];
  const running = status.runningRuns || [];
  const monitor = status.monitor || { status: 'unknown' };
  const state = status.awaitingResponse
    ? `处理中 · PID ${status.pid || '—'}`
    : status.status === 'EXTERNAL' && monitor.status === 'healthy'
        && !pending.length && !running.length
      ? `MONITORING_IDLE · PID ${status.pid}`
      : status.status === 'EXTERNAL'
        ? `外部运行 · PID ${status.pid}`
        : status.status === 'STOPPED' ? '未运行'
          : `${status.status} · PID ${status.pid || '—'}`;
  if ($('#scheduler-live-state')) $('#scheduler-live-state').textContent = state;
  const queueText = [
    running.length ? `运行中：${running.join('、')}` : '',
    pending.length ? `待处理：${pending.join('、')}` : '',
  ].filter(Boolean).join(' · ') || '队列暂无权威 signal 条目';
  const currentText = status.awaitingResponse
    ? '已收到比最后回复更新的请求，尚未看到 Scheduler 后续响应。'
    : status.lastAction?.text || '尚未读取到 Scheduler 的语义动作记录。';
  const monitorText = monitor.status === 'healthy'
    ? `正常 · PID ${monitor.pid || '—'} · ${formatTime(monitor.checkedAt)}`
    : `${monitor.status || 'unknown'} · ${monitor.reason || '尚未校验'}`;
  $('#scheduler-activity').innerHTML = `
    <dl class="scheduler-activity-grid">
      <dt>全局监控</dt><dd>${escapeHtml(monitorText)}</dd>
      <dt>当前队列</dt><dd>${escapeHtml(queueText)}</dd>
      ${status.awaitingResponse ? `<dt>当前状态</dt><dd>${escapeHtml(currentText)}</dd>` : ''}
      <dt>最近动作</dt><dd>${escapeHtml(status.lastAction?.text || '尚未读取到 Scheduler 的语义动作记录。')}</dd>
      ${status.awaitingResponse && status.lastIncoming ? `<dt>最近请求</dt><dd>${escapeHtml(status.lastIncoming.text)}</dd>` : ''}
      <dt>活动时间</dt><dd>${escapeHtml(formatTime(status.latestActivityAt || status.collectedAt))}</dd>
    </dl>`;
}

function renderProfessorStatus(status) {
  if (!status || !$('#professor-band')) return;
  lastProfessorStatus = status;
  const intervalHours = Number.isFinite(status.intervalMs)
    ? status.intervalMs / (60 * 60 * 1000) : null;
  $('#professor-live-state').textContent = `${status.status || 'UNKNOWN'} · STATELESS`;
  $('#professor-summary').textContent = [
    status.lastCodexAt ? `最近 Codex ${formatTime(status.lastCodexAt)}` : '等待首次 Codex 巡检',
    status.nextRunAt ? `下次 ${formatTime(status.nextRunAt)}`
      : intervalHours ? `周期 ${intervalHours} 小时` : '',
    `${status.pendingInterventions || 0} 个待确认重锚`,
  ].filter(Boolean).join(' · ');
  $('#professor-actions').innerHTML = '<button class="compact" data-run-professor>立即差分巡检</button>';
  const states = status.projectStates || [];
  $('#professor-projects').innerHTML = states.length ? states.slice(0, 9).map((item) => `
    <span class="professor-project">
      <b class="${verdictClass(item.verdict)}">${escapeHtml(item.projectId)}</b>
      <small>${escapeHtml(item.verdict)} · ${escapeHtml(item.status)}${item.updatedAt ? ` · ${escapeHtml(formatTime(item.updatedAt))}` : ''}</small>
    </span>`).join('') : '<span class="empty">等待首次隔离巡检</span>';
}

function bindDashboardActions() {
  document.querySelectorAll('[data-start-project]').forEach((button) => {
    button.addEventListener('click', () => startProject(button.dataset.startProject));
  });
  document.querySelectorAll('[data-start-control]').forEach((button) => {
    button.addEventListener('click', () => startProject(button.dataset.startControl, button));
  });
  document.querySelectorAll('[data-open-session]').forEach((button) => {
    button.addEventListener('click', () => selectSession(button.dataset.openSession));
  });
  document.querySelectorAll('[data-continue-external]').forEach((button) => {
    button.addEventListener('click', async () => {
      const projectId = button.dataset.continueExternal;
      if (!confirm(`向 ${projectId} 的外部 iTerm Claude 发送固定、范围保持的续跑指令？`)) return;
      button.disabled = true;
      button.textContent = '正在续跑…';
      try {
        await request(`/api/external-sessions/${encodeURIComponent(projectId)}/continue`, jsonOptions({}));
        $('#session-status').textContent = `${projectId} 已提交续跑指令`;
        setTimeout(() => refreshExternalSessionStatus().catch(() => {}), 1000);
      } catch (error) {
        $('#session-status').textContent = `外部续跑失败：${error.message}`;
        await refreshExternalSessionStatus();
      }
    });
  });
  document.querySelectorAll('[data-audit-project]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = '巡检中…';
      try {
        await request('/api/semantic-audit', jsonOptions({ projectId: button.dataset.auditProject }));
        await refresh();
      } catch (error) {
        $('#session-status').textContent = `Codex 巡检失败：${error.message}`;
      } finally {
        button.disabled = false;
        button.textContent = '巡检';
      }
    });
  });
  document.querySelectorAll('[data-run-professor]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = '差分巡检中…';
      try {
        await request('/api/semantic-audit', jsonOptions({}));
        await refresh();
      } catch (error) {
        $('#session-status').textContent = `Codex Professor 巡检失败：${error.message}`;
      } finally {
        button.disabled = false;
        button.textContent = '立即差分巡检';
      }
    });
  });
  document.querySelectorAll('[data-send-intervention]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!confirm('将固定边界重锚消息发送到该项目唯一等待输入的托管 session？')) return;
      try {
        await request(`/api/interventions/${button.dataset.sendIntervention}/send`, jsonOptions({}));
        await refresh();
      } catch (error) {
        $('#session-status').textContent = `重锚发送失败：${error.message}`;
      }
    });
  });
  document.querySelectorAll('[data-dismiss-intervention]').forEach((button) => {
    button.addEventListener('click', async () => {
      await request(`/api/interventions/${button.dataset.dismissIntervention}/dismiss`, jsonOptions({}));
      await refresh();
    });
  });
  document.querySelectorAll('[data-send-automation]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!confirm('把这条固定操作通知发送到唯一等待输入的托管目标 session？')) return;
      try {
        await request(`/api/automation-events/${button.dataset.sendAutomation}/send`, jsonOptions({}));
        await refresh();
      } catch (error) {
        $('#session-status').textContent = `事件投递失败：${error.message}`;
      }
    });
  });
  document.querySelectorAll('[data-dismiss-automation]').forEach((button) => {
    button.addEventListener('click', async () => {
      await request(`/api/automation-events/${button.dataset.dismissAutomation}/dismiss`, jsonOptions({}));
      await refresh();
    });
  });
  document.querySelectorAll('[data-open-target]').forEach((button) => {
    button.addEventListener('click', () => {
      const session = managedSessions.find((candidate) => (
        candidate.projectId === button.dataset.openTarget
        && ['RUNNING', 'WAITING_INPUT'].includes(candidate.status)
      ));
      if (session) selectSession(session.id);
      else $('#session-status').textContent = `${button.dataset.openTarget} 没有可打开的托管 session`;
    });
  });
  document.querySelectorAll('[data-goal-project]').forEach((button) => {
    button.addEventListener('click', async () => {
      const projectId = button.dataset.goalProject;
      const current = automationPolicies.find((policy) => policy.targetId === projectId);
      const enable = !current?.enabled;
      let objective = current?.objective || [
        `自主完成 ${projectId} 的完整研究到可投稿论文。`,
        '保持当前 sealed arena 和 primary outcome，先建立强基线与自然经验接触，再由证据形成和迭代方法，完成公平评估、主张收口与论文写作。',
      ].join(' ');
      if (enable) {
        objective = window.prompt('为该项目设置 Goal Loop 目标（系统不会自行扩大目标）：', objective)?.trim();
        if (!objective) return;
      }
      button.disabled = true;
      try {
        await request(`/api/automation-policies/${encodeURIComponent(projectId)}`, jsonOptions({
          enabled: enable,
          objective,
        }));
        await refresh();
        $('#session-status').textContent = `${projectId} Goal Loop 已${enable ? '开启' : '关闭'}`;
      } catch (error) {
        $('#session-status').textContent = `Goal Loop 更新失败：${error.message}`;
      } finally {
        button.disabled = false;
      }
    });
  });
}

function render(
  scan,
  history,
  semanticAudits = [],
  interventions = [],
  gpuQueue = {},
  automationEvents = [],
  policies = [],
  professorStatus = {},
  projectProgress = [],
) {
  const { snapshot, audit } = scan;
  const projectSemanticState = (project) => semanticStatus(
    semanticAudits.find((item) => item.projectId === project.id),
  );
  const idleProjectCount = snapshot.projects.filter((project) => (
    projectSemanticState(project).verdict === 'IDLE'
  )).length;
  const visibleProjects = showIdleProjects
    ? snapshot.projects
    : snapshot.projects.filter((project) => projectSemanticState(project).verdict !== 'IDLE');
  $('#toggle-idle').hidden = idleProjectCount === 0;
  $('#toggle-idle').textContent = showIdleProjects
    ? '隐藏 IDLE'
    : `显示 IDLE (${idleProjectCount})`;
  const groupedFindings = [...audit.findings.reduce((groups, item) => {
    const key = `${item.rule}:${item.severity}:${item.message}`;
    const current = groups.get(key) || { ...item, projects: [], count: 0 };
    current.count += 1;
    if (item.projectId) current.projects.push(item.projectId);
    groups.set(key, current);
    return groups;
  }, new Map()).values()];
  $('#updated').textContent = new Date(snapshot.collectedAt).toLocaleString();
  $('#summary').innerHTML = [
    ['规则状态', audit.verdict],
    ['项目', snapshot.projects.length],
    ['Claude Sessions', snapshot.sessions?.total ?? 0],
    ['待确认重锚', interventions.filter((item) => ['PROPOSED', 'HELD'].includes(item.status)).length],
    ['Automation Inbox', automationEvents.filter((item) => ['PENDING', 'HELD', 'SENT'].includes(item.status)).length],
    ['Goal Loops', policies.filter((item) => item.enabled).length],
  ].map(([label, value]) => `<div class="metric"><strong>${value}</strong><span>${label}</span></div>`).join('');
  $('#projects').innerHTML = visibleProjects.map((project) => `
    ${(() => {
      const origin = project.identity.value?.origin || {};
      const state = projectFile(project, 'PIPELINE_STATE.md');
      const semantic = semanticAudits.find((item) => item.projectId === project.id);
      const goalPolicy = policies.find((item) => item.targetId === project.id);
      const managed = managedSessions.filter((session) => session.projectId === project.id);
      const live = managed.find((session) => ['RUNNING', 'WAITING_INPUT'].includes(session.status));
      const processSession = externalSessionStates.find((session) => session.projectId === project.id)
        || project.sessions?.[0];
      const sessionStatus = live?.status || (processSession
        ? `PID ${processSession.pid} · ${processSession.operationalState || processSession.terminal?.state || 'STATE_UNCERTAIN'}` : '未运行');
      const nextAction = liveField(state, 'Next action') || liveField(state, '下一行动') || '等待会话更新 live state';
      const progress = projectProgress.find((item) => item.targetId === project.id);
      const progressSummary = progress?.summary || `尚未完成首次五小时组合审查。当前动作：${nextAction}`;
      const semanticState = semanticStatus(semantic);
      return `<article class="project-card">
        <div class="project-head">
          <div><h3>${escapeHtml(project.name)}</h3><span>${escapeHtml(origin.research_arena || project.identity.arena || project.identity.canonicalObject)}</span></div>
          <b class="${verdictClass(semanticState.verdict)}">${escapeHtml(semanticState.verdict)}</b>
        </div>
        <div class="primary-outcome">
          <p>${escapeHtml(progressSummary)}</p>
          <small>${escapeHtml(progress?.stage || '待首次组合审查')} · ${escapeHtml(progress?.reviewedAt ? formatTime(progress.reviewedAt) : '尚未审查')}</small>
        </div>
        <dl class="project-facts">
          <dt>Session</dt><dd data-session-project="${escapeHtml(project.id)}">${escapeHtml(sessionStatus)}</dd>
          <dt>有效进展</dt><dd data-heartbeat-project="${escapeHtml(project.id)}">${escapeHtml(heartbeatLabel(processSession?.heartbeat))}</dd>
          <dt>当前动作</dt><dd>${escapeHtml(nextAction)}</dd>
          <dt>Codex</dt><dd>${escapeHtml(semanticState.text)}</dd>
        </dl>
        <div class="project-actions">
          ${live ? `<button class="secondary compact" data-open-session="${escapeHtml(live.id)}">打开终端</button>`
            : processSession ? `<button class="secondary compact external-${externalCanContinue(processSession) ? 'waiting' : 'working'}" data-continue-external="${escapeHtml(project.id)}" ${externalCanContinue(processSession) ? '' : 'disabled'}>${escapeHtml(externalSessionLabel(processSession))}</button>`
              : `<button class="compact" data-start-project="${escapeHtml(project.id)}">启动研究</button>`}
          <button class="secondary compact" data-audit-project="${escapeHtml(project.id)}">巡检</button>
          <button class="secondary compact goal-${goalPolicy?.enabled ? 'on' : 'off'}" data-goal-project="${escapeHtml(project.id)}">Goal ${goalPolicy?.enabled ? 'ON' : 'OFF'}</button>
        </div>
      </article>`;
    })()}`).join('');
  const observedScheduler = snapshot.sessions?.items?.find((session) => (
    session.controlId === 'GPU_SCHEDULER'
  ));
  const managedScheduler = managedSessions.find((session) => (
    session.projectId === 'GPU_SCHEDULER' && ['RUNNING', 'WAITING_INPUT'].includes(session.status)
  ));
  const schedulerState = managedScheduler
    ? `${managedScheduler.status} · PID ${managedScheduler.pid}`
    : observedScheduler ? `外部运行 · PID ${observedScheduler.pid}` : '未运行';
  $('#scheduler-band').innerHTML = `
    <div class="scheduler-identity">
      <span class="scheduler-mark">GPU</span>
      <div><strong>GPU Scheduler</strong><small>唯一 worker 生命周期管理会话 · 不参与研究 Codex 审计</small></div>
    </div>
    <div class="scheduler-state"><span id="scheduler-live-state">${escapeHtml(schedulerState)}</span><small>${observedScheduler && !managedScheduler ? '停止原 iTerm 会话后可从这里启动并接管' : '自动读取 GPU_SCHEDULER_START_PROMPT.md'}</small></div>
    <div class="scheduler-actions">
      ${managedScheduler
        ? `<button class="secondary compact" data-open-session="${escapeHtml(managedScheduler.id)}">打开终端</button>`
        : observedScheduler
          ? '<button class="secondary compact" disabled>外部会话运行中</button>'
          : '<button class="compact" data-start-control="GPU_SCHEDULER">启动 Scheduler</button>'}
    </div>
    <div class="scheduler-activity" id="scheduler-activity"><span>正在读取 Scheduler 动作…</span></div>`;
  if (lastControlStatus) renderControlStatus(lastControlStatus);
  renderProfessorStatus(professorStatus);
  const queueCounts = gpuQueue.counts || {};
  $('#gpu-queue-updated').textContent = gpuQueue.status === 'ok'
    ? `远端同步 ${formatTime(gpuQueue.collectedAt)}`
    : gpuQueue.status === 'disabled' ? 'GPU queue 自动化已关闭'
      : `队列不可用：${gpuQueue.error || gpuQueue.status || '等待首次同步'}`;
  $('#gpu-queue-counts').innerHTML = ['pending', 'running', 'done', 'failed', 'cancelled']
    .map((state) => `<div class="queue-count queue-${state}"><strong>${escapeHtml(queueCounts[state] || 0)}</strong><span>${state}</span></div>`)
    .join('');
  const queueItems = [...(gpuQueue.items || [])]
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, 10);
  $('#gpu-queue-items').innerHTML = queueItems.length ? queueItems.map((item) => {
    const gpu = item.metadata || {};
    return `
    <article class="queue-item">
      <b class="queue-state queue-${escapeHtml(item.state)}">${escapeHtml(item.state)}</b>
      <span><strong>${escapeHtml(item.runId)}</strong><small>${escapeHtml(item.projectId || '未映射项目')} · ${escapeHtml(item.kind)} / ${escapeHtml(item.executor)} · ${escapeHtml(formatTime(item.updatedAt))}</small></span>
      <div class="queue-diagnostics">
        <code class="readiness readiness-${escapeHtml(String(gpu.submissionReadiness?.state || 'registered').toLowerCase())}">${escapeHtml(gpu.submissionReadiness?.state || 'REGISTERED')}</code>
        <code class="efficiency efficiency-${escapeHtml(String(gpu.efficiency?.state || 'tracked').toLowerCase())}" title="${escapeHtml(gpu.efficiency?.recommendation || item.purpose || '')}">${escapeHtml(gpu.efficiency?.state || 'TRACKED')}${Number.isFinite(gpu.efficiency?.averageUtilizationPct) ? ` · ${gpu.efficiency.averageUtilizationPct.toFixed(1)}%` : ''}</code>
      </div>
    </article>`;
  }).join('') : '<div class="empty">当前没有已注册任务</div>';
  const pendingAutomation = automationEvents.filter((item) => ['PENDING', 'HELD', 'SENT'].includes(item.status));
  $('#automation-inbox-section').hidden = !pendingAutomation.length;
  $('#automation-events').innerHTML = pendingAutomation.map((item) => {
    const managedTarget = managedSessions.find((session) => (
      session.projectId === item.targetId && ['RUNNING', 'WAITING_INPUT'].includes(session.status)
    ));
    const canSend = ['PENDING', 'HELD'].includes(item.status)
      && ['gpu_queue', 'gpu_efficiency', 'job_registry'].includes(item.category)
      && managedTarget?.status === 'WAITING_INPUT';
    return `<article class="automation-event event-${escapeHtml(item.severity)}">
      <b>${escapeHtml(item.eventType)}</b>
      <span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.targetId || '未映射')} · ${escapeHtml(item.status)} · ${escapeHtml(automationNote(item))}</small></span>
      <div class="automation-event-actions">
        ${canSend ? `<button class="compact" data-send-automation="${item.id}">发送</button>` : ''}
        ${managedTarget ? `<button class="secondary compact" data-open-target="${escapeHtml(item.targetId)}">打开</button>` : ''}
        ${item.targetId === 'GPU_SCHEDULER' && !managedTarget ? '<button class="secondary compact" disabled>等待接管</button>' : ''}
        ${item.status === 'SENT'
          ? '<button class="secondary compact" disabled>等待历史 ACK</button>'
          : `<button class="secondary compact" data-dismiss-automation="${item.id}">忽略</button>`}
      </div>
    </article>`;
  }).join('');
  const pendingInterventions = interventions.filter((item) => ['PROPOSED', 'HELD'].includes(item.status));
  $('#intervention-section').hidden = !pendingInterventions.length;
  $('#interventions').innerHTML = pendingInterventions.map((item) => {
    const evidence = item.evidence || [];
    const evidenceDetails = evidence.length ? `<details class="intervention-evidence">
      <summary>查看已验证原始证据 (${evidence.length})</summary>
      <div class="evidence-list">${evidence.map((entry) => `<section>
        <b>${escapeHtml(entry.sourceLabel || entry.source)}</b>
        <small>${escapeHtml(entry.sourceKind)}</small>
        <blockquote>${escapeHtml(entry.quote)}</blockquote>
        ${entry.reason ? `<p>${escapeHtml(entry.reason)}</p>` : ''}
      </section>`).join('')}</div>
    </details>` : '<small class="evidence-empty">没有可显示的已验证原始证据</small>';
    return `<article class="intervention">
      <div><strong>${escapeHtml(item.projectId)}</strong><small>${escapeHtml(item.status)} · ${new Date(item.createdAt).toLocaleString()}</small></div>
      <div class="intervention-copy">
        <p>${escapeHtml(item.promptText.slice(0, 360))}${item.promptText.length > 360 ? '…' : ''}</p>
        ${evidenceDetails}
      </div>
      <div class="intervention-actions">
        <button class="compact" data-send-intervention="${item.id}">发送重锚</button>
        <button class="secondary compact" data-dismiss-intervention="${item.id}">忽略</button>
      </div>
    </article>`;
  }).join('');
  const sessions = snapshot.sessions?.items || [];
  $('#observed-sessions').innerHTML = sessions.length ? sessions.map((session) => `
    <article class="session-row">
      <b>PID ${escapeHtml(session.pid)}</b>
      <span>
        <strong>${escapeHtml(session.projectId || session.controlId || session.mappingStatus)}</strong>
        <small>${escapeHtml(session.cwd || session.cwdReason || 'cwd 不可读')}</small>
      </span>
      <code title="${escapeHtml(session.command)}">${escapeHtml(session.pane?.target || '无 tmux pane')}</code>
    </article>`).join('') : '<div class="empty">未发现运行中的 Claude Code 主进程</div>';
  $('#findings').innerHTML = groupedFindings.length ? groupedFindings.map((item) => `
    <article class="finding">
      <b class="severity-${escapeHtml(item.severity)}">${escapeHtml(item.severity.toUpperCase())}${item.count > 1 ? ` ×${item.count}` : ''}</b>
      <span><strong>${escapeHtml(item.drift_type)}</strong> · ${escapeHtml(item.message)}
        <small>${item.projects.length ? `${escapeHtml([...new Set(item.projects)].join('、'))} · ` : ''}${escapeHtml(item.reanchor_requirement)}</small>
      </span>
      <code title="${escapeHtml(JSON.stringify(item.evidence))}">${escapeHtml(item.rule)}</code>
    </article>`).join('') : '<div class="empty">未发现规则漂移</div>';
  $('#history').innerHTML = history.slice(0, 6).map((item) => `
    <article class="history-row">
      <b>#${item.id}</b>
      <span>${new Date(item.collectedAt).toLocaleString()}</span>
      <code title="${escapeHtml(item.evidenceHash)}">${escapeHtml(item.evidenceHash.slice(0, 20))}…</code>
    </article>`).join('');
  bindDashboardActions();
}

async function refresh(scanResult) {
  const [
    history,
    semanticAudits,
    interventions,
    gpuQueue,
    automationEvents,
    policies,
    professorStatus,
    projectProgress,
  ] = await Promise.all([
    request('/api/scans'),
    request('/api/semantic-audits?limit=100'),
    request('/api/interventions?limit=100'),
    request('/api/jobs'),
    request('/api/automation-events?limit=200'),
    request('/api/automation-policies'),
    request('/api/professor-status'),
    request('/api/project-progress'),
  ]);
  if (!history.length && !scanResult) return;
  const scan = scanResult || await request(`/api/scans/${history[0].id}`);
  const latestSemantic = semanticAudits.filter((item, index, all) => (
    all.findIndex((candidate) => candidate.projectId === item.projectId) === index
  ));
  automationPolicies = policies;
  lastRenderPayload = [
    scan, history, latestSemantic, interventions, gpuQueue, automationEvents, policies,
    professorStatus, projectProgress,
  ];
  render(...lastRenderPayload);
}

async function refreshDashboardResilient() {
  if (dashboardRefreshPromise) return dashboardRefreshPromise;
  dashboardRefreshPromise = refresh()
    .then(() => {
      const updated = $('#updated');
      if (updated?.textContent?.startsWith('载入失败：')) updated.textContent = '连接已恢复';
    })
    .catch((error) => {
      $('#updated').textContent = `载入失败：${error.message} · 正在自动重试`;
    })
    .finally(() => { dashboardRefreshPromise = null; });
  return dashboardRefreshPromise;
}

$('#scan').addEventListener('click', async (event) => {
  event.currentTarget.disabled = true;
  event.currentTarget.textContent = '扫描中…';
  try {
    const result = await request('/api/scan', { method: 'POST' });
    await refresh(result);
  } catch (error) {
    $('#updated').textContent = `扫描失败：${error.message}`;
  } finally {
    event.currentTarget.disabled = false;
    event.currentTarget.textContent = '刷新状态';
  }
});

$('#toggle-idle').addEventListener('click', () => {
  showIdleProjects = !showIdleProjects;
  if (lastRenderPayload) render(...lastRenderPayload);
});

$('#automation-cycle').addEventListener('click', async (event) => {
  event.currentTarget.disabled = true;
  event.currentTarget.textContent = '同步中…';
  try {
    await request('/api/automation-cycle', jsonOptions({}));
    await refresh();
  } catch (error) {
    $('#session-status').textContent = `GPU 队列同步失败：${error.message}`;
  } finally {
    event.currentTarget.disabled = false;
    event.currentTarget.textContent = '同步 GPU 队列';
  }
});

$('#semantic-scan').addEventListener('click', async (event) => {
  event.currentTarget.disabled = true;
  event.currentTarget.textContent = 'Codex 巡检中…';
  try {
    await request('/api/semantic-audit', jsonOptions({}));
    await refresh();
  } catch (error) {
    $('#session-status').textContent = `Codex 巡检失败：${error.message}`;
  } finally {
    event.currentTarget.disabled = false;
    event.currentTarget.textContent = 'Codex 巡检';
  }
});

refreshDashboardResilient();
const terminal = new window.Terminal({
  cursorBlink: true,
  convertEol: false,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 13,
  theme: { background: '#050907', foreground: '#c8fbe4', cursor: '#67e8b2' },
  scrollback: 10000,
});
const fitAddon = new window.FitAddon.FitAddon();
terminal.loadAddon(fitAddon);
terminal.open($('#terminal'));
fitAddon.fit();

function socketSend(message) {
  if (terminalSocket?.readyState === WebSocket.OPEN) {
    terminalSocket.send(JSON.stringify(message));
  }
}

terminal.onData((data) => {
  if (selectedSession()?.status === 'RUNNING' || selectedSession()?.status === 'WAITING_INPUT') {
    socketSend({ type: 'input', data });
  }
});

function resizeTerminal() {
  fitAddon.fit();
  $('#terminal-cols').value = terminal.cols;
  $('#terminal-rows').value = terminal.rows;
  if (selectedSession()?.capabilities?.resize) {
    socketSend({ type: 'resize', cols: terminal.cols, rows: terminal.rows });
  }
}
window.addEventListener('resize', resizeTerminal);

function selectedSession() {
  return managedSessions.find((session) => session.id === selectedSessionId);
}

function renderManagedSessions() {
  $('#managed-sessions').innerHTML = managedSessions.length ? managedSessions.map((session) => `
    <button class="managed-session${session.id === selectedSessionId ? ' active' : ''}" data-session-id="${escapeHtml(session.id)}"
      title="${escapeHtml(`${session.backend} · ${session.id}`)}">
      <strong>${escapeHtml(session.projectName)}</strong>
      <small>${escapeHtml(session.bootstrapNeedsRetry ? 'AUTH REQUIRED' : session.status)} · Prompt ${escapeHtml(session.bootstrapStatus)} · PID ${escapeHtml(session.pid)} · ${new Date(session.createdAt).toLocaleTimeString()}</small>
    </button>`).join('') : '<div class="empty">尚未启动托管 session</div>';
  const selected = selectedSession();
  const running = selected?.status === 'RUNNING' || selected?.status === 'WAITING_INPUT';
  $('#terminal-title').textContent = selected
    ? `${selected.projectName} · ${selected.id}`
    : '选择一个 session';
  $('#stop-session').disabled = !running;
  $('#interrupt-session').disabled = !running;
  $('#bootstrap-session').disabled = !running
    || (selected?.bootstrapStatus === 'SENT' && !selected?.bootstrapNeedsRetry);
  $('#bootstrap-session').textContent = selected?.bootstrapNeedsRetry
    ? '登录后重发固定 Prompt' : '发送启动 Prompt';
  document.querySelectorAll('[data-session-id]').forEach((button) => {
    button.addEventListener('click', () => selectSession(button.dataset.sessionId));
  });
}

async function selectSession(id) {
  if (selectedSessionId === id) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  terminalSocket?.close();
  selectedSessionId = id;
  outputCursor = 0;
  reconnectAttempt = 0;
  terminal.reset();
  renderManagedSessions();
  connectTerminal(id);
}

function connectTerminal(id) {
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/terminal`);
  terminalSocket = socket;
  socket.addEventListener('open', () => {
    if (terminalSocket !== socket || selectedSessionId !== id) return;
    reconnectAttempt = 0;
    socket.send(JSON.stringify({ type: 'attach', sessionId: id, offset: outputCursor }));
    resizeTerminal();
    terminal.focus();
    $('#session-status').textContent = `已连接 ${selectedSession()?.projectName || id}`;
  });
  socket.addEventListener('message', (event) => {
    if (terminalSocket !== socket || selectedSessionId !== id) return;
    const message = JSON.parse(event.data);
    if (message.type === 'output') {
      if (message.truncated && outputCursor === 0) {
        terminal.writeln('\x1b[33m[较早输出已从持久缓冲截断]\x1b[0m');
      }
      if (message.data) terminal.write(message.data);
      outputCursor = message.nextCursor;
      const index = managedSessions.findIndex((session) => session.id === message.session.id);
      if (index >= 0) managedSessions[index] = message.session;
      renderManagedSessions();
    } else if (message.type === 'error') {
      $('#session-status').textContent = `终端错误：${message.error.code}: ${message.error.message}`;
    }
  });
  socket.addEventListener('close', () => {
    if (terminalSocket !== socket || selectedSessionId !== id) return;
    terminalSocket = null;
    const session = selectedSession();
    const live = session?.status === 'RUNNING' || session?.status === 'WAITING_INPUT';
    if (!live) {
      $('#session-status').textContent = `终端已断开；session 状态为 ${session?.status || 'unknown'}`;
      return;
    }
    const delay = Math.min(500 * (2 ** reconnectAttempt), 8000);
    reconnectAttempt += 1;
    $('#session-status').textContent = `终端桥接已断开，${delay} ms 后按 offset ${outputCursor} 重连`;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (selectedSessionId === id) connectTerminal(id);
    }, delay);
  });
  socket.addEventListener('error', () => socket.close());
}

async function refreshManagedSessions() {
  managedSessions = (await request('/api/sessions'))
    .filter((session) => sessionTargetIds.has(session.projectId));
  if (selectedSessionId && !selectedSession()) selectedSessionId = null;
  renderManagedSessions();
  if (lastRenderPayload) render(...lastRenderPayload);
}

async function refreshControlStatus(force = false) {
  const status = await request(`/api/control-status${force ? '?refresh=1' : ''}`);
  renderControlStatus(status);
}

async function loadSessionControls() {
  const targets = await request('/api/session-targets');
  sessionTargetIds = new Set(targets.map((target) => target.id));
  const research = targets.filter((target) => target.kind === 'research');
  const controls = targets.filter((target) => target.kind !== 'research');
  $('#project-select').innerHTML = [
    `<optgroup label="Research">${research.map((target) => (
      `<option value="${escapeHtml(target.id)}">${escapeHtml(target.name)}</option>`
    )).join('')}</optgroup>`,
    controls.length ? `<optgroup label="Control">${controls.map((target) => (
      `<option value="${escapeHtml(target.id)}">${escapeHtml(target.name)}</option>`
    )).join('')}</optgroup>` : '',
  ].join('');
  await refreshManagedSessions();
}

async function startProject(projectId, button = null) {
  if (button) button.disabled = true;
  try {
    const session = await request('/api/sessions', jsonOptions({
      projectId,
      cols: Number($('#terminal-cols').value),
      rows: Number($('#terminal-rows').value),
      bootstrap: true,
    }));
    await refreshManagedSessions();
    await selectSession(session.id);
    $('#session-status').textContent = `已启动 ${session.projectName}；等待 Claude ready 后自动发送启动 Prompt`;
  } catch (error) {
    $('#session-status').textContent = `启动失败：${error.message}`;
  } finally {
    if (button) button.disabled = false;
  }
}

$('#start-session').addEventListener('click', async (event) => {
  await startProject($('#project-select').value, event.currentTarget);
});

$('#bootstrap-session').addEventListener('click', async () => {
  if (!selectedSessionId) return;
  try {
    await request(`/api/sessions/${selectedSessionId}/bootstrap`, jsonOptions({}));
    await refreshManagedSessions();
    $('#session-status').textContent = '启动 prompt 已发送';
  } catch (error) {
    $('#session-status').textContent = `发送失败：${error.message}`;
  }
});

$('#interrupt-session').addEventListener('click', async () => {
  if (!selectedSessionId) return;
  try {
    await request(`/api/sessions/${selectedSessionId}/interrupt`, jsonOptions({}));
    $('#session-status').textContent = '已发送 Ctrl+C；session 保持运行';
  } catch (error) {
    $('#session-status').textContent = `中断失败：${error.message}`;
  }
});

$('#stop-session').addEventListener('click', async () => {
  if (!selectedSessionId) return;
  if (!confirm('停止会向 Claude 进程发送 SIGTERM。确定停止这个 session？')) return;
  try {
    socketSend({ type: 'stop' });
    $('#session-status').textContent = '停止信号已发送';
  } catch (error) {
    $('#session-status').textContent = `停止失败：${error.message}`;
  }
});

loadSessionControls().catch((error) => {
  $('#session-status').textContent = `托管面载入失败：${error.message}`;
});
refreshExternalSessionStatus().catch((error) => {
  $('#session-status').textContent = `外部会话状态读取失败：${error.message}`;
});
refreshControlStatus(true).catch((error) => {
  if ($('#scheduler-activity')) {
    $('#scheduler-activity').textContent = `Scheduler 动作读取失败：${error.message}`;
  }
});
setInterval(() => {
  refreshManagedSessions().catch((error) => {
    $('#session-status').textContent = `刷新失败：${error.message}`;
  });
}, 5000);
setInterval(() => {
  refreshControlStatus(true).catch((error) => {
    if ($('#scheduler-activity')) {
      $('#scheduler-activity').textContent = `Scheduler 动作读取失败：${error.message}`;
    }
  });
}, 15000);
setInterval(() => {
  refreshExternalSessionStatus().catch((error) => {
    $('#session-status').textContent = `外部会话状态读取失败：${error.message}`;
  });
}, 15000);
setInterval(refreshDashboardResilient, 60000);
window.addEventListener('online', refreshDashboardResilient);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshDashboardResilient();
});
