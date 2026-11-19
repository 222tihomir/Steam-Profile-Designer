import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Static copy of a Steam profile with the real class names and measurements.
// It is loaded from the dev server or from dist/mock-profile.html and mounts the
// same overlay module the content script uses.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'chrome110',
    rollupOptions: {
      input: {
        mock: 'mock-profile.html',
      },
    },
  },
})
