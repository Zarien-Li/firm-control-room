import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const ITERM_SNAPSHOT_SCRIPT = String.raw`
const app = Application("iTerm2");
const items = [];
app.windows().forEach((window) => window.tabs().forEach((tab) => (
  tab.sessions().forEach((session) => items.push({
    tty: session.tty(),
    name: session.name(),
    tail: String(session.contents()).slice(-12000),
  }))
)));
JSON.stringify(items);
`;

async function runJxa() {
  try {
    const { stdout, stderr } = await exec('/usr/bin/osascript', [
      '-l', 'JavaScript', '-e', ITERM_SNAPSHOT_SCRIPT,
    ], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout || '').trim(),
      stderr: String(error.stderr || error.message || '').trim(),
      code: error.code,
    };
  }
}

const ITERM_WRITE_LINES = Object.freeze([
  'on run argv',
  'set targetTty to item 1 of argv',
  'set payload to item 2 of argv',
  'tell application "iTerm2"',
  'repeat with w in windows',
  'repeat with t in tabs of w',
  'repeat with s in sessions of t',
  'if (tty of s) is targetTty then',
  'tell s to write text payload newline no',
  'return "ok"',
  'end if',
  'end repeat',
  'end repeat',
  'end repeat',
  'end tell',
  'error "iTerm session not found"',
  'end run',
]);

const ITERM_ENTER_LINES = Object.freeze([
  'on run argv',
  'set targetTty to item 1 of argv',
  'tell application "iTerm2"',
  'repeat with w in windows',
  'repeat with t in tabs of w',
  'repeat with s in sessions of t',
  'if (tty of s) is targetTty then',
  'tell s to write text (ASCII character 13) newline no',
  'return "ok"',
  'end if',
  'end repeat',
  'end repeat',
  'end repeat',
  'end tell',
  'error "iTerm session not found"',
  'end run',
]);

const ITERM_CLEAR_LINES = Object.freeze([
  'on run argv',
  'set targetTty to item 1 of argv',
  'tell application "iTerm2"',
  'repeat with w in windows',
  'repeat with t in tabs of w',
  'repeat with s in sessions of t',
  'if (tty of s) is targetTty then',
  'tell s to write text (ASCII character 3) newline no',
  'return "ok"',
  'end if',
  'end repeat',
  'end repeat',
  'end repeat',
  'end tell',
  'error "iTerm session not found"',
  'end run',
]);

const ITERM_ESCAPE_LINES = Object.freeze([
  'on run argv',
  'set targetTty to item 1 of argv',
  'tell application "iTerm2"',
  'repeat with w in windows',
  'repeat with t in tabs of w',
  'repeat with s in sessions of t',
  'if (tty of s) is targetTty then',
  'tell s to write text (ASCII character 27) newline no',
  'return "ok"',
  'end if',
  'end repeat',
  'end repeat',
  'end repeat',
  'end tell',
  'error "iTerm session not found"',
  'end run',
]);

function appleScriptArgs(lines, argv) {
  return [...lines.flatMap((line) => ['-e', line]), '--', ...argv];
}

async function runAppleScript(lines, argv) {
  const { stdout } = await exec('/usr/bin/osascript', appleScriptArgs(lines, argv), {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    encoding: 'utf8',
  });
  return stdout.trim();
}

function latestRateLimit(recent) {
  let latest = null;
  const pattern = /(?:API Error:[^\n]*429|Request rejected \(429\))[\s\S]{0,360}?限额将在\s*(\d{4}-\d{2}-\d{2})\s*T?\s*(\d{2}:\d{2}:\d{2})\s*重置/gi;
  for (const match of recent.matchAll(pattern)) {
    const resetAt = new Date(`${match[1]}T${match[2]}+08:00`);
    if (!Number.isNaN(resetAt.getTime())) {
      latest = { index: match.index, resetAt: resetAt.toISOString() };
    }
  }
  return latest;
}

