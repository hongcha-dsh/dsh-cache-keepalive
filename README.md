# dsh-cache-keepalive

Host-only Harness bundle + a settings page. While a user-visible main session is idle, it replays
the last real model request (same provider/model/messages/tools/toolHistory/config, only
`maxTokens` lowered) through `ctx.llm.stream()`, so the provider prompt cache stays warm and the
next real turn is billed at the cache-hit price instead of a full re-prefill. Optionally, a window
that stays idle long enough is compacted once (official compaction) and then left alone.

The replay never writes the session, never enters the chat and never executes tools.

## Why this exists

Prompt caches expire: Kimi's after tens of minutes, Anthropic's after 5. A conversation that goes
quiet and resumes pays a full cache write for the whole prefix. A replay every few minutes costs one
cache read of the same prefix, which is 10-40x cheaper than the rewrite it prevents - as long as you
stop before the replays add up to more than the rewrite. See [docs/ECONOMICS.md](docs/ECONOMICS.md)
for the numbers (break-even, per-idle-time savings, a measured run, worst-case spend).

Measured on kimi (2026-11-11, direct API, 10k-token unique prefixes):

| idle gap (no touch) | kimi-coding (`kimi-k3.1-pro`) | huosan |
|---|---|---|
| 10 / 20 / 30 min | 100% cache hit | — |
| 8 min | — | 0% (miss) |
| 45 min | 0% (needs a touch before then) | — |

Replaying with `max_tokens: 16` still hits. Measurements on an Anthropic-compatible relay (including
why `max_tokens: 0` / `1` must not be used for the replay) are in
[docs/RELAY-MEASUREMENTS.md](docs/RELAY-MEASUREMENTS.md).

On subscription routes that do not discount cache reads (e.g. Ark Agent Plan `/api/plan`), keep-alive
saves nothing and only burns quota - leave those routes out of `config.routes`.

## What the user sees

- **Composer oval** `[● 保活 | ● 压缩]` next to the message box. The left half switches keep-alive
  for **that conversation only**; the right half switches idle compaction for that conversation
  (it needs keep-alive on). Each window keeps its own switches; toggling one never changes another.
- **Hovering the keep-alive half** opens a small card with this window's numbers since it was switched
  on: keep-alives, spend, hits, cache-read tokens, net saving, the current idle gap.
