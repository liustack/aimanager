// Cross-platform launcher for dev/smoke commands. Exists for two reasons:
// `env -u` is unix-only, and editors that are themselves Electron apps leak
// ELECTRON_RUN_AS_NODE=1 into integrated terminals, which would make the
// Electron binary start as plain Node.

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mode = process.argv[2]

delete process.env.ELECTRON_RUN_AS_NODE

const isWindows = process.platform === 'win32'
const electronViteBin = join(
  root,
  'node_modules',
  '.bin',
  isWindows ? 'electron-vite.cmd' : 'electron-vite'
)

function runStep(cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, ...env },
      // .cmd files require a shell to spawn on Windows.
      shell: isWindows
    })
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))))
    child.on('error', reject)
  })
}

// require('electron') resolves to the binary path when run under plain Node.
const electronBin = require('electron')

try {
  if (mode === 'dev') {
    await runStep(electronViteBin, ['dev'])
  } else if (mode === 'smoke' || mode === 'smoke:dsh' || mode === 'smoke:apps') {
    await runStep(electronViteBin, ['build'])
    const smokeEnv = { smoke: '1', 'smoke:dsh': 'dsh', 'smoke:apps': 'apps' }
    await runStep(electronBin, ['.'], { AIM_SMOKE: smokeEnv[mode] })
  } else {
    console.error(`unknown mode: ${mode}`)
    process.exit(2)
  }
} catch (err) {
  console.error(String(err))
  process.exit(1)
}
