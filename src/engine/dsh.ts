// dsh domain: installs and supervises DeepSeek Harness. Its web UI is served
// locally and rendered inside an aimanager window; the user never sees npm,
// npx, or a port number.
//
// State intentionally stays in dsh's own default home (~/.dsh), shared with
// any copy the user runs by hand — online tutorials about dsh configuration
// must keep working against the managed instance. See decisions.md.
//
// Install layout is versioned under apps/dsh/versions/<ver>/ with current.json
// as the pointer. A leftover flat apps/dsh/node_modules tree is adopted in
// place, never reinstalled.
//
// First-run also seeds the official web-profile plugins (modlens, modsearch,
// dshmarket) via `dsh plugin add`, using the private Node and a corepack pnpm.
// An already-present package, including a local link, is left untouched.
// A successful seed is remembered under ~/.aimanager so a later uninstall
// is not put back. Seeding is best-effort: failure never blocks dsh itself.

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  baseDir,
  ensureNode,
  ensurePnpm,
  exists,
  installedNode,
  nodeExe,
  npmCli,
  run,
  runtimePath,
  type NodeRuntime
} from './runtime'
import { npmRegistries, officialNpmRegistry, recordSourceWin } from './sources'

const dshDir = join(baseDir, 'apps', 'dsh')
const dshPackage = '@deepseek-ai/dsh'
const currentFile = 'current.json'
const pendingFile = 'pending.json'
const stateFile = 'update-state.json'
const legacySeenFile = 'seen.json'
const WEB_PROFILE = 'web'
const BUNDLED_WEB_PLUGINS = ['@liustack/modlens', '@liustack/modsearch', 'dshmarket'] as const
const seededPluginsFile = 'seeded-web-plugins.json'

// Dedicated port for the aimanager-managed instance. dsh defaults to 3080,
// which a user-run copy may already occupy; a fixed private port keeps the
// two from colliding or impersonating each other.
const dshPort = 34517
export const dshUrl = `http://127.0.0.1:${dshPort}`

export const UPDATE_BAKE_MS = 2 * 60 * 60 * 1000
const CHECK_FIRST_DELAY_MS = 60_000
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const PREFLIGHT_MS = 10_000
const PORT_RELEASE_MS = 15_000
const SERVE_WAIT_MS = 180_000

const NPM_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

const APPLY_MSG = {
  applied: '已启用新版本',
  preflight: '新版本无法启动',
  portBusy: '端口未释放,请稍后重试',
  rolledBack: '新版本启动失败,已恢复上一版',
  fault: '切换失败,未能恢复上一版',
  failed: '切换失败,请稍后重试'
} as const

export interface VersionRef {
  version: string
  path: string
}

export interface CurrentPointer {
  version: string
  path: string
  previous?: VersionRef
}

export interface PendingRecord {
  version: string
  registry: string
}

export interface UpdateState {
  seen: Record<string, number>
  rejected: string[]
}

export interface ApplyResult {
  applied: boolean
  pending: string | null
  message?: string
}

export type SwitchFailure =
  | { at: 'preflight' }
  | { at: 'port-busy' }
  | { at: 'probe' }
  | { at: 'thrown'; pointerWritten: boolean }

export type SwitchRecovery =
  | {
      action: 'abort'
      restartOld: boolean
      keepPending: boolean
      rejectVersion: boolean
      emit: 'ready' | 'gone'
    }
  | { action: 'rollback'; verifyOld: true; rejectVersion: boolean }
  | { action: 'restore-pointer-and-old'; verifyOld: true; rejectVersion: boolean }

let child: ChildProcess | null = null
let lastStderr = ''
let updateLock: Promise<void> = Promise.resolve()
let coldStartEligible = true
let onUpdateReady: ((version: string) => void) | null = null
let onUpdateGone: (() => void) | null = null
let onViewReload: (() => void) | null = null

export function dshRunning(): boolean {
  return child !== null && child.exitCode === null
}

export function envWithoutNpmConfig(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cleaned: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase().startsWith('npm_config_')) continue
    cleaned[key] = value
  }
  return cleaned
}

export function pluginInstallEnv(
  baseEnv: NodeJS.ProcessEnv,
  input: {
    path: string
    registry: string
    corepackHome: string
    storeDir: string
    cacheDir: string
  }
): NodeJS.ProcessEnv {
  // pnpm 11+ ignores npm_config_*. Set both so registry and store stay pinned
  // regardless of which pnpm corepack materializes.
  const cleaned = envWithoutNpmConfig(baseEnv)
  for (const key of Object.keys(cleaned)) {
    if (key.toLowerCase().startsWith('pnpm_config_')) delete cleaned[key]
  }
  return {
    ...cleaned,
    PATH: input.path,
    COREPACK_NPM_REGISTRY: input.registry,
    COREPACK_HOME: input.corepackHome,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    npm_config_registry: input.registry,
    npm_config_store_dir: input.storeDir,
    npm_config_cache: input.cacheDir,
    pnpm_config_registry: input.registry,
    pnpm_config_store_dir: input.storeDir,
    pnpm_config_cache_dir: input.cacheDir
  }
}

