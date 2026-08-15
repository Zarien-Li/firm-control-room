import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildOperationalPacket,
  extractResearchAuthority,
  groundOperationalResolution,
  renderOperationalResolverPrompt,
} from '../src/operational-resolver.js';

test('operational resolver schema uses only Codex-supported structured-output keywords', async () => {
  const schema = JSON.parse(await readFile(new URL('../config/operational-resolver.schema.json', import.meta.url)));
  assert.equal(JSON.stringify(schema).includes('uniqueItems'), false);
});

test('session resolver gives Codex free response authority in a minimal machine envelope', () => {
  const packet = buildOperationalPacket(
    { id: 'ACL_1', name: 'ACL_1' },
    {
      terminal: {
        state: 'WAITING_INPUT',
        terminalEvidence: 'The baseline is complete. Should I run the paired utility check?',
      },
      heartbeat: {
        latestAssistantText: 'The baseline is complete. Should I run the paired utility check?',
      },
    },
    [],
  );
  const result = groundOperationalResolution({
    send: true,
    message: '运行 paired utility check，保留配对原始证据。',
    confidence: 0.93,
    evidence_source: 'session:latest-assistant',
    evidence_quote: 'Should I run the paired utility check?',
    rationale: 'This completes the current evidence bundle.',
    recheck_after_seconds: 0,
    state_reconciliation: '',
    fulfilled_reconciliation_keys: [],
  }, packet);
  assert.equal(result.shouldSend, true);
  assert.equal(result.grounding.eligible, true);
  assert.match(result.message, /paired utility check/);

  const prompt = renderOperationalResolverPrompt(packet);
  assert.match(prompt, /只区分研究自治域与外部授权域/);
  assert.match(prompt, /send=true/);
  assert.match(prompt, /不要区分“AI 决策”和“人类研究决策”/);
  assert.match(prompt, /都属于研究自治域/);
  assert.match(prompt, /researcher-decided active 或 researcher-decided deferred/);
  assert.match(prompt, /reconciliationObligations/);
  assert.doesNotMatch(prompt, /RETRY_SAME_ACTION|HUMAN_BOUNDARY|HEALTHY_WAIT/);
});

test('research authority is extracted only from the marked owner policy block', () => {
  const authority = extractResearchAuthority(`before\n<!-- FIRM_RESEARCH_AUTHORITY_BEGIN v1 -->\nResearch is autonomous.\n<!-- FIRM_RESEARCH_AUTHORITY_END -->\nafter`);
  assert.equal(authority.source, 'CLAUDE.md');
  assert.equal(authority.text, 'Research is autonomous.');
  assert.match(authority.sha256, /^[a-f0-9]{64}$/);
  assert.equal(extractResearchAuthority('unmarked'), null);
});

test('session resolver rejects ungrounded intervention text', () => {
  const packet = {
    evidence: [{ id: 'session:latest-assistant', text: 'The run completed normally.' }],
  };
  const result = groundOperationalResolution({
    send: true,
    message: 'Start an unrelated method.',
    confidence: 0.99,
    evidence_source: 'session:latest-assistant',
    evidence_quote: 'The provider crashed.',
    rationale: 'Fabricated premise.',
    recheck_after_seconds: 0,
    state_reconciliation: '',
    fulfilled_reconciliation_keys: [],
  }, packet);
  assert.equal(result.grounding.eligible, false);
});

test('session resolver survives terminal wrapping when history contains the exact quote', () => {
  const packet = {
    evidence: [
      { id: 'terminal:current-episode', text: 'API Error: 529 [abc\n123]. Try again.' },
      { id: 'session:latest-assistant', text: 'API Error: 529 [abc123]. Try again.' },
    ],
  };
  const result = groundOperationalResolution({
    send: true,
    message: 'Resume the interrupted action.',
    confidence: 0.99,
    evidence_source: 'terminal:current-episode',
    evidence_quote: 'API Error: 529 [abc123]. Try again.',
    rationale: 'The terminal wrapped a token but history retained it.',
    recheck_after_seconds: 60,
    state_reconciliation: '',
    fulfilled_reconciliation_keys: [],
  }, packet);
  assert.equal(result.grounding.eligible, true);
  assert.equal(result.evidenceSource, 'session:latest-assistant');
});

test('session resolver carries and grounds persistent state-reconciliation obligations', () => {
  const packet = buildOperationalPacket(
    { id: 'ACL_8', name: 'ACL_8' },
    {
      terminal: { state: 'WAITING_INPUT', terminalEvidence: 'Task #53 is AI-decided deferred.' },
      heartbeat: { latestAssistantText: 'I rewrote the live state and Task #53 as AI-decided deferred.' },
    },
    [],
    [{ key: 'reconcile:53', expectation: 'Remove the false USER gate from Task #53.' }],
  );
  const result = groundOperationalResolution({
    send: false,
    message: '',
    confidence: 0.98,
    evidence_source: 'session:latest-assistant',
    evidence_quote: 'Task #53 as AI-decided deferred',
    rationale: 'The authoritative state rewrite is explicitly confirmed.',
    recheck_after_seconds: 0,
    state_reconciliation: '',
    fulfilled_reconciliation_keys: ['reconcile:53', 'invented:key'],
  }, packet);
  assert.deepEqual(result.fulfilledReconciliationKeys, ['reconcile:53']);
  assert.equal(result.grounding.eligible, true);
});

test('session resolver cannot silently ignore an outstanding state reconciliation', () => {
  const packet = buildOperationalPacket(
    { id: 'ACL_8', name: 'ACL_8' },
    {
      terminal: { state: 'WAITING_INPUT', terminalEvidence: 'Task #53 still awaits the user.' },
      heartbeat: { latestAssistantText: 'Task #53 still awaits the user.' },
    },
    [],
    [{ key: 'reconcile:53', expectation: 'Relabel Task #53 as AI-decided deferred.' }],
  );
  const result = groundOperationalResolution({
    send: false,
    message: '',
    confidence: 0.99,
    evidence_source: 'session:latest-assistant',
    evidence_quote: 'Task #53 still awaits the user',
    rationale: 'Remain silent.',
    recheck_after_seconds: 0,
    state_reconciliation: '',
    fulfilled_reconciliation_keys: [],
  }, packet);
  assert.deepEqual(result.unresolvedReconciliationKeys, ['reconcile:53']);
  assert.equal(result.grounding.eligible, false);
});
