/**
 * Opus judge for both tests.
 *
 *   MG_JUDGE=teach  rates every Test 1 game in teach/games.jsonl against the
 *                   teaching rubric (writes teach/judge.jsonl and a readable
 *                   teach/<game>-<k>.md per game).
 *   MG_JUDGE=voice  blind voice/distinctness check on Test 2 lines: one group
 *                   of lines per character, shuffled and unlabeled, matched to
 *                   persona summaries and rated (writes skill/voice-judge.json).
 */
import { describe, it } from 'vitest';
import path from 'node:path';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { CHARACTER_IDS, OUT_DIR, appendJsonl, costOf, loadApiKey, outPath, rng, type Usage } from './lib/env';
import { renderTeach, type TeachRow } from './lib/render';

const MODE = process.env.MG_JUDGE || 'teach';
const MODEL = process.env.MG_JUDGE_MODEL || 'claude-opus-5-5';

const client = new Anthropic({ apiKey: loadApiKey(), maxRetries: 3 });

async function judge(system: string, user: string, effort = 'medium'): Promise<{ json: unknown; cost: number; text: string }> {
  const res = (await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort },
    system,
    messages: [{ role: 'user', content: user }],
  } as never)) as unknown as Anthropic.Message;
  const text = res.content.filter((b) => b.type === 'text').map((b) => (b as Anthropic.TextBlock).text).join('\n');
  const m = /```json\s*([\s\S]*?)```/.exec(text) ?? /(\{[\s\S]*\})/.exec(text);
  let json: unknown = null;
  try { json = m ? JSON.parse(m[1]) : null; } catch { json = null; }
  return { json, cost: costOf(MODEL, res.usage as Usage), text };
}

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);
}

function personaOf(name: string): string {
  const id = CHARACTER_IDS[name];
  const raw = JSON.parse(readFileSync(outPath('chars', `${id}.json`), 'utf8'));
  const row = Array.isArray(raw) ? raw[0] : raw;
  return String(row.persona_source || row.persona_expanded || '').slice(0, 900);
}

const RULES = {
  bs: 'Fleet Battle (Battleship): each side hides 5 ships (carrier 5, battleship 4, cruiser 3, submarine 3, destroyer 2) on a 10x10 grid (rows A-J, columns 1-10), straight lines, no overlap. Players alternate single shots (one shot per turn here, no extra shot on a hit); the shooter learns hit or miss, and when every cell of a ship is hit it is sunk and named. Whoever sinks the whole enemy fleet first wins. Good strategy: spread hunting shots (a checkerboard / parity pattern finds every ship of size 2+), and after a hit, fire at the orthogonal neighbours, then continue along the line once two hits show the direction, until the ship sinks.',
  c4: 'Four in a Row (Connect Four): 7 columns x 6 rows, upright. Red moves first, players alternate dropping one disc into a column; it falls to the lowest empty space. Four of your discs in a line horizontally, vertically or diagonally wins; a full board with no line is a draw. Good strategy: prefer the center columns, block the opponent when they have three with an open fourth spot (or two-way threats coming), build your own threats, avoid playing under a square the opponent needs.',
};

