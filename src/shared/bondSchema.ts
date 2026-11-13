import { z } from 'zod';

/**
 * The bond (261113, v0.7 character consistency D3): one small, bounded record
 * of how things stand between a companion and the player, kept per character
 * in `<memoryDir>/bond.json` and rendered the same way on every surface
 * (promptLibrary.js renderBond, right after the persona in the cached prefix).
 *
 * Written only when a stretch of time together is consolidated: the chat fold
 * (continuity.ts) and the game session-end call (playerEndNextStep.ts). Read
 * when a session's prompt is built, so it never changes inside a session's
 * cache. The pure read, merge and write live in src/bot/brain/memory/bond.js
 * (the bot process cannot import this file); main checks every record against
 * this schema before it writes one.
 *
 * No open plans or threads here: those are memory's (the plan line, the
 * fold's facts). A first version kept up to three open threads, and the fold
 * replaced an older still-open plan from a game with three newer ones from
 * chat, so every surface answered "what are we building next" with the
 * newest idea only (consistency eval smoke, 261113).
 *
 * Product rules (product call 261113): the bond can grow or hold, never sour
 * or drop. A session the companion judged as unkind changes nothing about
 * closeness or feelings. It is never synced to the cloud and never shown to
 * the player.
 */

/** Closeness, in order. The stage only ever moves up, one step per update at most. */
export const BOND_STAGES = ['new', 'acquainted', 'familiar', 'close', 'bonded'] as const;
export type BondStage = (typeof BOND_STAGES)[number];

/** How the companion judged the player's treatment in the consolidated stretch (the perception step). */
export const BOND_TREATED = ['warm', 'neutral', 'badly'] as const;
export type BondTreated = (typeof BOND_TREATED)[number];

/** Per-list caps; renderBond also holds the whole rendering under BOND_MAX_CHARS. */
export const BOND_MAX_ITEMS = 3;
export const BOND_LINE_CHARS = 160;

const line = z.string().min(1).max(BOND_LINE_CHARS);

export const BondSchema = z.object({
  v: z.literal(1),
  stage: z.enum(BOND_STAGES),
  how_i_feel: z.array(line).max(BOND_MAX_ITEMS),
  names: z.array(line).max(BOND_MAX_ITEMS),
  running_jokes: z.array(line).max(BOND_MAX_ITEMS),
  standing_rules: z.array(line).max(BOND_MAX_ITEMS),
  /** How many consolidations have written this record. */
  updates: z.number().int().nonnegative(),
  updated_at: z.string(),
});

export type Bond = z.infer<typeof BondSchema>;

/** Where a bond update came from, for analytics (`bond_updated.source`). */
export type BondSource = 'fold' | 'session_end';
