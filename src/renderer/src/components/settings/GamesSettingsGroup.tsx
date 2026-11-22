/**
 * GamesSettingsGroup â€” the Settings "Games & search" group (260908; it was
 * "Games" until 261023, when the web search rows moved in as a tab).
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
 *
 * `extraTabs` (261023) are non-game panes listed after the games, below a
 * thin rule: today only "Web search" (SearchSettingsSection), which used to
 * be its own group at the bottom of Settings. They share the tablist and the
 * keyboard behaviour; their ids are `settings-game-tab-<id>` like a game's.
 */
import React, { useState } from 'react';
import { useT } from '../../lib/i18n';
import { GAME_SETTINGS_SECTIONS } from '../../lib/gameSettingsSections';
import type { GameSettingsSectionProps } from '../../lib/gameSettingsSections';
import styles from '../../screens/SettingsScreen.module.css';

/** A non-game pane in the same tablist (261023: "Web search"). */
export interface SettingsExtraTab {
  id: string;
  /** English tab label (translated here). */
  title: string;
  render: () => React.ReactNode;
}

interface Props extends GameSettingsSectionProps {
  extraTabs?: SettingsExtraTab[];
}

export function GamesSettingsGroup({ extraTabs = [], ...props }: Props): React.ReactElement {
  const t = useT();
  const sections = GAME_SETTINGS_SECTIONS;
  const tabs: Array<{ id: string; title: string; extra: boolean }> = [
    ...sections.map((s) => ({ id: s.game as string, title: s.title, extra: false })),
    ...extraTabs.map((x) => ({ id: x.id, title: x.title, extra: true })),
  ];
  const [selectedId, setSelectedId] = useState<string>(tabs[0]?.id ?? 'minecraft');
  const selectedTab = tabs.find((x) => x.id === selectedId) ?? tabs[0];
  const selectedGame = selectedTab && !selectedTab.extra ? sections.find((s) => s.game === selectedTab.id) : undefined;
  const selectedExtra = selectedTab?.extra ? extraTabs.find((x) => x.id === selectedTab.id) : undefined;

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next = -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    setSelectedId(tabs[next].id);
    // By id, not by child index: the rule before the extra tabs is a child too.
    const el = e.currentTarget.ownerDocument?.getElementById(`settings-game-tab-${tabs[next].id}`);
    if (el instanceof HTMLElement) el.focus();
  };

  return (
    <div className={styles.gamesLayout}>
      <div className={styles.gamesNav} role="tablist" aria-orientation="vertical" aria-label={t('Games & search')}>
        {tabs.map((tab, i) => {
          const on = tab.id === selectedTab?.id;
          const firstExtra = tab.extra && (i === 0 || !tabs[i - 1].extra);
          return (
            <React.Fragment key={tab.id}>
              {firstExtra && i > 0 ? <div className={styles.gamesNavRule} aria-hidden="true" /> : null}
              <button
                type="button"
                role="tab"
                id={`settings-game-tab-${tab.id}`}
                aria-selected={on}
                aria-controls={`settings-game-pane-${tab.id}`}
                tabIndex={on ? 0 : -1}
                className={on ? styles.gamesNavItemOn : styles.gamesNavItem}
                onClick={() => setSelectedId(tab.id)}
                onKeyDown={(e) => onKeyDown(e, i)}
              >
                {t(tab.title)}
              </button>
            </React.Fragment>
          );
        })}
      </div>
      {selectedTab ? (
        <div
          className={styles.gamesPane}
          role="tabpanel"
          id={`settings-game-pane-${selectedTab.id}`}
          aria-labelledby={`settings-game-tab-${selectedTab.id}`}
        >
          {/* Keyed on the tab so a pane's local state (an edited port, a
              "Copied" flash, a half-typed key) never carries over. */}
          {selectedGame ? (
            <selectedGame.Section key={selectedGame.game} config={props.config} writeConfig={props.writeConfig} />
          ) : selectedExtra ? (
            <React.Fragment key={selectedExtra.id}>{selectedExtra.render()}</React.Fragment>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}




