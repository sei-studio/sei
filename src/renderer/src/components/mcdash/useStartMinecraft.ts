/**
 * Start Minecraft (R1b, 260929): one button that selects the Sei profile in
 * the Minecraft Launcher and opens the launcher (main: mcLauncher.ts). The
 * player still presses Play.
 *
 * Shared by every place the setup and summon flow sends a player to the
 * launcher: the launch panel's steps, the Minecraft setup window, the
 * LAN-not-open, unsupported-version and Forge-block modals, and the end of
 * the setup wizard. Where no Sei profile exists yet the same slot offers
 * "Set up Sei profile", which opens the setup wizard directly, so no copy
 * ever tells a player to build a launcher installation by hand.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { supportedVersions } from 'minecraft-protocol/src/version.js';
import type { StartMinecraftResult } from '@shared/ipc';
import { sei } from '../../lib/ipcClient';
import { useT } from '../../lib/i18n';
import { useWizardStore } from '../../lib/stores/useWizardStore';
import { useMcSetupStore, selectReadyVersion } from './useMcSetupStore';

type TFunction = (en: string, params?: Record<string, string | number>) => string;

/**
 * The version of the newest Sei-ready profile on this machine, or null.
 * `known` is false until the first install scan answers (one is started if
 * nobody has scanned yet).
 */
