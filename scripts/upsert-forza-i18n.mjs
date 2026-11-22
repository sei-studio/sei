// upsert-only i18n forza4 keys (plain ESM, no TS types)
import fs from 'node:fs';
import path from 'node:path';

const FORZA_KEYS = [
  'Companion',
  'Forza 4 is not available in this build yet.',
  "The game couldn't start. Try again in a moment.",
  'Forza 4 with {name}',
  'Forza 4',
  'Your side',
  'Red',
  'Yellow',
  'Random',
  'Starting…',
  'Start',
  'Launch',
  'Empty cell, row {r}, column {c}',
  'Red piece',
  'Yellow piece',
  "It's your turn, {name}",
  "{name}'s turn",
  'Resign?',
  'Yes',
  'No',
  'Resign',
  'Draw',
  'You won',
  '{name} won',
  'Four in a row.',
  'The board is full.',
  'This game ended without a result.',
  'Rematch',
];

const LOCALES = ['es', 'it', 'ja', 'pt-BR', 'ru', 'zh'];
const DIR = path.join(process.cwd(), 'src/renderer/src/lib/i18n');

const kvRe = /"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

for (const locale of LOCALES) {
  const file = path.join(DIR, locale + '.ts');
  let text = fs.readFileSync(file, 'utf8');

  const existing = new Set();
  let m;
  while ((m = kvRe.exec(text)) !== null) {
    existing.add(m[1]);
  }

  const missing = FORZA_KEYS.filter(function (k) { return !existing.has(k); });
  if (missing.length === 0) {
    console.log(locale + ': no missing keys');
    continue;
  }

  var block = missing.map(function (k) { return '  "' + k + '": "' + k + '",'; }).join('\n');

  var idx = text.lastIndexOf('};');
  if (idx === -1) {
    console.warn(locale + ': closing }; not found, skipping');
    continue;
  }
  var before = text.slice(0, idx);
  var after = text.slice(idx);
  var next = before + block + '\n' + after;

  fs.writeFileSync(file, next, 'utf8');
  console.log(locale + ': added ' + missing.length + ' keys: ' + missing.join(', '));
}

console.log('done');
