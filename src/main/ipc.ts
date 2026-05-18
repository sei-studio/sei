/**
 * IPC handler registrations. Wires every IpcChannel.<request-response> to
 * its main-process module. Push channels (status / log / lan) are emitted
 * directly by main/index.ts via webContents.send.
 *
 * Sources:
 *   - shared/ipc.ts (IpcChannel, RendererApi)
 *   - PATTERNS §"Zod validation at every external boundary"
 */
import { ipcMain } from 'electron';
import { z } from 'zod';
import { IpcChannel, type WizardProgressEvent } from '../shared/ipc';
import { CharacterSchema, UserConfigSchema, type Character, type UserConfig } from '../shared/characterSchema';
import { loadConfig, saveConfig } from './configStore';
import { listCharacters, getCharacter, expandAndSaveCharacter, saveCharacter, deleteCharacter, resetMemoryForCharacter } from './characterStore';
import { saveApiKey, hasApiKey, backendKind } from './apiKeyStore';
import type { BotSupervisor } from './botSupervisor';

export interface IpcHandlerDeps {
  supervisor: BotSupervisor;
  /**
   * Phase 9 (09-02): returns the loopback skin server's baseUrl, or null if
   * the server failed to bind on boot. Used by the skin:get-server-url IPC
   * handler (Task 3) to surface the URL to the renderer + wizard. Closure-via-
   * getter so a future restart of the skin server is observable.
   */
  getSkinServerBaseUrl: () => string | null;
  /**
   * Phase 9 (09-05): per-step progress sink for the wizard install flow.
   * The orchestrator's `onProgress` callback funnels through here so the IPC
   * handler can push the event onto the `wizard:progress` channel via
   * `webContents.send`. Injected from main/index.ts where `mainWindow` lives.
   */
  sendWizardProgress: (ev: WizardProgressEvent) => void;
}

/**
 * Canonical persona-id validator. Used by every IPC handler that accepts a
 * characterId — chars.* (Phase 4) AND skin.* (Phase 9 Plan 02).
 *
 * BLOCKER 1 (09-02-PLAN): previously `z.string().min(1)`. Tightened to a
 * kebab-case slug regex now that Phase 9's skin:apply makes the persona id a
 * filesystem path component (`<userData>/skins/<id>.png`). The regex forbids
 * any character that could escape path.join — `.`, `/`, `\\`, null bytes,
 * whitespace — so a renderer that synthesizes a malformed id (e.g. via a
 * compromised contextBridge surface) is rejected at the IPC boundary BEFORE
 * skinStore.applyPng builds a filesystem path. Defense-in-depth.
 *
 * Existing chars.* handlers keep working unchanged because their callers
 * always pass an id that already conforms (the persona-create flow uses the
 * same slug format upstream — sui, mochineko, clawd, plus user-created
 * personas slugified at AddCharacterScreen.tsx).
 */
const IdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, {
  message: 'characterId must be a lowercase slug (a-z, 0-9, hyphen), 1-63 chars, starting with a letter or digit',
});
const PlaintextSchema = z.string().min(1);

/**
 * Phase 9 (09-02): skin:apply request shape.
 *
 * `characterId` MUST go through IdSchema (BLOCKER 1) — the persona id becomes
 * a filesystem path component inside skinStore.applyPng. The renderer's
 * preload bindings never validate; main is the trust boundary.
 *
 * `username` is the per-persona MC in-game name (WARNING 5 / D-09 atomic
 * skin+username write). Validation is delegated to CharacterSchema.parse()
 * inside saveCharacter — that's where the `^[A-Za-z0-9_]+$` length 1-16
 * regex lives. Empty string after trim = clear (null). Undefined/null = no change.
 */
const ApplySkinArgsSchema = z.object({
  characterId: IdSchema,
  pngBase64: z.string().min(1),
  source: z.enum(['upload', 'username']),
  mojangUsername: z.string().nullable().optional(),
  username: z.string().nullable().optional(),
});

