import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  adoptLegacyInstall,
  decideAfterRollback,
  decideSwitchFailure,
  disposeSeedFailure,
  envWithoutNpmConfig,
  isBakeElapsed,
  isHttpHealthyResponse,
  isSafeVersion,
  isStagingDirName,
  parseCurrentPointer,
  npmDistTagsPath,
  parseLatestTag,
  parsePending,
  parseProfileBundles,
  parseSeededPlugins,
  pluginInstallEnv,
  pointerAfterRollback,
  pointerAfterSuccessfulSwitch,
  readCurrentPointer,
  reconcilePending,
  reconcileRejected,
  rememberFirstSeen,
  replaceFileViaRotate,
  resolveBinRelative,
  resolveInstallRoot,
  resolvePointerRecovery,
  shouldAutoApplyOnLaunch,
  shouldRemoveLegacyTree,
  shouldRollback,
  shouldSeedBundledPlugin,
  shouldSkipRejected,
  staleVersionDirs,
  stagingDirName,
  UPDATE_BAKE_MS,
  versionRelativePath,
  versionsDiffer,
  writeCurrentPointer,
  type CurrentPointer
} from './dsh'

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

describe('parseLatestTag', () => {
  it('returns only the latest tag, never next or a semver-max of all tags', () => {
    expect(
      parseLatestTag(
        JSON.stringify({ latest: '0.1.0-rc.7', next: '0.1.0-rc.8', beta: '1.0.0' })
      )
    ).toBe('0.1.0-rc.7')
  })

  it('throws when latest is missing or not a string', () => {
    expect(() => parseLatestTag('{"next":"1.0.0"}')).toThrow()
    expect(() => parseLatestTag('{"latest":1}')).toThrow()
    expect(() => parseLatestTag('not-json')).toThrow()
  })
})

describe('versionsDiffer', () => {
  it('treats any inequality as an update candidate, including a registry downgrade', () => {
    expect(versionsDiffer('0.1.0-rc.7', '0.1.0-rc.8')).toBe(true)
    expect(versionsDiffer('1.0.0', '0.9.0')).toBe(true)
    expect(versionsDiffer('0.1.0-rc.7', '0.1.0-rc.7')).toBe(false)
  })
})

describe('first-seen bake clock', () => {
  it('does not reset firstSeen when the same version is seen again', () => {
    const first = rememberFirstSeen({}, '0.1.0-rc.8', 1_000)
    expect(first['0.1.0-rc.8']).toBe(1_000)
    expect(rememberFirstSeen(first, '0.1.0-rc.8', 9_000)).toEqual(first)
  })

  it('tracks a new version on its own clock', () => {
    const seen = rememberFirstSeen({ '0.1.0-rc.7': 1_000 }, '0.1.0-rc.8', 2_000)
    expect(seen['0.1.0-rc.7']).toBe(1_000)
    expect(seen['0.1.0-rc.8']).toBe(2_000)
  })

  it('installs only after two hours have elapsed', () => {
    const seenAt = 10_000
    expect(isBakeElapsed(seenAt, seenAt + UPDATE_BAKE_MS - 1)).toBe(false)
    expect(isBakeElapsed(seenAt, seenAt + UPDATE_BAKE_MS)).toBe(true)
    expect(UPDATE_BAKE_MS).toBe(2 * 60 * 60 * 1000)
  })
})

