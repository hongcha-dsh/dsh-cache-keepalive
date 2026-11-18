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

async function* iter(chunks) {
  for (const c of chunks) yield c;
}
const flush = () => new Promise((r) => setImmediate(r));
const close = (actual, expected, eps = 1e-6) => assert.ok(Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`);
const agent = (status, compaction) => ({ status, ctx: { get: (name) => (name === 'compaction' ? compaction : undefined) } });

let h = null;

async function setup({ config = {}, agents = {}, compaction } = {}) {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: T0 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ka-test-'));
  const modPath = path.join(dir, 'index.mjs');
  fs.copyFileSync(SRC, modPath);
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ enabled: false, sessionEnabled: { [SID]: true }, routes: [CLAUDE], routeIntervals: {}, ...config }, null, 2)
  );
  const hooks = [];
  const routes = {};
  const cleanups = [];
  const h = {
    dir,
    logPath: path.join(dir, 'keepalive.jsonl'),
    replayUsage: { ...HIT },
    streamCalls: [],
    commandCalls: [],
    commandResult: undefined,
    sessions: {},
    agents,
    routes,
    respond: () => iter([{ type: 'usage', usage: { ...h.replayUsage } }, { type: 'finish', reason: { kind: 'stop' } }]),
    req: (o = {}) => ({ sessionId: SID, provider: CLAUDE.provider, model: CLAUDE.model, messages: MSG, tools: TOOLS, toolHistory: [], maxTokens: 4096, signal: new AbortController().signal, ...o }),
    /** Non-replay stream through the llm/stream hook chain (used for compaction-purpose requests). */
    llmStream: (options) => hooks[0](options, () => h.respond(options)),
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
    http: async (key, { method = 'GET', body, url } = {}) => {
      const handler = routes[key];
      assert.ok(handler, 'route not registered: ' + key);
      const req = {
        method,
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
    register: (desc) => {
      routes[desc.path] = desc.handler;
      return () => {};
    }
  };
  const ctx = {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    on(event, fn) {
      if (event === 'llm/stream') hooks.push(fn);
    },
    get(name) {
      if (name === 'sessions') return { get: (id) => h.sessions[id] ?? { header: {} } };
      throw new Error('service not available: ' + name);
    },
    llm: { stream: (options) => h.llmStream(options) },
    agents: { get: (id) => h.agents[id] },
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
    assert.equal(rep.signal, undefined, 'signal 不应随重放转发');
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
    h = await setup({ config: { compactAfterMinutes: 10 }, agents: { [SID]: agent('idle', comp) }, compaction: comp });
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
    h = await setup({ config: { compactAfterMinutes: 10 }, agents: { [SID]: agent('idle', comp) }, compaction: comp });
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
    h = await setup({ config: { compactAfterMinutes: 10 }, agents: { [SID]: agent('idle', comp) }, compaction: comp });
    await h.real(HIT);
    await h.advance(10 * MIN + 30_000);
    assert.equal(comp.calls, 1);
    assert.equal(h.logLines().find((l) => l.kind === 'compact').status, 'noop');
    await h.advance(60 * MIN);
    assert.equal(comp.calls, 1);
  });

  test('e4 agent 运行中 → 不触发、不停止；转为 idle 后再触发', async () => {
    const comp = { calls: 0, compactNow: async () => { comp.calls += 1; return { shadowedTokenCount: 1 }; } };
    h = await setup({ config: { compactAfterMinutes: 10 }, agents: { [SID]: agent('running', comp) }, compaction: comp });
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
    h = await setup({ config: { compactAfterMinutes: 10 }, agents: { [SID]: agent('idle', undefined) } });
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
    h = await setup({ config: { compactAfterMinutes: 10 }, agents: { [SID]: agent('idle', undefined) } });
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
    h = await setup({ config: { compactAfterMinutes: 10 }, agents: { [SID]: agent('idle', comp) }, compaction: comp });
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
    h = await setup({ config: { compactAfterMinutes: 10 }, agents: { [SID]: agent('idle', comp) }, compaction: comp });
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

  test('e8 compactAfterMinutes=0：永不压缩，maxTouches 仍生效', async () => {
    const comp = { calls: 0, compactNow: async () => { comp.calls += 1; return { shadowedTokenCount: 1 }; } };
    h = await setup({ config: { compactAfterMinutes: 0, maxTouches: 2 }, agents: { [SID]: agent('idle', comp) }, compaction: comp });
    await h.real(HIT);
    await h.advance(60 * MIN);
    assert.equal(comp.calls, 0);
    assert.equal(h.streamCalls.length, 2);
    assert.ok(h.logLines().some((l) => l.kind === 'stop' && l.reason === 'max-touches'));
  });

  test('e9 压缩开启时不应用 maxTouches 上限', async () => {
    const comp = { calls: 0, compactNow: async () => { comp.calls += 1; return { shadowedTokenCount: 1 }; } };
    h = await setup({ config: { compactAfterMinutes: 10, maxTouches: 1 }, agents: { [SID]: agent('idle', comp) }, compaction: comp });
    await h.real(HIT);
    await h.advance(9 * MIN + 30_000);
    assert.equal(h.streamCalls.length, 2, '超过 maxTouches=1 仍继续保活');
    assert.ok(!h.logLines().some((l) => l.kind === 'stop' && l.reason === 'max-touches'));
    await h.advance(MIN);
    assert.equal(comp.calls, 1);
  });

  test('e10 缓存已判 miss（stopped）的会话不压缩', async () => {
    const comp = { calls: 0, compactNow: async () => { comp.calls += 1; return { shadowedTokenCount: 1 }; } };
    h = await setup({ config: { compactAfterMinutes: 10 }, agents: { [SID]: agent('idle', comp) }, compaction: comp });
    h.replayUsage = { cacheReadTokens: 0, inputTokens: 5100, outputTokens: 16 };
    await h.real(HIT);
    await h.advance(15 * MIN);
    assert.equal(h.streamCalls.length, 1);
    assert.equal(comp.calls, 0);
    assert.equal(h.logLines().filter((l) => l.kind === 'compact').length, 0);
  });

  test('e11 有在途真实流时不压缩；流结束后下一次 tick 再压缩', async () => {
    const comp = { calls: 0, compactNow: async () => { comp.calls += 1; return { shadowedTokenCount: 1 }; } };
    h = await setup({ config: { compactAfterMinutes: 10 }, agents: { [SID]: agent('idle', comp) }, compaction: comp });
    const it = h.open(HIT);
    await it.next(); // 已开始迭代但未结束 → 在途
    await h.advance(10 * MIN + 30_000);
    assert.equal(comp.calls, 0, '在途流期间不压缩');
    assert.equal(h.streamCalls.length, 0, '在途流期间也不重放');
    for await (const _ of it) { /* finish the real stream */ }
    await h.advance(MIN);
    assert.equal(comp.calls, 1);
  });

  test('e12 （观察）agent 不存在时：记录 skipped 并停止该会话', async () => {
    const comp = { calls: 0, compactNow: async () => { comp.calls += 1; return { shadowedTokenCount: 1 }; } };
    h = await setup({ config: { compactAfterMinutes: 10 }, agents: {}, compaction: comp });
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
  const opus = { hit: 0.1944, input: 3.8889, output: 19.4444, write: 4.8611 };
  const usage = { cacheReadTokens: 100000, inputTokens: 50, outputTokens: 16 };
  const costOf = (p) => (100000 * p.hit + 50 * p.input + 16 * p.output) / 1e6;
  const savedOf = (p, k = 1) => (100000 * ((p.input + p.write) - p.hit * k)) / 1e6;

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
    close(savedOf(sonnet), 0.41806, 1e-9);
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
    close(costOf(opus), 0.0199455554, 1e-9);
  });

  test('f4 config.prices 覆盖生效', async () => {
    h = await setup({ config: { prices: { [`${CLAUDE.provider}/${CLAUDE.model}`]: { hit: 1, input: 2, output: 3, write: 4 } } } });
    await h.real(HIT);
    h.replayUsage = { ...usage };
    await h.advance(4 * MIN);
    const t = (await h.state()).tasks[0];
    close(t.cost, 0.100148);
    close(t.saved, 0.5);
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
    h = await setup({ config: { compactAfterMinutes: 3 }, agents: { [SID]: agent('idle', c) }, compaction: c });
    await h.real(HIT);
    await h.advance(4.5 * MIN);
    assert.equal(c.calls, 0);
    await h.advance(MIN);
    assert.equal(c.calls, 1);
  });

  test('g2 compactAfterMinutes=500 → 夹到 120（119 分钟不压缩，121 分钟压缩）', async () => {
    const c = comp();
    h = await setup({ config: { compactAfterMinutes: 500 }, agents: { [SID]: agent('idle', c) }, compaction: c });
    await h.real(HIT);
    await h.advance(119 * MIN);
    assert.equal(c.calls, 0);
    await h.advance(2 * MIN);
    assert.equal(c.calls, 1);
  });

  for (const bad of [-5, 0, 'abc', null]) {
    test(`g3 compactAfterMinutes=${JSON.stringify(bad)} → 关闭，maxTouches 生效`, async () => {
      const c = comp();
      h = await setup({ config: { compactAfterMinutes: bad, maxTouches: 2 }, agents: { [SID]: agent('idle', c) }, compaction: c });
      await h.real(HIT);
      await h.advance(60 * MIN);
      assert.equal(c.calls, 0);
      assert.equal(h.streamCalls.length, 2);
      h.teardown();
      h = null;
    });
  }

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

  test('g7 maxTouches=0 → 回落到 15（3 次重放后仍继续）', async () => {
    h = await setup({ config: { maxTouches: 0 } });
    await h.real(HIT);
    await h.advance(12 * MIN);
    assert.equal(h.streamCalls.length, 3);
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
    h = await setup({ config: { compactAfterMinutes: 10 }, agents: { [SID]: agent('idle', comp) }, compaction: comp });
    await h.real(HIT);
    const it = h.open(HIT);
    await it.return();
    await h.advance(11 * MIN);
    assert.equal(comp.calls, 1, 'inflight 不应因未迭代的流而永久阻塞压缩');
  });
});
