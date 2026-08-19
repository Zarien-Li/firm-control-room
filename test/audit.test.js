import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { auditSnapshot } from '../src/audit.js';

const cases = JSON.parse(await readFile(new URL('./fixtures/drift-cases.json', import.meta.url), 'utf8'));

function baseline() {
  const files = [
    {
      name: 'PROJECT_IDENTITY.json',
      status: 'ok',
      bytes: 100,
      sha256: 'a'.repeat(64),
      content: '{"project_id":"acl_1-method","identity_version":"arena-locked"}',
    },
    {
      name: 'PIPELINE_STATE.md', status: 'ok', bytes: 20, sha256: 'b'.repeat(64),
      content: '# Pipeline\nlocked',
    },
    {
      name: 'CLAUDE.md', status: 'ok', bytes: 20, sha256: 'c'.repeat(64),
      content: '# ACL project policy\n<!-- FIRM_RESEARCH_AUTHORITY_BEGIN v2 -->\nFIRM is operations only.',
    },
    {
      name: 'prompt.txt', status: 'ok', bytes: 20, sha256: 'd'.repeat(64),
      content: 'Continue the locked project.',
    },
  ];
  return {
    schemaVersion: 3,
    collectedAt: '2026-01-01T00:00:00.000Z',
    sessions: { status: 'ok', total: 0, mapped: 0, unmapped: 0, ambiguous: 0, items: [] },
    projects: [{
      id: 'ACL_1',
      name: 'ACL_1',
      expected: { identityPrefix: 'acl_1-', sessionContains: 'ACL_1' },
      identity: {
        status: 'ok',
        projectId: 'acl_1-method',
        identityVersion: 'arena-locked',
        currentStatus: 'locked',
      },
      files,
      tmux: { status: 'ok', available: true, panes: [] },
    }],
  };
}

function pane(overrides = {}) {
  return {
    status: 'ok',
    target: '%1',
    session: 'ACL_1-run',
    cwd: '/arena_locked/ACL_1',
    tail: 'training on cpu',
    tailSha256: 'e'.repeat(64),
    ...overrides,
  };
}

function addSecondProject(snapshot, tail) {
  const copy = structuredClone(snapshot.projects[0]);
  copy.id = 'ACL_4';
  copy.name = 'ACL_4';
  copy.expected = { identityPrefix: 'acl_4-', sessionContains: 'ACL_4' };
  copy.identity.projectId = 'acl_4-method';
  copy.files[0].content = '{"project_id":"acl_4-method","identity_version":"arena-locked"}';
  copy.tmux.panes = [pane({
    target: '%4', session: 'ACL_4-run', cwd: '/arena_locked/ACL_4',
    tail, tailSha256: 'f'.repeat(64),
  })];
  snapshot.projects.push(copy);
}

function applyMutation(snapshot, mutation) {
  const project = snapshot.projects[0];
  switch (mutation) {
    case 'identity-file-missing':
      project.files[0] = {
        name: 'PROJECT_IDENTITY.json', status: 'missing', reason: 'file_missing',
        bytes: null, sha256: null, content: null,
      };
      project.identity = { status: 'unavailable', configuredPath: '/missing' };
      break;
    case 'pipeline-file-missing':
      project.files[1] = {
        name: 'PIPELINE_STATE.md', status: 'missing', reason: 'file_missing',
        bytes: null, sha256: null, content: null,
      };
      break;
    case 'identity-json-invalid':
      project.identity = { status: 'degraded', reason: 'invalid_identity_json', detail: 'bad token' };
      break;
    case 'identity-project-mismatch':
      project.identity.projectId = 'acl_4-method';
      break;
    case 'pending-lock':
      project.identity.identityVersion = 'arena-lock-pending-user-confirmation';
      project.identity.currentStatus = 'pending_verbatim_user_lock';
      break;
    case 'cross-project-reference':
      project.files[2].content = 'Operate ACL_4 from this project.';
      break;
    case 'session-drift':
      project.tmux.panes = [pane({ session: 'misc-run' })];
      break;
    case 'gpu-assignment-drift':
      project.expected.allowedGpus = [0];
      project.tmux.panes = [pane({ tail: 'CUDA_VISIBLE_DEVICES=3 python train.py' })];
      break;
    case 'gpu-collision':
      project.tmux.panes = [pane({ tail: 'CUDA_VISIBLE_DEVICES=2 python train.py' })];
      addSecondProject(snapshot, 'python train.py --device cuda:2');
      break;
    case 'pane-evidence-incomplete':
      project.tmux.panes = [pane({
        status: 'degraded', tail: null, tailSha256: null, reason: 'pane_capture_failed',
      })];
      break;
    default:
      throw new Error(`Unknown mutation: ${mutation}`);
  }
  return snapshot;
}