describe('staging directory names', () => {
  it('names the in-progress dir with a .partial suffix and rejects it as a final tree', () => {
    expect(stagingDirName('0.1.0-rc.7')).toBe('0.1.0-rc.7.partial')
    expect(isStagingDirName('0.1.0-rc.7.partial')).toBe(true)
    expect(isStagingDirName('0.1.0-rc.7')).toBe(false)
  })

  it('treats leftover .partial names as cleanup targets and keeps final version dirs', () => {
    const pointer: CurrentPointer = {
      version: '0.1.0-rc.7',
      path: 'versions/0.1.0-rc.7',
      previous: { version: '0.1.0-rc.6', path: 'versions/0.1.0-rc.6' }
    }
    const names = ['0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8', '0.1.0-rc.8.partial', '0.1.0-rc.5']
    expect(staleVersionDirs(names, pointer)).toEqual(['0.1.0-rc.8', '0.1.0-rc.8.partial', '0.1.0-rc.5'])
  })

  it('rejects version strings that cannot be a single path segment', () => {
    expect(isSafeVersion('0.1.0-rc.7')).toBe(true)
    expect(isSafeVersion('1.2.3+build.4')).toBe(true)
    expect(isSafeVersion('../etc')).toBe(false)
    expect(isSafeVersion('1/2')).toBe(false)
    expect(isSafeVersion('1\\2')).toBe(false)
    expect(isSafeVersion('')).toBe(false)
    expect(isSafeVersion('.')).toBe(false)
    expect(isSafeVersion('..')).toBe(false)
    expect(isSafeVersion('1.0.0.partial')).toBe(false)
    expect(isSafeVersion('1.0.0.')).toBe(false)
    expect(isSafeVersion('CON')).toBe(false)
    expect(isSafeVersion('com1')).toBe(false)
    expect(isSafeVersion('installed')).toBe(false)
  })
})

describe('current.json pointer', () => {
  it('parses version, relative path, and optional previous', () => {
    const parsed = parseCurrentPointer(
      JSON.stringify({
        version: '0.1.0-rc.8',
        path: 'versions/0.1.0-rc.8',
        previous: { version: '0.1.0-rc.7', path: '.' }
      })
    )
    expect(parsed).toEqual({
      version: '0.1.0-rc.8',
      path: 'versions/0.1.0-rc.8',
      previous: { version: '0.1.0-rc.7', path: '.' }
    })
  })

  it('returns null for corrupt or incomplete JSON rather than throwing', () => {
    expect(parseCurrentPointer('not json')).toBeNull()
    expect(parseCurrentPointer('{"version":"1.0.0"}')).toBeNull()
    expect(parseCurrentPointer('{"version":"1.0.0","path":"../escape"}')).toBeNull()
  })

  it('resolves stored paths with join and maps "." to the dsh root', () => {
    expect(versionRelativePath('0.1.0-rc.7')).toBe('versions/0.1.0-rc.7')
    const root = join(tmpdir(), 'aim-dsh-root')
    expect(resolveInstallRoot(root, { version: '1.0.0', path: '.' })).toBe(root)
    expect(resolveInstallRoot(root, { version: '1.0.0', path: 'versions/1.0.0' })).toBe(
      join(root, 'versions', '1.0.0')
    )
  })
})

