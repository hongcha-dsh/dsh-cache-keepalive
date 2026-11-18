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
          headers: { 'content-type': 'application/json', 'x-keepalive': '1' },
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

      // ---- Look & feel -----------------------------------------------------
      // One <style> tag (ref-counted on the element itself, removed when the last
      // page unmounts). Every colour comes from a DSH token with a fallback.
      const STYLE_ID = 'dsh-cache-keepalive-style';
      const CSS = `
.ka{--ka-fg:var(--dsw-alias-label-primary,#101828);--ka-fg2:var(--dsw-alias-label-secondary,#4a5565);--ka-fg3:var(--dsw-alias-label-tertiary,#667085);--ka-base:var(--dsw-alias-bg-base,#ffffff);--ka-l1:var(--dsw-alias-bg-layer-1,#f7f8fa);--ka-l2:var(--dsw-alias-bg-layer-2,#eef0f3);--ka-b1:var(--dsw-alias-border-l1,rgba(16,24,40,.09));--ka-b2:var(--dsw-alias-border-l2,rgba(16,24,40,.18));--ka-brand:var(--dsw-alias-brand-primary,#3b6cf6);--ka-on-brand:var(--dsw-alias-brand-on-primary,#ffffff);--ka-ok:var(--dsw-alias-state-success-primary,#1f9d57);--ka-warn:var(--dsw-alias-state-warn-primary,#c98a04);--ka-err:var(--dsw-alias-state-error-primary,#d92d20);--ka-idle:var(--dsw-alias-state-idle-primary,#98a2b3);--ka-rm:var(--dsw-radius-md,8px);--ka-rl:var(--dsw-radius-lg,12px);display:flex;flex-direction:column;gap:22px;min-width:0;font-family:var(--dsw-font-family,inherit);font-size:13px;line-height:1.5;color:var(--ka-fg)}
.ka *,.ka *::before,.ka *::after{box-sizing:border-box}
.ka button,.ka input{font:inherit;color:inherit}
.ka button:focus-visible,.ka input:focus-visible{outline:2px solid color-mix(in srgb,var(--ka-brand) 55%,transparent);outline-offset:1px}
.ka-num{font-variant-numeric:tabular-nums}
.ka-group{display:flex;flex-direction:column;gap:8px;min-width:0}
.ka-gh{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;padding:0 2px}
.ka-gt{margin:0;font-size:13px;font-weight:600;color:var(--ka-fg)}
.ka-gd{font-size:12px;color:var(--ka-fg3)}
.ka-gs{margin-left:auto;font-size:12px;color:var(--ka-fg3)}
.ka-card{background:var(--ka-l1);border:1px solid var(--ka-b1);border-radius:var(--ka-rl);overflow:hidden;min-width:0}
.ka-banner{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;border-radius:var(--ka-rm);border:1px solid color-mix(in srgb,var(--ka-err) 35%,transparent);background:color-mix(in srgb,var(--ka-err) 9%,transparent);color:var(--ka-err);font-size:12px}
.ka-empty{padding:22px 16px;text-align:center;font-size:12px;color:var(--ka-fg3);line-height:1.7}
.ka-empty strong{display:block;margin-bottom:2px;font-size:13px;font-weight:600;color:var(--ka-fg2)}
.ka-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:8px}
.ka-stat{display:flex;flex-direction:column;gap:2px;min-width:0;padding:10px 12px;background:var(--ka-l1);border:1px solid var(--ka-b1);border-radius:var(--ka-rl)}
.ka-stat-l{font-size:12px;color:var(--ka-fg3);white-space:nowrap}
.ka-stat-v{font-size:20px;line-height:1.3;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ka-stat-s{font-size:11px;color:var(--ka-fg3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ka .ka-tone-ok{color:var(--ka-ok)}.ka .ka-tone-err{color:var(--ka-err)}.ka .ka-tone-warn{color:var(--ka-warn)}
.ka-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 16px;align-items:center;padding:12px 14px}
.ka-row+.ka-row,.ka-row+.ka-note{border-top:1px solid var(--ka-b1)}
.ka-rt{font-size:13px;font-weight:500;color:var(--ka-fg)}
.ka-rd{margin-top:1px;font-size:12px;line-height:1.55;color:var(--ka-fg3)}
.ka-rd b{font-weight:500;color:var(--ka-fg2)}
.ka-derived{display:inline-block;margin-top:4px;padding:1px 8px;border-radius:999px;font-size:12px;color:var(--ka-fg2);background:var(--ka-l2);font-variant-numeric:tabular-nums}
.ka-ctl{display:flex;align-items:center;gap:6px;justify-self:end}
.ka-unit{width:36px;font-size:12px;color:var(--ka-fg3);white-space:nowrap}
.ka-err{grid-column:1/-1;font-size:12px;color:var(--ka-err)}
.ka-below{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:6px}
.ka-input{width:84px;height:28px;padding:0 9px;text-align:right;font-variant-numeric:tabular-nums;background:var(--ka-base);border:1px solid var(--ka-b2);border-radius:var(--ka-rm);appearance:textfield;-moz-appearance:textfield}
.ka-input::-webkit-outer-spin-button,.ka-input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.ka-input:hover{border-color:var(--ka-fg3)}
.ka-input:focus{outline:none;border-color:var(--ka-brand);box-shadow:0 0 0 3px color-mix(in srgb,var(--ka-brand) 22%,transparent)}
.ka-input[aria-invalid=true]{border-color:var(--ka-err);box-shadow:0 0 0 3px color-mix(in srgb,var(--ka-err) 16%,transparent)}
.ka-input:disabled{opacity:.5;cursor:not-allowed}
.ka-switch{position:relative;flex:0 0 auto;width:34px;height:20px;padding:0;border:none;border-radius:999px;cursor:pointer;background:color-mix(in srgb,var(--ka-fg3) 38%,transparent);transition:background .15s}
.ka-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--ka-on-brand);box-shadow:0 1px 2px rgba(0,0,0,.28);transition:transform .15s}
.ka-switch[aria-checked=true]{background:var(--ka-brand)}
.ka-switch[aria-checked=true]::after{transform:translateX(14px)}
.ka-switch:disabled{opacity:.5;cursor:not-allowed}
.ka-note{display:flex;gap:8px;padding:10px 14px;font-size:12px;line-height:1.6;color:var(--ka-fg2);background:var(--ka-l2)}
.ka-note i{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;margin-top:2px;border-radius:50%;font-style:normal;font-size:10px;font-weight:700;color:var(--ka-l2);background:var(--ka-fg3)}
.ka-note code,.ka-rd code{padding:0 4px;border-radius:4px;background:var(--ka-l2);font-size:11.5px}
.ka-note code{background:var(--ka-base)}
.ka-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:0 2px}
.ka-bar-s{flex:1 1 160px;min-width:0;font-size:12px;color:var(--ka-fg3)}
.ka-btn{height:28px;padding:0 14px;border-radius:var(--ka-rm);border:1px solid var(--ka-b2);background:var(--ka-base);cursor:pointer;white-space:nowrap;font-size:12.5px}
.ka-btn:hover:not(:disabled){background:var(--ka-l2)}
.ka-btn:disabled{opacity:.45;cursor:not-allowed}
.ka-btn--primary{border-color:var(--ka-brand);background:var(--ka-brand);color:var(--ka-on-brand);font-weight:500}
.ka-btn--primary:hover:not(:disabled){background:var(--ka-brand);filter:brightness(1.08)}
.ka-btn--primary:disabled{border-color:transparent;background:var(--ka-l2);color:var(--ka-fg3);opacity:1}
.ka-btn--sm{height:24px;padding:0 9px;font-size:12px}
.ka-btn--danger{color:var(--ka-fg3);background:transparent;border-color:transparent}
.ka-btn--danger:hover:not(:disabled){color:var(--ka-err);background:color-mix(in srgb,var(--ka-err) 10%,transparent)}
.ka-btn--danger.is-confirm{color:var(--ka-err);border-color:var(--ka-err);background:color-mix(in srgb,var(--ka-err) 10%,transparent)}
.ka-item{display:flex;align-items:center;gap:6px 12px;flex-wrap:wrap;padding:11px 14px}
.ka-item+.ka-item{border-top:1px solid var(--ka-b1)}
.ka-dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:var(--ka-idle)}
.ka-dot.on{background:var(--ka-ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--ka-ok) 20%,transparent)}
.ka-dot.warn{background:var(--ka-warn)}
.ka-main{flex:1 1 200px;min-width:0}
.ka-title{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ka-meta{display:flex;flex-wrap:wrap;align-items:center;gap:2px 10px;margin-top:1px;font-size:12px;color:var(--ka-fg3);font-variant-numeric:tabular-nums}
.ka-chip{display:inline-flex;align-items:center;padding:0 7px;height:18px;border-radius:999px;font-size:11px;white-space:nowrap;color:var(--ka-fg2);background:var(--ka-l2)}
.ka-chip.ok{color:var(--ka-ok);background:color-mix(in srgb,var(--ka-ok) 13%,transparent)}
.ka-chip.warn{color:var(--ka-warn);background:color-mix(in srgb,var(--ka-warn) 14%,transparent)}
.ka-chip.err{color:var(--ka-err);background:color-mix(in srgb,var(--ka-err) 12%,transparent)}
.ka-chip.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;height:20px;padding:0 8px;color:var(--ka-fg2);background:var(--ka-l2)}
.ka-chips{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px 6px;margin-left:auto}
.ka-due{flex:0 0 auto;min-width:72px;text-align:right;font-size:11px;color:var(--ka-fg3);line-height:1.3}
.ka-due b{display:block;font-size:16px;font-weight:600;color:var(--ka-fg);font-variant-numeric:tabular-nums}
.ka-rec+.ka-rec{border-top:1px solid var(--ka-b1)}
.ka-rec-h{display:flex;align-items:center;gap:6px;padding:4px 8px 4px 6px}
.ka-rec-b{flex:1 1 auto;min-width:0;display:flex;align-items:center;flex-wrap:wrap;gap:2px 12px;padding:6px 6px;border:none;border-radius:var(--ka-rm);background:transparent;text-align:left;cursor:pointer}
.ka-rec-b:hover{background:color-mix(in srgb,var(--ka-fg3) 9%,transparent)}
.ka-chev{flex:0 0 auto;width:14px;font-size:10px;color:var(--ka-fg3);transition:transform .15s}
.ka-chev.open{transform:rotate(90deg)}
.ka-rec-t{flex:1 1 150px;min-width:0;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ka-rec-m{display:flex;align-items:center;flex-wrap:wrap;gap:2px 10px;font-size:12px;color:var(--ka-fg3);font-variant-numeric:tabular-nums}
.ka-detail{display:flex;flex-direction:column;gap:12px;margin:0 12px 12px;padding:12px;border-radius:var(--ka-rm);background:var(--ka-l2)}
.ka-kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:8px 12px}
.ka-kv div{display:flex;flex-direction:column;min-width:0}
.ka-kv span{font-size:11px;color:var(--ka-fg3)}
.ka-kv b{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ka-sub{font-size:12px;color:var(--ka-fg3)}
.ka-twrap{overflow-x:auto;border:1px solid var(--ka-b1);border-radius:var(--ka-rm);background:var(--ka-base)}
.ka-table{width:100%;min-width:470px;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}
.ka-table th{padding:6px 10px;text-align:left;font-weight:500;color:var(--ka-fg3);border-bottom:1px solid var(--ka-b1);white-space:nowrap}
.ka-table td{padding:5px 10px;white-space:nowrap}
.ka-table tr+tr td{border-top:1px solid var(--ka-b1)}
.ka-table .r{text-align:right}
.ka-table th.r{text-align:right}
.ka-foot{margin:0;font-size:11.5px;line-height:1.6;color:var(--ka-fg3)}
`;
      function useKaStyle() {
        React.useLayoutEffect(() => {
          if (typeof document === 'undefined') return undefined;
          let el = document.getElementById(STYLE_ID);
          if (!el) {
            el = document.createElement('style');
            el.id = STYLE_ID;
            document.head.appendChild(el);
          }
          if (el.textContent !== CSS) el.textContent = CSS;
          el.setAttribute('data-users', String(Number(el.getAttribute('data-users') || 0) + 1));
          return () => {
            const node = document.getElementById(STYLE_ID);
            if (!node) return;
            const left = Number(node.getAttribute('data-users') || 1) - 1;
            if (left <= 0) node.remove();
            else node.setAttribute('data-users', String(left));
          };
        }, []);
      }
      const cx = (...parts) => parts.filter(Boolean).join(' ');

      function useStatus() {
        const [state, setState] = React.useState(null);
        const [error, setError] = React.useState(null);
        const receivedRef = React.useRef(0);
        const load = React.useCallback(async () => {
          try {
            const res = await fetch(API + '/state', { cache: 'no-store' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const json = await res.json();
            receivedRef.current = Date.now();
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
        return { state, error, refresh: load, receivedAt: receivedRef.current };
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
      function countdown(seconds) {
        const total = Math.max(0, Math.round(seconds));
        return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
      }

      // Editable numeric settings. maxTouches is intentionally absent: the Host derives it.
      const FIELDS = {
        intervalMinutes: { min: 1, max: 60 },
        maxIdleMinutes: { min: 1, max: 1440 },
        replayMaxTokens: { min: 2, max: 64 },
        compactAfterMinutes: { min: 5, max: 120 }
      };
      // Raw text -> { ok, value } | { ok:false, error }. Empty / non-integer / out of range never reaches the Host.
      function parseField(key, raw) {
        const spec = FIELDS[key];
        const text = String(raw === null || raw === undefined ? '' : raw).trim();
        if (text === '') return { ok: false, error: '请输入 ' + spec.min + '–' + spec.max + ' 之间的整数' };
        const value = Number(text);
        if (!Number.isFinite(value) || !Number.isInteger(value)) return { ok: false, error: '请输入整数（' + spec.min + '–' + spec.max + '）' };
        if (value < spec.min || value > spec.max) return { ok: false, error: '超出范围，请输入 ' + spec.min + '–' + spec.max };
        return { ok: true, value };
      }

      function Stat({ label, value, sub, tone }) {
        return h('div', { className: 'ka-stat' },
          h('span', { className: 'ka-stat-l' }, label),
          h('span', { className: cx('ka-stat-v', tone && 'ka-tone-' + tone), title: String(value) }, value),
          sub ? h('span', { className: 'ka-stat-s', title: sub }, sub) : null
        );
      }

      function Switch({ checked, onChange, disabled, label }) {
        return h('button', {
          type: 'button',
          role: 'switch',
          className: 'ka-switch',
          'aria-checked': checked ? 'true' : 'false',
          'aria-label': label,
          disabled,
          onClick: () => onChange(!checked)
        });
      }

      function SettingRow({ title, desc, children, error, below }) {
        return h('div', { className: 'ka-row' },
          h('div', null,
            h('div', { className: 'ka-rt' }, title),
            desc ? h('div', { className: 'ka-rd' }, desc) : null
          ),
          children ? h('div', { className: 'ka-ctl' }, children) : null,
          below ? h('div', { className: 'ka-below' }, below) : null,
          error ? h('div', { className: 'ka-err', role: 'alert' }, error) : null
        );
      }

      function StatusCard({ view }) {
        const status = useStatus();
        const { state, error } = status;
        if (view === 'summary') {
          if (state === null) return h('span', null, error ? '状态接口不可用' : '读取中…');
          const on = state.sessions ? state.sessions.filter((x) => x.enabled).length : 0;
          const st = state.stats || {};
          return h('span', null, '空闲时自动重放请求保持提示词缓存'
            + (on > 0 ? ' · 保活中 ' + on + ' 个窗口' : ' · 暂无保活中的窗口')
            + (st.touches ? ' · 累计 ' + st.touches + ' 次，估算净省 ' + money(st.savedEstimate) : ''));
        }
        if (view !== 'page') return null;
        return h(SettingsPage, status);
      }

      function SettingsPage({ state, error, refresh, receivedAt }) {
        useKaStyle();
        const [edits, setEdits] = React.useState({});
        const [busy, setBusy] = React.useState(false);
        const [status, setStatus] = React.useState(null);

        React.useEffect(() => {
          if (!status || status.kind !== 'ok') return undefined;
          const timer = setTimeout(() => setStatus(null), 3200);
          return () => clearTimeout(timer);
        }, [status]);

        const config = (state && state.config) || {};
        const base = {
          enabled: typeof config.enabled === 'boolean' ? config.enabled : !!(state && state.enabled),
          compactEnabled: config.compactEnabled === true,
          compactResetOnManual: config.compactResetOnManual !== false,
          intervalMinutes: config.intervalMinutes,
          maxIdleMinutes: config.maxIdleMinutes,
          replayMaxTokens: config.replayMaxTokens,
          compactAfterMinutes: config.compactAfterMinutes
        };
        const loaded = state !== null;
        const bools = { enabled: true, compactEnabled: true, compactResetOnManual: true };
        const raw = (key) => (edits[key] !== undefined ? edits[key] : base[key] === undefined || base[key] === null ? '' : String(base[key]));
        const boolValue = (key) => (edits[key] !== undefined ? edits[key] : base[key]);
        const parsed = {};
        const errors = {};
        const patch = {};
        let dirtyCount = 0;
        Object.keys(FIELDS).forEach((key) => {
          if (edits[key] === undefined) return;
          const result = parseField(key, edits[key]);
          parsed[key] = result;
          if (!result.ok) {
            errors[key] = result.error;
            dirtyCount += 1;
          } else if (result.value !== base[key]) {
            patch[key] = result.value;
            dirtyCount += 1;
          }
        });
        Object.keys(bools).forEach((key) => {
          if (edits[key] !== undefined && edits[key] !== base[key]) {
            patch[key] = edits[key];
            dirtyCount += 1;
          }
        });
        const errorCount = Object.keys(errors).length;
        const dirty = dirtyCount > 0;
        const canSave = loaded && dirty && errorCount === 0 && !busy;

        const edit = (key, value) => {
          setStatus(null);
          setEdits((prev) => ({ ...prev, [key]: value }));
        };
        const save = async () => {
          if (!canSave) return;
          setBusy(true);
          setStatus(null);
          try {
            const res = await fetch(API + '/config', {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-keepalive': '1' },
              body: JSON.stringify(patch)
            });
            const json = await res.json().catch(() => null);
            if (!res.ok) throw new Error(json && json.error ? json.error : 'HTTP ' + res.status);
            await refresh();
            setEdits({});
            setStatus({ kind: 'ok', text: '已保存' });
          } catch (e) {
            setStatus({ kind: 'err', text: '保存失败：' + String((e && e.message) || e) });
          } finally {
            setBusy(false);
          }
        };

        // Live preview of the derived touch cap: floor(max duration / interval).
        const validNow = (key) => (parsed[key] ? (parsed[key].ok ? parsed[key].value : null) : base[key]);
        const iv = validNow('intervalMinutes');
        const mx = validNow('maxIdleMinutes');
        const derived = typeof iv === 'number' && typeof mx === 'number' && iv > 0 ? Math.floor(mx / iv) : config.maxTouches;
        const derivedText = typeof derived !== 'number' ? '—' : derived < 1 ? '不足 1 次，请缩短间隔或延长时长' : '约 ' + tokens(derived) + ' 次保活（按上方间隔自动计算；个别线路的间隔不同）';
        const compactMinutes = validNow('compactAfterMinutes') || 20;

        const numberInput = (key, unit, title) => h(React.Fragment, null,
          h('input', {
            className: 'ka-input',
            type: 'number',
            inputMode: 'numeric',
            step: 1,
            min: FIELDS[key].min,
            max: FIELDS[key].max,
            value: raw(key),
            disabled: !loaded,
            'aria-label': title,
            'aria-invalid': errors[key] ? 'true' : 'false',
            onChange: (e) => edit(key, e.target.value)
          }),
          h('span', { className: 'ka-unit' }, unit)
        );

        const stats = (state && state.stats) || {};
        const sessions = (state && state.sessions) || [];
        const tasks = (state && state.tasks) || [];
        const openWindows = sessions.filter((s) => s.enabled).length;
        const routes = Array.isArray(config.routes) ? config.routes : [];
        const saved = stats.savedEstimate;

        const footer = busy
          ? h('span', { className: 'ka-bar-s' }, '保存中…')
          : status
            ? h('span', { className: cx('ka-bar-s', status.kind === 'ok' ? 'ka-tone-ok' : 'ka-tone-err') }, (status.kind === 'ok' ? '✓ ' : '') + status.text)
            : errorCount > 0
              ? h('span', { className: 'ka-bar-s ka-tone-err' }, errorCount + ' 项输入无效，修正后才能保存')
              : dirty
                ? h('span', { className: 'ka-bar-s' }, '有 ' + dirtyCount + ' 项未保存的更改')
                : h('span', { className: 'ka-bar-s' }, '数值修改后点击保存生效；开关同样需要保存');

        return h('div', { className: 'ka', 'data-plugin': 'cache-keepalive' },
          error ? h('div', { className: 'ka-banner', role: 'alert' },
            h('span', null, '状态接口不可用：' + error + (loaded ? '（当前显示上一次的数据）' : '')),
            h('button', { type: 'button', className: 'ka-btn ka-btn--sm', onClick: () => void refresh() }, '重试')
          ) : null,

          h('div', { className: 'ka-stats' },
            h(Stat, { label: '保活中的窗口', value: loaded ? String(openWindows) : '—', sub: loaded ? '共跟踪 ' + sessions.length + ' 个会话' : '' }),
            h(Stat, { label: '累计保活', value: tokens(stats.touches), sub: '缓存读取 ' + tokens(stats.cacheRead) }),
            h(Stat, { label: '命中率', value: stats.hitRate === null || stats.hitRate === undefined ? '—' : Math.round(stats.hitRate * 100) + '%', sub: '命中 ' + tokens(stats.hits) + ' / ' + tokens(stats.touches) }),
            h(Stat, { label: '估算净省', value: money(saved), tone: typeof saved === 'number' && saved > 0 ? 'ok' : typeof saved === 'number' && saved < 0 ? 'err' : undefined, sub: '已扣除保活花费' }),
            h(Stat, { label: '估算花费', value: money(stats.costEstimate), sub: '保活本身的开销' })
          ),

          h('section', { className: 'ka-group' },
            h('div', { className: 'ka-gh' }, h('h3', { className: 'ka-gt' }, '保活'), h('span', { className: 'ka-gd' }, '空闲时按间隔重放最近一次请求，保住提示词缓存')),
            h('div', { className: 'ka-card' },
              h(SettingRow, {
                title: '新会话默认开启保活',
                desc: '只决定没单独选择过的窗口；每个窗口都可以用输入框旁的「保活」按钮单独开关。'
              }, h(Switch, { checked: boolValue('enabled') === true, onChange: (v) => edit('enabled', v), disabled: !loaded, label: '新会话默认开启保活' })),
              h(SettingRow, {
                title: '保活间隔',
                desc: h(React.Fragment, null, 'Claude 的提示词缓存只保留 5 分钟，建议设为 ', h('b', null, '4'), ' 分钟。范围 1–60。'),
                error: errors.intervalMinutes
              }, numberInput('intervalMinutes', '分钟', '保活间隔')),
              h(SettingRow, {
                title: '最长保活时长',
                desc: h(React.Fragment, null, '一次空闲期内最多保活这么久，之后停止，等下一次真实请求再重新计时。范围 1–1440。', h('br'), h('span', { className: 'ka-derived' }, derivedText)),
                error: errors.maxIdleMinutes
              }, numberInput('maxIdleMinutes', '分钟', '最长保活时长（分钟）')),
              h(SettingRow, {
                title: '重放输出上限',
                desc: '每次保活最多生成的 token 数。中转站可能把 1 直接短路而不碰缓存，所以至少为 2。范围 2–64。',
                error: errors.replayMaxTokens
              }, numberInput('replayMaxTokens', 'token', '重放输出上限')),
              h(SettingRow, {
                title: '保活线路',
                desc: routes.length > 0 ? '只对下列线路保活（改 config.json 的 routes 调整）。' : '没有限制线路，跟随当前会话所用的模型。',
                below: routes.length > 0 ? routes.map((r, i) => h('span', { key: i, className: 'ka-chip mono' }, r.provider + ' / ' + r.model)) : null
              })
            )
          ),

          h('section', { className: 'ka-group' },
            h('div', { className: 'ka-gh' }, h('h3', { className: 'ka-gt' }, '空闲后自动压缩'), h('span', { className: 'ka-gd' }, '长时间不回来的对话，压缩一次再停止保活')),
            h('div', { className: 'ka-card' },
              h(SettingRow, {
                title: '新会话默认开启压缩',
                desc: '每个窗口可用输入框旁的「压缩」按钮单独开关；该窗口需同时开着保活。'
              }, h(Switch, { checked: boolValue('compactEnabled') === true, onChange: (v) => edit('compactEnabled', v), disabled: !loaded, label: '新会话默认开启压缩' })),
              h(SettingRow, {
                title: '空闲多久后压缩',
                desc: '保活期间空闲满这么久就压缩一次。范围 5–120。',
                error: errors.compactAfterMinutes
              }, numberInput('compactAfterMinutes', '分钟', '空闲多久后压缩')),
              h(SettingRow, {
                title: '手动压缩时清零倒计时',
                desc: '你在窗口里手动执行 /compact 后，该窗口的自动压缩倒计时清零：已过时的保活请求快照会被丢弃，保活与压缩都等下一条真实消息后重新开始。关闭则不处理手动压缩。'
              }, h(Switch, { checked: boolValue('compactResetOnManual') === true, onChange: (v) => edit('compactResetOnManual', v), disabled: !loaded, label: '手动压缩时清零倒计时' })),
              h('div', { className: 'ka-note' }, h('i', { 'aria-hidden': 'true' }, 'i'),
                h('span', null, '压缩开启的窗口，空闲满 ', h('b', { className: 'ka-num' }, String(compactMinutes)), ' 分钟后压缩一次并停止保活，下一次真实请求再重新开始。请勿与 ', h('code', null, 'dsh-auto-compact'), ' 同装，否则它会提前压缩、让保活白费。'))
            )
          ),

          h('div', { className: 'ka-bar' },
            footer,
            dirty && !busy ? h('button', { type: 'button', className: 'ka-btn', onClick: () => { setEdits({}); setStatus(null); } }, '还原') : null,
            h('button', { type: 'button', className: 'ka-btn ka-btn--primary', disabled: !canSave, onClick: save }, busy ? '保存中…' : '保存')
          ),

          h('section', { className: 'ka-group' },
            h('div', { className: 'ka-gh' }, h('h3', { className: 'ka-gt' }, '当前跟踪的会话'), h('span', { className: 'ka-gs ka-num' }, loaded && sessions.length > 0 ? sessions.length + ' 个' : '')),
            h('div', { className: 'ka-card' },
              h(SessionList, { sessions, windows: (state && state.windows) || {}, receivedAt, compactMinutes: config.compactAfterMinutes || 20, loaded })
            )
          ),

          h('section', { className: 'ka-group' },
            h('div', { className: 'ka-gh' }, h('h3', { className: 'ka-gt' }, '保活记录'), h('span', { className: 'ka-gd' }, tasks.length > 0 ? '每个对话一条，点开看每次保活的明细' : '')),
            h('div', { className: 'ka-card' },
              h(TaskRecords, { tasks, onChanged: refresh })
            )
          )
        );
      }

      // The 压缩 label of one session row, driven by the Host's compactStatus.
      function compactChip(win, s, minutes, now, receivedAt) {
        if (!win) return null;
        const status = win.compactStatus;
        if (status === undefined) return win.compact ? h('span', { className: 'ka-chip warn' }, '压缩 ' + minutes + ' 分') : null;
        if (status === 'counting') {
          const due = typeof win.compactDueSeconds === 'number' ? Math.max(0, win.compactDueSeconds - (now - (receivedAt || now)) / 1000) : null;
          return h('span', { className: 'ka-chip warn ka-num', title: '距自动压缩' }, due === null ? '压缩' : due <= 0 ? '即将压缩' : '压缩 ' + countdown(due));
        }
        if (status === 'running') return h('span', { className: 'ka-chip warn' }, '压缩中');
        if (status === 'done' || status === 'manual') return h('span', { className: 'ka-chip ok', title: status === 'manual' ? '已手动压缩，等下一条消息重新计时' : '已自动压缩，等下一条消息重新计时' }, '已压缩');
        if (status === 'waiting') return h('span', { className: 'ka-chip', title: '等待下一条消息开始计时' }, '待命');
        if (status === 'stopped') return s.stopped ? null : h('span', { className: 'ka-chip err', title: '本轮保活已停，不会自动压缩' }, '本轮已停');
        return null;
      }

      function SessionList({ sessions, windows, receivedAt, compactMinutes, loaded }) {
        const ticking = sessions.some((s) => typeof s.nextDueSeconds === 'number' || (windows[s.id] && windows[s.id].compactStatus === 'counting'));
        const [now, setNow] = React.useState(Date.now());
        React.useEffect(() => {
          if (!ticking) return undefined;
          const timer = setInterval(() => setNow(Date.now()), 1000);
          return () => clearInterval(timer);
        }, [ticking]);
        if (!loaded) return h('div', { className: 'ka-empty' }, '读取中…');
        if (sessions.length === 0) {
          return h('div', { className: 'ka-empty' }, h('strong', null, '还没有跟踪中的会话'), '在对话输入框旁打开「保活」，下一次真实请求之后，这个会话就会出现在这里。');
        }
        return h('div', null, sessions.map((s) => {
          const win = windows[s.id];
          const active = s.enabled && s.armed && !s.stopped;
          const due = active && typeof s.nextDueSeconds === 'number' ? s.nextDueSeconds - (now - (receivedAt || now)) / 1000 : null;
          return h('div', { key: s.id, className: 'ka-item' },
            h('span', { className: cx('ka-dot', active && 'on', s.enabled && !active && 'warn'), title: s.enabled ? '本窗口保活已开' : '本窗口保活已关' }),
            h('div', { className: 'ka-main' },
              h('div', { className: 'ka-title', title: s.title || s.session }, s.title || '会话 ' + s.session),
              h('div', { className: 'ka-meta' },
                h('span', null, (s.provider || '?') + ' / ' + (s.model || '?')),
                h('span', null, '空闲 ' + s.idleMinutes + ' 分钟'),
                h('span', null, '已保活 ' + tokens(s.touches) + ' 次')
              )
            ),
            h('span', { className: 'ka-chips' },
              h('span', { className: cx('ka-chip', s.enabled ? 'ok' : '') }, s.enabled ? '保活开' : '保活关'),
              s.enabled ? compactChip(win, s, compactMinutes, now, receivedAt) : null,
              s.enabled && !s.armed ? h('span', { className: 'ka-chip' }, '待首次命中') : null,
              s.enabled && s.stopped ? h('span', { className: 'ka-chip err' }, '本轮已停') : null
            ),
            h('span', { className: 'ka-due' }, '下次保活', due === null ? h('b', { style: { color: 'var(--ka-fg3)' } }, '—') : h('b', null, due <= 0 ? '即将' : countdown(due)))
          );
        }));
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
              headers: { 'content-type': 'application/json', 'x-keepalive': '1' },
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
          return h('div', { className: 'ka-empty' }, h('strong', null, '还没有保活记录'), '开启保活后，每个对话会单独记一条；点开可以看每次保活的命中情况和花费。');
        }

        return h('div', null,
          error && openId === null ? h('div', { className: 'ka-banner', style: { margin: 10 }, role: 'alert' }, error) : null,
          tasks.map((task) => {
            const open = openId === task.id;
            const confirming = confirmId === task.id;
            return h('div', { key: task.id, className: 'ka-rec' },
              h('div', { className: 'ka-rec-h' },
                h('button', {
                  type: 'button',
                  className: 'ka-rec-b',
                  'aria-expanded': open ? 'true' : 'false',
                  title: open ? '收起明细' : '展开每次保活的明细',
                  onClick: () => toggle(task.id)
                },
                  h('span', { className: cx('ka-chev', open && 'open') }, '▶'),
                  h('span', { className: 'ka-rec-t', title: task.title }, task.title),
                  h('span', { className: 'ka-rec-m' },
                    h('span', { className: cx('ka-chip', task.enabled === false ? '' : 'ok') }, task.enabled === false ? '窗口关' : '窗口开'),
                    h('span', null, tokens(task.touches) + ' 次'),
                    h('span', { className: task.saved > 0 ? 'ka-tone-ok' : task.saved < 0 ? 'ka-tone-err' : '' }, '省 ' + money(task.saved)),
                    h('span', null, clockDate(task.lastAt))
                  )
                ),
                h('button', {
                  type: 'button',
                  className: cx('ka-btn ka-btn--sm ka-btn--danger', confirming && 'is-confirm'),
                  disabled: busy,
                  title: '删除这条记录（只删记录，不影响保活开关）',
                  onClick: () => (confirming ? void remove(task.id) : setConfirmId(task.id)),
                  onMouseLeave: () => {
                    if (confirming) setConfirmId(null);
                  },
                  onBlur: () => {
                    if (confirming) setConfirmId(null);
                  }
                }, confirming ? '确认删除' : '删除')
              ),
              open
                ? (detail && detail.task && detail.task.id === task.id
                  ? h(TaskDetail, { detail })
                  : h('div', { className: 'ka-detail ' + (error ? 'ka-tone-err' : 'ka-sub') }, error || '加载中…'))
                : null
            );
          }),
          h('p', { className: 'ka-foot', style: { padding: '10px 14px', borderTop: '1px solid var(--ka-b1)' } },
            '净省 = 缓存过期后下一次请求要整段重写缓存的额外花费（写入价 − 读取价）− 该空闲期所有保活花费。只统计之后用户确实回来发了请求的空闲期；金额均为按价格表的估算，不是账单。')
        );
      }

      function TaskDetail({ detail }) {
        const task = detail.task;
        const records = (detail.records || []).slice().reverse();
        const kv = (name, value) => h('div', null, h('span', null, name), h('b', { title: String(value) }, value));
        const result = (status) => status === 'hit' ? ['ok', '命中'] : status === 'miss' ? ['warn', '未命中'] : status === 'error' ? ['err', '错误'] : ['', '未知'];
        return h('div', { className: 'ka-detail' },
          h('div', { className: 'ka-kv' },
            kv('保活次数', tokens(task.touches)),
            kv('命中 / 未命中', tokens(task.hits) + ' / ' + tokens(task.misses)),
            kv('缓存读取', tokens(task.cacheRead)),
            kv('花费', money(task.cost)),
            kv('净省', money(task.saved)),
            kv('最近一次', clockDate(task.lastAt))
          ),
          h('div', { className: 'ka-sub' }, '模型 ' + (task.provider || '?') + ' / ' + (task.model || '?') + ' · 首次 ' + clockDate(task.firstAt)),
          records.length === 0
            ? h('div', { className: 'ka-sub' }, '这条记录还没有明细。')
            : h('div', { className: 'ka-twrap' },
              h('table', { className: 'ka-table' },
                h('thead', null, h('tr', null,
                  h('th', null, '时间'), h('th', { className: 'r' }, '第几次'), h('th', null, '结果'),
                  h('th', { className: 'r' }, '缓存读取'), h('th', { className: 'r' }, '未命中'), h('th', { className: 'r' }, '输出'),
                  h('th', { className: 'r' }, '花费'), h('th', { className: 'r' }, '耗时'))),
                h('tbody', null, records.map((record, index) => {
                  const res = result(record.status);
                  return h('tr', { key: index },
                    h('td', null, clock(record.ts)),
                    h('td', { className: 'r' }, record.touch === null || record.touch === undefined ? '—' : String(record.touch)),
                    h('td', null, h('span', { className: cx('ka-chip', res[0]) }, res[1])),
                    h('td', { className: 'r' }, tokens(record.cacheRead)),
                    h('td', { className: 'r' }, tokens(record.input)),
                    h('td', { className: 'r' }, tokens(record.output)),
                    h('td', { className: 'r' }, money(record.cost)),
                    h('td', { className: 'r' }, record.ms === null || record.ms === undefined ? '—' : (record.ms / 1000).toFixed(1) + 's')
                  );
                }))
              )
            )
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

      /**
       * Hover card for one window's idle auto-compaction. Same frame/portal/delayed-close
       * mechanism as WindowTip. The countdown is the Host's compactDueSeconds (as of the
       * last poll) minus the local time elapsed since; the 1s timer exists only while
       * this card is mounted (= open).
       */
      function CompactTip({ rect, enabled, compactOn, win, minutes, receivedAt, onEnter, onLeave }) {
        const [now, setNow] = React.useState(Date.now());
        React.useEffect(() => {
          const timer = setInterval(() => setNow(Date.now()), 1000);
          return () => clearInterval(timer);
        }, []);
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
        if (rect) {
          frame.left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - 256));
          if (rect.top > 210) frame.bottom = Math.max(8, window.innerHeight - rect.top + 8);
          else frame.top = Math.min(window.innerHeight - 16, rect.bottom + 8);
        }
        const warn = 'var(--dsw-alias-state-warn-primary, #d99600)';
        // Which message to show. Keep-alive off wins: the Host only reports windows that are on.
        let status;
        if (enabled === null || compactOn === null) status = 'loading';
        else if (enabled !== true) status = 'needKeepalive';
        else if (!compactOn) status = 'off';
        else status = win && win.compactStatus ? win.compactStatus : 'loading';
        const minutesText = (win && win.compactAfterMinutes) || minutes;
        const last = win && win.lastCompaction ? win.lastCompaction : null;
        const lastAt = last && last.at ? clock(last.at) : null;
        const note = (text) => h('div', { style: { color: TIP.secondary, lineHeight: 1.6, textWrap: 'pretty' } }, text);
        let body;
        if (status === 'counting') {
          const due = win && typeof win.compactDueSeconds === 'number' ? Math.max(0, win.compactDueSeconds - (now - (receivedAt || now)) / 1000) : null;
          body = h('div', null,
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, margin: '2px 0 4px' } },
              h('span', { style: { fontSize: due !== null && due <= 0 ? 18 : 28, lineHeight: 1.15, fontWeight: 600, letterSpacing: '-0.01em', fontVariantNumeric: 'tabular-nums', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: TIP.label } },
                due === null ? '—' : due <= 0 ? '即将压缩' : countdown(due)),
              due !== null && due > 0 ? h('span', { style: { color: TIP.tertiary } }, '后压缩') : null),
            note('空闲满 ' + minutesText + ' 分钟后压缩一次，之后停止保活'));
        } else if (status === 'running') body = note('正在压缩…');
        else if (status === 'done' || status === 'manual') {
          body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
            note('已' + (status === 'manual' ? '手动' : '自动') + '压缩，倒计时已清零；下一条消息起重新计时'),
            lastAt ? h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 10 } },
              h('span', { style: { color: TIP.tertiary } }, '压缩时间'),
              h('span', { style: { fontWeight: 500, fontVariantNumeric: 'tabular-nums' } }, lastAt)) : null);
        } else if (status === 'stopped') body = note('本轮保活已停（缓存可能已过期），不会自动压缩；下一条消息起重新计时');
        else if (status === 'waiting') body = note('等待下一条消息开始计时（插件刚重载/重启，快照在内存里）');
        else if (status === 'needKeepalive') body = note('需要先开启本窗口的保活');
        else if (status === 'off') body = note('本窗口未开启自动压缩，点击开启');
        else body = note('正在读取本窗口状态…');
        const stateText = status === 'loading' ? '读取中' : status === 'needKeepalive' || status === 'off' ? '本窗口关' : '本窗口开';
        return ReactDOM.createPortal(
          h('div', {
            'data-plugin': 'cache-keepalive-compact-tip',
            role: 'tooltip',
            style: frame,
            onMouseEnter: onEnter,
            onMouseLeave: onLeave
          },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 } },
              h('span', { style: { width: 7, height: 7, borderRadius: '50%', background: status === 'counting' || status === 'running' ? warn : 'rgba(127,127,127,0.55)', display: 'inline-block' } }),
              h('strong', { style: { fontSize: 12 } }, '空闲后自动压缩'),
              h('span', { style: { color: TIP.tertiary } }, stateText)
            ),
            body,
            h('div', { style: { marginTop: 7, paddingTop: 6, borderTop: '1px solid ' + TIP.border, color: TIP.tertiary } },
              '压缩期间若有新消息会排队到压缩结束；手动 /compact 的处理见设置页。')
          ),
          document.body
        );
      }

      // One compact start/pause pill beside the message composer. It controls
      // ONLY the conversation it renders in: the Host stores a per-session switch,
      // so toggling one window never changes another.
      function ComposerButton({ sessionId }) {
        const { state, refresh, receivedAt } = useStatus();
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
        // Per-window compaction switch (same explicit-then-default rule as keep-alive).
        const [compactPending, setCompactPending] = React.useState(null);
        const compactBusy = React.useRef(false);
        const compactExplicit = config && config.sessionCompact && Object.prototype.hasOwnProperty.call(config.sessionCompact, sessionId)
          ? config.sessionCompact[sessionId] === true
          : null;
        const compactStored = config === null ? null : compactExplicit === null ? config.compactEnabled === true : compactExplicit;
        const compactOn = compactPending === null ? compactStored : compactPending;
        React.useEffect(() => {
          if (compactPending !== null && compactStored === compactPending) setCompactPending(null);
        }, [compactPending, compactStored]);
        const toggleCompact = async () => {
          if (compactBusy.current || compactOn === null || enabled !== true || typeof sessionId !== 'string' || sessionId.length === 0) return;
          compactBusy.current = true;
          const next = !compactOn;
          setCompactPending(next);
          try {
            const res = await fetch(API + '/session', {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-keepalive': '1' },
              body: JSON.stringify({ session: sessionId, compact: next })
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            await refresh();
            setCompactPending(null);
          } catch {
            setCompactPending(null);
          } finally {
            compactBusy.current = false;
          }
        };
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
        // Same hover-card plumbing for the 压缩 half (own anchor, own delayed close).
        const [ctip, setCtip] = React.useState(null);
        const compactRef = React.useRef(null);
        const compactHide = React.useRef(null);
        React.useEffect(() => () => {
          if (compactHide.current !== null) clearTimeout(compactHide.current);
        }, []);
        React.useEffect(() => {
          if (ctip === null) return undefined;
          const close = () => setCtip(null);
          window.addEventListener('resize', close);
          return () => window.removeEventListener('resize', close);
        }, [ctip]);
        const openCompactTip = () => {
          if (compactHide.current !== null) {
            clearTimeout(compactHide.current);
            compactHide.current = null;
          }
          const node = compactRef.current;
          let rect = null;
          try {
            rect = node && typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
          } catch {
            rect = null;
          }
          setCtip({ rect });
        };
        const closeCompactTip = () => {
          if (compactHide.current !== null) clearTimeout(compactHide.current);
          compactHide.current = setTimeout(() => {
            compactHide.current = null;
            setCtip(null);
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
              headers: { 'content-type': 'application/json', 'x-keepalive': '1' },
              body: JSON.stringify({ session: sessionId, enabled: next })
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            // Re-read the server's value and drop the optimistic one either way, so a
            // value the server did not adopt can never leave the pill stuck on "pending".
            await refresh();
            setPending(null);
          } catch {
            setPending(null);
          } finally {
            setBusy(false);
          }
        };
        const missing = typeof sessionId !== 'string' || sessionId.length === 0;
        const interval = (state && state.windows && state.windows[sessionId] && state.windows[sessionId].intervalMinutes) || (config && config.intervalMinutes) || 4;
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
            padding: '2px 9px 2px 10px',
            margin: 0,
            color: 'inherit',
            background: enabled === true ? 'rgba(63,191,111,0.14)' : 'transparent',
            border: 'none',
            borderRadius: 0,
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

        const compactMinutes = (config && config.compactAfterMinutes) || 20;
        const compactDim = missing || enabled !== true;
        const compactPill = missing ? null : h('button', {
          type: 'button',
          'data-plugin': 'cache-keepalive-compact-toggle',
          ref: compactRef,
          title: canFloat
            ? undefined
            : enabled !== true
            ? '空闲自动压缩：需要先开启本窗口的「保活」'
            : compactOn
              ? '空闲自动压缩：已开启（保活期间空闲满 ' + compactMinutes + ' 分钟压缩一次并停止保活），点击关闭'
              : '空闲自动压缩：已关闭，点击开启（空闲满 ' + compactMinutes + ' 分钟压缩一次）',
          'aria-label': '空闲自动压缩开关（仅本会话）',
          // aria-disabled (not disabled): a disabled button swallows hover, and the card must explain why it is dim.
          'aria-disabled': compactDim ? 'true' : undefined,
          disabled: compactOn === null,
          onClick: toggleCompact,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            flex: '0 0 auto',
            whiteSpace: 'nowrap',
            writingMode: 'horizontal-tb',
            padding: '2px 10px 2px 9px',
            margin: 0,
            color: 'inherit',
            background: compactOn === true && !compactDim ? 'rgba(217,150,0,0.14)' : 'transparent',
            border: 'none',
            borderRadius: 0,
            cursor: compactDim ? 'default' : 'pointer',
            font: 'inherit',
            fontSize: 12,
            lineHeight: 1.5,
            opacity: compactDim ? 0.4 : compactOn === true ? 1 : 0.65
          }
        },
          h('span', { style: { width: 6, height: 6, borderRadius: '50%', background: compactOn === true && !compactDim ? '#d99600' : 'rgba(127,127,127,0.55)', display: 'inline-block', flex: '0 0 auto' } }),
          h('span', null, compactOn === true ? '压缩 ' + compactMinutes + 'm' : '压缩')
        );

        // One oval holding both switches, split by a thin vertical rule.
        const oval = (...parts) => h('span', {
          'data-plugin': 'cache-keepalive-oval',
          style: {
            display: 'inline-flex',
            alignItems: 'stretch',
            flex: '0 0 auto',
            whiteSpace: 'nowrap',
            margin: '0 4px',
            border: '1px solid rgba(127,127,127,0.3)',
            borderRadius: 999,
            overflow: 'hidden'
          }
        }, ...parts);
        const divider = h('span', { style: { width: 1, alignSelf: 'stretch', background: 'rgba(127,127,127,0.3)', flex: '0 0 auto' } });
        if (!canFloat || missing) return oval(pill, compactPill === null ? null : divider, compactPill);
        const keepAlivePill = h('span', {
          style: { display: 'inline-flex', alignItems: 'stretch', flex: '0 0 auto', whiteSpace: 'nowrap' },
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
            interval: (state && state.windows && state.windows[sessionId] && state.windows[sessionId].intervalMinutes) || interval,
            onEnter: openTip,
            onLeave: closeTip
          })
        );
        const compactWrapped = h('span', {
          style: { display: 'inline-flex', alignItems: 'stretch', flex: '0 0 auto', whiteSpace: 'nowrap' },
          onMouseEnter: openCompactTip,
          onMouseLeave: closeCompactTip,
          onFocus: openCompactTip,
          onBlur: closeCompactTip
        },
          compactPill,
          ctip === null ? null : h(CompactTip, {
            rect: ctip.rect,
            enabled: enabled === null ? null : enabled === true,
            compactOn,
            win: state && state.windows ? state.windows[sessionId] : null,
            minutes: compactMinutes,
            receivedAt,
            onEnter: openCompactTip,
            onLeave: closeCompactTip
          })
        );
        return oval(keepAlivePill, divider, compactWrapped);
      }

      // Page body of the Cmd+, Settings section: the same card as the Plugins page, in page view.
      function KeepaliveSettingsSection() {
        return h('div', { style: { padding: '4px 4px 28px', maxWidth: 820, fontFamily: 'var(--dsw-font-family, inherit)' }, 'data-plugin': 'cache-keepalive-section' },
          h('h2', { style: { margin: '0 0 4px', fontSize: 18, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--dsw-alias-label-primary, #101828)' } }, '缓存保活'),
          h('p', { style: { margin: '0 0 18px', fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary, #4a5565)' } }, '空闲时自动重放最近一次请求，保持提示词缓存有效；可选空闲后自动压缩。每个对话窗口在输入框旁单独开关。'),
          h(StatusCard, { view: 'page' }));
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
            ctx.slots.inject('settings.section', () => {
              try {
                report('section-slot-inject');
                return ctx.slots.register(
                  { name: 'settings.section', id: 'cache-keepalive', order: 40, label: () => '缓存保活' },
                  KeepaliveSettingsSection
                );
              } catch (error) {
                report('section-register-error', (error && error.message) || error);
                return undefined;
              }
            });
            // Also list the same card on the sidebar Plugins page (Official group) as its own entry.
            ctx.slots.inject('plugins.item', () => {
              try {
                report('item-slot-inject');
                return ctx.slots.register(
                  {
                    name: 'plugins.item',
                    id: 'cache-keepalive',
                    order: 90,
                    label: () => '缓存保活'
                  },
                  StatusCard
                );
              } catch (error) {
                report('item-register-error', (error && error.message) || error);
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
