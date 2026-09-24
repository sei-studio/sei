/**
 * 260925 backseat act (M0 spike): glue between backseat's control() tool and
 * the act loop.
 *
 * Dev-only: nothing here runs unless SEI_BACKSEAT_ACT=1 (or the
 * --sei-backseat-act argv flag) AND the platform is macOS, where the input
 * helper exists. One control run per character at a time; a new control()
 * call stops the running one ('replaced') and starts fresh.
 *
 * Per run: spawn the helper, check permissions (and log what the helper sees,
 * which is the TCC attribution question), build the choosers and the
 * completion check, show the driving pill, register the kill-switch hotkey,
 * run the loop, and tear all of it down in `finally`, whatever the outcome.
 *
 * Dev knobs (env): SEI_ACT_MODEL (vision chooser, default claude-sonnet-5),
 * SEI_ACT_VERIFY_MODEL, SEI_ACT_ANTHROPIC_KEY (direct Anthropic, dev only),
 * SEI_ACT_THINKING=off / SEI_ACT_EFFORT, SEI_ACT_TEXT_CHOOSER (haiku | jev |
 * local | none) + SEI_ACT_TEXT_MODEL, SEI_JEV_API_KEY + SEI_JEV_MODEL,
 * SEI_ACT_CHOOSER=vision (vision only), SEI_ACT_PERCEIVE=0 (no AX/OCR
 * options), SEI_ACT_MAX_STEPS, SEI_ACT_MAX_SECONDS.
 */
import { app, BrowserWindow, globalShortcut } from 'electron';
import { buildLlmProvider } from '../llm';
import { ActRun, DEFAULT_LIMITS, limitsFromEnv, type ActEvent, type ActLimits, type ActOutcome, type StopReason } from './actLoop';
import { buildActSystem } from './actPrompt';
import type { Chooser } from './chooser';
import { createDirectAnthropicCall } from './directAnthropic';
import { createDriveOverlay, type DriveOverlay } from './driveOverlay';
import { makeCapture, makePerceive, makeScope, targetFromSourceId } from './env';
import { budgetForModel } from './geometry';
import { helperPath, MacInputHelper } from './inputHelper';
import { buildJevChooser } from './jevChooser';
import { targetRect } from './scope';
import { TEXT_CHOOSER_MODEL, TextChooser, textChooserKind } from './textChooser';
import { actFlagFromEnv } from './controlTool';
import { makeVerifier, VisionChooser, type LlmCall } from './visionChooser';

export const KILL_HOTKEY = 'Control+Shift+Escape';
export const KILL_HOTKEY_LABEL = 'Ctrl+Shift+Esc';
export const DEFAULT_ACT_MODEL = 'claude-sonnet-5';

export function actFlagEnabled(): boolean {
  return actFlagFromEnv();
}

/** A player line that means "stop now", checked before it reaches the model. Mechanical on purpose: it must work while the model call is in flight. */
export function isStopLine(text: string): boolean {
  return /\b(stop|cancel|quit it|halt|enough)\b/i.test(text);
}

export interface ControlStartOptions {
  characterId: string;
  characterName: string;
  persona?: string;
  sourceId: string;
  sourceName: string;
  goal: string;
  /** Speak a line in the character's voice through the backseat speech path. */
  speak: (text: string) => void;
  log: (msg: string, warn?: boolean) => void;
  /** Called once when the run ends, whatever the reason (including 'replaced'). */
  onEnd?: (outcome: ActOutcome, goal: string) => void;
  limits?: Partial<ActLimits>;
}

interface Running {
  run: ActRun;
  goal: string;
  done: Promise<ActOutcome>;
}

const running = new Map<string, Running>();

export function isActing(characterId: string): boolean {
  return running.has(characterId);
}

export function actingGoal(characterId: string): string | null {
  return running.get(characterId)?.goal ?? null;
}

export function stopAct(characterId: string, reason: StopReason = 'stopped'): void {
  running.get(characterId)?.run.stop(reason);
}

export function stopAllActs(): void {
  for (const r of running.values()) r.run.stop('stopped');
}

/** A player line during a run: stop words stop it, anything else is passed to the next step as context. */
export function actPlayerLine(characterId: string, text: string): 'stopped' | 'noted' | 'none' {
  const r = running.get(characterId);
  if (!r) return 'none';
  if (isStopLine(text)) {
    r.run.stop('stopped', 'said stop');
    return 'stopped';
  }
  r.run.addPlayerLine(text);
  return 'noted';
}

