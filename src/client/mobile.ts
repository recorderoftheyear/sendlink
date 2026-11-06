import { ApiClient, ApiRequestError, EventStream } from './api.js';
import { $, h, showView } from './dom.js';
import { clientProfile, isInstalledApp, profileUpdate, requestPersistentStorage } from './identity.js';
import { friendlyError, isNetworkError, MSG } from './messages.js';
import { newMessageId, relayTransport, send, type OutgoingLink } from './send.js';
import type { MeResponse, PeerInfo, RealtimeEvent, RedeemResponse } from '../shared/protocol.js';
import { displayUrl, extractUrl, validateUrl } from '../shared/url.js';

const api = new ApiClient('sendlink.mobile');
const TARGET_KEY = 'sendlink.mobile.target'; // unchanged: existing phones keep their last destination
const INSTALL_DISMISSED_KEY = 'sendlink.install.dismissedAt';
/** Minimal snapshot to render a useful screen without network: names and ids only. */
const CACHE_KEY = 'sendlink.mobile.cache';
const INSTALL_SNOOZE_MS = 14 * 24 * 3600_000;
const VIEWS = ['view-loading', 'view-connect', 'view-send', 'view-sent', 'view-unreachable'];

const input = $<HTMLInputElement>('url-input');
const sendBtn = $<HTMLButtonElement>('send-btn');
const feedback = $('feedback');

let me: MeResponse | null = null;
let selected: string | null = readStorage(TARGET_KEY);
/** Launched from the Share menu with a link: destination-first layout, closes after sending. */
let shareMode = false;
/** No network: the screen is rendered from the cache and nothing can be sent yet. */
let offline = false;
/** Transports in preference order. Only the Internet relay exists today. */
const transports = [relayTransport(api)];
/** The send in progress/last failed: retried with the same messageId (never duplicated). */
let pending: OutgoingLink | null = null;
/** The user opened the shared link for editing: keep the text field visible across re-renders. */
let editingUrl = false;

/**
 * Live channel while the screen is visible: destinations' Online/Offline update as computers
 * connect or disconnect. Stopped when hidden (no background work on the phone).
 */
const stream = new EventStream(api, {
  onEvent: handleEvent,
  onState: () => undefined,
  onResync: () => void refresh(),
  onUnauthorized: () => void refresh(),
});

function handleEvent(event: RealtimeEvent): void {
  if (event.type === 'presence') {
    const peer = me?.peers.find((p) => p.id === event.deviceId);
    if (peer && peer.online !== event.online) {
      peer.online = event.online;
      renderDestinations();
    }
  } else if (event.type === 'paired' || event.type === 'unpaired' || event.type === 'peer_updated') {
    void refresh();
  }
}

function syncStream(): void {
  const wanted = !document.hidden && !!me?.peers.length;
  if (wanted) stream.start();
  else stream.stop();
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable: preferences just aren't remembered
  }
}

/**
 * Reads what launched the page, then strips it from the address bar:
 *  - #pair=<secret>  from the QR code (fragment => never sent to the server in a URL)
 *  - ?url=/&text=/&title=  from the OS share sheet (Web Share Target)
 */
function readLaunchParams(): { secret: string | null; shared: string | null } {
  const hash = new URLSearchParams(location.hash.slice(1));
  const query = new URLSearchParams(location.search);
  const shared = extractUrl(query.get('url')) ?? extractUrl(query.get('text')) ?? extractUrl(query.get('title'));
  if (location.hash || location.search) history.replaceState(null, '', location.pathname);
  return { secret: hash.get('pair'), shared };
}

async function boot(): Promise<void> {
  const { secret, shared } = readLaunchParams();
  if (shared) {
    input.value = shared;
    shareMode = true;
  }
  if (secret) {
    try {
      await pair({ secret });
      return;
    } catch (err) {
      await refresh();
      if (!me?.peers.length) showConnect(friendlyError(err, 'connect'));
      else setFeedback(friendlyError(err, 'connect'), 'error');
      return;
    }
  }
  await refresh();
}

async function pair(credential: { secret?: string; code?: string }): Promise<void> {
  const { name, clientType, clientLabel } = clientProfile('mobile');
  const body = { ...credential, deviceName: name, clientType, clientLabel };
  let res: RedeemResponse;
  try {
    res = await api.request<RedeemResponse>('POST', '/api/pairings', body);
  } catch (err) {
    // Stored credential was revoked/deleted: connect again as a brand-new device.
    if (!(err instanceof ApiRequestError && err.status === 401)) throw err;
    api.clear();
    res = await api.request<RedeemResponse>('POST', '/api/pairings', body);
  }
  if (res.token) {
    api.save({ deviceId: res.device.id, token: res.token });
    requestPersistentStorage();
  }
  selectTarget(res.peer.id);
  await refresh();
  showNotice(`✓ Connected to ${res.peer.name}`);
}

