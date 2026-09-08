/**
 * Game adapters (M0, 260908): the chat-surface launch tool is built from the
 * catalog's self-launchable games. With one game (today's catalog) it must be
 * the exact pre-M0 Minecraft tool, byte for byte; with several it names them.
 */
import { describe, it, expect } from 'vitest';
import { LAUNCH_TOOL, launchToolFor, SELF_LAUNCH_GAMES } from './chatPrompts';
import { GAME_CATALOG } from '../../shared/games';

const PRE_M0_LAUNCH_TOOL = {
  name: 'launch',
  description:
    'Join the player in Minecraft and start playing alongside them — this pulls you out of chat and into their world. ' +
    'ONLY call this when the player clearly asks you to play or join right now (e.g. "let\'s play", "come in", "join me"). ' +
    'Do NOT call it to answer a question about connection status, or just because a world is open. ' +
    'Minecraft is the only game you can start yourself; the others in # GAMES are opened by the player, so suggest those in words instead of calling this. ' +
    'It begins joining immediately; if the player has no LAN world open you will be told so, and should ask them to open one. ' +
    'Whenever you do call it, acknowledge in the same turn that you\'re hopping in.',
  input_schema: {
    type: 'object',
    properties: {
      game: { type: 'string', enum: ['minecraft'], description: 'The game to launch. Only "minecraft" is available.' },
    },
    required: ['game'],
  },
};

describe('LAUNCH_TOOL', () => {
  it('is derived from the catalog rows with selfLaunch && available', () => {
    expect(SELF_LAUNCH_GAMES).toEqual(GAME_CATALOG.filter((g) => g.selfLaunch && g.available));
  });

  it('equals the pre-M0 Minecraft tool while Minecraft is the only self-launchable game', () => {
    expect(SELF_LAUNCH_GAMES.map((g) => g.id)).toEqual(['minecraft']);
    expect(LAUNCH_TOOL).toEqual(PRE_M0_LAUNCH_TOOL);
    expect(launchToolFor([])).toEqual(PRE_M0_LAUNCH_TOOL);
  });

  it('names every game and widens the enum once a second game is available', () => {
    const tool = launchToolFor([{ id: 'minecraft', name: 'Minecraft' }, { id: 'stardew', name: 'Stardew Valley' }]);
    expect(tool.input_schema.properties.game.enum).toEqual(['minecraft', 'stardew']);
    expect(tool.description).toContain('Minecraft or Stardew Valley');
    expect(tool.description).not.toContain('LAN world');
    expect(tool.description).not.toContain('—'.repeat(2));
  });
});
