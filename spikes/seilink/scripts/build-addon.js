// Builds native/seilink.node against the Electron headers of the installed electron version.
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const electronVersion = require('electron/package.json').version
const gyp = require.resolve('node-gyp/bin/node-gyp.js')
const args = [
  gyp, 'rebuild',
  `--target=${electronVersion}`,
  `--arch=${process.env.SEILINK_ARCH || process.arch}`,
  '--dist-url=https://electronjs.org/headers',
]
console.log('node', args.join(' '))
execFileSync(process.execPath, args, { cwd: path.join(__dirname, '..'), stdio: 'inherit' })
