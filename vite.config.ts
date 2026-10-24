import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  base: './',
  // public/ only holds dev-extracted game data (gitignored); never ship it
  build: { target: 'es2022', copyPublicDir: false },
  worker: { format: 'es' },
  // onnxruntime-web 1.30's self-contained "bundle" build crashes in WebGPU mode (minifier bug), so use the
  // plain build and hand it the wasm + loader as hashed assets (see ai.worker.ts); don't let dev re-bundle it
  resolve: { alias: { 'onnxruntime-web/webgpu': fileURLToPath(new URL('./node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs', import.meta.url)) } },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  server: { port: 5199 },
});
