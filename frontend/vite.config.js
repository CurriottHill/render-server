import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Popup/app build only. Content script is built via vite.content.config.js
export default defineConfig({
  plugins: [react()],
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: { index: 'index.html' },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
})
