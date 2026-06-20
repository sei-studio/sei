/**
 * SkinEditor — the full per-persona Skin & Username editor surface on CharacterPage.
 *
 * Composes:
 *   - SkinPreview3d (left column, 240×320)
 *   - IN-GAME USERNAME TextField + hint
 *   - SKIN SOURCE radio switch (Upload PNG / Search MC)
 *   - SkinUploadZone or UsernameSearchField (based on switch)
 *   - "Apply skin" (accent) CTA + "Remove skin" (inline two-click destructive)
 *
 * Atomicity contract:
 *   onApply makes ONE IPC call — applySkin({ characterId, pngBase64, source,
 *   mojangUsername, username }). The renderer does NOT make a separate
 *   character-save IPC call. The main-side applyPng persists skin descriptor +
 *   username in a single store-layer write, so there's no half-applied state
 *   on partial failure.
 *
 * Preview URL refresh contract:
 *   The previewUrl-deriving useEffect EXPLICITLY lists
 *   [character.username, character.skin, baseUrl, usernameDraft, stagedPng]
 *   as its dependencies, so the 3D preview refreshes the moment the user types
 *   into the in-game username field (the URL path embeds usernameDraft).
 *
 * Sui-gating rule (UI-SPEC §"Sui-gating"):
 *   SkinEditor renders for ALL personas, including is_default: true ones.
 *   Skin + username are user-personalization the project wants accessible
 *   across all personas. The persona-source/name editing gate stays in
 *   EditCharacterModal — that's unchanged.
 *
 * Bot-active gating:
 *   If the bot is currently summoned as THIS persona, Apply + Remove are
 *   disabled with the inline hint "Stop the bot before changing skin.
 *   Skin applies on next summon." (UI-SPEC §"Skin editor — copy").
 *
 * Source: 09-UI-SPEC.md §"Layout Contracts → Skin editor on CharacterPage"
 *         + §"Skin editor (persona page section) — copy"
 *         + §"Interaction States" (Apply CTA + Remove button rows)
 *         + EditCharacterModal.tsx two-click destructive pattern (Reset memory).
 */

import React, { useEffect, useRef, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useDataStore } from '../lib/stores/useDataStore';
import { useWizardStore } from '../lib/stores/useWizardStore';
import { classifyRendererError } from '../lib/errors';
import type { Character } from '@shared/characterSchema';
import { effectiveMcUsername } from '@shared/characterSchema';
import { Button } from './Button';
import { TextField } from './TextField';
import { SkinPreview3d } from './SkinPreview3d';
import { SkinUploadZone } from './SkinUploadZone';
import { UsernameSearchField } from './UsernameSearchField';
import styles from './SkinEditor.module.css';

export interface SkinEditorProps {
  character: Character;
  /** Caller refreshes its character store so the new skin + username propagate. */
  onChanged: () => void;
  /**
   * ITEM 13 (quick/260523-t8d): when true, render the read-only view path even
   * for non-default characters (used when CharacterPage detects a foreign-owned
   * cloud-imported character). Mirrors the existing `character.is_default`
   * branch — same 3D preview, no edit affordances.
   */
  viewOnly?: boolean;
  /**
   * When true, drop the standalone-section chrome (top margin, outer border,
   * extra padding) so the editor fits inside a host panel — e.g. the
   * CharacterPage Skin tab — without forcing the panel to scroll.
   */
  compact?: boolean;
}

interface StagedPng {
  pngBase64: string;
  sha256: string;
  source: 'upload' | 'username';
  /** Present only when source === 'username'. */
  mojangUsername?: string;
}

type Mode = 'idle' | 'applying';

const REMOVE_CONFIRM_WINDOW_MS = 4000;

