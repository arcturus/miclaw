# 02 — Telegram Channel: Zero-Infra Messaging

**Date**: 2026-03-22
**Status**: Implemented
**Author**: arcturus

---

## The Problem

miclaw had two delivery channels: CLI (local, trusted) and Web (HTTP, untrusted). Both require the user to come to miclaw — either at a terminal or in a browser. There was no way to reach the bot where people already are: in a messaging app on their phone.

GitHub issue #2 requested adding Telegram as a channel.

## Design Decisions

### Why Long Polling, Not Webhooks

Telegram bots can receive messages two ways: long polling (bot pulls from Telegram's servers) or webhooks (Telegram pushes to a URL you expose). Webhooks require a publicly accessible HTTPS endpoint — a reverse proxy, a domain, TLS certificates. That's the opposite of miclaw's philosophy.

Long polling requires nothing. The bot connects outward to Telegram's servers. It works behind NAT, in Docker, on a laptop, anywhere. It's the same zero-infra approach as the CLI channel (stdin) and the Web channel (localhost HTTP server).

The trade-off is slightly higher latency (~1-2 seconds for polling interval) and more outbound connections. For a personal bot framework built for learning, this is the right call.

### Why Chat ID Allowlisting, Not Bot API Tokens for Auth

The web channel uses API key auth — a shared secret in the `Authorization` header. This makes sense for HTTP where you control the client. Telegram clients are out of your control; anyone who discovers the bot's username can message it.

Chat ID allowlisting is the Telegram-native access control: you list the numeric IDs of chats that are allowed to interact with the bot. Unauthorized chats get a short rejection message that includes their chat ID — so users can easily add themselves to the allowlist.

When the allowlist is empty, all chats are accepted. This is fine for development or truly public bots.

### Why In-Memory Known Chat IDs, Not Persisted

For wildcard broadcast (`send("*", message)`), the channel needs to know which chat IDs to send to. Rather than persisting chat IDs to disk, the channel tracks them in an in-memory `Set` populated by incoming messages during the current process lifetime.

This is the same approach `WebChannel` uses for SSE clients. The trade-off: if the bot restarts, it loses its broadcast list until users message it again. For a learning framework, this simplicity is worth it. If persistence becomes necessary, the `SessionManager` already stores channel:user pairs that could be queried.

### Why 30 req/min Rate Limit

The web channel defaults to 60 req/min. Telegram is inherently 1:1 (one user per chat), so a lower limit is appropriate. 30 req/min is still generous for conversational use but provides protection against abuse. Telegram itself rate-limits bots to ~30 messages/second globally, so miclaw's per-user limit is not the bottleneck.

## What Changed

| File | Change |
|------|--------|
| `src/channels/telegram.ts` | New file: `TelegramChannel` implementing `Channel` interface |
| `src/config.ts` | Added telegram config type, defaults, env var resolution, security profile |
| `src/index.ts` | Wire up telegram channel when enabled |
| `tests/channels/telegram.test.ts` | 18 tests covering lifecycle, routing, allowlist, broadcast, message splitting |
| `README.md` | Updated channel list, architecture diagram, config example, project structure |
| `ARCHITECTURE.md` | Updated component diagram, module graph, file layout, extension points; added Section 11b |

## What We Didn't Do

- **Markdown rendering**: Telegram supports its own Markdown variant (`MarkdownV2`), but Claude's responses use standard Markdown that would need escaping. For now, messages are sent as plain text. A future enhancement could add `parse_mode` support.

- **Bot commands**: Telegram bots conventionally respond to `/start` with a greeting. The channel currently treats all text messages equally. A `/start` handler could be added to show the chat ID and usage instructions.

- **Persistent broadcast list**: As noted above, known chat IDs are in-memory only. If cron broadcasts to Telegram become important, chat IDs could be persisted via the session store.

- **Inline keyboards / rich messages**: Telegram supports buttons, inline queries, and other rich message types. These are orthogonal to the `Channel` interface and could be added without architectural changes.
