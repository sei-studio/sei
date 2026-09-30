/**
 * 260925 backseat act: Jev (TypeSafe AI "System One") as a text chooser.
 *
 * Jev picks one option out of a menu from TEXT state and returns
 * probabilities. It cannot see pixels, so it runs on perception's state text
 * and numbered options (AX tree + OCR), and the loop hands a step to the
 * vision chooser when the options are thin or Jev is unsure.
 *
 * STUB until there is a key: without SEI_JEV_API_KEY buildJevChooser returns
 * null and every step runs on vision. The request/response shape follows
 * docs.typesafe.ai/api.md (fetched 260925):
 *
 *   POST https://api.typesafe.ai/v1/systemone
 *   Authorization: Bearer <key>
 *   { model, state, questions: { next: { type: "choice", instructions,
 *     criteria: { <option_key>: <description>, ... } } } }
 *   -> { model, answers: { next: { type: "choice", choice, probabilities,
 *        confidence } }, usage }
 *
 * TypeSafe's terms forbid sharing credentials, so a shipped version must
 * relay through sei-proxy with the key server-side, like the Anthropic key.
 */
import { ProbabilityChooser, type ScoreFn } from './chooser';

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MAX_OPTIONS = 255;
export const JEV_DEFAULT_MODEL = 'jev-1.13.0';

export interface JevRequest {
  model: string;
  state: string;
  questions: Record<string, { type: 'choice'; instructions: string; criteria: Record<string, string> }>;
}

export interface JevChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export const optionKey = (i: number): string => `o${i}`;

export function buildJevRequest(
  input: { goal: string; state: string; history: string[]; options: string[] },
  model = JEV_DEFAULT_MODEL,
): JevRequest {
  if (input.options.length === 0) throw new Error('jev: no options');
  if (input.options.length > JEV_MAX_OPTIONS) throw new Error(`jev: ${input.options.length} options, max ${JEV_MAX_OPTIONS}`);
  const criteria: Record<string, string> = {};
  input.options.forEach((o, i) => (criteria[optionKey(i)] = o));
  const state = [
    input.state,
    input.history.length ? `Steps so far:\n${input.history.join('\n')}` : 'Nothing done yet.',
  ].join('\n\n');
  return {
    model,
    state,
    questions: {
      next: {
        type: 'choice',
        instructions: `The user wants this done on their computer: ${input.goal.trim()}. Which action should be taken next on this screen?`,
        criteria,
      },
    },
  };
}

/** Probabilities in option order. Falls back to one-hot on `choice` when the answer has none. */
export function parseJevResponse(body: unknown, n: number): number[] {
  const ans = (body as { answers?: Record<string, JevChoiceAnswer> })?.answers?.next;
  if (!ans || ans.type !== 'choice' || typeof ans.choice !== 'string') throw new Error('jev: malformed response');
  const chosen = Number(/^o(\d+)$/.exec(ans.choice)?.[1] ?? NaN);
  if (!Number.isInteger(chosen) || chosen < 0 || chosen >= n) throw new Error(`jev: chose unknown option ${ans.choice}`);
  const probs = new Array<number>(n).fill(0);
  if (ans.probabilities && Object.keys(ans.probabilities).length) {
    for (const [k, v] of Object.entries(ans.probabilities)) {
      const i = Number(/^o(\d+)$/.exec(k)?.[1] ?? NaN);
      if (Number.isInteger(i) && i >= 0 && i < n && Number.isFinite(v)) probs[i] = v;
    }
    // Keep Jev's own pick on top even if the map was partial.
    if (probs[chosen]! < Math.max(...probs)) probs[chosen] = Math.max(...probs) + 1e-6;
  } else {
    probs[chosen] = typeof ans.confidence === 'number' ? ans.confidence : 1;
  }
  return probs;
}

export function makeJevScore(o: { apiKey: string; model?: string; fetchFn?: typeof fetch; timeoutMs?: number; url?: string }): ScoreFn {
  return async (input, signal) => {
    const req = buildJevRequest(input, o.model ?? JEV_DEFAULT_MODEL);
    const res = await (o.fetchFn ?? fetch)(o.url ?? JEV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${o.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal: AbortSignal.any([signal, AbortSignal.timeout(o.timeoutMs ?? 5000)]),
    });
    if (!res.ok) throw new Error(`jev: HTTP ${res.status}`);
    const body = (await res.json()) as { usage?: { input_tokens?: number; output_tokens?: number } };
    return { probs: parseJevResponse(body, input.options.length), usage: body.usage };
  };
}

/** The Jev text chooser, or null without a key (the stub state). */
export function buildJevChooser(env: NodeJS.ProcessEnv, fetchFn?: typeof fetch): ProbabilityChooser | null {
  const apiKey = env.SEI_JEV_API_KEY?.trim();
  if (!apiKey) return null;
  const model = env.SEI_JEV_MODEL?.trim() || JEV_DEFAULT_MODEL;
  return new ProbabilityChooser('jev', model, makeJevScore({ apiKey, model, fetchFn }));
}
