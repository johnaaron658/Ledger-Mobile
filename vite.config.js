import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8756',
    },
    // WSL's DrvFS mount (/mnt/c/...) doesn't emit inotify events, so Vite's
    // default file watcher silently never sees edits here. Poll instead.
    watch: {
      usePolling: true,
      interval: 300,
    },
  },
})
