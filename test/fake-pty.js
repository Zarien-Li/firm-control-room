export class FakeTerminal {
  constructor(pid) {
    this.pid = pid;
    this.dataHandlers = [];
    this.exitHandlers = [];
    this.writes = [];
    this.resizes = [];
    this.kills = [];
    this.exited = false;
  }

  onData(handler) {
    this.dataHandlers.push(handler);
    return { dispose() {} };
  }

  onExit(handler) {
    this.exitHandlers.push(handler);
    return { dispose() {} };
  }

  write(data) {
    this.writes.push(data);
  }

  resize(cols, rows) {
    this.resizes.push({ cols, rows });
  }

  kill(signal) {
    this.kills.push(signal);
    if (!this.exited) this.emitExit({ exitCode: 143, signal: 15 });
  }

  emitData(data) {
    for (const handler of this.dataHandlers) handler(data);
  }

  emitExit(event = { exitCode: 0, signal: 0 }) {
    if (this.exited) return;
    this.exited = true;
    for (const handler of this.exitHandlers) handler(event);
  }
}

export class FakePty {
  constructor({ name = 'fake-pty', resize = true } = {}) {
    this.name = name;
    this.capabilities = Object.freeze({ resize });
    this.calls = [];
    this.terminals = [];
  }

  spawn(executable, args, options) {
    const terminal = new FakeTerminal(4100 + this.terminals.length);
    this.calls.push({ executable, args, options });
    this.terminals.push(terminal);
    return terminal;
  }
}
