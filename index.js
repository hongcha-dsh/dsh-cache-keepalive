/**
 * dsh-cache-keepalive — Host-only bundle.
 *
 * What it does: while a user-visible main session sits idle, replay the last real
 * model request (same provider/model/messages/tools/toolHistory/config, only
 * `maxTokens` lowered) so the provider's prompt cache stays warm. The replay is a
 * direct `ctx.llm.stream()` call: it never enters the agent loop, never appends a
 * session event, never executes tools and never shows up in the chat UI.
 *
 * Why: Kimi's cache is billed at 1/10 of the miss price. A replay that hits costs
 * one cache-read pass; letting the cache expire costs a full-price re-prefill.
 * Measured on 2026-11-11: kimi-coding keeps a 10k-token prefix warm for 30+ min
 * (45 min -> miss), huosan dies after ~5 min. Interval must stay below the
 * measured TTL; this plugin is interval-driven, not TTL-guessing.
 *
 * Safety:
 *   - Only user-visible main sessions are armed (subagent/fork sessions skipped).
 *   - Only routes listed in config.routes are touched.
 *   - A replay that misses (cacheRead === 0) disables that session immediately.
 *   - Hard caps: maxIdleMinutes per idle gap (the touch count is derived from it: maxIdleMinutes / interval), one replay in flight.
 *   - Config is re-read from config.json when the file changes (2s poll).
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = fileURLToPath(new URL('.', import.meta.url));
const CONFIG_PATH = PLUGIN_DIR + 'config.json';
const LOG_PATH = PLUGIN_DIR + 'keepalive.jsonl';

const DEFAULTS = {
  /** Default for a session that never chose explicitly (per-window switches win). */
  enabled: false,
  /** sessionId -> boolean: the per-conversation switch owned by the composer pill. */
  sessionEnabled: {},
  /** Must stay below the route's cache TTL; Claude's is 5 min, so 4 is the safe default. */
  intervalMinutes: 4,
  maxIdleMinutes: 45,
  /** Idle minutes (5-120) before a compaction-enabled window is compacted once, after which keep-alive stops for it. */
  compactAfterMinutes: 20,
  /** Default for a window that never chose explicitly. Off: compaction is always opt-in per window. */
  compactEnabled: false,
  /** A manual compaction (the user's /compact) clears that window's auto-compaction countdown: the obsolete snapshot is dropped and keep-alive/compaction wait for the next real request. */
  compactResetOnManual: true,
  /** Do not auto-compact a window while a background job or a subagent it started is still running (the agent itself is idle, so its status alone does not show it). */
  compactSkipWhenBusy: true,
  /** sessionId -> boolean: the per-window compaction switch (needs that window's keep-alive on). */
  sessionCompact: {},
  /** Optional per-route price override (CNY / 1M tokens), keyed "provider/model": { hit, input, output, write }. */
  prices: {},
  replayMaxTokens: 16,
  scanSeconds: 15,
  maxSessions: 3,
  /** Empty list = follow whatever model the conversation is using. */
  routes: [],
  /** Optional per-route interval override, keyed "provider/model". */
  routeIntervals: { 'kimi-coding/kimi-k3.1-pro': 20, 'huosan/kimi-k3.1-pro': 4 },
  /** Arm a route only after a real request on it reported cacheRead > 0. */
  requireProvenCache: true
};

function normalizeConfig(raw) {
  const cfg = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  cfg.routes = (Array.isArray(cfg.routes) ? cfg.routes : [])
    .filter((route) => route && typeof route.provider === 'string' && typeof route.model === 'string')
    .map((route) => ({ provider: route.provider, model: route.model }));
  const intervals = {};
  if (cfg.routeIntervals && typeof cfg.routeIntervals === 'object') {
    for (const [key, value] of Object.entries(cfg.routeIntervals)) {
      const minutes = Number(value);
      if (typeof key === 'string' && Number.isFinite(minutes) && minutes > 0) intervals[key] = Math.min(Math.max(minutes, 1), 60);
    }
  }
  cfg.routeIntervals = intervals;
  const perSession = {};
  if (cfg.sessionEnabled && typeof cfg.sessionEnabled === 'object' && !Array.isArray(cfg.sessionEnabled)) {
    for (const [sessionId, value] of Object.entries(cfg.sessionEnabled)) {
      if (typeof sessionId === 'string' && sessionId.length > 0 && typeof value === 'boolean') perSession[sessionId] = value;
    }
  }
  cfg.sessionEnabled = perSession;
  cfg.requireProvenCache = cfg.requireProvenCache !== false;
  if (!Number.isFinite(cfg.intervalMinutes) || cfg.intervalMinutes <= 0) cfg.intervalMinutes = DEFAULTS.intervalMinutes;
  if (!Number.isFinite(cfg.maxIdleMinutes) || cfg.maxIdleMinutes <= 0) cfg.maxIdleMinutes = DEFAULTS.maxIdleMinutes;
  // Legacy key: the touch count is now derived from maxIdleMinutes / intervalMinutes, never configured.
  delete cfg.maxTouches;
  cfg.intervalMinutes = Math.min(Math.max(cfg.intervalMinutes, 1), 60);
  cfg.maxIdleMinutes = Math.min(cfg.maxIdleMinutes, 1440);
  if (!Number.isFinite(cfg.replayMaxTokens) || cfg.replayMaxTokens < 1) cfg.replayMaxTokens = DEFAULTS.replayMaxTokens;
  // >= 2: a relay may short-circuit max_tokens=1 without touching the cache.
  cfg.replayMaxTokens = Math.min(Math.max(Math.floor(cfg.replayMaxTokens), 2), 64);
  if (!Number.isFinite(cfg.scanSeconds) || cfg.scanSeconds < 5) cfg.scanSeconds = DEFAULTS.scanSeconds;
  cfg.scanSeconds = Math.min(cfg.scanSeconds, 300);
  if (!Number.isFinite(cfg.maxSessions) || cfg.maxSessions < 1) cfg.maxSessions = DEFAULTS.maxSessions;
  cfg.maxSessions = Math.min(Math.floor(cfg.maxSessions), 10);
  const compact = Number(cfg.compactAfterMinutes);
  cfg.compactAfterMinutes = Number.isFinite(compact) && compact > 0 ? Math.min(120, Math.max(5, compact)) : DEFAULTS.compactAfterMinutes;
  cfg.compactEnabled = cfg.compactEnabled === true;
  cfg.compactResetOnManual = cfg.compactResetOnManual !== false;
  cfg.compactSkipWhenBusy = cfg.compactSkipWhenBusy !== false;
  const perSessionCompact = {};
  if (cfg.sessionCompact && typeof cfg.sessionCompact === 'object' && !Array.isArray(cfg.sessionCompact)) {
    for (const [sessionId, value] of Object.entries(cfg.sessionCompact)) {
      if (typeof sessionId === 'string' && sessionId.length > 0 && typeof value === 'boolean') perSessionCompact[sessionId] = value;
    }
  }
  cfg.sessionCompact = perSessionCompact;
  const prices = {};
  if (cfg.prices && typeof cfg.prices === 'object' && !Array.isArray(cfg.prices)) {
    for (const [key, value] of Object.entries(cfg.prices)) {
      if (value && [value.hit, value.input, value.output, value.write].every((n) => Number.isFinite(Number(n)) && Number(n) >= 0)) {
        prices[key] = { hit: Number(value.hit), input: Number(value.input), output: Number(value.output), write: Number(value.write), ...(value.miss === 'input+write' ? { miss: 'input+write' } : {}) };
      }
    }
  }
  cfg.prices = prices;
  cfg.enabled = cfg.enabled === true;
  return cfg;
}

/** Missing file -> defaults. A file that exists but cannot be parsed -> null, so callers keep the config they already have. */
function loadConfig() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch {
    return normalizeConfig(DEFAULTS);
  }
  try {
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

function saveConfig(cfg) {
  const normalized = normalizeConfig(cfg);
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2) + '\n');
  fs.renameSync(tmp, CONFIG_PATH);
  return normalized;
}

