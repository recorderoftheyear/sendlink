import { randomToken } from './security.js';

/**
 * Browsers' EventSource cannot send an Authorization header, and the long-lived
 * device token must never appear in a URL. So the client first exchanges its
 * token for a single-use ticket valid for a few seconds, and opens
 * /api/events?ticket=… with it.
 */
export class StreamTickets {
  private readonly tickets = new Map<string, { deviceId: string; expiresAt: number }>();

  constructor(
    private readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  issue(deviceId: string): string {
    const t = this.now();
    for (const [k, v] of this.tickets) if (v.expiresAt <= t) this.tickets.delete(k);
    const ticket = randomToken(24);
    this.tickets.set(ticket, { deviceId, expiresAt: t + this.ttlMs });
    return ticket;
  }

  consume(ticket: string): string | null {
    const entry = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!entry || entry.expiresAt <= this.now()) return null;
    return entry.deviceId;
  }
}
