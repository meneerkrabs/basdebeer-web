import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // public/ only holds dev-extracted game data (gitignored); never ship it
  build: { target: 'es2022', copyPublicDir: false },
  server: { port: 5199 },
});
