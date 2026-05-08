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
import { IpcChannel } from '../shared/ipc';
import { CharacterSchema, UserConfigSchema, type Character, type UserConfig } from '../shared/characterSchema';
import { loadConfig, saveConfig } from './configStore';
import { listCharacters, getCharacter, saveCharacter, deleteCharacter } from './characterStore';
import { saveApiKey, hasApiKey, backendKind } from './apiKeyStore';
import type { BotSupervisor } from './botSupervisor';

export interface IpcHandlerDeps {
  supervisor: BotSupervisor;
}

const IdSchema = z.string().min(1);
const PlaintextSchema = z.string().min(1);

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
  ipcMain.handle(IpcChannel.chars.save, async (_event, charArg: unknown): Promise<void> => {
    const character = CharacterSchema.parse(charArg);
    await saveCharacter(character);
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
