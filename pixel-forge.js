/* pixel-forge: a small pixel art editor with no dependencies and no build step.
   Drop this one file into any project (or open the bundled index.html through `pixel-forge serve`), call PixelForge.mount(element, options),
   and it lists the project's PNG sprites, lets you edit them, saves them back, and can propose the change as a GitHub pull request.
   https://developer.mozilla.org/en-US/docs/Web/API/ImageData is the only "API" it leans on, plus fetch and canvas. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PixelForge = api;
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
  async function createPullRequest(o) {
    const api = (o.apiBase || 'https://api.github.com').replace(/\/$/, ''), doFetch = o.fetch || fetch.bind(globalThis), log = o.onProgress || (() => {});
    const call = async (method, url, body) => {
      const res = await doFetch(api + url, { method, headers: { Authorization: 'Bearer ' + o.token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
      if (!res.ok) { const e = new Error(`GitHub ${method} ${url} failed: ${res.status} ${(json && json.message) || text.slice(0, 120)}`); e.status = res.status; throw e; }
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
    const baseRef = await call('GET', '/repos/' + o.repo + '/git/ref/heads/' + encodeURIComponent(base));
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
    return `${o.description ? o.description + '\n\n' : ''}| Sprite | Size | Pixels changed |\n| --- | --- | --- |\n${rows}\n${imgs ? '\n' + imgs + '\n' : ''}\n_Proposed with pixel-forge. GitHub shows PNG changes in the "Files changed" tab with 2-up, swipe and onion-skin views._`;
  }

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
.pf dialog{background:var(--pf-panel);color:var(--pf-ink);border:1px solid var(--pf-accent);padding:16px;width:min(560px,94vw);max-height:92vh;overflow:auto}
.pf dialog::backdrop{background:rgba(0,0,0,.7)}
.pf-form{display:flex;flex-direction:column;gap:10px}.pf-log{white-space:pre-wrap;color:var(--pf-muted);max-height:140px;overflow:auto;border:1px solid var(--pf-line);padding:6px;min-height:34px}
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
      <aside class="pf-side"><div><h4>Sprites</h4><input type="text" class="pf-q" placeholder="filter…" aria-label="Filter sprites"></div>
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
        <label>Repository <input type="text" class="pf-pr-repo" placeholder="owner/name"></label>
        <label>Base branch <input type="text" class="pf-pr-base" placeholder="default branch"></label>
        <label>Title <input type="text" class="pf-pr-title" placeholder="Update player sprite"></label>
        <label>Description <textarea class="pf-pr-desc" rows="3" style="width:100%" placeholder="What changed and why"></textarea></label>
        <label>GitHub token <input type="password" class="pf-pr-token" autocomplete="off" placeholder="fine-grained token with Contents + Pull requests write"></label>
        <label><input type="checkbox" class="pf-pr-remember"> remember the token in this browser</label>
        <div class="pf-note">The token is only sent to GitHub. Without write access to the repository your fork is used automatically.</div>
        <div class="pf-log" aria-live="polite"></div>
        <div class="pf-row"><button type="button" class="primary pf-pr-go">Create pull request</button><button value="cancel">Close</button></div></form></dialog>
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

    /* ---------- state ---------- */
    const S = { sprites: [], docs: new Map(), cur: null, tool: 'pen', color: pack(57, 255, 122), mx: false, my: false, pp: true, grid: true, zoom: 8, ox: 0, oy: 0,
      palette: O.palette ? O.palette.map((c) => (typeof c === 'string' ? fromHex(c) : c)).filter((c) => c != null) : [], server: null, meta: {}, dir: null, anim: { timer: 0, t: 0 }, notice: '' };
    const doc = () => S.docs.get(S.cur);
    const view = $('.pf-view'), stage = $('.pf-stage'), g = view.getContext('2d');
    const offscreen = document.createElement('canvas');
    let overlay = null; // preview pixels while dragging a shape: { pts, value }
    const note = (t) => { S.notice = t; status(); };

    /* ---------- loading ---------- */
    const urlFor = (path) => { const b = S.server ? 'project/' : (O.baseUrl != null ? O.baseUrl : (S.meta.base || '')); return (b && !b.endsWith('/') ? b + '/' : b) + path.split('/').map(encodeURIComponent).join('/'); };
    async function fetchJson(u) { const r = await fetch(u); if (!r.ok) throw new Error(u + ': ' + r.status); return r.json(); }
    async function init() {
      let mf = null;
      try {
        if (O.sprites) mf = { sprites: O.sprites, palette: O.paletteList || null, repo: O.github || null };
        else if (O.manifestUrl) mf = await fetchJson(O.manifestUrl);
        else { try { mf = await fetchJson('api/manifest'); S.server = true; } catch { mf = await fetchJson('pixel-art.json'); } }
      } catch (e) { mf = { sprites: [] }; note('No sprite list found (' + e.message + '). Open PNG files to start.'); }
      S.meta = mf; S.sprites = (mf.sprites || []).map((s) => ({ ...s }));
      if (S.server === null || S.server === undefined) S.server = false;
      if (S.server) { const m = document.querySelector('meta[name="pf-token"]'); S.token = m ? m.content : ''; }
      if (mf.palette && !S.palette.length) S.palette = mf.palette.map((h) => (typeof h === 'string' ? fromHex(h) : h)).filter((c) => c != null);
      if (O.github) S.meta.repo = Object.assign({}, S.meta.repo || {}, O.github);
      $('.pf-src').textContent = S.server ? 'Saving writes straight to the project folder.' : 'Static mode: Save downloads the PNG' + ('showDirectoryPicker' in window ? ' (or writes to a folder you pick).' : '.');
      renderList(); renderPalette();
      if (S.sprites.length) openSprite(S.sprites[0].path);
      else { status(); render(); }
    }
    async function openSprite(path) {
      if (!S.docs.has(path)) {
        const meta = S.sprites.find((s) => s.path === path);
        try {
          const r = await fetch(urlFor(path)); if (!r.ok) throw new Error(r.status);
          const img = await decodePng(await r.blob());
          S.docs.set(path, new Doc(path, img.w, img.h, img.px, { frames: meta && meta.frames }));
        } catch (e) { note('Could not open ' + path + ': ' + e.message); return; }
      }
      S.cur = path; S.touched = false; const d = doc(); loadFrames(d); fit(); renderList(); renderColors(); status(); render(); drawPreview();
    }
    /** Add an image that is not in the manifest. inProject = Save should write it to that path in the project (needs the local server). */
    function addLocal(name, w, h, px, inProject) {
      let path = name, n = 1; while (S.docs.has(path)) path = name.replace(/(\.png)?$/i, '') + '-' + (++n) + '.png';
      S.docs.set(path, new Doc(path, w, h, px, { local: !inProject })); S.sprites.push({ path, w, h, local: !inProject }); return openSprite(path);
    }

    /* ---------- list ---------- */
    const thumbs = new Map();
    function renderList() {
      const q = $('.pf-q').value.toLowerCase(), list = $('.pf-list'); list.innerHTML = '';
      for (const s of S.sprites.filter((x) => x.path.toLowerCase().includes(q))) {
        const d = S.docs.get(s.path), b = el(`<button class="pf-item${s.path === S.cur ? ' on' : ''}" role="option" data-path="${esc(s.path)}"><canvas width="${s.w || 16}" height="${s.h || 16}"></canvas><span class="n">${esc(s.path.split('/').pop())}<small>${esc(s.path.split('/').slice(0, -1).join('/') || '.')} · ${d ? d.w + '×' + d.h : (s.w || '?') + '×' + (s.h || '?')}</small></span>${d && d.unsaved ? '<i class="dot" title="unsaved"></i>' : d && d.changed ? '<i class="dot base" title="saved, not yet proposed"></i>' : ''}</button>`);
        list.appendChild(b); paintThumb(b.querySelector('canvas'), s);
      }
    }
    async function paintThumb(canvas, s) {
      const d = S.docs.get(s.path);
      if (d) return drawPx(canvas, d);
      try {
        let bm = thumbs.get(s.path);
        if (!bm) { const r = await fetch(urlFor(s.path)); bm = await createImageBitmap(await r.blob()); thumbs.set(s.path, bm); }
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
    async function pngOf(d, scale = 1) { const c = document.createElement('canvas'); drawPx(c, d, scale); return toBlob(c); }
    async function save() {
      const d = doc(); if (!d) return;
      try {
        const blob = await pngOf(d);
        if (O.save) await O.save(d, blob);
        else if (S.server && !d.local) {
          const r = await fetch('project/' + d.path.split('/').map(encodeURIComponent).join('/'), { method: 'PUT', headers: { 'x-pixel-forge': S.token || '', 'content-type': 'image/png' }, body: blob });
          if (!r.ok) throw new Error('server said ' + r.status + ' ' + (await r.text()).slice(0, 80));
        } else if (S.dir) { await writeToDir(d.path, blob); }
        else if (!d.local && 'showDirectoryPicker' in window && O.pickFolder !== false && confirm('Pick the project folder so Save can write the file in place? Cancel to download instead.')) { S.dir = await window.showDirectoryPicker({ mode: 'readwrite' }); await writeToDir(d.path, blob); }
        else download(blob, d.path.split('/').pop());
        d.markSaved(); note('saved ' + d.path); changedUi();
      } catch (e) { note('Save failed: ' + e.message); }
    }
    async function writeToDir(path, blob) {
      const parts = path.split('/'); let dir = S.dir; for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
      const f = await dir.getFileHandle(parts[parts.length - 1], { create: true }), w = await f.createWritable(); await w.write(blob); await w.close();
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
      try { $('.pf-pr-token').value = $('.pf-pr-token').value || sessionStorage.getItem('pf:token') || localStorage.getItem('pf:token') || ''; } catch { /* storage blocked */ }
      $('.pf-chg-list').innerHTML = changed.map((d) => `<div class="pf-chg"><canvas data-p="${esc(d.path)}"></canvas><span>${esc(d.path)}<br><span class="pf-note">${d.w}×${d.h} · ${d.changedPixels()} px changed</span></span></div>`).join('');
      $$('.pf-chg canvas').forEach((c) => drawPx(c, S.docs.get(c.dataset.p)));
      $('.pf-log').textContent = ''; dlg.showModal();
    }
    async function submitPr() {
      const changed = [...S.docs.values()].filter((d) => d.changed), log = $('.pf-log'), go = $('.pf-pr-go');
      const token = $('.pf-pr-token').value.trim(), repo = $('.pf-pr-repo').value.trim(), title = $('.pf-pr-title').value.trim() || 'Update sprites';
      try { if ($('.pf-pr-remember').checked) localStorage.setItem('pf:token', token); else sessionStorage.setItem('pf:token', token); } catch { /* ignore */ }
      go.disabled = true; log.textContent = '';
      try {
        const files = []; for (const d of changed) files.push({ path: d.path, blob: await pngOf(d), w: d.w, h: d.h, pixels: d.changedPixels() });
        const prefix = (S.meta.repo && S.meta.repo.prefix) || '';
        const res = await createPullRequest({ token, repo, base: $('.pf-pr-base').value.trim() || undefined, prefix, title, apiBase: O.apiBase, files: files.map((f) => ({ path: f.path, blob: f.blob })), branch: 'art/' + slug(title) + '-' + Date.now().toString(36),
          body: (ctx) => prBody({ files, repo, prefix, description: $('.pf-pr-desc').value.trim(), baseSha: ctx.baseSha, commit: ctx.commit, headRepo: ctx.headRepo }), onProgress: (m) => { log.textContent += m + '\n'; log.scrollTop = log.scrollHeight; } });
        log.innerHTML = `${esc(log.textContent)}Done${res.forked ? ' (from your fork)' : ''}: <a href="${esc(res.url)}" target="_blank" rel="noopener" style="color:var(--pf-accent)">${esc(res.url)}</a>`;
        for (const d of changed) d.base = { w: d.w, h: d.h, px: d.px.slice() };
        status(); renderList();
      } catch (e) { log.textContent += '\n' + e.message; } finally { go.disabled = false; }
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
    $('.pf-new-ok').onclick = () => { const w = Math.max(1, Math.min(1024, +$('.pf-nw').value | 0)), h = Math.max(1, Math.min(1024, +$('.pf-nh').value | 0)); let n = $('.pf-nn').value.trim().replace(/^\/+/, '') || 'new-sprite.png'; if (!/\.png$/i.test(n)) n += '.png'; $('.pf-dlg-new').close(); addLocal(n, w, h, new Uint32Array(w * h), !!S.server); };
    $('.pf-open').onclick = () => $('.pf-file').click();
    $('.pf-file').onchange = async (e) => { for (const f of e.target.files) await importFile(f); e.target.value = ''; };
    async function importFile(f) { try { const img = await decodePng(f); addLocal(f.name, img.w, img.h, img.px); } catch (err) { note('Could not read ' + f.name + ': ' + err.message); } }
    stage.addEventListener('dragover', (e) => e.preventDefault());
    stage.addEventListener('drop', async (e) => { e.preventDefault(); for (const f of e.dataTransfer.files) if (/^image\//.test(f.type)) await importFile(f); });
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
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { const had = doc(); resizeView(); if (had && !S.touched) fit(); render(); }) : null; if (ro) ro.observe(stage);
    resizeView(); init();

    const ctrl = {
      get docs() { return S.docs; }, get current() { return doc(); }, open: openSprite, save, setColor, setTool, undo, redo, state: S,
      dispose() { document.removeEventListener('keydown', keydown); document.removeEventListener('keyup', keyup); if (ro) ro.disconnect(); clearInterval(S.anim.timer); host.innerHTML = ''; delete host.__pf; },
    };
    host.__pf = ctrl;
    return ctrl;
  }

  return { mount, createPullRequest, prBody, core: { pack, unpack, toHex, fromHex, parsePalette, nearestColor, linePoints, rectPoints, floodFill, colorsOf, flipH, flipV, rotateCW, shiftWrap, resizePx, countDiff, Doc } };
});
