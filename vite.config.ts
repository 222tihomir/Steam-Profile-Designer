import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Studio page (extension tab). The first build cleans `dist`; the other configs
// add the content script, helper, service worker and mock profile to it.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome110',
    rollupOptions: {
      input: {
        studio: 'index.html',
      },
    },
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
})
