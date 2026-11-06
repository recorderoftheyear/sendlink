import { devices, expect, test } from '@playwright/test';

const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';
const { defaultBrowserType: _ignored, ...pixel } = devices['Pixel 7'];

test('closing Firefox turns it Offline live on the phone; Chrome stays Online; reopening brings the queued link', async ({ browser }) => {
  const chromeCtx = await browser.newContext();
  const firefoxCtx = await browser.newContext({ userAgent: FIREFOX_LINUX });
  const chrome = await chromeCtx.newPage();
  const firefox = await firefoxCtx.newPage();
  for (const page of [chrome, firefox]) {
    await page.goto('/');
    await expect(page.getByTestId('qr')).toHaveAttribute('data-pair-url', /#pair=/);
  }

  const phoneCtx = await browser.newContext(pixel);
  const setup = await phoneCtx.newPage();
  for (const desktop of [chrome, firefox]) {
    await setup.goto((await desktop.getByTestId('qr').getAttribute('data-pair-url'))!);
    await expect(setup.getByText('Send to')).toBeVisible();
  }
  await setup.close();

  // Share screen stays open on the phone for the whole test (no reload).
  const share = await phoneCtx.newPage();
  await share.goto('/m?text=' + encodeURIComponent('https://youtube.com/shorts/presence'));
  const row = (name: string) => share.getByRole('radio', { name: new RegExp(name) });
  await expect(row('Firefox')).toContainText('Online');
  await expect(row('Chrome')).toContainText('Online');

  // Completely close Firefox (its profile — and so its SendLink identity — stays on disk).
  const firefoxProfile = await firefoxCtx.storageState();
  await firefoxCtx.close();
  await expect(row('Firefox')).toContainText('Offline', { timeout: 5000 });
  await expect(row('Chrome')).toContainText('Online');

  // Sending to closed Firefox: stored, and the phone says so.
  await row('Firefox').click();
  await share.getByRole('button', { name: 'Send →' }).click();
  await expect(share.getByTestId('sent-note')).toHaveText(
    'Computer offline — the link will be delivered when it reconnects.',
  );

  // A new share while Firefox is closed shows it Offline…
  const next = await phoneCtx.newPage();
  await next.goto('/m?text=' + encodeURIComponent('https://reddit.com/r/linux'));
  const nextRow = next.getByRole('radio', { name: /Firefox/ });
  await expect(nextRow).toContainText('Offline');

  // …and it turns Online live when Firefox is reopened, which also gets the queued link.
  const reopened = await (await browser.newContext({ userAgent: FIREFOX_LINUX, storageState: firefoxProfile })).newPage();
  await reopened.goto('/');
  await expect(reopened.getByTestId('link-item').first()).toContainText('youtube.com/shorts/presence');
  await expect(nextRow).toContainText('Online', { timeout: 5000 });
  await expect(next.getByRole('radio', { name: /Chrome/ })).toContainText('Online');
});
