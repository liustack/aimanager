// Artifact-fetch domain: official source plus China mirrors, tried in order
// per request. No probe, no global "which network" switch — nodejs.org being
// reachable does not imply registry.npmjs.org is. Instead the last source
// that actually delivered is remembered per artifact ("source memory"), so
// users on a slow route to the official host skip straight to the mirror on
// later requests, and the official source is retried after a window so
// changed networks (proxy on/off, travel) migrate back automatically.

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, readFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const ARTIFACT_SOURCES = {
  'node-dist': {
    official: 'https://nodejs.org/dist',
    mirrors: ['https://registry.npmmirror.com/-/binary/node']
  },
  'npm-registry': {
    official: 'https://registry.npmjs.org',
    mirrors: ['https://registry.npmmirror.com']
  }
} as const

export type ArtifactId = keyof typeof ARTIFACT_SOURCES

const STALL_MS = 8_000
const DOWNLOAD_FAILED = '下载失败,请检查网络后重试'

// 50 KiB/s sits above the design's 10–50 KB/s "connected but crawling"
// cross-border band (the 20 KB/s acceptance case) and far below a usable
// official CDN. 16s warmup so DNS/TLS jitter does not flip a healthy source.
export const THROUGHPUT_WARMUP_MS = 16_000
export const MIN_THROUGHPUT_BYTES_PER_SEC = 50 * 1024

export function shouldAbandonForThroughput(
  receivedBytes: number,
  elapsedMs: number,
  hasNextCandidate: boolean
): boolean {
  if (!hasNextCandidate || elapsedMs < THROUGHPUT_WARMUP_MS) return false
  return receivedBytes * 1000 < MIN_THROUGHPUT_BYTES_PER_SEC * elapsedMs
}

function stripSlash(url: string): string {
  return url.replace(/\/$/, '')
}

function officialBase(artifact: ArtifactId): string {
  // AIMANAGER_OFFICIAL_BASE is a verification hook (force the official origin
  // to a dead host and confirm we land on the mirror). Not a user setting.
  const override = process.env.AIMANAGER_OFFICIAL_BASE
  if (override) return stripSlash(override)
  return ARTIFACT_SOURCES[artifact].official
}

// Retry the official source once the remembered win is this old. The cost is
// one slow attempt per window for users who really need the mirror; the gain
// is that everyone else migrates back to the official source by itself.
export const RETRY_OFFICIAL_MS = 7 * 24 * 60 * 60 * 1000

export interface SourceWin {
  winner: string
  wonAt: number
}

export function orderBases(bases: string[], memo: SourceWin | undefined, now: number): string[] {
  if (!memo) return bases
  if (now - memo.wonAt >= RETRY_OFFICIAL_MS) return bases
  const idx = bases.indexOf(memo.winner)
  if (idx <= 0) return bases
  return [bases[idx], ...bases.slice(0, idx), ...bases.slice(idx + 1)]
}

// A win by the official source clears the memory (official-first is the
// default order). While the same mirror keeps winning, wonAt is kept from its
// first win so the official retry actually happens once the window elapses.
export function updatedWin(
  prev: SourceWin | undefined,
  base: string,
  official: string,
  now: number
): SourceWin | undefined {
  if (base === official) return undefined
  if (prev?.winner === base) return prev
  return { winner: base, wonAt: now }
}

const memoryFile = join(homedir(), '.aimanager', 'source-memory.json')
let memoryState: Partial<Record<ArtifactId, SourceWin>> | null = null

/** Test isolation hook: pin the in-memory state (or null to reload from disk). */
export function primeSourceMemory(state: Partial<Record<ArtifactId, SourceWin>> | null): void {
  memoryState = state
}

function loadMemory(): Partial<Record<ArtifactId, SourceWin>> {
  if (memoryState) return memoryState
  const out: Partial<Record<ArtifactId, SourceWin>> = {}
  try {
    const raw = JSON.parse(readFileSync(memoryFile, 'utf8')) as Record<string, unknown>
    for (const key of Object.keys(ARTIFACT_SOURCES) as ArtifactId[]) {
      const rec = raw[key] as { winner?: unknown; wonAt?: unknown } | undefined
      if (rec && typeof rec.winner === 'string' && typeof rec.wonAt === 'number') {
        out[key] = { winner: rec.winner, wonAt: rec.wonAt }
      }
    }
  } catch {
    // no memory yet
  }
  memoryState = out
  return out
}

export function recordSourceWin(artifact: ArtifactId, base: string): void {
  // The override is a verification hook; don't let test runs poison memory.
  if (process.env.AIMANAGER_OFFICIAL_BASE) return
  const memo = loadMemory()
  const next = updatedWin(memo[artifact], stripSlash(base), stripSlash(officialBase(artifact)), Date.now())
  if (next === memo[artifact]) return
  if (next === undefined) delete memo[artifact]
  else memo[artifact] = next
  void mkdir(dirname(memoryFile), { recursive: true })
    .then(() => writeFile(memoryFile, JSON.stringify(memo, null, 2)))
    .catch(() => undefined)
}

