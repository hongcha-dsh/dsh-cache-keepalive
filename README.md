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
stop before the replays add up to more than the rewrite. The savings arithmetic is below;
[docs/ECONOMICS.md](docs/ECONOMICS.md) has the full tables.

## How much it saves (the math)

Anthropic-style cache, 5-minute TTL, refreshed by every request that reads it. For a context of `C`
tokens, with per-million-token prices `hit` (cache read), `write` (5-minute cache write) and `out`:

- one replay costs `C·hit + 16·out` (it reads the whole prefix and emits at most 16 tokens);
- if the cache expires, the next real request pays `C·write` instead of `C·hit`: an **extra** `C·(write − hit)`;
- so keeping it alive pays off for up to `k* = (write − hit) / hit` replays. At one replay every
  4 minutes that is `4·k*` minutes.

The relay's cache-write price is unpublished, so two assumptions are shown (¥ per million tokens):

| | hit | write | `k*` | `4·k*` |
|---|---|---|---|---|
| A. relay list (Claude-Sonnet-5.5; read 0.1× input, write assumed 1.25× input) | 0.1944 | 2.4306 | 11.5 | ≈ 46 min |
| B. Anthropic list (read 0.05×, write 1.25× of $2/M, at ¥6.667/$) | 0.667 | 16.67 | 24.0 | ≈ 96 min |

That is why the max keep-alive duration defaults to **45 min**: 11 replays at a 4-minute interval, below
break-even under both assumptions, so a conversation that goes quiet never costs more than letting its
cache expire.

One 300k-token conversation, user comes back after:

| idle | replays | replay spend (A) | avoided rewrite (A) | net (A) | net (B) |
|---|---|---|---|---|---|
| 6 min | 1 | ¥0.058 | ¥0.671 | **+¥0.61** (91 %) | +¥4.60 (96 %) |
| 20 min | 5 | ¥0.292 | ¥0.671 | **+¥0.38** (56 %) | +¥3.80 (79 %) |
| 45 min | 11 | ¥0.643 | ¥0.671 | +¥0.03 (4 %) | +¥2.59 (54 %) |
| 60 min | 15 | ¥0.877 | ¥0.671 | −¥0.21 | +¥1.78 |

The negative rows are what the duration cap prevents: past break-even the plugin stops by itself.

Measured with this plugin on real conversations (2026-11-18 to 2026-11-19): 49 / 49 replays hit the
cache, over 15 idle gaps that ended in a real request. ¥3.10 spent against ¥10.39 of avoided rewrites
under A (**3.3× return**), ¥10.66 against ¥74.31 under B (**7.0×**). One of the gaps ran the full
15 replays on a 520k conversation and lost money under A, which is what the duration cap is for. Worst case: 3 conversations × 11 replays, none of which ever comes back, is about ¥1.9 under
A; the hit-ratio check and the stale guard (below) can stop it sooner.

All figures are estimates from list prices, not a bill.

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
- **Hovering the compaction half** opens a card with the countdown to the next automatic compaction (or why
  there is none: off, keep-alive off, waiting for the next message, running, done, cleared by a manual
  `/compact`, or this idle gap already stopped) and the time of the last compaction.
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
| clear countdown on manual compaction | on | when the user runs `/compact` in a window the plugin tracks, that window's auto-compaction countdown is cleared: the now-obsolete request snapshot is dropped and keep-alive/compaction wait for the next real request, which starts a fresh countdown. Off = manual compaction is ignored |
| skip compaction while work is running | on | a background job or subagent of that window still running postpones its auto-compaction (re-checked every scan) until it finishes. Off = only the agent's own idle state is checked |

`maxTouches` (the old setting) is gone; a leftover `maxTouches` in `config.json` is ignored and noted
in the log (`config-notice`).

### How "saved" is counted

