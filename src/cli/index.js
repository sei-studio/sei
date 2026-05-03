#!/usr/bin/env node
// src/cli/index.js — sei CLI: onboarding, start, config.
// Zero new deps; uses node:readline/promises and node:fs.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stdin as input, stdout as output } from 'node:process'
import * as readline from 'node:readline/promises'

// ─── ANSI palette (light blue theme, no deps) ────────────────────────────
const C = {
  reset: '\x1b[0m',
  bold:  '\x1b[1m',
  dim:   '\x1b[2m',
  blue:  '\x1b[94m',  // bright/light blue
  cyan:  '\x1b[96m',  // light cyan accent
  gray:  '\x1b[90m',
  red:   '\x1b[91m',
  green: '\x1b[92m',
}
const blue = (s) => `${C.blue}${s}${C.reset}`
const cyan = (s) => `${C.cyan}${s}${C.reset}`
const bold = (s) => `${C.bold}${s}${C.reset}`
const dim  = (s) => `${C.dim}${s}${C.reset}`
const gray = (s) => `${C.gray}${s}${C.reset}`
const red  = (s) => `${C.red}${s}${C.reset}`
const green = (s) => `${C.green}${s}${C.reset}`

// ─── Paths ───────────────────────────────────────────────────────────────
// Resolve project root by walking up from this file until we find package.json
// with name "sei". This lets the CLI work whether installed globally, run via
// npx, or invoked directly from the repo.
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROJECT_ROOT = resolve(__dirname, '..', '..')
const CONFIG_PATH = resolve(PROJECT_ROOT, 'config.json')
const EXAMPLE_PATH = resolve(PROJECT_ROOT, 'config.example.json')
const OWNER_MD_PATH = resolve(PROJECT_ROOT, 'OWNER.md')
const INDEX_PATH = resolve(PROJECT_ROOT, 'src', 'index.js')

// ─── Banner ──────────────────────────────────────────────────────────────
function banner() {
  const line = '═'.repeat(38)
  output.write('\n')
  output.write(`${blue(line)}\n`)
  output.write(`${blue('║')}    ${bold(blue('Sei (Dev Mode CLI)'))}                ${blue('║')}\n`)
  output.write(`${blue(line)}\n`)
  output.write(dim('   framework for custom Minecraft personas\n'))
  output.write('\n')
}

// ─── Q&A helpers ─────────────────────────────────────────────────────────
async function ask(rl, prompt, { def = '', validate = null } = {}) {
  while (true) {
    const hint = def ? gray(` [${def}]`) : ''
    const raw = await rl.question(`${cyan('?')} ${prompt}${hint} `)
    const value = raw.trim() === '' ? def : raw.trim()
    if (validate) {
      const err = validate(value)
      if (err) { output.write(`${red('!')} ${err}\n`); continue }
    }
    return value
  }
}

async function pick(rl, prompt, options, def = 0) {
  output.write(`${cyan('?')} ${prompt}\n`)
  options.forEach((opt, i) => {
    const marker = i === def ? blue('●') : gray('○')
    output.write(`  ${marker} ${i + 1}. ${opt}\n`)
  })
  while (true) {
    const raw = await rl.question(gray(`  choose 1-${options.length} [${def + 1}] `))
    const trimmed = raw.trim()
    if (trimmed === '') return options[def]
    const n = Number(trimmed)
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1]
    output.write(`${red('!')} pick a number between 1 and ${options.length}\n`)
  }
}

// ─── Config IO ───────────────────────────────────────────────────────────
function readJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}
function loadExisting() {
  return readJSON(CONFIG_PATH) ?? readJSON(EXAMPLE_PATH) ?? {}
}
function writeConfig(cfg) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
}

// Light-touch OWNER.md seed — only writes preferred_name if the file is
// missing. Once OWNER.md exists, the runtime owns it (memory/owner.js).
function seedOwnerMd(preferredName, ownerUsername) {
  if (existsSync(OWNER_MD_PATH)) return
  if (!preferredName && !ownerUsername) return
  const front = [
    '---',
    'owner_uuid:',
    `owner_username: ${ownerUsername || ''}`,
    'first_seen:',
    'last_seen:',
    'total_sessions: 0',
    `preferred_name: ${preferredName || ''}`,
    'pronouns:',
    '---',
    '# Notes',
    '',
    '',
  ].join('\n')
  writeFileSync(OWNER_MD_PATH, front, 'utf8')
}

