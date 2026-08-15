/**
 * Accessory expressions → per-frame parameter targets (260806).
 *
 * VTuber exports ship item toggles as expressions (hat, phone, coat...) meant
 * to be flipped on and stay on. They cannot ride the expressionManager: it
 * holds ONE active expression, so the next emotion expression would knock the
 * hat state off and its reset would put the hat back. Instead the toggled
 * expressions' parameter deltas are resolved to ABSOLUTE target values once
 * (against the model's parameter defaults) and written every frame inside the
 * wrapped motionManager.update, exactly like the mouth: persistent, and
 * layered so emotion expressions and accessories coexist.
 *
 * Pure and renderer-agnostic so the math is testable without a model; the
 * caller supplies the defaults lookup (Cubism core `getParameterDefaultValue`).
 */

/** One parameter line of an .exp3.json. Blend defaults to 'Add' per spec. */
export interface ExpressionParam {
  id: string;
  value: number;
  blend: 'Add' | 'Multiply' | 'Overwrite';
}

/** Tolerantly parse a .exp3.json's Parameters array (unknown JSON in). */
export function parseExpressionParams(json: unknown): ExpressionParam[] {
  const params = (json as { Parameters?: unknown })?.Parameters;
  if (!Array.isArray(params)) return [];
  const out: ExpressionParam[] = [];
  for (const p of params) {
    const id = (p as { Id?: unknown })?.Id;
    const value = (p as { Value?: unknown })?.Value;
    if (typeof id !== 'string' || typeof value !== 'number' || !Number.isFinite(value)) continue;
    const blendRaw = (p as { Blend?: unknown })?.Blend;
    const blend =
      blendRaw === 'Multiply' || blendRaw === 'Overwrite' ? blendRaw : ('Add' as const);
    out.push({ id, value, blend });
  }
  return out;
}

/**
 * Resolve the enabled accessories' param sets to absolute per-parameter
 * targets. Each parameter starts from its model default and the sets apply in
 * order (Add adds, Multiply scales, Overwrite replaces), so two accessories
 * touching the same parameter compose the way the runtime would compose their
 * expressions. Clamping to the parameter's min/max is the core setter's job.
 */
export function computeAccessoryTargets(
  paramSets: ReadonlyArray<ReadonlyArray<ExpressionParam>>,
  defaultOf: (id: string) => number,
): Map<string, number> {
  const targets = new Map<string, number>();
  for (const set of paramSets) {
    for (const { id, value, blend } of set) {
      const current = targets.get(id) ?? defaultOf(id);
      targets.set(
        id,
        blend === 'Overwrite' ? value : blend === 'Multiply' ? current * value : current + value,
      );
    }
  }
  return targets;
}
