const PENDING_PATTERN = /pending|awaiting|待确认|待锁定/i;
const GPU_PATTERNS = [
  /CUDA_VISIBLE_DEVICES\s*=\s*["']?([0-9,\s]+)/gi,
  /--(?:gpu|gpu-id|gpu_id|device)\s*[= ]\s*(?:cuda:)?(\d+)/gi,
];
const OPERATION_PATTERN = /\b(?:tmux\s+kill-(?:session|server)|killall|pkill\s+-9|rm\s+-rf)\b/i;

function finding(rule, severity, driftType, projectId, message, evidence, requirement) {
  return {
    rule,
    severity,
    drift_type: driftType,
    projectId,
    message,
    evidence,
    reanchor_requirement: requirement,
  };
}

function add(findings, ...args) {
  findings.push(finding(...args));
}

function extractGpuIds(text) {
  const ids = new Set();
  for (const pattern of GPU_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      for (const value of match[1].split(',')) {
        const id = Number(value.trim());
        if (Number.isInteger(id)) ids.add(id);
      }
    }
  }
  return [...ids].sort((a, b) => a - b);
}

export function auditSnapshot(snapshot, now = new Date()) {
  const findings = [];
  const gpuClaims = new Map();
  const sessions = snapshot.sessions || { status: 'degraded', items: [] };

  if (sessions.status !== 'ok') {
    add(findings, 'SESSION_DISCOVERY_UNAVAILABLE', 'high', 'operation', null,
      '无法通过 ps 发现 Claude Code 主进程',
      { source: 'ps', status: sessions.status, reason: sessions.reason },
      '恢复 ps 只读访问后重新扫描；不得用 tmux pane 代替全局进程发现');
  }
  for (const session of sessions.items || []) {
    const evidence = {
      source: `process:${session.pid}`,
      pid: session.pid,
      ppid: session.ppid,
      cwd: session.cwd,
      cwdStatus: session.cwdStatus,
      command: session.command,
    };
    if (session.mappingStatus === 'unmapped') {
      add(findings, 'CLAUDE_SESSION_UNMAPPED', 'medium', 'scope', null,
        '运行中的 Claude Code session 未映射到任何项目',
        { ...evidence, cwdReason: session.cwdReason },
        '为该 cwd 配置项目 path/sessionPathAliases，或确认其应保持未映射');
    } else if (session.mappingStatus === 'ambiguous') {
      add(findings, 'CLAUDE_SESSION_DUPLICATE_MAPPING', 'high', 'identity', null,
        'Claude Code session 的最长路径前缀同时映射到多个项目',
        { ...evidence, matches: session.matches },
        '消除重复的 path/sessionPathAliases 最长前缀，使 session 唯一归属');
    } else if (session.locationDrift) {
      add(findings, 'CLAUDE_SESSION_LOCATION_DRIFT', 'medium', 'scope', session.projectId,
        'Claude Code session 通过别名映射，但 cwd 已偏离项目规范路径',
        {
          ...evidence,
          projectId: session.projectId,
          matchedPath: session.matchedPath,
          matchSource: session.matchSource,
        },
        '确认别名仍获授权，或将 session 迁回项目 path 并重新扫描');
    }
  }

  for (const project of snapshot.projects) {
    const { expected = {}, identity, files = [], tmux = {} } = project;
    const maturity = project.researchMaturity;
    if (maturity?.status === 'missing') {
      add(findings, 'RESEARCH_MATURITY_STATUS_MISSING', 'info', 'evidence', project.id,
        '权威 live state 尚未提供双轨成熟度摘要',
        { source: 'PIPELINE_STATE.md', maturityStatus: maturity.status },
        '在下一次 consequential transition 写入 FIRM_RESEARCH_STATUS；无需中断当前原子动作');
    }
    for (const issue of maturity?.issues || []) {
      add(findings, 'RESEARCH_MATURITY_INCONSISTENT', 'medium', 'evidence', project.id,
        `研究成熟度描述不一致：${issue.message}`,
        {
          source: 'PIPELINE_STATE.md',
          maturityStatus: maturity.status,
          issue,
          fields: maturity.fields,
        },
        '依据原始证据修正描述字段；FIRM 不改变科学结论或研究路线');
    }
    for (const file of files) {
      if (file.status !== 'ok') {
        const identityFile = file.name === 'PROJECT_IDENTITY.json';
        add(
          findings,
          identityFile ? 'IDENTITY_FILE_MISSING' : 'REQUIRED_FILE_MISSING',
          identityFile ? 'critical' : 'high',
          identityFile ? 'identity' : 'evidence',
          project.id,
          `必需证据文件 ${file.name} 缺失或不可读`,
          { source: file.name, status: file.status, reason: file.reason, sha256: file.sha256 },
          `恢复 ${file.name}，并以只读扫描重新锚定其 SHA-256`,
        );
      } else if (!file.sha256 || !Number.isInteger(file.bytes)) {
        add(findings, 'EVIDENCE_HASH_MISSING', 'high', 'evidence', project.id,
          `${file.name} 缺少可验证哈希`, { source: file.name, sha256: file.sha256 },
          `重新采集 ${file.name} 的内容、字节数和 SHA-256`);
      }
    }

    if (identity.status === 'degraded') {
      add(findings, 'IDENTITY_JSON_INVALID', 'critical', 'identity', project.id,
        'PROJECT_IDENTITY.json 无法解析', { reason: identity.reason, detail: identity.detail },
        '修复身份 JSON 语法后重新扫描');
    } else if (identity.status === 'ok') {
      if (expected.identityPrefix
          && (!identity.projectId
            || !String(identity.projectId).startsWith(expected.identityPrefix))) {
        add(findings, 'IDENTITY_PROJECT_MISMATCH', 'critical', 'identity', project.id,
          '项目身份与配置槽位不一致',
          { expectedPrefix: expected.identityPrefix, actualProjectId: identity.projectId },
          '恢复配置槽位对应的 PROJECT_IDENTITY.project_id');
      }
      if (PENDING_PATTERN.test(String(identity.identityVersion))
          || PENDING_PATTERN.test(String(identity.currentStatus))) {
        add(findings, 'IDENTITY_PENDING_LOCK', 'high', 'identity', project.id,
          '身份仍处于 pending lock，不能视为已锁定',
          {
            identityVersion: identity.identityVersion,
            currentStatus: identity.currentStatus,
            source: 'PROJECT_IDENTITY.json',
          },
          '取得明确用户锁定并更新 identity_version/current.status；审计器不代替用户裁决');
      }
    }

    for (const file of files.filter((item) => item.status === 'ok')) {
      const foreign = [...new Set(String(file.content).match(/\b(?:ACL|ICLR|ICASSP)_\d+\b/gi) || [])]
        .filter((label) => label.toUpperCase() !== project.id.toUpperCase());
      if (foreign.length) {
        add(findings, 'CROSS_PROJECT_SCOPE_REFERENCE', 'medium', 'scope', project.id,
          `${file.name} 出现其他锁定项目标识`,
          { source: file.name, sha256: file.sha256, foreignProjectLabels: foreign },
          '确认该跨项目引用具有明确操作授权，否则恢复为本项目身份边界');
      }
    }

    if (!tmux.available) {
      add(findings, 'TMUX_EVIDENCE_UNAVAILABLE', 'info', 'evidence', project.id,
        'tmux pane 尾部不可用，操作证据不完整',
        { source: 'tmux', reason: tmux.reason, panes: 0 },
        'tmux 可用时重新扫描；不要据此推断科学结论');
    }
    for (const pane of tmux.panes || []) {
      const paneEvidence = {
        source: `tmux:${pane.target}`,
        session: pane.session,
        cwd: pane.cwd,
        tailSha256: pane.tailSha256,
      };
      if (pane.status !== 'ok' || !pane.tailSha256) {
        add(findings, 'TMUX_PANE_EVIDENCE_INCOMPLETE', 'medium', 'evidence', project.id,
          '关联 pane 尾部采集不完整', paneEvidence, '恢复 pane 可读性并重新采集尾部哈希');
        continue;
      }
      if (expected.sessionContains
          && !String(pane.session).toLowerCase().includes(String(expected.sessionContains).toLowerCase())) {
        add(findings, 'SESSION_IDENTITY_DRIFT', 'high', 'operation', project.id,
          'pane 所属 session 与项目槽位不一致', paneEvidence,
          `将操作迁回包含 ${expected.sessionContains} 的明确 session，或记录授权映射`);
      }
      if (OPERATION_PATTERN.test(pane.tail || '')) {
        add(findings, 'DESTRUCTIVE_OPERATION_OBSERVED', 'critical', 'operation', project.id,
          'pane 尾部出现破坏性操作信号', paneEvidence,
          '停止自动操作，由人工确认目标与授权后再继续');
      }
      const gpuIds = extractGpuIds(pane.tail || '');
      for (const gpuId of gpuIds) {
        if (!gpuClaims.has(gpuId)) gpuClaims.set(gpuId, []);
        gpuClaims.get(gpuId).push({ projectId: project.id, evidence: paneEvidence });
      }
      if (Array.isArray(expected.allowedGpus)) {
        const unexpected = gpuIds.filter((id) => !expected.allowedGpus.includes(id));
        if (unexpected.length) {
          add(findings, 'GPU_ASSIGNMENT_DRIFT', 'high', 'compute', project.id,
            'pane 中观察到未授权 GPU 指派',
            { ...paneEvidence, observedGpuIds: gpuIds, allowedGpuIds: expected.allowedGpus },
            '停止该 GPU 操作并按已授权设备重新锚定');
        }
      }
    }
  }

  for (const [gpuId, claims] of gpuClaims) {
    const projects = [...new Set(claims.map((claim) => claim.projectId))];
    if (projects.length > 1) {
      add(findings, 'GPU_CROSS_PROJECT_COLLISION', 'high', 'compute', null,
        `多个项目 pane 同时声明 GPU ${gpuId}`,
        { gpuId, projects, paneHashes: claims.map((claim) => claim.evidence.tailSha256) },
        '人工核对调度授权与实际进程；本审计不终止任务也不裁决实验价值');
    }
  }

  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const item of findings) counts[item.severity] += 1;
  const verdict = counts.critical > 0 ? 'INTERVENE'
    : counts.high + counts.medium + counts.low > 0 ? 'WARN' : 'PASS';
  const completeFiles = snapshot.projects.flatMap((project) => project.files || [])
    .filter((file) => file.status === 'ok' && file.sha256).length;
  const expectedFiles = snapshot.projects.reduce(
    (total, project) => total + (project.files || []).length,
    0,
  );
  const evidenceCompleteness = Number(Math.max(0, Math.min(1,
    (expectedFiles ? 0.9 * completeFiles / expectedFiles : 0)
      + (sessions.status === 'ok' ? 0.1 : 0),
  )).toFixed(2));

  return {
    schemaVersion: 3,
    auditedAt: now.toISOString(),
    snapshotCollectedAt: snapshot.collectedAt,
    mode: 'shadow-read-only',
    autoCorrection: false,
    scientificAdjudication: false,
    verdict,
    drift_type: [...new Set(findings.map((item) => item.drift_type))],
    evidence: findings.map((item) => ({ rule: item.rule, projectId: item.projectId, ...item.evidence })),
    reanchor_requirements: [...new Set(findings.map((item) => item.reanchor_requirement))],
    confidence: null,
    evidenceCompleteness,
    counts,
    findingCount: findings.length,
    pass: verdict === 'PASS',
    findings,
  };
}