export function useSeiProfile(): { known: boolean; version: string | null } {
  const installs = useMcSetupStore((s) => s.installs);
  const scan = useMcSetupStore((s) => s.scan);
  const wizardOpen = useWizardStore((s) => s.open);
  const wasOpen = useRef(wizardOpen);
  useEffect(() => {
    if (installs == null) void scan();
    // installs deliberately not a dependency: scan once, not on every result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scan]);
  // A wizard run that just finished may have created the profile.
  useEffect(() => {
    if (wasOpen.current && !wizardOpen) void scan();
    wasOpen.current = wizardOpen;
  }, [wizardOpen, scan]);
  return { known: installs != null, version: selectReadyVersion(installs, supportedVersions) };
}

export interface StartNote {
  tone: 'ok' | 'warn';
  text: string;
}

/** What to tell the player after a Start Minecraft press. */
export function startMinecraftNote(t: TFunction, res: StartMinecraftResult): StartNote {
  if (res.ok) {
    return res.alreadyOpen
      ? {
          tone: 'ok',
          text: t('The Minecraft Launcher is already open. Pick "{profile}" next to Play, then press Play.', {
            profile: res.profileName,
          }),
        }
      : {
          tone: 'ok',
          text: t('The Minecraft Launcher is opening with "{profile}" selected. Press Play.', {
            profile: res.profileName,
          }),
        };
  }
  if (res.reason === 'no_profile') {
    return { tone: 'warn', text: t('No Sei profile found. Use Set up Sei profile first.') };
  }
  return {
    tone: 'warn',
    text: res.profileName
      ? t('Could not open the Minecraft Launcher. Open it yourself, pick "{profile}" next to Play, and press Play.', {
          profile: res.profileName,
        })
      : t('Could not open the Minecraft Launcher. Open it yourself and pick the Sei profile next to Play.'),
  };
}

/**
 * When to ask main whether the launcher (or a game it started) is still up
 * after a successful Start Minecraft, in ms after the press (260929). A
 * handful of one-shot process listings, then the hint clears. The v0.6.5
 * smoke test had the launcher quit on its own "Unable to update the
 * launcher" error while Sei kept saying "is opening... Press Play." forever.
 */
export const LAUNCHER_CHECK_MS: readonly number[] = [20_000, 40_000, 60_000, 90_000, 120_000];

/** The hint once the launcher is gone without a game (see LAUNCHER_CHECK_MS). */
export function launcherGoneNote(t: TFunction, profileName: string): StartNote {
  return {
    tone: 'warn',
    text: t('Didn\'t see the launcher? Open the Minecraft Launcher, pick "{profile}" next to Play, and press Play.', {
      profile: profileName,
    }),
  };
}

/**
 * Runs the LAUNCHER_CHECK_MS checks after a successful press. `gone` fires
 * once on a definite "not running" and ends the watch; if the launcher stays
 * up (or the probe cannot tell) through every check, `timeout` fires so the
 * "opening... Press Play" hint does not linger. With no probe (an older
 * preload) only the timeout runs. Returns a cancel function.
 */
export function watchLauncher(
  probe: (() => Promise<boolean | null>) | undefined,
  on: { gone: () => void; timeout: () => void },
): () => void {
  let alive = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = (): void => {
    alive = false;
    clearTimeout(timer);
  };
  const lastMs = LAUNCHER_CHECK_MS[LAUNCHER_CHECK_MS.length - 1];
  if (typeof probe !== 'function') {
    timer = setTimeout(on.timeout, lastMs);
    return cancel;
  }
  const check = (i: number, prevMs: number): void => {
    if (i >= LAUNCHER_CHECK_MS.length) {
      on.timeout();
      return;
    }
    timer = setTimeout(() => {
      void probe()
        .catch(() => null)
        .then((running) => {
          if (!alive) return;
          // Only a definite "not running" changes the hint; unsure keeps it.
          if (running === false) on.gone();
          else check(i + 1, LAUNCHER_CHECK_MS[i]);
        });
    }, LAUNCHER_CHECK_MS[i] - prevMs);
  };
  check(0, 0);
  return cancel;
}

/** Press handler + the note to show under the button. */
export function useStartMinecraft(): {
  busy: boolean;
  note: StartNote | null;
  start: (mcVersion?: string | null) => Promise<void>;
} {
  const t = useT();
  const scan = useMcSetupStore((s) => s.scan);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<StartNote | null>(null);
  // The profile a successful press opened the launcher for; set = watching.
  const [watching, setWatching] = useState<{ profile: string } | null>(null);
  // useT hands back a new function every render; the checks must not restart
  // on each one, so they read the translator through a ref.
  const tRef = useRef(t);
  tRef.current = t;
  useEffect(() => {
    if (!watching) return;
    return watchLauncher(sei.minecraftRunning, {
      gone: () => setNote(launcherGoneNote(tRef.current, watching.profile)),
      timeout: () => setNote(null),
    });
  }, [watching]);
  const start = useCallback(
    async (mcVersion?: string | null) => {
      setBusy(true);
      setNote(null);
      setWatching(null);
      try {
        const res = await sei.startMinecraft(mcVersion ? { mcVersion } : {});
        setNote(startMinecraftNote(t, res));
        if (res.ok) setWatching({ profile: res.profileName });
        // The scan and main disagreed about the profile: re-scan so the
        // button turns back into Set up Sei profile.
        if (!res.ok && res.reason === 'no_profile') void scan();
      } catch {
        setNote(startMinecraftNote(t, { ok: false, reason: 'launch_failed' }));
      } finally {
        setBusy(false);
      }
    },
    [t, scan],
  );
  return { busy, note, start };
}

/** Opens the setup wizard that builds the "Sei <version>" profile. */
export function useOpenSeiProfileSetup(): (before?: () => void) => void {
  const openWizard = useWizardStore((s) => s.openWizard);
  return useCallback(
    (before?: () => void) => {
      before?.();
      openWizard(false);
    },
    [openWizard],
  );
}

export interface SeiProfileAction {
  /** False until the first install scan answers: render nothing yet. */
  known: boolean;
  /** A Sei-ready profile exists: the action is Start Minecraft. */
  ready: boolean;
  /** "Start Minecraft" or "Set up Sei profile", translated. */
  label: string;
  busy: boolean;
  onClick: () => void;
  /** Result line after a Start Minecraft press. */
  note: StartNote | null;
}

/**
 * The one "Sei profile" action for a surface: Start Minecraft when a Sei
 * profile exists, else Set up Sei profile (opens the wizard, after
 * `onBeforeSetup`, e.g. closing the current modal). The surface renders it
 * in its own button component and places `note` where it fits.
 */
export function useSeiProfileAction(opts: {
  /** Start this version's Sei profile (default: the newest ready one). */
  mcVersion?: string | null;
  onBeforeSetup?: () => void;
} = {}): SeiProfileAction {
  const t = useT();
  const profile = useSeiProfile();
  const { busy, note, start } = useStartMinecraft();
  const openSetup = useOpenSeiProfileSetup();
  const ready = profile.version != null;
  return {
    known: profile.known,
    ready,
    label: ready ? t('Start Minecraft') : t('Set up Sei profile'),
    busy,
    note,
    onClick: () => (ready ? void start(opts.mcVersion ?? profile.version) : openSetup(opts.onBeforeSetup)),
  };
}

/** Windows only (R7): the firewall prompt when opening to LAN is harmless. */
export function useFirewallHint(): string | null {
  const t = useT();
  return sei.platform === 'win32'
    ? t('Windows may ask whether Java can use the network. You can press Cancel. Sei joins your world from this computer, so it still works.')
    : null;
}
