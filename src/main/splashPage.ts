/**
 * The update splash page (261030, split out of windowChrome.ts 261108): pure,
 * no electron import, so it renders headless and unit-tests on any host.
 *
 * Since product call (261108) the splash only appears on the Windows update
 * screen: the window Sei shows while it hands over to Update.exe, the PNG
 * overlay frames Update.exe draws while it applies (velopackUpdater.ts), and
 * the same page the restarted Sei shows until its main window is up. A normal
 * launch shows no splash: the main window itself appears once it has painted.
 */

/** Splash window size in DIPs. The Windows update overlay frames are rendered at exactly this size too. */
export const SPLASH_SIZE = { width: 320, height: 170 } as const;

/**
 * How the white status line stays readable on a light desktop (product call
 * 261108). Switching variants is this one line; bump FRAMES_VERSION in
 * velopackUpdater.ts with it so cached overlay frames are rendered again.
 *  - 'pill':   a translucent Sei light blue rounded backdrop behind the line.
 *  - 'shadow': no backdrop, a strong dark shadow under the line and the logo.
 *  - 'glow':   no backdrop, a large Sei light blue glow under the line and the logo.
 */
export type SplashStatusStyle = 'pill' | 'shadow' | 'glow';
export const SPLASH_STATUS_STYLE: SplashStatusStyle = 'pill';

/** Sei's light blue: the light theme's chrome periwinkle (--rail / --elbow #7fb0ff in tokens.css). */
export const SEI_LIGHT_BLUE_RGB = '127,176,255';
/** A deeper step of the same blue for the inner edge of the 'glow' style, so white text holds an edge on white. */
export const GLOW_RGB = '74,134,232';

/** Status pill geometry in DIPs (the 'pill' style). Fill only, no border. */
export const STATUS_PILL = {
  top: 134,
  height: 24,
  padX: 11,
  maxWidth: SPLASH_SIZE.width - 4,
  alpha: 0.9,
} as const;

/** Smallest font the status line shrinks to when a long translation does not fit. */
export const STATUS_MIN_FONT_PX = 10;

/** The logo: 92 DIP tall, centered above the status line (top 34, bottom 126). */
export const SPLASH_LOGO_HEIGHT = 92;
export const SPLASH_LOGO_TOP = 34;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const STATUS_FONT = "600 13px 'Segoe UI','Microsoft YaHei UI','Microsoft YaHei',system-ui,sans-serif";

/**
 * Shrinks the status line until it fits the splash width: the longest
 * translations (ja error line, ru time estimates) run close to 320 px at 13 px,
 * and the pill's padding must never cut them off. Runs before the first paint
 * and again once fonts are in.
 */
const FIT_SCRIPT =
  '<script>(()=>{const s=document.getElementById("status");if(!s)return;' +
  `const fit=()=>{let f=13;s.style.fontSize=f+"px";while(s.scrollWidth>s.clientWidth+0.5&&f>${STATUS_MIN_FONT_PX}){f-=0.5;s.style.fontSize=f+"px"}};` +
  'fit();document.fonts&&document.fonts.ready.then(fit)})()</script>';

/** The logo's filter: glyphs forced to white, with a shadow that keeps them on a light desktop. */
function logoFilter(style: SplashStatusStyle): string {
  // brightness(0) forces the glyphs to black regardless of source color
  // before invert(1) lifts them to white.
  const shadow =
    style === 'shadow'
      ? 'drop-shadow(0 0 1px rgba(0,0,0,.7)) drop-shadow(0 2px 8px rgba(0,0,0,.6))'
      : style === 'glow'
        ? `drop-shadow(0 0 2px rgba(${GLOW_RGB},.95)) drop-shadow(0 0 10px rgba(${SEI_LIGHT_BLUE_RGB},.9))`
        : 'drop-shadow(0 0 1px rgba(30,50,90,.45)) drop-shadow(0 2px 10px rgba(14,22,36,.5))';
  return `brightness(0) invert(1) ${shadow}`;
}

