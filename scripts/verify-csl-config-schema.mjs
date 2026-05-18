#!/usr/bin/env node
/**
 * One-off WARNING 6 research script (Phase 9 Plan 04 Task 2A).
 *
 * UPDATE 2026-05-17 (Rule 1 deviation from PLAN — see 09-04-SUMMARY.md):
 *
 *   The plan pinned `CustomSkinAPI` as the loader type for our local-PNG
 *   skin server at `http://127.0.0.1:<port>/skins/{USERNAME}.png`. That
 *   prediction was WRONG. Verification against the upstream CSL Java
 *   source (`Common/src/main/java/customskinloader/loader/jsonapi/CustomSkinAPI.java`
 *   and `Common/src/main/java/customskinloader/loader/LegacyLoader.java`,
 *   branch `15-develop`) shows:
 *
 *     - `CustomSkinAPI` builds `GET {root}/{username}.json` and parses
 *       the response as a JSON document containing texture hash IDs,
 *       then issues a SECOND `GET {root}/textures/<id>` for the actual
 *       PNG. (Verified at Common/.../jsonapi/CustomSkinAPI.java
 *       `toJsonUrl(root, username) = root + username + ".json"`)
 *
 *     - `Legacy` takes a URL template like
 *       `https://optifine.net/capes/{USERNAME}.png`, literally substitutes
 *       `{USERNAME}` via `expandURL`, and fetches the resulting URL
 *       expecting raw PNG bytes. (Verified at Common/.../LegacyLoader.java
 *       `USERNAME_PLACEHOLDER = "{USERNAME}"`,
 *       `expandURL(url, username)` does the substitution, and the upstream
 *       default profiles use this for `OptiFine` capes etc.)
 *
 *   Our skin server (Plan 03) serves direct PNG bytes at
 *   `/skins/<username>.png` — no JSON intermediate. The correct loader
 *   type is therefore `Legacy`, not `CustomSkinAPI`. Shipping
 *   `CustomSkinAPI` would make the entire phase non-functional (CSL would
 *   GET `/skins/Sui.json`, get 404, and never render the skin).
 *
 *   This script now verifies the CORRECT pin (`Legacy`) by reading the
 *   upstream Java source directly — not the README, which is shallow and
 *   was the source of the original mis-pin. The Java source is the
 *   authoritative wire-protocol reference.
 *
 *   The plan's WARNING 6 research-step machinery worked exactly as
 *   intended: it caught a wrong prediction before the wrong type made it
 *   into production. The deviation is documented in 09-04-SUMMARY.md under
 *   "Deviations from Plan §Rule 1".
 *
 * Failure modes:
 *   - Java source fetch succeeds AND `LegacyLoader.java` contains both
 *     `USERNAME_PLACEHOLDER = "{USERNAME}"` and an `expandURL` impl that
 *     does literal substitution → PASS (the `Legacy` pin is correct)
 *   - Java source fetch succeeds but the loader behavior changed (e.g.
 *     upstream renamed `Legacy` to something else, or removed `{USERNAME}`
 *     substitution) → FAIL with a clear diagnostic; the planner-pinned
 *     schema requires re-review
 *   - Java source fetch fails (offline / repo moved / rate-limited) →
 *     WARN exit 0; the schema is pinned by what this script proves at
 *     plan-execution time, not by every later re-run
 *
 * Sources:
 *   - 09-04-PLAN §"Pre-lock research step (WARNING 6)"
 *   - Common/src/main/java/customskinloader/loader/LegacyLoader.java
 *   - Common/src/main/java/customskinloader/loader/jsonapi/CustomSkinAPI.java
 */
const LEGACY_LOADER_URLS = [
  'https://raw.githubusercontent.com/xfl03/MCCustomSkinLoader/15-develop/Common/src/main/java/customskinloader/loader/LegacyLoader.java',
  'https://raw.githubusercontent.com/xfl03/MCCustomSkinLoader/main/Common/src/main/java/customskinloader/loader/LegacyLoader.java',
];
const CUSTOMSKINAPI_URLS = [
  'https://raw.githubusercontent.com/xfl03/MCCustomSkinLoader/15-develop/Common/src/main/java/customskinloader/loader/jsonapi/CustomSkinAPI.java',
  'https://raw.githubusercontent.com/xfl03/MCCustomSkinLoader/main/Common/src/main/java/customskinloader/loader/jsonapi/CustomSkinAPI.java',
];
const TIMEOUT_MS = 30_000;

