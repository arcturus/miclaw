# 03 — Daemon Mode: Multi-Instance Workspace Isolation

**Date**: 2026-03-28
**Status**: Implemented
**Author**: arcturus, claude

---

## The Problem

miclaw runs as a single process: one config file, one soul, one memory directory, one set of sessions. If you want two agents — say, a work assistant and a code reviewer — you need two separate copies of the entire project, each in their own directory, each started manually. There's no way to manage multiple instances from a single command line, no process supervision, and no shared understanding of what's running where.

This is fine for learning how the framework works. It's not fine for actually using it.

## Design Decisions

### Why a Background Daemon, Not Direct Process Spawning

The simplest approach would be: `miclaw start <name>` spawns a background process directly (detached `spawn` + PID file), and `miclaw stop <name>` reads the PID file and sends SIGTERM. No daemon needed.

The problem is state coherence. With PID files alone:
- You can't tell if a process crashed (PID file exists but process is dead — stale PID)
- Listing running instances requires scanning PID files and sending signal 0 to each one
- There's no centralized place to detect port conflicts or enforce health checks
- Restart semantics (stop + start) require the CLI to handle races between stop completing and start beginning

A daemon process solves all of this. It holds the live `ChildProcess` handles, runs periodic health checks (signal 0 every 30 seconds), updates status on child exit events, and serializes start/stop operations. The daemon itself is lightweight — it's just a Unix socket server that dispatches JSON commands to methods on a `MiclawDaemon` class.

The daemon auto-starts on first CLI use (check PID → spawn detached if not running → wait for socket). Users never interact with the daemon directly.

### Why Unix Domain Socket, Not HTTP

The daemon needs a control plane for the CLI to send commands (start, stop, list). Options:

1. **HTTP on localhost** — works, but allocates a port. Port conflicts are already a concern with workspace instances; adding another port for the daemon makes it worse.
2. **Unix domain socket** (`~/.miclaw/daemon.sock`) — no port needed, naturally restricted to the local user (filesystem permissions), lower overhead than HTTP. The protocol is newline-delimited JSON, which is simple enough that it doesn't need HTTP's framing.
3. **Stdin/stdout IPC** — only works if the CLI is a child of the daemon, which it isn't. The CLI is a short-lived command that exits after each invocation.

Unix socket is the standard choice for local daemon control planes (Docker, systemd, PostgreSQL all use it). It's the right call here.

### Why Chat Via Web API, Not CLI Channel

The most natural-sounding design for `miclaw chat <name>` would be: pipe stdin/stdout between the terminal and the running instance's CLI channel. But the CLI channel (`channels/cli.ts`) is a blocking readline REPL that owns `process.stdin` and `process.stdout` directly. When an instance runs as a daemon child, its stdin is `/dev/null` and its stdout is piped to a log file. You can't "attach" a second terminal to an already-running readline.

The alternatives considered:

1. **Build a new IPC channel** — a custom stdin/stdout multiplexer or a dedicated socket per instance. Significant new code on both the daemon and instance side.
2. **Use the web channel's existing `/api/chat` endpoint** — each instance already runs a web server on localhost. `miclaw chat` is just a readline loop that POSTs JSON to `http://127.0.0.1:<port>/api/chat` and prints the response. Zero new server-side code.

Option 2 wins. It reuses all existing infrastructure: auth, rate limiting, session management, audit logging. The only requirement is that managed instances must have the web channel enabled — which the workspace template already enforces (web enabled on `127.0.0.1`, CLI disabled).

### Why Auto-Assigned Ports Starting at 3456

Each workspace instance needs its own web port. Manual port configuration is an unnecessary source of errors — users would need to remember to pick a unique port for each workspace. Instead:

- `miclaw init <name>` scans `workspaces.json` for used ports and assigns the next one starting from 3456
- The port is stored in the registry AND written into the workspace's `miclaw.json`
- `miclaw list` shows the port column so users know where each instance is accessible
- `127.0.0.1` binding only — these are internal ports, not exposed to the network

3456 was already the default web port in the existing single-instance mode. Incrementing from there (3457, 3458, ...) is predictable and unlikely to conflict with common services.

### Why ~/.miclaw/ for Everything

Workspace directories, daemon state, logs — everything lives under `~/.miclaw/`. Alternatives considered:

- **`~/miclaw-workspaces/`** — visible in home directory, but adds another top-level dot directory. Users already have dozens.
- **Current directory** — `miclaw init mybot` creates `./mybot/`. Flexible but messy: workspaces end up wherever you happen to run the command, making `miclaw list` unreliable.
- **XDG directories** — `$XDG_DATA_HOME/miclaw/` for data, `$XDG_STATE_HOME/miclaw/` for runtime. Correct by spec but splits state across multiple locations, making manual inspection harder.

`~/.miclaw/` is simple, self-contained, and follows the convention of tools like `~/.docker/`, `~/.npm/`, `~/.claude/`. All miclaw daemon state in one place.

### Why a Node.js Wrapper for the bin Entry Point

The CLI entry point (`src/cli.ts`) is TypeScript that needs `tsx` to run. The naive approach — `#!/usr/bin/env tsx` in the shebang — fails when `tsx` isn't globally installed. Since `tsx` is a devDependency (now promoted to dependency), it exists in `node_modules/.bin/tsx` but not necessarily in `$PATH`.

The solution is `bin/miclaw.mjs`: a plain Node.js script (`#!/usr/bin/env node`) that resolves `tsx` from the package's own `node_modules/.bin/` and `execFileSync`s it with `src/cli.ts`. This works with both `npm link` (local development) and `npm install -g` (global install) without requiring users to install tsx separately.

## What Changed

### New Files
- `src/cli.ts` — CLI entry point with all commands (init, start, stop, restart, list, status, logs, chat, kill)
- `src/daemon/types.ts` — type definitions and constants (paths, ports, IPC protocol)
- `src/daemon/workspace.ts` — workspace creation, registry management, port allocation
- `src/daemon/daemon.ts` — background daemon process with Unix socket server
- `src/daemon/client.ts` — socket client with auto-start logic
- `bin/miclaw.mjs` — Node.js wrapper for global install

### Modified Files
- `src/config.ts` — added `getPackageDir()` for template file resolution
- `src/index.ts` — added readiness signal when running as managed instance
- `package.json` — added `bin` field, moved `tsx` to dependencies

## Architecture Impact

The daemon layer is orthogonal to the existing four-layer hierarchy. It sits entirely at Layer 3 (Surface) and above — it never imports from Layer 2 or below. Each workspace instance runs the unmodified `src/index.ts` entry point with its own config path. The daemon is purely a process manager; it knows nothing about orchestrators, sessions, or Claude subprocesses.

```
Daemon Layer (new)
  miclaw CLI  ──Unix socket──>  Daemon Process
                                  │
                           spawn/kill children
                                  │
     ┌────────────────────────────┼────────────────────────────┐
     ▼                            ▼                            ▼
  Workspace A                 Workspace B                 Workspace C
  (index.ts + configA)        (index.ts + configB)        (index.ts + configC)
     │                            │                            │
  [existing 4-layer arch]      [existing 4-layer arch]      [existing 4-layer arch]
```

This means you can still run miclaw the old way (`npm start`) — nothing about the single-instance mode changed. The daemon is additive.
