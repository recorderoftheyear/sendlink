import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/server/db.js';
import { AppError, SendLinkService, type Publisher } from '../src/server/service.js';
import type { RealtimeEvent } from '../src/shared/protocol.js';

class RecordingPublisher implements Publisher {
  events: { deviceId: string; event: RealtimeEvent }[] = [];
  publish(deviceId: string, event: RealtimeEvent) {
    this.events.push({ deviceId, event });
  }
  isOnline() {
    return false;
  }
  to(deviceId: string) {
    return this.events.filter((e) => e.deviceId === deviceId).map((e) => e.event);
  }
}

const TTL = 120_000;
let now: number;
let pub: RecordingPublisher;
let svc: SendLinkService;

beforeEach(() => {
  now = Date.UTC(2026, 0, 1);
  pub = new RecordingPublisher();
  svc = new SendLinkService(openDatabase(':memory:'), pub, { pairingTtlMs: TTL, now: () => now });
});

function expectAppError(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
    return;
  }
  throw new Error(`expected AppError ${code}`);
}

/** Desktop + phone paired via the QR secret. */
function pairedSetup() {
  const desktop = svc.registerDevice('desktop', { name: 'Work PC' });
  const { secret } = svc.createPairingToken(desktop.device.id);
  const phone = svc.redeemPairing({ secret }, null, { name: 'Pixel', clientLabel: 'Chrome' });
  return { desktop, phone: { device: phone.device, token: phone.token! } };
}

