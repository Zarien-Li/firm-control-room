import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export function processStartToken(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).split(' ');
    return `linux-boot-ticks:${fields[19]}`;
  } catch {
    const started = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().replace(/\s+/g, ' ');
    if (!started) throw new Error(`process_not_found:${pid}`);
    return `ps-lstart:${started}`;
  }
}

export function argvFingerprint(argv) {
  return createHash('sha256').update(JSON.stringify(argv)).digest('hex');
}
