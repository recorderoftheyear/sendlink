import type { DB } from './db.js';
import { hashSecret, newId, normalizeCode, randomCode, randomToken, sanitizeName } from './security.js';
import { validateUrl } from '../shared/url.js';
import { MESSAGE_ID_PATTERN } from '../shared/protocol.js';
import type {
  ClientProfile,
  ClientType,
  DeviceInfo,
  DeviceKind,
  LinkMessage,
  MeResponse,
  PeerInfo,
  RealtimeEvent,
} from '../shared/protocol.js';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Delivers realtime events to the connections of one device only. */
export interface Publisher {
  publish(deviceId: string, event: RealtimeEvent): void;
  isOnline(deviceId: string): boolean;
}

export interface ServiceOptions {
  pairingTtlMs: number;
  now?: () => number;
  historyLimit?: number;
}

/** A client row joined with its physical device. */
interface DeviceRow {
  id: string;
  kind: DeviceKind;
  client_type: ClientType;
  client_label: string | null;
  physical_device_id: string;
  physical_name: string;
  created_at: number;
  last_seen_at: number;
}

const DEVICE_SELECT = `
  SELECT d.id, d.kind, d.client_type, d.client_label, d.physical_device_id,
         p.name AS physical_name, d.created_at, d.last_seen_at
  FROM devices d JOIN physical_devices p ON p.id = d.physical_device_id`;

const DEFAULT_NAMES: Record<DeviceKind, string> = { desktop: 'My Computer', mobile: 'My Phone' };
const MAX_LABEL = 24;

function cleanLabel(input: unknown): string | null {
  const label = sanitizeName(input, '').slice(0, MAX_LABEL).trim();
  return label || null;
}

function cleanClientType(input: unknown): ClientType | undefined {
  return input === 'pwa' || input === 'browser' ? input : undefined;
}

/**
 * Display name rule: the installed app *is* the device ("Galaxy S24"); a browser is one
 * destination among others on that machine ("Linux PC · Chrome").
 */
export function displayName(physicalName: string, type: ClientType, label: string | null): string {
  return type === 'pwa' || !label ? physicalName : `${physicalName} · ${label}`;
}

interface LinkRow {
  id: string;
  message_id: string | null;
  target_id: string;
  sender_id: string | null;
  sender_name: string;
  url: string;
  created_at: number;
}

const toDevice = (r: DeviceRow): DeviceInfo => ({
  id: r.id,
  name: displayName(r.physical_name, r.client_type, r.client_label),
  kind: r.kind,
  physicalDevice: { id: r.physical_device_id, name: r.physical_name },
  client: { type: r.client_type, label: r.client_label },
});

const toMessage = (r: LinkRow): LinkMessage => ({
  v: 1,
  type: 'url',
  id: r.id,
  messageId: r.message_id,
  targetDeviceId: r.target_id,
  senderDeviceId: r.sender_id,
  senderName: r.sender_name,
  url: r.url,
  timestamp: new Date(r.created_at).toISOString(),
});

const orderPair = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);

export class SendLinkService {
  private readonly now: () => number;
  private readonly historyLimit: number;

  constructor(
    private readonly db: DB,
    private readonly publisher: Publisher,
    private readonly opts: ServiceOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.historyLimit = opts.historyLimit ?? 200;
  }

  // ---------------------------------------------------------------- devices