// ─── Onboarding flow ─────────────────────────────────────────────────────
async function onboard({ rl, existing, mode = 'first-run' }) {
  const verb = mode === 'first-run' ? 'set up' : 're-configure'
  output.write(`${blue('→')} let's ${verb} your persona.\n\n`)

  const prevPersona = existing.persona ?? {}

  const playerName = await ask(rl, 'your name (what should the persona call you?):', {
    def: existing.owner_preferred_name ?? '',
  })

  const ownerUsername = await ask(rl, 'your minecraft username:', {
    def: existing.owner_username ?? '',
    validate: (v) => v.length === 0 ? 'required' : null,
  })

  const characterName = await ask(rl, 'name of the character (the bot):', {
    def: prevPersona.name ?? 'Sui',
    validate: (v) => v.length === 0 ? 'required' : null,
  })

  const backstory = await ask(rl, "one-line backstory for the character:", {
    def: prevPersona.backstory ?? 'A curious companion who enjoys exploring blocky worlds alongside their friend.',
  })

  const toneOpts = ['friendly', 'sarcastic', 'serious', 'curious']
  const toneDef = Math.max(0, toneOpts.indexOf(prevPersona.tone ?? 'friendly'))
  const tone = await pick(rl, 'tone:', toneOpts, toneDef)

  const apiKey = await ask(rl, 'anthropic api key (or blank to use $ANTHROPIC_API_KEY):', {
    def: existing.anthropic?.api_key ?? '',
  })

  output.write('\n')
  const chatMode = await pick(
    rl,
    'chat mode:',
    [
      'messages-only — only short say() lines reach the player (recommended)',
      'full messages+thoughts — every model utterance reaches chat (debugging)',
    ],
    existing.chat?.mode === 'dev' ? 1 : 0,
  )
  const chatModeValue = chatMode.startsWith('messages-only') ? 'prod' : 'dev'

  // Compose merged config — preserve any keys we didn't ask about.
  const example = readJSON(EXAMPLE_PATH) ?? {}
  const cfg = {
    ...example,
    ...existing,
    username: characterName,
    owner_username: ownerUsername,
    persona: {
      ...(existing.persona ?? example.persona ?? {}),
      name: characterName,
      backstory,
      tone,
    },
    anthropic: {
      ...(existing.anthropic ?? example.anthropic ?? {}),
      api_key: apiKey,
    },
    chat: {
      ...(existing.chat ?? example.chat ?? {}),
      mode: chatModeValue,
    },
  }
  if (playerName) cfg.owner_preferred_name = playerName

  writeConfig(cfg)
  seedOwnerMd(playerName, ownerUsername)

  output.write('\n')
  output.write(`${green('✓')} wrote ${gray(CONFIG_PATH)}\n`)
  output.write('\n')
  output.write(`${blue('next:')}\n`)
  output.write(`  1. open a Minecraft world and click ${bold('Open to LAN')}\n`)
  output.write(`  2. run ${bold(blue('sei start'))}\n`)
  output.write('\n')
  output.write(dim(`  re-run onboarding any time with ${bold('sei config')}\n`))
  output.write('\n')
}

// ─── Subcommands ─────────────────────────────────────────────────────────
async function cmdStart() {
  // Spawn `node src/index.js --lan`. We do NOT import the bot here because
  // mineflayer pulls native modules; keeping start as a child process means
  // the CLI itself stays light.
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [INDEX_PATH, '--lan'], {
    stdio: 'inherit',
    cwd: PROJECT_ROOT,
  })
  return new Promise((res) => {
    child.on('exit', (code) => { process.exit(code ?? 0) })
    child.on('error', (err) => {
      output.write(`${red('!')} failed to start: ${err.message}\n`)
      process.exit(1)
    })
  })
}

async function cmdConfig() {
  banner()
  const rl = readline.createInterface({ input, output })
  try {
    await onboard({ rl, existing: loadExisting(), mode: 'reconfig' })
  } finally {
    rl.close()
  }
}

async function cmdMenu() {
  banner()
  const cfg = readJSON(CONFIG_PATH)
  if (!cfg) {
    // First run: full onboarding.
    const rl = readline.createInterface({ input, output })
    try {
      await onboard({ rl, existing: loadExisting(), mode: 'first-run' })
    } finally {
      rl.close()
    }
    return
  }
  const rl = readline.createInterface({ input, output })
  try {
    const choice = await pick(rl, 'what now?', ['start', 'config', 'quit'], 0)
    rl.close()
    if (choice === 'start')  return cmdStart()
    if (choice === 'config') return cmdConfig()
    process.exit(0)
  } finally {
    try { rl.close() } catch {}
  }
}

function cmdHelp() {
  output.write(`
${bold(blue('sei'))} ${gray('— framework for custom Minecraft personas')}

${bold('usage')}
  sei              show menu (or run onboarding on first run)
  sei start        connect to an open LAN world and run the persona
  sei config       re-run onboarding
  sei help         show this help

${gray(`config lives in ${CONFIG_PATH}`)}
`)
}

// ─── Entrypoint ──────────────────────────────────────────────────────────
async function main() {
  const arg = process.argv[2]
  if (arg === 'start')                         return cmdStart()
  if (arg === 'config')                        return cmdConfig()
  if (arg === 'help' || arg === '--help' || arg === '-h') return cmdHelp()
  if (!arg)                                    return cmdMenu()
  output.write(`${red('!')} unknown command: ${arg}\n`)
  cmdHelp()
  process.exit(1)
}

// Only run when invoked directly (so unit tests can import without booting).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    output.write(`${red('!')} ${err?.stack ?? err?.message ?? err}\n`)
    process.exit(1)
  })
}