async function refresh(): Promise<void> {
  if (!api.credentials) return showConnect();
  try {
    me = await api.request<MeResponse>('GET', '/api/me');
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 401) {
      api.clear();
      me = null;
      return showConnect(MSG.revoked);
    }
    if (isNetworkError(err)) return showOffline();
    setFeedback(friendlyError(err), 'error');
    return;
  }
  setOffline(false);
  saveCache(me);
  await syncProfile();
  if (!me.peers.length) return showConnect();
  if (!me.peers.some((p) => p.id === selected)) selectTarget(defaultDestination(me.peers).id);
  render();
  syncStream();
  // Don't pull the user off the "Sent" confirmation when state refreshes in the background.
  if ($('view-sent').hidden) showView(VIEWS, 'view-send');
}

// ------------------------------------------------------------------ offline

interface CachedState {
  savedAt: string;
  device: { name: string; physicalName: string };
  peers: { id: string; name: string }[];
}

function saveCache(state: MeResponse): void {
  const snapshot: CachedState = {
    savedAt: new Date().toISOString(),
    device: { name: state.device.name, physicalName: state.device.physicalDevice.name },
    peers: state.peers.map((p) => ({ id: p.id, name: p.name })),
  };
  writeStorage(CACHE_KEY, JSON.stringify(snapshot));
}

function loadCache(): CachedState | null {
  try {
    const parsed = JSON.parse(readStorage(CACHE_KEY) ?? 'null') as CachedState | null;
    return parsed && Array.isArray(parsed.peers) ? parsed : null;
  } catch {
    return null;
  }
}

/** Renders the last known destinations; sending stays possible to try, but is never assumed. */
function showOffline(): void {
  const cached = loadCache();
  const creds = api.credentials;
  if (!cached || !creds || !cached.peers.length) return showView(VIEWS, 'view-unreachable');
  const unknown = { type: 'browser' as const, label: null };
  me = {
    device: {
      id: creds.deviceId,
      name: cached.device.name,
      kind: 'mobile',
      physicalDevice: { id: '', name: cached.device.physicalName },
      client: { type: isInstalledApp() ? 'pwa' : 'browser', label: null },
    },
    peers: cached.peers.map((p) => ({
      id: p.id,
      name: p.name,
      kind: 'desktop',
      physicalDevice: { id: '', name: p.name },
      client: unknown,
      pairedAt: '',
      online: false,
    })),
  };
  setOffline(true);
  if (!me.peers.some((p) => p.id === selected)) selectTarget(me.peers[0]!.id);
  render();
  syncStream(); // reconnects by itself when the network comes back, then refreshes
  if ($('view-sent').hidden) showView(VIEWS, 'view-send');
}

function setOffline(value: boolean): void {
  offline = value;
  const banner = $('offline-banner');
  banner.textContent = value ? MSG.offlineBanner : '';
  banner.hidden = !value;
}

/** Used when the last destination no longer exists: first online one, else the most recently added. */
function defaultDestination(peers: PeerInfo[]): PeerInfo {
  return peers.find((p) => p.online) ?? peers[0]!;
}

function showConnect(notice?: string): void {
  stream.stop();
  $('connect-host').textContent = location.host;
  const el = $('connect-notice');
  el.textContent = notice ?? '';
  el.hidden = !notice;
  $('pending-share').hidden = !input.value;
  showView(VIEWS, 'view-connect');
}

/**
 * First launch as the installed app (home screen or Share Target) upgrades this client to
 * the canonical "pwa" identity — same credential, since the app shares this browser's storage.
 */
let profileSynced = false;
async function syncProfile(): Promise<void> {
  if (profileSynced || !me) return;
  profileSynced = true;
  const patch = profileUpdate(me.device, 'mobile');
  if (!patch) return;
  try {
    me.device = (await api.request<{ device: MeResponse['device'] }>('PATCH', '/api/me', patch)).device;
  } catch {
    profileSynced = false;
  }
}

// ------------------------------------------------------------------ rendering

function render(): void {
  renderDestinations();
  renderUrl();
  $('self-name').textContent = me?.device.name ?? '';
  $('unpair-name').textContent = currentTarget()?.name ?? '';
  renderInstall();
}

