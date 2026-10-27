/// <reference types="vitest/config" />
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { manualPage } from './src/manual/plugin';

export default defineConfig({
  // Relative base so the build works under https://<user>.github.io/<repo>/
  base: './',
  plugins: [manualPage(import.meta.dirname)],
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        manual: resolve(import.meta.dirname, 'manual.html'),
      },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
