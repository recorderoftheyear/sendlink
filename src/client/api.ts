import type { ApiError, PollResponse, RealtimeEvent } from '../shared/protocol.js';

export interface Credentials {
  deviceId: string;
  token: string;
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Thin fetch wrapper. The device token lives in localStorage and is sent as a Bearer header. */
export class ApiClient {
  constructor(private readonly storageKey: string) {}

  get credentials(): Credentials | null {
    try {
      const raw = localStorage.getItem(this.storageKey);
      const parsed = raw ? (JSON.parse(raw) as Credentials) : null;
      return parsed?.token && parsed.deviceId ? parsed : null;
    } catch {
      return null;
    }
  }

  save(creds: Credentials): void {
    localStorage.setItem(this.storageKey, JSON.stringify(creds));
  }

  clear(): void {
    localStorage.removeItem(this.storageKey);
  }

  async request<T>(method: string, path: string, body?: unknown, opts: { keepalive?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = {};
    const creds = this.credentials;
    if (creds) headers.Authorization = `Bearer ${creds.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
        keepalive: opts.keepalive, // lets a "leave" request outlive the closing page
      });
    } catch {
      throw new ApiRequestError(0, 'network', 'Network error — check your connection');
    }
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => null)) as (T & Partial<ApiError>) | null;
    if (!res.ok) {
      throw new ApiRequestError(
        res.status,
        data?.error?.code ?? 'http_error',
        data?.error?.message ?? `Request failed (${res.status})`,
      );
    }
    return data as T;
  }
}

export type StreamState = 'connecting' | 'open' | 'reconnecting';
export type Transport = 'sse' | 'poll';

/** How long the SSE "ready" event may take before we assume a proxy is buffering the stream. */
const READY_TIMEOUT_MS = 4000;
const REALTIME_EVENTS = ['url', 'paired', 'unpaired', 'url_deleted', 'peer_updated', 'presence'] as const;

/**
 * Keeps a realtime channel open and proves to the server that it is alive.
 *
 * Primary transport: Server-Sent Events. The device token is exchanged for a one-time
 * ticket (EventSource can't send headers), and the stream reconnects with backoff.
 * The server only counts this device as online while the client acknowledges its
 * "ready" and periodic "ping" events (a presence lease).
 *
 * Some proxies (notably Cloudflare Quick Tunnels) deliver the SSE headers but hold the
 * body until the response ends — which for SSE is never. `onopen` still fires, so we
 * only trust the stream once "ready" actually arrives. If it doesn't, we fall back to
 * HTTP long-polling (each poll's arrival renews the lease), which works through any
 * buffering proxy because every response ends.
 *
 * On page hide/close the client tells the server it is leaving, so paired devices see
 * it offline at once; if the browser is killed, the lease simply expires.
 */
export class EventStream {
  private source: EventSource | null = null;
  private retry = 0;
  private stopped = true;
  /** Bumped by start/stop so loops from a previous run exit instead of running twice. */
  private generation = 0;
  private conn: string | null = null;
  private _transport: Transport = 'sse';

  constructor(
    private readonly api: ApiClient,
    private readonly handlers: {
      onEvent: (event: RealtimeEvent) => void;
      onState: (state: StreamState) => void;
      onUnauthorized: () => void;
      /** Events may have been missed: refetch state. */
      onResync: () => void;
      onTransport?: (transport: Transport) => void;
    },
  ) {
    window.addEventListener('pagehide', () => this.stop());
    window.addEventListener('pageshow', (e) => {
      if ((e as PageTransitionEvent).persisted) this.start(); // restored from the back/forward cache
    });
  }

  get transport(): Transport {
    return this._transport;
  }

  get running(): boolean {
    return !this.stopped;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const gen = ++this.generation;
    this.retry = 0;
    if (this._transport === 'poll') void this.pollLoop(gen);
    else void this.connectSse(gen);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.generation++;
    this.source?.close();
    this.source = null;
    if (this.conn) {
      // Best effort: the page may be going away, so the request must be allowed to outlive it.
      void this.api
        .request('POST', '/api/presence', { conn: this.conn, state: 'leave' }, { keepalive: true })
        .catch(() => undefined);
      this.conn = null;
    }
  }

  private live(gen: number): boolean {
    return !this.stopped && gen === this.generation;
  }

  private async connectSse(gen: number): Promise<void> {
    if (!this.live(gen)) return;
    this.handlers.onState(this.retry ? 'reconnecting' : 'connecting');
    let ticket: string;
    try {
      ({ ticket } = await this.api.request<{ ticket: string }>('POST', '/api/stream-tickets'));
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) return this.handlers.onUnauthorized();
      return this.scheduleReconnect(gen);
    }
    if (!this.live(gen)) return;

    const source = new EventSource(`/api/events?ticket=${encodeURIComponent(ticket)}`);
    this.source = source;
    let ready = false;
    const watchdog = window.setTimeout(() => {
      if (ready || this.source !== source) return;
      source.close();
      this.source = null;
      this.switchToPolling(gen);
    }, READY_TIMEOUT_MS);

    const acknowledge = (conn: string) => {
      this.api.request('POST', '/api/presence', { conn }).catch((err: unknown) => {
        // The server no longer knows this stream (swept as stale): start a fresh one.
        if (err instanceof ApiRequestError && err.status === 404 && this.source === source) {
          source.close();
          this.source = null;
          this.scheduleReconnect(gen);
        }
      });
    };

    source.addEventListener('ready', (e) => {
      ready = true;
      window.clearTimeout(watchdog);
      const { conn } = JSON.parse((e as MessageEvent<string>).data) as { conn: string };
      this.conn = conn;
      acknowledge(conn);
      this.retry = 0;
      this.handlers.onState('open');
      this.handlers.onResync();
    });
    source.addEventListener('ping', () => {
      if (this.conn) acknowledge(this.conn);
    });
    source.onerror = () => {
      window.clearTimeout(watchdog);
      source.close();
      if (this.source !== source) return;
      this.source = null;
      this.scheduleReconnect(gen);
    };
    for (const type of REALTIME_EVENTS) {
      source.addEventListener(type, (e) => this.dispatch((e as MessageEvent<string>).data));
    }
  }

  private dispatch(data: string): void {
    try {
      this.handlers.onEvent(JSON.parse(data) as RealtimeEvent);
    } catch {
      // ignore malformed frames
    }
  }

  private scheduleReconnect(gen: number): void {
    if (!this.live(gen)) return;
    this.handlers.onState('reconnecting');
    const delay = Math.min(1000 * 2 ** this.retry, 15_000);
    this.retry += 1;
    setTimeout(() => void this.connectSse(gen), delay);
  }

  private switchToPolling(gen: number): void {
    this._transport = 'poll';
    this.handlers.onTransport?.('poll');
    this.retry = 0;
    void this.pollLoop(gen);
  }

  private async pollLoop(gen: number): Promise<void> {
    let cursor: string | null = null;
    this.conn = null;
    while (this.live(gen)) {
      try {
        const params = new URLSearchParams();
        if (cursor) params.set('cursor', cursor);
        if (this.conn) params.set('conn', this.conn);
        const res: PollResponse = await this.api.request<PollResponse>('GET', `/api/events/poll?${params}`);
        if (!this.live(gen)) return;
        const first = cursor === null;
        cursor = res.cursor;
        this.conn = res.conn;
        if (first || this.retry > 0 || res.reset) {
          this.retry = 0;
          this.handlers.onState('open');
          this.handlers.onResync();
        }
        for (const event of res.events) this.handlers.onEvent(event);
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 401) return this.handlers.onUnauthorized();
        if (!this.live(gen)) return;
        this.handlers.onState('reconnecting');
        const delay = Math.min(1000 * 2 ** this.retry, 15_000);
        this.retry += 1;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
}
