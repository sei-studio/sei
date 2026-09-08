/**
 * GamesSettingsGroup — the Settings "Games" group (260908).
 *
 * One group for every game instead of a stack of per-game groups: the left
 * column lists the registered games (GAME_SETTINGS_SECTIONS, catalog order)
 * and the right column shows the selected game's rows. Three games' worth of
 * install status, ports and vision modes stacked as separate groups pushed
 * Language and Theme a whole screen down, and most players only ever set up
 * one of them.
 *
 * The list is a vertical tablist: arrow keys move between games and only the
 * selected tab sits in the tab order. Selection is screen-local state that
 * starts on the first registered game (Minecraft); it is not persisted, since
 * the list is short enough that landing on the first entry costs one click.
 */
import React, { useState } from 'react';
import { useT } from '../../lib/i18n';
import { GAME_SETTINGS_SECTIONS } from '../../lib/gameSettingsSections';
import type { GameSettingsSectionProps } from '../../lib/gameSettingsSections';
import styles from '../../screens/SettingsScreen.module.css';

export function GamesSettingsGroup(props: GameSettingsSectionProps): React.ReactElement {
  const t = useT();
  const sections = GAME_SETTINGS_SECTIONS;
  const [selectedGame, setSelectedGame] = useState(sections[0]?.game ?? 'minecraft');
  const selected = sections.find((s) => s.game === selectedGame) ?? sections[0];

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next = -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (index + 1) % sections.length;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (index - 1 + sections.length) % sections.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = sections.length - 1;
    if (next < 0) return;
    e.preventDefault();
    setSelectedGame(sections[next].game);
    const el = e.currentTarget.parentElement?.children[next];
    if (el instanceof HTMLElement) el.focus();
  };

  return (
    <div className={styles.gamesLayout}>
      <div className={styles.gamesNav} role="tablist" aria-orientation="vertical" aria-label={t('Games')}>
        {sections.map((section, i) => {
          const on = section.game === selected?.game;
          return (
            <button
              key={section.game}
              type="button"
              role="tab"
              id={`settings-game-tab-${section.game}`}
              aria-selected={on}
              aria-controls={`settings-game-pane-${section.game}`}
              tabIndex={on ? 0 : -1}
              className={on ? styles.gamesNavItemOn : styles.gamesNavItem}
              onClick={() => setSelectedGame(section.game)}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              {t(section.title)}
            </button>
          );
        })}
      </div>
      {selected ? (
        <div
          className={styles.gamesPane}
          role="tabpanel"
          id={`settings-game-pane-${selected.game}`}
          aria-labelledby={`settings-game-tab-${selected.game}`}
        >
          {/* Keyed on the game so a section's local state (an edited port, a
              "Copied" flash) never carries over into another game's pane. */}
          <selected.Section key={selected.game} config={props.config} writeConfig={props.writeConfig} />
        </div>
      ) : null}
    </div>
  );
}
