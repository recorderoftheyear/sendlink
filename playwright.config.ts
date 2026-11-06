import { defineConfig } from '@playwright/test';

const PORT = 4173;
export const BUFFERING_PROXY_PORT = 4174;

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  fullyParallel: false,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'npm run build && node dist/server.js',
      url: `http://localhost:${PORT}/healthz`,
      reuseExistingServer: false,
      env: { PORT: String(PORT), HOST: '127.0.0.1', DB_PATH: ':memory:', PUBLIC_URL: `http://localhost:${PORT}` },
    },
    {
      // Reverse proxy that holds response bodies until they end, like Cloudflare Quick Tunnels.
      command: `npx tsx scripts/proxy.ts ${BUFFERING_PROXY_PORT} ${PORT} buffer`,
      url: `http://localhost:${BUFFERING_PROXY_PORT}/healthz`,
      reuseExistingServer: false,
    },
  ],
});