function appendLog(record) {
  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n');
  } catch {
    /* logging must never break the plugin */
  }
}

/** A replay is a tiny request; anything slower than this is hung, and must not hold the lock. */
const REPLAY_TIMEOUT_MS = 60_000;
/** `workspace/session-activity` kinds that postpone a compaction. `turn` is covered by agent.status; `schedule` (a task due later) must not block it. */
const BLOCKING_KINDS = new Set(['job', 'subagent']);
/** Share of the replayed prompt that must come from cache to count as a hit. */
const HIT_RATIO = 0.9;

/** Fields the HTTP endpoint may change; routes, prices and per-window maps stay file-only (or have their own endpoint). */
const CONFIG_PATCH_KEYS = ['enabled', 'compactEnabled', 'compactResetOnManual', 'compactSkipWhenBusy', 'compactAfterMinutes', 'intervalMinutes', 'maxIdleMinutes', 'replayMaxTokens', 'scanSeconds', 'maxSessions'];

export const name = 'cache-keepalive';
export const inject = ['llm', 'sessions'];

export function apply(ctx) {
  let cfg = loadConfig() ?? normalizeConfig(DEFAULTS);
  /** sessionId -> { snapshot, lastRealAt, touches, nextDueAt, stopped } */
  const sessions = new Map();
  /** replay option objects created by this plugin: never captured, never observed. */
  const replaying = new WeakSet();
  /** sessionIds with a real model stream in flight. */
  /**
   * Real streams in flight, per session AND route. A stream on a different route (a persona rewrite, a
   * title call...) does not touch the replayed prefix's cache, so it must not hold the replay back.
   */
  const inflightCounts = new Map();
  const inflight = {
    add(id, route = '') { const k = id + '|' + route; inflightCounts.set(k, (inflightCounts.get(k) ?? 0) + 1); },
    delete(id, route = '') { const k = id + '|' + route; const n = (inflightCounts.get(k) ?? 0) - 1; if (n > 0) inflightCounts.set(k, n); else inflightCounts.delete(k); },
    /** `route` omitted: any route of this session. */
    has(id, route) {
      if (route !== undefined) return (inflightCounts.get(id + '|' + route) ?? 0) > 0;
      for (const [k, n] of inflightCounts) if (n > 0 && k.startsWith(id + '|')) return true;
      return false;
    }
  };
  /** Sessions with a compaction running (compaction runs outside the global replay lock). */
  const compacting = new Set();
  let busy = false;

  // ---- status surface (settings page card) ----
  const startedAt = Date.now();
  /** Every keepalive outcome on disk plus live ones: drives the per-task records. */
  const history = [];
  const HISTORY_MAX = 5000;
  const EMPTY_STATS = { touches: 0, hits: 0, misses: 0, unknown: 0, errors: 0, cacheRead: 0, input: 0, output: 0, cost: 0 };
  const stats = { ...EMPTY_STATS };
  /**
   * sessionId -> epoch ms of the last time that window's keepalive was switched
   * on. Rebuilt from the `session-switch` log lines on load, so "本次开启" keeps
   * the same meaning across a Host reload.
   */
  const enabledSince = new Map();
  /** sessionId -> last title seen in the log file (sessions no longer in memory). */
  const storedTitles = new Map();
  /** sessionId -> { title, scannedSeq }: incremental reader of `session/title` events. */
  const titleCache = new Map();
  /** Browser-side diagnostics reported by client.js (bundle load, slot registration errors). */
  const clientDiagnostics = [];
  /**
   * CNY per 1M tokens, keyed "provider/model". Estimate labels only, not a bill.
   * kimi: official domestic list price. blsc-anthropic: AI 智算云 market price
   * (hit = 0.1 x input); its cache-write price is not published, so write is
   * assumed to be Anthropic's standard 1.25 x input. Override via config.prices.
   * A route with no entry here is costed at 0 and reports no savings.
   */
  const DEFAULT_PRICES = {
    // miss: 'input+write' = this vendor bills an expired prefix at the input price AND a cache write (kimi's official billing).
    // The default (omitted) is Anthropic-style: an expired prefix is billed once, at the cache-write price.
    'kimi-coding/kimi-k3.1-pro': { hit: 1.3, input: 13, output: 68, write: 13, miss: 'input+write' },
    'huosan/kimi-k3.1-pro': { hit: 1.3, input: 13, output: 68, write: 13, miss: 'input+write' },
    'blsc-anthropic/Claude-Sonnet-5.5': { hit: 0.1944, input: 1.9444, output: 9.7222, write: 2.4306 },
    'blsc-anthropic/Claude-Opus-5.5': { hit: 0.3889, input: 3.8889, output: 19.4444, write: 4.8611 }
  };
  const NO_PRICE = { hit: 0, input: 0, output: 0, write: 0 };
  function priceFor(provider, model) {
    const key = routeKeyOf(provider, model);
    return cfg.prices[key] ?? DEFAULT_PRICES[key] ?? NO_PRICE;
  }
  function priceOf(record) {
    const price = priceFor(record.provider, record.model);
    return ((record.cacheRead ?? 0) * price.hit + (record.cacheWrite ?? 0) * price.write + (record.input ?? 0) * price.input + (record.output ?? 0) * price.output) / 1e6;
  }
  function remember(record) {
    history.push(record);
    if (history.length > HISTORY_MAX) history.shift();
  }
  function addToStats(record) {
    stats.touches += 1;
    if (record.status === 'hit') stats.hits += 1;
    else if (record.status === 'miss') stats.misses += 1;
    else if (record.status === 'unknown') stats.unknown += 1;
    else stats.errors += 1;
    stats.cacheRead += record.cacheRead ?? 0;
    stats.input += record.input ?? 0;
    stats.output += record.output ?? 0;
    stats.cost += priceOf(record);
  }
  function recomputeStats() {
    for (const key of Object.keys(stats)) stats[key] = 0;
    for (const record of history) addToStats(record);
  }
  function loadHistory() {
    try {
      const lines = fs.readFileSync(LOG_PATH, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (record === null || typeof record !== 'object') continue;
        if (record.kind === 'session-switch') {
          // The switch log is the only durable trace of when a window went on,
          // so the tooltip's "本次开启" survives a Host reload.
          const at = Date.parse(record.ts);
          if (typeof record.session === 'string' && record.session.length > 0 && Number.isFinite(at)) {
            if (record.enabled === true) enabledSince.set(record.session, at);
            else enabledSince.delete(record.session);
          }
          continue;
        }
        if (record.kind !== 'keepalive') continue;
        remember(record);
        if (typeof record.session === 'string' && typeof record.title === 'string' && record.title.length > 0) {
          storedTitles.set(record.session, record.title);
        }
      }
    } catch {
      /* no history yet */
    }
    recomputeStats();
  }
  loadHistory();

  function routeKeyOf(provider, model) {
    return String(provider) + '/' + String(model);
  }
  function intervalFor(provider, model) {
    const overrides = cfg.routeIntervals && typeof cfg.routeIntervals === 'object' ? cfg.routeIntervals : {};
    const minutes = Number(overrides[routeKeyOf(provider, model)]);
    return (Number.isFinite(minutes) && minutes > 0 ? minutes : cfg.intervalMinutes) * 60_000;
  }
  /** "provider/model" -> { provider, model, proven, lastCacheRead, samples } */
  const routeStats = new Map();
  function routeState(provider, model) {
    const key = routeKeyOf(provider, model);
    let state = routeStats.get(key);
    if (state === undefined) {
      state = { provider, model, proven: false, lastCacheRead: 0, samples: 0 };
      routeStats.set(key, state);
    }
    return state;
  }

  /** `agents` / `commands` are only needed for compaction: fetched lazily so the keep-alive part works without them. */
  function optionalService(name) {
    try {
      const service = ctx.get(name);
      if (service !== undefined && service !== null) return service;
    } catch {
      /* not mounted */
    }
    try {
      return ctx[name];
    } catch {
      return undefined;
    }
  }

  function sessionsService() {
    try {
      return ctx.get('sessions');
    } catch {
      return undefined;
    }
  }

  function isNotUserVisibleMainSession(sessionId) {
    try {
      const session = sessionsService()?.get(sessionId);
      if (session === undefined) return false;
      const header = session.header;
      if (header?.origin === 'subagent') return true;
      if (header?.parentSession !== undefined) return true;
      return false;
    } catch {
      return false;
    }
  }

  /**
   * The task name shown in the record list is the conversation's title: the log
   * carries `session/title` events and the last one wins. Reading is incremental
   * (`scannedSeq`), so a poll on a large session only slices new events.
   */
  function sessionTitle(sessionId) {
    try {
      const session = sessionsService()?.get(sessionId);
      if (session === undefined || session === null) return null;
      // The session-title service folds `session/title` events for us; the log
      // scan below is only the fallback when that service is unavailable.
      try {
        const service = ctx.get('sessionTitle');
        const snapshot = service?.get?.(session);
        if (snapshot !== undefined && snapshot !== null && typeof snapshot.title === 'string' && snapshot.title.trim().length > 0) {
          return snapshot.title.trim();
        }
      } catch {
        /* fall through to the log scan */
      }
      const cached = titleCache.get(sessionId);
      const from = cached === undefined ? 0 : cached.scannedSeq;
      let events = [];
      try {
        if (typeof session.snapshotEvents === 'function') events = session.snapshotEvents(from);
        else if (Array.isArray(session.log)) events = session.log.slice(from);
      } catch {
        events = [];
      }
      let title = cached === undefined ? null : cached.title;
      let scanned = from;
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        if (event === null || typeof event !== 'object') continue;
        const seq = typeof event.seq === 'number' ? event.seq : from + index;
        if (seq + 1 > scanned) scanned = seq + 1;
        if (event.type !== 'session/title') continue;
        const value = event.data && typeof event.data.title === 'string' ? event.data.title.trim() : '';
        if (value.length > 0) title = value;
      }
      titleCache.set(sessionId, { title, scannedSeq: scanned });
      return title;
    } catch {
      return null;
    }
  }

  function routeAllowed(provider, model) {
    const routes = Array.isArray(cfg.routes) ? cfg.routes : [];
    if (routes.length === 0) return true;
    return routes.some((route) => route.provider === provider && route.model === model);
  }

  /** Per-window switch: explicit session choice wins over the config default. */
  function sessionEnabledOf(sessionId) {
    const map = cfg.sessionEnabled && typeof cfg.sessionEnabled === 'object' ? cfg.sessionEnabled : {};
    if (Object.prototype.hasOwnProperty.call(map, sessionId)) return map[sessionId] === true;
    return cfg.enabled === true;
  }
  /**
   * Insert/overwrite a switch at the tail. Past 300 entries drop the ones that merely repeat the
   * default first (they change nothing), oldest first; only then the oldest remaining entry.
   */
  function withSwitch(source, sessionId, value, defaultValue) {
    const map = { ...(source && typeof source === 'object' ? source : {}) };
    delete map[sessionId];
    map[sessionId] = value === true;
    if (Object.keys(map).length > 300) {
      for (const key of Object.keys(map)) {
        if (Object.keys(map).length <= 300) break;
        if (key !== sessionId && map[key] === (defaultValue === true)) delete map[key];
      }
      for (const key of Object.keys(map)) {
        if (Object.keys(map).length <= 300) break;
        if (key !== sessionId) delete map[key];
      }
    }
    return map;
  }
  function setSessionEnabledOf(sessionId, enabled) {
    cfg = saveConfig({ ...cfg, sessionEnabled: withSwitch(cfg.sessionEnabled, sessionId, enabled, cfg.enabled) });
    // Turning a window on starts a fresh "本次开启" epoch; turning it off drops it.
    if (enabled === true) enabledSince.set(sessionId, Date.now());
    else enabledSince.delete(sessionId);
    if (enabled !== true) sessions.delete(sessionId);
    appendLog({ kind: 'session-switch', session: sessionId, enabled: enabled === true });
  }

  /** Per-window compaction switch: explicit window choice wins over the config default. */
  function compactEnabledOf(sessionId) {
    const map = cfg.sessionCompact && typeof cfg.sessionCompact === 'object' ? cfg.sessionCompact : {};
    if (Object.prototype.hasOwnProperty.call(map, sessionId)) return map[sessionId] === true;
    return cfg.compactEnabled === true;
  }
  function setSessionCompactOf(sessionId, enabled) {
    cfg = saveConfig({ ...cfg, sessionCompact: withSwitch(cfg.sessionCompact, sessionId, enabled, cfg.compactEnabled) });
    appendLog({ kind: 'compact-switch', session: sessionId, enabled: enabled === true });
  }

  function prune() {
    if (sessions.size <= cfg.maxSessions) return;
    const newestFirst = [...sessions.entries()].sort((a, b) => b[1].lastRealAt - a[1].lastRealAt);
    for (const [sessionId] of newestFirst.slice(cfg.maxSessions)) sessions.delete(sessionId);
  }

  /**
   * Net saving of one idle gap that ended in a real request. Had the cache expired, the
   * next request would have paid `coldPerM` (Anthropic-style: one cache write; kimi:
   * input + write) instead of the live-cache read `hit`, i.e. it avoids C * (cold - hit).
   * Keeping the cache warm cost the replays themselves (reads + their tiny output), summed
   * in gap.cost. net = C * (cold - hit) - gap.cost. A gap whose only outcomes were
   * misses/errors saved nothing and cost cash.
   */
  function summarizeSession(records, lastGapOpen = false) {
    const summary = { touches: 0, hits: 0, misses: 0, errors: 0, unknown: 0, cacheRead: 0, input: 0, output: 0, cost: 0, saved: 0 };
    const gaps = [];
    let previousTouch = 0;
    for (const record of records) {
      const cost = priceOf(record);
      summary.touches += 1;
      summary.cost += cost;
      summary.cacheRead += record.cacheRead ?? 0;
      summary.input += record.input ?? 0;
      summary.output += record.output ?? 0;
      if (record.status === 'hit') summary.hits += 1;
      else if (record.status === 'miss') summary.misses += 1;
      else if (record.status === 'error') summary.errors += 1;
      else summary.unknown += 1;
      const touch = Number(record.touch) || 0;
      let gap = gaps[gaps.length - 1];
      // `touch` restarts at 1 whenever a real request re-captures the session.
      if (gap === undefined || touch <= previousTouch) {
        gap = { touches: 0, cache: 0, hit: false, cost: 0, provider: record.provider, model: record.model };
        gaps.push(gap);
      }
      previousTouch = touch;
      gap.touches = Math.max(gap.touches, touch);
      gap.cost += cost;
      if (record.status === 'hit' && (record.cacheRead ?? 0) > 0) {
        gap.cache = Math.max(gap.cache, record.cacheRead);
        gap.hit = true;
      }
    }
    for (const [gapIndex, gap] of gaps.entries()) {
      // A gap that has not ended in a real request yet saved nothing so far: it only counts what it cost.
      if (lastGapOpen && gapIndex === gaps.length - 1) {
        summary.saved -= gap.cost;
        continue;
      }
      const price = priceFor(gap.provider, gap.model);
      // What the NEXT real request would have cost, per 1M tokens, had the cache expired, minus what it costs on a live cache.
      const coldPerM = price.miss === 'input+write' ? price.input + price.write : price.write;
      const avoidedPerM = Math.max(0, coldPerM - price.hit);
      summary.saved += gap.hit
        ? (gap.cache * avoidedPerM) / 1e6 - gap.cost
        : -gap.cost;
    }
    summary.cost = +summary.cost.toFixed(6);
    summary.saved = +summary.saved.toFixed(6);
    return summary;
  }

  /** True while the session's newest idle gap has no real request after it (the user has not come back yet). */
  function lastGapOpenOf(sessionId, records) {
    const entry = sessions.get(sessionId);
    const last = records[records.length - 1];
    if (entry === undefined || last === undefined) return false;
    return entry.lastRealAt < Date.parse(last.ts);
  }

  /**
   * Epoch of the current "本次开启" for one window: the last time its switch went
   * on. A window that never switched explicitly but inherits the config default
   * counts from the moment this plugin started keeping it alive.
   */
  function epochSinceOf(sessionId) {
    // A window that is off has no epoch at all: nothing can be "since it was
    // switched on". Without this gate a stale `session-switch` line in the log
    // (the window was switched on once, the config no longer knows it) would
    // report an epoch for a window that is closed.
    if (!sessionEnabledOf(sessionId)) return null;
    const explicit = enabledSince.get(sessionId);
    if (explicit !== undefined) return explicit;
    return startedAt;
  }

  /**
   * Per-window numbers since that window was switched on — what the composer
   * pill shows on hover. Turning the window on again resets them, so "本次开启"
   * is literally this enablement, not the whole history.
   */
  function buildWindows() {
    const ids = new Set([...enabledSince.keys(), ...sessions.keys()]);
    const buckets = new Map();
    for (const record of history) {
      const sessionId = record.session;
      if (typeof sessionId !== 'string' || sessionId.length === 0) continue;
      ids.add(sessionId);
      let bucket = buckets.get(sessionId);
      if (bucket === undefined) {
        bucket = [];
        buckets.set(sessionId, bucket);
      }
      bucket.push(record);
    }
    const windows = {};
    for (const sessionId of ids) {
      const enabled = sessionEnabledOf(sessionId);
      // Only windows that are actually being kept alive right now: a closed
      // window has nothing to report, and the pill shows its own "off" card.
      if (!enabled) continue;
      const since = epochSinceOf(sessionId);
      const all = buckets.get(sessionId) ?? [];
      const kept = since === null
        ? []
        : all.filter((record) => {
          const at = Date.parse(record.ts);
          return Number.isFinite(at) && at >= since;
        });
      const entry = sessions.get(sessionId);
      windows[sessionId] = {
        enabled,
        compact: compactEnabledOf(sessionId),
        since: since === null ? null : since,
        ...summarizeSession(kept, lastGapOpenOf(sessionId, kept)),
        lastAt: kept.length > 0 ? kept[kept.length - 1].ts : null,
        gapTouches: entry === undefined ? 0 : entry.touches,
        ...routeLimits(sessionId, entry),
        ...compactionInfo(sessionId, entry),
        stopped: entry === undefined ? false : entry.stopped,
        idleMinutes: entry === undefined ? null : +((Date.now() - entry.lastRealAt) / 60000).toFixed(1),
        nextDueSeconds: entry === undefined ? null : Math.max(0, Math.round((entry.nextDueAt - Date.now()) / 1000))
      };
    }
    return windows;
  }

  /** One record per task (conversation), newest first. */
  function buildTasks() {
    const groups = new Map();
    for (const record of history) {
      const sessionId = record.session;
      if (typeof sessionId !== 'string' || sessionId.length === 0) continue;
      let group = groups.get(sessionId);
      if (group === undefined) {
        group = [];
        groups.set(sessionId, group);
      }
      group.push(record);
    }
    const tasks = [];
    for (const [sessionId, records] of groups) {
      const latest = records[records.length - 1];
      const title = sessionTitle(sessionId)
        ?? storedTitles.get(sessionId)
        ?? (typeof latest?.title === 'string' ? latest.title : '');
      tasks.push({
        id: sessionId,
        title: title.length > 0 ? title : '会话 ' + sessionId.replace(/^session-/, '').slice(0, 8),
        enabled: sessionEnabledOf(sessionId),
        provider: latest?.provider ?? null,
        model: latest?.model ?? null,
        firstAt: records[0]?.ts ?? null,
        lastAt: latest?.ts ?? null,
        ...summarizeSession(records, lastGapOpenOf(sessionId, records))
      });
    }
    tasks.sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
    return tasks;
  }

  /** Per-touch detail of one task record, oldest first (last 200). */
  function taskRecords(sessionId) {
    return history
      .filter((record) => record.session === sessionId)
      .slice(-200)
      .map((record) => ({
        ts: record.ts,
        touch: record.touch ?? null,
        status: record.status,
        cacheRead: record.cacheRead ?? null,
        input: record.input ?? null,
        output: record.output ?? null,
        ms: record.ms ?? null,
        cost: +priceOf(record).toFixed(6)
      }));
  }

  /** Forget one task: drop its keepalive lines from disk (switch/capture lines stay, they carry the "本次开启" start) and stop its current idle gap. */
  function deleteTask(sessionId) {
    try {
      let kept = [];
      try {
        const raw = fs.readFileSync(LOG_PATH, 'utf8');
        kept = raw.split(/\r?\n/).filter((line) => {
          if (line.trim().length === 0) return false;
          try {
            const record = JSON.parse(line);
            return !(record !== null && typeof record === 'object' && record.session === sessionId && record.kind === 'keepalive');
          } catch {
            return true;
          }
        });
      } catch {
        kept = [];
      }
      fs.writeFileSync(LOG_PATH, kept.length > 0 ? kept.join('\n') + '\n' : '');
      for (let index = history.length - 1; index >= 0; index -= 1) {
        if (history[index].session === sessionId) history.splice(index, 1);
      }
      storedTitles.delete(sessionId);
      titleCache.delete(sessionId);
      sessions.delete(sessionId);
      recomputeStats();
      return true;
    } catch (error) {
      ctx.logger?.warn?.('cache-keepalive: delete record failed: ' + String(error?.message ?? error));
      return false;
    }
  }

  function capture(options) {
    if (options === null || typeof options !== 'object') return;
    if (replaying.has(options)) return;
    if (options.purpose !== undefined) return;
    const sessionId = options.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    if (!sessionEnabledOf(sessionId)) {
      // This window is switched off: forget its snapshot so nothing gets replayed.
      sessions.delete(sessionId);
      return;
    }
    if (!routeAllowed(options.provider, options.model)) return;
    if (isNotUserVisibleMainSession(sessionId)) return;

    const now = Date.now();
    const existing = sessions.get(sessionId);
    const title = sessionTitle(sessionId);
    if (existing === undefined) {
      sessions.set(sessionId, {
        snapshot: options,
        lastRealAt: now,
        touches: 0,
        nextDueAt: now + intervalFor(options.provider, options.model),
        stopped: false,
        gen: 0,
        lastTouchAt: now,
        title
      });
      appendLog({ kind: 'capture', session: sessionId, title, provider: options.provider, model: options.model, messages: Array.isArray(options.messages) ? options.messages.length : null, toolHistory: Array.isArray(options.toolHistory) ? options.toolHistory.length : null, tools: Array.isArray(options.tools) ? options.tools.length : null });
    } else {
      existing.snapshot = options;
      existing.lastRealAt = now;
      existing.touches = 0;
      existing.nextDueAt = now + intervalFor(options.provider, options.model);
      existing.stopped = false;
      existing.gen = (existing.gen ?? 0) + 1;
      existing.deferLogged = false;
      existing.blockLogged = false;
      existing.compactBlocked = undefined;
      existing.lastTouchAt = now;
      if (title !== null && title.length > 0) existing.title = title;
    }
    prune();
  }

  function observe(iterable, sessionId, route) {
    return (async function* observeStream() {
      // Marked in-flight only once iteration starts, so a stream that is closed
      // before its first pull can never leave the session stuck as in-flight.
      inflight.add(sessionId, route);
      try {
        for await (const chunk of iterable) {
          try {
            if (chunk !== null && typeof chunk === 'object' && chunk.type === 'usage' && chunk.usage) {
              const snapshot = sessions.get(sessionId)?.snapshot;
              if (snapshot !== undefined) {
                const route = routeState(snapshot.provider, snapshot.model);
                route.samples += 1;
                const cacheRead = chunk.usage.cacheReadTokens ?? chunk.usage.cacheRead ?? 0;
                const uncached = chunk.usage.inputTokens ?? chunk.usage.input ?? 0;
                route.lastCacheRead = cacheRead;
                const total = cacheRead + uncached;
                if (cacheRead >= 1024 && total > 0 && cacheRead / total >= 0.2) route.proven = true;
              }
            }
          } catch {
            /* usage inspection must never disturb the stream */
          }
          yield chunk;
        }
      } finally {
        inflight.delete(sessionId, route);
      }
    })();
  }

  function buildReplayOptions(snapshot, signal) {
    const { signal: _ignored, ...rest } = snapshot;
    const options = { ...rest, maxTokens: cfg.replayMaxTokens, signal };
    replaying.add(options);
    return options;
  }

  /** Run the official compaction once. Mirrors dsh-auto-compact's channel order: scoped service first, `/compact` command second. */
  async function runCompaction(agent, signal) {
    let compaction;
    try {
      compaction = agent?.ctx?.get?.('compaction');
    } catch {
      compaction = undefined;
    }
    if (compaction !== undefined && compaction !== null && typeof compaction.compactNow === 'function') {
      const result = await compaction.compactNow(agent, signal);
      if (result === null) return { via: 'service', kind: 'noop', text: 'nothing to compact' };
      const tokens = typeof result.shadowedTokenCount === 'number' ? result.shadowedTokenCount : 0;
      return { via: 'service', kind: 'success', text: 'compacted ~' + tokens + ' tokens' };
    }
    const commands = optionalService('commands');
    if (commands === undefined || typeof commands.execute !== 'function') return { via: 'command', kind: 'missing', text: 'no command service' };
    const execution = await commands.execute(agent, '/compact', [], signal);
    if (execution === undefined) return { via: 'command', kind: 'missing', text: 'no /compact command in this session' };
    const result = execution.result ?? {};
    return { via: 'command', kind: result.kind ?? 'unknown', text: result.text ?? '' };
  }

  /** Reject when `signal` aborts, so a call that ignores its signal still cannot hold a lock forever. */
  function abortRace(signal, message) {
    return new Promise((_, reject) => {
      if (signal.aborted) reject(new Error(message));
      else signal.addEventListener('abort', () => reject(new Error(message)), { once: true });
    });
  }

  /**
   * Is a background job or a subagent that belongs to this window still running? The agent is idle in that case
   * (it ended its turn and waits for the completion notice), so `agent.status` alone cannot tell. DSH answers this
   * through the `workspace/session-activity` waterfall (the same question it asks before archiving a session).
   * No such event (older DSH) = nothing to check; a failed check postpones the compaction to the next scan.
   * Records why in `entry.compactBlocked` (shown on the compaction hover card) and logs once per idle gap.
   */
  async function hasRunningWork(sessionId, entry) {
    if (typeof ctx.waterfall !== 'function') return false;
    let activity;
    try {
      activity = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]));
    } catch (error) {
      entry.compactBlocked = { at: Date.now(), kinds: ['unknown'] };
      if (entry.blockLogged !== true) {
        entry.blockLogged = true;
        appendLog({ kind: 'compact', session: sessionId, status: 'postponed', reason: 'activity-check-failed', error: String(error?.message ?? error) });
      }
      return true;
    }
    const kinds = (Array.isArray(activity) ? activity : []).map((a) => String(a?.kind)).filter((k) => BLOCKING_KINDS.has(k));
    if (kinds.length === 0) {
      entry.compactBlocked = undefined;
      return false;
    }
    entry.compactBlocked = { at: Date.now(), kinds };
    if (entry.blockLogged !== true) {
      entry.blockLogged = true;
      appendLog({ kind: 'compact', session: sessionId, status: 'postponed', reason: 'running-work', running: kinds });
    }
    return true;
  }

  /**
   * Idle long enough: compact once through the official backend, then stop keeping
   * this session alive. The entry is marked stopped BEFORE the call, so a failure or
   * a no-op can never retrigger; the next real request re-captures and re-arms it.
   * Returns false (nothing started, keep-alive carries on) while the agent is not
   * idle or a model stream is in flight. Runs outside the global replay lock, so a
   * slow compaction never delays other sessions' keep-alive.
   */
  async function startCompaction(sessionId, entry) {
    const agent = optionalService('agents')?.get?.(sessionId);
    if (agent === undefined) {
      entry.stopped = true;
      appendLog({ kind: 'compact', session: sessionId, status: 'skipped', reason: 'no-agent' });
      return true;
    }
    if (agent.status !== 'idle' || inflight.has(sessionId) || compacting.has(sessionId)) return false;
    const realAt = entry.lastRealAt;
    if (cfg.compactSkipWhenBusy && (await hasRunningWork(sessionId, entry))) return false;
    // The check above yielded: a real request or a new turn may have arrived meanwhile.
    if (entry.lastRealAt !== realAt || agent.status !== 'idle' || inflight.has(sessionId) || compacting.has(sessionId) || entry.stopped) return false;
    entry.compactBlocked = undefined;
    compacting.add(sessionId);
    entry.stopped = true;
    const idleMinutes = +((Date.now() - entry.lastRealAt) / 60000).toFixed(1);
    const signal = AbortSignal.timeout(10 * 60_000);
    void (async () => {
      try {
        const result = await Promise.race([runCompaction(agent, signal), abortRace(signal, 'compaction timed out')]);
        entry.lastCompaction = { at: Date.now(), kind: 'auto', status: result.kind };
        appendLog({ kind: 'compact', session: sessionId, title: entry.title ?? null, status: result.kind, via: result.via, text: result.text, idleMinutes, touches: entry.touches });
      } catch (error) {
        entry.lastCompaction = { at: Date.now(), kind: 'auto', status: 'error' };
        appendLog({ kind: 'compact', session: sessionId, title: entry.title ?? null, status: 'error', error: String(error?.message ?? error), idleMinutes, touches: entry.touches });
      } finally {
        compacting.delete(sessionId);
      }
    })();
    return true;
  }

  /** Why a due replay did not run: logged once per idle gap, and only when it is already 30 s overdue. */
  function noteDeferred(sessionId, entry, reason, now) {
    if (entry.deferLogged === true || now < entry.nextDueAt + 30_000) return;
    entry.deferLogged = true;
    appendLog({ kind: 'defer', session: sessionId, reason, overdueSeconds: Math.round((now - entry.nextDueAt) / 1000) });
  }

  async function replay(sessionId, entry) {
    if (!sessionEnabledOf(sessionId)) {
      entry.stopped = true;
      sessions.delete(sessionId);
      return;
    }
    if (busy) {
      noteDeferred(sessionId, entry, 'another-replay-running', Date.now());
      return;
    }
    if (entry.stopped) return;
    const compactOn = compactEnabledOf(sessionId);
    // The cache is refreshed from the START of the last request. If we are already well past the replay
    // interval (machine slept, clock jumped, queue backed up) it has probably expired, and a replay or a
    // compaction (which reads the whole context) would only pay for a cold rewrite. Stop instead.
    const nowMs = Date.now();
    if (entry.snapshot !== undefined && !inflight.has(sessionId, routeKeyOf(entry.snapshot.provider, entry.snapshot.model))) {
      const sinceTouch = nowMs - (entry.lastTouchAt ?? entry.lastRealAt);
      if (sinceTouch > intervalFor(entry.snapshot.provider, entry.snapshot.model) * 1.25) {
        entry.stopped = true;
        appendLog({ kind: 'stop', session: sessionId, reason: 'stale', sinceTouchMinutes: +(sinceTouch / 60000).toFixed(1) });
        return;
      }
    }
    if (compactOn && Date.now() - entry.lastRealAt >= cfg.compactAfterMinutes * 60_000 && (await startCompaction(sessionId, entry))) return;
    const now = Date.now();
    // With compaction on, the idle cap must leave room for the compaction to happen first.
    const idleCapMinutes = compactOn ? Math.max(cfg.maxIdleMinutes, cfg.compactAfterMinutes + 1) : cfg.maxIdleMinutes;
    if (now - entry.lastRealAt > idleCapMinutes * 60_000) {
      entry.stopped = true;
      appendLog({ kind: 'stop', session: sessionId, reason: 'max-idle', idleMinutes: +((now - entry.lastRealAt) / 60000).toFixed(1) });
      return;
    }
    if (now + cfg.scanSeconds * 1000 < entry.nextDueAt) return;
    if (entry.snapshot === undefined) return;
    if (inflight.has(sessionId, routeKeyOf(entry.snapshot.provider, entry.snapshot.model))) {
      noteDeferred(sessionId, entry, 'stream-in-flight', now);
      return;
    }
    if (cfg.requireProvenCache !== false && !routeState(entry.snapshot.provider, entry.snapshot.model).proven) {
      // No real request on this route has shown a cache hit yet: don't spend on it.
      return;
    }

    busy = true;
    entry.touches += 1;
    const touch = entry.touches;
    const gen = entry.gen ?? 0;
    const snapshot = entry.snapshot;
    entry.lastTouchAt = now;
    entry.nextDueAt = now + intervalFor(snapshot.provider, snapshot.model);
    const title = sessionTitle(sessionId) ?? entry.title ?? storedTitles.get(sessionId) ?? null;
    if (title !== null) entry.title = title;
    const startedAt = Date.now();
    let usage = null;
    let finishReason = null;
    const abort = new AbortController();
    const watchdog = setTimeout(() => abort.abort(), REPLAY_TIMEOUT_MS);
    try {
      const options = buildReplayOptions(snapshot, abort.signal);
      const consume = async () => {
        for await (const chunk of ctx.llm.stream(options)) {
          if (chunk === null || typeof chunk !== 'object') continue;
          if (chunk.type === 'usage') usage = chunk.usage ?? usage;
          else if (chunk.type === 'finish') finishReason = chunk.reason ?? finishReason;
        }
      };
      await Promise.race([consume(), abortRace(abort.signal, 'replay timed out')]);
    } catch (error) {
      busy = false;
      if ((entry.gen ?? 0) === gen) entry.stopped = true;
      const errorRecord = { ts: new Date().toISOString(), kind: 'keepalive', session: sessionId, title, provider: snapshot.provider, model: snapshot.model, touch, status: 'error', error: String(error?.message ?? error) };
      appendLog(errorRecord);
      remember(errorRecord);
      addToStats(errorRecord);
      return;
    } finally {
      clearTimeout(watchdog);
    }
    busy = false;

    const cacheRead = usage?.cacheReadTokens ?? usage?.cacheRead ?? null;
    const input = usage?.inputTokens ?? usage?.input ?? null;
    const output = usage?.outputTokens ?? usage?.output ?? null;
    const cacheWrite = usage?.cacheWriteTokens ?? usage?.cacheWrite ?? 0;
    const failed = finishReason !== null && typeof finishReason === 'object' && finishReason.kind === 'error';
    // A genuine hit reads (nearly) the whole prompt from cache. A small read next to a large
    // uncached/rewritten remainder means the replay diverged from the real request: that is a
    // miss, and repeating it would rewrite the prefix every interval.
    const promptTokens = (cacheRead ?? 0) + (input ?? 0) + cacheWrite;
    // The adapter omits a zero cacheRead entirely, so "no cache field but a prompt was billed" is a miss, not "unknown".
    const status = failed ? 'error'
      : cacheRead === null ? ((input ?? 0) + cacheWrite > 0 ? 'miss' : 'unknown')
        : cacheRead > 0 && promptTokens > 0 && cacheRead / promptTokens >= HIT_RATIO ? 'hit' : 'miss';
    const record = {
      ts: new Date().toISOString(),
      kind: 'keepalive',
      session: sessionId,
      title,
      provider: snapshot.provider,
      model: snapshot.model,
      touch,
      status,
      cacheRead,
      input,
      output,
      ...(cacheWrite > 0 ? { cacheWrite } : {}),
      finish: finishReason,
      ms: Date.now() - startedAt
    };
    appendLog(record);
    remember(record);
    if (title !== null) storedTitles.set(sessionId, title);
    addToStats(record);
    // A real request arrived while this replay was in flight: it re-armed the entry, so this
    // (now stale) result is recorded but must not stop the new idle gap.
    if ((entry.gen ?? 0) !== gen) return;
    if (failed) {
      entry.stopped = true;
      appendLog({ kind: 'stop', session: sessionId, reason: 'replay-error' });
    } else if (status === 'miss' || status === 'unknown') {
      entry.stopped = true;
      appendLog({ kind: 'stop', session: sessionId, reason: status === 'miss' ? 'cache-miss' : 'cache-unknown' });
    }
  }

  let ticking = false;
  /** Sequential: every due session is handled in the same pass (back to back), so a later session is not pushed a whole scan interval past its TTL. */
  async function tick() {
    if (ticking || sessions.size === 0) return;
    ticking = true;
    try {
      const entries = [...sessions.entries()].sort((a, b) => b[1].lastRealAt - a[1].lastRealAt).slice(0, cfg.maxSessions);
      for (const [sessionId, entry] of entries) {
        if (!sessionEnabledOf(sessionId)) {
          sessions.delete(sessionId);
          continue;
        }
        try {
          await replay(sessionId, entry);
        } catch (error) {
          ctx.logger?.warn?.('cache-keepalive: replay failed: ' + String(error?.message ?? error));
        }
      }
    } finally {
      ticking = false;
    }
  }

  ctx.on('llm/stream', (options, next) => {
    const raw = next();
    try {
      capture(options);
    } catch (error) {
      ctx.logger?.warn?.('cache-keepalive: capture failed: ' + String(error?.message ?? error));
    }
    const sessionId = options?.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return raw;
    if (replaying.has(options)) return raw;
    // Requests that carry a purpose (compaction, titles...) are not real turns: don't track them as in-flight or learn cache proof from them.
    if (options.purpose !== undefined) return raw;
    return observe(raw, sessionId, routeKeyOf(options.provider, options.model));
  });

  /**
   * The user's own /compact (a `compaction/end` with no turn and no error) rewrites the session surface: the
   * stored request snapshot no longer describes what the next real request will send, so replaying it would
   * only keep an obsolete prefix warm. With `compactResetOnManual` the window's auto-compaction countdown is
   * cleared along with it; the next real request re-arms keep-alive and starts the countdown again.
   */
  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type !== 'compaction/end' || event.data?.error !== undefined || event.data?.turn !== null) return;
      const sessionId = session?.id;
      if (typeof sessionId !== 'string' || compacting.has(sessionId)) return;
      const entry = sessions.get(sessionId);
      if (entry === undefined) return;
      entry.lastCompaction = { at: Date.now(), kind: 'manual', status: 'success' };
      if (!cfg.compactResetOnManual) return;
      entry.stopped = true;
      entry.snapshot = undefined;
      appendLog({ kind: 'compact', session: sessionId, title: entry.title ?? null, status: 'manual', via: 'user', text: 'manual compaction: countdown cleared, waiting for the next real request' });
    } catch (error) {
      ctx.logger?.warn?.('cache-keepalive: compaction event handler failed: ' + String(error?.message ?? error));
    }
  });

  /** What the compaction half of the composer oval shows: a countdown while armed, otherwise why there is none. */
  function compactionInfo(sessionId, entry) {
    const on = compactEnabledOf(sessionId);
    const minutes = cfg.compactAfterMinutes;
    const last = entry?.lastCompaction ?? null;
    let status;
    let dueSeconds = null;
    if (!on) status = 'off';
    else if (entry === undefined) status = 'waiting';
    else if (compacting.has(sessionId)) status = 'running';
    else if (last !== null && entry.stopped && entry.lastRealAt <= last.at) status = last.kind === 'manual' ? 'manual' : 'done';
    else if (entry.stopped) status = 'stopped';
    else if (entry.compactBlocked !== undefined && Date.now() - entry.lastRealAt >= minutes * 60_000) status = 'blocked';
    else {
      status = 'counting';
      dueSeconds = Math.max(0, Math.round((entry.lastRealAt + minutes * 60_000 - Date.now()) / 1000));
    }
    return { compactStatus: status, compactDueSeconds: dueSeconds, compactAfterMinutes: minutes, compactBlockedBy: status === 'blocked' ? entry.compactBlocked.kinds : null, lastCompaction: last };
  }

  /** Interval and keep-alive count that actually apply to this window's route (they differ per route). */
  function routeLimits(sessionId, entry) {
    const snapshot = entry?.snapshot;
    const intervalMs = snapshot === undefined ? cfg.intervalMinutes * 60_000 : intervalFor(snapshot.provider, snapshot.model);
    const idleCap = compactEnabledOf(sessionId) ? Math.max(cfg.maxIdleMinutes, cfg.compactAfterMinutes + 1) : cfg.maxIdleMinutes;
    return { intervalMinutes: +(intervalMs / 60000).toFixed(1), maxTouches: Math.floor((idleCap * 60_000) / intervalMs) };
  }

  function stateSnapshot() {
    const tasks = buildTasks();
    const saved = tasks.reduce((sum, task) => sum + task.saved, 0);
    return {
      now: Date.now(),
      startedAt,
      /** Default for sessions that never chose explicitly. */
      enabled: cfg.enabled,
      config: {
        enabled: cfg.enabled,
        sessionEnabled: cfg.sessionEnabled,
        intervalMinutes: cfg.intervalMinutes,
        maxIdleMinutes: cfg.maxIdleMinutes,
        /** Derived, read-only: how many keep-alives fit in the idle cap at the configured interval. */
        maxTouches: Math.floor(cfg.maxIdleMinutes / cfg.intervalMinutes),
        replayMaxTokens: cfg.replayMaxTokens,
        compactAfterMinutes: cfg.compactAfterMinutes,
        compactEnabled: cfg.compactEnabled,
        compactResetOnManual: cfg.compactResetOnManual,
        compactSkipWhenBusy: cfg.compactSkipWhenBusy,
        sessionCompact: cfg.sessionCompact,
        scanSeconds: cfg.scanSeconds,
        maxSessions: cfg.maxSessions,
        routes: cfg.routes,
        routeIntervals: cfg.routeIntervals,
        requireProvenCache: cfg.requireProvenCache
      },
      routes: [...routeStats.values()].map((route) => ({
        provider: route.provider,
        model: route.model,
        proven: route.proven,
        lastCacheRead: route.lastCacheRead,
        samples: route.samples,
        intervalMinutes: +(intervalFor(route.provider, route.model) / 60000).toFixed(1)
      })),
      sessions: [...sessions.entries()].map(([sessionId, entry]) => ({
        id: sessionId,
        session: String(sessionId).slice(0, 18),
        title: entry.title ?? sessionTitle(sessionId) ?? null,
        enabled: sessionEnabledOf(sessionId),
        provider: entry.snapshot?.provider,
        model: entry.snapshot?.model,
        armed: entry.snapshot === undefined ? false : cfg.requireProvenCache === false || routeState(entry.snapshot.provider, entry.snapshot.model).proven,
        idleMinutes: +((Date.now() - entry.lastRealAt) / 60000).toFixed(1),
        touches: entry.touches,
        stopped: entry.stopped,
        nextDueSeconds: Math.max(0, Math.round((entry.nextDueAt - Date.now()) / 1000))
      })),
      stats: {
        touches: stats.touches,
        hits: stats.hits,
        misses: stats.misses,
        unknown: stats.unknown,
        errors: stats.errors,
        cacheRead: stats.cacheRead,
        input: stats.input,
        output: stats.output,
        hitRate: stats.touches > 0 ? +(stats.hits / stats.touches).toFixed(3) : null,
        costEstimate: +stats.cost.toFixed(4),
        savedEstimate: +saved.toFixed(4)
      },
      /** Per-window "since this window was switched on" numbers (composer tooltip). */
      windows: buildWindows(),
      tasks
    };
  }

  function registerStatusRoutes() {
    const send = (res, code, payload) => {
      const body = JSON.stringify(payload);
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    };
    /**
     * Browsers let any web page POST a "simple" request (text/plain) to 127.0.0.1 without a
     * preflight. Require what a cross-site form/no-cors fetch cannot send: a JSON content type
     * plus our own header (both force a preflight we never answer), and a same-origin Origin.
     */
    const header = (req, name) => String(req.headers?.[name] ?? '');
    /** Host names a DNS-rebinding page cannot own: localhost, IP literals, or this server's own advertised origin. */
    const hostAllowed = (req, webServer) => {
      const raw = header(req, 'host');
      if (raw === '') return false;
      const name = (raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.replace(/:\d+$/, '')).toLowerCase();
      if (name === 'localhost' || name.endsWith('.localhost')) return true;
      if (name.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return true;
      try {
        return new URL(webServer.getOrigin()).host.toLowerCase() === raw.toLowerCase();
      } catch {
        return false;
      }
    };
    /** Every route: right Host, and never a cross-site fetch (a browser labels those itself). */
    const guardRequest = (req, res, webServer) => {
      if (!hostAllowed(req, webServer)) {
        send(res, 403, { error: 'host not allowed' });
        return false;
      }
      const site = header(req, 'sec-fetch-site');
      if (site !== '' && site !== 'same-origin' && site !== 'none') {
        send(res, 403, { error: 'cross-site request rejected' });
        return false;
      }
      return true;
    };
    const guardPost = (req, res) => {
      const header = (name) => String(req.headers?.[name] ?? '');
      const origin = header('origin');
      if (origin !== '') {
        let originHost = '';
        try {
          originHost = new URL(origin).host;
        } catch {
          originHost = '';
        }
        if (originHost !== header('host')) {
          send(res, 403, { error: 'cross-origin request rejected' });
          return false;
        }
      }
      if (!/^application\/json\b/i.test(header('content-type')) || header('x-keepalive') !== '1') {
        send(res, 415, { error: 'application/json with X-Keepalive: 1 required' });
        return false;
      }
      return true;
    };
    const readBody = async (req, limit) => {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > limit) throw new Error('body too large');
      }
      return body;
    };
    const installRoutes = (webCtx) => {
      const rawWebServer = webCtx.webServer;
      const webServer = {
        register: (route) => rawWebServer.register({
          ...route,
          handler: (req, res) => (guardRequest(req, res, rawWebServer) ? route.handler(req, res) : undefined)
        })
      };
      webCtx.effect(function* statusRoutes() {
        const offState = webServer.register({
        kind: 'exact',
        path: '/plugins/cache-keepalive/state',
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            send(res, 405, { error: 'method not allowed' });
            return;
          }
          send(res, 200, stateSnapshot());
        }
      });
      const offConfig = webServer.register({
        kind: 'exact',
        path: '/plugins/cache-keepalive/config',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            send(res, 405, { error: 'method not allowed' });
            return;
          }
          if (!guardPost(req, res)) return;
          try {
            const body = await readBody(req, 16384);
            const raw = body.length === 0 ? {} : JSON.parse(body);
            if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config patch must be an object');
            const patch = {};
            for (const key of CONFIG_PATCH_KEYS) if (Object.prototype.hasOwnProperty.call(raw, key)) patch[key] = raw[key];
            cfg = saveConfig({ ...cfg, ...patch });
            appendLog({ kind: 'config', intervalMinutes: cfg.intervalMinutes, maxIdleMinutes: cfg.maxIdleMinutes, replayMaxTokens: cfg.replayMaxTokens, enabled: cfg.enabled, routes: cfg.routes });
            send(res, 200, { ok: true, config: cfg });
          } catch (error) {
            send(res, 400, { error: String(error?.message ?? error) });
          }
        }
      });
      const offSession = webServer.register({
        kind: 'exact',
        path: '/plugins/cache-keepalive/session',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            send(res, 405, { error: 'method not allowed' });
            return;
          }
          if (!guardPost(req, res)) return;
          try {
            const body = await readBody(req, 4096);
            const payload = body.length === 0 ? {} : JSON.parse(body);
            const sessionId = typeof payload.session === 'string' ? payload.session : '';
            if (sessionId.length === 0) {
              send(res, 400, { error: 'session required' });
              return;
            }
            const hasEnabled = payload.enabled !== undefined;
            const hasCompact = payload.compact !== undefined;
            if (!hasEnabled && !hasCompact) {
              send(res, 400, { error: 'enabled or compact required' });
              return;
            }
            if ((hasEnabled && typeof payload.enabled !== 'boolean') || (hasCompact && typeof payload.compact !== 'boolean')) {
              send(res, 400, { error: 'enabled and compact must be booleans' });
              return;
            }
            if (hasEnabled) setSessionEnabledOf(sessionId, payload.enabled);
            if (hasCompact) setSessionCompactOf(sessionId, payload.compact);
            send(res, 200, { ok: true, session: sessionId, enabled: sessionEnabledOf(sessionId), compact: compactEnabledOf(sessionId) });
          } catch (error) {
            send(res, 400, { error: String(error?.message ?? error) });
          }
        }
      });
      const offDiagLog = webServer.register({
        kind: 'exact',
        path: '/plugins/cache-keepalive/clientlog',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            send(res, 405, { error: 'method not allowed' });
            return;
          }
          if (!guardPost(req, res)) return;
          try {
            const body = await readBody(req, 4096);
            const entry = JSON.parse(body || '{}');
            clientDiagnostics.push({ ts: new Date().toISOString(), stage: String(entry.stage ?? 'unknown'), detail: String(entry.detail ?? '') });
            if (clientDiagnostics.length > 20) clientDiagnostics.shift();
            send(res, 200, { ok: true });
          } catch (error) {
            send(res, 400, { error: String(error?.message ?? error) });
          }
        }
      });
      const offTask = webServer.register({
        kind: 'exact',
        path: '/plugins/cache-keepalive/task',
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            send(res, 405, { error: 'method not allowed' });
            return;
          }
          let sessionId = '';
          try {
            sessionId = new URL(req.url, 'http://127.0.0.1').searchParams.get('session') ?? '';
          } catch {
            sessionId = '';
          }
          if (sessionId.length === 0) {
            send(res, 400, { error: 'session required' });
            return;
          }
          const task = buildTasks().find((item) => item.id === sessionId);
          if (task === undefined) {
            send(res, 404, { error: 'record not found' });
            return;
          }
          send(res, 200, { task, records: taskRecords(sessionId) });
        }
      });
      const offTaskDelete = webServer.register({
        kind: 'exact',
        path: '/plugins/cache-keepalive/task/delete',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            send(res, 405, { error: 'method not allowed' });
            return;
          }
          if (!guardPost(req, res)) return;
          try {
            const body = await readBody(req, 4096);
            const payload = body.length === 0 ? {} : JSON.parse(body);
            const sessionId = typeof payload.session === 'string' ? payload.session : '';
            if (sessionId.length === 0) {
              send(res, 400, { error: 'session required' });
              return;
            }
            const removed = deleteTask(sessionId);
            appendLog({ kind: 'record-deleted', session: sessionId, ok: removed });
            send(res, 200, { ok: removed });
          } catch (error) {
            send(res, 400, { error: String(error?.message ?? error) });
          }
        }
      });
      const offDebug = webServer.register({
        kind: 'exact',
        path: '/plugins/cache-keepalive/debug',
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            send(res, 405, { error: 'method not allowed' });
            return;
          }
          let clientModules;
          try {
            clientModules = ctx.get('clientModules');
          } catch {
            clientModules = undefined;
          }
          let graph = null;
          try {
            const composed = clientModules?.graph?.();
            graph = composed === undefined ? null : { rev: composed.rev ?? null, entries: Array.isArray(composed.entries) ? composed.entries.map((entry) => ({ id: entry.id, rev: entry.rev ?? null })) : null };
          } catch {
            graph = null;
          }
          let clientPath = null;
          try {
            clientPath = clientModules?.clientPath?.('dsh-cache-keepalive') ?? null;
          } catch {
            clientPath = null;
          }
          let loaderEntries = null;
          try {
            loaderEntries = [...ctx.loader.entries()].map((entry) => entry.options?.name).filter((name) => typeof name === 'string' && name.includes('cache-keepalive'));
          } catch {
            loaderEntries = null;
          }
          send(res, 200, {
            hasClientModules: clientModules !== undefined,
            graphRev: graph?.rev ?? null,
            graphIds: graph?.entries?.map((entry) => entry.id) ?? null,
            clientPath,
            loaderEntries,
            clientDiagnostics
          });
        }
      });
      yield () => {
        offState();
        offConfig();
        offSession();
        offDiagLog();
        offTask();
        offTaskDelete();
        offDebug();
      };
      });
    };
    try {
      ctx.inject(['webServer'], installRoutes);
    } catch (error) {
      ctx.logger?.warn?.('cache-keepalive: cannot register status routes: ' + String((error && error.message) || error));
    }
  }
  registerStatusRoutes();

  ctx.effect(function* keepaliveLifecycle() {
    try {
      if (Object.prototype.hasOwnProperty.call(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')), 'maxTouches')) {
        appendLog({ kind: 'config-notice', notice: 'maxTouches is no longer a setting: the keep-alive count is now derived from maxIdleMinutes / interval' });
      }
    } catch {
      /* no config yet, or unreadable: nothing to report */
    }
    appendLog({ kind: 'start', intervalMinutes: cfg.intervalMinutes, maxIdleMinutes: cfg.maxIdleMinutes, replayMaxTokens: cfg.replayMaxTokens, routes: cfg.routes });
    let timerSeconds = cfg.scanSeconds;
    const startTimer = () => {
      const t = setInterval(() => {
        tick().catch((error) => {
          ctx.logger?.warn?.('cache-keepalive: tick failed: ' + String(error?.message ?? error));
        });
      }, timerSeconds * 1000);
      t.unref?.();
      return t;
    };
    let timer = startTimer();

    let lastMtime = 0;
    try {
      lastMtime = fs.statSync(CONFIG_PATH).mtimeMs;
    } catch {
      lastMtime = 0;
    }
    const onConfigChange = () => {
      try {
        const next = loadConfig();
        if (next === null) {
          appendLog({ kind: 'config-error', error: 'config.json is not valid JSON; keeping the previous settings' });
          return;
        }
        const changed = JSON.stringify(next) !== JSON.stringify(cfg);
        cfg = next;
        // scanSeconds is only read when the timer is created, so a change has to rebuild it.
        if (cfg.scanSeconds !== timerSeconds) {
          clearInterval(timer);
          timerSeconds = cfg.scanSeconds;
          timer = startTimer();
        }
        if (changed) {
          appendLog({ kind: 'config', intervalMinutes: cfg.intervalMinutes, maxIdleMinutes: cfg.maxIdleMinutes, replayMaxTokens: cfg.replayMaxTokens, enabled: cfg.enabled, routes: cfg.routes });
        }
      } catch {
        /* keep previous config */
      }
    };
    fs.watchFile(CONFIG_PATH, { interval: 2000 }, onConfigChange);

    yield () => {
      clearInterval(timer);
      try {
        fs.unwatchFile(CONFIG_PATH, onConfigChange);
      } catch {
        /* already gone */
      }
    };
  });
}
