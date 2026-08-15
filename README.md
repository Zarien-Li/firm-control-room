<div align="center">

# FIRM Control Room

### Keep multiple Claude Code research agents moving without losing scientific control.

[![CI](https://github.com/Zarien-Li/firm-control-room/actions/workflows/ci.yml/badge.svg)](https://github.com/Zarien-Li/firm-control-room/actions/workflows/ci.yml)
[![Node 26+](https://img.shields.io/badge/Node.js-26%2B-3c873a)](https://nodejs.org/)
[![macOS](https://img.shields.io/badge/platform-macOS-111111)](https://www.apple.com/macos/)
[![MIT](https://img.shields.io/badge/license-MIT-2f81f7)](LICENSE)

**One local dashboard for launching, observing, continuing, auditing, and safely re-anchoring parallel AI research sessions.**

[Quick start](#5-minute-quick-start) · [How it works](#how-it-works) · [GPU integration](#optional-gpu-queue) · [中文说明](README.zh-CN.md)

</div>

---

Opening more terminals is easy. Knowing whether nine research agents are genuinely working, waiting on a valid experiment, silently stopped, or drifting into a low-value side problem is not.

FIRM turns those hidden states into an evidence-backed control plane. It combines the Claude history stream, terminal state, process tree, project artifacts, persistent delivery acknowledgements, optional GPU queue signals, and short-lived Codex boundary audits. It can keep approved goals moving without granting a reviewer model authority over the science.

## Why FIRM

| Without a control plane | With FIRM |
|---|---|
| A prompt is visible, but you cannot tell whether Claude stopped or a tool is still draining | Explicit states such as `MODEL_WORKING`, `TOOL_RUNNING`, `WAITING_FOR_JOB`, and `WAITING_REVIEW` |
| “Continue” messages may be pasted twice or never submitted | Durable outbox, unique delivery markers, and Claude-history acknowledgement |
| A long-running session gradually replaces the original research program | Read-only evidence snapshots plus isolated Codex boundary audits |
| A reviewer agent starts inventing extra experiments and steering the PI | Codex may identify scope drift, but cannot choose methods, claims, pivots, or GPU actions |
| GPU workers start before data, dependencies, and evaluation code are ready | Optional readiness gate, queue lifecycle, phase-aware telemetry, and result wake-up |
| A session waiting for an experiment is mistaken for an abandoned session | GPU waits require an exact run ID that is independently verified as active and project-owned |

## What is automated

- **Persistent Claude sessions**: a broker owns PTYs, so a browser or web-process restart does not kill the research agent.
- **External iTerm discovery**: existing Claude Code processes are mapped to projects by verified working directory.
- **Goal Loop**: explicit per-project authorization, user-defined objectives, bounded continuation, and a rolling daily limit.
- **AI Session Resolver**: every new, stable Claude input episode is read by a short-lived Codex process. Codex freely decides whether a response is useful and writes the exact response; FIRM does not classify the episode with a hand-built error or boundary taxonomy.
- **Research-boundary auditing**: periodic portfolio review remains a separate, read-only control surface.
- **Reliable delivery**: external messages move through `QUEUED → SENDING → SENT_AWAITING_ACK → DELIVERED`.
- **GPU-aware waiting**: a project can legitimately stop while its declared `pending/running` experiment is active; terminal results wake it again.
- **Operational honesty**: ambiguous terminals, missing observability, stale progress, permission prompts, and policy holds remain distinct states.

FIRM does **not** let the dashboard execute arbitrary shell commands. It does not let Codex decide that a method is bad, that a field is exhausted, or that a paper should pivot. It never terminates a GPU worker from utilization alone.

## 5-minute quick start

### Requirements

- macOS (external iTerm control is macOS-specific)
- Node.js 26+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and logged in
- Codex CLI installed and logged in if you want independent audits; otherwise disable them

### 1. Install

```bash
git clone https://github.com/Zarien-Li/firm-control-room.git
cd firm-control-room
npm ci
```

### 2. Create one research project

```bash
mkdir -p "$HOME/research"
cp -R examples/research-project "$HOME/research/project-alpha"
cp config/projects.example.json config/projects.json
```

Edit `config/projects.json` when your project has a different name or location. Then replace the placeholders in:

```text
~/research/project-alpha/
├── CLAUDE.md
├── CLAUDE-RESEARCH.md
├── PROGRAM_ORIGIN.md
├── PROJECT_IDENTITY.json
├── SEED.md
├── PIPELINE_STATE.md
└── prompt.txt
```

These files separate durable research authority from mutable session narration. FIRM reads only a small allowlist; it does not recursively ingest your repository.

### 3. Verify and run

```bash
npm run doctor
npm start
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787). Click **Start Claude**, or keep using an existing iTerm Claude session inside the configured project directory and let FIRM discover it.

To run without Codex audits:

```bash
FIRM_CODEX_AUDIT_ENABLED=false npm start
```

## How it works

```mermaid
flowchart LR
    UI["Browser dashboard"] --> WEB["Local web control plane"]
    WEB --> BROKER["Persistent PTY broker"]
    BROKER --> CLAUDE["Claude Code sessions"]
    WEB --> EVIDENCE["Read-only project evidence"]
    WEB --> HISTORY["Claude JSONL + process heartbeat"]
    WEB --> LEDGER["SQLite episodes + delivery outbox"]
    WEB --> CODEX["Ephemeral Codex boundary auditor"]
    WEB -. optional .-> QUEUE["Remote GPU queue"]
    QUEUE --> SCHEDULER["GPU Scheduler session"]
    QUEUE --> CLAUDE
```

### Evidence, not terminal guessing

FIRM derives session state from four independent signals:

1. the current terminal surface;
2. the latest main-chain Claude history event;
3. active descendant tool processes;
4. writes to a bounded set of research artifacts.

That distinction matters. A spinner with no history, artifact, or tool progress is not silently called “working.” A visible prompt while a child process drains is not silently called “stopped.”

### Safe continuation

Automatic Goal Loop injection is globally off by default. Each newly stopped episode is handed to the Research Session Resolver together with the current terminal episode, latest Claude response, active tools, construction lease, registered jobs, and the persistent research-authority block from the project's `CLAUDE.md`. Codex acts as another PI: it may answer a question, choose among options, recover interrupted work, schedule a recheck, or remain silent. Research decisions are autonomous; only external-rights actions such as credentials, payment, legal commitments, irreversible deletion, formal submission, or public release require owner authorization. Resolver transport failures remain visible and retry automatically instead of becoming silently resolved events.

An external iTerm message is not considered delivered merely because AppleScript pasted it. The Claude history must contain its unique `[FIRM DELIVERY ...]` marker. Uncertain sends are exposed instead of retried blindly.

### Codex Professor Engine

Codex is invoked as a short-lived, read-only boundary auditor, not a permanent co-PI session. Each audit starts from project authority and recent bounded evidence. It may flag identity, scope, evidence, compute, or operational drift. It may not prescribe a method, add a baseline, invent a paper framing, or turn ordinary uncertainty into a stop decision.

For deployments that use a separate portfolio-review scheduler, set `FIRM_SCAN_INTERVAL_MS=0` and `FIRM_CODEX_AUDIT_ENABLED=false`. This leaves FIRM responsible for session liveness, structured job state, and operational events while the external scheduler remains the single owner of periodic scientific review. Manual audit endpoints remain available when explicitly enabled.

The default re-anchor mode is `auto`: high-confidence, grounded interventions are delivered directly. This does not grant authority for external-rights actions, which remain explicit owner decisions.

## Optional GPU queue

## FIRM Job Registry

FIRM does not infer long-task truth from terminal prose, GPU utilization, or a temporarily quiet log. Every long-running GPU, local CPU, remote CPU, or SSH task has one durable `runId` and an explicit lifecycle: `pending -> running -> done | failed | cancelled`. Unknown liveness is observability metadata and never changes that lifecycle.

GPU requests enter the registry automatically through the existing queue. Other jobs use:

```bash
scripts/run-registered-job.sh RUN_ID PROJECT_ID local_cpu -- command arg...
scripts/run-registered-job.sh RUN_ID PROJECT_ID remote_cpu -- ssh host command...
scripts/run-registered-job.sh RUN_ID PROJECT_ID ssh -- ssh host command...
```

The API is available at `GET /api/jobs`, `POST /api/jobs`, and `POST /api/jobs/:runId/status`. The default list returns every active job plus the 25 most recently updated terminal jobs. Follow `page.nextCursor` with `?view=history&limit=25&cursor=...` to page through complete terminal history. Registered process updates are bound to PID, operating-system process start token, and an argv fingerprint, preventing PID reuse or a different command from claiming the same run. A research session waiting on authoritative work emits the single accepted marker `[FIRM WAITING_FOR_JOB run_id=<run_id>]`.

The local research dashboard works with GPU integration disabled, which is the public default. To connect your own SSH-accessible queue:

```bash
export FIRM_GPU_QUEUE_ENABLED=true
export FIRM_GPU_SCHEDULER_AUTO_START=true
export FIRM_GPU_QUEUE_HOST=user@gpu-control-host
export FIRM_GPU_QUEUE_SSH_PORT=22
export FIRM_GPU_QUEUE_ROOT=/absolute/remote/path/to/gpu_queue
export FIRM_GPU_QUEUE_DOCKER_CONTAINER=research-container
npm start
```

`scripts/submit-gpu-request.sh` reads these values from the environment or
`.env.local`. Optional `FIRM_GPU_QUEUE_ALLOWED_PROJECTS` and
`FIRM_GPU_QUEUE_PROJECT_ROOT` settings constrain which projects may submit work.

The queue uses explicit file signals:

```text
pending/.submitted → running/.started → done|failed|cancelled/.ready
```

Before enabling it, adapt the operational templates in `config/` to your scheduler and place the required scheduler governance files in the projects' common parent directory. FIRM only reads queue state over a fixed SSH collector. Your scheduler remains the sole owner of worker launch and termination.

An accepted registered-job wait requires both:

- the latest Claude assistant event declares `[FIRM WAITING_FOR_JOB run_id=<run_id>]`; and
- the Job Registry independently shows the same project-owned run as `pending` or `running`.

Completed, failed, missing, cross-project, or merely planned jobs never suppress liveness review.
An unrelated active job owned by the same project is informational only; it cannot make the current Claude turn a job wait without the exact matching marker. The legacy `WAITING_FOR_GPU` marker is not accepted.

## Configuration

Start from [.env.example](.env.example), but export variables in your shell or process manager; FIRM does not automatically load `.env` files.

| Variable | Default | Purpose |
|---|---:|---|
| `RESEARCH_PROJECT_ROOT` | `~/research` | Root used by `${RESEARCH_PROJECT_ROOT}` in project config |
| `FIRM_CONFIG` | `config/projects.json` | Project configuration file |
| `FIRM_HOST` | `127.0.0.1` | Local bind address |
| `FIRM_PORT` | `8787` | Dashboard port |
| `FIRM_SCAN_RETENTION` | `50` | Maximum bulky raw control-room snapshots retained locally |
| `FIRM_GPU_SNAPSHOT_RETENTION` | `200` | Maximum bulky raw GPU queue snapshots retained locally |
| `FIRM_BROKER_SOCKET` | `<data-dir>/control-plane/broker.sock` | Stable Unix socket for the persistent PTY broker |
| `FIRM_BROKER_AUTOSTART` | `true` | Development fallback; the macOS service sets this to `false` and uses a separate broker LaunchAgent |
| `FIRM_CODEX_AUDIT_ENABLED` | `true` | Enable isolated Codex audits |
| `FIRM_OPERATIONAL_RESOLVER_ENABLED` | `true` | Let Codex inspect every new stable Claude input episode and decide whether to respond |
| `FIRM_OPERATIONAL_RESOLVER_TIMEOUT_MS` | `600000` | Per-episode Research Session Resolver timeout; unresolved failures remain visible and retry |
| `FIRM_OPERATIONAL_RESOLVER_ATTEMPTS` | `2` | Immediate fresh-process attempts before durable backoff |
| `FIRM_OPERATIONAL_RESOLVER_MAX_CONCURRENCY` | `2` | Bounded resolver workers; prevents restart-time connection stampedes |
| `FIRM_OPERATIONAL_MESSAGE_COOLDOWN_MS` | `300000` | Minimum interval between AI messages to the same project |
| `FIRM_OPERATIONAL_MAX_MESSAGES_PER_HOUR` | `3` | Delivery safety budget per project; it does not constrain Codex's reasoning |
| `FIRM_SCAN_INTERVAL_MS` | `9000000` | Periodic audit interval (2.5 hours) |
| `FIRM_REANCHOR_MODE` | `auto` | `off`, `approval`, or `auto` |
| `FIRM_GOAL_LOOP_ENABLED` | `false` | Global kill switch for generic automatic continuation |
| `FIRM_GOAL_MAX_CONTINUES_PER_DAY` | `48` | Hard rolling 24-hour continuation limit per project |
| `FIRM_GPU_QUEUE_ENABLED` | `false` | Enable remote queue collection |
| `FIRM_GPU_SCHEDULER_AUTO_START` | `false` | Allow a configured scheduler target to start for new requests |
| `FIRM_DATA_DIR` | `./var` | Local runtime database, evidence, and transcripts |

See [src/config.js](src/config.js) for all bounded timing and executable overrides.

## Development

```bash
npm run check
npm test
npm run smoke
npm run acceptance:restart
```

The test suite covers broker/web restarts, timed-out clients disconnecting before a broker response, bounded SQLite history, delayed acknowledgements, interrupted sends, terminal noise, fast work cycles, collector degradation, GPU monitor loss, valid GPU waits, and duplicate-delivery prevention.

## Security model

- The server binds to localhost by default and has no multi-user authentication. Do not expose it directly to a network.
- Project collection is allowlisted and read-only; FIRM runtime data goes under `var/`.
- Web APIs select only configured projects, fixed executables, fixed arguments, and fixed working directories.
- Codex runs read-only and receives project/session text as untrusted evidence.
- Queue free text is never injected directly as a research instruction.
- The only normal Claude termination path is an explicit user stop action.
- `var/`, `work/`, local project configuration, logs, and environment files are excluded from Git.

## Status

FIRM is an early open-source release extracted from a real multi-project research workflow. It is built for local, supervised use and deliberately reports uncertain states instead of pretending to provide exactly-once control over external terminal applications.

Issues and focused pull requests are welcome.

## License

[MIT](LICENSE)
