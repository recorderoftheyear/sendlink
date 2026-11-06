/** Fixed-window in-memory rate limiter. Good enough for a single-process MVP. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns true if the call is allowed. */
  take(key: string): boolean {
    const t = this.now();
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    if (this.hits.size > 10_000) this.sweep(t);
    return entry.count <= this.limit;
  }

  private sweep(t: number): void {
    for (const [key, entry] of this.hits) if (entry.resetAt <= t) this.hits.delete(key);
  }
}
