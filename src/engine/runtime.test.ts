import { describe, expect, it } from 'vitest'
import { corepackCliPath, distName, pickLtsVersion, pinnedNodeSha256, type DistEntry } from './runtime'

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

describe('pinnedNodeSha256', () => {
  it('pins the official SHASUMS256.txt digest for each supported archive', () => {
    expect(pinnedNodeSha256('darwin', 'arm64')).toBe(
      '8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d'
    )
    expect(pinnedNodeSha256('darwin', 'x64')).toBe(
      'd1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316'
    )
    expect(pinnedNodeSha256('linux', 'x64')).toBe(
      'f625d97cd707df4ff96254916fbc5ff014f09c09effe5a1e0ca8f6d41a8789d4'
    )
    expect(pinnedNodeSha256('win32', 'x64')).toBe(
      '57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73'
    )
  })

  it('throws for an archive we do not pin', () => {
    expect(() => pinnedNodeSha256('linux', 'arm64')).toThrow()
  })
})

describe('corepackCliPath', () => {
  it('uses the unix tarball layout and the windows zip layout', () => {
    expect(corepackCliPath('/rt/v24.19.0', 'darwin')).toBe(
      '/rt/v24.19.0/lib/node_modules/corepack/dist/corepack.js'
    )
    expect(corepackCliPath('/rt/v24.19.0', 'win32')).toBe(
      '/rt/v24.19.0/node_modules/corepack/dist/corepack.js'
    )
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
