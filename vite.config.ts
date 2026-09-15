import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { loadEnv } from 'vite'

export default defineConfig(({ command, mode }) => ({
  define: { 'import.meta.env.VITE_XIAOYIN_DEV_PROXY': JSON.stringify(String(command === 'serve' && mode !== 'test')) },
  plugins: [react()],
  clearScreen: false,
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    maxWorkers: 2,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('react-markdown') || id.includes('remark-') || id.includes('micromark') || id.includes('mdast') || id.includes('hast')) return 'markdown'
          if (id.includes('lucide-react')) return 'icons'
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('scheduler')) return 'react'
          if (id.includes('@tauri-apps')) return 'tauri'
          return 'vendor'
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.VITE_XIAOYIN_SERVER_URL
          ?? loadEnv(mode, process.cwd(), 'VITE_').VITE_XIAOYIN_SERVER_URL
          ?? 'http://192.168.2.67:30081',
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (request) => request.removeHeader('origin'))
        },
      },
    },
    watch: { ignored: ['**/src-tauri/**', '**/harness-host/dist/**', '**/harness-host/native/**', '**/output/**'] },
  },
}))
