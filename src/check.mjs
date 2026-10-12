// `spritewright check`: an art check for pull requests (or any time). Reads every sprite, or only the ones changed since a
// git ref, and reports problems in a Markdown table (for GitHub's job summary) or as JSON.
//   errors (exit 1):  a PNG that cannot be read, or larger than maxSize
//   warnings:         colours outside the project palette, a sprite whose size changed, animation frames of different
//                     sizes, a fully transparent image
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { scan, DEFAULTS, loadConfig } from './scan.mjs';
await import('../spritewright.js');
const PF = globalThis.Spritewright, C = PF.core;

const git = (root, args) => execFileSync('git', ['-C', root, ...args], { maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });

export async function check(root, { since } = {}) {
  root = path.resolve(root);
  const m = scan(root), cfg = { ...DEFAULTS, ...loadConfig(root) }, all = m.sprites.map((s) => s.path);
  let targets = all, outside = [];
  if (since) {
    const changed = git(root, ['diff', '--name-only', '--relative', '--diff-filter=AMR', `${since}...HEAD`, '--', '*.png', '*.PNG']).toString().split('\n').filter(Boolean);
    targets = all.filter((p) => changed.includes(p)); outside = changed.filter((p) => !all.includes(p));
  }
  const palette = m.palette ? new Set(m.palette.map((h) => C.fromHex(h) & 0xffffff)) : null;
  const fam = new Map(); for (const g of C.groupSprites(all)) for (const f of g.families) for (const p of f.members) fam.set(p, f);
  const decode = async (bytes) => PF.png.decode(new Uint8Array(bytes));
  const rows = [];
  for (const p of targets) {
    const row = { path: p, errors: [], warnings: [], notes: [] };
    rows.push(row);
    let img;
    try { img = await decode(fs.readFileSync(path.join(root, p))); } catch (e) { row.errors.push('cannot be read: ' + e.message); continue; }
    row.size = `${img.w}×${img.h}`;
    if (img.w > cfg.maxSize || img.h > cfg.maxSize) row.errors.push(`larger than maxSize (${cfg.maxSize})`);
    const cols = new Set(); let opaque = 0;
    for (const c of img.px) if (c >>> 24) { opaque++; cols.add(c & 0xffffff); }
    row.colours = cols.size;
    if (!opaque) row.warnings.push('fully transparent');
    if (palette) { const off = [...cols].filter((c) => !palette.has(c)); if (off.length) row.warnings.push(`${off.length} colour${off.length > 1 ? 's' : ''} outside the palette (${off.slice(0, 4).map((c) => C.toHex(c >>> 0 | 0xff000000)).join(' ')}${off.length > 4 ? ' …' : ''})`); }
    if (since) {
      let before = null;
      try { before = await decode(git(root, ['show', `${since}:./${p}`])); } catch { row.notes.push('new'); }
      if (before) {
        if (before.w !== img.w || before.h !== img.h) row.warnings.push(`size changed from ${before.w}×${before.h}`);
        else row.changed = C.countDiff(before.px, img.px);
      }
    }
    const f = fam.get(p);
    if (f && f.animated && f.members.length > 1) {
      const sizes = new Set();
      for (const q of f.members) { try { const b = fs.readFileSync(path.join(root, q)); sizes.add(`${b.readUInt32BE(16)}×${b.readUInt32BE(20)}`); } catch { /* unreadable: reported on its own row */ } }
      if (sizes.size > 1) row.warnings.push(`frames of "${f.key}" differ in size (${[...sizes].join(', ')})`);
    }
  }
  const errors = rows.reduce((n, r) => n + r.errors.length, 0), warnings = rows.reduce((n, r) => n + r.warnings.length, 0);
  return { rows, outside, errors, warnings, since: since || null, palette: !!palette };
}

export function markdown(res) {
  const esc = (t) => String(t).replace(/\|/g, '\\|');
  const lines = ['## Art check (spritewright)', ''];
  if (!res.rows.length) lines.push(res.since ? `No sprites changed since \`${res.since}\`.` : 'No sprites found.');
  else {
    lines.push('| Sprite | Size | Colours | ' + (res.since ? 'Changed px | ' : '') + 'Result |', '| --- | --- | --- | ' + (res.since ? '--- | ' : '') + '--- |');
    for (const r of res.rows) {
      const result = [...r.errors.map((e) => '❌ ' + e), ...r.warnings.map((w) => '⚠️ ' + w), ...r.notes].join('<br>') || '✅';
      lines.push(`| \`${esc(r.path)}\` | ${r.size || '?'} | ${r.colours ?? '?'} | ` + (res.since ? `${r.changed ?? (r.notes.includes('new') ? 'new' : '–')} | ` : '') + `${esc(result)} |`);
    }
  }
  if (res.outside.length) lines.push('', `${res.outside.length} changed PNG${res.outside.length > 1 ? 's are' : ' is'} outside the art folders and not checked: ${res.outside.slice(0, 8).map((p) => '`' + esc(p) + '`').join(', ')}`);
  lines.push('', `**${res.errors} error${res.errors === 1 ? '' : 's'}, ${res.warnings} warning${res.warnings === 1 ? '' : 's'}**${res.palette ? '' : ' · no project palette configured, so colours are not checked'}`, '');
  return lines.join('\n');
}
