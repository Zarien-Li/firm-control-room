import assert from 'node:assert/strict';
import test from 'node:test';
import { parseResearchMaturity } from '../src/research-maturity.js';

function status(overrides = {}) {
  const fields = {
    scientific_stage: 'realization',
    claim_stage: 'comparison-pending',
    current_construction: 'method-v1',
    episode_type: 'exploration',
    decisive_rival: 'strong-rival',
    rival_health: 'unresolved',
    utility_status: 'partial',
    paper_stage: 'entry-hold',
    claim_blocker: 'matched rival comparison',
    ...overrides,
  };
  return `<!-- FIRM_RESEARCH_STATUS\n${Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`).join('\n')}\n-->`;
}

test('an exploration realization may coexist with an unresolved rival', () => {
  const result = parseResearchMaturity(status());
  assert.equal(result.status, 'ok');
  assert.equal(result.fields.scientific_stage, 'realization');
  assert.equal(result.fields.claim_stage, 'comparison-pending');
});

test('paper entry cannot be declared before claim, rival, and utility mature', () => {
  const result = parseResearchMaturity(status({ paper_stage: 'entry-ready' }));
  assert.equal(result.status, 'contradictory');
  assert.ok(result.issues.some((item) => item.code === 'entry-ready-contradiction'));
});

test('a paper-bearing package with a healthy rival and complete utility is consistent', () => {
  const result = parseResearchMaturity(status({
    scientific_stage: 'paper-bearing',
    claim_stage: 'claim-bearing',
    episode_type: 'claim-bearing',
    rival_health: 'healthy',
    utility_status: 'complete',
    paper_stage: 'entry-ready',
    claim_blocker: 'none',
  }));
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.issues, []);
});

test('missing blocks are observable without inventing maturity', () => {
  assert.deepEqual(parseResearchMaturity('# ordinary state'), {
    status: 'missing', fields: null, issues: [],
  });
});

