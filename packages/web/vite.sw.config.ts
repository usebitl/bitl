import { defineConfig } from 'vite';

/**
 * Service worker build → dist/sw.js (runs after the app build, does not empty dist).
 * It needs a fixed, unhashed name so browsers recognize it as a new version of the same worker.
 * Not all browsers support module workers, so it is bundled as a single file (IIFE).
 */
export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(Date.now().toString(36)) },
  build: {
    emptyOutDir: false,
    copyPublicDir: false,
    lib: { entry: 'sw/sw.ts', formats: ['iife'], name: 'bitlsw', fileName: () => 'sw.js' },
  },
});
