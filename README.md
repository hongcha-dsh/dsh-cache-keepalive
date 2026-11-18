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
response" check). Cost per touch at a 252k context ≈ ¥0.33; one expired re-prefill ≈ ¥3.28 in
input alone, plus a ¥3.28 5-minute cache write (official billing charges the write too) ≈ ¥6.56
cold. Break-even is therefore up to ~18 touches per idle gap
(`C × hit × (20 − k) > 0`); the default `maxTouches: 8` stays deliberately conservative.
Interval must stay below the measured TTL: 20 min for kimi-coding, 4.5 min for huosan.
On subscription routes that do not discount cache reads (e.g. Ark Agent Plan `/api/plan`,
whose AFP formula has no cache term), keep-alive saves nothing and only burns quota —
leave those routes out of `config.routes`.

## What the user sees

- **Settings → Plugins**: one row, "Prompt cache keep-alive" / "提示词缓存保活", with an icon.
- The row has a **Configure** page (the card): live status, counters, editable interval / idle
  cap / touch cap / replay output cap, the per-session default, and a per-task record list.
- **Composer pill** (`[● 缓存保活 本窗口开/关]`): switches keep-alive for **that conversation only**.
  Each window keeps its own switch; toggling one never changes another. The pill reads/writes
  `config.sessionEnabled[<sessionId>]` through `POST /plugins/cache-keepalive/session`.
- **Hovering the pill** opens a small card with **this window's numbers since it was switched on**:
  keepalive count, yuan spent, hits / touches, cache-read tokens, net saving, touches in the current
  idle gap, and the last touch time. The counters restart the moment you turn that window on again
  (a window that never switched explicitly counts from the plugin start). Turning a window off
  clears the "本次开启" view; the all-time figures stay on the Configure page.
- **Record list**: one record per task (= one conversation), named by the conversation title.
  Each row shows how many keepalives ran, whether that window is on, and the net yuan saved; click
  it to expand the per-touch detail (time, cache-read / uncached / output tokens, cost, latency)
  and click 删除 to drop that record.
- **Chat**: nothing. No message, no badge, no tool call.
- Everything else: `keepalive.jsonl` (append-only).

### How "saved" is counted

A cold re-prefill costs the prompt at the input price plus a 5-minute cache write of the same
tokens (official billing counts both); keeping it warm costs one cache read per touch. For one
idle gap with `k` touches and `C` prompt tokens:

```
net = C × hit_price × (R − k)      R = (input_price + write_5m_price) / hit_price = 20 for kimi-k3.1-pro
```

A gap that only produced misses/errors saved nothing and is counted negative. Task rows and the
top-line "估算净省" both use this net figure, so the number already has the keepalive spend
subtracted. Prices are kimi-k3.1-pro list prices (hit ¥1.3 / input ¥13 / output ¥68 / 5m write
¥13 per MTok).

## Behaviour

- **Per-window switch.** `config.sessionEnabled[<sessionId>]` is the authoritative choice for that
  conversation; `config.enabled` is only the default used by a session that never chose explicitly.
  A disabled window captures nothing and replays nothing; enabling arms on the next real request.
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
| `GET /plugins/cache-keepalive/state` | config, counters, tracked sessions (with their switch), per-task records, and `windows` (numbers since that window was switched on; only windows that are currently on are listed) |
| `POST /plugins/cache-keepalive/config` | merge a JSON patch into `config.json` and apply it (`enabled` = default) |
| `POST /plugins/cache-keepalive/session` | `{"session":"<id>","enabled":true\|false}`: one window's switch |
| `GET /plugins/cache-keepalive/task?session=<id>` | one task record plus its per-touch detail |
| `POST /plugins/cache-keepalive/task/delete` | `{"session":"<id>"}`: forget that task record |

These serve the card. They expose only token counts, task titles and config — never prompt text.

## Files

| file | purpose |
|---|---|
| `config.json` | live config, including the per-window `sessionEnabled` map; hot-reloaded every 2 s |
| `keepalive.jsonl` | append-only log: `start`, `capture`, `keepalive`, `stop`, `config`, `session-switch`, `record-deleted` |

## Limits (v0.6.1)

- **Per window, off by default.** Use the composer pill in each conversation; the Configure page's
  "新会话默认" only sets the fallback for windows that never chose.
- Turning a window on while it is idle arms it on the next real request (no snapshot is kept while
  it is off).
- Request snapshots stay in memory; a DSH restart re-arms on the next real request.
- The card's yuan figures are estimates at kimi-coding list prices, not a bill.
- Task names come from the session title; a session without a generated title yet falls back to
  `会话 <short id>`.
- Deleting a record removes its `keepalive` lines from `keepalive.jsonl` and stops the current idle
  gap for that session (it re-arms on the next real request); it does not toggle the keepalive.
- No UI for adding routes yet; edit `config.json` (hot-reloaded) for `routes` / `routeIntervals`.
- The hover card's "本次开启" epoch survives a Host reload (it is rebuilt from the
  `session-switch` lines in `keepalive.jsonl`); a window that inherits the config default without
  ever switching explicitly counts from the plugin start instead.
- A `session-switch: true` line whose session is no longer enabled reports nothing: an epoch only
  exists for a window that is currently on (v0.6.1).


---

## Fork notes (dsh-cache-keeper)

Local fork of `hongcha-dsh/dsh-cache-keepalive` v0.6.1 for Claude routes. Changes:

- **Claude-safe defaults**: `intervalMinutes` 4 (Claude's cache TTL is 5 min), `maxTouches` 15, `maxSessions` 3.
- **Per-route prices** (`prices`, CNY / 1M tokens, keyed `provider/model`; built-in entries for kimi and `blsc-anthropic` Claude Sonnet/Opus). Cost and net-savings estimates now follow the replayed route instead of a hard-coded kimi price. Unknown routes are costed at 0.
- **Compact after idle** (opt-in per window): the composer shows a second pill `压缩` next to `保活`. When a window has both on and has been idle `compactAfterMinutes` (default 20, clamped to 5-120), the official compaction runs once (scoped `compaction.compactNow`, falling back to `/compact`) and keep-alive stops for that window. It is marked stopped before the call, so a failure or no-op never retriggers; the next real request re-arms keep-alive. With compaction on for a window, the touch cap is not applied to it (compaction ends the gap). Config: `compactAfterMinutes`, `compactEnabled` (default for windows that never chose, default false), `sessionCompact` (per-window switches); the Configure card has a matching row. `POST /plugins/cache-keepalive/session` accepts `{session, enabled?, compact?}`. Outcome is logged as `kind: "compact"` in `keepalive.jsonl`. Do not install `dsh-auto-compact` together with this: it would compact after 3 idle minutes and defeat the keep-alive.
- Compaction credit: the channel order is taken from `fpm0312/dsh-auto-compact`.

Measured on the AI 智算云 relay (2026-11-18, Claude-Sonnet-5.5): `max_tokens: 0` is *not* honoured (the relay generates a full reply), `max_tokens: 1` is short-circuited and does not touch the cache, `max_tokens >= 2` hits and refreshes the cache. The default `replayMaxTokens: 16` is fine. See `docs/FINDINGS.md`.
