/**
 * First-launch migration. Idempotent.
 *
 * Sources:
 *   - CONTEXT D-10 (legacy persona → characters/sui.json)
 *   - RESEARCH §Resolved Q4 (TREAT AS FRESH — no cross-machine migration)
 *   - PATTERNS §"Idempotent migrations" (early-return pattern)
 *
 * Scope (v1):
 *   - Dev-clone case: user runs Electron app from same cwd that has CLI's config.json.
 *     We pull persona out and write characters/sui.json, then strip persona from cwd config.
 *   - Packaged-app case: cwd has no legacy file → no-op. Per RESEARCH §Resolved Q4
 *     packaged users start fresh — we do NOT attempt cross-machine memory migration.
 */
import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { saveCharacter } from './characterStore';
import { paths } from './paths';
import type { Character } from '../shared/characterSchema';

const logger = {
  info: (m: string) => console.log(`[sei] ${m}`),
  warn: (m: string) => console.warn(`[sei] ${m}`),
};

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true; }
  catch { return false; }
}

interface LegacyPersona {
  name?: string;
  backstory?: string;
  tone?: string;
}

interface LegacyConfigShape {
  persona?: LegacyPersona;
  [key: string]: unknown;
}

/**
 * Run on app boot, AFTER app.whenReady so userData path resolves.
 *
 * @param cwdConfigPath  Path to the legacy CLI's config.json (defaults to './config.json' in cwd).
 *                       Tests can pass a fixture path.
 */
export async function runFirstLaunchMigration(
  cwdConfigPath: string = path.resolve(process.cwd(), 'config.json'),
): Promise<void> {
  // Idempotent guard: already migrated → no-op
  if (await fileExists(paths.characterPath('sui'))) {
    return;
  }

  // No legacy file → nothing to migrate (packaged-app case)
  if (!await fileExists(cwdConfigPath)) {
    return;
  }

  let raw: string;
  try { raw = await readFile(cwdConfigPath, 'utf8'); }
  catch (err) {
    logger.warn(`migration: legacy config read failed: ${(err as Error).message}`);
    return;
  }

  let parsed: LegacyConfigShape;
  try { parsed = JSON.parse(raw); }
  catch (err) {
    logger.warn(`migration: legacy config invalid JSON, skipping: ${(err as Error).message}`);
    return;
  }

  if (!parsed.persona || typeof parsed.persona !== 'object') {
    return; // already migrated or never had a persona
  }

  // 260516-0yw: emit the new persona shape { source, expanded:'' }. Migration
  // uses RAW saveCharacter (NOT expandAndSaveCharacter) so first-launch does
  // NOT burn an Anthropic API call on a freshly-cloned dev tree. The first
  // time the user opens the migrated character in the GUI to summon, the bot
  // will throw an explicit error ("persona expansion missing — re-save the
  // character in the GUI to populate persona.expanded") prompting a re-save.
  // The renderer can also show a "Generate expanded persona" CTA on the Edit
  // modal when persona.expanded is empty.
  const p = parsed.persona;
  const character: Character = {
    id: 'sui',
    name: typeof p.name === 'string' && p.name.trim() ? p.name : 'Sui',
    persona: {
      source: typeof p.backstory === 'string' && p.backstory.trim()
        ? p.backstory
        : 'A curious companion who enjoys exploring blocky worlds alongside their friend.',
      expanded: '',
    },
    is_default: true,
    created: new Date().toISOString(),
    last_launched: null,
    playtime_ms: 0,
    portrait_image: null,
    // Phase 9 (09-01): new schema fields. Migrated legacy sui has no skin yet —
    // first-launch seedDefaultCharacters won't run for an already-existing id,
    // so the migrated sui stays on the 'none' skin until the user picks one.
    skin: { source: 'none', mojang_username: null, png_sha256: null, applied_at: null },
    username: null,
  };

  try {
    await saveCharacter(character);
    logger.info(`migration: created characters/sui.json from legacy persona (persona.expanded empty — user must re-save in the GUI to populate the LLM-expanded prompt before first summon)`);
  } catch (err) {
    logger.warn(`migration: saveCharacter failed: ${(err as Error).message}`);
    return;
  }

  // Strip persona from legacy file (idempotent — running twice is harmless).
  // WARNING-8 fix: only attempt to mutate the cwd legacy file when running
  // unpackaged (dev clone). In packaged builds the cwd is typically the
  // installer dir / signed Sei.app bundle, which is read-only — writeFile
  // would throw EROFS and noisily mark the otherwise-clean migration as
  // failed. Skipping the strip-write in packaged mode is harmless because
  // packaged users never had a legacy CLI cwd config to begin with (per
  // RESEARCH §Resolved Q4 — packaged users start fresh).
  const { persona, ...rest } = parsed;
  void persona;
  if (!app.isPackaged) {
    try {
      await writeFile(cwdConfigPath, JSON.stringify(rest, null, 2) + '\n', 'utf8');
      logger.info(`migration: stripped persona field from ${cwdConfigPath}`);
    } catch (err) {
      logger.warn(`migration: failed to strip persona from legacy config: ${(err as Error).message}`);
    }
  } else {
    logger.info('migration: skipping cwd config strip-write in packaged build (read-only bundle)');
  }
}
