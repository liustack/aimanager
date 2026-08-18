import { describe, expect, it } from 'vitest'
import { envWithoutNpmConfig, resolveBinRelative } from './dsh'

describe('resolveBinRelative', () => {
  it('accepts a plain string bin', () => {
    expect(resolveBinRelative({ bin: 'dist/cli.js' })).toBe('dist/cli.js')
  })

  it('prefers the dsh key in a bin map', () => {
    expect(resolveBinRelative({ bin: { other: 'a.js', dsh: 'bin/dsh.js' } })).toBe('bin/dsh.js')
  })

  it('falls back to the first entry when no dsh key exists', () => {
    expect(resolveBinRelative({ bin: { anything: 'main.js' } })).toBe('main.js')
  })

  it('throws when the package declares no bin', () => {
    expect(() => resolveBinRelative({})).toThrow()
    expect(() => resolveBinRelative({ bin: {} })).toThrow()
  })
})

describe('envWithoutNpmConfig', () => {
  it('drops npm_config_* keys case-insensitively and keeps proxy/path vars', () => {
    const cleaned = envWithoutNpmConfig({
      PATH: '/bin',
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: 'localhost',
      NODE_USE_ENV_PROXY: '1',
      npm_config_devdir: '/tmp/devdir',
      NPM_CONFIG_CACHE: '/tmp/npm',
      Npm_Config_Registry: 'https://example.invalid',
      HOME: '/Users/leon'
    })
    expect(cleaned).toEqual({
      PATH: '/bin',
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: 'localhost',
      NODE_USE_ENV_PROXY: '1',
      HOME: '/Users/leon'
    })
  })
})
