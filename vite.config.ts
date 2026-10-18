import { defineConfig } from 'vite';

import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    assetsInlineLimit: 0,
  },
  worker: { format: 'es' },
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.ts'],
  },
} as any);
