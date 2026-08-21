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
    assert.equal(store.saveSemanticAudit, undefined);
    assert.equal(store.createIntervention, undefined);
    assert.equal(store.setAutomationPolicy, undefined);
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

test('online history pruning preserves legacy semantic-audit scan references', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'firm-legacy-retention-'));
  const databasePath = join(directory, 'history.sqlite');
  let store;
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE scans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collected_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        snapshot_json TEXT NOT NULL,
        audit_json TEXT NOT NULL,
        evidence_hash TEXT NOT NULL UNIQUE,
        evidence_path TEXT NOT NULL
      );
      CREATE TABLE semantic_audits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scan_id INTEGER,
        FOREIGN KEY(scan_id) REFERENCES scans(id)
      );
    `);
    const insertScan = db.prepare(`
      INSERT INTO scans
        (collected_at, snapshot_json, audit_json, evidence_hash, evidence_path)
      VALUES (?, '{}', '{}', ?, ?)
    `);
    for (let index = 0; index < 15; index += 1) {
      insertScan.run(`scan-${index}`, `hash-${index}`, `evidence-${index}`);
    }
    db.prepare('INSERT INTO semantic_audits (scan_id) VALUES (1)').run();
  } finally {
    db.close();
  }

  try {
    store = await createStore(directory, { scanRetention: 10 });
    assert.doesNotThrow(() => store.pruneHistory());
    store.close();
    store = null;
    const compacted = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(compacted.prepare('SELECT COUNT(*) AS count FROM scans').get().count, 11);
      assert.equal(compacted.prepare('SELECT COUNT(*) AS count FROM scans WHERE id = 1').get().count, 1);
    } finally {
      compacted.close();
    }
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
