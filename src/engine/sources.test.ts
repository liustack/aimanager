import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertSha256,
  createStallWatch,
  MIN_THROUGHPUT_BYTES_PER_SEC,
  npmRegistries,
  orderBases,
  primeSourceMemory,
  resolveUrls,
  RETRY_OFFICIAL_MS,
  sha256File,
  shouldAbandonForThroughput,
  THROUGHPUT_WARMUP_MS,
  tryCandidates,
  updatedWin
} from './sources'

// Pin the source memory empty so tests never depend on the developer's real
// ~/.aimanager/source-memory.json.
beforeEach(() => {
  primeSourceMemory({})
})

describe('resolveUrls', () => {
  it('puts the official node dist origin first and the npmmirror second', () => {
    expect(resolveUrls('node-dist', 'v24.19.0/node-v24.19.0-darwin-arm64.tar.gz')).toEqual([
      'https://nodejs.org/dist/v24.19.0/node-v24.19.0-darwin-arm64.tar.gz',
      'https://registry.npmmirror.com/-/binary/node/v24.19.0/node-v24.19.0-darwin-arm64.tar.gz'
    ])
  })

  it('puts the official npm registry first and the npmmirror second', () => {
    expect(resolveUrls('npm-registry', '@deepseek-ai/dsh')).toEqual([
      'https://registry.npmjs.org/@deepseek-ai/dsh',
      'https://registry.npmmirror.com/@deepseek-ai/dsh'
    ])
  })

  it('strips a leading slash on the path so bases do not double-slash', () => {
    expect(resolveUrls('node-dist', '/index.json')[0]).toBe('https://nodejs.org/dist/index.json')
  })

  it('replaces only the official origin when AIMANAGER_OFFICIAL_BASE is set', () => {
    const prev = process.env.AIMANAGER_OFFICIAL_BASE
    process.env.AIMANAGER_OFFICIAL_BASE = 'https://example.invalid'
    try {
      expect(resolveUrls('node-dist', 'v1/a.tar.gz')).toEqual([
        'https://example.invalid/v1/a.tar.gz',
        'https://registry.npmmirror.com/-/binary/node/v1/a.tar.gz'
      ])
    } finally {
      if (prev === undefined) delete process.env.AIMANAGER_OFFICIAL_BASE
      else process.env.AIMANAGER_OFFICIAL_BASE = prev
    }
  })
})

describe('npmRegistries', () => {
  it('returns official then mirror, with no path suffix', () => {
    expect(npmRegistries()).toEqual(['https://registry.npmjs.org', 'https://registry.npmmirror.com'])
  })

  it('puts a remembered mirror win first', () => {
    primeSourceMemory({
      'npm-registry': { winner: 'https://registry.npmmirror.com', wonAt: Date.now() }
    })
    expect(npmRegistries()).toEqual(['https://registry.npmmirror.com', 'https://registry.npmjs.org'])
  })
})

describe('orderBases', () => {
  const bases = ['official', 'mirror-a', 'mirror-b']

  it('keeps the default order without a memory', () => {
    expect(orderBases(bases, undefined, 1000)).toEqual(bases)
  })

  it('moves a fresh mirror win to the front, preserving the rest', () => {
    const memo = { winner: 'mirror-b', wonAt: 1000 }
    expect(orderBases(bases, memo, 1000 + RETRY_OFFICIAL_MS - 1)).toEqual([
      'mirror-b',
      'official',
      'mirror-a'
    ])
  })

  it('reverts to official-first once the win is old enough to re-probe', () => {
    const memo = { winner: 'mirror-a', wonAt: 1000 }
    expect(orderBases(bases, memo, 1000 + RETRY_OFFICIAL_MS)).toEqual(bases)
  })

  it('ignores a winner that is already first or unknown', () => {
    expect(orderBases(bases, { winner: 'official', wonAt: 1000 }, 1000)).toEqual(bases)
    expect(orderBases(bases, { winner: 'gone', wonAt: 1000 }, 1000)).toEqual(bases)
  })
})

