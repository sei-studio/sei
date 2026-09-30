/**
 * GAME_SETTINGS_SECTIONS — the per-game groups on the Settings screen (game
 * adapters M0, 260908). SettingsScreen renders one `.group` per entry, in
 * order, with the entry's title and its Section body. Minecraft's group is
 * the pre-M0 "Minecraft" group, content unchanged
 * (components/settings/MinecraftSettingsSection).
 *
 * Registering a game: `registerGameSettingsSection({ game, title, Section })`
 * from the game's module. `title` is the English string handed to t().
 */
import type React from 'react';
import type { UserConfig } from '@shared/characterSchema';
import type { GameId } from '@shared/gameIpc';
import { MinecraftSettingsSection } from '../components/settings/MinecraftSettingsSection';

export interface GameSettingsSectionProps {
  /** The loaded UserConfig (null before the first load). */
  config: UserConfig | null;
  /**
   * Write a patch through SettingsScreen's optimistic-then-rollback config
   * save (the same path the vision selector always used).
   */
  writeConfig: (patch: Partial<UserConfig>) => Promise<void>;
}

export interface GameSettingsSection {
  game: GameId;
  /** English group title (translated by the screen). */
  title: string;
  Section: React.ComponentType<GameSettingsSectionProps>;
}

export const GAME_SETTINGS_SECTIONS: GameSettingsSection[] = [
  { game: 'minecraft', title: 'Minecraft', Section: MinecraftSettingsSection },
];

export function registerGameSettingsSection(section: GameSettingsSection): void {
  const i = GAME_SETTINGS_SECTIONS.findIndex((s) => s.game === section.game);
  if (i >= 0) GAME_SETTINGS_SECTIONS[i] = section;
  else GAME_SETTINGS_SECTIONS.push(section);
}
