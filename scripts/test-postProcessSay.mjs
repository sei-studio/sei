#!/usr/bin/env node
// postProcessSay() unit tests.
// Safety-only: whitespace collapse, force-lowercase, 256-char hard cap.
// Length/shape rules live in the prompt — truncating mid-sentence here
// would ship nonsense, so we don't.
import assert from 'node:assert/strict'
import { postProcessSay } from '../src/bot/brain/orchestrator.js'

const cases = [
  // Lowercase
  ['Hello, World!',                  'hello, world!'],
  ["don't worry",                    "don't worry"],
  ["what's the move—shelter?",       "what's the move—shelter?"],
  ['got 3 mutton. we\'re fed.',      "got 3 mutton. we're fed."],
  ['en–dash and em—dash',            'en–dash and em—dash'],
  ['"double" and `back`',            '"double" and `back`'],
  // Whitespace collapse + trim
  ['multiple   spaces',              'multiple spaces'],
  ['  leading and trailing  ',       'leading and trailing'],
  ['newlines\nbecome\nspaces',       'newlines become spaces'],
  // Empty / nullish
  [undefined,                         ''],
  [null,                              ''],
  // Lowercase a shouty input
  ['HEY!!!',                          'hey!!!'],
  // Mixed-case usernames get lowercased too
  ['Hi SSk1tz',                       'hi ssk1tz'],
]
for (const [input, expected] of cases) {
  const got = postProcessSay(input)
  assert.equal(got, expected, `postProcessSay(${JSON.stringify(input)}) → ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`)
}
// 256-char hard cap (safety only)
assert.equal(postProcessSay('a'.repeat(300)).length, 256, 'truncation to 256 chars')
console.log('postProcessSay: all cases passed')
