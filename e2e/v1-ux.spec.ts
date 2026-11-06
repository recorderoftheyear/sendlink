import { devices, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';
const { defaultBrowserType: _ignored, ...pixel } = devices['Pixel 7'];

async function openDesktop(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(page.getByTestId('qr')).toHaveAttribute('data-pair-url', /#pair=/);
  return page;
}

const newDesktop = async (browser: Browser, userAgent?: string) =>
  openDesktop(await browser.newContext(userAgent ? { userAgent } : {}));

async function connect(phone: Page, desktop: Page): Promise<void> {
  await phone.goto((await desktop.getByTestId('qr').getAttribute('data-pair-url'))!);
  await expect(phone.getByText('Send to')).toBeVisible();
}

/** What Android does when the user picks SendLink in the Share menu. */
async function shareFromAndroid(phoneCtx: BrowserContext, text: string): Promise<Page> {
  const page = await phoneCtx.newPage();
  await page.goto('/m?title=Video&text=' + encodeURIComponent(text));
  await expect(page.getByText('Send to')).toBeVisible();
  return page;
}

const selectedDestination = (page: Page) =>
  page.locator('[data-testid="target"][aria-checked="true"] [data-testid="target-name"]');

test('Share: URL prefilled, last destination preselected, Send → only that computer receives', async ({ browser }) => {
  const chrome = await newDesktop(browser);
  const firefox = await newDesktop(browser, FIREFOX_LINUX);
  const phoneCtx = await browser.newContext(pixel);
  const phone = await phoneCtx.newPage();
  await connect(phone, chrome);
  await connect(phone, firefox); // the most recently connected one is selected…

  // …but the destination actually *used* last is what gets remembered.
  await phone.getByTestId('dest-select').selectOption({ label: 'Linux PC · Chrome' });
  await phone.getByTestId('url-input').fill('https://example.com/first');
  await phone.getByRole('button', { name: 'Send →' }).click();
  await expect(phone.getByTestId('feedback')).toHaveText('✓ Sent to Linux PC · Chrome');
  await expect(chrome.getByTestId('link-item')).toHaveCount(1);

  // YouTube → Share → SendLink
  const share = await shareFromAndroid(phoneCtx, 'https://youtube.com/shorts/abc123');
  await expect(share.getByTestId('shared-url')).toHaveText('youtube.com/shorts/abc123');
  await expect(share.getByTestId('target')).toHaveCount(2);
  await expect(selectedDestination(share)).toHaveText('Linux PC · Chrome');
  await expect(share.getByTestId('target')).toContainText(['Online', 'Online']);

  // Pick Firefox and send: Firefox receives, Chrome doesn't.
  await share.getByRole('radio', { name: /Linux PC · Firefox/ }).click();
  await share.getByRole('button', { name: 'Send →' }).click();
  await expect(share.getByTestId('sent-title')).toHaveText('✓ Sent to Linux PC · Firefox');
  await expect(firefox.getByTestId('link-item').first()).toContainText('youtube.com/shorts/abc123');
  await expect(chrome.getByTestId('link-item')).toHaveCount(1);

  // Next share remembers Firefox.
  const next = await shareFromAndroid(phoneCtx, 'https://reddit.com/r/linux');
  await expect(selectedDestination(next)).toHaveText('Linux PC · Firefox');

  // Firefox removes the phone: the next share falls back to a destination that still exists.
  firefox.once('dialog', (d) => void d.accept());
  await firefox.getByRole('button', { name: /^Remove / }).click();
  const after = await shareFromAndroid(phoneCtx, 'https://reddit.com/r/linux');
  await expect(after.getByTestId('target')).toHaveCount(1);
  await expect(selectedDestination(after)).toHaveText('Linux PC · Chrome');
});

test('Offline computer: phone is told the link will be delivered, computer gets it on reconnect', async ({ browser }) => {
  const desktopCtx = await browser.newContext();
  const desktop = await openDesktop(desktopCtx);
  const phoneCtx = await browser.newContext(pixel);
  const phone = await phoneCtx.newPage();
  await connect(phone, desktop);

  await desktop.close(); // computer goes offline (same browser profile keeps its identity)
  await expect(async () => {
    await phone.reload();
    await expect(phone.locator('#dest-single .dot')).toHaveClass(/off/, { timeout: 500 });
  }).toPass();

  // Direct launch: sending still works, with a clear explanation.
  await phone.getByTestId('url-input').fill('https://example.com/while-offline');
  await phone.getByRole('button', { name: 'Send →' }).click();
  await expect(phone.getByTestId('feedback')).toHaveText(
    '✓ Sent to Linux PC · Chrome. Computer offline — the link will be delivered when it reconnects.',
  );

  // Share launch: offline is shown but doesn't block.
  const share = await shareFromAndroid(phoneCtx, 'https://example.com/shared-offline');
  await expect(share.getByTestId('target')).toContainText('Offline');
  await share.getByRole('button', { name: 'Send →' }).click();
  await expect(share.getByTestId('sent-note')).toHaveText(
    'Computer offline — the link will be delivered when it reconnects.',
  );

  // Computer comes back: both links are there.
  const back = await desktopCtx.newPage();
  await back.goto('/');
  await expect(back.getByTestId('link-item')).toHaveCount(2);
  await expect(back.getByTestId('link-item').first()).toContainText('example.com/shared-offline');
  await expect(back.getByTestId('link-item').nth(1)).toContainText('example.com/while-offline');
});

test('Desktop notification: only when SendLink is in the background; clicking it opens the link', async ({ browser }) => {
  const desktopCtx = await browser.newContext();
  // Deterministic stand-ins for things a headless browser can't do for real:
  // a granted Notification permission, and the tab being in the background.
  await desktopCtx.addInitScript(() => {
    const w = window as unknown as { __notes: unknown[]; __background: boolean };
    w.__notes = [];
    w.__background = false;
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => w.__background });
    Document.prototype.hasFocus = () => !w.__background;
    class FakeNotification {
      static permission = 'granted';
      static requestPermission = async () => 'granted';
      onclick: (() => void) | null = null;
      constructor(
        readonly title: string,
        readonly options: NotificationOptions,
      ) {
        w.__notes.push(this);
      }
      close() {}
    }
    Object.defineProperty(window, 'Notification', { configurable: true, value: FakeNotification });
    // Use the page-level notification path (the service-worker path is covered by manual tests).
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: undefined });
  });
  await desktopCtx.route('https://example.com/**', (route) => route.fulfill({ body: 'opened' }));
  const desktop = await openDesktop(desktopCtx);
  const phone = await (await browser.newContext(pixel)).newPage();
  await connect(phone, desktop);
  await expect(desktop.getByTestId('notify-card')).toBeHidden(); // permission already granted
  await expect(desktop.locator('#notify-status')).toHaveText('Notifications on');

  const send = async (url: string) => {
    await phone.getByTestId('url-input').fill(url);
    await phone.getByRole('button', { name: 'Send →' }).click();
    await expect(desktop.getByTestId('link-item').first()).toContainText(url.replace('https://', ''));
  };
  const notes = () =>
    desktop.evaluate(() =>
      (window as unknown as { __notes: { title: string; options: NotificationOptions }[] }).__notes.map((n) => ({
        title: n.title,
        body: n.options.body,
      })),
    );

  // Visible & focused: no notification.
  await send('https://example.com/visible');
  expect(await notes()).toEqual([]);

  // In the background: "SendLink — <phone> sent you a link".
  await desktop.evaluate(() => ((window as unknown as { __background: boolean }).__background = true));
  await send('https://example.com/background');
  await expect.poll(notes).toEqual([
    { title: 'SendLink', body: 'Android phone · Chrome sent you a link\nexample.com/background' },
  ]);
  expect(desktopCtx.pages()).toHaveLength(1); // never opened automatically

  // Clicking the notification opens the link.
  const opened = desktopCtx.waitForEvent('page');
  await desktop.evaluate(() => (window as unknown as { __notes: { onclick(): void }[] }).__notes[0]!.onclick());
  await (await opened).waitForURL('https://example.com/background');
});
