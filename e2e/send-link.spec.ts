import { devices, expect, test, type Browser, type Page } from '@playwright/test';

/** Desktop and phone are separate browser contexts = separate devices with separate storage. */
async function openDesktop(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Send links from your phone/ })).toBeVisible();
  return page;
}

async function openPhone(browser: Browser): Promise<Page> {
  const { defaultBrowserType: _ignored, ...pixel } = devices['Pixel 7'];
  const ctx = await browser.newContext(pixel);
  return ctx.newPage();
}

/** What a phone camera would read from the QR code. */
async function scanQr(desktop: Page): Promise<string> {
  const qr = desktop.getByTestId('qr');
  await expect(qr).toHaveAttribute('data-pair-url', /\/m#pair=/);
  return (await qr.getAttribute('data-pair-url'))!;
}

test('desktop shows QR → phone pairs → phone sends URL → desktop receives it in history', async ({ browser }) => {
  // Desktop opens SendLink: a pairing QR + code is created.
  const desktop = await openDesktop(browser);
  await expect(desktop.getByTestId('pair-code')).toHaveText(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  const pairUrl = await scanQr(desktop);

  // Phone "scans" the QR code and gets paired.
  const phone = await openPhone(browser);
  await phone.goto(pairUrl);
  await expect(phone.getByText('Send to')).toBeVisible();
  await expect(phone.getByTestId('target-name')).toHaveText(/PC|Mac|Computer|Chromebook/);
  await expect(phone.getByTestId('notice')).toContainText('✓ Connected to');
  expect(phone.url()).not.toContain('pair='); // secret stripped from the address bar

  // Desktop switches to the inbox by itself (realtime "paired" event).
  await expect(desktop.getByRole('heading', { name: 'Received' })).toBeVisible();
  await expect(desktop.getByTestId('welcome')).toContainText('✓ Phone connected');
  await expect(desktop.getByTestId('status')).toContainText('Android phone');
  await expect(desktop.getByTestId('status')).toHaveAttribute('data-state', 'connected');
  await expect(desktop.locator('html')).not.toHaveAttribute('data-transport', 'poll'); // direct: real SSE

  // Phone sends a URL.
  const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  await phone.getByTestId('url-input').fill(url);
  await phone.getByRole('button', { name: 'Send →' }).click();
  await expect(phone.getByTestId('feedback')).toHaveText(/^✓ Sent to .+/);
  await expect(phone.getByTestId('url-input')).toHaveValue('');

  // Desktop receives it instantly, without auto-opening it.
  const item = desktop.getByTestId('link-item').first();
  await expect(item).toContainText('youtube.com/watch?v=dQw4w9WgXcQ');
  await expect(item).toContainText(/Android phone · Chrome · (just now|\d+ sec ago)/); // source · time
  await expect(desktop.getByTestId('welcome')).toBeHidden();
  await expect(item.getByRole('link')).toHaveAttribute('href', url);
  await expect(item.getByRole('link')).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(item.getByRole('button', { name: 'Open' })).toBeEnabled();
  expect(desktop.context().pages()).toHaveLength(1);

  // It is persisted in the history.
  await desktop.reload();
  await expect(desktop.getByTestId('link-item')).toHaveCount(1);
  await expect(desktop.getByTestId('link-item').first()).toContainText('youtube.com/watch?v=dQw4w9WgXcQ');

  // Delete from history.
  await desktop.getByRole('button', { name: 'Delete' }).click();
  await expect(desktop.getByTestId('link-item')).toHaveCount(0);
});

test('code entry, share launch before connecting, invalid link and removal', async ({ browser }) => {
  const desktop = await openDesktop(browser);
  const code = (await desktop.getByTestId('pair-code').textContent())!;

  // Phone opened from the OS share sheet (Web Share Target) before being connected.
  const phone = await openPhone(browser);
  await phone.goto('/m?title=Cool&text=' + encodeURIComponent('Look at this https://reddit.com/r/typescript'));
  await expect(phone.getByRole('heading', { name: 'Connect to your computer' })).toBeVisible();
  await expect(phone.getByText('Your link will be ready to send')).toBeVisible();
  await phone.getByLabel('Code').fill(code.toLowerCase());
  await phone.getByRole('button', { name: 'Connect' }).click();

  // The shared link survived connecting: share screen, then sent.
  await expect(phone.getByTestId('shared-url')).toHaveText('reddit.com/r/typescript');
  await phone.getByRole('button', { name: 'Send →' }).click();
  await expect(phone.getByTestId('sent-title')).toHaveText(/^✓ Sent to Linux PC · Chrome$/);
  await expect(desktop.getByTestId('link-item').first()).toContainText('reddit.com/r/typescript');
  await phone.getByRole('button', { name: 'Send another link' }).click();
  await phone.waitForTimeout(1800); // past the auto-close delay: staying must cancel it
  expect(phone.isClosed()).toBe(false);

  // Dangerous schemes are refused, in plain words...
  await phone.getByTestId('url-input').fill('javascript:alert(1)');
  await phone.getByRole('button', { name: 'Send →' }).click();
  await expect(phone.getByTestId('feedback')).toHaveText("That doesn't look like a web link. Check it and try again.");

  // ...bare domains are upgraded to https.
  await phone.getByTestId('url-input').fill('example.com/hello');
  await phone.getByRole('button', { name: 'Send →' }).click();
  await expect(phone.getByTestId('feedback')).toContainText('✓');
  await expect(desktop.getByTestId('link-item').first()).toContainText('example.com/hello');

  // Desktop removes the phone → the open phone screen switches to "connect" live (no send needed).
  desktop.once('dialog', (d) => void d.accept());
  await desktop.getByRole('button', { name: 'Remove Android phone · Chrome' }).click();
  await expect(desktop.getByRole('heading', { name: /Send links from your phone/ })).toBeVisible();
  await expect(phone.getByRole('heading', { name: 'Connect to your computer' })).toBeVisible();
});

test('a used QR code cannot pair a second phone', async ({ browser }) => {
  const desktop = await openDesktop(browser);
  const pairUrl = await scanQr(desktop);
  const phone1 = await openPhone(browser);
  await phone1.goto(pairUrl);
  await expect(phone1.getByText('Send to')).toBeVisible();

  const phone2 = await openPhone(browser);
  await phone2.goto(pairUrl);
  await expect(phone2.locator('#connect-notice')).toHaveText("This code doesn't work anymore. Use the code shown on your computer.");
});