export function classifyItermTail(value, options = {}) {
  const tail = String(value || '').replace(/\r/g, '');
  if (!tail) return { state: 'UNKNOWN', reason: 'empty_terminal_tail' };
  const recent = tail.slice(-12000);
  const lastIndex = (pattern) => {
    let index = -1;
    for (const match of recent.matchAll(pattern)) index = match.index;
    return index;
  };
  const confirmationIndex = lastIndex(/This command requires approval|Do you want to proceed\?|Esc to cancel.*Tab to amend|❯\s*1\.\s*Yes/gi);
  const activeProgressIndex = lastIndex(/[✳✶✽✢][\s\S]{0,160}(?:…|\.\.\.)|Thinking for\s+\d|Running\s+\d+\s+shell|Compacting conversation|Press up to edit queued/gi);
  const staleMonitorIndex = lastIndex(/monitor still running/gi);
  const progressIndex = Math.max(activeProgressIndex, staleMonitorIndex);
  const rateLimit = latestRateLimit(recent);
  const statusMatches = [...recent.matchAll(/(?:^|\n)\s*⏵⏵[^\n]*/gu)];
  const latestStatus = statusMatches.at(-1) || null;
  const statusIndex = latestStatus?.index ?? -1;
  const statusText = latestStatus?.[0] || '';
  const beforeStatus = statusIndex >= 0 ? recent.slice(0, statusIndex) : '';
  const separators = [...beforeStatus.matchAll(/(?:^|\n)[ \t]*[─━═-]{3,}[ \t]*(?=\n|$)/gu)];
  const separator = separators.at(-1) || null;
  const separatorIndex = separator?.index ?? -1;
  const promptMatches = separatorIndex >= 0
    ? [...beforeStatus.slice(0, separatorIndex).matchAll(/(?:^|\n)❯(?:\u00a0| )?/gu)]
    : [];
  const promptMatch = promptMatches.at(-1) || null;
  const promptIndex = promptMatch?.index ?? -1;
  const promptEnd = separatorIndex;
  const promptText = promptMatch
    ? beforeStatus.slice(promptIndex + promptMatch[0].length, separatorIndex).trim()
    : '';
  const normalizedPromptText = promptText.replace(/\s+/g, ' ').trim();

  const choiceFooterMatches = [...recent.matchAll(/Enter to select[^\n]*/gi)];
  const choiceFooter = choiceFooterMatches.at(-1) || null;
  const choiceFooterIndex = choiceFooter?.index ?? -1;
  const choiceSelections = choiceFooterIndex >= 0
    ? [...recent.slice(0, choiceFooterIndex).matchAll(/(?:^|\n)\s*❯\s*(\d+)\.\s*([^\n]*)/gu)]
    : [];
  const selectedChoice = choiceSelections.at(-1) || null;
  if (selectedChoice) {
    const selectedIndex = selectedChoice.index + selectedChoice[0].indexOf('❯');
    const following = recent.slice(selectedIndex, choiceFooterIndex);
    const nextOption = following.slice(1).search(/\n\s*\d+\.\s+/u);
    const selectedBlock = (nextOption >= 0 ? following.slice(0, nextOption + 1) : following).trim();
    const selectedText = selectedBlock.replace(/^❯\s*\d+\.\s*/u, '').replace(/\s+/g, ' ').trim();
    const humanOwned = /\b(?:grant|authorize|permission|approve|withdraw|submit|purchase|delete|archive)\b|\b(?:paper identity|contribution type|new seed|venue change)\b|(?:授权|批准|许可|删除|归档|投稿|撤稿|付费|更换\s*seed|贡献类型|论文身份)/i.test(selectedText);
    if (confirmationIndex >= 0 || humanOwned) {
      return {
        state: 'CONFIRMATION', reason: 'human_owned_choice_visible',
        selectedOptionNumber: Number(selectedChoice[1]), selectedOptionText: selectedText.slice(0, 500),
      };
    }
    return {
      state: 'ROUTINE_CHOICE', reason: 'claude_routine_choice_visible',
      selectedOptionNumber: Number(selectedChoice[1]), selectedOptionText: selectedText.slice(0, 500),
      recommendedSelected: /\(Recommended\)|（推荐）|推荐选项/i.test(selectedBlock),
    };
  }
  const latestIndex = Math.max(confirmationIndex, progressIndex, promptIndex);
  if (confirmationIndex === latestIndex && confirmationIndex >= 0) {
    return { state: 'CONFIRMATION', reason: 'interactive_confirmation_visible' };
  }
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  if (rateLimit && rateLimit.index > progressIndex
      && Date.parse(rateLimit.resetAt) > now.getTime()) {
    return {
      state: 'RATE_LIMITED',
      reason: 'api_rate_limit_wait',
      resetAt: rateLimit.resetAt,
    };
  }
  const expiredRateLimit = rateLimit && Date.parse(rateLimit.resetAt) <= now.getTime()
    ? { lastRateLimitResetAt: rateLimit.resetAt }
    : {};
  const foregroundProgress = progressIndex > statusIndex;
  const promptIsForeground = promptIndex >= 0 && statusIndex > promptEnd && !foregroundProgress;
  const queuedInputVisible = /Press up to edit queued/i.test(`${statusText}\n${promptText}`);
  const modelWorking = /esc to interrupt/i.test(statusText) || progressIndex > promptIndex;
  if (promptIsForeground) {
    if (queuedInputVisible) {
      return {
        state: 'WORKING', reason: 'queued_input_indicator_visible',
        acceptsQueuedInput: true, queuedInputVisible: true, ...expiredRateLimit,
      };
    }
    if (promptText) {
      const marker = normalizedPromptText.match(/\[FIRM DELIVERY ([^\]]+)\]/)?.[1] || null;
      if (marker) {
        return {
          state: 'DRAFT_PENDING_ENTER',
          reason: 'firm_delivery_draft_visible',
          draftDeliveryMarker: marker,
          ...(modelWorking ? { modelWorking: true, acceptsQueuedInput: true } : {}),
        };
      }
      if (/\[Pasted text #\d+(?:\s*\+\d+\s+lines)?\]/i.test(normalizedPromptText)) {
        return {
          state: 'DRAFT_PENDING_ENTER',
          reason: 'collapsed_bracketed_paste_draft_visible',
          draftDeliveryMarker: null,
          collapsedPasteDraft: true,
          ...(modelWorking ? { modelWorking: true, acceptsQueuedInput: true } : {}),
          ...expiredRateLimit,
        };
      }
      if (modelWorking) {
        return {
          state: 'WORKING', reason: 'model_working_with_editable_prompt',
          acceptsQueuedInput: true, ...expiredRateLimit,
        };
      }
      return { state: 'WAITING_INPUT', reason: 'claude_prompt_text_or_suggestion_visible', ...expiredRateLimit };
    }
    if (modelWorking) {
      return {
        state: 'WORKING', reason: 'model_working_with_editable_prompt',
        acceptsQueuedInput: true, ...expiredRateLimit,
      };
    }
    return { state: 'WAITING_INPUT', reason: 'claude_input_prompt_visible', ...expiredRateLimit };
  }
  if (progressIndex >= 0) {
    return { state: 'WORKING', reason: 'active_progress_visible', ...expiredRateLimit };
  }
  return { state: 'UNKNOWN', reason: 'no_decisive_terminal_marker' };
}

