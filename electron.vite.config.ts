import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // Engine runs as a separate utility process; see docs in src/engine.
          engine: resolve(__dirname, 'src/engine/index.ts')
        }
      }
    }
  },
  preload: {},
  renderer: {
    plugins: [react()]
  }
})
