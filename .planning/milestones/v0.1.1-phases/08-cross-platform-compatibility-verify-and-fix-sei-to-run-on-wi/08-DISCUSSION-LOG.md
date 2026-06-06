---
phase: 8
mode: --auto (autonomous, no user prompts)
generated: 2026-05-17
---

# Phase 8: Windows Cross-Platform Compatibility — Discussion Log

Auto-mode discuss (autonomous selection of recommended defaults). No interactive
prompts were issued — each gray area below was answered with the recommended
default and logged for audit.

## Gray Areas Considered

| Area | Question | Auto-selected default | Rationale |
|---|---|---|---|
| Test substrate | Real Windows VM/box or GitHub Actions matrix? | Real Windows VM/box for smoke (no CI yet) | Matches Phase 4 plan 04-11 clean-VM validation pattern. CI matrix is a separate, larger chunk of work; defer until codebase is known good on Windows. |
| Scope of "compatibility" | dev-mode only, full packaged install, or both? | Both — dev `npm run dev` AND packaged `.exe` from `npm run dist:win` on a clean VM | Phase 9 needs a packaged install path. Dev-only is insufficient. |
| Audit approach | Static-audit everything up-front, or smoke-test-driven? | Light static audit (Wave 1) + smoke-test driven fixes (Wave 2/3) | Static analysis cannot catch interaction bugs (like the Phase 4 `botEntryPath` regression). Real Windows execution is non-negotiable. |
| Native modules | Trust toolchain, or manual rebuild rituals? | Trust `@electron/rebuild` + `electron-builder install-app-deps` | Zero native deps right now (mineflayer is pure JS). Verify clean, don't reinvent. |
| Windows version baseline | Win10+ only, or include Win7/8? | Windows 10+ x64 only | Electron 42 drops Win7/8 support. |
| Defect handling pattern | Bulk fix vs atomic commits per defect? | Atomic commits per defect, logged in `08-WINDOWS-DEFECTS.md` | Matches Phase 03.1 defect-log pattern that worked well. |
| Linux scope | Smoke linux too, or skip? | Best-effort, non-blocking (matches Phase 4 D-60) | Linux is already deferred; don't expand Phase 8 scope. |
| `appId` placeholder | Resolve in Phase 8, or defer to Phase 9? | Flag the dependency, defer the lock to whoever ships first | `appId: app.sei.placeholder` affects `app.getPath('userData')` resolution. Locking it changes Keychain entries permanently — needs user input separately. Don't block Phase 8 on it. |

## Folded Todos
None — no pending todos matched Phase 8 scope.

## Reviewed Todos
None.

## Scope Redirected to Deferred
- Code-signing → already deferred per Phase 4 D-Q2.
- GitHub Actions Windows matrix → deferred to maintenance phase.
- Linux end-to-end smoke → already deferred per Phase 4 D-60.
- ARM64 Windows → deferred until requested.
- Performance benchmarking → deferred.

## Claude's Discretion (left to plan-phase / executor)
- Specific Windows VM choice (Parallels / UTM / Multipass / loaner) — user picks.
- Whether to capture a screencast of the smoke pass.
- Whether to add a Windows-specific `sei:win` dev script.
- Exact format of `08-HOTSPOTS.md` (table vs prose).
- Whether to smoke-test on both Win10 and Win11 vs only one.
- Whether to run linux AppImage smoke opportunistically.

## Notes for plan-phase

Phase 8 should plan a wave-based execution:
- Wave 1: static audit pass → `08-HOTSPOTS.md`
- Wave 2: smoke test on Windows VM (dev + packaged) → `08-WINDOWS-DEFECTS.md`
- Wave 3: fix each defect, atomic commits, re-run smoke until clean
- Wave 4: documentation (`README.md` Windows section + `08-WINDOWS-GUIDE.md` reference doc)

The phase has no traditional "code to write" until smoke testing surfaces defects — plan should reflect that the bulk of work is investigation + targeted fixes, not feature implementation.
