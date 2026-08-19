import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  AUTHORITY_FILES,
  CodexContinuityResolver,
  decisionPrompt,
  readAuthorityPacket,
} from '../src/continuity-resolver.js';

test('continuity prompt grants routine PI authority without inviting method invention', () => {
  const prompt = decisionPrompt({
    project: { id: 'P' },
    session: {
      terminal: { state: 'WAITING_INPUT', terminalEvidence: 'What should I do next?' },
      heartbeat: { latestAssistantText: 'I finished the readout.' },
    },
    operationalState: 'READY_FOR_INPUT',
    activeJobs: [],
  });
  assert.match(prompt, /AI has normal PI authority for routine research choices/);
  assert.match(prompt, /Do not invent a method, experiment, explanation, paper identity, or new branch/);
  assert.match(prompt, /irreversible or externally consequential actions/);
  assert.match(prompt, /the only project files/);
});

test('continuity evidence is restricted to regular allowlisted authority files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'firm-authority-'));
  try {
    await writeFile(join(directory, 'CLAUDE.md'), '# rules\n');
    await writeFile(join(directory, 'secret.txt'), 'must never leave the host\n');
    await symlink(join(directory, 'secret.txt'), join(directory, 'SEED.md'));
    const packet = await readAuthorityPacket(directory);
    assert.deepEqual(packet.map((item) => item.name), AUTHORITY_FILES);
    assert.equal(packet.find((item) => item.name === 'CLAUDE.md').content, '# rules\n');
    assert.equal(packet.find((item) => item.name === 'SEED.md').status, 'rejected_non_regular_file');
    assert.equal(JSON.stringify(packet).includes('must never leave'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Codex resolver validates one structured continuity decision', async () => {
  let observedPrompt = '';
  let observedCwd = '';
  const resolver = new CodexContinuityResolver({
    executable: '/fixed/codex',
    schemaPath: '/fixed/schema.json',
    timeoutMs: 60_000,
    run: async (_executable, args, options) => {
      observedPrompt = options.input;
      observedCwd = options.cwd;
      const outputPath = args[args.indexOf('--output-last-message') + 1];
      await writeFile(outputPath, JSON.stringify({
        action: 'continue',
        message: 'Resume from the authoritative live state and complete the current episode.',
        reason: 'No active work remains and the research package is incomplete.',
        optionNumber: null,
      }));
      return { stdout: '', stderr: '' };
    },
  });
  const decision = await resolver.resolve({
    project: { id: 'P', path: process.cwd() },
    session: { terminal: { state: 'WAITING_INPUT' }, heartbeat: {} },
    operationalState: 'READY_FOR_INPUT', activeJobs: [],
  });
  assert.equal(decision.action, 'continue');
  assert.match(decision.message, /authoritative live state/);
  assert.match(observedPrompt, /"projectId": "P"/);
  assert.notEqual(observedCwd, process.cwd());
  assert.equal(observedPrompt.includes(process.cwd()), false);
});
