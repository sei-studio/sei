#!/usr/bin/env node
// scripts/quality-eval/persona/card-edits.mjs: try a persona card change in
// the persona eval, then hand over the exact database change.
//
// Card text lives on the cloud `characters` row (persona_expanded), not in
// this repo, and the eval reads saved copies of those rows (the fixtures,
// ~/suisei/eval/characters). An edits file lists exact string replacements
// per character:
//
//   { "roger": { "id": "<row uuid>", "edits": [["before", "after"], ...] } }
//
// Every "before" must appear exactly once in the fixture's text, or nothing
// is written.
//
//   node scripts/quality-eval/persona/card-edits.mjs <edits.json> --out <dir>
//     copies the fixtures to <dir> with the edits applied; run the eval with
//     --chars <dir> (run.mjs and judge.mjs both take it).
//   node scripts/quality-eval/persona/card-edits.mjs <edits.json> --sql <file>
//     writes one guarded UPDATE per character: it only matches the row while
//     its text is still the fixture's (md5), and bumps updated_at so installs
//     pull the new text on their next refresh. Nothing is sent anywhere; the
//     file is for whoever applies it.
//
// --fixtures <dir> overrides the fixture directory.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}

/** The row object of a fixture file (a row, or a one-element array of one). */
export function readFixture(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  return { raw, row: Array.isArray(raw) ? raw[0] : raw }
}

/** Apply exact replacements; throws when a "before" is missing or not unique. */
export function applyEdits(text, edits, label = 'card') {
  let out = text
  for (const [before, after] of edits) {
    const n = out.split(before).length - 1
    if (n !== 1) throw new Error(`${label}: expected 1 match, found ${n}: ${JSON.stringify(before.slice(0, 80))}`)
    out = out.replace(before, () => after)
  }
  return out
}

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex')

/** A dollar-quoted SQL literal whose tag does not occur in the text. */
export function dollarQuote(text) {
  let tag = 'card'
  while (text.includes(`$${tag}$`)) tag += 'x'
  return `$${tag}$${text}$${tag}$`
}

export function updateSql({ id, name, before, after }) {
  return [
    `-- ${name} (${id})`,
    `update public.characters`,
    `set persona_expanded = ${dollarQuote(after)}, updated_at = now()`,
    `where id = '${id}' and md5(persona_expanded) = '${md5(before)}'`,
    `returning id, name, md5(persona_expanded) as new_md5, updated_at;`,
  ].join('\n')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const editsFile = process.argv[2]
  const fixtures = arg('fixtures', path.join(os.homedir(), 'suisei/eval/characters'))
  const outDir = arg('out')
  const sqlFile = arg('sql')
  if (!editsFile || (!outDir && !sqlFile)) {
    console.error('usage: card-edits.mjs <edits.json> (--out <dir> | --sql <file>) [--fixtures <dir>]')
    process.exit(2)
  }
  const spec = JSON.parse(fs.readFileSync(editsFile, 'utf8'))
  const changed = Object.entries(spec).map(([key, { id, edits }]) => {
    const file = path.join(fixtures, `${key}.json`)
    const { raw, row } = readFixture(file)
    if (id && row.id !== id) throw new Error(`${key}: fixture id ${row.id} is not ${id}`)
    const before = row.persona_expanded
    const after = applyEdits(before, edits, key)
    return { key, id: row.id, name: row.name, raw, row, before, after }
  })
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true })
    for (const f of fs.readdirSync(fixtures).filter((f) => f.endsWith('.json'))) {
      fs.copyFileSync(path.join(fixtures, f), path.join(outDir, f))
    }
    for (const c of changed) {
      c.row.persona_expanded = c.after
      fs.writeFileSync(path.join(outDir, `${c.key}.json`), JSON.stringify(c.raw, null, 1) + '\n')
      console.log(`${c.key}: ${c.before.length} -> ${c.after.length} chars`)
    }
  }
  if (sqlFile) {
    const sql = ['begin;', ...changed.map(updateSql), 'commit;'].join('\n\n') + '\n'
    fs.writeFileSync(sqlFile, sql)
    console.log(`wrote ${sqlFile} (${changed.length} rows)`)
  }
}
