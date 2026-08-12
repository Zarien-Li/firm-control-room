import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  claudeProjectDirectoryName,
  readClaudeHistoryHeartbeat,
  readRecentClaudeActivity,
} from '../src/claude-history.js';

test('Claude history heartbeat reports a semantic cursor and delivery acknowledgements', async () => {
  const root = await mkdtemp(join(tmpdir(), 'firm-claude-heartbeat-'));
  const projectPath = '/Users/example/research/ACL_1';
  const directory = join(root, claudeProjectDirectoryName(projectPath));
  await mkdir(directory);
  const older = join(directory, 'older.jsonl');
  const newer = join(directory, 'newer.jsonl');
  await writeFile(older, '{partial');
  await writeFile(newer, `${JSON.stringify({
    type: 'last-prompt',
    uuid: 'event-2',
    timestamp: '2026-08-11T00:02:00Z',
    lastPrompt: '[FIRM DELIVERY goal-42]\ncontinue',
  })}\n`);
  await utimes(older, new Date('2026-08-11T00:00:00Z'), new Date('2026-08-11T00:00:00Z'));
  await utimes(newer, new Date('2026-08-11T00:02:00Z'), new Date('2026-08-11T00:02:00Z'));
  try {
    const heartbeat = await readClaudeHistoryHeartbeat(projectPath, { claudeProjectsDir: root });
    assert.equal(heartbeat.status, 'ok');
    assert.equal(heartbeat.sourceFile, 'newer.jsonl');
    assert.equal(heartbeat.latestWriteAt, '2026-08-11T00:02:00.000Z');
    assert.equal(heartbeat.latestEventId, 'event-2');
    assert.equal(heartbeat.latestEventType, 'user');
    assert.equal(heartbeat.latestAssistantAt, null);
    assert.match(heartbeat.cursor, /^newer\.jsonl:\d+:event-2$/);
    assert.deepEqual(heartbeat.deliveryMarkers, ['goal-42']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Claude queue operations acknowledge a delivery even before a normal user message exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'firm-claude-queue-ack-'));
  const projectPath = '/Users/example/research/ACL_1';
  const directory = join(root, claudeProjectDirectoryName(projectPath));
  await mkdir(directory);
  const lines = [
    {
      type: 'queue-operation', operation: 'enqueue', timestamp: '2026-08-11T00:01:00Z',
      content: '[FIRM DELIVERY firm-queued]\ncontinue',
    },
    {
      type: 'attachment', timestamp: '2026-08-11T00:01:01Z',
      attachment: {
        type: 'queued_command', prompt: '[FIRM DELIVERY firm-attached]\ncontinue',
      },
    },
    {
      type: 'assistant', uuid: 'assistant-after-queue', timestamp: '2026-08-11T00:01:02Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Working now.' }] },
    },
  ];
  await writeFile(join(directory, 'session.jsonl'), `${lines.map(JSON.stringify).join('\n')}\n`);
  try {
    const heartbeat = await readClaudeHistoryHeartbeat(projectPath, { claudeProjectsDir: root });
    assert.deepEqual(heartbeat.deliveryMarkers, ['firm-queued', 'firm-attached']);
    assert.equal(heartbeat.latestEventId, 'assistant-after-queue');
    assert.equal(heartbeat.latestEventType, 'assistant');
    assert.equal(heartbeat.latestAssistantAt, '2026-08-11T00:01:02Z');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('heartbeat retains assistant liveness when one JSONL event exceeds the old 128 KiB window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'firm-claude-large-assistant-'));
  const projectPath = '/Users/example/research/ACL_1';
  const directory = join(root, claudeProjectDirectoryName(projectPath));
  await mkdir(directory);
  const lines = [
    {
      type: 'assistant', uuid: 'large-assistant', timestamp: '2026-08-11T00:03:00Z',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'x'.repeat(180 * 1024) }],
      },
    },
    {
      type: 'user', uuid: 'tool-result', timestamp: '2026-08-11T00:03:01Z',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'done' }] },
    },
  ];
  await writeFile(join(directory, 'session.jsonl'), `${lines.map(JSON.stringify).join('\n')}\n`);
  try {
    const heartbeat = await readClaudeHistoryHeartbeat(projectPath, { claudeProjectsDir: root });
    assert.equal(heartbeat.latestAssistantAt, '2026-08-11T00:03:00Z');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('heartbeat extracts only the single registered-job wait marker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'firm-claude-gpu-wait-'));
  const projectPath = '/Users/example/research/ACL_1';
  const directory = join(root, claudeProjectDirectoryName(projectPath));
  await mkdir(directory);
  const lines = [
    {
      type: 'assistant', uuid: 'wait-assistant', timestamp: '2026-08-11T00:04:00Z',
      message: { role: 'assistant', content: [{
        type: 'text', text: 'Old marker is ignored: [FIRM WAITING_FOR_GPU run_id=old].\n[FIRM WAITING_FOR_JOB run_id=ACL_1_train_1]',
      }] },
    },
    { type: 'system', subtype: 'turn_duration', timestamp: '2026-08-11T00:04:01Z' },
  ];
  await writeFile(join(directory, 'session.jsonl'), `${lines.map(JSON.stringify).join('\n')}\n`);
  try {
    const heartbeat = await readClaudeHistoryHeartbeat(projectPath, { claudeProjectsDir: root });
    assert.deepEqual(heartbeat.waitingForJobRunIds, ['ACL_1_train_1']);
    assert.equal('waitingForGpuRunIds' in heartbeat, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('heartbeat carries a construction lease until a matching terminal marker appears', async () => {
  const root = await mkdtemp(join(tmpdir(), 'firm-claude-construction-lease-'));
  const projectPath = '/Users/example/research/ACL_1';
  const directory = join(root, claudeProjectDirectoryName(projectPath));
  await mkdir(directory);
  const path = join(directory, 'session.jsonl');
  const active = {
    type: 'assistant', uuid: 'lease-active', timestamp: '2026-08-11T00:05:00Z',
    message: { role: 'assistant', content: [{
      type: 'text', text: '[FIRM CONSTRUCTION_LEASE id=method-v1 state=active]',
    }] },
  };
  await writeFile(path, `${JSON.stringify(active)}\n`);
  try {
    let heartbeat = await readClaudeHistoryHeartbeat(projectPath, { claudeProjectsDir: root });
    assert.deepEqual(heartbeat.constructionLease, {
      id: 'method-v1', state: 'active', active: true, observedAt: '2026-08-11T00:05:00Z',
    });
    assert.equal(heartbeat.latestAssistantText,
      '[FIRM CONSTRUCTION_LEASE id=method-v1 state=active]');
    const complete = {
      type: 'assistant', uuid: 'lease-complete', timestamp: '2026-08-11T00:06:00Z',
      message: { role: 'assistant', content: [{
        type: 'text', text: '[FIRM CONSTRUCTION_LEASE id=method-v1 state=complete]',
      }] },
    };
    await writeFile(path, `${JSON.stringify(active)}\n${JSON.stringify(complete)}\n`);
    heartbeat = await readClaudeHistoryHeartbeat(projectPath, { claudeProjectsDir: root });
    assert.equal(heartbeat.constructionLease.active, false);
    assert.equal(heartbeat.constructionLease.state, 'complete');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Claude history reader extracts recent user/assistant text without thinking or tool payloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'firm-claude-history-'));
  const projectPath = '/Users/example/research/ACL_1';
  const directory = join(root, claudeProjectDirectoryName(projectPath));
  await mkdir(directory);
  const now = new Date();
  const lines = [
    {
      type: 'assistant', timestamp: now.toISOString(), isSidechain: false,
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private' }] },
    },
    {
      type: 'assistant', timestamp: now.toISOString(), isSidechain: false,
      message: { role: 'assistant', content: [{ type: 'text', text: 'I will expand to ten seeds.' }] },
    },
    {
      type: 'user', timestamp: now.toISOString(), isSidechain: false,
      message: { role: 'user', content: [{ type: 'tool_result', content: 'secret tool output' }] },
    },
    { type: 'last-prompt', timestamp: now.toISOString(), lastPrompt: 'continue' },
  ];
  await writeFile(join(directory, 'session.jsonl'), `${lines.map(JSON.stringify).join('\n')}\n`);
  try {
    const activity = await readRecentClaudeActivity(projectPath, {
      claudeProjectsDir: root,
      lookbackMs: 60 * 60 * 1000,
      now,
    });
    assert.equal(activity.status, 'ok');
    assert.deepEqual(activity.messages.map((item) => item.text), [
      'I will expand to ten seeds.',
      'continue',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