export function resolveBinRelative(pkg: { bin?: string | Record<string, string> }): string {
  const rel =
    typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin?.dsh ?? Object.values(pkg.bin ?? {})[0])
  if (!rel) throw new Error('dsh 包未声明可执行入口')
  return rel
}

export function npmDistTagsPath(packageName: string): string {
  return `/-/package/${packageName.replace('/', '%2F')}/dist-tags`
}

export function parseProfileBundles(raw: string): string[] | null {
  try {
    const data = JSON.parse(raw) as { dsh?: { profile?: { bundles?: unknown } } }
    const bundles = data.dsh?.profile?.bundles
    if (!Array.isArray(bundles)) return []
    return bundles.filter((item): item is string => typeof item === 'string')
  } catch {
    return null
  }
}

export function shouldSeedBundledPlugin(input: {
  bundles: string[] | null
  packagePresent: boolean
  packageName: string
  alreadySeeded: boolean
}): boolean {
  if (input.alreadySeeded) return false
  if (input.packagePresent) return false
  if (input.bundles?.includes(input.packageName)) return false
  return true
}

/** Plugin seeding never blocks dsh install or launch. */
export function disposeSeedFailure(packageName: string | null): {
  blockLaunch: boolean
  warn: string
} {
  return {
    blockLaunch: false,
    warn:
      packageName === null
        ? '插件安装器准备失败,已跳过预装'
        : `插件 ${packageName} 安装失败,将在下次启动时重试`
  }
}

export function parseSeededPlugins(raw: string): string[] {
  try {
    const data = JSON.parse(raw) as unknown
    if (!data || typeof data !== 'object' || Array.isArray(data)) return []
    const packages = (data as { packages?: unknown }).packages
    if (!Array.isArray(packages)) return []
    return packages.filter((item): item is string => typeof item === 'string' && item.length > 0)
  } catch {
    return []
  }
}

export function parseLatestTag(body: string): string {
  const data = JSON.parse(body) as { latest?: unknown }
  if (typeof data.latest !== 'string' || data.latest.length === 0) {
    throw new Error('dist-tags missing latest')
  }
  return data.latest
}

export function versionsDiffer(current: string, latest: string): boolean {
  return current !== latest
}

export function rememberFirstSeen(
  seen: Record<string, number>,
  version: string,
  now: number
): Record<string, number> {
  if (seen[version] !== undefined) return seen
  return { ...seen, [version]: now }
}

export function isBakeElapsed(firstSeenAt: number, now: number, bakeMs = UPDATE_BAKE_MS): boolean {
  return now - firstSeenAt >= bakeMs
}

export function stagingDirName(version: string): string {
  return `${version}.partial`
}

export function isStagingDirName(name: string): boolean {
  return name.endsWith('.partial')
}

export function isSafeVersion(version: string): boolean {
  if (!version || version.length >= 64) return false
  if (version.endsWith('.') || version.endsWith(' ') || version.endsWith('.partial')) return false
  if (WIN_RESERVED.test(version)) return false
  return NPM_SEMVER.test(version)
}

export function versionRelativePath(version: string): string {
  return `versions/${version}`
}

export function shouldRollback(probeSucceeded: boolean): boolean {
  return !probeSucceeded
}

export function pointerAfterSuccessfulSwitch(
  current: CurrentPointer,
  next: VersionRef
): CurrentPointer {
  return {
    version: next.version,
    path: next.path,
    previous: { version: current.version, path: current.path }
  }
}

export function pointerAfterRollback(current: CurrentPointer): CurrentPointer | null {
  if (!current.previous) return null
  return { version: current.previous.version, path: current.previous.path }
}

export function shouldRemoveLegacyTree(pointer: CurrentPointer): boolean {
  return pointer.path !== '.' && pointer.previous?.path !== '.'
}

export function shouldAutoApplyOnLaunch(eligible: boolean, portFree: boolean): boolean {
  return eligible && portFree
}

export function isHttpHealthyResponse(status: number): boolean {
  return status >= 200 && status < 300
}

export function reconcilePending(input: {
  pending: PendingRecord | null
  current: string
  latest: string
}): { pending: PendingRecord | null; discard: boolean } {
  if (!input.pending) return { pending: null, discard: false }
  if (input.latest === input.current || input.pending.version !== input.latest) {
    return { pending: null, discard: true }
  }
  return { pending: input.pending, discard: false }
}

export function parsePending(raw: string): PendingRecord | null {
  try {
    const data = JSON.parse(raw) as unknown
    if (!data || typeof data !== 'object') return null
    const rec = data as Record<string, unknown>
    if (typeof rec.version !== 'string' || !isSafeVersion(rec.version)) return null
    if (typeof rec.registry !== 'string' || rec.registry.length === 0) return null
    return { version: rec.version, registry: rec.registry }
  } catch {
    return null
  }
}

export function reconcileRejected(rejected: string[], latest: string): string[] {
  return rejected.filter((version) => version === latest)
}

export function shouldSkipRejected(version: string, rejected: string[]): boolean {
  return rejected.includes(version)
}

