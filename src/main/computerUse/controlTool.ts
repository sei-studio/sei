/**
 * 260925 backseat act: the control() tool backseat gains when the dev flag is
 * on. Kept free of Electron imports so backseatService can read it
 * synchronously.
 *
 * control({goal}) is ASYNC: the tool returns "started" at once and the act
 * loop runs in the background while the companion keeps talking. When the
 * loop ends, a completion event ({status, steps, summary}) is injected into
 * the backseat conversation as its own turn, and the companion reacts to it.
 * Only one control runs at a time; a new call replaces the running one.
 *
 * It rides EVERY tick kind's tool array (the one-array policy keeps the
 * cached prefix stable) but is honored only on a USER tick: the player has to
 * have asked. Measured on this surface, every attached tool costs spoken
 * lines (100% -> 78% -> 68%), so this stays behind the flag until that is
 * measured with it attached.
 */
import type { LlmToolDef } from '../llm/types';

export function actFlagFromEnv(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv, platform = process.platform): boolean {
  return platform === 'darwin' && (env.SEI_BACKSEAT_ACT === '1' || argv.includes('--sei-backseat-act'));
}

export const CONTROL_TOOL_NAME = 'control';

export const CONTROL_TOOL: LlmToolDef = {
  name: CONTROL_TOOL_NAME,
  description:
    "Use the player's mouse and keyboard to do something on the screen they are sharing, when they ask you to do it for them. It starts in the background and you can keep talking while it runs. You will be told how it went when it ends. Calling it again replaces the one that is running. The player can stop it at any time by touching the mouse or keyboard.",
  input_schema: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'What to get done, in one sentence, as the player asked it.' },
    },
    required: ['goal'],
  },
};

/** The goal of a control() call in an assistant turn, or null. */
export function controlGoal(content: ReadonlyArray<{ type?: string; name?: string; input?: unknown }>): string | null {
  const b = content.find((x) => x.type === 'tool_use' && x.name === CONTROL_TOOL_NAME);
  const goal = (b?.input as { goal?: unknown } | undefined)?.goal;
  return typeof goal === 'string' && goal.trim() ? goal.trim().slice(0, 500) : null;
}

export interface ControlEvent {
  status: 'done' | 'gave_up' | 'timeout' | 'aborted';
  steps: number;
  summary: string;
}

/** The completion event as the backseat model reads it (a note on its own turn). */
export function controlEventNote(goal: string, e: ControlEvent): string {
  const how =
    e.status === 'done'
      ? 'finished'
      : e.status === 'gave_up'
        ? 'gave up'
        : e.status === 'timeout'
          ? 'ran out of steps or time'
          : 'was stopped';
  const sum = e.summary.trim() ? (/[.!?]$/.test(e.summary.trim()) ? e.summary.trim() : `${e.summary.trim()}.`) : '';
  return `Your control of the player's computer for "${goal}" ${how} after ${e.steps} step${e.steps === 1 ? '' : 's'}. Status: ${e.status}.${sum ? ` ${sum}` : ''} The screenshot shows the screen now. React to how it went.`;
}
