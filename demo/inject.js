// demo/inject.js — injected via Playwright addInitScript BEFORE the renderer's
// own scripts run, so `window.sei` is present the moment src/lib/ipcClient.ts
// does `export const sei = window.sei`.
//
// It stands up a FAKE `window.sei` bridge backed by in-memory fixtures so the
// React renderer believes it's talking to a real Electron main process. No
// keychain, no Minecraft, no cloud — every screen state is scripted. A small
// `window.__demo` control surface lets the Node-side recorder drive the summon
// state machine deterministically (connecting -> online) instead of relying on
// timers.
//
// Mode: LOCAL (auth defaults to { kind: 'local' }) so none of the cloud
// surfaces mount — no ToS modal, no credits UI, no email-verify banner.
(() => {
  'use strict';

  // ── Fixtures ──────────────────────────────────────────────────────────────
  // The recorder injects window.__seiFixtures (the real Sui / Lyra / Marv
  // default-character objects, read from resources/default-characters) and
  // window.__seiConfig BEFORE this script. We fall back to a lone placeholder
  // if they're absent so inject.js still works standalone.
  const characters =
    Array.isArray(window.__seiFixtures) && window.__seiFixtures.length
      ? window.__seiFixtures
      : [
          {
            id: '11111111-1111-4111-8111-111111111111',
            name: 'Marv',
            persona: { source: 'A builder companion.', expanded: '' },
            is_default: true,
            shared: false,
            slug: 'marv',
            metadata: {},
            created: '2026-01-04T12:00:00.000Z',
            last_launched: '2026-06-20T18:30:00.000Z',
            playtime_ms: 5_460_000,
            portrait_image: null,
            skin: { source: 'bundled', mojang_username: null, png_sha256: 'x', applied_at: null },
            username: 'Marv',
            owner: null,
            description: 'A builder companion.',
          },
        ];

  const config = window.__seiConfig || {
    mc_username: 'Shawn',
    preferred_name: 'Shawn',
    provider: 'anthropic',
    provider_config: {},
    theme_mode: 'dark',
    linuxBasicTextWarnDismissed: false,
    ai_backend_kind: 'local',
    dev_console_visible: false,
    skin_setup_pending: false,
    removed_default_ids: [],
    added_world_ids: [],
    has_been_welcomed: false,
    vision_mode: 'on-demand',
    total_playtime_ms: 5_460_000,
    total_playtime_backfilled: true,
  };

  // name -> id map for the recorder's summon-state control surface.
  const idByName = {};
  for (const c of characters) idByName[c.name.toLowerCase()] = c.id;

  // ── Push-channel registry ───────────────────────────────────────────────────
  const channels = {};
  const register = (name) => (cb) => {
    (channels[name] ||= new Set()).add(cb);
    return () => channels[name] && channels[name].delete(cb);
  };
  const emit = (name, payload) => {
    (channels[name] || []).forEach((cb) => {
      try {
        cb(payload);
      } catch (e) {
        /* swallow — a listener throwing must not break the demo */
      }
    });
  };

  const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

  // ── Explicit overrides (everything the scripted flow actually touches) ──────
  const overrides = {
    // config + identity
    getConfig: async () => clone(config),
    saveConfig: async (next) => {
      Object.assign(config, next || {});
    },
    hasApiKey: async () => true,
    getStartupWarnings: async () => ({
      keychainFallbackPlaintext: false,
      sessionFallbackPlaintext: false,
    }),

    // characters
    listCharacters: async () => characters.map(clone),
    getCharacter: async (id) => {
      const c = characters.find((x) => x.id === id);
      return c ? clone(c) : null;
    },
    charsListMerged: async () => ({ characters: [] }),
    charsOpenPrepare: async () => {},
    refreshCharacter: async () => {},

    // LAN — connected so the Summon CTA goes straight to summon (no LAN modal)
    getLanState: async () => ({ kind: 'connected' }),

    // skin subsystem
    getSkinServerUrl: async () => ({ baseUrl: location.origin }),
    getWizardState: async () => ({ hasRunOnce: true }),
    wizardPromptShown: async () => ({ shown: true }),

    // summon lifecycle — connecting now; recorder calls __demo.online() later
    summon: async (id) => {
      emit('status', { kind: 'connecting', characterId: id });
    },
    stop: async (id) => {
      emit('status', { kind: 'idle', characterId: id });
    },

    // push subscriptions (renderer subscribes once at mount)
    onLan: register('lan'),
    onStatus: register('status'),
    onLog: register('log'),
    onVisionCapability: register('vision'),
    onAuthState: register('auth'),
    onScopeChanged: register('scope'),
    onSyncStatusUpdate: register('sync'),
    onCreditsStatusUpdate: register('credits'),
    onCreditsHardStop: register('hardstop'),
    onUpdateAvailable: register('updAvail'),
    onUpdateProgress: register('updProg'),
    onUpdateDownloaded: register('updDl'),
    onWhatsNew: register('whatsNew'),
  };

  // ── Proxy backstop: anything not overridden returns a benign stub ───────────
  const sei = new Proxy(overrides, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop !== 'string') return undefined;
      // Subscription-style getters (`onX`) -> register a no-op unsubscriber.
      if (prop.startsWith('on') && prop.length > 2 && prop[2] === prop[2].toUpperCase()) {
        return () => () => {};
      }
      // Everything else: an async method resolving to undefined.
      return async () => undefined;
    },
  });

  window.sei = sei;

  // ── Recorder control surface ────────────────────────────────────────────────
  window.__demo = {
    ids: idByName, // e.g. window.__demo.ids.marv
    online: (id) => emit('status', { kind: 'online', characterId: id, startedAtMs: Date.now() }),
    idle: (id) => emit('status', { kind: 'idle', characterId: id }),
    lan: (kind) => emit('lan', { kind }),
  };
})();
