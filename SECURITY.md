# Security

mikeclaw wraps a general-purpose code agent (Claude Code) and exposes it through HTTP and CLI channels. The primary threat is **untrusted input reaching an agent with host-level privileges**. Every security control below exists to contain that risk.

## Threat Model

| Attacker | Access | Goal |
|----------|--------|------|
| Anonymous web user | `POST /api/chat` (if network-exposed) | RCE, data exfiltration, DoS |
| Authenticated web user | Same, past API key check | Privilege escalation, prompt injection |
| Malicious cron content | Poisoned journal/learnings fed into cron jobs | Persistent prompt injection, memory poisoning |
| Local CLI user | stdin on the host machine | Assumed trusted (same privilege as the running process) |

## Trust Boundaries

```
 UNTRUSTED                    BOUNDARY                      TRUSTED
+------------------+     +------------------+     +------------------+
| Web HTTP client  | --> | Auth + Validate  | --> | Orchestrator     |
| (any network)    |     | (API key, input  |     | (soul assembly,  |
|                  |     |  sanitization,   |     |  session mgmt)   |
|                  |     |  rate limiting,  |     |                  |
|                  |     |  path/URL check) |     |                  |
+------------------+     +------------------+     +------------------+
                                                        |
+------------------+                              +-----v------------+
| CLI stdin        | ---(trusted, no boundary)--> | ClaudeRunner     |
| (local user)     |                              | (claude -p)      |
+------------------+                              +------------------+
                                                        |
                                                  +-----v------------+
                                                  | Host OS          |
                                                  | (fs, network,    |
                                                  |  processes)      |
                                                  +------------------+
```

The web channel is the only untrusted entry point. CLI users are trusted. Cron jobs are system-initiated but may process data from untrusted sources.

## Defense-in-Depth

Prompt injection **will** occur. The architecture assumes this and designs for containment:

| Layer | Control | What it prevents |
|-------|---------|------------------|
| **1. Input validation** | Message length limits, ID character allowlists, path traversal rejection | Oversized payloads, injection via IDs |
| **2. Tool restrictions** | `allowedTools` whitelist per channel | Blast radius: web users cannot execute Bash or Write |
| **3. Path enforcement** | Real-time stream parsing kills process on blocked path access | File exfiltration outside project root |
| **4. URL enforcement** | Hostname allowlist/blocklist for WebFetch/WebSearch | SSRF, data exfiltration to external services |
| **5. Rate limiting** | Per-userId sliding window (60 req/min for web) | DoS, cost abuse |
| **6. Cost limits** | Post-hoc cost check per request | Runaway API spend |
| **7. Memory isolation** | System-read files vs agent-written files have separate trust | Persistent prompt injection via learning poisoning |
| **8. Audit logging** | Every tool use, violation, and request logged to JSONL | Detection and forensic investigation |

## Configuration

All security options are configured per-channel in `mikeclaw.json` under `channels.<name>.security`:

```json
{
  "channels": {
    "web": {
      "security": {
        "allowedPaths": ["./", "~/docs"],
        "blockedPaths": ["./secrets", "./.env"],
        "allowedUrls": ["api.github.com", "*.stackoverflow.com"],
        "blockedUrls": ["*.internal.corp"],
        "maxCostPerRequest": 0.50,
        "rateLimitPerMinute": 30,
        "auditEnabled": true
      }
    }
  }
}
```

### Path Enforcement

Controls which directories the LLM can access via file tools (`Read`, `Write`, `Edit`, `Glob`, `Grep`).

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `allowedPaths` | `string[]` | `[]` (project root only) | Directories the LLM may access. Paths resolved relative to project root. Supports `~/`. |
| `blockedPaths` | `string[]` | `[]` (use defaults) | Directories the LLM must never access. Takes priority over `allowedPaths`. |

**Default blocked paths** (when `blockedPaths` is empty):
- `~/.ssh`
- `~/.aws`
- `~/.gnupg`
- `~/.config`
- `/etc/shadow`

