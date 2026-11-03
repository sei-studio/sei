// Dev probe: open a URL on the private display, wait, screenshot, print a
// short page summary. Usage: node probe-page.mjs <display> <url> <outPng> [waitMs]
import { startDisplay, startChrome } from './env.mjs';
import { screenshot } from './input.mjs';
const [display, url, out, wait = '8000'] = process.argv.slice(2);
const d = await startDisplay(Number(display));
const c = await startChrome({ display: Number(display), url });
await new Promise((r) => setTimeout(r, Number(wait)));
const info = await c.page.evaluate(() => ({
  title: document.title,
  canvases: document.querySelectorAll('canvas').length,
  text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 400),
  buttons: [...document.querySelectorAll('button')].slice(0, 12).map((b) => b.innerText.trim().slice(0, 30)),
  inputs: [...document.querySelectorAll('input')].slice(0, 6).map((i) => i.type + ':' + (i.placeholder || i.name || i.id)),
}));
console.log(JSON.stringify(info));
await screenshot(Number(display), out);
await c.stop(); d.stop();
