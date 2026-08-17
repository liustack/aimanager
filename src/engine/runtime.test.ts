import { describe, expect, it } from 'vitest'
import { distName, pickLtsVersion, type DistEntry } from './runtime'

describe('pickLtsVersion', () => {
  it('picks the first LTS entry, skipping current releases', () => {
    const entries: DistEntry[] = [
      { version: 'v25.1.0', lts: false },
      { version: 'v25.0.0', lts: false },
      { version: 'v24.19.0', lts: 'Krypton' },
      { version: 'v24.18.0', lts: 'Krypton' }
    ]
    expect(pickLtsVersion(entries)).toBe('v24.19.0')
  })

  it('throws when no LTS entry exists', () => {
    expect(() => pickLtsVersion([{ version: 'v25.0.0', lts: false }])).toThrow()
  })
})

describe('distName', () => {
  it('builds unix tarball names from the platform as-is', () => {
    expect(distName('v24.19.0', 'darwin', 'arm64')).toBe('node-v24.19.0-darwin-arm64.tar.gz')
    expect(distName('v24.19.0', 'linux', 'x64')).toBe('node-v24.19.0-linux-x64.tar.gz')
  })

  it('maps win32 to the win zip distribution', () => {
    expect(distName('v24.19.0', 'win32', 'x64')).toBe('node-v24.19.0-win-x64.zip')
  })

  it('defaults to the current process platform', () => {
    expect(distName('v1.0.0')).toContain(process.arch)
  })
})
