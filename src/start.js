import { mkdir, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { BrokerClient } from './broker-client.js';
import { createApp } from './server.js';

async function waitForBroker(client) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await client.health();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('Session broker did not become ready');
}

async function main() {
  const config = await loadConfig();
  const client = new BrokerClient({ socketPath: config.brokerSocketPath });
  try {
    await client.health();
  } catch {
    await mkdir(config.dataDir, { recursive: true });
    const log = await open(join(config.dataDir, 'broker.log'), 'a', 0o600);
    const child = spawn(process.execPath, [join(config.root, 'src/broker.js')], {
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      env: process.env,
    });
    child.unref();
    await waitForBroker(client);
    await log.close();
  }
  const app = await createApp({ brokerClient: client });
  const address = await app.listen();
  console.log(`FIRM Control Room listening on http://${address.address}:${address.port}`);
  try {
    const initial = await app.fullCycle();
    console.log(`Initial read-only scan #${initial.id}: ${initial.evidenceHash}`);
  } catch (error) {
    console.error('Initial scan failed:', error);
  }
  try {
    const automation = await app.automationEngine.cycle({ forceQueue: true });
    console.log(`Initial automation cycle: GPU queue ${automation.queue.status}`);
  } catch (error) {
    console.error('Initial automation cycle failed:', error);
  }
  let brokerFailures = 0;
  const brokerWatch = setInterval(async () => {
    try {
      await client.health();
      brokerFailures = 0;
    } catch (error) {
      brokerFailures += 1;
      console.error(`Broker health check failed (${brokerFailures}/3):`, error);
      if (brokerFailures >= 3) {
        console.error('Broker remained unavailable; exiting so the supervisor can rebuild the control plane.');
        process.exit(1);
      }
    }
  }, 15_000);
  brokerWatch.unref();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
