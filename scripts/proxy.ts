// Test reverse proxy used to reproduce proxy behaviour locally.
//
//   mode "stream": forwards bytes as they arrive (nginx with buffering off, named Cloudflare tunnels…)
//   mode "buffer": forwards headers at once but holds the body until the upstream response ends —
//                  what Cloudflare Quick Tunnels (*.trycloudflare.com) were measured to do. SSE never
//                  gets through; long-polling does.
//
// CLI: npx tsx scripts/proxy.ts <listenPort> <targetPort> [stream|buffer]
import { createServer, request, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';

export type ProxyMode = 'stream' | 'buffer';

export function createProxy(targetPort: number, mode: ProxyMode, targetHost = '127.0.0.1'): Server {
  return createServer((req, res) => {
    const upstream = request(
      {
        host: targetHost,
        port: targetPort,
        method: req.method,
        path: req.url,
        headers: {
          ...req.headers,
          'x-forwarded-for': req.socket.remoteAddress ?? '',
          'x-forwarded-proto': 'http',
        },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        res.flushHeaders();
        if (mode === 'stream') {
          up.pipe(res);
          return;
        }
        const chunks: Buffer[] = [];
        up.on('data', (c: Buffer) => chunks.push(c));
        up.on('end', () => res.end(Buffer.concat(chunks)));
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [listen = '4174', target = '4173', mode = 'buffer'] = process.argv.slice(2);
  createProxy(Number(target), mode as ProxyMode).listen(Number(listen), '127.0.0.1', () => {
    console.log(`${mode} proxy http://localhost:${listen} -> :${target}`);
  });
}
