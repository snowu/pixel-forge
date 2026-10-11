// A small local server: serves the editor, lists the project's sprites, and writes edited PNGs back into the project folder.
// It binds to 127.0.0.1 only. Writes need a per-run secret header, which blocks other websites from poking at your files
// (a cross-origin request with a custom header needs a CORS preflight, and this server never answers one).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
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
      if (req.method === 'GET' && p === '/pixel-forge.js') return send(res, 200, fs.readFileSync(path.join(pkgDir, 'pixel-forge.js')), MIME['.js']);
      if (req.method === 'GET' && p === '/api/manifest') return send(res, 200, JSON.stringify(scan(root, config)), MIME['.json']);
      if (p.startsWith('/project/')) {
        const abs = safeResolve(root, p.slice('/project/'.length), ignore);
        if (!abs) return send(res, 400, 'Bad path');
        const ext = path.extname(abs).toLowerCase();
        if (req.method === 'GET') {
          if (ext !== '.png' && ext !== '.hex') return send(res, 403, 'Only PNG and palette files are served');
          if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return send(res, 404, 'Not found');
          return send(res, 200, fs.readFileSync(abs), MIME[ext]);
        }
        if (req.method === 'PUT') {
          if (req.headers['x-pixel-forge'] !== token) return send(res, 403, 'Missing or wrong token');
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
    close: () => new Promise((r) => server.close(r)),
  };
}
