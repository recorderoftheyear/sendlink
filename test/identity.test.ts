// physical_device vs client model, rename, and migration of pre-existing databases.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, openDatabase } from '../src/server/db.js';
import { hashSecret } from '../src/server/security.js';
import { displayName, SendLinkService, type Publisher } from '../src/server/service.js';
import type { RealtimeEvent } from '../src/shared/protocol.js';

const events: { deviceId: string; event: RealtimeEvent }[] = [];
const pub: Publisher = { publish: (deviceId, event) => void events.push({ deviceId, event }), isOnline: () => false };
let svc: SendLinkService;

beforeEach(() => {
  events.length = 0;
  svc = new SendLinkService(openDatabase(':memory:'), pub, { pairingTtlMs: 60_000 });
});

function pairPhone(desktopId: string, profile: Record<string, unknown> = {}) {
  const { secret } = svc.createPairingToken(desktopId);
  return svc.redeemPairing({ secret }, null, profile);
}

describe('display names', () => {
  it('browser clients show "<device> · <browser>", the installed app shows the device only', () => {
    expect(displayName('Linux PC', 'browser', 'Chrome')).toBe('Linux PC · Chrome');
    expect(displayName('Galaxy S24', 'pwa', 'Chrome')).toBe('Galaxy S24');
    expect(displayName('Linux PC', 'browser', null)).toBe('Linux PC');
  });

  it('two browsers on the same PC are two distinct, separately paired destinations', () => {
    const chrome = svc.registerDevice('desktop', { name: 'Linux PC', clientLabel: 'Chrome' });
    const firefox = svc.registerDevice('desktop', { name: 'Linux PC', clientLabel: 'Firefox' });
    const phone = pairPhone(chrome.device.id, { name: 'Galaxy S24', clientType: 'pwa', clientLabel: 'Chrome' });
    const { secret } = svc.createPairingToken(firefox.device.id);
    svc.redeemPairing({ secret }, phone.device);

    expect(svc.listPeers(phone.device.id).map((p) => p.name).sort()).toEqual(['Linux PC · Chrome', 'Linux PC · Firefox']);
    expect(svc.listPeers(chrome.device.id).map((p) => p.name)).toEqual(['Galaxy S24']);
    // No inferred grouping: each client has its own physical device record.
    expect(chrome.device.physicalDevice.id).not.toBe(firefox.device.physicalDevice.id);
  });

  it('sanitizes client labels and ignores unknown client types', () => {
    const { device } = svc.registerDevice('desktop', { clientLabel: '  Fire\u0000fox  '.padEnd(60, 'x'), clientType: 'root' });
    expect(device.client.type).toBe('browser');
    expect(device.client.label!.length).toBeLessThanOrEqual(24);
    expect(device.client.label).not.toContain('\u0000');
  });
});

describe('canonical mobile identity (installed PWA)', () => {
  it('a Share Target launch of the installed app reuses the same client and credential', () => {
    const desktop = svc.registerDevice('desktop', { name: 'Linux PC', clientLabel: 'Chrome' });
    const phone = pairPhone(desktop.device.id, { name: 'Android phone', clientLabel: 'Chrome' });
    // First launch as the installed app upgrades the client: same id, same token.
    const upgraded = svc.updateDevice(phone.device.id, { clientType: 'pwa' });
    expect(upgraded.id).toBe(phone.device.id);
    expect(upgraded.name).toBe('Android phone');
    expect(svc.authenticate(phone.token!)?.id).toBe(phone.device.id);
    // Re-scanning a QR with the existing credential never creates a second identity.
    const again = svc.redeemPairing({ secret: svc.createPairingToken(desktop.device.id).secret }, upgraded);
    expect(again.token).toBeUndefined();
    expect(again.device.id).toBe(phone.device.id);
  });

  it('/m opened in another browser (isolated storage) is a separate, visibly different client', () => {
    const desktop = svc.registerDevice('desktop', { name: 'Linux PC', clientLabel: 'Chrome' });
    const app = pairPhone(desktop.device.id, { name: 'Galaxy S24', clientType: 'pwa', clientLabel: 'Chrome' });
    const samsung = pairPhone(desktop.device.id, { name: 'Android phone', clientLabel: 'Samsung Internet' });
    expect(samsung.device.id).not.toBe(app.device.id);
    expect(samsung.token).not.toBe(app.token);
    expect(svc.listPeers(desktop.device.id).map((p) => p.name).sort()).toEqual([
      'Android phone · Samsung Internet',
      'Galaxy S24',
    ]);
  });
});

