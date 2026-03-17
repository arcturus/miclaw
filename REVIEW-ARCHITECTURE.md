# Architecture Review: mikeclaw

**Reviewer**: Senior Software Architect
**Date**: 2026-03-17
**Documents reviewed**: `ARCHITECTURE.md` (v1.0.0), original plan at `~/.claude/plans/rosy-seeking-puzzle.md`

---

## 1. Completeness

### What is covered well

The architecture doc is impressively thorough for a pre-implementation spec. It covers all 13 sections with concrete TypeScript interfaces, ASCII diagrams, step-by-step data flows, and even cost analysis for the learning system. The gap between the original plan and the architecture doc is small — the architecture doc faithfully expands every phase from the plan into implementable detail.

### Gaps between plan and architecture

**Missing: `maxConcurrentProcesses` in `MikeClawConfig`**. Section 6.6 mentions a configurable `maxConcurrentProcesses` (default: 5) with a bounded queue, but this field does not appear in the `MikeClawConfig` interface (Section 5.7). It also has no corresponding environment variable override in Appendix C. This is a concurrency-critical config value that should be in the interface.

**Missing: Logging strategy**. The doc repeatedly says "log stderr as warning", "log full stderr", "log error" — but there is no logging interface, no log levels, no log destination configuration. For a system that spawns multiple concurrent subprocesses, observability is critical from day one.

**Missing: Startup validation**. The doc says ConfigError is thrown on startup (fail fast), but there is no description of what gets validated. Does it check that `claude` is on PATH? That soul files exist? That `sessions.json` is parseable? A startup checklist would prevent confusing runtime errors.

**Missing: `ephemeral` flag on `MessageInput`**. Section 4.3 (Cron Job Trigger) shows `ephemeral: true` being passed to `orchestrator.handleMessage()`, but the `MessageInput` interface (Section 5.1) has no `ephemeral` field. The orchestrator needs this to know whether to persist the session.

**Missing: Inter-agent messaging detail**. The plan mentions "file-based inbox/outbox per session" for Phase 4, but the architecture doc provides no interface for this. No `Inbox`, no `Outbox`, no message routing protocol between agents. This is fine if Phase 4 is truly deferred, but it should be acknowledged as an open design question.

**Plan divergence: Web framework choice**. The original plan says `src/channels/web.ts` uses "Express/Fastify HTTP server" and later "Express or bare `node:http`". The architecture doc commits to bare `node:http`. This is fine as a decision, but the plan's mention of Express should be reconciled — either remove it from the plan or document the decision rationale in the architecture doc.

---

## 2. Layering & Dependencies

### The 4-layer model is sound

The layered architecture (Types -> Core -> Coordination -> Surface) with strict downward-only imports is a good design. The explicit import map in Section 3 is excellent — it makes dependency violations immediately visible during code review.

### The circular dependency prevention rules are well-thought-out

The four rules (orchestrator never imports channels, learner never imports orchestrator, session never imports runner, agent registry is Layer 1) are the right constraints. Rule 2 — learner having its own ClaudeRunner instance — is particularly good because it prevents the learner from accidentally coupling to the orchestrator's lifecycle.

### Risk: Orchestrator as god object

The orchestrator imports 7 modules: `runner.ts`, `soul.ts`, `memory.ts`, `skills.ts`, `session.ts`, `learner.ts`, `agents/registry.ts`. It is responsible for:

- Soul assembly
- Memory injection
- Skill loading
- Session management bridging
- Runner dispatch
- Journal writing
- Learning triggering
- Agent resolution

This is a classic "mediator that knows too much" pattern. Today it is manageable because each responsibility is a single method call. But as features accrete (Phase 4 inter-agent messaging, streaming support, middleware hooks), the orchestrator will become the place where everything goes to grow.

**Recommendation**: Consider splitting the orchestrator into two concerns:

