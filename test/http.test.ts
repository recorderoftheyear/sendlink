// Integration tests over real HTTP + SSE.
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import type { RealtimeEvent } from '../src/shared/protocol.js';

let app: App;
let base: string;
const streams: { close(): void }[] = [];

beforeEach(async () => {
  app = createApp({ ...loadConfig({}), dbPath: ':memory:', publicUrl: 'https://send.example' });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const s of streams.splice(0)) s.close();
  await app.close();
});

async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, headers: res.headers, body: (text ? JSON.parse(text) : undefined) as any };
}

/**
 * Opens an SSE stream like a browser would: acknowledges "ready" and "ping" so the server
 * counts this device as online. `{ ack: false }` simulates a dead/unreachable client.
 */
async function openStream(token: string, { ack = true }: { ack?: boolean } = {}) {
  const { body } = await call('POST', '/api/stream-tickets', { token });
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/events?ticket=${body.ticket}`, { signal: ctrl.signal });
  const events: RealtimeEvent[] = [];
  const control: { event: string; data: { conn: string } }[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const lines = buf.slice(0, i).split('\n');
          buf = buf.slice(i + 2);
          const name = lines.find((l) => l.startsWith('event: '))?.slice(7);
          const data = lines.find((l) => l.startsWith('data: '));
          if (!data) continue;
          const parsed = JSON.parse(data.slice(6));
          if (name === 'ready' || name === 'ping') {
            control.push({ event: name, data: parsed });
            if (ack) call('POST', '/api/presence', { token, body: { conn: parsed.conn } }).catch(() => undefined); // may race teardown
          } else {
            events.push(parsed);
          }
        }
      }
    } catch {
      // aborted
    }
  })();
  const stream = {
    status: res.status,
    events,
    control,
    ticket: body.ticket as string,
    close: () => ctrl.abort(),
  };
  streams.push(stream);
  return stream;
}

async function until(check: () => boolean, timeoutMs = 2000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function setup() {
  const desktop = (await call('POST', '/api/devices', { body: { kind: 'desktop', name: 'Work PC' } })).body;
  const pairing = (await call('POST', '/api/pairing-tokens', { token: desktop.token })).body;
  const secret = new URL(pairing.pairUrl).hash.replace('#pair=', '');
  const phone = (await call('POST', '/api/pairings', { body: { secret, deviceName: 'Pixel' } })).body;
  return { desktop, phone, pairing };
}

describe('HTTP API', () => {
  it('pair → send → the right desktop receives it in realtime', async () => {
    const desktop = (await call('POST', '/api/devices', { body: { kind: 'desktop', name: 'Work PC' } })).body;
    const other = (await call('POST', '/api/devices', { body: { kind: 'desktop', name: 'Other PC' } })).body;
    const desktopStream = await openStream(desktop.token);
    const otherStream = await openStream(other.token);
    expect(desktopStream.status).toBe(200);

    const pairing = await call('POST', '/api/pairing-tokens', { token: desktop.token });
    expect(pairing.status).toBe(201);
    const pairUrl = new URL(pairing.body.pairUrl);
    // Secret travels in the fragment only, on the configured public origin.
    expect(pairUrl.origin + pairUrl.pathname + pairUrl.search).toBe('https://send.example/m');
    const secret = pairUrl.hash.replace('#pair=', '');

    const phone = await call('POST', '/api/pairings', { body: { secret, deviceName: 'Pixel' } });
    expect(phone.status).toBe(201);
    expect(phone.body.peer.name).toBe('Work PC');
    await until(() => desktopStream.events.some((e) => e.type === 'paired'));

    await until(() => app.hub.isOnline(desktop.device.id));
    const me = await call('GET', '/api/me', { token: phone.body.token });
    expect(me.body.peers).toEqual([expect.objectContaining({ id: desktop.device.id, online: true })]);

    const sent = await call('POST', '/api/links', {
      token: phone.body.token,
      body: { targetDeviceId: desktop.device.id, url: 'https://reddit.com/r/programming' },
    });
    expect(sent.status).toBe(201);
    await until(() => desktopStream.events.some((e) => e.type === 'url'));
    expect(desktopStream.events.find((e) => e.type === 'url')).toMatchObject({
      url: 'https://reddit.com/r/programming',
      senderName: 'Pixel',
    });

    const history = await call('GET', '/api/links', { token: desktop.token });
    expect(history.body.links).toHaveLength(1);

    await new Promise((r) => setTimeout(r, 50));
    expect(otherStream.events).toEqual([]);
    expect((await call('GET', '/api/links', { token: other.token })).body.links).toEqual([]);
  });

  it('tells the sender whether the link was delivered live or stored for later', async () => {
    const { desktop, phone } = await setup();
    const send = (url: string) =>
      call('POST', '/api/links', { token: phone.token, body: { targetDeviceId: desktop.device.id, url } });

    const offline = await send('https://a.com/1');
    expect(offline.status).toBe(201);
    expect(offline.body.delivered).toBe(false); // stored, delivered on reconnect

    await openStream(desktop.token);
    await until(() => app.hub.isOnline(desktop.device.id)); // "ready" acknowledged
    expect((await send('https://a.com/2')).body.delivered).toBe(true);

    // Store-and-forward: the computer gets both from its history.
    const history = await call('GET', '/api/links', { token: desktop.token });
    expect(history.body.links.map((l: { url: string }) => l.url)).toEqual(['https://a.com/2', 'https://a.com/1']);
  });

  it('healthcheck reports ok when the database is usable', async () => {
    const res = await call('GET', '/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('rejects requests without a valid device token', async () => {
    expect((await call('GET', '/api/me')).status).toBe(401);
    expect((await call('GET', '/api/me', { token: 'sld_forged' })).status).toBe(401);
    expect((await call('GET', '/api/links', { token: 'garbage' })).status).toBe(401);
    expect((await call('GET', '/api/events')).status).toBe(401);
  });

  it('stream tickets are single-use', async () => {
    const { desktop } = await setup();
    const stream = await openStream(desktop.token);
    const reuse = await fetch(`${base}/api/events?ticket=${stream.ticket}`);
    expect(reuse.status).toBe(401);
  });

  it('a device cannot send to a device it is not paired with', async () => {
    const { phone } = await setup();
    const stranger = (await call('POST', '/api/devices', { body: { kind: 'desktop', name: 'Stranger' } })).body;
    const res = await call('POST', '/api/links', {
      token: phone.token,
      body: { targetDeviceId: stranger.device.id, url: 'https://a.com' },
    });
    expect(res.status).toBe(403);
    expect((await call('GET', '/api/links', { token: stranger.token })).body.links).toEqual([]);
  });

  it('rejects invalid URLs with 400', async () => {
    const { desktop, phone } = await setup();
    const res = await call('POST', '/api/links', {
      token: phone.token,
      body: { targetDeviceId: desktop.device.id, url: 'javascript:alert(document.cookie)' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_url');
  });

  it('revocation takes effect immediately', async () => {
    const { desktop, phone } = await setup();
    const phoneStream = await openStream(phone.token);
    expect((await call('DELETE', `/api/pairings/${phone.device.id}`, { token: desktop.token })).status).toBe(204);
    await until(() => phoneStream.events.some((e) => e.type === 'unpaired'));
    const res = await call('POST', '/api/links', {
      token: phone.token,
      body: { targetDeviceId: desktop.device.id, url: 'https://a.com' },
    });
    expect(res.status).toBe(403);
  });

  it('only allows registering desktops directly (phones come from pairing)', async () => {
    expect((await call('POST', '/api/devices', { body: { kind: 'mobile' } })).status).toBe(400);
  });

  it('rate-limits pairing attempts (brute force on short codes)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) {
      statuses.push((await call('POST', '/api/pairings', { body: { code: 'AAAAAAAA' } })).status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 400)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it('limits authenticated traffic per device, so devices sharing an IP (NAT) do not starve each other', async () => {
    const { desktop, phone } = await setup();
    let last = 0;
    for (let i = 0; i < 305 && last !== 429; i++) last = (await call('GET', '/api/me', { token: phone.token })).status;
    expect(last).toBe(429); // this phone is over its own budget…
    expect((await call('GET', '/api/me', { token: desktop.token })).status).toBe(200); // …the computer on the same IP is not
  });

  it('rate-limits sending', async () => {
    const { desktop, phone } = await setup();
    let last = 0;
    for (let i = 0; i < 31; i++) {
      last = (
        await call('POST', '/api/links', {
          token: phone.token,
          body: { targetDeviceId: desktop.device.id, url: `https://a.com/${i}` },
        })
      ).status;
    }
    expect(last).toBe(429);
  });

  it('requires JSON bodies and bounds their size', async () => {
    const res = await fetch(`${base}/api/devices`, { method: 'POST', body: 'kind=desktop' });
    expect(res.status).toBe(415);
    const big = await call('POST', '/api/devices', { body: { kind: 'desktop', name: 'x'.repeat(10_000) } });
    expect(big.status).toBe(413);
  });

  it('serves pages with strict security headers and blocks path traversal', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect((await fetch(`${base}/..%2f..%2fpackage.json`)).status).toBe(404);
    expect((await fetch(`${base}/%E0%A4%A`)).status).toBe(404);
  });
});
