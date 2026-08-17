import { describe, expect, it } from 'vitest'
import { resolveBinRelative } from './dsh'

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
