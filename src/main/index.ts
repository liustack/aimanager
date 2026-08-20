import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow, ipcMain, shell, utilityProcess, WebContentsView } from 'electron'

interface EngineMessage {
  id?: number
  result?: unknown
  error?: string
  event?: string
  payload?: unknown
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
}

let engine: Electron.UtilityProcess | null = null
let nextRequestId = 1
const pending = new Map<number, Pending>()

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload)
  }
}

function engineForkEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  // Node 24 fetch is undici and ignores HTTP(S)_PROXY unless this is set at
  // process start (https://nodejs.org/api/cli.html#--use-env-proxy). `import
  // 'undici'` is not a public builtin, so this is the engine's proxy path.
  // Loopback stays in NO_PROXY so dsh health checks never go through a proxy.
  env.NODE_USE_ENV_PROXY = '1'
  const extra = ['127.0.0.1', 'localhost', '::1']
  const existing = env.NO_PROXY || env.no_proxy || ''
  const noProxy = [
    ...new Set([...existing.split(',').map((s) => s.trim()).filter(Boolean), ...extra])
  ].join(',')
  env.NO_PROXY = noProxy
  env.no_proxy = noProxy
  return env
}

function startEngine(): void {
  engine = utilityProcess.fork(join(import.meta.dirname, 'engine.js'), [], {
    serviceName: 'aimanager-engine',
    env: engineForkEnv()
  })
  engine.on('message', (message: EngineMessage) => {
    if (message.event !== undefined) {
      if (message.event === 'dsh.viewReload' && dshView) {
        const url = dshView.webContents.getURL()
        if (url.startsWith('http')) void dshView.webContents.reload()
      }
      broadcast('engine:event', { event: message.event, payload: message.payload })
      return
    }
    if (message.id === undefined) return
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.error !== undefined) entry.reject(new Error(message.error))
    else entry.resolve(message.result)
  })
  engine.on('exit', () => {
    for (const entry of pending.values()) entry.reject(new Error('engine exited'))
    pending.clear()
    engine = null
  })
}

