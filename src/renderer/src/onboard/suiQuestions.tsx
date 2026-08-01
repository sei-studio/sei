/**
 * suiQuestions — the companion-preference questions as Sui asks them (260731).
 *
 * The same three questions ProfileQuestionsScreen asks as a form (age feel /
 * what you're looking for / art style) plus the per-cast gender question, in
 * the scene's register: pills and portrait tiles under her dialogue rather
 * than tiles in a shell. Shared by the first-run ritual (OnboardApp) and the
 * in-app "update my preferences" scene (SuiPrefsScene), so a wording or option
 * change lands in both.
 *
 * Prefill matters here in a way it does not during onboarding: the in-app
 * retake must show what the player already chose, so every picker takes an
 * `initial` and marks it selected.
 */
import React, { useState } from 'react';
import { useT } from '../lib/i18n';
import type { UniqueGender } from '@shared/ipc';
import type { UserPreferences } from '@shared/characterSchema';
import chibiF from '../assets/art-styles/chibi-female.jpg';
import chibiM from '../assets/art-styles/chibi-male.jpg';
import animeF from '../assets/art-styles/anime-female.jpg';
import animeM from '../assets/art-styles/anime-male.jpg';
import celF from '../assets/art-styles/celshaded-female.jpg';
import celM from '../assets/art-styles/celshaded-male.jpg';
import cartoonF from '../assets/art-styles/cartoon-female.jpg';
import cartoonM from '../assets/art-styles/cartoon-male.jpg';
import threeDF from '../assets/art-styles/3d-female.jpg';
import threeDM from '../assets/art-styles/3d-male.jpg';
import styles from './onboard.module.css';

export type AgeRange = NonNullable<UserPreferences['companion_age_range']>;
export type ArtStyle = NonNullable<UserPreferences['art_style']>;
export type Dynamic = NonNullable<UserPreferences['companion_dynamics']>[number];

export const DYN_OPTIONS: Array<{ value: Dynamic; label: string }> = [
  { value: 'partner-in-crime', label: 'A partner in crime' },
  { value: 'caretaker', label: 'Someone to look after me' },
  { value: 'protege', label: 'Someone to look after' },
  { value: 'chill-friend', label: 'A chill friend' },
  { value: 'challenger', label: 'Someone who pushes me' },
];

export const AGE_OPTIONS: Array<{ value: AgeRange; label: string }> = [
  { value: 'young-adult', label: 'Young adult' },
  { value: 'adult', label: 'Adult' },
  { value: 'mature', label: 'Mature' },
  { value: 'elder', label: 'Elder' },
  { value: 'timeless', label: 'Timeless' },
];

export const ART_OPTIONS: Array<{ value: ArtStyle; label: string; imgs: [string, string] }> = [
  { value: 'chibi', label: 'Round chibi', imgs: [chibiF, chibiM] },
  { value: 'anime', label: 'Anime', imgs: [animeF, animeM] },
  { value: 'celshaded', label: 'Cel-shaded', imgs: [celF, celM] },
  { value: 'cartoon', label: 'Cartoon', imgs: [cartoonF, cartoonM] },
  { value: '3d', label: '3D', imgs: [threeDF, threeDM] },
];

/** The per-cast question, and the only one that is not a stored preference.
 * "Nonbinary" (260731) replaced "Androgynous": the option describes the
 * companion, not a drawing style, and the plainer word is the one people use
 * about themselves. Values stay 'female' | 'male' | 'other'. */
export const GENDER_OPTIONS: Array<{ value: UniqueGender; label: string }> = [
  { value: 'female', label: 'Feminine' },
  { value: 'male', label: 'Masculine' },
  { value: 'other', label: 'Nonbinary' },
];

/** Rank-by-click multi-select for the dynamics question. "Surprise me" is a
 * selectable state (mutually exclusive with the ranked picks), and BOTH paths
 * confirm through the same Done button — a single-click Surprise-me that
 * advanced instantly read as a misclick trap (260729).
 *
 * `initial`: the stored ranking. `[]` is the explicit "Surprise me" (that is
 * what prefsSave writes for it); null/undefined means nothing chosen yet. */
export function DynPicker(props: {
  initial?: Dynamic[] | null;
  onDone: (dynamics: Dynamic[]) => void;
  onBack?: () => void;
}): React.ReactElement {
  const tt = useT();
  const [picked, setPicked] = useState<Dynamic[]>(props.initial ?? []);
  const [surprise, setSurprise] = useState(props.initial !== null && props.initial?.length === 0);
  const toggle = (v: Dynamic): void => {
    setSurprise(false);
    setPicked((cur) => (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]));
  };
  return (
    <div className={styles.choicesCol}>
      <div className={styles.choices}>
        {DYN_OPTIONS.map((o) => {
          const rank = picked.indexOf(o.value);
          return (
            <button
              key={o.value}
              className={rank >= 0 ? `${styles.pill} ${styles.pillPicked}` : styles.pill}
              onClick={() => toggle(o.value)}
            >
              {rank >= 0 ? <span className={styles.rankBadge}>{rank + 1}</span> : null}
              {tt(o.label)}
            </button>
          );
        })}
        <button
          className={surprise ? `${styles.pill} ${styles.pillPicked}` : styles.pill}
          onClick={() => {
            setSurprise((s) => !s);
            setPicked([]);
          }}
        >
          {tt('Surprise me')}
        </button>
      </div>
      <div className={styles.choices}>
        <button
          className={styles.pill}
          disabled={!surprise && picked.length === 0}
          onClick={() => props.onDone(surprise ? [] : picked)}
        >
          {tt('Done')}
        </button>
        {props.onBack ? (
          <button className={styles.quietLink} onClick={props.onBack}>
            {tt('Back')}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** One-click pill row (age, gender). Picking answers the question outright. */
export function PillPicker<T extends string>(props: {
  options: Array<{ value: T; label: string }>;
  selected?: T | null;
  onPick: (value: T) => void;
  onBack?: () => void;
}): React.ReactElement {
  const tt = useT();
  return (
    <div className={styles.choices}>
      {props.options.map((o) => (
        <button
          key={o.value}
          className={
            props.selected === o.value ? `${styles.pill} ${styles.pillPicked}` : styles.pill
          }
          onClick={() => props.onPick(o.value)}
        >
          {tt(o.label)}
        </button>
      ))}
      {props.onBack ? (
        <button className={styles.quietLink} onClick={props.onBack}>
          {tt('Back')}
        </button>
      ) : null}
    </div>
  );
}

/** The art-style question: the sample pair IS the choice, so the label lives
 * only in the aria-label. */
export function ArtPicker(props: {
  selected?: ArtStyle | null;
  onPick: (value: ArtStyle) => void;
  onBack?: () => void;
}): React.ReactElement {
  const tt = useT();
  return (
    <div className={styles.choicesCol}>
      <div className={styles.artRow}>
        {ART_OPTIONS.map((o) => (
          <button
            key={o.value}
            className={
              props.selected === o.value ? `${styles.artTile} ${styles.artTilePicked}` : styles.artTile
            }
            aria-label={tt(o.label)}
            onClick={() => props.onPick(o.value)}
          >
            <span className={styles.artImgs}>
              <img src={o.imgs[0]} alt="" draggable={false} />
              <img src={o.imgs[1]} alt="" draggable={false} />
            </span>
          </button>
        ))}
      </div>
      {props.onBack ? (
        <button className={styles.quietLink} onClick={props.onBack}>
          {tt('Back')}
        </button>
      ) : null}
    </div>
  );
}
