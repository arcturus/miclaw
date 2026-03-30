# 04 — Multi-Agent: Skill Filtering, Memory Isolation, Discovery, and Delegation

**Date**: 2026-03-30
**Status**: Implemented
**Author**: arcturus, claude
**Issue**: #9

---

## The Problem

miclaw's `agents.json` lets you register multiple agents with independent souls, models, and tool restrictions. But the multi-agent story had four significant gaps:

1. **Skills were silently ignored.** `AgentConfig.skills` was defined in the type, parsed from config, and then never used. Every agent got every skill — the field was dead code masquerading as configuration.

2. **Memory was shared.** All agents read and wrote the same `MEMORY.md`, `learnings.md`, and `journals/` directory. A legal-research agent's learnings polluted a code-review agent's context window. The learner didn't know which agent it was extracting insights for.

3. **Agents were invisible to each other.** No agent's system prompt mentioned that other agents existed. An agent couldn't suggest "ask the code-reviewer about this" because it had no idea there was one.

4. **No delegation mechanism.** Even if agents knew about each other, there was no way for Agent A to hand work to Agent B. The orchestrator routed user→agent only, never agent→agent.

## Design Decisions

### Why Per-Agent Skill Filtering Is a Bug Fix, Not a Feature

The `skills` field existed on `AgentConfig` from the start. It was parsed from `agents.json` in `index.ts` and stored in the agent registry. But `orchestrator.ts` called `this.skills.getPromptSection()` and `this.skills.getAllAllowedTools()` — both of which returned all globally loaded skills, ignoring the agent entirely.

This isn't a missing feature — it's a broken feature. Users who set `skills: ["github-pr"]` on an agent expected it to work. It didn't, and there was no error or warning. The fix was straightforward: add `getPromptSectionFor(names?)` and `getAllowedToolsFor(names?)` to `SkillLoader`, then use the agent's skill list in the orchestrator. Empty array means "all skills" for backward compatibility.

### Why Optional memoryDir, Not Mandatory Per-Agent Directories

The simplest approach would be: every agent automatically gets `memory/<agentId>/`. But this would be a breaking change — existing single-agent setups would suddenly find their memory in `memory/assistant/` instead of `memory/`. And for deployments where agents genuinely should share context (e.g., a researcher and a summarizer working the same domain), forced isolation would be counterproductive.

Instead, `memoryDir` is optional on `AgentConfig`. When set, the orchestrator creates a separate `MemoryManager` (lazily cached in a `Map<string, MemoryManager>`). When unset, the agent uses the shared default. This gives explicit control without breaking anything.

The `MemoryManager` was already fully path-parameterized — it takes `config.memoryDir` in its constructor and never references global state. So per-agent isolation required no changes to the memory layer itself, only to the orchestrator's wiring.

### Why Journals Stay Shared

Journals record chronological interaction history. Unlike learnings (which accumulate agent-specific patterns), journals provide temporal context that's useful across agents: "the user asked the researcher about X at 10am, then asked the reviewer about the same codebase at 11am." Isolating journals would break this cross-agent timeline.

Per-agent memory isolation handles the actual contamination problem — learnings from a legal-research agent won't pollute a code-reviewer's prompt. Journals are a different concern and benefit from remaining shared.

### Why a Pure Function for Agent Directory

The agent directory section could have been a private method on `Orchestrator`. But the orchestrator is hard to unit-test — its constructor creates a `ClaudeRunner`, `ProcessPool`, `SessionManager`, and other real objects. Extracting `buildAgentDirectory(agents, currentAgentId, delegationEnabled)` as a pure exported function made it trivially testable without mocking the entire orchestrator dependency tree.

The orchestrator's private method is now a one-liner that calls the pure function.

### Why Fenced Code Blocks for Delegation, Not HTML Comments or Structured Output

The issue proposed HTML comment markers (`<!-- delegate:agent-id -->`) for delegation. Three problems:

