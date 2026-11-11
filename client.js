// dsh-cache-keepalive — Client module: the settings-page status card.
// Registers into `plugins.row.config` keyed by "<bundle>#<rowId>", which is what
// makes the Plugin Manager show a "Configure" page for this plugin row.
// Every step reports to the Host's /plugins/cache-keepalive/clientlog so a load
// or registration failure is visible without browser devtools.
window.__ModuleLoader__.load({
  id: 'dsh-cache-keepalive',
  factory(require) {
    const report = (stage, detail) => {
      try {
        fetch('/plugins/cache-keepalive/clientlog', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ stage, detail: detail === undefined ? '' : String(detail) }),
          keepalive: true
        }).catch(() => {});
      } catch {
        /* diagnostics must never break the plugin */
      }
    };
    try {
      report('factory');

      const React = require('react');
      const h = React.createElement;
      const API = '/plugins/cache-keepalive';

      const label = { fontSize: 12, opacity: 0.65 };
      const row = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' };
      const box = { display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 0 8px' };
      const card = { border: '1px solid rgba(127,127,127,0.28)', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 };
      const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 };
      const input = { width: 76, padding: '2px 6px', color: 'inherit', background: 'transparent', border: '1px solid rgba(127,127,127,0.35)', borderRadius: 6, font: 'inherit' };
      const button = { padding: '3px 12px', color: 'inherit', background: 'transparent', border: '1px solid rgba(127,127,127,0.45)', borderRadius: 6, cursor: 'pointer', font: 'inherit' };
      const th = { textAlign: 'left', fontWeight: 500, opacity: 0.65, padding: '2px 8px 2px 0', fontSize: 12 };
      const td = { padding: '2px 8px 2px 0', fontSize: 12 };

      function useStatus() {
        const [state, setState] = React.useState(null);
        const [error, setError] = React.useState(null);
        const load = React.useCallback(async () => {
          try {
            const res = await fetch(API + '/state', { cache: 'no-store' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const json = await res.json();
            setState(json);
            setError(null);
            return json;
          } catch (e) {
            setError(String((e && e.message) || e));
            return null;
          }
        }, []);
        React.useEffect(() => {
          load();
          const timer = setInterval(load, 4000);
          return () => clearInterval(timer);
        }, [load]);
        return { state, error, refresh: load };
      }

      function money(value) {
        if (value === null || value === undefined) return '—';
        return '¥' + Number(value).toFixed(3);
      }
      function tokens(value) {
        if (value === null || value === undefined) return '—';
        return Number(value).toLocaleString('en-US');
      }
      function clock(ts) {
        try {
          return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
        } catch {
          return String(ts);
        }
      }

      function StatusCard({ view }) {
        const { state, error, refresh } = useStatus();
        const [draft, setDraft] = React.useState(null);
        const [busy, setBusy] = React.useState(false);
        const [message, setMessage] = React.useState(null);
        const [pendingEnabled, setPendingEnabled] = React.useState(null);

        React.useEffect(() => {
          if (state !== null && draft === null) setDraft({ ...state.config });
        }, [state, draft]);
        React.useEffect(() => {
          if (pendingEnabled !== null && state !== null && state.enabled === pendingEnabled) setPendingEnabled(null);
        }, [state, pendingEnabled]);

        if (view !== 'page') return null;

        const post = async (patch) => {
          setBusy(true);
          try {
            const res = await fetch(API + '/config', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(patch)
            });
            const json = await res.json();
            if (!res.ok) throw new Error(json && json.error ? json.error : 'HTTP ' + res.status);
            setDraft({ ...json.config });
            setMessage('已保存');
            void refresh();
            return true;
          } catch (e) {
            setMessage('保存失败：' + String((e && e.message) || e));
            return false;
          } finally {
            setBusy(false);
          }
        };

        const stats = (state && state.stats) || {};
        const enabled = pendingEnabled === null ? (state ? state.enabled : false) : pendingEnabled;
        const config = draft || (state && state.config) || {};
        const edit = (key, value) => setDraft({ ...config, [key]: value });

        return h('div', { style: box, 'data-plugin': 'cache-keepalive' },
          h('div', { style: row },
            h('strong', null, '提示词缓存保活'),
            h('span', { style: { ...label, opacity: enabled ? 0.65 : 0.45 } }, enabled ? '● 运行中' : '○ 已暂停'),
            error ? h('span', { style: { ...label, color: '#c4553b' } }, '状态接口不可用：' + error) : null
          ),
          h('div', { style: grid },
            h(Metric, { title: '保活次数', value: tokens(stats.touches) }),
            h(Metric, { title: '命中', value: tokens(stats.hits) }),
            h(Metric, { title: '命中率', value: stats.hitRate === null || stats.hitRate === undefined ? '—' : Math.round(stats.hitRate * 100) + '%' }),
            h(Metric, { title: '累计缓存读取', value: tokens(stats.cacheRead) }),
            h(Metric, { title: '估算花费', value: money(stats.costEstimate) }),
            h(Metric, { title: '估算省下', value: money(stats.avoidedEstimate) })
          ),

          h('div', { style: card },
            h('div', { style: row },
              h('span', { style: label }, '启用'),
              h('button', { style: { ...button, fontWeight: 600, borderColor: 'currentColor' }, disabled: busy || state === null, onClick: () => post({ enabled: !enabled }) }, enabled ? '暂停保活' : '启动保活'),
              h('span', { style: label }, '线路：'),
              h('code', { style: { fontSize: 12 } }, config.routes && config.routes.length > 0 ? config.routes.map((r) => r.provider + ' / ' + r.model).join('，') : '跟随当前会话模型')
            ),
            h('div', { style: row },
              h('span', { style: label }, '间隔'),
              h('input', { style: input, type: 'number', min: 1, value: config.intervalMinutes ?? '', onChange: (e) => edit('intervalMinutes', Number(e.target.value)) }),
              h('span', { style: label }, '分钟'),
              h('span', { style: label }, '空闲上限'),
              h('input', { style: input, type: 'number', min: 1, value: config.maxIdleMinutes ?? '', onChange: (e) => edit('maxIdleMinutes', Number(e.target.value)) }),
              h('span', { style: label }, '分钟'),
              h('span', { style: label }, '最多'),
              h('input', { style: input, type: 'number', min: 1, value: config.maxTouches ?? '', onChange: (e) => edit('maxTouches', Number(e.target.value)) }),
              h('span', { style: label }, '次'),
              h('span', { style: label }, '重放输出上限'),
              h('input', { style: input, type: 'number', min: 1, value: config.replayMaxTokens ?? '', onChange: (e) => edit('replayMaxTokens', Number(e.target.value)) }),
              h('span', { style: label }, '个 token'),
              h('button', {
                style: button,
                disabled: busy || draft === null,
                onClick: () => post({
                  intervalMinutes: Number(config.intervalMinutes),
                  maxIdleMinutes: Number(config.maxIdleMinutes),
                  maxTouches: Number(config.maxTouches),
                  replayMaxTokens: Number(config.replayMaxTokens)
                })
              }, '保存')
            ),
            h('p', { style: { ...label, margin: 0 } },
              '成本按 kimi-coding 列表价估算；每次空闲最多 8 次保活。'),
            message ? h('p', { style: { ...label, margin: 0 } }, message) : null
          ),

          h('div', { style: card },
            h('div', { style: row }, h('span', { style: label }, '当前跟踪的会话'), state && state.sessions && state.sessions.length > 0
              ? h('span', { style: { fontSize: 12 } }, state.sessions.map((s) => s.session + ' · ' + (s.provider || '?') + '/' + (s.model || '?') + ' · 空闲 ' + s.idleMinutes + ' 分钟 · 已保活 ' + s.touches + ' 次' + (s.armed ? '' : ' · 待首次命中') + (s.stopped ? ' · 已停' : '')).join('；'))
              : h('span', { style: { fontSize: 12, opacity: 0.55 } }, '暂无（等下一次真实请求）'))
          ),

          h('div', { style: card },
            h('span', { style: label }, '最近保活'),
            (state && state.recent && state.recent.length > 0)
              ? h('table', { style: { borderCollapse: 'collapse' } },
                h('thead', null, h('tr', null,
                  h('th', { style: th }, '时间'), h('th', { style: th }, '结果'), h('th', { style: th }, '缓存读取'),
                  h('th', { style: th }, '未命中'), h('th', { style: th }, '输出'), h('th', { style: th }, '花费'), h('th', { style: th }, '省下'))),
                h('tbody', null, state.recent.map((r, index) => h('tr', { key: index },
                  h('td', { style: td }, clock(r.ts)),
                  h('td', { style: td }, r.status === 'hit' ? '命中' : r.status === 'miss' ? '未命中' : r.status === 'error' ? '错误' : '未知'),
                  h('td', { style: td }, tokens(r.cacheRead)),
                  h('td', { style: td }, tokens(r.input)),
                  h('td', { style: td }, tokens(r.output)),
                  h('td', { style: td }, money(r.cost)),
                  h('td', { style: td }, money(r.avoided))
                )))
              )
              : h('span', { style: { ...label, margin: 0 } }, '还没有保活记录。')
          )
        );
      }

      function Metric({ title, value }) {
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
          h('span', { style: label }, title),
          h('strong', { style: { fontSize: 16 } }, value === null || value === undefined ? '—' : String(value))
        );
      }

      // One compact start/pause pill beside the message composer, so the
      // keep-alive can be started or paused without leaving the conversation.
      function ComposerButton() {
        const { state } = useStatus();
        const [busy, setBusy] = React.useState(false);
        const enabled = state ? state.enabled : null;
        const toggle = async () => {
          if (enabled === null) return;
          setBusy(true);
          try {
            const res = await fetch(API + '/config', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ enabled: !enabled })
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
          } catch {
            /* the configuration card shows the error text */
          } finally {
            setBusy(false);
          }
        };
        const dot = enabled === null ? 'rgba(127,127,127,0.55)' : enabled ? '#3fbf6f' : 'rgba(127,127,127,0.55)';
        return h('button', {
          type: 'button',
          'data-plugin': 'cache-keepalive-toggle',
          title: enabled === null
            ? '提示词缓存保活：状态读取中'
            : enabled
              ? '提示词缓存保活：运行中（每 ' + ((state && state.config && state.config.intervalMinutes) || 20) + ' 分钟续一次缓存），点击暂停'
              : '提示词缓存保活：已暂停，点击启动',
          'aria-label': '提示词缓存保活开关',
          disabled: busy || enabled === null,
          onClick: toggle,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '3px 10px',
            margin: '0 4px',
            color: 'inherit',
            background: 'transparent',
            border: '1px solid rgba(127,127,127,0.35)',
            borderRadius: 999,
            cursor: busy ? 'default' : 'pointer',
            font: 'inherit',
            fontSize: 12,
            lineHeight: 1.4,
            opacity: busy ? 0.6 : 1
          }
        },
          h('span', { style: { width: 7, height: 7, borderRadius: '50%', background: dot, display: 'inline-block' } }),
          h('span', null, '缓存保活'),
          h('span', { style: { opacity: 0.65 } }, enabled === null ? '读取中' : enabled ? '开' : '关')
        );
      }

      return {
        inject: ['slots'],
        apply(ctx) {
          try {
            ctx.slots.inject('plugins.row.config', () => {
              try {
                report('slot-inject-callback');
                return ctx.slots.register(
                  {
                    name: 'plugins.row.config',
                    id: 'cache-keepalive-config',
                    key: 'dsh-cache-keepalive#cache-keepalive',
                    order: 10
                  },
                  StatusCard
                );
              } catch (error) {
                report('slot-register-error', (error && error.message) || error);
                return undefined;
              }
            });
            ctx.slots.inject('conversation.composer.dock', () => {
              try {
                report('composer-slot-inject');
                return ctx.slots.register(
                  { name: 'conversation.composer.dock', id: 'cache-keepalive-toggle', order: 30 },
                  ComposerButton
                );
              } catch (error) {
                report('composer-register-error', (error && error.message) || error);
                return undefined;
              }
            });
            report('applied');
          } catch (error) {
            report('apply-error', (error && error.message) || error);
          }
        }
      };
    } catch (error) {
      report('factory-error', (error && error.stack) || error);
      throw error;
    }
  }
});