function statusHtml(status: string, style: SplashStatusStyle): string {
  const text = escapeHtml(status);
  if (style === 'glow') {
    return (
      `<div id="status" style="position:absolute;left:2px;right:2px;top:${STATUS_PILL.top + 3}px;text-align:center;color:#fff;` +
      `font:${STATUS_FONT};letter-spacing:.2px;white-space:nowrap;` +
      `text-shadow:0 0 1px rgba(${GLOW_RGB},1),0 0 1px rgba(${GLOW_RGB},1),0 0 2px rgba(${GLOW_RGB},1),0 0 4px rgba(${GLOW_RGB},1),0 0 8px rgba(${SEI_LIGHT_BLUE_RGB},1),0 0 14px rgba(${SEI_LIGHT_BLUE_RGB},1),0 0 22px rgba(${SEI_LIGHT_BLUE_RGB},.8)">` +
      `${text}</div>`
    );
  }
  if (style === 'shadow') {
    return (
      `<div id="status" style="position:absolute;left:2px;right:2px;top:${STATUS_PILL.top + 3}px;text-align:center;color:#fff;` +
      `font:${STATUS_FONT};letter-spacing:.2px;white-space:nowrap;` +
      'text-shadow:0 0 2px rgba(0,0,0,.95),0 1px 3px rgba(0,0,0,.85),0 0 10px rgba(0,0,0,.6)">' +
      `${text}</div>`
    );
  }
  const p = STATUS_PILL;
  return (
    `<div style="position:absolute;left:0;right:0;top:${p.top}px;display:flex;justify-content:center">` +
    `<div id="status" style="box-sizing:border-box;max-width:${p.maxWidth}px;height:${p.height}px;` +
    `line-height:${p.height}px;padding:0 ${p.padX}px;border-radius:${p.height / 2}px;` +
    `background:rgba(${SEI_LIGHT_BLUE_RGB},${p.alpha});color:#fff;font:${STATUS_FONT};letter-spacing:.2px;` +
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
    `text-shadow:0 1px 2px rgba(14,22,36,.5)">${text}</div></div>`
  );
}

/**
 * The splash page. No card: the white logo floats on the desktop (the window
 * is transparent), with the small status line under it ("Updating…", a time
 * estimate, the error line). Shown without a fade: it must look identical to
 * the overlay frame Update.exe showed a moment before.
 *
 * Exported for the update overlay frames, which render this same page.
 */
export function splashHtml(logoB64: string, opts: { status?: string; style?: SplashStatusStyle } = {}): string {
  const style = opts.style ?? SPLASH_STATUS_STYLE;
  return (
    '<!doctype html><meta charset="utf-8"><style>' +
    'html,body{margin:0;height:100%;background:transparent;overflow:hidden}' +
    'body{position:relative}' +
    '</style><body>' +
    `<div style="position:absolute;left:0;right:0;top:${SPLASH_LOGO_TOP}px;display:flex;justify-content:center">` +
    `<img alt="Sei" style="height:${SPLASH_LOGO_HEIGHT}px;filter:${logoFilter(style)};image-rendering:pixelated" ` +
    `src="data:image/png;base64,${logoB64}"></div>` +
    (opts.status ? statusHtml(opts.status, style) + FIT_SCRIPT : '') +
    '</body>'
  );
}

/**
 * The status line for this launch's splash, or undefined for no splash at all.
 * product call (261108): a normal launch no longer shows the floating Sei
 * logo; only a launch right after Update.exe restarted Sei does ("Updating…"
 * or the error line, read once by `readUpdateStatus`). A login launch shows
 * nothing until Sei is opened, and does not consume the update note.
 */
export function launchSplashStatus(login: boolean, readUpdateStatus: () => string | undefined): string | undefined {
  if (login) return undefined;
  return readUpdateStatus() || undefined;
}

/**
 * Milliseconds from process start to now, for the startup timing event.
 * `creationTimeMs` is the browser process's creation time (app.getAppMetrics),
 * when known; otherwise process.uptime() stands in.
 */
export function msSinceProcessStart(nowMs: number, creationTimeMs: number | undefined, uptimeSec: number): number {
  const fromCreation = creationTimeMs && creationTimeMs > 0 && creationTimeMs <= nowMs ? nowMs - creationTimeMs : null;
  return Math.max(0, Math.round(fromCreation ?? uptimeSec * 1000));
}