  /**
   * Registers a new client. Each client gets its own physical device record: without
   * fingerprinting we cannot know that two browsers share a machine, so grouping clients
   * under one physical device must come from an explicit, authenticated action (future).
   */
  registerDevice(kind: DeviceKind, profile: ClientProfile | Record<string, unknown> = {}): { device: DeviceInfo; token: string } {
    const token = `sld_${randomToken()}`;
    const now = this.now();
    const id = newId('dev');
    const physicalId = newId('phy');
    this.db.transaction(() => {
      this.db
        .prepare(`INSERT INTO physical_devices (id, name, kind, created_at) VALUES (?, ?, ?, ?)`)
        .run(physicalId, sanitizeName(profile.name, DEFAULT_NAMES[kind]), kind, now);
      this.db
        .prepare(
          `INSERT INTO devices (id, kind, token_hash, physical_device_id, client_type, client_label, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          kind,
          hashSecret(token),
          physicalId,
          cleanClientType(profile.clientType) ?? 'browser',
          cleanLabel(profile.clientLabel),
          now,
          now,
        );
    })();
    return { device: this.getDevice(id), token };
  }

  /** Resolves a bearer credential to a device, or null. */
  authenticate(token: string | undefined | null): DeviceInfo | null {
    if (!token || !token.startsWith('sld_') || token.length > 100) return null;
    const row = this.db.prepare(`${DEVICE_SELECT} WHERE d.token_hash = ?`).get(hashSecret(token)) as
      | DeviceRow
      | undefined;
    if (!row) return null;
    const now = this.now();
    if (now - row.last_seen_at > 60_000) {
      this.db.prepare(`UPDATE devices SET last_seen_at = ? WHERE id = ?`).run(now, row.id);
    }
    return toDevice(row);
  }

  /**
   * A client updates its own profile: `name` renames its physical device (shared by every
   * client on it), `clientLabel`/`clientType` describe this installation.
   * Paired peers are notified so their UI updates live.
   */
  updateDevice(deviceId: string, profile: ClientProfile | Record<string, unknown>): DeviceInfo {
    const current = this.getDevice(deviceId);
    this.db.transaction(() => {
      if (profile.name !== undefined) {
        this.db
          .prepare(`UPDATE physical_devices SET name = ? WHERE id = ?`)
          .run(sanitizeName(profile.name, current.physicalDevice.name), current.physicalDevice.id);
      }
      if (profile.clientLabel !== undefined) {
        this.db.prepare(`UPDATE devices SET client_label = ? WHERE id = ?`).run(cleanLabel(profile.clientLabel), deviceId);
      }
      const type = cleanClientType(profile.clientType);
      if (type) this.db.prepare(`UPDATE devices SET client_type = ? WHERE id = ?`).run(type, deviceId);
    })();

    const updated = this.getDevice(deviceId);
    if (updated.name !== current.name) {
      // Every client on this physical device may have been renamed.
      const siblings = this.db
        .prepare(`SELECT id FROM devices WHERE physical_device_id = ?`)
        .all(current.physicalDevice.id) as { id: string }[];
      for (const { id } of siblings) {
        const peer = this.getDevice(id);
        for (const p of this.listPeers(id)) this.publisher.publish(p.id, { type: 'peer_updated', peer });
      }
    }
    return updated;
  }

  /** Permanently deletes a client: its credential, pairings and inbox (and its physical device if now empty). */
  deleteDevice(deviceId: string): void {
    const device = this.getDevice(deviceId);
    const peers = this.listPeers(deviceId);
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM devices WHERE id = ?`).run(deviceId);
      this.db
        .prepare(`DELETE FROM physical_devices WHERE id = ? AND NOT EXISTS (SELECT 1 FROM devices WHERE physical_device_id = ?)`)
        .run(device.physicalDevice.id, device.physicalDevice.id);
    })();
    for (const peer of peers) this.publisher.publish(peer.id, { type: 'unpaired', peerId: deviceId });
  }

  me(deviceId: string): MeResponse {
    return { device: this.getDevice(deviceId), peers: this.listPeers(deviceId) };
  }

  private getDevice(id: string): DeviceInfo {
    const row = this.db.prepare(`${DEVICE_SELECT} WHERE d.id = ?`).get(id) as DeviceRow | undefined;
    if (!row) throw new AppError(404, 'device_not_found', 'Device not found');
    return toDevice(row);
  }

  // ---------------------------------------------------------------- pairing