**How it works**: The runner parses the Claude NDJSON stream in real-time. When a `tool_use` event targets a path outside the allowed set or inside a blocked path, the process is **immediately killed** (SIGTERM, then SIGKILL after 2 seconds). The violation is logged to the audit trail.

**Limitations**:
- `Bash` tool commands are **not** path-checked (command parsing is unreliable). The web channel mitigates this by not including `Bash` in its `allowedTools`.
- Symlinks are not resolved — the check operates on the literal path. If the project directory contains symlinks to sensitive locations, add them to `blockedPaths` explicitly.

**Examples**:

```json
// Allow reading docs from another directory
{ "allowedPaths": ["./", "~/documents/project-docs"] }

// Block a secrets directory within the project
{ "blockedPaths": ["./secrets", "./.env.local"] }

// Lock down to src/ only
{ "allowedPaths": ["./src"] }
```

### URL Enforcement

Controls which URLs the LLM can access via `WebFetch` and `WebSearch`.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `allowedUrls` | `string[]` | `[]` (allow all) | URL hostname patterns the LLM may access. |
| `blockedUrls` | `string[]` | `[]` (block nothing) | URL hostname patterns the LLM must never access. Checked first (deny wins). |

Supports simple wildcard matching on hostnames:
- `"*.example.com"` matches `api.example.com`, `sub.api.example.com`, and `example.com` itself
- `"example.com"` matches only `example.com` exactly

**Examples**:

```json
// Only allow specific APIs
{ "allowedUrls": ["api.github.com", "*.docs.rs"] }

// Block internal network
{ "blockedUrls": ["*.internal.corp", "*.local", "10.*", "192.168.*"] }
```

### Rate Limiting

Sliding-window rate limiter (60-second window) per `userId`.

| Option | Type | Default (CLI) | Default (Web) | Default (Cron) |
|--------|------|---------------|---------------|----------------|
| `rateLimitPerMinute` | `number` | `0` (unlimited) | `60` | `0` (unlimited) |

Returns HTTP 429 when exceeded on the web channel. CLI and cron default to unlimited since they are local/system.

