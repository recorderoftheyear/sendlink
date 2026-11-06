import { devices, expect, test } from '@playwright/test';
import { BUFFERING_PROXY_PORT } from '../playwright.config';

// Everything goes through a proxy that buffers response bodies until they end —
// the behaviour measured on Cloudflare Quick Tunnels, where SSE events never arrive.
const PROXY = `http://localhost:${BUFFERING_PROXY_PORT}`;

test('behind a buffering proxy: pair and send update the desktop without refresh', async ({ browser }) => {
  const desktop = await (await browser.newContext()).newPage();
  await desktop.goto(`${PROXY}/`);
  await expect(desktop.getByRole('heading', { name: /Send links from your phone/ })).toBeVisible();

  // SSE stays silent behind this proxy; the client detects it and falls back to long-polling.
  await expect(desktop.locator('html')).toHaveAttribute('data-transport', 'poll', { timeout: 8000 });
  await expect(desktop.getByTestId('status')).toHaveAttribute('data-state', 'connected');

  const qrUrl = new URL((await desktop.getByTestId('qr').getAttribute('data-pair-url'))!);
  const { defaultBrowserType: _ignored, ...pixel } = devices['Pixel 7'];
  const phone = await (await browser.newContext(pixel)).newPage();
  await phone.goto(`${PROXY}/m${qrUrl.hash}`);
  await expect(phone.getByText('Send to')).toBeVisible();

  // Pair → desktop switches to the inbox by itself.
  await expect(desktop.getByRole('heading', { name: 'Received' })).toBeVisible({ timeout: 3000 });
  await expect(desktop.getByTestId('status')).toHaveAttribute('data-state', 'connected');

  // Send → the link appears on the desktop by itself.
  await phone.getByTestId('url-input').fill('https://news.ycombinator.com/item?id=1');
  await phone.getByRole('button', { name: 'Send →' }).click();
  await expect(phone.getByTestId('feedback')).toContainText('✓');
  await expect(desktop.getByTestId('link-item').first()).toContainText('news.ycombinator.com/item?id=1', {
    timeout: 3000,
  });

  // A second link, to check the poll loop keeps going after delivering.
  await phone.getByTestId('url-input').fill('https://example.com/second');
  await phone.getByRole('button', { name: 'Send →' }).click();
  await expect(desktop.getByTestId('link-item')).toHaveCount(2, { timeout: 3000 });
});
