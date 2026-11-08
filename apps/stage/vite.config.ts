import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { swSource } from './src/sw/template.ts';

/** Emits sw.js precaching every built file of the stage app shell (design/16, design/17). */
function serviceWorker(): Plugin {
  return {
    name: 'ordo-stage-sw',
    apply: 'build',
    enforce: 'post',
    generateBundle(_opts, bundle) {
      const files = Object.keys(bundle)
        .filter((f) => !f.endsWith('.map') && f !== 'sw.js')
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
        fileName: 'sw.js',
        source: swSource(files, `stage-${(h >>> 0).toString(36)}`),
      });
    },
  };
}

export default defineConfig({
  base: './',
  // The GitHub Pages demo build (apps/demo) sets ORDO_DEMO=1: no hub socket, a service worker hub.
  define: { __ORDO_DEMO__: JSON.stringify(process.env.ORDO_DEMO === '1') },
  plugins: [react(), serviceWorker()],
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 2000 },
  // The link worker (design/25) is an ES module worker.
  worker: { format: 'es' },
  server: {
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: false },
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
});
