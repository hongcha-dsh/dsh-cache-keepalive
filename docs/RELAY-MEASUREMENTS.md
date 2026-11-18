# Replay parameters on an Anthropic-compatible relay (measured 2026-11-18)

Model: Claude Sonnet 5.5 through an Anthropic-messages-compatible relay. Test prefix ≈ 13.7k tokens, a new random prefix per run, `cache_control` on the system block and the last user turn, 5-minute cache. Adaptive thinking on/off made no difference.

| replay `max_tokens` | what the relay did | refreshes the cache? |
|---|---|---|
| `0` (the value Anthropic documents for a pure keep-alive) | **not honoured**: generated the full reply (566-594 output tokens), cache read OK | yes, but every replay pays real output tokens |
| `1` | short-circuited: returned a fake one-token reply, `input_tokens: 0`, **no cache fields** | **no** (the cache had expired by the next check) |
| `2` / `4` / `8` / `16` | normal: whole prefix read from cache, only that many output tokens | yes |

Cache lifetime check (new prefix, requests at t = 0, then every 4 min):

| schedule | t = 9 min |
|---|---|
| no replay (control, checked at 6.5 min) | prefix re-written (cache expired) |
| `max_tokens: 0` at t = 4, 8 | still read from cache |
| `max_tokens: 1` at t = 4, 8 | prefix re-written |

Conclusion: use a small positive cap. The plugin defaults `replayMaxTokens` to 16 and refuses anything below 2. Other relays/providers behave differently; the plugin only keeps a route armed after a real request on it has shown a genuine cache hit, and stops a session whose replay does not.

DSH side: the replay goes through `ctx.llm.stream()`, whose usage chunks carry `cacheReadTokens` / `cacheWriteTokens` (omitted when zero); `input` excludes cached tokens, the three are disjoint.
