# Local Deployment

FIRM runs locally, keeps mutable state outside Git, and binds the dashboard to
`127.0.0.1` by default.

## Configure

```bash
cp .env.example .env.local
cp config/projects.example.json local/projects.json
```

Edit `.env.local` and `local/projects.json` for your research directories. Both are
ignored by Git. Remote GPU settings are optional; leave them disabled unless this
machine is the elected scheduler owner.

## Start Interactively

Install Node.js 26 or newer, then run:

```bash
npm install
npm run doctor:local
npm run start:local
```

Open `http://127.0.0.1:8787`.

## Run as a macOS Service

```bash
npm run service:install
```

The installer creates a private runtime copy under
`~/.local/lib/firm-control-room`, stores mutable state under
`~/.local/state/firm-control-room`, and installs two background LaunchAgents:

- `com.firm.control-room.broker` owns persistent PTYs and the stable broker socket;
- `com.firm.control-room` owns the Web/API process.

There is no nested restart loop. `launchd` is the single supervisor for both
processes, and restarting the Web service does not terminate broker-owned sessions.
The service never opens Terminal.app; both processes run directly in the background.
Raw scan and GPU queue snapshots are retained within configured bounds; canonical
job lifecycle rows and project progress remain in SQLite.

Verify with:

```bash
npm run service:status
launchctl print gui/$(id -u)/com.firm.control-room.broker
curl -sS http://127.0.0.1:8787/api/health
```

The service discovers Node.js 26 through `nvm` or `PATH`. Set
`FIRM_NODE_EXECUTABLE` when Node lives elsewhere.

## Safety Defaults

- The server listens on localhost.
- Secrets, project maps, session state, and job history are not committed.
- Operational AI decisions fail closed: no grounded decision means no message.
- Remote GPU collection and scheduling remain disabled until explicitly configured.