async function fetchWithTimeout(url, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, {
      signal: ac.signal,
      headers: { 'user-agent': 'sei-verify-csl-config-schema/1.0' },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFirstOk(urls) {
  for (const url of urls) {
    try {
      const r = await fetchWithTimeout(url, TIMEOUT_MS);
      if (r.ok) return { body: await r.text(), url };
    } catch {
      // try next
    }
  }
  return null;
}

async function main() {
  // Fetch both loader sources. If either is unavailable, WARN-exit 0 —
  // the schema is pinned by what this script proved at execution time.
  const legacy = await fetchFirstOk(LEGACY_LOADER_URLS);
  const customSkinApi = await fetchFirstOk(CUSTOMSKINAPI_URLS);
  if (!legacy || !customSkinApi) {
    console.log(
      'WARN: could not fetch CSL loader sources from any candidate branch — proceeding with planner-pinned schema {version: 14, loadlist[0].type: \'Legacy\', root + skin URL template}',
    );
    console.log(`  · legacy=${legacy ? 'OK' : 'MISSING'} customSkinApi=${customSkinApi ? 'OK' : 'MISSING'}`);
    process.exit(0);
  }
  console.log(`LegacyLoader.java fetched from ${legacy.url}`);
  console.log(`CustomSkinAPI.java fetched from ${customSkinApi.url}`);

  // ── Legacy verification ──────────────────────────────────────────────
  // Required evidence:
  //   1. The class is named LegacyLoader and getName() returns "Legacy"
  //   2. {USERNAME} placeholder is documented + an expandURL impl exists
  const legacyClassMatch = /class\s+LegacyLoader/.test(legacy.body);
  const legacyGetName = /return\s+"Legacy"/.test(legacy.body);
  const usernamePlaceholder = /USERNAME_PLACEHOLDER\s*=\s*"\{USERNAME\}"/.test(legacy.body);
  const expandUrlImpl = /expandURL\s*\([^)]*url[^)]*username[^)]*\)/.test(legacy.body);
  if (!legacyClassMatch || !legacyGetName || !usernamePlaceholder || !expandUrlImpl) {
    console.error(
      `FAIL: LegacyLoader.java does not match the expected shape (classMatch=${legacyClassMatch}, getName=${legacyGetName}, placeholder=${usernamePlaceholder}, expandURL=${expandUrlImpl}). Planner-pinned schema requires review.`,
    );
    process.exit(1);
  }

  // ── CustomSkinAPI verification (negative — confirm it's the WRONG one) ──
  // Required evidence:
  //   1. CustomSkinAPI.toJsonUrl(root, username) returns "{root}{username}.json"
  //      → confirms it requires a JSON-returning endpoint, NOT direct PNG
  const jsonUrlPattern = /toJsonUrl\([^)]*\)\s*\{[^}]*username\s*\+\s*SUFFIX/s.test(customSkinApi.body) ||
    /SUFFIX\s*=\s*"\.json"/.test(customSkinApi.body);
  if (!jsonUrlPattern) {
    console.error(
      'FAIL: CustomSkinAPI.java does not show the JSON-endpoint pattern. Upstream wire protocol may have changed; planner-pinned schema requires review.',
    );
    process.exit(1);
  }

  console.log('PASS: LegacyLoader.java confirms {USERNAME} substitution + expandURL semantics (matches our skin server)');
  console.log('PASS: CustomSkinAPI.java confirms JSON-endpoint pattern (would NOT work with our PNG-bytes server)');
  console.log(
    "Pinned shipped schema: { version: 14, loadlist[0]: { name: 'SeiLocal', type: 'Legacy', skin: 'http://127.0.0.1:<port>/skins/{USERNAME}.png' } }",
  );
}

main().catch((err) => {
  console.error('FAIL: unexpected error:', err);
  process.exit(1);
});
