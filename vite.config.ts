/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the build works under https://<user>.github.io/<repo>/
  base: './',
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
