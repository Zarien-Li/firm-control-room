import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export async function createStore(dataDir, options = {}) {
  await mkdir(dataDir, { recursive: true });
  const databasePath = join(dataDir, 'history.sqlite');
  const db = new DatabaseSync(databasePath);
  const scanRetention = Math.max(10, Number(options.scanRetention) || 50);
  const gpuSnapshotRetention = Math.max(20, Number(options.gpuSnapshotRetention) || 200);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA wal_autocheckpoint = 250;
    PRAGMA journal_size_limit = 16777216;
    CREATE TABLE IF NOT EXISTS scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collected_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      snapshot_json TEXT NOT NULL,
      audit_json TEXT NOT NULL,
      evidence_hash TEXT NOT NULL UNIQUE,
      evidence_path TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scans_collected_at_idx ON scans(collected_at DESC);
    CREATE TABLE IF NOT EXISTS gpu_queue_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collected_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      status TEXT NOT NULL,
      snapshot_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS gpu_queue_snapshots_collected_idx
      ON gpu_queue_snapshots(collected_at DESC);
    CREATE TABLE IF NOT EXISTS automation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      event_type TEXT NOT NULL,
      target_id TEXT,
      run_id TEXT,
      severity TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      source_json TEXT,
      session_id TEXT,
      delivered_at TEXT,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS automation_events_status_idx
      ON automation_events(status, id DESC);
    CREATE TABLE IF NOT EXISTS project_progress (
      target_id TEXT PRIMARY KEY,
      stage TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL,
      reviewed_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'portfolio-review',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS message_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_key TEXT NOT NULL UNIQUE,
      target_id TEXT NOT NULL,
      category TEXT NOT NULL,
      automation_event_id INTEGER,
      session_pid INTEGER,
      session_id TEXT,
      tty TEXT,
      payload_text TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      baseline_cursor TEXT,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      enter_attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      sending_at TEXT,
      sent_at TEXT,
      last_enter_at TEXT,
      acked_at TEXT,
      ack_cursor TEXT,
      error TEXT,
      FOREIGN KEY(automation_event_id) REFERENCES automation_events(id)
    );
    CREATE INDEX IF NOT EXISTS message_outbox_status_idx
      ON message_outbox(status, id ASC);
    CREATE INDEX IF NOT EXISTS message_outbox_target_idx
      ON message_outbox(target_id, id DESC);
    CREATE TABLE IF NOT EXISTS session_episodes (
      episode_id TEXT PRIMARY KEY,
      target_id TEXT NOT NULL,
      session_pid INTEGER NOT NULL,
      terminal_state TEXT NOT NULL,
      history_cursor TEXT,
      tail_hash TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      source_json TEXT
    );
    CREATE INDEX IF NOT EXISTS session_episodes_target_idx
      ON session_episodes(target_id, last_seen_at DESC);
    CREATE TABLE IF NOT EXISTS jobs (
      run_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      executor TEXT NOT NULL,
      state TEXT NOT NULL,
      host TEXT,
      pid INTEGER,
      pid_start_token TEXT,
      command_fingerprint TEXT,
      purpose TEXT NOT NULL DEFAULT '',
      submitted_at TEXT NOT NULL,
      started_at TEXT,
      heartbeat_at TEXT,
      finished_at TEXT,
      progress_json TEXT,
      result_json TEXT,
      metadata_json TEXT,
      source TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS jobs_project_state_idx
      ON jobs(project_id, state, updated_at DESC);
    CREATE TABLE IF NOT EXISTS job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT,
      at TEXT NOT NULL,
      payload_json TEXT,
      FOREIGN KEY(run_id) REFERENCES jobs(run_id)
    );
    CREATE INDEX IF NOT EXISTS job_events_run_idx ON job_events(run_id, id ASC);
  `);
  const outboxColumns = new Set(db.prepare('PRAGMA table_info(message_outbox)').all()
    .map((column) => column.name));
  if (!outboxColumns.has('enter_attempts')) {
    db.exec('ALTER TABLE message_outbox ADD COLUMN enter_attempts INTEGER NOT NULL DEFAULT 0');
  }
  if (!outboxColumns.has('last_enter_at')) {
    db.exec('ALTER TABLE message_outbox ADD COLUMN last_enter_at TEXT');
  }
  db.exec(`
    UPDATE message_outbox
    SET status = 'UNCERTAIN', updated_at = CURRENT_TIMESTAMP,
        error = COALESCE(error, 'process_restarted_during_transport_send')
    WHERE status = 'SENDING';

    DELETE FROM job_events
    WHERE event_type = 'updated'
      AND id NOT IN (
        SELECT MAX(id) FROM job_events WHERE event_type = 'updated' GROUP BY run_id
      );
  `);
  const insert = db.prepare(`
    INSERT INTO scans (collected_at, snapshot_json, audit_json, evidence_hash, evidence_path)
    VALUES (?, ?, ?, ?, ?)
  `);
  const list = db.prepare(`
    SELECT id, collected_at, created_at, evidence_hash, evidence_path, audit_json
    FROM scans ORDER BY id DESC LIMIT ?
  `);
  const get = db.prepare('SELECT * FROM scans WHERE id = ?');
  const hasLegacySemanticAudits = Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'semantic_audits'
  `).get());
  const pruneScans = db.prepare(hasLegacySemanticAudits ? `
    DELETE FROM scans
    WHERE id NOT IN (SELECT id FROM scans ORDER BY id DESC LIMIT ?)
      AND id NOT IN (SELECT scan_id FROM semantic_audits WHERE scan_id IS NOT NULL)
  ` : `
    DELETE FROM scans
    WHERE id NOT IN (SELECT id FROM scans ORDER BY id DESC LIMIT ?)
  `);
  const insertGpuQueueSnapshot = db.prepare(`
    INSERT INTO gpu_queue_snapshots (collected_at, status, snapshot_json)
    VALUES (?, ?, ?)
  `);
  const latestGpuQueueSnapshot = db.prepare(`
    SELECT * FROM gpu_queue_snapshots ORDER BY id DESC LIMIT 1
  `);
  const pruneGpuQueueSnapshots = db.prepare(`
    DELETE FROM gpu_queue_snapshots
    WHERE id NOT IN (
      SELECT id FROM gpu_queue_snapshots ORDER BY id DESC LIMIT ?
    )
  `);
  const insertAutomationEvent = db.prepare(`
    INSERT OR IGNORE INTO automation_events
      (event_key, category, event_type, target_id, run_id, severity,
       status, title, message, source_json, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getAutomationEvent = db.prepare('SELECT * FROM automation_events WHERE event_key = ?');
  const getAutomationEventById = db.prepare('SELECT * FROM automation_events WHERE id = ?');
  const listAutomationEvents = db.prepare(`
    SELECT * FROM automation_events ORDER BY id DESC LIMIT ?
  `);
  const listPendingAutomationEvents = db.prepare(`
    SELECT * FROM automation_events
    WHERE status IN ('PENDING', 'HELD') ORDER BY id ASC LIMIT ?
  `);
  const updateAutomationEvent = db.prepare(`
    UPDATE automation_events
    SET status = ?, updated_at = CURRENT_TIMESTAMP, session_id = ?, delivered_at = ?, note = ?
    WHERE id = ?
  `);
  const upsertProjectProgress = db.prepare(`
    INSERT INTO project_progress (target_id, stage, summary, reviewed_at, source)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(target_id) DO UPDATE SET
      stage = excluded.stage,
      summary = excluded.summary,
      reviewed_at = excluded.reviewed_at,
      source = excluded.source,
      updated_at = CURRENT_TIMESTAMP
  `);
  const getProjectProgress = db.prepare(`
    SELECT * FROM project_progress WHERE target_id = ?
  `);
  const listProjectProgress = db.prepare(`
    SELECT * FROM project_progress ORDER BY target_id ASC
  `);
  const insertOutboxMessage = db.prepare(`
    INSERT OR IGNORE INTO message_outbox
      (message_key, target_id, category, automation_event_id, session_pid,
       session_id, tty, payload_text, payload_hash, baseline_cursor, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED')
  `);
  const getOutboxMessage = db.prepare(`
    SELECT * FROM message_outbox WHERE message_key = ?
  `);
  const getOutboxMessageById = db.prepare(`
    SELECT * FROM message_outbox WHERE id = ?
  `);
  const listOutboxMessages = db.prepare(`
    SELECT * FROM message_outbox ORDER BY id DESC LIMIT ?
  `);
  const listUnacknowledgedOutbox = db.prepare(`
    SELECT * FROM message_outbox
    WHERE status IN ('QUEUED', 'SENDING', 'SENT_AWAITING_ACK', 'UNCERTAIN')
    ORDER BY id ASC LIMIT ?
  `);
  const claimOutboxMessage = db.prepare(`
    UPDATE message_outbox
    SET status = 'SENDING', sending_at = ?, updated_at = CURRENT_TIMESTAMP,
        attempts = attempts + 1, error = NULL
    WHERE id = ? AND status = 'QUEUED'
  `);
  const markOutboxSent = db.prepare(`
    UPDATE message_outbox
    SET status = 'SENT_AWAITING_ACK', sent_at = ?, updated_at = CURRENT_TIMESTAMP,
        error = NULL
    WHERE id = ? AND status = 'SENDING'
  `);
  const markOutboxAcknowledged = db.prepare(`
    UPDATE message_outbox
    SET status = 'ACKED', acked_at = ?, ack_cursor = ?, updated_at = CURRENT_TIMESTAMP,
        error = NULL
    WHERE id = ? AND status IN ('SENDING', 'SENT_AWAITING_ACK', 'UNCERTAIN')
  `);
  const markOutboxFailed = db.prepare(`
    UPDATE message_outbox
    SET status = ?, error = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status IN ('QUEUED', 'SENDING', 'SENT_AWAITING_ACK', 'UNCERTAIN')
  `);
  const recordOutboxEnterRetry = db.prepare(`
    UPDATE message_outbox
    SET enter_attempts = enter_attempts + 1, last_enter_at = ?,
        updated_at = CURRENT_TIMESTAMP, error = NULL
    WHERE id = ? AND status IN ('SENT_AWAITING_ACK', 'UNCERTAIN')
  `);
  const upsertSessionEpisode = db.prepare(`
    INSERT INTO session_episodes
      (episode_id, target_id, session_pid, terminal_state, history_cursor,
       tail_hash, first_seen_at, last_seen_at, source_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(episode_id) DO UPDATE SET
      terminal_state = excluded.terminal_state,
      history_cursor = excluded.history_cursor,
      tail_hash = excluded.tail_hash,
      last_seen_at = excluded.last_seen_at,
      source_json = excluded.source_json
  `);
  const listSessionEpisodes = db.prepare(`
    SELECT * FROM session_episodes ORDER BY last_seen_at DESC LIMIT ?
  `);
  const upsertJob = db.prepare(`
    INSERT INTO jobs
      (run_id, project_id, kind, executor, state, host, pid, pid_start_token,
       command_fingerprint, purpose, submitted_at, started_at, heartbeat_at,
       finished_at, progress_json, result_json, metadata_json, source, revision)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      project_id=excluded.project_id, kind=excluded.kind, executor=excluded.executor,
      state=excluded.state, host=excluded.host, pid=excluded.pid,
      pid_start_token=excluded.pid_start_token,
      command_fingerprint=excluded.command_fingerprint, purpose=excluded.purpose,
      submitted_at=excluded.submitted_at, started_at=excluded.started_at,
      heartbeat_at=excluded.heartbeat_at, finished_at=excluded.finished_at,
      progress_json=excluded.progress_json, result_json=excluded.result_json,
      metadata_json=excluded.metadata_json, source=excluded.source,
      revision=excluded.revision, updated_at=CURRENT_TIMESTAMP
  `);
  const getJob = db.prepare('SELECT * FROM jobs WHERE run_id = ?');
  const listJobs = db.prepare('SELECT * FROM jobs ORDER BY updated_at DESC, run_id DESC LIMIT ?');
  const listActiveJobs = db.prepare(`
    SELECT * FROM jobs WHERE state IN ('pending', 'running')
    ORDER BY updated_at DESC, run_id DESC
  `);
  const listTerminalJobs = db.prepare(`
    SELECT * FROM jobs WHERE state IN ('done', 'failed', 'cancelled')
    ORDER BY COALESCE(finished_at, updated_at) DESC, run_id DESC LIMIT ?
  `);
  const listTerminalJobsAfter = db.prepare(`
    SELECT * FROM jobs
    WHERE state IN ('done', 'failed', 'cancelled')
      AND (COALESCE(finished_at, updated_at) < ?
        OR (COALESCE(finished_at, updated_at) = ? AND run_id < ?))
    ORDER BY COALESCE(finished_at, updated_at) DESC, run_id DESC LIMIT ?
  `);
  const countJobsByState = db.prepare(`
    SELECT state, COUNT(*) AS count FROM jobs GROUP BY state
  `);
  const insertJobEvent = db.prepare(`
    INSERT OR IGNORE INTO job_events
      (event_key, run_id, event_type, from_state, to_state, at, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const listJobEvents = db.prepare('SELECT * FROM job_events WHERE run_id = ? ORDER BY id ASC');

  function automationEventRow(row) {
    if (!row) return null;
    return {
      id: Number(row.id),
      eventKey: row.event_key,
      category: row.category,
      eventType: row.event_type,
      targetId: row.target_id,
      runId: row.run_id,
      severity: row.severity,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      status: row.status,
      title: row.title,
      message: row.message,
      source: row.source_json ? JSON.parse(row.source_json) : null,
      sessionId: row.session_id,
      deliveredAt: row.delivered_at,
      note: row.note,
    };
  }

  function projectProgressRow(row) {
    if (!row) return null;
    return {
      targetId: row.target_id,
      stage: row.stage,
      summary: row.summary,
      reviewedAt: row.reviewed_at,
      source: row.source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function outboxRow(row) {
    if (!row) return null;
    return {
      id: Number(row.id),
      messageKey: row.message_key,
      targetId: row.target_id,
      category: row.category,
      automationEventId: row.automation_event_id === null ? null : Number(row.automation_event_id),
      sessionPid: row.session_pid === null ? null : Number(row.session_pid),
      sessionId: row.session_id,
      tty: row.tty,
      payloadText: row.payload_text,
      payloadHash: row.payload_hash,
      baselineCursor: row.baseline_cursor,
      status: row.status,
      attempts: Number(row.attempts),
      enterAttempts: Number(row.enter_attempts || 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      sendingAt: row.sending_at,
      sentAt: row.sent_at,
      lastEnterAt: row.last_enter_at,
      ackedAt: row.acked_at,
      ackCursor: row.ack_cursor,
      error: row.error,
    };
  }

  function sessionEpisodeRow(row) {
    if (!row) return null;
    return {
      episodeId: row.episode_id,
      targetId: row.target_id,
      sessionPid: Number(row.session_pid),
      terminalState: row.terminal_state,
      historyCursor: row.history_cursor,
      tailHash: row.tail_hash,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      source: row.source_json ? JSON.parse(row.source_json) : null,
    };
  }

  function jobRow(row) {
    if (!row) return null;
    return {
      runId: row.run_id, projectId: row.project_id, kind: row.kind,
      executor: row.executor, state: row.state, host: row.host,
      pid: row.pid === null ? null : Number(row.pid), pidStartToken: row.pid_start_token,
      commandFingerprint: row.command_fingerprint, purpose: row.purpose,
      submittedAt: row.submitted_at, startedAt: row.started_at,
      heartbeatAt: row.heartbeat_at, finishedAt: row.finished_at,
      progress: row.progress_json ? JSON.parse(row.progress_json) : null,
      result: row.result_json ? JSON.parse(row.result_json) : null,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
      source: row.source, revision: Number(row.revision),
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  return {
    databasePath,
    save(snapshot, audit, evidence) {
      const result = insert.run(
        snapshot.collectedAt,
        JSON.stringify(snapshot),
        JSON.stringify(audit),
        evidence.bundleHash,
        evidence.directory,
      );
      pruneScans.run(scanRetention);
      return Number(result.lastInsertRowid);
    },
    list(limit = 50) {
      return list.all(Math.max(1, Math.min(Number(limit) || 50, 500))).map((row) => ({
        id: Number(row.id),
        collectedAt: row.collected_at,
        createdAt: row.created_at,
        evidenceHash: row.evidence_hash,
        evidencePath: row.evidence_path,
        audit: JSON.parse(row.audit_json),
      }));
    },
    get(id) {
      const row = get.get(Number(id));
      if (!row) return null;
      return {
        id: Number(row.id),
        collectedAt: row.collected_at,
        createdAt: row.created_at,
        evidenceHash: row.evidence_hash,
        evidencePath: row.evidence_path,
        snapshot: JSON.parse(row.snapshot_json),
        audit: JSON.parse(row.audit_json),
      };
    },
    saveGpuQueueSnapshot(snapshot) {
      const inserted = insertGpuQueueSnapshot.run(
        snapshot.collectedAt,
        snapshot.status,
        JSON.stringify(snapshot),
      );
      pruneGpuQueueSnapshots.run(gpuSnapshotRetention);
      return Number(inserted.lastInsertRowid);
    },
    latestGpuQueueSnapshot() {
      const row = latestGpuQueueSnapshot.get();
      if (!row) return null;
      return {
        id: Number(row.id),
        collectedAt: row.collected_at,
        createdAt: row.created_at,
        status: row.status,
        snapshot: JSON.parse(row.snapshot_json),
      };
    },
    pruneHistory() {
      const scans = pruneScans.run(scanRetention);
      const gpuSnapshots = pruneGpuQueueSnapshots.run(gpuSnapshotRetention);
      db.exec('PRAGMA wal_checkpoint(PASSIVE)');
      return {
        scansDeleted: Number(scans.changes),
        gpuSnapshotsDeleted: Number(gpuSnapshots.changes),
      };
    },
    createAutomationEvent(event) {
      insertAutomationEvent.run(
        event.eventKey,
        event.category,
        event.eventType,
        event.targetId ?? null,
        event.runId ?? null,
        event.severity || 'info',
        event.status || 'PENDING',
        event.title,
        event.message,
        event.source ? JSON.stringify(event.source) : null,
        event.note ?? null,
      );
      return automationEventRow(getAutomationEvent.get(event.eventKey));
    },
    getAutomationEvent(eventKey) {
      return automationEventRow(getAutomationEvent.get(eventKey));
    },
    getAutomationEventById(id) {
      return automationEventRow(getAutomationEventById.get(Number(id)));
    },
    listAutomationEvents(limit = 100) {
      return listAutomationEvents.all(Math.max(1, Math.min(Number(limit) || 100, 1000)))
        .map(automationEventRow);
    },
    listPendingAutomationEvents(limit = 100) {
      return listPendingAutomationEvents.all(Math.max(1, Math.min(Number(limit) || 100, 1000)))
        .map(automationEventRow);
    },
    setAutomationEvent(id, {
      status,
      sessionId = null,
      deliveredAt = null,
      note = null,
    }) {
      updateAutomationEvent.run(status, sessionId, deliveredAt, note, Number(id));
      return automationEventRow(getAutomationEventById.get(Number(id)));
    },
    setProjectProgress(targetId, { stage = '', summary, reviewedAt, source }) {
      upsertProjectProgress.run(targetId, stage, summary, reviewedAt, source);
      return projectProgressRow(getProjectProgress.get(targetId));
    },
    getProjectProgress(targetId) {
      return projectProgressRow(getProjectProgress.get(targetId));
    },
    listProjectProgress() {
      return listProjectProgress.all().map(projectProgressRow);
    },
    createOutboxMessage(message) {
      insertOutboxMessage.run(
        message.messageKey,
        message.targetId,
        message.category,
        message.automationEventId ?? null,
        message.sessionPid ?? null,
        message.sessionId ?? null,
        message.tty ?? null,
        message.payloadText,
        message.payloadHash,
        message.baselineCursor ?? null,
      );
      return outboxRow(getOutboxMessage.get(message.messageKey));
    },
    getOutboxMessage(messageKey) {
      return outboxRow(getOutboxMessage.get(messageKey));
    },
    listOutboxMessages(limit = 100) {
      return listOutboxMessages.all(Math.max(1, Math.min(Number(limit) || 100, 1000)))
        .map(outboxRow);
    },
    listUnacknowledgedOutbox(limit = 1000) {
      return listUnacknowledgedOutbox
        .all(Math.max(1, Math.min(Number(limit) || 1000, 5000)))
        .map(outboxRow);
    },
    claimOutboxMessage(id, at) {
      const result = claimOutboxMessage.run(at, Number(id));
      return {
        claimed: Number(result.changes) === 1,
        message: outboxRow(getOutboxMessageById.get(Number(id))),
      };
    },
    markOutboxSent(id, at) {
      markOutboxSent.run(at, Number(id));
      return outboxRow(getOutboxMessageById.get(Number(id)));
    },
    acknowledgeOutboxMessage(id, { at, cursor = null }) {
      markOutboxAcknowledged.run(at, cursor, Number(id));
      return outboxRow(getOutboxMessageById.get(Number(id)));
    },
    failOutboxMessage(id, { status = 'FAILED', error }) {
      markOutboxFailed.run(status, error, Number(id));
      return outboxRow(getOutboxMessageById.get(Number(id)));
    },
    recordOutboxEnterRetry(id, at) {
      recordOutboxEnterRetry.run(at, Number(id));
      return outboxRow(getOutboxMessageById.get(Number(id)));
    },
    observeSessionEpisode(episode) {
      upsertSessionEpisode.run(
        episode.episodeId,
        episode.targetId,
        episode.sessionPid,
        episode.terminalState,
        episode.historyCursor ?? null,
        episode.tailHash ?? null,
        episode.observedAt,
        episode.observedAt,
        episode.source ? JSON.stringify(episode.source) : null,
      );
      return sessionEpisodeRow(db.prepare(
        'SELECT * FROM session_episodes WHERE episode_id = ?',
      ).get(episode.episodeId));
    },
    listSessionEpisodes(limit = 100) {
      return listSessionEpisodes.all(Math.max(1, Math.min(Number(limit) || 100, 1000)))
        .map(sessionEpisodeRow);
    },
    saveJob(job) {
      upsertJob.run(
        job.runId, job.projectId, job.kind, job.executor, job.state,
        job.host ?? null, job.pid ?? null, job.pidStartToken ?? null,
        job.commandFingerprint ?? null, job.purpose || '', job.submittedAt,
        job.startedAt ?? null, job.heartbeatAt ?? null, job.finishedAt ?? null,
        job.progress ? JSON.stringify(job.progress) : null,
        job.result ? JSON.stringify(job.result) : null,
        JSON.stringify(job.metadata || {}), job.source, job.revision || 1,
      );
      return jobRow(getJob.get(job.runId));
    },
    getJob(runId) { return jobRow(getJob.get(runId)); },
    listJobs(limit = 1000) {
      return listJobs.all(Math.max(1, Math.min(Number(limit) || 1000, 5000))).map(jobRow);
    },
    listActiveJobs() { return listActiveJobs.all().map(jobRow); },
    listTerminalJobs({ limit = 25, cursor = null } = {}) {
      const bounded = Math.max(1, Math.min(Number(limit) || 25, 200));
      const rows = cursor
        ? listTerminalJobsAfter.all(cursor.updatedAt, cursor.updatedAt, cursor.runId, bounded + 1)
        : listTerminalJobs.all(bounded + 1);
      return { items: rows.slice(0, bounded).map(jobRow), hasMore: rows.length > bounded };
    },
    countJobsByState() {
      return countJobsByState.all().map((row) => ({ state: row.state, count: Number(row.count) }));
    },
    addJobEvent(event) {
      insertJobEvent.run(
        event.eventKey, event.runId, event.eventType, event.fromState ?? null,
        event.toState ?? null, event.at,
        event.payload ? JSON.stringify(event.payload) : null,
      );
    },
    listJobEvents(runId) {
      return listJobEvents.all(runId).map((row) => ({
        id: Number(row.id), eventKey: row.event_key, runId: row.run_id,
        eventType: row.event_type, fromState: row.from_state, toState: row.to_state,
        at: row.at, payload: row.payload_json ? JSON.parse(row.payload_json) : null,
      }));
    },
    close() {
      db.close();
    },
  };
}
