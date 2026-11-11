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
 *   - Hard caps: maxTouches per idle gap, maxIdleMinutes, one replay in flight.
 *   - Config is re-read from config.json when the file changes (2s poll).
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = fileURLToPath(new URL('.', import.meta.url));
const CONFIG_PATH = PLUGIN_DIR + 'config.json';
const LOG_PATH = PLUGIN_DIR + 'keepalive.jsonl';

const DEFAULTS = {
  enabled: false,
  intervalMinutes: 20,
  maxIdleMinutes: 150,
  maxTouches: 8,
  replayMaxTokens: 16,
  scanSeconds: 30,
  maxSessions: 1,
  /** Empty list = follow whatever model the conversation is using. */
  routes: [],
  /** Optional per-route interval override, keyed "provider/model". */
  routeIntervals: { 'kimi-coding/kimi-k3.1-pro': 20, 'huosan/kimi-k3.1-pro': 5 },
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
      if (typeof key === 'string' && Number.isFinite(minutes) && minutes > 0) intervals[key] = minutes;
    }
  }
  cfg.routeIntervals = intervals;
  cfg.requireProvenCache = cfg.requireProvenCache !== false;
  if (!Number.isFinite(cfg.intervalMinutes) || cfg.intervalMinutes <= 0) cfg.intervalMinutes = DEFAULTS.intervalMinutes;
  if (!Number.isFinite(cfg.maxIdleMinutes) || cfg.maxIdleMinutes <= 0) cfg.maxIdleMinutes = DEFAULTS.maxIdleMinutes;
  if (!Number.isFinite(cfg.maxTouches) || cfg.maxTouches < 1) cfg.maxTouches = DEFAULTS.maxTouches;
  if (!Number.isFinite(cfg.replayMaxTokens) || cfg.replayMaxTokens < 1) cfg.replayMaxTokens = DEFAULTS.replayMaxTokens;
  if (!Number.isFinite(cfg.scanSeconds) || cfg.scanSeconds < 5) cfg.scanSeconds = DEFAULTS.scanSeconds;
  if (!Number.isFinite(cfg.maxSessions) || cfg.maxSessions < 1) cfg.maxSessions = DEFAULTS.maxSessions;
  cfg.enabled = cfg.enabled === true;
  return cfg;
}

function loadConfig() {
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  } catch {
    return normalizeConfig(DEFAULTS);
  }
}

function saveConfig(cfg) {
  const normalized = normalizeConfig(cfg);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(normalized, null, 2) + '\n');
  return normalized;
}

function appendLog(record) {
  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n');
  } catch {
    /* logging must never break the plugin */
  }
}

export const name = 'cache-keepalive';
export const inject = ['llm', 'sessions'];

