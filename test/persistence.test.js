import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createEvidenceBundle, verifyEvidenceBundle } from '../src/evidence.js';
import { createStore } from '../src/store.js';

test('evidence bundle hashes verify and SQLite retains history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'firm-control-room-'));
  let evidence;
  let store;
  try {
    const snapshot = {
      schemaVersion: 1,
      collectedAt: '2026-01-01T00:00:00.000Z',
      mode: 'shadow-read-only',
      projects: [],
      gpu: { available: false, devices: [], queue: { status: 'degraded', jobs: [] } },
    };
    const audit = {
      schemaVersion: 1,
      auditedAt: '2026-01-01T00:00:01.000Z',
      mode: 'shadow-read-only',
      autoCorrection: false,
      findings: [],
      findingCount: 0,
      counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    };
    evidence = await createEvidenceBundle(directory, snapshot, audit);
    const verification = await verifyEvidenceBundle(evidence.directory);
    assert.equal(verification.valid, true);
    assert.equal(verification.bundleHash, evidence.bundleHash);

    store = await createStore(directory);
    const id = store.save(snapshot, audit, evidence);
    const restored = store.get(id);
    assert.equal(restored.evidenceHash, evidence.bundleHash);
    assert.equal(restored.snapshot.mode, 'shadow-read-only');
    assert.equal(store.list().length, 1);
    const semanticId = store.saveSemanticAudit(id, 'ACL_1', {
      status: 'completed',
      packetHash: 'f'.repeat(64),
      packetPath: '/packet.json',
      resultPath: '/result.json',
      audit: { verdict: 'INTERVENE', confidence: 0.9 },
      error: null,
    });
    assert.equal(store.getSemanticAudit(semanticId).audit.verdict, 'INTERVENE');
    assert.equal(store.latestSemanticAudit('ACL_1').id, semanticId);
    const intervention = store.createIntervention(
      semanticId,
      'ACL_1',
      'fixed reanchor prompt',
      'test',
    );
    assert.equal(intervention.status, 'PROPOSED');
    const secondSemanticId = store.saveSemanticAudit(id, 'ACL_1', {
      status: 'completed',
      packetHash: 'e'.repeat(64),
      packetPath: '/packet-2.json',
      resultPath: '/result-2.json',
      audit: { verdict: 'INTERVENE', confidence: 0.95 },
      error: null,
    });
    const refreshed = store.createIntervention(
      secondSemanticId,
      'ACL_1',
      'new fixed reanchor prompt',
      'new audit',
    );
    assert.equal(refreshed.id, intervention.id);
    assert.equal(refreshed.semanticAuditId, secondSemanticId);
    assert.equal(refreshed.promptText, 'new fixed reanchor prompt');
    assert.equal(store.listInterventions().length, 1);
    const samePacketSemanticId = store.saveSemanticAudit(id, 'ACL_1', {
      status: 'completed',
      packetHash: 'e'.repeat(64),
      packetPath: '/packet-2.json',
      resultPath: '/result-pass-same-packet.json',
      audit: { verdict: 'PASS', confidence: 0.9 },
      error: null,
    });
    const unchanged = store.clearPendingIntervention('ACL_1', {
      semanticAuditId: samePacketSemanticId,
      packetHash: 'e'.repeat(64),
      verdict: 'PASS',
    });
    assert.equal(unchanged.status, 'PROPOSED');
    const changedPacketSemanticId = store.saveSemanticAudit(id, 'ACL_1', {
      status: 'completed',
      packetHash: 'd'.repeat(64),
      packetPath: '/packet-3.json',
      resultPath: '/result-pass-new-packet.json',
      audit: { verdict: 'PASS', confidence: 0.9 },
      error: null,
    });
    const cleared = store.clearPendingIntervention('ACL_1', {
      semanticAuditId: changedPacketSemanticId,
      packetHash: 'd'.repeat(64),
      verdict: 'PASS',
    });
    assert.equal(cleared.status, 'CLEARED');
    const replacement = store.createIntervention(
      changedPacketSemanticId,
      'ACL_1',
      'reopened prompt',
      'new drift',
    );
    assert.notEqual(replacement.id, intervention.id);
    const sent = store.setIntervention(intervention.id, {
      status: 'SENT', sessionId: 'session-1', sentAt: '2026-01-01T01:00:00.000Z', note: 'test',
    });
    assert.equal(sent.sessionId, 'session-1');
    assert.equal(store.lastSentIntervention('ACL_1').id, intervention.id);
  } finally {
    store?.close();
    if (evidence) await chmod(evidence.directory, 0o755);
    await rm(directory, { recursive: true, force: true });
  }
});

