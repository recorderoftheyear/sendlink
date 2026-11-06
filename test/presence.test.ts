// Presence = "this destination has a healthy realtime receiver right now", not "is paired".
// Real HTTP + SSE/long-poll with shortened leases so timeouts are exercised quickly.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProxy } from '../scripts/proxy.js';
import { createApp, type App } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { SseHub } from '../src/server/hub.js';
import type { PollResponse, RealtimeEvent } from '../src/shared/protocol.js';

const TIMINGS = { pingMs: 40, sseTtlMs: 150, pollTtlMs: 250, sweepMs: 20 };
const POLL_HOLD_MS = 150;
/** Upper bound for "offline after a bounded timeout": longest TTL + a sweep + slack. */
const DETECTION_BOUND_MS = TIMINGS.pollTtlMs + 400;

let app: App;
let base: string;
const cleanups: (() => void)[] = [];

beforeEach(async () => {
  app = createApp({ ...loadConfig({}), dbPath: ':memory:', publicUrl: 'https://send.example' }, { hub: TIMINGS, pollHoldMs: POLL_HOLD_MS });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const c of cleanups.splice(0)) c();
  await app.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<number> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await sleep(10);
  }
  return Date.now() - start;
}

async function call(method: string, path: string, token?: string, body?: unknown, origin = base) {
  const res = await fetch(origin + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as any };
}

/**
 * A browser tab's SSE receiver. `acking` can be switched off to simulate a tab whose
 * browser was killed/frozen while the TCP connection (or a proxy leg) stays open.
 */
