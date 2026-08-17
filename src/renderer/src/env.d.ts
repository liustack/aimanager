/// <reference types="vite/client" />

export interface EngineEvent {
  event: string
  payload?: unknown
}

export interface EngineStatus {
  node: { version: string; binDir: string } | null
  dshInstalled: boolean
  dshRunning: boolean
  dshUrl: string
}

export interface DesktopApp {
  id: string
  name: string
  description: string
  installed: boolean
}

declare global {
  interface Window {
    aimanager: {
      engineCall: (method: string, params?: unknown) => Promise<unknown>
      openDsh: () => Promise<void>
      dshMenu: () => Promise<void>
      onDshView: (callback: (state: { shown: boolean; color?: string | null }) => void) => () => void
      onEngineEvent: (callback: (message: EngineEvent) => void) => () => void
    }
  }
}
