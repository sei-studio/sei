/**
 * The beginner player simulator for Test 1: an LLM that sees only what the
 * game panel shows and what the companion said in chat, and answers with one
 * `act` call (private note, optional chat line, optional move).
 */
import { appendFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { costOf, loadApiKey, type Usage } from './env';

export interface LearnerAct {
  note: string;
  chat?: string;
  move?: string;
}

const FALLBACK_MODEL = 'claude-sonnet-5-5';

export interface LearnerCall {
  model?: string;
  ms: number;
  usage: Usage | undefined;
  cost: number;
  act: LearnerAct | null;
  raw?: string;
}

const RULES_KNOWN = {
  bs: [
    'The game is called Fleet Battle. The launch screen says: "Hide your fleet, then take turns firing."',
    'The setup screen said: "Drag ships onto your waters. Click one to turn it." (You pressed Random, so your ships are already placed.)',
    'The screen shows two 10x10 boards with rows A-J and columns 1-10: "Your fleet" (your own waters) and the enemy waters. You click an enemy cell to fire there; a cell you already fired at cannot be clicked. After a shot the panel flashes "Hit", "Miss" or "You sank their <ship>"; after the companion fires it flashes "<name> missed", "<name> hit your fleet" or "<name> sank your <ship>".',
  ].join('\n'),
  c4: [
    'The game is called Four in a Row. The launch screen only had the title "Four in a Row" and a choice of side (red or yellow).',
    'The screen shows an upright board with 7 columns and 6 rows. On your turn you click a column and your disc falls to the lowest empty space in it. A full column cannot be clicked. The top of the screen says "Your turn" or "<name> is thinking…". When the game ends it shows who won and "Four in a row." if someone made one.',
  ].join('\n'),
};

function systemPrompt(game: 'bs' | 'c4', companion: string, player: string): string {
  const moveField =
    game === 'bs'
      ? '`move`: the enemy cell you click, like "D4" (row letter, then column number). Only cells not fired at yet.'
      : '`move`: the column you click, 1 to 7 from the left. Only columns that are not full.';
  return [
    `You are role-playing ${player}, a real person using a desktop app where an AI companion named ${companion} plays small games with you. Right now you are playing ${game === 'bs' ? 'Fleet Battle' : 'Four in a Row'} with ${companion} for the first time.`,
    '',
    `You have NEVER played this game or anything like it. You do not know its rules or any strategy. The only things you know about it are: (1) what the app screen shows you, listed below, and (2) what ${companion} tells you in chat. Everything else you may know about games like this does not exist for ${player}. Never use a rule, tip, pattern or term that did not come from the screen text or from ${companion}. If you are unsure how something works, ask ${companion} or just guess like a newcomer would.`,
    '',
    'What the screen shows:',
    RULES_KNOWN[game],
    '',
    `How to play the role:`,
    `- You asked ${companion} to teach you as you go. Be a curious, friendly beginner. Ask follow-up questions when they come up naturally: when something happens you do not understand, after your first hit or theirs, when you want to know why they did something, when you are stuck on what to do next. Roughly every few turns early on, less once you feel you get it. Never ask about something you were already told unless it was unclear.`,
    `- Chat like a person texting: short, lowercase, casual. One message at a time.`,
    `- Until ${companion} gives you a tip, choose moves the way a first-timer would: on a hunch, a spot that looks nice, sometimes random. Once you get a tip that makes sense to you, use it. If a tip is confusing, ask about it.`,
    `- Only use what you have actually been told. If ${companion} told you something wrong, you would not know it is wrong.`,
    '',
    'Each step, call the `act` tool exactly once:',
    `- \`note\`: private, one line: what you are basing this step on (e.g. "random guess", "${companion} said to shoot next to a hit", "asking because I don't get the symbols"). Never shown to ${companion}.`,
    `- \`chat\`: optional, a message to ${companion}. If you send a chat, do NOT make a move in the same step: you will see the reply and then move.`,
    `- ${moveField} Required when it is your turn and you are not chatting.`,
  ].join('\n');
}

export const ACT_TOOL = (game: 'bs' | 'c4') => ({
  name: 'act',
  description: 'Your step: a private note, and either a chat message or a move.',
  input_schema: {
    type: 'object' as const,
    properties: {
      note: { type: 'string', description: 'Private one-line note on what you base this step on.' },
      chat: { type: 'string', description: 'Optional message to the companion.' },
      move: {
        type: 'string',
        description: game === 'bs' ? 'Enemy cell to fire at, like "D4".' : 'Column 1 to 7.',
      },
    },
    required: ['note'],
  },
});

export class Learner {
  private client = new Anthropic({ apiKey: loadApiKey(), maxRetries: 2 });
  calls: LearnerCall[] = [];
  notes: string[] = [];
  constructor(
    private game: 'bs' | 'c4',
    private companion: string,
    private player: string,
    private model = process.env.MG_LEARNER_MODEL || 'claude-opus-5-5',
  ) {}

  get cost(): number {
    return this.calls.reduce((a, c) => a + c.cost, 0);
  }

  /** One step. `screen` is everything the player can see right now. */
  async step(screen: string, ask: string): Promise<LearnerAct | null> {
    const recent = this.notes.slice(-6);
    const user = [
      screen,
      recent.length ? `\nYour own recent private notes (oldest first):\n${recent.map((n) => `- ${n}`).join('\n')}` : '',
      `\n${ask}`,
    ].join('\n');
    const t0 = Date.now();
    const req: Record<string, unknown> = {
      model: this.model,
      max_tokens: 4000,
      // No cache_control: with it, this exact request drew instant stop_reason
      // "refusal" turns from Opus 5.5 in streaks (2 of 3 replays); without it, none.
      system: systemPrompt(this.game, this.companion, this.player),
      tools: [ACT_TOOL(this.game)],
      messages: [{ role: 'user', content: user }],
    };
    if (this.model.startsWith('claude-opus') || this.model.startsWith('claude-sonnet')) req.output_config = { effort: 'low' };
    const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [{ role: 'user', content: user }];
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        req.messages = messages;
        const res = (await this.client.messages.create(req as never)) as unknown as Anthropic.Message;
        const tu = res.content.find((b) => b.type === 'tool_use') as Anthropic.ToolUseBlock | undefined;
        const input = (tu?.input ?? null) as Record<string, unknown> | null;
        const act: LearnerAct | null = input
          ? {
              note: String(input.note ?? ''),
              ...(typeof input.chat === 'string' && input.chat.trim() ? { chat: input.chat.trim() } : {}),
              ...(input.move !== undefined && String(input.move).trim() ? { move: String(input.move).trim() } : {}),
            }
          : null;
        this.calls.push({
          ms: Date.now() - t0,
          model: String(req.model),
          usage: res.usage as Usage,
          cost: costOf(String(req.model), res.usage as Usage),
          act,
          ...(act ? {} : { raw: `${res.stop_reason} ${JSON.stringify(res.content.filter((b) => b.type !== 'thinking')).slice(0, 400)}` }),
        });
        if (act) {
          if (act.note) this.notes.push(act.note);
          return act;
        }
        if (!act && res.stop_reason === 'refusal' && process.env.MG_LEARNER_DUMP) {
          try {
            appendFileSync(process.env.MG_LEARNER_DUMP, JSON.stringify({ system: systemPrompt(this.game, this.companion, this.player), messages }) + '\n');
          } catch { /* debug only */ }
        }
        if (res.stop_reason === 'refusal') {
          // Retry the same request on the fallback model (logged per call).
          req.model = FALLBACK_MODEL;
          req.output_config = { effort: 'low' };
          continue;
        }
        // No tool call (an empty or text-only turn): continue the same
        // conversation with a nudge rather than resampling blind.
        messages.push({ role: 'assistant', content: res.content.filter((b) => b.type !== 'thinking') });
        if (!(messages[messages.length - 1].content as unknown[]).length) messages[messages.length - 1].content = [{ type: 'text', text: '(no reply)' }];
        messages.push({ role: 'user', content: 'Call the act tool now, exactly once.' });
      } catch (err) {
        this.calls.push({ ms: Date.now() - t0, usage: undefined, cost: 0, act: null, raw: `error ${String((err as Error).message).slice(0, 300)}` });
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    return null;
  }
}
