/**
 * McInstallList — vertical list of detected Minecraft installs with selection.
 *
 * Scrollable container with max-height 320px so a user with many CurseForge
 * instances doesn't overflow the 520px-min-height modal. Each row is a
 * McInstallRow; the list strips the bottom-border on the last row via
 * a :last-child selector in CSS.
 */

import React from 'react';
import type { McInstall } from '@shared/ipc';
import { McInstallRow } from './McInstallRow';
import styles from './McInstallList.module.css';

export interface McInstallListProps {
  installs: McInstall[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
}

export function McInstallList({
  installs,
  selectedIds,
  onToggle,
}: McInstallListProps): React.ReactElement {
  return (
    <div className={styles.list} role="group" aria-label="Detected Minecraft installs">
      {installs.map((install) => (
        <McInstallRow
          key={install.id}
          install={install}
          selected={selectedIds.has(install.id)}
          onToggle={() => onToggle(install.id)}
        />
      ))}
    </div>
  );
}
