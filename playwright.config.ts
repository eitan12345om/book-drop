import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  use: { baseURL: 'http://localhost:3001' },
  webServer: {
    command:
      'cross-env UPLOAD_DIR=.tmp/bookdrop-e2e-uploads MAX_KEYS_PER_IP=50 RATE_LIMIT_MAX=200 DISABLE_HSTS=1 tsx src/server.ts',
    url: 'http://localhost:3001',
    reuseExistingServer: false,
  },
});