Had the cache expired, the next real request would have paid a cache write for the whole prefix
instead of a cache read, so the avoided cost of an idle gap that ended in a real request is
`C × (cold − hit)` (a gap that is still idle has not ended yet: it only subtracts what it has cost so far), where `cold` is the cache-write price (kimi bills an expired prefix at input +
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
- A due replay is deferred while a real stream **on the same route** is in flight (streams on other routes do not
  touch that prefix's cache). If a replay is more than 30 s overdue, one `defer` line with the reason is logged per idle gap.
- **Compaction** (opt-in per window, needs keep-alive on): when the window has been idle `compactAfterMinutes`
  and its agent is idle and has no stream in flight, the official compaction runs once (scoped
  `compaction.compactNow`, falling back to the `/compact` command) outside the replay lock, with a 10 min
  watchdog, and keep-alive stops for that window. If the window still owns a **running background job or subagent** (the agent itself is idle then, waiting for the
  completion notice), the compaction is postponed instead (setting above; one `compact` log line with
  `status: "postponed"` per idle gap, and the compaction card shows "任务中"); keep-alive carries on up to the
  idle cap, `max(maxIdleMinutes, compactAfterMinutes + 1)`, then stops. When the work ends, its completion notice wakes
  the agent; that real request re-arms the window and restarts both countdowns, so a long task is never compacted at
  its end just because the idle time had long passed. (Keep-alive for k touches pays off while
  `k ≤ write/hit − 1`, independent of context size: ~11 touches ≈ 46 min on the relay, ~24 ≈ 95 min at list price; keep
  `maxIdleMinutes` below that.) Only `job` and `subagent` entries count (a pending `schedule` entry, e.g. a reminder due next week, does not). The check asks DSH's `workspace/session-activity` question (the one it asks before archiving a session);
  a host without it is treated as "nothing running", and a failing check postpones the round. A turn that is merely
  waiting on a tool call or subagent has agent status `running`, which was already never compacted. The window is marked stopped *before* the call, so a
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
| `POST /plugins/cache-keepalive/config` | merge a JSON patch of whitelisted fields (`enabled`, `compactEnabled`, `compactSkipWhenBusy`, `compactResetOnManual`, `compactAfterMinutes`, `intervalMinutes`, `maxIdleMinutes`, `replayMaxTokens`, `scanSeconds`, `maxSessions`); values are clamped |
| `POST /plugins/cache-keepalive/session` | `{"session":"<id>","enabled"?:bool,"compact"?:bool}`: one window's switches |
| `GET /plugins/cache-keepalive/task?session=<id>` | one task record plus its per-touch detail |
| `POST /plugins/cache-keepalive/task/delete` | `{"session":"<id>"}`: forget that task record |
| `POST /plugins/cache-keepalive/clientlog`, `GET .../debug` | browser-module load diagnostics |

## Files

| file | purpose |
|---|---|
| `config.json` | live config (not committed), including the per-window `sessionEnabled` / `sessionCompact` maps; hot-reloaded every 2 s (a file that is not valid JSON is ignored and the previous settings are kept); written atomically. `scanSeconds` takes effect after a reload |
| `keepalive.jsonl` | append-only log (not committed): `start`, `capture`, `keepalive`, `stop`, `defer`, `compact` (incl. `postponed`), `config`, `session-switch`, `compact-switch`, `record-deleted` |

## Limits

- Request snapshots stay in memory: after a plugin reload or a DSH restart a window is re-armed by its next
  real request, not before.
- Per window, off by default. Turning a window on while it is idle arms it on the next real request.
- Task names come from the session title; a session without a generated title yet falls back to `会话 <short id>`.
- Deleting a record removes its `keepalive` lines from `keepalive.jsonl` and stops the current idle gap for that
  session (the `session-switch` lines stay: they hold the "本次开启" start); it does not toggle the keep-alive.
- No UI for adding routes or prices yet; edit `config.json` (`routes`, `routeIntervals`, `prices`).
- The settings page texts are Chinese only.

## Tests

`test/keepalive.test.mjs` drives `apply()` with a fake host and mock timers (no network, no API):

```sh
node --test test/keepalive.test.mjs
```

(With DSH Desktop only: `ELECTRON_RUN_AS_NODE=1 "<DSH executable>" --test test/keepalive.test.mjs`.)
