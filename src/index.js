import { loadConfig } from './config.js'
import { start } from './bot.js'
import { discoverLanPort } from './lanDiscovery.js'

function parseArgs(argv) {
  const args = { port: null, lan: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--lan') args.lan = true
    else if (a === '--help' || a === '-h') args.help = true
    else if (a === '--port' || a === '-p') {
      args.port = argv[++i]
    } else if (a.startsWith('--port=')) {
      args.port = a.slice('--port='.length)
    }
  }
  return args
}

function printHelp() {
  console.log(`Usage: node src/index.js [options]

Options:
  -p, --port <number>   Override the Minecraft server port (1-65535)
      --lan             Auto-discover an open LAN world via UDP multicast
                        (listens on 224.0.2.60:4445 for ~5s)
  -h, --help            Show this help

When neither --port nor --lan is given, the port from config.json is used.
`)
}

function validatePort(value) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid port: "${value}" (expected integer 1-65535)`)
  }
  return n
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const overrides = {}

  if (args.port != null) {
    overrides.port = validatePort(args.port)
    console.log(`[sei] Using port ${overrides.port} from --port`)
  } else if (args.lan) {
    console.log('[sei] Searching for an open LAN world...')
    const { port, motd } = await discoverLanPort({ timeoutMs: 5000 })
    overrides.port = port
    console.log(`[sei] Found LAN world "${motd}" on port ${port}`)
  }

  const config = loadConfig('./config.json', overrides)
  start(config)
}

main().catch((err) => {
  console.error(`[sei] Startup failed: ${err.message}`)
  process.exit(1)
})