function basesFor(artifact: ArtifactId): string[] {
  const bases = [officialBase(artifact), ...ARTIFACT_SOURCES[artifact].mirrors].map(stripSlash)
  return orderBases(bases, loadMemory()[artifact], Date.now())
}

function baseOfUrl(artifact: ArtifactId, url: string): string | null {
  for (const base of [officialBase(artifact), ...ARTIFACT_SOURCES[artifact].mirrors].map(stripSlash)) {
    if (url === base || url.startsWith(`${base}/`)) return base
  }
  return null
}

export function resolveUrls(artifact: ArtifactId, path: string): string[] {
  const rel = path.replace(/^\//, '')
  return basesFor(artifact).map((base) => `${base}/${rel}`)
}

export function npmRegistries(): string[] {
  return basesFor('npm-registry')
}

export function officialNpmRegistry(): string {
  return stripSlash(officialBase('npm-registry'))
}

export async function tryCandidates<T>(
  candidates: readonly string[],
  attempt: (url: string, ctx: { hasNextCandidate: boolean }) => Promise<T>,
  onFail?: (url: string, err: unknown) => void | Promise<void>
): Promise<T> {
  if (candidates.length === 0) throw new Error(DOWNLOAD_FAILED)
  for (let i = 0; i < candidates.length; i++) {
    const url = candidates[i]
    try {
      return await attempt(url, { hasNextCandidate: i < candidates.length - 1 })
    } catch (err) {
      await onFail?.(url, err)
    }
  }
  throw new Error(DOWNLOAD_FAILED)
}

export function createStallWatch(ms: number, onStall: () => void): { bump: () => void; stop: () => void } {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (): void => {
    clearTimeout(timer)
    if (stopped) return
    timer = setTimeout(onStall, ms)
  }
  arm()
  return {
    bump: arm,
    stop() {
      stopped = true
      clearTimeout(timer)
    }
  }
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export async function assertSha256(path: string, expected: string): Promise<void> {
  const actual = await sha256File(path)
  if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error('sha256 mismatch')
}

export interface DownloadOpts {
  onProgress?: (received: number, total: number) => void
  sha256?: string
  stallMs?: number
  /** When set, the base that delivered is remembered for future ordering. */
  artifact?: ArtifactId
}

async function downloadOne(
  url: string,
  destPath: string,
  opts: DownloadOpts,
  hasNextCandidate: boolean
): Promise<void> {
  const controller = new AbortController()
  const watch = createStallWatch(opts.stallMs ?? STALL_MS, () => controller.abort())
  let startedAt = Date.now()
  let received = 0
  let tick: ReturnType<typeof setInterval> | undefined
  const checkThroughput = (): void => {
    if (shouldAbandonForThroughput(received, Date.now() - startedAt, hasNextCandidate)) {
      controller.abort()
    }
  }
  try {
    // Proxy: Node's fetch is undici and ignores HTTP(S)_PROXY unless the
    // process started with NODE_USE_ENV_PROXY=1 / --use-env-proxy
    // (https://nodejs.org/api/cli.html#--use-env-proxy). `import 'undici'` is
    // not a public Node builtin — verified on Node 24.13 ("Cannot find
    // package 'undici'") and Electron 43 ships Node 24.17, same constraint —
    // so EnvHttpProxyAgent cannot be constructed without adding a dependency.
    // The engine is forked with NODE_USE_ENV_PROXY=1 (see src/main/index.ts).
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    watch.bump()
    startedAt = Date.now()
    const total = Number(res.headers.get('content-length') ?? 0)
    tick = setInterval(checkThroughput, 1000)
    const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
    body.on('data', (chunk: Buffer) => {
      watch.bump()
      received += chunk.length
      checkThroughput()
      opts.onProgress?.(received, total)
    })
    await pipeline(body, createWriteStream(destPath))
    watch.stop()
    if (opts.sha256) await assertSha256(destPath, opts.sha256)
  } finally {
    if (tick) clearInterval(tick)
    watch.stop()
  }
}

export async function download(
  candidateUrls: string[],
  destPath: string,
  opts: DownloadOpts = {}
): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true })
  await tryCandidates(
    candidateUrls,
    async (url, { hasNextCandidate }) => {
      await downloadOne(url, destPath, opts, hasNextCandidate)
      if (opts.artifact) {
        const base = baseOfUrl(opts.artifact, url)
        if (base) recordSourceWin(opts.artifact, base)
      }
    },
    async () => {
      await rm(destPath, { force: true })
    }
  )
}
