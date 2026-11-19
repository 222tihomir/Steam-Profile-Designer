import { defineConfig } from 'vite'

// Upload-page helper: a small classic script, no framework needed.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'chrome110',
    lib: {
      entry: 'src/content/helper.ts',
      name: 'SteamProfileDesignerHelper',
      formats: ['iife'],
      fileName: () => 'helper.js',
    },
    rollupOptions: {
      output: {
        extend: true,
        inlineDynamicImports: true,
      },
    },
  },
})