1. **Fragile parsing.** LLMs frequently break HTML comment syntax — missing closing `-->`, nested comments, whitespace variations.
2. **Invisible to users.** HTML comments are hidden in rendered markdown. If a user inspects the raw response, delegation markers mixed into prose are hard to spot.
3. **No structured payload.** A comment can only carry a flat string. Delegation needs at least `targetAgent` and `message`, ideally `context` too.

Fenced code blocks with a `delegate` language tag solve all three:

```
\`\`\`delegate
{"targetAgent": "reviewer", "message": "Review this PR", "context": "PR #42"}
\`\`\`
```

JSON is unambiguous to parse. The `delegate` tag is distinct from any real language, so it won't collide with normal code blocks. The block is visible in rendered output. And `parseDelegationBlocks()` is a 15-line function with a single regex — no AST parsing needed.

### Why Depth-1 Delegation Only

Allowing delegation chains (A delegates to B, B delegates to C) creates the risk of infinite loops — especially since agents are LLMs that might not respect "don't delegate back." The safest constraint is depth 1: an agent can delegate, but the delegated agent cannot delegate further. This is enforced via `metadata.isDelegation` — if the incoming message has this flag, delegation blocks in the response are ignored.

Max 1 delegation per turn (only the first `delegate` block is executed) further limits blast radius. These constraints can be relaxed later if needed, but starting restrictive is safer.

### Why Delegation Is Enabled by Default

Initially `interAgentDelegation` defaulted to `false` (opt-in). During review, this was changed to `true` — if you've configured multiple agents, you likely want them to collaborate. The delegation mechanism is safe by default (depth-1, max 1 per turn, ephemeral sessions), so there's no security reason to require explicit opt-in. Users who don't want it can set `interAgentDelegation: false`.

## What Changed

### Modified Files
- `src/types.ts` — added `DelegationRequest`, `DelegationResult` interfaces; added `memoryDir?` to `AgentConfig`; added `delegations?` to `MessageOutput`
- `src/config.ts` — added `interAgentDelegation: true` to `MiclawConfig` and defaults
- `src/skills.ts` — added `getPromptSectionFor(names?)`, `getAllowedToolsFor(names?)`, and private `filterSkills()` helper
- `src/orchestrator.ts` — per-agent memory via `getMemoryForAgent()` cache; per-agent skill filtering; agent directory injection; delegation parsing and execution; extracted `buildAgentDirectory()` and `parseDelegationBlocks()` as pure exported functions
- `src/learner.ts` — `reflect()` accepts optional `memoryOverride` parameter, all internal references use it
- `CLAUDE.md` — updated message flow, agents description, added multi-agent configuration section

### New Files
- `tests/orchestrator.test.ts` — 13 tests for agent directory and delegation parsing

### Test Impact
- 230 tests across 12 files (was 217 across 11)
- Fixed pre-existing date-sensitive test in `memory.test.ts` (hardcoded date had decayed past confidence threshold)

## Architecture Impact

No new layers. All changes stay within the existing four-layer hierarchy:

- **Layer 0** (`types.ts`, `config.ts`): new interfaces and config field
- **Layer 1** (`skills.ts`, `learner.ts`): filtered skill loading, memory override in learner
- **Layer 2** (`orchestrator.ts`): per-agent memory cache, agent directory, delegation orchestration

The delegation flow adds a recursive `handleMessage` call (orchestrator calls itself for the delegated agent), but it's bounded by the depth-1 check and uses ephemeral sessions, so it doesn't affect session state or journal writes for the original interaction.

```
User message
    │
    ▼
Orchestrator._handleMessage(agentId="assistant")
    │
    ├── assemble prompt (soul + agent memory + filtered skills + agent directory)
    ├── runner.run() → response with ```delegate block
    ├── parseDelegationBlocks(response)
    │       │
    │       ▼
    │   Orchestrator.handleMessage(agentId="reviewer", ephemeral=true, isDelegation=true)
    │       │
    │       ├── assemble prompt (reviewer soul + reviewer memory + reviewer skills)
    │       ├── runner.run() → delegation result
    │       └── return (no further delegation — isDelegation=true)
    │
    ├── append delegation result to response
    └── return combined result
```
