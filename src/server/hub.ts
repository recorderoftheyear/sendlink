import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { PollResponse, RealtimeEvent } from '../shared/protocol.js';
import type { Publisher } from './service.js';

interface Buffered {
  seq: number;
  at: number;
  event: RealtimeEvent;
}

/**
 * One realtime connection of a device (a browser tab). Its presence lease is renewed
 * only by proof coming *from the client*: an SSE ping acknowledgement, or the arrival
 * of a long-poll request. Server-side writes prove nothing — a proxy or a half-open
 * TCP connection accepts them happily after the browser is gone.
 */
interface Receiver {
  id: string;
  kind: 'sse' | 'poll';
  res?: ServerResponse;
  openedAt: number;
  /** Last client proof; null = never (an SSE stream is unproven until "ready" is acknowledged). */
  lastProof: number | null;
}

export interface HubTimings {
  /** Interval of SSE "ping" events the client must acknowledge. */
  pingMs: number;
  /** An SSE receiver is healthy for this long after its last acknowledgement. */
  sseTtlMs: number;
  /** A long-poll receiver is healthy for this long after its last request arrived (> hold time). */
  pollTtlMs: number;
  /** How often stale receivers are cleaned up and presence changes detected. */
  sweepMs: number;
}

export const DEFAULT_TIMINGS: HubTimings = { pingMs: 10_000, sseTtlMs: 25_000, pollTtlMs: 30_000, sweepMs: 2_000 };

const BACKLOG_SIZE = 50;
const BACKLOG_TTL_MS = 5 * 60_000;
const CONN_ID = /^[\w-]{8,32}$/;

/**
 * In-memory realtime hub. Events are routed only to the connections of the target device.
 *
 * Two transports share one event log:
 *  - Server-Sent Events (primary): pushed as soon as they are published.
 *  - Long-polling (fallback): for networks that buffer streamed responses until they end
 *    (e.g. Cloudflare Quick Tunnels). Each device keeps a short backlog of numbered events
 *    so nothing is lost between two polls.
 *
 * Presence: a device is online iff at least one of its receivers holds a live lease
 * (see Receiver). Transitions are reported through onPresenceChange.
 *
 * Cursors are "<bootId>:<seq>", so a cursor from a previous server process is detected
 * and the client told to resync.
 *
 * Single-process by design. To scale horizontally, replace with a Redis/Postgres
 * pub/sub fan-out keyed by device id — the Publisher interface stays the same.
 */
export class SseHub implements Publisher {
  private readonly bootId = randomBytes(6).toString('base64url');
  private seq = 0;
  private readonly receivers = new Map<string, Map<string, Receiver>>();
  private readonly backlog = new Map<string, Buffered[]>();
  /** Highest seq dropped from a device's backlog: older cursors must resync. */
  private readonly trimmed = new Map<string, number>();
  private readonly waiters = new Map<string, Set<() => void>>();
  /** Last presence state announced per device (absent = offline). */
  private readonly announced = new Set<string>();
  private presenceListener: ((deviceId: string, online: boolean) => void) | null = null;
  private readonly timers: NodeJS.Timeout[];
  readonly timings: HubTimings;

  constructor(
    timings: Partial<HubTimings> = {},
    private readonly now: () => number = Date.now,
  ) {
    this.timings = { ...DEFAULT_TIMINGS, ...timings };
    this.timers = [
      // Pings double as keep-alive traffic for idle proxies.
      setInterval(() => this.ping(), this.timings.pingMs),
      setInterval(() => this.sweep(), this.timings.sweepMs),
    ];
    for (const t of this.timers) t.unref();
  }

  get cursor(): string {
    return `${this.bootId}:${this.seq}`;
  }

  onPresenceChange(listener: (deviceId: string, online: boolean) => void): void {
    this.presenceListener = listener;
  }

  // ---------------------------------------------------------------- SSE

