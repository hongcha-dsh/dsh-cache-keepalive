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
| B. Anthropic list (Sonnet 5.5: read 0.05×, write 1.25× of $2/M, at ¥6.667/$) | 0.667 | 16.67 | 66.7 | 24.0 | ≈ 96 min |

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

## Measured run (this plugin, real conversations, 2026-11-18 to 2026-11-19)

From `keepalive.jsonl`: 49 replays, **49 / 49 cache hits (100 %)**, mean 325k tokens read per replay, 104 uncached input tokens and 784 output tokens in total, 3–16 s per replay.
Over the 15 idle gaps that ended with a real request (the newest gap of each session is still open and not counted; a gap whose user never came back cannot be told apart in the log, so the avoided figure is an upper bound):

| | replay spend | avoided rewrite | net | return on spend |
|---|---|---|---|---|
| A (relay list) | ¥3.10 | ¥10.39 | **¥7.28** | **3.3×** |
| B (Anthropic list) | ¥10.66 | ¥74.31 | **¥63.65** | **7.0×** |

Avoided rewrite is `max cacheRead in the gap × (write − hit)`. One gap ran all 15 replays on a 520k conversation (≈ ¥1.52 spent against ¥1.17 avoided under A, a small loss), which is what the 45-minute cap exists to limit.

## Worst-case spend bound

At most `maxSessions` (default 3) sessions are kept alive and each stops at the idle cap (default 45 min = 11 replays): ≤ 33 replays per quiet period, ≈ ¥1.9 under A for three 300k-token conversations, and only when none of them comes back — in which case the cap, the hit-ratio check (a replay that reads < 90 % of its prompt from cache stops the session) and the stale guard (no replay once the cache has probably expired) all apply.

## Compaction (optional, per window)

For a 300k conversation with a 15k fixed prefix, compacted after 20 idle minutes to ~10 % of the rest (≈ 44k tokens):

| path | A | B |
|---|---|---|
| do nothing, come back after 20 min | ¥0.729 | ¥5.00 |
| keep alive 20 min, come back | ¥0.351 | ¥1.21 |
| keep alive 20 min + compact, then come back | ¥0.734 | ¥3.83 |

Whether compaction pays **for the idle gap** depends on the size of the conversation. Compared with letting the cache expire and rewriting `C` tokens, the compaction path pays the extra keep-alive from the idle cap to the compaction time (about 4 more touches), the compaction call (`C` read + a ~5k-token summary as output; the summaries in the log are 1–1.8 万 characters), and one cache write of the shrunken context `P`. It wins only if `P` is below about 19 % of `C` at 49k tokens, 46 % at 141k, 54 % at 327k and 56 % at 522k (relay price A; list price B: 39 / 66 / 74 / 76 %). Measured on this plugin's real compactions (2026-11-18 to 2026-11-20): 522k → 136k saves ≈ ¥0.38 (A) / ¥4.36 (B), 327k → 108k saves ≈ ¥0.16 / ¥2.21, 141k → 49k saves ≈ ¥0.04 / ¥0.73, while a 49k context cannot shrink enough and loses ≈ ¥0.1 (A). All of these assume the user comes back; if not, the extra touches and the compaction call are wasted.

So windows below `compactMinTokens` (default 150000) are not compacted. Beyond the gap itself, compaction also makes every later turn read less, which is the main reason to use it. It is off by default and chosen per window.
