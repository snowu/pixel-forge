#!/usr/bin/env node
// pixel-forge scan  [dir] [-o pixel-art.json]   list the project's pixel art as JSON
// pixel-forge serve [dir] [--port 5173] [--open] edit it in the browser (the default command)
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { scan } from '../src/scan.mjs';
import { createServer } from '../src/serve.mjs';

const args = process.argv.slice(2);
const cmd = ['scan', 'serve'].includes(args[0]) ? args.shift() : 'serve';
const flag = (n) => { const i = args.indexOf(n); if (i < 0) return null; const [, v] = args.splice(i, 2); return v ?? null; };
const has = (n) => { const i = args.indexOf(n); if (i < 0) return false; args.splice(i, 1); return true; };

if (has('--help') || has('-h')) {
  console.log(`pixel-forge: edit a project's pixel art in the browser

  pixel-forge [serve] [dir] [--port 5173] [--open]
  pixel-forge scan [dir] [-o pixel-art.json]

Put pixel-forge.config.json in the project to choose folders, ignore patterns, a palette (.hex) and animation frame sizes. See README.md.`);
  process.exit(0);
}
const out = flag('-o'), port = +(flag('--port') || 5173), open = has('--open');
const dir = args[0] || '.';
if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { console.error(`Not a folder: ${dir}`); process.exit(1); }

if (cmd === 'scan') {
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