function seiPids(): Set<number> {
  const s = new Set<number>([process.pid]);
  try {
    for (const m of app.getAppMetrics()) s.add(m.pid);
  } catch {
    /* not ready */
  }
  return s;
}

/** Sei windows that cannot take a click (overlays), by native CGWindowID. */
function passThroughWindowIds(): Set<number> {
  const ids = new Set<number>();
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || w.isFocusable()) continue;
    const m = /^window:(\d+):/.exec(w.getMediaSourceId());
    if (m) ids.add(Number(m[1]));
  }
  return ids;
}

async function buildChoosers(system: string): Promise<{
  vision: VisionChooser;
  text: Chooser | null;
  verify: ReturnType<typeof makeVerifier>;
  budgetModel: string;
}> {
  const model = process.env.SEI_ACT_MODEL || DEFAULT_ACT_MODEL;
  let call: LlmCall;
  let anthropic = true;
  let budgetModel = model;
  const directKey = process.env.SEI_ACT_ANTHROPIC_KEY;
  if (directKey) {
    call = createDirectAnthropicCall(directKey);
  } else {
    const llm = await buildLlmProvider();
    call = (p) => llm.call(p);
    anthropic = llm.kind === 'anthropic';
    // Non-Anthropic providers ignore the model override and run their own.
    if (!anthropic) budgetModel = llm.model;
  }
  // Latency: the 5-gen models think adaptively by default. Low effort keeps a
  // step to a few seconds; SEI_ACT_THINKING=off disables thinking outright.
  let extra: Record<string, unknown> | undefined;
  if (anthropic && /(sonnet|opus|fable)-5/.test(model)) {
    extra =
      process.env.SEI_ACT_THINKING === 'off'
        ? { thinking: { type: 'disabled' } }
        : { output_config: { effort: process.env.SEI_ACT_EFFORT || 'low' } };
  }
  const vision = new VisionChooser({ call, model, system, cache: anthropic, anthropicExtra: extra });
  const verify = makeVerifier({ call, model: process.env.SEI_ACT_VERIFY_MODEL || model, anthropic });
  return { vision, text: buildTextChooser(call, anthropic), verify, budgetModel };
}

/**
 * The text chooser, by config (SEI_ACT_TEXT_CHOOSER):
 *   haiku (default) - Haiku 4.5 in text mode through the same call (cloud proxy);
 *   jev             - TypeSafe Jev, needs SEI_JEV_API_KEY (else none);
 *   local           - seam for an on-device scorer, not implemented (none);
 *   none            - every step on vision (also SEI_ACT_CHOOSER=vision).
 */
function buildTextChooser(call: LlmCall, anthropic: boolean): Chooser | null {
  switch (textChooserKind()) {
    case 'haiku':
      return new TextChooser({ call, model: process.env.SEI_ACT_TEXT_MODEL || TEXT_CHOOSER_MODEL, anthropic });
    case 'jev':
      return buildJevChooser(process.env);
    default:
      return null;
  }
}

/**
 * Start a control run. A running one for the same character is stopped
 * ('replaced') first and awaited. Resolves once the new run has STARTED (or
 * failed to), not when it ends; `onEnd` gets the outcome.
 */