export function decideSwitchFailure(failure: SwitchFailure): SwitchRecovery {
  if (failure.at === 'preflight') {
    return { action: 'abort', restartOld: false, keepPending: false, rejectVersion: true, emit: 'gone' }
  }
  if (failure.at === 'port-busy') {
    return { action: 'abort', restartOld: true, keepPending: true, rejectVersion: false, emit: 'ready' }
  }
  if (failure.at === 'probe') {
    return { action: 'rollback', verifyOld: true, rejectVersion: true }
  }
  if (failure.pointerWritten) {
    return { action: 'restore-pointer-and-old', verifyOld: true, rejectVersion: false }
  }
  return { action: 'abort', restartOld: true, keepPending: true, rejectVersion: false, emit: 'ready' }
}

export function decideAfterRollback(
  oldHealthy: boolean
): { emit: 'gone' | 'fault'; keepPending: false; fault: boolean } {
  return oldHealthy
    ? { emit: 'gone', keepPending: false, fault: false }
    : { emit: 'fault', keepPending: false, fault: true }
}

export function resolvePointerRecovery(input: {
  pointer: CurrentPointer | null
  currentExists: boolean
  previousExists: boolean
  existingVersionDirs: string[]
  legacyVersion: string | null
}): CurrentPointer | null {
  if (input.pointer && input.currentExists) return input.pointer
  if (input.pointer?.previous && input.previousExists) {
    return { version: input.pointer.previous.version, path: input.pointer.previous.path }
  }
  const version = input.existingVersionDirs[0]
  if (version) return { version, path: versionRelativePath(version) }
  if (input.legacyVersion) return { version: input.legacyVersion, path: '.' }
  return null
}

function isSafeRelativePath(rel: string): boolean {
  if (rel === '.' || rel === '') return true
  const parts = rel.split(/[/\\]/).filter((part) => part !== '')
  if (parts.some((part) => part === '..' || part === '.')) return false
  return parts.length === 2 && parts[0] === 'versions' && isSafeVersion(parts[1])
}

function isVersionRef(value: unknown): value is VersionRef {
  if (!value || typeof value !== 'object') return false
  const rec = value as Record<string, unknown>
  return (
    typeof rec.version === 'string' &&
    isSafeVersion(rec.version) &&
    typeof rec.path === 'string' &&
    isSafeRelativePath(rec.path)
  )
}

export function parseCurrentPointer(raw: string): CurrentPointer | null {
  try {
    const data = JSON.parse(raw) as unknown
    if (!data || typeof data !== 'object') return null
    const rec = data as Record<string, unknown>
    if (typeof rec.version !== 'string' || typeof rec.path !== 'string') return null
    if (!isSafeVersion(rec.version) || !isSafeRelativePath(rec.path)) return null
    const pointer: CurrentPointer = { version: rec.version, path: rec.path }
    if (rec.previous !== undefined) {
      if (!isVersionRef(rec.previous)) return null
      pointer.previous = rec.previous
    }
    return pointer
  } catch {
    return null
  }
}

function versionNameFromPath(rel: string): string | null {
  if (rel === '.' || rel === '') return null
  const parts = rel.split(/[/\\]/).filter((part) => part !== '')
  if (parts[0] !== 'versions' || parts.length !== 2) return null
  return parts[1]
}

export function staleVersionDirs(dirNames: string[], pointer: CurrentPointer): string[] {
  const keep = new Set<string>()
  for (const ref of [pointer, pointer.previous]) {
    if (!ref) continue
    const name = versionNameFromPath(ref.path)
    if (name) keep.add(name)
  }
  return dirNames.filter((name) => !keep.has(name))
}

export function resolveInstallRoot(dshRoot: string, pointer: CurrentPointer): string {
  if (pointer.path === '.' || pointer.path === '') return dshRoot
  const parts = pointer.path.split(/[/\\]/).filter((part) => part && part !== '.')
  if (parts.some((part) => part === '..')) throw new Error('invalid path')
  return join(dshRoot, ...parts)
}

export async function replaceFileViaRotate(tmp: string, dest: string): Promise<void> {
  const bak = `${dest}.bak`
  await rm(bak, { force: true })
  try {
    await rename(dest, bak)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
  try {
    await rename(tmp, dest)
  } catch (err) {
    try {
      await rename(bak, dest)
    } catch {
      // dest is gone; bak restore failed. Leave bak for a later recovery attempt.
    }
    await rm(tmp, { force: true })
    throw err
  }
  await rm(bak, { force: true })
}

async function replaceFileAtomically(tmp: string, dest: string): Promise<void> {
  try {
    await rename(tmp, dest)
  } catch {
    await replaceFileViaRotate(tmp, dest)
  }
}

async function writeJsonAtomic(dir: string, file: string, value: unknown): Promise<void> {
  await mkdir(dir, { recursive: true })
  const dest = join(dir, file)
  const tmp = join(dir, `${file}.tmp`)
  await writeFile(tmp, JSON.stringify(value, null, 2))
  await replaceFileAtomically(tmp, dest)
}

export async function writeCurrentPointer(root: string, pointer: CurrentPointer): Promise<void> {
  await writeJsonAtomic(root, currentFile, pointer)
}

export async function readCurrentPointer(root: string): Promise<CurrentPointer | null> {
  try {
    return parseCurrentPointer(await readFile(join(root, currentFile), 'utf8'))
  } catch {
    return null
  }
}

function emptyState(): UpdateState {
  return { seen: {}, rejected: [] }
}

function parseSeenMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
  }
  return out
}

