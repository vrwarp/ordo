import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { allFiles, compactFiles, type SetBundle } from './src/sw/sets.ts';
import { swSource } from './src/sw/template.ts';

/**
 * Emits sw.js precaching every built file of the app shell (design/17), and the phone's set beside it
 * (src/sw/sets.ts: a phone registers ./sw.js?set=compact). The version hash is of every file, as before.
 */
function serviceWorker(): Plugin {
  let root = '';
  return {
    name: 'ordo-operator-sw',
    apply: 'build',
    enforce: 'post',
    configResolved(c) {
      root = c.root;
    },
    generateBundle(_opts, bundle) {
      const files = allFiles(bundle as unknown as SetBundle);
      let h = 0;
      for (const f of files) for (let i = 0; i < f.length; i++) h = (h * 31 + f.charCodeAt(i)) | 0;
      const compact = compactFiles(bundle as unknown as SetBundle, { root });
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: swSource(files, `op-${(h >>> 0).toString(36)}`, undefined, compact),
      });
    },
  };
}

export default defineConfig({
  base: './',
  // The GitHub Pages demo build (apps/demo) sets ORDO_DEMO=1: no hub socket, a service worker hub.
  define: { __ORDO_DEMO__: JSON.stringify(process.env.ORDO_DEMO === '1') },
  plugins: [react(), serviceWorker()],
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 2000 },
  server: {
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: false },
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
});