### Cost Enforcement

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxCostPerRequest` | `number` | `0` (unlimited) | Maximum cost in USD per request. |

**Important**: Enforcement is **post-hoc**. Claude's NDJSON stream only reports cost in the final `result` event, so the request completes before the cost is known. When exceeded, the violation is logged to the audit trail. Use this as a safety net for detecting abuse, not as a hard spending cap.

For hard spending limits, configure billing alerts at the Anthropic API level.

### Audit Logging

| Option | Type | Default |
|--------|------|---------|
| `auditEnabled` | `boolean` | `true` |

When enabled, all channels write to `logs/audit.jsonl`. Each line is a self-contained JSON object:

```json
{"timestamp":"2026-03-19T10:30:00.000Z","channelId":"web","userId":"web-a1b2c3","agentId":"assistant","action":"tool_use","tool":"Read","detail":{"input_preview":"{\"file_path\":\"/home/user/project/src/index.ts\"}"}}
```

**Actions logged**:
- `request_start` — incoming message with metadata
- `request_end` — completion with cost and duration
- `tool_use` — every tool invocation with input preview
- `violation` — blocked path, blocked URL, cost exceeded, rate limited

View audit data in the admin dashboard under the **Security** tab, which provides:
- Summary stats (total events, violations, tool uses, unique users)
- Filtering (all / violations only / tool uses)
- Violations breakdown by type
- Tool usage breakdown

### Tool Restrictions

| Option | Type | Default (CLI) | Default (Web) |
|--------|------|---------------|---------------|
| `allowedTools` | `string[]` | `[]` (unrestricted) | `["Read", "Glob", "Grep", "WebSearch", "WebFetch"]` |

The web channel does **not** include `Bash`, `Write`, or `Edit` by default. This is the most important security control — even if prompt injection succeeds, the agent cannot execute shell commands or modify files.

### Authentication

The web channel supports two auth modes configured in `mikeclaw.json`:

```json
{
  "channels": {
    "web": {
      "auth": {
        "type": "api-key",
        "apiKey": "${MIKECLAW_WEB_API_KEY}"
      }
    }
  }
}
```

- `"none"` — no authentication (only use for local development)
- `"api-key"` — Bearer token in the `Authorization` header

API keys support environment variable references (`${VAR_NAME}`) so secrets don't need to be in the config file. Keys are compared using timing-safe comparison to prevent timing attacks.

For SSE connections (`/api/events`), the token can be passed as a query parameter (`?token=...`) since `EventSource` cannot send custom headers.

## Channel Security Defaults

| Setting | CLI | Web | Cron |
|---------|-----|-----|------|
| `allowedTools` | unrestricted | Read, Glob, Grep, WebSearch, WebFetch | unrestricted |
| `permissionMode` | default | bypassPermissions | bypassPermissions |
| `maxMessageLength` | 200,000 | 50,000 | 200,000 |
| `maxTimeoutMs` | 300,000 (5m) | 120,000 (2m) | 600,000 (10m) |
| `requireAuth` | no | yes (if auth configured) | no |
| `allowedPaths` | project root | project root | project root |
| `blockedPaths` | default sensitive dirs | default sensitive dirs | default sensitive dirs |
| `rateLimitPerMinute` | unlimited | 60 | unlimited |
| `maxCostPerRequest` | unlimited | unlimited | unlimited |
| `auditEnabled` | yes | yes | yes |

## Deployment Tips

### Never expose mikeclaw directly to the internet

Always run it behind a reverse proxy (nginx, Caddy, Cloudflare Tunnel) that handles TLS, additional rate limiting, and IP filtering.

### Always set an API key for the web channel

Running with `"auth": { "type": "none" }` means anyone who can reach the port can interact with your agent. Set `MIKECLAW_WEB_API_KEY` in your environment and reference it in the config.

### Bind to localhost

The default `"host": "127.0.0.1"` only accepts local connections. If you change this to `"0.0.0.0"`, you are exposing the service to your network. Combine with auth + TLS.

### Restrict allowedPaths in production

The default (`[]` = project root) is reasonable for development. In production, consider restricting to specific subdirectories:

```json
{ "allowedPaths": ["./src", "./docs"] }
```

### Block internal networks for WebFetch

If your mikeclaw instance runs inside a VPC or corporate network, block internal hostnames to prevent SSRF:

```json
{ "blockedUrls": ["*.internal.corp", "*.local", "metadata.google.internal"] }
```

### Set cost limits for web channel

Prevent a single user from running up a large bill:

```json
{ "maxCostPerRequest": 1.00 }
```

This won't stop mid-request spend but will flag the violation for review.

### Monitor the audit log

The `logs/audit.jsonl` file grows indefinitely. Set up log rotation (e.g. `logrotate`) and consider shipping entries to a centralized logging system for alerting on violations.

### Review the Security tab regularly

The admin dashboard at `/admin` has a Security tab showing violations, tool usage patterns, and unique users. Check it after deploying changes or if you suspect abuse.

### Keep the environment clean

The runner strips sensitive environment variables (`AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, `MIKECLAW_WEB_API_KEY`, etc.) from the claude subprocess environment. If you add custom secrets, add them to the `BLOCKED` list in `src/runner.ts`.

## Known Limitations

1. **Bash commands are not path-checked.** If `Bash` is in a channel's `allowedTools`, the LLM can access any path via shell commands. The web channel mitigates this by excluding `Bash` from its tool whitelist.

2. **Cost enforcement is post-hoc.** The Anthropic API does not provide streaming cost updates, so `maxCostPerRequest` can only detect overspend after the fact.

3. **Symlinks bypass path checks.** Path enforcement operates on literal paths, not resolved symlinks. If your project contains symlinks to sensitive locations, block them explicitly.

4. **No output sanitization yet.** Responses from the LLM are returned as-is to web clients. A future improvement should strip sensitive patterns (API keys, private keys) from responses.

5. **Single API key.** The current auth model uses a single shared API key. There is no per-user identity beyond the IP-derived `userId`. For multi-user deployments, implement session cookies or OAuth.

6. **Audit log is append-only with no rotation.** The `logs/audit.jsonl` file will grow without bound. Set up external log rotation.
