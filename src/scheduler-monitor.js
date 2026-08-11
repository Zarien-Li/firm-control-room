import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const MONITOR_COMMAND_MARKER = 'GLOBAL_GPU_SCHEDULER_MONITOR';

export async function probeSchedulerMonitor(pidFile, options = {}) {
  if (!pidFile) return { status: 'disabled', reason: 'pid_file_not_configured' };
  let rawPid;
  try {
    rawPid = await (options.readFile || readFile)(pidFile, 'utf8');
  } catch (error) {
    return {
      status: 'missing',
      reason: error.code === 'ENOENT' ? 'pid_file_missing' : 'pid_file_unreadable',
      pidFile,
    };
  }
  const pid = Number(String(rawPid).trim());
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    return { status: 'missing', reason: 'pid_file_invalid', pidFile };
  }
  try {
    const runPs = options.runPs || ((value) => exec('/bin/ps', [
      '-p', String(value), '-o', 'command=',
    ], { timeout: 5000, encoding: 'utf8' }));
    const { stdout = '' } = await runPs(pid);
    const command = String(stdout).trim();
    if (!command) return { status: 'missing', reason: 'process_not_found', pidFile, pid };
    if (!command.includes(MONITOR_COMMAND_MARKER)) {
      return { status: 'missing', reason: 'pid_reused_by_other_process', pidFile, pid };
    }
    return { status: 'healthy', reason: 'monitor_process_verified', pidFile, pid };
  } catch (error) {
    return {
      status: 'missing',
      reason: error.code === 1 || error.code === 'ESRCH' ? 'process_not_found' : 'process_probe_failed',
      pidFile,
      pid,
    };
  }
}