describe('current.json read/write and legacy adopt', () => {
  let dir = ''

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = ''
  })

  it('writes via a temp file then rename, and reads the same pointer back', async () => {
    dir = await mkdtemp(join(tmpdir(), 'aim-dsh-ptr-'))
    const pointer: CurrentPointer = {
      version: '0.1.0-rc.7',
      path: 'versions/0.1.0-rc.7'
    }
    await writeCurrentPointer(dir, pointer)
    expect(await readCurrentPointer(dir)).toEqual(pointer)
    await expect(readFile(join(dir, 'current.json.tmp'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('replaces an existing pointer atomically on a second write', async () => {
    dir = await mkdtemp(join(tmpdir(), 'aim-dsh-ptr-'))
    await writeCurrentPointer(dir, { version: '1.0.0', path: 'versions/1.0.0' })
    await writeCurrentPointer(dir, { version: '2.0.0', path: 'versions/2.0.0' })
    expect(await readCurrentPointer(dir)).toEqual({ version: '2.0.0', path: 'versions/2.0.0' })
  })

  it('adopts a flat node_modules install as current without deleting it', async () => {
    dir = await mkdtemp(join(tmpdir(), 'aim-dsh-mig-'))
    const pkgDir = join(dir, 'node_modules', '@deepseek-ai', 'dsh')
    await mkdir(pkgDir, { recursive: true })
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0-rc.7' }))
    const pointer = await adoptLegacyInstall(dir)
    expect(pointer).toEqual({ version: '0.1.0-rc.7', path: '.' })
    expect(await readCurrentPointer(dir)).toEqual(pointer)
    expect(JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8')).version).toBe('0.1.0-rc.7')
  })

  it('leaves an existing pointer untouched when its target and a legacy tree are both present', async () => {
    dir = await mkdtemp(join(tmpdir(), 'aim-dsh-mig-'))
    const legacyPkg = join(dir, 'node_modules', '@deepseek-ai', 'dsh')
    const versionPkg = join(dir, 'versions', '0.1.0-rc.7', 'node_modules', '@deepseek-ai', 'dsh')
    await mkdir(legacyPkg, { recursive: true })
    await mkdir(versionPkg, { recursive: true })
    await writeFile(join(legacyPkg, 'package.json'), JSON.stringify({ version: '0.0.1' }))
    await writeFile(join(versionPkg, 'package.json'), JSON.stringify({ version: '0.1.0-rc.7' }))
    await writeCurrentPointer(dir, { version: '0.1.0-rc.7', path: 'versions/0.1.0-rc.7' })
    expect(await adoptLegacyInstall(dir)).toEqual({
      version: '0.1.0-rc.7',
      path: 'versions/0.1.0-rc.7'
    })
  })

  it('recovers a missing pointer target via previous, then a version dir, then the legacy tree', async () => {
    dir = await mkdtemp(join(tmpdir(), 'aim-dsh-mig-'))
    const legacyPkg = join(dir, 'node_modules', '@deepseek-ai', 'dsh')
    await mkdir(legacyPkg, { recursive: true })
    await writeFile(join(legacyPkg, 'package.json'), JSON.stringify({ version: '0.1.0-rc.7' }))
    await writeCurrentPointer(dir, { version: '0.1.0-rc.9', path: 'versions/0.1.0-rc.9' })
    expect(await adoptLegacyInstall(dir)).toEqual({ version: '0.1.0-rc.7', path: '.' })
  })

  it('returns null when there is no pointer and no legacy install', async () => {
    dir = await mkdtemp(join(tmpdir(), 'aim-dsh-mig-'))
    expect(await adoptLegacyInstall(dir)).toBeNull()
  })
})

describe('rollback and retention', () => {
  it('rolls back only when the health probe failed', () => {
    expect(shouldRollback(true)).toBe(false)
    expect(shouldRollback(false)).toBe(true)
  })

  it('keeps the outgoing version as previous after a successful switch', () => {
    const current: CurrentPointer = { version: '0.1.0-rc.7', path: '.' }
    expect(
      pointerAfterSuccessfulSwitch(current, { version: '0.1.0-rc.8', path: 'versions/0.1.0-rc.8' })
    ).toEqual({
      version: '0.1.0-rc.8',
      path: 'versions/0.1.0-rc.8',
      previous: { version: '0.1.0-rc.7', path: '.' }
    })
  })

  it('restores previous and drops the failed version from the pointer', () => {
    const switched: CurrentPointer = {
      version: '0.1.0-rc.8',
      path: 'versions/0.1.0-rc.8',
      previous: { version: '0.1.0-rc.7', path: '.' }
    }
    expect(pointerAfterRollback(switched)).toEqual({ version: '0.1.0-rc.7', path: '.' })
    expect(pointerAfterRollback({ version: '1.0.0', path: 'versions/1.0.0' })).toBeNull()
  })

  it('removes the legacy tree only once it is neither current nor previous', () => {
    expect(
      shouldRemoveLegacyTree({
        version: '0.1.0-rc.8',
        path: 'versions/0.1.0-rc.8',
        previous: { version: '0.1.0-rc.7', path: '.' }
      })
    ).toBe(false)
    expect(
      shouldRemoveLegacyTree({
        version: '0.1.0-rc.9',
        path: 'versions/0.1.0-rc.9',
        previous: { version: '0.1.0-rc.8', path: 'versions/0.1.0-rc.8' }
      })
    ).toBe(true)
  })
})

describe('pending and rejected reconciliation', () => {
  it('keeps pending only while it still matches latest and latest differs from current', () => {
    const pending = { version: '0.1.0-rc.8', registry: 'https://registry.npmjs.org' }
    expect(reconcilePending({ pending, current: '0.1.0-rc.7', latest: '0.1.0-rc.8' })).toEqual({
      pending,
      discard: false
    })
    expect(reconcilePending({ pending, current: '0.1.0-rc.7', latest: '0.1.0-rc.9' })).toEqual({
      pending: null,
      discard: true
    })
    expect(reconcilePending({ pending, current: '0.1.0-rc.8', latest: '0.1.0-rc.8' })).toEqual({
      pending: null,
      discard: true
    })
  })

  it('parses pending.json and rejects a missing or unsafe version', () => {
    expect(parsePending(JSON.stringify({ version: '0.1.0-rc.8', registry: 'https://example' }))).toEqual({
      version: '0.1.0-rc.8',
      registry: 'https://example'
    })
    expect(parsePending('{"version":"../x"}')).toBeNull()
    expect(parsePending('not-json')).toBeNull()
  })

  it('drops rejected versions once latest moves on, and skips a still-current reject', () => {
    expect(reconcileRejected(['0.1.0-rc.8', '0.1.0-rc.7'], '0.1.0-rc.9')).toEqual([])
    expect(reconcileRejected(['0.1.0-rc.8'], '0.1.0-rc.8')).toEqual(['0.1.0-rc.8'])
    expect(shouldSkipRejected('0.1.0-rc.8', ['0.1.0-rc.8'])).toBe(true)
    expect(shouldSkipRejected('0.1.0-rc.9', ['0.1.0-rc.8'])).toBe(false)
  })
})

describe('switch transaction decisions', () => {
  it('aborts before writing the pointer when preflight fails or the port stays busy', () => {
    expect(decideSwitchFailure({ at: 'preflight' })).toEqual({
      action: 'abort',
      restartOld: false,
      keepPending: false,
      rejectVersion: true,
      emit: 'gone'
    })
    expect(decideSwitchFailure({ at: 'port-busy' })).toEqual({
      action: 'abort',
      restartOld: true,
      keepPending: true,
      rejectVersion: false,
      emit: 'ready'
    })
  })

  it('rolls back after a written pointer when probe fails or a later step throws', () => {
    expect(decideSwitchFailure({ at: 'probe' })).toEqual({
      action: 'rollback',
      verifyOld: true,
      rejectVersion: true
    })
    expect(decideSwitchFailure({ at: 'thrown', pointerWritten: true })).toEqual({
      action: 'restore-pointer-and-old',
      verifyOld: true,
      rejectVersion: false
    })
    expect(decideSwitchFailure({ at: 'thrown', pointerWritten: false })).toEqual({
      action: 'abort',
      restartOld: true,
      keepPending: true,
      rejectVersion: false,
      emit: 'ready'
    })
  })

  it('keeps an explicit fault when the previous version does not come back healthy', () => {
    expect(decideAfterRollback(true)).toEqual({ emit: 'gone', keepPending: false, fault: false })
    expect(decideAfterRollback(false)).toEqual({ emit: 'fault', keepPending: false, fault: true })
  })

  it('treats only 2xx as a healthy HTTP probe', () => {
    expect(isHttpHealthyResponse(200)).toBe(true)
    expect(isHttpHealthyResponse(204)).toBe(true)
    expect(isHttpHealthyResponse(404)).toBe(false)
    expect(isHttpHealthyResponse(500)).toBe(false)
  })
})

describe('pointer recovery order', () => {
  it('prefers the current target, then previous, then a version dir, then the legacy tree', () => {
    const pointer: CurrentPointer = {
      version: '0.1.0-rc.8',
      path: 'versions/0.1.0-rc.8',
      previous: { version: '0.1.0-rc.7', path: 'versions/0.1.0-rc.7' }
    }
    expect(
      resolvePointerRecovery({
        pointer,
        currentExists: true,
        previousExists: true,
        existingVersionDirs: ['0.1.0-rc.6'],
        legacyVersion: '0.1.0-rc.5'
      })
    ).toEqual(pointer)
    expect(
      resolvePointerRecovery({
        pointer,
        currentExists: false,
        previousExists: true,
        existingVersionDirs: ['0.1.0-rc.6'],
        legacyVersion: '0.1.0-rc.5'
      })
    ).toEqual({ version: '0.1.0-rc.7', path: 'versions/0.1.0-rc.7' })
    expect(
      resolvePointerRecovery({
        pointer,
        currentExists: false,
        previousExists: false,
        existingVersionDirs: ['0.1.0-rc.6'],
        legacyVersion: '0.1.0-rc.5'
      })
    ).toEqual({ version: '0.1.0-rc.6', path: 'versions/0.1.0-rc.6' })
    expect(
      resolvePointerRecovery({
        pointer: null,
        currentExists: false,
        previousExists: false,
        existingVersionDirs: [],
        legacyVersion: '0.1.0-rc.5'
      })
    ).toEqual({ version: '0.1.0-rc.5', path: '.' })
    expect(
      resolvePointerRecovery({
        pointer: null,
        currentExists: false,
        previousExists: false,
        existingVersionDirs: [],
        legacyVersion: null
      })
    ).toBeNull()
  })
})

describe('cold-start eligibility', () => {
  it('auto-applies only on a cold start with a free port', () => {
    expect(shouldAutoApplyOnLaunch(true, true)).toBe(true)
    expect(shouldAutoApplyOnLaunch(true, false)).toBe(false)
    expect(shouldAutoApplyOnLaunch(false, true)).toBe(false)
    expect(shouldAutoApplyOnLaunch(false, false)).toBe(false)
  })
})

describe('shouldSeedBundledPlugin', () => {
  it('seeds when the profile does not exist yet', () => {
    expect(
      shouldSeedBundledPlugin({
        bundles: null,
        packagePresent: false,
        packageName: 'dshmarket',
        alreadySeeded: false
      })
    ).toBe(true)
  })

  it('seeds a named plugin that is not in the bundle list', () => {
    expect(
      shouldSeedBundledPlugin({
        bundles: ['@liustack/modlens'],
        packagePresent: false,
        packageName: 'dshmarket',
        alreadySeeded: false
      })
    ).toBe(true)
  })

  it('skips when the plugin is already a bundle and the package is on disk', () => {
    expect(
      shouldSeedBundledPlugin({
        bundles: ['@liustack/modlens', 'dshmarket'],
        packagePresent: true,
        packageName: 'dshmarket',
        alreadySeeded: false
      })
    ).toBe(false)
  })

  it('skips when listed in bundles even if the package files are gone', () => {
    expect(
      shouldSeedBundledPlugin({
        bundles: ['dshmarket'],
        packagePresent: false,
        packageName: 'dshmarket',
        alreadySeeded: false
      })
    ).toBe(false)
  })

  it('does not overwrite a package that is on disk but not in the bundle list', () => {
    expect(
      shouldSeedBundledPlugin({
        bundles: ['@liustack/modlens'],
        packagePresent: true,
        packageName: 'dshmarket',
        alreadySeeded: false
      })
    ).toBe(false)
  })

  it('skips after a successful seed even if the user later removes the package', () => {
    expect(
      shouldSeedBundledPlugin({
        bundles: null,
        packagePresent: false,
        packageName: 'dshmarket',
        alreadySeeded: true
      })
    ).toBe(false)
  })
})

describe('disposeSeedFailure', () => {
  it('never blocks launch and keeps the user-facing warning in Chinese', () => {
    expect(disposeSeedFailure('dshmarket')).toEqual({
      blockLaunch: false,
      warn: '插件 dshmarket 安装失败,将在下次启动时重试'
    })
    expect(disposeSeedFailure(null)).toEqual({
      blockLaunch: false,
      warn: '插件安装器准备失败,已跳过预装'
    })
  })
})

describe('pluginInstallEnv', () => {
  it('drops leaked npm_config_* and pins registry plus private pnpm dirs', () => {
    const env = pluginInstallEnv(
      {
        PATH: '/usr/bin',
        npm_config_registry: 'https://example.invalid',
        NPM_CONFIG_CACHE: '/tmp/leaked',
        PNPM_CONFIG_REGISTRY: 'https://leaked.invalid',
        HOME: '/Users/leon'
      },
      {
        path: '/private/node/bin:/usr/bin',
        registry: 'https://registry.npmmirror.com',
        corepackHome: '/private/corepack',
        storeDir: '/private/pnpm-store',
        cacheDir: '/private/pnpm-cache'
      }
    )
    expect(env.npm_config_registry).toBe('https://registry.npmmirror.com')
    expect(env.pnpm_config_registry).toBe('https://registry.npmmirror.com')
    expect(env.COREPACK_NPM_REGISTRY).toBe('https://registry.npmmirror.com')
    expect(env.COREPACK_HOME).toBe('/private/corepack')
    expect(env.COREPACK_ENABLE_DOWNLOAD_PROMPT).toBe('0')
    expect(env.npm_config_store_dir).toBe('/private/pnpm-store')
    expect(env.npm_config_cache).toBe('/private/pnpm-cache')
    expect(env.pnpm_config_store_dir).toBe('/private/pnpm-store')
    expect(env.pnpm_config_cache_dir).toBe('/private/pnpm-cache')
    expect(env.PATH).toBe('/private/node/bin:/usr/bin')
    expect(env.HOME).toBe('/Users/leon')
    expect(env.NPM_CONFIG_CACHE).toBeUndefined()
    expect(env.PNPM_CONFIG_REGISTRY).toBeUndefined()
  })
})

describe('parseProfileBundles', () => {
  it('reads bare package names from a real dsh web profile package.json', () => {
    expect(
      parseProfileBundles(
        JSON.stringify({
          name: 'dsh-profile-web',
          private: true,
          dsh: {
            profile: {
              bundles: [
                '@deepseek-ai/dsh-base',
                '@deepseek-ai/dsh-web-app',
                '@liustack/modlens',
                '@liustack/modsearch',
                'dshmarket'
              ]
            }
          },
          dependencies: {
            '@liustack/modlens': '1.2.3',
            '@liustack/modsearch': '1.2.3',
            dshmarket: '^1.16.2'
          }
        })
      )
    ).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@liustack/modlens',
      '@liustack/modsearch',
      'dshmarket'
    ])
  })

  it('returns an empty list for a profile with no bundles field', () => {
    expect(parseProfileBundles('{"name":"dsh-profile-web"}')).toEqual([])
  })

  it('returns null for unreadable JSON', () => {
    expect(parseProfileBundles('not-json')).toBeNull()
  })
})

describe('parseSeededPlugins', () => {
  it('reads the per-package marker list', () => {
    expect(parseSeededPlugins('{"packages":["dshmarket","@liustack/modlens"]}')).toEqual([
      'dshmarket',
      '@liustack/modlens'
    ])
  })

  it('returns an empty list for a corrupt marker file', () => {
    expect(parseSeededPlugins('not-json')).toEqual([])
    expect(parseSeededPlugins('{"packages":[1,""]}')).toEqual([])
  })
})

describe('npmDistTagsPath', () => {
  it('encodes a scoped package and leaves an unscoped name alone', () => {
    expect(npmDistTagsPath('@liustack/modlens')).toBe('/-/package/@liustack%2Fmodlens/dist-tags')
    expect(npmDistTagsPath('dshmarket')).toBe('/-/package/dshmarket/dist-tags')
  })
})

describe('atomic pointer replace without deleting dest', () => {
  let dir = ''

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = ''
  })

  it('rotates dest aside and back so a failed second rename would still restore the old file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'aim-dsh-rot-'))
    const dest = join(dir, 'current.json')
    const tmp = join(dir, 'current.json.tmp')
    await writeFile(dest, 'old-pointer')
    await writeFile(tmp, 'new-pointer')
    await replaceFileViaRotate(tmp, dest)
    expect(await readFile(dest, 'utf8')).toBe('new-pointer')
    await expect(readFile(`${dest}.bak`)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(tmp)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
