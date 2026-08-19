import { mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { createPtyBackend } from './pty-backend.js';
import { SessionManager } from './session-manager.js';
import { createBrokerServer, probeBroker } from './broker-rpc.js';

export async function startBroker(overrides = {}) {
  const config = { ...(await loadConfig()), ...overrides };
  if (await probeBroker(config.brokerSocketPath)) {
    throw new Error(`A session broker is already listening at ${config.brokerSocketPath}`);
  }
  await mkdir(dirname(config.brokerSocketPath), { recursive: true });
  await unlink(config.brokerSocketPath).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  const pty = overrides.pty || await createPtyBackend({ executable: config.claudeExecutable });
  const manager = overrides.sessionManager || new SessionManager({
    projects: config.sessionTargets,
    executable: config.claudeExecutable,
    args: config.claudeArgs,
    controlDir: config.sessionControlDir,
    bufferBytes: config.sessionBufferBytes,
    pty,
  });
  const broker = await createBrokerServer({
    socketPath: config.brokerSocketPath,
    manager,
  });
  return { ...broker, manager, config };
}

async function main() {
  const broker = await startBroker();
  console.log(`FIRM session broker PID ${process.pid} listening at ${broker.config.brokerSocketPath}`);
  const shutdown = async () => {
    await broker.close({ terminate: true });
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
