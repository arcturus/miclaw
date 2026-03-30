# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is miclaw

A minimal agentic bot framework (~3,500 lines of TypeScript) that proxies to Claude Code's CLI. It wraps `claude -p` subprocess calls, adding personality (soul files), persistent sessions, scheduled tasks, self-learning, multi-channel delivery (CLI/Web/Telegram), and real-time security enforcement via NDJSON stream parsing. It does NOT reimplement tool execution — all tools are delegated to Claude Code natively.

## Commands

```bash
npm install           # install dependencies
npm start             # run with miclaw.json (default config)
npm start path.json   # run with custom config
npm run dev           # watch mode (tsx watch)
npm test              # run all tests (vitest run)
npx vitest run tests/runner.test.ts  # run a single test file
```

### Daemon CLI

```bash
miclaw init <name>              # create workspace at ~/.miclaw/workspaces/<name>/
miclaw start <name>             # start instance via daemon (auto-starts daemon)
miclaw start <name> --foreground # run in current terminal (no daemon)
miclaw stop <name>              # graceful stop
miclaw restart <name>           # stop + start
miclaw list                     # table of all instances with status/PID/port
miclaw status <name>            # detailed single-instance view
miclaw logs <name> [--follow]   # tail instance logs
miclaw chat <name>              # interactive REPL via web API
miclaw kill                     # stop all instances + daemon
```

Docker: `docker compose up -d --build` (uses `miclaw.docker.json` which binds to 0.0.0.0 and disables CLI channel).

## Architecture

Four-layer import hierarchy — imports go down only, no circular dependencies:

- **Layer 3 (Surface):** `index.ts`, `cli.ts`, `channels/cli.ts`, `channels/web.ts`, `channels/telegram.ts`, `cron.ts`, `tunnel.ts`
- **Layer 2 (Coordination):** `orchestrator.ts`, `session.ts`, `learner.ts`
- **Layer 1 (Core):** `runner.ts`, `soul.ts`, `memory.ts`, `skills.ts`
- **Layer 0 (Types):** `types.ts`, `config.ts`
- **Daemon (orthogonal):** `daemon/daemon.ts`, `daemon/client.ts`, `daemon/workspace.ts`, `daemon/types.ts`

### Message flow

Channel receives input → `orchestrator.handleMessage()` validates, resolves session, assembles system prompt (soul + memory + skills + agent directory), spawns `claude -p --output-format stream-json` via `ClaudeRunner` → runner parses NDJSON in real time with security enforcement (path/URL checks, kills process on violation) → orchestrator checks for delegation blocks (if `interAgentDelegation: true`) and executes them → orchestrator updates session, writes journal, optionally triggers learner reflection → channel delivers response.

### Key design decisions

- **File-based state everywhere**: sessions (`sessions/sessions.json`), memory (`memory/`), learnings (`memory/learnings.md`), journals (`memory/journals/`), audit logs (`logs/audit.jsonl`). No database.
- **Proxy pattern**: miclaw never calls the Claude API directly. It spawns `claude -p` as a child process and communicates via NDJSON streams.
- **Per-session serialization locks** in Orchestrator prevent concurrent `--resume` corruption.
- **ProcessPool** bounds concurrent Claude subprocesses (default: 5 concurrent, 20 queued).
- **Security profiles per channel**: CLI gets full trust; Web/Telegram are restricted (read-only tools, rate limited, audit logged). Configured in `miclaw.json` under `channels.*.security`.
- **Config merging**: user config deep-merges over defaults in `config.ts`. Supports `${ENV_VAR}` substitution in string values.
- **Daemon mode**: `cli.ts` manages multiple isolated instances via a background daemon process. Each workspace (`~/.miclaw/workspaces/<name>/`) has its own config, soul, memory, and sessions. The daemon communicates over a Unix domain socket (`~/.miclaw/daemon.sock`). `miclaw chat` connects to instances via their auto-assigned web API port (starting at 3456). The daemon auto-starts on first CLI use.

### Content-driven configuration

- **Soul** (`soul/`): Markdown files (AGENTS.md, SOUL.md, IDENTITY.md, TOOLS.md) concatenated into the system prompt.
- **Skills** (`skills/<name>/SKILL.md`): Markdown with YAML frontmatter. Gate on `requires.bins`, `requires.env`, `requires.os` — silently excluded if prerequisites aren't met.
- **Agents** (`agents.json`): Each agent specifies its own soul dir, skills, model, tool restrictions, and optionally its own `memoryDir` for isolated memory/journals/learnings. Agents with `skills: ["skill-a"]` only get those skills in their prompt (empty array = all skills). Registered agents are listed in each other's system prompts for discovery.
- **Cron** (`cron/jobs.json`): Scheduled tasks with template variables (`{{DATE}}`, `{{JOURNALS_LAST_N}}`). A `learning-consolidation` job is auto-registered when `learning.enabled: true`.

### Multi-agent configuration

Create `agents.json` in the project root to register multiple agents:

```json
{
  "code-reviewer": {
    "description": "Reviews pull requests and code quality",
    "soulDir": "./souls/reviewer",
    "skills": ["github-pr"],
    "model": "sonnet",
    "allowedTools": ["Read", "Glob", "Grep", "WebFetch"],
    "memoryDir": "./memory/reviewer"
  },
  "researcher": {
    "description": "Deep research agent for investigation tasks",
    "soulDir": "./souls/researcher",
    "skills": ["web-search"],
    "model": "opus",
    "memoryDir": "./memory/researcher"
  }
}
```

**Key fields:**
- `skills`: Array of skill names to include (empty = all skills). Maps to skills in `skillsDir`.
- `memoryDir`: Optional isolated memory directory. If omitted, shares the default `memoryDir`.
- `interAgentDelegation`: Set to `true` in `miclaw.json` to enable agents delegating tasks to each other via ` ```delegate ` blocks. Max 1 delegation per turn, depth 1 (no chains).

## Testing

Tests use vitest with mocked subprocesses (no actual Claude API calls). Each test file mirrors a source module. Tests create temporary directories for file-based state and clean up in `afterEach`. Run a single test: `npx vitest run tests/<module>.test.ts`.

## TypeScript

- ES modules (`"type": "module"` in package.json)
- Target ES2022, module resolution Node16
- Strict mode enabled
- Executed directly via `tsx` (no build step needed for dev)
