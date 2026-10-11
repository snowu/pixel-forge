#!/usr/bin/env node
// pixel-forge scan  [dir] [-o pixel-art.json]   list the project's pixel art as JSON
// pixel-forge serve [dir] [--port 5173] [--open] edit it in the browser (the default command)
// pixel-forge init  [dir] [--force]               write a starter pixel-forge.config.json from what a scan finds
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { scan, suggestConfig } from '../src/scan.mjs';
import { createServer } from '../src/serve.mjs';

const args = process.argv.slice(2);
const cmd = ['scan', 'serve', 'init'].includes(args[0]) ? args.shift() : 'serve';
const flag = (n) => { const i = args.indexOf(n); if (i < 0) return null; const [, v] = args.splice(i, 2); return v ?? null; };
const has = (n) => { const i = args.indexOf(n); if (i < 0) return false; args.splice(i, 1); return true; };

if (has('--help') || has('-h')) {
  console.log(`pixel-forge: edit a project's pixel art in the browser

  pixel-forge [serve] [dir] [--port 5173] [--open]
  pixel-forge scan [dir] [-o pixel-art.json]
  pixel-forge init [dir] [--force]      write a starter pixel-forge.config.json (skips docs, screenshots, previews)

Put pixel-forge.config.json in the project to choose folders, ignore patterns, a palette (.hex) and animation frame sizes. See README.md.`);
  process.exit(0);
}
const out = flag('-o'), port = +(flag('--port') || 5173), open = has('--open'), force = has('--force');
const dir = args[0] || '.';
if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { console.error(`Not a folder: ${dir}`); process.exit(1); }

if (cmd === 'init') {
  const file = path.join(dir, 'pixel-forge.config.json');
  if (fs.existsSync(file) && !force) { console.error(`${file} already exists (use --force to overwrite).`); process.exit(1); }
  const before = scan(dir, { dirs: [] }), { config, kept, skipped } = suggestConfig(before);
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  console.log(`Wrote ${file}\n  ${before.sprites.length} PNGs found, ${kept} look like game art${skipped ? ` (${skipped} in docs/screenshots/previews/test folders are skipped)` : ''}.\n  dirs: ${config.dirs ? config.dirs.join(', ') : '(whole project)'}\n\nNext:  npx pixel-forge --open      (add  "art": "pixel-forge --open"  to package.json scripts if you like)`);
} else if (cmd === 'scan') {
  const m = scan(dir), json = JSON.stringify(m, null, 2) + '\n';
  if (out) { fs.writeFileSync(out, json); console.error(`${m.sprites.length} sprites -> ${out}`); } else process.stdout.write(json);
} else {
  const s = createServer({ root: dir, port });
  s.listen().then((url) => {
    const n = scan(dir).sprites.length;
    console.log(`pixel-forge: ${n} sprite${n === 1 ? '' : 's'} found in ${s.root}\n  ${url}\nCtrl+C to stop. Saving writes straight into that folder.`);
    if (open) { const opener = process.platform === 'darwin' ? ['open'] : process.platform === 'win32' ? ['cmd', '/c', 'start'] : ['xdg-open']; spawn(opener[0], [...opener.slice(1), url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); }
  }).catch((e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${port} is busy. Try --port ${port + 1}.` : e.message); process.exit(1); });
}
