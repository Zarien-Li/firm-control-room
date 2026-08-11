import assert from 'node:assert/strict';
import test from 'node:test';
import { probeSchedulerMonitor } from '../src/scheduler-monitor.js';

test('Scheduler monitor probe rejects missing, invalid, and reused PIDs', async () => {
  assert.deepEqual(await probeSchedulerMonitor('/tmp/monitor.pid', {
    readFile: async () => {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
  }), {
    status: 'missing', reason: 'pid_file_missing', pidFile: '/tmp/monitor.pid',
  });
  assert.equal((await probeSchedulerMonitor('/tmp/monitor.pid', {
    readFile: async () => 'not-a-pid',
  })).reason, 'pid_file_invalid');
  assert.equal((await probeSchedulerMonitor('/tmp/monitor.pid', {
    readFile: async () => '123',
    runPs: async () => ({ stdout: '/usr/bin/python unrelated.py' }),
  })).reason, 'pid_reused_by_other_process');
});

test('Scheduler monitor probe verifies the fixed command marker', async () => {
  assert.deepEqual(await probeSchedulerMonitor('/tmp/monitor.pid', {
    readFile: async () => '2409\n',
    runPs: async () => ({
      stdout: '/usr/bin/python /tmp/GLOBAL_GPU_SCHEDULER_MONITOR_fixed.py\n',
    }),
  }), {
    status: 'healthy',
    reason: 'monitor_process_verified',
    pidFile: '/tmp/monitor.pid',
    pid: 2409,
  });
});
