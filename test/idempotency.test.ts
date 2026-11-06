// Increment 1: message_id + idempotent link submission + the client send pipeline.
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiRequestError, type ApiClient } from '../src/client/api.js';
import { newMessageId, relayTransport, send, type Transport } from '../src/client/send.js';
import { createApp, type App } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { MIGRATIONS, openDatabase } from '../src/server/db.js';
import { hashSecret } from '../src/server/security.js';
import { AppError, SendLinkService, type Publisher } from '../src/server/service.js';
import { MESSAGE_ID_PATTERN, type RealtimeEvent } from '../src/shared/protocol.js';

const published: { deviceId: string; event: RealtimeEvent }[] = [];
const pub: Publisher = { publish: (deviceId, event) => void published.push({ deviceId, event }), isOnline: () => false };
const urlEvents = () => published.filter((p) => p.event.type === 'url');

function pairedService() {
  const svc = new SendLinkService(openDatabase(':memory:'), pub, { pairingTtlMs: 60_000 });
  const desktop = svc.registerDevice('desktop', { name: 'Linux PC', clientLabel: 'Chrome' });
  const pairPhone = (name: string) =>
    svc.redeemPairing({ secret: svc.createPairingToken(desktop.device.id).secret }, null, { name });
  return { svc, desktop, phoneA: pairPhone('Galaxy S24'), phoneB: pairPhone('Pixel') };
}

const ID = 'msg_AAAAAAAAAAAAAAAAAAAAAA';

describe('idempotent submission (service)', () => {
  beforeEach(() => void (published.length = 0));

  it('same sender + same messageId repeated = one link, one history entry, one realtime publication', () => {
    const { svc, desktop, phoneA } = pairedService();
    published.length = 0;
    const input = { targetId: desktop.device.id, url: 'https://youtube.com/shorts/x', messageId: ID };

    const first = svc.submitLink(phoneA.device.id, input);
    const second = svc.submitLink(phoneA.device.id, input);
    const third = svc.submitLink(phoneA.device.id, { ...input, url: 'https://youtube.com/shorts/x' });

    expect([first.duplicate, second.duplicate, third.duplicate]).toEqual([false, true, true]);
    expect(second.message).toEqual(first.message);
    expect(first.message.messageId).toBe(ID);
    expect(svc.listLinks(desktop.device.id)).toHaveLength(1);
    expect(urlEvents()).toHaveLength(1);
  });

  it('different senders may use the same messageId without collision', () => {
    const { svc, desktop, phoneA, phoneB } = pairedService();
    const a = svc.submitLink(phoneA.device.id, { targetId: desktop.device.id, url: 'https://a.com/', messageId: ID });
    const b = svc.submitLink(phoneB.device.id, { targetId: desktop.device.id, url: 'https://b.com/', messageId: ID });
    expect(a.duplicate || b.duplicate).toBe(false);
    expect(a.message.id).not.toBe(b.message.id);
    expect(svc.listLinks(desktop.device.id).map((l) => l.url).sort()).toEqual(['https://a.com/', 'https://b.com/']);
  });

  it('reusing a messageId for a different link or destination is refused (409), nothing stored', () => {
    const { svc, desktop, phoneA } = pairedService();
    const other = svc.registerDevice('desktop', { name: 'Work PC' });
    svc.redeemPairing({ secret: svc.createPairingToken(other.device.id).secret }, phoneA.device);
    svc.submitLink(phoneA.device.id, { targetId: desktop.device.id, url: 'https://a.com/', messageId: ID });

    const conflict = (fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        return (err as AppError).status;
      }
      return 0;
    };
    expect(conflict(() => svc.submitLink(phoneA.device.id, { targetId: desktop.device.id, url: 'https://other.com/', messageId: ID }))).toBe(409);
    expect(conflict(() => svc.submitLink(phoneA.device.id, { targetId: other.device.id, url: 'https://a.com/', messageId: ID }))).toBe(409);
    expect(svc.listLinks(desktop.device.id)).toHaveLength(1);
    expect(svc.listLinks(other.device.id)).toHaveLength(0);
  });

  it('rejects malformed messageIds; without messageId the legacy behaviour is unchanged', () => {
    const { svc, desktop, phoneA } = pairedService();
    for (const bad of ['', 'msg_short', 'x'.repeat(30), 'msg_' + '!'.repeat(20), 42]) {
      expect(() => svc.submitLink(phoneA.device.id, { targetId: desktop.device.id, url: 'https://a.com/', messageId: bad })).toThrow(
        'messageId is malformed',
      );
    }
    svc.submitLink(phoneA.device.id, { targetId: desktop.device.id, url: 'https://a.com/' });
    svc.submitLink(phoneA.device.id, { targetId: desktop.device.id, url: 'https://a.com/' });
    expect(svc.listLinks(desktop.device.id).map((l) => l.messageId)).toEqual([null, null]);
  });
});

