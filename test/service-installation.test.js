import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('background service scripts never launch a terminal application', async () => {
  const scriptsDir = join(root, 'scripts');
  const names = await readdir(scriptsDir);
  const sources = await Promise.all(names.map(async (name) => ({
    name,
    text: await readFile(join(scriptsDir, name), 'utf8'),
  })));
  const guiLaunch = /(?:\/usr\/bin\/open\b|Terminal\.app|tell application ["']Terminal["'])/i;
  const offenders = sources.filter(({ text }) => guiLaunch.test(text)).map(({ name }) => name);
  assert.deepEqual(offenders, []);
});
