// packs/minecraft/prune.mjs
//
// What scripts/build-game-pack.mjs DELETES from the Minecraft pack after the
// production install and native rebuild. Globs are minimatch patterns
// relative to the pack root (the directory holding node_modules/), matched
// with `dot: true`. Written ONCE here; electron-builder.yml no longer carries
// any of these because the packages they prune left the app bundle with the
// game-pack split (260908).
//
// Every entry below was measured against a live build before it was added.
// Read the note above a group before widening it: two of them (the bedrock
// `common/` files, the 1.16.4 entity textures) look like dead weight and
// crash the bot when removed.

/** Prunes applied on every platform. */
export const PRUNE_COMMON = [
  // Source maps + the usual per-package cruft (top-level and nested).
  'node_modules/**/*.map',
  '**/node_modules/*/{test,tests,__tests__,*.md,*.markdown}',
  // npm's shim dir + hidden lockfile: the pack is not an npm project.
  'node_modules/.bin/**',
  'node_modules/.package-lock.json',
  // AppleDouble resource forks. 46 of them ship INSIDE vendor/gl-8.1.6-cxx20.tgz
  // (the tarball was rolled on a mac), so they are real files in node_modules/gl
  // and would ride into every pack, including the Windows one.
  '**/._*',

  // 260803 bedrock: minecraft-data ships the complete Bedrock Edition data
  // tree (329MB / 398 files) and nothing in this app speaks Bedrock. It CANNOT
  // be dropped wholesale: minecraft-data/index.js (lines 6, 103, 111) and
  // lib/supportsFeature.js (line 3) EAGERLY require
  // bedrock/common/{protocolVersions,versions,legacy,features}.json at module
  // load time, so a blanket `bedrock/**` glob makes `require('minecraft-data')`
  // throw and kills the bot utilityProcess on every summon. Every bedrock
  // VERSION directory begins with a digit (0.14 through 1.26.30) while only
  // `common` and `latest` begin with a letter, so the [0-9] character class
  // prunes exactly the version dirs and leaves the eagerly-required common/
  // files in place. The `**/` prefix also catches the nested copy under
  // mineflayer-utils.
  '**/minecraft-data/minecraft-data/data/bedrock/[0-9]*/**',

  // 260803 headless-gl: `gl` is 208MB unpacked, and the only runtime artifact
  // is build/Release/webgl.node (2.3MB) plus src/javascript/**, index.js and
  // package.json. `bindings('webgl')` (node_modules/bindings/bindings.js lines
  // 36-58) walks a FIXED ordered list of 13 candidate paths and returns on the
  // first one that requires successfully; there is no directory scan, and the
  // winner is always candidate #3, build/Release/webgl.node. Nothing ever
  // looks in bin/ (that copy is written by @electron/rebuild's legacy
  // node-pre-gyp compat step and is unreachable). Everything excluded below is
  // node-gyp build residue: the ANGLE source checkout, the intermediate object
  // trees, and the generated makefiles / project files. gl's own
  // node_modules/ holds its BUILD-time deps (node-gyp, prebuild-install and
  // their nested trees); `bindings` is hoisted beside gl and stays.
  //
  // DO NOT broaden any of this to "node_modules/gl/build/Release/**". On
  // Windows, gl's binding.gyp copies libEGL.dll, libGLESv2.dll and
  // d3dcompiler_47.dll into build/Release and they are required at load time.
  // That mistake builds clean and tests green on macOS, and only surfaces as a
  // LoadLibrary failure inside the bot utilityProcess on an end user's Windows
  // machine. Keeping the exclusions narrow (named subdirectories plus
  // object-file extensions) makes that failure impossible.
  //
  // The lists deliberately cover both toolchains: make (*.a, obj.target,
  // .deps) and MSVC (*.lib/.obj/.pdb/.ilk/.exp/.iobj/.ipdb/.tlog,
  // build/Release/obj). The half that does not apply is a harmless no-op on
  // each platform.
  'node_modules/gl/angle/**',
  'node_modules/gl/bin/**',
  'node_modules/gl/node_modules/**',
  'node_modules/gl/src/native/**',
  'node_modules/gl/build/Release/obj.target/**',
  'node_modules/gl/build/Release/obj/**',
  'node_modules/gl/build/Release/.deps/**',
  'node_modules/gl/build/Release/*.{a,o,lib,obj,pdb,ilk,exp,iobj,ipdb,tlog}',
  'node_modules/gl/build/angle/**',
  'node_modules/gl/build/{Makefile,binding.Makefile,gyp-mac-tool,config.gypi}',
  'node_modules/gl/build/*.{mk,vcxproj,sln,filters}',

  // 260803 three: the nested 0.128.0 under prismarine-viewer has NO exports
  // field, so Node uses `main: build/three.js` and can never reach
  // three.module.js or three.min.js.
  'node_modules/prismarine-viewer/node_modules/three/build/three.min.js',
  'node_modules/prismarine-viewer/node_modules/three/build/three.module.js',

  // 260728 textures: prismarine-viewer's texture tree was ~32k tiny files
  // (the reason the mac dmg could not be built for a month: dmgbuild sizes
  // the volume from the byte-sum and ignores per-file APFS overhead). Keep
  // only the 1.20.1 / 1.21.1 / 1.21.4 sets, the versions players actually
  // run (~9.4k files); the second line drops the orphaned per-version atlas
  // PNGs that sit beside the folders.
  //
  // The tradeoff: on a world older than 1.20, POV vision is unavailable
  // (povRenderer reports CANT_SEE) and dashboard item icons fall back to text
  // labels (mcAssets 404s). CANT_SEE is enforced by an explicit
  // atlas-existence pre-check in povRenderer.js, and that pre-check is what
  // makes the degradation graceful rather than fatal: prismarine-viewer's
  // supported-version list is hardcoded in viewer/lib/version.js, so
  // setVersion() still SUCCEEDS for, say, a 1.16 world and it is the later
  // loadTexture() that rejects. That rejection has no .catch, so without the
  // pre-check it escapes to the unhandledRejection handler in
  // src/bot/index.js, which calls process.exit(1) and kills the whole bot
  // process. Do not remove the pre-check while these prunes are in place.
  'node_modules/prismarine-viewer/public/textures/1.{8.8,9.4,10.2,11.2,12.2,13.2,14.4,15.2,16.1,17.1,18.1,19}/**',
  'node_modules/prismarine-viewer/public/textures/1.{8.8,9.4,10.2,11.2,12.2,13.2,14.4,15.2,16.1,16.4,17.1,18.1,19}.png',

  // 1.16.4 IS PRUNED, BUT NOT ENTIRELY (260806). It is not just another old
  // version: viewer/lib/entities.js line 12 constructs every entity as
  // `new Entity('1.16.4', entity.name, scene)` with the version HARDCODED, so
  // `textures/1.16.4/{entity,items,misc}` is the ONLY entity texture tree the
  // viewer ever reads, on every world, at every version. Excluding 1.16.4 with
  // the rest of the old versions therefore removed the textures for EVERY
  // entity in EVERY packaged build, and prismarine-viewer's loadTexture has no
  // .catch, so the first entity to enter the bot's POV render became an
  // unhandled rejection and killed the bot process (measured live 260805:
  // three sessions, exit code 1, world still open). render/textureFallback.js
  // now makes that survivable; keeping these three subtrees is what makes
  // entities actually look like themselves (837 files / 0.6MB). Everything
  // else under 1.16.4 is genuinely unused, so it is dropped explicitly rather
  // than by relying on negation ordering. The 1.16.4.png BLOCK atlas above
  // stays pruned: block rendering resolves per world version, never to 1.16.4.
  'node_modules/prismarine-viewer/public/textures/1.16.4/{blocks,colormap,effect,environment,font,gui,map,mob_effect,models,painting,particle}/**',
  'node_modules/prismarine-viewer/public/textures/1.16.4/*.json',
];

