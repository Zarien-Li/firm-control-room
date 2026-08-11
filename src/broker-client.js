import { createConnection } from 'node:net';

export class BrokerError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = 'BrokerError';
    this.code = code;
    this.status = status;
  }
}

export class BrokerClient {
  constructor({ socketPath, timeoutMs = 5000 }) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let settled = false;
      let response = '';
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => {
        finish(new BrokerError('broker_timeout', 'Broker RPC timed out', 504));
      }, this.timeoutMs);
      socket.setEncoding('utf8');
      socket.once('connect', () => {
        socket.write(`${JSON.stringify({ method, params })}\n`);
      });
      socket.on('data', (chunk) => {
        response += chunk;
        const newline = response.indexOf('\n');
        if (newline < 0) return;
        try {
          const message = JSON.parse(response.slice(0, newline));
          if (!message.ok) {
            finish(new BrokerError(
              message.error.code,
              message.error.message,
              message.error.status,
            ));
          } else {
            finish(null, message.result);
          }
        } catch {
          finish(new BrokerError('invalid_broker_response', 'Broker returned invalid JSON'));
        }
      });
      socket.once('error', () => {
        finish(new BrokerError('broker_unavailable', 'Session broker is unavailable', 503));
      });
      socket.once('end', () => {
        if (!settled) finish(new BrokerError('broker_disconnected', 'Broker disconnected', 503));
      });
    });
  }

  health() { return this.request('health'); }
  list() { return this.request('list'); }
  start(projectId, dimensions) { return this.request('start', { projectId, ...dimensions }); }
  output(id, cursor) { return this.request('output', { id, cursor }); }
  input(id, data) { return this.request('input', { id, data }); }
  resize(id, cols, rows) { return this.request('resize', { id, cols, rows }); }
  bootstrap(id) { return this.request('bootstrap', { id }); }
  interrupt(id) { return this.request('interrupt', { id }); }
  stop(id) { return this.request('stop', { id }); }
  async close() {}
}
