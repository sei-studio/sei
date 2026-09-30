/**
 * Survivor pick (game-adapters M2, 260908): which Don't Starve Together
 * survivor a character plays as. The CHARACTER chooses on first launch (plan
 * section 8, decision 3) through a one-off LLM call over the persona plus the
 * roster brief, following src/main/chess/chessProfile.ts; the result is
 * persisted SPARSE per character in UserConfig.dst_survivor (never in
 * character.metadata, which cloud-syncs verbatim), and the launch panel can
 * override it ("Marv wants to play as Wigfrid" + a change control).
 *
 * Never throws: a failed derivation stores and returns Wilson so the launch
 * can always proceed.
 */
import {
  DST_DEFAULT_SURVIVOR,
  DST_SURVIVOR_PREFABS,
  dstSurvivor,
  isDstSurvivorPrefab,
  renderDstRosterBrief,
} from '../../../shared/dstSurvivors';
import type { DstSurvivorPick } from '../../../shared/dstIpc';
import type { UserConfig } from '../../../shared/characterSchema';

export interface SurvivorPickDeps {
  getCharacter(id: string): Promise<{ name: string; persona: { expanded: string; source?: string } } | null>;
  loadConfig(): Promise<UserConfig>;
  updateConfig(mutate: (c: UserConfig) => UserConfig): Promise<UserConfig>;
  /** The one-off LLM call; returns tool input or null. Wrapped in try/catch. */
  pick(args: { name: string; persona: string; roster: string }): Promise<{ prefab?: unknown; reason?: unknown } | null>;
  log?: (msg: string) => void;
}

const PICK_TOOL = {
  name: 'pick_survivor',
  description: 'Choose which Don\'t Starve Together survivor this character plays as.',
  input_schema: {
    type: 'object' as const,
    properties: {
      prefab: {
        type: 'string',
        enum: [...DST_SURVIVOR_PREFABS],
        description: 'The survivor prefab id from the roster whose perks and downsides fit this character best.',
      },
      reason: {
        type: 'string',
        description: 'One sentence, in the character\'s own voice, on why they picked this survivor (shown to the player).',
      },
    },
    required: ['prefab', 'reason'],
  },
};

/** The real LLM call (chessProfile.ts pattern). Lazy imports keep tests Electron-free. */
export async function llmPick(args: { name: string; persona: string; roster: string }): Promise<{ prefab?: unknown; reason?: unknown } | null> {
  const { buildLlmProvider } = await import('../../llm');
  const { CHAT_TIMEOUT_MS } = await import('../../chat/sdk');
  const llm = await buildLlmProvider();
  const res = await llm.call({
    maxTokens: 300,
    system:
      'You map a game companion character to the Don\'t Starve Together survivor they would choose to play as. ' +
      'Read the persona, then the roster (every eligible survivor with stats, perks and downsides), and pick the one whose ' +
      'strengths and quirks fit the character: temperament, what they enjoy, how they treat others, what they would find funny to be. ' +
      'Do not default to Wilson unless the persona is genuinely plain. Call pick_survivor exactly once.',
    tools: [PICK_TOOL],
    toolChoice: { type: 'tool', name: 'pick_survivor' },
    messages: [
      {
        role: 'user',
        content: `Character name: ${args.name}\n\nPersona:\n${args.persona.slice(0, 4000)}\n\nRoster:\n${args.roster}`,
      },
    ],
    timeoutMs: CHAT_TIMEOUT_MS,
  });
  const toolUse = res.toolUses[0];
  return toolUse ? (toolUse.input as { prefab?: unknown; reason?: unknown }) : null;
}

export function defaultPickDeps(): SurvivorPickDeps {
  return {
    getCharacter: async (id) => {
      const { getCharacter } = await import('../../characterStore');
      const c = await getCharacter(id);
      return c ? { name: c.name, persona: { expanded: c.persona.expanded, source: c.persona.source } } : null;
    },
    loadConfig: async () => (await import('../../configStore')).loadConfig(),
    updateConfig: async (mutate) => (await import('../../configStore')).updateConfig(mutate),
    pick: llmPick,
    log: (m) => console.log(`[sei/dst] ${m}`),
  };
}

/** Read the stored pick without deriving one. */
export function readStoredPick(cfg: UserConfig, characterId: string): DstSurvivorPick | null {
  const row = cfg.dst_survivor?.[characterId];
  if (!row || !isDstSurvivorPrefab(row.prefab)) return null;
  return { prefab: row.prefab, source: row.source === 'user' ? 'user' : 'auto', reason: row.reason ?? '' };
}

/**
 * The character's survivor, deriving + persisting one on first use. A stored
 * pick whose prefab left the roster is re-derived.
 */
export async function getOrPickSurvivor(characterId: string, deps: SurvivorPickDeps = defaultPickDeps()): Promise<DstSurvivorPick> {
  const cfg = await deps.loadConfig();
  const stored = readStoredPick(cfg, characterId);
  if (stored) return stored;

  let pick: DstSurvivorPick = { prefab: DST_DEFAULT_SURVIVOR, source: 'auto', reason: '' };
  const character = await deps.getCharacter(characterId).catch(() => null);
  if (character) {
    try {
      const persona = character.persona.expanded || character.persona.source || '';
      const out = await deps.pick({ name: character.name, persona, roster: renderDstRosterBrief() });
      const prefab = typeof out?.prefab === 'string' ? out.prefab.trim().toLowerCase() : '';
      if (isDstSurvivorPrefab(prefab)) {
        pick = { prefab, source: 'auto', reason: String(out?.reason ?? '').trim().slice(0, 300) };
      } else if (out) {
        deps.log?.(`survivor pick returned an ineligible prefab (${String(out?.prefab)}), using ${DST_DEFAULT_SURVIVOR}`);
      }
    } catch (err) {
      deps.log?.(`survivor pick failed, using ${DST_DEFAULT_SURVIVOR}: ${(err as Error).message}`);
    }
  }
  await persist(characterId, pick, deps);
  deps.log?.(`${character?.name ?? characterId} plays as ${dstSurvivor(pick.prefab).name} (${pick.source})`);
  return pick;
}

/** User override from the launch panel; null forgets it (the character picks again next time). */
export async function setSurvivor(characterId: string, prefab: string | null, deps: SurvivorPickDeps = defaultPickDeps()): Promise<DstSurvivorPick> {
  if (prefab == null) {
    await deps.updateConfig((c) => {
      const next = { ...(c.dst_survivor ?? {}) };
      delete next[characterId];
      return { ...c, dst_survivor: Object.keys(next).length ? next : undefined };
    });
    return getOrPickSurvivor(characterId, deps);
  }
  if (!isDstSurvivorPrefab(prefab)) throw new Error(`not an eligible survivor: ${prefab}`);
  const pick: DstSurvivorPick = { prefab, source: 'user', reason: '' };
  await persist(characterId, pick, deps);
  return pick;
}

async function persist(characterId: string, pick: DstSurvivorPick, deps: SurvivorPickDeps): Promise<void> {
  try {
    await deps.updateConfig((c) => ({
      ...c,
      dst_survivor: { ...(c.dst_survivor ?? {}), [characterId]: { prefab: pick.prefab, source: pick.source, reason: pick.reason } },
    }));
  } catch (err) {
    deps.log?.(`survivor pick persist failed: ${(err as Error).message}`);
  }
}
