import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Resolve workspace packages from source so tests don't need a prior `tsc -b`.
    alias: {
      '@pumpwire/score': fileURLToPath(new URL('./packages/score/src/index.ts', import.meta.url)),
      '@pumpwire/live': fileURLToPath(new URL('./packages/live/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
  },
});