```typescript
// PromptAssembler: pure function, no side effects
class PromptAssembler {
  constructor(soul: SoulLoader, memory: MemoryManager, skills: SkillLoader) {}
  assemble(agentId: string): string { /* ... */ }
}

// Orchestrator: coordination only
class Orchestrator {
  constructor(
    private assembler: PromptAssembler,
    private runner: ClaudeRunner,
    private sessions: SessionManager,
    private learner: Learner,
    private agents: AgentRegistry,
  ) {}
  async handleMessage(input: MessageInput): Promise<MessageOutput> { /* ... */ }
}
```

This keeps the assembler testable in isolation (pass in mock loaders, assert output string) and prevents the orchestrator from accumulating prompt-formatting logic.

### Hidden coupling risk: Memory file contention

Three writers can modify `memory/learnings.md` concurrently:

1. The Learner (Mechanism 1: post-turn reflection)
2. The consolidation cron job (Mechanism 2, via Claude's file tools)
3. The agent itself during a conversation (Mechanism 3, via Claude's file tools)

The architecture doc mentions file locks on `sessions.json` (Section 6.6) but says nothing about locking `learnings.md`. Since Mechanisms 2 and 3 both use Claude Code's built-in file tools (which have no awareness of mikeclaw's file locks), a cron consolidation could overwrite learnings that the Learner just appended.

**Recommendation**: Either:
- Make `learnings.md` append-only from mikeclaw's side and let only the consolidation cron do rewrites (which already has exclusive access as a single cron job with the concurrency guard), OR
- Use a lockfile (`learnings.md.lock`) with `proper-lockfile` or `fs.open` with `O_EXCL` for the Learner's writes, and document that cron consolidation should check for this lock.

---

## 3. Interface Design

### Strengths

- The `ClaudeJsonOutput` interface (Section 5.2) documents the exact shape of `claude -p --output-format json` output, including all optional fields. This is critical for a proxy system — knowing your upstream contract.
- The `Channel` interface is minimal and correct. The `send()` method returning `Promise<boolean>` is a nice touch for handling unreachable users.
- The `Session` interface has a `metadata: Record<string, unknown>` escape hatch for channel-specific data, which is good foresight.

### Issues

**`MessageInput` is missing `ephemeral`**. As noted above, the cron flow depends on this field but the interface does not define it. Add:

```typescript
interface MessageInput {
  // ... existing fields ...
  /** If true, session is not persisted. Used by cron jobs. */
  ephemeral?: boolean;
}
```

**`ClaudeRunnerOptions.resume` and `appendSystemPrompt` mutual exclusivity is not enforced**. The doc says `resume` is "mutually exclusive with sessionId" and `systemPrompt` is "mutually exclusive with appendSystemPrompt" — but TypeScript interfaces cannot enforce mutual exclusivity. In practice, someone will pass both `resume` and `appendSystemPrompt` and wonder why the system prompt is ignored (see Section 4 below). Consider a discriminated union:

```typescript
type ClaudeRunnerOptions =
  | NewSessionOptions & { resume?: never }
  | ResumeSessionOptions & { systemPrompt?: never; appendSystemPrompt?: never };
```

Or, more practically, validate at runtime in `ClaudeRunner.run()` and throw if conflicting options are passed.

**`CronJob.broadcastTarget` format is stringly-typed**. The format `"<channelName>:<userId>"` is documented only in a comment. This should be a structured type:

```typescript
interface BroadcastTarget {
  channel: string;
  userId: string;
}
```

**`SessionStore.version` has no migration strategy**. The doc defines `version: number` for forward compatibility but says nothing about what happens when the code expects version 2 and finds version 1 on disk. Define the migration contract now, even if it is just "if version < CURRENT_VERSION, wipe and start fresh with a logged warning."

**`SkillDefinition.requires.os` is a single string**. This means a skill cannot target both Linux and macOS. Should be `os?: string[]`.

---

## 4. Claude CLI Integration

This is the most critical section of the architecture and the area with the most risk, since the entire system depends on an external CLI tool's behavior.

### `--append-system-prompt` with `--resume`: This likely does not work as expected

Section 6.2 shows the "Resumed session" command using both `--resume` and `--append-system-prompt`:

```bash
claude -p \
  --output-format json \
  --resume abc-123-def-456 \
  --append-system-prompt "## Soul\nYou are mikeclaw...\n\n## Memory\n..." \
  "Tell me more about that."
```

**This is the single biggest risk in the architecture.** When you resume a Claude Code session, the session already has a system prompt baked in from the original invocation. The behavior of `--append-system-prompt` on a resumed session is undefined in public documentation. There are three possibilities:

1. **It appends again** (doubling the soul prompt on every turn) — causes context window bloat and contradictory instructions.
2. **It replaces the appended portion** — this is the desired behavior but is not guaranteed.
3. **It is silently ignored** — the agent loses personality/memory updates after the first turn.

**Recommendation**: Before building anything, write a test script:

```bash
# Turn 1
claude -p --output-format json --append-system-prompt "Your name is TestBot." "What is your name?"
# Note the session_id

# Turn 2
claude -p --output-format json --resume <session_id> --append-system-prompt "Your name is ChangedBot." "What is your name now?"
# Does it say TestBot or ChangedBot?

# Turn 3
claude -p --output-format json --resume <session_id> "What is your name now?"
# Without --append-system-prompt, what happens?
```

If `--append-system-prompt` does not work with `--resume`, the entire session continuity model breaks. Fallback strategies:

- **Option A: Stateless sessions**. Do not use `--resume` at all. Instead, replay conversation history as part of the user message. This is expensive but guaranteed to work. The soul prompt is fresh every time.
- **Option B: Summary injection**. Use `--resume` for Claude Code's session continuity but inject updated memory/learnings as part of the user message, not the system prompt: `"[System update: your latest learnings are...]\n\nUser's actual message: ..."`. Ugly but functional.
- **Option C: Session rotation**. Start a new session after N turns (e.g., 10) or when memory changes significantly. Pass a summary of the previous conversation as context in the new session's system prompt.

### Context window overflow on long-running sessions

The architecture doc does not address what happens when a resumed session's context window fills up. Claude Code sessions accumulate all tool calls, file contents, and responses. A session with 50 turns of tool-heavy interactions could easily exceed the context window.

`claude -p` will likely return `subtype: "error_max_turns"` or simply degrade in quality. The architecture doc handles `error_max_turns` in the `ClaudeJsonOutput` interface but does not describe recovery.

**Recommendation**: Add session rotation logic to the orchestrator:

```typescript
// In orchestrator.handleMessage():
if (session.turnCount > MAX_TURNS_PER_SESSION || session.claudeSessionAge > MAX_SESSION_AGE_MS) {
  // Start a new Claude session, inject summary of previous conversation
  session.claudeSessionId = null;
  session.turnCount = 0;
}
```

This should be a configurable threshold (e.g., `maxTurnsPerSession: 20` in config).

### Concurrent `claude -p` processes with the same session ID

Section 6.6 says "Each process has its own session ID and operates on independent state." But what if two messages arrive for the same user in quick succession? The orchestrator would try to `--resume` the same Claude session ID twice concurrently. Claude Code likely does not support this — session state is file-based internally and concurrent writes would corrupt it.

**Recommendation**: Add per-session locking. A simple approach:

```typescript
class Orchestrator {
  private sessionLocks = new Map<string, Promise<void>>();

  async handleMessage(input: MessageInput): Promise<MessageOutput> {
    const sessionKey = `${input.channelId}:${input.userId}`;
    const prev = this.sessionLocks.get(sessionKey) ?? Promise.resolve();
    const current = prev.then(() => this._doHandleMessage(input));
    this.sessionLocks.set(sessionKey, current.then(() => {}, () => {}));
    return current;
  }
}
```

This serializes messages for the same session while allowing different sessions to run in parallel.

### Claude Code version changes breaking JSON output format

The `ClaudeJsonOutput` interface hardcodes the current output format. If Claude Code adds, renames, or removes fields, the parser breaks silently (missing fields) or loudly (parse errors).

**Recommendation**: Parse defensively with runtime validation. Use `zod` or a simple manual check:

```typescript
function parseClaudeOutput(raw: string): ClaudeRunnerResult {
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return { ok: false, error: "malformed JSON", ... }; }

  if (typeof json !== "object" || json === null) return { ok: false, ... };
  const obj = json as Record<string, unknown>;

  // Required fields with fallbacks
  const result = typeof obj.result === "string" ? obj.result : String(obj.result ?? "");
  const sessionId = typeof obj.session_id === "string" ? obj.session_id : "";

  // Don't crash on missing optional fields
  const cost = typeof obj.cost_usd === "number" ? obj.cost_usd : undefined;
  // ...
}
```

Also pin Claude Code to a version range in documentation and add a startup check: `claude --version` parsed and compared against a known-compatible range.

### Rate limiting from Anthropic API

The architecture doc does not address Anthropic API rate limits. When `claude -p` hits a rate limit, it may retry internally (Claude Code has built-in retry logic) or it may fail with a specific error. The architecture should:

1. Document what `claude -p` does when rate-limited (does it retry? does it return an error JSON?).
2. Add backoff logic at the mikeclaw level for burst scenarios (e.g., cron job fires + 3 users chatting simultaneously).
3. Consider the `maxConcurrentProcesses` limit as a crude rate limiter and set its default based on the API tier.

---

## 5. Session Management

### File-based JSON is appropriate for MVP

For a single-node bot framework, `sessions.json` is fine. The atomic write pattern (write to `.tmp`, rename) is correct for crash safety on POSIX.

### Race conditions with concurrent writes

The doc mentions "file locks on `sessions.json`" in Section 6.6 but does not specify the locking mechanism. Node.js `fs.rename` is atomic, but the read-modify-write cycle is not. Two concurrent requests could both read the same `sessions.json`, make different modifications, and one would overwrite the other.

**Recommendation**: Use an in-memory `Map<string, Session>` as the primary store with periodic flush to disk, rather than reading from disk on every access:

```typescript
class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private dirty = false;

  async getOrCreate(channelId: string, userId: string, agentId: string): Promise<Session> {
    const key = `${channelId}:${userId}:${agentId}`;
    if (!this.sessions.has(key)) {
      this.sessions.set(key, createNewSession(key, channelId, userId, agentId));
      this.dirty = true;
    }
    return this.sessions.get(key)!;
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    await atomicWriteJson(this.sessionsPath, { version: 1, sessions: Object.fromEntries(this.sessions) });
    this.dirty = false;
  }
}
```

Flush on every write (after `update()`), on a timer (every 30s), and on shutdown. This eliminates read-modify-write races entirely because the in-memory map is the source of truth.

### Session cleanup / garbage collection

The doc does not describe when old sessions are cleaned up. A bot running for months will accumulate thousands of sessions in `sessions.json`. Claude Code's internal session files will also accumulate on disk.

**Recommendation**: Add a `sessionTtlDays` config option (default: 30). On startup and periodically (daily cron or in-process timer), scan sessions and remove any with `lastActiveAt` older than the TTL. Also consider cleaning up Claude Code's session files (likely stored in `~/.claude/` or similar).

---

## 6. Self-Learning

### Is the haiku reflection call worth the cost/latency?

At ~$0.00025 per reflection and ~1-3 seconds latency, the per-turn cost is trivial but the latency is not. If learning reflection is fire-and-forget (as Section 6.6 suggests), the latency does not affect user experience. But it does mean:

- An extra `claude -p` process spawns after every turn (when `afterEveryTurn: true`).
- Each reflection consumes one of the `maxConcurrentProcesses` slots.
- If the user sends rapid messages, reflections pile up.

**Recommendation**: The default of `afterEveryTurn: false` is correct. But the doc should also describe a batching strategy: instead of reflecting after every turn, accumulate the last N turns in memory and reflect once per session close or after N turns (e.g., every 5 turns). This reduces process spawning by 5x while capturing the same information.

### Deduplication is fragile

The substring + Levenshtein approach (Section 8.5) will miss semantic duplicates. "User prefers TypeScript" and "The user likes TypeScript over JavaScript" are clearly related but would not be caught by substring matching and would have a high normalized Levenshtein distance.

However, this is explicitly acknowledged: "This is a conservative, cheap heuristic. The consolidation cron job performs deeper deduplication using Claude itself." This is an acceptable layered strategy — fast-but-imperfect for real-time, thorough-but-expensive for batch.

### Learnings can grow unbounded between consolidations

If the consolidation cron fails (Claude CLI error, process crash, cron skipped) and `afterEveryTurn: true`, learnings will accumulate indefinitely. The `maxLearningEntries` field exists in the config interface but its behavior is not described anywhere.

**Recommendation**: Define the behavior explicitly. When `learnings.md` exceeds `maxLearningEntries`:
- Option A: Stop adding new learnings until consolidation runs (safe, might miss insights).
- Option B: Trigger an immediate consolidation (self-healing but potentially expensive).
- Option C: Drop the oldest entries to make room (lossy but bounded).

I would recommend Option A with a warning log.

---

## 7. Cron System

### `node-cron` is fine but has limitations

`node-cron` is a reasonable choice for an in-process scheduler. It is lightweight, well-maintained, and has no native dependencies. However:

**Missed jobs on process restart**: `node-cron` is purely in-memory. If the process restarts at 2:05 AM, the 2:00 AM consolidation job is simply missed. The doc does not address this.

**Recommendation**: On startup, check the last run time of each job (store in `cron/state.json`). If a job was supposed to run since the last shutdown, run it immediately (or within a configurable grace period). This is similar to anacron's behavior:

```typescript
interface CronJobState {
  lastRunAt: string; // ISO 8601
  lastRunResult: "success" | "error";
}

// On startup:
for (const job of enabledJobs) {
  const state = jobStates[job.id];
  if (state && missedSinceLastRun(job.schedule, state.lastRunAt)) {
    logger.info(`Job ${job.id} missed during downtime, running now`);
    await this.runNow(job.id);
  }
}
```

**Timezone handling**: `node-cron` uses the system timezone by default. If the server moves between timezones (cloud deployment, container migration), cron schedules shift. The `CronJob` interface has no `timezone` field.

**Recommendation**: Add an optional `timezone` field to `CronJob` and a global `cron.timezone` in config. `node-cron` supports timezone via its options parameter.

### Alternative: `croner`

The doc mentions `croner` as a fallback. `croner` is actually the better choice overall — it is ESM-native, has built-in timezone support, supports `catch-up` for missed executions, and has a smaller dependency footprint. Consider making it the primary choice.

---

## 8. Web Channel

### Bare `node:http` is sufficient for MVP but will become painful quickly

For Phase 1 with 3 routes, bare `node:http` works. But the moment you add:
- Authentication middleware
- Request body parsing (currently manual JSON.parse of request body)
- Content-Type validation
- Path parameter extraction (`/api/sessions/:id`)
- Error handling middleware
- Streaming (SSE)

...you will be reimplementing Express poorly. The path parameter route (`GET /api/sessions/:id`) already requires manual URL parsing with `node:http`.

**Recommendation**: Use Fastify from the start. It adds ~200KB to `node_modules`, has TypeScript-first support, built-in JSON schema validation, and is faster than Express. The setup cost is nearly identical to bare `node:http`:

```typescript
import Fastify from "fastify";
const app = Fastify();

app.post("/api/chat", async (req, reply) => {
  const { message, userId, agentId } = req.body as ChatRequest;
  const result = await orchestrator.handleMessage({ channelId: "web", userId, message, agentId });
  return result;
});

await app.listen({ port: config.channels.web.port, host: config.channels.web.host });
```

### CORS implementation has a bug

Section 10.4 shows:

```typescript
"Access-Control-Allow-Origin": config.channels.web.corsOrigins?.join(",") ?? "*",
```

The `Access-Control-Allow-Origin` header does not support comma-separated origins. It must be either `*` or a single specific origin. To support multiple origins, you must check the request's `Origin` header against the whitelist and reflect back the matching origin:

```typescript
const requestOrigin = req.headers.origin;
const allowedOrigins = config.channels.web.corsOrigins ?? ["*"];
const corsOrigin = allowedOrigins.includes("*")
  ? "*"
  : allowedOrigins.includes(requestOrigin) ? requestOrigin : "";
```

### WebSocket vs SSE for streaming

The doc mentions SSE for future streaming (`GET /api/chat/stream`). SSE is the right choice here:
- Unidirectional (server -> client) which matches the response streaming use case.
- Works through HTTP proxies and CDNs without special configuration.
- Auto-reconnects natively in the browser via `EventSource`.
- No additional dependency needed.

WebSocket would only be needed if bidirectional real-time communication is required (e.g., collaborative editing, typing indicators). For a chat bot, SSE is sufficient.

### Authentication is absent

The doc acknowledges in Appendix A that client-provided `userId` is spoofable. But there is no Phase where authentication is added. For a local-only tool, this is fine. For any networked deployment, it is a security hole.

**Recommendation**: Add a `web.auth` config section supporting at minimum a static API key:

```typescript
web: {
  auth: {
    type: "none" | "api-key" | "jwt";
    apiKey?: string; // checked against X-API-Key header
  }
}
```

This can be implemented in 20 lines of middleware and prevents drive-by abuse.

---

## 9. Error Handling

### Strengths

The error type hierarchy (`MikeClawError` -> `RunnerError`, `SessionError`, `ConfigError`) is clean. The per-scenario tables in Section 11.3 and 11.5 are thorough. The session corruption recovery flow (Section 11.4) with atomic writes and `.tmp`/`.bak` fallback is production-grade thinking for an MVP.

### Missing error types

- **`MemoryError`**: mentioned in Section 11.1 ("Catches runner/session/memory errors") but not defined in Section 11.2. What happens when `MEMORY.md` is missing? When a journal file is corrupt? When `learnings.md` cannot be written?
- **`SoulError`**: same — mentioned in Layer 1 but not defined. What if `AGENTS.md` is missing (required file) vs. `IDENTITY.md` (optional)?
- **`SkillError`**: mentioned but not defined. Malformed YAML frontmatter? Missing required binary?
- **`CronError`**: not mentioned at all. What error wraps a failed cron job for logging?

**Recommendation**: Define all four. They can be simple subclasses:

```typescript
class MemoryError extends MikeClawError {
  constructor(message: string, code: "MEMORY_READ" | "MEMORY_WRITE" | "MEMORY_CORRUPT") {
    super(message, code);
  }
}
```

### The "auto-retry once without `--resume`" is risky

Section 11.3 says: "Session expired / invalid resume ID → Clear `claudeSessionId` from session, retry as new session." This means the user's message is sent twice — once with `--resume` (fails) and once without (succeeds). But the second attempt creates a brand new session, losing all conversation context. The user will notice: "Why did you forget everything we talked about?"

**Recommendation**: When the resume fails, inform the user: "Your session has expired. Starting a new conversation." Do not silently retry — the context loss changes the user's experience and they should know why.

---

## 10. Scalability Concerns

Even for a "minimal" system, some design decisions would make future scaling painful:

### Single `sessions.json` file

Every session read/write hits a single file. With 1,000 concurrent users, the in-memory map (recommended above) becomes the right approach. But if you ever want multi-process (e.g., PM2 cluster mode), the in-memory map does not work. Future migration path: SQLite (single-file, no server, supports concurrent readers via WAL mode). Design the `SessionManager` behind an interface so the storage backend can be swapped.

### System prompt grows linearly with memory

As `MEMORY.md` and `learnings.md` grow, the system prompt grows, consuming more of the context window and increasing API cost per request. The 100,000 character target (Section 7.5) is generous — that is roughly 25,000 tokens of system prompt on every single request.

**Recommendation**: Set a more aggressive default target (e.g., 20,000 characters / ~5,000 tokens). Memory should be summarized, not dumped verbatim. The consolidation cron should have a hard character budget for `MEMORY.md`.

### No message queue

The current design handles backpressure via `maxConcurrentProcesses` with "excess requests queue with a bounded buffer." But there is no actual queue implementation described. What data structure is the buffer? What happens when it is full — drop the request? Return 503?

**Recommendation**: Use a simple in-process queue with explicit overflow behavior:

```typescript
class BoundedQueue<T> {
  private queue: Array<{ item: T; resolve: (v: any) => void; reject: (e: any) => void }> = [];
  constructor(private maxSize: number) {}

  enqueue(item: T): Promise<any> {
    if (this.queue.length >= this.maxSize) {
      return Promise.reject(new MikeClawError("Queue full", "QUEUE_OVERFLOW"));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ item, resolve, reject });
    });
  }
}
```

---

## 11. Alternative Approaches

### Session continuity without `--resume`

If `--append-system-prompt` does not work with `--resume` (see Section 4), the entire session model needs rethinking. The most robust alternative:

**Stateless sessions with conversation summary**: Every request is a new `claude -p` invocation. The orchestrator maintains a conversation history in the session object. Before each call, the last N messages (or a summary) are prepended to the user's message. This is more expensive (larger prompts) but eliminates all `--resume` concerns.

```typescript
// Instead of --resume, inject conversation context:
const conversationContext = session.recentMessages
  .map(m => `${m.role}: ${m.content}`)
  .join("\n\n");

runner.run({
  message: `## Previous conversation:\n${conversationContext}\n\n## Current message:\n${input.message}`,
  appendSystemPrompt: assembledSoul,
});
```

### File-based memory vs. structured storage

The all-markdown approach is charming and inspectable, but it makes programmatic queries impossible. "What did the user say about TypeScript three weeks ago?" requires either Claude reading all journals or a human grepping files.

**Alternative**: Alongside markdown files, maintain a lightweight SQLite database with structured entries:

```sql
CREATE TABLE learnings (id INTEGER PRIMARY KEY, category TEXT, content TEXT, learned_at TEXT);
CREATE TABLE journal_entries (id INTEGER PRIMARY KEY, date TEXT, role TEXT, content TEXT, session_id TEXT);
```

The markdown files remain the human-readable view. The database enables programmatic queries, deduplication, and selective retrieval (e.g., "retrieve only TypeScript-related learnings for the system prompt").

This is a Phase 2+ enhancement, not an MVP requirement. But designing the `MemoryManager` interface to support it from the start (by abstracting behind methods like `queryLearnings(filter)` rather than raw file reads) would make the migration painless.

---

## 12. Praise

### The proxy pattern is the single best design decision

By building entirely on top of `claude -p`, mikeclaw avoids:
- Maintaining an LLM client
- Implementing tool execution
- Managing MCP server lifecycles
- Handling API authentication
- Dealing with streaming protocols
- Tracking Claude Code feature updates

This is a genuinely elegant architectural insight. It reduces the codebase by an estimated 70-80% compared to building a standalone agent framework. The doc's explanation in Section 1 ("Why We Do Not Reimplement Tools") is clear and well-reasoned.

### The layered architecture with explicit import map

Most projects this size do not bother with a formal dependency graph. The fact that the architecture doc specifies every legal import relationship means circular dependencies can be caught in code review without tooling. This discipline will pay dividends as the codebase grows.

### The soul assembly pipeline is well-designed

The deterministic file reading order (Section 7.1), the section header format (Section 7.4), and the truncation priority (Section 7.5) are all thoughtfully designed. The truncation priority is particularly good — journals first, soul never. This ensures the bot always maintains its personality even when context is tight.

### The self-learning cost analysis

Estimating the per-reflection cost (~$0.00025) and the per-session cost (~$0.005) shows mature thinking about operational costs. Many architecture docs handwave this.

### Atomic session writes

The write-to-temp-then-rename pattern for `sessions.json` is the right approach and shows awareness of real-world failure modes. The recovery cascade (check `.tmp`, check `.bak`, start fresh, preserve corrupt file for debugging) is thorough.

### The Channel interface is minimal and correct

Four methods (`start`, `stop`, `onMessage`, `send`), no more. The `send` method enables bidirectional communication (needed for cron broadcast) without overcomplicating the interface. The extension point documentation (Section 13.1) shows exactly how to add a new channel in ~30 lines.

### The cron-as-messages pattern

Routing cron jobs through the same orchestrator pipeline as user messages is elegant. It means cron jobs get the same soul, memory, and skill context as interactive sessions. It also means the orchestrator is the single point of testing — if it works for users, it works for cron.

---

## Summary of Critical Action Items

> **Status legend**: INCORPORATED = addressed in ARCHITECTURE.md v1.1.0 | NOTED = acknowledged in Known Limitations | OPEN = not yet addressed

| Priority | Issue | Section | Status |
|----------|-------|---------|--------|
| **P0** | Test `--append-system-prompt` + `--resume` interaction before building anything | 4 | **INCORPORATED** — Section 7.4 documents the risk with three fallback strategies; Section 16 has a concrete test script |
| **P0** | Add per-session message serialization to prevent concurrent `--resume` of same session | 4 | **INCORPORATED** — Section 7.8 adds per-session mutex via promise chain |
| **P0** | Add `ephemeral` field to `MessageInput` interface | 3 | **INCORPORATED** — Added to `MessageInput` interface in Section 6 |
| **P1** | Add `maxConcurrentProcesses` to `MikeClawConfig` interface | 2 | **INCORPORATED** — Added to `MikeClawConfig` along with `maxQueueDepth`, `maxTurnsPerSession`, `sessionTtlDays` |
| **P1** | Define behavior for `maxLearningEntries` overflow | 6 | **INCORPORATED** — Section 9.7: pause reflection + log warning when limit exceeded |
| **P1** | Fix CORS implementation (single origin, not comma-separated) | 8 | **INCORPORATED** — Section 11: single-origin-per-response with `Vary: Origin` |
| **P1** | Add session rotation logic for long-running sessions | 4 | **INCORPORATED** — Section 7.5 adds rotation with user notification on context loss |
| **P1** | Define missing error types (`MemoryError`, `SoulError`, `SkillError`, `CronError`) | 9 | **INCORPORATED** — All four defined in Section 12 error hierarchy |
| **P2** | Add logging strategy (levels, destinations, format) | 1 | **INCORPORATED** — Section 15: structured JSON-lines audit logging with 18 event types |
| **P2** | Add startup validation checklist | 1 | **INCORPORATED** — Section 16: Pre-Implementation Validation Checklist with 6 test scripts |
| **P2** | Add cron job state persistence for missed-job catch-up | 7 | **OPEN** — Not addressed in v1.1.0; consider adding `cron/state.json` |
| **P2** | Add `timezone` field to `CronJob` and config | 7 | **INCORPORATED** — `CronJob` gains `timezone` field |
| **P2** | Consider Fastify over bare `node:http` | 8 | **OPEN** — Architecture still uses bare `node:http`; valid for MVP |
| **P2** | Consider in-memory session store with periodic disk flush | 5 | **OPEN** — Still file-based; in-memory Map recommended as future optimization |
| **P3** | Split orchestrator into `PromptAssembler` + `Orchestrator` | 2 | **OPEN** — Orchestrator remains unified; split can happen when complexity warrants it |
| **P3** | Add batching strategy for learning reflections | 6 | **OPEN** — Still per-turn; batching (every N turns) suggested but not formalized |
| **P3** | Add session garbage collection with TTL | 5 | **INCORPORATED** — `sessionTtlDays` added to config |
| **P3** | Design `MemoryManager` interface to support future structured storage | 11 | **OPEN** — Memory is still file-based; interface abstraction deferred |

---

*This review is based solely on the architecture document and plan. Many of the concerns raised here may already have solutions that simply are not documented. The P0 items (especially the `--resume` + `--append-system-prompt` interaction) should be resolved before any implementation begins.*
