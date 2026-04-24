import { loadConfig } from './config.js'
import { start } from './bot.js'

const config = loadConfig()
start(config)
