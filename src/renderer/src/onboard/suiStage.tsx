/**
 * suiStage — the pieces every Sui scene shares (260731).
 *
 * Sui started as the first-run ritual only (OnboardApp), so her typewriter,
 * her voice-over, the corner controls and the continue hint all lived inside
 * that one file. She now fronts two in-app flows as well ("update my
 * preferences" and "meet my companion"), and each of those is the same stage
 * with a different script. Everything reusable moved here VERBATIM so there is
 * exactly one implementation of each behaviour; OnboardApp imports it and
 * keeps only its own script and branch logic.
 *
 * The scene art itself is OnboardScene.tsx; the styles are onboard.module.css.
 * Both are shared as-is.
 */
import React, { useEffect, useRef, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { t, useLangStore, useT, type UiLanguage } from '../lib/i18n';
import styles from './onboard.module.css';

/* ── Voice preferences ───────────────────────────────────────────────────
   Volume/mute for Sui's voice-over, persisted in localStorage (not config:
   it is a per-machine playback preference, and the scene must be able to read
   it synchronously on the first frame). */

export interface VoicePrefs {
  volume: number;
  muted: boolean;
}

const VOICE_PREFS_KEY = 'sei.onboard.voice';

export function loadVoicePrefs(): VoicePrefs {
  try {
    const raw = localStorage.getItem(VOICE_PREFS_KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<VoicePrefs>;
      if (typeof v.volume === 'number' && Number.isFinite(v.volume) && typeof v.muted === 'boolean') {
        return { volume: Math.min(1, Math.max(0, v.volume)), muted: v.muted };
      }
    }
  } catch {
    /* fall through to defaults */
  }
  // Voice ON by default.
  return { volume: 0.85, muted: false };
}

/** Voice prefs + the effective volume (0 while muted), persisted on change. */
export function useVoicePrefs(): {
  prefs: VoicePrefs;
  setPrefs: (next: VoicePrefs) => void;
  volume: number;
} {
  const [prefs, setPrefs] = useState<VoicePrefs>(loadVoicePrefs);
  const volume = prefs.muted ? 0 : prefs.volume;
  useEffect(() => {
    try {
      localStorage.setItem(VOICE_PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* volume just won't persist */
    }
  }, [prefs]);
  return { prefs, setPrefs, volume };
}

/* ── Sui's voice-over ────────────────────────────────────────────────────
   ENGLISH ONLY. Pre-generated clips bundled under
   public/voice/onboard/<clip>.en.mp3, PLAYED AS RECORDED. Chinese was tried on
   both flash_v2_5 and multilingual_v2 and cut (260730): her English voice
   carries a marked accent into Chinese, so zh scenes are text-only on purpose.

   How they are cut (260731). The pitch lift is BAKED IN, so nothing here
   touches playbackRate:

     1. ElevenLabs, voice tnVKC6NjwhdRxoQIfKue, model eleven_flash_v2_5,
        stability 0.75, style 0, output mp3_44100_128 — and NO speed. That is
        byte-for-byte the request a live call now sends.
     2. The SAME shifter a call uses: signalsmith-stretch, formantCompensation
        off, semitones = 12*log2(rate) — i.e. lib/voice/pitchBus.ts attach(),
        driven offline through a headless Chromium page. rate is Sui's
        voicePitch ON HER CLOUD ROW (1.25 at 260731b), not the code default.
     3. Encoded back to mp3 44100/128k mono, scaled down where the shift
        overshot 0 dBFS (a phase vocoder overshoots on hot material).

   Step 2 runs the real engine rather than an offline equivalent, because an
   equivalent is not what the scene needs to sound like. An earlier cut put the
   six "meet" lines through rubberband instead: it delivered the same 1.3 ratio
   to within measurement error and still did not sound like Sui, and two
   shifters across one script is an inconsistency with nothing to recommend it.
   Baking at all is what makes the ritual independent of the Web Audio graph —
   the first-run scene plays before any call has warmed the shifter.

   WATCH THE TAKE, NOT JUST THE SHIFT. An exclamation followed by a question
   ("So! ... ?") makes the model read high, and the lift then puts that line
   clear of everything around it: the first meet cut landed at 459 Hz against a
   script median of 315. So a new line is synthesized several times and the take
   whose median F0 sits in the script's band is the one kept. Nothing about the
   text changes; the model's variance between takes is wide enough on its own.

   Verified at 260731b: F0 256-408 Hz across all 29 clips, no clipping, onsets
   intact, and the 23 clips whose take did not change measured at exactly the
   1.25/1.30 ratio against their predecessors.

   They used to work the other way: synthesized at speed 1/1.3 and played at
   playbackRate 1.3 with preservesPitch off, so the resample cancelled the
   slowdown. That is the trick deleted at 260731 (see shared/voicePitch.ts),
   and it failed hardest exactly here — on the short exclamatory lines, where
   the model had no room to act on `speed`. Measured on the old files: the
   long lines came back 1.24-1.36x slow as asked, but "AHHHHH!" came back 1.08x
   and "Hey. I'm Sui!" 1.05x, so both played back roughly 20% too fast.

   To re-cut a line, run all three steps. Do NOT re-synthesize alone.

   A MISSING clip is silent, not an error: the typewriter carries the line on
   its own. That is what lets a new script ship before its clips are cut. */
export function useSuiVoice(clip: string | null, volume: number): void {
  const uiLang = useLangStore((s) => s.lang);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Volume through a ref so a slider drag applies to the PLAYING clip instead
  // of restarting the line.
  const volRef = useRef(volume);
  volRef.current = volume;
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);
  useEffect(() => {
    if (!clip || uiLang !== 'en') return undefined;
    const audio = new Audio(`./voice/onboard/${clip}.en.mp3`);
    audio.volume = volRef.current;
    audioRef.current = audio;
    void audio.play().catch(() => {
      /* missing clip or autoplay refusal: text carries the line */
    });
    return () => {
      audio.pause();
      if (audioRef.current === audio) audioRef.current = null;
    };
  }, [clip, uiLang]);
}

/* ── Corner controls (260730) ────────────────────────────────────────────
   One always-visible row in the top-right: [volume] [language] [close].
   Chrome-less by design — bare ink on the sky, no boxes. Each control's
   dropdown opens on HOVER (only two languages, so a popup would be
   overkill): the globe reveals two text items (EN / 中文), the speaker
   reveals a minimal vertical volume slider. Clicking the speaker toggles
   mute; clicking a language flips the live UI language and persists
   config.ui_language so the rest of the scene, and every character created
   after it, follows.

   The X means "leave this scene". In the first-run ritual there is nowhere to
   leave TO, so it quits the app (a bare window close on macOS left Sei sitting
   in the dock with no window); the in-app scenes pass their own way out. */

function VolumeIcon({ muted }: { muted: boolean }): React.ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 5 6.5 9H3v6h3.5L11 19V5Z" />
      {muted ? (
        <path d="m15 9 5 6M20 9l-5 6" />
      ) : (
        <>
          <path d="M14.5 9.5a3.6 3.6 0 0 1 0 5" />
          <path d="M17 7a7 7 0 0 1 0 10" />
        </>
      )}
    </svg>
  );
}