async function readUpdateState(root = dshDir): Promise<UpdateState> {
  try {
    const data = JSON.parse(await readFile(join(root, stateFile), 'utf8')) as unknown
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const rec = data as Record<string, unknown>
      if (rec.seen !== undefined || rec.rejected !== undefined) {
        return {
          seen: parseSeenMap(rec.seen),
          rejected: Array.isArray(rec.rejected)
            ? rec.rejected.filter((item): item is string => typeof item === 'string')
            : []
        }
      }
      return { seen: parseSeenMap(data), rejected: [] }
    }
  } catch {
    // fall through to the previous seen.json filename
  }
  try {
    return { seen: parseSeenMap(JSON.parse(await readFile(join(root, legacySeenFile), 'utf8'))), rejected: [] }
  } catch {
    return emptyState()
  }
}

async function writeUpdateState(root: string, state: UpdateState): Promise<void> {
  await writeJsonAtomic(root, stateFile, state)
}

async function readPendingRecord(root = dshDir): Promise<PendingRecord | null> {
  try {
    return parsePending(await readFile(join(root, pendingFile), 'utf8'))
  } catch {
    return null
  }
}

async function writePendingRecord(record: PendingRecord): Promise<void> {
  await writeJsonAtomic(dshDir, pendingFile, record)
}

async function clearPending(): Promise<void> {
  await rm(join(dshDir, pendingFile), { force: true })
}

function legacyPkgJson(root: string): string {
  return join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
}

function pkgDir(root: string, pointer: CurrentPointer): string {
  return join(resolveInstallRoot(root, pointer), 'node_modules', '@deepseek-ai', 'dsh')
}

async function pkgExists(root: string, pointer: CurrentPointer): Promise<boolean> {
  return exists(join(pkgDir(root, pointer), 'package.json'))
}

async function listCompleteVersionDirs(root: string): Promise<string[]> {
  const versionsDir = join(root, 'versions')
  if (!(await exists(versionsDir))) return []
  const names: string[] = []
  for (const name of await readdir(versionsDir)) {
    if (isStagingDirName(name) || !isSafeVersion(name)) continue
    if (await exists(join(versionsDir, name, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))) {
      names.push(name)
    }
  }
  return names
}

async function readLegacyVersion(root: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(legacyPkgJson(root), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' && isSafeVersion(pkg.version) ? pkg.version : null
  } catch {
    return null
  }
}

export async function adoptLegacyInstall(root: string): Promise<CurrentPointer | null> {
  const pointer = await readCurrentPointer(root)
  const currentExists = pointer ? await pkgExists(root, pointer) : false
  const previousExists =
    pointer?.previous !== undefined ? await pkgExists(root, { ...pointer.previous }) : false
  const recovered = resolvePointerRecovery({
    pointer,
    currentExists,
    previousExists,
    existingVersionDirs: await listCompleteVersionDirs(root),
    legacyVersion: await readLegacyVersion(root)
  })
  if (recovered && JSON.stringify(recovered) !== JSON.stringify(pointer)) {
    await writeCurrentPointer(root, recovered)
  }
  return recovered
}

export async function dshInstalled(): Promise<boolean> {
  const pointer = await adoptLegacyInstall(dshDir)
  if (pointer && (await pkgExists(dshDir, pointer))) return true
  return exists(legacyPkgJson(dshDir))
}

function withUpdateLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = updateLock.then(fn, fn)
  updateLock = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

function npmIsolation(): string[] {
  const npmCache = join(baseDir, 'runtime', 'npm-cache')
  const npmrc = join(baseDir, 'runtime', 'npmrc-isolated')
  return ['--cache', npmCache, '--userconfig', npmrc, '--fetch-retries=2', '--fetch-timeout=60000']
}

async function ensureNpmIsolationDirs(): Promise<void> {
  const npmCache = join(baseDir, 'runtime', 'npm-cache')
  const npmrc = join(baseDir, 'runtime', 'npmrc-isolated')
  await mkdir(npmCache, { recursive: true })
  if (!(await exists(npmrc))) await writeFile(npmrc, '')
}

function isOfficialNpmRegistry(registry: string): boolean {
  return registry.replace(/\/$/, '') === officialNpmRegistry()
}

// npm's own --fetch-timeout is per request: a route that trickles a few bytes
// every minute never trips it, so a crawling cross-border install would run
// forever without ever reaching the mirror. Cap the whole subprocess instead.
// installLatest exempts the last candidate because dsh itself must land no
// matter how slow the only remaining route is. Plugin seeding caps every
// candidate: it is best-effort, sits on the launch path, and retries next
// launch. Generous on purpose: a healthy route finishes well under this, and
// a capped user pays it once before source memory reorders the next attempt.
const INSTALL_CAP_MS = 10 * 60_000

async function runNpm(
  node: NodeRuntime,
  args: string[],
  cwd: string,
  timeoutMs?: number
): Promise<void> {
  await run(nodeExe(node), [npmCli(node), ...args], {
    cwd,
    env: { ...envWithoutNpmConfig(process.env), PATH: runtimePath(node) },
    timeoutMs
  })
}

async function fetchLatestTag(registry: string, packageName = dshPackage): Promise<string> {
  const url = `${registry.replace(/\/$/, '')}${npmDistTagsPath(packageName)}`
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return parseLatestTag(await res.text())
}

