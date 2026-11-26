/**
 * PartyFullHint (261124): the party is full, and here is how to free a slot.
 *
 *  - `PartyFullHint`: one brief styled line ("Your party is full. Unbind a
 *    companion to make room.") ending in a Free a slot button. Where adding
 *    a companion failed (Invite to party, creating one).
 *  - `FreeSlotButton`: the button alone, for a surface that already says the
 *    party is full in its own words (the World header, the import notice and
 *    Settings row, Sui's casting scene).
 *  - `FreeSlotPicker`: the party, one row per companion. Picking one opens
 *    their page on the Danger zone (More tab), where Unbind keeps its own
 *    confirm. Nothing is unbound here.
 *
 * Analytics and copy: lib/partyFull.ts (docs/agents/party-slots.md).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Character } from '@shared/characterSchema';
import { useT } from '../lib/i18n';
import { isHomeCharacter, railParty } from '../lib/homeLibrary';
import {
  FREE_A_SLOT,
  PARTY_FULL_HINT,
  type PartyFullSurface,
  openForUnbind,
  trackFreeSlotTapped,
  trackPartyFullShown,
} from '../lib/partyFull';
import { pickPalette } from '../lib/portraitPalettes';
import { portraitSrc } from '../lib/portraitSrc';
import { resolvedScheme } from '../lib/theme';
import { useAuthStore } from '../lib/stores/useAuthStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { useLibraryStateStore } from '../lib/stores/useLibraryStateStore';
import { useUiStore } from '../lib/stores/useUiStore';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import { PixelPortrait } from './PixelPortrait';
import styles from './PartyFullHint.module.css';

/** The party as the rail and Home count it, most recently active first. */
export function partyMembers<T extends Character>(
  characters: readonly T[],
  currentUserId: string | null,
  addedDefaultIds: Set<string>,
  addedWorldIds: Set<string>,
): T[] {
  return railParty(characters.filter((c) => isHomeCharacter(c, currentUserId, addedDefaultIds, addedWorldIds)));
}

/** partyMembers over the live stores. */
export function usePartyMembers(): Character[] {
  const characters = useDataStore((s) => s.characters);
  const addedDefaultIds = useLibraryStateStore((s) => s.addedDefaultIds);
  const addedWorldIds = useLibraryStateStore((s) => s.addedWorldIds);
  const authState = useAuthStore((s) => s.state);
  const currentUserId = authState.kind === 'signed_in' ? authState.user.id : null;
  return useMemo(
    () => partyMembers(characters, currentUserId, addedDefaultIds, addedWorldIds),
    [characters, currentUserId, addedDefaultIds, addedWorldIds],
  );
}

/** Pick who to unbind: opens that companion's page on the Danger zone. */
export function FreeSlotPicker({
  surface,
  onClose,
  onPicked,
}: {
  surface: PartyFullSurface;
  onClose: () => void;
  /** After a pick, once the page is on its way (e.g. close the dialog underneath). */
  onPicked?: () => void;
}): React.ReactElement {
  const navigate = useUiStore((s) => s.navigate);
  const party = usePartyMembers();
  return (
    <FreeSlotPickerView
      party={party}
      onClose={onClose}
      onPick={(id) => {
        onClose();
        openForUnbind(surface, id, navigate);
        onPicked?.();
      }}
    />
  );
}

/** The picker's markup for a given party (stateless, so tests can render it). */
export function FreeSlotPickerView({
  party,
  onPick,
  onClose,
}: {
  party: readonly Character[];
  onPick: (id: string) => void;
  onClose: () => void;
}): React.ReactElement {
  const t = useT();
  const theme = resolvedScheme();
  return (
    <ModalShell title={t(FREE_A_SLOT)} onClose={onClose} scrimClose tier="stacked">
      <p className={styles.pickerBody}>{t('Pick who to unbind. Their page opens at Unbind, and nothing changes until you confirm.')}</p>
      <ul className={styles.list} data-free-slot-picker="true">
        {party.map((c) => (
          <li key={c.id}>
            <button type="button" className={styles.member} data-party-member={c.id} onClick={() => onPick(c.id)}>
              <span className={styles.avatar} aria-hidden="true">
                <PixelPortrait
                  seed={c.id + c.name}
                  palette={pickPalette(c.id + c.name, theme)}
                  size={32}
                  portraitImage={portraitSrc(c.portrait_image)}
                  className={styles.avatarImg}
                />
              </span>
              <span className={styles.name}>{c.name}</span>
            </button>
          </li>
        ))}
      </ul>
      <ModalFooter>
        <Button kind="quiet" onClick={onClose}>
          {t('Cancel')}
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}

/**
 * The Free a slot button and its picker. Reports the surface as shown on
 * mount (once per surface per run).
 */
export function FreeSlotButton({
  surface,
  className,
  plain = false,
  onPicked,
}: {
  surface: PartyFullSurface;
  className?: string;
  /** Only `className` styles it (a surface with its own button look). */
  plain?: boolean;
  /** See FreeSlotPicker. */
  onPicked?: () => void;
}): React.ReactElement {
  const t = useT();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    trackPartyFullShown(surface);
  }, [surface]);
  return (
    <>
      <button
        type="button"
        className={[plain ? '' : styles.action, className ?? ''].filter(Boolean).join(' ')}
        data-free-slot={surface}
        onClick={() => {
          trackFreeSlotTapped(surface);
          setOpen(true);
        }}
      >
        {t(FREE_A_SLOT)}
      </button>
      {/* Portaled: a header or notice may be a containing block (transform,
          backdrop-filter) that would trap the fixed scrim. */}
      {open ? createPortal(
            <FreeSlotPicker surface={surface} onClose={() => setOpen(false)} onPicked={onPicked} />,
            document.body,
          ) : null}
    </>
  );
}

/** One line: the party is full, unbind someone, and the button that helps. */
export function PartyFullHint({
  surface,
  className,
}: {
  surface: PartyFullSurface;
  className?: string;
}): React.ReactElement {
  const t = useT();
  return (
    <div className={[styles.line, className ?? ''].filter(Boolean).join(' ')} role="status" data-party-full={surface}>
      <span>{t(PARTY_FULL_HINT)}</span>
      <FreeSlotButton surface={surface} />
    </div>
  );
}
