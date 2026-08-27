import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: '一鸣与美垚的旅行计划',
        short_name: '旅行计划',
        description: '一鸣与美垚的协作旅行计划',
        lang: 'zh-CN',
        start_url: '/',
        display: 'standalone',
        theme_color: '#f2f1eb',
        background_color: '#f2f1eb',
        icons: [],
      },
      workbox: {
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/(?:auth|api|oauth)(?:\/|$)/],
        runtimeCaching: [
          {
            urlPattern: ({ request, url }) => request.mode === 'navigate'
              && !/^\/(?:auth|api|oauth)(?:\/|$)/.test(url.pathname),
            handler: 'NetworkFirst',
            options: { cacheName: 'travel-app-shell-v1', networkTimeoutSeconds: 3 },
          },
          {
            urlPattern: ({ url }) => /^\/(?:auth|api|oauth)(?:\/|$)/.test(url.pathname),
            handler: 'NetworkOnly',
          },
          {
            urlPattern: ({ url }) => url.origin !== (globalThis as unknown as { location?: { origin?: string } }).location?.origin,
            handler: 'NetworkOnly',
          },
          {
            urlPattern: ({ url }) => url.origin === (globalThis as unknown as { location?: { origin?: string } }).location?.origin
              && /^\/(?:images|media)(?:\/|$)/.test(url.pathname),
            handler: 'CacheFirst',
            options: { cacheName: 'travel-owned-images-v1' },
          },
        ],
      },
    }),
  ],
  // Keep local secrets in one ignored repository-root .env.local file.
  envDir: "../..",
  test: {
    environment: 'jsdom',
    setupFiles: './src/test-setup.ts',
    passWithNoTests: true,
  },
})
