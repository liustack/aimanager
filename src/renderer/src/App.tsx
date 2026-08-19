import { useEffect, useState } from 'react'
import type { DesktopApp, EngineStatus } from './env'
import deepseekIcon from './assets/deepseek.svg'
import openaiIcon from './assets/openai.svg'
import claudeIcon from './assets/claude-color.svg'

type Phase = 'idle' | 'working' | 'ready' | 'error'

interface TileState {
  phase: Phase
  stage?: string
  /* Download ratio 0..1; undefined means the current step is indeterminate. */
  progress?: number
  error?: string
}

const stageCopy: Record<string, string> = {
  'node-download': '正在准备…',
  'node-extract': '正在准备…',
  'dsh-install': '正在安装…',
  starting: '正在启动…',
  'app-download': '下载中…',
  'app-install': '正在安装…'
}

// Brand SVGs vendored from lobe-icons (lobehub/lobe-icons, MIT); tile
// backgrounds mirror each vendor's real app icon.
const marks: Record<string, { icon: string; tone: string }> = {
  dsh: { icon: deepseekIcon, tone: 'tone-dsh' },
  codex: { icon: openaiIcon, tone: 'tone-codex' },
  claude: { icon: claudeIcon, tone: 'tone-claude' }
}

/** Perceived luminance of `rgb()`/`#hex` colors; unparseable input is dark. */
function isLightColor(color: string): boolean {
  let r = 0
  let g = 0
  let b = 0
  const rgb = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  const hex = color.match(/^#([0-9a-f]{3}(?:[0-9a-f]{3})?)$/i)
  if (rgb) {
    ;[r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  } else if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1]
    ;[r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
  } else {
    return false
  }
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5
}

function caption(state: TileState, installed: boolean): string {
  if (state.phase === 'working') {
    if (state.progress !== undefined && state.stage === '下载中…') {
      return `下载中 ${Math.round(state.progress * 100)}%`
    }
    return state.stage ?? '正在处理…'
  }
  if (state.phase === 'error') return '出错了,点击重试'
  if (!installed && state.phase !== 'ready') return '点击安装'
  return ''
}

const RING_RADIUS = 15
const RING_LENGTH = 2 * Math.PI * RING_RADIUS

/* App Store-style overlay: a determinate ring while downloading, a spinning
   arc while the step has no measurable progress. */
function ProgressRing({ progress }: { progress?: number }): React.JSX.Element {
  const determinate = progress !== undefined
  return (
    <span className="ring-overlay">
      <svg
        className={determinate ? 'ring' : 'ring is-spinning'}
        viewBox="0 0 38 38"
        width="38"
        height="38"
      >
        <circle className="ring-track" cx="19" cy="19" r={RING_RADIUS} />
        <circle
          className="ring-value"
          cx="19"
          cy="19"
          r={RING_RADIUS}
          strokeDasharray={RING_LENGTH}
          strokeDashoffset={determinate ? RING_LENGTH * (1 - progress) : RING_LENGTH * 0.75}
        />
      </svg>
    </span>
  )
}

interface TileProps {
  id: string
  name: string
  state: TileState
  installed: boolean
  onClick: () => void
}

function Tile({ id, name, state, installed, onClick }: TileProps): React.JSX.Element {
  const mark = marks[id]
  const working = state.phase === 'working'
  const showTip = !installed && state.phase === 'idle'
  return (
    <button
      type="button"
      className="tile"
      disabled={working}
      onClick={onClick}
      title={state.error}
      data-tip={showTip ? '点击安装,装好后自动打开' : undefined}
    >
      <span
        className={`tile-icon ${mark?.tone ?? ''} ${working || showTip ? 'is-dimmed' : ''}`}
      >
        {mark ? <img className="tile-logo" src={mark.icon} alt="" /> : name.slice(0, 1)}
        {working && <ProgressRing progress={state.progress} />}
      </span>
      <span className="tile-name">{name}</span>
      <span className={`tile-sub ${state.phase === 'error' ? 'is-error' : ''}`}>
        {caption(state, installed)}
      </span>
    </button>
  )
}

export default function App(): React.JSX.Element {
  const [dsh, setDsh] = useState<TileState>({ phase: 'idle' })
  const [dshInstalled, setDshInstalled] = useState(false)
  const [apps, setApps] = useState<DesktopApp[]>([])
  const [appStates, setAppStates] = useState<Record<string, TileState>>({})
  const [engineReady, setEngineReady] = useState<boolean | null>(null)
  const [dshLayer, setDshLayer] = useState<{ shown: boolean; color?: string | null }>({
    shown: false
  })

  useEffect(() => {
    if (!window.aimanager) {
      setEngineReady(false)
      return
    }
    const offView = window.aimanager.onDshView(setDshLayer)
    void window.aimanager
      .engineCall('status')
      .then((raw) => {
        const status = raw as EngineStatus
        setEngineReady(true)
        setDshInstalled(status.dshInstalled)
        if (status.dshRunning) setDsh({ phase: 'ready' })
      })
      .catch(() => setEngineReady(false))
    void window.aimanager
      .engineCall('apps.list')
      .then((raw) => setApps(raw as DesktopApp[]))
      .catch(() => setApps([]))
    const offEngine = window.aimanager.onEngineEvent(({ event, payload }) => {
      if (event === 'dsh.stage') {
        setDsh({ phase: 'working', stage: stageCopy[String(payload)] ?? '正在处理…' })
      }
      if (event === 'app.stage') {
        const { id, stage } = payload as { id: string; stage: string }
        setAppStates((prev) => ({
          ...prev,
          [id]: { phase: 'working', stage: stageCopy[stage] ?? '正在处理…' }
        }))
      }
      if (event === 'app.progress') {
        const { id, ratio } = payload as { id: string; ratio: number }
        setAppStates((prev) => {
          const current = prev[id]
          if (current?.phase !== 'working') return prev
          return { ...prev, [id]: { ...current, progress: ratio } }
        })
      }
    })
    return () => {
      offView()
      offEngine()
    }
  }, [])

  const openDsh = (): void => {
    setDsh({ phase: 'working', stage: '正在准备…' })
    window.aimanager
      .openDsh()
      .then(() => {
        setDsh({ phase: 'ready' })
        setDshInstalled(true)
      })
      .catch((err: unknown) => {
        setDsh({ phase: 'error', error: err instanceof Error ? err.message : String(err) })
      })
  }

  const installOrOpen = (app: DesktopApp): void => {
    const state = appStates[app.id] ?? { phase: 'idle' }
    if (app.installed || state.phase === 'ready') {
      void window.aimanager.engineCall('apps.launch', { id: app.id })
      return
    }
    setAppStates((prev) => ({ ...prev, [app.id]: { phase: 'working', stage: '正在准备…' } }))
    window.aimanager
      .engineCall('apps.install', { id: app.id })
      .then(() => {
        setAppStates((prev) => ({ ...prev, [app.id]: { phase: 'ready' } }))
        void window.aimanager.engineCall('apps.launch', { id: app.id })
      })
      .catch((err: unknown) => {
        setAppStates((prev) => ({
          ...prev,
          [app.id]: { phase: 'error', error: err instanceof Error ? err.message : String(err) }
        }))
      })
  }

  // While dsh covers the window, only this 30px strip stays visible —
  // installed-PWA-style chrome colored by dsh's own sampled background
  // (fallback: theme-color, then dark). Traffic lights left (native), a
  // centered title, a back-to-launchpad button right (a direct button, not a
  // native popup menu — Electron menus can't right-align to a window edge),
  // drag everywhere else. The hairline bottom border is what reads as "real
  // titlebar" (a drop shadow would be painted under the native dsh view and
  // never show); its tone and the control colors derive from the sampled
  // background's luminance so light themes work too.
  if (dshLayer.shown) {
    const bg = dshLayer.color ?? '#1a1a1c'
    const light = isLightColor(bg)
    const vars = {
      background: bg,
      '--strip-fg': light ? 'rgba(0, 0, 0, 0.55)' : 'rgba(255, 255, 255, 0.55)',
      '--strip-fg-strong': light ? 'rgba(0, 0, 0, 0.85)' : '#ffffff',
      '--strip-border': light ? 'rgba(0, 0, 0, 0.10)' : 'rgba(255, 255, 255, 0.08)',
      '--strip-hover': light ? 'rgba(0, 0, 0, 0.07)' : 'rgba(255, 255, 255, 0.16)'
    } as React.CSSProperties
    return (
      <header className="dsh-strip" style={vars}>
        <span className="strip-title">DeepSeek Harness</span>
        <button
          type="button"
          className="strip-more"
          aria-label="回到启动台"
          title="回到启动台"
          onClick={() => void window.aimanager.dshBack()}
        >
          {/* Launchpad glyph: the classic 3×3 dot grid. */}
          <svg viewBox="0 0 24 24" fill="currentColor">
            <circle cx="5" cy="5" r="2" />
            <circle cx="12" cy="5" r="2" />
            <circle cx="19" cy="5" r="2" />
            <circle cx="5" cy="12" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="19" cy="12" r="2" />
            <circle cx="5" cy="19" r="2" />
            <circle cx="12" cy="19" r="2" />
            <circle cx="19" cy="19" r="2" />
          </svg>
        </button>
      </header>
    )
  }

  return (
    <main className="launchpad">
      <div className="grid">
        <Tile
          id="dsh"
          name="DeepSeek Harness"
          state={dsh}
          installed={dshInstalled}
          onClick={openDsh}
        />
        {apps.map((app) => (
          <Tile
            key={app.id}
            id={app.id}
            name={app.name}
            state={appStates[app.id] ?? { phase: 'idle' }}
            installed={app.installed || appStates[app.id]?.phase === 'ready'}
            onClick={() => installOrOpen(app)}
          />
        ))}
      </div>
      {engineReady === false && <p className="engine-warning">后台服务未就绪,请重启应用</p>}
    </main>
  )
}
