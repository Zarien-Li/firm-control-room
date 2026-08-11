import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyItermTail,
  collectItermStatuses,
  sendItermMessage,
  submitItermDraft,
} from '../src/iterm-status.js';

test('iTerm terminal classifier separates work, input, and confirmation', () => {
  assert.equal(classifyItermTail('✽ Advancing CPU baseline prep…\n❯ \n────\n⏵⏵ auto mode on').state, 'WAITING_INPUT');
  assert.equal(classifyItermTail('✢ Preparing baseline\n anchor…\n❯ \n────\n⏵⏵ auto mode on').state, 'WAITING_INPUT');
  assert.equal(classifyItermTail('❯ Press up to edit queued…\n────\n⏵⏵ auto mode on').state, 'WORKING');
  assert.equal(classifyItermTail('✻ Worked for 2m\n────\n❯ \n────\n⏵⏵ auto mode on').state, 'WAITING_INPUT');
  assert.equal(classifyItermTail('This command requires approval\nDo you want to proceed?\n❯ 1. Yes').state, 'CONFIRMATION');
  assert.equal(classifyItermTail('plain output').state, 'UNKNOWN');
});

test('the newest terminal marker wins over stale monitor text', () => {
  const staleMonitorThenPrompt = [
    'Cooked for 11s · 1 monitor still running',
    'monitor event output',
    '❯ 继续等 FIRM 唤醒',
    '────────────────────────',
    '  ⏵⏵ auto mode on',
  ].join('\n');
  assert.deepEqual(classifyItermTail(staleMonitorThenPrompt), {
    state: 'WAITING_INPUT', reason: 'claude_prompt_text_or_suggestion_visible',
  });

  const staleProgressThenEmptyPrompt = [
    '✶ Validating old request…',
    'x'.repeat(300),
    'request review completed',
    '❯ ',
    '────────────────────────',
    '  ⏵⏵ auto mode on',
  ].join('\n');
  assert.deepEqual(classifyItermTail(staleProgressThenEmptyPrompt), {
    state: 'WAITING_INPUT', reason: 'claude_input_prompt_visible',
  });

  const oldPromptThenProgress = [
    '❯ continue',
    '────────────────────────',
    '  ⏵⏵ auto mode on',
    '✽ Running evaluation…',
  ].join('\n');
  assert.deepEqual(classifyItermTail(oldPromptThenProgress), {
    state: 'WORKING', reason: 'active_progress_visible',
  });
});

test('untracked prompt text is treated as a possible suggestion, not a safe draft', () => {
  const reflowed = [
    'research result summary',
    '❯ continue the approved research goal',
    '────────────────────────────────────────────────────────────────',
    '  ⏵⏵ auto mode on',
    ...Array.from({ length: 350 }, (_, index) => `wrapped static line ${index}`),
  ].join('\n');
  assert.deepEqual(classifyItermTail(reflowed), {
    state: 'WAITING_INPUT', reason: 'claude_prompt_text_or_suggestion_visible',
  });
});

test('iTerm snapshot exposes only typed state and a tail hash', async () => {
  const snapshot = await collectItermStatuses({
    platform: 'darwin',
    runCommand: async () => ({
      ok: true,
      stdout: JSON.stringify([{
        tty: '/dev/ttys019',
        name: 'ACL_4',
        tail: '✻ Done\n────\n❯ \n────\n⏵⏵ auto mode on',
      }]),
      stderr: '',
    }),
  });
  assert.equal(snapshot.status, 'ok');
  assert.equal(snapshot.items[0].state, 'WAITING_INPUT');
  assert.match(snapshot.items[0].tailHash, /^[a-f0-9]{64}$/);
  assert.equal('tail' in snapshot.items[0], false);
});

test('external iTerm delivery separates bracketed paste from raw Enter', async () => {
  const calls = [];
  const result = await sendItermMessage('/dev/ttys019', 'continue safely', {
    enterDelayMs: 0,
    runWrite: async (lines, argv) => calls.push({ lines, argv }),
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].argv, ['/dev/ttys019', 'continue safely']);
  assert.deepEqual(calls[1].argv, ['/dev/ttys019']);
  assert.ok(calls[0].lines.some((line) => /payload newline no/.test(line)));
  assert.ok(calls[1].lines.some((line) => /ASCII character 13/.test(line)));
});

test('tracked prompt drafts expose their marker and support Enter-only retry', async () => {
  assert.deepEqual(classifyItermTail([
    '✶ stale work indicator…',
    '❯ [FIRM DELIVERY firm-deadbeef] continue the approved goal',
    '────────────────────────',
    '  ⏵⏵ auto mode on',
  ].join('\n')), {
    state: 'DRAFT_PENDING_ENTER',
    reason: 'firm_delivery_draft_visible',
    draftDeliveryMarker: 'firm-deadbeef',
  });
  const calls = [];
  await submitItermDraft('/dev/ttys019', {
    runWrite: async (lines, argv) => calls.push({ lines, argv }),
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv, ['/dev/ttys019']);
  assert.ok(calls[0].lines.some((line) => /ASCII character 13/.test(line)));
});
