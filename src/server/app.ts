import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { Config } from './config.js';
import { openDatabase, type DB } from './db.js';
import { SseHub, type HubTimings } from './hub.js';
import { RateLimiter } from './rateLimit.js';
import { AppError, SendLinkService } from './service.js';
import { StreamTickets } from './tickets.js';
import type { DeviceInfo } from '../shared/protocol.js';

const MAX_BODY_BYTES = 8 * 1024;
/**
 * Long-poll hold time: well under the ~100 s idle timeout of Cloudflare & most proxies,
 * and shorter than the poll presence lease (HubTimings.pollTtlMs) so a live client
 * always renews its lease in time.
 */
const POLL_HOLD_MS = 20_000;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
};

const PAGES: Record<string, string> = {
  '/': 'desktop.html',
  '/index.html': 'desktop.html',
  '/m': 'mobile.html',
  '/m/': 'mobile.html',
};

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  ip: string;
}

export interface App {
  server: Server;
  service: SendLinkService;
  hub: SseHub;
  db: DB;
  close(): Promise<void>;
}

export interface AppOptions {
  /** Realtime/presence timings (tests shorten them). */
  hub?: Partial<HubTimings>;
  pollHoldMs?: number;
}

export function createApp(config: Config, options: AppOptions = {}): App {
  const db = openDatabase(config.dbPath);
  const hub = new SseHub(options.hub);
  const service = new SendLinkService(db, hub, { pairingTtlMs: config.pairingTtlMs });
  const pollHoldMs = options.pollHoldMs ?? POLL_HOLD_MS;
  // Presence changes are pushed live to paired devices.
  hub.onPresenceChange((deviceId, online) => service.announcePresence(deviceId, online));
  const tickets = new StreamTickets();

  const limits = {
    register: new RateLimiter(20, 60 * 60_000), // new desktop devices per IP per hour
    pairing: new RateLimiter(20, 60_000), // pairing attempts per IP per minute (guards short codes)
    send: new RateLimiter(30, 60_000), // links per device per minute
    // Authenticated traffic is limited per device, not per IP: several devices commonly share
    // one IP (home/office NAT), and each open tab acknowledges presence pings.
    device: new RateLimiter(300, 60_000), // any authenticated call per device per minute
    flood: new RateLimiter(1200, 60_000), // any /api call per IP per minute (coarse flood guard)
  };

  const purge = setInterval(() => service.purgeExpiredPairingTokens(), 60_000);
  purge.unref();

  function clientIp(req: IncomingMessage): string {
    if (config.trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  function requireAuth(ctx: Ctx): DeviceInfo {
    const header = ctx.req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
    const device = service.authenticate(token);
    if (!device) throw new AppError(401, 'unauthorized', 'Unknown or revoked device');
    limit(limits.device, device.id);
    return device;
  }

  function limit(limiter: RateLimiter, key: string): void {
    if (!limiter.take(key)) throw new AppError(429, 'rate_limited', 'Too many requests, slow down');
  }

  function baseUrl(req: IncomingMessage): string {
    if (config.publicUrl) return config.publicUrl;
    const forwardedHttps = config.trustProxy && req.headers['x-forwarded-proto'] === 'https';
    let url: URL;
    try {
      url = new URL(`${forwardedHttps ? 'https' : 'http'}://${req.headers.host ?? 'localhost'}`);
    } catch {
      url = new URL(`http://localhost:${config.port}`);
    }
    // The phone can't reach "localhost": swap in this machine's LAN address.
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      const ip = lanAddress();
      if (ip) url.hostname = ip;
    }
    return url.origin;
  }

  async function handleApi(ctx: Ctx): Promise<void> {
    const { req, res, url, ip } = ctx;
    const method = req.method ?? 'GET';
    const path = url.pathname;
    limit(limits.flood, ip);

    // POST /api/devices — register a computer (phones are created by pairing)
    if (method === 'POST' && path === '/api/devices') {
      limit(limits.register, ip);
      const body = await readJson(req);
      if (body.kind !== 'desktop') throw new AppError(400, 'invalid_request', 'kind must be "desktop"');
      return json(res, 201, service.registerDevice('desktop', body));
    }

    if (path === '/api/me') {
      const device = requireAuth(ctx);
      if (method === 'GET') return json(res, 200, service.me(device.id));
      if (method === 'PATCH') {
        const body = await readJson(req);
        return json(res, 200, { device: service.updateDevice(device.id, body) });
      }
      if (method === 'DELETE') {
        service.deleteDevice(device.id);
        return empty(res);
      }
    }

    // POST /api/pairing-tokens — computer asks for a fresh QR code
    if (method === 'POST' && path === '/api/pairing-tokens') {
      const device = requireAuth(ctx);
      const { secret, code, expiresAt } = service.createPairingToken(device.id);
      // Secret goes in the URL *fragment*: never sent to servers, proxies or logs.
      const pairUrl = `${baseUrl(req)}/m#pair=${secret}`;
      return json(res, 201, { code, pairUrl, expiresAt: new Date(expiresAt).toISOString() });
    }

    // POST /api/pairings — phone redeems a QR secret or short code
    if (method === 'POST' && path === '/api/pairings') {
      limit(limits.pairing, ip);
      const body = await readJson(req);
      const joiner = req.headers.authorization ? requireAuth(ctx) : null;
      const profile = { name: body.deviceName ?? body.name, clientType: body.clientType, clientLabel: body.clientLabel };
      const result = service.redeemPairing({ secret: body.secret, code: body.code }, joiner, profile);
      return json(res, 201, result);
    }

    const unpair = /^\/api\/pairings\/([\w-]{1,64})$/.exec(path);
    if (method === 'DELETE' && unpair?.[1]) {
      const device = requireAuth(ctx);
      service.unpair(device.id, unpair[1]);
      return empty(res);
    }

    if (path === '/api/links') {
      const device = requireAuth(ctx);
      if (method === 'GET') return json(res, 200, { links: service.listLinks(device.id) });
      if (method === 'POST') {
        limit(limits.send, device.id);
        const body = await readJson(req);
        const { message, duplicate } = service.submitLink(device.id, {
          targetId: body.targetDeviceId,
          url: body.url,
          messageId: body.messageId,
        });
        // 201 = accepted now; 200 = this messageId was already accepted (safe retry).
        return json(res, duplicate ? 200 : 201, {
          ...message,
          delivered: hub.isOnline(message.targetDeviceId),
          duplicate,
        });
      }
    }

    const link = /^\/api\/links\/([\w-]{1,64})$/.exec(path);
    if (method === 'DELETE' && link?.[1]) {
      const device = requireAuth(ctx);
      service.deleteLink(device.id, link[1]);
      return empty(res);
    }

    // POST /api/presence — {conn, state?: "leave"}: acknowledges an SSE ping (renews the
    // presence lease) or announces that this connection is going away.
    if (method === 'POST' && path === '/api/presence') {
      const device = requireAuth(ctx);
      const body = await readJson(req);
      if (typeof body.conn !== 'string') throw new AppError(400, 'invalid_request', 'conn is required');
      if (body.state === 'leave') {
        hub.leave(device.id, body.conn);
        return empty(res);
      }
      if (!hub.acknowledge(device.id, body.conn)) throw new AppError(404, 'unknown_connection', 'Unknown connection');
      return empty(res);
    }

    if (method === 'POST' && path === '/api/stream-tickets') {
      const device = requireAuth(ctx);
      return json(res, 201, { ticket: tickets.issue(device.id) });
    }

    // GET /api/events — SSE stream (Bearer header for native clients, ticket for browsers)
    if (method === 'GET' && path === '/api/events') {
      const ticket = url.searchParams.get('ticket');
      const deviceId = ticket ? tickets.consume(ticket) : requireAuth(ctx).id;
      if (!deviceId) throw new AppError(401, 'unauthorized', 'Invalid or expired stream ticket');
      hub.subscribe(deviceId, res);
      return;
    }

    // GET /api/events/poll — long-polling fallback when a proxy buffers the SSE stream
    if (method === 'GET' && path === '/api/events/poll') {
      const device = requireAuth(ctx);
      const result = await hub.poll(
        device.id,
        url.searchParams.get('cursor'),
        url.searchParams.get('conn'),
        pollHoldMs,
        (cb) => res.on('close', () => cb(!res.writableEnded)),
      );
      if (!res.writableEnded && !res.destroyed) json(res, 200, result);
      return;
    }

    throw new AppError(404, 'not_found', 'Not found');
  }

  async function handleStatic(ctx: Ctx): Promise<void> {
    const { req, res, url } = ctx;
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new AppError(405, 'method_not_allowed', 'Method not allowed');
    const root = resolve(config.staticDir);
    let rel = PAGES[url.pathname];
    try {
      rel ??= normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
    } catch {
      throw new AppError(404, 'not_found', 'Not found');
    }
    const file = resolve(join(root, rel));
    const type = MIME[extname(file)];
    if (!file.startsWith(root + sep) || !type) throw new AppError(404, 'not_found', 'Not found');
    let data: Buffer;
    try {
      data = await readFile(file);
    } catch {
      throw new AppError(404, 'not_found', 'Not found');
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': data.length,
      'Cache-Control': type.startsWith('text/html') || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=300',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  const server = createServer((req, res) => {
    const ctx: Ctx = {
      req,
      res,
      url: new URL(req.url ?? '/', 'http://internal'),
      ip: clientIp(req),
    };
    setSecurityHeaders(res, config.isProduction);
    const handler = ctx.url.pathname === '/healthz'
      ? async () => {
          db.prepare('SELECT 1').get(); // throws (-> 500) if the database is unusable
          json(res, 200, { ok: true });
        }
      : ctx.url.pathname.startsWith('/api/')
        ? handleApi
        : handleStatic;
    handler(ctx).catch((err: unknown) => {
      if (res.headersSent) return void res.end();
      if (err instanceof AppError) return json(res, err.status, { error: { code: err.code, message: err.message } });
      console.error(err);
      json(res, 500, { error: { code: 'internal', message: 'Internal server error' } });
    });
  });

  return {
    server,
    service,
    hub,
    db,
    async close() {
      clearInterval(purge);
      hub.close();
      await new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      });
      db.close();
    },
  };
}

function setSecurityHeaders(res: ServerResponse, production: boolean): void {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (production) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function empty(res: ServerResponse): void {
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) {
    throw new AppError(415, 'unsupported_media_type', 'Expected application/json');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new AppError(413, 'payload_too_large', 'Request body too large');
    chunks.push(chunk);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new AppError(400, 'invalid_json', 'Body must be a JSON object');
}

/** First private IPv4 address of this machine, used to build a phone-reachable pairing URL. */
export function lanAddress(): string | undefined {
  const candidates = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i!.address);
  const isPrivate = (a: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
  return candidates.find(isPrivate) ?? candidates[0];
}
