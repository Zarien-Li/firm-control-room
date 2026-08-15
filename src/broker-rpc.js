import { createServer, createConnection } from 'node:net';
import { chmod, unlink } from 'node:fs/promises';

const MAX_MESSAGE_BYTES = 128 * 1024;

function endSocket(socket, payload) {
  if (socket.destroyed || !socket.writable || socket.writableEnded) return;
  // Clients deliberately destroy timed-out RPC sockets. A late reply must not
  // turn that ordinary disconnect into an uncaught EPIPE that kills the broker.
  socket.end(payload, () => {});
}

function rpcError(error) {
  return {
    code: error.code || 'internal_error',
    message: error.code ? error.message : 'Internal broker error',
    status: error.status || 500,
  };
}

async function dispatch(manager, method, params = {}) {
  switch (method) {
    case 'health': return { ok: true, brokerPid: process.pid };
    case 'list': return manager.list();
    case 'start': return manager.start(params.projectId, {
      cols: params.cols,
      rows: params.rows,
      bootstrap: params.bootstrap,
    });
    case 'output': return manager.output(params.id, params.cursor ?? 0);
    case 'input': return manager.input(params.id, params.data);
    case 'resize': return manager.resize(params.id, params.cols, params.rows);
    case 'bootstrap': return manager.bootstrap(params.id);
    case 'interrupt': return manager.interrupt(params.id);
    case 'stop': return manager.stop(params.id);
    default: {
      const error = new Error(`Unknown broker method: ${method}`);
      error.code = 'method_not_found';
      error.status = 404;
      throw error;
    }
  }
}

export async function createBrokerServer({ socketPath, manager }) {
  const server = createServer((socket) => {
    let input = Buffer.alloc(0);
    let dispatched = false;
    socket.on('error', () => {
      // Per-connection failures are isolated. The broker process owns PTYs and
      // must survive a browser refresh, client timeout, or abandoned request.
    });
    socket.on('data', async (chunk) => {
      if (dispatched) return;
      input = Buffer.concat([input, chunk]);
      if (input.length > MAX_MESSAGE_BYTES) {
        dispatched = true;
        endSocket(socket, `${JSON.stringify({ ok: false, error: {
          code: 'message_too_large', message: 'Broker message exceeds 128 KiB', status: 413,
        } })}\n`);
        return;
      }
      const newline = input.indexOf(10);
      if (newline < 0) return;
      dispatched = true;
      socket.pause();
      try {
        const request = JSON.parse(input.subarray(0, newline).toString('utf8'));
        const result = await dispatch(manager, request.method, request.params);
        endSocket(socket, `${JSON.stringify({ ok: true, result })}\n`);
      } catch (error) {
        endSocket(socket, `${JSON.stringify({ ok: false, error: rpcError(error) })}\n`);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  return {
    server,
    async close({ terminate = false } = {}) {
      await new Promise((resolve) => server.close(resolve));
      await unlink(socketPath).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      await manager.close({ terminate });
    },
  };
}

export function probeBroker(socketPath, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => {
      finish(true);
    });
    socket.once('error', () => finish(false));
  });
}
