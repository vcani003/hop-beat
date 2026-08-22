import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages serves a project site from a subdirectory, so the base path is
// set at build time. Development stays at '/' where a subpath would only get
// in the way.
const base = process.env.VITE_BASE ?? '/'

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    port: 5175,
    strictPort: true,
  },
})