describe('devices', () => {
  it('creates a device with an unpredictable token that authenticates', () => {
    const a = svc.registerDevice('desktop', { name: 'Work PC' });
    const b = svc.registerDevice('desktop', { name: 'Home PC' });
    expect(a.token).toMatch(/^sld_[\w-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.device.id).not.toBe(b.device.id);
    expect(svc.authenticate(a.token)).toEqual(a.device);
    expect(svc.authenticate('sld_nope')).toBeNull();
    expect(svc.authenticate(undefined)).toBeNull();
  });

  it('sanitizes device names', () => {
    const { device } = svc.registerDevice('desktop', { name: '  <b>PC</b>\u0000\n  x ' });
    expect(device.name).toBe('<b>PC</b> x'); // stored as text; clients render with textContent
    expect(svc.registerDevice('desktop', { name: '' }).device.name).toBe('My Computer');
    expect(svc.registerDevice('desktop', { name: 'a'.repeat(100) }).device.name).toHaveLength(40);
  });

  it('never stores tokens in clear text', () => {
    const { token } = svc.registerDevice('desktop', { name: 'PC' });
    const db = (svc as unknown as { db: ReturnType<typeof openDatabase> }).db;
    const dump = JSON.stringify(db.prepare('SELECT * FROM devices').all());
    expect(dump).not.toContain(token);
  });
});

describe('pairing tokens', () => {
  it('generates a long secret and an 8-char code that expire after the TTL', () => {
    const { device } = svc.registerDevice('desktop', { name: 'PC' });
    const t = svc.createPairingToken(device.id);
    expect(t.secret.length).toBeGreaterThanOrEqual(43);
    expect(t.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(t.expiresAt).toBe(now + TTL);
  });

  it('rejects an expired token', () => {
    const { device } = svc.registerDevice('desktop', { name: 'PC' });
    const { secret } = svc.createPairingToken(device.id);
    now += TTL;
    expectAppError(() => svc.redeemPairing({ secret }, null), 'pairing_expired');
    expect(svc.listPeers(device.id)).toEqual([]);
  });

  it('is single use', () => {
    const { device } = svc.registerDevice('desktop', { name: 'PC' });
    const { secret, code } = svc.createPairingToken(device.id);
    svc.redeemPairing({ secret }, null);
    expectAppError(() => svc.redeemPairing({ secret }, null), 'pairing_invalid');
    expectAppError(() => svc.redeemPairing({ code }, null), 'pairing_invalid');
  });

  it('invalidates the previous token when a new one is created', () => {
    const { device } = svc.registerDevice('desktop', { name: 'PC' });
    const first = svc.createPairingToken(device.id);
    svc.createPairingToken(device.id);
    expectAppError(() => svc.redeemPairing({ secret: first.secret }, null), 'pairing_invalid');
  });

  it('rejects unknown secrets and missing credentials', () => {
    expectAppError(() => svc.redeemPairing({ secret: 'x'.repeat(43) }, null), 'pairing_invalid');
    expectAppError(() => svc.redeemPairing({}, null), 'invalid_request');
  });
});

describe('pairing', () => {
  it('pairs a new phone via the QR secret, issues it a credential and notifies the desktop', () => {
    const { desktop, phone } = pairedSetup();
    expect(phone.device.kind).toBe('mobile');
    expect(phone.device.name).toBe('Pixel · Chrome'); // browser client until installed as app
    expect(svc.authenticate(phone.token)).toEqual(phone.device);
    expect(svc.isPaired(desktop.device.id, phone.device.id)).toBe(true);
    expect(svc.listPeers(desktop.device.id).map((p) => p.id)).toEqual([phone.device.id]);
    expect(svc.listPeers(phone.device.id).map((p) => p.id)).toEqual([desktop.device.id]);
    expect(pub.to(desktop.device.id)).toEqual([{ type: 'paired', peer: phone.device }]);
  });

  it('pairs via the short code, case/format-insensitively', () => {
    const desktop = svc.registerDevice('desktop', { name: 'PC' });
    const { code } = svc.createPairingToken(desktop.device.id);
    const typed = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase();
    const res = svc.redeemPairing({ code: typed }, null);
    expect(res.peer.id).toBe(desktop.device.id);
  });

  it('lets an existing phone pair with a second computer without a new credential', () => {
    const { phone } = pairedSetup();
    const home = svc.registerDevice('desktop', { name: 'Home PC' });
    const { secret } = svc.createPairingToken(home.device.id);
    const res = svc.redeemPairing({ secret }, phone.device);
    expect(res.token).toBeUndefined();
    expect(res.device).toEqual(phone.device);
    expect(svc.listPeers(phone.device.id)).toHaveLength(2);
  });

  it('refuses to pair a device with itself', () => {
    const desktop = svc.registerDevice('desktop', { name: 'PC' });
    const { secret } = svc.createPairingToken(desktop.device.id);
    expectAppError(() => svc.redeemPairing({ secret }, desktop.device), 'pairing_self');
  });
});

describe('sending links', () => {
  it('delivers the URL only to the target device', () => {
    const { desktop, phone } = pairedSetup();
    const other = svc.registerDevice('desktop', { name: 'Someone else' });
    pub.events = [];

    const msg = svc.sendLink(phone.device.id, desktop.device.id, 'https://youtube.com/watch?v=abc');
    expect(msg).toMatchObject({
      v: 1,
      type: 'url',
      targetDeviceId: desktop.device.id,
      senderDeviceId: phone.device.id,
      senderName: 'Pixel · Chrome',
      url: 'https://youtube.com/watch?v=abc',
    });
    expect(pub.events).toEqual([{ deviceId: desktop.device.id, event: msg }]);
    expect(svc.listLinks(desktop.device.id)).toEqual([msg]);
    expect(svc.listLinks(other.device.id)).toEqual([]);
    expect(svc.listLinks(phone.device.id)).toEqual([]);
  });

  it.each([
    ['javascript:alert(1)', 'Only http and https links are allowed'],
    ['data:text/html,<script>alert(1)</script>', 'Only http and https links are allowed'],
    ['file:///etc/passwd', 'Only http and https links are allowed'],
    ['not a url', 'URL contains invalid characters'],
    ['https://user:pass@example.com', 'Links with embedded credentials are not allowed'],
    ['', 'URL is required'],
    [`https://example.com/${'a'.repeat(2100)}`, 'URL is too long'],
    [42, 'URL must be a string'],
  ])('rejects invalid URL %j', (url, message) => {
    const { desktop, phone } = pairedSetup();
    pub.events = [];
    expect(() => svc.sendLink(phone.device.id, desktop.device.id, url)).toThrow(message);
    expect(pub.events).toEqual([]);
    expect(svc.listLinks(desktop.device.id)).toEqual([]);
  });

  it('forbids sending to a device you are not paired with', () => {
    const { phone } = pairedSetup();
    const stranger = svc.registerDevice('desktop', { name: 'Stranger PC' });
    pub.events = [];
    expectAppError(() => svc.sendLink(phone.device.id, stranger.device.id, 'https://a.com'), 'not_paired');
    expectAppError(() => svc.sendLink(phone.device.id, 'dev_doesnotexist', 'https://a.com'), 'not_paired');
    expectAppError(() => svc.sendLink(phone.device.id, phone.device.id, 'https://a.com'), 'not_paired');
    expect(pub.events).toEqual([]);
    expect(svc.listLinks(stranger.device.id)).toEqual([]);
  });

  it('keeps history newest first, bounded, and deletable only by the recipient', () => {
    const { desktop, phone } = pairedSetup();
    const a = svc.sendLink(phone.device.id, desktop.device.id, 'https://a.com');
    now += 1000;
    const b = svc.sendLink(phone.device.id, desktop.device.id, 'https://b.com');
    expect(svc.listLinks(desktop.device.id).map((l) => l.id)).toEqual([b.id, a.id]);

    expectAppError(() => svc.deleteLink(phone.device.id, a.id), 'link_not_found');
    svc.deleteLink(desktop.device.id, a.id);
    expect(svc.listLinks(desktop.device.id).map((l) => l.id)).toEqual([b.id]);
  });

  it('trims history to the configured limit', () => {
    svc = new SendLinkService(openDatabase(':memory:'), pub, { pairingTtlMs: TTL, now: () => now, historyLimit: 3 });
    const { desktop, phone } = pairedSetup();
    for (let i = 0; i < 5; i++) {
      now += 1;
      svc.sendLink(phone.device.id, desktop.device.id, `https://e.com/${i}`);
    }
    expect(svc.listLinks(desktop.device.id).map((l) => l.url)).toEqual([
      'https://e.com/4',
      'https://e.com/3',
      'https://e.com/2',
    ]);
  });
});

describe('revocation', () => {
  it('unpairing blocks further sends and notifies both sides', () => {
    const { desktop, phone } = pairedSetup();
    svc.sendLink(phone.device.id, desktop.device.id, 'https://a.com');
    pub.events = [];

    svc.unpair(desktop.device.id, phone.device.id);
    expect(pub.to(phone.device.id)).toEqual([{ type: 'unpaired', peerId: desktop.device.id }]);
    expect(pub.to(desktop.device.id)).toEqual([{ type: 'unpaired', peerId: phone.device.id }]);
    expect(svc.listPeers(desktop.device.id)).toEqual([]);
    expectAppError(() => svc.sendLink(phone.device.id, desktop.device.id, 'https://b.com'), 'not_paired');
    expectAppError(() => svc.unpair(desktop.device.id, phone.device.id), 'not_paired');
  });

  it('either side can unpair', () => {
    const { desktop, phone } = pairedSetup();
    svc.unpair(phone.device.id, desktop.device.id);
    expect(svc.isPaired(desktop.device.id, phone.device.id)).toBe(false);
  });

  it('deleting a device revokes its credential and pairings', () => {
    const { desktop, phone } = pairedSetup();
    svc.deleteDevice(phone.device.id);
    expect(svc.authenticate(phone.token)).toBeNull();
    expect(svc.listPeers(desktop.device.id)).toEqual([]);
    expect(pub.to(desktop.device.id).at(-1)).toEqual({ type: 'unpaired', peerId: phone.device.id });
  });
});

describe('housekeeping', () => {
  it('purges expired and used pairing tokens', () => {
    const { device } = svc.registerDevice('desktop', { name: 'PC' });
    svc.createPairingToken(device.id);
    expect(svc.purgeExpiredPairingTokens()).toBe(0);
    now += TTL + 1;
    expect(svc.purgeExpiredPairingTokens()).toBe(1);
  });
});
