/* spritewright: a small pixel art editor with no dependencies and no build step.
   Drop this one file into any project (or open the bundled index.html through `spritewright serve`), call Spritewright.mount(element, options),
   and it lists the project's PNG sprites, lets you edit them, saves them back, and can propose the change as a GitHub pull request.
   https://developer.mozilla.org/en-US/docs/Web/API/ImageData is the only "API" it leans on, plus fetch and canvas. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; // CommonJS and bundlers that treat this file as CommonJS
  root.Spritewright = api; // always register the global too: <script> tags, and index.mjs read it
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* =====================================================================================================
     Colours are packed little-endian into a Uint32 (0xAABBGGRR), which is exactly how a canvas's RGBA bytes
     read as a Uint32 on every platform browsers run on. Comparing two pixels is then one integer compare.
     ===================================================================================================== */
  const pack = (r, g, b, a = 255) => (((a << 24) | (b << 16) | (g << 8) | r) >>> 0);
  const unpack = (c) => [c & 255, (c >>> 8) & 255, (c >>> 16) & 255, c >>> 24];
  const toHex = (c) => '#' + unpack(c).slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('');
  const fromHex = (h) => {
    const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(h).trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return pack((n >> 16) & 255, (n >> 8) & 255, n & 255, m[2] ? parseInt(m[2], 16) : 255);
  };
  const isClear = (c) => c >>> 24 === 0;
  /** Parse a palette: Lospec .hex (one rrggbb per line) or any text containing #rrggbb values. Duplicates removed, order kept. */
  function parsePalette(text) {
    const out = [], seen = new Set();
    for (const tok of String(text).split(/[\s,;]+/)) {
      const c = tok ? fromHex(tok) : null;
      if (c != null && !seen.has(c)) { seen.add(c); out.push(c); }
    }
    return out;
  }
  const dist2 = (a, b) => { const p = unpack(a), q = unpack(b); return (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2; };
  /** The palette colour closest to c by RGB distance; the first one wins ties. */
  function nearestColor(c, palette) {
    let best = palette[0], bd = Infinity;
    for (const p of palette) { const d = dist2(c, p); if (d < bd) { bd = d; best = p; } }
    return best;
  }

  /* =====================================================================================================
     Drawing algorithms, pure functions over a Uint32Array so they are easy to test.
     ===================================================================================================== */
  /** Bresenham: every pixel on the line from (x0,y0) to (x1,y1), inclusive. */
  function linePoints(x0, y0, x1, y1) {
    const pts = [], dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      pts.push([x0, y0]);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
    return pts;
  }
  /** The pixels of a rectangle between two corners, outline only or filled. */
  function rectPoints(x0, y0, x1, y1, filled) {
    const pts = [], ax = Math.min(x0, x1), bx = Math.max(x0, x1), ay = Math.min(y0, y1), by = Math.max(y0, y1);
    for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) if (filled || x === ax || x === bx || y === ay || y === by) pts.push([x, y]);
    return pts;
  }
  /** Contiguous (4-way) flood fill. Returns the list of indices that were changed. */
  function floodFill(px, w, h, x, y, value) {
    const target = px[y * w + x], changed = [];
    if (target === value) return changed;
    const stack = [y * w + x];
    while (stack.length) {
      const i = stack.pop();
      if (px[i] !== target) continue;
      px[i] = value; changed.push(i);
      const cx = i % w, cy = (i / w) | 0;
      if (cx > 0) stack.push(i - 1);
      if (cx < w - 1) stack.push(i + 1);
      if (cy > 0) stack.push(i - w);
      if (cy < h - 1) stack.push(i + w);
    }
    return changed;
  }
  /** Colours used by an image, most used first. Fully transparent pixels are counted under key 0 and listed last. */
  function colorsOf(px) {
    const m = new Map();
    for (let i = 0; i < px.length; i++) { const c = isClear(px[i]) ? 0 : px[i]; m.set(c, (m.get(c) || 0) + 1); }
    return [...m.entries()].sort((a, b) => (a[0] === 0) - (b[0] === 0) || b[1] - a[1]);
  }
  const flipH = (px, w, h) => { const o = new Uint32Array(px.length); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o[y * w + x] = px[y * w + (w - 1 - x)]; return o; };
  const flipV = (px, w, h) => { const o = new Uint32Array(px.length); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o[y * w + x] = px[(h - 1 - y) * w + x]; return o; };
  /** Rotate 90 degrees clockwise. The result is h wide and w tall. */
  const rotateCW = (px, w, h) => { const o = new Uint32Array(px.length); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o[x * h + (h - 1 - y)] = px[y * w + x]; return o; };
  /** Move everything by (dx,dy), wrapping around the edges so nothing is lost. */
  const shiftWrap = (px, w, h, dx, dy) => { const o = new Uint32Array(px.length); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o[((y + dy % h + h) % h) * w + ((x + dx % w + w) % w)] = px[y * w + x]; return o; };
  /** A new canvas size. anchor 'tl' keeps the top-left corner, 'c' keeps the centre. */
  function resizePx(px, w, h, nw, nh, anchor) {
    const o = new Uint32Array(nw * nh), ox = anchor === 'c' ? Math.floor((nw - w) / 2) : 0, oy = anchor === 'c' ? Math.floor((nh - h) / 2) : 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const X = x + ox, Y = y + oy; if (X >= 0 && Y >= 0 && X < nw && Y < nh) o[Y * nw + X] = px[y * w + x]; }
    return o;
  }
  const countDiff = (a, b) => { if (a.length !== b.length) return Math.max(a.length, b.length); let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };

  /* =====================================================================================================
     A document is one image being edited, with undo history.
     base    = the pixels when this session loaded it (what a pull request is measured against)
     saved   = the pixels at the last save (what "unsaved changes" is measured against)
     ===================================================================================================== */
  class Doc {
    constructor(path, w, h, px, extra = {}) {
      this.path = path; this.w = w; this.h = h; this.px = px;
      this.base = { w, h, px: px.slice() }; this.saved = { w, h, px: px.slice() };
      this.undo = []; this.redo = []; this.local = !!extra.local; this.frames = extra.frames || null;
    }
    snapshot() { this.undo.push({ w: this.w, h: this.h, px: this.px.slice() }); if (this.undo.length > 100) this.undo.shift(); this.redo.length = 0; }
    swap(from, to) { to.push({ w: this.w, h: this.h, px: this.px.slice() }); const s = from.pop(); this.w = s.w; this.h = s.h; this.px = s.px; }
    undoOnce() { if (!this.undo.length) return false; this.swap(this.undo, this.redo); return true; }
    redoOnce() { if (!this.redo.length) return false; this.swap(this.redo, this.undo); return true; }
    same(ref) { return ref.w === this.w && ref.h === this.h && countDiff(ref.px, this.px) === 0; }
    get unsaved() { return !this.same(this.saved); }
    get changed() { return !this.same(this.base); }
    markSaved() { this.saved = { w: this.w, h: this.h, px: this.px.slice() }; }
    changedPixels() { return this.base.w === this.w && this.base.h === this.h ? countDiff(this.base.px, this.px) : this.w * this.h; }
    imageData() { return new ImageData(new Uint8ClampedArray(this.px.buffer.slice(0)), this.w, this.h); }
  }

  /* =====================================================================================================
     Pull requests through the GitHub REST API, straight from the browser. No server is involved: the token the
     artist pastes in is only ever sent to api.github.com (or the apiBase you configure).
       - If the token can push to the repo, the branch goes there.
       - If not (an outside contributor), the repo is forked first and the pull request is opened from the fork.
     files: [{ path, blob }]  where path is relative to the repository root and blob is the PNG as a Blob/Uint8Array.
     ===================================================================================================== */
  /** A plain-language reason for a GitHub API failure, with the raw message kept at the end for support. */
  function explainGithubError(status, message, what, repo) {
    const m = String(message || ''), raw = ` [${what}: ${status} ${m}]`;
    if (status === 401) return 'GitHub rejected the sign-in or token (it expired or was revoked). Sign in again or paste a new token.' + raw;
    if (status === 403 && /SAML|SSO/i.test(m)) return 'This organisation requires single sign-on: authorise the token or app for it on GitHub, then try again.' + raw;
    if (status === 403 && /rate limit/i.test(m)) return 'GitHub rate limit reached. Sign in (or add a token) to raise it, or wait a few minutes.' + raw;
    if (status === 403 && /not accessible|forbidden|permission/i.test(m)) return `You are signed in, but not allowed to do that${repo ? ' on ' + repo : ''}. It needs write access to Contents and Pull requests on this repository (for the GitHub App: install the app on it and accept the permissions).` + raw;
    if (status === 404) return `GitHub says not found${repo ? ' for ' + repo : ''}. Check the name and branch, and for a private repository sign in or use a token with access to it.` + raw;
    if (status === 422 && /already exists/i.test(m)) return 'A branch or pull request with that name already exists. Change the title and try again.' + raw;
    return `GitHub ${what} failed: ${status} ${m}`;
  }
  const refPath = (b) => String(b).split('/').map(encodeURIComponent).join('/'); // keep the slashes in branch names like release/1.0
  async function createPullRequest(o) {
    const api = (o.apiBase || 'https://api.github.com').replace(/\/$/, ''), doFetch = o.fetch || fetch.bind(globalThis), log = o.onProgress || (() => {});
    const call = async (method, url, body) => {
      const res = await doFetch(api + url, { method, headers: { Authorization: 'Bearer ' + o.token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
      if (!res.ok) { const e = new Error(explainGithubError(res.status, (json && json.message) || text.slice(0, 120), `${method} ${url}`, o.repo)); e.status = res.status; throw e; }
      return json;
    };
    if (!o.token) throw new Error('A GitHub token is required.');
    if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo || '')) throw new Error('Repository must look like owner/name.');
    if (!o.files || !o.files.length) throw new Error('There are no changed sprites to propose.');

    log('Checking the token…');
    const me = (await call('GET', '/user')).login;
    log('Reading ' + o.repo + '…');
    const repo = await call('GET', '/repos/' + o.repo);
    const base = o.base || repo.default_branch;
    let headRepo = o.repo, headOwner = null;
    if (!(repo.permissions && repo.permissions.push)) {
      log('No write access, forking to ' + me + '…');
      const fork = await call('POST', '/repos/' + o.repo + '/forks', {});
      headRepo = fork.full_name || me + '/' + repo.name; headOwner = me;
      for (let i = 0; i < (o.forkRetries ?? 30); i++) {
        try { await call('GET', '/repos/' + headRepo); break; } catch (e) { if (e.status !== 404 || i === (o.forkRetries ?? 30) - 1) throw e; await new Promise((r) => setTimeout(r, o.forkDelay ?? 1000)); }
      }
      try { await call('POST', '/repos/' + headRepo + '/merge-upstream', { branch: base }); } catch { /* already up to date, or not allowed: carry on */ }
    }
    log('Reading ' + base + '…');
    const baseRef = await call('GET', '/repos/' + o.repo + '/git/ref/heads/' + refPath(base));
    const baseSha = baseRef.object.sha;
    const baseCommit = await call('GET', '/repos/' + o.repo + '/git/commits/' + baseSha);
    const tree = [];
    for (const f of o.files) {
      log('Uploading ' + f.path + '…');
      const bytes = f.blob instanceof Uint8Array ? f.blob : new Uint8Array(await f.blob.arrayBuffer());
      let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      const blob = await call('POST', '/repos/' + headRepo + '/git/blobs', { content: btoa(bin), encoding: 'base64' });
      tree.push({ path: (o.prefix || '') + f.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    log('Creating the commit…');
    const newTree = await call('POST', '/repos/' + headRepo + '/git/trees', { base_tree: baseCommit.tree.sha, tree });
    const commit = await call('POST', '/repos/' + headRepo + '/git/commits', { message: o.message || o.title, tree: newTree.sha, parents: [baseSha] });
    const branch = o.branch || 'art/update-' + Date.now().toString(36);
    await call('POST', '/repos/' + headRepo + '/git/refs', { ref: 'refs/heads/' + branch, sha: commit.sha });
    log('Opening the pull request…');
    const pr = await call('POST', '/repos/' + o.repo + '/pulls', { title: o.title, body: typeof o.body === 'function' ? o.body({ baseSha, commit: commit.sha, headRepo }) : (o.body || ''), head: headOwner ? headOwner + ':' + branch : branch, base, maintainer_can_modify: true });
    return { url: pr.html_url, number: pr.number, branch, forked: !!headOwner, commit: commit.sha, headRepo };
  }
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'art';

  /** Markdown for the pull request body: what changed and how much, with before/after links when the repo is public. */
  function prBody(o) {
    const rows = o.files.map((f) => `| \`${f.path}\` | ${f.w}×${f.h} | ${f.pixels} |`).join('\n');
    const imgs = o.files.map((f) => o.repo && o.baseSha && o.commit ? `**${f.path}**\n\nBefore | After\n--- | ---\n<img src="https://raw.githubusercontent.com/${o.repo}/${o.baseSha}/${o.prefix || ''}${f.path}" width="128"> | <img src="https://raw.githubusercontent.com/${o.headRepo || o.repo}/${o.commit}/${o.prefix || ''}${f.path}" width="128">` : '').filter(Boolean).join('\n\n');
    return `${o.description ? o.description + '\n\n' : ''}| Sprite | Size | Pixels changed |\n| --- | --- | --- |\n${rows}\n${imgs ? '\n' + imgs + '\n' : ''}\n_Proposed with spritewright. GitHub shows PNG changes in the "Files changed" tab with 2-up, swipe and onion-skin views._`;
  }


  /* =====================================================================================================
     Lossless PNG reading and writing. Browsers decode images through a canvas, which stores premultiplied alpha, so a pixel
     such as (229, 120, 7, alpha 250) comes back as (230, ...): silently changing colours that a game may match exactly.
     Reading and writing the PNG bytes ourselves keeps every channel of every pixel intact. Uses the browsers' built-in
     DecompressionStream/CompressionStream ("deflate" is the zlib format PNG uses); older browsers fall back to the canvas.
     ===================================================================================================== */
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (u8, start, end) => { let c = 0xffffffff; for (let i = start; i < end; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
  const inflate = (b) => pipe(b, new DecompressionStream('deflate'));
  const deflate = (b) => pipe(b, new CompressionStream('deflate'));
  const hasStreams = () => typeof DecompressionStream !== 'undefined' && typeof CompressionStream !== 'undefined';

  /** PNG bytes to { w, h, px } (px is straight-alpha 0xAABBGGRR). Throws for interlaced files and other unsupported variants. */
  async function decodePngBytes(u8) {
    if (u8.length < 33 || PNG_SIG.some((v, i) => u8[i] !== v)) throw new Error('not a PNG file');
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let off = 8, ihdr = null, plte = null, trns = null; const idat = [];
    while (off + 12 <= u8.length) {
      const len = dv.getUint32(off), type = String.fromCharCode(u8[off + 4], u8[off + 5], u8[off + 6], u8[off + 7]), data = u8.subarray(off + 8, off + 8 + len);
      if (type === 'IHDR') ihdr = { w: dv.getUint32(off + 8), h: dv.getUint32(off + 12), depth: data[8], ct: data[9], interlace: data[12] };
      else if (type === 'PLTE') plte = data; else if (type === 'tRNS') trns = data; else if (type === 'IDAT') idat.push(data); else if (type === 'IEND') break;
      off += 12 + len;
    }
    if (!ihdr || !idat.length) throw new Error('damaged PNG');
    const { w, h, depth, ct } = ihdr;
    if (ihdr.interlace) throw new Error('interlaced PNG');
    const chans = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
    if (!chans || ![1, 2, 4, 8, 16].includes(depth) || (depth < 8 && ct !== 0 && ct !== 3) || (ct === 3 && depth === 16)) throw new Error('unsupported PNG variant');
    const total = idat.reduce((n, c) => n + c.length, 0), z = new Uint8Array(total); let o = 0; for (const c of idat) { z.set(c, o); o += c.length; }
    const raw = await inflate(z), bits = chans * depth, stride = Math.ceil((w * bits) / 8), bpp = Math.max(1, bits >> 3);
    if (raw.length < (stride + 1) * h) throw new Error('damaged PNG data');
    const img = new Uint8Array(stride * h);
    for (let y = 0; y < h; y++) {
      const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride, up = dst - stride;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? img[dst + i - bpp] : 0, b = y ? img[up + i] : 0, c = y && i >= bpp ? img[up + i - bpp] : 0; let v = raw[src + i];
        if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
        else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; } else if (f !== 0) throw new Error('bad PNG filter');
        img[dst + i] = v & 255;
      }
    }
    const rgba = new Uint8Array(w * h * 4), sample = (y, x, k) => { // k-th sample of pixel (x,y), scaled to 8 bits
      if (depth === 8) return img[y * stride + x * chans + k]; if (depth === 16) return img[y * stride + (x * chans + k) * 2];
      const bit = (x * depth), byte = img[y * stride + (bit >> 3)]; return (byte >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
    };
    const key = trns && (ct === 0 || ct === 2) ? [(trns[0] << 8) | trns[1], (trns[2] << 8) | trns[3], (trns[4] << 8) | trns[5]] : null;
    const full = (v) => (depth < 8 ? Math.round((v * 255) / ((1 << depth) - 1)) : v);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let r, g, b, a = 255; const i = (y * w + x) * 4;
      if (ct === 3) { const k = sample(y, x, 0); if (!plte || k * 3 + 2 >= plte.length) throw new Error('missing palette'); r = plte[k * 3]; g = plte[k * 3 + 1]; b = plte[k * 3 + 2]; if (trns && k < trns.length) a = trns[k]; }
      else if (ct === 0) { const v = sample(y, x, 0); r = g = b = full(v); const raw = depth === 16 ? (img[y * stride + x * 2] << 8) | img[y * stride + x * 2 + 1] : v; if (key && raw === key[0]) a = 0; }
      else if (ct === 4) { r = g = b = sample(y, x, 0); a = sample(y, x, 1); }
      else { r = sample(y, x, 0); g = sample(y, x, 1); b = sample(y, x, 2); if (ct === 6) a = sample(y, x, 3); else if (key && depth === 8 && r === key[0] && g === key[1] && b === key[2]) a = 0; }
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a;
    }
    return { w, h, px: new Uint32Array(rgba.buffer) };
  }

  /** { w, h, px } to PNG bytes: 8-bit RGBA, no ancillary chunks. scale > 1 repeats each pixel (nearest neighbour). */
  async function encodePngBytes(w, h, px, scale = 1) {
    if (scale > 1) { const W = w * scale, H = h * scale, out = new Uint32Array(W * H); for (let y = 0; y < H; y++) { const sy = ((y / scale) | 0) * w; for (let x = 0; x < W; x++) out[y * W + x] = px[sy + ((x / scale) | 0)]; } px = out; w = W; h = H; }
    const rgba = new Uint8Array(px.buffer, px.byteOffset, px.length * 4), row = w * 4, raw = new Uint8Array((row + 1) * h);
    for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * row, (y + 1) * row), y * (row + 1) + 1);
    const z = await deflate(raw), out = new Uint8Array(8 + 25 + 12 + z.length + 12), dv = new DataView(out.buffer);
    out.set(PNG_SIG, 0);
    const chunk = (at, type, len) => { dv.setUint32(at, len); for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i); };
    chunk(8, 'IHDR', 13); dv.setUint32(16, w); dv.setUint32(20, h); out[24] = 8; out[25] = 6; out[26] = out[27] = out[28] = 0; dv.setUint32(29, crc32(out, 12, 29));
    chunk(33, 'IDAT', z.length); out.set(z, 41); dv.setUint32(41 + z.length, crc32(out, 37, 41 + z.length));
    const e = 45 + z.length; chunk(e, 'IEND', 0); dv.setUint32(e + 8, crc32(out, e + 4, e + 8));
    return out;
  }


  /* =====================================================================================================
     Sources: where sprites come from and how they are read and written. The editor itself does not care.
       { kind, note, sprites: [{ path, w?, h?, bytes?, frames? }], read(path) -> Uint8Array, write?(path, Uint8Array),
         repo?: { slug, base, prefix }, palette?: ['#rrggbb'], thumbs: boolean }
     Built in: a list of files served over HTTP (static), the local `spritewright serve` server, a GitHub repository (read through the
     API, changes go back as a pull request) and a folder on your disk (browser File System Access API, saves in place).
     ===================================================================================================== */
  const IGNORE = ['node_modules', '.git', '.godot', '.import', '.zig-cache', 'zig-cache', 'zig-out', 'dist', 'build', 'target', '.venv', '__pycache__', '.next', 'coverage'];
  const globRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$');
  const slugFromRemote = (url) => { const m = /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(url).trim()); return m ? m[1] + '/' + m[2] : null; };
  const b64ToBytes = (b64) => { const bin = atob(String(b64).replace(/\s/g, '')), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; };
  const pngSize = (u8) => (u8.length >= 24 && PNG_SIG.every((v, i) => u8[i] === v) && String.fromCharCode(u8[12], u8[13], u8[14], u8[15]) === 'IHDR' ? { w: new DataView(u8.buffer, u8.byteOffset).getUint32(16), h: new DataView(u8.buffer, u8.byteOffset).getUint32(20) } : null);
  const palFromText = (t) => parsePalette(t).map(toHex);
  /** Keep the paths a project config wants (dirs, exclude, ignore) and attach frame sizes. */
  function applyConfig(items, cfg = {}) {
    const dirs = (cfg.dirs && cfg.dirs.length ? cfg.dirs : ['']).map((d) => (d === '.' ? '' : d.replace(/\/+$/, '')));
    const ign = new Set([...IGNORE, ...(cfg.ignore || [])]), exc = (cfg.exclude || []).map(globRe);
    return items.filter((it) => {
      const parts = it.path.split('/');
      if (parts.slice(0, -1).some((x) => ign.has(x))) return false;
      if (!dirs.some((d) => !d || it.path === d || it.path.startsWith(d + '/'))) return false;
      return !exc.some((r) => r.test(it.path));
    }).map((it) => { const fr = cfg.frames && (cfg.frames[it.path] || Object.entries(cfg.frames).find(([k]) => k.includes('*') && globRe(k).test(it.path))?.[1]); return fr ? { ...it, frames: fr } : it; });
  }

  /** Sprites listed in a manifest and fetched over HTTP relative to baseUrl. Read-only (Save downloads). */
  function staticSource(mf, baseUrl) {
    const base = baseUrl == null ? '' : baseUrl && !baseUrl.endsWith('/') ? baseUrl + '/' : baseUrl;
    return { kind: 'static', thumbs: true, note: 'Static mode: Save downloads the PNG. Connect a folder to save in place.', sprites: (mf.sprites || []).map((x) => ({ ...x })), repo: mf.repo || null, palette: mf.palette || null,
      async read(path) { const r = await fetch(base + path.split('/').map(encodeURIComponent).join('/')); if (!r.ok) throw new Error(r.status + ' ' + r.statusText); return new Uint8Array(await r.arrayBuffer()); } };
  }
  /** The local `spritewright serve` server: reads and writes the project folder. */
  function serverSource(mf, token) {
    const url = (path) => 'project/' + path.split('/').map(encodeURIComponent).join('/');
    return { kind: 'server', thumbs: true, note: 'Saving writes straight to the project folder.', sprites: (mf.sprites || []).map((x) => ({ ...x })), repo: mf.repo || null, palette: mf.palette || null,
      async read(path) { const r = await fetch(url(path)); if (!r.ok) throw new Error(r.status + ' ' + r.statusText); return new Uint8Array(await r.arrayBuffer()); },
      async write(path, bytes) { const r = await fetch(url(path), { method: 'PUT', headers: { 'x-spritewright': token || '', 'content-type': 'image/png' }, body: bytes }); if (!r.ok) throw new Error('server said ' + r.status + ' ' + (await r.text()).slice(0, 80)); } };
  }

  /** A GitHub repository, read through the REST API (a token is only needed for private repos and for pull requests). */
  async function githubSource(o) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo || '')) throw new Error('Repository must look like owner/name.');
    const api = (o.apiBase || 'https://api.github.com').replace(/\/$/, ''), doFetch = o.fetch || fetch.bind(globalThis), maxBytes = o.maxBytes || 262144;
    const call = async (path) => {
      const res = await doFetch(api + path, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(o.token ? { Authorization: 'Bearer ' + o.token } : {}) } });
      const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
      if (!res.ok) {
        const left = res.headers && res.headers.get && res.headers.get('x-ratelimit-remaining');
        throw new Error(explainGithubError(left === '0' && res.status === 403 ? 403 : res.status, left === '0' && res.status === 403 ? 'API rate limit exceeded' : (json && json.message) || text.slice(0, 100), 'GET ' + path.split('?')[0], o.repo));
      }
      return json;
    };
    const info = await call('/repos/' + o.repo), branch = o.branch || info.default_branch;
    const ref = await call('/repos/' + o.repo + '/git/ref/heads/' + refPath(branch));
    const commit = await call('/repos/' + o.repo + '/git/commits/' + ref.object.sha);
    const tree = await call('/repos/' + o.repo + '/git/trees/' + commit.tree.sha + '?recursive=1');
    const entries = new Map((tree.tree || []).filter((e) => e.type === 'blob').map((e) => [e.path, e]));
    const blob = async (path) => { const e = entries.get(path); if (!e) throw new Error('not in the repository: ' + path); const b = await call('/repos/' + o.repo + '/git/blobs/' + e.sha); return b.encoding === 'base64' ? b64ToBytes(b.content) : new TextEncoder().encode(b.content); };
    let cfg = {}, palette = null;
    if (entries.has('spritewright.config.json')) { try { cfg = JSON.parse(new TextDecoder().decode(await blob('spritewright.config.json'))); } catch { /* ignore a broken config */ } }
    if (cfg.palette && entries.has(cfg.palette)) { try { palette = palFromText(new TextDecoder().decode(await blob(cfg.palette))); } catch { /* none */ } }
    const png = [...entries.values()].filter((e) => /\.png$/i.test(e.path) && e.size <= (cfg.maxBytes || maxBytes)).map((e) => ({ path: e.path, bytes: e.size }));
    const sprites = applyConfig(png, cfg);
    return { kind: 'github', thumbs: false, sprites, palette, branch,
      note: 'GitHub ' + o.repo + ' @ ' + branch + (tree.truncated ? ' (very large repository: the list is incomplete)' : '') + '. Save downloads; Propose PR sends changes back.',
      repo: { slug: o.repo, base: branch, prefix: '', canPush: !!(info.permissions && info.permissions.push) }, read: blob };
  }

  /** A folder on disk through the File System Access API (Chromium browsers): lists, reads and saves in place. */
  async function folderSource(root, o = {}) {
    const maxSize = o.maxSize || 1024, files = new Map();
    const readText = async (dir, ...names) => { try { let d = dir; for (const n of names.slice(0, -1)) d = await d.getDirectoryHandle(n); return await (await (await d.getFileHandle(names.at(-1))).getFile()).text(); } catch { return null; } };
    let cfg = {}; const cfgText = await readText(root, 'spritewright.config.json'); if (cfgText) { try { cfg = JSON.parse(cfgText); } catch { /* ignore */ } }
    const ign = new Set([...IGNORE, ...(cfg.ignore || [])]), found = [];
    const walk = async (dir, prefix) => {
      for await (const [name, h] of dir.entries()) {
        if (h.kind === 'directory') { if (!ign.has(name) && !name.startsWith('.')) await walk(h, prefix + name + '/'); continue; }
        if (!/\.png$/i.test(name)) continue;
        const f = await h.getFile(), head = pngSize(new Uint8Array(await f.slice(0, 24).arrayBuffer())), lim = cfg.maxSize || maxSize;
        if (!head || head.w > lim || head.h > lim) continue;
        files.set(prefix + name, h); found.push({ path: prefix + name, w: head.w, h: head.h, bytes: f.size });
      }
    };
    await walk(root, ''); found.sort((a, b) => a.path.localeCompare(b.path));
    let palette = null; if (cfg.palette) { const t = await readText(root, ...cfg.palette.split('/')); if (t) palette = palFromText(t); }
    const gitCfg = await readText(root, '.git', 'config'), m = gitCfg && /\[remote "origin"\][^[]*?url\s*=\s*(.+)/.exec(gitCfg), slug = (m && slugFromRemote(m[1])) || (cfg.repo && cfg.repo.slug) || null;
    return { kind: 'folder', thumbs: true, sprites: applyConfig(found, cfg), palette, name: root.name, note: 'Folder "' + root.name + '": Save writes the PNG in place.', repo: { slug, base: (cfg.repo && cfg.repo.base) || null, prefix: (cfg.repo && cfg.repo.prefix) || '' },
      async read(path) { const h = files.get(path); if (!h) throw new Error('not found: ' + path); return new Uint8Array(await (await h.getFile()).arrayBuffer()); },
      async write(path, bytes) {
        const parts = path.split('/'); let dir = root; for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
        const h = await dir.getFileHandle(parts.at(-1), { create: true }), w = await h.createWritable(); await w.write(bytes); await w.close(); files.set(path, h);
      } };
  }


  /* =====================================================================================================
     Sign in with GitHub. The page opens a small popup on an auth service (see worker/), the user signs in on
     github.com (their normal login, SSO and 2FA included), and the service posts an access token back to this page.
     The service only exists because GitHub's token exchange needs a client secret and has no CORS; it never stores tokens.
     ===================================================================================================== */
  function githubSignIn(authBase, { win = window, timeoutMs = 300000 } = {}) {
    if (!authBase) return Promise.reject(new Error('Sign-in is not set up on this page.'));
    const origin = new URL(authBase, win.location.href).origin, nonce = Array.from(win.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    const popup = win.open(`${authBase.replace(/\/$/, '')}/login?origin=${encodeURIComponent(win.location.origin)}&nonce=${nonce}`, 'pf-auth', 'width=520,height=700');
    if (!popup) return Promise.reject(new Error('The sign-in window was blocked. Allow pop-ups for this site and try again.'));
    return new Promise((resolve, reject) => {
      const done = (fn, v) => { win.removeEventListener('message', onMsg); clearInterval(poll); clearTimeout(to); try { popup.close(); } catch { /* already closed */ } fn(v); };
      const onMsg = (e) => { const d = e.data; if (e.origin !== origin || !d || d.type !== 'pf-auth' || d.nonce !== nonce) return; d.error ? done(reject, new Error(d.error)) : d.token ? done(resolve, { token: d.token, expiresIn: d.expires_in || null, refreshToken: d.refresh_token || null, refreshExpiresIn: d.refresh_token_expires_in || null }) : done(reject, new Error('The sign-in service returned no token.')); };
      win.addEventListener('message', onMsg);
      const poll = setInterval(() => { if (popup.closed) done(reject, new Error('The sign-in window was closed before finishing.')); }, 500);
      const to = setTimeout(() => done(reject, new Error('Sign-in timed out.')), timeoutMs);
    });
  }
  /** Swap a refresh token for a new access token through the auth service (GitHub App user tokens expire after 8 hours). */
  async function githubRefresh(authBase, refreshToken, o = {}) {
    const res = await (o.fetch || fetch.bind(globalThis))(authBase.replace(/\/$/, '') + '/refresh', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ refresh_token: refreshToken }) });
    let j = {}; try { j = JSON.parse(await res.text()); } catch { /* not JSON */ }
    if (!res.ok || !j.token) { const e = new Error(j.error || 'Could not renew the GitHub sign-in (' + res.status + ').'); e.status = res.status; throw e; }
    return { token: j.token, expiresIn: j.expires_in || null, refreshToken: j.refresh_token || null, refreshExpiresIn: j.refresh_token_expires_in || null };
  }
  /** Who the token belongs to. */
  async function githubUser(token, o = {}) {
    const res = await (o.fetch || fetch.bind(globalThis))((o.apiBase || 'https://api.github.com') + '/user', { headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(explainGithubError(res.status, '', 'GET /user'));
    const j = JSON.parse(await res.text()); return { login: j.login, name: j.name || j.login };
  }
  /** Repositories this token can reach: through the GitHub App installations when it is an app token, else the user's recent repos.
      Names by default; with { details: true } objects { name, private, push, branch } (push = the user may write, so pull requests go straight to it). */
  async function listRepos(token, o = {}) {
    const api = (o.apiBase || 'https://api.github.com'), doFetch = o.fetch || fetch.bind(globalThis), get = async (u) => { const r = await doFetch(api + u, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' } }); return r.ok ? JSON.parse(await r.text()) : null; };
    const out = [], inst = await get('/user/installations?per_page=30');
    if (inst && inst.installations) for (const i of inst.installations.slice(0, 10)) { const r = await get(`/user/installations/${i.id}/repositories?per_page=100`); if (r && r.repositories) out.push(...r.repositories); }
    if (!out.length) { const r = await get('/user/repos?sort=updated&per_page=50'); if (r) out.push(...r); }
    const seen = new Set(), uniq = out.filter((x) => x && x.full_name && !seen.has(x.full_name) && seen.add(x.full_name));
    return o.details ? uniq.map((x) => ({ name: x.full_name, private: !!x.private, push: !!(x.permissions && x.permissions.push), branch: x.default_branch || null })) : uniq.map((x) => x.full_name);
  }
  const PAT_URL = 'https://github.com/settings/personal-access-tokens/new?name=spritewright&description=Edit+sprites+and+open+pull+requests&expires_in=30&contents=write&pull_requests=write';

  /* =====================================================================================================
     The editor UI
     ===================================================================================================== */
  const CSS = `
.pf{--pf-bg:#07090b;--pf-panel:#0d1114;--pf-panel2:#141a1f;--pf-line:#232d34;--pf-ink:#d6e4dc;--pf-muted:#7f948a;--pf-accent:#39ff7a;--pf-on:#04120a;--pf-bad:#ff5470;
  display:grid;grid-template-columns:220px minmax(0,1fr) 230px;grid-template-rows:minmax(0,1fr);height:100%;min-height:420px;background:var(--pf-bg);color:var(--pf-ink);font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;border:1px solid var(--pf-line);box-sizing:border-box}
.pf *{box-sizing:border-box;border-radius:0}
.pf button,.pf select,.pf input{font:inherit;color:inherit}
.pf button{background:var(--pf-panel2);border:1px solid var(--pf-line);padding:5px 9px;cursor:pointer;min-height:30px}
.pf button:hover:not(:disabled){border-color:var(--pf-accent);color:var(--pf-accent)}
.pf button:disabled{opacity:.4;cursor:default}
.pf button.on,.pf button.primary{background:var(--pf-accent);border-color:var(--pf-accent);color:var(--pf-on);font-weight:700}
.pf input[type=text],.pf input[type=number],.pf input[type=password],.pf select,.pf textarea{background:#05080a;border:1px solid var(--pf-line);padding:5px 7px;min-height:30px;width:100%}
.pf input[type=number]{width:70px}
.pf label{display:flex;gap:6px;align-items:center;color:var(--pf-muted)}
.pf h4{margin:0 0 6px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--pf-accent);font-weight:700}
.pf-side,.pf-right{background:var(--pf-panel);overflow:auto;padding:10px;display:flex;flex-direction:column;gap:12px;min-width:0}
.pf-side{border-right:1px solid var(--pf-line)}.pf-right{border-left:1px solid var(--pf-line)}
.pf-list{display:flex;flex-direction:column;gap:2px;overflow:auto;flex:1;min-height:80px}
.pf-item{display:flex;gap:8px;align-items:center;padding:4px;border:1px solid transparent;cursor:pointer;background:none;text-align:left;width:100%;min-height:44px}
.pf .pf-item.on{border-color:var(--pf-accent);background:var(--pf-panel2);color:var(--pf-ink);font-weight:400}
.pf-item canvas{width:36px;height:36px;image-rendering:pixelated;background:repeating-conic-gradient(#1a2229 0 25%,#10161a 0 50%) 0 0/8px 8px;flex:none}
.pf-item .n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}.pf-item small{display:block;color:var(--pf-muted);overflow:hidden;text-overflow:ellipsis}
.pf-item .dot{width:8px;height:8px;background:var(--pf-accent);flex:none}.pf-item .dot.base{background:#ffb000}
.pf-main{display:flex;flex-direction:column;min-width:0;min-height:0}
.pf-bar{display:flex;flex-wrap:wrap;gap:6px;padding:8px;border-bottom:1px solid var(--pf-line);background:var(--pf-panel);align-items:center}
.pf-bar .sep{width:1px;align-self:stretch;background:var(--pf-line);margin:0 2px}
.pf-stage{position:relative;flex:1;min-height:200px;overflow:hidden;background:#05070a;touch-action:none}
.pf-stage canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:crosshair}
.pf-status{display:flex;flex-wrap:wrap;gap:4px 16px;padding:6px 10px;border-top:1px solid var(--pf-line);background:var(--pf-panel);color:var(--pf-muted);font-size:12px}
.pf-status b{color:var(--pf-ink)}
.pf-sw{display:flex;flex-wrap:wrap;gap:4px}
.pf-sw button{width:28px;height:28px;min-height:0;padding:0;border:2px solid var(--pf-line)}
.pf-sw button.on{border-color:var(--pf-ink);outline:2px solid var(--pf-accent)}
.pf-cur{display:flex;gap:8px;align-items:center}.pf-cur input[type=color]{width:44px;height:34px;padding:0;border:1px solid var(--pf-line);background:none}
.pf-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.pf-prev canvas{image-rendering:pixelated;background:repeating-conic-gradient(#1a2229 0 25%,#10161a 0 50%) 0 0/8px 8px;max-width:100%;display:block}
.pf-note{color:var(--pf-muted);font-size:12px}.pf-bad{color:var(--pf-bad)}
.pf-box{border:1px solid var(--pf-line);padding:10px;display:flex;flex-direction:column;gap:8px}
.pf-signed-in .pf-gh-box{order:-1}.pf-dlg-connect h4{order:-2}.pf-c-pick.on{border-color:var(--pf-accent)}
.pf-auth-row[hidden]{display:none}
.pf-acct{display:inline-flex;gap:8px;align-items:center;font-size:12px;color:#7f948a}.pf-acct .pf-who{color:#7f948a;font-size:12px}
.pf-acct button{font:inherit;font-size:12px;background:#141a1f;color:#d6e4dc;border:1px solid #232d34;padding:2px 8px;cursor:pointer}.pf-acct button:hover{border-color:var(--pf-accent,#39ff7a);color:var(--pf-accent,#39ff7a)}.pf-side-auth{justify-content:space-between;flex-wrap:nowrap}.pf-side-auth .pf-who{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.pf-side-auth .pf-who:empty{display:none}.pf-side-auth .pf-signin{width:100%}
.pf-source{width:100%;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pf-c-mine{display:flex;flex-direction:column;gap:6px}.pf-c-mine[hidden]{display:none}.pf-c-repolist{display:flex;flex-direction:column;gap:4px;max-height:220px;overflow:auto}
.pf-c-pick{display:flex;justify-content:space-between;gap:8px;text-align:left;width:100%}.pf-c-pick b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pf-tokenbox summary{cursor:pointer;color:var(--pf-muted);font-size:12px}.pf-tokenbox>label,.pf-tokenbox>.pf-note{display:block;margin-top:8px}.pf-tokenbox[hidden]{display:none}
.pf dialog{background:var(--pf-panel);color:var(--pf-ink);border:1px solid var(--pf-accent);padding:16px;width:min(560px,94vw);max-height:92vh;overflow:auto}
.pf dialog::backdrop{background:rgba(0,0,0,.7)}
.pf-form{display:flex;flex-direction:column;gap:10px}.pf-log:empty{display:none}.pf-log{white-space:pre-wrap;color:var(--pf-muted);max-height:140px;overflow:auto;border:1px solid var(--pf-line);padding:6px;min-height:34px}
.pf-chg{display:flex;gap:8px;align-items:center;padding:4px 0;border-bottom:1px solid var(--pf-line)}.pf-chg canvas{width:40px;height:40px;image-rendering:pixelated;background:#10161a}
@media (max-width:900px){
  .pf{grid-template-columns:1fr;grid-template-rows:auto minmax(380px,1fr) auto;height:auto}
  .pf-side{flex-direction:column;border-right:0;border-bottom:1px solid var(--pf-line);max-height:none}.pf-list{flex-direction:row;overflow-x:auto;overflow-y:hidden;flex:none;min-height:0}.pf-item{width:150px;flex:none}
  .pf-right{border-left:0;border-top:1px solid var(--pf-line)}
  .pf-stage{min-height:340px}
  .pf button{min-height:38px}.pf input[type=text],.pf input[type=password],.pf input[type=number],.pf select,.pf textarea{font-size:16px;min-height:38px}
}`;

  const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TOOLS = [['pen', 'Pencil', 'B'], ['erase', 'Eraser', 'E'], ['fill', 'Fill', 'G'], ['line', 'Line', 'L'], ['rect', 'Rectangle', 'R'], ['rectf', 'Filled rectangle', 'F'], ['pick', 'Colour picker', 'I']];
  const toBlob = (canvas) => new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode the PNG'))), 'image/png'));
  const drawPx = (canvas, doc, scale = 1) => { // blit a doc's pixels to a canvas at scale (nearest neighbour)
    const t = document.createElement('canvas'); t.width = doc.w; t.height = doc.h; t.getContext('2d').putImageData(doc.imageData(), 0, 0);
    canvas.width = doc.w * scale; canvas.height = doc.h * scale; const g = canvas.getContext('2d'); g.imageSmoothingEnabled = false; g.clearRect(0, 0, canvas.width, canvas.height); g.drawImage(t, 0, 0, canvas.width, canvas.height);
  };
  async function decodePng(blob) {
    if (hasStreams()) { try { return await decodePngBytes(new Uint8Array(await blob.arrayBuffer())); } catch (e) { if (!/interlaced|unsupported/.test(e.message)) throw e; /* rare variants: let the browser decode (may round semi-transparent pixels) */ } }
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, bmp.width, bmp.height);
    return { w: d.width, h: d.height, px: new Uint32Array(d.data.buffer.slice(0)) };
  }

  function $$dialogs(root) { root.querySelectorAll('dialog form').forEach((f) => f.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') e.preventDefault(); })); }

  function mount(host, options = {}) {
    if (!document.getElementById('pf-css')) { const st = document.createElement('style'); st.id = 'pf-css'; st.textContent = CSS; document.head.appendChild(st); }
    const O = Object.assign({ manifestUrl: null, baseUrl: '', save: null, github: null, palette: null, accent: null, pr: true }, options);
    const root = el(`<div class="pf" tabindex="-1">
      <aside class="pf-side"><button class="pf-source" title="Switch to another GitHub repository or a folder on this computer">Open project…</button>
        <div class="pf-row pf-auth-row pf-side-auth"><button type="button" class="pf-signin">Sign in with GitHub</button><span class="pf-who pf-note"></span><button type="button" class="pf-signout" hidden>Sign out</button></div><div><h4>Sprites</h4><input type="text" class="pf-q" placeholder="filter…" aria-label="Filter sprites"></div>
        <div class="pf-list" role="listbox" aria-label="Sprites"></div>
        <div class="pf-row"><button class="pf-open">Open PNG…</button><button class="pf-new">New</button></div>
        <div class="pf-note pf-src"></div><input type="file" class="pf-file" accept="image/png,image/*" multiple hidden></aside>
      <section class="pf-main">
        <div class="pf-bar">
          <span class="pf-row pf-tools"></span><span class="sep"></span>
          <button class="pf-undo" title="Undo (Ctrl+Z)">Undo</button><button class="pf-redo" title="Redo (Ctrl+Y)">Redo</button><span class="sep"></span>
          <button class="pf-zout" title="Zoom out (-)">−</button><button class="pf-zin" title="Zoom in (+)">+</button><button class="pf-fit" title="Fit to window (0)">Fit</button><button class="pf-grid on" title="Grid (#)">Grid</button><span class="sep"></span>
          <button class="pf-mx" title="Mirror left-right (M)">Mirror X</button><button class="pf-my" title="Mirror up-down">Mirror Y</button><button class="pf-pp on" title="Pixel-perfect pencil: removes the corner doubles that make lines lumpy">Clean lines</button><span class="sep"></span>
          <button class="pf-save primary" title="Save (Ctrl+S)">Save</button><button class="pf-export" title="Download a PNG">Export</button><button class="pf-prbtn" title="Open a GitHub pull request with the changed sprites">Propose PR</button>
        </div>
        <div class="pf-stage"><canvas class="pf-view" aria-label="Sprite canvas"></canvas></div>
        <div class="pf-status"><span class="pf-s-name"></span><span class="pf-s-pos"></span><span class="pf-s-info"></span></div>
      </section>
      <aside class="pf-right">
        <div><h4>Colour</h4><div class="pf-cur"><input type="color" class="pf-cpick" aria-label="Current colour"><input type="text" class="pf-chex" maxlength="9" aria-label="Hex colour"></div>
          <div class="pf-row" style="margin-top:6px"><button class="pf-recolor" title="Change this colour everywhere in the image">Recolour all…</button><input type="color" class="pf-recolor-in" aria-hidden="true" tabindex="-1" style="position:absolute;opacity:0;width:1px;height:1px;pointer-events:none"></div></div>
        <div><h4>In this image</h4><div class="pf-sw pf-img-colors"></div></div>
        <div class="pf-pal-wrap" hidden><h4>Project palette</h4><div class="pf-sw pf-pal-colors"></div><div class="pf-row" style="margin-top:6px"><button class="pf-snap">Snap to palette</button></div><div class="pf-note pf-off"></div></div>
        <div class="pf-row"><button class="pf-palload">Load palette…</button><button class="pf-palsave">Save .hex</button><input type="file" class="pf-palfile" accept=".hex,.txt,text/plain" hidden></div>
        <div class="pf-prev"><h4>Preview</h4><canvas class="pf-p1"></canvas>
          <div class="pf-row" style="margin-top:6px"><label>frame <input type="number" class="pf-fw" min="1" value="16">×<input type="number" class="pf-fh" min="1" value="16"></label></div>
          <div class="pf-row" style="margin-top:6px"><label>fps <input type="number" class="pf-fps" min="1" max="60" value="8"></label><button class="pf-play">Play</button></div>
          <canvas class="pf-p2" style="margin-top:6px"></canvas></div>
        <div><h4>Image</h4><div class="pf-row"><button class="pf-fliph">Flip ↔</button><button class="pf-flipv">Flip ↕</button><button class="pf-rot">Rotate ↻</button></div>
          <div class="pf-row" style="margin-top:6px"><button class="pf-sh" data-d="-1,0">←</button><button class="pf-sh" data-d="0,-1">↑</button><button class="pf-sh" data-d="0,1">↓</button><button class="pf-sh" data-d="1,0">→</button><span class="pf-note">wrap shift</span></div>
          <div class="pf-row" style="margin-top:6px"><button class="pf-resize">Canvas size…</button><button class="pf-clear">Clear</button></div></div>
        <div class="pf-note pf-keys">B pencil · E eraser · G fill · L line · R rect · I pick · M mirror · Ctrl+Z undo · scroll to zoom · space+drag or middle mouse to pan · right click erases</div>
      </aside>
      <dialog class="pf-dlg-pr"><form method="dialog" class="pf-form"><h4>Propose changes as a pull request</h4><div class="pf-chg-list"></div>
        <label>Repository <input type="text" class="pf-pr-repo" list="pf-repos" placeholder="owner/name"></label>
        <label>Base branch <input type="text" class="pf-pr-base" placeholder="default branch"></label>
        <label>Title <input type="text" class="pf-pr-title" placeholder="Update player sprite"></label>
        <label>Description <textarea class="pf-pr-desc" rows="3" style="width:100%" placeholder="What changed and why"></textarea></label>
        <div class="pf-row pf-auth-row"><button type="button" class="primary pf-signin">Sign in with GitHub</button><span class="pf-who pf-note"></span><button type="button" class="pf-signout" hidden>Sign out</button></div><div class="pf-note pf-auth-help"></div>
        <details class="pf-tokenbox"><summary>Use a token instead</summary>
          <label>GitHub token <input type="password" class="pf-pr-token" autocomplete="off" placeholder="fine-grained token with Contents + Pull requests write"></label>
          <label><input type="checkbox" class="pf-pr-remember"> remember the token in this browser</label>
          <div class="pf-note">The token is only sent to GitHub. Without write access to the repository your fork is used automatically.</div></details>
        <div class="pf-log" aria-live="polite"></div>
        <div class="pf-row"><button type="button" class="primary pf-pr-go">Create pull request</button><button value="cancel">Close</button></div></form></dialog>
      <dialog class="pf-dlg-connect"><form method="dialog" class="pf-form"><h4>Open a project</h4>
        <div class="pf-box"><b>Just draw</b><div class="pf-note">Upload a PNG, or start a blank sprite. You work on it in this browser tab and download the result. Nothing is sent anywhere.</div>
          <div class="pf-row"><button type="button" class="primary pf-c-upload">Upload PNG…</button><button type="button" class="pf-c-blank">Blank sprite</button></div></div>
        <div class="pf-note pf-conn-intro">Or work on a whole project: a GitHub repository (changes go back as a pull request) or a folder on this computer (saves in place).</div>
        <div class="pf-box pf-gh-box"><b>GitHub repository</b>
          <div class="pf-row pf-auth-row"><button type="button" class="primary pf-signin">Sign in with GitHub</button><span class="pf-who pf-note"></span><button type="button" class="pf-signout" hidden>Sign out</button></div><div class="pf-note pf-auth-help"></div>
          <div class="pf-c-mine" hidden><div class="pf-c-repolist"></div><div class="pf-note pf-c-addrepo"></div></div>
          <label>Repository <input type="text" class="pf-c-repo" list="pf-repos" placeholder="owner/name" autocomplete="off"></label><datalist id="pf-repos"></datalist>
          <label>Branch <input type="text" class="pf-c-branch" placeholder="default branch"></label>
          <details class="pf-tokenbox"><summary>Use a token instead</summary>
            <label>Token <input type="password" class="pf-c-token" autocomplete="off" placeholder="optional for public repos; needed for private repos and pull requests"></label>
            <label><input type="checkbox" class="pf-c-remember"> remember the token in this browser</label></details>
          <div class="pf-row"><button type="button" class="primary pf-c-gh">Open repository</button></div></div>
        <div class="pf-box pf-c-folderbox"><b>Folder on this computer</b><div class="pf-note pf-c-foldernote">Pick the game project's folder. Works in Chrome, Edge and Opera.</div>
          <div class="pf-row"><button type="button" class="primary pf-c-folder">Choose folder…</button></div></div>
        <div class="pf-note">You can also drop PNG files onto the canvas at any time.</div>
        <div class="pf-log pf-c-msg" aria-live="polite"></div>
        <div class="pf-row"><button value="cancel">Close</button></div></form></dialog>
      <dialog class="pf-dlg-size"><form method="dialog" class="pf-form"><h4>Canvas size</h4>
        <div class="pf-row"><label>width <input type="number" class="pf-sz-w" min="1" max="1024"></label><label>height <input type="number" class="pf-sz-h" min="1" max="1024"></label></div>
        <label>keep <select class="pf-sz-a"><option value="tl">top-left</option><option value="c">centre</option></select></label>
        <div class="pf-row"><button type="button" class="primary pf-sz-ok">Apply</button><button value="cancel">Cancel</button></div></form></dialog>
      <dialog class="pf-dlg-new"><form method="dialog" class="pf-form"><h4>New sprite</h4>
        <div class="pf-row"><label>width <input type="number" class="pf-nw" min="1" max="1024" value="16"></label><label>height <input type="number" class="pf-nh" min="1" max="1024" value="16"></label></div>
        <label>file name <input type="text" class="pf-nn" value="new-sprite.png" placeholder="art/hero.png"></label>
        <div class="pf-row"><button type="button" class="primary pf-new-ok">Create</button><button value="cancel">Cancel</button></div></form></dialog>
    </div>`);
    $$dialogs(root);
    if (O.accent) root.style.setProperty('--pf-accent', O.accent);
    host.innerHTML = ''; host.appendChild(root);
    const $ = (s) => root.querySelector(s), $$ = (s) => [...root.querySelectorAll(s)];
    // accountEl: put "Signed in as … / Sign out" in the host page (e.g. its header) instead of the sidebar
    const account = root.querySelector('.pf-side-auth'), accountEl = typeof O.accountEl === 'string' ? document.querySelector(O.accountEl) : O.accountEl;
    if (accountEl) { account.classList.replace('pf-side-auth', 'pf-acct'); accountEl.appendChild(account); }
    const authRows = (sel) => [...$$('.pf-auth-row'), ...(accountEl ? [account] : [])].map((r) => (sel ? r.querySelector(sel) : r));

    /* ---------- state ---------- */
    const S = { sprites: [], docs: new Map(), cur: null, tool: 'pen', color: pack(57, 255, 122), mx: false, my: false, pp: true, grid: true, zoom: 8, ox: 0, oy: 0,
      palette: O.palette ? O.palette.map((c) => (typeof c === 'string' ? fromHex(c) : c)).filter((c) => c != null) : [], src: null, meta: {}, auth: { token: '', login: '' }, anim: { timer: 0, t: 0 }, notice: '' };
    const doc = () => S.docs.get(S.cur);
    const view = $('.pf-view'), stage = $('.pf-stage'), g = view.getContext('2d');
    const offscreen = document.createElement('canvas');
    let overlay = null; // preview pixels while dragging a shape: { pts, value }
    const note = (t) => { S.notice = t; status(); };

    /* ---------- sign in ----------
       One sign-in per device: the session (access token + refresh token) is kept in localStorage and the access token is renewed
       through the auth service when it is about to expire, so people do not see the GitHub popup again until they sign out. */
    const authBase = O.authBase || (typeof window !== 'undefined' && window.PF_AUTH_BASE) || '';
    const AUTH_KEY = 'pf:gh', emptyAuth = () => ({ token: '', exp: 0, refresh: '', rexp: 0, login: '' });
    const loadAuth = () => { try { const a = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); if (a && a.token && (!a.rexp || a.rexp > Date.now() || (a.exp && a.exp > Date.now()))) return { ...emptyAuth(), ...a }; } catch { /* storage blocked */ } return emptyAuth(); };
    const saveAuth = () => { try { if (S.auth.token) localStorage.setItem(AUTH_KEY, JSON.stringify(S.auth)); else localStorage.removeItem(AUTH_KEY); } catch { /* storage blocked */ } };
    const fromGrant = (r, login) => ({ token: r.token, exp: r.expiresIn ? Date.now() + r.expiresIn * 1000 : 0, refresh: r.refreshToken || '', rexp: r.refreshExpiresIn ? Date.now() + r.refreshExpiresIn * 1000 : 0, login: login || '' });
    S.auth = authBase ? loadAuth() : emptyAuth();
    let renewing = null;
    /** A usable access token for the signed-in user ('' when signed out), renewed first when it expires within two minutes. */
    function authToken() {
      const a = S.auth; if (!a.token) return Promise.resolve('');
      if (!a.exp || a.exp - Date.now() > 120000 || !a.refresh || !authBase) return Promise.resolve(a.token);
      if (renewing) return renewing;
      const run = async () => {
        const cur = loadAuth(); // another tab may have renewed it already (refresh tokens are single use)
        if (cur.token && cur.token !== a.token && (!cur.exp || cur.exp - Date.now() > 120000)) { S.auth = cur; return cur.token; }
        try { S.auth = fromGrant(await githubRefresh(authBase, cur.refresh || a.refresh), a.login); saveAuth(); return S.auth.token; }
        catch (e) { if (e.status === 401 || e.status === 400) { signOut(); throw new Error('Your GitHub sign-in has expired. Sign in again.'); } throw e; }
      };
      renewing = (typeof navigator !== 'undefined' && navigator.locks ? navigator.locks.request('pf-auth-renew', run) : run()).finally(() => { renewing = null; });
      return renewing;
    }
    function renderAuth() {
      const on = !!S.auth.token;
      authRows().forEach((r) => { r.hidden = !on && !authBase; r.querySelector('.pf-signin').hidden = on || !authBase; r.querySelector('.pf-signout').hidden = !on; r.querySelector('.pf-who').textContent = on ? 'Signed in as ' + (S.auth.login || 'GitHub user') : ''; });
      $$('.pf-auth-help').forEach((h) => { h.innerHTML = authBase ? (on ? '' : 'Sign in once and pick a repository you own or collaborate on. Edits go back as a pull request, no tokens to paste.') : `Sign-in is not set up on this page. Paste a token instead: <a href="${PAT_URL}" target="_blank" rel="noopener" style="color:var(--pf-accent)">create one with the right permissions</a> (Contents and Pull requests: read and write, only for your repository).`; });
      $$('.pf-tokenbox').forEach((d) => { d.open = !authBase; d.hidden = on; });
      $('.pf-c-mine').hidden = !on; $('.pf-dlg-connect .pf-form').classList.toggle('pf-signed-in', on);
      if (!on) { S.repos = null; $('#pf-repos').innerHTML = ''; }
    }
    const installUrl = () => (O.githubApp ? `https://github.com/apps/${encodeURIComponent(O.githubApp)}/installations/select_target` : '');
    function renderRepos() {
      const list = $('.pf-c-repolist'), add = $('.pf-c-addrepo'), repos = S.repos || [], link = installUrl();
      list.innerHTML = S.repos == null ? '<div class="pf-note">Loading your repositories…</div>' : repos.length
        ? repos.map((r) => `<button type="button" class="pf-c-pick${S.src && S.src.kind === 'github' && S.src.repo.slug === r.name ? ' on' : ''}" data-repo="${esc(r.name)}" data-branch="${esc(r.branch || '')}"><b>${esc(r.name)}</b><span class="pf-note">${S.src && S.src.kind === 'github' && S.src.repo.slug === r.name ? 'open now · ' : ''}${r.private ? 'private · ' : ''}${r.push ? 'pull requests' : 'read only'}</span></button>`).join('')
        : '<div class="pf-note">No repositories yet.</div>';
      $('#pf-repos').innerHTML = repos.map((r) => `<option value="${esc(r.name)}">`).join('');
      add.innerHTML = link ? `Missing one? <a href="${esc(link)}" target="_blank" rel="noopener" style="color:var(--pf-accent)">Install the app on it</a> (you, or the repository's owner), then reopen this dialog.` : '';
    }
    async function loadRepos() {
      if (!S.auth.token) return; S.repos = null; renderRepos();
      try { S.repos = await listRepos(await authToken(), { apiBase: O.apiBase, details: true }); } catch { S.repos = []; }
      renderRepos();
    }
    async function doSignIn(msgEl) {
      const say = (t) => (msgEl ? (msgEl.textContent = t) : note(t));
      try {
        say('Waiting for GitHub…');
        const r = await githubSignIn(authBase);
        let login = ''; try { login = (await githubUser(r.token, { apiBase: O.apiBase })).login; } catch { /* name is cosmetic */ }
        S.auth = fromGrant(r, login); saveAuth();
        say('Signed in' + (login ? ' as ' + login : '') + '.');
        renderAuth(); await loadRepos();
      } catch (e) { say(e.message); }
    }
    function signOut() { S.auth = emptyAuth(); saveAuth(); try { ['pf:authtoken', 'pf:authuser'].forEach((k) => sessionStorage.removeItem(k)); } catch { /* ignore */ } renderAuth(); }

    /* ---------- loading ---------- */
    const storedToken = () => { try { return sessionStorage.getItem('pf:token') || localStorage.getItem('pf:token') || ''; } catch { return ''; } };
    async function fetchJson(u) { const r = await fetch(u); if (!r.ok) throw new Error(u + ': ' + r.status); return r.json(); }
    /** Make `src` the project being edited. Returns false if the user chose to keep their unsaved session. */
    async function useSource(src) {
      if ([...S.docs.values()].some((d) => d.changed) && !confirm('Switching source discards this session\'s changes. Save or propose them first to keep them. Switch anyway?')) return false;
      play(false); S.docs.clear(); S.cur = null; S.src = src; S.sprites = src.sprites.map((x) => ({ ...x })); thumbs.clear();
      S.meta = { repo: Object.assign({}, src.repo || {}, Object.fromEntries(Object.entries(O.github || {}).filter(([, v]) => v != null && v !== ''))) };
      if (!O.palette) S.palette = (src.palette || []).map((h) => (typeof h === 'string' ? fromHex(h) : h)).filter((c) => c != null);
      $('.pf-src').textContent = src.note || '';
      const label = src.kind === 'github' ? src.repo.slug : src.kind === 'folder' ? src.name : '';
      $('.pf-source').textContent = label ? label + ' ▾' : 'Open project…'; $('.pf-source').title = (label ? label + ': ' : '') + 'switch to another GitHub repository or a folder on this computer';
      $('.pf-pr-repo').value = ''; $('.pf-pr-base').value = ''; $('.pf-pr-title').value = ''; // the next pull request goes to the new project
      renderList(); renderPalette();
      if (S.sprites.length) await openSprite(S.sprites[0].path); else { status(); render(); }
      return true;
    }
    async function init() {
      try {
        if (O.source) return void (await useSource(O.source));
        if (O.sprites) return void (await useSource(staticSource({ sprites: O.sprites, palette: O.paletteList || null, repo: O.github || null }, O.baseUrl)));
        if (O.manifestUrl) { const mf = await fetchJson(O.manifestUrl); return void (await useSource(staticSource(mf, O.baseUrl != null ? O.baseUrl : (mf.base || '')))); }
        if (O.connect === 'github' && O.github && O.github.slug) {
          try { return void (await useSource(await githubSource({ repo: O.github.slug, branch: O.github.base, token: storedToken() || await authToken().catch(() => ''), apiBase: O.apiBase }))); } catch (e) { return openConnect(e.message); }
        }
        try { const mf = await fetchJson('api/manifest'), m = document.querySelector('meta[name="pf-token"]'); return void (await useSource(serverSource(mf, m ? m.content : ''))); } catch { /* no local server here */ }
        try { const mf = await fetchJson('pixel-art.json'); return void (await useSource(staticSource(mf, O.baseUrl != null ? O.baseUrl : (mf.base || '')))); } catch { /* no manifest here */ }
        status(); render();
        if (O.blank) await addLocal(O.blank.name || 'sprite.png', O.blank.w || 16, O.blank.h || 16, new Uint32Array((O.blank.w || 16) * (O.blank.h || 16)), false); else if (O.connect !== false) openConnect();
      } catch (e) { note('Could not start: ' + e.message); }
    }
    async function openSprite(path) {
      if (!S.docs.has(path)) {
        const meta = S.sprites.find((s) => s.path === path);
        try {
          const img = await decodePng(new Blob([await S.src.read(path)], { type: 'image/png' }));
          S.docs.set(path, new Doc(path, img.w, img.h, img.px, { frames: meta && meta.frames }));
        } catch (e) { note('Could not open ' + path + ': ' + e.message); return; }
      }
      S.cur = path; S.touched = false; const d = doc(); loadFrames(d); fit(); renderList(); renderColors(); status(); render(); drawPreview();
    }
    /** Add an image that is not in the project list. inProject = Save should write it to that path (needs a source that can write). */
    function addLocal(name, w, h, px, inProject) {
      let path = name, n = 1; while (S.docs.has(path)) path = name.replace(/(\.png)?$/i, '') + '-' + (++n) + '.png';
      S.docs.set(path, new Doc(path, w, h, px, { local: !inProject })); S.sprites.push({ path, w, h, local: !inProject }); return openSprite(path);
    }
    const canWrite = () => !!(S.src && S.src.write);

    /* ---------- list ---------- */
    const thumbs = new Map();
    const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { io.unobserve(e.target); paintThumb(e.target, e.target.__s); } }), { root: $('.pf-list') }) : null;
    function renderList() {
      const q = $('.pf-q').value.toLowerCase(), list = $('.pf-list'); list.innerHTML = '';
      for (const s of S.sprites.filter((x) => x.path.toLowerCase().includes(q))) {
        const d = S.docs.get(s.path), b = el(`<button class="pf-item${s.path === S.cur ? ' on' : ''}" role="option" data-path="${esc(s.path)}"><canvas width="${s.w || 16}" height="${s.h || 16}"></canvas><span class="n">${esc(s.path.split('/').pop())}<small>${esc(s.path.split('/').slice(0, -1).join('/') || '.')} · ${d ? d.w + '×' + d.h : (s.w || '?') + '×' + (s.h || '?')}</small></span>${d && d.unsaved ? '<i class="dot" title="unsaved"></i>' : d && d.changed ? '<i class="dot base" title="saved, not yet proposed"></i>' : ''}</button>`);
        list.appendChild(b); const cv = b.querySelector('canvas'); cv.__s = s; if (io) io.observe(cv); else paintThumb(cv, s);
      }
    }
    async function paintThumb(canvas, s) {
      const d = S.docs.get(s.path);
      if (d) return drawPx(canvas, d);
      if (!S.src || !S.src.thumbs) return;
      try {
        let bm = thumbs.get(s.path);
        if (!bm) { bm = await createImageBitmap(new Blob([await S.src.read(s.path)], { type: 'image/png' })); thumbs.set(s.path, bm); }
        canvas.width = bm.width; canvas.height = bm.height; const c = canvas.getContext('2d'); c.imageSmoothingEnabled = false; c.drawImage(bm, 0, 0);
      } catch { /* leave blank */ }
    }

    /* ---------- palette / colours ---------- */
    function renderColors() {
      const d = doc(); if (!d) return;
      const cols = colorsOf(d.px).filter(([c]) => c !== 0).slice(0, 64);
      $('.pf-img-colors').innerHTML = cols.map(([c, n]) => `<button data-c="${c}" title="${toHex(c)} · ${n}px" class="${c === S.color ? 'on' : ''}" style="background:${toHex(c)}"></button>`).join('') || '<span class="pf-note">transparent</span>';
      $('.pf-cpick').value = toHex(S.color); if (document.activeElement !== $('.pf-chex')) $('.pf-chex').value = toHex(S.color);
      $$('.pf-pal-colors button').forEach((b) => b.classList.toggle('on', +b.dataset.c === S.color));
      if (S.palette.length) {
        const set = new Set(S.palette), off = cols.filter(([c]) => !set.has(c)).length;
        $('.pf-off').innerHTML = off ? `<span class="pf-bad">${off} colour${off > 1 ? 's' : ''} outside the palette</span>` : 'All colours are in the palette.';
      }
    }
    function renderPalette() {
      $('.pf-pal-wrap').hidden = !S.palette.length;
      $('.pf-pal-colors').innerHTML = S.palette.map((c) => `<button data-c="${c}" title="${toHex(c)}" style="background:${toHex(c)}"></button>`).join('');
    }
    function setColor(c) { S.color = c; if (S.tool === 'erase' || S.tool === 'pick') setTool('pen'); renderColors(); }

    /* ---------- viewport ---------- */
    function resizeView() {
      const r = stage.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      view.width = Math.max(1, Math.round(r.width * dpr)); view.height = Math.max(1, Math.round(r.height * dpr)); render();
    }
    function fit() {
      const d = doc(); if (!d) return; const r = stage.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      const z = Math.max(1, Math.floor(Math.min((r.width * dpr - 40) / d.w, (r.height * dpr - 40) / d.h)));
      S.zoom = Math.min(64, z); S.ox = Math.round((view.width - d.w * S.zoom) / 2); S.oy = Math.round((view.height - d.h * S.zoom) / 2);
    }
    function zoomAt(f, cx, cy) {
      const z = Math.max(1, Math.min(64, Math.round(S.zoom * f) === S.zoom ? S.zoom + (f > 1 ? 1 : -1) : Math.round(S.zoom * f)));
      const px = (cx - S.ox) / S.zoom, py = (cy - S.oy) / S.zoom; S.zoom = z; S.ox = Math.round(cx - px * z); S.oy = Math.round(cy - py * z); S.touched = true; render();
    }
    const toCell = (e) => { const r = view.getBoundingClientRect(), dpr = view.width / r.width, X = (e.clientX - r.left) * dpr, Y = (e.clientY - r.top) * dpr; return { x: Math.floor((X - S.ox) / S.zoom), y: Math.floor((Y - S.oy) / S.zoom), X, Y }; };

    function render() {
      const d = doc(); g.clearRect(0, 0, view.width, view.height); g.imageSmoothingEnabled = false;
      if (!d) return;
      const z = S.zoom, W = d.w * z, H = d.h * z;
      /* checkerboard behind transparent pixels, one square per 2 art pixels at low zoom */
      const cs = Math.max(8, z * 2 > 16 ? z : 16);
      g.save(); g.beginPath(); g.rect(S.ox, S.oy, W, H); g.clip();
      for (let y = 0; y * cs < H; y++) for (let x = 0; x * cs < W; x++) { g.fillStyle = (x + y) % 2 ? '#1a2229' : '#10161a'; g.fillRect(S.ox + x * cs, S.oy + y * cs, cs, cs); }
      g.restore();
      offscreen.width = d.w; offscreen.height = d.h; offscreen.getContext('2d').putImageData(d.imageData(), 0, 0);
      g.drawImage(offscreen, S.ox, S.oy, W, H);
      if (overlay) { g.globalAlpha = 0.9; for (const [x, y] of overlay.pts) if (x >= 0 && y >= 0 && x < d.w && y < d.h) { g.fillStyle = isClear(overlay.value) ? 'rgba(255,255,255,.35)' : toHex(overlay.value); g.fillRect(S.ox + x * z, S.oy + y * z, z, z); } g.globalAlpha = 1; }
      if (S.grid && z >= 6) {
        g.strokeStyle = 'rgba(255,255,255,.10)'; g.lineWidth = 1; g.beginPath();
        for (let x = 0; x <= d.w; x++) { g.moveTo(S.ox + x * z + .5, S.oy); g.lineTo(S.ox + x * z + .5, S.oy + H); }
        for (let y = 0; y <= d.h; y++) { g.moveTo(S.ox, S.oy + y * z + .5); g.lineTo(S.ox + W, S.oy + y * z + .5); }
        g.stroke();
      }
      const f = frameSize(d);
      if (f && (f.w < d.w || f.h < d.h)) { g.strokeStyle = 'rgba(255,176,0,.6)'; g.beginPath(); for (let x = f.w; x < d.w; x += f.w) { g.moveTo(S.ox + x * z + .5, S.oy); g.lineTo(S.ox + x * z + .5, S.oy + H); } for (let y = f.h; y < d.h; y += f.h) { g.moveTo(S.ox, S.oy + y * z + .5); g.lineTo(S.ox + W, S.oy + y * z + .5); } g.stroke(); }
      g.strokeStyle = 'rgba(255,255,255,.35)'; g.strokeRect(S.ox - .5, S.oy - .5, W + 1, H + 1);
      if (S.mx) { g.strokeStyle = 'rgba(255,0,200,.6)'; g.beginPath(); g.moveTo(S.ox + W / 2, S.oy); g.lineTo(S.ox + W / 2, S.oy + H); g.stroke(); }
      if (S.my) { g.strokeStyle = 'rgba(255,0,200,.6)'; g.beginPath(); g.moveTo(S.ox, S.oy + H / 2); g.lineTo(S.ox + W, S.oy + H / 2); g.stroke(); }
    }
    function status() {
      const d = doc();
      $('.pf-s-name').innerHTML = d ? `<b>${esc(d.path)}</b>${d.unsaved ? ' · <span class="pf-bad">unsaved</span>' : d.changed ? ' · saved, not yet in a PR' : ''}` : 'No sprite open';
      $('.pf-s-info').innerHTML = d ? `${d.w}×${d.h} · zoom ${S.zoom}×${S.notice ? ' · ' + esc(S.notice) : ''}` : esc(S.notice);
      $('.pf-undo').disabled = !d || !d.undo.length; $('.pf-redo').disabled = !d || !d.redo.length; $('.pf-save').disabled = !d;
      $('.pf-prbtn').hidden = !O.pr; $('.pf-prbtn').disabled = ![...S.docs.values()].some((x) => x.changed);
    }

    /* ---------- editing ---------- */
    const setTool = (t) => { S.tool = t; $$('.pf-tools button').forEach((b) => b.classList.toggle('on', b.dataset.t === t)); };
    $('.pf-tools').innerHTML = TOOLS.map(([k, n, key]) => `<button data-t="${k}" title="${n} (${key})">${n.replace('Colour picker', 'Pick').replace('Filled rectangle', 'Rect ■').replace('Rectangle', 'Rect □')}</button>`).join('');
    setTool('pen');
    const changedUi = () => { renderColors(); status(); renderListSoon(); drawPreview(); render(); };
    let listTimer = 0; const renderListSoon = () => { clearTimeout(listTimer); listTimer = setTimeout(renderList, 120); };
    function put(d, x, y, v, rec) { // paint with mirror, recording the previous value once per stroke
      const set = (X, Y) => { if (X < 0 || Y < 0 || X >= d.w || Y >= d.h) return; const i = Y * d.w + X; if (rec && !rec.has(i)) rec.set(i, d.px[i]); d.px[i] = v; };
      set(x, y); if (S.mx) set(d.w - 1 - x, y); if (S.my) set(x, d.h - 1 - y); if (S.mx && S.my) set(d.w - 1 - x, d.h - 1 - y);
    }
    const mirrorPts = (d, pts) => { const out = []; for (const [x, y] of pts) { out.push([x, y]); if (S.mx) out.push([d.w - 1 - x, y]); if (S.my) out.push([x, d.h - 1 - y]); if (S.mx && S.my) out.push([d.w - 1 - x, d.h - 1 - y]); } return out; };
    let drag = null, pan = null, space = false; const pointers = new Map(); let pinch = null;

    view.addEventListener('contextmenu', (e) => e.preventDefault());
    view.addEventListener('pointerdown', (e) => {
      const d = doc(); if (!d) return; view.setPointerCapture(e.pointerId); pointers.set(e.pointerId, e);
      if (pointers.size === 2) { drag = null; const [a, b] = [...pointers.values()]; pinch = { dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), zoom: S.zoom, cx: (a.clientX + b.clientX) / 2, cy: (a.clientY + b.clientY) / 2 }; return; }
      if (e.button === 1 || space || (e.button === 0 && e.shiftKey && e.altKey)) { pan = { x: e.clientX, y: e.clientY, ox: S.ox, oy: S.oy }; return; }
      const c = toCell(e), inb = c.x >= 0 && c.y >= 0 && c.x < d.w && c.y < d.h;
      let tool = S.tool, value = S.color; if (e.button === 2) { tool = tool === 'pick' ? 'pick' : 'erase'; }
      if (tool === 'erase') value = 0;
      if (tool === 'pick') { if (inb) { const v = d.px[c.y * d.w + c.x]; if (isClear(v)) setTool('erase'); else { setColor(v); setTool('pen'); } } return; }
      if (!inb && tool !== 'line' && tool !== 'rect' && tool !== 'rectf') return;
      d.snapshot(); drag = { tool, value, start: c, last: c, rec: new Map(), trail: [c], moved: false };
      if (tool === 'pen' || tool === 'erase') { put(d, c.x, c.y, value, drag.rec); changedUi(); }
      else if (tool === 'fill') { if (inb) { const tmp = d.px.slice(); const ch = floodFill(tmp, d.w, d.h, c.x, c.y, value); if (ch.length) { d.px = tmp; if (S.mx || S.my) { /* mirrored fill: also fill the mirror point's region */ for (const [mx, my] of mirrorPts(d, [[c.x, c.y]]).slice(1)) floodFill(d.px, d.w, d.h, mx, my, value); } } else d.undo.pop(); } drag = null; changedUi(); }
    });
    view.addEventListener('pointermove', (e) => {
      const d = doc(); if (!d) return;
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, e);
      if (pinch && pointers.size === 2) { const [a, b] = [...pointers.values()]; const nd = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); const r = view.getBoundingClientRect(), dpr = view.width / r.width; const z = Math.max(1, Math.min(64, Math.round(pinch.zoom * nd / pinch.dist))); if (z !== S.zoom) { const cx = (pinch.cx - r.left) * dpr, cy = (pinch.cy - r.top) * dpr, px = (cx - S.ox) / S.zoom, py = (cy - S.oy) / S.zoom; S.zoom = z; S.ox = Math.round(cx - px * z); S.oy = Math.round(cy - py * z); render(); status(); } return; }
      if (pan) { S.touched = true; const r = view.getBoundingClientRect(), dpr = view.width / r.width; S.ox = Math.round(pan.ox + (e.clientX - pan.x) * dpr); S.oy = Math.round(pan.oy + (e.clientY - pan.y) * dpr); render(); return; }
      const c = toCell(e); $('.pf-s-pos').textContent = c.x >= 0 && c.y >= 0 && c.x < d.w && c.y < d.h ? `x ${c.x}  y ${c.y}  ${toHex(d.px[c.y * d.w + c.x])}${isClear(d.px[c.y * d.w + c.x]) ? ' (clear)' : ''}` : '';
      if (!drag) return;
      if (drag.tool === 'pen' || drag.tool === 'erase') {
        for (const [x, y] of linePoints(drag.last.x, drag.last.y, c.x, c.y).slice(1)) {
          put(d, x, y, drag.value, drag.rec); drag.trail.push({ x, y });
          if (S.pp && drag.tool === 'pen' && drag.trail.length >= 3) { /* pixel-perfect: drop the middle pixel of an L-shaped corner */
            const [p1, p2, p3] = drag.trail.slice(-3);
            if (Math.abs(p3.x - p1.x) === 1 && Math.abs(p3.y - p1.y) === 1 && (p2.x === p1.x || p2.y === p1.y) && !(S.mx || S.my)) { const i = p2.y * d.w + p2.x; if (drag.rec.has(i)) d.px[i] = drag.rec.get(i); drag.trail.splice(-2, 1); }
          }
        }
        drag.last = c; changedUi();
      } else { // shapes: preview only until release
        const pts = drag.tool === 'line' ? linePoints(drag.start.x, drag.start.y, c.x, c.y) : rectPoints(drag.start.x, drag.start.y, c.x, c.y, drag.tool === 'rectf');
        overlay = { pts: mirrorPts(d, pts), value: drag.value }; drag.last = c; drag.moved = true; render();
      }
    });
    const end = (e) => {
      pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; pan = null;
      const d = doc(); if (drag && d) {
        if (overlay) { for (const [x, y] of overlay.pts) if (x >= 0 && y >= 0 && x < d.w && y < d.h) d.px[y * d.w + x] = overlay.value; overlay = null; }
        else if ((drag.tool === 'line' || drag.tool === 'rect' || drag.tool === 'rectf') && !drag.moved) { const c = drag.start; if (c.x >= 0 && c.y >= 0 && c.x < d.w && c.y < d.h) d.px[c.y * d.w + c.x] = drag.value; }
        const same = !d.undo.length || countDiff(d.undo[d.undo.length - 1].px, d.px) === 0 && d.undo[d.undo.length - 1].w === d.w; if (same) d.undo.pop();
        drag = null; changedUi();
      }
    };
    view.addEventListener('pointerup', end); view.addEventListener('pointercancel', end);
    view.addEventListener('wheel', (e) => { e.preventDefault(); const r = view.getBoundingClientRect(), dpr = view.width / r.width; zoomAt(e.deltaY < 0 ? 1.25 : 0.8, (e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr); status(); }, { passive: false });

    /* ---------- operations ---------- */
    function edit(fn) { const d = doc(); if (!d) return; d.snapshot(); fn(d); changedUi(); }
    const undo = () => { const d = doc(); if (d && d.undoOnce()) { fit(); changedUi(); } };
    const redo = () => { const d = doc(); if (d && d.redoOnce()) { fit(); changedUi(); } };

    /* ---------- saving & exporting ---------- */
    async function pngOf(d, scale = 1) {
      if (hasStreams()) return new Blob([await encodePngBytes(d.w, d.h, d.px, scale)], { type: 'image/png' });
      const c = document.createElement('canvas'); drawPx(c, d, scale); return toBlob(c);
    }
    async function save() {
      const d = doc(); if (!d) return;
      try {
        const blob = await pngOf(d);
        if (O.save) await O.save(d, blob);
        else if (canWrite() && !d.local) await S.src.write(d.path, new Uint8Array(await blob.arrayBuffer()));
        else download(blob, d.path.split('/').pop());
        d.markSaved(); note(canWrite() && !d.local ? 'saved ' + d.path : 'downloaded ' + d.path.split('/').pop()); changedUi();
      } catch (e) { note('Save failed: ' + e.message); }
    }
    function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 3000); }
    async function exportPng() { const d = doc(); if (!d) return; const s = +(prompt('Export scale (1 = original size, 8 = each pixel becomes 8×8):', '1') || 0); if (!s || s < 1 || s > 64) return; download(await pngOf(d, Math.floor(s)), d.path.split('/').pop().replace(/\.png$/i, '') + (s > 1 ? '@' + s + 'x' : '') + '.png'); }

    /* ---------- preview & animation ---------- */
    const frameKey = (d) => 'pf:frames:' + d.path;
    function loadFrames(d) {
      let f = d.frames; try { const s = JSON.parse(localStorage.getItem(frameKey(d))); if (s) f = s; } catch { /* none */ }
      if (!f) f = d.w > d.h && d.w % d.h === 0 ? { w: d.h, h: d.h, fps: 8 } : { w: d.w, h: d.h, fps: 8 };
      d.frames = f; $('.pf-fw').value = f.w; $('.pf-fh').value = f.h; $('.pf-fps').value = f.fps || 8;
    }
    const frameSize = (d) => (d && d.frames ? { w: Math.max(1, Math.min(d.w, d.frames.w | 0)), h: Math.max(1, Math.min(d.h, d.frames.h | 0)) } : null);
    function drawPreview() {
      const d = doc(); if (!d) return; const p1 = $('.pf-p1'), p2 = $('.pf-p2');
      drawPx(p1, d, d.w <= 32 ? 2 : 1);
      const f = frameSize(d), cols = Math.max(1, Math.floor(d.w / f.w)), rows = Math.max(1, Math.floor(d.h / f.h)), n = cols * rows, i = S.anim.t % n;
      const sc = Math.max(1, Math.min(8, Math.floor(190 / f.w)));
      p2.width = f.w * sc; p2.height = f.h * sc; const k = p2.getContext('2d'); k.imageSmoothingEnabled = false; k.clearRect(0, 0, p2.width, p2.height);
      offscreen.width = d.w; offscreen.height = d.h; offscreen.getContext('2d').putImageData(d.imageData(), 0, 0);
      k.drawImage(offscreen, (i % cols) * f.w, Math.floor(i / cols) * f.h, f.w, f.h, 0, 0, f.w * sc, f.h * sc);
    }
    function play(on) {
      clearInterval(S.anim.timer); S.anim.timer = 0; $('.pf-play').textContent = on ? 'Stop' : 'Play';
      if (on) S.anim.timer = setInterval(() => { S.anim.t++; drawPreview(); }, 1000 / Math.max(1, Math.min(60, +$('.pf-fps').value || 8)));
    }
    function frameInputs() {
      const d = doc(); if (!d) return; d.frames = { w: +$('.pf-fw').value || d.w, h: +$('.pf-fh').value || d.h, fps: +$('.pf-fps').value || 8 };
      try { localStorage.setItem(frameKey(d), JSON.stringify(d.frames)); } catch { /* ignore */ }
      if (S.anim.timer) play(true); drawPreview(); render();
    }

    /* ---------- pull request dialog ---------- */
    function openPr() {
      const changed = [...S.docs.values()].filter((d) => d.changed); if (!changed.length) return;
      const gh = S.meta.repo || {}, dlg = $('.pf-dlg-pr');
      $('.pf-pr-repo').value = $('.pf-pr-repo').value || gh.slug || gh.repo || ''; $('.pf-pr-base').value = $('.pf-pr-base').value || gh.base || gh.branch || '';
      $('.pf-pr-title').value = $('.pf-pr-title').value || (changed.length === 1 ? 'Update ' + changed[0].path.split('/').pop() : 'Update ' + changed.length + ' sprites');
      if (!S.auth.token) try { $('.pf-pr-token').value = $('.pf-pr-token').value || sessionStorage.getItem('pf:token') || localStorage.getItem('pf:token') || ''; } catch { /* storage blocked */ }
      $('.pf-chg-list').innerHTML = changed.map((d) => `<div class="pf-chg"><canvas data-p="${esc(d.path)}"></canvas><span>${esc(d.path)}<br><span class="pf-note">${d.w}×${d.h} · ${d.changedPixels()} px changed</span></span></div>`).join('');
      $$('.pf-chg canvas').forEach((c) => drawPx(c, S.docs.get(c.dataset.p)));
      $('.pf-log').textContent = ''; dlg.showModal();
    }
    async function submitPr() {
      const changed = [...S.docs.values()].filter((d) => d.changed), log = $('.pf-log'), go = $('.pf-pr-go');
      const typed = $('.pf-pr-token').value.trim(), repo = $('.pf-pr-repo').value.trim(), title = $('.pf-pr-title').value.trim() || 'Update sprites';
      try { if (typed) { if ($('.pf-pr-remember').checked) localStorage.setItem('pf:token', typed); else sessionStorage.setItem('pf:token', typed); } } catch { /* ignore */ }
      go.disabled = true; log.textContent = '';
      try {
        const token = (S.auth.token && !typed ? await authToken() : typed) || '';
        if (!token) throw new Error(authBase ? 'Sign in with GitHub first.' : 'Paste a GitHub token first.');
        const files = []; for (const d of changed) files.push({ path: d.path, blob: await pngOf(d), w: d.w, h: d.h, pixels: d.changedPixels() });
        const prefix = (S.meta.repo && S.meta.repo.prefix) || '';
        const res = await createPullRequest({ token, repo, base: $('.pf-pr-base').value.trim() || undefined, prefix, title, apiBase: O.apiBase, files: files.map((f) => ({ path: f.path, blob: f.blob })), branch: 'art/' + slug(title) + '-' + Date.now().toString(36),
          body: (ctx) => prBody({ files, repo, prefix, description: $('.pf-pr-desc').value.trim(), baseSha: ctx.baseSha, commit: ctx.commit, headRepo: ctx.headRepo }), onProgress: (m) => { log.textContent += m + '\n'; log.scrollTop = log.scrollHeight; } });
        log.innerHTML = `${esc(log.textContent)}Done${res.forked ? ' (from your fork)' : ''}: <a href="${esc(res.url)}" target="_blank" rel="noopener" style="color:var(--pf-accent)">${esc(res.url)}</a>`;
        for (const d of changed) d.base = { w: d.w, h: d.h, px: d.px.slice() };
        status(); renderList();
      } catch (e) { log.textContent += '\n' + e.message; if (/rejected the (sign-in|token)/.test(e.message) && S.auth.token) signOut(); } finally { go.disabled = false; }
    }

    /* ---------- events ---------- */
    root.addEventListener('click', (e) => {
      const t = e.target.closest('button'); if (!t) return;
      if (t.dataset.t) return setTool(t.dataset.t);
      if (t.classList.contains('pf-item')) return openSprite(t.dataset.path);
      if (t.dataset.c !== undefined && t.closest('.pf-sw')) return setColor(+t.dataset.c);
      if (t.dataset.d) { const [dx, dy] = t.dataset.d.split(',').map(Number); return edit((d) => { d.px = shiftWrap(d.px, d.w, d.h, dx, dy); }); }
    });
    $('.pf-q').oninput = renderList;
    $('.pf-undo').onclick = undo; $('.pf-redo').onclick = redo;
    $('.pf-zin').onclick = () => { S.zoom = Math.min(64, S.zoom + 1); S.touched = true; fit2(); }; $('.pf-zout').onclick = () => { S.zoom = Math.max(1, S.zoom - 1); S.touched = true; fit2(); };
    function fit2() { const d = doc(); if (d) { S.ox = Math.round((view.width - d.w * S.zoom) / 2); S.oy = Math.round((view.height - d.h * S.zoom) / 2); } render(); status(); }
    $('.pf-fit').onclick = () => { fit(); render(); status(); };
    $('.pf-grid').onclick = (e) => { S.grid = !S.grid; e.currentTarget.classList.toggle('on', S.grid); render(); };
    $('.pf-mx').onclick = (e) => { S.mx = !S.mx; e.currentTarget.classList.toggle('on', S.mx); render(); };
    $('.pf-my').onclick = (e) => { S.my = !S.my; e.currentTarget.classList.toggle('on', S.my); render(); };
    $('.pf-pp').onclick = (e) => { S.pp = !S.pp; e.currentTarget.classList.toggle('on', S.pp); };
    $('.pf-save').onclick = save; $('.pf-export').onclick = exportPng; $('.pf-prbtn').onclick = openPr; $('.pf-pr-go').onclick = submitPr;
    $('.pf-cpick').oninput = (e) => setColor(fromHex(e.target.value));
    $('.pf-chex').onchange = (e) => { const c = fromHex(e.target.value); if (c != null) setColor(c); else renderColors(); };
    $('.pf-recolor').onclick = () => { const i = $('.pf-recolor-in'); i.value = toHex(S.color); i.click(); };
    { let session = null;
      $('.pf-recolor-in').oninput = (e) => { const d = doc(), to = fromHex(e.target.value); if (!d || to == null) return; if (!session) { if (!d.px.includes(S.color)) { note('That colour is not in this image.'); return; } d.snapshot(); session = { from: S.color }; } for (let i = 0; i < d.px.length; i++) if (d.px[i] === session.from) d.px[i] = to; session.from = to; S.color = to; changedUi(); };
      $('.pf-recolor-in').onchange = () => { session = null; }; }
    $('.pf-fliph').onclick = () => edit((d) => { d.px = flipH(d.px, d.w, d.h); }); $('.pf-flipv').onclick = () => edit((d) => { d.px = flipV(d.px, d.w, d.h); });
    $('.pf-rot').onclick = () => edit((d) => { d.px = rotateCW(d.px, d.w, d.h); [d.w, d.h] = [d.h, d.w]; fit(); });
    $('.pf-clear').onclick = () => edit((d) => { d.px = new Uint32Array(d.w * d.h); });
    $('.pf-resize').onclick = () => { const d = doc(); if (!d) return; $('.pf-sz-w').value = d.w; $('.pf-sz-h').value = d.h; $('.pf-dlg-size').showModal(); };
    $('.pf-sz-ok').onclick = () => { const w = Math.max(1, Math.min(1024, +$('.pf-sz-w').value | 0)), h = Math.max(1, Math.min(1024, +$('.pf-sz-h').value | 0)); edit((d) => { d.px = resizePx(d.px, d.w, d.h, w, h, $('.pf-sz-a').value); d.w = w; d.h = h; fit(); }); $('.pf-dlg-size').close(); };
    $('.pf-new').onclick = () => $('.pf-dlg-new').showModal();
    $('.pf-new-ok').onclick = () => { const w = Math.max(1, Math.min(1024, +$('.pf-nw').value | 0)), h = Math.max(1, Math.min(1024, +$('.pf-nh').value | 0)); let n = $('.pf-nn').value.trim().replace(/^\/+/, '') || 'new-sprite.png'; if (!/\.png$/i.test(n)) n += '.png'; $('.pf-dlg-new').close(); addLocal(n, w, h, new Uint32Array(w * h), canWrite()); };
    $('.pf-open').onclick = () => $('.pf-file').click();
    $('.pf-file').onchange = async (e) => { for (const f of e.target.files) await importFile(f); e.target.value = ''; };
    async function importFile(f) { try { const img = await decodePng(f); addLocal(f.name, img.w, img.h, img.px); } catch (err) { note('Could not read ' + f.name + ': ' + err.message); } }
    stage.addEventListener('dragover', (e) => e.preventDefault());
    stage.addEventListener('drop', async (e) => { e.preventDefault(); for (const f of e.dataTransfer.files) if (/^image\//.test(f.type)) await importFile(f); });
    function openConnect(msg) {
      const dlg = $('.pf-dlg-connect'), gh = O.github || {};
      $('.pf-c-repo').value = $('.pf-c-repo').value || gh.slug || ''; $('.pf-c-branch').value = $('.pf-c-branch').value || gh.base || ''; if (!S.auth.token) $('.pf-c-token').value = $('.pf-c-token').value || storedToken();
      if (S.auth.token) loadRepos();
      const canFolder = typeof window.showDirectoryPicker === 'function'; $('.pf-c-folder').disabled = !canFolder; $('.pf-c-foldernote').textContent = canFolder ? 'Pick the game project\'s folder. Saving writes the PNGs in place. Works in Chrome, Edge and Opera.' : 'This browser cannot open folders (use Chrome, Edge or Opera), but GitHub and Open PNG work everywhere.';
      $('.pf-c-msg').textContent = msg || ''; if (!dlg.open) dlg.showModal();
    }
    $('.pf-source').onclick = () => openConnect();
    authRows('.pf-signin').forEach((b) => (b.onclick = () => { const d = b.closest('dialog'); doSignIn(d && d.querySelector('.pf-c-msg, .pf-log')); }));
    authRows('.pf-signout').forEach((b) => (b.onclick = () => { signOut(); if (!b.closest('dialog')) note('Signed out of GitHub on this device.'); }));
    $('.pf-c-repolist').onclick = (e) => { const b = e.target.closest('.pf-c-pick'); if (!b) return; $('.pf-c-repo').value = b.dataset.repo; $('.pf-c-branch').value = b.dataset.branch; $('.pf-c-gh').click(); };
    $('.pf-c-upload').onclick = () => { $('.pf-dlg-connect').close(); $('.pf-file').click(); };
    $('.pf-c-blank').onclick = () => { $('.pf-dlg-connect').close(); $('.pf-dlg-new').showModal(); };
    $('.pf-c-gh').onclick = async () => {
      const msg = $('.pf-c-msg'), btn = $('.pf-c-gh'), typed = S.auth.token ? '' : $('.pf-c-token').value.trim(); btn.disabled = true; msg.textContent = 'Connecting…';
      try {
        const token = typed || await authToken();
        const src = await githubSource({ repo: $('.pf-c-repo').value.trim(), branch: $('.pf-c-branch').value.trim() || undefined, token, apiBase: O.apiBase });
        try { if (typed) { if ($('.pf-c-remember').checked) localStorage.setItem('pf:token', token); else sessionStorage.setItem('pf:token', token); } } catch { /* storage blocked */ }
        msg.textContent = src.sprites.length + ' PNG file' + (src.sprites.length === 1 ? '' : 's') + ' found.';
        if (await useSource(src)) $('.pf-dlg-connect').close();
      } catch (e) { msg.textContent = e.message; if (/rejected the (sign-in|token)/.test(e.message) && S.auth.token) signOut(); } finally { btn.disabled = false; }
    };
    $('.pf-c-folder').onclick = async () => {
      const msg = $('.pf-c-msg'); msg.textContent = '';
      try {
        const dir = await window.showDirectoryPicker({ mode: 'readwrite' }); msg.textContent = 'Scanning ' + dir.name + '…';
        const src = await folderSource(dir); msg.textContent = src.sprites.length + ' PNG file' + (src.sprites.length === 1 ? '' : 's') + ' found.';
        if (await useSource(src)) $('.pf-dlg-connect').close();
      } catch (e) { msg.textContent = e && e.name === 'AbortError' ? '' : 'Could not open the folder: ' + (e && e.message); }
    };
    $('.pf-palload').onclick = () => $('.pf-palfile').click();
    $('.pf-palfile').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; const p = parsePalette(await f.text()); if (p.length) { S.palette = p; renderPalette(); renderColors(); note('palette: ' + p.length + ' colours'); } else note('No colours found in ' + f.name); e.target.value = ''; };
    $('.pf-palsave').onclick = () => { const d = doc(); if (!d) return; const cols = S.palette.length ? S.palette : colorsOf(d.px).filter(([c]) => c !== 0).map(([c]) => c); download(new Blob([cols.map((c) => toHex(c).slice(1)).join('\n') + '\n'], { type: 'text/plain' }), 'palette.hex'); };
    $('.pf-snap').onclick = () => edit((d) => { for (let i = 0; i < d.px.length; i++) if (!isClear(d.px[i])) d.px[i] = nearestColor(d.px[i], S.palette); });
    $('.pf-play').onclick = () => play(!S.anim.timer);
    ['.pf-fw', '.pf-fh', '.pf-fps'].forEach((s) => ($(s).oninput = frameInputs));
    function keydown(e) {
      if (!root.isConnected) return;
      const tag = (e.target.tagName || '').toLowerCase(); if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
      if (root.querySelector('dialog[open]')) return;
      const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
      if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); } else if (mod && k === 'y') { e.preventDefault(); redo(); } else if (mod && k === 's') { e.preventDefault(); save(); }
      else if (!mod && !e.altKey) {
        const t = TOOLS.find((x) => x[2].toLowerCase() === k); if (t) setTool(t[0]);
        else if (k === 'm') $('.pf-mx').click(); else if (k === '+' || k === '=') $('.pf-zin').click(); else if (k === '-') $('.pf-zout').click(); else if (k === '0') $('.pf-fit').click(); else if (k === '#') $('.pf-grid').click();
        else if (k === ' ') { space = true; e.preventDefault(); }
      }
    }
    const keyup = (e) => { if (e.key === ' ') space = false; };
    document.addEventListener('keydown', keydown); document.addEventListener('keyup', keyup);
    const leaveGuard = (e) => { if ([...S.docs.values()].some((d) => d.unsaved && d.changed)) { e.preventDefault(); e.returnValue = ''; } }; /* unsaved work would be lost: ask first */
    window.addEventListener('beforeunload', leaveGuard);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { const had = doc(); resizeView(); if (had && !S.touched) fit(); render(); }) : null; if (ro) ro.observe(stage);
    resizeView(); renderAuth(); init();

    const ctrl = {
      get docs() { return S.docs; }, get current() { return doc(); }, open: openSprite, save, setColor, setTool, undo, redo, state: S,
      dispose() { document.removeEventListener('keydown', keydown); document.removeEventListener('keyup', keyup); window.removeEventListener('beforeunload', leaveGuard); if (ro) ro.disconnect(); clearInterval(S.anim.timer); host.innerHTML = ''; delete host.__pf; },
    };
    host.__pf = ctrl;
    return ctrl;
  }

  return { mount, createPullRequest, prBody, png: { decode: decodePngBytes, encode: encodePngBytes }, auth: { signIn: githubSignIn, refresh: githubRefresh, user: githubUser, listRepos, explainError: explainGithubError, tokenUrl: PAT_URL }, sources: { githubSource, folderSource, staticSource, serverSource, applyConfig }, core: { pack, unpack, toHex, fromHex, parsePalette, nearestColor, linePoints, rectPoints, floodFill, colorsOf, flipH, flipV, rotateCW, shiftWrap, resizePx, countDiff, Doc } };
});
