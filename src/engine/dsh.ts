// dsh domain: installs and supervises DeepSeek Harness. Its web UI is served
// locally and rendered inside an aimanager window; the user never sees npm,
// npx, or a port number.
//
// State intentionally stays in dsh's own default home (~/.dsh), shared with
// any copy the user runs by hand — online tutorials about dsh configuration
// must keep working against the managed instance. See decisions.md.

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { baseDir, ensureNode, exists, nodeExe, npmCli, run, runtimePath } from './runtime'

const dshDir = join(baseDir, 'apps', 'dsh')
const dshPkgDir = join(dshDir, 'node_modules', '@deepseek-ai', 'dsh')
// Dedicated port for the aimanager-managed instance. dsh defaults to 3080,
// which a user-run copy may already occupy; a fixed private port keeps the
// two from colliding or impersonating each other.
const dshPort = 34517
export const dshUrl = `http://127.0.0.1:${dshPort}`

let child: ChildProcess | null = null
let lastStderr = ''

export async function dshInstalled(): Promise<boolean> {
  return exists(join(dshPkgDir, 'package.json'))
}

export function dshRunning(): boolean {
  return child !== null && child.exitCode === null
}

export async function ensureDsh(onStage: (stage: string) => void): Promise<void> {
  const node = await ensureNode(onStage)
  if (await dshInstalled()) return
  onStage('dsh-install')
  await mkdir(dshDir, { recursive: true })
  const pkgPath = join(dshDir, 'package.json')
  if (!(await exists(pkgPath))) {
    await writeFile(pkgPath, JSON.stringify({ name: 'aimanager-dsh', private: true }, null, 2))
  }
  // npm runs as `node npm-cli.js` instead of the npm/.cmd shims: same code
  // path on every platform, and no shell needed to spawn .cmd on Windows.
  await run(
    nodeExe(node),
    [npmCli(node), 'install', '@deepseek-ai/dsh@latest', '--no-fund', '--no-audit'],
    { cwd: dshDir, env: { ...process.env, PATH: runtimePath(node) } }
  )
}

// Resolve dsh's entry script from its own bin declaration, then run it with
// the private node directly — the node_modules/.bin shims differ per platform
// (.cmd on Windows) while the entry script does not.
export function resolveBinRelative(pkg: { bin?: string | Record<string, string> }): string {
  const rel =
    typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin?.dsh ?? Object.values(pkg.bin ?? {})[0])
  if (!rel) throw new Error('dsh 包未声明可执行入口')
  return rel
}

async function dshEntry(): Promise<string> {
  const raw = await readFile(join(dshPkgDir, 'package.json'), 'utf8')
  const pkg = JSON.parse(raw) as { bin?: string | Record<string, string> }
  return join(dshPkgDir, resolveBinRelative(pkg))
}

async function serving(): Promise<boolean> {
  try {
    await fetch(dshUrl, { signal: AbortSignal.timeout(1000) })
    return true
  } catch {
    return false
  }
}

export async function launchDsh(onStage: (stage: string) => void): Promise<{ url: string }> {
  // Something already answers on the port: a dsh we started earlier, or one
  // left over from a previous run. Either way the UI is there; just open it.
  if (await serving()) return { url: dshUrl }

  await ensureDsh(onStage)
  const node = await ensureNode(onStage)

  onStage('starting')
  lastStderr = ''
  child = spawn(nodeExe(node), [await dshEntry(), 'web', '--port', String(dshPort)], {
    cwd: dshDir,
    env: { ...process.env, PATH: runtimePath(node) },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    lastStderr = (lastStderr + String(chunk)).slice(-1000)
  })

  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const detail = lastStderr.trim()
      child = null
      throw new Error(`应用意外退出${detail ? `:${detail.slice(-300)}` : ''}`)
    }
    if (await serving()) return { url: dshUrl }
    await delay(500)
  }
  stopDsh()
  throw new Error('启动超时,请重试')
}

export function stopDsh(): void {
  if (child && child.exitCode === null) child.kill('SIGTERM')
  child = null
}

process.on('exit', () => {
  if (child && child.exitCode === null) child.kill('SIGTERM')
})
