import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as path from 'node:path';

export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@core': path.resolve(__dirname, 'src/core'),
      '@components': path.resolve(__dirname, 'src/components'),
      '@layout': path.resolve(__dirname, 'src/layout'),
      '@stores': path.resolve(__dirname, 'src/stores'),
      '@hooks': path.resolve(__dirname, 'src/hooks'),
      '@styles': path.resolve(__dirname, 'src/styles'),
      '@tokens': path.resolve(__dirname, 'src/tokens'),
      '@themes': path.resolve(__dirname, 'src/themes'),
      '@app-types': path.resolve(__dirname, 'src/types'),
      '@utils': path.resolve(__dirname, 'src/utils'),
      '@assets': path.resolve(__dirname, 'src/assets'),
      '@providers': path.resolve(__dirname, 'src/providers'),
      '@motion/scene': path.resolve(__dirname, 'packages/scene/src/index.ts'),
      '@motion/workspace': path.resolve(__dirname, 'packages/workspace/src/index.ts'),
      '@motion/timeline': path.resolve(__dirname, 'packages/timeline/src/index.ts'),
      '@motion/animation': path.resolve(__dirname, 'packages/animation/src/index.ts'),
      '@motion/renderer': path.resolve(__dirname, 'packages/renderer/src/index.ts'),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          state: ['zustand', 'immer'],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // Proxy API calls to the motion-back backend so the browser talks same-origin
    // (avoids CORS in dev and works inside sandboxed preview browsers). The client
    // uses VITE_MOTION_API_URL="/api" (see .env.local) to hit this path.
    proxy: {
      '/api': {
        target: process.env.MOTION_API_TARGET || 'http://localhost:4000',
        changeOrigin: true,
      },
      // Uploaded assets are served by the backend at /files/<key>. Proxy them so
      // the browser loads them same-origin (the page CSP is default-src 'self',
      // which blocks the backend's absolute http://localhost:4000 URLs).
      '/files': {
        target: process.env.MOTION_API_TARGET || 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
});
