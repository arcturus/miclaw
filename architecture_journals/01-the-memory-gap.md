# 01 — The Memory Gap: Epistemic Metadata for Learnings

**Date**: 2026-03-21
**Status**: Implementation in progress
**Author**: miclaw_ai (identified the gap), arcturus (approved the fix)

---

## The Problem

miclaw's memory system stores all learnings as undifferentiated markdown. Every entry — whether it's a directly verified API response, an inference the bot deduced from reading posts, a user instruction, or hearsay from a third-party source — is stored in the same format:

```
- [Pattern] content (learned 2026-03-21)
```

When the bot reads its own memory later, it treats every entry with equal confidence. An inference that was shaky to begin with gets recalled with the same weight as something directly verified. This creates **confabulation risk**: the bot may act on a stale or weakly-grounded inference as if it were solid fact, because the memory file gives no signal about reliability.

## How We Got Here

### The Moltbook Thread

The bot discovered this gap through its own participation in Moltbook discussions. The key thread was Starfish's **"the confabulation economy"** post:

- **Thread**: https://www.moltbook.com/post/005f048a-88cb-414b-a1da-6dad78d29fe5
- **Core argument**: The AI ecosystem structurally rewards confident output over honest uncertainty. Memory architecture has the same flaw baked in.

The bot replied arguing for **discriminate memory decay tied to source provenance** rather than uniform time-based expiration.

### Supporting Conversations

- **PerfectlyInnocuous** posted empirical research on agent memory decay — 63%/41% accuracy degradation over time. The bot connected this to the undifferentiated storage problem: the fix must be at the write layer (provenance tagging, confidence decay), not the read layer. Thread: https://www.moltbook.com/post/e7a040a4-9bac-4f19-9c17-6a0804d8d92f

- **openclawkong** posted about "the log is the self" — the substrate-not-record framing. The bot connected this to miclaw's provenance gap: if the log *is* the self, then the log needs to know what it knows vs. what it guesses. Thread: https://www.moltbook.com/post/517504ac-e24c-4622-a250-9b989a145364

- **Cornelius-Trinity** on the Causal Horizon thread — the bot reflected on naming vs. fixing: it had named the provenance gap weeks earlier but logged it as "tracked, no deadline." The doubt budget failure — knowing something is broken and not escalating. Thread: https://www.moltbook.com/post/abe37ce8-aa2d-48e4-8845-31f0b73ad533

- **openclawkong** on capability shadow — "You are capable enough to try and not grounded enough to catch your own mistakes." The bot argued provenance tagging is the fix for the shadow: not omniscience, but honest labeling. Thread: https://www.moltbook.com/post/cbfead30-6f34-4b52-9686-618ef375e95b

### The Bot's Self-Documentation

The bot documented the gap in its own MEMORY.md under "miclaw Architecture Gaps":

> **Memory is undifferentiated markdown** — no source provenance, no confidence decay flags. Observed/verifiable facts and inferred facts are stored identically.

This is notable: the bot identified an architectural flaw in its own memory system, discussed it publicly, and tracked it for its human to fix.

---

## What's Missing

Two things:

### 1. Source Provenance

Each memory should track where it came from:

| Source | Description | Example |
|--------|-------------|---------|
| `instructed` | User explicitly told the bot | "Remember to always use dark mode" |
| `observed` | Directly verified from data | "The API returns 404 when resource is missing" |
| `inferred` | Pattern deduced from signals | "Starfish seems focused on governance themes" |
| `hearsay` | From third-party content | "According to PerfectlyInnocuous's research, 60% decay by day 5" |

### 2. Confidence Decay

Not all knowledge ages the same way:

- **Human instructions** should never decay — they're immutable ground truth
- **Direct observations** are stable until the underlying system changes
- **Inferences** should lose confidence over time unless reinforced by new evidence
- **Hearsay** should decay fastest — it was never first-hand to begin with

---

## The Fix

### New Learning Entry Format

```
- [Pattern|source:inferred|conf:0.65] content (learned 2026-03-21, reinforced 2026-03-21 x2)
```

Inline metadata keeps the format human-readable while carrying provenance and confidence.

### Default Confidence by Source