/** Extra prunes per target platform. */
export const PRUNE_BY_PLATFORM = {
  // 260803 headless-gl: gl/deps is the prebuilt Windows DLL + import-lib
  // payload that binding.gyp copies into build/Release at compile time. Dead
  // weight anywhere but Windows.
  darwin: ['node_modules/gl/deps/**'],
  linux: ['node_modules/gl/deps/**'],
  win32: [],
};

/** The full prune list for one target platform. */
export function pruneGlobsFor(platform) {
  return [...PRUNE_COMMON, ...(PRUNE_BY_PLATFORM[platform] ?? [])];
}

/**
 * Files whose presence proves the prune did not cut into the runtime. The
 * builder refuses to zip a pack that lacks any of them.
 */
export const MUST_KEEP = [
  'node_modules/gl/build/Release/webgl.node',
  'node_modules/gl/index.js',
  'node_modules/gl/src/javascript/webgl-rendering-context.js',
  'node_modules/bindings/bindings.js',
  'node_modules/canvas/package.json',
  'node_modules/canvas/build/Release/canvas.node',
  'node_modules/minecraft-data/minecraft-data/data/bedrock/common/protocolVersions.json',
  'node_modules/minecraft-data/minecraft-data/data/bedrock/common/versions.json',
  'node_modules/prismarine-viewer/public/textures/1.16.4/entity',
  'node_modules/prismarine-viewer/public/textures/1.21.4',
  'node_modules/prismarine-viewer/node_modules/three/build/three.js',
  'node_modules/mineflayer/package.json',
  // 260926 Minecraft 26.2 / 26.3: these exist only when patches/*.patch applied
  // (postinstall patch-package). A pack without them would ship without 26.x
  // support, so refuse to build it.
  'node_modules/minecraft-data/minecraft-data/data/pc/26.2/protocol.json',
  'node_modules/minecraft-data/minecraft-data/data/pc/26.3/version.json',
  'node_modules/mineflayer/lib/playerActionIds.js',
];
