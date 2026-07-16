import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = {
    ...loadEnv(mode, resolve(process.cwd(), '..'), ''),
    ...loadEnv(mode, process.cwd(), ''),
  }
  // `npm run dev` runs with --mode gallery: the 线上图库 preview. It must talk to the
  // CLOUD backend, not the local one. We proxy /api and /files server-side (just like
  // Vercel's rewrites), so the browser stays same-origin: no CORS, no cloud .env changes.
  const isGallery = mode === 'gallery'
  const cloudBackend = env.VITE_CLOUD_BACKEND || 'http://123.57.34.90:8000'

  return {
    plugins: [react()],
    define: {
      'import.meta.env.VITE_AMAP_SCRIPT_ID': JSON.stringify(env.AMAP_SCRIPT_ID ?? 'museum-console-amap-script'),
      'import.meta.env.VITE_AMAP_SECURITY_CODE': JSON.stringify(env.AMAP_SECURITY_CODE ?? ''),
      'import.meta.env.VITE_AMAP_SCRIPT_SRC': JSON.stringify(env.AMAP_SCRIPT_SRC ?? ''),
    },
    ...(isGallery
      ? {
          server: {
            proxy: {
              '/api': { target: cloudBackend, changeOrigin: true },
              '/files': { target: cloudBackend, changeOrigin: true },
            },
          },
        }
      : {}),
  }
})
