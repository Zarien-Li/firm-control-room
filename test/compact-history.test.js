import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('history compaction is safe before the service creates its schema', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'firm-compact-empty-history-'));
  const empty = new DatabaseSync(join(dataDir, 'history.sqlite'));
  empty.close();
  try {
    const { stdout } = await execFileAsync(process.execPath, ['scripts/compact-history.js'], {
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, FIRM_DATA_DIR: dataDir },
    });
    const result = JSON.parse(stdout);
    assert.equal(result.scansDeleted, 0);
    assert.equal(result.gpuSnapshotsDeleted, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('history compaction supports the current schema without legacy semantic audits', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'firm-compact-history-'));
  const databasePath = join(dataDir, 'history.sqlite');
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      CREATE TABLE scans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collected_at TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        audit_json TEXT NOT NULL,
        evidence_hash TEXT NOT NULL UNIQUE,
        evidence_path TEXT NOT NULL
      );
      CREATE TABLE gpu_queue_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collected_at TEXT NOT NULL,
        status TEXT NOT NULL,
        snapshot_json TEXT NOT NULL
      );
    `);
    const insertScan = db.prepare(`
      INSERT INTO scans
        (collected_at, snapshot_json, audit_json, evidence_hash, evidence_path)
      VALUES (?, '{}', '{}', ?, ?)
    `);
    const insertGpu = db.prepare(`
      INSERT INTO gpu_queue_snapshots (collected_at, status, snapshot_json)
      VALUES (?, 'ok', '{}')
    `);
    for (let index = 0; index < 15; index += 1) {
      insertScan.run(`scan-${index}`, `hash-${index}`, `evidence-${index}`);
    }
    for (let index = 0; index < 25; index += 1) {
      insertGpu.run(`gpu-${index}`);
    }
  } finally {
    db.close();
  }

  try {
    await execFileAsync(process.execPath, ['scripts/compact-history.js'], {
      cwd: join(import.meta.dirname, '..'),
      env: {
        ...process.env,
        FIRM_DATA_DIR: dataDir,
        FIRM_SCAN_RETENTION: '10',
        FIRM_GPU_SNAPSHOT_RETENTION: '20',
      },
    });
    const compacted = new DatabaseSync(databasePath);
    try {
      assert.equal(compacted.prepare('SELECT COUNT(*) AS count FROM scans').get().count, 10);
      assert.equal(
        compacted.prepare('SELECT COUNT(*) AS count FROM gpu_queue_snapshots').get().count,
        20,
      );
    } finally {
      compacted.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('history compaction preserves scans referenced by legacy semantic audits', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'firm-compact-legacy-history-'));
  const databasePath = join(dataDir, 'history.sqlite');
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE scans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collected_at TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        audit_json TEXT NOT NULL,
        evidence_hash TEXT NOT NULL UNIQUE,
        evidence_path TEXT NOT NULL
      );
      CREATE TABLE gpu_queue_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collected_at TEXT NOT NULL,
        status TEXT NOT NULL,
        snapshot_json TEXT NOT NULL
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
    await execFileAsync(process.execPath, ['scripts/compact-history.js'], {
      cwd: join(import.meta.dirname, '..'),
      env: {
        ...process.env,
        FIRM_DATA_DIR: dataDir,
        FIRM_SCAN_RETENTION: '10',
      },
    });
    const compacted = new DatabaseSync(databasePath);
    try {
      assert.equal(compacted.prepare('SELECT COUNT(*) AS count FROM scans').get().count, 11);
      assert.equal(compacted.prepare('SELECT COUNT(*) AS count FROM scans WHERE id = 1').get().count, 1);
    } finally {
      compacted.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
