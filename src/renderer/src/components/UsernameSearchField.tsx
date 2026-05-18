/**
 * UsernameSearchField — TextField + "Look up" button + inline result state.
 *
 * Wraps `sei.searchMojangSkin(name)` (Plan 03 handler) with the verbatim UI-SPEC
 * error/success copy. Every failure path from main throws an Error whose message
 * begins with `MOJANG_LOOKUP_FAILED: <stage>: <human-readable>`; we route on the
 * human-readable suffix to surface the exact error copy from UI-SPEC §"Skin
 * editor — copy".
 *
 * Source: 09-UI-SPEC.md §"Skin editor (persona page section) — copy"
 *   - success:        "Found {Name}'s current skin."
 *   - no-such-user:   "No Minecraft account named {input}. Check the spelling."
 *   - rate-limited:   "Mojang is rate-limiting lookups. Wait a minute and try again."
 *   - network error:  "Couldn't reach Mojang. Check your connection and try again."
 *   - invalid input:  "That doesn't look like a Minecraft username. Use letters, digits, and underscores only."
 *
 * The success copy renders INLINE below the input (it's not an `onError` event);
 * the four failure variants go through the `onError` prop so the SkinEditor can
 * surface them in its shared error band.
 */

import React, { useState } from 'react';
import { sei } from '../lib/ipcClient';
import { ERROR_COPY } from '../lib/errors';
import { classifyRendererError } from '../lib/errors';
import { TextField } from './TextField';
import { Button } from './Button';
import styles from './UsernameSearchField.module.css';

export interface UsernameSearchFieldProps {
  onResolved: (result: { pngBase64: string; sha256: string; resolvedUsername: string }) => void;
  onError: (message: string) => void;
  disabled?: boolean;
}

type FieldState =
  | { kind: 'idle' }
  | { kind: 'searching' }
  | { kind: 'found'; resolvedUsername: string }
  | { kind: 'error'; copy: string; isNetwork: boolean };

/**
 * Map the main-side error message to one of the four UI-SPEC copy variants.
 * Plan 03's mojangSkinLookup.ts prefixes every throw with `MOJANG_LOOKUP_FAILED:`
 * followed by stage + human-readable detail; we route on substring matches
 * that the planner specified verbatim.
 */
function mapMojangError(
  rawMessage: string,
  input: string,
): { copy: string; isNetwork: boolean } {
  const lower = rawMessage.toLowerCase();
  if (lower.includes('no minecraft account named')) {
    return {
      copy: `No Minecraft account named ${input}. Check the spelling.`,
      isNetwork: false,
    };
  }
  if (lower.includes('rate-limited') || lower.includes('rate limited')) {
    return {
      copy: 'Mojang is rate-limiting lookups. Wait a minute and try again.',
      isNetwork: false,
    };
  }
  if (lower.includes('invalid characters') || lower.includes('invalid username')) {
    return {
      copy:
        "That doesn't look like a Minecraft username. Use letters, digits, and underscores only.",
      isNetwork: false,
    };
  }
  // Network-class shapes — classifyRendererError already routes ENOTFOUND/etc.
  // to NETWORK_OFFLINE. We treat that one as the "Couldn't reach Mojang" copy.
  const classified = classifyRendererError({ message: rawMessage });
  if (classified.class === 'NETWORK_OFFLINE') {
    return {
      copy: "Couldn't reach Mojang. Check your connection and try again.",
      isNetwork: true,
    };
  }
  // Generic Mojang failure — UI-SPEC copy from ERROR_COPY[MOJANG_LOOKUP_FAILED].
  return { copy: ERROR_COPY.MOJANG_LOOKUP_FAILED, isNetwork: false };
}

export function UsernameSearchField({
  onResolved,
  onError,
  disabled,
}: UsernameSearchFieldProps): React.ReactElement {
  const [input, setInput] = useState<string>('');
  const [state, setState] = useState<FieldState>({ kind: 'idle' });

  const trimmed = input.trim();
  const busy = state.kind === 'searching';
  const buttonDisabled = disabled || busy || trimmed.length === 0;

  const handleSearch = async (): Promise<void> => {
    if (buttonDisabled) return;
    setState({ kind: 'searching' });
    try {
      const res = await sei.searchMojangSkin(trimmed);
      setState({ kind: 'found', resolvedUsername: res.resolvedUsername });
      onResolved(res);
    } catch (err) {
      const rawMessage =
        err && typeof err === 'object' && 'message' in err
          ? String((err as { message: unknown }).message)
          : String(err);
      const mapped = mapMojangError(rawMessage, trimmed);
      setState({ kind: 'error', copy: mapped.copy, isNetwork: mapped.isNetwork });
      onError(mapped.copy);
    }
  };

  return (
    <div className={styles.wrapper}>
      <div className={styles.fieldEyebrow}>MOJANG USERNAME</div>
      <div className={styles.row}>
        <div className={styles.inputCol}>
          <TextField
            value={input}
            onChange={(v) => {
              setInput(v);
              // Reset stale result state on edit — the next click is a new lookup.
              if (state.kind !== 'idle' && state.kind !== 'searching') {
                setState({ kind: 'idle' });
              }
            }}
            placeholder="e.g. Notch"
            disabled={disabled || busy}
            onEnter={() => void handleSearch()}
            aria-label="Mojang username"
          />
        </div>
        <Button
          kind="primary"
          size="md"
          onClick={() => void handleSearch()}
          disabled={buttonDisabled}
        >
          {busy ? 'Searching...' : 'Look up'}
        </Button>
      </div>
      {state.kind === 'found' ? (
        <p className={`${styles.result} ${styles.success}`}>
          Found {state.resolvedUsername}&apos;s current skin.
        </p>
      ) : null}
      {state.kind === 'error' ? (
        <p
          className={`${styles.result} ${state.isNetwork ? styles.warn : styles.error}`}
        >
          {state.copy}
        </p>
      ) : null}
    </div>
  );
}
