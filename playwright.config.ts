import { defineConfig } from '@playwright/test';

const PORT = process.env.E2E_PORT ?? '3001';
const BASE_URL = `http://localhost:${PORT}`;

// Suppress the first-visit "How it works" modal by default in every test context;
// individual specs that need the first-visit flow re-create a fresh context.
export const SUPPRESS_HOWTO_STORAGE = {
  cookies: [],
  origins: [
    {
      origin: BASE_URL,
      localStorage: [{ name: 'bookdrop-howto-seen', value: '1' }],
    },
  ],
};

export default defineConfig({
  testDir: 'tests/e2e',
  use: {
    baseURL: BASE_URL,
    storageState: SUPPRESS_HOWTO_STORAGE,
  },
  webServer: {
    command: `cross-env UPLOAD_DIR=.tmp/bookdrop-e2e-uploads MAX_KEYS_PER_IP=50 RATE_LIMIT_MAX=200 DISABLE_HSTS=1 PORT=${PORT} tsx src/server.ts`,
    url: BASE_URL,
    reuseExistingServer: false,
  },
});
