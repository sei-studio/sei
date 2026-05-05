#!/usr/bin/env node
// src/cli/index.js — sei CLI: onboarding, start, config.
// Zero new deps; uses node:readline/promises and node:fs.

import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs'
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
const MEMORY_DIR = resolve(PROJECT_ROOT, 'memory')
const OWNER_MD_PATH = resolve(MEMORY_DIR, 'OWNER.md')
const INDEX_PATH = resolve(PROJECT_ROOT, 'src', 'index.js')

const DEFAULT_CONFIG = {
  host: '127.0.0.1',
  port: 25565,
  auth: 'offline',
  username: 'Sui',
  owner_username: 'YourMinecraftName',
  minecraft_version: '1.21.1',
  reconnect_delay_ms: 5000,
  pathfinder_timeout_ms: 12000,
  follow_range: 3,
  persona: {
    name: 'Sui',
    backstory: 'A curious companion who enjoys exploring blocky worlds alongside their friend.',
    tone: 'friendly',
  },
  anthropic: { api_key: '' },
  llm: { rate_limit_per_min: 30, debounce_ms: 500, max_hops: 5, idle_fallback_ms: 10000 },
}

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
  return readJSON(CONFIG_PATH) ?? DEFAULT_CONFIG
}
function writeConfig(cfg) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
}

// Light-touch OWNER.md seed — only writes preferred_name if the file is
// missing. Once OWNER.md exists, the runtime owns it (memory/owner.js).
function seedOwnerMd(preferredName, ownerUsername) {
  if (existsSync(OWNER_MD_PATH)) return
  if (!preferredName && !ownerUsername) return
  mkdirSync(MEMORY_DIR, { recursive: true })
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

  // Compose merged config — preserve any keys we didn't ask about.
  const cfg = {
    ...DEFAULT_CONFIG,
    ...existing,
    username: characterName,
    owner_username: ownerUsername,
    persona: {
      ...DEFAULT_CONFIG.persona,
      ...(existing.persona ?? {}),
      name: characterName,
      backstory,
      tone,
    },
    anthropic: {
      ...DEFAULT_CONFIG.anthropic,
      ...(existing.anthropic ?? {}),
      api_key: apiKey,
    },
  }
  // Strip the legacy chat-mode field if a previous onboarding wrote it.
  delete cfg.chat
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

// `start` and `config` both require that onboarding has run at least once
// (config.json exists). Guard them so the user gets a clear error instead of
// a confusing readline prompt or a bot that boots with placeholder defaults.
function requireOnboarded(cmdName) {
  if (existsSync(CONFIG_PATH)) return
  output.write(`${red('!')} no ${gray('config.json')} found — run ${bold(blue('sei'))} first to set up your persona.\n`)
  output.write(dim(`   (sei ${cmdName} requires onboarding to have been completed)\n`))
  process.exit(1)
}

// ─── Subcommands ─────────────────────────────────────────────────────────
async function cmdStart() {
  requireOnboarded('start')
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
  requireOnboarded('config')
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
// Resolve symlinks on argv[1] — npm/npx dispatch the `bin` entry through a
// symlink (e.g. node_modules/.bin/sei → src/cli/index.js), and without
// realpath the URLs never match, leaving `main()` uncalled and the process
// exiting silently.
function isDirectInvocation() {
  const argv1 = process.argv[1]
  if (!argv1) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href
  } catch {
    // argv[1] missing or unreadable — assume direct invocation since the
    // script clearly ran. Better to boot than to exit silently.
    return true
  }
}

if (isDirectInvocation()) {
  main().catch((err) => {
    output.write(`${red('!')} ${err?.stack ?? err?.message ?? err}\n`)
    process.exit(1)
  })
}
