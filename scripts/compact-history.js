import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dataDir = resolve(process.env.FIRM_DATA_DIR || process.argv[2] || 'var');
const databasePath = resolve(dataDir, 'history.sqlite');
if (!existsSync(databasePath)) {
  console.log(`No FIRM history database at ${databasePath}; nothing to compact.`);
  process.exit(0);
}

const scans = Math.max(10, Number(process.env.FIRM_SCAN_RETENTION) || 50);
const gpuSnapshots = Math.max(20, Number(process.env.FIRM_GPU_SNAPSHOT_RETENTION) || 200);
const db = new DatabaseSync(databasePath);
try {
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;');
  const scanDelete = db.prepare(`
    DELETE FROM scans
    WHERE id NOT IN (SELECT id FROM scans ORDER BY id DESC LIMIT ?)
      AND id NOT IN (SELECT scan_id FROM semantic_audits WHERE scan_id IS NOT NULL)
  `).run(scans);
  const gpuDelete = db.prepare(`
    DELETE FROM gpu_queue_snapshots
    WHERE id NOT IN (
      SELECT id FROM gpu_queue_snapshots ORDER BY id DESC LIMIT ?
    )
  `).run(gpuSnapshots);
  db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE);');
  const pageCount = Number(db.prepare('PRAGMA page_count').get().page_count);
  const freePages = Number(db.prepare('PRAGMA freelist_count').get().freelist_count);
  if (pageCount > 0 && freePages / pageCount >= 0.2) db.exec('VACUUM;');
  console.log(JSON.stringify({
    databasePath,
    scansDeleted: Number(scanDelete.changes),
    gpuSnapshotsDeleted: Number(gpuDelete.changes),
    vacuumed: pageCount > 0 && freePages / pageCount >= 0.2,
  }));
} catch (error) {
  try { db.exec('ROLLBACK'); } catch {}
  throw error;
} finally {
  db.close();
}
