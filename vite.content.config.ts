import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Content script: one classic IIFE, because MV3 injects it as a plain script.
export default defineConfig({
  plugins: [react()],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'chrome110',
    cssCodeSplit: false,
    lib: {
      entry: 'src/content/index.tsx',
      name: 'SteamProfileDesigner',
      formats: ['iife'],
      fileName: () => 'content.js',
    },
    rollupOptions: {
      output: {
        extend: true,
        inlineDynamicImports: true,
      },
    },
  },
})
