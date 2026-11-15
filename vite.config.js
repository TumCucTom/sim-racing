import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run build` -> dist/ (normal multi-file build)
// `SINGLE=1 npm run build` -> one self-contained dist-single/index.html
export default defineConfig({
  base: './',
  plugins: process.env.SINGLE ? [viteSingleFile()] : [],
  build: { outDir: process.env.SINGLE ? 'dist-single' : 'dist', chunkSizeWarningLimit: 2500 },
  server: { host: '127.0.0.1', port: 5173 },
});
