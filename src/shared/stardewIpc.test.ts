import { describe, it, expect } from 'vitest';
import { StardewHelloSchema, StardewModConfigSchema, steamLaunchOption, isStardewDashboardSnapshot, STARDEW_MOD_PACK_PATH } from './stardewIpc';

describe('stardewIpc contract', () => {
  it('parses a hello and a mod config with defaults', () => {
    const hello = StardewHelloSchema.parse({ mod: 'SeiCompanion', version: '0.1.0', protocol: 1, save: { loaded: true, farmName: 'Sunny', uniqueId: '1', day: 2, season: 'spring' } });
    expect(hello.save.farmName).toBe('Sunny');
    expect(StardewHelloSchema.safeParse({ mod: 'x' }).success).toBe(false);
    expect(StardewModConfigSchema.parse({})).toEqual({ Port: 27431, Token: '', AnnounceInChat: true, ObserveHz: 2, StartingGold: 500, DisconnectGraceSeconds: 10, DevCommands: false, FarmerLook: true });
  });

  it('formats the Steam launch option and names the pack path', () => {
    expect(steamLaunchOption('C:\\Games\\Stardew Valley\\')).toBe('"C:\\Games\\Stardew Valley\\StardewModdingAPI.exe" %command%');
    expect(steamLaunchOption('/x/Stardew Valley')).toBe('"\\x\\Stardew Valley\\StardewModdingAPI.exe" %command%');
    expect(STARDEW_MOD_PACK_PATH).toEqual(['assets', 'stardew-mod', 'SeiCompanion']);
    expect(isStardewDashboardSnapshot({ game: 'stardew', items: [] })).toBe(true);
    expect(isStardewDashboardSnapshot({ game: 'minecraft', items: [] })).toBe(false);
  });
});
