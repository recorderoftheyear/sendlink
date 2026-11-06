// Realtime delivery behind reverse proxies, incl. one that buffers streamed bodies
// like Cloudflare Quick Tunnels do.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProxy } from '../scripts/proxy.js';
import { createApp, type App } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import type { PollResponse } from '../src/shared/protocol.js';

let app: App;
const proxies: Server[] = [];
const aborts: AbortController[] = [];

const listen = (server: Server) =>
  new Promise<string>((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));

beforeEach(async () => {
  app = createApp({ ...loadConfig({}), dbPath: ':memory:', publicUrl: 'https://tunnel.example', trustProxy: true });
  await listen(app.server);
});

afterEach(async () => {
  for (const a of aborts.splice(0)) a.abort();
  for (const p of proxies.splice(0)) {
    p.closeAllConnections();
    p.close();
  }
  await app.close();
});

async function viaProxy(mode: 'stream' | 'buffer') {
  const port = (app.server.address() as AddressInfo).port;
  const proxy = createProxy(port, mode);
  proxies.push(proxy);
  const base = await listen(proxy);

  async function call(method: string, path: string, token?: string, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.status === 204 ? undefined : res.json();
  }

  /** Opens an SSE stream and records raw bytes with their arrival time. */
  async function openSse(token: string) {
    const { ticket } = await call('POST', '/api/stream-tickets', token);
    const ctrl = new AbortController();
    aborts.push(ctrl);
    const res = await fetch(`${base}/api/events?ticket=${ticket}`, { signal: ctrl.signal });
    let text = '';
    void (async () => {
      const decoder = new TextDecoder();
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) text += decoder.decode(chunk);
      } catch {
        // aborted
      }
    })();
    return { status: res.status, contentType: res.headers.get('content-type'), text: () => text };
  }

  async function setup() {
    const desktop = await call('POST', '/api/devices', undefined, { kind: 'desktop', name: 'PC' });
    const pairing = await call('POST', '/api/pairing-tokens', desktop.token);
    const secret = new URL(pairing.pairUrl).hash.slice('#pair='.length);
    return { desktop, secret };
  }

  return { call, openSse, setup };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, timeoutMs = 2000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await sleep(10);
  }
}

describe('behind a streaming reverse proxy', () => {
  it('SSE delivers ready, paired and url events immediately', async () => {
    const { call, openSse, setup } = await viaProxy('stream');
    const { desktop, secret } = await setup();
    const sse = await openSse(desktop.token);
    expect(sse.contentType).toBe('text/event-stream; charset=utf-8');
    await until(() => sse.text().includes('event: ready'));

    const phone = await call('POST', '/api/pairings', undefined, { secret });
    await until(() => sse.text().includes('event: paired'));
    await call('POST', '/api/links', phone.token, { targetDeviceId: desktop.device.id, url: 'https://a.com/x' });
    await until(() => sse.text().includes('"url":"https://a.com/x"'));
    // Frame format: id + event + data lines, blank-line terminated.
    expect(sse.text()).toMatch(/id: [\w-]+:\d+\nevent: url\ndata: \{.*\}\n\n/);
  });
});

describe('behind a proxy that buffers response bodies (Cloudflare Quick Tunnel behaviour)', () => {
  it('reproduces the bug: SSE headers arrive but no event ever does', async () => {
    const { call, openSse, setup } = await viaProxy('buffer');
    const { desktop, secret } = await setup();
    const sse = await openSse(desktop.token);
    expect(sse.status).toBe(200);
    expect(sse.contentType).toContain('text/event-stream');

    const phone = await call('POST', '/api/pairings', undefined, { secret });
    await call('POST', '/api/links', phone.token, { targetDeviceId: desktop.device.id, url: 'https://a.com/x' });
    await sleep(500);
    expect(sse.text()).toBe(''); // not even the "ready" event => client falls back to polling
  });

  it('long-polling delivers pairing and links in realtime through the buffering proxy', async () => {
    const { call, setup } = await viaProxy('buffer');
    const { desktop, secret } = await setup();

    const initial: PollResponse = await call('GET', '/api/events/poll', desktop.token);
    expect(initial.events).toEqual([]);

    // A poll is parked; pairing must complete it right away (not after the 25 s hold).
    const t0 = Date.now();
    const pairedPoll = call('GET', `/api/events/poll?cursor=${initial.cursor}`, desktop.token) as Promise<PollResponse>;
    await sleep(100);
    const phone = await call('POST', '/api/pairings', undefined, { secret });
    const afterPair = await pairedPoll;
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(afterPair.events).toEqual([expect.objectContaining({ type: 'paired' })]);

    const urlPoll = call('GET', `/api/events/poll?cursor=${afterPair.cursor}`, desktop.token) as Promise<PollResponse>;
    await sleep(100);
    await call('POST', '/api/links', phone.token, { targetDeviceId: desktop.device.id, url: 'https://a.com/x' });
    const afterUrl = await urlPoll;
    expect(afterUrl.events).toEqual([expect.objectContaining({ type: 'url', url: 'https://a.com/x' })]);
  });

  it('does not lose events published between two polls, and keeps devices isolated', async () => {
    const { call, setup } = await viaProxy('buffer');
    const { desktop, secret } = await setup();
    const other = await call('POST', '/api/devices', undefined, { kind: 'desktop', name: 'Other' });
    const { cursor } = await call('GET', '/api/events/poll', desktop.token);
    const otherCursor = (await call('GET', '/api/events/poll', other.token)).cursor;

    const phone = await call('POST', '/api/pairings', undefined, { secret });
    for (const n of [1, 2]) {
      await call('POST', '/api/links', phone.token, { targetDeviceId: desktop.device.id, url: `https://a.com/${n}` });
    }
    const res: PollResponse = await call('GET', `/api/events/poll?cursor=${cursor}`, desktop.token);
    expect(res.events.map((e) => e.type)).toEqual(['paired', 'url', 'url']);

    // The other device saw none of it (short hold via the hub directly).
    const otherRes = await app.hub.poll(other.device.id, otherCursor, null, 50, () => undefined);
    expect(otherRes.events).toEqual([]);
    // Nothing is re-delivered after the cursor advanced.
    const next = await app.hub.poll(desktop.device.id, res.cursor, null, 50, () => undefined);
    expect(next.events).toEqual([]);
  });

  it('asks the client to resync on an unknown or stale cursor', async () => {
    const { call, setup } = await viaProxy('buffer');
    const { desktop } = await setup();
    const res: PollResponse = await call('GET', '/api/events/poll?cursor=oldboot:3', desktop.token);
    expect(res.reset).toBe(true);
    expect(res.events).toEqual([]);
  });

  it('a device only polling counts as online for its peers', async () => {
    const { call, setup } = await viaProxy('buffer');
    const { desktop, secret } = await setup();
    const phone = await call('POST', '/api/pairings', undefined, { secret });
    await call('GET', '/api/events/poll', desktop.token);
    const me = await call('GET', '/api/me', phone.token);
    expect(me.peers[0].online).toBe(true);
  });
});
