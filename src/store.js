import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export async function createStore(dataDir) {
  await mkdir(dataDir, { recursive: true });
  const databasePath = join(dataDir, 'history.sqlite');
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
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
    CREATE TABLE IF NOT EXISTS semantic_audits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id INTEGER,
      project_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      status TEXT NOT NULL,
      packet_hash TEXT,
      packet_path TEXT,
      result_path TEXT,
      audit_json TEXT,
      error TEXT,
      FOREIGN KEY(scan_id) REFERENCES scans(id)
    );
    CREATE INDEX IF NOT EXISTS semantic_audits_project_idx
      ON semantic_audits(project_id, id DESC);
    CREATE TABLE IF NOT EXISTS interventions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      semantic_audit_id INTEGER NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      status TEXT NOT NULL,
      prompt_text TEXT NOT NULL,
      session_id TEXT,
      sent_at TEXT,
      note TEXT,
      FOREIGN KEY(semantic_audit_id) REFERENCES semantic_audits(id)
    );
    CREATE INDEX IF NOT EXISTS interventions_status_idx
      ON interventions(status, id DESC);
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
    CREATE TABLE IF NOT EXISTS automation_policies (
      target_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      objective TEXT NOT NULL DEFAULT '',
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
    UPDATE interventions
    SET status = 'SUPERSEDED', note = 'superseded_by_newer_pending_intervention'
    WHERE status IN ('PROPOSED', 'HELD')
      AND id NOT IN (
        SELECT MAX(id) FROM interventions
        WHERE status IN ('PROPOSED', 'HELD')
        GROUP BY project_id
      );
    CREATE UNIQUE INDEX IF NOT EXISTS interventions_one_pending_project_idx
      ON interventions(project_id)
      WHERE status IN ('PROPOSED', 'HELD');

    UPDATE automation_events
    SET status = 'RESOLVED', updated_at = CURRENT_TIMESTAMP,
        note = 'replaced_by_stateless_codex_professor_engine'
    WHERE event_type IN ('PROFESSOR_REVIEW_AVAILABLE', 'PROFESSOR_AUTH_REQUIRED')
      AND status IN ('PENDING', 'HELD', 'DELIVERED');

    UPDATE message_outbox
    SET status = 'UNCERTAIN', updated_at = CURRENT_TIMESTAMP,
        error = COALESCE(error, 'process_restarted_during_transport_send')
    WHERE status = 'SENDING';
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
  const insertSemantic = db.prepare(`
    INSERT INTO semantic_audits
      (scan_id, project_id, status, packet_hash, packet_path, result_path, audit_json, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const listSemantic = db.prepare(`
    SELECT * FROM semantic_audits ORDER BY id DESC LIMIT ?
  `);
  const listSemanticByProject = db.prepare(`
    SELECT * FROM semantic_audits WHERE project_id = ? ORDER BY id DESC LIMIT ?
  `);
  const getSemantic = db.prepare('SELECT * FROM semantic_audits WHERE id = ?');
  const insertIntervention = db.prepare(`
    INSERT OR IGNORE INTO interventions
      (semantic_audit_id, project_id, status, prompt_text, note)
    VALUES (?, ?, ?, ?, ?)
  `);
  const pendingIntervention = db.prepare(`
    SELECT * FROM interventions
    WHERE project_id = ? AND status IN ('PROPOSED', 'HELD')
    ORDER BY id DESC LIMIT 1
  `);
  const refreshPendingIntervention = db.prepare(`
    UPDATE interventions
    SET semantic_audit_id = ?, status = 'PROPOSED', prompt_text = ?,
        session_id = NULL, sent_at = NULL, note = ?
    WHERE id = ?
  `);
  const pendingInterventionWithAudit = db.prepare(`
    SELECT interventions.*, semantic_audits.packet_hash AS source_packet_hash
    FROM interventions
    JOIN semantic_audits ON semantic_audits.id = interventions.semantic_audit_id
    WHERE interventions.project_id = ?
      AND interventions.status IN ('PROPOSED', 'HELD')
    ORDER BY interventions.id DESC LIMIT 1
  `);
  const listInterventions = db.prepare(`
    SELECT * FROM interventions ORDER BY id DESC LIMIT ?
  `);
  const getIntervention = db.prepare('SELECT * FROM interventions WHERE id = ?');
  const updateIntervention = db.prepare(`
    UPDATE interventions SET status = ?, session_id = ?, sent_at = ?, note = ? WHERE id = ?
  `);
  const lastSentIntervention = db.prepare(`
    SELECT * FROM interventions
    WHERE project_id = ? AND status = 'SENT'
    ORDER BY id DESC LIMIT 1
  `);
  const insertGpuQueueSnapshot = db.prepare(`
    INSERT INTO gpu_queue_snapshots (collected_at, status, snapshot_json)
    VALUES (?, ?, ?)
  `);
  const latestGpuQueueSnapshot = db.prepare(`
    SELECT * FROM gpu_queue_snapshots ORDER BY id DESC LIMIT 1
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
  const upsertAutomationPolicy = db.prepare(`
    INSERT INTO automation_policies (target_id, enabled, objective)
    VALUES (?, ?, ?)
    ON CONFLICT(target_id) DO UPDATE SET
      enabled = excluded.enabled,
      objective = excluded.objective,
      updated_at = CURRENT_TIMESTAMP
  `);
  const listAutomationPolicies = db.prepare(`
    SELECT * FROM automation_policies ORDER BY target_id ASC
  `);
  const getAutomationPolicy = db.prepare(`
    SELECT * FROM automation_policies WHERE target_id = ?
  `);
  const recentGoalActions = db.prepare(`
    SELECT COUNT(*) AS count, MAX(delivered_at) AS last_delivered_at
    FROM automation_events
    WHERE category = 'goal_loop'
      AND target_id = ?
      AND status = 'DELIVERED'
      AND delivered_at >= ?
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

  function semanticRow(row) {
    if (!row) return null;
    return {
      id: Number(row.id),
      scanId: row.scan_id === null ? null : Number(row.scan_id),
      projectId: row.project_id,
      createdAt: row.created_at,
      status: row.status,
      packetHash: row.packet_hash,
      packetPath: row.packet_path,
      resultPath: row.result_path,
      audit: row.audit_json ? JSON.parse(row.audit_json) : null,
      error: row.error,
    };
  }

  function interventionRow(row) {
    if (!row) return null;
    return {
      id: Number(row.id),
      semanticAuditId: Number(row.semantic_audit_id),
      projectId: row.project_id,
      createdAt: row.created_at,
      status: row.status,
      promptText: row.prompt_text,
      sessionId: row.session_id,
      sentAt: row.sent_at,
      note: row.note,
    };
  }

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

  function automationPolicyRow(row) {
    if (!row) return null;
    return {
      targetId: row.target_id,
      enabled: Boolean(row.enabled),
      objective: row.objective,
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
    saveSemanticAudit(scanId, projectId, result) {
      const inserted = insertSemantic.run(
        scanId ?? null,
        projectId,
        result.status,
        result.packetHash ?? null,
        result.packetPath ?? null,
        result.resultPath ?? null,
        result.audit ? JSON.stringify(result.audit) : null,
        result.error ?? null,
      );
      return Number(inserted.lastInsertRowid);
    },
    listSemanticAudits(limit = 50, projectId = null) {
      const bounded = Math.max(1, Math.min(Number(limit) || 50, 500));
      const rows = projectId
        ? listSemanticByProject.all(projectId, bounded)
        : listSemantic.all(bounded);
      return rows.map(semanticRow);
    },
    getSemanticAudit(id) {
      return semanticRow(getSemantic.get(Number(id)));
    },
    latestSemanticAudit(projectId) {
      return semanticRow(listSemanticByProject.get(projectId, 1));
    },
    createIntervention(semanticAuditId, projectId, promptText, note = null) {
      const pending = pendingIntervention.get(projectId);
      if (pending) {
        refreshPendingIntervention.run(
          semanticAuditId,
          promptText,
          note || 'refreshed_from_newer_high_confidence_audit',
          pending.id,
        );
        return interventionRow(getIntervention.get(pending.id));
      }
      insertIntervention.run(semanticAuditId, projectId, 'PROPOSED', promptText, note);
      const row = db.prepare('SELECT * FROM interventions WHERE semantic_audit_id = ?')
        .get(semanticAuditId);
      return interventionRow(row);
    },
    clearPendingIntervention(projectId, { semanticAuditId, packetHash, verdict }) {
      const pending = pendingInterventionWithAudit.get(projectId);
      if (!pending || !packetHash || pending.source_packet_hash === packetHash) {
        return pending ? interventionRow(pending) : null;
      }
      updateIntervention.run(
        'CLEARED',
        null,
        null,
        `cleared_by_newer_${String(verdict || 'nonintervention').toLowerCase()}_audit:${semanticAuditId}`,
        pending.id,
      );
      return interventionRow(getIntervention.get(pending.id));
    },
    listInterventions(limit = 50) {
      return listInterventions.all(Math.max(1, Math.min(Number(limit) || 50, 500)))
        .map(interventionRow);
    },
    getIntervention(id) {
      return interventionRow(getIntervention.get(Number(id)));
    },
    setIntervention(id, { status, sessionId = null, sentAt = null, note = null }) {
      updateIntervention.run(status, sessionId, sentAt, note, Number(id));
      return interventionRow(getIntervention.get(Number(id)));
    },
    lastSentIntervention(projectId) {
      return interventionRow(lastSentIntervention.get(projectId));
    },
    saveGpuQueueSnapshot(snapshot) {
      const inserted = insertGpuQueueSnapshot.run(
        snapshot.collectedAt,
        snapshot.status,
        JSON.stringify(snapshot),
      );
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
    setAutomationPolicy(targetId, { enabled, objective }) {
      upsertAutomationPolicy.run(targetId, enabled ? 1 : 0, objective);
      return automationPolicyRow(getAutomationPolicy.get(targetId));
    },
    getAutomationPolicy(targetId) {
      return automationPolicyRow(getAutomationPolicy.get(targetId));
    },
    listAutomationPolicies() {
      return listAutomationPolicies.all().map(automationPolicyRow);
    },
    recentGoalActions(targetId, since) {
      const row = recentGoalActions.get(targetId, since);
      return {
        count: Number(row?.count || 0),
        lastDeliveredAt: row?.last_delivered_at || null,
      };
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
    close() {
      db.close();
    },
  };
}
