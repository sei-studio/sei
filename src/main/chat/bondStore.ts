/**
 * Main's side of the bond (261113, v0.7 consistency D3): read it for a
 * prompt, and write one update from the fold or the game session-end call.
 * The record, the merge rules and the file live in
 * src/bot/brain/memory/bond.js; the schema in src/shared/bondSchema.ts.
 *
 * Analytics, shape only (never any bond text): `bond_updated
 * {character_id, source, outcome, stage, prev_stage, stage_changed, treated}`
 * for every update attempt, `outcome` one of saved / missing / unchanged /
 * invalid / failed.
 */
import { readBond, saveBondUpdate } from '../../bot/brain/memory/bond.js';
import { BondSchema, type Bond, type BondSource } from '../../shared/bondSchema';
import type { BondUpdate } from './continuityCore';

/** The bond for a prompt, or null. Never throws. */
export async function readBondFor(memoryDir: string): Promise<Bond | null> {
  try {
    return (await readBond(memoryDir)) as Bond | null;
  } catch {
    return null;
  }
}

export interface BondSaveResult {
  outcome: 'saved' | 'missing' | 'unchanged' | 'invalid' | 'failed';
  stage: string | null;
  prevStage: string | null;
  treated: string | null;
}

/** The analytics props of one update attempt. */
export function bondUpdatedProps(characterId: string, source: BondSource, r: BondSaveResult): Record<string, string | boolean> {
  return {
    character_id: characterId,
    source,
    outcome: r.outcome,
    ...(r.stage ? { stage: r.stage } : {}),
    ...(r.prevStage ? { prev_stage: r.prevStage } : {}),
    stage_changed: r.outcome === 'saved' && r.prevStage !== null && r.stage !== r.prevStage,
    ...(r.treated ? { treated: r.treated } : {}),
  };
}

/**
 * Merge and write one update. `mayWrite` is checked right before the write
 * (scope and clear checks). Never throws.
 */
export async function saveBondFor(
  memoryDir: string,
  update: BondUpdate | null,
  opts: { mayWrite?: () => boolean; now?: number } = {},
): Promise<BondSaveResult> {
  return (await saveBondUpdate(memoryDir, update, {
    now: opts.now,
    mayWrite: opts.mayWrite,
    validate: (b: unknown) => BondSchema.safeParse(b).success,
  })) as BondSaveResult;
}
