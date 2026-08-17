// Runtime domain: provisions an invisible Node.js into aimanager's private
// directory. The user never learns Node exists.
//
// Platform notes: official Node distributions differ per OS — unix tarballs
// place binaries under <dist>/bin and npm under <dist>/lib/node_modules,
// Windows zips place node.exe and node_modules/npm at the dist root. All of
// that is absorbed here; other domains only see NodeRuntime.

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

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
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      ...opts,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
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

async function pickLatestLts(): Promise<string> {
  const res = await fetch('https://nodejs.org/dist/index.json')
  if (!res.ok) throw new Error(`nodejs.org 响应异常(${res.status})`)
  return pickLtsVersion((await res.json()) as DistEntry[])
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
  const version = await pickLatestLts()
  const name = distName(version)
  await mkdir(nodeDir, { recursive: true })
  const archivePath = join(nodeDir, name)
  const res = await fetch(`https://nodejs.org/dist/${version}/${name}`)
  if (!res.ok || !res.body) throw new Error(`下载运行环境失败(${res.status})`)
  await pipeline(
    Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
    createWriteStream(archivePath)
  )

  onStage('node-extract')
  // bsdtar ships with both macOS and Windows 10+, and auto-detects zip.
  await run('tar', ['-xf', archivePath, '-C', nodeDir])
  await rename(join(nodeDir, name.replace(/\.(tar\.gz|zip)$/, '')), join(nodeDir, version))
  await rm(archivePath, { force: true })

  const runtime = await installedNode()
  if (!runtime) throw new Error('运行环境安装后校验失败')
  return runtime
}
