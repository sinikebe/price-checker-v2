import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  publicDir: 'public-v2',
  build: { outDir: 'dist-v2', rollupOptions: { input: resolve(import.meta.dirname, 'v2.html') } },
  plugins: [react(), VitePWA({
    registerType: 'prompt', scope: '/v2',
    includeAssets: ['v2-mark.svg', 'apple-touch-icon-180x180.png', 'favicon.ico'],
    manifest: {
      id: '/v2', name: 'Price Checker', short_name: 'Price Checker',
      description: 'Produits, panier et recettes à portée de main.',
      lang: 'fr', start_url: '/v2', scope: '/v2', display: 'standalone',
      theme_color: '#2f8061', background_color: '#f7faf4',
      icons: [
        { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
        { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
        { src: '/maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    workbox: {
      navigateFallback: '/v2.html', navigateFallbackDenylist: [/^\/api\//],
      globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
      maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      runtimeCaching: [{
        urlPattern: ({ url, request }) => request.method === 'GET' && url.origin === (globalThis as unknown as { location: { origin: string } }).location.origin &&
          !request.headers.has('X-PWA-Sync') &&
          ((/^\/api\/v2\/recipes(?:\/\d+)?$/.test(url.pathname) ||
            /^\/api\/v2\/products(?:\/\d+)?$/.test(url.pathname))),
        handler: 'CacheFirst',
        options: { cacheName: 'price-checker-offline-data-v2', expiration: { maxEntries: 600 } },
      }],
    },
  })],
  server: { proxy: { '/api': { target: 'http://127.0.0.1:8000', changeOrigin: false } } },
})
