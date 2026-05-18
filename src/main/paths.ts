/**
 * Canonical userData path resolution. ALL `<userData>/...` reads/writes
 * across main process must funnel through here so test harnesses can
 * later override `userDataOverride` if needed.
 *
 * Source: CONTEXT D-09 (paths under app.getPath('userData')).
 */
import { app } from 'electron';
import path from 'node:path';

let userDataOverride: string | null = null;

/** TEST-ONLY: override userData root. Production code must not call this. */
export function _setUserDataOverride(p: string | null): void {
  userDataOverride = p;
}

function userDataRoot(): string {
  return userDataOverride ?? app.getPath('userData');
}

export const paths = {
  userData: userDataRoot,
  configPath: () => path.join(userDataRoot(), 'config.json'),
  charactersDir: () => path.join(userDataRoot(), 'characters'),
  characterPath: (id: string) => path.join(userDataRoot(), 'characters', `${id}.json`),
  characterPortraitPath: (id: string) => path.join(userDataRoot(), 'characters', `${id}.png`),
  indexPath: () => path.join(userDataRoot(), 'characters', 'index.json'),
  apiKeyPath: () => path.join(userDataRoot(), 'api_key.bin'),
  logsDir: () => path.join(userDataRoot(), 'logs'),
  memoryDir: (characterId: string) => path.join(userDataRoot(), 'memory', characterId),
  // Phase 9 (09-02): per-persona skin PNG storage. Files live under
  // <userData>/skins/<personaId>.png. The persona id has already been
  // validated by main/ipc.ts's IdSchema (kebab-case slug regex, no '.', '/',
  // or '\\') before any of these path-builders is invoked, so path.join's
  // normalization never has to deal with an escape-attempting component.
  skinsDir: () => path.join(userDataRoot(), 'skins'),
  skinPngPath: (personaId: string) => path.join(userDataRoot(), 'skins', `${personaId}.png`),
  // Phase 9 (09-04): wizard state JSON. Persists which MC installs the user
  // ticked, `hasRunOnce` (gates the first-launch modal vs the settings-reopen
  // flow), and the last skin-server port (helps Plan 05 detect port drift —
  // see WARNING 7).
  wizardStatePath: () => path.join(userDataRoot(), 'skin-setup-state.json'),
};