describe('client send pipeline', () => {
  it('generates well-formed, unique messageIds', () => {
    const ids = new Set(Array.from({ length: 1000 }, newMessageId));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(MESSAGE_ID_PATTERN);
  });

  const fakeApi = (script: (() => unknown)[]) => {
    const calls: unknown[] = [];
    const api = {
      async request(_method: string, _path: string, body?: unknown) {
        calls.push(body);
        const step = script.shift();
        if (!step) throw new Error('unexpected call');
        return step();
      },
    } as unknown as ApiClient;
    return { api, calls };
  };
  const link = { messageId: ID, targetDeviceId: 'dev_x', url: 'https://a.com/' };

  it('retries an ambiguous failure with the SAME messageId', async () => {
    const { api, calls } = fakeApi([
      () => {
        throw new ApiRequestError(0, 'network', 'lost');
      },
      () => {
        throw new ApiRequestError(502, 'http_error', 'bad gateway');
      },
      () => ({ delivered: true, duplicate: true }),
    ]);
    const outcome = await send(link, [relayTransport(api, [1, 1])]);
    expect(outcome).toEqual({ transport: 'relay', status: 'delivered' });
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => (c as { messageId: string }).messageId))).toEqual(new Set([ID]));
  });

  it('does not retry a definitive rejection, and reports queued when the destination is offline', async () => {
    const rejected = fakeApi([
      () => {
        throw new ApiRequestError(403, 'not_paired', 'no');
      },
    ]);
    await expect(send(link, [relayTransport(rejected.api, [1, 1])])).rejects.toMatchObject({ status: 403 });
    expect(rejected.calls).toHaveLength(1);

    const queued = fakeApi([() => ({ delivered: false, duplicate: false })]);
    expect(await send(link, [relayTransport(queued.api)])).toEqual({ transport: 'relay', status: 'queued' });
  });

  it('tries transports in order and returns the first success', async () => {
    const failing: Transport = { name: 'first', send: async () => Promise.reject(new Error('nope')) };
    const ok: Transport = { name: 'second', send: async () => ({ transport: 'second', status: 'delivered' }) };
    expect(await send(link, [failing, ok])).toEqual({ transport: 'second', status: 'delivered' });
  });
});

