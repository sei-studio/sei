#!/usr/bin/env node
// src/cli/index.js — sei CLI: onboarding, start, config.
// Zero new deps; uses node:readline/promises and node:fs.

import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
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
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..')
const CONFIG_PATH = resolve(PROJECT_ROOT, 'config.json')
const MEMORY_DIR = resolve(PROJECT_ROOT, 'memory')
const PLAYER_MD_PATH = resolve(MEMORY_DIR, 'PLAYER.md')
const INDEX_PATH = resolve(PROJECT_ROOT, 'src', 'bot', 'index.js')

const DEFAULT_CONFIG = {
  player_username: 'YourMinecraftName',
  // Adapter-specific fields nest under adapter.<kind>.*. The loader's
  // migrateLegacyAdapterFields hoists older flat configs automatically, so
  // this CLI writes the new shape directly.
  adapter: {
    kind: 'minecraft',
    minecraft: {
      host: '127.0.0.1',
      auth: 'offline',
      username: 'Sui',
      version: '1.21.1',
      reconnect_delay_ms: 5000,
      pathfinder_timeout_ms: 12000,
      follow_range: 3,
    },
  },
  // 260516-0yw: persona is now { name, source, expanded }. `source` is the
  // user's short blurb; `expanded` is the LLM-generated long prompt produced
  // by the GUI at character-save time. The CLI does NOT call the expansion
  // API itself — it writes an empty `expanded` and the user must either run
  // the GUI to populate it, or hand-fill the config.json before `sei start`.
  // The bot's config.persona schema reads `expanded`; an empty value throws
  // an explicit error at boot.
  persona: {
    name: 'Sui',
    source: 'A curious companion who enjoys exploring blocky worlds alongside their friend.',
    expanded: '',
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

// Light-touch PLAYER.md seed — only writes preferred_name if the file is
// missing. Once PLAYER.md exists, the runtime owns it (memory/player.js).
function seedPlayerMd(preferredName, playerUsername) {
  if (existsSync(PLAYER_MD_PATH)) return
  if (!preferredName && !playerUsername) return
  mkdirSync(MEMORY_DIR, { recursive: true })
  const front = [
    '---',
    'player_uuid:',
    `player_username: ${playerUsername || ''}`,
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
  writeFileSync(PLAYER_MD_PATH, front, 'utf8')
}

// ─── Onboarding flow ─────────────────────────────────────────────────────
async function onboard({ rl, existing, mode = 'first-run' }) {
  const verb = mode === 'first-run' ? 'set up' : 're-configure'
  output.write(`${blue('→')} let's ${verb} your persona.\n\n`)

  const prevPersona = existing.persona ?? {}

  const playerName = await ask(rl, 'your name (what should the persona call you?):', {
    def: existing.player_preferred_name ?? '',
  })

  const playerUsername = await ask(rl, 'your minecraft username:', {
    def: existing.player_username ?? '',
    validate: (v) => v.length === 0 ? 'required' : null,
  })

  const characterName = await ask(rl, 'name of the character (the bot):', {
    def: prevPersona.name ?? 'Sui',
    validate: (v) => v.length === 0 ? 'required' : null,
  })

  // 260516-0yw: ask for a short PERSONA SOURCE blurb. The GUI's main-process
  // Anthropic call expands this into the six-section persona prompt at
  // character-save time. CLI users won't get the LLM expansion (no Electron
  // safeStorage / IPC pipeline here), so `expanded` stays empty and the bot
  // boot will refuse with a clear error until the GUI is used at least once
  // OR `expanded` is hand-pasted into config.json.
  const source = await ask(rl, "short persona blurb (who is this character?):", {
    def: prevPersona.source ?? prevPersona.backstory ?? 'A curious companion who enjoys exploring blocky worlds alongside their friend.',
  })

  const chatModeOpts = ['chat', 'full']
  const prevChatMode = existing.chat_mode === 'full' ? 1 : 0
  const chatMode = await pick(
    rl,
    'chat mode (chat = only say() reaches Minecraft; full = also print bot thinking with [think] prefix):',
    chatModeOpts,
    prevChatMode,
  )

  const apiKey = await ask(rl, 'anthropic api key (or blank to use $ANTHROPIC_API_KEY):', {
    def: existing.anthropic?.api_key ?? '',
  })

  // Compose merged config — preserve any keys we didn't ask about.
  // `username` (the character / mineflayer login name) lives under
  // adapter.minecraft.username; older configs may still have it at the top
  // level — rewrite to the new shape.
  const existingMc = existing.adapter?.minecraft ?? {}
  const cfg = {
    ...DEFAULT_CONFIG,
    ...existing,
    chat_mode: chatMode,
    player_username: playerUsername,
    adapter: {
      kind: 'minecraft',
      minecraft: {
        ...DEFAULT_CONFIG.adapter.minecraft,
        ...existingMc,
        // Migrate legacy top-level fields if present in existing config.
        host: existingMc.host ?? existing.host ?? DEFAULT_CONFIG.adapter.minecraft.host,
        port: existingMc.port ?? existing.port,
        auth: existingMc.auth ?? existing.auth ?? DEFAULT_CONFIG.adapter.minecraft.auth,
        version: existingMc.version ?? existing.minecraft_version ?? DEFAULT_CONFIG.adapter.minecraft.version,
        reconnect_delay_ms: existingMc.reconnect_delay_ms ?? existing.reconnect_delay_ms ?? DEFAULT_CONFIG.adapter.minecraft.reconnect_delay_ms,
        pathfinder_timeout_ms: existingMc.pathfinder_timeout_ms ?? existing.pathfinder_timeout_ms ?? DEFAULT_CONFIG.adapter.minecraft.pathfinder_timeout_ms,
        follow_range: existingMc.follow_range ?? existing.follow_range ?? DEFAULT_CONFIG.adapter.minecraft.follow_range,
        username: characterName,
      },
    },
    persona: {
      ...DEFAULT_CONFIG.persona,
      ...(existing.persona ?? {}),
      name: characterName,
      source,
      // Preserve existing expanded if present; CLI does NOT regenerate.
      expanded: (existing.persona?.expanded ?? '').toString(),
    },
    anthropic: {
      ...DEFAULT_CONFIG.anthropic,
      ...(existing.anthropic ?? {}),
      api_key: apiKey,
    },
  }
  // Strip migrated legacy top-level minecraft keys so the file is canonical.
  for (const k of ['host', 'port', 'auth', 'username', 'minecraft_version',
                   'reconnect_delay_ms', 'pathfinder_timeout_ms', 'follow_range']) {
    delete cfg[k]
  }
  // Strip the legacy chat-mode field if a previous onboarding wrote it.
  // (the new field is `chat_mode`, distinct name, no collision)
  delete cfg.chat
  if (playerName) cfg.player_preferred_name = playerName

  writeConfig(cfg)
  seedPlayerMd(playerName, playerUsername)

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
  // Spawn `node src/index.js`. We do NOT import the bot here because
  // mineflayer pulls native modules; keeping start as a child process means
  // the CLI itself stays light.
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [INDEX_PATH], {
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

// ─── Reset ────────────────────────────────────────────────────────────────
// The Electron GUI stores its config at <userData>/config.json (separate from
// the CLI's ./config.json). To force a fresh onboarding pass on next launch
// we delete the GUI's config + api_key.bin (and the CLI's local config).
// Characters are left in place so users keep their personas.
//
// userData path mirrors Electron's `app.getPath('userData')` for productName
// "Sei" (electron-builder.yml). Computed without importing electron so the
// CLI stays light.
function electronUserDataDir() {
  const APP = 'Sei'
  if (process.platform === 'darwin') {
    return resolve(homedir(), 'Library', 'Application Support', APP)
  }
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || resolve(homedir(), 'AppData', 'Roaming')
    return resolve(appdata, APP)
  }
  // linux / other unix
  const xdg = process.env.XDG_CONFIG_HOME || resolve(homedir(), '.config')
  return resolve(xdg, APP)
}

async function cmdReset() {
  banner()
  const userData = electronUserDataDir()
  const guiConfig = resolve(userData, 'config.json')
  const guiApiKey = resolve(userData, 'api_key.bin')
  const cliConfig = CONFIG_PATH

  const targets = [
    { label: 'GUI config',    path: guiConfig, why: 'forces re-run of onboarding' },
    { label: 'GUI API key',   path: guiApiKey, why: "(otherwise app skips onboarding because hasApiKey()=true)" },
    { label: 'CLI config',    path: cliConfig, why: 'legacy ./config.json (only if you used `sei` from terminal)' },
  ]

  const present = targets.filter((t) => existsSync(t.path))
  if (present.length === 0) {
    output.write(`${green('✓')} nothing to reset — no config files found.\n`)
    output.write(dim(`   checked:\n`))
    for (const t of targets) output.write(dim(`     - ${t.path}\n`))
    output.write('\n')
    return
  }

  output.write(`${blue('→')} the following will be deleted (so onboarding re-runs):\n\n`)
  for (const t of present) {
    output.write(`   ${red('✗')} ${t.label}: ${gray(t.path)}\n`)
    output.write(`     ${dim(t.why)}\n`)
  }
  output.write('\n')
  output.write(dim(`   characters and memory are NOT touched.\n\n`))

  const rl = readline.createInterface({ input, output })
  try {
    const ans = (await rl.question(`${cyan('?')} proceed? ${gray('[y/N]')} `)).trim().toLowerCase()
    if (ans !== 'y' && ans !== 'yes') {
      output.write(`${gray('aborted.')}\n\n`)
      return
    }
  } finally {
    rl.close()
  }

  let deleted = 0
  for (const t of present) {
    try {
      rmSync(t.path, { force: true })
      output.write(`${green('✓')} deleted ${gray(t.path)}\n`)
      deleted += 1
    } catch (err) {
      output.write(`${red('!')} could not delete ${gray(t.path)}: ${err?.message ?? err}\n`)
    }
  }
  output.write('\n')
  output.write(`${green('✓')} reset complete (${deleted}/${present.length}).\n`)
  output.write(dim(`   next launch of the Sei app will start onboarding from scratch.\n\n`))
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
  sei config       re-run onboarding (interactive, terminal flow)
  sei reset        delete saved config so the GUI re-runs onboarding next launch
  sei help         show this help

${gray(`CLI config lives in ${CONFIG_PATH}`)}
${gray(`GUI config lives in ${electronUserDataDir()}/config.json`)}
`)
}

// ─── Entrypoint ──────────────────────────────────────────────────────────
async function main() {
  const arg = process.argv[2]
  if (arg === 'start')                         return cmdStart()
  if (arg === 'config')                        return cmdConfig()
  if (arg === 'reset' || arg === 'reset-config') return cmdReset()
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
