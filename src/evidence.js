import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function createEvidenceBundle(dataDir, snapshot, audit) {
  const evidenceRoot = join(dataDir, 'evidence');
  await mkdir(evidenceRoot, { recursive: true });
  const directory = join(
    evidenceRoot,
    `${snapshot.collectedAt.replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`,
  );
  await mkdir(directory, { recursive: false });

  const files = {
    'snapshot.json': `${JSON.stringify(snapshot, null, 2)}\n`,
    'audit.json': `${JSON.stringify(audit, null, 2)}\n`,
  };
  const entries = [];
  for (const [name, body] of Object.entries(files)) {
    const path = join(directory, name);
    await writeFile(path, body, { flag: 'wx', mode: 0o444 });
    entries.push({ name, bytes: Buffer.byteLength(body), sha256: sha256(body) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const bundleHash = sha256(entries.map((item) => `${item.name}:${item.sha256}`).join('\n'));
  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    algorithm: 'sha256',
    bundleHash,
    files: entries,
    guarantees: {
      sourceCollection: 'read-only',
      autoCorrection: false,
      evidenceFilesMode: '0444',
    },
  };
  const manifestPath = join(directory, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o444 });
  await chmod(directory, 0o555);
  return { directory, manifestPath, bundleHash, manifest };
}

export async function verifyEvidenceBundle(directory) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  const checks = await Promise.all(manifest.files.map(async (entry) => {
    const body = await readFile(join(directory, entry.name));
    return { name: entry.name, valid: sha256(body) === entry.sha256 };
  }));
  const bundleHash = sha256(manifest.files
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((item) => `${item.name}:${item.sha256}`)
    .join('\n'));
  return {
    valid: checks.every((item) => item.valid) && bundleHash === manifest.bundleHash,
    bundleHash,
    checks,
  };
}