export function CornerControls(props: {
  prefs: VoicePrefs;
  onPrefs: (next: VoicePrefs) => void;
  /** What the X does. Omitted → quit the app (the first-run ritual). */
  onClose?: () => void;
  /** Accessible label for the X. Omitted → "Quit Sei". */
  closeLabel?: string;
  /** Drop the X entirely, for the stretch of a scene there is no backing out
   * of. A button that is present but does nothing reads as broken, and one
   * that falls through to its default here would quit the app. */
  closeHidden?: boolean;
}): React.ReactElement {
  const { prefs, onPrefs } = props;
  const tt = useT();
  const lang = useLangStore((s) => s.lang);
  const setLang = useLangStore((s) => s.setLang);
  const [open, setOpen] = useState<'vol' | 'lang' | null>(null);
  const pick = (next: UiLanguage): void => {
    setOpen(null);
    if (next === lang) return;
    setLang(next);
    void (async () => {
      try {
        const cfg = await sei.getConfig();
        await sei.saveConfig({ ...cfg, ui_language: next });
      } catch {
        /* live flip already happened; persistence retries on Settings */
      }
    })();
  };
  return (
    <div className={styles.corner} onClick={(e) => e.stopPropagation()}>
      <div
        className={styles.cornerItem}
        onMouseEnter={() => setOpen('vol')}
        onMouseLeave={() => setOpen((o) => (o === 'vol' ? null : o))}
      >
        <button
          type="button"
          className={styles.cornerBtn}
          aria-label={prefs.muted ? tt('Unmute voice') : tt('Mute voice')}
          onClick={() => onPrefs({ ...prefs, muted: !prefs.muted })}
        >
          <VolumeIcon muted={prefs.muted} />
        </button>
        {open === 'vol' ? (
          <div className={styles.volDrop}>
            <input
              className={styles.volRange}
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={prefs.muted ? 0 : prefs.volume}
              aria-label={tt('Voice volume')}
              // Dragging the slider always unmutes — a muted slider that
              // moves silently reads as broken.
              onChange={(e) => onPrefs({ volume: Number(e.target.value), muted: false })}
            />
          </div>
        ) : null}
      </div>
      <div
        className={styles.cornerItem}
        onMouseEnter={() => setOpen('lang')}
        onMouseLeave={() => setOpen((o) => (o === 'lang' ? null : o))}
      >
        <button
          type="button"
          className={styles.cornerBtn}
          aria-label={tt('Language')}
          aria-expanded={open === 'lang'}
          // Click also toggles the menu — hover opens it, but a click that
          // does nothing reads as broken.
          onClick={() => setOpen((o) => (o === 'lang' ? null : 'lang'))}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
          </svg>
        </button>
        {open === 'lang' ? (
          <div className={styles.langMenu} role="menu">
            <button
              type="button"
              role="menuitem"
              className={lang === 'en' ? `${styles.langItem} ${styles.langItemOn}` : styles.langItem}
              onClick={() => pick('en')}
            >
              EN
            </button>
            <button
              type="button"
              role="menuitem"
              className={lang === 'zh' ? `${styles.langItem} ${styles.langItemOn}` : styles.langItem}
              onClick={() => pick('zh')}
            >
              中文
            </button>
          </div>
        ) : null}
      </div>
      {/* An svg X (not a text ×): a glyph sits on the font baseline, which
          left it riding higher than the icon boxes beside it. */}
      {props.closeHidden ? null : (
        <button
          type="button"
          className={styles.cornerBtn}
          aria-label={props.closeLabel ? tt(props.closeLabel) : tt('Quit Sei')}
          onClick={() => (props.onClose ? props.onClose() : void sei.appQuit())}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" />
          </svg>
        </button>
      )}
    </div>
  );
}

