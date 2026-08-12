import assert from 'node:assert/strict';
import test from 'node:test';
import { argvFingerprint, processStartToken } from '../scripts/process-identity.js';

test('process identity uses a stable OS birth token for the live process', () => {
  const first = processStartToken(process.pid);
  const second = processStartToken(process.pid);
  assert.equal(first, second);
  assert.match(first, /^(linux-boot-ticks|ps-lstart):/);
});

test('argv fingerprint preserves argument boundaries', () => {
  assert.equal(argvFingerprint(['python', 'a b']), argvFingerprint(['python', 'a b']));
  assert.notEqual(argvFingerprint(['python', 'a b']), argvFingerprint(['python', 'a', 'b']));
});