describe('updatedWin', () => {
  it('clears the memory when the official source wins', () => {
    const prev = { winner: 'mirror', wonAt: 1 }
    expect(updatedWin(prev, 'official', 'official', 2)).toBeUndefined()
  })

  it('keeps wonAt while the same mirror keeps winning, so the re-probe still happens', () => {
    const prev = { winner: 'mirror', wonAt: 1 }
    expect(updatedWin(prev, 'mirror', 'official', 999)).toBe(prev)
  })

  it('records a new mirror win with the current time', () => {
    expect(updatedWin(undefined, 'mirror', 'official', 42)).toEqual({ winner: 'mirror', wonAt: 42 })
    expect(updatedWin({ winner: 'other', wonAt: 1 }, 'mirror', 'official', 42)).toEqual({
      winner: 'mirror',
      wonAt: 42
    })
  })
})

describe('tryCandidates', () => {
  it('returns the first successful attempt and does not call later sources', async () => {
    const seen: string[] = []
    const result = await tryCandidates(['a', 'b'], async (url) => {
      seen.push(url)
      return `${url}-ok`
    })
    expect(result).toBe('a-ok')
    expect(seen).toEqual(['a'])
  })

  it('falls back to the next source after a failure and runs onFail', async () => {
    const seen: string[] = []
    const failed: string[] = []
    const result = await tryCandidates(
      ['a', 'b'],
      async (url) => {
        seen.push(url)
        if (url === 'a') throw new Error('boom')
        return 'ok'
      },
      async (url) => {
        failed.push(url)
      }
    )
    expect(result).toBe('ok')
    expect(seen).toEqual(['a', 'b'])
    expect(failed).toEqual(['a'])
  })

  it('throws a Chinese network error when every source fails', async () => {
    await expect(tryCandidates(['a', 'b'], async () => {
      throw new Error('nope')
    })).rejects.toThrow(/下载失败/)
  })

  it('throws when the candidate list is empty', async () => {
    await expect(tryCandidates([], async () => 1)).rejects.toThrow(/下载失败/)
  })
})

describe('sha256', () => {
  let dir = ''

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = ''
  })

  it('hashes a file and accepts a matching digest case-insensitively', async () => {
    dir = await mkdtemp(join(tmpdir(), 'aim-sha-'))
    const path = join(dir, 'blob')
    await writeFile(path, 'hello')
    const digest = createHash('sha256').update('hello').digest('hex')
    expect(await sha256File(path)).toBe(digest)
    await expect(assertSha256(path, digest.toUpperCase())).resolves.toBeUndefined()
  })

  it('rejects a mismatch so the caller can treat the source as failed', async () => {
    dir = await mkdtemp(join(tmpdir(), 'aim-sha-'))
    const path = join(dir, 'blob')
    await writeFile(path, 'hello')
    await expect(assertSha256(path, '0'.repeat(64))).rejects.toThrow()
  })
})

describe('shouldAbandonForThroughput', () => {
  const warmup = THROUGHPUT_WARMUP_MS
  const minBps = MIN_THROUGHPUT_BYTES_PER_SEC
  const slowBytes = Math.floor((minBps * warmup) / 1000) - 1
  const keepBytes = Math.ceil((minBps * warmup) / 1000)

  it('never abandons the last candidate, even when far below the floor', () => {
    expect(shouldAbandonForThroughput(0, warmup + 60_000, false)).toBe(false)
    expect(shouldAbandonForThroughput(slowBytes, warmup, false)).toBe(false)
  })

  it('does not judge during the warmup window', () => {
    expect(shouldAbandonForThroughput(0, warmup - 1, true)).toBe(false)
    expect(shouldAbandonForThroughput(1, 0, true)).toBe(false)
  })

  it('abandons a slow source after warmup when another candidate remains', () => {
    expect(shouldAbandonForThroughput(slowBytes, warmup, true)).toBe(true)
  })

  it('keeps a source at or above the floor after warmup', () => {
    expect(shouldAbandonForThroughput(keepBytes, warmup, true)).toBe(false)
  })
})

describe('createStallWatch', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires after the quiet period and resets when bumped', async () => {
    vi.useFakeTimers()
    const onStall = vi.fn()
    const watch = createStallWatch(8_000, onStall)
    await vi.advanceTimersByTimeAsync(7_999)
    expect(onStall).not.toHaveBeenCalled()
    watch.bump()
    await vi.advanceTimersByTimeAsync(7_999)
    expect(onStall).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(onStall).toHaveBeenCalledOnce()
    watch.stop()
  })

  it('does not fire after stop', async () => {
    vi.useFakeTimers()
    const onStall = vi.fn()
    const watch = createStallWatch(8_000, onStall)
    watch.stop()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(onStall).not.toHaveBeenCalled()
  })
})
