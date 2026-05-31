import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:sockets': './src/tests/mocks/cloudflare-sockets.ts',
    },
  },
});
