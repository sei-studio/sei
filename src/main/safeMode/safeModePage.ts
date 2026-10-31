/**
 * The safe-mode screen's page (261031, T277): one self-contained HTML
 * document, loaded as a data: URL so it needs nothing from the renderer
 * bundle (which may be the thing that is broken). Pure: no electron import,
 * unit tested in safeModePage.test.ts.
 *
 * The page talks to main only through `window.seiSafeMode`
 * (src/preload/safeMode.ts): `action(name)` for the four buttons and the
 * update steps, `onUpdate(cb)` for the updater's pushes, `ready()` once it
 * listens. CSP: nothing external, inline style + script only.
 *
 * User copy rules: plain and short, no em dashes.
 */

export type SafeModeLang = 'en' | 'zh';
export type SafeModeTheme = 'system' | 'dark' | 'light';
/** Why safe mode is up, as the page words it. */
export type SafeModeCause = 'repeated' | 'forced';

export interface SafeModePageOptions {
  lang: SafeModeLang;
  cause: SafeModeCause;
  theme: SafeModeTheme;
  version: string;
  /** False in dev: updates only work in the installed app. */
  packaged: boolean;
}

/** Every string the page shows. `{v}` = a version, `{p}` = a percent. */
export const SAFE_MODE_COPY = {
  en: {
    docTitle: 'Sei safe mode',
    title: 'Sei had trouble starting',
    bodyRepeated:
      "Sei didn't start properly twice in a row, so it opened in safe mode. Games, overlays and voice are turned off for now.",
    bodyForced: 'Sei opened in safe mode because it was started that way. Games, overlays and voice are turned off for now.',
    updatesHeading: 'Updates',
    updatesHint: 'A newer version may already fix this.',
    check: 'Check for updates',
    checking: 'Checking for updates...',
    available: 'Sei {v} is available.',
    download: 'Download update',
    downloading: 'Downloading the update... {p}%',
    ready: 'The update is ready.',
    install: 'Restart to update',
    installing: 'Installing the update. Sei will restart in a moment.',
    upToDate: "You're on the latest version ({v}).",
    updateError: "Couldn't check for updates. Check your connection and try again.",
    updatesDev: 'Updates only work in the installed app.',
    otherHeading: 'Other things to try',
    openLogs: 'Open logs folder',
    openLogsError: "Couldn't open the logs folder.",
    reset: 'Reset settings',
    resetHint: 'Puts your preferences back to their defaults.',
    resetConfirm:
      'Reset your settings? Things like theme, voice, overlay and game options go back to their defaults. Your companions, chats and account stay as they are.',
    resetYes: 'Reset',
    resetNo: 'Cancel',
    resetDone: 'Settings reset. Try a normal start to see if that fixed it.',
    resetError: "Couldn't reset your settings.",
    normal: 'Try normal start',
    normalHint: 'Sei restarts and tries to start normally once.',
    logsHint: 'If this keeps happening, the newest file there helps us find out why.',
    versionLine: 'Version {v}',
  },
  zh: {
    docTitle: 'Sei 安全模式',
    title: 'Sei 启动时遇到了问题',
    bodyRepeated: 'Sei 连续两次没能正常启动，所以这次以安全模式打开。游戏、悬浮窗和语音暂时关闭。',
    bodyForced: 'Sei 这次是以安全模式启动的。游戏、悬浮窗和语音暂时关闭。',
    updatesHeading: '更新',
    updatesHint: '新版本可能已经修复了这个问题。',
    check: '检查更新',
    checking: '正在检查更新...',
    available: 'Sei {v} 可以更新了。',
    download: '下载更新',
    downloading: '正在下载更新... {p}%',
    ready: '更新已准备好。',
    install: '重启并更新',
    installing: '正在安装更新，Sei 马上会重启。',
    upToDate: '已经是最新版本（{v}）。',
    updateError: '无法检查更新。请检查网络连接后再试一次。',
    updatesDev: '只有安装版可以更新。',
    otherHeading: '还可以试试',
    openLogs: '打开日志文件夹',
    openLogsError: '无法打开日志文件夹。',
    reset: '重置设置',
    resetHint: '把你的偏好设置恢复为默认。',
    resetConfirm: '要重置设置吗？主题、语音、悬浮窗和游戏选项等会恢复默认。你的伙伴、聊天记录和账号不受影响。',
    resetYes: '重置',
    resetNo: '取消',
    resetDone: '设置已重置。试试正常启动，看看问题是否解决。',
    resetError: '无法重置设置。',
    normal: '正常启动',
    normalHint: 'Sei 会重启，并尝试正常启动一次。',
    logsHint: '如果问题一直出现，那里最新的文件能帮我们找到原因。',
    versionLine: '版本 {v}',
  },
} as const satisfies Record<SafeModeLang, Record<string, string>>;