describe('over HTTP', () => {
  let app: App;
  let base: string;
  const extra: Server[] = [];

  beforeEach(async () => {
    app = createApp({ ...loadConfig({}), dbPath: ':memory:', publicUrl: 'https://send.example' });
    await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    for (const s of extra.splice(0)) {
      s.closeAllConnections();
      s.close();
    }
    await app.close();
  });

  async function call(method: string, path: string, token?: string, body?: unknown, origin = base) {
    const res = await fetch(origin + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as any };
  }

  async function setup() {
    const desktop = (await call('POST', '/api/devices', undefined, { kind: 'desktop', name: 'Linux PC' })).body;
    const { pairUrl } = (await call('POST', '/api/pairing-tokens', desktop.token)).body;
    const phone = (await call('POST', '/api/pairings', undefined, { secret: new URL(pairUrl).hash.slice(6) })).body;
    const events: RealtimeEvent[] = [];
    app.hub.publish = ((orig) => (deviceId: string, event: RealtimeEvent) => {
      if (deviceId === desktop.device.id) events.push(event);
      orig(deviceId, event);
    })(app.hub.publish.bind(app.hub));
    return { desktop, phone, events };
  }

  it('repeated POST: 201 then 200 duplicate, one history entry, one realtime event', async () => {
    const { desktop, phone, events } = await setup();
    const body = { messageId: ID, targetDeviceId: desktop.device.id, url: 'https://youtube.com/shorts/x' };
    const first = await call('POST', '/api/links', phone.token, body);
    const second = await call('POST', '/api/links', phone.token, body);
    expect([first.status, second.status]).toEqual([201, 200]);
    expect([first.body.duplicate, second.body.duplicate]).toEqual([false, true]);
    expect(second.body.id).toBe(first.body.id);
    expect((await call('GET', '/api/links', desktop.token)).body.links).toHaveLength(1);
    expect(events.filter((e) => e.type === 'url')).toHaveLength(1);
    expect((await call('POST', '/api/links', phone.token, { ...body, url: 'https://other.com' })).status).toBe(409);
  });

  it('retry after an ambiguous network failure (server stored it, response lost) creates no duplicate', async () => {
    const { desktop, phone, events } = await setup();
    // Proxy that forwards the request, waits for the server's full answer, then kills the
    // client connection: the server has stored the link but the client sees a network error.
    const port = (app.server.address() as AddressInfo).port;
    const dropper = createServer((req, res) => {
      const up = request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers }, (upRes) => {
        upRes.resume();
        upRes.on('end', () => res.socket?.destroy());
      });
      req.pipe(up);
    });
    extra.push(dropper);
    await new Promise<void>((r) => dropper.listen(0, '127.0.0.1', r));
    const dropperBase = `http://127.0.0.1:${(dropper.address() as AddressInfo).port}`;

    const body = { messageId: ID, targetDeviceId: desktop.device.id, url: 'https://reddit.com/r/x' };
    await expect(call('POST', '/api/links', phone.token, body, dropperBase)).rejects.toThrow(); // ambiguous
    expect((await call('GET', '/api/links', desktop.token)).body.links).toHaveLength(1); // it did land

    const retry = await call('POST', '/api/links', phone.token, body);
    expect(retry.status).toBe(200);
    expect(retry.body.duplicate).toBe(true);
    expect((await call('GET', '/api/links', desktop.token)).body.links).toHaveLength(1);
    expect(events.filter((e) => e.type === 'url')).toHaveLength(1);
  });

  it('validates messageId at the API', async () => {
    const { desktop, phone } = await setup();
    const res = await call('POST', '/api/links', phone.token, { messageId: 'nope', targetDeviceId: desktop.device.id, url: 'https://a.com' });
    expect(res.status).toBe(400);
  });
});

describe('migration v3 (message_id)', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'sendlink-v3-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('upgrades a v2 database without touching existing history', () => {
    const path = join(dir, 'v2.db');
    const v2 = new Database(path);
    v2.pragma('foreign_keys = ON');
    MIGRATIONS[0]!(v2);
    MIGRATIONS[1]!(v2);
    v2.pragma('user_version = 2');
    v2.prepare(`INSERT INTO physical_devices VALUES ('phy_d', 'Linux PC', 'desktop', 1), ('phy_p', 'Galaxy S24', 'mobile', 1)`).run();
    const dev = v2.prepare(`INSERT INTO devices (id, kind, token_hash, physical_device_id, client_type, client_label, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1)`);
    dev.run('dev_d', 'desktop', hashSecret('sld_d'), 'phy_d', 'browser', 'Chrome');
    dev.run('dev_p', 'mobile', hashSecret('sld_p'), 'phy_p', 'pwa', 'Chrome');
    v2.prepare(`INSERT INTO pairings VALUES ('pair_1', 'dev_d', 'dev_p', 1)`).run();
    v2.prepare(`INSERT INTO links (id, target_id, sender_id, sender_name, url, created_at) VALUES ('lnk_old', 'dev_d', 'dev_p', 'Galaxy S24', 'https://old.example/', 1)`).run();
    v2.close();

    const db = openDatabase(path);
    expect(db.pragma('user_version', { simple: true })).toBe(3);
    const svc = new SendLinkService(db, pub, { pairingTtlMs: 60_000 });
    expect(svc.listLinks('dev_d')).toEqual([expect.objectContaining({ id: 'lnk_old', messageId: null, url: 'https://old.example/' })]);
    svc.submitLink('dev_p', { targetId: 'dev_d', url: 'https://new.example/', messageId: ID });
    svc.submitLink('dev_p', { targetId: 'dev_d', url: 'https://new.example/', messageId: ID });
    expect(svc.listLinks('dev_d').map((l) => l.url)).toEqual(['https://new.example/', 'https://old.example/']);
    db.close();
  });
});