- **Settings (⌘,) → 缓存保活**, and the same page on the sidebar **Plugins** page (Official group, and the
  plugin row's *Configure*): status blocks, the editable settings below, the tracked sessions with a
  countdown to their next keep-alive, and a per-conversation record list (click a row for the
  per-touch detail, delete with confirmation).
- **Chat**: nothing. No message, no badge, no tool call.

### Settings

| setting | default | meaning |
|---|---|---|
| default for new windows | off | only for windows that never chose; every window has its own switch |
| interval | 4 min (1-60) | how often to replay; must stay below the provider's cache TTL (Anthropic: 5 min) |
| max keep-alive duration | 45 min (1-1440) | the only length cap per idle gap. The number of keep-alives is *derived*: `floor(duration / interval)`, shown read-only. 45 min keeps a Claude-class route below its break-even |
| replay output cap | 16 (2-64) | `maxTokens` of the replay. At least 2: some relays short-circuit `max_tokens: 1` without touching the cache |
| compaction default / minutes | off / 20 (5-120) | a window with compaction on, idle that long, is compacted once and keep-alive stops for it |

`maxTouches` (the old setting) is gone; a leftover `maxTouches` in `config.json` is ignored and noted
in the log (`config-notice`).

### How "saved" is counted

Had the cache expired, the next real request would have paid a cache write for the whole prefix
instead of a cache read, so the avoided cost of an idle gap that ended in a real request is
`C × (cold − hit)`, where `cold` is the cache-write price (kimi bills an expired prefix at input +
write, so its entries carry `miss: "input+write"`). The estimate subtracts what the replays cost:

```
net = C × (cold − hit) − Σ cost(replay)       # cost = cacheRead·hit + cacheWrite·write + input·in + output·out
```

A gap that only produced misses/errors saved nothing and counts negative. Prices are per route
(`config.prices`, `provider/model` → `{hit, input, output, write, miss?}` per 1M tokens; built-in entries
for kimi and `blsc-anthropic` Claude Sonnet/Opus). A route without a price is costed at 0 and reports no
saving. All figures are estimates, not a bill.

## Behaviour

- **Per-window switch.** `config.sessionEnabled[<sessionId>]` is the authoritative choice for that
  conversation; `config.enabled` is only the default for a session that never chose. A disabled window
  captures nothing and replays nothing; enabling arms on the next real request.
- **Follows the session's model.** It captures the latest real `llm/stream` request per session and
  replays with that request's own provider/model. `config.routes: []` means "any route"; fill it to
  restrict. Per-route pacing lives in `config.routeIntervals` (kimi-coding 20 min, huosan 4 min),
  falling back to `config.intervalMinutes`.
- **Only arms a route it has proof for.** A route is armed only after a real request on it reported a
  genuine cache hit (`cacheRead >= 1024` and `>= 20%` of the prompt). Replays never self-certify.
- Skips subagent/fork sessions, requests with a `purpose` (compaction, titles...) and its own replays.
- Every `scanSeconds` (default 15), due sessions (the most recent `maxSessions`, default 3) are replayed
  one after another: replay once, consume the stream, drop the output. A replay has a 60 s timeout.
- **A replay counts as a hit only if it reads ≥ 90 % of its prompt from the cache.** A miss (including a
  partial hit, or no cache fields at all while input was billed), an error, or an unknown result stops that
  session immediately, so a replay that diverged from the real request cannot keep rewriting the prefix.
- **Stale guard.** The cache is refreshed from the *start* of the last request. If more than 1.25 × the
  interval has passed (machine slept, clock jumped, long queue) the cache has probably expired and the
  session is stopped (`stale`) instead of paying for a cold rewrite - this also applies before a compaction.
- Stops at the max keep-alive duration. A real request re-arms the session.
- A replay in flight when a real request arrives is recorded but does not stop the new idle gap.
- **Compaction** (opt-in per window, needs keep-alive on): when the window has been idle `compactAfterMinutes`
  and its agent is idle and has no stream in flight, the official compaction runs once (scoped
  `compaction.compactNow`, falling back to the `/compact` command) outside the replay lock, with a 10 min
  watchdog, and keep-alive stops for that window. The window is marked stopped *before* the call, so a
  failure or no-op never retriggers. If the agent is busy, compaction is skipped and keep-alive carries on.
  Do not install `dsh-auto-compact` together with this: it compacts after 3 idle minutes and defeats the
  keep-alive. The channel order is taken from [`fpm0312/dsh-auto-compact`](https://github.com/fpm0312/dsh-auto-compact).
- While an agent turn waits on a long tool call or sub-agent, there is no model stream in flight, so the
  keep-alive keeps running; that is intended (the cache would otherwise expire mid-task).

## HTTP endpoints (this machine only)

All routes check the `Host` header (localhost, an IP literal, or the server's own origin) and refuse
requests a browser labels cross-site. `POST` routes additionally need `Content-Type: application/json`,
the header `X-Keepalive: 1` and, if an `Origin` is sent, the same origin as `Host` - so a web page
open in your browser cannot drive them. They expose only token counts, task titles and config - never
prompt text.

| method + path | purpose |
|---|---|
| `GET /plugins/cache-keepalive/state` | config (with the derived `maxTouches`), counters, tracked sessions, per-task records, and `windows` (numbers since that window was switched on, with the interval/limit of its route) |
| `POST /plugins/cache-keepalive/config` | merge a JSON patch of whitelisted fields (`enabled`, `compactEnabled`, `compactAfterMinutes`, `intervalMinutes`, `maxIdleMinutes`, `replayMaxTokens`, `scanSeconds`, `maxSessions`); values are clamped |
| `POST /plugins/cache-keepalive/session` | `{"session":"<id>","enabled"?:bool,"compact"?:bool}`: one window's switches |
| `GET /plugins/cache-keepalive/task?session=<id>` | one task record plus its per-touch detail |
| `POST /plugins/cache-keepalive/task/delete` | `{"session":"<id>"}`: forget that task record |
| `POST /plugins/cache-keepalive/clientlog`, `GET .../debug` | browser-module load diagnostics |

## Files

| file | purpose |
|---|---|
| `config.json` | live config (not committed), including the per-window `sessionEnabled` / `sessionCompact` maps; hot-reloaded every 2 s (a file that is not valid JSON is ignored and the previous settings are kept); written atomically. `scanSeconds` takes effect after a reload |
| `keepalive.jsonl` | append-only log (not committed): `start`, `capture`, `keepalive`, `stop`, `compact`, `config`, `session-switch`, `compact-switch`, `record-deleted` |

## Limits

- Request snapshots stay in memory: after a plugin reload or a DSH restart a window is re-armed by its next
  real request, not before.
- Per window, off by default. Turning a window on while it is idle arms it on the next real request.
- Task names come from the session title; a session without a generated title yet falls back to `会话 <short id>`.
- Deleting a record removes its `keepalive` lines from `keepalive.jsonl` and stops the current idle gap for that
  session; it does not toggle the keep-alive.
- No UI for adding routes or prices yet; edit `config.json` (`routes`, `routeIntervals`, `prices`).
- The settings page texts are Chinese only.

## Tests

`test/keepalive.test.mjs` drives `apply()` with a fake host and mock timers (no network, no API):

```sh
node --test test/keepalive.test.mjs
```

(With DSH Desktop only: `ELECTRON_RUN_AS_NODE=1 "<DSH executable>" --test test/keepalive.test.mjs`.)