function callEngine(method: string, params?: unknown): Promise<unknown> {
  if (!engine) return Promise.reject(new Error('engine not running'))
  const id = nextRequestId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    engine!.postMessage({ id, method, params })
  })
}

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    show: false,
    title: 'aimanager',
    backgroundColor: '#0d0d12',
    // Frameless look: macOS keeps only the traffic lights, Windows/Linux get
    // native window controls overlaid on our background.
    titleBarStyle: 'hiddenInset',
    // y centers the lights within the 30px dsh strip; on the launcher they
    // float over empty backdrop where exact y hardly matters.
    trafficLightPosition: { x: 14, y: 9 },
    ...(process.platform !== 'darwin'
      ? { titleBarOverlay: { color: '#0d0d12', symbolColor: '#e8e8ec', height: 30 } }
      : {}),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false
    }
  })
  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('resize', layoutDshView)
  mainWindow.on('closed', () => {
    stopDshSampling()
    mainWindow = null
    dshView = null
    dshViewShown = false
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
  createDshView()
}

// dsh's web UI lives inside the main window (per plan: the user never leaves
// aimanager) under a 30px strip. The strip is rendered by our renderer (a
// plain DOM ✕ — native-view overlays proved unreliable for clicks) and
// doubles as the drag region. Traffic lights keep their native spot inside it.
const DSH_STRIP_HEIGHT = 30
let dshView: WebContentsView | null = null
let dshViewShown = false
let dshViewColor: string | null = null
let dshLaunch: Promise<unknown> | null = null

// Strip color: capture a sliver of real rendered pixels at the top-center of
// the dsh view and average them. CSS-based sampling (body backgroundColor,
// theme-color meta) lied — dsh paints its dark theme on inner containers
// while body stays light. Pixels can't lie, and they track the user toggling
// dsh's light/dark appearance, so we resample on an interval while shown.
const DSH_SAMPLE_INTERVAL_MS = 500
const DSH_SETTLE_INTERVAL_MS = 120
const DSH_SETTLE_MAX_FRAMES = 25
let dshSampleTimer: NodeJS.Timeout | null = null
let dshSettling = false

async function captureDshColor(): Promise<string | null> {
  if (!dshView || !dshView.webContents.getURL().startsWith('http')) return null
  try {
    const { width } = dshView.getBounds()
    if (width < 32) return null
    const image = await dshView.webContents.capturePage({
      x: Math.floor(width / 2) - 8,
      y: 2,
      width: 16,
      height: 6
    })
    const bitmap = image.toBitmap() // BGRA
    if (bitmap.length < 4) return null
    let r = 0
    let g = 0
    let b = 0
    const count = bitmap.length / 4
    for (let i = 0; i < bitmap.length; i += 4) {
      b += bitmap[i]
      g += bitmap[i + 1]
      r += bitmap[i + 2]
    }
    return `rgb(${Math.round(r / count)}, ${Math.round(g / count)}, ${Math.round(b / count)})`
  } catch {
    // Sampling is cosmetic; the renderer falls back to its own dark tone.
    return null
  }
}

async function sampleDshColor(): Promise<void> {
  if (dshSettling) return
  const first = await captureDshColor()
  if (!first || first === dshViewColor) return
  // dsh animates its light/dark toggle, so a changed frame may be a
  // mid-transition gray. Burst-sample until two consecutive frames agree
  // (animation over) and commit only the final color — the strip jumps
  // straight from old theme to new with no intermediate steps.
  dshSettling = true
  try {
    let color = first
    for (let i = 0; i < DSH_SETTLE_MAX_FRAMES; i++) {
      await delay(DSH_SETTLE_INTERVAL_MS)
      const next = await captureDshColor()
      if (!next) break
      if (next === color) break
      color = next
    }
    if (color !== dshViewColor) {
      dshViewColor = color
      if (dshViewShown) mainWindow?.webContents.send('dsh:view', { shown: true, color })
    }
  } finally {
    dshSettling = false
  }
}

function startDshSampling(): void {
  stopDshSampling()
  void sampleDshColor()
  dshSampleTimer = setInterval(() => void sampleDshColor(), DSH_SAMPLE_INTERVAL_MS)
}

function stopDshSampling(): void {
  if (dshSampleTimer) {
    clearInterval(dshSampleTimer)
    dshSampleTimer = null
  }
}

function layoutDshView(): void {
  if (!mainWindow || !dshView) return
  const [width, height] = mainWindow.getContentSize()
  dshView.setBounds({
    x: 0,
    y: DSH_STRIP_HEIGHT,
    width,
    height: height - DSH_STRIP_HEIGHT
  })
}

// The view is created, attached, and warmed at startup and only toggles
// visibility afterwards. Attach/detach churn is the known flicker source
// (electron#43961/#47351: a never-painted view's first attach exposes
// uninitialized compositor buffers — horizontal tearing). A hidden view
// pre-loaded with about:blank has a painted, committed surface long before
// the first click, and revealing it is a pure visibility flip.
function createDshView(): void {
  if (!mainWindow || dshView) return
  dshView = new WebContentsView({ webPreferences: { sandbox: true } })
  // dsh's body color: any gap before the page paints shows this, not white.
  dshView.setBackgroundColor('#151517')
  dshView.setVisible(false)
  dshView.webContents.setWindowOpenHandler(({ url: external }) => {
    if (external.startsWith('https://') || external.startsWith('http://')) {
      void shell.openExternal(external)
    }
    return { action: 'deny' }
  })
  dshView.webContents.on('did-finish-load', () => {
    // Fires for the about:blank warm-up too; only sample the real page.
    if (dshView?.webContents.getURL().startsWith('http')) void sampleDshColor()
  })
  void dshView.webContents.loadURL('about:blank')
  mainWindow.contentView.addChildView(dshView)
  layoutDshView()
}

function showDshView(url: string): void {
  if (!mainWindow || !dshView) return
  // Only navigate away from the about:blank warm-up once; re-opens must not
  // reload the page (getURL() normalizes with a trailing slash, so a naive
  // equality check against the engine's URL would reload every time).
  if (!dshView.webContents.getURL().startsWith('http')) void dshView.webContents.loadURL(url)
  dshViewShown = true
  layoutDshView()
  dshView.setVisible(true)
  mainWindow.webContents.send('dsh:view', { shown: true, color: dshViewColor })
  startDshSampling()
}

function hideDshView(): void {
  // Hidden, not destroyed: the dsh process keeps running and coming back is
  // instant.
  stopDshSampling()
  dshView?.setVisible(false)
  dshViewShown = false
  mainWindow?.webContents.send('dsh:view', { shown: false })
}

async function openDsh(): Promise<void> {
  dshLaunch ??= callEngine('dsh.launch').finally(() => {
    dshLaunch = null
  })
  const { url } = (await dshLaunch) as { url: string }
  showDshView(url)
}

async function runSmoke(mode: string): Promise<void> {
  try {
    if (mode === '1') {
      const result = await callEngine('ping')
      console.log(`engine ping: ${String(result)}`)
      app.exit(result === 'pong' ? 0 : 1)
      return
    }
    if (mode === 'install') {
      await callEngine('dsh.setup')
      console.log('dsh setup: ok')
      app.exit(0)
      return
    }
    // mode 'apps': run the desktop-app install pipeline into a scratch dir.
    if (mode === 'apps') {
      const scratch = join(app.getPath('temp'), 'aim-apps-verify')
      try {
        for (const id of ['codex', 'claude']) {
          await callEngine('apps.install', { id, targetDir: scratch })
          console.log(`app install ok: ${id}`)
        }
      } finally {
        // Electron patches fs to present app.asar archives as virtual
        // directories; recursively deleting another Electron app's .app
        // bundle then hangs inside the archive. Disable the patch while
        // touching foreign bundles.
        process.noAsar = true
        try {
          await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
        } catch (err) {
          console.warn(`scratch cleanup failed: ${String(err)}`)
        } finally {
          process.noAsar = false
        }
      }
      app.exit(0)
      return
    }
    // mode 'dsh': exercise the entire first-slice loop headlessly.
    const { url } = (await callEngine('dsh.launch')) as { url: string }
    const res = await fetch(url)
    console.log(`dsh smoke: ${url} -> HTTP ${res.status}`)
    await callEngine('dsh.stop')
    app.exit(res.ok ? 0 : 1)
  } catch (err) {
    console.error(`smoke failed: ${err instanceof Error ? err.message : String(err)}`)
    app.exit(1)
  }
}

app.whenReady().then(async () => {
  ipcMain.handle('engine:call', (_event, method: string, params?: unknown) =>
    callEngine(method, params)
  )
  ipcMain.handle('dsh:open', () => openDsh())
  // The strip's right-side control is a plain button, not a native popup
  // menu. Electron menus can't be aligned to a window edge (no menu-size
  // API, anchor is always the menu's top-left; electron#15096/#16008
  // wontfix), so any menu anchored near the right edge either spills past
  // the window or needs a guessed width. With a single action a direct
  // button is also one click cheaper. If per-harness actions multiply,
  // build a DOM dropdown in a small child window — not a native menu.
  ipcMain.handle('dsh:back', () => hideDshView())

  startEngine()

  if (process.env.AIM_SMOKE) {
    await runSmoke(process.env.AIM_SMOKE)
    return
  }

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let quitting = false
app.on('before-quit', (event) => {
  if (quitting || !engine) return
  event.preventDefault()
  quitting = true
  void Promise.race([callEngine('dsh.stop'), delay(1500)])
    .catch(() => undefined)
    .finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