function renderDestinations(): void {
  const peers = me?.peers ?? [];
  const list = $('dest-list');
  const single = $('dest-single');
  const select = $<HTMLSelectElement>('dest-select');
  // Share mode: every destination visible, one tap to choose. Direct launch: compact.
  const mode = shareMode ? 'list' : peers.length > 1 ? 'select' : 'single';
  list.hidden = mode !== 'list';
  single.hidden = mode !== 'single';
  select.hidden = mode !== 'select';

  if (mode === 'list') {
    list.replaceChildren(
      ...peers.map((p) => {
        const on = p.id === selected;
        return h(
          'button',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(on),
            class: on ? 'dest selected' : 'dest',
            'data-testid': 'target',
            onclick: () => {
              selectTarget(p.id);
              render();
            },
          },
          h('span', { class: 'radio', 'aria-hidden': 'true' }),
          h(
            'span',
            { class: 'dest-text' },
            h('span', { class: 'dest-name', 'data-testid': 'target-name' }, p.name),
            h(
              'span',
              { class: `dest-status ${p.online ? 'on' : ''}` },
              offline ? 'Status unknown' : p.online ? 'Online' : 'Offline',
            ),
          ),
          on ? h('span', { class: 'check', 'aria-hidden': 'true' }, '✓') : null,
        );
      }),
    );
  } else if (mode === 'single') {
    const p = peers[0]!;
    single.replaceChildren(
      h('span', { class: 'dest-name', 'data-testid': 'target-name' }, p.name),
      h('span', { class: `dot ${p.online ? 'on' : 'off'}`, title: p.online ? 'Online' : 'Offline' }),
    );
  } else {
    select.replaceChildren(
      ...peers.map((p) => {
        const option = h('option', { value: p.id }, p.online ? p.name : `${p.name} (offline)`);
        option.selected = p.id === selected;
        return option;
      }),
    );
  }
}

function renderUrl(): void {
  const check = validateUrl(input.value);
  const preview = shareMode && check.ok && !editingUrl;
  $('shared-preview').hidden = !preview;
  $('url-row').hidden = preview;
  if (preview) $('shared-url').textContent = displayUrl(check.url, 60);
}

function selectTarget(id: string): void {
  selected = id;
  writeStorage(TARGET_KEY, id);
}

function currentTarget(): PeerInfo | undefined {
  return me?.peers.find((p) => p.id === selected);
}

function setFeedback(text: string, kind: 'ok' | 'error' | '' = ''): void {
  feedback.textContent = text;
  feedback.className = `feedback ${kind}`;
}

function showNotice(text: string): void {
  const el = $('notice');
  el.textContent = text;
  el.hidden = false;
}

// ------------------------------------------------------------------ sending

$('send-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const target = currentTarget();
  if (!target) return;
  const raw = input.value.trim();
  if (!raw) {
    input.focus();
    return setFeedback('Paste a link to send.', 'error');
  }
  const check = validateUrl(extractUrl(raw) ?? raw);
  if (!check.ok) return setFeedback(MSG.invalidUrl, 'error');

  // One logical send = one messageId, created before any transport is chosen. Tapping Send
  // again for the same link and destination (after a failure) reuses it: never a duplicate.
  if (!pending || pending.url !== check.url || pending.targetDeviceId !== target.id) {
    pending = { messageId: newMessageId(), targetDeviceId: target.id, url: check.url };
  }
  const link = pending;

  sendBtn.disabled = true;
  sendBtn.textContent = 'Sending…';
  setFeedback('');
  try {
    const outcome = await send(link, transports);
    pending = null;
    document.documentElement.dataset.lastSend = `${outcome.transport}:${outcome.status}`; // dev observability
    selectTarget(target.id);
    const note = outcome.status === 'delivered' ? '' : MSG.offlineDelivery;
    input.value = '';
    if (offline) void refresh(); // it went through: we're back online
    if (shareMode) {
      showSent(`Sent to ${target.name}`, note);
    } else {
      setFeedback(note ? `✓ Sent to ${target.name}. ${note}` : `✓ Sent to ${target.name}`, 'ok');
      renderUrl();
    }
  } catch (err) {
    // Never claim delivery: the link stays in the field and can be retried (same messageId).
    setFeedback(isNetworkError(err) ? MSG.notSentOffline : friendlyError(err, 'send'), 'error');
    if (!isNetworkError(err)) pending = null; // definitively rejected: a new attempt is a new send
    if (err instanceof ApiRequestError && (err.status === 403 || err.status === 401)) await refresh();
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send →';
  }
});

let autoCloseTimer: number | undefined;

/** Share mode done: confirm, then hand control back to the app the user came from. */
function showSent(title: string, note: string): void {
  $('sent-title').textContent = `✓ ${title}`;
  $('sent-note').textContent = note;
  showView(VIEWS, 'view-sent');
  // Standard API only. It works for the window Android opens for a share; if the browser
  // refuses, the confirmation stays and the user can go back or send another link.
  autoCloseTimer = window.setTimeout(() => window.close(), note ? 3000 : 1500);
}

$('sent-done').addEventListener('click', () => {
  window.close();
  window.setTimeout(leaveShareMode, 300); // still here: closing isn't allowed in this context
});
$('sent-another').addEventListener('click', leaveShareMode);

