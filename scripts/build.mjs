// Builds the client bundles + static files into dist/public and the server into dist/server.js.
// `--watch` rebuilds on change and runs the server with tsx in watch mode.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/public/assets', { recursive: true });
const copyPublic = () => cpSync('public', 'dist/public', { recursive: true });
copyPublic();

// Stamp the service worker with a hash of the offline app shell: any change to the shell
// produces a new sw.js, so browsers install a fresh cache instead of serving a stale app.
const SHELL_FILES = ['mobile.html', 'assets/mobile.js', 'styles.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];
function stampServiceWorker() {
  const hash = createHash('sha256');
  for (const file of SHELL_FILES) {
    const path = `dist/public/${file}`;
    if (existsSync(path)) hash.update(readFileSync(path));
  }
  const build = hash.digest('hex').slice(0, 12);
  const sw = readFileSync('public/sw.js', 'utf8').replace('__SENDLINK_BUILD__', build);
  writeFileSync('dist/public/sw.js', sw);
}

const client = {
  entryPoints: { desktop: 'src/client/desktop.ts', mobile: 'src/client/mobile.ts' },
  outdir: 'dist/public/assets',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  minify: !watch,
  sourcemap: watch,
  logLevel: 'info',
};

const server = {
  entryPoints: ['src/server/index.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node20'],
  packages: 'external',
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context({
    ...client,
    plugins: [
      {
        name: 'copy-public',
        setup: (b) =>
          b.onEnd(() => {
            copyPublic();
            stampServiceWorker();
          }),
      },
    ],
  });
  await ctx.watch();
  spawn('npx', ['tsx', 'watch', 'src/server/index.ts'], { stdio: 'inherit' });
} else {
  await Promise.all([esbuild.build(client), esbuild.build(server)]);
  stampServiceWorker();
}