export type SafeModeCopy = (typeof SAFE_MODE_COPY)['en'];

/** zh for a Chinese system locale, else English. */
export function safeModeLang(locale: string | null | undefined): SafeModeLang {
  return typeof locale === 'string' && locale.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** The app theme_mode setting to the page theme (unknown = follow the system). */
export function safeModeTheme(themeMode: unknown): SafeModeTheme {
  if (themeMode === 'midnight' || themeMode === 'dark') return 'dark';
  if (themeMode === 'ice' || themeMode === 'acorn' || themeMode === 'mint' || themeMode === 'light') return 'light';
  return 'system';
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** JSON safe to inline inside a <script> element. */
function inlineJson(v: unknown): string {
  return JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export const SAFE_MODE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

const STYLE = `
:root {
  --bg: #04070f; --surface: #0b1424; --surface-2: #13203a; --text: #e9e7e1; --muted: #8f9bb0;
  --accent: #7fb0ff; --accent-strong: #a3c6ff; --accent-text: #08101f;
  --danger: #e8746b; --danger-text: #1a0806; --ok: #7fd1a3;
  color-scheme: dark;
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    --bg: #f3f8ff; --surface: #ffffff; --surface-2: #e4eefc; --text: #2a3340; --muted: #6f84a0;
    --accent: #3f6fc4; --accent-strong: #335da6; --accent-text: #ffffff;
    --danger: #c0443c; --danger-text: #ffffff; --ok: #2f8a58;
    color-scheme: light;
  }
}
:root[data-theme="light"] {
  --bg: #f3f8ff; --surface: #ffffff; --surface-2: #e4eefc; --text: #2a3340; --muted: #6f84a0;
  --accent: #3f6fc4; --accent-strong: #335da6; --accent-text: #ffffff;
  --danger: #c0443c; --danger-text: #ffffff; --ok: #2f8a58;
  color-scheme: light;
}
:root[data-theme="dark"] {
  --bg: #04070f; --surface: #0b1424; --surface-2: #13203a; --text: #e9e7e1; --muted: #8f9bb0;
  --accent: #7fb0ff; --accent-strong: #a3c6ff; --accent-text: #08101f;
  --danger: #e8746b; --danger-text: #1a0806; --ok: #7fd1a3;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  background: var(--bg); color: var(--text);
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Roboto, sans-serif;
  display: flex; flex-direction: column; -webkit-user-select: none; user-select: none;
}
.drag { height: 28px; flex: 0 0 auto; -webkit-app-region: drag; }
main { flex: 1 1 auto; overflow-y: auto; padding: 4px 32px 24px; }
h1 { font-size: 22px; line-height: 1.25; margin: 0 0 8px; font-weight: 650; }
.lead { margin: 0 0 22px; color: var(--muted); max-width: 52ch; }
section { background: var(--surface); border-radius: 10px; padding: 16px 18px; margin: 0 0 14px; }
h2 { font-size: 12px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin: 0 0 10px; font-weight: 600; }
.status { margin: 0 0 12px; min-height: 21px; }
.status.err { color: var(--danger); }
.status.ok { color: var(--ok); }
.row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.item { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 8px 0; }
.item + .item { margin-top: 2px; }
.item p { margin: 0; color: var(--muted); font-size: 13px; }
button {
  font: inherit; font-weight: 600; border: 0; border-radius: 8px; padding: 8px 16px; cursor: pointer;
  background: var(--surface-2); color: var(--text); white-space: nowrap; -webkit-app-region: no-drag;
}
button:hover { filter: brightness(1.12); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
button:disabled { opacity: .5; cursor: default; filter: none; }
button.primary { background: var(--accent); color: var(--accent-text); }
button.danger { background: var(--danger); color: var(--danger-text); }
.confirm { background: var(--surface-2); border-radius: 8px; padding: 12px 14px; margin-top: 8px; }
.confirm p { margin: 0 0 10px; color: var(--text); }
.bar { height: 4px; border-radius: 2px; background: var(--surface-2); overflow: hidden; margin: -4px 0 12px; }
.bar > i { display: block; height: 100%; width: 0; background: var(--accent); transition: width .3s; }
[hidden] { display: none !important; }
footer { color: var(--muted); font-size: 12px; padding: 0 32px 18px; display: flex; justify-content: space-between; gap: 12px; }
@media (max-width: 480px) {
  main { padding: 4px 16px 20px; }
  footer { padding: 0 16px 16px; flex-direction: column; }
  .item { flex-direction: column; align-items: stretch; }
}
`;

/**
 * The page script. Plain ES2017, no modules. `C` = copy, `O` = options.
 * States: idle | checking | available | downloading | ready | installing |
 * none | error | dev.
 */
const SCRIPT = `
(function () {
  var C = window.__SEI_COPY__, O = window.__SEI_OPTS__;
  var api = window.seiSafeMode;
  var $ = function (id) { return document.getElementById(id); };
  var fill = function (s, v, p) { return s.replace('{v}', v == null ? '' : String(v)).replace('{p}', p == null ? '' : String(p)); };
  var st = { kind: O.packaged ? 'idle' : 'dev', version: '', percent: 0 };

  function renderUpdate() {
    var s = $('upd-status'), check = $('btn-check'), dl = $('btn-download'), inst = $('btn-install'), bar = $('upd-bar');
    s.className = 'status';
    dl.hidden = true; inst.hidden = true; bar.hidden = true; check.hidden = false; check.disabled = false;
    switch (st.kind) {
      case 'idle': s.textContent = C.updatesHint; break;
      case 'dev': s.textContent = C.updatesDev; check.disabled = true; break;
      case 'checking': s.textContent = C.checking; check.disabled = true; break;
      case 'available': s.textContent = fill(C.available, st.version); dl.hidden = false; check.hidden = true; break;
      case 'downloading':
        s.textContent = fill(C.downloading, null, Math.max(0, Math.min(100, Math.round(st.percent))));
        bar.hidden = false; $('upd-bar-fill').style.width = Math.max(0, Math.min(100, st.percent)) + '%';
        check.hidden = true; break;
      case 'ready': s.textContent = C.ready; s.className = 'status ok'; inst.hidden = false; check.hidden = true; break;
      case 'installing': s.textContent = C.installing; check.hidden = true; break;
      case 'none': s.textContent = fill(C.upToDate, O.version); s.className = 'status ok'; break;
      case 'error': s.textContent = C.updateError; s.className = 'status err'; break;
    }
  }

  function note(id, text, cls) { var el = $(id); el.textContent = text || ''; el.className = 'status' + (cls ? ' ' + cls : ''); el.hidden = !text; }

  function run(name) {
    if (!api) return Promise.resolve({ ok: false });
    return api.action(name).then(function (r) { return r || { ok: false }; }, function () { return { ok: false }; });
  }

  if (api) {
    api.onUpdate(function (kind, p) {
      if (kind === 'checking') st.kind = 'checking';
      else if (kind === 'not-available') st.kind = O.packaged ? 'none' : 'dev';
      else if (kind === 'available') { st.kind = 'available'; st.version = (p && p.version) || ''; }
      else if (kind === 'progress') { st.kind = 'downloading'; st.percent = (p && typeof p.percent === 'number') ? p.percent : 0; }
      else if (kind === 'downloaded') st.kind = (p && p.forced) ? 'installing' : 'ready';
      else if (kind === 'error') { if (st.kind !== 'ready' && st.kind !== 'installing') st.kind = 'error'; }
      renderUpdate();
    });
  }

  $('btn-check').addEventListener('click', function () { st.kind = 'checking'; renderUpdate(); run('check'); });
  $('btn-download').addEventListener('click', function () { st.kind = 'downloading'; st.percent = 0; renderUpdate(); run('download'); });
  $('btn-install').addEventListener('click', function () { st.kind = 'installing'; renderUpdate(); run('install'); });
  $('btn-logs').addEventListener('click', function () {
    note('other-status', '');
    run('open-logs').then(function (r) { if (!r.ok) note('other-status', C.openLogsError, 'err'); });
  });
  $('btn-reset').addEventListener('click', function () {
    var box = $('reset-confirm');
    box.hidden = false; $('btn-reset').disabled = true; $('btn-reset-no').focus();
    if (box.scrollIntoView) box.scrollIntoView({ block: 'nearest' });
  });
  $('btn-reset-no').addEventListener('click', function () { $('reset-confirm').hidden = true; $('btn-reset').disabled = false; });
  $('btn-reset-yes').addEventListener('click', function () {
    $('btn-reset-yes').disabled = true;
    run('reset-settings').then(function (r) {
      $('reset-confirm').hidden = true; $('btn-reset-yes').disabled = false; $('btn-reset').disabled = false;
      note('other-status', r.ok ? C.resetDone : C.resetError, r.ok ? 'ok' : 'err');
    });
  });
  $('btn-normal').addEventListener('click', function () { $('btn-normal').disabled = true; run('normal-start'); });

  renderUpdate();
  if (api) {
    api.ready();
    if (O.packaged) { st.kind = 'checking'; renderUpdate(); run('check'); }
  }
})();
`;

/** Render the whole page. */
export function renderSafeModeHtml(opts: SafeModePageOptions): string {
  const c: SafeModeCopy = SAFE_MODE_COPY[opts.lang] as SafeModeCopy;
  const e = escapeHtml;
  const body = opts.cause === 'forced' ? c.bodyForced : c.bodyRepeated;
  const themeAttr = opts.theme === 'system' ? '' : ` data-theme="${opts.theme}"`;
  return `<!doctype html>
<html lang="${opts.lang === 'zh' ? 'zh-CN' : 'en'}"${themeAttr}>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${e(SAFE_MODE_CSP)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(c.docTitle)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="drag"></div>
<main>
  <h1>${e(c.title)}</h1>
  <p class="lead">${e(body)}</p>
  <section aria-labelledby="h-upd">
    <h2 id="h-upd">${e(c.updatesHeading)}</h2>
    <p class="status" id="upd-status" role="status" aria-live="polite"></p>
    <div class="bar" id="upd-bar" hidden><i id="upd-bar-fill"></i></div>
    <div class="row">
      <button class="primary" id="btn-check" data-action="check">${e(c.check)}</button>
      <button class="primary" id="btn-download" data-action="download" hidden>${e(c.download)}</button>
      <button class="primary" id="btn-install" data-action="install" hidden>${e(c.install)}</button>
    </div>
  </section>
  <section aria-labelledby="h-other">
    <h2 id="h-other">${e(c.otherHeading)}</h2>
    <div class="item">
      <p>${e(c.normalHint)}</p>
      <button id="btn-normal" data-action="normal-start">${e(c.normal)}</button>
    </div>
    <div class="item">
      <p>${e(c.resetHint)}</p>
      <button id="btn-reset" data-action="reset-settings">${e(c.reset)}</button>
    </div>
    <div class="confirm" id="reset-confirm" hidden>
      <p>${e(c.resetConfirm)}</p>
      <div class="row">
        <button class="danger" id="btn-reset-yes">${e(c.resetYes)}</button>
        <button id="btn-reset-no">${e(c.resetNo)}</button>
      </div>
    </div>
    <div class="item">
      <p>${e(c.logsHint)}</p>
      <button id="btn-logs" data-action="open-logs">${e(c.openLogs)}</button>
    </div>
    <p class="status" id="other-status" role="status" aria-live="polite" hidden></p>
  </section>
</main>
<footer><span>${e(c.versionLine.replace('{v}', opts.version))}</span></footer>
<script>window.__SEI_COPY__=${inlineJson(c)};window.__SEI_OPTS__=${inlineJson({ version: opts.version, packaged: opts.packaged })};</script>
<script>${SCRIPT}</script>
</body>
</html>`;
}

/** The page as a data: URL for BrowserWindow.loadURL. */
export function safeModeDataUrl(opts: SafeModePageOptions): string {
  return 'data:text/html;charset=utf-8;base64,' + Buffer.from(renderSafeModeHtml(opts), 'utf8').toString('base64');
}
