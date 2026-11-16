/**
 * WorldLink and companions whose look is a picture someone uploaded
 * (261116, product call 261116: Aria #M5IR "failed terribly").
 *
 * WorldLink draws a companion as her imported avatar, else her face set (the
 * anima bake), else a cut-out of her card picture (portraitCutout.ts). The
 * cut-out is clean when the picture's background is flat or transparent
 * (method 'key'); on a painted or photographed background it can only fade
 * an oval round her (method 'vignette'), so she sits in the room as a hazy
 * card with her own backdrop still in it. That is what Aria looked like: her
 * face set bake was refused (QC) and her dark bedroom backdrop cannot be
 * keyed. 13 of 22 public uploaded pictures sampled on 261116 land there.
 *
 * WORLDLINK_UPLOADED_LOOKS is the one switch for limiting that:
 *  - 'all' (default): every companion can move in, as before.
 *  - 'clean_cutout': an uploaded picture with no avatar and no face set moves
 *    in only when its background cuts out cleanly; otherwise the move-in
 *    sheet says so in one line and Move in is off.
 *  - 'sei_looks': only looks made in Sei (generated card art, a face set or
 *    an imported avatar) move in; any other uploaded picture gets the line.
 * Built-in companions and Sei-generated card art are never limited.
 */
import { cardImageOrigin, type CardImageOrigin, type Character } from '@shared/characterSchema';
import { sei } from '../ipcClient';
import { portraitSrc } from '../portraitSrc';
import { loadCutout } from './portraitCutout';

export type UploadedLookPolicy = 'all' | 'clean_cutout' | 'sei_looks';

/** THE switch (see the header). Default 'all': nothing is limited. */
export const WORLDLINK_UPLOADED_LOOKS: UploadedLookPolicy = 'all';

/** Why her look keeps her out: 'none' = she can move in. */
export type LookBlock = 'none' | 'busy_background' | 'uploaded';

export interface LookFacts {
  origin: CardImageOrigin;
  /** She has an imported avatar (Live2D / rig) or a face set: WorldLink does not use the picture. */
  figure: boolean;
  /** How her picture cuts out ('key' clean, 'vignette' an oval with her backdrop); null when it was not checked or did not load. */
  cutout: 'key' | 'vignette' | null;
}

/** Pure rule behind the switch. */
export function uploadedLookBlock(policy: UploadedLookPolicy, f: LookFacts): LookBlock {
  if (policy === 'all' || f.origin !== 'uploaded' || f.figure) return 'none';
  if (policy === 'sei_looks') return 'uploaded';
  return f.cutout === 'vignette' ? 'busy_background' : 'none';
}

const done = new Map<string, LookBlock>();

/**
 * Her block under `policy`. Free with the default policy (no reads at all);
 * otherwise one avatar and face-set lookup and, for 'clean_cutout', the same
 * cut-out the room draws (cached per picture, so the room reuses it).
 */
export async function worldlinkLookBlock(
  c: Pick<Character, 'id' | 'kind' | 'is_default' | 'metadata' | 'portrait_image'>,
  policy: UploadedLookPolicy = WORLDLINK_UPLOADED_LOOKS,
): Promise<LookBlock> {
  if (policy === 'all') return 'none';
  const origin = cardImageOrigin(c);
  if (origin !== 'uploaded') return 'none';
  const memo = `${policy}:${c.id}:${c.portrait_image ?? ''}`;
  const hit = done.get(memo);
  if (hit) return hit;
  let figure = false;
  try {
    figure = Boolean(await sei?.avatarGet?.(c.id)) || Boolean(await sei?.facepackForCharacter?.(c.id));
  } catch {
    /* no bridge: judge by the picture */
  }
  let cutout: LookFacts['cutout'] = null;
  if (!figure && policy === 'clean_cutout') {
    const url = portraitSrc(c.portrait_image);
    cutout = url ? ((await loadCutout(url).catch(() => null))?.method ?? null) : null;
  }
  const block = uploadedLookBlock(policy, { origin, figure, cutout });
  // A face set can still arrive (the bake runs when WorldLink opens): only a clear pass is kept.
  if (block === 'none') done.set(memo, block);
  return block;
}
