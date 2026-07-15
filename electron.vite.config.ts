import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // keytar 包含 macOS/Windows 原生二进制，必须由 Electron 直接 require，不能被 Rollup 内联。
        external: ['keytar']
      }
    }
  },
  preload: {},
  renderer: {}
})
