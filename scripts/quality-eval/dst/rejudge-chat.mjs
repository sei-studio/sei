#!/usr/bin/env node
// Re-judge errand_chat reps from an arm's run.out log with the same rule
// run.ts uses now: every line she says in the 15 s after "how's it going?".
// Lets an arm recorded before that rule change be scored like the others.
// usage: node rejudge-chat.mjs <out-dir>/<arm>.run.out
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

const file = process.argv[2];
const key = readFileSync(path.join(os.homedir(), '.sei-dev', 'anthropic-test-key'), 'utf8').trim();
const client = new Anthropic({ apiKey: key });
const PRICE = { in: 0.10, out: 0.50 };
const Q = "how's it going?";

const reps = new Map();
for (const line of readFileSync(file, 'utf8').split('\n')) {
  const m = /^\[(\d+)s\]\s+\[(errand_chat-\d+)\] (Steve|Sui): (.*)$/.exec(line);
  if (!m) continue;
  const [, t, rep, who, text] = m;
  const r = reps.get(rep) ?? { askAt: null, lines: [] };
  if (who === 'Steve' && text.trim() === Q) r.askAt = Number(t);
  else if (who === 'Sui' && r.askAt != null && Number(t) <= r.askAt + 15) r.lines.push(text);
  reps.set(rep, r);
}

let usd = 0, ok = 0, n = 0;
for (const [rep, r] of reps) {
  if (r.askAt == null) continue;
  n++;
  const reply = r.lines.join(' / ');
  let verdict = 'NO\nno reply within 15 s';
  if (reply) {
    const prompt = `A player in Don't Starve Together asked their AI companion to fetch 10 twigs. While she was out picking saplings, the player typed: "${Q}"\nHer chat lines in the next 15 seconds, in order, were: "${reply}"\n\nDo her lines answer the question sensibly given what she is doing (fetching twigs, or having just finished)? A short status update about the task counts as an answer. Reply with YES or NO on the first line, then one short sentence.`;
    // One Haiku call flips on borderline lines, so take the majority of 3.
    const votes = [];
    for (let i = 0; i < 3; i++) {
      const res = await client.messages.create({ model: 'claude-haiku-5-5', max_tokens: 60, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: prompt }] });
      usd += ((res.usage.input_tokens || 0) * PRICE.in + (res.usage.output_tokens || 0) * PRICE.out) / 1e6;
      votes.push(res.content.map((b) => b.text ?? '').join('').trim());
    }
    const yes = votes.filter((v) => /^yes/i.test(v)).length;
    verdict = `${yes >= 2 ? 'YES' : 'NO'} (${yes}/3) ${votes.find((v) => /^yes/i.test(v) === yes >= 2)}`;
  }
  const pass = /^yes/i.test(verdict);
  if (pass) ok++;
  console.log(`${rep} judge=${pass ? 'YES' : 'NO'} reply="${reply.slice(0, 160)}" why="${verdict.replace(/\n/g, ' ').slice(0, 140)}"`);
}
console.log(`judge ${ok}/${n} spend $${usd.toFixed(4)}`);
