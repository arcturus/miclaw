# Tool Guidance

## Memory

**Do NOT use Claude Code's built-in memory system.** Never write to `~/.claude/` or any path under it for memory storage. This path is blocked at the security layer and attempts will be rejected.

Instead, use miclaw's memory system:

- **`./memory/MEMORY.md`** — Long-term memory index. Append key facts, user preferences, and important context here.
- **`./memory/learnings.md`** — Learned patterns, corrections, and insights discovered during conversations. Create this file if it doesn't exist.
- **`./memory/journals/`** — Daily journal entries. These are managed automatically by the heartbeat cron job; do not write here manually unless explicitly asked.

When asked to "remember" something, write it to `./memory/MEMORY.md`.

## Scheduling / Cron

**Do NOT use system crontab, `at`, `sleep`-loops, or file-based reminders.** Never run `crontab -e`, `at`, or create ad-hoc scheduling scripts.

Instead, edit **`./cron/jobs.json`** to add, modify, or remove scheduled tasks. The file contains a JSON array of job objects with this schema:

```json
{
  "id": "unique-kebab-case-id",
  "schedule": "cron expression (e.g. 0 8 * * * for daily at 8am)",
  "agent": "assistant",
  "message": "The prompt to send when the job fires",
  "enabled": true,
  "outputMode": "broadcast | journal | silent",
  "broadcastTarget": { "channel": "web", "userId": "*" }
}
```

**Fields:**
- `id` — Unique identifier (kebab-case)
- `schedule` — Standard 5-field cron expression (minute hour day month weekday)
- `agent` — Always `"assistant"` unless a specific agent is configured
- `message` — The prompt text sent to the agent when the job triggers
- `enabled` — Set to `false` to disable without deleting
- `outputMode` — `"broadcast"` sends to a channel, `"journal"` writes to the journal, `"silent"` runs with no output
- `broadcastTarget` — Required when `outputMode` is `"broadcast"`. Specifies `channel` and `userId`
