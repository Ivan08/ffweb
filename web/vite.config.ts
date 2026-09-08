import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'

// Where the Rust server is listening. `make dev` sets this so a non-default
// --port still gets a working proxy; on its own, Vite assumes the default.
const apiTarget = process.env.FFWEB_API ?? 'http://127.0.0.1:7788'

export default defineConfig({
  plugins: [react(), tailwind()],
  build: {
    // The Rust binary embeds whatever lands here.
    outDir: '../assets/dist',
    emptyOutDir: true,
    // The wasm core is fetched at runtime from /wasm; nothing here is huge.
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': apiTarget,
      '/wasm': apiTarget,
    },
    headers: {
      // Match the production server so SharedArrayBuffer works in dev too.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  worker: { format: 'es' },
})