function leaveShareMode(): void {
  window.clearTimeout(autoCloseTimer); // the user chose to stay: never close under their finger
  shareMode = false;
  setFeedback('');
  render();
  showView(VIEWS, 'view-send');
  input.focus();
}

$('edit-url').addEventListener('click', () => {
  editingUrl = true;
  renderUrl();
  input.focus();
  input.select();
});

$('dest-select').addEventListener('change', (e) => {
  selectTarget((e.target as HTMLSelectElement).value);
  render();
});

input.addEventListener('input', () => setFeedback(''));

// ------------------------------------------------------------------ connecting

$('code-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $<HTMLInputElement>('code-input').value.trim();
  if (!code) return;
  $('connect-error').textContent = '';
  try {
    await pair({ code });
  } catch (err) {
    showConnect();
    $('connect-error').textContent = friendlyError(err, 'connect');
  }
});

$('unpair-btn').addEventListener('click', async () => {
  const target = currentTarget();
  if (!target || !confirm(`Disconnect from ${target.name}? You won't be able to send links to it anymore.`)) return;
  try {
    await api.request('DELETE', `/api/pairings/${encodeURIComponent(target.id)}`);
  } catch (err) {
    setFeedback(friendlyError(err), 'error');
  }
  await refresh();
});

$('rename-btn').addEventListener('click', async () => {
  if (!me) return;
  const name = prompt('Name this phone (shown on your computers):', me.device.physicalDevice.name);
  if (!name?.trim()) return;
  try {
    me.device = (await api.request<{ device: MeResponse['device'] }>('PATCH', '/api/me', { name })).device;
    render();
  } catch (err) {
    setFeedback(friendlyError(err), 'error');
  }
});

$('retry-btn').addEventListener('click', () => void boot());
window.addEventListener('online', () => {
  if (!$('view-unreachable').hidden || offline) void refresh();
});

// Clipboard read is only available in secure contexts (HTTPS / localhost).
const pasteBtn = $<HTMLButtonElement>('paste-btn');
if (window.isSecureContext && navigator.clipboard?.readText) {
  pasteBtn.hidden = false;
  pasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      input.value = extractUrl(text) ?? text.trim();
      setFeedback('');
    } catch {
      input.focus();
    }
  });
}

// ------------------------------------------------------------------ install (Android)

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let installPrompt: BeforeInstallPromptEvent | null = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // we show our own, better-timed card instead of the browser's banner
  installPrompt = e as BeforeInstallPromptEvent;
  renderInstall();
});

window.addEventListener('appinstalled', () => {
  installPrompt = null;
  $('install-card').hidden = true;
  $('installed-card').hidden = false;
});

function installSnoozed(): boolean {
  return Date.now() - Number(readStorage(INSTALL_DISMISSED_KEY) ?? 0) < INSTALL_SNOOZE_MS;
}

/**
 * Suggest installing only where it unlocks the Share menu (Android), once connected,
 * when not already the installed app, and not again for a while after "Not now".
 */
function renderInstall(): void {
  const alreadyInstalled = isInstalledApp() || me?.device.client.type === 'pwa';
  const show =
    !!me?.peers.length &&
    !alreadyInstalled &&
    !installSnoozed() &&
    /Android/.test(navigator.userAgent) &&
    !shareMode &&
    !offline;
  $('install-card').hidden = !show || !$('installed-card').hidden;
  $('install-manual').hidden = !!installPrompt;
  $('install-btn').hidden = !installPrompt;
}

$('install-btn').addEventListener('click', async () => {
  if (!installPrompt) return;
  const prompt = installPrompt;
  installPrompt = null;
  await prompt.prompt();
  const { outcome } = await prompt.userChoice;
  if (outcome === 'dismissed') writeStorage(INSTALL_DISMISSED_KEY, String(Date.now()));
  renderInstall();
});

$('install-later').addEventListener('click', () => {
  writeStorage(INSTALL_DISMISSED_KEY, String(Date.now()));
  renderInstall();
});

// ------------------------------------------------------------------ lifecycle

// A QR link opened in a tab already showing /m only changes the fragment (no reload).
window.addEventListener('hashchange', () => {
  const secret = new URLSearchParams(location.hash.slice(1)).get('pair');
  if (!secret) return;
  history.replaceState(null, '', location.pathname);
  pair({ secret }).catch((err: unknown) => setFeedback(friendlyError(err, 'connect'), 'error'));
});

// Returning to the app refreshes online/offline states (not while showing a result screen).
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return stream.stop();
  if (api.credentials && !$('view-send').hidden) void refresh(); // refresh() restarts the stream
});

// Needed for "Add to Home Screen" + Share Target on Android. Requires HTTPS.
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}

void boot();
