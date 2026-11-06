import { devices, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

const { defaultBrowserType: _ignored, ...pixel } = devices['Pixel 7'];

async function pairedPhone(browser: Browser): Promise<{ desktop: Page; phoneCtx: BrowserContext; phone: Page }> {
  const desktop = await (await browser.newContext()).newPage();
  await desktop.goto('/');
  const pairUrl = await desktop.getByTestId('qr').getAttribute('data-pair-url');
  const phoneCtx = await browser.newContext(pixel);
  const phone = await phoneCtx.newPage();
  await phone.goto(pairUrl!);
  await expect(phone.getByText('Send to')).toBeVisible();
  return { desktop, phoneCtx, phone };
}

/** "Installed/loaded once": the service worker is active and the app shell is precached. */
async function waitForOfflineShell(page: Page): Promise<void> {
  await page.waitForFunction(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg?.active) return false;
    const names = await caches.keys();
    const shell = names.find((n) => n.startsWith('sendlink-shell-'));
    return !!shell && !!(await (await caches.open(shell)).match('/m'));
  });
}

test('offline: the cached /m opens from Share with the last destinations, and never claims delivery', async ({ browser }) => {
  const { desktop, phoneCtx, phone } = await pairedPhone(browser);
  await waitForOfflineShell(phone);

  await phoneCtx.setOffline(true);
  const share = await phoneCtx.newPage();
  await share.goto('/m?text=' + encodeURIComponent('https://youtube.com/shorts/offline1'));

  // The SendLink app shell, not Chrome's offline error page.
  await expect(share).toHaveTitle('SendLink');
  await expect(share.getByTestId('offline-banner')).toHaveText(
    "You're offline. SendLink is open, but links can't be sent until you're back online.",
  );
  await expect(share.getByTestId('target-name')).toHaveText('Linux PC · Chrome'); // cached destination
  await expect(share.getByTestId('target')).toContainText('Status unknown');
  await expect(share.getByTestId('shared-url')).toHaveText('youtube.com/shorts/offline1');

  // Trying to send offline: clearly NOT sent, link kept.
  await share.getByRole('button', { name: 'Send →' }).click();
  await expect(share.getByTestId('feedback')).toHaveText(
    "Not sent — no connection. Your link is still here: try again when you're back online.",
  );
  await expect(share.getByTestId('sent-title')).toBeHidden();
  await expect(desktop.getByTestId('link-item')).toHaveCount(0);

  // Back online: the same send goes through, exactly once.
  await phoneCtx.setOffline(false);
  await share.getByRole('button', { name: 'Send →' }).click();
  await expect(share.getByTestId('sent-title')).toHaveText('✓ Sent to Linux PC · Chrome');
  await expect(desktop.getByTestId('link-item')).toHaveCount(1);
  await expect(desktop.getByTestId('link-item').first()).toContainText('youtube.com/shorts/offline1');
});

test('offline and never connected: the cached shell still opens, on the connect screen', async ({ browser }) => {
  const phoneCtx = await browser.newContext(pixel);
  const phone = await phoneCtx.newPage();
  await phone.goto('/m'); // loaded once (not connected to any computer)
  await waitForOfflineShell(phone);
  await phoneCtx.setOffline(true);
  const again = await phoneCtx.newPage();
  await again.goto('/m');
  await expect(again).toHaveTitle('SendLink');
  await expect(again.getByRole('heading', { name: 'Connect to your computer' })).toBeVisible();
});

test('ambiguous failure (server stored it, response lost): automatic retry with the same messageId, one link', async ({ browser }) => {
  const { desktop, phone } = await pairedPhone(browser);
  const bodies: string[] = [];
  let dropNext = true;
  await phone.route('**/api/links', async (route) => {
    bodies.push(route.request().postData() ?? '');
    if (dropNext) {
      dropNext = false;
      await route.fetch(); // reaches the server, which stores the link…
      await route.abort('connectionreset'); // …but the phone never gets the answer
      return;
    }
    await route.continue();
  });

  await phone.getByTestId('url-input').fill('https://example.com/ambiguous');
  await phone.getByRole('button', { name: 'Send →' }).click();
  await expect(phone.getByTestId('feedback')).toHaveText('✓ Sent to Linux PC · Chrome');
  await expect(phone.locator('html')).toHaveAttribute('data-last-send', 'relay:delivered');

  expect(bodies).toHaveLength(2);
  const ids = bodies.map((b) => (JSON.parse(b) as { messageId: string }).messageId);
  expect(ids[0]).toMatch(/^msg_/);
  expect(ids[1]).toBe(ids[0]); // retried with the same id

  await expect(desktop.getByTestId('link-item')).toHaveCount(1);
  await desktop.waitForTimeout(500); // no late duplicate from the realtime channel either
  await expect(desktop.getByTestId('link-item')).toHaveCount(1);
  await desktop.reload();
  await expect(desktop.getByTestId('link-item')).toHaveCount(1);
});