/** Render a translated template with React nodes in {placeholder} slots.
 * Node substitution can't ride t()'s string params, and concatenating
 * separately translated fragments is banned, so the whole sentence stays ONE
 * dictionary key and the nodes are spliced in afterwards. The English key
 * itself renders correctly through the same path (split leaves the literal
 * text around each placeholder intact). */
export function fmtNodes(template: string, nodes: Record<string, React.ReactNode>): React.ReactNode {
  return template.split(/(\{[a-z]+\})/i).map((part, i) => {
    const m = /^\{([a-z]+)\}$/i.exec(part);
    if (!m) return part;
    return <React.Fragment key={i}>{nodes[m[1]] ?? part}</React.Fragment>;
  });
}

/* ── Typewriter ──────────────────────────────────────────────────────────── */

const CHAR_MS = 24;
// Breath at the end of a sentence (260729). `paused` is exposed so the talk
// flap can close the mouth for the beat instead of flapping through it.
const FULL_STOP_PAUSE_MS = 340;

/** Typewriter — chars appear over time; skip() completes instantly. */
export function useTypewriter(text: string): {
  shown: string;
  done: boolean;
  paused: boolean;
  skip: () => void;
} {
  const [n, setN] = useState(0);
  const [paused, setPaused] = useState(false);
  const skipRef = useRef(false);
  // Render-phase reset: when the line changes, `n` still holds the previous
  // line's count until an effect runs, and slicing the NEW text by the OLD
  // count flashed the whole next line for one frame (260729). Resetting
  // during render (the sanctioned derive-from-props pattern) means no commit
  // ever renders the new text with the stale count.
  const prevTextRef = useRef(text);
  if (prevTextRef.current !== text) {
    prevTextRef.current = text;
    setN(0);
    setPaused(false);
  }
  useEffect(() => {
    skipRef.current = false;
    setN(0);
    setPaused(false);
    if (text.length === 0) return undefined;
    let i = 0;
    let t: ReturnType<typeof setTimeout> | null = null;
    const step = (): void => {
      if (skipRef.current) return;
      i += 1;
      setN(i);
      if (i >= text.length) {
        setPaused(false);
        return;
      }
      // The pause lands after a sentence-ending stop that has a word after it
      // (mid-ellipsis dots don't qualify: only the one before the space does).
      const atStop = '.!?'.includes(text[i - 1]) && text[i] === ' ';
      setPaused(atStop);
      t = setTimeout(step, atStop ? FULL_STOP_PAUSE_MS : CHAR_MS);
    };
    t = setTimeout(step, CHAR_MS);
    return () => {
      if (t) clearTimeout(t);
    };
  }, [text]);
  return {
    shown: text.slice(0, n),
    done: n >= text.length,
    paused,
    skip: () => {
      skipRef.current = true;
      setPaused(false);
      setN(text.length);
    },
  };
}

/* ── Continue hint ───────────────────────────────────────────────────────── */

/** The "click" half of the continue hint: a mouse with the left button shaded. */
function MouseIcon(): React.ReactElement {
  return (
    <svg className={styles.hintMouse} viewBox="0 0 16 22" aria-label={t('Click')}>
      <rect x="1" y="1" width="14" height="20" rx="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 1 A7 7 0 0 0 1 8 L 8 8 Z" fill="currentColor" />
      <line x1="8" y1="1" x2="8" y2="8" stroke="currentColor" strokeWidth="1.2" />
      <line x1="1" y1="8" x2="15" y2="8" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

/** "(mouse) or ↵ to continue" — the idle nudge under a text-only line. */
export function ContinueHint(): React.ReactElement {
  const tt = useT();
  return (
    <div className={styles.continueHint}>
      <MouseIcon />{' '}
      {fmtNodes(tt('or {enter} to continue'), {
        enter: <span className={styles.hintGlyph}>&#x21B5;</span>,
      })}
    </div>
  );
}

/** Fade-out color: match the theme the app will be wearing on the other side. */
export function fadeThemeClass(): string {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? styles.fadeDark : styles.fadeLight;
}

/* ── Enter-advances ──────────────────────────────────────────────────────── */

/** Enter advances any line that advances on click. Form fields own their own
 * Enter (the auth panel, the name input), so focus inside one is ignored. */
export function useEnterAdvances(advance: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter') return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'SELECT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'BUTTON')
      )
        return;
      advance();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [advance]);
}
