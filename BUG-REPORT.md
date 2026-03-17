# mikeclaw Bug Report

**Date**: 2026-03-17
**Status**: All Critical/High/Medium bugs FIXED. Low bugs documented.

---

## Summary

25 bugs found across all source files. 19 fixed, 6 low-severity documented for future.

| Severity | Found | Fixed |
|----------|-------|-------|
| Critical | 2 | 2 |
| High | 2 | 2 |
| Medium | 15 | 15 |
| Low | 6 | 0 (documented) |

---

## Critical (FIXED)

### BUG-01: Command injection in skills.ts
- **File**: `src/skills.ts:109`
- **Bug**: `execSync(`which ${bin}`)` — unsanitized YAML frontmatter value passed to shell
- **Fix**: Added `SAFE_BIN_NAME = /^[a-zA-Z0-9_.-]+$/` regex validation before exec

### BUG-02: Admin API has no authentication
- **File**: `src/channels/web.ts:125-128`
- **Bug**: All `/api/admin/*` endpoints skipped `authenticate()`, unlike `/api/chat`
- **Fix**: Added `authenticate()` check before `handleAdmin()` dispatch

---

## High (FIXED)

### BUG-03: Default agent overwrites agents.json
- **File**: `src/index.ts:37-42`
- **Bug**: `registerAgent({id: "assistant"})` called unconditionally, overwriting custom agent with same ID
- **Fix**: Only register default if no "assistant" agent already loaded

### BUG-14: Empty API key passes auth
- **File**: `src/channels/web.ts:145-146`
- **Bug**: `"" !== ""` is false, so empty `Authorization: Bearer ` succeeds when apiKey is empty string
- **Fix**: Reject if no API key configured, reject empty tokens, use `timingSafeEqual`

---

## Medium (FIXED)

### BUG-04: Template variable single replacement
- **File**: `src/cron.ts:134`
- **Bug**: `String.replace()` only replaces first occurrence of `{{DATE}}` etc.
- **Fix**: Changed to `replaceAll()`

### BUG-06: sessionLocks memory leak
- **File**: `src/orchestrator.ts:29`
- **Bug**: `sessionLocks` Map grows unboundedly — entries never removed
- **Fix**: Delete lock entry after promise chain settles if still current

### BUG-09: API key timing attack
- **File**: `src/channels/web.ts:146`
- **Bug**: API key compared with `!==` (timing-vulnerable)
- **Fix**: Use `crypto.timingSafeEqual()` with Buffer comparison

### BUG-11: validateId never called
- **File**: `src/orchestrator.ts:14-18`
- **Bug**: `validateId()` defined but never invoked — no input validation on userId/agentId
- **Fix**: Call `validateId()` on userId and agentId in `_handleMessage()`

### BUG-12: Session GC never triggered
- **File**: `src/session.ts` + `src/index.ts`
- **Bug**: `gc()` method exists but is never called anywhere
- **Fix**: Run `sessions.gc()` on orchestrator construction

### BUG-13: Silent empty env vars
- **File**: `src/config.ts:94`
- **Bug**: Missing env vars silently resolve to `""` via `process.env[key] ?? ""`
- **Fix**: Log warning when env var is not set

### BUG-16: Path traversal in readJournal
- **File**: `src/memory.ts:126-133`
- **Bug**: `readJournal(date)` accepts arbitrary strings used in file path
- **Fix**: Validate `YYYY-MM-DD` format and verify resolved path is within journals dir

### BUG-20: XSS in admin config view
- **File**: `admin.html:548-570`
- **Bug**: `syntaxHighlight()` injects raw JSON into innerHTML without escaping
- **Fix**: Escape HTML entities before applying syntax highlighting

### BUG-21: XSS in admin skills view
- **File**: `admin.html:504`
- **Bug**: `JSON.stringify(s.requires)` inserted into innerHTML unescaped
- **Fix**: Wrapped in `escHtml()`

### BUG-22: XSS in admin overview
- **File**: `admin.html:385`
- **Bug**: Channel breakdown keys inserted into innerHTML unescaped
- **Fix**: Wrapped in `escHtml()`

### BUG-23: Learner bypasses ProcessPool
- **File**: `src/learner.ts:36`
- **Bug**: Learner creates own `ClaudeRunner` with no concurrency control
- **Fix**: Accept shared `ProcessPool` in constructor, acquire/release around runner calls

### BUG-24: SIGKILL timer never cleared
- **File**: `src/runner.ts:99-103`
- **Bug**: 5-second SIGKILL fallback `setTimeout` never cleared on normal close
- **Fix**: Track `killTimer` and clear in both `close` and `error` handlers

### BUG-25: Server start() never rejects
- **File**: `src/channels/web.ts:75-81`
- **Bug**: `new Promise((resolve) => server.listen(...))` — no rejection on port conflict
- **Fix**: Added `server.once("error", reject)` before listen

---

## Low (Documented, Not Fixed)

### BUG-08: Multi-byte character corruption in readBody
- **File**: `src/channels/web.ts:452-453`
- **Impact**: Multi-byte UTF-8 characters split across chunk boundaries get corrupted
- **Suggestion**: Collect Buffers and call `Buffer.concat().toString()` at end

### BUG-15: stdout parsing fails on non-JSON
- **File**: `src/runner.ts:165-175`
- **Impact**: If Claude CLI outputs warnings before JSON, parsing fails
- **Suggestion**: Find first `{` in stdout before parsing

### BUG-17: Unhandled promise rejection in shutdown
- **File**: `src/index.ts:84-93`
- **Impact**: If channel.stop() throws, shutdown handler crashes
- **Suggestion**: Wrap each stop() in try/catch

### BUG-18: isDuplicate false positives
- **File**: `src/learner.ts:114`
- **Impact**: 50-char substring check is too aggressive for short learnings
- **Suggestion**: Use longer substring or semantic similarity

### BUG-26: Vary header only on matching origins
- **File**: `src/channels/web.ts:49-54`
- **Impact**: Caches may serve wrong CORS response when origin varies
- **Suggestion**: Always set `Vary: Origin` when CORS is configured

### BUG-27: Mutable session objects
- **File**: `src/session.ts:22-42`
- **Impact**: Direct mutation of Map values makes dirty-flag tracking fragile
- **Suggestion**: Return copies or use update() exclusively
