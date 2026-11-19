import { defineConfig } from 'vite'

// MV3 service worker. Built as an IIFE so it loads without module resolution.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'chrome110',
    lib: {
      entry: 'src/content/sw.ts',
      name: 'SteamProfileDesignerWorker',
      formats: ['iife'],
      fileName: () => 'sw.js',
    },
    rollupOptions: {
      output: {
        extend: true,
        inlineDynamicImports: true,
      },
    },
  },
})
