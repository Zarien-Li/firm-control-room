const baseUrl = process.env.FIRM_BASE_URL || 'http://127.0.0.1:8787';
const durationMs = Number(process.env.FIRM_SOAK_MS || 24 * 60 * 60 * 1000);
const intervalMs = Number(process.env.FIRM_SOAK_INTERVAL_MS || 15_000);
const startedAt = Date.now();
let samples = 0;
const missingEpisodes = new Map();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function json(path) {
  const response = await fetch(`${baseUrl}${path}`);
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response.json();
}

async function sample() {
  const [sessions, events, outbox, episodes] = await Promise.all([
    json('/api/external-sessions'),
    json('/api/automation-events?limit=1000'),
    json('/api/message-outbox?limit=1000'),
    json('/api/session-episodes?limit=1000'),
  ]);
  assert(sessions.status === 'ok', `session collector degraded: ${sessions.status}`);
  const keys = outbox.map((message) => message.messageKey);
  assert(new Set(keys).size === keys.length, 'duplicate outbox message_key detected');
  for (const message of outbox) {
    if (message.status === 'ACKED') {
      assert(message.ackedAt, `ACKED outbox ${message.messageKey} has no ackedAt`);
      assert(message.ackCursor, `ACKED outbox ${message.messageKey} has no history cursor`);
    }
    if (message.status === 'SENT_AWAITING_ACK') {
      assert(message.sentAt, `sent outbox ${message.messageKey} has no sentAt`);
    }
  }
  for (const event of events) {
    if (event.status !== 'DELIVERED') continue;
    const linked = outbox.find((message) => message.automationEventId === event.id);
    if (linked) assert(linked.status === 'ACKED', `event ${event.eventKey} delivered without ACK`);
  }
  for (const session of sessions.items || []) {
    assert(session.operationalState, `session ${session.pid} has no operational state`);
    if (session.heartbeat?.episodeId) {
      const episodeId = session.heartbeat.episodeId;
      if (episodes.some((episode) => episode.episodeId === episodeId)) {
        missingEpisodes.delete(episodeId);
      } else {
        const missingSince = missingEpisodes.get(episodeId) || Date.now();
        missingEpisodes.set(episodeId, missingSince);
        assert(Date.now() - missingSince < Math.max(45_000, intervalMs * 3),
          `live episode ${episodeId} was not persisted within three samples`);
      }
    }
  }
  samples += 1;
  process.stdout.write(`\rFIRM soak: ${samples} samples, ${sessions.items?.length || 0} sessions, ${outbox.length} deliveries`);
}

while (Date.now() - startedAt < durationMs) {
  await sample();
  if (Date.now() - startedAt >= durationMs) break;
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
process.stdout.write(`\nFIRM soak passed for ${Date.now() - startedAt} ms.\n`);
