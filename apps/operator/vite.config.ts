import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { swSource } from './src/sw/template.ts';

/** Emits sw.js precaching every built file of the app shell (design/17). */
function serviceWorker(): Plugin {
  return {
    name: 'ordo-operator-sw',
    apply: 'build',
    enforce: 'post',
    generateBundle(_opts, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map') && f !== 'sw.js');
      if (!files.includes('index.html')) files.push('index.html');
      let h = 0;
      for (const f of files.sort()) for (let i = 0; i < f.length; i++) h = (h * 31 + f.charCodeAt(i)) | 0;
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: swSource(files, `op-${(h >>> 0).toString(36)}`),
      });
    },
  };
}

export default defineConfig({
  base: './',
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
