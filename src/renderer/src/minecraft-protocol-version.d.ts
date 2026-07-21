/**
 * Ambient declaration for the deep import used by UnsupportedVersionModal:
 * minecraft-protocol's version table is a dependency-free CJS data module,
 * safe to bundle into the renderer (unlike the package root, which pulls the
 * full protocol stack). Kept in its own file — global.d.ts is a module (it
 * has imports), where `declare module` becomes augmentation and is ignored
 * for untyped packages.
 */
declare module 'minecraft-protocol/src/version.js' {
  export const defaultVersion: string;
  export const supportedVersions: readonly string[];
}
