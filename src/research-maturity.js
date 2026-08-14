const BLOCK = /<!--\s*FIRM_RESEARCH_STATUS\s*([\s\S]*?)-->/i;

const ENUMS = Object.freeze({
  scientific_stage: new Set(['contact', 'candidate', 'realization', 'paper-bearing']),
  claim_stage: new Set(['exploratory', 'comparison-pending', 'claim-bearing']),
  episode_type: new Set(['none', 'exploration', 'claim-bearing']),
  rival_health: new Set(['none', 'unresolved', 'fragile', 'invalid', 'healthy']),
  utility_status: new Set(['missing', 'partial', 'complete']),
  paper_stage: new Set(['none', 'hypothesis', 'entry-hold', 'entry-ready']),
});

const REQUIRED = Object.freeze([
  'scientific_stage',
  'claim_stage',
  'current_construction',
  'episode_type',
  'decisive_rival',
  'rival_health',
  'utility_status',
  'paper_stage',
  'claim_blocker',
]);

export function parseResearchMaturity(text) {
  const match = String(text || '').match(BLOCK);
  if (!match) return { status: 'missing', fields: null, issues: [] };

  const fields = {};
  for (const rawLine of match[1].split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const field = line.match(/^([a-z_]+):\s*(.*?)\s*$/);
    if (!field) continue;
    fields[field[1]] = field[2];
  }

  const issues = [];
  for (const key of REQUIRED) {
    if (!fields[key]) issues.push(issue('missing-field', `${key} is missing`, key));
  }
  for (const [key, allowed] of Object.entries(ENUMS)) {
    if (fields[key] && !allowed.has(fields[key])) {
      issues.push(issue('invalid-value', `${key} has unsupported value ${fields[key]}`, key));
    }
  }

  const rivalHealthy = fields.rival_health === 'healthy';
  if (fields.claim_stage === 'claim-bearing' && !rivalHealthy) {
    issues.push(issue(
      'claim-without-healthy-rival',
      'claim-bearing status requires a healthy claim-threatening rival',
      'claim_stage',
    ));
  }
  if (fields.scientific_stage === 'paper-bearing') {
    if (fields.claim_stage !== 'claim-bearing') {
      issues.push(issue(
        'paper-object-without-claim',
        'paper-bearing scientific status requires claim-bearing evidence',
        'scientific_stage',
      ));
    }
    if (!rivalHealthy) {
      issues.push(issue(
        'paper-object-without-healthy-rival',
        'paper-bearing scientific status requires a healthy decisive rival',
        'scientific_stage',
      ));
    }
    if (fields.utility_status !== 'complete') {
      issues.push(issue(
        'paper-object-without-utility',
        'paper-bearing scientific status requires complete relevant utility',
        'utility_status',
      ));
    }
  }
  if (fields.paper_stage === 'entry-ready' && (
    fields.scientific_stage !== 'paper-bearing'
    || fields.claim_stage !== 'claim-bearing'
    || !rivalHealthy
    || fields.utility_status !== 'complete'
  )) {
    issues.push(issue(
      'entry-ready-contradiction',
      'entry-ready conflicts with scientific, claim, rival, or utility maturity',
      'paper_stage',
    ));
  }
  if (fields.episode_type === 'claim-bearing'
      && (!fields.decisive_rival || fields.decisive_rival === 'none')) {
    issues.push(issue(
      'claim-episode-without-rival',
      'claim-bearing episode must name its decisive rival',
      'decisive_rival',
    ));
  }

  return {
    status: issues.some((item) => ['missing-field', 'invalid-value'].includes(item.code))
      ? 'invalid' : issues.length ? 'contradictory' : 'ok',
    fields,
    issues,
  };
}

function issue(code, message, field) {
  return { code, message, field };
}

