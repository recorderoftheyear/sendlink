import { devices, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';
const SAMSUNG_INTERNET =
  'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36';
const { defaultBrowserType: _ignored, ...pixel } = devices['Pixel 7'];

async function openDesktop(browser: Browser, userAgent?: string): Promise<Page> {
  const page = await (await browser.newContext(userAgent ? { userAgent } : {})).newPage();
  await page.goto('/');
  await expect(page.getByTestId('qr')).toHaveAttribute('data-pair-url', /#pair=/);
  return page;
}

const pairUrlOf = async (desktop: Page) => (await desktop.getByTestId('qr').getAttribute('data-pair-url'))!;

/** Makes pages of this context run as the installed app (display-mode: standalone). */
async function launchAsInstalledApp(ctx: BrowserContext): Promise<void> {
  await ctx.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (q: string) =>
      q.includes('display-mode: standalone') ? ({ ...original(q), matches: true, media: q } as MediaQueryList) : original(q);
  });
}

test('each desktop browser is its own destination: "Linux PC · Chrome" and "Linux PC · Firefox"', async ({ browser }) => {
  const chrome = await openDesktop(browser);
  const firefox = await openDesktop(browser, FIREFOX_LINUX);

  const phoneCtx = await browser.newContext(pixel);
  const phone = await phoneCtx.newPage();
  await phone.goto(await pairUrlOf(chrome));
  await expect(phone.getByText('Send to')).toBeVisible();
  await phone.goto(await pairUrlOf(firefox)); // same phone, same credential, second computer
  const select = phone.getByTestId('dest-select');
  await expect(select.locator('option')).toHaveText(['Linux PC · Firefox', 'Linux PC · Chrome']);

  // Sending to the Firefox destination reaches Firefox only.
  await select.selectOption({ label: 'Linux PC · Firefox' });
  await phone.getByTestId('url-input').fill('https://example.com/for-firefox');
  await phone.getByRole('button', { name: 'Send →' }).click();
  await expect(phone.getByTestId('feedback')).toHaveText('✓ Sent to Linux PC · Firefox');
  await expect(firefox.getByTestId('link-item')).toHaveCount(1);
  await expect(chrome.getByTestId('link-item')).toHaveCount(0);
});

test('installed app = one canonical phone identity, reused by Share Target; other browsers stay separate', async ({ browser }) => {
  const desktop = await openDesktop(browser);

  // Connected first from a Chrome tab: a browser client.
  const phoneCtx = await browser.newContext(pixel);
  const tab = await phoneCtx.newPage();
  await tab.goto(await pairUrlOf(desktop));
  await expect(tab.getByTestId('self-name')).toHaveText('Android phone · Chrome');
  await expect(tab.getByTestId('install-card')).toBeVisible(); // not installed yet
  await expect(desktop.getByTestId('status')).toContainText('Android phone · Chrome');
  const credential = await tab.evaluate(() => localStorage.getItem('sendlink.mobile'));

  // The PWA installed from that browser shares its storage; a Share Target launch opens it.
  await launchAsInstalledApp(phoneCtx);
  const app = await phoneCtx.newPage();
  await app.goto('/m?text=' + encodeURIComponent('Watch this https://www.youtube.com/watch?v=share1'));
  await expect(app.getByTestId('shared-url')).toHaveText('youtube.com/watch?v=share1');
  expect(await app.evaluate(() => localStorage.getItem('sendlink.mobile'))).toBe(credential); // same identity
  await expect(desktop.getByTestId('status')).toContainText('Android phone');
  await expect(desktop.getByTestId('status')).not.toContainText('· Chrome'); // canonical: no browser suffix

  await app.getByRole('button', { name: 'Send →' }).click();
  await expect(desktop.getByTestId('link-item').first()).toContainText('youtube.com/watch?v=share1');
  await expect(desktop.getByTestId('link-item').first()).toContainText('Android phone ·');

  // Opened directly, the installed app shows its identity and no install suggestion.
  const home = await phoneCtx.newPage();
  await home.goto('/m');
  await expect(home.getByTestId('self-name')).toHaveText('Android phone');
  await expect(home.getByTestId('install-card')).toBeHidden();

  // Rename the phone: the desktop updates live.
  home.once('dialog', (d) => void d.accept('Galaxy S24'));
  await home.getByRole('button', { name: 'Rename' }).click();
  await expect(home.getByTestId('self-name')).toHaveText('Galaxy S24');
  await expect(desktop.getByTestId('status')).toContainText('Galaxy S24');

  // Samsung Internet on the same phone has isolated storage: not silently the same installation.
  const samsung = await (await browser.newContext({ ...pixel, userAgent: SAMSUNG_INTERNET })).newPage();
  await samsung.goto('/m');
  await expect(samsung.getByRole('heading', { name: 'Connect to your computer' })).toBeVisible();
});

test('renaming the computer keeps the browser label and updates the phone', async ({ browser }) => {
  const desktop = await openDesktop(browser);
  const phone = await (await browser.newContext(pixel)).newPage();
  await phone.goto(await pairUrlOf(desktop));
  await expect(phone.getByTestId('target-name')).toHaveText('Linux PC · Chrome');

  desktop.once('dialog', (d) => void d.accept('Work PC'));
  await desktop.getByRole('button', { name: 'Rename this computer' }).click();
  await expect(desktop.locator('#this-device')).toHaveText('Work PC · Chrome');

  await phone.reload();
  await expect(phone.getByTestId('target-name')).toHaveText('Work PC · Chrome');
});