test('fixture contains exactly ten synthetic drift cases', () => {
  assert.equal(cases.length, 10);
  assert.equal(new Set(cases.map((item) => item.id)).size, 10);
});

for (const drift of cases) {
  test(`${drift.id}: ${drift.name}`, () => {
    const audit = auditSnapshot(applyMutation(baseline(), drift.mutation));
    assert.ok(
      audit.findings.some((finding) => finding.rule === drift.expectedRule),
      `expected rule ${drift.expectedRule}, got ${audit.findings.map((item) => item.rule).join(', ')}`,
    );
    assert.equal(audit.verdict, drift.expectedVerdict);
    assert.ok(audit.drift_type.includes(drift.expectedType));
    assert.ok(audit.evidence.length > 0);
    assert.ok(audit.reanchor_requirements.length > 0);
    assert.equal(audit.confidence, null);
    assert.ok(audit.evidenceCompleteness >= 0 && audit.evidenceCompleteness <= 1);
    assert.equal(audit.autoCorrection, false);
    assert.equal(audit.mode, 'shadow-read-only');
    assert.equal(audit.scientificAdjudication, false);
  });
}

test('clean evidence produces PASS without scientific adjudication', () => {
  const audit = auditSnapshot(baseline(), new Date('2026-01-01T00:00:01.000Z'));
  assert.equal(audit.verdict, 'PASS');
  assert.deepEqual(audit.drift_type, []);
  assert.equal(audit.scientificAdjudication, false);
});

test('session audit reports unmapped, duplicate mapping, and location drift independently', () => {
  const snapshot = baseline();
  snapshot.sessions.items = [
    {
      pid: 10, ppid: 1, command: 'claude', cwd: '/unknown', cwdStatus: 'ok',
      mappingStatus: 'unmapped', projectId: null,
    },
    {
      pid: 11, ppid: 1, command: 'claude', cwd: '/shared', cwdStatus: 'ok',
      mappingStatus: 'ambiguous', projectId: null,
      matches: [{ projectId: 'ACL_1' }, { projectId: 'ACL_4' }],
    },
    {
      pid: 12, ppid: 1, command: 'claude', cwd: '/alias/ACL_1', cwdStatus: 'ok',
      mappingStatus: 'mapped', projectId: 'ACL_1', matchedPath: '/alias/ACL_1',
      matchSource: 'sessionPathAlias', locationDrift: true,
    },
  ];
  const rules = auditSnapshot(snapshot).findings.map((finding) => finding.rule);
  assert.ok(rules.includes('CLAUDE_SESSION_UNMAPPED'));
  assert.ok(rules.includes('CLAUDE_SESSION_DUPLICATE_MAPPING'));
  assert.ok(rules.includes('CLAUDE_SESSION_LOCATION_DRIFT'));
});

test('legacy FIRM scientific authority is continuously detected', () => {
  const snapshot = baseline();
  snapshot.projects[0].files.find((file) => file.name === 'CLAUDE.md').content =
    'You, project Claude, Codex reviewers, and FIRM act as one autonomous PI team.';
  const audit = auditSnapshot(snapshot);
  assert.ok(audit.findings.some((finding) => finding.rule === 'FIRM_AUTHORITY_BOUNDARY_INVALID'));
  assert.equal(audit.verdict, 'WARN');
});
