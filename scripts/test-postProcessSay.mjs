#!/usr/bin/env node
// Plan 03.1-03 Task 1 — postProcessSay() unit tests (D-7).
// Relocated from test/ (which is gitignored) to scripts/ so the harness
// is committed alongside the source. See SUMMARY for the deviation note.
import assert from 'node:assert/strict'
import { postProcessSay } from '../src/brain/orchestrator.js'

const cases = [
  ['Hello, World!',                  'hello world'],
  ["don't worry",                    "don't worry"],
  ["what's the move—shelter?",       "what's the move shelter"],
  ['got 3 mutton. we\'re fed.',      "got 3 mutton we're fed"],
  ['multiple   spaces',              'multiple spaces'],
  [undefined,                         ''],
  [null,                              ''],
  ['HEY!!!',                          'hey'],
  ['`quoted`',                        'quoted'],
  ['"double"',                        'double'],
]
for (const [input, expected] of cases) {
  const got = postProcessSay(input)
  assert.equal(got, expected, `postProcessSay(${JSON.stringify(input)}) → ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`)
}
// Truncation case
assert.equal(postProcessSay('a'.repeat(300)).length, 256, 'truncation to 256 chars')
console.log('postProcessSay: all cases passed')
