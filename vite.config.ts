import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import * as path from 'node:path';
import { buildAppCsp } from './src/core/api/csp';

/**
 * Fills `%MOTION_CSP%` in index.html with a policy that names the backend this
 * build talks to. Without it the shipped policy could only ever reach localhost,
 * so a packaged build pointed at a deployed server was blocked from its own API
 * and from Cloudinary-served assets. See src/core/api/csp.ts.
 *
 * The resolved origin is printed because getting it wrong produces a working
 * build that fails only once installed — the most expensive kind of typo.
 */
function motionCsp(mode: string): Plugin {
  return {
    name: 'motion-csp',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        // `''` prefix = load every var, not just VITE_-prefixed ones, so the
        // same file can hold non-client build settings later.
        const env = loadEnv(mode, __dirname, '');
        const backendOrigin = env.VITE_BACKEND_ORIGIN ?? '';
        const csp = buildAppCsp({
          backendOrigin,
          mediaOrigins: env.VITE_MEDIA_ORIGINS,
        });
        if (backendOrigin) {
          console.log(`[motion-csp] backend origin: ${backendOrigin}`);
        }
        return html.replace('%MOTION_CSP%', csp);
      },
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), motionCsp(mode)],
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
      '@motion/ai-tools': path.resolve(__dirname, 'packages/ai-tools/src/index.ts'),
      // These four resolve through tsconfig `paths` and the Jest moduleNameMapper
      // as well. All three lists have to agree: a package missing from THIS one
      // typechecks, tests green, and then fails to resolve in the dev server.
      '@motion/design-system': path.resolve(__dirname, 'packages/design-system/src/index.ts'),
      '@motion/technique-library': path.resolve(__dirname, 'packages/technique-library/src/index.ts'),
      '@motion/product-motion': path.resolve(__dirname, 'packages/product-motion/src/index.ts'),
      '@motion/caster': path.resolve(__dirname, 'packages/caster/src/index.ts'),
      '@motion/audio': path.resolve(__dirname, 'packages/audio/src/index.ts'),
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
          renderer: ['@motion/renderer'],
        },
      },
    },
  },
  // Every worker is spawned as `new Worker(new URL(...), { type: 'module' })`
  // (thumbnail, encode, plugin). Vite's default worker format is 'iife', which
  // cannot be code-split — and the thumbnail worker pulls in the renderer graph,
  // which contains dynamic imports, so an iife build fails outright. 'es' matches
  // the module workers we already declare and is supported by Electron's Chromium.
  worker: {
    format: 'es',
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
}));