async function fetchLatestForPackage(packageName: string, registry: string): Promise<string> {
  const version = await fetchLatestTag(registry, packageName)
  if (!isSafeVersion(version)) {
    throw new Error(`invalid version from registry: ${version}`)
  }
  return version
}

// Mirrors dsh resolveDshHome: $DSH_HOME if set and non-empty, else ~/.dsh.
// A vendor change of that convention would silently miss the real profile.
function webProfileDir(): string {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'profiles', WEB_PROFILE)
}

async function bundledPluginPresent(packageName: string): Promise<boolean> {
  return exists(join(webProfileDir(), 'node_modules', ...packageName.split('/'), 'package.json'))
}

async function readWebProfileBundles(): Promise<string[] | null> {
  try {
    return parseProfileBundles(await readFile(join(webProfileDir(), 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

async function runDshCli(
  node: NodeRuntime,
  pointer: CurrentPointer,
  args: string[],
  opts: { timeoutMs?: number; registry: string }
): Promise<void> {
  const entry = await dshEntryFromPkg(pkgDir(dshDir, pointer))
  const corepackHome = join(baseDir, 'runtime', 'corepack')
  const storeDir = join(baseDir, 'runtime', 'pnpm-store')
  const cacheDir = join(baseDir, 'runtime', 'pnpm-cache')
  await mkdir(corepackHome, { recursive: true })
  await mkdir(storeDir, { recursive: true })
  await mkdir(cacheDir, { recursive: true })
  await run(nodeExe(node), [entry, ...args], {
    env: pluginInstallEnv(process.env, {
      path: runtimePath(node),
      registry: opts.registry,
      corepackHome,
      storeDir,
      cacheDir
    }),
    timeoutMs: opts.timeoutMs
  })
}

async function readSeededPluginNames(): Promise<Set<string>> {
  try {
    return new Set(parseSeededPlugins(await readFile(join(baseDir, seededPluginsFile), 'utf8')))
  } catch {
    return new Set()
  }
}

async function markPluginSeeded(name: string): Promise<void> {
  const names = [...(await readSeededPluginNames())]
  if (names.includes(name)) return
  names.push(name)
  names.sort()
  await writeJsonAtomic(baseDir, seededPluginsFile, { packages: names })
}

async function seedBundledPlugin(
  node: NodeRuntime,
  pointer: CurrentPointer,
  name: string
): Promise<void> {
  let lastError: unknown
  for (const registry of npmRegistries()) {
    try {
      const version = await fetchLatestForPackage(name, registry)
      // pnpm 11 loose mode auto-writes minimumReleaseAgeExclude into the
      // profile pnpm-workspace.yaml for a young pinned version. We accept
      // that vendor-dir write. Setting minimumReleaseAge ourselves would
      // flip strict mode on and abort a non-TTY install.
      await runDshCli(node, pointer, ['plugin', '--profile', WEB_PROFILE, 'add', `${name}@${version}`], {
        timeoutMs: INSTALL_CAP_MS,
        registry
      })
      recordSourceWin('npm-registry', registry)
      await markPluginSeeded(name)
      return
    } catch (err) {
      lastError = err
    }
  }
  throw lastError instanceof Error ? lastError : new Error('安装失败,请检查网络后重试')
}

async function ensureBundledPlugins(
  node: NodeRuntime,
  pointer: CurrentPointer,
  onStage: (stage: string) => void
): Promise<void> {
  const bundles = await readWebProfileBundles()
  const seeded = await readSeededPluginNames()
  const missing: string[] = []
  for (const name of BUNDLED_WEB_PLUGINS) {
    const present = await bundledPluginPresent(name)
    if (
      shouldSeedBundledPlugin({
        bundles,
        packagePresent: present,
        packageName: name,
        alreadySeeded: seeded.has(name)
      })
    ) {
      missing.push(name)
    }
  }
  if (missing.length === 0) return

  onStage('dsh-plugin')
  try {
    await ensurePnpm(node)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.warn(`[dsh-plugin] ${detail}`)
    const disposition = disposeSeedFailure(null)
    console.warn(disposition.warn)
    if (disposition.blockLaunch) throw err
    return
  }

  for (const name of missing) {
    try {
      await seedBundledPlugin(node, pointer, name)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      console.warn(`[dsh-plugin] ${detail}`)
      const disposition = disposeSeedFailure(name)
      console.warn(disposition.warn)
      if (disposition.blockLaunch) throw err
    }
  }
}

async function dshEntryFromPkg(pkgRoot: string): Promise<string> {
  const raw = await readFile(join(pkgRoot, 'package.json'), 'utf8')
  const pkg = JSON.parse(raw) as { bin?: string | Record<string, string> }
  return join(pkgRoot, resolveBinRelative(pkg))
}

async function preflightEntry(node: NodeRuntime, entry: string): Promise<boolean> {
  if (!(await exists(entry))) return false
  return new Promise((resolve) => {
    const probe = spawn(nodeExe(node), [entry, '--version'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true
    })
    const started = Date.now()
    const timer = setTimeout(() => {
      probe.kill('SIGTERM')
      resolve(true)
    }, PREFLIGHT_MS)
    probe.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    probe.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(true)
      else resolve(Date.now() - started > 400)
    })
  })
}

async function cleanStagingDirs(root = dshDir): Promise<void> {
  const versionsDir = join(root, 'versions')
  if (!(await exists(versionsDir))) return
  for (const name of await readdir(versionsDir)) {
    if (isStagingDirName(name)) {
      await rm(join(versionsDir, name), { recursive: true, force: true })
    }
  }
}

async function cleanupRetention(pointer: CurrentPointer): Promise<void> {
  const versionsDir = join(dshDir, 'versions')
  if (await exists(versionsDir)) {
    const names = await readdir(versionsDir)
    for (const name of staleVersionDirs(names, pointer)) {
      await rm(join(versionsDir, name), { recursive: true, force: true })
    }
  }
  if (shouldRemoveLegacyTree(pointer)) {
    await rm(join(dshDir, 'node_modules'), { recursive: true, force: true })
    await rm(join(dshDir, 'package.json'), { force: true })
  }
}

async function installPinnedVersion(
  node: NodeRuntime,
  version: string,
  registry: string,
  capMs?: number
): Promise<void> {
  if (!isSafeVersion(version)) throw new Error('invalid version')
  const versionsDir = join(dshDir, 'versions')
  const finalDir = join(versionsDir, version)
  const stagedPkg = join(finalDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  if (await exists(stagedPkg)) return
  if (await exists(finalDir)) await rm(finalDir, { recursive: true, force: true })

  const partialDir = join(versionsDir, stagingDirName(version))
  await rm(partialDir, { recursive: true, force: true })
  await mkdir(partialDir, { recursive: true })
  await writeFile(
    join(partialDir, 'package.json'),
    JSON.stringify({ name: 'aimanager-dsh', private: true, dependencies: { [dshPackage]: version } }, null, 2)
  )
  await ensureNpmIsolationDirs()
  try {
    await runNpm(
      node,
      ['install', `${dshPackage}@${version}`, '--no-fund', '--no-audit', ...npmIsolation(), '--registry', registry],
      partialDir,
      capMs
    )
    if (isOfficialNpmRegistry(registry)) {
      await runNpm(node, ['audit', 'signatures', ...npmIsolation(), '--registry', registry], partialDir, capMs)
    }
    await rename(partialDir, finalDir)
    recordSourceWin('npm-registry', registry)
  } catch (err) {
    await rm(partialDir, { recursive: true, force: true })
    throw err
  }
}

async function installLatest(node: NodeRuntime): Promise<CurrentPointer> {
  let lastError: unknown
  const registries = npmRegistries()
  for (let i = 0; i < registries.length; i++) {
    const registry = registries[i]
    const capMs = i < registries.length - 1 ? INSTALL_CAP_MS : undefined
    try {
      const version = await fetchLatestTag(registry)
      await installPinnedVersion(node, version, registry, capMs)
      const pointer: CurrentPointer = { version, path: versionRelativePath(version) }
      await writeCurrentPointer(dshDir, pointer)
      return pointer
    } catch (err) {
      lastError = err
    }
  }
  throw lastError instanceof Error ? lastError : new Error('安装失败,请检查网络后重试')
}

async function ensureDshLocked(node: NodeRuntime, onStage: (stage: string) => void): Promise<void> {
  await cleanStagingDirs()
  let pointer = await adoptLegacyInstall(dshDir)
  if (!pointer || !(await pkgExists(dshDir, pointer))) {
    onStage('dsh-install')
    pointer = await installLatest(node)
  }
  await ensureBundledPlugins(node, pointer, onStage)
}

export async function ensureDsh(onStage: (stage: string) => void): Promise<void> {
  const node = await ensureNode(onStage)
  await withUpdateLock(() => ensureDshLocked(node, onStage))
}

function portOccupied(port = dshPort): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const finish = (value: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(400, () => finish(false))
  })
}

async function httpHealthy(): Promise<boolean> {
  try {
    const res = await fetch(dshUrl, { signal: AbortSignal.timeout(1000) })
    return isHttpHealthyResponse(res.status)
  } catch {
    return false
  }
}

async function waitUntilPortFree(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await portOccupied())) return true
    await delay(200)
  }
  return !(await portOccupied())
}

