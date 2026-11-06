import QRCode from 'qrcode';
import { ApiClient, ApiRequestError, EventStream, type StreamState } from './api.js';
import { $, formatCode, h, showView, timeAgo } from './dom.js';
import { clientProfile, profileUpdate, requestPersistentStorage } from './identity.js';
import { friendlyError, isNetworkError } from './messages.js';
import type {
  LinkMessage,
  MeResponse,
  PairingTokenResponse,
  RealtimeEvent,
  RegisterResponse,
} from '../shared/protocol.js';
import { displayUrl, validateUrl } from '../shared/url.js';

const api = new ApiClient('sendlink.desktop');
const VIEWS = ['view-loading', 'view-pair', 'view-inbox', 'view-error'];

let me: MeResponse | null = null;
let links: LinkMessage[] = [];
let streamState: StreamState = 'connecting';
let pairingRequested = false;
let pairingTimer: number | undefined;
let unseen = 0;
/** Set when a phone connects during this visit: the empty inbox then celebrates it. */
let justPaired = false;
const NOTIFY_DISMISSED_KEY = 'sendlink.notify.dismissed';

// ------------------------------------------------------------------ boot

async function ensureDevice(): Promise<void> {
  if (api.credentials) {
    try {
      me = await api.request<MeResponse>('GET', '/api/me');
      // Legacy clients (pre physical-device model) learn their browser label once.
      const patch = profileUpdate(me.device, 'desktop');
      if (patch) await api.request('PATCH', '/api/me', patch);
      return;
    } catch (err) {
      if (!(err instanceof ApiRequestError && err.status === 401)) throw err;
      api.clear();
    }
  }
  // One identity per browser installation/profile: this browser's storage holds the credential.
  const created = await api.request<RegisterResponse>('POST', '/api/devices', {
    kind: 'desktop',
    ...clientProfile('desktop'),
  });
  api.save({ deviceId: created.device.id, token: created.token });
  me = { device: created.device, peers: [] };
}

const stream = new EventStream(api, {
  onEvent: handleEvent,
  onState: (state) => {
    streamState = state;
    renderStatus();
  },
  // Stream (re)established: resync anything we may have missed while disconnected.
  onResync: () => void refresh(),
  onTransport: (transport) => (document.documentElement.dataset.transport = transport),
  onUnauthorized: () => {
    api.clear();
    location.reload();
  },
});

let streamStarted = false;
async function boot(): Promise<void> {
  requestPersistentStorage();
  try {
    await ensureDevice();
    if (!streamStarted) {
      streamStarted = true;
      stream.start();
    }
    await refresh();
  } catch (err) {
    showError(err);
  }
}

// Refreshes are serialized so concurrent triggers (boot, SSE reconnect, events) can't interleave.
let refreshChain: Promise<void> = Promise.resolve();
function refresh(): Promise<void> {
  refreshChain = refreshChain.then(doRefresh).catch(showError);
  return refreshChain;
}

async function doRefresh(): Promise<void> {
  me = await api.request<MeResponse>('GET', '/api/me');
  if (me.peers.length === 0 || pairingRequested) {
    await showPairing();
  } else {
    stopPairing();
    const res = await api.request<{ links: LinkMessage[] }>('GET', '/api/links');
    links = res.links;
    showView(VIEWS, 'view-inbox');
    renderLinks();
    renderPeers();
  }
  renderStatus();
}

let retryTimer: number | undefined;
function showError(err: unknown): void {
  const offline = isNetworkError(err);
  $('error-text').textContent = offline ? 'Check your internet connection. Retrying…' : friendlyError(err);
  showView(VIEWS, 'view-error');
  window.clearTimeout(retryTimer);
  if (offline) retryTimer = window.setTimeout(() => void boot(), 5000);
}

// ------------------------------------------------------------------ pairing

async function showPairing(): Promise<void> {
  showView(VIEWS, 'view-pair');
  $('pair-cancel').hidden = !me?.peers.length;
  if (pairingTimer === undefined) await newPairingToken();
}

// Only one token request at a time: a newer token invalidates the older one server-side.
let tokenChain: Promise<void> = Promise.resolve();
function newPairingToken(): Promise<void> {
  window.clearInterval(pairingTimer);
  pairingTimer = -1; // "pairing active" marker until the countdown starts
  tokenChain = tokenChain.catch(() => undefined).then(fetchPairingToken);
  return tokenChain;
}

