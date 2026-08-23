// Summono engine: the resident process that does the real work (runtime
// installs, harness supervision). It runs as an Electron utility process,
// isolated from the GUI behind this RPC seam so it can be replaced
// independently without touching the app shell.

import * as apps from './apps'
import * as dsh from './dsh'
import { installedNode } from './runtime'

interface RpcRequest {
  id: number
  method: string
  params?: unknown
}

function emit(event: string, payload?: unknown): void {
  process.parentPort.postMessage({ event, payload })
}

const onStage = (stage: string): void => emit('dsh.stage', stage)

dsh.startUpdateChecker({
  onReady: (version) => emit('dsh.updateReady', { version }),
  onGone: () => emit('dsh.updateGone'),
  onViewReload: () => emit('dsh.viewReload')
})

const handlers: Record<string, (params?: unknown) => Promise<unknown> | unknown> = {
  ping: () => 'pong',
  status: async () => ({
    node: await installedNode(),
    dshInstalled: await dsh.dshInstalled(),
    dshRunning: dsh.dshRunning(),
    dshUrl: dsh.dshUrl,
    dshUpdateReady: await dsh.pendingUpdateVersion()
  }),
  'dsh.setup': () => dsh.ensureDsh(onStage),
  'dsh.launch': () => dsh.launchDsh(onStage),
  'dsh.stop': () => dsh.stopDsh(),
  'dsh.update': () => dsh.checkForUpdate(),
  'dsh.applyUpdate': () => dsh.applyUpdate(),
  'apps.list': () => apps.listApps(),
  'apps.install': (params) => {
    const { id, targetDir } = params as { id: string; targetDir?: string }
    return apps.installApp(
      id,
      (appId, stage) => emit('app.stage', { id: appId, stage }),
      (appId, ratio) => emit('app.progress', { id: appId, ratio }),
      targetDir
    )
  },
  'apps.launch': (params) => apps.launchApp((params as { id: string }).id)
}

process.parentPort.on('message', async (event) => {
  const { id, method, params } = event.data as RpcRequest
  const handler = handlers[method]
  if (!handler) {
    process.parentPort.postMessage({ id, error: `unknown method: ${method}` })
    return
  }
  try {
    process.parentPort.postMessage({ id, result: await handler(params) })
  } catch (err) {
    process.parentPort.postMessage({ id, error: err instanceof Error ? err.message : String(err) })
  }
})
