import { spawn as nodeSpawn } from 'node:child_process';
import { chmod } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = '/usr/bin/script';
const SCRIPT_CAPABILITIES = Object.freeze({ resize: false });
const NODE_PTY_CAPABILITIES = Object.freeze({ resize: true });

function disposable(list, handler) {
  return {
    dispose() {
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
  };
}

export function createScriptBackend({
  executable,
  spawnProcess = nodeSpawn,
  killProcess = process.kill.bind(process),
} = {}) {
  if (typeof executable !== 'string' || !isAbsolute(executable)) {
    throw new Error('script backend executable must be an absolute path');
  }

  return Object.freeze({
    name: 'macos-script',
    capabilities: SCRIPT_CAPABILITIES,
    spawn(requestedExecutable, args, options = {}) {
      if (requestedExecutable !== executable) {
        throw new Error('script backend only permits its fixed executable');
      }
      if (!Array.isArray(args) || args.length !== 0) {
        throw new Error('script backend does not accept executable arguments');
      }

      const child = spawnProcess(
        SCRIPT_PATH,
        ['-q', '/dev/null', executable],
        {
          cwd: options.cwd,
          env: options.env,
          detached: true,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      const dataHandlers = [];
      const exitHandlers = [];
      let exited = false;

      const emitData = (data) => {
        for (const handler of [...dataHandlers]) handler(data);
      };
      const emitExit = (event) => {
        if (exited) return;
        exited = true;
        for (const handler of [...exitHandlers]) handler(event);
      };
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', emitData);
      child.stderr?.on('data', emitData);
      child.once('error', (error) => {
        emitData(`${error.message}\n`);
        emitExit({ exitCode: null, signal: null });
      });
      child.once('exit', (exitCode, signal) => emitExit({ exitCode, signal }));

      return {
        pid: child.pid ?? null,
        onData(handler) {
          dataHandlers.push(handler);
          return disposable(dataHandlers, handler);
        },
        onExit(handler) {
          exitHandlers.push(handler);
          return disposable(exitHandlers, handler);
        },
        write(data) {
          child.stdin.write(data);
        },
        resize() {
          return false;
        },
        kill(signal = 'SIGTERM') {
          if (exited || !Number.isInteger(child.pid) || child.pid < 1) return;
          try {
            killProcess(-child.pid, signal);
          } catch (error) {
            if (error.code !== 'ESRCH') throw error;
          }
        },
      };
    },
  });
}

export function createNodePtyBackend(nodePty) {
  if (!nodePty || typeof nodePty.spawn !== 'function') {
    throw new Error('node-pty spawn is required');
  }
  return Object.freeze({
    name: 'node-pty',
    capabilities: NODE_PTY_CAPABILITIES,
    spawn: nodePty.spawn.bind(nodePty),
  });
}

export async function createPtyBackend({
  executable,
  platform = process.platform,
  arch = process.arch,
  spawnProcess,
  loadNodePty = () => import('node-pty'),
  chmodFile = chmod,
  spawnHelperPath,
} = {}) {
  if (platform === 'darwin') {
    const packageEntry = fileURLToPath(import.meta.resolve('node-pty'));
    const packageRoot = resolve(dirname(packageEntry), '..');
    const helper = spawnHelperPath
      || join(packageRoot, 'prebuilds', `darwin-${arch}`, 'spawn-helper');
    await chmodFile(helper, 0o755);
  }
  return createNodePtyBackend(await loadNodePty());
}
