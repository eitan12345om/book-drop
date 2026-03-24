import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  use: { baseURL: 'http://localhost:3001' },
  webServer: {
    command: 'UPLOAD_DIR=/tmp/bookdrop-e2e-uploads tsx src/server.ts',
    url: 'http://localhost:3001',
    reuseExistingServer: false,
  },
});
