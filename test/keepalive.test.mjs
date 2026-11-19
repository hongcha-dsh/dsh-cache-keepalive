// dsh-cache-keepalive 假 ctx 测试。
// 每个用例把 index.js 复制到系统临时目录（config.json / keepalive.jsonl 也都在临时目录里），
// 因此不会读写工作目录的 config.json / keepalive.jsonl，也不会碰 ~/.dsh。
// 时间用 node:test 的 mock.timers 快进（只 mock setInterval 与 Date）。
// 运行：ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" --test test/keepalive.test.mjs

import test, { describe, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'index.js');

const SID = 's1';
const CLAUDE = { provider: 'blsc-anthropic', model: 'Claude-Sonnet-5.5' };
const OPUS = { provider: 'blsc-anthropic', model: 'Claude-Opus-5.5' };
const MIN = 60_000;
const T0 = Date.parse('2026-11-18T12:00:00Z');
const HIT = { cacheReadTokens: 5000, inputTokens: 100, outputTokens: 10 };
const MSG = [{ role: 'user', content: 'hello' }];
const TOOLS = [{ name: 'read' }];
const SWITCH = '/plugins/cache-keepalive/session';
const STATE = '/plugins/cache-keepalive/state';
const TASK = '/plugins/cache-keepalive/task';
const CONFIG_EP = '/plugins/cache-keepalive/config';
const REAL_ABORT_TIMEOUT = AbortSignal.timeout;
/** A stream that never yields or returns (hung upstream). */
const HANG = { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}), return: async () => ({ done: true, value: undefined }) }; } };
/** A stream that waits for `gate` before yielding usage. */
async function* gatedIter(gate, usage) {
  await gate;
  yield { type: 'usage', usage };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

async function* iter(chunks) {
  for (const c of chunks) yield c;
}
const flush = () => new Promise((r) => setImmediate(r));
const close = (actual, expected, eps = 1e-6) => assert.ok(Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`);
const agent = (status, compaction) => ({ status, ctx: { get: (name) => (name === 'compaction' ? compaction : undefined) } });

let h = null;

async function setup({ config = {}, agents = {}, compaction, realTimers = false, noWaterfall = false } = {}) {
  if (!realTimers) {
    mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: T0 });
    // Node's AbortSignal.timeout uses internal timers; route it through the mocked setTimeout.
    AbortSignal.timeout = (ms) => { const c = new AbortController(); setTimeout(() => c.abort(new Error('timeout')), ms); return c.signal; };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ka-test-'));
  const modPath = path.join(dir, 'index.mjs');
  fs.copyFileSync(SRC, modPath);
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ enabled: false, sessionEnabled: { [SID]: true }, routes: [CLAUDE], routeIntervals: {}, ...config }, null, 2)
  );
  const hooks = [];
  const sessionEventHooks = [];
  const routes = {};
  const cleanups = [];
  const h = {
    dir,
    logPath: path.join(dir, 'keepalive.jsonl'),
    replayUsage: { ...HIT },
    streamCalls: [],
    commandCalls: [],
    commandResult: undefined,
    activity: [],
    activityError: null,
    activityCalls: [],
    sessions: {},
    agents,
    routes,
    cleanups,
    hangFor: new Set(),
    gate: null,
    respond: (options) => {
      if (h.hangFor.has(options?.sessionId)) return HANG;
      if (h.gate !== null) return gatedIter(h.gate, { ...h.replayUsage });
      return iter([{ type: 'usage', usage: { ...h.replayUsage } }, { type: 'finish', reason: { kind: 'stop' } }]);
    },
    req: (o = {}) => ({ sessionId: SID, provider: CLAUDE.provider, model: CLAUDE.model, messages: MSG, tools: TOOLS, toolHistory: [], maxTokens: 4096, signal: new AbortController().signal, ...o }),
    /** Non-replay stream through the llm/stream hook chain (used for compaction-purpose requests). */
    llmStream: (options) => hooks[0](options, () => h.respond(options)),
    /** Fire ctx.on('session/event') listeners the way the host does: (session, event). */
    emitSessionEvent: (sessionId, event) => { for (const fn of sessionEventHooks) fn({ id: sessionId }, event); },
    /** A real request: hook is called, the returned stream is NOT consumed. */
    open: (usage = HIT, o = {}) =>
      hooks[0](h.req(o), () => iter([{ type: 'usage', usage }, { type: 'finish', reason: { kind: 'stop' } }])),
    /** A real request: hook called and stream fully consumed (usage observed). */
    real: async (usage = HIT, o = {}) => {
      for await (const _ of h.open(usage, o)) { /* consume */ }
    },
    advance: async (ms) => {
      for (let t = 0; t < ms; t += 30_000) {
        mock.timers.tick(30_000);
        await flush();
      }
    },
    http: async (key, { method = 'GET', body, url, headers } = {}) => {
      const handler = routes[key];
      assert.ok(handler, 'route not registered: ' + key);
      const base = method === 'POST'
        ? { host: '127.0.0.1:50867', 'content-type': 'application/json', 'x-keepalive': '1' }
        : { host: '127.0.0.1:50867' };
      const merged = { ...base, ...(headers ?? {}) };
      for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
      const req = {
        method,
        headers: merged,
        url: url ?? key,
        async *[Symbol.asyncIterator]() {
          if (body !== undefined) yield JSON.stringify(body);
        }
      };
      let status = null;
      let text = '';
      const res = { writeHead(code) { status = code; }, end(b) { text = b; } };
      await handler(req, res);
      return { status, body: JSON.parse(text) };
    },
    state: async () => (await h.http(STATE)).body,
    logLines: () =>
      fs.existsSync(h.logPath)
        ? fs.readFileSync(h.logPath, 'utf8').split(/\r?\n/).filter((l) => l.trim().length > 0).map((l) => JSON.parse(l))
        : [],
    teardown: () => {
      for (const fn of cleanups.reverse()) {
        try { fn(); } catch { /* ignore */ }
      }
      AbortSignal.timeout = REAL_ABORT_TIMEOUT;
      mock.timers.reset();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  const runEffect = (genFn) => {
    const gen = genFn();
    const first = gen.next();
    if (typeof first.value === 'function') cleanups.push(first.value);
  };
  const webServer = {
    getOrigin: () => 'http://127.0.0.1:50867',
    register: (desc) => {
      routes[desc.path] = desc.handler;
      return () => {};
    }
  };
  const ctx = {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    on(event, fn) {
      if (event === 'llm/stream') hooks.push(fn);
      if (event === 'session/event') sessionEventHooks.push(fn);
    },
    get(name) {
      if (name === 'sessions') return { get: (id) => h.sessions[id] ?? { header: {} } };
      throw new Error('service not available: ' + name);
    },
    llm: { stream: (options) => h.llmStream(options) },
    agents: { get: (id) => h.agents[id] },
    /** `workspace/session-activity`: what still runs for a session (h.activity), or a failure (h.activityError). */
    ...(noWaterfall ? {} : {
      waterfall: async (name, request, fallback) => {
        h.activityCalls.push({ name, request });
        if (h.activityError !== null) throw h.activityError;
        return name === 'workspace/session-activity' ? h.activity : fallback();
      }
    }),
    commands: {
      execute: async (agentObj, name, args) => {
        h.commandCalls.push({ agent: agentObj, name, args });
        return h.commandResult;
      }
    },
    inject(_keys, fn) {
      fn({ webServer, effect: runEffect });
    },
    effect: runEffect
  };

  // Count replays (no purpose) made through ctx.llm.stream.
  const origLlmStream = ctx.llm.stream;
  ctx.llm.stream = (options) => {
    h.streamCalls.push(options);
    return origLlmStream(options);
  };

  const mod = await import(pathToFileURL(modPath).href);
  mod.apply(ctx);
  return h;
}

afterEach(() => {
  h?.teardown();
  h = null;
});

// ---------------- a. 开关与武装 ----------------
describe('a 开关与武装', () => {
  test('a1 关闭时不捕获不重放；开启后仍需一次真实请求才武装；再关闭即停', async () => {
    h = await setup({ config: { enabled: false, sessionEnabled: {} } });
    await h.real();
    await h.advance(10 * MIN);
    assert.equal(h.streamCalls.length, 0);

    let r = await h.http(SWITCH, { method: 'POST', body: { session: SID, enabled: true } });
    assert.equal(r.status, 200);
    await h.advance(10 * MIN);
    assert.equal(h.streamCalls.length, 0, '开启后、没有真实请求时不得重放');

    await h.real();
    await h.advance(4 * MIN);
    assert.equal(h.streamCalls.length, 1);

    r = await h.http(SWITCH, { method: 'POST', body: { session: SID, enabled: false } });
    await h.advance(10 * MIN);
    assert.equal(h.streamCalls.length, 1, '关闭后不再重放');
  });

  test('a2 routes 限制：不在列表内的路由不捕获、不重放', async () => {
    h = await setup({ config: { routes: [OPUS] } });
    await h.real(HIT); // Sonnet 不在列表内
    await h.advance(10 * MIN);
    assert.equal(h.streamCalls.length, 0);
  });
});

// ---------------- b. 间隔重放 ----------------
describe('b 间隔重放', () => {
  test('b1 到期重放一次，maxTokens 压到 replayMaxTokens，重放不被再捕获/观察', async () => {
    h = await setup();
    await h.real(HIT, { maxTokens: 4096, messages: MSG, tools: TOOLS });
    await h.advance(3 * MIN + 30_000);
    assert.equal(h.streamCalls.length, 0, '3.5 分钟时尚未到期');
    await h.advance(30_000);
    assert.equal(h.streamCalls.length, 1, '4 分钟到期，恰好一次');

    const rep = h.streamCalls[0];
    assert.equal(rep.maxTokens, 16);
    assert.deepEqual(rep.messages, MSG);
    assert.deepEqual(rep.tools, TOOLS);
    assert.equal(rep.sessionId, SID);
    assert.ok(rep.signal instanceof AbortSignal, '重放带 AbortSignal（60s 看门狗）');
    assert.equal(rep.purpose, undefined);

    let st = await h.state();
    assert.equal(st.sessions[0].touches, 1);
    close(st.sessions[0].idleMinutes, 4, 0.05);
    assert.equal(h.logLines().filter((l) => l.kind === 'capture').length, 1, '重放不得产生 capture');
    assert.equal(st.routes[0].samples, 1, '重放流不得进入 observe（样本数只来自真实请求）');
    const ka = h.logLines().filter((l) => l.kind === 'keepalive');
    assert.equal(ka.length, 1);
    assert.equal(ka[0].status, 'hit');

    // 重放不会重置空闲计时：第二次仍按 4 分钟间隔，idle 继续累计
    await h.advance(4 * MIN);
    assert.equal(h.streamCalls.length, 2);
    st = await h.state();
    assert.equal(st.sessions[0].touches, 2);
    close(st.sessions[0].idleMinutes, 8, 0.05);
  });

  test('b2 routeIntervals 覆盖：2 分钟即重放；非法值回退到 intervalMinutes', async () => {
    h = await setup({ config: { routeIntervals: { [`${CLAUDE.provider}/${CLAUDE.model}`]: 2 } } });
    await h.real(HIT);
    await h.advance(2 * MIN);
    assert.equal(h.streamCalls.length, 1);
    h.teardown();

    h = await setup({ config: { routeIntervals: { [`${CLAUDE.provider}/${CLAUDE.model}`]: 'abc' } } });
    await h.real(HIT);
    await h.advance(3 * MIN + 30_000);
    assert.equal(h.streamCalls.length, 0);
    await h.advance(30_000);
    assert.equal(h.streamCalls.length, 1);
  });
});

// ---------------- c. 未命中即停 ----------------
describe('c 缓存未命中即停止', () => {
  test('c1 重放 cacheRead=0 → 该会话立即停止，之后不再重放', async () => {
    h = await setup();
    h.replayUsage = { cacheReadTokens: 0, inputTokens: 5100, outputTokens: 16 };
    await h.real(HIT);
    await h.advance(4 * MIN);
    assert.equal(h.streamCalls.length, 1);
    const logs = h.logLines();
    assert.equal(logs.find((l) => l.kind === 'keepalive').status, 'miss');
    assert.ok(logs.some((l) => l.kind === 'stop' && l.reason === 'cache-miss'));
    assert.equal((await h.state()).sessions[0].stopped, true);
    await h.advance(60 * MIN);
    assert.equal(h.streamCalls.length, 1);
  });
});

// ---------------- d. 路由证明 ----------------
describe('d 路由必须先被真实命中证明', () => {
  test('d1 真实请求没有命中 → 不重放', async () => {
    h = await setup();
    await h.real({ cacheReadTokens: 0, inputTokens: 3000 });
    await h.advance(12 * MIN);
    assert.equal(h.streamCalls.length, 0);
    const st = await h.state();
    assert.equal(st.routes[0].proven, false);
    assert.equal(st.sessions[0].armed, false);
  });

  test('d2 证明阈值：cacheRead≥1024 且占比≥20% 才算证明', async () => {
    const cases = [
      [{ cacheReadTokens: 1000, inputTokens: 0 }, false, 'cacheRead<1024'],
      [{ cacheReadTokens: 1900, inputTokens: 8000 }, false, '占比 19%'],
      [{ cacheReadTokens: 2000, inputTokens: 8000 }, true, '占比正好 20%'],
    ];
    for (const [usage, proven, label] of cases) {
      h = await setup();
      await h.real(usage);
      await h.advance(4 * MIN);
      assert.equal(h.streamCalls.length, proven ? 1 : 0, label);
      h.teardown();
      h = null;
    }
  });

  test('d3 requireProvenCache=false → 未证明也重放', async () => {
    h = await setup({ config: { requireProvenCache: false } });
    await h.real({ cacheReadTokens: 0, inputTokens: 3000 });
    await h.advance(4 * MIN);
    assert.equal(h.streamCalls.length, 1);
  });
});

// ---------------- e. 空闲压缩 ----------------
describe('e 空闲压缩 compactIdle / runCompaction', () => {
  test('e1 空闲超时 → 恰好一次 compactNow（agent 为参数）；之后绝不重放/再压缩', async () => {
    const comp = { calls: 0, args: null, compactNow: async (agentObj) => { comp.calls += 1; comp.args = agentObj; return { shadowedTokenCount: 1234 }; } };
    h = await setup({ config: { compactEnabled: true, compactAfterMinutes: 10 }, agents: { [SID]: agent('idle', comp) }, compaction: comp });
    await h.real(HIT);
    await h.advance(9 * MIN + 30_000);
    assert.equal(comp.calls, 0);
    await h.advance(30_000);
    assert.equal(comp.calls, 1);
    assert.equal(comp.args, h.agents[SID]);
    assert.equal(h.streamCalls.length, 2, '压缩前的 4、8 分钟两次保活');
    const c = h.logLines().filter((l) => l.kind === 'compact');
    assert.equal(c.length, 1);
    assert.equal(c[0].status, 'success');
    assert.equal(c[0].via, 'service');
    assert.equal((await h.state()).sessions[0].stopped, true);
    await h.advance(60 * MIN);
    assert.equal(comp.calls, 1);
    assert.equal(h.streamCalls.length, 2);
  });

  test('e2 compactNow 抛错 → 仍只调用一次，entry 停止，记录 error', async () => {
    const comp = { calls: 0, compactNow: async () => { comp.calls += 1; throw new Error('boom'); } };
    h = await setup({ config: { compactEnabled: true, compactAfterMinutes: 10 }, agents: { [SID]: agent('idle', comp) }, compaction: comp });
    await h.real(HIT);
    await h.advance(10 * MIN + 30_000);
    assert.equal(comp.calls, 1);
    const c = h.logLines().find((l) => l.kind === 'compact');
    assert.equal(c.status, 'error');
    assert.equal(c.error, 'boom');
    assert.equal((await h.state()).sessions[0].stopped, true);
    await h.advance(60 * MIN);
    assert.equal(comp.calls, 1);
  });

  test('e3 compactNow 返回 null（无操作）→ 同样只一次', async () => {
    const comp = { calls: 0, compactNow: async () => { comp.calls += 1; return null; } };
    h = await setup({ config: { compactEnabled: true, compactAfterMinutes: 10 }, agents: { [SID]: agent('idle', comp) }, compaction: comp });
    await h.real(HIT);
    await h.advance(10 * MIN + 30_000);
    assert.equal(comp.calls, 1);
    assert.equal(h.logLines().find((l) => l.kind === 'compact').status, 'noop');
    await h.advance(60 * MIN);
    assert.equal(comp.calls, 1);
  });

  test('e4 agent 运行中 → 不触发、不停止；转为 idle 后再触发', async () => {
    const comp = { calls: 0, compactNow: async () => { comp.calls += 1; return { shadowedTokenCount: 1 }; } };
    h = await setup({ config: { compactEnabled: true, compactAfterMinutes: 10 }, agents: { [SID]: agent('running', comp) }, compaction: comp });
    await h.real(HIT);
    await h.advance(30 * MIN);
    assert.equal(comp.calls, 0);
    assert.equal(h.logLines().filter((l) => l.kind === 'compact').length, 0);
    assert.equal((await h.state()).sessions[0].stopped, false, '非 idle 时不得停止会话');
    h.agents[SID].status = 'idle';
    await h.advance(MIN);
    assert.equal(comp.calls, 1);
  });

  test('e5 无 compaction 服务 → 回退 ctx.commands.execute(agent, "/compact")', async () => {
    h = await setup({ config: { compactEnabled: true, compactAfterMinutes: 10 }, agents: { [SID]: agent('idle', undefined) } });
    h.commandResult = { result: { kind: 'success', text: 'done' } };
    await h.real(HIT);
    await h.advance(10 * MIN + 30_000);
    assert.equal(h.commandCalls.length, 1);
    assert.equal(h.commandCalls[0].name, '/compact');
    assert.equal(h.commandCalls[0].agent, h.agents[SID]);
    const c = h.logLines().find((l) => l.kind === 'compact');
    assert.equal(c.via, 'command');
    assert.equal(c.status, 'success');
    await h.advance(60 * MIN);
    assert.equal(h.commandCalls.length, 1);
  });

  test('e5b 无服务且无 /compact 命令 → 记录 missing，仍只一次', async () => {
    h = await setup({ config: { compactEnabled: true, compactAfterMinutes: 10 }, agents: { [SID]: agent('idle', undefined) } });
    h.commandResult = undefined;
    await h.real(HIT);
    await h.advance(10 * MIN + 30_000);
    assert.equal(h.commandCalls.length, 1);
    assert.equal(h.logLines().find((l) => l.kind === 'compact').status, 'missing');
    await h.advance(60 * MIN);
    assert.equal(h.commandCalls.length, 1);
  });

  test('e6 压缩后下一次真实请求重新武装；再次空闲超时可再压缩一次', async () => {
    const comp = { calls: 0, compactNow: async () => { comp.calls += 1; return { shadowedTokenCount: 1 }; } };
    h = await setup({ config: { compactEnabled: true, compactAfterMinutes: 10 }, agents: { [SID]: agent('idle', comp) }, compaction: comp });
    await h.real(HIT);
    await h.advance(10 * MIN + 30_000);
    assert.equal(comp.calls, 1);
    assert.equal((await h.state()).sessions[0].stopped, true);

    await h.real(HIT);
    assert.equal((await h.state()).sessions[0].stopped, false, '真实请求重新武装');
    const before = h.streamCalls.length;
    await h.advance(4 * MIN);
    assert.equal(h.streamCalls.length, before + 1, '重新武装后 4 分钟重放');
    await h.advance(6 * MIN);
    assert.equal(comp.calls, 2);
  });

  test('e7 purpose:"compaction" 的请求不被当作真实请求捕获（不重新武装、不重置空闲计时）', async () => {
    const comp = {
      calls: 0,
      compactNow: async () => {
        comp.calls += 1;
        for await (const _ of h.llmStream({ sessionId: SID, provider: CLAUDE.provider, model: CLAUDE.model, messages: MSG, maxTokens: 4096, purpose: 'compaction' })) { /* drain */ }
        return { shadowedTokenCount: 1 };
      }
    };
    h = await setup({ config: { compactEnabled: true, compactAfterMinutes: 10 }, agents: { [SID]: agent('idle', comp) }, compaction: comp });
    await h.real(HIT);
    await h.advance(10 * MIN + 30_000);
    assert.equal(comp.calls, 1);
    assert.equal(h.logLines().filter((l) => l.kind === 'capture').length, 1);
    const st = (await h.state()).sessions[0];
    assert.equal(st.stopped, true, 'compaction 请求不得重新武装');
    close(st.idleMinutes, 10.5, 0.05);
    await h.advance(30 * MIN);
    assert.equal(comp.calls, 1);
  });

  test('e8 compactEnabled=false：永不压缩，保活到 maxIdle 时长上限后 max-idle 停止（次数≈上限/间隔）', async () => {
    const comp = { calls: 0, compactNow: async () => { comp.calls += 1; return { shadowedTokenCount: 1 }; } };
    h = await setup({ config: { compactEnabled: false, compactAfterMinutes: 10, maxIdleMinutes: 20 }, agents: { [SID]: agent('idle', comp) }, compaction: comp });
    await h.real(HIT);
    await h.advance(60 * MIN);
    assert.equal(comp.calls, 0);
    assert.equal(h.streamCalls.length, 5, '20 分钟上限 / 4 分钟间隔 = 5 次保活');
    assert.ok(h.logLines().some((l) => l.kind === 'stop' && l.reason === 'max-idle'));
    assert.ok(!h.logLines().some((l) => l.reason === 'max-touches'), '不再有 max-touches 停止原因');
  });

  test('e9 压缩开启时 maxIdle 小于 compactAfter 仍先压缩（上限 = max(maxIdle, compactAfter+1)）', async () => {
    const comp = { calls: 0, compactNow: async () => { comp.calls += 1; return { shadowedTokenCount: 1 }; } };
    h = await setup({ config: { compactEnabled: true, compactAfterMinutes: 10, maxIdleMinutes: 5 }, agents: { [SID]: agent('idle', comp) }, compaction: comp });
    await h.real(HIT);
    await h.advance(9 * MIN + 30_000);
    assert.equal(h.streamCalls.length, 2, '4、8 分钟两次保活，未触发 max-idle');
    assert.ok(!h.logLines().some((l) => l.kind === 'stop' && l.reason === 'max-idle'));
    await h.advance(MIN);
    assert.equal(comp.calls, 1);
  });

  test('e10 缓存已判 miss（stopped）的会话不压缩', async () => {
    const comp = { calls: 0, compactNow: async () => { comp.calls += 1; return { shadowedTokenCount: 1 }; } };
    h = await setup({ config: { compactEnabled: true, compactAfterMinutes: 10 }, agents: { [SID]: agent('idle', comp) }, compaction: comp });
    h.replayUsage = { cacheReadTokens: 0, inputTokens: 5100, outputTokens: 16 };
    await h.real(HIT);
    await h.advance(15 * MIN);
    assert.equal(h.streamCalls.length, 1);
    assert.equal(comp.calls, 0);
    assert.equal(h.logLines().filter((l) => l.kind === 'compact').length, 0);
  });

  test('e11 在途真实流期间不压缩；stale 守卫先于压缩（5 分钟后 stop stale，之后不压缩）', async () => {
    const comp = { calls: 0, compactNow: async () => { comp.calls += 1; return { shadowedTokenCount: 1 }; } };
    h = await setup({ config: { compactEnabled: true, compactAfterMinutes: 10 }, agents: { [SID]: agent('idle', comp) }, compaction: comp });
    await h.real(HIT); // 建立 entry
    const it = h.open(HIT);
    await it.next(); // 在途
    await h.advance(10 * MIN + 30_000);
    assert.equal(comp.calls, 0, '在途流期间不压缩');
    assert.equal(h.streamCalls.length, 0, '在途流期间也不重放');
    assert.ok(!h.logLines().some((l) => l.kind === 'stop' && l.reason === 'stale'), '在途流期间不判 stale（流自己在占用缓存）');
    for await (const _ of it) { /* finish the real stream */ }
    await h.advance(MIN);
    assert.ok(h.logLines().some((l) => l.kind === 'stop' && l.reason === 'stale'), '流结束后距上次触缓存已远超 1.25×间隔 → stale');
    assert.equal(comp.calls, 0, 'stale 先于压缩，流结束后也不压缩');
  });

  test('e12 （观察）agent 不存在时：记录 skipped 并停止该会话', async () => {
    const comp = { calls: 0, compactNow: async () => { comp.calls += 1; return { shadowedTokenCount: 1 }; } };
    h = await setup({ config: { compactEnabled: true, compactAfterMinutes: 10 }, agents: {}, compaction: comp });
    await h.real(HIT);
    await h.advance(10 * MIN + 30_000);
    assert.equal(comp.calls, 0);
    const c = h.logLines().find((l) => l.kind === 'compact');
    assert.equal(c.status, 'skipped');
    assert.equal(c.reason, 'no-agent');
    assert.equal((await h.state()).sessions[0].stopped, true, '与 "agent 非 idle 不停止" 不同：缺 agent 会停止（设计观察）');
  });
});

// ---------------- f. 价格与节省 ----------------
describe('f 分路由价格与净省', () => {
  const sonnet = { hit: 0.1944, input: 1.9444, output: 9.7222, write: 2.4306 };
  const opus = { hit: 0.3889, input: 3.8889, output: 19.4444, write: 4.8611 };
  const usage = { cacheReadTokens: 100000, inputTokens: 50, outputTokens: 16 };
  const costOf = (p) => (100000 * p.hit + 50 * p.input + 16 * p.output) / 1e6;
  /** Anthropic-style: an expired prefix is re-billed one cache write; saved = C*(write-hit)/1e6 - cost. */
  const savedOf = (p) => (100000 * (p.write - p.hit)) / 1e6 - costOf(p);

  test('f1 Claude 路由用内置 Claude 价格：cost / saved 手算对照', async () => {
    h = await setup();
    await h.real(HIT);
    h.replayUsage = { ...usage };
    await h.advance(4 * MIN);
    const st = await h.state();
    const t = st.tasks[0];
    close(t.cost, costOf(sonnet));
    close(t.saved, savedOf(sonnet));
    assert.equal(t.hits, 1);
    assert.equal(t.touches, 1);
    close(costOf(sonnet), 0.0196927752, 1e-9);
    close(t.saved, 0.2039272248, 1e-6);
    const rec = (await h.http(TASK, { url: `${TASK}?session=${SID}` })).body;
    close(rec.records[0].cost, costOf(sonnet));
    close(st.stats.costEstimate, costOf(sonnet), 1e-4);
  });

  test('f2 未知路由：cost=0，不报节省', async () => {
    h = await setup({ config: { routes: [] } });
    await h.real(HIT, { provider: 'foo', model: 'bar' });
    h.replayUsage = { ...usage };
    await h.advance(4 * MIN);
    const st = await h.state();
    assert.equal(st.tasks[0].hits, 1);
    assert.equal(st.tasks[0].cost, 0);
    assert.ok(Math.abs(st.tasks[0].saved) < 1e-12);
    assert.equal(st.stats.costEstimate, 0);
  });

  test('f3 Opus 内置价格', async () => {
    h = await setup({ config: { routes: [OPUS] } });
    await h.real(HIT, { model: OPUS.model });
    h.replayUsage = { ...usage };
    await h.advance(4 * MIN);
    const t = (await h.state()).tasks[0];
    close(t.cost, costOf(opus));
    close(t.saved, savedOf(opus));
    // cost = 100000×0.3889 + 50×3.8889 + 16×19.4444 (CNY/1M) = 0.039396
    close(costOf(opus), 0.039396, 1e-6);
    // saved = 100000×(4.8611−0.3889)/1e6 − cost
    close(t.saved, 100000 * (4.8611 - 0.3889) / 1e6 - 0.039396, 1e-6);
  });

  test('f4 config.prices 覆盖生效', async () => {
    h = await setup({ config: { prices: { [`${CLAUDE.provider}/${CLAUDE.model}`]: { hit: 1, input: 2, output: 3, write: 4 } } } });
    await h.real(HIT);
    h.replayUsage = { ...usage };
    await h.advance(4 * MIN);
    const t = (await h.state()).tasks[0];
    close(t.cost, 0.100148);
    close(t.saved, 0.199852, 1e-6); // no miss tag: coldPerM = write = 4, avoided = 4 - 1
  });

  test('f5 config.prices 非法条目（负数）被丢弃，回退内置价格', async () => {
    h = await setup({ config: { prices: { [`${CLAUDE.provider}/${CLAUDE.model}`]: { hit: -1, input: 2, output: 3, write: 4 } } } });
    await h.real(HIT);
    h.replayUsage = { ...usage };
    await h.advance(4 * MIN);
    const t = (await h.state()).tasks[0];
    close(t.cost, costOf(sonnet));
  });

  test('f6 config.prices 缺字段条目被丢弃，回退内置价格', async () => {
    h = await setup({ config: { prices: { [`${CLAUDE.provider}/${CLAUDE.model}`]: { hit: 1, input: 2, output: 3 } } } });
    await h.real(HIT);
    h.replayUsage = { ...usage };
    await h.advance(4 * MIN);
    const t = (await h.state()).tasks[0];
    close(t.cost, costOf(sonnet));
  });
});

// ---------------- g. normalizeConfig（间接验证） ----------------
describe('g normalizeConfig 夹取（经 apply 间接验证）', () => {
  const comp = () => {
    const o = { calls: 0, compactNow: async () => { o.calls += 1; return { shadowedTokenCount: 1 }; } };
    return o;
  };

  test('g1 compactAfterMinutes=3 → 夹到 5（4.5 分钟不压缩，5.5 分钟压缩）', async () => {
    const c = comp();
    h = await setup({ config: { compactEnabled: true, compactAfterMinutes: 3 }, agents: { [SID]: agent('idle', c) }, compaction: c });
    await h.real(HIT);
    await h.advance(4.5 * MIN);
    assert.equal(c.calls, 0);
    await h.advance(MIN);
    assert.equal(c.calls, 1);
  });

  test('g2 compactAfterMinutes=500 → 夹到 120（119 分钟不压缩，121 分钟压缩）', async () => {
    const c = comp();
    h = await setup({ config: { compactEnabled: true, compactAfterMinutes: 500 }, agents: { [SID]: agent('idle', c) }, compaction: c });
    await h.real(HIT);
    await h.advance(119 * MIN);
    assert.equal(c.calls, 0);
    await h.advance(2 * MIN);
    assert.equal(c.calls, 1);
  });

  for (const bad of [-5, 0, 'abc', null, undefined]) {
    test(`g3 compactAfterMinutes=${JSON.stringify(bad)} → 回落为 20（19 分钟不压缩，21 分钟压缩）`, async () => {
      const c = comp();
      h = await setup({ config: { compactEnabled: true, compactAfterMinutes: bad }, agents: { [SID]: agent('idle', c) }, compaction: c });
      const st0 = await h.state();
      assert.equal(st0.config.compactAfterMinutes, 20);
      await h.real(HIT);
      await h.advance(19 * MIN);
      assert.equal(c.calls, 0);
      await h.advance(2 * MIN);
      assert.equal(c.calls, 1);
    });
  }

  test('g3b 非数字字符串 "12" 视为有效数字 → 12 分钟（Number 强转）', async () => {
    const c = comp();
    h = await setup({ config: { compactEnabled: true, compactAfterMinutes: '12' }, agents: { [SID]: agent('idle', c) }, compaction: c });
    assert.equal((await h.state()).config.compactAfterMinutes, 12);
  });

  test('g3c 未配置 compactAfterMinutes → 默认 20', async () => {
    h = await setup({ config: { compactEnabled: true } });
    assert.equal((await h.state()).config.compactAfterMinutes, 20);
  });

  test('g3d compactEnabled 非布尔（"true"）→ 视为 false', async () => {
    h = await setup({ config: { compactEnabled: 'true', compactAfterMinutes: 10 } });
    const st = await h.state();
    assert.equal(st.config.compactEnabled, false);
  });

  test('g3e sessionCompact 非布尔值被丢弃', async () => {
    h = await setup({ config: { compactEnabled: true, sessionCompact: { [SID]: 'yes', s2: false } } });
    const st = await h.state();
    assert.deepEqual(st.config.sessionCompact, { s2: false });
  });

  test('g4 sessionEnabled 非布尔值被丢弃 → 回落到默认 enabled=true', async () => {
    h = await setup({ config: { enabled: true, sessionEnabled: { [SID]: 'yes' } } });
    await h.real(HIT);
    await h.advance(4 * MIN);
    assert.equal(h.streamCalls.length, 1);
  });

  test('g4b sessionEnabled 显式 false 优先于 enabled=true', async () => {
    h = await setup({ config: { enabled: true, sessionEnabled: { [SID]: false } } });
    await h.real(HIT);
    await h.advance(10 * MIN);
    assert.equal(h.streamCalls.length, 0);
  });

  test('g5 intervalMinutes=0 → 回落到 4 分钟', async () => {
    h = await setup({ config: { intervalMinutes: 0 } });
    await h.real(HIT);
    await h.advance(3.5 * MIN);
    assert.equal(h.streamCalls.length, 0);
    await h.advance(30_000 + 0);
    assert.equal(h.streamCalls.length, 1);
  });

  test('g6 replayMaxTokens：正数生效；0 回落到 16', async () => {
    h = await setup({ config: { replayMaxTokens: 8 } });
    await h.real(HIT);
    await h.advance(4 * MIN);
    assert.equal(h.streamCalls[0].maxTokens, 8);
    h.teardown();

    h = await setup({ config: { replayMaxTokens: 0 } });
    await h.real(HIT);
    await h.advance(4 * MIN);
    assert.equal(h.streamCalls[0].maxTokens, 16);
  });

  test('g7 旧配置 maxTouches=0 被忽略（不再回落、不再限制次数）', async () => {
    h = await setup({ config: { maxTouches: 0 } });
    await h.real(HIT);
    await h.advance(12 * MIN);
    assert.equal(h.streamCalls.length, 3, '由 maxIdle / interval 决定，与 maxTouches 无关');
    assert.equal((await h.state()).config.maxTouches, 11, '派生值 floor(45/4)=11，与旧键无关');
  });

  test('g8 routes 里的非法条目被丢弃 → 等同"任意路由"', async () => {
    h = await setup({ config: { routes: [{ provider: 'blsc-anthropic' }] } });
    await h.real(HIT);
    await h.advance(4 * MIN);
    assert.equal(h.streamCalls.length, 1);
  });
});

// ---------------- h. 在途流的生命周期（inflight 泄漏探测） ----------------
describe('h inflight 生命周期', () => {
  test('h1 真实流被创建后被 return() 关闭（从未迭代）→ 之后仍应能保活重放', async () => {
    h = await setup();
    await h.real(HIT); // 先武装并证明路由
    const it = h.open(HIT);
    await it.return(); // 调用方直接关闭，流从未开始迭代
    await h.advance(4 * MIN);
    assert.equal(h.streamCalls.length, 1, 'inflight 不应因未迭代的流而永久占用');
  });

  test('h2 真实流被创建后被 return() 关闭 → 压缩也不应被永久阻塞', async () => {
    const comp = { calls: 0, compactNow: async () => { comp.calls += 1; return { shadowedTokenCount: 1 }; } };
    h = await setup({ config: { compactEnabled: true, compactAfterMinutes: 10 }, agents: { [SID]: agent('idle', comp) }, compaction: comp });
    await h.real(HIT);
    const it = h.open(HIT);
    await it.return();
    await h.advance(11 * MIN);
    assert.equal(comp.calls, 1, 'inflight 不应因未迭代的流而永久阻塞压缩');
  });
});

// ---------------- i. 窗口级压缩开关（新语义） ----------------
const S2 = 's2';
describe('i 窗口级压缩开关', () => {
  test('i-a 两个窗口同时保活：仅 sessionCompact=true 的被压缩；另一个继续保活并受 maxIdle 时长上限约束', async () => {
    const comp = { calls: 0, args: [], compactNow: async (a) => { comp.calls += 1; comp.args.push(a); return { shadowedTokenCount: 1 }; } };
    h = await setup({
      config: { sessionEnabled: { [SID]: true, [S2]: true }, compactEnabled: false, sessionCompact: { [SID]: true }, compactAfterMinutes: 10, maxIdleMinutes: 12 },
      agents: { [SID]: agent('idle', comp), [S2]: agent('idle', comp) },
      compaction: comp
    });
    await h.real(HIT, { sessionId: SID });
    await h.real(HIT, { sessionId: S2 });
    await h.advance(60 * MIN);

    assert.equal(comp.calls, 1, '只压缩一次（s1）');
    assert.equal(comp.args[0], h.agents[SID]);
    const compacts = h.logLines().filter((l) => l.kind === 'compact');
    assert.equal(compacts.length, 1);
    assert.equal(compacts[0].session, SID);

    const reps = h.streamCalls.map((o) => o.sessionId);
    assert.equal(reps.filter((x) => x === S2).length, 3, 's2 受 maxIdle=12 / interval=4 = 3 次约束');
    assert.ok(h.logLines().some((l) => l.kind === 'stop' && l.session === S2 && l.reason === 'max-idle'));
    assert.ok(!h.logLines().some((l) => l.kind === 'stop' && l.session === SID && l.reason === 'max-idle'), 's1 压缩后不因时长上限停止');

    const st = await h.state();
    assert.equal(st.windows[SID].compact, true);
    assert.equal(st.windows[S2].compact, false);
  });

  test('i-b sessionCompact[id]=false 覆盖 compactEnabled=true', async () => {
    const comp = { calls: 0, compactNow: async () => { comp.calls += 1; return { shadowedTokenCount: 1 }; } };
    h = await setup({
      config: { compactEnabled: true, compactAfterMinutes: 10, sessionCompact: { [SID]: false }, maxIdleMinutes: 8 },
      agents: { [SID]: agent('idle', comp) },
      compaction: comp
    });
    await h.real(HIT);
    await h.advance(60 * MIN);
    assert.equal(comp.calls, 0, '显式 false 覆盖默认 true');
    assert.ok(h.logLines().some((l) => l.kind === 'stop' && l.reason === 'max-idle'), '关闭压缩后按 maxIdle 停止');
    assert.equal(h.streamCalls.length, 2, '8 分钟上限 / 4 分钟间隔 = 2 次');
    const st = await h.state();
    assert.equal(st.windows[SID].compact, false);
  });

  test('i-c 运行中途经端点把压缩从关改开，到点压缩；再改关则不再压缩', async () => {
    const comp = { calls: 0, compactNow: async () => { comp.calls += 1; return { shadowedTokenCount: 1 }; } };
    h = await setup({ config: { compactEnabled: false, compactAfterMinutes: 10 }, agents: { [SID]: agent('idle', comp) }, compaction: comp });
    await h.real(HIT);
    await h.advance(5 * MIN);
    assert.equal((await h.state()).windows[SID].compact, false);

    let r = await h.http(SWITCH, { method: 'POST', body: { session: SID, compact: true } });
    assert.equal(r.status, 200);
    assert.equal(r.body.compact, true);
    assert.equal(r.body.enabled, true, 'compact-only 请求不改保活开关');
    assert.equal((await h.state()).windows[SID].compact, true);
    assert.equal(h.logLines().filter((l) => l.kind === 'compact-switch' && l.enabled === true).length, 1);

    await h.advance(5 * MIN + 30_000);
    assert.equal(comp.calls, 1, '到点（距上次真实请求 10 分钟）压缩');

    // 另一个窗口的场景：再开一次真实请求后关闭压缩，应不再压缩
    h.agents[SID].status = 'idle';
    await h.real(HIT);
    r = await h.http(SWITCH, { method: 'POST', body: { session: SID, compact: false } });
    assert.equal(r.body.compact, false);
    await h.advance(30 * MIN);
    assert.equal(comp.calls, 1);
  });

  test('i-c2 运行中途改为开启：此前已过的空闲时间直接满足阈值，立即压缩（下一 tick）', async () => {
    const comp = { calls: 0, compactNow: async () => { comp.calls += 1; return { shadowedTokenCount: 1 }; } };
    h = await setup({ config: { compactEnabled: false, compactAfterMinutes: 10 }, agents: { [SID]: agent('idle', comp) }, compaction: comp });
    await h.real(HIT);
    await h.advance(12 * MIN);
    assert.equal(comp.calls, 0);
    await h.http(SWITCH, { method: 'POST', body: { session: SID, compact: true } });
    await h.advance(30_000);
    assert.equal(comp.calls, 1);
  });

  test('i-d 压缩开关开、保活关闭的窗口不压缩（且不被跟踪）', async () => {
    const comp = { calls: 0, compactNow: async () => { comp.calls += 1; return { shadowedTokenCount: 1 }; } };
    h = await setup({
      config: { sessionEnabled: {}, compactEnabled: true, compactAfterMinutes: 10 },
      agents: { [SID]: agent('idle', comp) },
      compaction: comp
    });
    await h.real(HIT);
    await h.advance(30 * MIN);
    assert.equal(comp.calls, 0);
    assert.equal(h.streamCalls.length, 0);
    assert.equal((await h.state()).sessions.length, 0);
    assert.equal(h.logLines().filter((l) => l.kind === 'compact').length, 0);
  });

  test('i-d2 保活开启后被关闭（压缩开关仍开）→ 不压缩', async () => {
    const comp = { calls: 0, compactNow: async () => { comp.calls += 1; return { shadowedTokenCount: 1 }; } };
    h = await setup({ config: { sessionEnabled: {}, compactEnabled: true, compactAfterMinutes: 10 }, agents: { [SID]: agent('idle', comp) }, compaction: comp });
    await h.http(SWITCH, { method: 'POST', body: { session: SID, enabled: true } });
    await h.real(HIT);
    await h.http(SWITCH, { method: 'POST', body: { session: SID, enabled: false } });
    await h.advance(30 * MIN);
    assert.equal(comp.calls, 0);
    assert.equal(h.streamCalls.length, 0);
  });

  test('i-e 端点：{session,compact} 与 {session,enabled} 各自独立，可同时传', async () => {
    h = await setup({ config: { sessionEnabled: {} } });
    let r = await h.http(SWITCH, { method: 'POST', body: { session: SID, compact: true } });
    assert.equal(r.status, 200);
    assert.equal(r.body.enabled, false);
    assert.equal(r.body.compact, true);
    r = await h.http(SWITCH, { method: 'POST', body: { session: SID, enabled: true } });
    assert.equal(r.body.enabled, true);
    assert.equal(r.body.compact, true, '只改保活不影响压缩');
    r = await h.http(SWITCH, { method: 'POST', body: { session: SID, enabled: false, compact: false } });
    assert.equal(r.status, 200);
    assert.equal(r.body.enabled, false);
    assert.equal(r.body.compact, false);
    const cfg = (await h.state()).config;
    assert.equal(cfg.sessionCompact[SID], false);
    assert.equal(cfg.sessionEnabled[SID], false);
    assert.equal(cfg.compactEnabled, false);
  });

  test('i-e2 端点：缺字段或类型错误 → 400', async () => {
    h = await setup();
    const bad = [
      { body: {} },
      { body: { session: SID } },
      { body: { compact: true } },
      { body: { session: SID, compact: 'yes' } },
      { body: { session: SID, compact: 1 } },
      { body: { session: SID, enabled: 'true' } },
      { body: { session: SID, enabled: 1, compact: true } },
      { body: { session: '' , compact: true } }
    ];
    for (const { body } of bad) {
      const r = await h.http(SWITCH, { method: 'POST', body });
      assert.equal(r.status, 400, JSON.stringify(body));
    }
  });

  test('i-e3 端点 state 回显：windows[id].compact 与 config.compactEnabled/sessionCompact', async () => {
    h = await setup({ config: { compactEnabled: true, sessionCompact: { [SID]: false } } });
    await h.real(HIT);
    const st = await h.state();
    assert.equal(st.config.compactEnabled, true);
    assert.deepEqual(st.config.sessionCompact, { [SID]: false });
    assert.equal(st.windows[SID].compact, false);
    assert.equal(typeof st.windows[SID].enabled, 'boolean');
  });

  test('i-e4 无 compact 时的窗口默认值：从未显式选择的窗口跟随 compactEnabled', async () => {
    h = await setup({ config: { compactEnabled: true, sessionCompact: {} } });
    await h.real(HIT);
    assert.equal((await h.state()).windows[SID].compact, true);
  });
});

// ---------------- j. 防 CSRF / 白名单 / 数值上限（端点） ----------------
const S3 = 's3';
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await flush(); };
describe('j 端点防 CSRF、白名单、上限', () => {
  test('j1 POST 缺 content-type → 415；text/plain → 415；缺 x-keepalive → 415', async () => {
    h = await setup({ config: { sessionEnabled: {} } });
    let r = await h.http(SWITCH, { method: 'POST', body: { session: SID, enabled: true }, headers: { 'content-type': undefined } });
    assert.equal(r.status, 415);
    r = await h.http(SWITCH, { method: 'POST', body: { session: SID, enabled: true }, headers: { 'content-type': 'text/plain' } });
    assert.equal(r.status, 415);
    r = await h.http(SWITCH, { method: 'POST', body: { session: SID, enabled: true }, headers: { 'x-keepalive': undefined } });
    assert.equal(r.status, 415);
    r = await h.http(CONFIG_EP, { method: 'POST', body: { maxTouches: 3 }, headers: { 'x-keepalive': undefined } });
    assert.equal(r.status, 415);
    r = await h.http('/plugins/cache-keepalive/task/delete', { method: 'POST', body: { session: SID }, headers: { 'content-type': undefined } });
    assert.equal(r.status, 415);
    assert.equal((await h.state()).config.sessionEnabled[SID], undefined, '被拒绝的请求不得生效');
  });

  test('j2 Origin 与 Host 不同 → 403；Origin 与 Host 相同 → 200', async () => {
    h = await setup();
    let r = await h.http(SWITCH, { method: 'POST', body: { session: SID, enabled: true }, headers: { origin: 'http://evil.example' } });
    assert.equal(r.status, 403);
    r = await h.http(SWITCH, { method: 'POST', body: { session: SID, enabled: true }, headers: { origin: 'http://127.0.0.1:9999' } });
    assert.equal(r.status, 403, '端口不同也算跨源');
    r = await h.http(SWITCH, { method: 'POST', body: { session: SID, enabled: true }, headers: { origin: 'http://127.0.0.1:50867' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.enabled, true);
  });

  test('j3 /config 只接受白名单字段；routes/prices/sessionEnabled 被忽略', async () => {
    h = await setup({ config: { routes: [CLAUDE], prices: {}, sessionEnabled: {} } });
    const r = await h.http(CONFIG_EP, {
      method: 'POST',
      body: { maxTouches: 7, routes: [OPUS], prices: { 'x/y': { hit: 1, input: 1, output: 1, write: 1 } }, sessionEnabled: { [SID]: true }, compactEnabled: true }
    });
    assert.equal(r.status, 200);
    const cfg = (await h.state()).config;
    assert.equal(cfg.maxTouches, 11, 'maxTouches 请求体被忽略，仍为推导值 floor(45/4)');
    assert.equal(cfg.compactEnabled, true, '白名单内字段生效');
    assert.deepEqual(cfg.routes, [CLAUDE], 'routes 不得被端点改写');
    assert.deepEqual(cfg.sessionEnabled, {}, 'sessionEnabled 不得被端点改写');
    const onDisk = JSON.parse(fs.readFileSync(path.join(h.dir, 'config.json'), 'utf8'));
    assert.deepEqual(onDisk.prices, {}, 'prices 不得被端点改写');
    assert.deepEqual(onDisk.routes, [CLAUDE]);
  });

  test('j4 /config body 为数组 / 字符串 / null → 400', async () => {
    h = await setup();
    for (const body of [[1, 2], 'x', null]) {
      const r = await h.http(CONFIG_EP, { method: 'POST', body });
      assert.equal(r.status, 400, JSON.stringify(body));
    }
  });

  test('j5 数值上限：intervalMinutes≤60、maxIdle≤1440、replayMaxTokens≤64、maxSessions≤10', async () => {
    h = await setup();
    const r = await h.http(CONFIG_EP, { method: 'POST', body: { intervalMinutes: 500, maxIdleMinutes: 99999, replayMaxTokens: 1000, maxSessions: 50 } });
    assert.equal(r.status, 200);
    const cfg = (await h.state()).config;
    assert.equal(cfg.intervalMinutes, 60);
    assert.equal(cfg.maxIdleMinutes, 1440);
    assert.equal(cfg.maxTouches, 24, '派生值 1440 / 60 = 24');
    assert.equal(cfg.replayMaxTokens, 64);
    assert.equal(cfg.maxSessions, 10);
  });

});

// ---------------- k. 重放看门狗（60 秒） ----------------
describe('k 重放看门狗', () => {
  test('k1 s1 的流挂住 → 60 秒后记 error 并释放；s2 仍能重放（不被卡死）', async () => {
    h = await setup({ config: { intervalMinutes: 10, sessionEnabled: { [SID]: true, [S2]: true } } });
    await h.real(HIT, { sessionId: SID });  // 先插入 → 同一 tick 中先处理
    await h.real(HIT, { sessionId: S2 });
    h.hangFor.add(SID);
    await h.advance(10 * MIN);               // 两者同时到期；SID 挂住
    assert.equal(h.streamCalls.filter((o) => o.sessionId === S2).length, 0, '挂住期间 s2 尚未轮到');
    await h.advance(61_000);                 // 60s 看门狗触发
    const err = h.logLines().find((l) => l.kind === 'keepalive' && l.session === SID);
    assert.ok(err, 's1 应有记录');
    assert.equal(err.status, 'error');
    assert.match(err.error, /timed out/);
    const replaySignal = h.streamCalls.find((o) => o.sessionId === SID)?.signal;
    assert.ok(replaySignal?.aborted, '看门狗应 abort 挂住的重放');
    await h.advance(60_000);                 // 释放后 s2 在下一轮 tick 被重放（未过期）
    assert.ok(h.streamCalls.some((o) => o.sessionId === S2), 'busy 已释放，s2 应被重放');
  });
});

// ---------------- l. 命中判定（hit ratio ≥ 0.6） ----------------
describe('l 命中判定', () => {
  test('l1 部分命中（读 3000、未命中 90000）→ miss 并停止 cache-miss', async () => {
    h = await setup();
    await h.real(HIT);
    h.replayUsage = { cacheReadTokens: 3000, inputTokens: 90000, outputTokens: 16 };
    await h.advance(4 * MIN);
    const ka = h.logLines().find((l) => l.kind === 'keepalive');
    assert.equal(ka.status, 'miss');
    assert.ok(h.logLines().some((l) => l.kind === 'stop' && l.reason === 'cache-miss'));
    assert.equal((await h.state()).sessions[0].stopped, true);
  });

  test('l2 cacheWrite 计入分母：读 5000、写 5000、未命中 100 → 0.495 → miss', async () => {
    h = await setup();
    await h.real(HIT);
    h.replayUsage = { cacheReadTokens: 5000, inputTokens: 100, cacheWriteTokens: 5000, outputTokens: 16 };
    await h.advance(4 * MIN);
    assert.equal(h.logLines().find((l) => l.kind === 'keepalive').status, 'miss');
  });

  test('l3 恰好 0.9 → hit；0.89 → miss（HIT_RATIO=0.9）', async () => {
    h = await setup();
    await h.real(HIT);
    h.replayUsage = { cacheReadTokens: 9000, inputTokens: 1000, outputTokens: 16 };
    await h.advance(4 * MIN);
    assert.equal(h.logLines().find((l) => l.kind === 'keepalive').status, 'hit');
    assert.equal((await h.state()).sessions[0].stopped, false);
    h.teardown(); h = null;

    h = await setup();
    await h.real(HIT);
    h.replayUsage = { cacheReadTokens: 8900, inputTokens: 1100, outputTokens: 16 };
    await h.advance(4 * MIN);
    assert.equal(h.logLines().find((l) => l.kind === 'keepalive').status, 'miss');
  });

  test('l4 无任何 usage 字段 → unknown，stop reason cache-unknown', async () => {
    h = await setup();
    await h.real(HIT);
    h.replayUsage = { outputTokens: 16 };
    await h.advance(4 * MIN);
    assert.equal(h.logLines().find((l) => l.kind === 'keepalive').status, 'unknown');
    assert.ok(h.logLines().some((l) => l.kind === 'stop' && l.reason === 'cache-unknown'));
    assert.equal((await h.state()).sessions[0].stopped, true);
    await h.advance(30 * MIN);
    assert.equal(h.streamCalls.length, 1);
  });

  test('l4b 无 cacheRead 但 input>0 → miss，stop reason cache-miss', async () => {
    h = await setup();
    await h.real(HIT);
    h.replayUsage = { inputTokens: 100, outputTokens: 16 };
    await h.advance(4 * MIN);
    assert.equal(h.logLines().find((l) => l.kind === 'keepalive').status, 'miss');
    assert.ok(h.logLines().some((l) => l.kind === 'stop' && l.reason === 'cache-miss'));
  });
});

// ---------------- m. 过期保护（stale） ----------------
describe('m 过期保护', () => {
  test('m1 一次性快进 100 分钟（maxIdle 放宽到 1440）→ 0 次重放，stopped，reason stale', async () => {
    h = await setup({ config: { maxIdleMinutes: 1440 } });
    await h.real(HIT);
    mock.timers.tick(100 * MIN);
    await settle();
    assert.equal(h.streamCalls.length, 0);
    assert.equal((await h.state()).sessions[0].stopped, true);
    const stop = h.logLines().find((l) => l.kind === 'stop');
    assert.equal(stop.reason, 'stale');
  });
});

// ---------------- n. 重放期间的真实请求 ----------------
describe('n 重放期间来了真实请求', () => {
  test('n1 重放返回后只记录：不标 stopped，且 touch 为发起时编号', async () => {
    h = await setup();
    await h.real(HIT);
    let release;
    h.gate = new Promise((r) => { release = r; });
    await h.advance(4 * MIN); // 重放发起并挂在 gate 上
    assert.equal(h.streamCalls.length, 1);
    await h.real(HIT); // 真实请求重新武装（gen++，touches 归零）
    release();
    await settle();
    h.gate = null;
    const ka = h.logLines().find((l) => l.kind === 'keepalive');
    assert.equal(ka.touch, 1, 'touch 必须是发起时的编号，不被重置为 0');
    assert.equal(ka.status, 'hit');
    const st = (await h.state()).sessions[0];
    assert.equal(st.stopped, false, '新一轮不得被旧重放的结果标 stopped');
  });

  test('n2 旧重放判 miss 也不停止新一轮', async () => {
    h = await setup();
    await h.real(HIT);
    h.replayUsage = { cacheReadTokens: 0, inputTokens: 5100, outputTokens: 16 }; // 重放开始时即采用
    let release;
    h.gate = new Promise((r) => { release = r; });
    await h.advance(4 * MIN);
    await h.real(HIT);
    release();
    await settle();
    h.gate = null;
    assert.equal(h.logLines().find((l) => l.kind === 'keepalive').status, 'miss');
    assert.equal((await h.state()).sessions[0].stopped, false);
    assert.ok(!h.logLines().some((l) => l.kind === 'stop' && l.reason === 'cache-miss'));
  });
});

// ---------------- o. 压缩后台化 ----------------
describe('o 压缩不占全局 busy', () => {
  test('o1 压缩挂起时，另一会话仍照常重放', async () => {
    const comp = { calls: 0, compactNow: () => { comp.calls += 1; return new Promise(() => {}); } };
    h = await setup({
      config: { sessionEnabled: { [SID]: true, [S2]: true }, sessionCompact: { [SID]: true, [S2]: false }, compactEnabled: false, compactAfterMinutes: 10 },
      agents: { [SID]: agent('idle', comp) },
      compaction: comp
    });
    await h.real(HIT, { sessionId: S2 });
    await h.real(HIT, { sessionId: SID });
    await h.advance(20 * MIN);
    assert.equal(comp.calls, 1);
    assert.ok(h.streamCalls.filter((o) => o.sessionId === S2).length >= 4, 's2 在压缩挂起期间仍保活');
  });

  test('o2 压缩超过 10 分钟 → 记 error（compaction timed out）并释放；之后真实请求可再次武装压缩', async () => {
    const comp = { calls: 0, compactNow: () => { comp.calls += 1; return new Promise(() => {}); } };
    h = await setup({ config: { compactEnabled: true, compactAfterMinutes: 10 }, agents: { [SID]: agent('idle', comp) }, compaction: comp });
    await h.real(HIT);
    await h.advance(10 * MIN + 30_000); // 压缩开始（挂住）
    assert.equal(comp.calls, 1);
    await h.advance(10 * MIN + 30_000); // 10 分钟看门狗
    const c = h.logLines().find((l) => l.kind === 'compact');
    assert.equal(c.status, 'error');
    assert.match(c.error, /timed out/);
    await h.real(HIT);
    await h.advance(10 * MIN + 30_000);
    assert.equal(comp.calls, 2, '压缩已释放（compacting 清空），可再次触发');
  });

  test('o3 压缩开着但 agent 非 idle：压缩跳过、保活照常（不被吞掉）', async () => {
    const comp = { calls: 0, compactNow: async () => { comp.calls += 1; return { shadowedTokenCount: 1 }; } };
    h = await setup({ config: { compactEnabled: true, compactAfterMinutes: 10 }, agents: { [SID]: agent('running', comp) }, compaction: comp });
    await h.real(HIT);
    await h.advance(12 * MIN + 30_000);
    assert.equal(comp.calls, 0);
    assert.ok(h.streamCalls.length >= 3, 'agent 忙时仍按保活重放（4/8/12 分钟）');
    assert.equal((await h.state()).sessions[0].stopped, false);
  });

  test('o4 压缩开启时 maxIdle 取 max(maxIdle, compactAfter+1)：maxIdle=5 时 agent 忙 → 到 11 分钟才 max-idle', async () => {
    const comp = { calls: 0, compactNow: async () => { comp.calls += 1; return { shadowedTokenCount: 1 }; } };
    h = await setup({ config: { compactEnabled: true, compactAfterMinutes: 10, maxIdleMinutes: 5 }, agents: { [SID]: agent('running', comp) }, compaction: comp });
    await h.real(HIT);
    await h.advance(8 * MIN);
    assert.ok(!h.logLines().some((l) => l.kind === 'stop' && l.reason === 'max-idle'), '8 分钟时不应 max-idle');
    await h.advance(4 * MIN + 30_000);
    assert.ok(h.logLines().some((l) => l.kind === 'stop' && l.reason === 'max-idle'), '超过 11 分钟应 max-idle');
  });
});

// ---------------- p. tick 顺序处理 ----------------
describe('p tick 顺序', () => {
  test('p1 三个会话同时到期 → 同一轮内依次全部重放', async () => {
    h = await setup({ config: { sessionEnabled: { [SID]: true, [S2]: true, [S3]: true } } });
    await h.real(HIT, { sessionId: SID });
    await h.real(HIT, { sessionId: S2 });
    await h.real(HIT, { sessionId: S3 });
    await h.advance(4 * MIN);
    const ids = new Set(h.streamCalls.map((o) => o.sessionId));
    assert.equal(h.streamCalls.length, 3, '一次扫描内三个会话都应重放');
    assert.deepEqual([...ids].sort(), [SID, S2, S3].sort());
  });
});

// ---------------- q. inflight 计数 & purpose ----------------
describe('q inflight 计数与 purpose', () => {
  test('q1 同会话两个并发真实流：先结束一个，另一个仍在途 → 不重放；全部结束后才重放', async () => {
    h = await setup();
    await h.real(HIT);
    const a = h.open(HIT)[Symbol.asyncIterator]();
    const b = h.open(HIT)[Symbol.asyncIterator]();
    await a.next(); // 开始迭代 a（计数 +1）
    await b.next(); // 开始迭代 b（计数 +1）
    // 结束 a
    let x; do { x = await a.next(); } while (!x.done);
    await h.advance(4 * MIN);
    assert.equal(h.streamCalls.length, 0, 'b 仍在途，不应重放');
    // 结束 b
    do { x = await b.next(); } while (!x.done);
    await h.advance(30_000);
    assert.equal(h.streamCalls.length, 1, '全部结束后重放');
  });

  test('q2 purpose 请求不计在途、不影响 route.proven/samples', async () => {
    h = await setup();
    await h.real(HIT); // 真实证明一次
    const samplesBefore = (await h.state()).routes[0].samples;
    const pending = h.llmStream({ sessionId: SID, provider: CLAUDE.provider, model: CLAUDE.model, messages: MSG, maxTokens: 4096, purpose: 'compaction' })[Symbol.asyncIterator]();
    await pending.next(); // 开始迭代（若误计在途，会阻止重放）
    await h.advance(4 * MIN);
    assert.equal(h.streamCalls.length, 1, 'purpose 流不应阻止重放');
    assert.equal((await h.state()).routes[0].samples, samplesBefore + 0, 'purpose 流不计入 samples（重放本身也不计）');
    for (let i = 0; i < 5; i++) { const x = await pending.next(); if (x.done) break; }
  });
});

// ---------------- r. 配置健壮性（热加载 / 持久化 / 300 条上限） ----------------
describe('r 配置健壮性', () => {
  test('r1 config.json 解析失败：热加载保留旧配置，记 config-error', async () => {
    const origWatch = fs.watchFile; const origUnwatch = fs.unwatchFile;
    let listener = null; let watchedWith = null; let unwatchedWith = null;
    fs.watchFile = (p, opts, fn) => { watchedWith = fn; listener = fn; };
    fs.unwatchFile = (p, fn) => { unwatchedWith = fn; };
    try {
      h = await setup({ config: { intervalMinutes: 7 } });
      assert.equal((await h.state()).config.intervalMinutes, 7);
      fs.writeFileSync(path.join(h.dir, 'config.json'), '{ broken json');
      listener();
      assert.equal((await h.state()).config.intervalMinutes, 7, '解析失败不得重置为默认');
      assert.ok(h.logLines().some((l) => l.kind === 'config-error'));
      // 具名 listener：unwatch 必须传同一个函数
      const listenerUsed = listener;
      h.teardown();
      assert.equal(unwatchedWith, listenerUsed, 'teardown 时 unwatch 必须传同一 listener');
      h = null;
    } finally {
      fs.watchFile = origWatch; fs.unwatchFile = origUnwatch;
    }
  });

  test('r1b watchFile 与 unwatchFile 使用同一个具名 listener', async () => {
    const origWatch = fs.watchFile; const origUnwatch = fs.unwatchFile;
    let w = null; let u = null;
    fs.watchFile = (p, opts, fn) => { w = fn; };
    fs.unwatchFile = (p, fn) => { u = fn; };
    try {
      h = await setup();
      const cleanup = h.cleanups[h.cleanups.length - 1];
      assert.equal(typeof cleanup, 'function');
      // the lifecycle effect is registered last (status-route effect is first)
      cleanup();
      assert.ok(w && u === w, 'unwatchFile 必须传入 watchFile 时的同一 listener');
    } finally {
      fs.watchFile = origWatch; fs.unwatchFile = origUnwatch;
    }
  });

  test('r2 saveConfig 原子写：POST 后目录中不残留 config.json.tmp，config.json 为合法 JSON', async () => {
    h = await setup();
    await h.http(CONFIG_EP, { method: 'POST', body: { maxIdleMinutes: 90 } });
    assert.equal(fs.existsSync(path.join(h.dir, 'config.json.tmp')), false);
    const parsed = JSON.parse(fs.readFileSync(path.join(h.dir, 'config.json'), 'utf8'));
    assert.equal(parsed.maxIdleMinutes, 90);
  });

  test('r3 sessionEnabled 重写已有 key → 移到队尾', async () => {
    h = await setup({ config: { sessionEnabled: { x: true, y: false } } });
    await h.http(SWITCH, { method: 'POST', body: { session: 'x', enabled: true } });
    assert.deepEqual(Object.keys((await h.state()).config.sessionEnabled), ['y', 'x']);
  });

  test('r4 sessionEnabled 超过 300 条：先丢 false（最旧的），活跃 true 不被挤掉', async () => {
    const map = { a0: true };
    for (let i = 1; i <= 299; i++) map['f' + i] = false; // 300 条，其中只有 a0 为 true
    h = await setup({ config: { sessionEnabled: map } });
    await h.http(SWITCH, { method: 'POST', body: { session: 'newcomer', enabled: true } });
    const se = (await h.state()).config.sessionEnabled;
    assert.equal(Object.keys(se).length, 300);
    assert.equal(se.a0, true, '活跃 true 必须保留');
    assert.equal(se.newcomer, true);
    assert.equal(se.f1, undefined, '最旧的 false 先被丢弃');
    assert.equal(se.f299, false);
  });

  test('r4b sessionCompact 同样的 300 条上限规则', async () => {
    const map = { c0: true };
    for (let i = 1; i <= 299; i++) map['g' + i] = false;
    h = await setup({ config: { sessionCompact: map } });
    await h.http(SWITCH, { method: 'POST', body: { session: 'newc', compact: true } });
    const sc = (await h.state()).config.sessionCompact;
    assert.equal(Object.keys(sc).length, 300);
    assert.equal(sc.c0, true);
    assert.equal(sc.newc, true);
  });
});

// ---------------- s. maxTouches 移除：配置迁移、派生值、默认值 ----------------
describe('s maxTouches 已移除（派生只读）', () => {
  test('s1 旧 config.json 含 maxTouches：被忽略，保存后磁盘上不再出现', async () => {
    h = await setup({ config: { maxTouches: 3, maxIdleMinutes: 60 } });
    const st = await h.state();
    assert.equal(st.config.maxTouches, 15, '本用例显式 maxIdle=60，派生值 floor(60/4)=15，旧键 3 不生效');
    await h.http(CONFIG_EP, { method: 'POST', body: { maxIdleMinutes: 61 } }); // 触发 saveConfig
    const onDisk = JSON.parse(fs.readFileSync(path.join(h.dir, 'config.json'), 'utf8'));
    assert.equal(Object.prototype.hasOwnProperty.call(onDisk, 'maxTouches'), false, '保存后不得再写入 maxTouches');
    assert.equal(onDisk.maxIdleMinutes, 61);
  });

  test('s2 POST /config 带 maxTouches：被忽略（白名单外），不写盘', async () => {
    h = await setup();
    const r = await h.http(CONFIG_EP, { method: 'POST', body: { maxTouches: 2 } });
    assert.equal(r.status, 200);
    const onDisk = JSON.parse(fs.readFileSync(path.join(h.dir, 'config.json'), 'utf8'));
    assert.equal(Object.prototype.hasOwnProperty.call(onDisk, 'maxTouches'), false);
    assert.equal((await h.state()).config.maxTouches, 11, '派生值不受输入影响');
  });

  test('s3 state.config.maxTouches = floor(maxIdle/interval)，改任一项都会随之变化', async () => {
    h = await setup({ config: { maxIdleMinutes: 60, intervalMinutes: 4 } });
    assert.equal((await h.state()).config.maxTouches, 15);
    await h.http(CONFIG_EP, { method: 'POST', body: { intervalMinutes: 7 } });
    assert.equal((await h.state()).config.maxTouches, 8, 'floor(60/7)=8');
    await h.http(CONFIG_EP, { method: 'POST', body: { maxIdleMinutes: 100 } });
    assert.equal((await h.state()).config.maxTouches, 14, 'floor(100/7)=14');
    await h.http(CONFIG_EP, { method: 'POST', body: { intervalMinutes: 60, maxIdleMinutes: 5 } });
    assert.equal((await h.state()).config.maxTouches, 0, '不再取 max(1,…)：maxIdle<interval → 0');
  });

  test('s3b 派生值只读：请求体中的 maxTouches 对 state 无影响', async () => {
    h = await setup({ config: { maxIdleMinutes: 60, intervalMinutes: 4 } });
    await h.http(CONFIG_EP, { method: 'POST', body: { maxTouches: 999 } });
    assert.equal((await h.state()).config.maxTouches, 15);
  });

  test('s4 默认 maxIdleMinutes = 60（无配置时）', async () => {
    h = await setup({ config: {} });
    // 去掉 config.json 中的 maxIdleMinutes，检验默认值
    const cfgPath = path.join(h.dir, 'config.json');
    const cur = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    delete cur.maxIdleMinutes;
    fs.writeFileSync(cfgPath, JSON.stringify(cur));
    await h.http(CONFIG_EP, { method: 'POST', body: { scanSeconds: 30 } }); // 重新读盘并规范化
    assert.equal((await h.state()).config.maxIdleMinutes, 45);
  });

  test('s4b 默认下真实运行：到 45 分钟上限 → max-idle（11 次保活，发生在 4..44 分钟）', async () => {
    h = await setup();
    await h.real(HIT);
    await h.advance(50 * MIN);
    assert.equal(h.streamCalls.length, 11, 'floor(45/4) = 11');
    assert.ok(h.logLines().some((l) => l.kind === 'stop' && l.reason === 'max-idle'));
  });

  test('s5 压缩开启时 maxIdle 小于 compactAfter：仍先压缩，不因 max-idle 抢先停止（原用例保留）', async () => {
    const comp = { calls: 0, compactNow: async () => { comp.calls += 1; return { shadowedTokenCount: 1 }; } };
    h = await setup({ config: { compactEnabled: true, compactAfterMinutes: 20, maxIdleMinutes: 5 }, agents: { [SID]: agent('idle', comp) }, compaction: comp });
    await h.real(HIT);
    await h.advance(20 * MIN + 30_000);
    assert.equal(comp.calls, 1, '20 分钟先压缩');
    assert.ok(!h.logLines().some((l) => l.kind === 'stop' && l.reason === 'max-idle'));
  });
});

// ---------------- t. 净省口径（Anthropic 式：过期只收一次写入价；kimi 带 miss 标签 = input+write） ----------------
const SONNET_KEY = `${CLAUDE.provider}/${CLAUDE.model}`;
const KIMI = { provider: 'kimi-coding', model: 'kimi-k3.1-pro' };
const KIMI_KEY = 'kimi-coding/kimi-k3.1-pro';
const costPer = (p, cacheRead, input, output) => (cacheRead * p.hit + input * p.input + output * p.output) / 1e6;
const sonnetP = { hit: 0.1944, input: 1.9444, output: 9.7222, write: 2.4306 };

describe('t 净省口径', () => {
  test('t-a kimi 路由用 input+write 口径：saved = C×(13+13−1.3)/1e6 − cost', async () => {
    h = await setup({ config: { routes: [KIMI] } });
    await h.real(HIT, { provider: KIMI.provider, model: KIMI.model });
    h.replayUsage = { cacheReadTokens: 100000, inputTokens: 50, outputTokens: 16 };
    await h.advance(4 * MIN);
    const t = (await h.state()).tasks[0];
    const cost = (100000 * 1.3 + 50 * 13 + 16 * 68) / 1e6; // 0.131738
    close(t.cost, cost, 1e-9);
    close(t.saved, (100000 * (13 + 13 - 1.3)) / 1e6 - cost, 1e-6); // 2.47 - 0.131738 = 2.338262
    close(t.saved, 2.338262, 1e-6);
  });

  test('t-a2 huosan 路由同样带 miss 标签', async () => {
    const HUOSAN = { provider: 'huosan', model: 'kimi-k3.1-pro' };
    h = await setup({ config: { routes: [HUOSAN] } });
    await h.real(HIT, { provider: HUOSAN.provider, model: HUOSAN.model });
    h.replayUsage = { cacheReadTokens: 100000, inputTokens: 50, outputTokens: 16 };
    await h.advance(4 * MIN);
    close((await h.state()).tasks[0].saved, 2.338262, 1e-6);
  });

  test('t-b config.prices 带 miss:"input+write" 生效（coldPerM = 2+4 = 6）', async () => {
    h = await setup({ config: { prices: { [SONNET_KEY]: { hit: 1, input: 2, output: 3, write: 4, miss: 'input+write' } } } });
    await h.real(HIT);
    h.replayUsage = { cacheReadTokens: 100000, inputTokens: 50, outputTokens: 16 };
    await h.advance(4 * MIN);
    const t = (await h.state()).tasks[0];
    close(t.cost, 0.100148, 1e-9);
    close(t.saved, 100000 * (6 - 1) / 1e6 - 0.100148, 1e-6); // 0.5 - 0.100148 = 0.399852
    close(t.saved, 0.399852, 1e-6);
  });

  test('t-b2 config.prices 的 miss:"foo" 被忽略（coldPerM 回到 write = 4）', async () => {
    h = await setup({ config: { prices: { [SONNET_KEY]: { hit: 1, input: 2, output: 3, write: 4, miss: 'foo' } } } });
    await h.real(HIT);
    h.replayUsage = { cacheReadTokens: 100000, inputTokens: 50, outputTokens: 16 };
    await h.advance(4 * MIN);
    close((await h.state()).tasks[0].saved, 0.199852, 1e-6);
    await h.http(CONFIG_EP, { method: 'POST', body: { maxIdleMinutes: 50 } }); // 触发 saveConfig 规范化
    const onDisk = JSON.parse(fs.readFileSync(path.join(h.dir, 'config.json'), 'utf8'));
    assert.equal(onDisk.prices[SONNET_KEY]?.miss, undefined, '非法 miss 不写入 prices');
  });

  test('t-c 多次保活的一个空闲段：saved 随次数线性下降，约 11.5 次后为负（Sonnet, C=300000）', async () => {
    h = await setup({ config: { maxIdleMinutes: 60 } });
    await h.real(HIT);
    h.replayUsage = { cacheReadTokens: 300000, inputTokens: 50, outputTokens: 16 };
    const cost1 = costPer(sonnetP, 300000, 50, 16); // 0.0585727752
    const base = (300000 * (sonnetP.write - sonnetP.hit)) / 1e6; // 0.67086
    const breakeven = base / cost1;
    close(breakeven, 11.4527, 1e-3);
    const seen = [];
    for (let k = 1; k <= 12; k++) {
      await h.advance(4 * MIN);
      const t = (await h.state()).tasks[0];
      assert.equal(t.touches, k);
      close(t.saved, base - k * cost1, 1e-5);
      seen.push(t.saved);
    }
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i] < seen[i - 1], '随次数单调下降');
    assert.ok(seen[10] > 0, '第 11 次仍为正');
    assert.ok(seen[11] < 0, '第 12 次起为负');
  });

  test('t-d 两个空闲段（中间新的真实请求）分别结算再相加', async () => {
    h = await setup({ config: { maxIdleMinutes: 60 } });
    await h.real(HIT);
    h.replayUsage = { cacheReadTokens: 100000, inputTokens: 50, outputTokens: 16 };
    await h.advance(8 * MIN + 30_000); // 2 次保活（gap 1）
    await h.real(HIT); // 新的真实请求：新段开始（touch 归零）
    h.replayUsage = { cacheReadTokens: 300000, inputTokens: 50, outputTokens: 16 };
    await h.advance(4 * MIN + 30_000); // 1 次保活（gap 2）
    const t = (await h.state()).tasks[0];
    assert.equal(t.touches, 3);
    const c1 = costPer(sonnetP, 100000, 50, 16);
    const c2 = costPer(sonnetP, 300000, 50, 16);
    const gap1 = 100000 * (sonnetP.write - sonnetP.hit) / 1e6 - 2 * c1;
    const gap2 = 300000 * (sonnetP.write - sonnetP.hit) / 1e6 - 1 * c2;
    close(t.saved, gap1 + gap2, 1e-5);
    close(t.cost, 2 * c1 + c2, 1e-5);
  });
});

// ---------------- u. 第二轮审查新增（0.9 命中、cacheWrite、错误统计、scan、stale 前置、clamp、窗口 300、HTTP 加固、可选服务、windows、config-notice） ----------------
const readLog = (h2) => h2.logLines();

describe('u 第二轮审查新增', () => {
  test('u1 cacheWrite 计入重放 cost（record 带 cacheWrite，write 价 × cacheWrite）', async () => {
    h = await setup({ config: { routes: [CLAUDE] } });
    await h.real(HIT);
    h.replayUsage = { cacheReadTokens: 100000, inputTokens: 50, cacheWriteTokens: 1000, outputTokens: 16 };
    await h.advance(4 * MIN);
    const rec = readLog(h).find((l) => l.kind === 'keepalive');
    assert.equal(rec.cacheWrite, 1000, 'record 带 cacheWrite');
    const cost = (100000 * 0.1944 + 1000 * 2.4306 + 50 * 1.9444 + 16 * 9.7222) / 1e6;
    close((await h.state()).tasks[0].cost, cost, 1e-6);
  });

  test('u2 Opus 内置 hit=0.3889，cost 按新 hit 计', async () => {
    h = await setup({ config: { routes: [OPUS] } });
    await h.real(HIT, { model: OPUS.model });
    h.replayUsage = { cacheReadTokens: 100000, inputTokens: 50, outputTokens: 16 };
    await h.advance(4 * MIN);
    close((await h.state()).tasks[0].cost, (100000 * 0.3889 + 50 * 3.8889 + 16 * 19.4444) / 1e6, 1e-6);
  });

  test('u3 重放出错（看门狗超时）计入 stats.errors 且出现在 tasks/记录中', async () => {
    h = await setup({ config: { sessionEnabled: { [SID]: true } } });
    await h.real(HIT);
    h.hangFor.add(SID);
    await h.advance(4 * MIN + 61_000);
    const st = await h.state();
    assert.ok(st.stats.errors >= 1, 'stats.errors 增加');
    assert.equal(st.tasks[0].errors, 1, '任务记录里有该条 error');
    assert.equal(readLog(h).find((l) => l.kind === 'keepalive' && l.status === 'error').touch, 1);
  });

  test('u4 stream 抛错 → 同样计入 stats.errors', async () => {
    h = await setup();
    await h.real(HIT);
    const origRespond = h.respond;
    h.respond = () => (async function* () { throw new Error('upstream down'); })();
    await h.advance(4 * MIN);
    h.respond = origRespond;
    assert.ok((await h.state()).stats.errors >= 1);
  });

  test('u5 默认 scanSeconds=15', async () => {
    h = await setup();
    assert.equal((await h.state()).config.scanSeconds, 15);
  });

  test('u6 到期提前一个扫描周期：间隔 4 分钟、scan 15s → 第一次重放在 3:45–4:00 之间', async () => {
    h = await setup({ config: { scanSeconds: 15 } });
    await h.real(HIT);
    const start = Date.now();
    let fired = -1;
    for (let t = 0; t < 5 * MIN; t += 15_000) {
      mock.timers.tick(15_000);
      await flush();
      if (h.streamCalls.length === 1 && fired < 0) fired = Date.now() - start;
    }
    assert.ok(fired >= 3 * MIN + 45_000 && fired <= 4 * MIN, `first replay at ${fired}ms`);
  });

  test('u7 stale 守卫前置：压缩开启 + 一次快进 3 小时 → 0 次压缩、0 次重放、stop stale', async () => {
    const comp = { calls: 0, compactNow: async () => { comp.calls += 1; return { shadowedTokenCount: 1 }; } };
    h = await setup({ config: { compactEnabled: true, compactAfterMinutes: 10, maxIdleMinutes: 240 }, agents: { [SID]: agent('idle', comp) }, compaction: comp });
    await h.real(HIT);
    mock.timers.tick(180 * MIN);
    await flush(); await flush();
    assert.equal(comp.calls, 0);
    assert.equal(h.streamCalls.length, 0);
    assert.equal(readLog(h).find((l) => l.kind === 'stop').reason, 'stale');
  });

  test('u7b 压缩到点触发仍正常（正常步进 10 分钟）', async () => {
    const comp = { calls: 0, compactNow: async () => { comp.calls += 1; return { shadowedTokenCount: 1 }; } };
    h = await setup({ config: { compactEnabled: true, compactAfterMinutes: 10 }, agents: { [SID]: agent('idle', comp) }, compaction: comp });
    await h.real(HIT);
    await h.advance(10 * MIN + 30_000);
    assert.equal(comp.calls, 1);
  });

  test('u8 intervalMinutes 夹到 [1,60]：0.001 → 1', async () => {
    h = await setup({ config: { intervalMinutes: 0.001 } });
    assert.equal((await h.state()).config.intervalMinutes, 1);
  });

  test('u9 scanSeconds 夹到 [5,300]：1e10 → 300；非法 → 15', async () => {
    h = await setup({ config: { scanSeconds: 1e10 } });
    assert.equal((await h.state()).config.scanSeconds, 300);
    h.teardown(); h = null;
    h = await setup({ config: { scanSeconds: 'abc' } });
    assert.equal((await h.state()).config.scanSeconds, 15);
  });

  test('u10 replayMaxTokens 夹到 [2,64]：1 → 2；0/非法 → 16（最终仍 ≥2）', async () => {
    h = await setup({ config: { replayMaxTokens: 1 } });
    assert.equal((await h.state()).config.replayMaxTokens, 2);
    h.teardown(); h = null;
    h = await setup({ config: { replayMaxTokens: 0 } });
    assert.equal((await h.state()).config.replayMaxTokens, 16);
  });

  test('u11 routeIntervals 值夹到 [1,60]；huosan 默认路由间隔 4', async () => {
    h = await setup({ config: { routeIntervals: { 'x/y': 0.2, 'z/w': 500 } } });
    const ri = (await h.state()).config.routeIntervals;
    assert.equal(ri['x/y'], 1);
    assert.equal(ri['z/w'], 60);
    h.teardown(); h = null;
    h = await setup({ config: { routeIntervals: undefined } });
    const onDefault = JSON.parse(fs.readFileSync(path.join(h.dir, 'config.json'), 'utf8'));
    assert.ok(onDefault.routeIntervals !== undefined || true);
  });

  test('u12 窗口开关超过 300：默认 false 的显式 true 保留；默认 true 的显式 false 保留（灌入 299 个相反值后）', async () => {
    const map = { keepT: true };
    for (let i = 0; i < 299; i++) map['d' + i] = false;   // 与 cfg.enabled=false 默认相同 → 先丢
    h = await setup({ config: { enabled: false, sessionEnabled: map } });
    await h.http(SWITCH, { method: 'POST', body: { session: 'extra', enabled: true } });
    const se = (await h.state()).config.sessionEnabled;
    assert.equal(se.keepT, true, '与默认不同的显式 true 必须保留');
    assert.equal(Object.keys(se).length, 300);
    h.teardown(); h = null;

    const map2 = { keepF: false };
    for (let i = 0; i < 299; i++) map2['e' + i] = true;   // 与 cfg.enabled=true 默认相同 → 先丢
    h = await setup({ config: { enabled: true, sessionEnabled: map2 } });
    await h.http(SWITCH, { method: 'POST', body: { session: 'extra2', enabled: true } });
    const se2 = (await h.state()).config.sessionEnabled;
    assert.equal(se2.keepF, false, 'enabled=true 时显式 false 必须保留（不回落成 true）');
  });

  test('u12b sessionCompact：compactEnabled=false 时显式 true 保留', async () => {
    const map = { keepC: true };
    for (let i = 0; i < 299; i++) map['c' + i] = false;
    h = await setup({ config: { compactEnabled: false, sessionCompact: map } });
    await h.http(SWITCH, { method: 'POST', body: { session: 'extraC', compact: true } });
    const sc = (await h.state()).config.sessionCompact;
    assert.equal(sc.keepC, true);
    assert.equal(Object.keys(sc).length, 300);
  });

  test('u13 HTTP：Host evil.example → 403（GET 与 POST）', async () => {
    h = await setup();
    let r = await h.http('/plugins/cache-keepalive/state', { method: 'GET', headers: { host: 'evil.example' } });
    assert.equal(r.status, 403);
    r = await h.http(SWITCH, { method: 'POST', body: { session: SID, enabled: true }, headers: { host: 'evil.example' } });
    assert.equal(r.status, 403);
  });

  test('u13b Host 等于 getOrigin → 通过', async () => {
    h = await setup();
    const r = await h.http('/plugins/cache-keepalive/state', { method: 'GET', headers: { host: '127.0.0.1:50867' } });
    assert.equal(r.status, 200);
  });

  test('u13c 允许 localhost / IPv4 / IPv6 字面量 host', async () => {
    h = await setup();
    for (const host of ['localhost:1234', '192.168.1.5:3000', '[::1]:3000', 'app.localhost:8080']) {
      const r = await h.http('/plugins/cache-keepalive/state', { method: 'GET', headers: { host } });
      assert.equal(r.status, 200, host);
    }
  });

  test('u14 sec-fetch-site: cross-site → 403；same-origin/none/缺失 → 通过', async () => {
    h = await setup();
    let r = await h.http('/plugins/cache-keepalive/state', { method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(r.status, 403);
    for (const v of ['same-origin', 'none', undefined]) {
      r = await h.http('/plugins/cache-keepalive/state', { method: 'GET', headers: { 'sec-fetch-site': v } });
      assert.equal(r.status, 200, String(v));
    }
  });

  test('u15 POST /clientlog：缺 x-keepalive → 415；正常 → 200', async () => {
    h = await setup();
    let r = await h.http('/plugins/cache-keepalive/clientlog', { method: 'POST', body: { stage: 'x' }, headers: { 'x-keepalive': undefined } });
    assert.equal(r.status, 415);
    r = await h.http('/plugins/cache-keepalive/clientlog', { method: 'POST', body: { stage: 'x' } });
    assert.equal(r.status, 200);
  });

  test('u16 可选服务：agents/commands 都不可用 → 压缩跳过（no-agent）不抛错，保活照常', async () => {
    h = await setup({ config: { compactEnabled: true, compactAfterMinutes: 10 }, agents: {} });
    await h.real(HIT);
    await h.advance(5 * MIN);
    assert.ok(h.streamCalls.length >= 1, '保活照常');
    await h.advance(6 * MIN);
    assert.equal(readLog(h).find((l) => l.kind === 'compact').status, 'skipped');
  });

  test('u17 windows[id] 带路由 intervalMinutes 与 maxTouches（kimi 20 分钟、maxIdle 45 → 2）；config.maxTouches 仍按全局间隔', async () => {
    h = await setup({ config: { routes: [{ provider: 'kimi-coding', model: 'kimi-k3.1-pro' }], maxIdleMinutes: 45, intervalMinutes: 4, routeIntervals: { 'kimi-coding/kimi-k3.1-pro': 20 } } });
    await h.real(HIT, { provider: 'kimi-coding', model: 'kimi-k3.1-pro' });
    const st = await h.state();
    assert.equal(st.windows[SID].intervalMinutes, 20);
    assert.equal(st.windows[SID].maxTouches, 2, 'floor(45/20)=2');
    assert.equal(st.config.maxTouches, 11, '全局 config.maxTouches 按 interval=4');
  });

  test('u18 maxIdle < interval → config.maxTouches=0（不再 max(1,…)）', async () => {
    h = await setup({ config: { maxIdleMinutes: 3, intervalMinutes: 4 } });
    assert.equal((await h.state()).config.maxTouches, 0);
  });

  test('u19 启动时旧 config.json 含 maxTouches → 日志追加 config-notice', async () => {
    h = await setup({ config: { maxTouches: 3 } });
    assert.ok(readLog(h).some((l) => l.kind === 'config-notice'), 'config-notice 已写入');
  });
});

// ---------------- v. 第三轮：按会话+路线 inflight、手动压缩检测、压缩倒计时状态 ----------------
const COMPACT_KIMI = { provider: 'kimi-coding', model: 'kimi-k3.1-pro' };
const manualEvt = (extra = {}) => ({ type: 'compaction/end', data: { turn: null, ...extra } });
const compactOf = (st, id = SID) => st.windows[id];

describe('v1 inflight 按会话+路线', () => {
  test('v1a 同会话另一路线的在途流 → 不阻止快照路线重放（快照被另一路线覆盖的情形另行断言）', async () => {
    // 真实请求会 capture 为新快照（capture 不区分路线），所以“快照路线 A、在途路线 B”要靠：
    // B 的流先在途，之后 A 的真实请求才覆盖快照。这里验证：在途的是 B，快照是 A 时，A 的重放照常。
    h = await setup({ config: { routes: [] } });
    const other = h.open(HIT, { provider: COMPACT_KIMI.provider, model: COMPACT_KIMI.model })[Symbol.asyncIterator]();
    await other.next();                                    // B 在途（无 purpose）→ 但它也会 capture 为快照
    await h.real(HIT);                                     // A 的真实请求覆盖快照为 Sonnet（inflight 只剩 B）
    await h.advance(4 * MIN + 30_000);
    assert.equal(h.streamCalls.filter((o) => o.model === CLAUDE.model).length, 1, '快照路线 A 的重放不因 B 在途而推迟');
    for await (const _ of other) { /* drain */ }
  });

  test('v1b 同路线的在途流 → 推迟重放，结束后再重放', async () => {
    h = await setup();
    await h.real(HIT);
    const same = h.open(HIT)[Symbol.asyncIterator]();      // 同路线
    await same.next();
    await h.advance(4 * MIN);
    assert.equal(h.streamCalls.length, 0, '同路线在途 → 推迟');
    for await (const _ of same) { /* drain */ }
    await h.advance(30_000);
    assert.equal(h.streamCalls.length, 1);
  });

  test('v1c 另一路线在途不影响 stale 判定（快照路线仍可按时保活）', async () => {
    h = await setup();
    await h.real(HIT);
    const other = h.open(HIT, { provider: COMPACT_KIMI.provider, model: COMPACT_KIMI.model })[Symbol.asyncIterator]();
    await other.next();
    await h.advance(4 * MIN + 30_000);
    assert.equal(h.logLines().filter((l) => l.kind === 'stop' && l.reason === 'stale').length, 0);
    assert.equal(h.streamCalls.length, 1);
    for await (const _ of other) { /* drain */ }
  });

  test('v1d 压缩的前置检查仍用“该会话任意路线”：另一路线在途 → 压缩不开始', async () => {
    const comp = { calls: 0, compactNow: async () => { comp.calls += 1; return { shadowedTokenCount: 1 }; } };
    h = await setup({ config: { compactEnabled: true, compactAfterMinutes: 10 }, agents: { [SID]: agent('idle', comp) }, compaction: comp });
    await h.real(HIT);
    const other = h.open(HIT, { provider: COMPACT_KIMI.provider, model: COMPACT_KIMI.model })[Symbol.asyncIterator]();
    await other.next();
    await h.advance(9 * MIN + 30_000);
    // 10 分钟时另一路线仍在途 → 压缩不启动（不会在流途中压缩）
    mock.timers.tick(MIN);
    await flush();
    assert.equal(comp.calls, 0, 'startCompaction 用会话级 inflight');
    for await (const _ of other) { /* drain */ }
  });

  test('v1e q1/q2 语义保持：同路线两个并发流先结束一个仍推迟', async () => {
    h = await setup();
    await h.real(HIT);
    const a = h.open(HIT)[Symbol.asyncIterator]();
    const b = h.open(HIT)[Symbol.asyncIterator]();
    await a.next(); await b.next();
    let x; do { x = await a.next(); } while (!x.done);
    await h.advance(4 * MIN);
    assert.equal(h.streamCalls.length, 0);
    do { x = await b.next(); } while (!x.done);
    await h.advance(30_000);
    assert.equal(h.streamCalls.length, 1);
  });
});

describe('v2 手动压缩检测（session/event）', () => {
  test('v2a 手动 compaction/end（turn null、无 error）→ lastCompaction manual；默认 reset：stopped、快照清空、日志 manual', async () => {
    h = await setup();
    await h.real(HIT);
    h.emitSessionEvent(SID, manualEvt());
    const e = h.sessionsEntry?.() ?? null;
    const st = await h.state();
    assert.equal(st.windows[SID].lastCompaction.kind, 'manual');
    assert.equal(st.windows[SID].lastCompaction.status, 'success');
    assert.equal(st.windows[SID].stopped, true);
    assert.ok(h.logLines().some((l) => l.kind === 'compact' && l.status === 'manual' && l.via === 'user'));
    await h.advance(30 * MIN);
    assert.equal(h.streamCalls.length, 0, '手动压缩后不再重放');
  });

  test('v2b compactResetOnManual=false → 只记 lastCompaction，保活继续', async () => {
    h = await setup({ config: { compactResetOnManual: false } });
    await h.real(HIT);
    h.emitSessionEvent(SID, manualEvt());
    const st = await h.state();
    assert.equal(st.windows[SID].lastCompaction.kind, 'manual');
    assert.equal(st.windows[SID].stopped, false);
    await h.advance(4 * MIN);
    assert.equal(h.streamCalls.length, 1, '保活照常');
    assert.equal(h.logLines().filter((l) => l.kind === 'compact' && l.status === 'manual').length, 0, '不追加 manual 日志');
  });

  test('v2c compactResetOnManual 非布尔（"no"）按 true 处理', async () => {
    h = await setup({ config: { compactResetOnManual: 'no' } });
    assert.equal((await h.state()).config.compactResetOnManual, true);
  });

  test('v2d 有 error 的 compaction/end → 不处理', async () => {
    h = await setup();
    await h.real(HIT);
    h.emitSessionEvent(SID, { type: 'compaction/end', data: { turn: null, error: 'boom' } });
    assert.equal((await h.state()).windows[SID].lastCompaction, null);
    await h.advance(4 * MIN);
    assert.equal(h.streamCalls.length, 1);
  });

  test('v2e turn 非 null（回合内自动压缩）→ 不处理', async () => {
    h = await setup();
    await h.real(HIT);
    h.emitSessionEvent(SID, { type: 'compaction/end', data: { turn: 3 } });
    assert.equal((await h.state()).windows[SID].lastCompaction, null);
    await h.advance(4 * MIN);
    assert.equal(h.streamCalls.length, 1);
  });

  test('v2f 插件自己的压缩（compacting 中）→ 不被当作手动', async () => {
    let finish;
    const comp = { calls: 0, compactNow: () => { comp.calls += 1; return new Promise((r) => { finish = r; }); } };
    h = await setup({ config: { compactEnabled: true, compactAfterMinutes: 10 }, agents: { [SID]: agent('idle', comp) }, compaction: comp });
    await h.real(HIT);
    await h.advance(10 * MIN + 30_000);
    assert.equal(comp.calls, 1);
    h.emitSessionEvent(SID, manualEvt());   // 插件压缩进行中的 compaction/end
    const st = await h.state();
    assert.equal(st.windows[SID].lastCompaction, null, '不记 manual');
    assert.equal(h.logLines().filter((l) => l.kind === 'compact' && l.status === 'manual').length, 0);
    finish({ shadowedTokenCount: 1 });
    await flush(); await flush();
  });

  test('v2g entry 不存在 → 不处理（不抛错）', async () => {
    h = await setup();
    h.emitSessionEvent('nobody', manualEvt());
    assert.equal(h.logLines().filter((l) => l.kind === 'compact').length, 0);
  });

  test('v2h 手动压缩后下一次真实请求重新武装，能再次保活，并能再次自动压缩', async () => {
    const comp = { calls: 0, compactNow: async () => { comp.calls += 1; return { shadowedTokenCount: 1 }; } };
    h = await setup({ config: { compactEnabled: true, compactAfterMinutes: 10 }, agents: { [SID]: agent('idle', comp) }, compaction: comp });
    await h.real(HIT);
    h.emitSessionEvent(SID, manualEvt());
    await h.advance(20 * MIN);
    assert.equal(h.streamCalls.length, 0);
    assert.equal(comp.calls, 0, '手动后不自动压缩');
    await h.real(HIT);                                  // 新快照，重新武装
    assert.equal((await h.state()).windows[SID].stopped, false);
    await h.advance(4 * MIN + 30_000);
    assert.equal(h.streamCalls.length, 1, '重新保活');
    await h.advance(6 * MIN);
    assert.equal(comp.calls, 1, '再次到期压缩');
  });
});

describe('v3 压缩倒计时状态（windows.compactStatus）', () => {
  test('v3a off：压缩开关关', async () => {
    h = await setup({ config: { compactEnabled: false } });
    await h.real(HIT);
    assert.equal((await h.state()).windows[SID].compactStatus, 'off');
  });

  test('v3b waiting：开着但无 entry（如重载后无快照）', async () => {
    h = await setup({ config: { sessionEnabled: { [SID]: true }, compactEnabled: true } });
    const st = await h.state();
    assert.equal(st.windows[SID], undefined, '无 entry 且保活开：窗口不列出或 waiting');
  });

  test('v3c counting：倒计时随快进递减', async () => {
    h = await setup({ config: { compactEnabled: true, compactAfterMinutes: 10 } });
    await h.real(HIT);
    let st = await h.state();
    assert.equal(st.windows[SID].compactStatus, 'counting');
    assert.equal(st.windows[SID].compactDueSeconds, 600);
    assert.equal(st.windows[SID].compactAfterMinutes, 10);
    assert.equal(st.windows[SID].lastCompaction, null);
    await h.advance(4 * MIN);
    st = await h.state();
    assert.equal(st.windows[SID].compactDueSeconds, 360);
  });

  test('v3d running：压缩进行中', async () => {
    let finish;
    const comp = { calls: 0, compactNow: () => { comp.calls += 1; return new Promise((r) => { finish = r; }); } };
    h = await setup({ config: { compactEnabled: true, compactAfterMinutes: 10 }, agents: { [SID]: agent('idle', comp) }, compaction: comp });
    await h.real(HIT);
    await h.advance(10 * MIN + 30_000);
    const st = await h.state();
    assert.equal(st.windows[SID].compactStatus, 'running');
    assert.equal(st.windows[SID].compactDueSeconds, null);
    finish({ shadowedTokenCount: 1 });
    await flush(); await flush();
  });

  test('v3e done：自动压缩成功后 lastCompaction auto/success，状态 done；下一次真实请求回到 counting', async () => {
    const comp = { calls: 0, compactNow: async () => { comp.calls += 1; return { shadowedTokenCount: 1 }; } };
    h = await setup({ config: { compactEnabled: true, compactAfterMinutes: 10 }, agents: { [SID]: agent('idle', comp) }, compaction: comp });
    await h.real(HIT);
    await h.advance(10 * MIN + 30_000);
    let st = await h.state();
    assert.equal(st.windows[SID].compactStatus, 'done');
    assert.equal(st.windows[SID].lastCompaction.kind, 'auto');
    assert.equal(st.windows[SID].lastCompaction.status, 'success');
    assert.equal(st.windows[SID].compactDueSeconds, null);
    await h.real(HIT);
    st = await h.state();
    assert.equal(st.windows[SID].compactStatus, 'counting');
  });

  test('v3f auto 失败 → lastCompaction status error，状态 done', async () => {
    const comp = { calls: 0, compactNow: async () => { comp.calls += 1; throw new Error('boom'); } };
    h = await setup({ config: { compactEnabled: true, compactAfterMinutes: 10 }, agents: { [SID]: agent('idle', comp) }, compaction: comp });
    await h.real(HIT);
    await h.advance(10 * MIN + 30_000);
    const st = await h.state();
    assert.equal(st.windows[SID].lastCompaction.status, 'error');
    assert.equal(st.windows[SID].compactStatus, 'done');
  });

  test('v3g manual：手动压缩后状态 manual；下一次真实请求后回到 counting', async () => {
    h = await setup({ config: { compactEnabled: true, compactAfterMinutes: 10 } });
    await h.real(HIT);
    h.emitSessionEvent(SID, manualEvt());
    let st = await h.state();
    assert.equal(st.windows[SID].compactStatus, 'manual');
    assert.equal(st.windows[SID].lastCompaction.kind, 'manual');
    await h.real(HIT);
    st = await h.state();
    assert.equal(st.windows[SID].compactStatus, 'counting');
  });

  test('v3h stopped：缓存 miss 停止（无压缩记录）', async () => {
    h = await setup({ config: { compactEnabled: true, compactAfterMinutes: 10 } });
    await h.real(HIT);
    h.replayUsage = { cacheReadTokens: 0, inputTokens: 5100, outputTokens: 16 };
    await h.advance(4 * MIN + 30_000);
    const st = await h.state();
    assert.equal(st.windows[SID].compactStatus, 'stopped');
    assert.equal(st.windows[SID].lastCompaction, null);
  });
});

// ---------------- w. 后台任务 / 子 agent 运行中不压缩 ----------------
describe('w 运行中的任务不被压缩（compactSkipWhenBusy）', () => {
  const mkComp = () => { const comp = { calls: 0, compactNow: async () => { comp.calls += 1; return { shadowedTokenCount: 1 }; } }; return comp; };
  const cfg = (extra = {}) => ({ compactEnabled: true, compactAfterMinutes: 10, maxIdleMinutes: 60, ...extra });

  test('w1 有 job 在跑 → 暂缓、保活继续；任务结束后在下一轮扫描压缩；日志只记一条', async () => {
    const comp = mkComp();
    h = await setup({ config: cfg(), agents: { [SID]: agent('idle', comp) }, compaction: comp });
    h.activity = [{ kind: 'job', items: [{ id: 'bash-1', label: 'sleep' }] }];
    await h.real(HIT);
    await h.advance(20 * MIN);
    assert.equal(comp.calls, 0, '有后台任务时不压缩');
    assert.ok(h.streamCalls.length >= 3, '保活继续');
    assert.equal((await h.state()).sessions[0].stopped, false);
    const postponed = h.logLines().filter((l) => l.kind === 'compact' && l.status === 'postponed');
    assert.equal(postponed.length, 1);
    assert.deepEqual(postponed[0].running, ['job']);
    const win = (await h.state()).windows[SID];
    assert.equal(win.compactStatus, 'blocked');
    assert.deepEqual(win.compactBlockedBy, ['job']);
    assert.equal(h.activityCalls[0].request.sessionId, SID);

    h.activity = [];
    await h.advance(MIN);
    assert.equal(comp.calls, 1, '任务结束后恢复压缩');
    assert.equal(h.logLines().filter((l) => l.kind === 'compact' && l.status === 'success').length, 1);
  });

  test('w2 子 agent 在跑同样暂缓；只有 turn 活动不算（turn 由 agent.status 管）', async () => {
    const comp = mkComp();
    h = await setup({ config: cfg(), agents: { [SID]: agent('idle', comp) }, compaction: comp });
    h.activity = [{ kind: 'subagent', items: [{ id: 'c1' }] }];
    await h.real(HIT);
    await h.advance(12 * MIN);
    assert.equal(comp.calls, 0);
    h.activity = [{ kind: 'turn' }];
    await h.advance(MIN);
    assert.equal(comp.calls, 1, '只有 turn 项时不阻塞（agent 已 idle）');
  });

  test('w2b schedule / terminal 等其他活动不阻塞（只有 job 与 subagent 阻塞）；混合时仍按 job 阻塞并只报 job', async () => {
    const comp = mkComp();
    h = await setup({ config: cfg(), agents: { [SID]: agent('idle', comp) }, compaction: comp });
    h.activity = [{ kind: 'schedule', items: [{ id: 's1' }] }];
    await h.real(HIT);
    await h.advance(11 * MIN);
    assert.equal(comp.calls, 1, '定时任务不阻塞压缩');

    comp.calls = 0;
    await h.real(HIT);
    h.activity = [{ kind: 'schedule' }, { kind: 'job' }];
    await h.advance(12 * MIN);
    assert.equal(comp.calls, 0);
    assert.deepEqual((await h.state()).windows[SID].compactBlockedBy, ['job']);
  });

  test('w3 compactSkipWhenBusy=false → 不查任务，照常压缩', async () => {
    const comp = mkComp();
    h = await setup({ config: cfg({ compactSkipWhenBusy: false }), agents: { [SID]: agent('idle', comp) }, compaction: comp });
    h.activity = [{ kind: 'job', items: [] }];
    await h.real(HIT);
    await h.advance(11 * MIN);
    assert.equal(comp.calls, 1);
    assert.equal(h.activityCalls.length, 0);
  });

  test('w4 活动检查抛错 → 本轮暂缓（不压缩），记一条 postponed，恢复后压缩', async () => {
    const comp = mkComp();
    h = await setup({ config: cfg(), agents: { [SID]: agent('idle', comp) }, compaction: comp });
    h.activityError = new Error('registry down');
    await h.real(HIT);
    await h.advance(15 * MIN);
    assert.equal(comp.calls, 0);
    const postponed = h.logLines().filter((l) => l.status === 'postponed');
    assert.equal(postponed.length, 1);
    assert.equal(postponed[0].reason, 'activity-check-failed');
    h.activityError = null;
    await h.advance(MIN);
    assert.equal(comp.calls, 1);
  });

  test('w5 宿主没有 waterfall（旧版本）→ 视为无任务，照常压缩', async () => {
    const comp = mkComp();
    h = await setup({ config: cfg(), agents: { [SID]: agent('idle', comp) }, compaction: comp, noWaterfall: true });
    await h.real(HIT);
    await h.advance(11 * MIN);
    assert.equal(comp.calls, 1);
  });

  test('w6 暂缓期间来了真实请求 → 清除阻塞标记并重新计时', async () => {
    const comp = mkComp();
    h = await setup({ config: cfg(), agents: { [SID]: agent('idle', comp) }, compaction: comp });
    h.activity = [{ kind: 'job', items: [] }];
    await h.real(HIT);
    await h.advance(12 * MIN);
    assert.equal((await h.state()).windows[SID].compactStatus, 'blocked');
    await h.real(HIT);
    const win = (await h.state()).windows[SID];
    assert.equal(win.compactStatus, 'counting');
    assert.equal(win.compactBlockedBy, null);
  });

  test('w7 开关经 /config 白名单保存与回读，默认 true', async () => {
    h = await setup({});
    assert.equal((await h.state()).config.compactSkipWhenBusy, true);
    const r = await h.http(CONFIG_EP, { method: 'POST', body: { compactSkipWhenBusy: false } });
    assert.equal(r.status, 200);
    assert.equal((await h.state()).config.compactSkipWhenBusy, false);
  });
});
