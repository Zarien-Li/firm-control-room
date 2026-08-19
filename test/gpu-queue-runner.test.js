import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const runner = new URL('../scripts/firm-gpu-queue-runner.sh', import.meta.url).pathname;

test('queue runner does not expand a local variable before nounset has declared it', async () => {
  const source = await readFile(runner, 'utf8');
  assert.doesNotMatch(source, /local\s+run_dir="\$1"[^\n]*\$run_dir\//);
  assert.doesNotMatch(source, /local\s+request="\$run_dir\/REQUEST\.md"[^\n]*\$request/);
});
