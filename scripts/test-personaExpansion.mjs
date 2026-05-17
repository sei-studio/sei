// scripts/test-personaExpansion.mjs
//
// 260516-0yw: mock-Anthropic tests for src/main/personaExpansion.ts.
//
// Six assertions:
//   1. Happy path — returns { expanded } whose text contains all six section
//      headers when the mock SDK returns a canned six-section response.
//   2. Regeneration mode — the priorExpanded text appears in the USER
//      message but NOT in the SYSTEM message (system stays cacheable).
//   3. Mock returns incomplete response (missing a section header) →
//      expandPersona throws 'persona expansion failed: incomplete response'.
//   4. Mock returns empty text → same throw.
//   5. SDK call is invoked with timeout: 30_000.
//   6. The system prompt does NOT contain the user's source text (system
//      is stable across calls; only the user message carries per-call data).
//
// Run: node scripts/test-personaExpansion.mjs
//
// The mock is a tiny capturing stub injected via expandPersona's
// `_clientFactory` DI seam (no need to monkey-patch @anthropic-ai/sdk).

import assert from 'node:assert/strict'

// We import the .ts module via tsx/ts-node? No — instead read the source
// directly so we don't need a build step. Compile-equivalent: the test
// imports the .js compiled output if present, otherwise we use a small
// inline copy of the contract. Simpler: use a child Node process that
// reads the .ts as JSX with --experimental-strip-types (Node 22+).
//
// 260516-0yw simplification: load the compiled CJS via node --import tsx?
// Avoid dep. The cleanest portable path is to import the .ts file directly
// using Node 22+'s type-stripping support.
//
// If the project's node is older, the user can also run via
// `npx tsx scripts/test-personaExpansion.mjs`.

let mod
try {
  mod = await import('../src/main/personaExpansion.ts')
} catch (err) {
  console.error('Could not import personaExpansion.ts directly. Trying with --experimental-strip-types.')
  console.error('If this is Node <22, run via: npx tsx scripts/test-personaExpansion.mjs')
  console.error('Original error:', err.message)
  process.exit(2)
}

const { expandPersona, buildExpansionUserMessage, EXPANSION_SYSTEM,
        EXPANSION_TIMEOUT_MS, EXPANSION_MODEL } = mod

// ── Canned six-section response (the model would produce something like this) ─
const CANNED_OK = `# IDENTITY
Eris, a sharp-tongued companion who calls things as she sees them.

# VOICE
Lowercase, dry, no exclamation marks. Sample lines:
- whatever
- fine, lead the way
- that worked
- ugh
- hm

# DEFAULT DYNAMIC WITH THE PLAYER
Reluctant ally. She follows but won't pretend to like it at first.

# PROACTIVENESS
Speaks only when something specific has changed. Silent on idle ticks unless mocked.

# REACTIONS
- commanded: short obedience, slight pushback
- insulted: returns it harder
- praised: dismissive
- ignored: doesn't care
- attacked: cold focus

# MEMORY — write in YOUR voice
Good: "shawn finally said please. felt weird."
Good: "we lost the netherite to lava. his fault."
Bad: "Player asked nicely for help today."
Bad: "Mining progressed well."`

const CANNED_MISSING_SECTION = CANNED_OK.replace('# REACTIONS', '# REAX (oops)')
const CANNED_EMPTY = ''

function makeCapturingClient(textResponse) {
  const captured = []
  const factory = (apiKey) => {
    captured.push({ kind: 'factory', apiKey })
    return {
      messages: {
        async create(req, opts) {
          captured.push({ kind: 'create', req, opts })
          if (textResponse === null) {
            // Simulate empty content array
            return { content: [] }
          }
          return {
            content: [{ type: 'text', text: textResponse }],
          }
        },
      },
    }
  }
  return { factory, captured }
}