async function fetchPairingToken(): Promise<void> {
  if (pairingTimer === undefined) return; // pairing was cancelled meanwhile
  const token = await api.request<PairingTokenResponse>('POST', '/api/pairing-tokens');
  const canvas = $<HTMLCanvasElement>('qr');
  await QRCode.toCanvas(canvas, token.pairUrl, { width: 232, margin: 1, errorCorrectionLevel: 'M' });
  canvas.dataset.pairUrl = token.pairUrl; // same content the QR encodes (used by E2E tests)
  $('pair-code').textContent = formatCode(token.code);
  $('pair-host').textContent = new URL(token.pairUrl).host;

  const expiresAt = new Date(token.expiresAt).getTime();
  const tick = () => {
    const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    $('pair-expiry').textContent = `Code refreshes in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    // Rotate the token when it expires, but only while someone is looking at it.
    if (left === 0 && !document.hidden) void newPairingToken().catch(showError);
  };
  if (pairingTimer === undefined) return;
  pairingTimer = window.setInterval(tick, 1000);
  tick();
}

function stopPairing(): void {
  window.clearInterval(pairingTimer);
  pairingTimer = undefined;
}

// ------------------------------------------------------------------ realtime

function handleEvent(event: RealtimeEvent): void {
  switch (event.type) {
    case 'url':
      if (links.some((l) => l.id === event.id)) return;
      links.unshift(event);
      renderLinks(event.id);
      notify(event);
      break;
    case 'paired':
      justPaired = true;
      pairingRequested = false;
      stopPairing();
      void refresh();
      break;
    case 'unpaired':
    case 'peer_updated':
      void refresh();
      break;
    case 'url_deleted':
      links = links.filter((l) => l.id !== event.id);
      renderLinks();
      break;
    case 'presence':
      break; // phones' presence isn't shown on the computer
  }
}

// Service worker = notifications with an "Open" action that work while the tab is in the
// background. Needs a secure context (HTTPS or localhost); otherwise plain notifications.
let swRegistration: ServiceWorkerRegistration | null = null;
if (window.isSecureContext && navigator.serviceWorker?.register) {
  navigator.serviceWorker
    .register('/sw.js')
    .then(() => navigator.serviceWorker.ready)
    .then((reg) => (swRegistration = reg))
    .catch(() => undefined);
}

function notify(link: LinkMessage): void {
  // Nothing to announce if the user is looking at SendLink right now.
  if (!document.hidden && document.hasFocus()) return;
  unseen += 1;
  document.title = `(${unseen}) SendLink`;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const check = validateUrl(link.url);
  if (!check.ok) return;

  const title = 'SendLink';
  const options = {
    body: `${link.senderName} sent you a link\n${displayUrl(check.url, 70)}`,
    tag: link.id,
    icon: '/icon-192.png',
    data: { url: check.url },
  };
  // Clicking the notification is the user's explicit choice to open the link (never automatic).
  if (swRegistration) {
    void swRegistration.showNotification(title, { ...options, actions: [{ action: 'open', title: 'Open' }] } as NotificationOptions);
  } else {
    const n = new Notification(title, options);
    n.onclick = () => {
      openUrl(check.url);
      n.close();
    };
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  unseen = 0;
  document.title = 'SendLink';
  if (pairingTimer !== undefined && !$('view-pair').hidden) void newPairingToken().catch(showError);
});

// ------------------------------------------------------------------ rendering

function renderStatus(): void {
  const peers = me?.peers ?? [];
  const online = streamState === 'open';
  const status = $('status');
  status.dataset.state = online ? 'connected' : streamState;
  status.title = online ? 'Connected' : 'Reconnecting…';
  $('status-peer').textContent = peers.length && !$('view-inbox').hidden ? peers.map((p) => p.name).join(', ') : '';
  $('status-dot').className = `dot ${online ? 'on' : 'off'}`;
  $('status-text').textContent = online ? '' : streamState === 'connecting' ? 'Connecting…' : 'Reconnecting…';
}

function renderLinks(highlightId?: string): void {
  const list = $('links');
  list.replaceChildren(...links.map((l) => linkItem(l, l.id === highlightId)));
  $('empty').hidden = links.length > 0 || justPaired;
  $('welcome').hidden = links.length > 0 || !justPaired;
}

function linkItem(link: LinkMessage, fresh: boolean): HTMLLIElement {
  // Re-validate before rendering: only http(s) ever becomes a clickable href.
  const check = validateUrl(link.url);
  const safe = check.ok ? check.url : null;
  const time = h('time', { datetime: link.timestamp, title: new Date(link.timestamp).toLocaleString() }, timeAgo(link.timestamp));

  return h(
    'li',
    { class: fresh ? 'link fresh' : 'link', 'data-testid': 'link-item', 'data-id': link.id },
    safe
      ? h('a', { class: 'url', href: safe, target: '_blank', rel: 'noopener noreferrer', title: safe }, displayUrl(safe))
      : h('span', { class: 'url invalid' }, displayUrl(link.url)),
    h(
      'div',
      { class: 'meta' },
      h('span', { class: 'muted source' }, `${link.senderName} · `, time),
      h(
        'span',
        { class: 'actions' },
        h('button', { class: 'btn primary', disabled: !safe, onclick: () => safe && openUrl(safe) }, 'Open'),
        h('button', { class: 'btn', disabled: !safe, onclick: (e) => safe && void copy(safe, e.currentTarget as HTMLButtonElement) }, 'Copy'),
        h('button', { class: 'btn ghost', 'aria-label': 'Delete', title: 'Remove from history', onclick: () => void remove(link.id) }, '✕'),
      ),
    ),
  );
}

function renderPeers(): void {
  const peers = me?.peers ?? [];
  $('this-device').textContent = me?.device.name ?? '';
  $('peers').replaceChildren(
    ...peers.map((p) =>
      h(
        'li',
        { class: 'peer' },
        h('span', {}, p.name),
        h('button', { class: 'btn ghost small', 'aria-label': `Remove ${p.name}`, onclick: () => void unpair(p.id, p.name) }, 'Remove'),
      ),
    ),
  );
}

// ------------------------------------------------------------------ actions

function openUrl(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

async function copy(url: string, button: HTMLButtonElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    const ta = h('textarea', {}, url);
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  button.textContent = 'Copied ✓';
  setTimeout(() => (button.textContent = 'Copy'), 1500);
}

async function remove(id: string): Promise<void> {
  links = links.filter((l) => l.id !== id);
  renderLinks();
  await api.request('DELETE', `/api/links/${encodeURIComponent(id)}`).catch(() => undefined);
}

async function unpair(peerId: string, name: string): Promise<void> {
  if (!confirm(`Remove ${name}? It will no longer be able to send links to this computer.`)) return;
  await api.request('DELETE', `/api/pairings/${encodeURIComponent(peerId)}`);
  await refresh();
}

$('pair-another').addEventListener('click', () => {
  pairingRequested = true;
  void refresh();
});
$('pair-cancel').addEventListener('click', () => {
  pairingRequested = false;
  stopPairing();
  void refresh();
});
$('rename').addEventListener('click', async () => {
  // Renames the physical device; the browser label stays ("Work PC · Chrome").
  const name = prompt('Name this computer (shown on your phone):', me?.device.physicalDevice.name ?? '');
  if (!name?.trim()) return;
  await api.request('PATCH', '/api/me', { name });
  await refresh();
});
$('retry').addEventListener('click', () => void boot());

function renderNotifySettings(): void {
  const supported = 'Notification' in window;
  const permission = supported ? Notification.permission : 'denied';
  let dismissed = false;
  try {
    dismissed = localStorage.getItem(NOTIFY_DISMISSED_KEY) === '1';
  } catch {
    // ignore
  }
  $('notify-card').hidden = !supported || permission !== 'default' || dismissed;
  $('notify-status').textContent = !supported
    ? ''
    : permission === 'granted'
      ? 'Notifications on'
      : permission === 'denied'
        ? 'Notifications are blocked in your browser settings'
        : '';
}

$('notify').addEventListener('click', async () => {
  await Notification.requestPermission();
  renderNotifySettings();
});
$('notify-later').addEventListener('click', () => {
  try {
    localStorage.setItem(NOTIFY_DISMISSED_KEY, '1');
  } catch {
    // ignore
  }
  renderNotifySettings();
});
renderNotifySettings();

setInterval(() => {
  for (const el of document.querySelectorAll<HTMLTimeElement>('#links time')) {
    el.textContent = timeAgo(el.dateTime);
  }
}, 30_000);

void boot();
