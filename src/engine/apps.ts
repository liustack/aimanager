// Desktop apps domain: installs and launches harnesses that ship their own
// GUI. Installation must never send the user to a browser — that's the whole
// point of an installer. On macOS both supported apps distribute plain DMGs,
// which mount + copy silently without admin rights. Launching uses the
// vendor app as-is per the vendor-internalization rule.
//
// Windows install/detection is pending real-machine verification (roadmap
// 第 1.5 刀): Claude ships an official MSIX, ChatGPT's installer is TBD.

import { spawn } from 'node:child_process'
import { constants, createWriteStream } from 'node:fs'
import { access, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { baseDir, exists, run } from './runtime'

interface AppSpec {
  id: string
  name: string
  description: string
  macBundles: string[]
  macDmgUrl: string
  winStartMenuName: string
  winRelativeExePaths: string[]
}

const registry: AppSpec[] = [
  {
    id: 'codex',
    name: 'Codex (ChatGPT)',
    description: 'OpenAI 出品:Codex 编程助手 + Chat + Work',
    // The Codex app merged into the ChatGPT desktop app (2026-07); updated
    // installs may keep either bundle name.
    macBundles: ['ChatGPT.app', 'Codex.app'],
    macDmgUrl: 'https://persistent.oaistatic.com/sidekick/public/ChatGPT_Desktop_public_latest.dmg',
    winStartMenuName: 'ChatGPT',
    winRelativeExePaths: []
  },
  {
    id: 'claude',
    name: 'Claude',
    description: 'Anthropic 出品,自带 Claude Code',
    macBundles: ['Claude.app'],
    macDmgUrl:
      'https://storage.googleapis.com/osprey-downloads-c02f6a0d-347c-492b-a752-3e0651722e97/nest/Claude.dmg',
    winStartMenuName: 'Claude',
    winRelativeExePaths: [join('AnthropicClaude', 'claude.exe')]
  }
]

export interface DesktopApp {
  id: string
  name: string
  description: string
  installed: boolean
}

async function macPath(spec: AppSpec): Promise<string | null> {
  for (const bundle of spec.macBundles) {
    for (const dir of ['/Applications', join(homedir(), 'Applications')]) {
      const path = join(dir, bundle)
      if (await exists(path)) return path
    }
  }
  return null
}

function winStartMenuRoots(): string[] {
  const roots: string[] = []
  if (process.env.APPDATA) {
    roots.push(join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'))
  }
  if (process.env.ProgramData) {
    roots.push(join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'))
  }
  return roots
}

async function winPath(spec: AppSpec): Promise<string | null> {
  const localAppData = process.env.LOCALAPPDATA
  if (localAppData) {
    for (const rel of spec.winRelativeExePaths) {
      const path = join(localAppData, rel)
      if (await exists(path)) return path
    }
  }
  const wanted = `${spec.winStartMenuName.toLowerCase()}.lnk`
  for (const root of winStartMenuRoots()) {
    if (!(await exists(root))) continue
    try {
      const entries = await readdir(root, { recursive: true })
      const hit = entries.find((entry) => entry.toLowerCase().endsWith(wanted))
      if (hit) return join(root, hit)
    } catch {
      // A single unreadable Start Menu folder should not fail detection.
    }
  }
  return null
}

function findSpec(id: string): AppSpec {
  const spec = registry.find((entry) => entry.id === id)
  if (!spec) throw new Error(`未知应用:${id}`)
  return spec
}

async function installedPath(spec: AppSpec): Promise<string | null> {
  if (process.platform === 'darwin') return macPath(spec)
  if (process.platform === 'win32') return winPath(spec)
  return null
}

export async function listApps(): Promise<DesktopApp[]> {
  return Promise.all(
    registry.map(async (spec) => ({
      id: spec.id,
      name: spec.name,
      description: spec.description,
      installed: (await installedPath(spec)) !== null
    }))
  )
}

async function writableApplicationsDir(): Promise<string> {
  try {
    await access('/Applications', constants.W_OK)
    return '/Applications'
  } catch {
    return join(homedir(), 'Applications')
  }
}

export async function installApp(
  id: string,
  onStage: (id: string, stage: string) => void,
  onProgress: (id: string, ratio: number) => void,
  targetDir?: string
): Promise<void> {
  const spec = findSpec(id)
  if (process.platform !== 'darwin') {
    throw new Error('这个平台的自动安装还没准备好')
  }
  // targetDir is a verification hook (smoke installs into a scratch dir);
  // real installs skip work when the app is already present.
  if (!targetDir && (await installedPath(spec)) !== null) return

  onStage(id, 'app-download')
  const downloads = join(baseDir, 'downloads')
  await mkdir(downloads, { recursive: true })
  const dmgPath = join(downloads, `${spec.id}.dmg`)
  const res = await fetch(spec.macDmgUrl)
  if (!res.ok || !res.body) throw new Error(`下载失败(${res.status}),请重试`)
  // Byte-level progress feeds the App Store-style ring in the UI; only
  // report whole-percent steps to keep RPC chatter down.
  const total = Number(res.headers.get('content-length') ?? 0)
  let received = 0
  let lastReported = 0
  const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
  if (total > 0) {
    body.on('data', (chunk: Buffer) => {
      received += chunk.length
      const ratio = received / total
      if (ratio - lastReported >= 0.01 || ratio >= 1) {
        lastReported = ratio
        onProgress(id, Math.min(ratio, 1))
      }
    })
  }
  await pipeline(body, createWriteStream(dmgPath))

  onStage(id, 'app-install')
  const mount = await mkdtemp(join(tmpdir(), 'aim-dmg-'))
  try {
    await run('hdiutil', ['attach', dmgPath, '-nobrowse', '-readonly', '-mountpoint', mount])
    const entries = await readdir(mount)
    const appName = entries.find((entry) => entry.endsWith('.app'))
    if (!appName) throw new Error('安装包内容异常,请重试')
    const dest = targetDir ?? (await writableApplicationsDir())
    await mkdir(dest, { recursive: true })
    // ditto preserves bundle signatures and metadata, and needs no admin.
    await run('ditto', [join(mount, appName), join(dest, appName)])
  } finally {
    await run('hdiutil', ['detach', mount, '-quiet']).catch(() => undefined)
    await rm(mount, { recursive: true, force: true }).catch(() => undefined)
    await rm(dmgPath, { force: true })
  }
}

export async function launchApp(id: string): Promise<void> {
  const spec = findSpec(id)
  const path = await installedPath(spec)
  if (!path) throw new Error(`${spec.name} 尚未安装`)
  if (process.platform === 'darwin') {
    await run('open', [path])
    return
  }
  // `start` handles both .exe and .lnk; the empty string fills the window
  // title slot that start would otherwise consume from a quoted path.
  spawn('cmd', ['/c', 'start', '', path], {
    windowsHide: true,
    detached: true,
    stdio: 'ignore'
  }).unref()
}