describe(`judge: ${MODE}`, () => {
  it('runs', async () => {
    let spent = 0;
    if (MODE === 'teach') {
      const rows = readJsonl<TeachRow & Record<string, unknown>>(outPath('teach', 'games.jsonl'));
      const done = new Set(readJsonl<{ game: string; k: number }>(outPath('teach', 'judge.jsonl')).map((r) => `${r.game}-${r.k}`));
      for (const row of rows) {
        writeFileSync(outPath('teach', `${row.game}-${row.k}.md`), `# ${row.game === 'bs' ? 'Fleet Battle' : 'Four in a Row'} teaching game ${row.k} (${row.character})\n\n` + renderTeach(row, { md: true }).split('\n').join('\n\n') + '\n');
        if (done.has(`${row.game}-${row.k}`)) continue;
        const facts = JSON.stringify({
          winner: row.winner,
          playerShots: row.playerShots,
          aiShots: row.aiShots,
          plies: row.plies,
          learner: row.learner && { ...(row.learner as Record<string, unknown>), checks: undefined },
          learnerIllegalAttempts: row.learnerIllegal,
          harnessFallbackMoves: row.fallbacks,
          playerChats: row.chats,
          companionIllegal: row.aiIllegal,
          companionRetries: row.aiRetries,
          companionFailedTurns: row.aiFailedTurns,
          tryAgainClicks: row.retryClicks,
          stuck: row.stuck,
        });
        const system = [
          'You evaluate an AI game companion inside a desktop app, playing a small board game in a side panel with a player who has never played before and asked to be taught. The companion speaks in short chat lines. You see the full timeline: the player\'s chat, the companion\'s lines, what the screen showed, and the player\'s private notes (the companion never saw those).',
          'The player is a simulated beginner who must only use knowledge from the screen or the companion. Part of your job is to audit that (a "leak" is a note or move that relies on a rule, tip or term nobody gave it).',
          '',
          'Rules and good strategy, for your reference:',
          RULES[row.game],
          '',
          'Rate each 1-5 (5 = excellent, 3 = adequate, 1 = failing) with a one-sentence reason:',
          '- rules: core rules explained correctly and early enough for the beginner to play.',
          row.game === 'bs'
            ? '- strategy: useful strategy taught (hunt/target: fire next to a hit, follow the line; spreading hunting shots).'
            : '- strategy: useful strategy taught (center columns, blocking three-in-a-row, making your own threats).',
          '- accuracy: no wrong rules and no false claims about the board (who hit what, where ships are, what is on the board). Check every factual claim against the timeline; quote each wrong one.',
          '- in_character: sounds like the persona below while teaching, not a generic tutor.',
          row.game === 'bs'
            ? '- learner_improvement: did the beginner play better after the tips (e.g. firing next to hits, following lines) as shown by moves and notes?'
            : '- learner_improvement: did the beginner play better after the tips (e.g. blocking threats, using the center) as shown by moves and notes?',
          '- pacing: explanations arrive when useful, not too much at once, not lecturing every move, answers the actual questions; table talk does not drown the game.',
          '',
          'Also list: wrong_claims (verbatim quote + why wrong), leaks (learner notes/moves using untaught knowledge), bugs (chat not answered, stale or contradictory state, replies about the wrong board, hidden information revealed, stuck turns, anything off), and 4 short verbatim quotes that best show the teaching (good or bad), each with a 3-6 word label.',
          'Answer with one ```json block: {"scores":{"rules":{"score":n,"why":""},"strategy":{...},"accuracy":{...},"in_character":{...},"learner_improvement":{...},"pacing":{...}},"wrong_claims":[{"quote":"","why":""}],"leaks":[{"note":"","why":""}],"bugs":[{"what":"","evidence":""}],"quotes":[{"quote":"","label":""}],"verdict":"two sentences"}',
        ].join('\n');
        const user = [
          `Companion persona (${row.character}):\n${personaOf(row.character)}`,
          '',
          `Measured facts: ${facts}`,
          '',
          'Timeline:',
          renderTeach(row, { judge: true }),
        ].join('\n');
        const r = await judge(system, user);
        spent += r.cost;
        appendJsonl('teach/judge.jsonl', { game: row.game, k: row.k, judge: r.json, raw: r.json ? undefined : r.text.slice(0, 2000), cost: r.cost });
        appendJsonl('spend.jsonl', { test: 'judge-teach', game: row.game, k: row.k, cost: r.cost });
      }
    } else {
      // Voice: one shuffled group of lines per character.
      const files = readdirSync(path.join(OUT_DIR, 'skill')).filter((f) => f.endsWith('.jsonl'));
      const groups: Array<{ name: string; lines: string[] }> = [];
      for (const f of files) {
        const rows = readJsonl<{ character: string; game: string; lines: Array<{ text: string }> }>(outPath('skill', f));
        if (!rows.length) continue;
        const name = rows[0].character;
        const all = rows.flatMap((r) => r.lines.map((l) => `[${r.game === 'bs' ? 'Fleet Battle' : 'Four in a Row'}] ${l.text}`));
        const rand = rng(7 + name.length);
        const pick: string[] = [];
        const pool = all.slice();
        while (pick.length < 16 && pool.length) pick.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
        groups.push({ name, lines: pick });
      }
      const rand = rng(99);
      const order = groups.map((g) => ({ g, r: rand() })).sort((a, b) => a.r - b.r).map((x) => x.g);
      const letters = 'ABCDEFGH';
      const personas = groups.map((g) => g.name).sort();
      const system = [
        'You judge character voice in a game companion app. Several AI characters each played Fleet Battle and Four in a Row; below are unlabeled groups of the lines each one said at the table (one group per character, lines sampled across games), and the persona cards of the characters.',
        '1) Match each group to a persona (each persona used once).',
        '2) For each group rate 1-5: voice_fit (sounds like that persona, given your match), distinctness (how clearly it differs from the other groups; 1 = interchangeable generic gamer talk), and note any generic or off-character lines (verbatim).',
        '3) Overall: does the style genuinely vary by personality? One short paragraph.',
        'Answer with one ```json block: {"groups":{"A":{"persona":"","confidence":"high|medium|low","voice_fit":n,"distinctness":n,"notes":"","off_lines":[""]}},"overall":""}',
      ].join('\n');
      const user = [
        'Personas:',
        ...personas.map((p) => `### ${p}\n${personaOf(p)}`),
        '',
        'Groups:',
        ...order.map((g, i) => `### Group ${letters[i]}\n${g.lines.map((l) => `- ${l}`).join('\n')}`),
      ].join('\n');
      const r = await judge(system, user);
      spent += r.cost;
      const key = Object.fromEntries(order.map((g, i) => [letters[i], g.name]));
      writeFileSync(outPath('skill', 'voice-judge.json'), JSON.stringify({ key, judge: r.json, raw: r.json ? undefined : r.text, groups: order, cost: r.cost }, null, 2));
      appendJsonl('spend.jsonl', { test: 'judge-voice', cost: r.cost });
    }
    writeFileSync(outPath(`judge-${MODE}-last-cost.txt`), `${spent}\n`);
  });
});