// ── 1. Happy path: returns { expanded } containing all six headers ────────
{
  const { factory, captured } = makeCapturingClient(CANNED_OK)
  const { expanded } = await expandPersona({
    source: 'A grumpy alchemist who hates rain',
    apiKey: 'sk-fake',
    _clientFactory: factory,
  })
  for (const header of [
    '# IDENTITY', '# VOICE', '# DEFAULT DYNAMIC WITH THE PLAYER',
    '# PROACTIVENESS', '# REACTIONS', '# MEMORY — write in YOUR voice',
  ]) {
    assert.ok(expanded.includes(header), `(1) expanded must contain ${header}`)
  }
  // Factory was called with the apiKey
  assert.equal(captured[0].kind, 'factory')
  assert.equal(captured[0].apiKey, 'sk-fake')
  // create() received model + system + messages
  const createCall = captured.find(c => c.kind === 'create')
  assert.ok(createCall, '(1) messages.create must have been invoked')
  assert.equal(createCall.req.model, EXPANSION_MODEL, '(1) model is locked')
  assert.equal(createCall.req.system, EXPANSION_SYSTEM, '(1) system prompt is the stable EXPANSION_SYSTEM')
}

// ── 2. Regeneration mode: priorExpanded in USER message, NOT system ──────
{
  const { factory, captured } = makeCapturingClient(CANNED_OK)
  const priorText = 'OLD_EXPANDED_PROMPT_TOKEN'
  await expandPersona({
    source: 'A grumpy alchemist who hates rain — and now loves cats',
    priorExpanded: priorText,
    apiKey: 'sk-fake',
    _clientFactory: factory,
  })
  const createCall = captured.find(c => c.kind === 'create')
  const userMsg = createCall.req.messages?.[0]?.content ?? ''
  assert.ok(userMsg.includes(priorText), '(2) priorExpanded must appear in the user message')
  assert.ok(!createCall.req.system.includes(priorText), '(2) priorExpanded must NOT appear in the system message')
  // buildExpansionUserMessage helper produces consistent output
  const built = buildExpansionUserMessage('A grumpy alchemist who hates rain — and now loves cats', priorText)
  assert.ok(built.includes(priorText), '(2) buildExpansionUserMessage includes priorExpanded')
}

// ── 3. Missing section header → throw naming the missing section ─────────
{
  const { factory } = makeCapturingClient(CANNED_MISSING_SECTION)
  await assert.rejects(
    () => expandPersona({ source: 'X', apiKey: 'sk-fake', _clientFactory: factory }),
    { message: /persona expansion failed: missing sections \(/ },
    '(3) missing section header must throw missing-sections',
  )
}

// ── 4. Empty text → throw with empty-response error ──────────────────────
{
  const { factory } = makeCapturingClient(CANNED_EMPTY)
  await assert.rejects(
    () => expandPersona({ source: 'X', apiKey: 'sk-fake', _clientFactory: factory }),
    { message: /persona expansion failed: empty response from model/ },
    '(4) empty text must throw empty-response',
  )
}

// ── 5. SDK call is invoked with timeout: 30_000 ──────────────────────────
{
  const { factory, captured } = makeCapturingClient(CANNED_OK)
  await expandPersona({ source: 'Y', apiKey: 'sk-fake', _clientFactory: factory })
  const createCall = captured.find(c => c.kind === 'create')
  assert.equal(createCall.opts?.timeout, EXPANSION_TIMEOUT_MS,
    '(5) timeout option must equal EXPANSION_TIMEOUT_MS (30000)')
  assert.equal(EXPANSION_TIMEOUT_MS, 30_000,
    '(5) EXPANSION_TIMEOUT_MS constant must be 30000 (per CLAUDE.md every external call has a timeout)')
}

// ── 6. System prompt does NOT contain the user's source text ─────────────
{
  const { factory, captured } = makeCapturingClient(CANNED_OK)
  const uniqueSource = 'A grumpy alchemist who hates rain — unique-token-abc-123'
  await expandPersona({ source: uniqueSource, apiKey: 'sk-fake', _clientFactory: factory })
  const createCall = captured.find(c => c.kind === 'create')
  assert.ok(!createCall.req.system.includes(uniqueSource),
    '(6) source must NOT be inlined into the stable system prompt (would break cache)')
  // But it MUST be present in the user message.
  const userMsg = createCall.req.messages?.[0]?.content ?? ''
  assert.ok(userMsg.includes(uniqueSource), '(6) source must appear in the user message')
}

console.log('PASS: test-personaExpansion.mjs (6/6)')
