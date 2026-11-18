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
        const amount = Number(value);
        if (!Number.isFinite(amount)) return '—';
        const absolute = Math.abs(amount);
        const digits = absolute > 0 && absolute < 0.01 ? 4 : 3;
        return (amount < 0 ? '-¥' : '¥') + absolute.toFixed(digits);
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
      function clockDate(ts) {
        if (!ts) return '—';
        try {
          return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
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
        const openWindows = state && state.sessions ? state.sessions.filter((s) => s.enabled).length : 0;

        return h('div', { style: box, 'data-plugin': 'cache-keepalive' },
          h('div', { style: row },
            h('strong', null, '提示词缓存保活'),
            h('span', { style: { ...label, opacity: 0.65 } },
              (enabled ? '新会话默认开' : '新会话默认关') + (openWindows > 0 ? ' · ' + openWindows + ' 个窗口已单独开启' : '')),
            error ? h('span', { style: { ...label, color: '#c4553b' } }, '状态接口不可用：' + error) : null
          ),
          h('div', { style: grid },
            h(Metric, { title: '保活次数', value: tokens(stats.touches) }),
            h(Metric, { title: '命中', value: tokens(stats.hits) }),
            h(Metric, { title: '命中率', value: stats.hitRate === null || stats.hitRate === undefined ? '—' : Math.round(stats.hitRate * 100) + '%' }),
            h(Metric, { title: '累计缓存读取', value: tokens(stats.cacheRead) }),
            h(Metric, { title: '估算花费', value: money(stats.costEstimate) }),
            h(Metric, { title: '估算净省', value: money(stats.savedEstimate) })
          ),

          h('div', { style: card },
            h('div', { style: row },
              h('span', { style: label }, '新会话默认'),
              h('button', { style: { ...button, fontWeight: 600, borderColor: 'currentColor' }, disabled: busy || state === null, onClick: () => post({ enabled: !enabled }) }, enabled ? '默认开' : '默认关'),
              h('span', { style: { ...label, opacity: 0.55 } }, '每个窗口用回复框的「缓存保活」按钮单独开关，互不影响'),
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
              '成本按所配价格表估算（config.prices）；每次空闲有保活次数上限。'),
            message ? h('p', { style: { ...label, margin: 0 } }, message) : null
          ),

          h('div', { style: card },
            h('div', { style: row }, h('span', { style: label }, '当前跟踪的会话'), state && state.sessions && state.sessions.length > 0
              ? h('span', { style: { fontSize: 12 } }, state.sessions.map((s) => (s.title ? s.title + ' · ' : '') + '[' + (s.enabled ? '开' : '关') + '] ' + s.session + ' · ' + (s.provider || '?') + '/' + (s.model || '?') + ' · 空闲 ' + s.idleMinutes + ' 分钟 · 已保活 ' + s.touches + ' 次' + (s.armed ? '' : ' · 待首次命中') + (s.stopped ? ' · 已停' : '')).join('；'))
              : h('span', { style: { fontSize: 12, opacity: 0.55 } }, '暂无（等下一次真实请求）'))
          ),

          h('div', { style: card },
            h('div', { style: row },
              h('span', { style: label }, '保活记录'),
              h('span', { style: { ...label, opacity: 0.45 } }, state && state.tasks && state.tasks.length > 0 ? '按任务记录 · 点一条看明细' : '')
            ),
            h(TaskRecords, { tasks: (state && state.tasks) || [], onChanged: refresh })
          )
        );
      }

      // One record per task (= one conversation). The row carries the task title,
      // the keepalive count and the net saving; clicking it loads the per-touch
      // detail from the Host, and 删除 drops that task's record.
      function TaskRecords({ tasks, onChanged }) {
        const [openId, setOpenId] = React.useState(null);
        const [detail, setDetail] = React.useState(null);
        const [error, setError] = React.useState(null);
        const [confirmId, setConfirmId] = React.useState(null);
        const [busy, setBusy] = React.useState(false);

        const loadDetail = React.useCallback(async (id) => {
          setDetail(null);
          setError(null);
          try {
            const res = await fetch(API + '/task?session=' + encodeURIComponent(id), { cache: 'no-store' });
            const json = await res.json();
            if (!res.ok) throw new Error((json && json.error) || 'HTTP ' + res.status);
            setDetail(json);
          } catch (e) {
            setError(String((e && e.message) || e));
          }
        }, []);

        const toggle = (id) => {
          setConfirmId(null);
          if (openId === id) {
            setOpenId(null);
            setDetail(null);
            return;
          }
          setOpenId(id);
          void loadDetail(id);
        };

        const remove = async (id) => {
          setBusy(true);
          setError(null);
          try {
            const res = await fetch(API + '/task/delete', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ session: id })
            });
            const json = await res.json();
            if (!res.ok || !json.ok) throw new Error((json && json.error) || 'HTTP ' + res.status);
            if (openId === id) {
              setOpenId(null);
              setDetail(null);
            }
            setConfirmId(null);
            if (onChanged) await onChanged();
          } catch (e) {
            setError('删除失败：' + String((e && e.message) || e));
          } finally {
            setBusy(false);
          }
        };

        if (tasks.length === 0) {
          return h('span', { style: { ...label, margin: 0 } }, '还没有保活记录。开启后每个任务单独记一条，点进去看每次保活的明细。');
        }

        return h('div', { style: { display: 'flex', flexDirection: 'column' } },
          tasks.map((task) => {
            const open = openId === task.id;
            return h('div', { key: task.id, style: { borderTop: '1px solid rgba(127,127,127,0.18)', paddingTop: 2 } },
              h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                h('button', {
                  type: 'button',
                  title: open ? '收起明细' : '展开每次保活的明细',
                  onClick: () => toggle(task.id),
                  style: { flex: 1, display: 'flex', gap: 8, alignItems: 'center', padding: '5px 2px', color: 'inherit', background: 'transparent', border: 'none', cursor: 'pointer', font: 'inherit', textAlign: 'left', minWidth: 0 }
                },
                  h('span', { style: { opacity: 0.5, fontSize: 11, width: 10, flex: '0 0 auto' } }, open ? '▾' : '▸'),
                  h('span', { style: { fontWeight: 600, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, task.title),
                  h('span', { style: { ...label, whiteSpace: 'nowrap', opacity: 0.55 } }, task.enabled === false ? '窗口关' : '窗口开'),
                  h('span', { style: { ...label, whiteSpace: 'nowrap' } }, tokens(task.touches) + ' 次'),
                  h('span', { style: { ...label, whiteSpace: 'nowrap', opacity: task.saved > 0 ? 0.75 : 0.5 } }, '省 ' + money(task.saved)),
                  h('span', { style: { ...label, whiteSpace: 'nowrap', opacity: 0.45 } }, clockDate(task.lastAt))
                ),
                h('button', {
                  type: 'button',
                  disabled: busy,
                  title: '删除这条记录（只删记录，不影响保活开关）',
                  onClick: () => (confirmId === task.id ? void remove(task.id) : setConfirmId(task.id)),
                  onMouseLeave: () => {
                    if (confirmId === task.id) setConfirmId(null);
                  },
                  style: { ...button, padding: '1px 8px', fontSize: 12, whiteSpace: 'nowrap', borderColor: confirmId === task.id ? '#c4553b' : 'rgba(127,127,127,0.35)', color: confirmId === task.id ? '#c4553b' : 'inherit' }
                }, confirmId === task.id ? '确认删除' : '删除')
              ),
              open
                ? (detail && detail.task && detail.task.id === task.id
                  ? h(TaskDetail, { detail })
                  : h('div', { style: { ...label, padding: '2px 0 8px 20px' } }, error || '加载中…'))
                : null
            );
          })
        );
      }

      function TaskDetail({ detail }) {
        const task = detail.task;
        const records = (detail.records || []).slice().reverse();
        return h('div', { style: { padding: '0 0 10px 20px', display: 'flex', flexDirection: 'column', gap: 8 } },
          h('div', { style: grid },
            h(Metric, { title: '保活次数', value: tokens(task.touches) }),
            h(Metric, { title: '命中 / 未命中', value: tokens(task.hits) + ' / ' + tokens(task.misses) }),
            h(Metric, { title: '缓存读取', value: tokens(task.cacheRead) }),
            h(Metric, { title: '花费', value: money(task.cost) }),
            h(Metric, { title: '净省', value: money(task.saved) }),
            h(Metric, { title: '最近一次', value: clockDate(task.lastAt) })
          ),
          h('div', { style: { ...label, display: 'flex', gap: 12, flexWrap: 'wrap' } },
            h('span', null, '模型 ' + (task.provider || '?') + ' / ' + (task.model || '?')),
            h('span', null, '首次 ' + clockDate(task.firstAt))
          ),
          h('table', { style: { borderCollapse: 'collapse' } },
            h('thead', null, h('tr', null,
              h('th', { style: th }, '时间'), h('th', { style: th }, '第几次'), h('th', { style: th }, '结果'),
              h('th', { style: th }, '缓存读取'), h('th', { style: th }, '未命中'), h('th', { style: th }, '输出'),
              h('th', { style: th }, '花费'), h('th', { style: th }, '耗时'))),
            h('tbody', null, records.map((record, index) => h('tr', { key: index },
              h('td', { style: td }, clock(record.ts)),
              h('td', { style: td }, record.touch === null ? '—' : String(record.touch)),
              h('td', { style: td }, record.status === 'hit' ? '命中' : record.status === 'miss' ? '未命中' : record.status === 'error' ? '错误' : '未知'),
              h('td', { style: td }, tokens(record.cacheRead)),
              h('td', { style: td }, tokens(record.input)),
              h('td', { style: td }, tokens(record.output)),
              h('td', { style: td }, money(record.cost)),
              h('td', { style: td }, record.ms === null || record.ms === undefined ? '—' : (record.ms / 1000).toFixed(1) + 's')
            )))
          ),
          h('p', { style: { ...label, margin: 0 } },
            '净省 = 每次空闲期保住缓存所避免的一次冷重算花费（输入价 + 5 分钟缓存写入费）− 该空闲期所有保活花费（缓存读取按输入价的 1/10 计）。')
        );
      }

      function Metric({ title, value }) {
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
          h('span', { style: label }, title),
          h('strong', { style: { fontSize: 16 } }, value === null || value === undefined ? '—' : String(value))
        );
      }

      // The composer pill's hover card lives in a portal on <body>: the dock clips
      // its own overflow, so an absolutely-positioned child would be cut off.
      let ReactDOM;
      try {
        ReactDOM = require('react-dom');
      } catch {
        ReactDOM = undefined;
      }
      const canFloat = typeof document !== 'undefined' && ReactDOM !== undefined && ReactDOM !== null && typeof ReactDOM.createPortal === 'function';

      // Theme tokens with fallbacks: a renamed token changes the look, never breaks the card.
      const TIP = {
        label: 'var(--dsw-alias-label-primary, #101828)',
        secondary: 'var(--dsw-alias-label-secondary, #4a5565)',
        tertiary: 'var(--dsw-alias-label-tertiary, #667085)',
        border: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.28))',
        bg: 'var(--dsw-specific-menu, var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-base, #ffffff)))',
        shadow: 'var(--dsw-elevation-prominent, 0 12px 32px rgba(16,24,40,0.18))',
        radius: 'var(--dsw-radius-lg, 12px)'
      };

      /**
       * Hover card for one window's keepalive. All numbers come from
       * /state → windows[<sessionId>], which the Host scopes to "since this
       * window was switched on" (it restarts whenever the pill is turned on).
       */
      function WindowTip({ rect, enabled, win, interval, onEnter, onLeave }) {
        const frame = {
          position: 'fixed',
          zIndex: 2147483000,
          width: 248,
          boxSizing: 'border-box',
          padding: '10px 12px',
          borderRadius: TIP.radius,
          border: '1px solid ' + TIP.border,
          background: TIP.bg,
          color: TIP.label,
          boxShadow: TIP.shadow,
          fontSize: 12,
          lineHeight: 1.55
        };
        // Above the pill normally; below it when the composer sits high on screen.
        if (rect) {
          frame.left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - 256));
          if (rect.top > 210) frame.bottom = Math.max(8, window.innerHeight - rect.top + 8);
          else frame.top = Math.min(window.innerHeight - 16, rect.bottom + 8);
        }
        const row = (name, value) => h('div', { style: { display: 'flex', gap: 10, justifyContent: 'space-between', alignItems: 'baseline' } },
          h('span', { style: { color: TIP.tertiary, whiteSpace: 'nowrap' } }, name),
          h('span', { style: { textAlign: 'right', fontWeight: 500 } }, value)
        );
        const touches = win && typeof win.touches === 'number' ? win.touches : 0;
        // Off renders no body at all: just the header and the "click to turn on" footer.
        const body = enabled === null
          ? h('div', { style: { color: TIP.secondary, lineHeight: 1.6 } }, '正在读取本窗口状态…')
          : enabled
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 1 } },
              row('本次开启', '保活 ' + tokens(touches) + ' 次'),
              row('花费', money(win ? win.cost : 0)),
              row('命中 / 次数', tokens(win ? win.hits : 0) + ' / ' + tokens(win ? win.touches : 0)),
              row('缓存读取', tokens(win ? win.cacheRead : 0)),
              row('净省', money(win ? win.saved : 0)),
              win && win.gapTouches > 0 ? row('本轮空闲', '已保活 ' + tokens(win.gapTouches) + ' 次') : null,
              row('最近一次', win && win.lastAt ? clock(win.lastAt) : '还没开始'),
              win && win.stopped ? row('状态', '本轮已停，等下一次真实请求') : null
            )
            : null;

        return ReactDOM.createPortal(
          h('div', {
            'data-plugin': 'cache-keepalive-tip',
            role: 'tooltip',
            style: frame,
            onMouseEnter: onEnter,
            onMouseLeave: onLeave
          },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 } },
              h('span', { style: { width: 7, height: 7, borderRadius: '50%', background: enabled === true ? '#3fbf6f' : 'rgba(127,127,127,0.55)', display: 'inline-block' } }),
              h('strong', { style: { fontSize: 12 } }, '提示词缓存保活'),
              h('span', { style: { color: TIP.tertiary } }, enabled === null ? '读取中' : enabled ? '本窗口开' : '本窗口关')
            ),
            body,
            h('div', { style: { marginTop: 7, paddingTop: 6, borderTop: '1px solid ' + TIP.border, color: TIP.tertiary } },
              enabled === null ? '状态读取中' : enabled ? '点击关闭本窗口 · 空闲时每 ' + interval + ' 分钟续一次' : '点击开启本窗口')
          ),
          document.body
        );
      }

      // One compact start/pause pill beside the message composer. It controls
      // ONLY the conversation it renders in: the Host stores a per-session switch,
      // so toggling one window never changes another.
      function ComposerButton({ sessionId }) {
        const { state } = useStatus();
        const [busy, setBusy] = React.useState(false);
        const [pending, setPending] = React.useState(null);
        const [tip, setTip] = React.useState(null);
        const buttonRef = React.useRef(null);
        const hideTimer = React.useRef(null);
        const config = state && state.config ? state.config : null;
        const explicit = config && config.sessionEnabled && Object.prototype.hasOwnProperty.call(config.sessionEnabled, sessionId)
          ? config.sessionEnabled[sessionId] === true
          : null;
        const stored = config === null ? null : explicit === null ? config.enabled === true : explicit;
        const enabled = pending === null ? stored : pending;
        React.useEffect(() => {
          if (pending !== null && stored === pending) setPending(null);
        }, [pending, stored]);
        // The card must survive the pointer travelling from the pill onto it.
        React.useEffect(() => () => {
          if (hideTimer.current !== null) clearTimeout(hideTimer.current);
        }, []);
        React.useEffect(() => {
          if (tip === null) return undefined;
          const close = () => setTip(null);
          window.addEventListener('resize', close);
          return () => window.removeEventListener('resize', close);
        }, [tip]);
        const openTip = () => {
          if (hideTimer.current !== null) {
            clearTimeout(hideTimer.current);
            hideTimer.current = null;
          }
          const node = buttonRef.current;
          let rect = null;
          try {
            rect = node && typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
          } catch {
            rect = null;
          }
          setTip({ rect });
        };
        const closeTip = () => {
          if (hideTimer.current !== null) clearTimeout(hideTimer.current);
          hideTimer.current = setTimeout(() => {
            hideTimer.current = null;
            setTip(null);
          }, 120);
        };
        const toggle = async () => {
          if (enabled === null || busy || typeof sessionId !== 'string' || sessionId.length === 0) return;
          const next = !enabled;
          setPending(next);
          setBusy(true);
          try {
            const res = await fetch(API + '/session', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ session: sessionId, enabled: next })
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
          } catch {
            setPending(null);
          } finally {
            setBusy(false);
          }
        };
        const missing = typeof sessionId !== 'string' || sessionId.length === 0;
        const interval = (config && config.intervalMinutes) || 4;
        const dot = missing || enabled === null ? 'rgba(127,127,127,0.55)' : enabled ? '#3fbf6f' : 'rgba(127,127,127,0.55)';
        const pill = h('button', {
          ref: buttonRef,
          type: 'button',
          'data-plugin': 'cache-keepalive-toggle',
          // The native tooltip is only the fallback: with react-dom available the
          // hover card below replaces it (it shows live numbers, not just a hint).
          title: canFloat && !missing
            ? undefined
            : missing
              ? '提示词缓存保活：没拿到本窗口的会话 id'
              : enabled === null
                ? '提示词缓存保活：状态读取中'
                : enabled
                  ? '提示词缓存保活：本窗口已开启（空闲时每 ' + interval + ' 分钟续一次缓存），点击只关闭本窗口'
                  : '提示词缓存保活：本窗口已关闭，点击只开启本窗口',
          'aria-label': '提示词缓存保活开关（仅本会话）',
          disabled: missing || busy || enabled === null,
          onClick: toggle,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            flex: '0 0 auto',
            whiteSpace: 'nowrap',
            writingMode: 'horizontal-tb',
            padding: '2px 9px',
            margin: '0 4px',
            color: 'inherit',
            background: enabled === true ? 'rgba(63,191,111,0.12)' : 'transparent',
            border: '1px solid ' + (enabled === true ? 'rgba(63,191,111,0.45)' : 'rgba(127,127,127,0.3)'),
            borderRadius: 999,
            cursor: missing || busy ? 'default' : 'pointer',
            font: 'inherit',
            fontSize: 12,
            lineHeight: 1.5,
            opacity: missing || busy ? 0.6 : 1
          }
        },
          h('span', { style: { width: 6, height: 6, borderRadius: '50%', background: dot, display: 'inline-block', flex: '0 0 auto', boxShadow: enabled === true ? '0 0 0 3px rgba(63,191,111,0.18)' : 'none' } }),
          h('span', { style: { opacity: enabled === true ? 1 : 0.6 } }, missing ? '保活?' : '保活')
        );

        if (!canFloat || missing) return pill;
        return h('span', {
          style: { display: 'inline-flex', alignItems: 'center', flex: '0 0 auto', whiteSpace: 'nowrap' },
          onMouseEnter: openTip,
          onMouseLeave: closeTip,
          onFocus: openTip,
          onBlur: closeTip
        },
          pill,
          tip === null ? null : h(WindowTip, {
            rect: tip.rect,
            enabled: enabled === null ? null : enabled === true,
            win: state && state.windows ? state.windows[sessionId] : null,
            interval,
            onEnter: openTip,
            onLeave: closeTip
          })
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
                  {
                    name: 'conversation.composer.dock',
                    id: 'cache-keepalive-toggle',
                    order: 30,
                    // Session-scoped slot: the renderer passes this slot's binding
                    // key (the session id) as the first inject argument.
                    inject: (sessionId) => {
                      report('composer-inject', sessionId === undefined ? 'missing' : String(sessionId).slice(0, 12));
                      return { sessionId };
                    }
                  },
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