export async function startControl(o: ControlStartOptions): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!actFlagEnabled()) return { ok: false, error: 'ACT_DISABLED' };
  const prev = running.get(o.characterId);
  if (prev) {
    prev.run.stop('replaced');
    await Promise.race([prev.done.catch(() => null), new Promise((r) => setTimeout(r, 3000))]);
    if (running.get(o.characterId) === prev) running.delete(o.characterId);
  }
  const target = targetFromSourceId(o.sourceId, o.sourceName);
  if (!target) return { ok: false, error: `ACT_BAD_SOURCE: ${o.sourceId}` };

  let helper: MacInputHelper;
  try {
    helper = await MacInputHelper.start(helperPath(app.isPackaged, process.resourcesPath, app.getAppPath()), {
      log: (m) => o.log(m),
    });
  } catch (e) {
    return { ok: false, error: `ACT_HELPER_FAILED: ${(e as Error).message}` };
  }
  o.log(`act helper ready: ${JSON.stringify(helper.ready)}`);
  let overlay: DriveOverlay | null = null;
  try {
    const perms = await helper.permissions(false);
    o.log(`act permissions as the helper sees them: ${JSON.stringify(perms)}`);
    if (!perms.postEventAccess || !perms.axTrusted) {
      const asked = await helper.permissions(true);
      o.log(`act permissions after prompt: ${JSON.stringify(asked)}`, true);
      if (!asked.postEventAccess) throw new Error('ACT_NO_ACCESSIBILITY');
    }
    const [windows, displays] = await Promise.all([helper.windows(), helper.displays()]);
    const rect = targetRect({ target, windows, displays });
    if (!rect) throw new Error('ACT_TARGET_GONE');
    if (target.kind === 'window') target.pid = windows.find((w) => w.id === target.windowId)?.pid;

    const system = buildActSystem({
      characterName: o.characterName,
      persona: o.persona,
      target,
      targetLabel: o.sourceName,
    });
    const { vision, text, verify, budgetModel } = await buildChoosers(system);
    const limits = { ...DEFAULT_LIMITS, ...limitsFromEnv(), ...o.limits };
    o.log(
      `act start: goal="${o.goal.slice(0, 160)}" vision=${vision.model} text=${text ? text.model : 'none'} ` +
        `target=${JSON.stringify(target)} rect=${JSON.stringify(rect)} steps=${limits.maxSteps} secs=${limits.maxMs / 1000}`,
    );

    let run: ActRun | null = null;
    overlay = createDriveOverlay({
      characterName: o.characterName,
      hotkeyLabel: KILL_HOTKEY_LABEL,
      near: rect,
      onStop: () => run?.stop('stopped', 'Stop button'),
    });
    const ov = overlay;
    const onEvent = (e: ActEvent): void => {
      switch (e.type) {
        case 'say':
          o.speak(e.text);
          break;
        case 'step': {
          const t = e.timing;
          o.log(
            `act step ${t.step}: ${t.chooser}(${t.pick}) total=${t.totalMs}ms capture=${t.captureMs} perceive=${t.perceiveMs} ` +
              `model=${t.modelMs} verify=${t.verifyMs} action=${t.actionMs} options=${t.options} ` +
              `in=${t.inputTokens ?? '?'} out=${t.outputTokens ?? '?'}` +
              (e.scratch ? ` notes="${e.scratch.slice(0, 160).replace(/\s+/g, ' ')}"` : ''),
          );
          break;
        }
        case 'action':
          // Every action is logged, refused and failed ones included.
          o.log(`act action ${e.step}: ${e.action} -> ${e.ok ? 'ok' : 'FAILED'} ${e.result} (${e.ms}ms)`, !e.ok);
          ov.setDetail(`Step ${e.step}: ${e.action.slice(0, 60)}`);
          break;
        case 'verify':
          o.log(`act verify: ${e.achieved ? 'achieved' : 'not achieved'} (${e.ms}ms) ${e.why}`);
          break;
        case 'log':
          o.log(`act ${e.msg}`);
          break;
      }
    };
    run = new ActRun(
      {
        goal: o.goal,
        executor: helper,
        vision,
        text,
        verify,
        capture: makeCapture({ executor: helper, target, budget: budgetForModel(budgetModel), excludePids: [...seiPids()] }),
        ...(process.env.SEI_ACT_PERCEIVE === '0'
          ? {}
          : { perceive: makePerceive({ executor: helper, target, seiPids, log: (m) => o.log(`act ${m}`) }) }),
        focused: (signal) => helper.axFocused(signal),
        scope: makeScope({
          executor: helper,
          target,
          seiPids,
          passThroughWindowIds,
          seiRects: () => {
            const r = ov.rect();
            return r ? [r] : [];
          },
        }),
        onEvent,
      },
      limits,
    );
    const r = run;
    const hotkeyOk = globalShortcut.register(KILL_HOTKEY, () => r.stop('stopped', KILL_HOTKEY_LABEL));
    if (!hotkeyOk) o.log(`act: could not register ${KILL_HOTKEY}`, true);

    const done = r
      .run()
      .then((outcome) => {
        o.log(
          `act end: ${outcome.reason} (${outcome.status}) after ${outcome.steps} steps, ${Math.round(outcome.elapsedMs / 100) / 10}s` +
            ` "${outcome.summary.slice(0, 160)}"` +
            (outcome.error ? ` error=${outcome.error}` : ''),
          outcome.reason === 'error',
        );
        return outcome;
      })
      .finally(() => {
        if (hotkeyOk) globalShortcut.unregister(KILL_HOTKEY);
        ov.close();
        helper.dispose();
        if (running.get(o.characterId)?.run === r) running.delete(o.characterId);
      });
    running.set(o.characterId, { run: r, goal: o.goal, done });
    void done.then((outcome) => o.onEnd?.(outcome, o.goal));
    return { ok: true };
  } catch (e) {
    overlay?.close();
    helper.dispose();
    return { ok: false, error: (e as Error).message };
  }
}
