import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

async function text(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('FIRM separates event-driven continuity from scientific portfolio authority', async () => {
  const [server, engine, config, store, ui, html, env, pkg] = await Promise.all([
    text('src/server.js'),
    text('src/automation-engine.js'),
    text('src/config.js'),
    text('src/store.js'),
    text('public/app.js'),
    text('public/index.html'),
    text('.env.example'),
    text('package.json'),
  ]);
  const activeSurface = [server, engine, config, ui, html, env, pkg].join('\n');

  for (const forbidden of [
    'runCodexSemanticAudit',
    'FIRM_GOAL_LOOP',
    '/api/semantic-audit',
    '/api/interventions',
    '/api/automation-policies',
  ]) {
    assert.equal(activeSurface.includes(forbidden), false, `forbidden authority surface: ${forbidden}`);
  }

  for (const forbiddenExport of [
    'saveSemanticAudit',
    'createIntervention',
    'setIntervention',
    'setAutomationPolicy',
    'recentGoalActions',
  ]) {
    assert.equal(
      new RegExp(`\\n\\s{4}${forbiddenExport}\\(`).test(store),
      false,
      `forbidden store authority export: ${forbiddenExport}`,
    );
  }
});

test('legacy scientific resolver modules remain removed', async () => {
  for (const path of [
    'src/semantic-audit.js',
    'config/codex-audit.schema.json',
  ]) {
    await assert.rejects(access(new URL(path, root)));
  }
});

test('automatic delivery is limited to operational facts and AI continuity decisions', async () => {
  const engine = await text('src/automation-engine.js');
  assert.match(engine, /const AUTO_DELIVERY_TYPES = new Set/);
  assert.match(engine, /CONTINUITY_RESUME_READY/);
  assert.match(engine, /Only allowlisted operational or continuity events can be delivered/);
  assert.doesNotMatch(engine, /category: 'goal_loop'/);
  assert.doesNotMatch(engine, /eventType: 'AI_SESSION_MESSAGE_SENT'/);
});
