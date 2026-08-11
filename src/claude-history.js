import { createHash } from 'node:crypto';
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_TAIL_BYTES = 768 * 1024;
const HEARTBEAT_TAIL_BYTES = 1024 * 1024;
const MAX_MESSAGES = 80;
const MAX_TEXT_CHARS = 48 * 1024;
const DELIVERY_MARKER = /\[FIRM DELIVERY ([^\]\r\n]+)\]/g;
const GPU_WAIT_MARKER = /\[FIRM WAITING_FOR_GPU run_id=([A-Za-z0-9._:-]+)\]/g;

export function claudeProjectDirectoryName(projectPath) {
  return projectPath.replace(/[^A-Za-z0-9]/g, '-');
}

export async function readClaudeHistoryHeartbeat(projectPath, {
  claudeProjectsDir,
} = {}) {
  const directory = join(claudeProjectsDir, claudeProjectDirectoryName(projectPath));
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    return {
      status: 'unavailable',
      directory,
      reason: error.code === 'ENOENT'
        ? 'claude_project_history_missing' : 'claude_project_history_unreadable',
      latestWriteAt: null,
      sourceFile: null,
      cursor: null,
      latestEventId: null,
      latestEventType: null,
      latestAssistantAt: null,
      waitingForGpuRunIds: [],
      deliveryMarkers: [],
    };
  }
  let newest = null;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    try {
      const info = await stat(join(directory, entry.name));
      if (!newest || info.mtimeMs > newest.mtimeMs) {
        newest = {
          name: entry.name,
          path: join(directory, entry.name),
          mtimeMs: info.mtimeMs,
          sizeBytes: info.size,
        };
      }
    } catch {
      // A disappearing session file is ignored until the next heartbeat.
    }
  }
  if (newest) {
    let semantic = {
      latestEventId: null,
      latestEventType: null,
      latestAssistantAt: null,
      waitingForGpuRunIds: [],
      deliveryMarkers: [],
    };
    try {
      semantic = parseHeartbeatTail(await readTail(newest.path, HEARTBEAT_TAIL_BYTES), newest.name);
    } catch {
      // The mtime/size cursor remains useful while Claude is rotating or writing the file.
    }
    return {
      status: 'ok',
      directory,
      reason: null,
      latestWriteAt: new Date(newest.mtimeMs).toISOString(),
      sourceFile: newest.name,
      sizeBytes: newest.sizeBytes,
      cursor: `${newest.name}:${newest.sizeBytes}:${semantic.latestEventId || 'no-semantic-event'}`,
      ...semantic,
    };
  }
  return {
    status: 'idle',
    directory,
    reason: 'no_claude_session_history',
    latestWriteAt: null,
    sourceFile: null,
    sizeBytes: 0,
    cursor: null,
    latestEventId: null,
    latestEventType: null,
    latestAssistantAt: null,
    waitingForGpuRunIds: [],
    deliveryMarkers: [],
  };
}

async function readTail(path, maximum = MAX_TAIL_BYTES) {
  const info = await stat(path);
  const size = Math.min(info.size, maximum);
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, info.size - size);
    let text = buffer.toString('utf8');
    if (info.size > size) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } finally {
    await handle.close();
  }
}

function textParts(content) {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text);
}

function normalizeEvent(value, sourceFile) {
  const timestamp = value.timestamp || value.message?.timestamp || null;
  if (value.isSidechain) return null;
  if (value.type === 'assistant' && value.message?.role === 'assistant') {
    const text = textParts(value.message.content).join('\n').trim();
    return text ? { timestamp, role: 'assistant', text, sourceFile } : null;
  }
  if (value.type === 'user' && value.message?.role === 'user') {
    const text = textParts(value.message.content).join('\n').trim();
    return text ? { timestamp, role: 'user', text, sourceFile } : null;
  }
  if (value.type === 'system' && value.subtype === 'away_summary'
      && typeof value.content === 'string') {
    return { timestamp, role: 'summary', text: value.content.trim(), sourceFile };
  }
  if (value.type === 'last-prompt' && typeof value.lastPrompt === 'string') {
    return { timestamp, role: 'user', text: value.lastPrompt.trim(), sourceFile };
  }
  return null;
}

function stableEventId(value, line) {
  return value.uuid || value.message?.id
    || createHash('sha256').update(line).digest('hex').slice(0, 24);
}

