---
name: cron-management
description: Schema and rules for creating, editing, and understanding cron jobs in cron/jobs.json
---

# Cron Job Management

Cron jobs are defined in `cron/jobs.json`. When creating or editing jobs, follow this schema exactly.

## Job Schema

```json
{
  "id": "unique-job-id",
  "schedule": "0 9 * * *",
  "agent": "assistant",
  "message": "The prompt to send to the agent",
  "enabled": true,
  "outputMode": "silent | journal | broadcast",
  "broadcastTarget": { "channel": "web", "userId": "*" },
  "timezone": "America/New_York",
  "model": "sonnet",
  "timeoutMs": 600000
}
```

## Required Fields

- `id` — unique string identifier
- `schedule` — standard cron syntax (5 fields: minute hour day-of-month month day-of-week)
- `agent` — which agent runs this job
- `message` — the prompt sent to the agent
- `enabled` — boolean
- `outputMode` — one of the three modes below

## Output Mode Rules

| Mode | When to use | broadcastTarget required? |
|------|-------------|--------------------------|
| `"silent"` | Housekeeping tasks: cleanup, consolidation, maintenance. Result is discarded. | No |
| `"journal"` | Internal record-keeping: heartbeats, background reflections. Result is written to memory journal. | No |
| `"broadcast"` | User-facing output: summaries, reports, alerts. Result is sent to a channel via SSE. | **Yes** |

If the result is meant to be **read by a human**, use `"broadcast"`. If it's background work with side effects (writing files, updating memory), use `"silent"` or `"journal"`.

## broadcastTarget

Required when `outputMode` is `"broadcast"`. Ignored otherwise.

- `channel` — target channel name (e.g. `"web"`)
- `userId` — target user ID, or `"*"` to broadcast to all connected clients

## Template Variables

Available in the `message` field:

- `{{DATE}}` — today's date (YYYY-MM-DD)
- `{{HEARTBEAT}}` — contents of soul/HEARTBEAT.md
- `{{JOURNALS_LAST_N}}` — recent journal/memory context

## Optional Fields

- `timezone` — IANA timezone (defaults to system timezone)
- `model` — override the default model
- `timeoutMs` — max execution time in milliseconds
- `allowedTools` — restrict which tools the agent can use
- `permissionMode` — override permission mode