  /**
   * Creates a fresh pairing token for `deviceId` (the one displaying the QR code).
   * Any previous unused token of that device is invalidated: only one can be live.
   */
  createPairingToken(deviceId: string): { secret: string; code: string; expiresAt: number } {
    const secret = randomToken();
    const code = randomCode();
    const expiresAt = this.now() + this.opts.pairingTtlMs;
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM pairing_tokens WHERE device_id = ? AND used_at IS NULL`).run(deviceId);
      this.db
        .prepare(
          `INSERT INTO pairing_tokens (id, device_id, secret_hash, code_hash, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(newId('pt'), deviceId, hashSecret(secret), hashSecret(code), expiresAt);
    })();
    return { secret, code, expiresAt };
  }

  /**
   * Consumes a pairing token (by QR secret or short code) and links the two devices.
   * If `joiner` is null a new mobile client (+ physical device, credential) is created
   * from `joinerProfile`; an already-registered client reuses its identity.
   * Atomic: a token can be redeemed exactly once, and only before it expires.
   */
  redeemPairing(
    credential: { secret?: unknown; code?: unknown },
    joiner: DeviceInfo | null,
    joinerProfile: ClientProfile | Record<string, unknown> = {},
  ): { device: DeviceInfo; token?: string; peer: DeviceInfo } {
    let hash: string;
    let column: 'secret_hash' | 'code_hash';
    if (typeof credential.secret === 'string' && credential.secret.length >= 20) {
      hash = hashSecret(credential.secret);
      column = 'secret_hash';
    } else if (typeof credential.code === 'string' && credential.code.length <= 20) {
      hash = hashSecret(normalizeCode(credential.code));
      column = 'code_hash';
    } else {
      throw new AppError(400, 'invalid_request', 'A pairing secret or code is required');
    }

    const result = this.db.transaction(() => {
      const now = this.now();
      const tokenRow = this.db
        .prepare(`SELECT id, device_id, expires_at, used_at FROM pairing_tokens WHERE ${column} = ?`)
        .get(hash) as { id: string; device_id: string; expires_at: number; used_at: number | null } | undefined;

      if (!tokenRow || tokenRow.used_at !== null) {
        throw new AppError(400, 'pairing_invalid', 'This pairing code is invalid or was already used');
      }
      if (tokenRow.expires_at <= now) {
        throw new AppError(400, 'pairing_expired', 'This pairing code has expired. Scan the new QR code.');
      }
      if (joiner && joiner.id === tokenRow.device_id) {
        throw new AppError(400, 'pairing_self', 'A device cannot pair with itself');
      }
      this.db.prepare(`UPDATE pairing_tokens SET used_at = ? WHERE id = ?`).run(now, tokenRow.id);

      let device = joiner;
      let token: string | undefined;
      if (!device) {
        const created = this.registerDevice('mobile', joinerProfile);
        device = created.device;
        token = created.token;
      }
      const [a, b] = orderPair(device.id, tokenRow.device_id);
      this.db
        .prepare(
          `INSERT INTO pairings (id, device_a, device_b, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (device_a, device_b) DO NOTHING`,
        )
        .run(newId('pair'), a, b, now);
      return { device, token, peer: this.getDevice(tokenRow.device_id) };
    })();

    this.publisher.publish(result.peer.id, { type: 'paired', peer: result.device });
    return result.token ? result : { device: result.device, peer: result.peer };
  }

  isPaired(x: string, y: string): boolean {
    const [a, b] = orderPair(x, y);
    return !!this.db.prepare(`SELECT 1 FROM pairings WHERE device_a = ? AND device_b = ?`).get(a, b);
  }

  listPeers(deviceId: string): PeerInfo[] {
    const rows = this.db
      .prepare(
        `SELECT d.id, d.kind, d.client_type, d.client_label, d.physical_device_id,
                ph.name AS physical_name, d.created_at, d.last_seen_at, p.created_at AS paired_at
         FROM pairings p
         JOIN devices d ON d.id = CASE WHEN p.device_a = @id THEN p.device_b ELSE p.device_a END
         JOIN physical_devices ph ON ph.id = d.physical_device_id
         WHERE p.device_a = @id OR p.device_b = @id
         ORDER BY p.created_at DESC`,
      )
      .all({ id: deviceId }) as (DeviceRow & { paired_at: number })[];
    return rows.map((r) => ({
      ...toDevice(r),
      pairedAt: new Date(r.paired_at).toISOString(),
      online: this.publisher.isOnline(r.id),
    }));
  }

  /** Revokes the trust relationship. Either side may do it. */
  unpair(deviceId: string, peerId: string): void {
    const [a, b] = orderPair(deviceId, peerId);
    const { changes } = this.db
      .prepare(`DELETE FROM pairings WHERE device_a = ? AND device_b = ?`)
      .run(a, b);
    if (!changes) throw new AppError(404, 'not_paired', 'These devices are not paired');
    this.publisher.publish(peerId, { type: 'unpaired', peerId: deviceId });
    this.publisher.publish(deviceId, { type: 'unpaired', peerId });
  }

  /** Tells paired devices that `deviceId` went online/offline (healthy realtime connection or not). */
  announcePresence(deviceId: string, online: boolean): void {
    for (const peer of this.listPeers(deviceId)) {
      this.publisher.publish(peer.id, { type: 'presence', deviceId, online });
    }
  }

  // ---------------------------------------------------------------- links

  sendLink(senderId: string, targetId: unknown, rawUrl: unknown): LinkMessage {
    return this.submitLink(senderId, { targetId, url: rawUrl }).message;
  }

  /**
   * Accepts one logical send. With a `messageId`, submission is idempotent per sender:
   * repeating it (retries after an ambiguous failure, double taps, later another transport)
   * returns the original link — nothing is stored or published twice.
   */
  submitLink(
    senderId: string,
    input: { targetId: unknown; url: unknown; messageId?: unknown },
  ): { message: LinkMessage; duplicate: boolean } {
    const { targetId, url: rawUrl, messageId } = input;
    if (messageId !== undefined && messageId !== null) {
      if (typeof messageId !== 'string' || !MESSAGE_ID_PATTERN.test(messageId)) {
        throw new AppError(400, 'invalid_request', 'messageId is malformed');
      }
      const existing = this.findByMessageId(senderId, messageId);
      if (existing) return this.resolveDuplicate(existing, targetId, rawUrl);
    }

    const check = validateUrl(rawUrl);
    if (!check.ok) throw new AppError(400, 'invalid_url', check.error);
    // Same error for "unknown device" and "not paired": don't leak which device ids exist.
    if (typeof targetId !== 'string' || targetId === senderId || !this.isPaired(senderId, targetId)) {
      throw new AppError(403, 'not_paired', 'You are not paired with this device');
    }
    const sender = this.getDevice(senderId);
    const row: LinkRow = {
      id: newId('lnk'),
      message_id: typeof messageId === 'string' ? messageId : null,
      target_id: targetId,
      sender_id: senderId,
      sender_name: sender.name,
      url: check.url,
      created_at: this.now(),
    };
    try {
      this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO links (id, message_id, target_id, sender_id, sender_name, url, created_at)
             VALUES (@id, @message_id, @target_id, @sender_id, @sender_name, @url, @created_at)`,
          )
          .run(row);
        this.db
          .prepare(
            `DELETE FROM links WHERE target_id = ? AND id NOT IN
               (SELECT id FROM links WHERE target_id = ? ORDER BY created_at DESC LIMIT ?)`,
          )
          .run(targetId, targetId, this.historyLimit);
      })();
    } catch (err) {
      // Defensive: a concurrent identical submission won the unique index.
      const existing = row.message_id ? this.findByMessageId(senderId, row.message_id) : undefined;
      if (existing && (err as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT')) {
        return this.resolveDuplicate(existing, targetId, rawUrl);
      }
      throw err;
    }
    const message = toMessage(row);
    this.publisher.publish(targetId, message);
    return { message, duplicate: false };
  }

  private findByMessageId(senderId: string, messageId: string): LinkRow | undefined {
    return this.db
      .prepare(`SELECT * FROM links WHERE sender_id = ? AND message_id = ?`)
      .get(senderId, messageId) as LinkRow | undefined;
  }

  /** A repeated messageId must describe the same send; reusing it for something else is a client bug. */
  private resolveDuplicate(existing: LinkRow, targetId: unknown, rawUrl: unknown): { message: LinkMessage; duplicate: boolean } {
    const check = validateUrl(rawUrl);
    if (existing.target_id !== targetId || !check.ok || check.url !== existing.url) {
      throw new AppError(409, 'message_id_conflict', 'This messageId was already used for a different link');
    }
    return { message: toMessage(existing), duplicate: true };
  }

  listLinks(deviceId: string, limit = 100): LinkMessage[] {
    const rows = this.db
      .prepare(`SELECT * FROM links WHERE target_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(deviceId, Math.min(Math.max(limit, 1), this.historyLimit)) as LinkRow[];
    return rows.map(toMessage);
  }

  deleteLink(deviceId: string, linkId: string): void {
    const { changes } = this.db
      .prepare(`DELETE FROM links WHERE id = ? AND target_id = ?`)
      .run(linkId, deviceId);
    if (!changes) throw new AppError(404, 'link_not_found', 'Link not found');
    this.publisher.publish(deviceId, { type: 'url_deleted', id: linkId });
  }

  // ---------------------------------------------------------------- housekeeping

  purgeExpiredPairingTokens(): number {
    return this.db
      .prepare(`DELETE FROM pairing_tokens WHERE expires_at <= ? OR used_at IS NOT NULL`)
      .run(this.now()).changes;
  }
}
