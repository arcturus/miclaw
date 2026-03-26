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

Docker: `docker compose up -d --build` (uses `miclaw.docker.json` which binds to 0.0.0.0 and disables CLI channel).

## Architecture

Four-layer import hierarchy — imports go down only, no circular dependencies:

- **Layer 3 (Surface):** `index.ts`, `channels/cli.ts`, `channels/web.ts`, `channels/telegram.ts`, `cron.ts`, `tunnel.ts`
- **Layer 2 (Coordination):** `orchestrator.ts`, `session.ts`, `learner.ts`
- **Layer 1 (Core):** `runner.ts`, `soul.ts`, `memory.ts`, `skills.ts`
- **Layer 0 (Types):** `types.ts`, `config.ts`

### Message flow

Channel receives input → `orchestrator.handleMessage()` validates, resolves session, assembles system prompt (soul + memory + skills), spawns `claude -p --output-format stream-json` via `ClaudeRunner` → runner parses NDJSON in real time with security enforcement (path/URL checks, kills process on violation) → orchestrator updates session, writes journal, optionally triggers learner reflection → channel delivers response.

### Key design decisions

- **File-based state everywhere**: sessions (`sessions/sessions.json`), memory (`memory/`), learnings (`memory/learnings.md`), journals (`memory/journals/`), audit logs (`logs/audit.jsonl`). No database.
- **Proxy pattern**: miclaw never calls the Claude API directly. It spawns `claude -p` as a child process and communicates via NDJSON streams.
- **Per-session serialization locks** in Orchestrator prevent concurrent `--resume` corruption.
- **ProcessPool** bounds concurrent Claude subprocesses (default: 5 concurrent, 20 queued).
- **Security profiles per channel**: CLI gets full trust; Web/Telegram are restricted (read-only tools, rate limited, audit logged). Configured in `miclaw.json` under `channels.*.security`.
- **Config merging**: user config deep-merges over defaults in `config.ts`. Supports `${ENV_VAR}` substitution in string values.

### Content-driven configuration

- **Soul** (`soul/`): Markdown files (AGENTS.md, SOUL.md, IDENTITY.md, TOOLS.md) concatenated into the system prompt.
- **Skills** (`skills/<name>/SKILL.md`): Markdown with YAML frontmatter. Gate on `requires.bins`, `requires.env`, `requires.os` — silently excluded if prerequisites aren't met.
- **Agents** (`agents.json`): Each agent specifies its own soul dir, skills, model, and tool restrictions.
- **Cron** (`cron/jobs.json`): Scheduled tasks with template variables (`{{DATE}}`, `{{JOURNALS_LAST_N}}`). A `learning-consolidation` job is auto-registered when `learning.enabled: true`.

## Testing

Tests use vitest with mocked subprocesses (no actual Claude API calls). Each test file mirrors a source module. Tests create temporary directories for file-based state and clean up in `afterEach`. Run a single test: `npx vitest run tests/<module>.test.ts`.

## TypeScript

- ES modules (`"type": "module"` in package.json)
- Target ES2022, module resolution Node16
- Strict mode enabled
- Executed directly via `tsx` (no build step needed for dev)
