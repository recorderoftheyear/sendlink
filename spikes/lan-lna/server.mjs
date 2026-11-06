// DISPOSABLE SPIKE — not part of SendLink. See README.md in this folder.
//
// Two listeners in one process:
//   1. PWA files on 127.0.0.1:8787  -> expose through an HTTPS tunnel (the PWA needs a public HTTPS origin)
//   2. "Agent" on 0.0.0.0:47631     -> plain HTTP on the LAN; the PWA calls it with fetch()
//
// No crypto, no auth, no persistence: it only proves/disproves browser + network assumptions.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces, hostname } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PWA_PORT = Number(process.env.PWA_PORT ?? 8787);
const AGENT_PORT = Number(process.env.AGENT_PORT ?? 47631);
const PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

const stamp = () => new Date().toISOString().slice(11, 23);
const lanIps = () =>
  Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);

// ---------------------------------------------------------------- 1. PWA static files
createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const file = path === '/' ? 'index.html' : path.slice(1);
  if (!/^[\w.-]+$/.test(file) || !MIME[extname(file)]) {
    res.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(join(PUBLIC_DIR, file));
    res.writeHead(200, { 'Content-Type': MIME[extname(file)], 'Cache-Control': 'no-cache' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(PWA_PORT, '127.0.0.1');

// ---------------------------------------------------------------- 2. LAN agent
createServer((req, res) => {
  const origin = req.headers.origin ?? '(none)';
  const from = req.socket.remoteAddress?.replace('::ffff:', '');
  const pna = req.headers['access-control-request-private-network'];
  const cors = {
    'Access-Control-Allow-Origin': req.headers.origin ?? '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Private-Network': 'true', // legacy PNA preflight answer (harmless otherwise)
    'Access-Control-Max-Age': '0', // re-preflight every time: we want to see each one
    Vary: 'Origin',
  };

  if (req.method === 'OPTIONS') {
    console.log(`${stamp()}  PREFLIGHT from ${from}  origin=${origin}  request-private-network=${pna ?? '-'}  method=${req.headers['access-control-request-method']}`);
    res.writeHead(204, cors).end();
    return;
  }

  if (req.method === 'GET' && req.url === '/') {
    console.log(`${stamp()}  GET / from ${from} (reachability check)`);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`LAN spike agent on ${hostname()} is reachable.\n`);
    return;
  }

  if (req.url?.startsWith('/ping')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let info = {};
      try {
        info = body ? JSON.parse(body) : Object.fromEntries(new URL(req.url, 'http://x').searchParams);
      } catch {
        info = { raw: body.slice(0, 200) };
      }
      console.log(
        `\n${stamp()}  ✅ HIT ${req.method} /ping from ${from}  origin=${origin}\n` +
          `           scenario=${info.scenario ?? '-'}  mode=${info.displayMode ?? '-'}  launch=${info.launch ?? '-'}  ` +
          `online=${info.online ?? '-'}  conn=${info.connection ?? '-'}  variant=${info.variant ?? '-'}\n` +
          `           shared=${info.shared ?? '-'}\n`,
      );
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end(
        JSON.stringify({ ok: true, agent: hostname(), agentTime: new Date().toISOString(), received: info.scenario ?? null }),
      );
    });
    return;
  }

  res.writeHead(404, cors).end();
}).listen(AGENT_PORT, '0.0.0.0');

console.log(`LAN spike running.
  PWA files : http://127.0.0.1:${PWA_PORT}   (expose it: cloudflared tunnel --url http://localhost:${PWA_PORT})
  Agent     : http://0.0.0.0:${AGENT_PORT}
  LAN IPs   : ${lanIps().join(', ') || '(none found)'}   <- enter this IP in the phone page
Waiting for requests… (Ctrl+C to stop)`);
