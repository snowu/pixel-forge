// Finds the pixel art in a project: every PNG under the root that is small enough to be a sprite or tile sheet.
// Reads only the 24-byte PNG header of each file, so it is fast even in big repositories. No dependencies.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = {
  ignore: ['node_modules', '.git', '.godot', '.import', '.zig-cache', 'zig-cache', 'zig-out', 'dist', 'build', 'target', '.venv', '__pycache__', '.next', 'coverage'],
  maxSize: 1024, // pixels, per side. Larger images are photos, backgrounds or screenshots, not sprites.
  maxFiles: 5000,
};
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height from the PNG header, or null if the file is not a PNG. */
export function readPngSize(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(24);
    if (fs.readSync(fd, b, 0, 24, 0) < 24 || !b.subarray(0, 8).equals(PNG_SIG) || b.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  } finally { fs.closeSync(fd); }
}

export function loadConfig(root) {
  const f = path.join(root, 'pixel-forge.config.json');
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { throw new Error(`${f} is not valid JSON: ${e.message}`); }
}

/** "owner/name" from a git remote URL (ssh or https), or null. */
export function slugFromRemote(url) {
  const m = /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(url).trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Where the git root is relative to `root` (so the PR flow can build repo-relative paths), plus the origin slug. */
export function gitInfo(root) {
  let dir = path.resolve(root);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      let slug = null;
      try {
        const cfg = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8');
        const m = /\[remote "origin"\][^[]*?url\s*=\s*(.+)/.exec(cfg);
        if (m) slug = slugFromRemote(m[1]);
      } catch { /* .git may be a file (worktree/submodule): no remote info */ }
      const rel = path.relative(dir, path.resolve(root)).split(path.sep).join('/');
      return { slug, prefix: rel ? rel + '/' : '' };
    }
    const up = path.dirname(dir);
    if (up === dir) return { slug: null, prefix: '' };
    dir = up;
  }
}

/** A tiny glob: * matches within a path segment, ** across segments. */
export function globToRegExp(g) {
  const re = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return new RegExp('^' + re + '$');
}

export function scan(root, userConfig) {
  root = path.resolve(root);
  const cfg = { ...DEFAULTS, ...loadConfig(root), ...(userConfig || {}) };
  const ignore = new Set(cfg.ignore);
  const dirs = cfg.dirs && cfg.dirs.length ? cfg.dirs : ['.'];
  const exclude = (cfg.exclude || []).map(globToRegExp);
  const sprites = [];
  const walk = (abs) => {
    if (sprites.length >= cfg.maxFiles) return;
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.isSymbolicLink()) continue; // never follow links out of the project or into loops
      const p = path.join(abs, e.name);
      if (e.isDirectory()) { if (!ignore.has(e.name)) walk(p); continue; }
      if (!e.isFile() || !/\.png$/i.test(e.name)) continue;
      const rel = path.relative(root, p).split(path.sep).join('/');
      if (exclude.some((r) => r.test(rel))) continue;
      const size = readPngSize(p);
      if (!size || size.w > cfg.maxSize || size.h > cfg.maxSize || size.w < 1 || size.h < 1) continue;
      const s = { path: rel, w: size.w, h: size.h, bytes: fs.statSync(p).size };
      const fr = cfg.frames && (cfg.frames[rel] || Object.entries(cfg.frames).find(([k]) => k.includes('*') && globToRegExp(k).test(rel))?.[1]);
      if (fr) s.frames = fr;
      sprites.push(s);
    }
  };
  for (const d of dirs) { const abs = path.resolve(root, d); if (abs === root || abs.startsWith(root + path.sep)) walk(abs); }
  let palette = null;
  if (cfg.palette) {
    try { palette = fs.readFileSync(path.resolve(root, cfg.palette), 'utf8').split(/[\s,;]+/).map((t) => /^#?[0-9a-f]{6}$/i.test(t) ? '#' + t.replace('#', '').toLowerCase() : null).filter(Boolean); } catch { /* missing palette file: ignore */ }
  }
  const git = gitInfo(root);
  return { version: 1, generated: new Date().toISOString(), repo: { slug: cfg.repo?.slug || git.slug, base: cfg.repo?.base || null, prefix: cfg.repo?.prefix ?? git.prefix }, palette, sprites };
}
