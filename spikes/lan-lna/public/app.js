// DISPOSABLE SPIKE — records exactly what Chrome does when an installed HTTPS PWA
// calls a plain-HTTP agent on the LAN (Local Network Access).
const $ = (id) => document.getElementById(id);
const LOG_KEY = 'spike.log';
const PERMISSION_NAMES = ['local-network-access', 'local-network', 'loopback-network'];
const AGENT_PORT = 47631;
const TIMEOUT_MS = 60_000; // long on purpose: the fetch may wait while the permission prompt is open

// ---------------------------------------------------------------- persistent log
const readLog = () => {
  try {
    return JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
  } catch {
    return [];
  }
};
function log(line) {
  const entry = `${new Date().toISOString().slice(11, 23)} ${line}`;
  const all = [...readLog(), entry].slice(-300);
  localStorage.setItem(LOG_KEY, JSON.stringify(all));
  renderLog();
}
function renderLog() {
  $('log').textContent = readLog().slice().reverse().join('\n');
}

// ---------------------------------------------------------------- context
const params = new URLSearchParams(location.search);
const shared = params.get('url') || params.get('text') || params.get('title') || '';
const standalone = matchMedia('(display-mode: standalone)').matches;
const launch = shared ? 'share-target' : standalone ? 'home-screen' : 'browser-tab';
const chrome = (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || '?';

async function permissionStates() {
  const out = {};
  for (const name of PERMISSION_NAMES) {
    try {
      out[name] = (await navigator.permissions.query({ name })).state;
    } catch (e) {
      out[name] = `unsupported(${e.name})`;
    }
  }
  return out;
}
const permString = (p) => Object.entries(p).map(([k, v]) => `${k}=${v}`).join(' ');

async function offlineReady() {
  try {
    return !!(await caches.match('/index.html'));
  } catch {
    return false;
  }
}

async function renderContext() {
  const perms = await permissionStates();
  const lines = [
    ['Launch', launch],
    ['Display mode', standalone ? 'standalone (installed app)' : 'browser'],
    ['Chrome', chrome],
    ['navigator.onLine', String(navigator.onLine)],
    ['Connection', navigator.connection?.type ?? 'n/a'],
    ['SW controls page', String(!!navigator.serviceWorker?.controller)],
    ['Offline ready', String(await offlineReady())],
    ['Permission', permString(perms)],
    ['Shared', shared || '-'],
  ];
  $('ctx').replaceChildren(
    ...lines.map(([k, v]) => {
      const div = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = k;
      div.append(b, document.createTextNode(' ' + v));
      return div;
    }),
  );
  return perms;
}

// ---------------------------------------------------------------- attempts
async function attempt(variant) {
  const ip = $('ip').value.trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    setResult('Enter the PC LAN IP first', false);
    return;
  }
  localStorage.setItem('spike.ip', ip);
  const scenario = $('scenario').value;
  localStorage.setItem('spike.scenario', scenario);

  const info = {
    scenario,
    variant,
    launch,
    displayMode: standalone ? 'standalone' : 'browser',
    online: navigator.onLine,
    connection: navigator.connection?.type ?? 'n/a',
    shared: shared || null,
    chrome,
  };
  const before = await permissionStates();
  log(`${scenario} ${variant} START launch=${launch} online=${info.online} conn=${info.connection} perm-before: ${permString(before)}`);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = performance.now();
  let url = `http://${ip}:${AGENT_PORT}/ping`;
  const init = { signal: ctrl.signal, cache: 'no-store' };
  if (variant === 'A') Object.assign(init, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(info), targetAddressSpace: 'local' });
  if (variant === 'B') Object.assign(init, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(info) });
  if (variant === 'C') {
    url += '?' + new URLSearchParams(Object.entries(info).map(([k, v]) => [k, String(v)]));
    Object.assign(init, { method: 'GET', targetAddressSpace: 'local' });
  }

  try {
    const res = await fetch(url, init);
    const body = await res.json().catch(() => null);
    const ms = Math.round(performance.now() - t0);
    const after = await permissionStates();
    log(`${scenario} ${variant} OK http=${res.status} ${ms}ms agent=${body?.agent} perm-after: ${permString(after)}`);
    setResult(`✅ ${scenario}/${variant}: agent reached in ${ms} ms`, true);
  } catch (e) {
    const ms = Math.round(performance.now() - t0);
    const after = await permissionStates();
    log(`${scenario} ${variant} FAIL ${e.name}: ${e.message} after ${ms}ms perm-after: ${permString(after)}`);
    setResult(`❌ ${scenario}/${variant}: ${e.name}: ${e.message} (${ms} ms)`, false);
  } finally {
    clearTimeout(timer);
    renderContext();
  }
}

function setResult(text, ok) {
  $('result').textContent = text;
  $('result').className = ok ? 'ok' : 'err';
}

// ---------------------------------------------------------------- wiring
$('ip').value = localStorage.getItem('spike.ip') || '';
const savedScenario = localStorage.getItem('spike.scenario');
if (launch === 'share-target') $('scenario').value = 'S3';
else if (launch === 'home-screen') $('scenario').value = 'S2';
else if (savedScenario) $('scenario').value = savedScenario;

$('send').onclick = () => attempt('A');
$('sendB').onclick = () => attempt('B');
$('sendC').onclick = () => attempt('C');
$('perm').onclick = async () => log(`PERMISSION ${permString(await renderContext())}`);
$('copy').onclick = async () => {
  const text = readLog().join('\n');
  try {
    await navigator.clipboard.writeText(text);
    setResult('Log copied — paste it back to Claude', true);
  } catch {
    setResult('Clipboard blocked: long-press the log to select it', false);
  }
};
$('clear').onclick = () => {
  if (confirm('Clear the whole log?')) {
    localStorage.removeItem(LOG_KEY);
    renderLog();
  }
};

(async () => {
  const perms = await renderContext();
  log(`LAUNCH ${launch} chrome=${chrome} online=${navigator.onLine} conn=${navigator.connection?.type ?? 'n/a'} sw=${!!navigator.serviceWorker?.controller} perm: ${permString(perms)}${shared ? ` shared=${shared}` : ''}`);
  renderLog();
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      renderContext();
    } catch (e) {
      log(`SW register failed: ${e.message}`);
    }
  }
})();
