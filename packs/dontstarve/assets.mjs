// Game-side assets the Don't Starve Together pack carries (game-adapters M2,
// 260908). scripts/build-game-pack.mjs copies each `from` (repo-relative) to
// `to` inside the pack; src/main/games/dontstarve/install.ts resolves the mod
// from `<packRoot>/assets/dst-mod/sei` when packaged and from
// `<repoRoot>/native/dst-mod/sei` in dev (the pack root IS the repo root
// there), so the two paths below are the contract between them.
export const ASSET_DIRS = [
  { from: 'native/dst-mod/sei', to: 'assets/dst-mod/sei' },
];
