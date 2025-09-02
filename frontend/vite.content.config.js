import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dedicated build for the content script. Produces a single classic file at dist/content.js
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: false, // keep popup build artifacts
    rollupOptions: {
      input: { content: 'src/content.js' },
      output: {
        entryFileNames: 'content.js',
        // Force one-file output for content script
        inlineDynamicImports: true,
        manualChunks: undefined,
        assetFileNames: (assetInfo) => {
          if (assetInfo.name === 'content.css' || assetInfo.name?.endsWith('.css')) {
            return 'assets/popup.css'
          }
          return 'assets/[name].[ext]'
        },
      },
    },
  },
})
