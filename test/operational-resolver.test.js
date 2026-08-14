import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildOperationalPacket,
  groundOperationalResolution,
  renderOperationalResolverPrompt,
} from '../src/operational-resolver.js';

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
  }, packet);
  assert.equal(result.shouldSend, true);
  assert.equal(result.grounding.eligible, true);
  assert.match(result.message, /paired utility check/);

  const prompt = renderOperationalResolverPrompt(packet);
  assert.match(prompt, /不要把它塞进预设状态或错误类别/);
  assert.match(prompt, /send=true/);
  assert.doesNotMatch(prompt, /RETRY_SAME_ACTION|HUMAN_BOUNDARY|HEALTHY_WAIT/);
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
  }, packet);
  assert.equal(result.grounding.eligible, false);
});