export async function collectItermStatuses(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'darwin') {
    return { status: 'unavailable', reason: 'iterm_status_requires_macos', items: [] };
  }
  const result = await (options.runCommand || runJxa)();
  if (!result.ok) {
    return {
      status: 'degraded',
      reason: result.code === 'ENOENT' ? 'osascript_not_installed' : 'iterm_snapshot_failed',
      detail: result.stderr,
      items: [],
    };
  }
  try {
    const parsed = JSON.parse(result.stdout || '[]');
    return {
      status: 'ok',
      reason: null,
      items: parsed.filter((item) => item?.tty).map((item) => ({
        tty: item.tty,
        name: String(item.name || '').slice(0, 200),
        ...classifyItermTail(item.tail, { now: options.now }),
        tailHash: createHash('sha256').update(String(item.tail || '')).digest('hex'),
      })),
    };
  } catch (error) {
    return {
      status: 'degraded',
      reason: 'iterm_snapshot_invalid_json',
      detail: String(error.message || error),
      items: [],
    };
  }
}

export async function sendItermMessage(tty, message, options = {}) {
  if (process.platform !== 'darwin' && !options.runWrite) {
    throw new Error('External iTerm delivery requires macOS');
  }
  if (!/^\/dev\/tty\S+$/.test(String(tty || ''))) throw new Error('Invalid iTerm TTY');
  if (typeof message !== 'string' || !message.trim() || message.length > 8000) {
    throw new Error('External iTerm message must contain 1-8000 characters');
  }
  const write = options.runWrite || ((lines, argv) => runAppleScript(lines, argv));
  await write(ITERM_WRITE_LINES, [tty, message]);
  await new Promise((resolve) => setTimeout(resolve, options.enterDelayMs ?? 350));
  await write(ITERM_ENTER_LINES, [tty]);
  return { ok: true, tty, bytes: Buffer.byteLength(message) };
}

export async function submitItermDraft(tty, options = {}) {
  if (process.platform !== 'darwin' && !options.runWrite) {
    throw new Error('External iTerm delivery requires macOS');
  }
  if (!/^\/dev\/tty\S+$/.test(String(tty || ''))) throw new Error('Invalid iTerm TTY');
  const write = options.runWrite || ((lines, argv) => runAppleScript(lines, argv));
  await write(ITERM_ENTER_LINES, [tty]);
  return { ok: true, tty };
}

export async function clearItermDraft(tty, options = {}) {
  if (process.platform !== 'darwin' && !options.runWrite) {
    throw new Error('External iTerm delivery requires macOS');
  }
  if (!/^\/dev\/tty\S+$/.test(String(tty || ''))) throw new Error('Invalid iTerm TTY');
  const write = options.runWrite || ((lines, argv) => runAppleScript(lines, argv));
  await write(ITERM_CLEAR_LINES, [tty]);
  return { ok: true, tty };
}

export async function dismissItermChoice(tty, options = {}) {
  if (process.platform !== 'darwin' && !options.runWrite) {
    throw new Error('External iTerm delivery requires macOS');
  }
  if (!/^\/dev\/tty\S+$/.test(String(tty || ''))) throw new Error('Invalid iTerm TTY');
  const write = options.runWrite || ((lines, argv) => runAppleScript(lines, argv));
  await write(ITERM_ESCAPE_LINES, [tty]);
  return { ok: true, tty };
}

export const itermStatusInternals = Object.freeze({
  ITERM_WRITE_LINES,
  ITERM_ENTER_LINES,
  ITERM_CLEAR_LINES,
  ITERM_ESCAPE_LINES,
  appleScriptArgs,
});