export function registerIpcHandlers(deps: IpcHandlerDeps): void {
  // Bot supervision
  ipcMain.handle(IpcChannel.bot.summon, async (_event, idArg: unknown) => {
    const id = IdSchema.parse(idArg);
    await deps.supervisor.summon(id);
  });
  ipcMain.handle(IpcChannel.bot.stop, async () => {
    await deps.supervisor.stop();
  });

  // Character CRUD
  ipcMain.handle(IpcChannel.chars.list, async (): Promise<Character[]> => {
    return await listCharacters();
  });
  ipcMain.handle(IpcChannel.chars.get, async (_event, idArg: unknown): Promise<Character | null> => {
    const id = IdSchema.parse(idArg);
    return await getCharacter(id);
  });
  // 260516-0yw: chars.save runs the LLM expansion call (main owns the
  // Anthropic API key) and returns the persisted Character so the renderer
  // can update its store with the new persona.expanded.
  // 260517-frz: when the renderer passes `{ skipExpansion: true }`, main
  // writes `character.persona.expanded` verbatim and skips the LLM call.
  // This is how the Edit modal supports manual editing of the long-form
  // prompt — the user's edits win, no regeneration is triggered.
  ipcMain.handle(IpcChannel.chars.save, async (_event, charArg: unknown, optsArg: unknown): Promise<Character> => {
    const character = CharacterSchema.parse(charArg);
    const skipExpansion =
      optsArg != null &&
      typeof optsArg === 'object' &&
      (optsArg as { skipExpansion?: unknown }).skipExpansion === true;
    if (skipExpansion) {
      await saveCharacter(character);
      return character;
    }
    return await expandAndSaveCharacter({ character });
  });
  ipcMain.handle(IpcChannel.chars.delete, async (_event, idArg: unknown): Promise<void> => {
    const id = IdSchema.parse(idArg);
    // Refuse to delete sui — UI also gates this, but defense-in-depth.
    if (id === 'sui') throw new Error('Cannot delete the default character.');
    // Refuse to delete the active character — UI should never request this.
    if (deps.supervisor.getActiveId() === id) {
      throw new Error('Cannot delete the currently summoned character. Stop first.');
    }
    await deleteCharacter(id);
  });
  ipcMain.handle(IpcChannel.chars.resetMemory, async (_event, idArg: unknown): Promise<void> => {
    const id = IdSchema.parse(idArg);
    // Refuse while bot is reading/writing memory at runtime.
    if (deps.supervisor.getActiveId() === id) {
      throw new Error('Cannot reset memory of the currently summoned character. Stop first.');
    }
    await resetMemoryForCharacter(id);
  });

  // Phase 9 (09-02): skin pipeline. Plan 02 ships apply + remove +
  // get-server-url; Plan 03 adds upload + mojang. Lazy-import the skinStore
  // module inside the handler bodies so a future cyclic import (skinStore
  // → characterStore → ipc → skinStore) cannot deadlock at module-init time.
  ipcMain.handle(IpcChannel.skin.apply, async (_event, argsRaw: unknown) => {
    const args = ApplySkinArgsSchema.parse(argsRaw);
    const pngBytes = Buffer.from(args.pngBase64, 'base64');
    // Refuse while bot is connected — bot would keep serving the OLD skin
    // until disconnect, and the user's intuition is "skin shows up on next
    // summon". UI also gates this; defense-in-depth.
    if (deps.supervisor.getActiveId() === args.characterId) {
      throw new Error('Stop the bot before changing skin. Skin applies on next summon.');
    }
    const { applyPng } = await import('./skinStore');
    return await applyPng({
      personaId: args.characterId,
      pngBytes,
      source: args.source,
      mojangUsername: args.mojangUsername ?? null,
      // undefined = leave existing username untouched (renderer didn't ship a value);
      // empty string = explicit clear; any other string = explicit set.
      username: args.username ?? undefined,
    }); // { skin, username }
  });

  ipcMain.handle(IpcChannel.skin.remove, async (_event, idArg: unknown) => {
    const id = IdSchema.parse(idArg); // BLOCKER 1 — same strict slug validator as skin:apply
    if (deps.supervisor.getActiveId() === id) {
      throw new Error('Stop the bot before changing skin. Skin applies on next summon.');
    }
    const { removePng } = await import('./skinStore');
    const skin = await removePng(id);
    return { skin };
  });

  ipcMain.handle(IpcChannel.skin.getServerUrl, async () => {
    const baseUrl = deps.getSkinServerBaseUrl();
    if (!baseUrl) {
      // Skin server failed to bind on boot (SKIN_SERVER_PORT_TAKEN). Surface
      // as a rejected promise — the renderer's SkinEditor maps the throw to
      // ERROR_COPY[SKIN_SERVER_PORT_TAKEN] so the UI shows the relevant copy.
      throw new Error("Sei couldn't reserve a local port for serving skins. Restart Sei and try again.");
    }
    return { baseUrl };
  });

  // Phase 9 (09-03): native file picker for user-supplied skins + Mojang
  // username search. Both lazy-import the underlying module so a future
  // cyclic-import path can't deadlock at module-init time, and so test
  // harnesses that pull in IPC types don't drag electron.dialog / node:crypto
  // into module-eval (same rationale as the skinStore lazy import above).
  ipcMain.handle(IpcChannel.skin.uploadPng, async () => {
    const { openSkinPicker } = await import('./skinUpload');
    return await openSkinPicker(); // null when user cancels
  });

  ipcMain.handle(IpcChannel.skin.searchMojang, async (_event, usernameArg: unknown) => {
    // Zod gate at the IPC boundary — defense-in-depth even though
    // lookupMojangSkin re-validates with its own regex. Length 1..32 mirrors
    // Mojang's allowed username range (modern names cap at 16; pre-2014
    // legacy accounts can be longer — accept up to 32 here, let Mojang's
    // 204 path handle the "no such user" tail).
    const username = z.string().min(1).max(32).parse(usernameArg);
    const { lookupMojangSkin } = await import('./mojangSkinLookup');
    const res = await lookupMojangSkin(username);
    return {
      pngBase64: res.pngBase64,
      sha256: res.sha256,
      resolvedUsername: res.resolvedUsername,
    };
  });

  // Phase 9 (09-05): wizard install pipeline. Same lazy-import discipline as
  // the skin handlers — keeps the orchestrator + Plan 04 modules out of
  // module-init time so a cyclic import (wizard → ... → ipc) can't deadlock.
  //
  // wizard:detect-installs is read-only (scan) so no zod gate needed.
  // wizard:install / wizard:cancel are zod-gated; wizard:cancel's sessionId
  // is the BLOCKER 2 IPC-crossing routing key that maps to the main-side
  // AbortController in src/main/wizard.ts.
  ipcMain.handle(IpcChannel.wizard.detectInstalls, async () => {
    const { scanMcInstalls } = await import('./mcInstallScan');
    const installs = await scanMcInstalls();
    return { installs };
  });

  ipcMain.handle(IpcChannel.wizard.install, async (_event, argsRaw: unknown) => {
    // sessionId is REQUIRED (BLOCKER 2) — without it, wizard:cancel has no
    // routing key. installIds must be non-empty; the renderer should also
    // gate this but defense-in-depth at the IPC boundary. skinServerBaseUrl
    // is the loopback URL captured from skin:get-server-url — must be a
    // valid URL because the orchestrator parses .port off it for the
    // port-drift state update.
    const args = z.object({
      sessionId: z.string().min(1),
      installIds: z.array(z.string().min(1)).min(1),
      skinServerBaseUrl: z.string().url(),
    }).parse(argsRaw);
    const { runWizardInstall } = await import('./wizard');
    return await runWizardInstall({
      ...args,
      onProgress: (ev) => deps.sendWizardProgress(ev),
    });
  });

  ipcMain.handle(IpcChannel.wizard.cancel, async (_event, sessionIdArg: unknown) => {
    // BLOCKER 2 — the IPC-crossing abort. Resolves immediately after firing
    // .abort() on the matching controller; the in-flight runWizardInstall
    // promise then rejects (or emits a `cancelled` stage event) through
    // Plan 04's signal-aware modules. Fire-and-forget — we don't surface the
    // boolean return of abortWizardSession to the renderer because the user
    // doesn't care whether the cancel raced against a completed install;
    // either way the UI flips to "cancelled" via the progress channel.
    const sessionId = z.string().min(1).parse(sessionIdArg);
    const { abortWizardSession } = await import('./wizard');
    abortWizardSession(sessionId);
    return;
  });

  ipcMain.handle(IpcChannel.wizard.getState, async () => {
    const { loadWizardState } = await import('./wizardStateStore');
    return await loadWizardState();
  });

  // User config
  ipcMain.handle(IpcChannel.config.get, async (): Promise<UserConfig> => {
    return await loadConfig();
  });
  ipcMain.handle(IpcChannel.config.save, async (_event, cfgArg: unknown): Promise<void> => {
    const cfg = UserConfigSchema.parse(cfgArg);
    await saveConfig(cfg);
  });
  ipcMain.handle(IpcChannel.config.saveApiKey, async (_event, plaintextArg: unknown): Promise<void> => {
    const plaintext = PlaintextSchema.parse(plaintextArg);
    await saveApiKey(plaintext);
  });
  ipcMain.handle(IpcChannel.config.hasApiKey, async (): Promise<boolean> => {
    return await hasApiKey();
  });

  // App-level one-shot queries
  ipcMain.handle(IpcChannel.app.warnings, async () => {
    return {
      keychainFallbackPlaintext:
        process.platform === 'linux' && backendKind() === 'basic_text',
    };
  });
}
