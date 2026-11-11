# dsh-cache-keepalive

Host-only Harness bundle + a settings-page card. While a user-visible main session is idle, it
replays the last real model request (same provider/model/messages/tools/toolHistory/config, only
`maxTokens` lowered) through `ctx.llm.stream()`, so the provider prompt cache stays warm and the
next real turn is billed at the cache-hit price instead of a full re-prefill.

## Why this exists

Kimi bills cache hits at 1/10 of the miss price. Measured on this machine (2026-11-11, direct
API, 10k-token unique prefixes):

| idle gap (no touch) | kimi-coding (`kimi-k3.1-pro`) | huosan |
|---|---|---|
| 10 / 20 / 30 min | 100% cache hit | — |
| 8 min | — | 0% (miss) |
| 45 min | 0% (needs a touch before then) | — |

Replaying with `max_tokens: 16` still hits (verified; `max_tokens: 1` can fail an "empty
response" check). Cost per touch at a 252k context ≈ ¥0.33; one expired re-prefill ≈ ¥3.28.
Break-even is **8 touches per idle gap** (`k+1 < 10`). Interval must stay below the measured
TTL: 20 min for kimi-coding, 4.5 min for huosan.

## What the user sees

- **Settings → Plugins**: one row, "Prompt cache keep-alive" / "提示词缓存保活", with an icon.
- The row has a **Configure** page (the card): live status, counters, editable interval / idle
  cap / touch cap / replay output cap, and the last 20 keepalive outcomes with estimated cost and
  estimated savings.
- **Chat**: nothing. No message, no badge, no tool call.
- Everything else: `keepalive.jsonl` (append-only).

## Behaviour

- **Follows the session's model.** It captures the latest real `llm/stream` request per session and
  replays with that request's own provider/model. `config.routes: []` means "any route"; fill it to
  restrict. Per-route pacing lives in `config.routeIntervals` (kimi-coding 20 min, huosan 5 min),
  falling back to `config.intervalMinutes`.
- **Only arms a route it has proof for.** A route may be keep-alive-armed only after a real request
  on it reported a genuine cache hit (`cacheRead >= 1024` and `>= 20%` of the prompt). Real hits are
  observed from the live stream; replays never self-certify.
- Captures the latest real `llm/stream` request per session (skips subagent/fork sessions,
  requests with a `purpose`, and its own replays).
- Every `scanSeconds`, for the most recent `maxSessions` eligible session: when
  `now - lastRealAt >= interval`, replay once, consume the stream fully, drop output.
- Never enters the agent loop: no assistant message, no session event, no tool execution.
- A replay that returns `cacheRead === 0` stops that session immediately; also stops at
  `maxTouches` / `maxIdleMinutes`; one replay in flight at a time.

## HTTP endpoints (loopback, no auth)

| method + path | purpose |
|---|---|
| `GET /plugins/cache-keepalive/state` | config, counters, tracked sessions, last 20 outcomes |
| `POST /plugins/cache-keepalive/config` | merge a JSON patch into `config.json` and apply it |

These serve the card. They expose only token counts and config — never prompt text.

## Files

| file | purpose |
|---|---|
| `config.json` | live config (also editable in the card); hot-reloaded every 2 s |
| `keepalive.jsonl` | append-only log: `start`, `capture`, `keepalive`, `stop`, `config` |

## Limits (v0.3)

- **Off by default.** Start or pause from the composer pill (`[● 缓存保活 开]`) or the Configure page.
- Request snapshots stay in memory; a DSH restart re-arms on the next real request.
- The card's yuan figures are estimates at kimi-coding list prices, not a bill.
- No UI for adding routes yet; edit `config.json` (hot-reloaded) for `routes` / `routeIntervals`.