export function apply(ctx) {
  let cfg = loadConfig();
  /** sessionId -> { snapshot, lastRealAt, touches, nextDueAt, stopped } */
  const sessions = new Map();
  /** replay option objects created by this plugin: never captured, never observed. */
  const replaying = new WeakSet();
  /** sessionIds with a real model stream in flight. */
  const inflight = new Set();
  let busy = false;

  // ---- status surface (settings page card) ----
  const startedAt = Date.now();
  /** In-memory ring of the latest keepalive outcomes for the settings card. */
  const recent = [];
  const stats = { touches: 0, hits: 0, misses: 0, unknown: 0, errors: 0, cacheRead: 0, input: 0, output: 0 };
  /** Browser-side diagnostics reported by client.js (bundle load, slot registration errors). */
  const clientDiagnostics = [];
  /** CNY per 1M tokens, kimi-coding list price; only used for the estimate label. */
  const PRICE = { hit: 1.3, input: 13, output: 68 };
  function remember(record) {
    recent.push(record);
    if (recent.length > 40) recent.shift();
  }
  function loadHistory() {
    try {
      const lines = fs.readFileSync(LOG_PATH, 'utf8').trim().split(/\r?\n/);
      for (const line of lines.slice(-40)) {
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (record === null || record.kind !== 'keepalive') continue;
        remember(record);
        stats.touches += 1;
        if (record.status === 'hit') stats.hits += 1;
        else if (record.status === 'miss') stats.misses += 1;
        else if (record.status === 'unknown') stats.unknown += 1;
        else stats.errors += 1;
        stats.cacheRead += record.cacheRead ?? 0;
        stats.input += record.input ?? 0;
        stats.output += record.output ?? 0;
      }
    } catch {
      /* no history yet */
    }
  }
  loadHistory();
  function priceOf(record) {
    return ((record.cacheRead ?? 0) * PRICE.hit + (record.input ?? 0) * PRICE.input + (record.output ?? 0) * PRICE.output) / 1e6;
  }

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

  function routeAllowed(provider, model) {
    const routes = Array.isArray(cfg.routes) ? cfg.routes : [];
    if (routes.length === 0) return true;
    return routes.some((route) => route.provider === provider && route.model === model);
  }

  function prune() {
    if (sessions.size <= cfg.maxSessions) return;
    const newestFirst = [...sessions.entries()].sort((a, b) => b[1].lastRealAt - a[1].lastRealAt);
    for (const [sessionId] of newestFirst.slice(cfg.maxSessions)) sessions.delete(sessionId);
  }

  function capture(options) {
    if (!cfg.enabled) return;
    if (options === null || typeof options !== 'object') return;
    if (replaying.has(options)) return;
    if (options.purpose !== undefined) return;
    const sessionId = options.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    if (!routeAllowed(options.provider, options.model)) return;
    if (isNotUserVisibleMainSession(sessionId)) return;

    const now = Date.now();
    const existing = sessions.get(sessionId);
    if (existing === undefined) {
      sessions.set(sessionId, {
        snapshot: options,
        lastRealAt: now,
        touches: 0,
        nextDueAt: now + intervalFor(options.provider, options.model),
        stopped: false
      });
      appendLog({ kind: 'capture', session: sessionId, provider: options.provider, model: options.model, messages: Array.isArray(options.messages) ? options.messages.length : null, toolHistory: Array.isArray(options.toolHistory) ? options.toolHistory.length : null, tools: Array.isArray(options.tools) ? options.tools.length : null });
    } else {
      existing.snapshot = options;
      existing.lastRealAt = now;
      existing.touches = 0;
      existing.nextDueAt = now + intervalFor(options.provider, options.model);
      existing.stopped = false;
    }
    prune();
  }

  function observe(iterable, sessionId) {
    inflight.add(sessionId);
    return (async function* observeStream() {
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
        inflight.delete(sessionId);
      }
    })();
  }

  function buildReplayOptions(snapshot) {
    const { signal: _ignored, ...rest } = snapshot;
    const options = { ...rest, maxTokens: cfg.replayMaxTokens };
    replaying.add(options);
    return options;
  }

  async function replay(sessionId, entry) {
    if (busy) return;
    if (entry.stopped) return;
    if (entry.touches >= cfg.maxTouches) {
      entry.stopped = true;
      appendLog({ kind: 'stop', session: sessionId, reason: 'max-touches', touches: entry.touches });
      return;
    }
    const now = Date.now();
    if (now - entry.lastRealAt > cfg.maxIdleMinutes * 60_000) {
      entry.stopped = true;
      appendLog({ kind: 'stop', session: sessionId, reason: 'max-idle', idleMinutes: +((now - entry.lastRealAt) / 60000).toFixed(1) });
      return;
    }
    if (now < entry.nextDueAt) return;
    if (inflight.has(sessionId)) return;
    if (entry.snapshot === undefined) return;
    if (cfg.requireProvenCache !== false && !routeState(entry.snapshot.provider, entry.snapshot.model).proven) {
      // No real request on this route has shown a cache hit yet: don't spend on it.
      return;
    }

    busy = true;
    entry.touches += 1;
    entry.nextDueAt = now + intervalFor(entry.snapshot.provider, entry.snapshot.model);
    const startedAt = Date.now();
    let usage = null;
    let finishReason = null;
    try {
      const options = buildReplayOptions(entry.snapshot);
      for await (const chunk of ctx.llm.stream(options)) {
        if (chunk === null || typeof chunk !== 'object') continue;
        if (chunk.type === 'usage') usage = chunk.usage ?? usage;
        else if (chunk.type === 'finish') finishReason = chunk.reason ?? finishReason;
      }
    } catch (error) {
      busy = false;
      entry.stopped = true;
      appendLog({ kind: 'keepalive', session: sessionId, provider: entry.snapshot.provider, model: entry.snapshot.model, touch: entry.touches, status: 'error', error: String(error?.message ?? error) });
      return;
    }
    busy = false;

    const cacheRead = usage?.cacheReadTokens ?? usage?.cacheRead ?? null;
    const input = usage?.inputTokens ?? usage?.input ?? null;
    const output = usage?.outputTokens ?? usage?.output ?? null;
    const failed = finishReason !== null && typeof finishReason === 'object' && finishReason.kind === 'error';
    const status = failed ? 'error' : cacheRead === null ? 'unknown' : cacheRead > 0 ? 'hit' : 'miss';
    const record = {
      ts: new Date().toISOString(),
      kind: 'keepalive',
      session: sessionId,
      provider: entry.snapshot.provider,
      model: entry.snapshot.model,
      touch: entry.touches,
      status,
      cacheRead,
      input,
      output,
      finish: finishReason,
      ms: Date.now() - startedAt
    };
    appendLog(record);
    remember(record);
    stats.touches += 1;
    if (status === 'hit') stats.hits += 1;
    else if (status === 'miss') stats.misses += 1;
    else if (status === 'unknown') stats.unknown += 1;
    else stats.errors += 1;
    stats.cacheRead += cacheRead ?? 0;
    stats.input += input ?? 0;
    stats.output += output ?? 0;
    if (failed) {
      entry.stopped = true;
      appendLog({ kind: 'stop', session: sessionId, reason: 'replay-error' });
    } else if (cacheRead === 0) {
      entry.stopped = true;
      appendLog({ kind: 'stop', session: sessionId, reason: 'cache-miss' });
    }
  }

  function tick() {
    if (!cfg.enabled) return;
    const entries = [...sessions.entries()].sort((a, b) => b[1].lastRealAt - a[1].lastRealAt).slice(0, cfg.maxSessions);
    for (const [sessionId, entry] of entries) {
      void replay(sessionId, entry).catch((error) => {
        ctx.logger?.warn?.('cache-keepalive: replay failed: ' + String(error?.message ?? error));
      });
      if (busy) return;
    }
  }

  ctx.on('llm/stream', (options, next) => {
    const raw = next();
    if (cfg.enabled) {
      try {
        capture(options);
      } catch (error) {
        ctx.logger?.warn?.('cache-keepalive: capture failed: ' + String(error?.message ?? error));
      }
    }
    const sessionId = options?.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return raw;
    if (replaying.has(options)) return raw;
    return observe(raw, sessionId);
  });

  function stateSnapshot() {
    const avoidedOf = (record) => (record.status === 'hit' ? ((record.cacheRead ?? 0) * (PRICE.input - PRICE.hit)) / 1e6 : 0);
    const recentPublic = recent
      .slice(-20)
      .reverse()
      .map((record) => ({
        ts: record.ts,
        status: record.status,
        cacheRead: record.cacheRead,
        input: record.input,
        output: record.output,
        touch: record.touch,
        ms: record.ms,
        cost: +priceOf(record).toFixed(5),
        avoided: +avoidedOf(record).toFixed(5)
      }));
    const cost = recent.reduce((sum, record) => sum + priceOf(record), 0);
    const avoided = recent.reduce((sum, record) => sum + avoidedOf(record), 0);
    return {
      now: Date.now(),
      startedAt,
      enabled: cfg.enabled,
      config: {
        intervalMinutes: cfg.intervalMinutes,
        maxIdleMinutes: cfg.maxIdleMinutes,
        maxTouches: cfg.maxTouches,
        replayMaxTokens: cfg.replayMaxTokens,
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
        session: String(sessionId).slice(0, 18),
        provider: entry.snapshot?.provider,
        model: entry.snapshot?.model,
        armed: entry.snapshot === undefined ? false : cfg.requireProvenCache === false || routeState(entry.snapshot.provider, entry.snapshot.model).proven,
        idleMinutes: +((Date.now() - entry.lastRealAt) / 60000).toFixed(1),
        touches: entry.touches,
        stopped: entry.stopped,
        nextDueSeconds: Math.max(0, Math.round((entry.nextDueAt - Date.now()) / 1000))
      })),
      stats: {
        ...stats,
        hitRate: stats.touches > 0 ? +(stats.hits / stats.touches).toFixed(3) : null,
        costEstimate: +cost.toFixed(4),
        avoidedEstimate: +avoided.toFixed(4)
      },
      recent: recentPublic
    };
  }

  function registerStatusRoutes() {
    const send = (res, code, payload) => {
      const body = JSON.stringify(payload);
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
      res.end(body);
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
      const webServer = webCtx.webServer;
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
          try {
            const body = await readBody(req, 16384);
            const patch = body.length === 0 ? {} : JSON.parse(body);
            cfg = saveConfig({ ...cfg, ...patch });
            appendLog({ kind: 'config', intervalMinutes: cfg.intervalMinutes, maxIdleMinutes: cfg.maxIdleMinutes, maxTouches: cfg.maxTouches, replayMaxTokens: cfg.replayMaxTokens, enabled: cfg.enabled, routes: cfg.routes });
            send(res, 200, { ok: true, config: cfg });
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
        offDiagLog();
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
    appendLog({ kind: 'start', intervalMinutes: cfg.intervalMinutes, maxIdleMinutes: cfg.maxIdleMinutes, maxTouches: cfg.maxTouches, replayMaxTokens: cfg.replayMaxTokens, routes: cfg.routes });
    const timer = setInterval(() => {
      try {
        tick();
      } catch (error) {
        ctx.logger?.warn?.('cache-keepalive: tick failed: ' + String(error?.message ?? error));
      }
    }, cfg.scanSeconds * 1000);
    timer.unref?.();

    let lastMtime = 0;
    try {
      lastMtime = fs.statSync(CONFIG_PATH).mtimeMs;
    } catch {
      lastMtime = 0;
    }
    fs.watchFile(CONFIG_PATH, { interval: 2000 }, () => {
      try {
        const next = loadConfig();
        const changed = JSON.stringify(next) !== JSON.stringify(cfg);
        cfg = next;
        if (changed) {
          appendLog({ kind: 'config', intervalMinutes: cfg.intervalMinutes, maxIdleMinutes: cfg.maxIdleMinutes, maxTouches: cfg.maxTouches, replayMaxTokens: cfg.replayMaxTokens, enabled: cfg.enabled, routes: cfg.routes });
        }
      } catch {
        /* keep previous config */
      }
    });

    yield () => {
      clearInterval(timer);
      try {
        fs.unwatchFile(CONFIG_PATH);
      } catch {
        /* already gone */
      }
    };
  });
}
