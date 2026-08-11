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

export function classifyItermTail(value) {
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
  let promptIndex = -1;
  let promptEnd = -1;
  let promptText = '';
  for (const match of recent.matchAll(/(?:^|\n)❯(?:\u00a0| )*([^\n]*)\n[─\s]*\n\s*⏵⏵/gu)) {
    promptIndex = match.index;
    promptEnd = match.index + match[0].length;
    promptText = match[1].trim();
  }
  const latestIndex = Math.max(confirmationIndex, progressIndex, promptIndex);
  if (confirmationIndex === latestIndex && confirmationIndex >= 0) {
    return { state: 'CONFIRMATION', reason: 'interactive_confirmation_visible' };
  }
  const progressAfterPrompt = promptEnd >= 0
    && Math.max(activeProgressIndex, staleMonitorIndex) > promptEnd;
  if (promptIndex >= 0 && !progressAfterPrompt) {
    if (/Press up to edit queued/i.test(promptText)) {
      return { state: 'WORKING', reason: 'queued_input_indicator_visible' };
    }
    if (promptText) {
      const marker = promptText.match(/\[FIRM DELIVERY ([^\]]+)\]/)?.[1] || null;
      if (marker) {
        return {
          state: 'DRAFT_PENDING_ENTER',
          reason: 'firm_delivery_draft_visible',
          draftDeliveryMarker: marker,
        };
      }
      return { state: 'WAITING_INPUT', reason: 'claude_prompt_text_or_suggestion_visible' };
    }
    return { state: 'WAITING_INPUT', reason: 'claude_input_prompt_visible' };
  }
  if (progressIndex >= 0) {
    return { state: 'WORKING', reason: 'active_progress_visible' };
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
        ...classifyItermTail(item.tail),
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

export const itermStatusInternals = Object.freeze({
  ITERM_WRITE_LINES,
  ITERM_ENTER_LINES,
  appleScriptArgs,
});
