// A small local server: serves the editor, lists the project's sprites, and writes edited PNGs back into the project folder.
// It binds to 127.0.0.1 only. Writes need a per-run secret header, which blocks other websites from poking at your files
// (a cross-origin request with a custom header needs a CORS preflight, and this server never answers one).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scan, DEFAULTS, loadConfig } from './scan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.join(here, '..');
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_BYTES = 8 * 1024 * 1024;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.json': 'application/json', '.hex': 'text/plain', '.svg': 'image/svg+xml' };

/** Resolve a request path to a file inside root, or null if it escapes, is hidden, or lives in an ignored folder. */
export function safeResolve(root, rel, ignore = DEFAULTS.ignore) {
  let p;
  try { p = decodeURIComponent(rel); } catch { return null; }
  if (!p || p.includes('\0') || p.includes('\\') || path.isAbsolute(p)) return null;
  const parts = p.split('/').filter(Boolean);
  if (!parts.length || parts.some((s) => s === '..' || s === '.' || ignore.includes(s) || s.startsWith('.'))) return null;
  const abs = path.resolve(root, ...parts);
  return abs.startsWith(root + path.sep) ? abs : null;
}

export function createServer({ root, port = 5173, host = '127.0.0.1', config } = {}) {
  root = fs.realpathSync(path.resolve(root || '.'));
  const token = crypto.randomBytes(16).toString('hex');
  const ignore = [...DEFAULTS.ignore, ...(config?.ignore || loadConfig(root).ignore || [])];
  let actualPort = port;
  const hostOk = (h) => { const m = /^(127\.0\.0\.1|localhost|\[::1\]):(\d+)$/.exec(String(h || '')); return !!m && +m[2] === actualPort; };
  const send = (res, code, body, type = 'text/plain; charset=utf-8', extra = {}) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra }); res.end(body); };

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostOk(req.headers.host)) return send(res, 403, 'Bad host header');
      const url = new URL(req.url, 'http://x'), p = url.pathname;
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        const html = fs.readFileSync(path.join(pkgDir, 'index.html'), 'utf8').replace('<!--PF_TOKEN-->', `<meta name="pf-token" content="${token}">`);
        return send(res, 200, html, MIME['.html']);
      }
      if (req.method === 'GET' && p === '/spritewright.js') return send(res, 200, fs.readFileSync(path.join(pkgDir, 'spritewright.js')), MIME['.js']);
      if (req.method === 'GET' && p === '/api/manifest') return send(res, 200, JSON.stringify(scan(root, config)), MIME['.json']);
      // a sprite's git history (read-only): the last commits that touched it, and the file as it was in one of them
      if (req.method === 'GET' && (p === '/api/history' || p === '/api/file-at')) {
        const rel = url.searchParams.get('path') || '', abs = safeResolve(root, rel, ignore);
        if (!abs || path.extname(abs).toLowerCase() !== '.png') return send(res, 400, 'Bad path');
        const git = (args) => execFileSync('git', ['-C', root, ...args], { maxBuffer: 32 << 20, stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 });
        if (p === '/api/history') {
          let out = '';
          try { out = git(['log', '-n', '30', '--format=%H%x1f%aI%x1f%an%x1f%s', '--', rel]).toString(); } catch { return send(res, 200, '[]', MIME['.json']); } // not a git repository
          const list = out.split('\n').filter(Boolean).map((l) => { const [sha, date, author, message] = l.split('\x1f'); return { sha, date, author, message }; });
          return send(res, 200, JSON.stringify(list), MIME['.json']);
        }
        const sha = url.searchParams.get('sha') || '';
        if (!/^([0-9a-f]{7,40}|HEAD)$/.test(sha)) return send(res, 400, 'Bad commit'); // HEAD: the file as committed on the checked-out branch
        try { git(['rev-parse', '--verify', '-q', 'HEAD']); } catch { return send(res, 409, 'Not a git repository (or nothing committed yet)'); }
        try { return send(res, 200, git(['show', `${sha}:./${rel}`]), MIME['.png']); } catch { return send(res, 404, 'Not in that commit'); }
      }
      if (p.startsWith('/project/')) {
        const abs = safeResolve(root, p.slice('/project/'.length), ignore);
        if (!abs) return send(res, 400, 'Bad path');
        const ext = path.extname(abs).toLowerCase();
        if (req.method === 'GET') {
          if (ext !== '.png' && ext !== '.hex') return send(res, 403, 'Only PNG and palette files are served');
          if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return send(res, 404, 'Not found');
          return send(res, 200, fs.readFileSync(abs), MIME[ext]);
        }
        if (req.method === 'DELETE') { // only a sprite's layers file, once the sprite is back to one layer
          if (req.headers['x-spritewright'] !== token) return send(res, 403, 'Missing or wrong token');
          if (!/\.layers\.png$/i.test(abs)) return send(res, 400, 'Only .layers.png files can be removed');
          if (!fs.existsSync(abs)) return send(res, 404, 'Not found');
          fs.unlinkSync(abs); return send(res, 200, JSON.stringify({ ok: true }), MIME['.json']);
        }
        if (req.method === 'PUT') {
          if (req.headers['x-spritewright'] !== token) return send(res, 403, 'Missing or wrong token');
          if (ext !== '.png') return send(res, 400, 'Only .png files can be written');
          const chunks = []; let size = 0;
          for await (const c of req) { size += c.length; if (size > MAX_BYTES) return send(res, 413, 'File too large'); chunks.push(c); }
          const body = Buffer.concat(chunks);
          if (body.length < 33 || !body.subarray(0, 8).equals(PNG_SIG)) return send(res, 400, 'Not a PNG');
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          const tmp = abs + '.pf-tmp-' + process.pid; fs.writeFileSync(tmp, body); fs.renameSync(tmp, abs);
          return send(res, 200, JSON.stringify({ ok: true, bytes: body.length }), MIME['.json']);
        }
      }
      return send(res, 404, 'Not found');
    } catch (e) { return send(res, 500, 'Server error: ' + e.message); }
  });
  return {
    server, token, root,
    listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { actualPort = server.address().port; resolve(`http://${host === '::1' ? '[::1]' : host}:${actualPort}/`); }); }),
    close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }), // a browser keeps idle keep-alive connections open, and close() waits for them
  };
}