  /** Opens an SSE stream; returns its connection id (the client acknowledges pings with it). */
  subscribe(deviceId: string, res: ServerResponse): string {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx & compatible proxies: don't buffer
    });
    res.flushHeaders();
    res.socket?.setNoDelay(true);

    const conn = newConnId();
    this.add(deviceId, { id: conn, kind: 'sse', res, openedAt: this.now(), lastProof: null });
    res.on('close', () => this.remove(deviceId, conn));
    // "ready" proves that body bytes actually reach the client. If a proxy buffers
    // the stream, the client never sees it (so never acknowledges it) and switches to long-polling.
    res.write(`retry: 3000\nevent: ready\ndata: ${JSON.stringify({ cursor: this.cursor, conn })}\n\n`);
    return conn;
  }

  /** Client proof that an SSE stream delivers: renews its lease. False if the connection is unknown. */
  acknowledge(deviceId: string, conn: string): boolean {
    const receiver = this.receivers.get(deviceId)?.get(conn);
    if (!receiver || receiver.kind !== 'sse') return false;
    receiver.lastProof = this.now();
    this.updatePresence(deviceId);
    return true;
  }

  /** The client is going away (tab closed / page hidden): drop its lease right now. */
  leave(deviceId: string, conn: string): void {
    const receiver = this.receivers.get(deviceId)?.get(conn);
    if (!receiver) return;
    this.remove(deviceId, conn);
    receiver.res?.end();
  }

  private ping(): void {
    for (const map of this.receivers.values()) {
      for (const r of map.values()) {
        if (r.res) r.res.write(`event: ping\ndata: ${JSON.stringify({ conn: r.id })}\n\n`);
      }
    }
  }

  // ---------------------------------------------------------------- publish

  publish(deviceId: string, event: RealtimeEvent): void {
    const seq = ++this.seq;
    const t = this.now();
    const log = (this.backlog.get(deviceId) ?? []).filter((b) => {
      const keep = t - b.at < BACKLOG_TTL_MS;
      if (!keep) this.trimmed.set(deviceId, Math.max(this.trimmed.get(deviceId) ?? 0, b.seq));
      return keep;
    });
    log.push({ seq, at: t, event });
    while (log.length > BACKLOG_SIZE) this.trimmed.set(deviceId, log.shift()!.seq);
    this.backlog.set(deviceId, log);

    const map = this.receivers.get(deviceId);
    if (map) {
      const frame = `id: ${this.bootId}:${seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
      for (const r of map.values()) r.res?.write(frame);
    }
    const waiting = this.waiters.get(deviceId);
    if (waiting) for (const wake of [...waiting]) wake();
  }

  // ---------------------------------------------------------------- long-poll

  /**
   * Long-poll: resolves with events newer than `cursor` as soon as there are any,
   * or with an empty list after `holdMs`. No cursor => returns the current cursor at once.
   * The request's *arrival* renews the connection's lease; a poll abandoned by the client
   * (connection closed before we answered) ends it immediately.
   */
  poll(
    deviceId: string,
    cursor: string | null,
    conn: string | null,
    holdMs: number,
    onClose: (cb: (aborted: boolean) => void) => void,
  ): Promise<PollResponse> {
    const id = conn && CONN_ID.test(conn) ? conn : newConnId();
    const existing = this.receivers.get(deviceId)?.get(id);
    if (existing?.kind === 'poll') existing.lastProof = this.now();
    else this.add(deviceId, { id, kind: 'poll', openedAt: this.now(), lastProof: this.now() });
    this.updatePresence(deviceId);

    if (!cursor) return Promise.resolve({ cursor: this.cursor, conn: id, events: [] });

    const [boot, rawSeq] = cursor.split(':');
    const since = Number(rawSeq);
    if (boot !== this.bootId || !Number.isInteger(since) || since > this.seq || since < (this.trimmed.get(deviceId) ?? 0)) {
      return Promise.resolve({ cursor: this.cursor, conn: id, events: [], reset: true });
    }

    const pending = this.eventsSince(deviceId, since, id);
    if (pending.events.length) return Promise.resolve(pending);

    return new Promise((resolve) => {
      let set = this.waiters.get(deviceId);
      if (!set) this.waiters.set(deviceId, (set = new Set()));
      const finish = () => {
        clearTimeout(timer);
        set.delete(finish);
        if (set.size === 0 && this.waiters.get(deviceId) === set) this.waiters.delete(deviceId);
        resolve(this.eventsSince(deviceId, since, id));
      };
      const timer = setTimeout(finish, holdMs);
      set.add(finish);
      onClose((aborted) => {
        if (aborted) this.remove(deviceId, id); // nobody is waiting for the answer anymore
        finish();
      });
    });
  }

  private eventsSince(deviceId: string, since: number, conn: string): PollResponse {
    const events = (this.backlog.get(deviceId) ?? []).filter((b) => b.seq > since);
    const last = events.at(-1);
    return {
      // Advance only to the last delivered event: never skip events published meanwhile.
      cursor: last ? `${this.bootId}:${last.seq}` : `${this.bootId}:${since}`,
      conn,
      events: events.map((b) => b.event),
    };
  }

  // ---------------------------------------------------------------- presence

  private healthy(r: Receiver, t = this.now()): boolean {
    if (r.lastProof === null) return false;
    return t - r.lastProof < (r.kind === 'sse' ? this.timings.sseTtlMs : this.timings.pollTtlMs);
  }

  /** Online = at least one connection with a live lease: it can receive a link right now. */
  isOnline(deviceId: string): boolean {
    const map = this.receivers.get(deviceId);
    if (!map) return false;
    const t = this.now();
    for (const r of map.values()) if (this.healthy(r, t)) return true;
    return false;
  }

  /**
   * Drops receivers whose lease expired (closing stale SSE streams, e.g. half-open
   * connections or streams a buffering proxy never delivered) and reports presence changes.
   */
  sweep(): void {
    const t = this.now();
    for (const [deviceId, map] of this.receivers) {
      for (const r of [...map.values()]) {
        const ttl = r.kind === 'sse' ? this.timings.sseTtlMs : this.timings.pollTtlMs;
        if (!this.healthy(r, t) && t - Math.max(r.openedAt, r.lastProof ?? 0) >= ttl) {
          this.remove(deviceId, r.id);
          r.res?.destroy();
        }
      }
      this.updatePresence(deviceId);
    }
    for (const deviceId of [...this.announced]) this.updatePresence(deviceId);
  }

  private add(deviceId: string, receiver: Receiver): void {
    let map = this.receivers.get(deviceId);
    if (!map) this.receivers.set(deviceId, (map = new Map()));
    map.set(receiver.id, receiver);
  }

  private remove(deviceId: string, conn: string): void {
    const map = this.receivers.get(deviceId);
    if (!map?.delete(conn)) return;
    if (map.size === 0) this.receivers.delete(deviceId);
    this.updatePresence(deviceId);
  }

  private updatePresence(deviceId: string): void {
    const online = this.isOnline(deviceId);
    if (online === this.announced.has(deviceId)) return;
    if (online) this.announced.add(deviceId);
    else this.announced.delete(deviceId);
    this.presenceListener?.(deviceId, online);
  }

  close(): void {
    this.presenceListener = null; // shutting down: nobody to notify
    for (const t of this.timers) clearInterval(t);
    for (const map of this.receivers.values()) for (const r of map.values()) r.res?.end();
    this.receivers.clear();
    for (const set of this.waiters.values()) for (const wake of [...set]) wake();
  }
}

function newConnId(): string {
  return randomBytes(12).toString('base64url');
}