async function sseReceiver(token: string, opts: { ack?: boolean } = {}) {
  const state = { acking: opts.ack ?? true, conn: '', ended: false, events: [] as RealtimeEvent[] };
  const { body } = await call('POST', '/api/stream-tickets', token);
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/events?ticket=${body.ticket}`, { signal: ctrl.signal });
  const reader = res.body!.getReader();
  void (async () => {
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
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
            state.conn = parsed.conn;
            if (state.acking) call('POST', '/api/presence', token, { conn: parsed.conn }).catch(() => undefined); // may race teardown
          } else state.events.push(parsed);
        }
      }
    } catch {
      // aborted
    }
    state.ended = true;
  })();
  const close = () => ctrl.abort();
  cleanups.push(close);
  return { state, close };
}

/** A tab in long-poll mode (e.g. behind a Cloudflare Quick Tunnel). `stop()` = the browser is killed. */
function pollReceiver(token: string, origin = base) {
  const state = { running: true, conn: null as string | null, events: [] as RealtimeEvent[] };
  void (async () => {
    let cursor: string | null = null;
    while (state.running) {
      const q = new URLSearchParams();
      if (cursor) q.set('cursor', cursor);
      if (state.conn) q.set('conn', state.conn);
      const res = await call('GET', `/api/events/poll?${q}`, token, undefined, origin).catch(() => null);
      if (!res || res.status !== 200) break;
      const body = res.body as PollResponse;
      cursor = body.cursor;
      state.conn = body.conn;
      state.events.push(...body.events);
    }
  })();
  const stop = () => (state.running = false);
  cleanups.push(stop);
  return { state, stop };
}

async function setup() {
  const register = async (name: string, clientLabel: string) =>
    (await call('POST', '/api/devices', undefined, { kind: 'desktop', name, clientLabel })).body;
  const chrome = await register('Linux PC', 'Chrome');
  const firefox = await register('Linux PC', 'Firefox');
  const pairWith = async (desktopToken: string, phoneToken?: string) => {
    const { pairUrl } = (await call('POST', '/api/pairing-tokens', desktopToken)).body;
    const secret = new URL(pairUrl).hash.slice('#pair='.length);
    return (await call('POST', '/api/pairings', phoneToken, { secret, deviceName: 'Galaxy S24', clientType: 'pwa' })).body;
  };
  const phone = await pairWith(chrome.token);
  await pairWith(firefox.token, phone.token);

  const peerOnline = async (desktopId: string) =>
    ((await call('GET', '/api/me', phone.token)).body.peers as { id: string; online: boolean }[]).find(
      (p) => p.id === desktopId,
    )!.online;
  const send = async (desktopId: string, url: string) =>
    (await call('POST', '/api/links', phone.token, { targetDeviceId: desktopId, url })).body as {
      url: string;
      delivered: boolean;
    };
  return { chrome, firefox, phone, peerOnline, send };
}

describe('presence over SSE', () => {
  it('an active receiver (acknowledging) is Online; a merely paired desktop is not', async () => {
    const { chrome, firefox, peerOnline } = await setup();
    expect(await peerOnline(chrome.device.id)).toBe(false); // paired, no receiver
    await sseReceiver(chrome.token);
    await until(() => peerOnline(chrome.device.id));
    expect(await peerOnline(firefox.device.id)).toBe(false);
  });

  it('closing the browser (connection closed) => Offline right away', async () => {
    const { firefox, peerOnline } = await setup();
    const tab = await sseReceiver(firefox.token);
    await until(() => peerOnline(firefox.device.id));
    tab.close();
    const took = await until(async () => !(await peerOnline(firefox.device.id)));
    expect(took).toBeLessThan(DETECTION_BOUND_MS);
  });

  it('a killed browser whose connection stays open (stale SSE) => Offline after a bounded time, and the stream is dropped', async () => {
    const { firefox, peerOnline } = await setup();
    const tab = await sseReceiver(firefox.token);
    await until(() => peerOnline(firefox.device.id));
    tab.state.acking = false; // browser gone; TCP/proxy leg still open, server writes still "succeed"
    const took = await until(async () => !(await peerOnline(firefox.device.id)));
    expect(took).toBeLessThan(DETECTION_BOUND_MS);
    await until(() => tab.state.ended); // server cleaned the stale stream up
  });

  it('an SSE stream that never proves delivery (buffered by a proxy) never counts as Online', async () => {
    const { firefox, peerOnline, send } = await setup();
    await sseReceiver(firefox.token, { ack: false });
    await sleep(TIMINGS.sseTtlMs / 2);
    expect(await peerOnline(firefox.device.id)).toBe(false);
    expect((await send(firefox.device.id, 'https://a.com/x')).delivered).toBe(false);
  });

  it('sending while stale returns delivered:false; reopening => Online again and the queued link is there', async () => {
    const { firefox, phone, peerOnline, send } = await setup();
    const tab = await sseReceiver(firefox.token);
    await until(() => peerOnline(firefox.device.id));
    tab.state.acking = false;
    await until(async () => !(await peerOnline(firefox.device.id)));

    const res = await send(firefox.device.id, 'https://youtube.com/shorts/queued');
    expect(res.delivered).toBe(false);

    // Firefox is reopened: new receiver, Online, and the link comes from store-and-forward.
    await sseReceiver(firefox.token);
    await until(() => peerOnline(firefox.device.id));
    const history = await call('GET', '/api/links', firefox.token);
    expect(history.body.links.map((l: { url: string }) => l.url)).toEqual(['https://youtube.com/shorts/queued']);
    expect((await send(firefox.device.id, 'https://youtube.com/shorts/live')).delivered).toBe(true);
    void phone;
  });

  it('Chrome staying online never makes Firefox (same PC) appear online', async () => {
    const { chrome, firefox, peerOnline, send } = await setup();
    await sseReceiver(chrome.token);
    const ff = await sseReceiver(firefox.token);
    await until(async () => (await peerOnline(chrome.device.id)) && (await peerOnline(firefox.device.id)));
    ff.close();
    await until(async () => !(await peerOnline(firefox.device.id)));
    await sleep(TIMINGS.sseTtlMs + 50); // well past a lease: Chrome keeps acknowledging
    expect(await peerOnline(chrome.device.id)).toBe(true);
    expect(await peerOnline(firefox.device.id)).toBe(false);
    expect((await send(chrome.device.id, 'https://a.com/c')).delivered).toBe(true);
    expect((await send(firefox.device.id, 'https://a.com/f')).delivered).toBe(false);
  });

  it('an explicit "leave" (page closing) => Offline immediately', async () => {
    const { firefox, peerOnline } = await setup();
    const tab = await sseReceiver(firefox.token);
    await until(() => peerOnline(firefox.device.id));
    await call('POST', '/api/presence', firefox.token, { conn: tab.state.conn, state: 'leave' });
    expect(await peerOnline(firefox.device.id)).toBe(false);
  });

  it('presence changes are pushed live to the paired phone', async () => {
    const { firefox, phone } = await setup();
    const phoneTab = await sseReceiver(phone.token);
    const ff = await sseReceiver(firefox.token);
    const presence = () => phoneTab.state.events.filter((e) => e.type === 'presence' && e.deviceId === firefox.device.id);
    await until(() => presence().length === 1);
    ff.close();
    await until(() => presence().length === 2);
    await sseReceiver(firefox.token);
    await until(() => presence().length === 3);
    expect(presence().map((e) => (e as { online: boolean }).online)).toEqual([true, false, true]);
  });

  it('acknowledging an unknown connection is refused (client must reconnect)', async () => {
    const { firefox } = await setup();
    expect((await call('POST', '/api/presence', firefox.token, { conn: 'nope-nope-nope' })).status).toBe(404);
    expect((await call('POST', '/api/presence', undefined, { conn: 'x' })).status).toBe(401);
  });
});

describe('presence over long-polling (buffering proxy, e.g. Cloudflare Quick Tunnel)', () => {
  let proxyBase: string;
  let proxy: Server;

  beforeEach(async () => {
    proxy = createProxy((app.server.address() as AddressInfo).port, 'buffer');
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    proxyBase = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  });
  afterEach(() => {
    proxy.closeAllConnections();
    proxy.close();
  });

  it('polling receiver = Online; killed browser (no more polls) => Offline within the lease', async () => {
    const { firefox, peerOnline, send } = await setup();
    const tab = pollReceiver(firefox.token, proxyBase);
    await until(() => peerOnline(firefox.device.id));
    await sleep(POLL_HOLD_MS * 2); // several poll cycles: stays online
    expect(await peerOnline(firefox.device.id)).toBe(true);

    tab.stop(); // killed: the last parked poll ends by timeout — that must not renew the lease
    const took = await until(async () => !(await peerOnline(firefox.device.id)));
    expect(took).toBeLessThan(DETECTION_BOUND_MS);
    expect((await send(firefox.device.id, 'https://a.com/while-closed')).delivered).toBe(false);
  });

  it('delivers live to a polling receiver (delivered:true) and the link arrives by poll', async () => {
    const { firefox, peerOnline, send } = await setup();
    const tab = pollReceiver(firefox.token, proxyBase);
    await until(() => peerOnline(firefox.device.id));
    expect((await send(firefox.device.id, 'https://a.com/live')).delivered).toBe(true);
    await until(() => tab.state.events.some((e) => e.type === 'url' && e.url === 'https://a.com/live'));
  });
});

describe('hub leases (deterministic clock)', () => {
  it('a poll that ends by timeout does not renew the lease; only a new request does', async () => {
    let t = 0;
    const hub = new SseHub({ ...TIMINGS, pollTtlMs: 30_000, sweepMs: 60_000, pingMs: 60_000 }, () => t);
    const closers: ((aborted: boolean) => void)[] = [];
    const first = await hub.poll('ff', null, null, 20_000, () => undefined);
    const parked = hub.poll('ff', first.cursor, first.conn, 20_000, (cb) => closers.push(cb));
    expect(hub.isOnline('ff')).toBe(true);

    t += 20_000;
    closers[0]!(false); // hold expired, we answered — the client never polls again
    await parked;
    t += 10_000; // 30 s after the last *arrival*
    expect(hub.isOnline('ff')).toBe(false);

    await hub.poll('ff', first.cursor, first.conn, 0, () => undefined).catch(() => undefined);
    expect(hub.isOnline('ff')).toBe(true); // a real arrival renews it
    hub.close();
  });

  it('a poll abandoned by the client (closed before the answer) ends the lease at once', async () => {
    const hub = new SseHub({ sweepMs: 60_000, pingMs: 60_000 });
    const changes: boolean[] = [];
    hub.onPresenceChange((_, online) => changes.push(online));
    const first = await hub.poll('ff', null, null, 20_000, () => undefined);
    const closers: ((aborted: boolean) => void)[] = [];
    const parked = hub.poll('ff', first.cursor, first.conn, 20_000, (cb) => closers.push(cb));
    closers[0]!(true);
    await parked;
    expect(hub.isOnline('ff')).toBe(false);
    expect(changes).toEqual([true, false]);
    hub.close();
  });
});