describe('rename', () => {
  it('renames the physical device, keeps the browser label, and notifies paired peers', () => {
    const desktop = svc.registerDevice('desktop', { name: 'Linux PC', clientLabel: 'Chrome' });
    const phone = pairPhone(desktop.device.id, { name: 'Android phone', clientType: 'pwa' });
    events.length = 0;

    const renamed = svc.updateDevice(desktop.device.id, { name: 'Work PC' });
    expect(renamed.name).toBe('Work PC · Chrome');
    expect(events).toEqual([{ deviceId: phone.device.id, event: { type: 'peer_updated', peer: renamed } }]);

    svc.updateDevice(phone.device.id, { name: 'Galaxy S24' });
    expect(svc.listPeers(desktop.device.id)[0]!.name).toBe('Galaxy S24');
    expect(svc.me(desktop.device.id).device.name).toBe('Work PC · Chrome');
  });

  it('an empty name keeps the current one; no-op updates notify nobody', () => {
    const desktop = svc.registerDevice('desktop', { name: 'Linux PC' });
    pairPhone(desktop.device.id);
    events.length = 0;
    expect(svc.updateDevice(desktop.device.id, { name: '   ' }).name).toBe('Linux PC');
    expect(events).toEqual([]);
  });

  it('new links carry the sender name at send time', () => {
    const desktop = svc.registerDevice('desktop', { name: 'Linux PC' });
    const phone = pairPhone(desktop.device.id, { name: 'Galaxy S24', clientType: 'pwa' });
    expect(svc.sendLink(phone.device.id, desktop.device.id, 'https://a.com').senderName).toBe('Galaxy S24');
  });

  it('deleting the last client of a physical device removes that physical device', () => {
    const desktop = svc.registerDevice('desktop', { name: 'Linux PC' });
    svc.deleteDevice(desktop.device.id);
    const db = (svc as unknown as { db: Database.Database }).db;
    expect(db.prepare('SELECT count(*) AS n FROM physical_devices').get()).toEqual({ n: 0 });
  });
});

describe('migration of an existing v1 database', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'sendlink-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps credentials, names, pairings and history; no re-pairing needed', () => {
    const path = join(dir, 'legacy.db');
    // A database exactly as the first MVP created it (unversioned, v1 schema).
    const legacy = new Database(path);
    MIGRATIONS[0]!(legacy);
    expect(legacy.pragma('user_version', { simple: true })).toBe(0);
    const ins = legacy.prepare(
      `INSERT INTO devices (id, name, kind, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, 1, 1)`,
    );
    ins.run('dev_desk', 'Linux PC', 'desktop', hashSecret('sld_desk'));
    ins.run('dev_phone', 'Android phone', 'mobile', hashSecret('sld_phone'));
    legacy.prepare(`INSERT INTO pairings (id, device_a, device_b, created_at) VALUES ('pair_1', 'dev_desk', 'dev_phone', 1)`).run();
    legacy
      .prepare(`INSERT INTO links (id, target_id, sender_id, sender_name, url, created_at) VALUES ('lnk_1', 'dev_desk', 'dev_phone', 'Android phone', 'https://a.com/', 1)`)
      .run();
    legacy.close();

    const db = openDatabase(path);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    const migrated = new SendLinkService(db, pub, { pairingTtlMs: 60_000 });

    const desk = migrated.authenticate('sld_desk')!;
    expect(desk).toMatchObject({ id: 'dev_desk', name: 'Linux PC', client: { type: 'browser', label: null } });
    expect(migrated.authenticate('sld_phone')?.name).toBe('Android phone');
    expect(migrated.listPeers('dev_desk').map((p) => p.id)).toEqual(['dev_phone']);
    expect(migrated.listLinks('dev_desk').map((l) => l.url)).toEqual(['https://a.com/']);
    expect(migrated.sendLink('dev_phone', 'dev_desk', 'https://b.com').targetDeviceId).toBe('dev_desk');

    // The client then fills in its browser label on next launch.
    expect(migrated.updateDevice('dev_desk', { clientLabel: 'Chrome' }).name).toBe('Linux PC · Chrome');

    // Re-opening is a no-op.
    db.close();
    const reopened = openDatabase(path);
    expect(new SendLinkService(reopened, pub, { pairingTtlMs: 60_000 }).authenticate('sld_desk')?.name).toBe('Linux PC · Chrome');
    reopened.close();
  });
});