async function waitUntilHealthy(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!dshRunning()) return false
    if (await httpHealthy()) return true
    await delay(500)
  }
  return dshRunning() && (await httpHealthy())
}

function killChild(): void {
  if (child && child.exitCode === null) child.kill('SIGTERM')
  child = null
}

async function startDshProcess(node: NodeRuntime, pointer: CurrentPointer): Promise<void> {
  lastStderr = ''
  const entry = await dshEntryFromPkg(pkgDir(dshDir, pointer))
  child = spawn(nodeExe(node), [entry, 'web', '--port', String(dshPort)], {
    cwd: resolveInstallRoot(dshDir, pointer),
    env: { ...process.env, PATH: runtimePath(node) },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    lastStderr = (lastStderr + String(chunk)).slice(-1000)
  })
}

function launchFailure(exited: boolean): Error {
  if (exited) {
    const detail = lastStderr.trim()
    return new Error(`应用意外退出${detail ? `:${detail.slice(-300)}` : ''}`)
  }
  return new Error('启动超时,请重试')
}

async function stagedPkgExists(version: string): Promise<boolean> {
  return exists(join(dshDir, 'versions', version, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
}

export async function pendingUpdateVersion(): Promise<string | null> {
  const pending = await readPendingRecord()
  if (!pending) return null
  if (!(await stagedPkgExists(pending.version))) return null
  return pending.version
}

async function discardStagedVersion(version: string, pointer: CurrentPointer): Promise<void> {
  const keep = new Set(
    [pointer, pointer.previous]
      .flatMap((ref) => (ref ? [versionNameFromPath(ref.path)] : []))
      .filter((name): name is string => Boolean(name))
  )
  if (keep.has(version)) return
  await rm(join(dshDir, 'versions', version), { recursive: true, force: true })
}

async function markRejected(version: string): Promise<void> {
  const state = await readUpdateState()
  if (!state.rejected.includes(version)) state.rejected.push(version)
  await writeUpdateState(dshDir, state)
}

async function restartAndVerify(node: NodeRuntime, pointer: CurrentPointer): Promise<boolean> {
  try {
    killChild()
    await startDshProcess(node, pointer)
    return await waitUntilHealthy(SERVE_WAIT_MS)
  } catch {
    return false
  }
}

async function finishAbort(
  decision: SwitchRecovery,
  current: CurrentPointer,
  nextVersion: string,
  nextRoot: string,
  node: NodeRuntime
): Promise<ApplyResult> {
  if (decision.action !== 'abort') {
    return { applied: false, pending: nextVersion, message: APPLY_MSG.failed }
  }
  if (decision.rejectVersion) {
    await markRejected(nextVersion)
    await rm(nextRoot, { recursive: true, force: true })
    await clearPending()
  }
  if (decision.restartOld) await restartAndVerify(node, current)
  if (decision.emit === 'ready') {
    onUpdateReady?.(nextVersion)
    return { applied: false, pending: nextVersion, message: APPLY_MSG.portBusy }
  }
  onUpdateGone?.()
  return { applied: false, pending: null, message: APPLY_MSG.preflight }
}

async function finishRollback(
  node: NodeRuntime,
  switched: CurrentPointer,
  nextVersion: string,
  nextRoot: string,
  rejectVersion: boolean
): Promise<ApplyResult> {
  killChild()
  await waitUntilPortFree(PORT_RELEASE_MS)
  const rolled = pointerAfterRollback(switched)
  let oldHealthy = false
  if (rolled) {
    try {
      await writeCurrentPointer(dshDir, rolled)
      oldHealthy = await restartAndVerify(node, rolled)
    } catch (err) {
      console.warn('[dsh-update]', err instanceof Error ? err.message : String(err))
    }
  }
  if (rejectVersion) await markRejected(nextVersion)
  await rm(nextRoot, { recursive: true, force: true })
  await clearPending()
  const after = decideAfterRollback(oldHealthy)
  onUpdateGone?.()
  return {
    applied: false,
    pending: null,
    message: after.fault ? APPLY_MSG.fault : APPLY_MSG.rolledBack
  }
}

async function runSwitchTransaction(
  node: NodeRuntime,
  current: CurrentPointer,
  nextVersion: string,
  opts: { stopFirst: boolean }
): Promise<ApplyResult> {
  const nextRoot = join(dshDir, 'versions', nextVersion)
  const nextRef: VersionRef = { version: nextVersion, path: versionRelativePath(nextVersion) }
  let pointerWritten = false
  try {
    const entry = await dshEntryFromPkg(join(nextRoot, 'node_modules', '@deepseek-ai', 'dsh'))
    if (!(await preflightEntry(node, entry))) {
      return finishAbort(decideSwitchFailure({ at: 'preflight' }), current, nextVersion, nextRoot, node)
    }
    if (opts.stopFirst) {
      killChild()
      if (!(await waitUntilPortFree(PORT_RELEASE_MS))) {
        return finishAbort(decideSwitchFailure({ at: 'port-busy' }), current, nextVersion, nextRoot, node)
      }
    }
    const switched = pointerAfterSuccessfulSwitch(current, nextRef)
    await writeCurrentPointer(dshDir, switched)
    pointerWritten = true
    await startDshProcess(node, switched)
    const probeOk = await waitUntilHealthy(SERVE_WAIT_MS)
    if (shouldRollback(probeOk)) {
      return finishRollback(node, switched, nextVersion, nextRoot, true)
    }
    try {
      await cleanupRetention(switched)
    } catch (err) {
      console.warn('[dsh-update] cleanup', err instanceof Error ? err.message : String(err))
    }
    await clearPending()
    onUpdateGone?.()
    onViewReload?.()
    return { applied: true, pending: null, message: APPLY_MSG.applied }
  } catch (err) {
    console.warn('[dsh-update]', err instanceof Error ? err.message : String(err))
    const decision = decideSwitchFailure({ at: 'thrown', pointerWritten })
    if (decision.action === 'rollback' || decision.action === 'restore-pointer-and-old') {
      const switched = pointerAfterSuccessfulSwitch(current, nextRef)
      return finishRollback(node, switched, nextVersion, nextRoot, decision.rejectVersion)
    }
    return finishAbort(decision, current, nextVersion, nextRoot, node)
  }
}

async function launchDshLocked(
  node: NodeRuntime,
  onStage: (stage: string) => void
): Promise<{ url: string }> {
  const occupied = await portOccupied()
  const autoApply = shouldAutoApplyOnLaunch(coldStartEligible, !occupied)
  coldStartEligible = false

  if (occupied) {
    await adoptLegacyInstall(dshDir)
    return { url: dshUrl }
  }

  await ensureDshLocked(node, onStage)

  if (autoApply) {
    const pending = await pendingUpdateVersion()
    const current = await adoptLegacyInstall(dshDir)
    if (pending && current) {
      const result = await runSwitchTransaction(node, current, pending, { stopFirst: false })
      if (result.applied || dshRunning()) return { url: dshUrl }
    }
  }

  onStage('starting')
  const pointer = await adoptLegacyInstall(dshDir)
  if (!pointer) throw new Error('安装失败,请检查网络后重试')
  await startDshProcess(node, pointer)
  if (await waitUntilHealthy(SERVE_WAIT_MS)) return { url: dshUrl }
  const exited = child !== null && child.exitCode !== null
  killChild()
  throw launchFailure(exited)
}

export async function launchDsh(onStage: (stage: string) => void): Promise<{ url: string }> {
  const node = await ensureNode(onStage)
  return withUpdateLock(() => launchDshLocked(node, onStage))
}

export async function stopDsh(): Promise<void> {
  await withUpdateLock(async () => {
    killChild()
  })
}

async function checkForUpdateLocked(): Promise<void> {
  const node = await installedNode()
  if (!node) return
  await cleanStagingDirs()
  const pointer = await adoptLegacyInstall(dshDir)
  if (!pointer || !(await pkgExists(dshDir, pointer))) return

  let lastError: unknown
  const registries = npmRegistries()
  for (let i = 0; i < registries.length; i++) {
    const registry = registries[i]
    const capMs = i < registries.length - 1 ? INSTALL_CAP_MS : undefined
    try {
      const latest = await fetchLatestTag(registry)
      if (!isSafeVersion(latest)) continue
      const state = await readUpdateState()
      state.rejected = reconcileRejected(state.rejected, latest)
      const pending = await readPendingRecord()
      const rec = reconcilePending({ pending, current: pointer.version, latest })
      if (rec.discard && pending) {
        await discardStagedVersion(pending.version, pointer)
        await clearPending()
      }
      await writeUpdateState(dshDir, state)

      if (!versionsDiffer(pointer.version, latest)) {
        if (!(await pendingUpdateVersion())) onUpdateGone?.()
        return
      }
      if (shouldSkipRejected(latest, state.rejected)) return

      state.seen = rememberFirstSeen(state.seen, latest, Date.now())
      await writeUpdateState(dshDir, state)
      const firstSeenAt = state.seen[latest]
      if (firstSeenAt === undefined || !isBakeElapsed(firstSeenAt, Date.now())) return

      if (rec.pending?.version === latest && (await stagedPkgExists(latest))) {
        onUpdateReady?.(latest)
        return
      }

      await installPinnedVersion(node, latest, registry, capMs)
      const entry = await dshEntryFromPkg(join(dshDir, 'versions', latest, 'node_modules', '@deepseek-ai', 'dsh'))
      if (!(await preflightEntry(node, entry))) {
        await rm(join(dshDir, 'versions', latest), { recursive: true, force: true })
        await markRejected(latest)
        console.warn('[dsh-update] preflight failed; discarded staged version')
        continue
      }
      await writePendingRecord({ version: latest, registry })
      onUpdateReady?.(latest)
      return
    } catch (err) {
      lastError = err
    }
  }
  if (lastError) throw lastError
}

export async function checkForUpdate(): Promise<void> {
  try {
    await withUpdateLock(checkForUpdateLocked)
  } catch (err) {
    console.warn('[dsh-update]', err instanceof Error ? err.message : String(err))
  }
}

async function applyUpdateLocked(): Promise<ApplyResult> {
  const pending = await pendingUpdateVersion()
  if (!pending) return { applied: false, pending: null }
  const current = await adoptLegacyInstall(dshDir)
  if (!current) return { applied: false, pending, message: APPLY_MSG.failed }
  const node = await ensureNode(() => undefined)
  return runSwitchTransaction(node, current, pending, { stopFirst: true })
}

export async function applyUpdate(): Promise<ApplyResult> {
  try {
    return await withUpdateLock(applyUpdateLocked)
  } catch (err) {
    console.warn('[dsh-update]', err instanceof Error ? err.message : String(err))
    onUpdateGone?.()
    return { applied: false, pending: null, message: APPLY_MSG.failed }
  }
}

export function startUpdateChecker(hooks: {
  onReady: (version: string) => void
  onGone: () => void
  onViewReload: () => void
}): void {
  onUpdateReady = hooks.onReady
  onUpdateGone = hooks.onGone
  onViewReload = hooks.onViewReload
  void pendingUpdateVersion().then((version) => {
    if (version) onUpdateReady?.(version)
  })
  setTimeout(() => {
    void checkForUpdate()
    setInterval(() => void checkForUpdate(), CHECK_INTERVAL_MS)
  }, CHECK_FIRST_DELAY_MS)
}

process.on('exit', () => {
  killChild()
})
