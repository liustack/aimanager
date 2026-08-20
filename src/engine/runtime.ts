// Runtime domain: provisions an invisible Node.js into aimanager's private
// directory. The user never learns Node exists.
//
// Platform notes: official Node distributions differ per OS — unix tarballs
// place binaries under <dist>/bin and npm under <dist>/lib/node_modules,
// Windows zips place node.exe and node_modules/npm at the dist root. All of
// that is absorbed here; other domains only see NodeRuntime.

import { spawn } from 'node:child_process'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { download, resolveUrls } from './sources'

const isWindows = process.platform === 'win32'

export const baseDir = join(homedir(), '.aimanager')
const nodeDir = join(baseDir, 'runtime', 'node')

export interface NodeRuntime {
  version: string
  /** Extracted distribution root, e.g. ~/.aimanager/runtime/node/v24.19.0 */
  dir: string
  /** Directory containing the node executable */
  binDir: string
}

export function nodeExe(runtime: NodeRuntime): string {
  return join(runtime.binDir, isWindows ? 'node.exe' : 'node')
}

export function npmCli(runtime: NodeRuntime): string {
  return isWindows
    ? join(runtime.dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : join(runtime.dir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
}

/** JS entry, never the .cmd shim. Spawning .cmd without shell throws EINVAL after CVE-2024-27980. */
export function corepackCliPath(
  distDir: string,
  platform: NodeJS.Platform = process.platform
): string {
  return platform === 'win32'
    ? join(distDir, 'node_modules', 'corepack', 'dist', 'corepack.js')
    : join(distDir, 'lib', 'node_modules', 'corepack', 'dist', 'corepack.js')
}

export function corepackCli(runtime: NodeRuntime): string {
  return corepackCliPath(runtime.dir)
}

function pnpmBin(runtime: NodeRuntime): string {
  return join(runtime.binDir, isWindows ? 'pnpm.cmd' : 'pnpm')
}

/** dsh plugin is a thin pnpm forwarder. Private Node ships corepack, not pnpm. */
export async function ensurePnpm(runtime: NodeRuntime): Promise<void> {
  if (await exists(pnpmBin(runtime))) return
  const home = join(baseDir, 'runtime', 'corepack')
  await mkdir(home, { recursive: true })
  await run(nodeExe(runtime), [corepackCli(runtime), 'enable'], {
    env: {
      ...process.env,
      PATH: runtimePath(runtime),
      COREPACK_HOME: home,
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0'
    }
  })
  if (!(await exists(pnpmBin(runtime)))) {
    throw new Error('插件安装器准备失败,请重试')
  }
}

/** PATH with the private node's bin directory prepended. */
export function runtimePath(runtime: NodeRuntime): string {
  return `${runtime.binDir}${delimiter}${process.env.PATH ?? ''}`
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    })
    let stderr = ''
    let timedOut = false
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, opts.timeoutMs)
      : undefined
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += String(chunk)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (timedOut) reject(new Error(`${cmd} timed out after ${opts.timeoutMs}ms`))
      else if (code === 0) resolve()
      else reject(new Error(`${cmd} exited with ${code}: ${stderr.slice(-400)}`))
    })
  })
}

export async function installedNode(): Promise<NodeRuntime | null> {
  if (!(await exists(nodeDir))) return null
  const entries = await readdir(nodeDir)
  const versions = entries
    .filter((entry) => /^v\d+\.\d+\.\d+$/.test(entry))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  for (const version of versions) {
    const dir = join(nodeDir, version)
    const binDir = isWindows ? dir : join(dir, 'bin')
    const runtime = { version, dir, binDir }
    if (await exists(nodeExe(runtime))) return runtime
  }
  return null
}

export interface DistEntry {
  version: string
  lts: string | false
}

/** nodejs.org lists releases newest-first; the first LTS entry is the latest LTS. */
export function pickLtsVersion(entries: DistEntry[]): string {
  const lts = entries.find((entry) => entry.lts !== false)
  if (!lts) throw new Error('未找到 Node LTS 版本')
  return lts.version
}

// Pinned latest LTS as of 2026-08-19 from https://nodejs.org/dist/index.json
// (first lts !== false → v24.19.0 Krypton, date 2026-08-03). SHA256 from
// https://nodejs.org/dist/v24.19.0/SHASUMS256.txt fetched the same day.
export const PINNED_NODE_VERSION = 'v24.19.0'

const PINNED_NODE_SHA256: Record<string, string> = {
  'darwin-arm64': '8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d',
  'darwin-x64': 'd1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316',
  'linux-x64': 'f625d97cd707df4ff96254916fbc5ff014f09c09effe5a1e0ca8f6d41a8789d4',
  'win-x64': '57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73'
}

export function pinnedNodeSha256(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string {
  const key = `${platform === 'win32' ? 'win' : platform}-${arch}`
  const hash = PINNED_NODE_SHA256[key]
  if (!hash) throw new Error(`没有该平台的运行环境(${platform}-${arch})`)
  return hash
}

/** Official archive name, e.g. node-v24.19.0-darwin-arm64.tar.gz / node-v24.19.0-win-x64.zip */
export function distName(
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string {
  const win = platform === 'win32'
  return `node-${version}-${win ? 'win' : platform}-${arch}.${win ? 'zip' : 'tar.gz'}`
}

export async function ensureNode(onStage: (stage: string) => void): Promise<NodeRuntime> {
  const existing = await installedNode()
  if (existing) return existing

  onStage('node-download')
  const version = PINNED_NODE_VERSION
  const name = distName(version)
  const sha256 = pinnedNodeSha256()
  await mkdir(nodeDir, { recursive: true })
  const archivePath = join(nodeDir, name)
  try {
    await download(resolveUrls('node-dist', `${version}/${name}`), archivePath, {
      sha256,
      artifact: 'node-dist'
    })
  } catch {
    throw new Error('下载运行环境失败,请检查网络后重试')
  }

  onStage('node-extract')
  // bsdtar ships with both macOS and Windows 10+, and auto-detects zip.
  await run('tar', ['-xf', archivePath, '-C', nodeDir])
  await rename(join(nodeDir, name.replace(/\.(tar\.gz|zip)$/, '')), join(nodeDir, version))
  await rm(archivePath, { force: true })

  const runtime = await installedNode()
  if (!runtime) throw new Error('运行环境安装后校验失败')
  return runtime
}
