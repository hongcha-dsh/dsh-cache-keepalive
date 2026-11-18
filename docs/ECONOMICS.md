# Keep-alive economics (worked numbers)

Everything here is arithmetic on list prices plus a measured run; it is an estimate, not a bill.

## Model

Anthropic-style prompt cache, 5-minute TTL (refreshed by every request that reads it).
For a context of `C` tokens and per-million-token prices `hit` (cache read), `write` (5-minute cache write), `out`:

- one keep-alive replay costs `C·hit + 16·out` (the replay reads the whole prefix and emits ≤16 tokens)
- if the cache expires, the next real request pays `C·write` instead of `C·hit`, so expiry costs an **extra** `C·(write − hit)`
- break-even number of replays: `k* = (write − hit) / hit`
  (the `16·out` term is ≈ 0.3 % of a replay at C = 300k and is ignored here)
- a replay every 4 minutes means the cache is kept alive for `4·k*` minutes before keeping it costs more than letting it expire

Two price assumptions are shown because the relay's cache-write price is not published:

| | hit | write | out | `k*` | `4·k*` |
|---|---|---|---|---|---|
| A. relay list (AI 智算云 Claude-Sonnet-5.5, ¥/M; read = 0.1× input, write assumed 1.25× input) | 0.1944 | 2.4306 | 9.7222 | 11.5 | ≈ 46 min |
| B. Anthropic list (Sonnet 5.5: read 0.05×, write 1.25× of $2/M, at ¥6.667/$) | 0.667 | 16.67 | 66.7 | 23.9 | ≈ 95 min |

This is why `maxIdleMinutes` defaults to **45**: with a 4-minute interval that is 11 replays, below break-even under both assumptions, so a session that goes quiet can never cost more than letting its cache expire.

## One 300k-token conversation (A / B)

| user comes back after | replays | replay spend (A) | avoided rewrite (A) | **net (A)** | **net (B)** |
|---|---|---|---|---|---|
| 6 min  | 1  | ¥0.058 | ¥0.671 | **+¥0.61** (91 %) | +¥4.60 (96 %) |
| 10 min | 2  | ¥0.117 | ¥0.671 | **+¥0.55** (83 %) | +¥4.40 (92 %) |
| 20 min | 5  | ¥0.292 | ¥0.671 | **+¥0.38** (56 %) | +¥3.80 (79 %) |
| 30 min | 7  | ¥0.409 | ¥0.671 | **+¥0.26** (39 %) | +¥3.39 (71 %) |
| 45 min | 11 | ¥0.643 | ¥0.671 | **+¥0.03** (4 %)  | +¥2.59 (54 %) |
| 60 min | 15 | ¥0.877 | ¥0.671 | −¥0.21 (−31 %)    | +¥1.78 (37 %) |
| 120 min| 30 | ¥1.754 | ¥0.671 | −¥1.08            | −¥1.23 |

"Net" = avoided rewrite − replay spend. Past the break-even the plugin stops by itself (`maxIdleMinutes`), so the negative rows are exactly what the cap prevents.

## Measured run (this plugin, real conversations, 2026-11-18)

From `keepalive.jsonl`: 11 replays, **11 / 11 cache hits (100 %)**, mean 256k tokens read per replay, 24 uncached input tokens and 166 output tokens in total, 4–16 s per replay.
Over the 5 idle gaps that ended with a real request:

| | replay spend | avoided rewrite | net | return on spend |
|---|---|---|---|---|
| A (relay list) | ¥0.415 | ¥2.81 | **¥2.40** | **6.8×** |
| B (Anthropic list) | ¥1.43 | ¥20.11 | **¥18.68** | **14.1×** |

## Worst-case spend bound

At most `maxSessions` (default 3) sessions are kept alive and each stops at the idle cap (default 45 min = 11 replays): ≤ 33 replays per quiet period, ≈ ¥1.9 under A for three 300k-token conversations, and only when none of them comes back — in which case the cap, the hit-ratio check (a replay that reads < 90 % of its prompt from cache stops the session) and the stale guard (no replay once the cache has probably expired) all apply.

## Compaction (optional, per window)

For a 300k conversation with a 15k fixed prefix, compacted after 20 idle minutes to ~10 % of the rest (≈ 44k tokens):

| path | A | B |
|---|---|---|
| do nothing, come back after 20 min | ¥0.729 | ¥5.00 |
| keep alive 20 min, come back | ¥0.351 | ¥1.21 |
| keep alive 20 min + compact, then come back | ¥0.734 | ¥3.83 |

Compaction itself is roughly break-even **for the idle gap** (the summary is output tokens, which are the expensive ones); what it buys is that every later turn reads ~44k instead of 300k tokens (−¥0.05 per turn under A, −¥0.17 under B). It is off by default and chosen per window.
