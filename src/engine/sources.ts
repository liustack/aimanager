// Artifact-fetch domain: official source plus China mirrors, tried in order
// per request. No probe, no global "which network" switch — nodejs.org being
// reachable does not imply registry.npmjs.org is.

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
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

export function resolveUrls(artifact: ArtifactId, path: string): string[] {
  const rel = path.replace(/^\//, '')
  const bases = [officialBase(artifact), ...ARTIFACT_SOURCES[artifact].mirrors]
  return bases.map((base) => `${stripSlash(base)}/${rel}`)
}

export function npmRegistries(): string[] {
  return [officialBase('npm-registry'), ...ARTIFACT_SOURCES['npm-registry'].mirrors].map(stripSlash)
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
    (url, { hasNextCandidate }) => downloadOne(url, destPath, opts, hasNextCandidate),
    async () => {
      await rm(destPath, { force: true })
    }
  )
}
