import { type Plugin, defineConfig } from 'vite';

/**
 * Writes precache.json next to index.html: the app shell file list and a version derived from it.
 * public/sw.js reads it on install and whenever a navigation succeeds, so a new build replaces the cache.
 */
function precacheManifest(): Plugin {
  return {
    name: 'ordo-output-precache',
    apply: 'build',
    enforce: 'post',
    generateBundle(_opts, bundle) {
      const files = Object.keys(bundle)
        .filter((f) => !f.endsWith('.map') && f !== 'precache.json')
        .sort();
      if (!files.includes('index.html')) files.push('index.html');
      let h = 2166136261;
      for (const f of files)
        for (let i = 0; i < f.length; i++) {
          h ^= f.charCodeAt(i);
          h = Math.imul(h, 16777619);
        }
      this.emitFile({
        type: 'asset',
        fileName: 'precache.json',
        source: JSON.stringify({ version: `out-${(h >>> 0).toString(36)}`, files }, null, 1),
      });
    },
  };
}

export default defineConfig({
  base: './',
  // The GitHub Pages demo build (apps/demo) sets ORDO_DEMO=1: no hub socket, a service worker hub.
  define: { __ORDO_DEMO__: JSON.stringify(process.env.ORDO_DEMO === '1') },
  plugins: [precacheManifest()],
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 2000 },
  server: {
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: false },
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
});
