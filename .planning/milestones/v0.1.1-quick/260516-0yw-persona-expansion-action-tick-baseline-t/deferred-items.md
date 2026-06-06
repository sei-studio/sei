# Deferred items — 260516-0yw

These are pre-existing harness failures (NOT caused by 0yw work) discovered while
running the regression suite. The prior-session refactor (owner→player rename,
memoryLog, removal of diary/compaction/affectLog/persona/goals modules) left
the verify-260513-wkd.mjs and verify-260514-gam.mjs mock adapters out of sync
with the orchestrator's new requirements. Fixing them requires a separate
harness-modernization pass beyond 0yw's scope.

## scripts/verify-260513-wkd.mjs

After supplying `memory_md_path` (now also patched in the harness config), the
harness fails at `adapter.capabilityParagraph is not a function` — the mock
adapter in `makeMockAdapter` is missing methods that the orchestrator now
calls during `rebuildPersonalitySystem` (capabilityParagraph, worldPrimer,
actionRules — these moved out of persona.js into the adapter prompts module).

## scripts/verify-260514-gam.mjs

Same root cause as 260513-wkd. Skipped pending harness modernization.

## What 0yw still proves

The two new 0yw test scripts (`test-actionTick.mjs`, `test-followOpenEnded.mjs`)
exercise the new wiring end-to-end with the LIVE orchestrator code (priority
queue, classifier scan, real registry/adapter signal plumbing through follow).
They both pass. The follow open-ended regression is the specific bug 0yw fixes
and is covered by isolated end-to-end assertions.
