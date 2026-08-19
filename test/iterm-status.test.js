import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyItermTail,
  clearItermDraft,
  collectItermStatuses,
  dismissItermChoice,
  selectItermChoice,
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

test('a 429 with a future reset time is a healthy rate-limit wait', () => {
  const tail = [
    'API Error: Request rejected (429) · [1308][已达到 5小时的使用上限。您的限额将在 2026-08-1200:17:28重置。',
    '❯ ',
    '────────────────────────',
    '  ⏵⏵ auto mode on',
  ].join('\n');
  assert.deepEqual(classifyItermTail(tail, {
    now: new Date('2026-08-11T16:00:00Z'),
  }), {
    state: 'RATE_LIMITED',
    reason: 'api_rate_limit_wait',
    resetAt: '2026-08-11T16:17:28.000Z',
  });
  assert.deepEqual(classifyItermTail(tail, {
    now: new Date('2026-08-11T16:18:00Z'),
  }), {
    state: 'WAITING_INPUT',
    reason: 'claude_input_prompt_visible',
    lastRateLimitResetAt: '2026-08-11T16:17:28.000Z',
  });
});

test('a provider 5xx is a silent transient, not a fresh Claude input point', () => {
  const tail = [
    'API Error: 529 overloaded. Retrying in 30 seconds.',
    '❯ ',
    '────────────────────────',
    '  ⏵⏵ auto mode on',
  ].join('\n');
  assert.deepEqual(classifyItermTail(tail), {
    state: 'PROVIDER_TRANSIENT',
    reason: 'provider_temporary_failure',
    retryAfterSeconds: 30,
    providerFailureFingerprint: 'c0f6eeff8c013ab9f019b7f70db60a18b06cac293e7751c25e0a6372a40dde14',
  });
  assert.equal(classifyItermTail(`${tail}\n✽ Continuing the current turn…`).state, 'WORKING');
});

test('a later 429 reset wins over stale 529 and FIRM recovery text', () => {
  const tail = [
    'API Error: 529 overloaded. Retrying in 30 seconds.',
    '[FIRM OPERATIONAL RECOVERY] The preceding provider failure has reached its retry point.',
    'API Error: Request rejected (429) · [1308][已达到 5小时的使用上限。您的限额将在 2026-08-1200:17:28重置。',
    '❯ ',
    '────────────────────────',
    '  ⏵⏵ auto mode on',
  ].join('\n');
  assert.deepEqual(classifyItermTail(tail, {
    now: new Date('2026-08-11T16:00:00Z'),
  }), {
    state: 'RATE_LIMITED',
    reason: 'api_rate_limit_wait',
    resetAt: '2026-08-11T16:17:28.000Z',
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

test('multiline FIRM prompts are foreground drafts even when stale progress appears above them', () => {
  assert.deepEqual(classifyItermTail([
    '✳ Running an old monitor…',
    '✻ Worked for 3h',
    '❯ [FIRM DELIVERY',
    '  firm-c7265dc5fe7a24c599265f5d]',
    '  [FIRM OPERATIONAL EVENT — GPU RESULT]',
    '  Read RESULT.md and continue.',
    '────────────────────────────────',
    '  ⏵⏵ auto mode on (shift+tab to cycle)',
  ].join('\n')), {
    state: 'DRAFT_PENDING_ENTER',
    reason: 'firm_delivery_draft_visible',
    draftDeliveryMarker: 'firm-c7265dc5fe7a24c599265f5d',
  });
});

test('a FIRM draft can be submitted into Claude Code while the model is running', () => {
  assert.deepEqual(classifyItermTail([
    '✶ Building the current method…',
    '❯ [FIRM DELIVERY firm-queued-result]',
    '  A GPU result is ready.',
    '────────────────────────────────',
    '  ⏵⏵ auto mode on · esc to interrupt',
  ].join('\n')), {
    state: 'DRAFT_PENDING_ENTER',
    reason: 'firm_delivery_draft_visible',
    draftDeliveryMarker: 'firm-queued-result',
    modelWorking: true,
    acceptsQueuedInput: true,
  });
});

test('a truncated Claude working footer wins over the editable empty prompt', () => {
  assert.deepEqual(classifyItermTail([
    '✻ Processing… (4m 16s)',
    '❯ ',
    '────────────────',
    '  ⏵⏵ auto mode on (shift+tab to cycle) · esc to int…',
  ].join('\n')), {
    state: 'WORKING',
    reason: 'model_working_with_editable_prompt',
    acceptsQueuedInput: true,
  });
  assert.deepEqual(classifyItermTail([
    'Compacting conversation… (6m 34s)',
    '❯ ',
    '────────────────',
    '  ⏵⏵ auto mode on (shift+tab to cycle) · esc to …',
    '                            0% until auto-compact',
  ].join('\n')), {
    state: 'WORKING',
    reason: 'model_working_with_editable_prompt',
    acceptsQueuedInput: true,
  });
});

test('ordinary research menus are distinct from external-authorization confirmations', () => {
  assert.deepEqual(classifyItermTail([
    'How should I unblock it?',
    '❯ 1. Start the GPU Scheduler (Recommended)',
    '     Drain the existing queue.',
    '  2. Keep waiting',
    '  3. Type something.',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n')), {
    state: 'ROUTINE_CHOICE',
    reason: 'claude_routine_choice_visible',
    selectedOptionNumber: 1,
    selectedOptionText: 'Start the GPU Scheduler (Recommended) Drain the existing queue.',
    recommendedSelected: true,
  });
  assert.deepEqual(classifyItermTail([
    '❯ 1. Grant permission to delete the dataset (Recommended)',
    '  2. Cancel',
    'Enter to select · Esc to cancel',
  ].join('\n')), {
    state: 'BOUNDARY_CHOICE',
    reason: 'external_authorization_choice_visible',
    selectedOptionNumber: 1,
    selectedOptionText: 'Grant permission to delete the dataset (Recommended)',
    recommendedSelected: true,
  });
});

test('draft clear and choice dismiss are separate terminal actions', async () => {
  const calls = [];
  const runWrite = async (lines, argv) => calls.push({ lines, argv });
  await clearItermDraft('/dev/ttys019', { runWrite });
  await dismissItermChoice('/dev/ttys019', { runWrite });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].lines.some((line) => /ASCII character 3/.test(line)));
  assert.ok(calls[1].lines.some((line) => /ASCII character 27/.test(line)));
});

test('routine choice selection navigates from the visible item and submits once', async () => {
  const calls = [];
  const result = await selectItermChoice('/dev/ttys019', 1, 3, {
    runWrite: async (lines, argv) => calls.push({ lines, argv }),
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv, ['/dev/ttys019', '1', '3']);
  assert.ok(calls[0].lines.some((line) => /targetChoice - currentChoice/.test(line)));
  assert.ok(calls[0].lines.some((line) => /ASCII character 13/.test(line)));
});

test('collapsed bracketed paste is a draft that needs Enter, not a fresh prompt', () => {
  assert.deepEqual(classifyItermTail([
    'research status',
    '❯ [Pasted text #1 +12 lines]',
    '────────────────────────',
    '  ⏵⏵ auto mode on',
  ].join('\n')), {
    state: 'DRAFT_PENDING_ENTER',
    reason: 'collapsed_bracketed_paste_draft_visible',
    draftDeliveryMarker: null,
    collapsedPasteDraft: true,
  });
});
