import { contextBridge, ipcRenderer } from 'electron'

export interface EngineEvent {
  event: string
  payload?: unknown
}

const api = {
  engineCall: (method: string, params?: unknown): Promise<unknown> =>
    ipcRenderer.invoke('engine:call', method, params),
  openDsh: (): Promise<void> => ipcRenderer.invoke('dsh:open'),
  dshBack: (): Promise<void> => ipcRenderer.invoke('dsh:back'),
  onDshView: (
    callback: (state: { shown: boolean; color?: string | null }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      state: { shown: boolean; color?: string | null }
    ): void => callback(state)
    ipcRenderer.on('dsh:view', listener)
    return () => ipcRenderer.removeListener('dsh:view', listener)
  },
  onEngineEvent: (callback: (message: EngineEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, message: EngineEvent): void =>
      callback(message)
    ipcRenderer.on('engine:event', listener)
    return () => ipcRenderer.removeListener('engine:event', listener)
  }
}

contextBridge.exposeInMainWorld('aimanager', api)
