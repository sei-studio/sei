/**
 * visionGate (china-compat W9) — the one place the "your model cannot see
 * images" copy is composed, so the Draw! tile, the ChatTopBar backseat button,
 * the CallControls share pill and the two stores' error mapping all say the
 * same sentence.
 *
 * The signal is useUiStore.llmVision ('yes' | 'no' | 'unknown', fed by the
 * llm:capability push). Gates lock ONLY on a confident 'no': 'unknown' must
 * never block (BYOK Anthropic before any capability fetch would lose backseat
 * for nothing; a wrong lock hides a feature silently, a wrong allow fails
 * visibly against the main-side backstops).
 *
 * The helpers take `t` as a parameter instead of importing it, so components
 * pass their useT() translator (reactive) while stores pass the bare t.
 */

export type Translate = (en: string, params?: Record<string, string | number>) => string;

export type VisionSurface = 'draw' | 'backseat';

/** True only on a confident 'no'; 'unknown' stays usable by design. */
export function visionBlocked(llmVision: 'yes' | 'no' | 'unknown'): boolean {
  return llmVision === 'no';
}

/** The disabled-entry explanation for a vision surface. */
export function visionGateReason(
  t: Translate,
  surface: VisionSurface,
  model: string | null,
): string {
  if (surface === 'draw') {
    return model
      ? t(
          'Draw! needs a model that can see images. Your current model ({model}) does not support vision.',
          { model },
        )
      : t('Draw! needs a model that can see images. Your current model does not support vision.');
  }
  return model
    ? t(
        'Screen sharing needs a model that can see images. Your current model ({model}) does not support vision.',
        { model },
      )
    : t(
        'Screen sharing needs a model that can see images. Your current model does not support vision.',
      );
}
