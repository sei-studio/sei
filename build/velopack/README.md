# Sei's patched Velopack Update.exe

Windows updates run on [Velopack](https://github.com/velopack/velopack) (MIT).
Sei ships a patched `Update.exe` so an in-app restart takes a few seconds
instead of ~20: the package is extracted while Sei is still running, and the
restart only swaps two folders.

- Upstream base: `velopack/velopack` commit
  `8d2844f324a69bd848719ef465b1ae12c5060524` (release 1.3.39-g8d2844f, the
  same version as the `velopack` npm package and the `vpk` tool we use).
- Patch: `sei-fast-apply.patch` in this folder (`git diff` against that
  commit). Every change is marked `SEI PATCH`.

## What the patch adds

| | |
|---|---|
| `Update.exe stage --package <nupkg>` | Extracts the package into `packages\SeiStaged\v<version>.partial` at below-normal CPU priority (normal I/O), verifies every file's size, renames it to `v<version>` and writes `v<version>.ok`. Skips itself (`last-result.txt` says why) when the volume would be left with less than 1 GiB free. One stage at a time (`.lock`); stale folders are removed by the next stage. A stage killed at any point leaves no `.ok`, so it is never used. |
| `apply` uses the staged copy | When `v<version>.ok` matches the package (name and size) and the tree verifies, `current` is swapped with it (two renames, with upstream's rollback if the second fails). The backup folder's parent (`packages\VelopackTemp`) is created first: upstream only made it while extracting there, so on an install that had never applied a delta every swap failed with os error 3 (261031 CI, sig-accept). Otherwise the stock extraction runs. |
| `apply --noHooks` | No app hooks (Sei handles none), and the new Sei is started right after the swap, before the uninstall-entry, shortcut and cleanup work. |
| `apply --seiOverlay <dir>` | A native click-through topmost window showing PNG frames Sei rendered (its splash with "Updating…", a time estimate after `slowAfterMs`, an error frame). Up before Update.exe waits for Sei to exit, closed when the restarted Sei shows a window. On failure: the error frame for 2.5 s, then the old version starts. See `windows/sei_overlay.rs` for `overlay.txt`. |
| Waiting for Sei to exit | The stock wait opens Sei's process for SYNCHRONIZE, which is denied for Sei's main process (every CI run logged "Access is denied" and went straight on). The patch then polls the process list every 50 ms until the pid is gone (60 s cap), and the swap renames retry every 100 ms (same 10 s / 30 s budgets as upstream's 1 s retries). |
| Image prewarm | After a stage, every top-level `.exe`/`.dll` of the staged copy is mapped as an image once and unmapped, so creating the image section (a full read of the 190 MB `Sei.exe`, plus the on-execute scan) happens before the restart instead of inside it. |
| `packages\SeiStaged\applying.pid` | Present while an apply runs. A Sei launched during it leaves `relaunch` and exits (`velopackBoot.ts`); a no-restart apply starts Sei when it finishes. |

A stock `Update.exe` ignores the unknown flags (clap `ignore_errors`), so an
install whose Update.exe is not ours yet still updates, just slowly. Every
downloaded package carries our Update.exe (Velopack copies the package's
`Squirrel.exe` over `Update.exe` on download), so the first update lands it.

## Building it

CI does this (`.github/workflows/velopack-update.yml`, job `update-exe`;
`release.yml` reuses it):

```
git clone https://github.com/velopack/velopack && cd velopack
git checkout 8d2844f324a69bd848719ef465b1ae12c5060524
git apply ../sei/build/velopack/sei-fast-apply.patch
# Cargo.toml's workspace version is 0.0.0-local; give the binary a real one
sed -i 's/^version = "0.0.0-local"/version = "1.3.39-sei"/' Cargo.toml
RUSTFLAGS="-C target-feature=+crt-static" \
  cargo build --target x86_64-pc-windows-msvc --features windows --release -p velopack_bins
# -> target/x86_64-pc-windows-msvc/release/update.exe
```

`vpk pack --runtime win-x64` embeds `vendor/update_x64.exe` from its tool
folder, so CI copies the built `update.exe` over `update_x64.exe` (and
`update.exe`) in `~/.dotnet/tools/.store/vpk/1.3.39-g8d2844f/**/vendor/`
before packing. Windows only: the patch is `cfg(target_os = "windows")`.

## Updating the base

Rebase the patch onto a newer upstream commit, rebuild, bump the `velopack`
npm package and `VPK_VERSION` to the matching release, and rerun
`velopack-update.yml`.