function parseHeartbeatTail(tail, sourceFile) {
  let latestEventId = null;
  let latestEventType = null;
  let latestAssistantAt = null;
  let waitingForGpuRunIds = [];
  const markers = [];
  for (const line of tail.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      const event = normalizeEvent(value, sourceFile);
      if (!value.isSidechain && value.type === 'assistant'
          && value.message?.role === 'assistant') {
        latestEventId = stableEventId(value, line);
        latestEventType = 'assistant';
        latestAssistantAt = value.timestamp || value.message?.timestamp || latestAssistantAt;
        const assistantText = textParts(value.message.content).join('\n');
        waitingForGpuRunIds = [...assistantText.matchAll(GPU_WAIT_MARKER)]
          .map((match) => match[1]);
      } else if (event) {
        latestEventId = stableEventId(value, line);
        latestEventType = event.role;
      }
      const deliveryEvidence = [
        event?.text,
        value.type === 'queue-operation' && ['enqueue', 'remove'].includes(value.operation)
          ? value.content : null,
        value.type === 'attachment' && value.attachment?.type === 'queued_command'
          ? value.attachment.prompt : null,
      ].filter((text) => typeof text === 'string');
      for (const text of deliveryEvidence) {
        for (const match of text.matchAll(DELIVERY_MARKER)) markers.push(match[1]);
      }
    } catch {
      // Partial boundary lines are expected in a bounded live JSONL tail.
    }
  }
  return {
    latestEventId,
    latestEventType,
    latestAssistantAt,
    waitingForGpuRunIds: [...new Set(waitingForGpuRunIds)].slice(-8),
    deliveryMarkers: [...new Set(markers)].slice(-16),
  };
}

export async function readRecentClaudeActivity(projectPath, {
  claudeProjectsDir,
  lookbackMs,
  now = new Date(),
  maxMessages = MAX_MESSAGES,
  maxTextChars = MAX_TEXT_CHARS,
  maxMessageChars = MAX_TEXT_CHARS,
} = {}) {
  const directory = join(claudeProjectsDir, claudeProjectDirectoryName(projectPath));
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    return {
      status: 'unavailable',
      directory,
      reason: error.code === 'ENOENT' ? 'claude_project_history_missing' : 'claude_project_history_unreadable',
      messages: [],
      sourceFiles: [],
      latestAt: null,
    };
  }
  const since = now.getTime() - lookbackMs;
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const path = join(directory, entry.name);
    try {
      const info = await stat(path);
      if (info.mtimeMs >= since) files.push({ path, name: entry.name, mtimeMs: info.mtimeMs });
    } catch {
      // A disappearing session file is ignored until the next scan.
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const messages = [];
  for (const file of files.slice(0, 4)) {
    let tail;
    try {
      tail = await readTail(file.path);
    } catch {
      continue;
    }
    for (const line of tail.split('\n')) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line);
        const event = normalizeEvent(value, file.name);
        const at = event?.timestamp ? Date.parse(event.timestamp) : NaN;
        if (event && (!Number.isFinite(at) || at >= since)) messages.push(event);
      } catch {
        // A partial first or last JSONL line is expected when Claude is writing.
      }
    }
  }
  messages.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
  const bounded = [];
  let chars = 0;
  for (const message of messages.slice(-Math.max(1, maxMessages)).reverse()) {
    const boundedMessage = { ...message, text: message.text.slice(0, Math.max(1, maxMessageChars)) };
    if (chars + boundedMessage.text.length > maxTextChars && bounded.length) break;
    bounded.push(boundedMessage);
    chars += boundedMessage.text.length;
  }
  bounded.reverse();
  return {
    status: bounded.length ? 'ok' : 'idle',
    directory,
    reason: bounded.length ? null : 'no_recent_semantic_activity',
    messages: bounded,
    sourceFiles: files.slice(0, 4).map((file) => ({
      name: file.name,
      mtime: new Date(file.mtimeMs).toISOString(),
    })),
    latestAt: bounded.at(-1)?.timestamp || files[0] && new Date(files[0].mtimeMs).toISOString() || null,
    latestSemanticAt: bounded.at(-1)?.timestamp || null,
    latestWriteAt: files[0] ? new Date(files[0].mtimeMs).toISOString() : null,
  };
}
