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
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules')) {
              if (id.includes('/antd/es/') || id.includes('/antd/lib/')) {
                const match = id.match(/antd\/(?:es|lib)\/([^/]+)/)
                if (match?.[1]) return `antd-${match[1]}`
              }
              if (id.includes('/@ant-design/')) return 'antd-icons'
              if (id.includes('/rc-')) {
                const match = id.match(/\/(rc-[^/]+)\//)
                if (match?.[1]) return match[1]
              }
              if (id.includes('/react/') || id.includes('react-dom')) return 'react-vendor'
              if (id.includes('lucide-react')) return 'icons'
              if (id.includes('@amap/amap-jsapi-loader')) return 'amap'
            }

            if (id.includes('/src/BatchConsole')) return 'page-batch'
            if (id.includes('/src/ExifConsole')) return 'page-exif'
            if (id.includes('/src/Gallery')) return 'page-gallery'
            if (id.includes('/src/MuseumBrowser')) return 'page-museums'

            return undefined
          },
        },
      },
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
      },
    },
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