test('raw scan and GPU snapshot history stays within configured retention', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'firm-retention-'));
  let store;
  try {
    store = await createStore(directory, { scanRetention: 10, gpuSnapshotRetention: 20 });
    for (let index = 0; index < 25; index += 1) {
      store.save(
        { collectedAt: new Date(index * 1000).toISOString(), projects: [{ index }] },
        { auditedAt: new Date(index * 1000).toISOString(), findings: [] },
        { bundleHash: index.toString(16).padStart(64, '0'), directory: `/evidence/${index}` },
      );
    }
    for (let index = 0; index < 45; index += 1) {
      store.saveGpuQueueSnapshot({
        collectedAt: new Date(index * 1000).toISOString(), status: 'ok', items: [{ index }],
      });
    }
    store.close();
    store = null;
    const db = new DatabaseSync(join(directory, 'history.sqlite'), { readOnly: true });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM scans').get().count, 10);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM gpu_queue_snapshots').get().count, 20);
    db.close();
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('opening the store resolves legacy persistent Professor events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'firm-professor-migration-'));
  let store;
  try {
    store = await createStore(directory);
    store.createAutomationEvent({
      eventKey: 'legacy-professor-review',
      category: 'professor_review',
      eventType: 'PROFESSOR_REVIEW_AVAILABLE',
      targetId: 'RESEARCH_PROFESSOR',
      runId: 'ACL_1',
      severity: 'warn',
      title: 'Legacy review',
      message: 'Legacy bounded packet',
      source: {},
    });
    store.createAutomationEvent({
      eventKey: 'current-stop-review',
      category: 'professor_review',
      eventType: 'STOP_REVIEW_QUEUED',
      targetId: 'ACL_1',
      severity: 'info',
      title: 'Current stop review',
      message: 'Must survive restart',
      source: {},
    });
    store.close();
    store = null;
    store = await createStore(directory);
    const event = store.getAutomationEvent('legacy-professor-review');
    assert.equal(event.status, 'RESOLVED');
    assert.equal(event.note, 'replaced_by_stateless_codex_professor_engine');
    assert.equal(store.getAutomationEvent('current-stop-review').status, 'PENDING');
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('message outbox persists ACK evidence and quarantines an interrupted send on restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'firm-outbox-restart-'));
  let store;
  try {
    store = await createStore(directory);
    const event = store.createAutomationEvent({
      eventKey: 'goal:P:episode-1',
      category: 'goal_loop',
      eventType: 'GOAL_CONTINUED',
      targetId: 'P',
      severity: 'info',
      title: 'Continue P',
      message: 'Continue after review',
      source: {},
    });
    const message = store.createOutboxMessage({
      messageKey: 'firm-deadbeef',
      targetId: 'P',
      category: 'goal_loop',
      automationEventId: event.id,
      sessionPid: 42,
      tty: 'ttys001',
      payloadText: '[FIRM DELIVERY firm-deadbeef]\ncontinue',
      payloadHash: 'a'.repeat(64),
      baselineCursor: 'session.jsonl:10:event-1',
    });
    assert.equal(message.status, 'QUEUED');
    assert.equal(store.claimOutboxMessage(message.id, '2026-08-11T00:00:00Z').claimed, true);
    store.close();
    store = null;

    store = await createStore(directory);
    const uncertain = store.getOutboxMessage('firm-deadbeef');
    assert.equal(uncertain.status, 'UNCERTAIN');
    assert.equal(uncertain.attempts, 1);
    assert.equal(uncertain.enterAttempts, 0);
    const retried = store.recordOutboxEnterRetry(
      uncertain.id,
      '2026-08-11T00:01:30Z',
    );
    assert.equal(retried.enterAttempts, 1);
    assert.equal(retried.lastEnterAt, '2026-08-11T00:01:30Z');
    assert.equal(store.claimOutboxMessage(uncertain.id, '2026-08-11T00:01:00Z').claimed, false);
    const acked = store.acknowledgeOutboxMessage(uncertain.id, {
      at: '2026-08-11T00:02:00Z',
      cursor: 'session.jsonl:100:event-2',
    });
    assert.equal(acked.status, 'ACKED');
    assert.equal(acked.ackCursor, 'session.jsonl:100:event-2');
    store.observeSessionEpisode({
      episodeId: 'episode-1', targetId: 'P', sessionPid: 42,
      terminalState: 'WAITING_INPUT', historyCursor: 'session.jsonl:100:event-2',
      tailHash: 'tail-a', observedAt: '2026-08-11T00:02:00Z',
      source: { historyEventType: 'assistant' },
    });
    store.observeSessionEpisode({
      episodeId: 'episode-1', targetId: 'P', sessionPid: 42,
      terminalState: 'WORKING', historyCursor: 'session.jsonl:120:event-2',
      tailHash: 'tail-b', observedAt: '2026-08-11T00:03:00Z',
      source: { historyEventType: 'assistant' },
    });
    const episode = store.listSessionEpisodes(10)[0];
    assert.equal(episode.episodeId, 'episode-1');
    assert.equal(episode.firstSeenAt, '2026-08-11T00:02:00Z');
    assert.equal(episode.lastSeenAt, '2026-08-11T00:03:00Z');
    assert.equal(episode.terminalState, 'WORKING');
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