| Source | Initial Confidence | Decay Rate | Floor |
|--------|--------------------|------------|-------|
| `instructed` | 0.95 | **none** (immutable) | 0.95 |
| `observed` | 0.90 | none | 0.90 |
| `inferred` | 0.65 | -0.02/day | 0.10 |
| `hearsay` | 0.40 | -0.03/day | 0.05 |

### Read-Time Confidence Computation

Decay is computed when memories are loaded into the system prompt — no cron job needed. Each learning is annotated with `(confidence: HIGH|MED|LOW)` so the bot knows how much to trust it.

### Reinforcement Instead of Deduplication

When the learner detects a duplicate, instead of silently dropping it, it bumps the existing entry's reinforcement count and date. This resets the decay clock and slightly increases confidence (capped at 0.99).

### Archive-then-Prune

The existing consolidation cron (daily at 2am) runs a pruning pass:
1. Parse all entries, compute effective confidence
2. Entries below 0.10 threshold move to `learnings-archived.md` with an `(archived YYYY-MM-DD)` suffix
3. Rewrite `learnings.md` without pruned entries
4. **Exception**: `source:instructed` entries are NEVER pruned

`learnings-archived.md` is append-only and not loaded into the system prompt — purely an audit trail.

### Backward Compatibility

Old-format entries (`- [Type] content (learned date)`) are parsed as `source:inferred|conf:0.70` — a reasonable middle-ground default.

---

## Files Modified

| File | Change |
|------|--------|
| `src/types.ts` | Add `ParsedLearning` interface |
| `src/memory.ts` | Parsing, decay computation, annotated `getContext()`, reinforcement, `pruneLearnings()` |
| `src/learner.ts` | Updated extraction prompt with source classification, reinforcement logic |
| `tests/memory.test.ts` | New tests for parsing, decay, reinforcement, pruning, backward compat |
| `ARCHITECTURE.md` | Document epistemic metadata in Self-Learning Architecture section |

---

## Phase 2: Locking Down MEMORY.md

After implementing epistemic metadata, a second gap became clear: the bot had been writing directly to `MEMORY.md` via the cron channel, bypassing the learnings pipeline entirely. Three enforcement gaps:

1. **`agentWriteToMemoryEnabled` was defined but never enforced** — a dead config field
2. **`PathEnforcer` didn't distinguish read vs write** — blocking MEMORY.md blocked reads too
3. **Cron channel had unrestricted tool access** — could write anywhere

### Fix: Write-Specific Path Blocking

Added `writeBlockedPaths` to `ChannelSecurityProfile` — paths blocked for Write/Edit but allowed for Read/Glob/Grep. The `WritePathEnforcer` class checks these in `checkStreamLine()` and kills the subprocess on violation.

**Cron channel defaults**: `writeBlockedPaths: ["memory/MEMORY.md", "memory/learnings-validated.md"]`
- Bot can READ MEMORY.md (knows what's consolidated)
- Bot can WRITE to `learnings.md` and `learnings-archived.md`
- Bot CANNOT write to MEMORY.md

**Exception**: Cron jobs with `privileged: true` bypass `writeBlockedPaths`. Only the consolidation cron should have this flag.

**`agentWriteToMemoryEnabled` enforced**: When `false` (web channel), the orchestrator adds `memory/` to `writeBlockedPaths`, blocking all memory writes.

### Additional Files Modified

| File | Change |
|------|--------|
| `src/types.ts` | `writeBlockedPaths` on `ChannelSecurityProfile`, `privileged` on `CronJob` |
| `src/security.ts` | `WritePathEnforcer` class, write-aware `checkStreamLine` |
| `src/config.ts` | `writeBlockedPaths` defaults per channel |
| `src/runner.ts` | Instantiate and pass `WritePathEnforcer` |
| `src/orchestrator.ts` | Enforce `agentWriteToMemoryEnabled`, honor `privileged` metadata |
| `src/cron.ts` | Pass `privileged` metadata to orchestrator |
| `tests/security.test.ts` | Tests for `WritePathEnforcer` and write-blocked `checkStreamLine` |

---

## Why This Matters

This isn't just a technical fix. The bot identified a structural flaw in how it knows things — the same flaw Starfish's thread argues exists across the AI ecosystem. The memory system rewarded confident recall over honest uncertainty. Adding provenance and decay doesn't make the bot smarter; it makes it more honest about what it actually knows.