/**
 * Mirror of src/bot/index.js sanitizeMcName for the renderer's preview-URL path.
 * The skin server routes /skins/<name>.png by the sanitized name when
 * the persona has no character.username set — we use the same algorithm here so
 * the preview URL matches what CustomSkinLoader will actually ask for.
 *
 * Mojang username constraints: [A-Za-z0-9_], ≤16 chars, non-empty (falls back
 * to 'Sei' if the persona name reduces to empty after sanitization).
 */
function sanitizeMcName(name: string): string {
  const cleaned = String(name || '')
    .replace(/[^A-Za-z0-9_]/g, '')
    .slice(0, 16);
  return cleaned || 'Sei';
}

/** MC username regex — matches CharacterSchema.username constraint. */
const MC_NAME_RE = /^[A-Za-z0-9_]{0,16}$/;

export function SkinEditor({
  character,
  onChanged,
  viewOnly = false,
  compact = false,
}: SkinEditorProps): React.ReactElement {
  const sectionClass = compact ? `${styles.section} ${styles.sectionCompact}` : styles.section;
  // ── Source-of-skin switch + staged PNG bytes ─────────────────────────────
  const [tab, setTab] = useState<'upload' | 'search'>('search');
  const [stagedPng, setStagedPng] = useState<StagedPng | null>(null);

  // ── In-game username field ───────────────────────────────────────────────
  // Defaults to the persisted character.username (or the persona name as a
  // visible placeholder hint). The field stores empty-string to mean "use the
  // fallback" — onApply translates empty → null at the IPC boundary.
  const [usernameDraft, setUsernameDraft] = useState<string>(character.username ?? '');
  const [usernameError, setUsernameError] = useState<string | null>(null);

  // ── Apply / Remove flow state ────────────────────────────────────────────
  const [mode, setMode] = useState<Mode>('idle');
  const [error, setError] = useState<string | null>(null);
  const [successToast, setSuccessToast] = useState<boolean>(false);
  const [removeArmed, setRemoveArmed] = useState<boolean>(false);
  const [removeDone, setRemoveDone] = useState<boolean>(false);
  const removeTimerRef = useRef<number | null>(null);

  // ── Skin-server base URL — fetched once on mount ─────────────────────────
  const [baseUrl, setBaseUrl] = useState<string | null>(null);

  // ── Computed: preview data URL or skin-server URL ────────────────────────
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // ── Bot-active gating ────────────────────────────────────────────────────
  // Per-character (multi-summon): true only when THIS persona's bot is online.
  const botActiveForThisPersona = useDataStore(
    (s) => s.summons[character.id]?.kind === 'online',
  );

  // ── Username-collision warning ───────────────────────────────────────────
  // In offline-mode LAN, the world keys inventory + position by the in-game
  // username (offline UUID). If two characters log in under the SAME name they
  // share that playerdata — summon one after the other and the second inherits
  // the first's items and location. Warn when this persona's effective name
  // collides with another library character so the user can rename one. The
  // resolved name uses the live draft, so the warning clears as they type.
  const allCharacters = useDataStore((s) => s.characters);
  const resolvedMcName = effectiveMcUsername({ username: usernameDraft, name: character.name });
  const usernameCollision = allCharacters.find(
    (c) =>
      c.id !== character.id &&
      effectiveMcUsername(c).toLowerCase() === resolvedMcName.toLowerCase(),
  );

  // ── Skin-setup gating ────────────────────────────────────────────────────
  // The 3D preview always renders (it hits the local skin server), but the
  // skin only actually appears in Minecraft once the host's MC client has
  // CustomSkinLoader installed via the setup wizard. When setup has never
  // completed (WizardState.hasRunOnce === false), cover the preview with a
  // "set up skins" nudge so the user isn't misled into thinking the in-Sei
  // preview is what they'll see in-game. null = still loading (no overlay).
  const openWizard = useWizardStore((s) => s.openWizard);
  const wizardOpen = useWizardStore((s) => s.open);
  const [skinsSetUp, setSkinsSetUp] = useState<boolean | null>(null);
  useEffect(() => {
    // Re-check on mount AND whenever the wizard closes (the user may have just
    // finished setup) so the overlay clears without a page reload. Skip while
    // the wizard is open — that fetch would race its in-flight install.
    if (wizardOpen) return;
    let cancelled = false;
    void (async () => {
      try {
        const st = await sei.getWizardState();
        if (!cancelled) setSkinsSetUp(st.hasRunOnce);
      } catch {
        // On a transient IPC failure, don't cover the preview with a false
        // "not set up" overlay — assume set up.
        if (!cancelled) setSkinsSetUp(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wizardOpen]);

  useEffect(() => {
    // Fetch the skin-server base URL once. If it rejects (port reservation
    // failed at boot), surface SKIN_SERVER_PORT_TAKEN copy via setError.
    let cancelled = false;
    (async () => {
      try {
        const res = await sei.getSkinServerUrl();
        if (!cancelled) setBaseUrl(res.baseUrl);
      } catch (err) {
        if (!cancelled) {
          const classified = classifyRendererError(err);
          setError(classified.copy);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // INFO 10 — preview URL refresh effect.
  //
  // The dep array MUST include character.username (the persisted username, in
  // case main updates it out-of-band), character.skin (re-fetch on applySkin
  // success), baseUrl (becomes non-null once getSkinServerUrl resolves),
  // usernameDraft (the user typing into the IN-GAME USERNAME field — this is
  // why the dep list cannot be reduced), and stagedPng (data: URL preview wins
  // over the server URL when bytes are staged).
  // INFO 10 — useEffect dep array includes character.username (see deps below).
  useEffect(() => {
    if (stagedPng) {
      setPreviewUrl(`data:image/png;base64,${stagedPng.pngBase64}`);
      return;
    }
    if (!baseUrl) {
      setPreviewUrl(null);
      return;
    }
    // Even when skin.source==='none' (newly-created persona), show the 3D
    // preview by hitting the local skin server with the bot's effective
    // username. The server returns a transparent PNG for unknown personas;
    // skinview3d still renders it (Steve-shaped silhouette).
    const serverName = usernameDraft.trim() || character.username || sanitizeMcName(character.name);
    const cacheBust = character.skin.png_sha256 ?? String(Date.now());
    setPreviewUrl(`${baseUrl}/skins/${encodeURIComponent(serverName)}.png?sha=${cacheBust}`);
  }, [character.username, character.skin, baseUrl, usernameDraft, stagedPng, character.name]);

  // Clean up the remove-armed timer on unmount.
  useEffect(() => {
    return () => {
      if (removeTimerRef.current !== null) {
        window.clearTimeout(removeTimerRef.current);
        removeTimerRef.current = null;
      }
    };
  }, []);

  // ── Username field validation (renderer-side, mirrors CharacterSchema) ───
  const onUsernameChange = (v: string): void => {
    setUsernameDraft(v);
    // Empty is allowed (means "use fallback") — only flag if non-empty AND invalid.
    if (v.length > 0 && !MC_NAME_RE.test(v)) {
      setUsernameError('Letters, digits, and underscores only, max 16 characters.');
    } else {
      setUsernameError(null);
    }
  };

  // ── Apply skin — single-call atomic apply ───────────────────────────────
  const onApply = async (): Promise<void> => {
    if (!stagedPng) return;
    if (usernameError) return;
    setMode('applying');
    setError(null);
    try {
      // ONE IPC call that atomically updates skin descriptor + per-persona MC
      // username in a single store-layer write (main-side). The renderer must
      // not issue a separate character-save IPC before this — that would be
      // two round-trips and risk a half-applied state.
      await sei.applySkin({
        characterId: character.id,
        pngBase64: stagedPng.pngBase64,
        source: stagedPng.source,
        mojangUsername: stagedPng.mojangUsername ?? null,
        username: usernameDraft.trim() || null,
      });
      setStagedPng(null);
      setSuccessToast(true);
      window.setTimeout(() => setSuccessToast(false), 3000);
      onChanged();
    } catch (err) {
      const classified = classifyRendererError(err);
      setError(classified.copy);
    } finally {
      setMode('idle');
    }
  };

  // ── Remove skin — inline two-click confirm (EditCharacterModal pattern) ──
  const onRemoveClick = async (): Promise<void> => {
    if (!removeArmed) {
      setRemoveArmed(true);
      // Auto-disarm after 4 seconds if the user doesn't click again.
      if (removeTimerRef.current !== null) {
        window.clearTimeout(removeTimerRef.current);
      }
      removeTimerRef.current = window.setTimeout(() => {
        setRemoveArmed(false);
        removeTimerRef.current = null;
      }, REMOVE_CONFIRM_WINDOW_MS);
      return;
    }
    // Second click within the window — actually remove.
    if (removeTimerRef.current !== null) {
      window.clearTimeout(removeTimerRef.current);
      removeTimerRef.current = null;
    }
    setRemoveArmed(false);
    setError(null);
    try {
      await sei.removeSkin(character.id);
      setRemoveDone(true);
      window.setTimeout(() => setRemoveDone(false), 3000);
      onChanged();
    } catch (err) {
      const classified = classifyRendererError(err);
      setError(classified.copy);
    }
  };

  // ── Render helpers ───────────────────────────────────────────────────────
  const applyDisabled =
    !stagedPng || mode === 'applying' || botActiveForThisPersona || !!usernameError;
  const showDefaultBadge =
    character.skin.source === 'bundled' && !stagedPng;

  // Left column = 3D preview, optionally covered by the skin-setup nudge.
  // Shared between the view-only/default branch and the editable branch so
  // the overlay behaves identically in both.
  const previewColumn = (
    <div className={styles.left}>
      <SkinPreview3d pngDataUrl={previewUrl} personaName={character.name} />
      {skinsSetUp === false ? (
        <div className={styles.setupOverlay}>
          <div className={styles.setupOverlayTitle}>Skin setup not complete</div>
          <p className={styles.setupOverlayBody}>
            Your skin won’t show in Minecraft until you set up skins on this computer.
          </p>
          <Button kind="accent" size="sm" onClick={() => openWizard(true)}>
            Set up skins
          </Button>
        </div>
      ) : null}
    </div>
  );

  // Skins are locked on default personas AND on foreign-owned cloud-imported
  // characters (ITEM 13 viewOnly path) — show the 3D preview but hide every
  // edit affordance. Users who want a different skin create their own persona.
  if (character.is_default || viewOnly) {
    return (
      <section className={sectionClass}>
        <div className={styles.header}>
          <div className={styles.eyebrow}>SKIN &amp; USERNAME</div>
          <span className={styles.defaultBadge}>Public skin</span>
        </div>
        <div className={styles.cols}>
          {previewColumn}
          <div className={styles.right}>
            {/*
              ITEM 14 (quick/260523-t8d): removed the "Default personas keep their
              bundled skin and username. Create a custom persona to use your own
              skin." paragraph — the Public skin badge above already conveys
              read-only state.
            */}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className={sectionClass}>
      <div className={styles.header}>
        <div className={styles.eyebrow}>SKIN &amp; USERNAME</div>
        {showDefaultBadge ? (
          // ITEM 14 (quick/260523-t8d): "Default skin" → "Public skin".
          <span className={styles.defaultBadge}>Public skin</span>
        ) : null}
      </div>

      <div className={styles.cols}>
        {previewColumn}

        <div className={styles.right}>
          {/* IN-GAME USERNAME field ─────────────────────────────────────── */}
          <div className={styles.fieldEyebrow}>IN-GAME USERNAME</div>
          <TextField
            value={usernameDraft}
            onChange={onUsernameChange}
            placeholder={character.name}
            disabled={mode === 'applying' || botActiveForThisPersona}
            aria-label="In-game username"
            aria-invalid={!!usernameError}
          />
          {usernameError ? (
            <p className={styles.errorCopy}>{usernameError}</p>
          ) : (
            <p className={styles.hint}>
              This is the name other players see above the bot. Any text works in offline LAN
              worlds.
            </p>
          )}
          {!usernameError && usernameCollision ? (
            <p className={styles.warnCopy}>
              {`${usernameCollision.name} also joins as "${resolvedMcName}". In a world, two
              characters with the same in-game name share one inventory and location — summon one
              after the other and the second inherits the first's items and spot. Give one a
              different name to keep them separate.`}
            </p>
          ) : null}

          {/* SKIN SOURCE radio switch ─────────────────────────────────── */}
          <div className={styles.fieldEyebrow}>SKIN SOURCE</div>
          <div className={styles.sourceTabs} role="radiogroup" aria-label="Skin source">
            <label className={styles.sourceTabLabel}>
              <input
                type="radio"
                name="skin-source"
                checked={tab === 'upload'}
                onChange={() => setTab('upload')}
                disabled={mode === 'applying' || botActiveForThisPersona}
              />{' '}
              Upload PNG
            </label>
            <label className={styles.sourceTabLabel}>
              <input
                type="radio"
                name="skin-source"
                checked={tab === 'search'}
                onChange={() => setTab('search')}
                disabled={mode === 'applying' || botActiveForThisPersona}
              />{' '}
              Search MC
            </label>
          </div>

          {tab === 'upload' ? (
            <SkinUploadZone
              onUpload={(r) => {
                setStagedPng({ pngBase64: r.pngBase64, sha256: r.sha256, source: 'upload' });
                setError(null);
              }}
              onError={(msg) => setError(msg)}
              disabled={mode === 'applying' || botActiveForThisPersona}
            />
          ) : (
            <UsernameSearchField
              initialValue={character.skin.mojang_username ?? ''}
              onResolved={(r) => {
                setStagedPng({
                  pngBase64: r.pngBase64,
                  sha256: r.sha256,
                  source: 'username',
                  mojangUsername: r.resolvedUsername,
                });
                setError(null);
              }}
              onError={(msg) => setError(msg)}
              disabled={mode === 'applying' || botActiveForThisPersona}
            />
          )}

          {/* CTA row — Apply skin + Remove skin ─────────────────────────── */}
          <div className={styles.ctaRow}>
            <Button
              kind="accent"
              size="md"
              onClick={() => void onApply()}
              disabled={applyDisabled}
            >
              {mode === 'applying' ? 'Applying...' : 'Apply skin'}
            </Button>
            <button
              type="button"
              className={styles.removeBtn}
              onClick={() => void onRemoveClick()}
              disabled={mode === 'applying' || botActiveForThisPersona}
            >
              {removeDone
                ? 'Skin removed'
                : removeArmed
                  ? 'Click again to remove'
                  : 'Remove skin'}
            </button>
          </div>

          {/* Inline status copy band ───────────────────────────────────── */}
          {botActiveForThisPersona ? (
            <p className={styles.warnCopy}>
              Stop the bot before changing skin. Skin applies on next summon.
            </p>
          ) : null}
          {error ? <p className={styles.errorCopy}>{error}</p> : null}
          {/*
            ITEM 11 (quick/260523-t8d): also gate on character.skin.source ===
            'none'. Once any skin source is applied ('bundled' | 'upload' |
            'username'), the helper text is stale — the user has obviously
            already picked one.
          */}
          {!stagedPng && !botActiveForThisPersona && mode !== 'applying' && !error && character.skin.source === 'none' ? (
            <p className={styles.hint}>Pick an upload or search a username first.</p>
          ) : null}
          {successToast ? (
            <p className={styles.successCopy}>
              {"Skin applied. It'll show up on the next bot summon."}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
