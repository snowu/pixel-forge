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

  /** The pixels of an ellipse inside the box between two corners. Filled = every pixel centre inside; outline = the filled
      pixels that touch the outside on a side (a clean 1-pixel, 8-connected ring, symmetric like hand-placed pixel art). */
  function ellipsePoints(x0, y0, x1, y1, filled) {
    const ax = Math.min(x0, x1), bx = Math.max(x0, x1), ay = Math.min(y0, y1), by = Math.max(y0, y1), w = bx - ax + 1, h = by - ay + 1;
    const cx = (w - 1) / 2, cy = (h - 1) / 2, rx = w / 2, ry = h / 2, inside = new Uint8Array(w * h), pts = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1.0001) inside[y * w + x] = 1;
    const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && inside[y * w + x];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inside[y * w + x] && (filled || !at(x - 1, y) || !at(x + 1, y) || !at(x, y - 1) || !at(x, y + 1))) pts.push([ax + x, ay + y]);
    return pts;
  }
  /** Offsets of a brush tip of the given size: 'square' or 'round'. Size 1 is a single pixel; even sizes lean up-left. */
  function brushOffsets(size, shape) {
    const s = Math.max(1, Math.min(32, size | 0)), lo = 0 - Math.floor((s - 1) / 2) || 0, out = [], c = (s - 1) / 2 + lo, r = s / 2;
    for (let y = lo; y < lo + s; y++) for (let x = lo; x < lo + s; x++) if (shape !== 'round' || s <= 2 || (x - c) ** 2 + (y - c) ** 2 <= r * r - 0.5) out.push([x, y]);
    return out;
  }
  /** The checkerboard used by the dither pattern: true on the pixels it paints. */
  const ditherOn = (x, y, phase = 0) => ((x + y + phase) & 1) === 0;
  /** Replace every pixel of one colour (fully clear pixels count as one colour). Returns the indices changed. */
  function fillSame(px, x, y, w, value) {
    const t = px[y * w + x], clear = isClear(t), changed = [];
    if (t === value) return changed;
    for (let i = 0; i < px.length; i++) if (clear ? isClear(px[i]) : px[i] === t) { px[i] = value; changed.push(i); }
    return changed;
  }
  /** Outline: every clear pixel next to an opaque one gets the colour. corners = also diagonal neighbours (a thicker, rounder line). */
  function outlinePx(px, w, h, color, corners) {
    const o = px.slice(), solid = (x, y) => x >= 0 && y >= 0 && x < w && y < h && !isClear(px[y * w + x]);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!isClear(px[y * w + x])) continue;
      if (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1) || (corners && (solid(x - 1, y - 1) || solid(x + 1, y - 1) || solid(x - 1, y + 1) || solid(x + 1, y + 1)))) o[y * w + x] = color;
    }
    return o;
  }
  /* HSV helpers for ramps and shading. h in degrees, s and v in 0..1. */
  function toHsv(c) {
    const [r, g, b] = unpack(c).map((v) => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0; if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [(h * 60 + 360) % 360, mx ? d / mx : 0, mx];
  }
  function fromHsv(h, s, v, a = 255) {
    h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(1, s)); v = Math.max(0, Math.min(1, v));
    const f = (n) => { const k = (n + h / 60) % 6; return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255); };
    return pack(f(5), f(3), f(1), a);
  }
  /** Move hue `amt` degrees toward `target` along the shorter way round the colour wheel. */
  const hueToward = (h, target, amt) => { const d = ((target - h + 540) % 360) - 180; return h + Math.sign(d) * Math.min(Math.abs(d), amt); };
  /** One step lighter (dir > 0) or darker (dir < 0), the pixel-art way: shadows drift toward blue and lose a little
      saturation, highlights drift toward yellow. With a palette, the result snaps to the nearest palette colour that differs. */
  function shadeColor(c, dir, palette) {
    if (isClear(c)) return c;
    let [h, s, v] = toHsv(c), out = c;
    for (let step = 1; step <= 6; step++) {
      const t = 0.1 * step, nh = s < 0.05 ? h : hueToward(h, dir > 0 ? 60 : 240, 12 * step);
      const cand = fromHsv(nh, s < 0.05 ? s : dir > 0 ? s - 0.06 * step : s + 0.04 * step, dir > 0 ? v + t : v - t, c >>> 24);
      out = palette && palette.length ? nearestColor(cand, palette) : cand;
      if (out !== c) return out;
    }
    return out;
  }
  /** Shift a colour's hue (degrees), saturation and brightness (-1..1, relative). keepDark leaves near-black (outlines) alone. */
  function shiftColor(c, dh, ds, dv, keepDark) {
    if (isClear(c)) return c;
    const [h, s, v] = toHsv(c);
    if (keepDark && v < 0.16) return c;
    return fromHsv(h + dh, ds >= 0 ? s + (1 - s) * ds : s * (1 + ds), dv >= 0 ? v + (1 - v) * dv : v * (1 + dv), c >>> 24);
  }
  /** The name of a family member's variant: king_atk.png + "dark" (family "king") → king_dark_atk.png. */
  const variantPath = (path, key, suffix) => { const i = path.lastIndexOf('/') + 1, file = path.slice(i); return path.slice(0, i) + key + '_' + suffix + file.slice(key.length); };
  /** A ramp of n colours around c, darkest first, with hue shifting (cool shadows, warm highlights). */
  function hueRamp(c, n = 5) {
    const [h, s, v] = toHsv(c), mid = (n - 1) / 2, out = [];
    for (let i = 0; i < n; i++) {
      const k = (i - mid) / Math.max(1, mid); // -1 darkest .. 1 lightest
      out.push(i === Math.round(mid) && n % 2 ? c : fromHsv(s < 0.05 ? h : hueToward(h, k > 0 ? 60 : 240, Math.abs(k) * 30), s < 0.05 ? s : s * (1 - 0.25 * k) + (k < 0 ? 0.1 * -k : 0), v + k * (k > 0 ? Math.min(0.35, 1 - v + 0.1) : Math.min(0.45, v - 0.08))));
    }
    return out;
  }
  /** An animated GIF (looping, 1-bit transparency) from frames [{ w, h, px: Uint32Array }]. Frames of different sizes share
      the largest canvas, bottom-centred so feet line up. Up to 255 colours are exact; beyond that the rarest colours map to
      the nearest kept one. delay is in hundredths of a second; scale blows pixels up (nearest neighbour). */
  function encodeGif(frames, { delay = 12, scale = 1 } = {}) {
    const W = Math.max(...frames.map((f) => f.w)) * scale, H = Math.max(...frames.map((f) => f.h)) * scale, count = new Map();
    for (const f of frames) for (const c of f.px) if (c >>> 24 >= 128) { const k = c & 0xffffff; count.set(k, (count.get(k) || 0) + 1); }
    const kept = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 255).map(([k]) => k), index = new Map(kept.map((k, i) => [k, i + 1]));
    const lookup = (k) => { let i = index.get(k); if (i == null) { let best = 1, bd = Infinity; kept.forEach((q, j) => { const d = ((q & 255) - (k & 255)) ** 2 + (((q >> 8) & 255) - ((k >> 8) & 255)) ** 2 + (((q >> 16) & 255) - ((k >> 16) & 255)) ** 2; if (d < bd) { bd = d; best = j + 1; } }); index.set(k, (i = best)); } return i; };
    let bits = 1; while ((1 << bits) < kept.length + 1) bits++;
    const out = [], u16 = (v) => out.push(v & 255, (v >> 8) & 255), str = (t) => { for (const ch of t) out.push(ch.charCodeAt(0)); };
    str('GIF89a'); u16(W); u16(H); out.push(0x80 | 0x70 | (bits - 1), 0, 0);
    for (let i = 0; i < 1 << bits; i++) { const k = i ? kept[i - 1] || 0 : 0; out.push(k & 255, (k >> 8) & 255, (k >> 16) & 255); }
    out.push(0x21, 0xff, 11); str('NETSCAPE2.0'); out.push(3, 1, 0, 0, 0); // loop forever
    const min = Math.max(2, bits);
    for (const f of frames) {
      const ox = Math.floor((W / scale - f.w) / 2), oy = H / scale - f.h, idx = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const sx = Math.floor(x / scale) - ox, sy = Math.floor(y / scale) - oy; if (sx < 0 || sy < 0 || sx >= f.w || sy >= f.h) continue; const c = f.px[sy * f.w + sx]; if (c >>> 24 >= 128) idx[y * W + x] = lookup(c & 0xffffff); }
      out.push(0x21, 0xf9, 4, (2 << 2) | 1); u16(delay); out.push(0, 0); // restore to background, index 0 is transparent
      out.push(0x2c); u16(0); u16(0); u16(W); u16(H); out.push(0, min);
      const data = gifLzw(idx, min); for (let i = 0; i < data.length; i += 255) { const n = Math.min(255, data.length - i); out.push(n); for (let j = 0; j < n; j++) out.push(data[i + j]); }
      out.push(0);
    }
    out.push(0x3b);
    return new Uint8Array(out);
  }
  function gifLzw(indices, min) {
    const clear = 1 << min, eoi = clear + 1, out = [], dict = new Map();
    let size = min + 1, next = eoi + 1, acc = 0, nbits = 0;
    const emit = (code) => { acc |= code << nbits; nbits += size; while (nbits >= 8) { out.push(acc & 255); acc >>>= 8; nbits -= 8; } };
    emit(clear);
    let cur = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i], key = (cur << 8) | k, hit = dict.get(key);
      if (hit !== undefined) { cur = hit; continue; }
      emit(cur);
      if (next === 4096) { emit(clear); dict.clear(); next = eoi + 1; size = min + 1; }
      else { if (next >= 1 << size) size++; dict.set(key, next++); }
      cur = k;
    }
    emit(cur); emit(eoi); if (nbits) out.push(acc & 255);
    return out;
  }
  /** Copy a rectangle {x,y,w,h} out of an image; parts outside the image come back clear. */
  function copyRect(px, w, h, r) {
    const o = new Uint32Array(r.w * r.h);
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) { const X = r.x + x, Y = r.y + y; if (X >= 0 && Y >= 0 && X < w && Y < h) o[y * r.w + x] = px[Y * w + X]; }
    return o;
  }
  /** Paste src (sw x sh) at (x,y). Clear source pixels leave what is underneath (like placing a sprite), unless opaque is true. */
  function pasteRect(px, w, h, src, sw, sh, x, y, opaque) {
    for (let j = 0; j < sh; j++) for (let i = 0; i < sw; i++) { const X = x + i, Y = y + j, v = src[j * sw + i]; if (X >= 0 && Y >= 0 && X < w && Y < h && (opaque || !isClear(v))) px[Y * w + X] = v; }
    return px;
  }
  /** Normalise a drag between two cells into a rectangle clipped to the image (null when it misses the image). */
  function rectBetween(a, b, w, h) {
    const x0 = Math.max(0, Math.min(a.x, b.x)), y0 = Math.max(0, Math.min(a.y, b.y)), x1 = Math.min(w - 1, Math.max(a.x, b.x)), y1 = Math.min(h - 1, Math.max(a.y, b.y));
    return x1 < x0 || y1 < y0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }
  /** Shift-constrain the second corner so the box is square (shapes) or the line snaps to 0/45/90 degrees. */
  function constrain(a, b, mode) {
    const dx = b.x - a.x, dy = b.y - a.y, m = Math.max(Math.abs(dx), Math.abs(dy));
    if (mode === 'line') { const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4); return { x: a.x + Math.round(Math.cos(ang) * m), y: a.y + Math.round(Math.sin(ang) * m) }; }
    return { x: a.x + Math.sign(dx || 1) * m, y: a.y + Math.sign(dy || 1) * m };
  }

  /* =====================================================================================================
     A document is one image being edited, with undo history.
     base    = the pixels when this session loaded it (what a pull request is measured against)
     saved   = the pixels at the last save (what "unsaved changes" is measured against)
     ===================================================================================================== */
  class Doc {
    constructor(path, w, h, px, extra = {}) {
      this.path = path; this.w = w; this.h = h; this.px = px;
      this.base = { w, h, px: px.slice() }; this.saved = { w, h, px: px.slice() };
      this.undo = []; this.redo = []; this.local = !!extra.local; this.frames = extra.frames || null; this.isNew = !!extra.isNew;
      if (this.isNew) this.base = { w, h, px: new Uint32Array(w * h) }; // a new file: every pixel counts as a change
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
    const upload = async (data) => {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer());
      let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return (await call('POST', '/repos/' + headRepo + '/git/blobs', { content: btoa(bin), encoding: 'base64' })).sha;
    };
    const tree = [];
    for (const f of o.files) {
      log('Uploading ' + f.path + '…');
      tree.push({ path: (o.prefix || '') + f.path, mode: '100644', type: 'blob', sha: await upload(f.blob) });
    }
    const branch = o.branch || 'art/update-' + Date.now().toString(36);
    /* Upscaled previews for the description (GitHub smooths small images it scales up; these need no scaling).
       Preferred: a commit on no branch kept alive by a hidden ref, so they never touch the pull request at all.
       If the token may not create that ref (some GitHub App setups), they go in a commit under the change instead, which the
       change itself deletes again: the pull request's files are still only the sprites. */
    let previewSha = null, previewDir = '', parent = baseSha;
    if (o.previews && o.previews.length) {
      try {
        log('Uploading previews…');
        const ptree = [];
        for (const [i, p] of o.previews.entries()) for (const side of ['before', 'after']) if (p[side]) ptree.push({ name: `${i}-${side}.png`, sha: await upload(p[side]) });
        const entry = (dir) => ptree.map((t) => ({ path: dir + t.name, mode: '100644', type: 'blob', sha: t.sha }));
        try {
          const pt = await call('POST', '/repos/' + headRepo + '/git/trees', { tree: entry('') });
          const pc = await call('POST', '/repos/' + headRepo + '/git/commits', { message: 'spritewright: previews for the pull request description (on no branch)', tree: pt.sha, parents: [] });
          await call('POST', '/repos/' + headRepo + '/git/refs', { ref: 'refs/spritewright/previews/' + branch, sha: pc.sha });
          previewSha = pc.sha;
        } catch {
          previewDir = '.spritewright-previews/';
          const pt = await call('POST', '/repos/' + headRepo + '/git/trees', { base_tree: baseCommit.tree.sha, tree: entry(previewDir) });
          const pc = await call('POST', '/repos/' + headRepo + '/git/commits', { message: 'spritewright: previews for the pull request description (removed by the next commit)', tree: pt.sha, parents: [baseSha] });
          previewSha = pc.sha; parent = pc.sha;
        }
      } catch (e) { previewSha = null; previewDir = ''; parent = baseSha; log('Previews skipped (' + e.message + '); the description links the files instead.'); }
    }
    log('Creating the commit…');
    const newTree = await call('POST', '/repos/' + headRepo + '/git/trees', { base_tree: baseCommit.tree.sha, tree });
    const commit = await call('POST', '/repos/' + headRepo + '/git/commits', { message: o.message || o.title, tree: newTree.sha, parents: [parent] });
    await call('POST', '/repos/' + headRepo + '/git/refs', { ref: 'refs/heads/' + branch, sha: commit.sha });
    log('Opening the pull request…');
    const pr = await call('POST', '/repos/' + o.repo + '/pulls', { title: o.title, body: typeof o.body === 'function' ? o.body({ baseSha, commit: commit.sha, headRepo, previewSha, previewDir }) : (o.body || ''), head: headOwner ? headOwner + ':' + branch : branch, base, maintainer_can_modify: true });
    return { url: pr.html_url, number: pr.number, branch, forked: !!headOwner, commit: commit.sha, headRepo, previewSha, previewDir };
  }
  /** How much to blow a sprite up for the pull request description: about 256 px on the long side, 1× to 16×. */
  const previewScale = (w, h) => Math.max(1, Math.min(16, Math.floor(256 / Math.max(w, h, 1))));
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'art';

  /** Markdown for the pull request body: what changed and how much, with before/after links when the repo is public. */
  function prBody(o) {
    const rows = o.files.map((f) => `| \`${f.path}\` | ${f.w}×${f.h} | ${f.pixels} |`).join('\n');
    const raw = (repo, sha, file) => `https://raw.githubusercontent.com/${repo}/${sha}/${file}`;
    const imgs = o.files.map((f, i) => {
      if (o.previewSha) { // pre-scaled, nearest-neighbour copies shown at their real size, so GitHub never smooths them
        const sc = f.scale || 1, wpx = f.w * sc, bw = (f.baseW || f.w) * sc, prev = (side) => raw(o.headRepo || o.repo, o.previewSha, `${o.previewDir || ''}${i}-${side}.png`);
        return `**${f.path}** (shown ${sc}×)\n\nBefore | After\n--- | ---\n${f.isNew ? '_new file_' : `<img src="${prev('before')}" width="${bw}">`} | <img src="${prev('after')}" width="${wpx}">`;
      }
      return o.repo && o.baseSha && o.commit ? `**${f.path}**\n\nBefore | After\n--- | ---\n<img src="${raw(o.repo, o.baseSha, (o.prefix || '') + f.path)}" width="128"> | <img src="${raw(o.headRepo || o.repo, o.commit, (o.prefix || '') + f.path)}" width="128">` : '';
    }).filter(Boolean).join('\n\n');
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
    if (!cfg.dirs && !cfg.exclude && !cfg.keepDocs) items = skipNonArt(items);
    const dirs = (cfg.dirs && cfg.dirs.length ? cfg.dirs : ['']).map((d) => (d === '.' ? '' : d.replace(/\/+$/, '')));
    const ign = new Set([...IGNORE, ...(cfg.ignore || [])]), exc = (cfg.exclude || []).map(globRe);
    return items.filter((it) => {
      const parts = it.path.split('/');
      if (parts.slice(0, -1).some((x) => ign.has(x))) return false;
      if (!dirs.some((d) => !d || it.path === d || it.path.startsWith(d + '/'))) return false;
      return !exc.some((r) => r.test(it.path));
    }).map((it) => { const fr = cfg.frames && (cfg.frames[it.path] || Object.entries(cfg.frames).find(([k]) => k.includes('*') && globRe(k).test(it.path))?.[1]); return fr ? { ...it, frames: fr } : it; });
  }

  /* =====================================================================================================
     Families: games name related images alike (archer_0, archer_atk, archer_block; flame_0, flame_1, flame_2;
     floor_crypt, floor_crypt_grave). Grouping by the longest shared name prefix (cut at _ or -) folds a folder of hundreds
     of files into a short list, and a family with numbered members is an animation.
     ===================================================================================================== */
  const NON_ART = /^(docs?|documentation|screenshots?|previews?|tests?|e2e|coverage|examples?|samples?|marketing|promo|store)$/i;
  const stem = (p) => p.split('/').pop().replace(/\.png$/i, '');
  /** Group sprite paths: [{ dir, families: [{ key, members: [path], animated }] }], folders and families in name order. */
  function groupSprites(paths) {
    const byDir = new Map();
    for (const p of paths) { const d = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''; if (!byDir.has(d)) byDir.set(d, []); byDir.get(d).push(p); }
    const out = [];
    for (const [dir, list] of [...byDir.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const names = list.map(stem), fam = new Map();
      list.forEach((p, i) => {
        const n = names[i], cuts = [n]; for (let k = n.length - 1; k > 0; k--) if (n[k] === '_' || n[k] === '-') cuts.push(n.slice(0, k));
        // a real family has a base image (floor_crypt.png next to floor_crypt_grave.png) or numbered members (archer_0, flame_1);
        // a shared prefix alone (ic_gem, ic_ring) is just a naming category, not a family
        const key = cuts.find((c) => { const m = names.filter((x) => x === c || x.startsWith(c + '_') || x.startsWith(c + '-')); return m.length >= 2 && (names.includes(c) || m.some((x) => /^[_-]\d+$/.test(x.slice(c.length)))); }) || n;
        if (!fam.has(key)) fam.set(key, []); fam.get(key).push(p);
      });
      const rank = (key, p) => { const rest = stem(p).slice(key.length).replace(/^[_-]/, ''); return rest === '' ? [0, 0, ''] : /^\d+$/.test(rest) ? [1, +rest, ''] : [2, 0, rest]; };
      const families = [...fam.entries()].map(([key, members]) => {
        members.sort((a, b) => { const x = rank(key, a), y = rank(key, b); return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]); });
        // an animation is a run of numbered frames: 0,1,2 or 1,2,3 (icon-192 / icon-512 are sizes, not frames)
        const nums = members.map((p) => rank(key, p)).filter((r) => r[0] === 1).map((r) => r[1]);
        return { key, members, animated: nums.length >= 2 && nums[0] <= 1 && nums.every((v, i) => !i || v === nums[i - 1] + 1) };
      }).sort((a, b) => a.key.localeCompare(b.key));
      out.push({ dir, families });
    }
    return out;
  }
  /** With no project config, leave out folders that are clearly not game art (docs, screenshots, previews, tests...). */
  const skipNonArt = (items) => items.filter((it) => !it.path.split('/').slice(0, -1).some((seg) => NON_ART.test(seg)));
  /** What applyConfig left out only because of that default, so the editor can offer "show N hidden images". */
  const hiddenBy = (items, cfg, kept) => { const k = new Set(kept.map((x) => x.path)); return applyConfig(items, { ...cfg, keepDocs: true }).filter((x) => !k.has(x.path)); };

  /** Sprites listed in a manifest and fetched over HTTP relative to baseUrl. Read-only (Save downloads). */
  function staticSource(mf, baseUrl) {
    const base = baseUrl == null ? '' : baseUrl && !baseUrl.endsWith('/') ? baseUrl + '/' : baseUrl;
    return { kind: 'static', thumbs: true, note: 'Static mode: Save downloads the PNG. Connect a folder to save in place.', sprites: (mf.sprites || []).map((x) => ({ ...x })), hidden: mf.hidden || [], background: mf.background || null, repo: mf.repo || null, palette: mf.palette || null,
      async read(path) { const r = await fetch(base + path.split('/').map(encodeURIComponent).join('/')); if (!r.ok) throw new Error(r.status + ' ' + r.statusText); return new Uint8Array(await r.arrayBuffer()); } };
  }
  /** The local `spritewright serve` server: reads and writes the project folder. */
  function serverSource(mf, token) {
    const url = (path) => 'project/' + path.split('/').map(encodeURIComponent).join('/');
    const history = async (path) => { const r = await fetch('api/history?path=' + encodeURIComponent(path)); return r.ok ? r.json() : []; };
    const readAt = async (path, sha) => { const r = await fetch(`api/file-at?path=${encodeURIComponent(path)}&sha=${sha}`); if (!r.ok) throw new Error('not in that commit'); return new Uint8Array(await r.arrayBuffer()); };
    return { kind: 'server', thumbs: true, history, readAt, note: 'Saving writes straight to the project folder.', sprites: (mf.sprites || []).map((x) => ({ ...x })), hidden: mf.hidden || [], background: mf.background || null, repo: mf.repo || null, palette: mf.palette || null,
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
    const apiBlob = async (path) => { const e = entries.get(path); if (!e) throw new Error('not in the repository: ' + path); const b = await call('/repos/' + o.repo + '/git/blobs/' + e.sha); return b.encoding === 'base64' ? b64ToBytes(b.content) : new TextEncoder().encode(b.content); };
    /* Public repositories: read files from GitHub's file CDN at this exact commit. Same bytes, and it does not use up the API
       rate limit (60 calls an hour without sign-in), so every thumbnail can load. Private ones (or a failure) go through the API. */
    const rawBase = o.rawBase || (o.apiBase ? null : 'https://raw.githubusercontent.com');
    const rawUrl = info.private === false && rawBase ? (path) => `${rawBase.replace(/\/$/, '')}/${o.repo}/${ref.object.sha}/${path.split('/').map(encodeURIComponent).join('/')}` : null;
    const blob = async (path) => {
      if (!entries.has(path)) throw new Error('not in the repository: ' + path);
      if (rawUrl) { try { const r = await doFetch(rawUrl(path)); if (r.ok) return new Uint8Array(await r.arrayBuffer()); } catch { /* fall back to the API */ } }
      return apiBlob(path);
    };
    let cfg = {}, palette = null;
    if (entries.has('spritewright.config.json')) { try { cfg = JSON.parse(new TextDecoder().decode(await blob('spritewright.config.json'))); } catch { /* ignore a broken config */ } }
    if (cfg.palette && entries.has(cfg.palette)) { try { palette = palFromText(new TextDecoder().decode(await blob(cfg.palette))); } catch { /* none */ } }
    const png = [...entries.values()].filter((e) => /\.png$/i.test(e.path) && e.size <= (cfg.maxBytes || maxBytes)).map((e) => ({ path: e.path, bytes: e.size }));
    const sprites = applyConfig(png, cfg), hidden = hiddenBy(png, cfg, sprites);
    const history = async (path) => (await call(`/repos/${o.repo}/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(branch)}&per_page=30`)).map((c) => ({ sha: c.sha, date: c.commit.author.date, author: (c.author && c.author.login) || c.commit.author.name, message: c.commit.message.split('\n')[0] }));
    const readAt = async (path, sha) => {
      if (rawUrl) { try { const r = await doFetch(`${rawBase.replace(/\/$/, '')}/${o.repo}/${sha}/${path.split('/').map(encodeURIComponent).join('/')}`); if (r.ok) return new Uint8Array(await r.arrayBuffer()); } catch { /* use the API */ } }
      const f = await call(`/repos/${o.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`); return b64ToBytes(f.content.replace(/\n/g, ''));
    };
    return { kind: 'github', thumbs: true, history, readAt, sprites, hidden, palette, branch, background: cfg.background || null,
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
    const sprites = applyConfig(found, cfg);
    return { kind: 'folder', thumbs: true, sprites, hidden: hiddenBy(found, cfg, sprites), palette, background: cfg.background || null, name: root.name, note: 'Folder "' + root.name + '": Save writes the PNG in place.', repo: { slug, base: (cfg.repo && cfg.repo.base) || null, prefix: (cfg.repo && cfg.repo.prefix) || '' },
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
.pf{--pf-bg:#07040d;--pf-panel:#0e0918;--pf-panel2:#150e24;--pf-line:#2a1b45;--pf-line2:#443070;--pf-ink:#e6dcf7;--pf-muted:#9a86c4;--pf-faint:#6a5890;--pf-accent:#b98cff;--pf-accent2:#e08cff;--pf-on:#12081f;--pf-bad:#ff5470;--pf-good:#7dffb2;--pf-warn:#ffb000;
  --pf-ck1:#1c1530;--pf-ck2:#130e22;--pf-ckbg:repeating-conic-gradient(var(--pf-ck1) 0 25%,var(--pf-ck2) 0 50%) 0 0/8px 8px;
  --pf-mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  position:relative;display:grid;grid-template-columns:220px minmax(0,1fr) 248px;grid-template-rows:minmax(0,1fr);height:100%;min-height:440px;background:var(--pf-bg);color:var(--pf-ink);font:12.5px/1.45 var(--pf-mono);border:1px solid var(--pf-line);box-sizing:border-box;font-variant-ligatures:none}
.pf *{box-sizing:border-box;border-radius:0}
.pf [hidden]{display:none!important}
.pf ::selection{background:var(--pf-accent);color:var(--pf-on)}
.pf button,.pf select,.pf input{font:inherit;color:inherit}
.pf button{background:var(--pf-panel2);border:1px solid var(--pf-line);padding:4px 9px;cursor:pointer;min-height:30px;display:inline-flex;align-items:center;justify-content:center;gap:6px;transition:border-color .12s,color .12s,box-shadow .12s}
.pf button:hover:not(:disabled){border-color:var(--pf-accent);color:var(--pf-accent);box-shadow:0 0 0 1px rgba(185,140,255,.12),0 0 14px rgba(185,140,255,.12)}
.pf button:focus-visible{outline:1px solid var(--pf-accent);outline-offset:1px}
.pf button:disabled{opacity:.35;cursor:default}
.pf button.on,.pf button.primary{background:var(--pf-accent);border-color:var(--pf-accent);color:var(--pf-on);font-weight:700}
.pf button.on:hover:not(:disabled),.pf button.primary:hover:not(:disabled){color:var(--pf-on);background:#cba8ff}
.pf input[type=text],.pf input[type=number],.pf input[type=password],.pf select,.pf textarea{background:#05030a;border:1px solid var(--pf-line);padding:5px 7px;min-height:30px;width:100%;color:var(--pf-ink)}
.pf input:focus,.pf textarea:focus{outline:none;border-color:var(--pf-accent)}
.pf input[type=number]{width:64px}
.pf input[type=range]{accent-color:var(--pf-accent);width:92px}
.pf input[type=checkbox]{accent-color:var(--pf-accent)}
.pf label{display:flex;gap:6px;align-items:center;color:var(--pf-muted)}
.pf kbd{font:inherit;font-size:11px;background:var(--pf-panel2);border:1px solid var(--pf-line2);padding:1px 6px;color:var(--pf-accent);white-space:nowrap}
.pf h4{margin:0 0 8px;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--pf-accent);font-weight:700}
.pf h4::before{content:"// ";color:var(--pf-faint)}
.pf-ic{width:16px;height:16px;flex:none;display:block}
.pf-side,.pf-right{background:var(--pf-panel);overflow:auto;padding:10px;display:flex;flex-direction:column;gap:10px;min-width:0}
.pf-side{border-right:1px solid var(--pf-line)}.pf-right{border-left:1px solid var(--pf-line);gap:0;padding:0}
.pf-panel{padding:12px 12px 14px;border-bottom:1px solid var(--pf-line);display:flex;flex-direction:column;gap:8px}
.pf-list{display:flex;flex-direction:column;gap:2px;overflow:auto;flex:1;min-height:80px}
.pf-item{position:relative;display:flex;gap:8px;align-items:center;padding:4px;border:1px solid transparent;cursor:pointer;background:none;text-align:left;width:100%;min-height:44px;justify-content:flex-start}
.pf .pf-item{background:none;border-color:transparent}.pf .pf-item:hover:not(:disabled){box-shadow:none;background:var(--pf-panel2)}
.pf .pf-item.on,.pf .pf-item.on:hover:not(:disabled){border-color:var(--pf-accent);background:var(--pf-panel2);color:var(--pf-ink);font-weight:400;box-shadow:inset 3px 0 0 var(--pf-accent)}
.pf-item canvas{width:36px;height:36px;image-rendering:pixelated;background:var(--pf-ckbg);flex:none}
.pf-item .n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}.pf-item small{display:block;color:var(--pf-muted);overflow:hidden;text-overflow:ellipsis}
.pf-item .dot{width:8px;height:8px;background:var(--pf-accent);flex:none}.pf-item .dot.base{background:var(--pf-warn)}
.pf-list:not(.pf-flat){display:block}
.pf .pf-dir{display:flex;width:100%;justify-content:flex-start;gap:6px;background:none;border:0;border-bottom:1px solid var(--pf-line);padding:7px 2px 5px;min-height:0;margin-top:6px;color:var(--pf-muted);font-size:11px;letter-spacing:.04em;position:sticky;top:0;z-index:1;background:var(--pf-panel)}
.pf .pf-dir:hover:not(:disabled){box-shadow:none;color:var(--pf-accent)}
.pf-caret{width:10px;color:var(--pf-accent)}.pf-dirname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}.pf-dircount{color:var(--pf-faint);font-size:10.5px}
.pf-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(60px,1fr));gap:4px;padding:6px 0 4px}
.pf .pf-cell{flex-direction:column;gap:3px;padding:5px 3px 4px;min-height:0;position:relative;justify-content:flex-start;border:1px solid transparent}
.pf .pf-cell canvas{width:44px;height:44px;object-fit:contain}
.pf .pf-cell .n{width:100%;text-align:center;font-size:10.5px;line-height:1.25}.pf .pf-cell small{font-size:9.5px;text-align:center;color:var(--pf-faint)}
.pf .pf-cell.on,.pf .pf-cell.on:hover:not(:disabled){box-shadow:inset 0 0 0 1px var(--pf-accent),0 0 12px rgba(185,140,255,.18)}
.pf-fam{display:flex;flex-direction:column;gap:6px}.pf-fam-h{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}.pf-fam-h b{color:var(--pf-ink)}
.pf-fam-strip{display:flex;gap:4px;overflow-x:auto;padding-bottom:2px}
.pf .pf-fam-m{flex-direction:column;gap:2px;padding:3px;min-height:0;flex:none;font-size:9.5px;color:var(--pf-muted);background:var(--pf-bg)}
.pf .pf-fam-m canvas{width:40px;height:40px;image-rendering:pixelated;object-fit:contain;background:var(--pf-ckbg)}
.pf .pf-fam-m.on{border-color:var(--pf-accent);color:var(--pf-accent);background:var(--pf-panel2);font-weight:400}.pf .pf-fam-m.playing{box-shadow:0 0 0 1px var(--pf-accent2)}
.pf .pf-hidden-toggle{width:100%;justify-content:flex-start;text-align:left;white-space:normal;margin:8px 0 4px;font-size:11px;color:var(--pf-muted);border-style:dashed}
.pf-bg-sw{width:14px;height:14px;border:1px solid var(--pf-line2);background:var(--pf-ckbg);flex:none}
.pf-bgmenu{position:absolute;z-index:20;background:var(--pf-panel);border:1px solid var(--pf-line2);box-shadow:0 12px 40px rgba(0,0,0,.55);padding:6px;display:flex;flex-direction:column;gap:2px;min-width:210px}
.pf .pf-bgmenu button{justify-content:flex-start;background:none;border-color:transparent;min-height:30px;width:100%}
.pf .pf-bgmenu button.on{background:var(--pf-panel2);color:var(--pf-accent);border-color:var(--pf-line2);font-weight:400}
.pf-bgmenu .pf-bg-sw{width:16px;height:16px}.pf-bgmenu label{padding:4px 8px;font-size:11.5px}.pf-bgmenu input[type=color]{width:34px;height:24px;padding:0;border:1px solid var(--pf-line2);background:none}
.pf-s-peek{color:var(--pf-accent2);cursor:pointer;user-select:none;-webkit-user-select:none;touch-action:none}.pf-arrow{color:var(--pf-faint);font-style:normal}
.pf-ctx{border-top:1px solid var(--pf-line);background:var(--pf-panel);display:flex;flex-direction:column;flex:none}
.pf-ctx-bar{display:flex;gap:10px;align-items:center;padding:5px 10px;border-bottom:1px solid var(--pf-line)}.pf .pf-ctx-bar .pf-seg button{min-height:24px;padding:1px 8px}
.pf-ctx-cv{display:block;width:100%;height:150px;image-rendering:pixelated}
.pf-fam-tools{margin-left:auto;display:inline-flex;gap:3px}.pf .pf-fam-tools button{min-height:24px;padding:1px 7px;font-size:11px}
.pf-vision-tag{position:absolute;left:14px;top:12px;font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;padding:3px 8px;background:var(--pf-accent2);color:var(--pf-on);font-weight:700;pointer-events:none}
.pf[data-vision="grey"] :is(.pf-view,.pf-ctx-cv,.pf-prev canvas,.pf-fam-m canvas){filter:grayscale(1)}
.pf[data-vision="protan"] :is(.pf-view,.pf-ctx-cv,.pf-prev canvas,.pf-fam-m canvas){filter:url(#pf-vision-protan)}
.pf[data-vision="deutan"] :is(.pf-view,.pf-ctx-cv,.pf-prev canvas,.pf-fam-m canvas){filter:url(#pf-vision-deutan)}
.pf[data-vision="tritan"] :is(.pf-view,.pf-ctx-cv,.pf-prev canvas,.pf-fam-m canvas){filter:url(#pf-vision-tritan)}
.pf .pf-ref-sprite{width:auto;flex:1;min-width:0}.pf-ref-on{display:flex;flex-direction:column;gap:6px}.pf .pf-refpanel .pf-seg button{min-height:26px;padding:2px 8px}
.pf-v-shift{display:flex;flex-direction:column;gap:4px}.pf-v-shift input[type=range]{flex:1;width:auto}.pf-v-shift b{min-width:3.2em;text-align:right;color:var(--pf-accent)}
.pf-v-cols{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:6px}.pf-v-col{display:flex;align-items:center;gap:4px;font-size:11px}.pf-v-col i{width:20px;height:20px;border:1px solid var(--pf-line2);flex:none}.pf-v-col input[type=color]{width:30px;height:22px;padding:0;border:1px solid var(--pf-line2);background:none}
.pf-v-preview{display:flex;gap:6px;flex-wrap:wrap;padding:8px;border:1px solid var(--pf-line);background:var(--pf-ckbg)}.pf-v-preview canvas{image-rendering:pixelated;height:72px}
.pf-hist summary{list-style:none;cursor:pointer}.pf-hist summary::-webkit-details-marker{display:none}.pf-hist summary h4{display:inline}.pf-hist summary h4::after{content:" ▸";color:var(--pf-faint)}.pf-hist[open] summary h4::after{content:" ▾"}
.pf-hist-list{display:flex;flex-direction:column;gap:3px;max-height:260px;overflow:auto;margin-top:6px}
.pf .pf-hist-e{display:grid;grid-template-columns:36px 1fr;gap:2px 8px;text-align:left;justify-content:stretch;align-items:center;background:none;border-color:transparent;padding:4px;min-height:0}
.pf .pf-hist-e canvas{grid-row:span 2;width:36px;height:36px;image-rendering:pixelated;object-fit:contain;background:var(--pf-ckbg)}
.pf-hist-e b{font-weight:400;color:var(--pf-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px}.pf-hist-e small{color:var(--pf-muted);font-size:10.5px}
.pf .pf-hist-e.on{border-color:var(--pf-accent);background:var(--pf-panel2);font-weight:400}
.pf-badge{position:absolute;top:2px;right:2px;font-style:normal;font-size:9.5px;line-height:1;padding:2px 3px;background:var(--pf-panel2);border:1px solid var(--pf-line2);color:var(--pf-muted)}
.pf-badge.anim{color:var(--pf-on);background:var(--pf-accent);border-color:var(--pf-accent);font-weight:700}
.pf .pf-cell .dot{position:absolute;top:4px;left:4px}
.pf-main{display:flex;flex-direction:column;min-width:0;min-height:0}
.pf-bar,.pf-opts{display:flex;flex-wrap:wrap;gap:6px 14px;padding:7px 10px;border-bottom:1px solid var(--pf-line);background:var(--pf-panel);align-items:center}
.pf-opts{background:var(--pf-bg);height:46px;flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;font-size:12px;scrollbar-width:thin}.pf-opt{flex-wrap:nowrap;white-space:nowrap;flex:none}
.pf-grp,.pf-opt{display:inline-flex;gap:4px;align-items:center;flex-wrap:wrap}.pf-opt[hidden]{display:none}
.pf-grp-end,.pf-opt-end{margin-left:auto}
.pf-ol{color:var(--pf-faint);text-transform:uppercase;letter-spacing:.1em;font-size:10px;margin-right:2px}
.pf-sizev{min-width:1.5em;color:var(--pf-accent)}
.pf-zl{min-width:3.2em;text-align:center;color:var(--pf-muted)}
.pf-seg{display:inline-flex;border:1px solid var(--pf-line2)}
.pf .pf-seg button{border:0;border-right:1px solid var(--pf-line2);min-height:28px;padding:3px 9px;background:var(--pf-panel)}
.pf .pf-seg button:last-child{border-right:0}.pf .pf-seg button.on{background:var(--pf-accent);color:var(--pf-on)}
.pf-work{flex:1;display:flex;min-height:0}
.pf-rail{display:flex;flex-direction:column;gap:4px;padding:8px 6px;border-right:1px solid var(--pf-line);background:var(--pf-panel);align-items:center;overflow:auto}
.pf-tools{display:flex;flex-direction:column;gap:4px}
.pf .pf-tools button{width:38px;height:38px;padding:0;background:transparent;border-color:transparent}
.pf .pf-tools button .pf-ic{width:21px;height:21px}
.pf .pf-tools button.on{background:var(--pf-accent);border-color:var(--pf-accent);color:var(--pf-on);box-shadow:0 0 16px rgba(185,140,255,.35)}
.pf-swatch{position:relative;width:40px;height:44px;margin-top:10px;flex:none}
.pf .pf-prim,.pf .pf-sec{position:absolute;width:26px;height:26px;min-height:0;padding:0;border:2px solid var(--pf-ink);background:var(--pf-c,#000)}
.pf .pf-prim{left:0;top:0;z-index:1}.pf .pf-sec{right:0;bottom:0;border-color:var(--pf-faint)}
.pf .pf-prim.clear,.pf .pf-sec.clear{background:repeating-conic-gradient(#3a2d55 0 25%,#1c1530 0 50%) 0 0/8px 8px}
.pf .pf-swap{position:absolute;right:-3px;top:-4px;min-height:0;width:16px;height:16px;padding:0;font-size:10px;background:none;border:0;color:var(--pf-muted)}
.pf-stage{position:relative;flex:1;min-height:200px;overflow:hidden;touch-action:none;background-color:#05030a;
  background-image:radial-gradient(ellipse 80% 60% at 50% 0%,rgba(185,140,255,.10),transparent 70%),linear-gradient(rgba(185,140,255,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(185,140,255,.045) 1px,transparent 1px);background-size:auto,32px 32px,32px 32px}
.pf-stage::after{content:"";position:absolute;inset:6px;pointer-events:none;background-repeat:no-repeat;background-image:
  linear-gradient(var(--pf-accent),var(--pf-accent)),linear-gradient(var(--pf-accent),var(--pf-accent)),linear-gradient(var(--pf-accent),var(--pf-accent)),linear-gradient(var(--pf-accent),var(--pf-accent)),
  linear-gradient(var(--pf-accent),var(--pf-accent)),linear-gradient(var(--pf-accent),var(--pf-accent)),linear-gradient(var(--pf-accent),var(--pf-accent)),linear-gradient(var(--pf-accent),var(--pf-accent));
  background-size:12px 1px,1px 12px,12px 1px,1px 12px,12px 1px,1px 12px,12px 1px,1px 12px;
  background-position:0 0,0 0,100% 0,100% 0,0 100%,0 100%,100% 100%,100% 100%;opacity:.55}
.pf-stage canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:crosshair}
.pf-status{display:flex;flex-wrap:wrap;gap:4px 18px;padding:6px 10px;border-top:1px solid var(--pf-line);background:var(--pf-panel);color:var(--pf-muted);font-size:11.5px}
.pf-status b{color:var(--pf-ink)}.pf-s-sel{color:var(--pf-accent)}
.pf-sw{display:flex;flex-wrap:wrap;gap:4px}
.pf .pf-sw button{width:24px;height:24px;min-height:0;padding:0;border:1px solid rgba(0,0,0,.6);box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}
.pf .pf-sw button:hover:not(:disabled){box-shadow:0 0 0 1px var(--pf-accent)}
.pf .pf-sw button.on{outline:2px solid var(--pf-accent);outline-offset:1px;border-color:var(--pf-on)}
.pf .pf-sw button.sec{outline:1px dashed var(--pf-muted);outline-offset:1px}
.pf-cur{display:flex;gap:8px;align-items:center}.pf-cur input[type=color]{width:44px;height:32px;padding:0;border:1px solid var(--pf-line2);background:none;flex:none;cursor:pointer}
.pf-ramp{display:flex;flex-direction:column;gap:6px}.pf-ramp[hidden]{display:none}.pf .pf-ramp .pf-sw button{width:34px;height:24px}
.pf-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.pf-prev canvas{image-rendering:pixelated;background:var(--pf-ckbg);max-width:100%;display:block;border:1px solid var(--pf-line)}
.pf-note{color:var(--pf-muted);font-size:11.5px}.pf-bad{color:var(--pf-bad)}
.pf-pal-empty[hidden]{display:none}
.pf-box{border:1px solid var(--pf-line);padding:10px;display:flex;flex-direction:column;gap:8px;background:var(--pf-bg)}
.pf .pf-c-pick.on{border-color:var(--pf-accent)}
.pf dialog.pf-dlg-connect{width:min(640px,94vw)}
.pf-dlg-head{display:flex;justify-content:space-between;align-items:center}.pf-dlg-head h4{margin:0}
.pf .pf-x{min-height:0;width:30px;height:30px;padding:0;background:none;border-color:transparent;color:var(--pf-muted);font-size:14px}
.pf-c-sec{border:1px solid var(--pf-line);background:var(--pf-bg);padding:14px;display:flex;flex-direction:column;gap:10px}
.pf-c-sechead{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;min-height:30px}
.pf-c-title{font-weight:700;color:var(--pf-ink)}
.pf-c-other{display:grid;grid-template-columns:minmax(0,1fr) 140px auto;gap:6px}
.pf-c-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.pf-c-tile{border:1px solid var(--pf-line);background:var(--pf-bg);padding:12px 14px;display:flex;flex-direction:column;gap:8px;align-items:flex-start}
.pf-c-tile .pf-note{min-height:2.6em}
.pf-c-foot{text-align:center}.pf-auth-help:empty,.pf-c-addrepo:empty{display:none}
.pf-auth-row[hidden]{display:none}
.pf-acct{display:inline-flex;gap:8px;align-items:center;font:12px var(--pf-mono,'JetBrains Mono',ui-monospace,monospace);color:#9a86c4}.pf-acct .pf-who{color:#9a86c4;font-size:12px}
.pf-acct button{font:inherit;font-size:12px;background:#150e24;color:#e6dcf7;border:1px solid #2a1b45;padding:2px 8px;cursor:pointer}.pf-acct button:hover{border-color:var(--pf-accent,#b98cff);color:var(--pf-accent,#b98cff)}
.pf-side-auth{justify-content:space-between;flex-wrap:nowrap}.pf-side-auth .pf-who{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.pf-side-auth .pf-who:empty{display:none}.pf-side-auth .pf-signin{width:100%}
.pf .pf-source{width:100%;justify-content:flex-start;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-color:var(--pf-line2);display:block}
.pf-c-mine{display:flex;flex-direction:column;gap:6px}.pf-c-mine[hidden]{display:none}.pf-c-repolist{display:flex;flex-direction:column;gap:4px;max-height:220px;overflow:auto}
.pf .pf-c-pick{display:flex;justify-content:space-between;gap:8px;text-align:left;width:100%}.pf-c-pick b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pf-tokenbox summary{cursor:pointer;color:var(--pf-muted);font-size:12px}.pf-tokenbox>label,.pf-tokenbox>.pf-note{display:block;margin-top:8px}.pf-tokenbox[hidden]{display:none}
.pf dialog{background:var(--pf-panel);color:var(--pf-ink);border:1px solid var(--pf-line2);box-shadow:0 0 0 1px rgba(185,140,255,.15),0 20px 60px rgba(0,0,0,.6),0 0 40px rgba(185,140,255,.10);padding:18px;width:min(560px,94vw);max-height:92vh;overflow:auto}
.pf dialog::backdrop{background:rgba(7,4,13,.78);backdrop-filter:blur(2px)}
.pf-form{display:flex;flex-direction:column;gap:10px}.pf-log:empty{display:none}.pf-log{white-space:pre-wrap;color:var(--pf-muted);max-height:140px;overflow:auto;border:1px solid var(--pf-line);padding:6px;min-height:34px;background:#05030a}
.pf-chg{display:flex;gap:8px;align-items:center;padding:4px 0;border-bottom:1px solid var(--pf-line)}.pf-chg canvas{width:40px;height:40px;image-rendering:pixelated;background:var(--pf-ckbg)}
.pf-keys{display:grid;grid-template-columns:1fr;gap:6px}.pf-key{display:grid;grid-template-columns:minmax(150px,auto) 1fr;gap:12px;align-items:baseline;padding:3px 0;border-bottom:1px dashed var(--pf-line)}.pf-key span{color:var(--pf-muted)}.pf-key kbd{justify-self:start}
@media (max-width:1600px){.pf-grp-view button > span:not(.pf-bg-sw){display:none}.pf .pf-grp-view button{padding:4px 8px}}
@media (max-width:1100px){.pf{grid-template-columns:200px minmax(0,1fr) 220px}.pf-bar button span,.pf-opt-end button span{display:none}}
@media (max-width:900px){
  .pf-c-grid{grid-template-columns:1fr}.pf-c-other{grid-template-columns:1fr}
  .pf{grid-template-columns:1fr;grid-template-rows:auto minmax(420px,1fr) auto;height:auto}
  .pf-side{flex-direction:column;border-right:0;border-bottom:1px solid var(--pf-line);max-height:none}.pf-list.pf-flat{flex-direction:row;overflow-x:auto;overflow-y:hidden;flex:none;min-height:0}.pf-flat .pf-item{width:150px;flex:none}.pf-list:not(.pf-flat){max-height:300px;flex:none}.pf-tiles{grid-template-columns:repeat(auto-fill,minmax(64px,1fr))}
  .pf-right{border-left:0;border-top:1px solid var(--pf-line)}
  .pf-work{flex-direction:column}
  .pf-rail{flex-direction:row;border-right:0;border-bottom:1px solid var(--pf-line);overflow-x:auto;padding:6px}
  .pf-tools{flex-direction:row}
  .pf-swatch{margin:0 0 0 8px}
  .pf-stage{min-height:340px}
  .pf-grp-end,.pf-opt-end{margin-left:0}
  .pf button{min-height:38px}.pf input[type=text],.pf input[type=password],.pf input[type=number],.pf select,.pf textarea{font-size:16px;min-height:38px}
  .pf-key{grid-template-columns:1fr}
}`;

  const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /* Interface icons: simple 24-unit line drawings (currentColor, so they follow the theme). */
  const ICONS = {
    pen: '<path d="M4 20l1.2-4.2L16.4 4.6a2.1 2.1 0 0 1 3 3L8.2 18.8z"/><path d="M14.4 6.6l3 3"/>',
    erase: '<path d="M9 20h11"/><path d="M5.7 15.3l8.8-8.8a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L12 19H8.4l-2.7-2.7a1 1 0 0 1 0-1z"/><path d="M9.6 11.4l5 5"/>',
    fill: '<path d="M10.5 3.5l8.4 8.4-6.7 6.7a2 2 0 0 1-2.8 0l-5.6-5.6a2 2 0 0 1 0-2.8z"/><path d="M4.2 11.9H17"/><path d="M20 15.2s1.9 2.3 1.9 3.6a1.9 1.9 0 0 1-3.8 0c0-1.3 1.9-3.6 1.9-3.6z"/>',
    pick: '<circle cx="17.4" cy="6.6" r="3" fill="currentColor" stroke="none"/><path d="M13 7.6l3.4 3.4"/><path d="M14.6 9.4L6 18l-1.5 2.5 2.5-1.5 8.6-8.6"/>',
    line: '<path d="M6 18L18 6"/><circle cx="5.2" cy="18.8" r="1.7" fill="currentColor" stroke="none"/><circle cx="18.8" cy="5.2" r="1.7" fill="currentColor" stroke="none"/>',
    rect: '<rect x="4.5" y="5.5" width="15" height="13"/>',
    ellipse: '<ellipse cx="12" cy="12" rx="8.2" ry="6.6"/>',
    select: '<path d="M4.5 8V4.5H8M11 4.5h2M16 4.5h3.5V8M19.5 11v2M19.5 16v3.5H16M13 19.5h-2M8 19.5H4.5V16M4.5 13v-2"/>',
    shade: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>',
    undo: '<path d="M9 13.5L4.5 9 9 4.5"/><path d="M4.5 9H15a5 5 0 0 1 0 10h-3.5"/>',
    redo: '<path d="M15 13.5L19.5 9 15 4.5"/><path d="M19.5 9H9a5 5 0 0 0 0 10h3.5"/>',
    grid: '<rect x="4" y="4" width="16" height="16"/><path d="M4 9.3h16M4 14.7h16M9.3 4v16M14.7 4v16"/>',
    tile: '<rect x="4" y="4" width="7" height="7"/><rect x="13" y="4" width="7" height="7"/><rect x="4" y="13" width="7" height="7"/><rect x="13" y="13" width="7" height="7"/>',
    changes: '<rect x="3.5" y="3.5" width="17" height="17"/><path d="M12 3.5v17"/><path d="M5.5 9.5h4M7.5 7.5v4"/><path d="M14.5 9.5h4"/><path d="M14.5 15.5h4" stroke-dasharray="1 1.6"/>',
    context: '<rect x="3.5" y="13.5" width="5" height="6"/><rect x="9.5" y="7.5" width="5" height="12" fill="currentColor"/><rect x="15.5" y="11.5" width="5" height="8"/><path d="M2 20.5h20"/>',
    vision: '<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/><path d="M12 9v6" />',
    onion: '<rect x="3.5" y="8.5" width="10" height="11" stroke-dasharray="2 2"/><rect x="10.5" y="4.5" width="10" height="11"/>',
    mx: '<path d="M12 3v18" stroke-dasharray="1.5 2.5"/><path d="M9 7.5L4.5 12 9 16.5z"/><path d="M15 7.5l4.5 4.5-4.5 4.5z"/>',
    my: '<path d="M3 12h18" stroke-dasharray="1.5 2.5"/><path d="M7.5 9L12 4.5 16.5 9z"/><path d="M7.5 15l4.5 4.5 4.5-4.5z"/>',
    sq: '<rect x="6.5" y="6.5" width="11" height="11" fill="currentColor"/>',
    circ: '<circle cx="12" cy="12" r="6" fill="currentColor"/>',
  };
  const icon = (name) => `<svg class="pf-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  // [id, name, key, rail icon or the rail tool it belongs to]
  const TOOLS = [['pen', 'Pencil', 'B'], ['erase', 'Eraser', 'E'], ['fill', 'Fill', 'G'], ['pick', 'Colour picker', 'I'], ['line', 'Line', 'L'], ['rect', 'Rectangle', 'R'], ['rectf', 'Filled rectangle', 'F', 'rect'], ['ellipse', 'Ellipse', 'O'], ['ellipsef', 'Filled ellipse', 'U', 'ellipse'], ['select', 'Select and move', 'S'], ['shade', 'Shade: lighter, right click darker', 'D']];
  const railOf = (t) => { const x = TOOLS.find((k) => k[0] === t); return (x && x[3]) || t; };
  const KEYS = [['B E G I', 'pencil · eraser · fill · colour picker'], ['L R F O U', 'line · rectangle · filled rect · ellipse · filled ellipse'], ['S D', 'select & move · shade'], ['[ ]', 'brush size'], ['X', 'swap primary / secondary colour'], ['Alt+click', 'pick a colour with any tool'], ['right click', 'paint with the secondary colour (clear = erase)'], ['Shift', 'square / circle / 45° lines; with the pencil, click to draw a line from the last point'],
    ['M', 'mirror left-right'], ['V', 'context: the sprite at game scale next to others from its folder'], ['H', 'show / hide the reference image'], ['Y', 'vision check: values (greyscale), protanopia, deuteranopia, tritanopia'], ['C · hold \\', 'changes since opening (dims the rest) · show the original while held'], ['T · N · # · K', 'tile preview · onion skin · grid · background (dark / light checker, black, white, custom, the project\'s)'], ['Ctrl+C X V', 'copy · cut · paste (images from other apps too)'], ['Ctrl+A · Del · Esc · Enter', 'select all · delete · drop · apply selection'], ['arrows', 'nudge the selection (Shift: 8 px)'], ['Ctrl+Z · Ctrl+Y', 'undo · redo'], ['Ctrl+S', 'save'], ['wheel · + − 0', 'zoom · fit'], ['space+drag · middle mouse', 'pan'], ['?', 'this list']];
  /* What shows behind transparent pixels. No single background suits all art (dark details vanish on the dark checker, pale
     ones on the light one), so like Aseprite, Pixelorama and Piskel the editor offers a few and remembers the choice.
     "project" is the game's own background colour from spritewright.config.json ("background": "#1a1426"). */
  const BACKGROUNDS = [['project', 'Project background'], ['dark', 'Dark checker'], ['light', 'Light checker'], ['black', 'Black'], ['white', 'White'], ['custom', 'Custom colour']];
  const luma = (hex) => { const c = fromHex(hex); if (c == null) return 0; const [r, g, b] = unpack(c); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };
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
    if (!document.getElementById('pf-vision-defs')) { // colour-blind simulations (Machado, Oliveira & Fernandes 2009, full severity), used by CSS filters
      const m = { protan: '0.152286 1.052583 -0.204868 0 0 0.114503 0.786281 0.099216 0 0 -0.003882 -0.048116 1.051998 0 0', deutan: '0.367322 0.860646 -0.227968 0 0 0.280085 0.672501 0.047413 0 0 -0.011820 0.042940 0.968881 0 0', tritan: '1.255528 -0.076749 -0.178779 0 0 -0.078411 0.930809 0.147602 0 0 0.004733 0.691367 0.303900 0 0' };
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.id = 'pf-vision-defs'; svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');
      svg.innerHTML = Object.entries(m).map(([k, v]) => `<filter id="pf-vision-${k}"><feColorMatrix type="matrix" values="${v} 0 0 0 1 0"/></filter>`).join(''); document.body.appendChild(svg);
    }
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
          <span class="pf-grp"><button class="pf-undo" title="Undo (Ctrl+Z)">${icon('undo')}<span>Undo</span></button><button class="pf-redo" title="Redo (Ctrl+Y)">${icon('redo')}<span>Redo</span></button></span>
          <span class="pf-grp"><button class="pf-zout" title="Zoom out (-)">−</button><span class="pf-zl" title="Zoom">1×</span><button class="pf-zin" title="Zoom in (+)">+</button><button class="pf-fit" title="Fit to window (0)">Fit</button></span>
          <span class="pf-grp pf-grp-view"><button class="pf-grid on" title="Pixel grid (#)">${icon('grid')}<span>Grid</span></button><button class="pf-tile" title="Tile preview: see the sprite repeated, and draw across the edges (T)">${icon('tile')}<span>Tile</span></button><button class="pf-bg" title="Background behind transparent pixels (K cycles)" aria-haspopup="menu"><span class="pf-bg-sw"></span><span>Background</span></button><button class="pf-context" title="Context: the sprite at game scale on the project background, next to others from its folder, live as you draw (V)">${icon('context')}<span>Context</span></button><button class="pf-changes" title="Changes: dim what you have not touched and outline the pixels that differ from the original (C). Hold \\ to see the original.">${icon('changes')}<span>Changes</span></button><button class="pf-vision" title="Vision check: values (greyscale) and colour-blind simulations (Y)">${icon('vision')}<span>Vision</span></button><button class="pf-onion" title="Onion skin: show the previous animation frame faintly under the current one (N)">${icon('onion')}<span>Onion</span></button></span>
          <span class="pf-grp pf-grp-end"><button class="pf-help" title="Keyboard shortcuts (?)">?</button><button class="pf-save primary" title="Save (Ctrl+S)">Save</button><button class="pf-export" title="Download a PNG, optionally scaled up">Export</button><button class="pf-prbtn" title="Open a GitHub pull request with the changed sprites">Propose PR</button></span>
        </div>
        <div class="pf-opts">
          <span class="pf-opt" data-for="pen erase shade"><span class="pf-ol">size</span><input type="range" class="pf-size" min="1" max="8" value="1" aria-label="Brush size"><b class="pf-sizev">1</b>
            <span class="pf-seg pf-shape"><button data-shape="square" class="on" title="Square tip">${icon('sq')}</button><button data-shape="round" title="Round tip">${icon('circ')}</button></span></span>
          <span class="pf-opt" data-for="pen fill rect rectf ellipse ellipsef line"><span class="pf-ol">pattern</span><span class="pf-seg pf-pattern"><button data-pattern="solid" class="on" title="Solid">solid</button><button data-pattern="dither" title="Checkerboard dither: the primary colour on every other pixel (fills put the secondary colour in between)">dither</button></span></span>
          <span class="pf-opt" data-for="fill"><span class="pf-ol">fill</span><span class="pf-seg pf-fillmode"><button data-fill="area" class="on" title="Only the connected area">area</button><button data-fill="same" title="Every pixel of that colour in the image">same colour</button></span></span>
          <span class="pf-opt" data-for="rect rectf ellipse ellipsef"><span class="pf-seg pf-filled"><button data-filled="0" class="on" title="Outline (R / O)">outline</button><button data-filled="1" title="Filled (F / U)">filled</button></span><span class="pf-note">Shift: square / circle</span></span>
          <span class="pf-opt" data-for="line"><span class="pf-note">Shift snaps to 45°</span></span>
          <span class="pf-opt" data-for="pen"><button class="pf-pp" title="Pixel-perfect pencil: removes the corner doubles that make 1-pixel lines lumpy. Best for single lines; leave it off to fill areas by dragging.">clean lines</button><span class="pf-note">Shift+click: line from the last point</span></span>
          <span class="pf-opt" data-for="shade"><span class="pf-note">click lightens · right click darkens · steps through the palette when one is loaded</span></span>
          <span class="pf-opt" data-for="select"><button class="pf-sel-copy" title="Copy (Ctrl+C)">copy</button><button class="pf-sel-cut" title="Cut (Ctrl+X)">cut</button><button class="pf-sel-paste" title="Paste (Ctrl+V; images from other apps too)">paste</button><button class="pf-sel-del" title="Delete (Del)">delete</button><button class="pf-sel-all" title="Select all (Ctrl+A)">all</button><button class="pf-sel-none" title="Drop the selection (Esc)">deselect</button><span class="pf-note">drag inside to move · arrows nudge</span></span>
          <span class="pf-opt pf-opt-end" data-for="*"><button class="pf-mx" title="Mirror left-right (M)">${icon('mx')}<span>mirror X</span></button><button class="pf-my" title="Mirror up-down">${icon('my')}<span>mirror Y</span></button></span>
        </div>
        <div class="pf-work">
          <nav class="pf-rail" aria-label="Tools"><span class="pf-tools"></span>
            <span class="pf-swatch" title="Primary (left click) and secondary (right click) colours. X swaps them."><button class="pf-prim" aria-label="Primary colour"></button><button class="pf-sec" aria-label="Secondary colour"></button><button class="pf-swap" title="Swap colours (X)">⇄</button></span></nav>
          <div class="pf-stage"><canvas class="pf-view" aria-label="Sprite canvas"></canvas><span class="pf-vision-tag" hidden></span></div>
        </div>
        <div class="pf-ctx" hidden><div class="pf-ctx-bar"><span class="pf-ol">in context</span><span class="pf-seg pf-ctx-scale">${[1, 2, 3, 4].map((n) => `<button data-scale="${n}"${n === 2 ? ' class="on"' : ''}>${n}×</button>`).join('')}</span><span class="pf-note pf-ctx-note"></span></div><canvas class="pf-ctx-cv" aria-label="The sprite in context"></canvas></div>
        <div class="pf-status"><span class="pf-s-name"></span><span class="pf-s-pos"></span><span class="pf-s-sel"></span><span class="pf-s-info"></span></div>
      </section>
      <aside class="pf-right">
        <div class="pf-panel"><h4>Colour</h4><div class="pf-cur"><input type="color" class="pf-cpick" aria-label="Current colour"><input type="text" class="pf-chex" maxlength="9" aria-label="Hex colour"></div>
          <div class="pf-row"><button class="pf-ramp-btn" title="A 5-colour ramp around this colour: cool, darker shadows and warm highlights">Hue-shift ramp</button><button class="pf-recolor" title="Change this colour everywhere in the image">Recolour all…</button><input type="color" class="pf-recolor-in" aria-hidden="true" tabindex="-1" style="position:absolute;opacity:0;width:1px;height:1px;pointer-events:none"></div>
          <div class="pf-ramp" hidden><div class="pf-sw pf-ramp-colors"></div><button class="pf-ramp-add" title="Add these colours to the palette">+ add to palette</button></div></div>
        <div class="pf-panel"><h4>In this image</h4><div class="pf-sw pf-img-colors"></div></div>
        <div class="pf-panel"><h4>Palette</h4><div class="pf-pal-wrap"><div class="pf-sw pf-pal-colors"></div><div class="pf-note pf-pal-empty">No palette yet: load a .hex (Lospec), or add colours with +.</div><div class="pf-note pf-off"></div></div>
          <div class="pf-row"><button class="pf-pal-add" title="Add the primary colour to the palette">+ colour</button><button class="pf-palload">Load…</button><button class="pf-palsave">Save .hex</button><button class="pf-snap" title="Move every pixel to its nearest palette colour">Snap</button><input type="file" class="pf-palfile" accept=".hex,.txt,text/plain" hidden></div></div>
        <div class="pf-panel pf-prev"><h4>Preview</h4>
          <div class="pf-fam" hidden><div class="pf-fam-h"><b class="pf-fam-name"></b><span class="pf-note pf-fam-kind"></span><span class="pf-fam-tools"><button type="button" class="pf-fam-left" title="Move this frame earlier (swaps it with the one before)">◀</button><button type="button" class="pf-fam-right" title="Move this frame later">▶</button><button type="button" class="pf-fam-add" title="New frame: a copy of this one, numbered after the last">+ frame</button></span></div><div class="pf-fam-strip" role="listbox" aria-label="Frames and poses"></div><div class="pf-note"><kbd>,</kbd> <kbd>.</kbd> previous / next · Play flips through them</div></div>
          <canvas class="pf-p1"></canvas>
          <div class="pf-row pf-sheet-row"><label>frame <input type="number" class="pf-fw" min="1" value="16">×<input type="number" class="pf-fh" min="1" value="16"></label></div>
          <div class="pf-row"><label>fps <input type="number" class="pf-fps" min="1" max="60" value="8"></label><button class="pf-play">Play</button><button class="pf-gif" title="Download the animation (or this image) as a looping GIF, to share in chat or a pull request">GIF…</button></div>
          <canvas class="pf-p2"></canvas></div>
        <div class="pf-panel pf-refpanel"><h4>Reference</h4>
          <div class="pf-row"><button class="pf-ref-load" title="Any image: concept art, a photo, a screenshot of the game">Image…</button><select class="pf-ref-sprite" aria-label="Or a sprite from this project"><option value="">or a sprite…</option></select><input type="file" class="pf-ref-file" accept="image/*" hidden></div>
          <div class="pf-ref-on" hidden><div class="pf-note pf-ref-name"></div>
            <div class="pf-row"><label>opacity <input type="range" class="pf-ref-op" min="5" max="100" value="40"></label></div>
            <div class="pf-row"><span class="pf-seg pf-ref-place"><button data-place="under" class="on" title="Behind your pixels">under</button><button data-place="over" title="On top of your pixels">over</button></span><span class="pf-seg pf-ref-fit"><button data-fit="pixels" class="on" title="One image pixel per sprite pixel, from the top-left">1:1</button><button data-fit="fit" title="Scaled to fit the canvas">fit</button></span></div>
            <div class="pf-row"><button class="pf-ref-toggle" title="Show or hide the reference (H)">hide</button><button class="pf-ref-clear">remove</button></div></div></div>
        <details class="pf-panel pf-hist" hidden><summary><h4>History</h4></summary><div class="pf-hist-list"></div><div class="pf-row pf-hist-act" hidden><button class="primary pf-hist-restore">Restore this version</button><span class="pf-note pf-hist-sel"></span></div></details>
        <div class="pf-panel"><h4>Image</h4><div class="pf-row"><button class="pf-fliph" title="Flip the image, or the selection">Flip ↔</button><button class="pf-flipv">Flip ↕</button><button class="pf-rot" title="Rotate the image, or the selection">Rotate ↻</button></div>
          <div class="pf-row"><button class="pf-sh" data-d="-1,0">←</button><button class="pf-sh" data-d="0,-1">↑</button><button class="pf-sh" data-d="0,1">↓</button><button class="pf-sh" data-d="1,0">→</button><span class="pf-note">wrap shift</span></div>
          <div class="pf-row"><button class="pf-variant" title="A recoloured copy of this sprite (and its whole family: every pose and frame) as new files, e.g. king → king_dark">Make variant…</button></div>
          <div class="pf-row"><button class="pf-outline" title="Draw a 1-pixel outline in the primary colour around everything opaque">Outline</button><label class="pf-note"><input type="checkbox" class="pf-outline-c"> corners</label></div>
          <div class="pf-row"><button class="pf-resize">Canvas size…</button><button class="pf-clear">Clear</button></div></div>
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
      <dialog class="pf-dlg-connect"><form method="dialog" class="pf-form">
        <div class="pf-dlg-head"><h4>Open a project</h4><button value="cancel" class="pf-x" aria-label="Close" title="Close (Esc)">✕</button></div>
        <section class="pf-c-sec pf-gh-box">
          <div class="pf-c-sechead"><span class="pf-c-title">GitHub repository</span>
            <span class="pf-row pf-auth-row"><span class="pf-who pf-note"></span><button type="button" class="pf-signout" hidden>Sign out</button><button type="button" class="primary pf-signin">Sign in with GitHub</button></span></div>
          <div class="pf-note pf-auth-help"></div>
          <div class="pf-c-mine" hidden><div class="pf-c-repolist"></div><div class="pf-note pf-c-addrepo"></div></div>
          <div class="pf-c-other"><input type="text" class="pf-c-repo" list="pf-repos" placeholder="owner/name" autocomplete="off" aria-label="Repository (owner/name)"><datalist id="pf-repos"></datalist><input type="text" class="pf-c-branch" placeholder="branch" aria-label="Branch (default branch if empty)"><button type="button" class="pf-c-gh">Open</button></div>
          <details class="pf-tokenbox"><summary>Use a token instead</summary>
            <label>Token <input type="password" class="pf-c-token" autocomplete="off" placeholder="optional for public repos; needed for private repos and pull requests"></label>
            <label><input type="checkbox" class="pf-c-remember"> remember the token in this browser</label></details>
        </section>
        <div class="pf-c-grid">
          <section class="pf-c-tile pf-c-folderbox"><span class="pf-c-title">Folder on this computer</span><span class="pf-note pf-c-foldernote"></span><button type="button" class="pf-c-folder">Choose folder…</button></section>
          <section class="pf-c-tile"><span class="pf-c-title">Just draw</span><span class="pf-note">Stays in this tab. Download when done.</span><span class="pf-row"><button type="button" class="pf-c-upload">Upload PNG…</button><button type="button" class="pf-c-blank">Blank sprite</button></span></section>
        </div>
        <div class="pf-log pf-c-msg" aria-live="polite"></div>
        <div class="pf-note pf-c-foot">Tip: drop PNG files onto the canvas at any time.</div></form></dialog>
      <dialog class="pf-dlg-size"><form method="dialog" class="pf-form"><h4>Canvas size</h4>
        <div class="pf-row"><label>width <input type="number" class="pf-sz-w" min="1" max="1024"></label><label>height <input type="number" class="pf-sz-h" min="1" max="1024"></label></div>
        <label>keep <select class="pf-sz-a"><option value="tl">top-left</option><option value="c">centre</option></select></label>
        <div class="pf-row"><button type="button" class="primary pf-sz-ok">Apply</button><button value="cancel">Cancel</button></div></form></dialog>
      <dialog class="pf-dlg-variant"><form method="dialog" class="pf-form">
        <div class="pf-dlg-head"><h4>New variant</h4><button value="cancel" class="pf-x" aria-label="Close">✕</button></div>
        <div class="pf-note pf-v-what"></div>
        <label>name <input type="text" class="pf-v-suffix" value="variant" maxlength="32" aria-label="Variant name"></label>
        <div class="pf-note pf-v-names"></div>
        <span class="pf-seg pf-v-mode"><button type="button" data-mode="shift" class="on">shift colours</button><button type="button" data-mode="swap">swap colours</button></span>
        <div class="pf-v-shift"><label>hue <input type="range" class="pf-v-h" min="-180" max="180" value="0"><b class="pf-v-hv">0°</b></label><label>saturation <input type="range" class="pf-v-s" min="-100" max="100" value="0"><b class="pf-v-sv">0</b></label><label>brightness <input type="range" class="pf-v-l" min="-100" max="100" value="0"><b class="pf-v-lv">0</b></label><label><input type="checkbox" class="pf-v-keep" checked> keep outlines (near-black) as they are</label></div>
        <div class="pf-v-swap" hidden><div class="pf-v-cols"></div></div>
        <div class="pf-v-preview"></div>
        <div class="pf-row"><button type="button" class="primary pf-v-go">Create</button><button value="cancel">Cancel</button></div></form></dialog>
      <dialog class="pf-dlg-keys"><form method="dialog" class="pf-form"><h4>Keyboard shortcuts</h4><div class="pf-keys"></div><div class="pf-row"><button value="cancel" class="primary">Close</button></div></form></dialog>
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
    const S = { sprites: [], docs: new Map(), cur: null, tool: 'pen', color: pack(185, 140, 255), mx: false, my: false, pp: false, grid: true, zoom: 8, ox: 0, oy: 0,
      color2: 0, ref: null, vision: 'normal', ctx: false, ctxScale: 2, changes: false, peek: false, bg: 'auto', bgCustom: '#3a5a40', size: 1, shape: 'square', pattern: 'solid', fillMode: 'area', tile: false, onion: false, sel: null, float: null, clip: null, hover: null, lastPt: null,
      palette: O.palette ? O.palette.map((c) => (typeof c === 'string' ? fromHex(c) : c)).filter((c) => c != null) : [], src: null, meta: {}, auth: { token: '', login: '' }, anim: { timer: 0, t: 0 }, notice: '' };
    const doc = () => S.docs.get(S.cur);
    const view = $('.pf-view'), stage = $('.pf-stage'), g = view.getContext('2d');
    const offscreen = document.createElement('canvas'), diffCanvas = document.createElement('canvas');
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
      $$('.pf-auth-help').forEach((h) => { h.innerHTML = authBase ? (on ? '' : 'Sign in to list your repositories. Edits go back as a pull request.') : `Sign-in is not set up on this page. Paste a token instead: <a href="${PAT_URL}" target="_blank" rel="noopener" style="color:var(--pf-accent)">create one with the right permissions</a> (Contents and Pull requests: read and write, only for your repository).`; });
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
      add.innerHTML = link ? `Missing a repository? <a href="${esc(link)}" target="_blank" rel="noopener" style="color:var(--pf-accent)">Install the app on it</a>, then reopen this.` : '';
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
      play(false); S.float = null; S.sel = null; S.docs.clear(); S.cur = null; S.src = src; folded = null; S.sprites = src.sprites.map((x) => ({ ...x })); thumbs.clear();
      S.meta = { repo: Object.assign({}, src.repo || {}, Object.fromEntries(Object.entries(O.github || {}).filter(([, v]) => v != null && v !== ''))) };
      if (!O.palette) S.palette = (src.palette || []).map((h) => (typeof h === 'string' ? fromHex(h) : h)).filter((c) => c != null);
      $('.pf-src').textContent = src.note || '';
      const label = src.kind === 'github' ? src.repo.slug : src.kind === 'folder' ? src.name : '';
      $('.pf-source').textContent = label ? label + ' ▾' : 'Open project…'; $('.pf-source').title = (label ? label + ': ' : '') + 'switch to another GitHub repository or a folder on this computer';
      $('.pf-pr-repo').value = ''; $('.pf-pr-base').value = ''; $('.pf-pr-title').value = ''; // the next pull request goes to the new project
      renderList(); renderPalette(); applyBg();
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
    /** The document for a sprite, loading it if needed (without opening it). Null if it cannot be read. */
    async function loadDoc(path) {
      if (S.docs.has(path)) return S.docs.get(path);
      const meta = S.sprites.find((s) => s.path === path);
      try {
        const img = await decodePng(new Blob([await S.src.read(path)], { type: 'image/png' }));
        S.docs.set(path, new Doc(path, img.w, img.h, img.px, { frames: meta && meta.frames }));
        return S.docs.get(path);
      } catch (e) { note('Could not open ' + path + ': ' + e.message); return null; }
    }
    async function openSprite(path) {
      if (path !== S.cur) { commitFloat(); S.sel = null; S.lastPt = null; }
      if (!(await loadDoc(path))) return;
      S.cur = path; S.touched = false; const d = doc(); loadFrames(d); fit(); renderList(); renderColors(); status(); render(); drawPreview(); renderFamily(); resetHistory();
    }
    /** Add an image that is not in the project list. inProject = Save should write it to that path (needs a source that can write). */
    function addLocal(name, w, h, px, inProject, isNew) {
      let path = name, n = 1; while (S.docs.has(path)) path = name.replace(/(\.png)?$/i, '') + '-' + (++n) + '.png';
      S.docs.set(path, new Doc(path, w, h, px, { local: !inProject, isNew })); S.sprites.push({ path, w, h, local: !inProject }); return openSprite(path);
    }
    const canWrite = () => !!(S.src && S.src.write);

    /* ---------- list ---------- */
    const thumbs = new Map();
    const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { io.unobserve(e.target); paintThumb(e.target, e.target.__s); } }), { root: $('.pf-list') }) : null;
    /* The sprite list: folders you can fold, one tile per family (archer_0 + archer_atk + archer_block), animations marked ▶.
       Typing in the filter shows a flat list of matching files instead. */
    const famOf = new Map(); // path -> { key, dir, members, animated }
    const collapsedKey = () => 'pf:folded:' + ((S.meta.repo && S.meta.repo.slug) || (S.src && S.src.name) || location.pathname);
    let folded = null;
    const loadFolded = () => { try { folded = new Set(JSON.parse(localStorage.getItem(collapsedKey()) || '[]')); } catch { folded = new Set(); } };
    const saveFolded = () => { try { localStorage.setItem(collapsedKey(), JSON.stringify([...folded])); } catch { /* ignore */ } };
    function regroup() {
      famOf.clear(); const groups = groupSprites(S.sprites.map((s) => s.path));
      for (const g of groups) for (const f of g.families) { const fam = { ...f, dir: g.dir }; for (const m of f.members) famOf.set(m, fam); }
      return groups;
    }
    const spriteOf = (path) => S.sprites.find((x) => x.path === path);
    function tileHtml(s, label, fam, flat) {
      const d = S.docs.get(s.path), members = fam ? fam.members : [s.path], dirty = members.some((p) => { const x = S.docs.get(p); return x && x.unsaved; }), changed = members.some((p) => { const x = S.docs.get(p); return x && x.changed; });
      const size = d ? d.w + '×' + d.h : (s.w || '?') + '×' + (s.h || '?'), dir = s.path.split('/').slice(0, -1).join('/') || '.';
      const badge = fam && fam.members.length > 1 ? `<i class="pf-badge${fam.animated ? ' anim' : ''}" title="${fam.animated ? 'animation: ' + fam.members.length + ' frames' : fam.members.length + ' images in this family'}">${fam.animated ? '▶' : ''}${fam.members.length}</i>` : '';
      const on = members.includes(S.cur);
      return `<button class="pf-item${flat ? '' : ' pf-cell'}${on ? ' on' : ''}" role="option" data-path="${esc(s.path)}" title="${esc(s.path)}"><canvas width="${s.w || 16}" height="${s.h || 16}"></canvas><span class="n">${esc(label)}<small>${flat ? esc(dir) + ' · ' : ''}${size}</small></span>${badge}${dirty ? '<i class="dot" title="unsaved"></i>' : changed ? '<i class="dot base" title="saved, not yet proposed"></i>' : ''}</button>`;
    }
    function renderList() {
      const q = $('.pf-q').value.toLowerCase(), list = $('.pf-list'), groups = regroup(); list.innerHTML = '';
      if (!folded) loadFolded();
      const add = (html, s) => { const b = el(html); list.appendChild(b); const cv = b.querySelector('canvas'); cv.__s = s; if (io) io.observe(cv); else paintThumb(cv, s); return b; };
      list.classList.toggle('pf-flat', !!q);
      if (q) { for (const s of S.sprites.filter((x) => x.path.toLowerCase().includes(q))) add(tileHtml(s, s.path.split('/').pop(), famOf.get(s.path), true), s); return; }
      const hid = (S.src && S.src.hidden) || []; let hidNote = null;
      if (hid.length) { // the default skip of docs/screenshots/... folders, made visible and reversible
        const shown = S.sprites.some((x) => x.hiddenByDefault);
        const note = hidNote = el(`<button class="pf-hidden-toggle" title="${shown ? 'Hide' : 'Show'} the images in folders like docs, screenshots and previews, which are usually not game art">${shown ? 'Hide' : 'Show'} ${hid.length} image${hid.length > 1 ? 's' : ''} from docs / screenshots / previews folders</button>`);
      }
      for (const g of groups) {
        const n = g.families.reduce((k, f) => k + f.members.length, 0), shut = folded.has(g.dir) && !g.families.some((f) => f.members.includes(S.cur));
        if (groups.length > 1 || g.dir) list.appendChild(el(`<button class="pf-dir${shut ? ' shut' : ''}" data-dir="${esc(g.dir)}" aria-expanded="${!shut}"><span class="pf-caret">${shut ? '▸' : '▾'}</span><span class="pf-dirname">${esc(g.dir || '.')}</span><span class="pf-dircount">${n}</span></button>`));
        if (shut) continue;
        const grid = el('<div class="pf-tiles"></div>'); list.appendChild(grid);
        for (const f of g.families) {
          const shown = f.members.includes(S.cur) ? S.cur : f.members[0], s = spriteOf(shown);
          const b = el(tileHtml(s, f.members.length > 1 ? f.key : shown.split('/').pop(), famOf.get(shown), false)); grid.appendChild(b);
          const cv = b.querySelector('canvas'); cv.__s = s; if (io) io.observe(cv); else paintThumb(cv, s);
        }
      }
      if (hidNote) list.appendChild(hidNote); // after the folders
    }
    function toggleDir(dir) { if (!folded) loadFolded(); folded.has(dir) ? folded.delete(dir) : folded.add(dir); saveFolded(); renderList(); }
    /* Thumbnails load as their rows come into view, a few at a time, so a big project starts drawing at once without flooding the network. */
    let thumbBusy = 0; const thumbQueue = [];
    const thumbSlot = () => new Promise((res) => { if (thumbBusy < 6) { thumbBusy++; res(); } else thumbQueue.push(res); });
    const thumbDone = () => { const next = thumbQueue.shift(); if (next) next(); else thumbBusy--; };
    async function paintThumb(canvas, s) {
      const d = S.docs.get(s.path);
      if (d) return drawPx(canvas, d);
      if (!S.src || !S.src.thumbs) return;
      const src = S.src;
      try {
        let bm = thumbs.get(s.path);
        if (!bm) { await thumbSlot(); try { if (S.src !== src) return; bm = await createImageBitmap(new Blob([await src.read(s.path)], { type: 'image/png' })); thumbs.set(s.path, bm); } finally { thumbDone(); } }
        canvas.width = bm.width; canvas.height = bm.height; const c = canvas.getContext('2d'); c.imageSmoothingEnabled = false; c.drawImage(bm, 0, 0);
        if (!s.w || !s.h) { s.w = bm.width; s.h = bm.height; const small = canvas.parentElement && canvas.parentElement.querySelector('small'); if (small) small.textContent = small.textContent.replace(/\?×\?$/, s.w + '×' + s.h); }
      } catch { /* leave blank */ }
    }

    /* ---------- palette / colours ---------- */
    function renderColors() {
      const d = doc(); if (!d) return;
      swatches(); const cols = colorsOf(d.px).filter(([c]) => c !== 0).slice(0, 64);
      $('.pf-img-colors').innerHTML = cols.map(([c, n]) => `<button data-c="${c}" title="${toHex(c)} · ${n}px" class="${c === S.color ? 'on' : ''}" style="background:${toHex(c)}"></button>`).join('') || '<span class="pf-note">transparent</span>';
      $('.pf-cpick').value = toHex(S.color); if (document.activeElement !== $('.pf-chex')) $('.pf-chex').value = toHex(S.color);
      $$('.pf-sw button').forEach((b) => { b.classList.toggle('on', +b.dataset.c === S.color); b.classList.toggle('sec', !isClear(S.color2) && +b.dataset.c === S.color2); });
      if (S.palette.length) {
        const set = new Set(S.palette), off = cols.filter(([c]) => !set.has(c)).length;
        $('.pf-off').innerHTML = off ? `<span class="pf-bad">${off} colour${off > 1 ? 's' : ''} outside the palette</span>` : 'All colours are in the palette.';
      }
    }
    function swatches() {
      for (const [sel, c] of [['.pf-prim', S.color], ['.pf-sec', S.color2]]) { const b = $(sel); b.classList.toggle('clear', isClear(c)); b.style.setProperty('--pf-c', toHex(c)); b.title = (sel === '.pf-prim' ? 'Primary ' : 'Secondary ') + (isClear(c) ? 'clear (erases)' : toHex(c)); }
    }
    function renderPalette() {
      $('.pf-pal-empty').hidden = !!S.palette.length; if (!S.palette.length) $('.pf-off').textContent = '';
      $('.pf-pal-colors').innerHTML = S.palette.map((c) => `<button data-c="${c}" title="${toHex(c)}" style="background:${toHex(c)}"></button>`).join('');
    }
    function setColor(c) { S.color = c; if (S.tool === 'erase' || S.tool === 'pick') setTool('pen'); renderColors(); swatches(); }
    function setColor2(c) { S.color2 = c; renderColors(); swatches(); }

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
      // holding \ shows the image as it was when this session opened it (what a pull request compares against)
      const shown = S.peek ? { w: d.base.w, h: d.base.h, img: new ImageData(new Uint8ClampedArray(d.base.px.buffer.slice(0)), d.base.w, d.base.h) } : { w: d.w, h: d.h, img: d.imageData() };
      const z = S.zoom, W = shown.w * z, H = shown.h * z;
      offscreen.width = shown.w; offscreen.height = shown.h; offscreen.getContext('2d').putImageData(shown.img, 0, 0);
      if (S.tile) { /* the eight neighbours, dimmed, so seams show */
        g.globalAlpha = 0.45; for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if (i || j) g.drawImage(offscreen, S.ox + i * W, S.oy + j * H, W, H); g.globalAlpha = 1;
      }
      /* checkerboard behind transparent pixels, one square per 2 art pixels at low zoom */
      const cs = Math.max(8, z * 2 > 16 ? z : 16), ck = bgColors(), lightBg = luma(ck[0]) > 0.55;
      g.save(); g.beginPath(); g.rect(S.ox, S.oy, W, H); g.clip();
      for (let y = 0; y * cs < H; y++) for (let x = 0; x * cs < W; x++) { g.fillStyle = (x + y) % 2 ? ck[0] : ck[1]; g.fillRect(S.ox + x * cs, S.oy + y * cs, cs, cs); }
      const f = frameSize(d), multi = f && (f.w < d.w || f.h < d.h);
      if (S.onion && multi) { /* each frame shows the one before it, faintly, underneath */
        const cols = Math.floor(d.w / f.w), rows = Math.floor(d.h / f.h); g.globalAlpha = 0.28;
        for (let k = 1; k < cols * rows; k++) { const sx = ((k - 1) % cols) * f.w, sy = Math.floor((k - 1) / cols) * f.h, dx = (k % cols) * f.w, dy = Math.floor(k / cols) * f.h; g.drawImage(offscreen, sx, sy, f.w, f.h, S.ox + dx * z, S.oy + dy * z, f.w * z, f.h * z); }
        g.globalAlpha = 1;
      }
      const fam = !multi && S.onion ? famFor(d) : null, fi = fam ? fam.members.indexOf(d.path) : -1;
      if (fi > 0) { const prev = memberImage(fam.members[fi - 1]); if (prev) { g.globalAlpha = 0.28; g.drawImage(prev, S.ox, S.oy, prev.width * z, prev.height * z); g.globalAlpha = 1; offscreen.width = shown.w; offscreen.height = shown.h; offscreen.getContext('2d').putImageData(shown.img, 0, 0); } }
      if (S.ref && S.ref.visible && !S.ref.over) drawRef(W, H);
      g.drawImage(offscreen, S.ox, S.oy, W, H);
      if (S.ref && S.ref.visible && S.ref.over) drawRef(W, H);
      g.restore();
      if (S.changes && !S.peek && d.base.w === d.w && d.base.h === d.h) { /* dim what is untouched, outline what changed */
        const base = d.base.px, mask = new Uint32Array(d.w * d.h), dim = pack(7, 4, 13, 175), cells = [];
        for (let i = 0; i < mask.length; i++) if (d.px[i] === base[i]) mask[i] = dim; else cells.push(i);
        diffCanvas.width = d.w; diffCanvas.height = d.h; diffCanvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(mask.buffer), d.w, d.h), 0, 0);
        g.drawImage(diffCanvas, S.ox, S.oy, W, H);
        if (z >= 3 && cells.length < 20000) { g.strokeStyle = '#e08cff'; g.lineWidth = Math.max(1, Math.floor(z / 8)); for (const i of cells) g.strokeRect(S.ox + (i % d.w) * z + 0.5, S.oy + ((i / d.w) | 0) * z + 0.5, z - 1, z - 1); g.lineWidth = 1; }
      }
      if (S.ctx) drawContext(d);
      if (S.peek) { g.fillStyle = 'rgba(224,140,255,.9)'; g.font = `${Math.round(12 * (window.devicePixelRatio || 1))}px ${getComputedStyle(root).getPropertyValue('--pf-mono') || 'monospace'}`; g.fillText('BEFORE', S.ox, S.oy - 8); }
      const fl = S.float;
      if (fl) { const t = document.createElement('canvas'); t.width = fl.w; t.height = fl.h; t.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(fl.px.buffer.slice(0)), fl.w, fl.h), 0, 0); g.drawImage(t, S.ox + fl.x * z, S.oy + fl.y * z, fl.w * z, fl.h * z); }
      if (overlay) { g.globalAlpha = 0.9; for (const [x, y] of overlay.pts) { g.fillStyle = isClear(overlay.value) ? 'rgba(255,255,255,.35)' : toHex(overlay.value); g.fillRect(S.ox + x * z, S.oy + y * z, z, z); } g.globalAlpha = 1; }
      if (S.grid && z >= 6) {
        g.strokeStyle = lightBg ? 'rgba(20,10,40,.16)' : 'rgba(230,220,247,.09)'; g.lineWidth = 1; g.beginPath();
        for (let x = 0; x <= d.w; x++) { g.moveTo(S.ox + x * z + .5, S.oy); g.lineTo(S.ox + x * z + .5, S.oy + H); }
        for (let y = 0; y <= d.h; y++) { g.moveTo(S.ox, S.oy + y * z + .5); g.lineTo(S.ox + W, S.oy + y * z + .5); }
        g.stroke();
      }
      if (multi) { g.strokeStyle = 'rgba(255,176,0,.6)'; g.beginPath(); for (let x = f.w; x < d.w; x += f.w) { g.moveTo(S.ox + x * z + .5, S.oy); g.lineTo(S.ox + x * z + .5, S.oy + H); } for (let y = f.h; y < d.h; y += f.h) { g.moveTo(S.ox, S.oy + y * z + .5); g.lineTo(S.ox + W, S.oy + y * z + .5); } g.stroke(); }
      g.strokeStyle = 'rgba(185,140,255,.55)'; g.lineWidth = 1; g.strokeRect(S.ox - .5, S.oy - .5, W + 1, H + 1);
      g.strokeStyle = 'rgba(224,140,255,.75)';
      if (S.mx) { g.beginPath(); g.moveTo(S.ox + W / 2, S.oy); g.lineTo(S.ox + W / 2, S.oy + H); g.stroke(); }
      if (S.my) { g.beginPath(); g.moveTo(S.ox, S.oy + H / 2); g.lineTo(S.ox + W, S.oy + H / 2); g.stroke(); }
      if (S.sel) { /* marching ants, without the marching */
        const r = [S.ox + S.sel.x * z + .5, S.oy + S.sel.y * z + .5, S.sel.w * z - 1, S.sel.h * z - 1];
        g.setLineDash([4, 4]); g.strokeStyle = '#000'; g.strokeRect(...r); g.lineDashOffset = 4; g.strokeStyle = '#fff'; g.strokeRect(...r); g.setLineDash([]); g.lineDashOffset = 0;
      }
      const hv = S.hover;
      if (hv && !drag && (S.tool === 'pen' || S.tool === 'erase' || S.tool === 'shade') && z >= 3) { /* brush footprint */
        g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = 1;
        for (const [ox, oy] of brushOffsets(S.size, S.shape)) { const c = cell(d, hv.x + ox, hv.y + oy); if (c) g.strokeRect(S.ox + c[0] * z + .5, S.oy + c[1] * z + .5, z - 1, z - 1); }
      }
    }
    /* In context: the sprite at game scale on the project's background, standing next to its neighbours from the same folder
       (one per family, nearest by name), so size, silhouette and contrast are judged as a player sees them. Live while drawing. */
    function drawContext(d) {
      const cv = $('.pf-ctx-cv'), dpr = window.devicePixelRatio || 1, W = Math.max(1, Math.round(cv.clientWidth * dpr)), H = Math.max(1, Math.round(cv.clientHeight * dpr));
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
      const k = cv.getContext('2d'), sc = S.ctxScale * Math.max(1, Math.round(dpr)), ground = H - Math.round(14 * dpr), gap = Math.round(12 * dpr);
      k.imageSmoothingEnabled = false; k.fillStyle = projectBg() || bgColors()[0]; k.fillRect(0, 0, W, H);
      k.fillStyle = luma(projectBg() || bgColors()[0]) > 0.55 ? 'rgba(20,10,40,.25)' : 'rgba(230,220,247,.18)'; k.fillRect(0, ground, W, Math.max(1, Math.round(dpr)));
      const cur = document.createElement('canvas'); cur.width = d.w; cur.height = d.h; cur.getContext('2d').putImageData(d.imageData(), 0, 0);
      const fam = famOf.get(d.path), dir = d.path.includes('/') ? d.path.slice(0, d.path.lastIndexOf('/')) : '';
      const sameDir = [...new Set(S.sprites.map((x) => x.path).filter((p) => p !== d.path && (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '') === dir && (!fam || !fam.members.includes(p))).map((p) => { const f = famOf.get(p); return f ? f.members[0] : p; }))];
      sameDir.sort((a, b) => a.localeCompare(b)); const at = sameDir.findIndex((p) => p.localeCompare(d.path) > 0), ordered = at < 0 ? sameDir.slice().reverse() : [...sameDir.slice(at), ...sameDir.slice(0, at).reverse()];
      const items = [{ img: cur, me: true }]; let used = d.w * sc + gap * 2, shown = 0;
      for (const p of ordered) { const img = memberImage(p); if (!img) continue; if (used + img.width * sc + gap > W) break; used += img.width * sc + gap; items.push({ img }); shown++; if (shown >= 8) break; }
      // the edited sprite in the middle, neighbours alternating left and right of it
      const row = [items[0]]; items.slice(1).forEach((it, i) => (i % 2 ? row.unshift(it) : row.push(it)));
      let x = Math.round((W - row.reduce((a, it) => a + it.img.width * sc, 0) - gap * (row.length - 1)) / 2);
      for (const it of row) {
        const w = it.img.width * sc, h = it.img.height * sc;
        k.drawImage(it.img, x, ground - h, w, h);
        if (it.me) { k.fillStyle = '#e08cff'; k.fillRect(x, ground + Math.round(4 * dpr), w, Math.max(1, Math.round(2 * dpr))); }
        x += w + gap;
      }
      $('.pf-ctx-note').textContent = `${S.ctxScale}× · ${shown ? shown + ' neighbour' + (shown > 1 ? 's' : '') + ' from ' + (dir || 'the project root') : 'no other sprites in this folder'} · ${projectBg() ? 'project background' : 'background ' + bgColors()[0]}`;
    }
    /* reference image: traced over or compared against, never saved */
    function drawRef(W, H) {
      const r = S.ref, z = S.zoom; g.save(); g.globalAlpha = r.opacity;
      if (r.fit === 'fit') { const k = Math.min(W / r.img.width, H / r.img.height), w = r.img.width * k, h = r.img.height * k; g.imageSmoothingEnabled = !r.pixel; g.drawImage(r.img, S.ox + (W - w) / 2, S.oy + (H - h) / 2, w, h); }
      else { g.imageSmoothingEnabled = false; g.drawImage(r.img, S.ox, S.oy, r.img.width * z, r.img.height * z); }
      g.restore();
    }
    function status() {
      const d = doc();
      $('.pf-s-name').innerHTML = d ? `<b>${esc(d.path)}</b>${d.unsaved ? ' · <span class="pf-bad">unsaved</span>' : d.changed ? ' · saved, not yet in a PR' : ''}${d.changed ? ` · <span class="pf-s-peek" title="Press and hold (or hold \\) to see the original">${d.changedPixels()} px changed · hold \\ for before</span>` : ''}` : 'No sprite open';
      $('.pf-s-info').innerHTML = d ? `${d.w}×${d.h} · zoom ${S.zoom}×${S.notice ? ' · ' + esc(S.notice) : ''}` : esc(S.notice);
      $('.pf-zl').textContent = S.zoom + '×'; $('.pf-s-sel').textContent = S.sel ? `selection ${S.sel.w}×${S.sel.h}${S.float ? ' · floating' : ''}` : '';
      $('.pf-undo').disabled = !d || !d.undo.length; $('.pf-redo').disabled = !d || !d.redo.length; $('.pf-save').disabled = !d;
      $('.pf-prbtn').hidden = !O.pr; $('.pf-prbtn').disabled = ![...S.docs.values()].some((x) => x.changed);
    }

    /* ---------- editing ---------- */
    function setTool(t) {
      if (t !== S.tool && S.float) commitFloat();
      S.tool = t; const rail = railOf(t);
      $$('.pf-tools button').forEach((b) => b.classList.toggle('on', b.dataset.t === rail));
      $$('.pf-opt').forEach((o) => { const f = o.dataset.for.split(' '); o.hidden = !(f.includes('*') || f.includes(t)); });
      $$('.pf-filled button').forEach((b) => b.classList.toggle('on', (b.dataset.filled === '1') === (t === 'rectf' || t === 'ellipsef')));
      view.style.cursor = t === 'select' ? 'default' : 'crosshair'; render();
    }
    $('.pf-tools').innerHTML = TOOLS.filter((x) => !x[3]).map(([k, n, key]) => `<button data-t="${k}" title="${n} (${key})" aria-label="${n}">${icon(k)}</button>`).join('');
    $('.pf-keys').innerHTML = KEYS.map(([k, v]) => `<div class="pf-key"><kbd>${esc(k)}</kbd><span>${esc(v)}</span></div>`).join('');
    const changedUi = () => { renderColors(); status(); renderListSoon(); drawPreview(); render(); renderFamilySoon(); };
    let famTimer = 0; const renderFamilySoon = () => { clearTimeout(famTimer); famTimer = setTimeout(renderFamily, 150); };
    let listTimer = 0; const renderListSoon = () => { clearTimeout(listTimer); listTimer = setTimeout(renderList, 120); };
    /** Where a pixel lands: wrapped around the edges in tile mode, else null when outside the image. */
    const cell = (d, x, y) => { if (S.tile) return [((x % d.w) + d.w) % d.w, ((y % d.h) + d.h) % d.h]; return x >= 0 && y >= 0 && x < d.w && y < d.h ? [x, y] : null; };
    /** A position plus its mirror images. */
    const mirrored = (d, x, y) => { const out = [[x, y]]; if (S.mx) out.push([d.w - 1 - x, y]); if (S.my) out.push([x, d.h - 1 - y]); if (S.mx && S.my) out.push([d.w - 1 - x, d.h - 1 - y]); return out; };
    const mirrorPts = (d, pts) => pts.flatMap(([x, y]) => mirrored(d, x, y));
    /** Set one pixel (with mirrors and tile wrap), remembering the old value once per stroke. */
    function put(d, x, y, v, rec) {
      for (const [mx, my] of mirrored(d, x, y)) { const c = cell(d, mx, my); if (!c) continue; const i = c[1] * d.w + c[0]; if (rec && !rec.has(i)) rec.set(i, d.px[i]); d.px[i] = v; }
    }
    /** One brush dab at (x,y): size, tip shape, dither pattern and the shade tool all go through here. */
    function dab(d, x, y, drag) {
      for (const [ox, oy] of brushOffsets(drag.tool === 'pen' || drag.tool === 'erase' || drag.tool === 'shade' ? S.size : 1, S.shape)) {
        const X = x + ox, Y = y + oy;
        if (drag.tool === 'shade') {
          for (const [mx, my] of mirrored(d, X, Y)) { const c = cell(d, mx, my); if (!c) continue; const i = c[1] * d.w + c[0]; if (drag.rec.has(i)) continue; drag.rec.set(i, d.px[i]); d.px[i] = shadeColor(d.px[i], drag.dir, S.palette); }
        } else if (drag.tool === 'pen' && S.pattern === 'dither') { const c = cell(d, X, Y); if (c && ditherOn(c[0], c[1])) put(d, X, Y, drag.value, drag.rec); }
        else put(d, X, Y, drag.value, drag.rec);
      }
    }
    const shapePts = (tool, a, b) => tool === 'line' ? linePoints(a.x, a.y, b.x, b.y) : tool === 'rect' || tool === 'rectf' ? rectPoints(a.x, a.y, b.x, b.y, tool === 'rectf') : ellipsePoints(a.x, a.y, b.x, b.y, tool === 'ellipsef');
    const isShape = (t) => t === 'line' || t === 'rect' || t === 'rectf' || t === 'ellipse' || t === 'ellipsef';
    function fillAt(d, x, y, value, other) {
      const tmp = d.px.slice(), seeds = mirrored(d, x, y).map(([a, b]) => cell(d, a, b)).filter(Boolean), region = new Set();
      for (const [sx, sy] of seeds) { const probe = d.px.slice(), mark = (probe[sy * d.w + sx] ^ 0x5a5a5a5a) >>> 0; for (const i of S.fillMode === 'same' ? fillSame(probe, sx, sy, d.w, mark) : floodFill(probe, d.w, d.h, sx, sy, mark)) region.add(i); }
      for (const i of region) { const on = S.pattern !== 'dither' || ditherOn(i % d.w, (i / d.w) | 0); if (on) tmp[i] = value; else if (other != null && !isClear(other)) tmp[i] = other; }
      if (countDiff(tmp, d.px) === 0) return false; d.px = tmp; return true;
    }
    function pickAt(d, c, secondary) {
      const p = cell(d, c.x, c.y); if (!p) return; const v = d.px[p[1] * d.w + p[0]];
      if (secondary) { S.color2 = isClear(v) ? 0 : v; renderColors(); return; }
      if (isClear(v)) setTool('erase'); else { setColor(v); setTool('pen'); }
    }

    /* selection: S.sel is the selected rectangle; S.float holds lifted or pasted pixels that move with it until they are applied */
    function liftSelection() {
      const d = doc(); if (!d || !S.sel || S.float) return;
      d.snapshot(); const px = copyRect(d.px, d.w, d.h, S.sel);
      for (let y = 0; y < S.sel.h; y++) for (let x = 0; x < S.sel.w; x++) d.px[(S.sel.y + y) * d.w + S.sel.x + x] = 0;
      S.float = { px, w: S.sel.w, h: S.sel.h, x: S.sel.x, y: S.sel.y };
    }
    function commitFloat() {
      const d = doc(), f = S.float; if (!f) return; S.float = null;
      if (d) { pasteRect(d.px, d.w, d.h, f.px, f.w, f.h, f.x, f.y, false); S.sel = rectBetween({ x: f.x, y: f.y }, { x: f.x + f.w - 1, y: f.y + f.h - 1 }, d.w, d.h); changedUi(); }
    }
    function dropSelection() { commitFloat(); S.sel = null; render(); status(); }
    function selectAll() { const d = doc(); if (!d) return; commitFloat(); S.sel = { x: 0, y: 0, w: d.w, h: d.h }; if (S.tool !== 'select') setTool('select'); render(); status(); }
    function copySel(cut) {
      const d = doc(); if (!d || !S.sel && !S.float) return false;
      S.clip = S.float ? { px: S.float.px.slice(), w: S.float.w, h: S.float.h } : { px: copyRect(d.px, d.w, d.h, S.sel), w: S.sel.w, h: S.sel.h };
      if (cut) { if (S.float) { S.float = null; S.sel = null; changedUi(); } else { d.snapshot(); for (let y = 0; y < S.sel.h; y++) for (let x = 0; x < S.sel.w; x++) d.px[(S.sel.y + y) * d.w + S.sel.x + x] = 0; S.sel = null; changedUi(); } }
      note((cut ? 'cut ' : 'copied ') + S.clip.w + '×' + S.clip.h); return true;
    }
    function pastePx(px, w, h) {
      const d = doc(); if (!d) return; commitFloat(); d.snapshot();
      const x = S.sel ? S.sel.x : 0, y = S.sel ? S.sel.y : 0;
      S.float = { px: px.slice(), w, h, x, y }; S.sel = { x, y, w, h }; if (S.tool !== 'select') { S.tool = 'select'; setTool('select'); } changedUi(); note('pasted ' + w + '×' + h + ': drag to place, Enter to apply');
    }
    function deleteSel() { const d = doc(); if (!d) return; if (S.float) { S.float = null; S.sel = null; changedUi(); return; } if (!S.sel) return; edit((dd) => { for (let y = 0; y < S.sel.h; y++) for (let x = 0; x < S.sel.w; x++) dd.px[(S.sel.y + y) * dd.w + S.sel.x + x] = 0; }); }
    function nudge(dx, dy) { if (!S.sel) return false; liftSelection(); S.float.x += dx; S.float.y += dy; S.sel = { ...S.sel, x: S.float.x, y: S.float.y }; render(); status(); return true; }
    /** Flip or rotate the selection instead of the whole image when there is one. */
    function transformSel(fn) { if (!S.sel) return false; liftSelection(); const f = S.float, r = fn(f.px, f.w, f.h); f.px = r.px; f.w = r.w; f.h = r.h; S.sel = { x: f.x, y: f.y, w: f.w, h: f.h }; changedUi(); return true; }
    const inSel = (c) => S.sel && c.x >= S.sel.x && c.y >= S.sel.y && c.x < S.sel.x + S.sel.w && c.y < S.sel.y + S.sel.h;

    let drag = null, pan = null, space = false; const pointers = new Map(); let pinch = null;
    view.addEventListener('contextmenu', (e) => e.preventDefault());
    view.addEventListener('pointerdown', (e) => {
      const d = doc(); if (!d) return; view.setPointerCapture(e.pointerId); pointers.set(e.pointerId, e);
      if (pointers.size === 2) { drag = null; overlay = null; const [a, b] = [...pointers.values()]; pinch = { dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), zoom: S.zoom, cx: (a.clientX + b.clientX) / 2, cy: (a.clientY + b.clientY) / 2 }; return; }
      if (e.button === 1 || space || (e.button === 0 && e.shiftKey && e.altKey)) { pan = { x: e.clientX, y: e.clientY, ox: S.ox, oy: S.oy }; return; }
      const c = toCell(e), right = e.button === 2, inb = !!cell(d, c.x, c.y);
      let tool = S.tool;
      if (e.altKey && tool !== 'select') tool = 'pick';
      if (tool === 'pick') { pickAt(d, c, right); return; }
      if (tool === 'select') {
        if (inSel(c)) { liftSelection(); drag = { tool, move: true, start: c, fx: S.float.x, fy: S.float.y }; }
        else { commitFloat(); drag = { tool, start: c }; S.sel = rectBetween(c, c, d.w, d.h); render(); }
        status(); return;
      }
      let value = right ? S.color2 : S.color; if (tool === 'erase') value = 0;
      if (!inb && !isShape(tool)) return;
      d.snapshot(); drag = { tool, value, dir: right ? -1 : 1, start: c, last: c, rec: new Map(), trail: [c], visits: new Map([[c.y * d.w + c.x, 1]]), moved: false };
      if (tool === 'fill') { if (!fillAt(d, c.x, c.y, value, right ? S.color : S.color2)) d.undo.pop(); drag = null; changedUi(); return; }
      if (tool === 'pen' && e.shiftKey && S.lastPt) { for (const [x, y] of linePoints(S.lastPt.x, S.lastPt.y, c.x, c.y)) dab(d, x, y, drag); }
      else if (!isShape(tool)) dab(d, c.x, c.y, drag);
      changedUi();
    });
    view.addEventListener('pointermove', (e) => {
      const d = doc(); if (!d) return;
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, e);
      if (pinch && pointers.size === 2) { const [a, b] = [...pointers.values()]; const nd = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); const r = view.getBoundingClientRect(), dpr = view.width / r.width; const z = Math.max(1, Math.min(64, Math.round(pinch.zoom * nd / pinch.dist))); if (z !== S.zoom) { const cx = (pinch.cx - r.left) * dpr, cy = (pinch.cy - r.top) * dpr, px = (cx - S.ox) / S.zoom, py = (cy - S.oy) / S.zoom; S.zoom = z; S.ox = Math.round(cx - px * z); S.oy = Math.round(cy - py * z); render(); status(); } return; }
      if (pan) { S.touched = true; const r = view.getBoundingClientRect(), dpr = view.width / r.width; S.ox = Math.round(pan.ox + (e.clientX - pan.x) * dpr); S.oy = Math.round(pan.oy + (e.clientY - pan.y) * dpr); render(); return; }
      const c = toCell(e), p = cell(d, c.x, c.y);
      $('.pf-s-pos').textContent = p ? `x ${p[0]}  y ${p[1]}  ${toHex(d.px[p[1] * d.w + p[0]])}${isClear(d.px[p[1] * d.w + p[0]]) ? ' (clear)' : ''}` : '';
      const hovered = !S.hover || S.hover.x !== c.x || S.hover.y !== c.y; S.hover = c;
      if (!drag) { if (hovered && (S.tool === 'pen' || S.tool === 'erase' || S.tool === 'shade')) render(); return; }
      if (drag.tool === 'select') {
        if (drag.move) { S.float.x = drag.fx + c.x - drag.start.x; S.float.y = drag.fy + c.y - drag.start.y; S.sel = { x: S.float.x, y: S.float.y, w: S.float.w, h: S.float.h }; }
        else S.sel = rectBetween(drag.start, c, d.w, d.h);
        render(); status(); return;
      }
      if (drag.tool === 'pen' || drag.tool === 'erase' || drag.tool === 'shade') {
        for (const [x, y] of linePoints(drag.last.x, drag.last.y, c.x, c.y).slice(1)) {
          dab(d, x, y, drag); drag.trail.push({ x, y }); const vk = y * d.w + x; drag.visits.set(vk, (drag.visits.get(vk) || 0) + 1);
          if (S.pp && drag.tool === 'pen' && S.size === 1 && S.pattern === 'solid' && drag.trail.length >= 3) { /* pixel-perfect: drop the middle pixel of an L-shaped corner */
            const [p1, p2, p3] = drag.trail.slice(-3), i = p2.y * d.w + p2.x;
            // only a corner this stroke has just made: never a pixel it already drew earlier (going back over your own stroke must not erase it)
            if (Math.abs(p3.x - p1.x) === 1 && Math.abs(p3.y - p1.y) === 1 && (p2.x === p1.x || p2.y === p1.y) && !(S.mx || S.my || S.tile) && drag.visits.get(i) === 1) { if (drag.rec.has(i)) d.px[i] = drag.rec.get(i); drag.visits.delete(i); drag.trail.splice(-2, 1); }
          }
        }
        drag.last = c; changedUi();
      } else if (isShape(drag.tool)) { // shapes: preview only until release
        const b = e.shiftKey ? constrain(drag.start, c, drag.tool === 'line' ? 'line' : 'box') : c;
        let pts = mirrorPts(d, shapePts(drag.tool, drag.start, b)).map(([x, y]) => cell(d, x, y)).filter(Boolean);
        if (S.pattern === 'dither') pts = pts.filter(([x, y]) => ditherOn(x, y));
        overlay = { pts, value: drag.value }; drag.last = c; drag.moved = true; render();
      }
    });
    const end = (e) => {
      pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; pan = null;
      const d = doc(); if (!drag || !d) return;
      if (drag.tool === 'select') { if (!drag.move && S.sel && S.sel.w * S.sel.h <= 1 && drag.start.x === (S.hover || drag.start).x && drag.start.y === (S.hover || drag.start).y) S.sel = null; drag = null; render(); status(); return; }
      if (overlay) { for (const [x, y] of overlay.pts) d.px[y * d.w + x] = overlay.value; overlay = null; }
      else if (isShape(drag.tool) && !drag.moved) { const c = cell(d, drag.start.x, drag.start.y); if (c) d.px[c[1] * d.w + c[0]] = drag.value; }
      if (drag.tool === 'pen' || drag.tool === 'erase') S.lastPt = drag.last;
      const same = !d.undo.length || countDiff(d.undo[d.undo.length - 1].px, d.px) === 0 && d.undo[d.undo.length - 1].w === d.w; if (same) d.undo.pop();
      drag = null; changedUi();
    };
    view.addEventListener('pointerup', end); view.addEventListener('pointercancel', end);
    view.addEventListener('pointerleave', () => { if (!drag && S.hover) { S.hover = null; render(); } });
    view.addEventListener('wheel', (e) => { e.preventDefault(); const r = view.getBoundingClientRect(), dpr = view.width / r.width; zoomAt(e.deltaY < 0 ? 1.25 : 0.8, (e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr); status(); }, { passive: false });
    setTool('pen');

    /* ---------- operations ---------- */
    function edit(fn) { const d = doc(); if (!d) return; d.snapshot(); fn(d); changedUi(); }
    const undo = () => { const d = doc(); if (!d) return; S.float = null; S.sel = null; if (d.undoOnce()) { if (!S.touched) fit(); changedUi(); } else render(); };
    const redo = () => { const d = doc(); if (!d) return; commitFloat(); S.sel = null; if (d.redoOnce()) { if (!S.touched) fit(); changedUi(); } };

    /* ---------- saving & exporting ---------- */
    async function pngOf(d, scale = 1) {
      if (hasStreams()) return new Blob([await encodePngBytes(d.w, d.h, d.px, scale)], { type: 'image/png' });
      const c = document.createElement('canvas'); drawPx(c, d, scale); return toBlob(c);
    }
    async function save() {
      const d = doc(); if (!d) return; commitFloat();
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
    /* Families (poses, variants, numbered animation frames in separate files): any member as something drawable.
       An open document wins, so edits show up in the strip, the flipbook and the onion skin straight away. */
    const famFor = (d) => { const f = d && famOf.get(d.path); return f && f.members.length > 1 ? f : null; };
    const pending = new Set();
    function memberImage(path) {
      const d = S.docs.get(path);
      if (d) { const c = document.createElement('canvas'); c.width = d.w; c.height = d.h; c.getContext('2d').putImageData(d.imageData(), 0, 0); return c; }
      const bm = thumbs.get(path); if (bm) return bm;
      if (S.src && !pending.has(path)) {
        pending.add(path); const src = S.src;
        src.read(path).then((b) => createImageBitmap(new Blob([b], { type: 'image/png' }))).then((bm2) => { if (S.src !== src) return; thumbs.set(path, bm2); renderFamily(); drawPreview(); render(); }).catch(() => {}).finally(() => pending.delete(path));
      }
      return null;
    }
    const memberLabel = (fam, p) => { const r = p.split('/').pop().replace(/\.png$/i, '').slice(fam.key.length).replace(/^[_-]/, ''); return r || 'base'; };
    function renderFamily() {
      const d = doc(), fam = famFor(d), box = $('.pf-fam'); box.hidden = !fam; if (!fam) return;
      const at = fam.members.indexOf(d.path); $('.pf-fam-left').disabled = at <= 0; $('.pf-fam-right').disabled = at >= fam.members.length - 1;
      $('.pf-fam-name').textContent = fam.key; $('.pf-fam-kind').textContent = fam.animated ? `animation · ${fam.members.length} frames` : `${fam.members.length} poses / variants`;
      const strip = $('.pf-fam-strip'); strip.innerHTML = '';
      for (const p of fam.members) {
        const b = el(`<button class="pf-fam-m${p === S.cur ? ' on' : ''}" data-path="${esc(p)}" role="option" title="${esc(p)}"><canvas></canvas><span>${esc(memberLabel(fam, p))}</span></button>`);
        strip.appendChild(b); const img = memberImage(p), c = b.querySelector('canvas');
        if (img) { c.width = img.width; c.height = img.height; const k = c.getContext('2d'); k.imageSmoothingEnabled = false; k.drawImage(img, 0, 0); }
      }
    }
    function stepMember(dir) { const d = doc(), fam = famFor(d); if (!fam) return; const i = fam.members.indexOf(d.path); openSprite(fam.members[(i + dir + fam.members.length) % fam.members.length]); }
    function drawPreview() {
      const d = doc(); if (!d) return; const p1 = $('.pf-p1'), p2 = $('.pf-p2');
      drawPx(p1, d, d.w <= 32 ? 2 : 1);
      const sheet = frameSize(d), fam = famFor(d);
      const flip = !!fam && !(sheet.w < d.w || sheet.h < d.h); p1.hidden = flip; $('.pf-sheet-row').hidden = flip;
      if (flip) { // flipbook through the family's images
        const i = S.anim.timer ? S.anim.t % fam.members.length : fam.members.indexOf(d.path), img = memberImage(fam.members[i]);
        $$('.pf-fam-m').forEach((b, k) => b.classList.toggle('playing', !!S.anim.timer && k === i));
        const w = img ? img.width : d.w, h = img ? img.height : d.h, sc = Math.max(1, Math.min(8, Math.floor(190 / Math.max(w, h))));
        p2.width = w * sc; p2.height = h * sc; const k = p2.getContext('2d'); k.imageSmoothingEnabled = false; k.clearRect(0, 0, p2.width, p2.height);
        if (img) k.drawImage(img, 0, 0, w * sc, h * sc);
        return;
      }
      const f = sheet, cols = Math.max(1, Math.floor(d.w / f.w)), rows = Math.max(1, Math.floor(d.h / f.h)), n = cols * rows, i = S.anim.t % n;
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
      commitFloat(); const changed = [...S.docs.values()].filter((d) => d.changed); if (!changed.length) return;
      const gh = S.meta.repo || {}, dlg = $('.pf-dlg-pr');
      $('.pf-pr-repo').value = $('.pf-pr-repo').value || gh.slug || gh.repo || ''; $('.pf-pr-base').value = $('.pf-pr-base').value || gh.base || gh.branch || '';
      $('.pf-pr-title').value = $('.pf-pr-title').value || (changed.length === 1 ? 'Update ' + changed[0].path.split('/').pop() : 'Update ' + changed.length + ' sprites');
      if (!S.auth.token) try { $('.pf-pr-token').value = $('.pf-pr-token').value || sessionStorage.getItem('pf:token') || localStorage.getItem('pf:token') || ''; } catch { /* storage blocked */ }
      $('.pf-chg-list').innerHTML = changed.map((d) => `<div class="pf-chg"><canvas data-b="${esc(d.path)}" title="before"></canvas><i class="pf-arrow">→</i><canvas data-p="${esc(d.path)}" title="after"></canvas><span>${esc(d.path)}<br><span class="pf-note">${d.w}×${d.h} · ${d.changedPixels()} px changed</span></span></div>`).join('');
      $$('.pf-chg canvas[data-p]').forEach((c) => drawPx(c, S.docs.get(c.dataset.p)));
      $$('.pf-chg canvas[data-b]').forEach((c) => { const b = S.docs.get(c.dataset.b).base; drawPx(c, { w: b.w, h: b.h, imageData: () => new ImageData(new Uint8ClampedArray(b.px.buffer.slice(0)), b.w, b.h) }); });
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
        const files = [], previews = [];
        for (const d of changed) {
          const sc = previewScale(Math.max(d.w, d.base.w), Math.max(d.h, d.base.h)); // one scale for both sides so they compare 1:1
          files.push({ path: d.path, blob: await pngOf(d), w: d.w, h: d.h, pixels: d.changedPixels(), scale: sc, baseW: d.base.w, isNew: !!(d.local || d.isNew) });
          previews.push({ before: d.local || d.isNew ? null : await pngOf(new Doc(d.path, d.base.w, d.base.h, d.base.px), sc), after: await pngOf(d, sc) });
        }
        const prefix = (S.meta.repo && S.meta.repo.prefix) || '';
        const res = await createPullRequest({ token, repo, base: $('.pf-pr-base').value.trim() || undefined, prefix, title, apiBase: O.apiBase, files: files.map((f) => ({ path: f.path, blob: f.blob })), previews, branch: 'art/' + slug(title) + '-' + Date.now().toString(36),
          body: (ctx) => prBody({ files, repo, prefix, description: $('.pf-pr-desc').value.trim(), baseSha: ctx.baseSha, commit: ctx.commit, headRepo: ctx.headRepo, previewSha: ctx.previewSha, previewDir: ctx.previewDir }), onProgress: (m) => { log.textContent += m + '\n'; log.scrollTop = log.scrollHeight; } });
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
      if (t.classList.contains('pf-dir')) return toggleDir(t.dataset.dir);
      if (t.classList.contains('pf-hidden-toggle')) { const hid = S.src.hidden || []; if (S.sprites.some((x) => x.hiddenByDefault)) S.sprites = S.sprites.filter((x) => !x.hiddenByDefault); else S.sprites = S.sprites.concat(hid.map((x) => ({ ...x, hiddenByDefault: true }))); return renderList(); }
      if (t.classList.contains('pf-fam-m')) return openSprite(t.dataset.path);
      if (t.dataset.c !== undefined && t.closest('.pf-sw')) return e.shiftKey ? setColor2(+t.dataset.c) : setColor(+t.dataset.c);
      if (t.dataset.d) { const [dx, dy] = t.dataset.d.split(',').map(Number); return edit((d) => { d.px = shiftWrap(d.px, d.w, d.h, dx, dy); }); }
    });
    root.addEventListener('contextmenu', (e) => { const t = e.target.closest('.pf-sw button[data-c]'); if (t) { e.preventDefault(); setColor2(+t.dataset.c); } });
    $('.pf-q').oninput = renderList;
    /* background behind transparent pixels: a menu on the Background button, K cycles, the choice is remembered */
    const projectBg = () => { const b = O.background || (S.src && S.src.background); return typeof b === 'string' && fromHex(b) != null ? toHex(fromHex(b)) : null; };
    const bgModes = () => BACKGROUNDS.filter(([m]) => m !== 'project' || projectBg());
    const bgMode = () => (S.bg === 'auto' || (S.bg === 'project' && !projectBg()) ? (projectBg() ? 'project' : 'dark') : S.bg);
    function bgColors() {
      const m = bgMode();
      if (m === 'light') return ['#d6d6de', '#f2f2f6'];
      if (m === 'black') return ['#000000', '#000000'];
      if (m === 'white') return ['#ffffff', '#ffffff'];
      if (m === 'custom') return [S.bgCustom, S.bgCustom];
      if (m === 'project') return [projectBg(), projectBg()];
      return ['#1c1530', '#130e22'];
    }
    function applyBg() {
      const [a, b] = bgColors(); root.style.setProperty('--pf-ck1', a); root.style.setProperty('--pf-ck2', b);
      $('.pf-bg').title = 'Background: ' + BACKGROUNDS.find(([m]) => m === bgMode())[1].toLowerCase() + ' (K cycles)'; render();
      const menu = root.querySelector('.pf-bgmenu'); if (menu) menu.querySelectorAll('[data-bg]').forEach((x) => x.classList.toggle('on', x.dataset.bg === bgMode()));
    }
    function setBg(mode, custom) { S.bg = mode; if (custom) S.bgCustom = custom; try { localStorage.setItem('pf:bg', JSON.stringify({ mode, custom: S.bgCustom })); } catch { /* not remembered */ } applyBg(); }
    try { const saved = JSON.parse(localStorage.getItem('pf:bg') || 'null'); if (saved) { S.bg = saved.mode || 'auto'; if (fromHex(saved.custom || '') != null) S.bgCustom = saved.custom; } } catch { /* defaults */ }
    const swatchCss = (m) => { const [a, b] = m === 'dark' ? ['#1c1530', '#130e22'] : m === 'light' ? ['#d6d6de', '#f2f2f6'] : m === 'black' ? ['#000', '#000'] : m === 'white' ? ['#fff', '#fff'] : m === 'custom' ? [S.bgCustom, S.bgCustom] : [projectBg(), projectBg()]; return `background:repeating-conic-gradient(${a} 0 25%,${b} 0 50%) 0 0/8px 8px`; };
    function closeBgMenu() { const m = root.querySelector('.pf-bgmenu'); if (m) m.remove(); }
    function openBgMenu() {
      closeBgMenu();
      const menu = el(`<div class="pf-bgmenu" role="menu">${bgModes().map(([m, n]) => `<button role="menuitemradio" data-bg="${m}"><span class="pf-bg-sw" style="${swatchCss(m)}"></span>${esc(n)}${m === 'project' ? ` <span class="pf-note">${esc(projectBg())}</span>` : ''}</button>`).join('')}<label>custom <input type="color" class="pf-bgcustom" value="${esc(S.bgCustom)}"></label></div>`);
      root.appendChild(menu);
      const b = $('.pf-bg').getBoundingClientRect(), r = root.getBoundingClientRect();
      menu.style.left = Math.max(4, Math.min(b.left - r.left, r.width - menu.offsetWidth - 4)) + 'px'; menu.style.top = (b.bottom - r.top + 4) + 'px';
      menu.onclick = (e) => { const t = e.target.closest('[data-bg]'); if (!t) return; setBg(t.dataset.bg); closeBgMenu(); };
      menu.querySelector('.pf-bgcustom').oninput = (e) => { setBg('custom', e.target.value); menu.querySelector('[data-bg="custom"] .pf-bg-sw').setAttribute('style', swatchCss('custom')); };
      applyBg();
    }
    $('.pf-bg').onclick = (e) => { e.stopPropagation(); root.querySelector('.pf-bgmenu') ? closeBgMenu() : openBgMenu(); };
    const bgOutside = (e) => { const m = root.querySelector('.pf-bgmenu'); if (m && !m.contains(e.target) && !e.target.closest('.pf-bg')) closeBgMenu(); };
    document.addEventListener('pointerdown', bgOutside);
    const cycleBg = () => { const list = bgModes().map(([m]) => m), i = list.indexOf(bgMode()); setBg(list[(i + 1) % list.length]); };
    /* tool options */
    const segOn = (box, b) => $$(box + ' button').forEach((x) => x.classList.toggle('on', x === b));
    const setSize = (n) => { S.size = Math.max(1, Math.min(8, n | 0)); $('.pf-size').value = S.size; $('.pf-sizev').textContent = S.size; render(); };
    $('.pf-size').oninput = (e) => setSize(+e.target.value);
    $$('.pf-shape button').forEach((b) => (b.onclick = () => { S.shape = b.dataset.shape; segOn('.pf-shape', b); render(); }));
    $$('.pf-pattern button').forEach((b) => (b.onclick = () => { S.pattern = b.dataset.pattern; segOn('.pf-pattern', b); }));
    $$('.pf-fillmode button').forEach((b) => (b.onclick = () => { S.fillMode = b.dataset.fill; segOn('.pf-fillmode', b); }));
    $$('.pf-filled button').forEach((b) => (b.onclick = () => { const base = railOf(S.tool); setTool(b.dataset.filled === '1' ? base + 'f' : base); }));
    $('.pf-tile').onclick = (e) => { S.tile = !S.tile; e.currentTarget.classList.toggle('on', S.tile); if (S.tile && !S.touched && doc()) { const d = doc(), r = stage.getBoundingClientRect(), dpr = window.devicePixelRatio || 1; S.zoom = Math.max(1, Math.min(64, Math.floor(Math.min((r.width * dpr - 40) / (d.w * 3), (r.height * dpr - 40) / (d.h * 3))))); S.ox = Math.round((view.width - d.w * S.zoom) / 2); S.oy = Math.round((view.height - d.h * S.zoom) / 2); } else if (!S.tile && !S.touched) fit(); render(); status(); };
    $('.pf-onion').onclick = (e) => { S.onion = !S.onion; e.currentTarget.classList.toggle('on', S.onion); const d = doc(), f = frameSize(d); if (S.onion && d && !(f.w < d.w || f.h < d.h) && !famFor(d)) note('Onion skin needs animation frames: a sprite sheet (set the frame size under Preview) or numbered files like walk_0, walk_1.'); render(); };
    $('.pf-help').onclick = () => $('.pf-dlg-keys').showModal();
    /* vision check: how the art reads by value alone, and to players with the three main kinds of colour blindness */
    const VISION = [['normal', ''], ['grey', 'values (greyscale)'], ['protan', 'protanopia · red-blind'], ['deutan', 'deuteranopia · green-blind'], ['tritan', 'tritanopia · blue-blind']];
    function setVision(mode) {
      S.vision = mode; root.dataset.vision = mode; const v = VISION.find(([m]) => m === mode);
      $('.pf-vision').classList.toggle('on', mode !== 'normal'); $('.pf-vision-tag').hidden = mode === 'normal'; $('.pf-vision-tag').textContent = v[1];
      $('.pf-vision').title = 'Vision check: ' + (mode === 'normal' ? 'normal' : v[1]) + ' (Y cycles)';
    }
    $('.pf-vision').onclick = () => { const i = VISION.findIndex(([m]) => m === S.vision); setVision(VISION[(i + 1) % VISION.length][0]); };
    /* animation: frames that are separate numbered files (flame_0, flame_1...) */
    const frameNo = (fam, p) => { const r = p.split('/').pop().replace(/\.png$/i, '').slice(fam.key.length); const m = /^([_-])(\d+)$/.exec(r); return m ? { sep: m[1], n: +m[2], pad: m[2].length } : null; };
    $('.pf-fam-add').onclick = async () => {
      const d = doc(), fam = famFor(d); if (!d || !fam) return;
      const nums = fam.members.map((p) => frameNo(fam, p)).filter(Boolean), sep = nums[0] ? nums[0].sep : '_', pad = nums[0] ? nums[0].pad : 1, n = nums.length ? Math.max(...nums.map((x) => x.n)) + 1 : 1;
      const dir = d.path.includes('/') ? d.path.slice(0, d.path.lastIndexOf('/') + 1) : '', path = `${dir}${fam.key}${sep}${String(n).padStart(pad, '0')}.png`;
      if (S.sprites.some((x) => x.path === path)) return note(path + ' already exists');
      await addLocal(path, d.w, d.h, d.px.slice(), canWrite(), true);
      note(`new frame ${path.split('/').pop()}: a copy of ${d.path.split('/').pop()}${canWrite() ? '' : ' (Save downloads it; Propose PR adds it)'}`);
    };
    async function moveFrame(dir) {
      const d = doc(), fam = famFor(d); if (!d || !fam) return;
      const i = fam.members.indexOf(d.path), j = i + dir; if (j < 0 || j >= fam.members.length) return;
      const o = await loadDoc(fam.members[j]); if (!o) return;
      d.snapshot(); o.snapshot();
      [d.px, o.px] = [o.px, d.px]; [d.w, o.w] = [o.w, d.w]; [d.h, o.h] = [o.h, d.h];
      await openSprite(o.path); note(`moved ${dir < 0 ? 'earlier' : 'later'}: now ${o.path.split('/').pop()}`); changedUi(); renderList();
    }
    $('.pf-fam-left').onclick = () => moveFrame(-1); $('.pf-fam-right').onclick = () => moveFrame(1);
    $('.pf-gif').onclick = async () => {
      const d = doc(); if (!d) return; const fam = famFor(d), sheet = frameSize(d), frames = [];
      if (sheet.w < d.w || sheet.h < d.h) { const cols = Math.floor(d.w / sheet.w), rows = Math.floor(d.h / sheet.h); for (let k = 0; k < cols * rows; k++) frames.push({ w: sheet.w, h: sheet.h, px: copyRect(d.px, d.w, d.h, { x: (k % cols) * sheet.w, y: Math.floor(k / cols) * sheet.h, w: sheet.w, h: sheet.h }) }); }
      else if (fam) { for (const p of fam.members) { const x = await loadDoc(p); if (x) frames.push({ w: x.w, h: x.h, px: x.px }); } }
      else frames.push({ w: d.w, h: d.h, px: d.px });
      const s = +(prompt(`GIF of ${frames.length} frame${frames.length > 1 ? 's' : ''} at ${+$('.pf-fps').value || 8} fps. Scale (1 = original size):`, String(Math.max(1, Math.min(8, Math.floor(256 / Math.max(d.w, d.h)))))) || 0);
      if (!s || s < 1 || s > 32) return;
      const gif = encodeGif(frames, { delay: Math.max(2, Math.round(100 / Math.max(1, +$('.pf-fps').value || 8))), scale: Math.floor(s) });
      download(new Blob([gif], { type: 'image/gif' }), (fam && !(sheet.w < d.w) ? fam.key : d.path.split('/').pop().replace(/\.png$/i, '')) + (s > 1 ? '@' + s + 'x' : '') + '.gif');
      note(`GIF: ${frames.length} frame${frames.length > 1 ? 's' : ''}, ${(gif.length / 1024).toFixed(1)} KB`);
    };
    function setRef(img, name, pixel) {
      S.ref = { img, name, pixel, opacity: +$('.pf-ref-op').value / 100, over: $('.pf-ref-place button.on').dataset.place === 'over', fit: $('.pf-ref-fit button.on').dataset.fit, visible: true };
      $('.pf-ref-on').hidden = false; $('.pf-ref-name').textContent = `${name} · ${img.width}×${img.height}`; $('.pf-ref-toggle').textContent = 'hide'; render();
    }
    $('.pf-ref-load').onclick = () => $('.pf-ref-file').click();
    $('.pf-ref-file').onchange = async (e) => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { setRef(await createImageBitmap(f), f.name, false); } catch (err) { note('Could not read that image: ' + err.message); } };
    $('.pf-ref-sprite').onfocus = () => { const sel = $('.pf-ref-sprite'), cur = sel.value; sel.innerHTML = '<option value="">or a sprite…</option>' + S.sprites.map((x) => `<option value="${esc(x.path)}">${esc(x.path)}</option>`).join(''); sel.value = cur; };
    $('.pf-ref-sprite').onchange = async (e) => { const path = e.target.value; if (!path) return; const d = await loadDoc(path); if (!d) return; const c = document.createElement('canvas'); c.width = d.w; c.height = d.h; c.getContext('2d').putImageData(d.imageData(), 0, 0); setRef(c, path.split('/').pop(), true); e.target.value = ''; e.target.blur(); /* shortcuts (H) work straight away */ };
    $('.pf-ref-op').oninput = (e) => { if (S.ref) { S.ref.opacity = +e.target.value / 100; render(); } };
    $$('.pf-ref-place button').forEach((b) => (b.onclick = () => { segOn('.pf-ref-place', b); if (S.ref) { S.ref.over = b.dataset.place === 'over'; render(); } }));
    $$('.pf-ref-fit button').forEach((b) => (b.onclick = () => { segOn('.pf-ref-fit', b); if (S.ref) { S.ref.fit = b.dataset.fit; render(); } }));
    const toggleRef = () => { if (!S.ref) return; S.ref.visible = !S.ref.visible; $('.pf-ref-toggle').textContent = S.ref.visible ? 'hide' : 'show'; render(); };
    $('.pf-ref-toggle').onclick = toggleRef;
    $('.pf-ref-clear').onclick = () => { S.ref = null; $('.pf-ref-on').hidden = true; render(); };
    /* variants: a recoloured copy of a whole family (or one sprite) as new files */
    let variant = null;
    async function openVariant() {
      const d = doc(); if (!d) return;
      const fam = famFor(d), key = fam ? fam.key : d.path.split('/').pop().replace(/\.png$/i, ''), members = fam ? fam.members : [d.path], docs = [];
      for (const p of members) { const x = await loadDoc(p); if (x) docs.push(x); }
      const counts = new Map(); for (const x of docs) for (const c of x.px) if (!isClear(c)) counts.set(c, (counts.get(c) || 0) + 1);
      variant = { key, docs, cols: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 48).map(([c]) => c), swap: new Map() };
      $('.pf-v-what').textContent = `${docs.length > 1 ? `The whole "${key}" family: ${docs.length} images` : d.path.split('/').pop()}, recoloured into new files.`;
      $('.pf-v-cols').innerHTML = variant.cols.map((c, i) => `<label class="pf-v-col"><i style="background:${toHex(c)}"></i>→<input type="color" data-i="${i}" value="${toHex(c)}"></label>`).join('');
      for (const [sel, v] of [['.pf-v-h', 0], ['.pf-v-s', 0], ['.pf-v-l', 0]]) $(sel).value = v;
      variantPreview(); $('.pf-dlg-variant').showModal();
    }
    const suffixOf = () => ($('.pf-v-suffix').value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'variant');
    function variantFn() {
      if ($('.pf-v-mode button.on').dataset.mode === 'swap') return (c) => (isClear(c) ? c : variant.swap.has(c) ? ((variant.swap.get(c) & 0xffffff) | (c & 0xff000000)) >>> 0 : c);
      const dh = +$('.pf-v-h').value, ds = +$('.pf-v-s').value / 100, dl = +$('.pf-v-l').value / 100, keep = $('.pf-v-keep').checked, memo = new Map();
      return (c) => { let r = memo.get(c); if (r === undefined) memo.set(c, (r = shiftColor(c, dh, ds, dl, keep))); return r; };
    }
    function variantPreview() {
      if (!variant) return; const fn = variantFn(), sfx = suffixOf();
      $('.pf-v-hv').textContent = $('.pf-v-h').value + '°'; $('.pf-v-sv').textContent = $('.pf-v-s').value; $('.pf-v-lv').textContent = $('.pf-v-l').value;
      $('.pf-v-names').textContent = '→ ' + variant.docs.map((x) => variantPath(x.path, variant.key, sfx).split('/').pop()).join(', ');
      const box = $('.pf-v-preview'); box.innerHTML = '';
      for (const x of variant.docs) { const c = document.createElement('canvas'); box.appendChild(c); drawPx(c, { w: x.w, h: x.h, imageData: () => new ImageData(new Uint8ClampedArray(x.px.map(fn).buffer), x.w, x.h) }); c.style.width = Math.round(72 * x.w / x.h) + 'px'; }
    }
    $('.pf-variant').onclick = openVariant;
    ['.pf-v-h', '.pf-v-s', '.pf-v-l', '.pf-v-keep', '.pf-v-suffix'].forEach((sel) => ($(sel).oninput = variantPreview));
    $$('.pf-v-mode button').forEach((b) => (b.onclick = () => { segOn('.pf-v-mode', b); $('.pf-v-shift').hidden = b.dataset.mode !== 'shift'; $('.pf-v-swap').hidden = b.dataset.mode !== 'swap'; variantPreview(); }));
    $('.pf-v-cols').oninput = (e) => { const i = e.target.dataset.i; if (i == null) return; variant.swap.set(variant.cols[+i], fromHex(e.target.value)); variantPreview(); };
    $('.pf-v-go').onclick = async () => {
      const fn = variantFn(), sfx = suffixOf(), made = [];
      for (const x of variant.docs) {
        const path = variantPath(x.path, variant.key, sfx);
        if (S.sprites.some((s) => s.path === path)) { note(path.split('/').pop() + ' already exists: pick another name'); return; }
      }
      $('.pf-dlg-variant').close();
      for (const x of variant.docs) { const path = variantPath(x.path, variant.key, sfx); await addLocal(path, x.w, x.h, x.px.map(fn), canWrite(), true); made.push(path); }
      await openSprite(made[0]); note(`variant: ${made.length} new file${made.length > 1 ? 's' : ''} (${canWrite() ? 'Save writes each' : 'Save downloads; Propose PR adds them'})`);
    };
    /* history: earlier versions of the open sprite from git (GitHub repositories and the local server) */
    let histFor = null, histPick = null;
    async function loadHistory() {
      const d = doc(), box = $('.pf-hist-list'); if (!d || !S.src || !S.src.history || !$('.pf-hist').open) return;
      if (histFor === d.path) return; histFor = d.path; histPick = null; $('.pf-hist-act').hidden = true;
      box.innerHTML = '<div class="pf-note">Loading…</div>';
      let list = []; try { list = d.isNew || d.local ? [] : await S.src.history(d.path); } catch (e) { box.innerHTML = `<div class="pf-note">${esc(e.message)}</div>`; return; }
      if (histFor !== d.path) return;
      box.innerHTML = list.length ? '' : '<div class="pf-note">No earlier versions.</div>';
      for (const c of list) {
        const b = el(`<button class="pf-hist-e" data-sha="${esc(c.sha)}" title="${esc(c.message)}"><canvas></canvas><b>${esc(c.message)}</b><small>${esc(String(c.date).slice(0, 10))} · ${esc(c.author)} · ${esc(c.sha.slice(0, 7))}</small></button>`);
        box.appendChild(b); const cv = b.querySelector('canvas'), path = d.path;
        S.src.readAt(path, c.sha).then((bytes) => createImageBitmap(new Blob([bytes], { type: 'image/png' }))).then((bm) => { cv.width = bm.width; cv.height = bm.height; const k = cv.getContext('2d'); k.imageSmoothingEnabled = false; k.drawImage(bm, 0, 0); }).catch(() => { b.disabled = true; b.title = 'Not in that commit (renamed or added later)'; });
      }
    }
    const resetHistory = () => { histFor = null; $('.pf-hist').hidden = !(S.src && S.src.history); if ($('.pf-hist').open) loadHistory(); };
    $('.pf-hist').addEventListener('toggle', loadHistory);
    $('.pf-hist-list').onclick = (e) => { const b = e.target.closest('.pf-hist-e'); if (!b || b.disabled) return; $$('.pf-hist-e').forEach((x) => x.classList.toggle('on', x === b)); histPick = b.dataset.sha; $('.pf-hist-act').hidden = false; $('.pf-hist-sel').textContent = histPick.slice(0, 7); };
    $('.pf-hist-restore').onclick = async () => {
      const d = doc(); if (!d || !histPick) return;
      try { const img = await decodePng(new Blob([await S.src.readAt(d.path, histPick)], { type: 'image/png' })); d.snapshot(); d.px = img.px; d.w = img.w; d.h = img.h; fit(); changedUi(); note(`restored the version from ${histPick.slice(0, 7)} (Ctrl+Z undoes it)`); }
      catch (e) { note('Could not restore: ' + e.message); }
    };
    $('.pf-context').onclick = (e) => { S.ctx = !S.ctx; e.currentTarget.classList.toggle('on', S.ctx); $('.pf-ctx').hidden = !S.ctx; try { localStorage.setItem('pf:ctx', S.ctx ? '1' : '0'); } catch { /* ignore */ } requestAnimationFrame(() => { resizeView(); if (!S.touched) fit(); render(); }); };
    $$('.pf-ctx-scale button').forEach((b) => (b.onclick = () => { S.ctxScale = +b.dataset.scale; segOn('.pf-ctx-scale', b); render(); }));
    try { if (localStorage.getItem('pf:ctx') === '1') { S.ctx = true; $('.pf-context').classList.add('on'); $('.pf-ctx').hidden = false; } } catch { /* off */ }
    $('.pf-changes').onclick = (e) => { S.changes = !S.changes; e.currentTarget.classList.toggle('on', S.changes); render(); };
    const peek = (on) => { if (S.peek === on || !doc()) return; S.peek = on; render(); };
    $('.pf-status').addEventListener('pointerdown', (e) => { if (e.target.closest('.pf-s-peek')) { e.preventDefault(); peek(true); } });
    const peekOff = () => peek(false); window.addEventListener('pointerup', peekOff);
    $('.pf-swap').onclick = () => { [S.color, S.color2] = [S.color2, S.color]; if (isClear(S.color) && S.tool === 'pen') setTool('erase'); else if (!isClear(S.color) && S.tool === 'erase') setTool('pen'); renderColors(); swatches(); };
    $('.pf-prim').onclick = () => $('.pf-cpick').click();
    $('.pf-sec').onclick = () => $('.pf-swap').click();
    $('.pf-ramp-btn').onclick = () => { if (isClear(S.color)) return note('Pick a colour first.'); const r = hueRamp(S.color, 5); $('.pf-ramp').hidden = false; $('.pf-ramp-colors').innerHTML = r.map((c) => `<button data-c="${c}" title="${toHex(c)}" style="background:${toHex(c)}"></button>`).join(''); S.ramp = r; renderColors(); };
    $('.pf-ramp-add').onclick = () => { const add = (S.ramp || []).filter((c) => !S.palette.includes(c)); S.palette = S.palette.concat(add); renderPalette(); renderColors(); note('added ' + add.length + ' colours to the palette'); };
    $('.pf-pal-add').onclick = () => { if (isClear(S.color) || S.palette.includes(S.color)) return; S.palette = S.palette.concat([S.color]); renderPalette(); renderColors(); };
    $('.pf-sel-copy').onclick = () => copySel(false); $('.pf-sel-cut').onclick = () => copySel(true); $('.pf-sel-paste').onclick = () => { if (S.clip) pastePx(S.clip.px, S.clip.w, S.clip.h); else note('Nothing copied yet.'); };
    $('.pf-sel-del').onclick = deleteSel; $('.pf-sel-all').onclick = selectAll; $('.pf-sel-none').onclick = dropSelection;
    $('.pf-undo').onclick = undo; $('.pf-redo').onclick = redo;
    $('.pf-zin').onclick = () => { S.zoom = Math.min(64, S.zoom + 1); S.touched = true; fit2(); }; $('.pf-zout').onclick = () => { S.zoom = Math.max(1, S.zoom - 1); S.touched = true; fit2(); };
    function fit2() { const d = doc(); if (d) { S.ox = Math.round((view.width - d.w * S.zoom) / 2); S.oy = Math.round((view.height - d.h * S.zoom) / 2); } render(); status(); }
    $('.pf-fit').onclick = () => { fit(); render(); status(); };
    $('.pf-grid').onclick = (e) => { S.grid = !S.grid; e.currentTarget.classList.toggle('on', S.grid); render(); };
    $('.pf-mx').onclick = (e) => { S.mx = !S.mx; e.currentTarget.classList.toggle('on', S.mx); render(); };
    $('.pf-my').onclick = (e) => { S.my = !S.my; e.currentTarget.classList.toggle('on', S.my); render(); };
    try { S.pp = localStorage.getItem('pf:cleanlines') === '1'; } catch { /* default off */ } $('.pf-pp').classList.toggle('on', S.pp);
    $('.pf-pp').onclick = (e) => { S.pp = !S.pp; e.currentTarget.classList.toggle('on', S.pp); try { localStorage.setItem('pf:cleanlines', S.pp ? '1' : '0'); } catch { /* ignore */ } };
    $('.pf-save').onclick = save; $('.pf-export').onclick = exportPng; $('.pf-prbtn').onclick = openPr; $('.pf-pr-go').onclick = submitPr;
    $('.pf-cpick').oninput = (e) => setColor(fromHex(e.target.value));
    $('.pf-chex').onchange = (e) => { const c = fromHex(e.target.value); if (c != null) setColor(c); else renderColors(); };
    $('.pf-recolor').onclick = () => { const i = $('.pf-recolor-in'); i.value = toHex(S.color); i.click(); };
    { let session = null;
      $('.pf-recolor-in').oninput = (e) => { const d = doc(), to = fromHex(e.target.value); if (!d || to == null) return; if (!session) { if (!d.px.includes(S.color)) { note('That colour is not in this image.'); return; } d.snapshot(); session = { from: S.color }; } for (let i = 0; i < d.px.length; i++) if (d.px[i] === session.from) d.px[i] = to; session.from = to; S.color = to; changedUi(); };
      $('.pf-recolor-in').onchange = () => { session = null; }; }
    $('.pf-fliph').onclick = () => transformSel((px, w, h) => ({ px: flipH(px, w, h), w, h })) || edit((d) => { d.px = flipH(d.px, d.w, d.h); });
    $('.pf-flipv').onclick = () => transformSel((px, w, h) => ({ px: flipV(px, w, h), w, h })) || edit((d) => { d.px = flipV(d.px, d.w, d.h); });
    $('.pf-rot').onclick = () => transformSel((px, w, h) => ({ px: rotateCW(px, w, h), w: h, h: w })) || edit((d) => { d.px = rotateCW(d.px, d.w, d.h); [d.w, d.h] = [d.h, d.w]; fit(); });
    $('.pf-outline').onclick = () => { if (isClear(S.color)) return note('Pick an opaque primary colour for the outline.'); commitFloat(); edit((d) => { d.px = outlinePx(d.px, d.w, d.h, S.color, $('.pf-outline-c').checked); }); };
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
      const canFolder = typeof window.showDirectoryPicker === 'function'; $('.pf-c-folder').disabled = !canFolder; $('.pf-c-foldernote').textContent = canFolder ? 'Saves the PNGs in place. Chrome, Edge and Opera.' : 'Needs Chrome, Edge or Opera.';
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
      else if (mod && k === 'c') { if (copySel(false)) e.preventDefault(); } else if (mod && k === 'x') { if (copySel(true)) e.preventDefault(); }
      else if (mod && k === 'a') { e.preventDefault(); selectAll(); }
      else if (mod && k === 'v') { pasteSoon = setTimeout(() => { if (S.clip) pastePx(S.clip.px, S.clip.w, S.clip.h); }, 60); } // the paste event below wins when the clipboard holds an image from another app
      else if (k === 'escape' && root.querySelector('.pf-bgmenu')) { e.preventDefault(); closeBgMenu(); }
      else if (k === 'escape' && (S.sel || S.float)) { e.preventDefault(); dropSelection(); }
      else if (k === 'enter' && S.float) { e.preventDefault(); commitFloat(); render(); status(); }
      else if ((k === 'delete' || k === 'backspace') && (S.sel || S.float)) { e.preventDefault(); deleteSel(); }
      else if (k.startsWith('arrow') && S.sel && !mod) { e.preventDefault(); const n = e.shiftKey ? 8 : 1; nudge(k === 'arrowleft' ? -n : k === 'arrowright' ? n : 0, k === 'arrowup' ? -n : k === 'arrowdown' ? n : 0); }
      else if (!mod && !e.altKey) {
        const t = TOOLS.find((x) => x[2].toLowerCase() === k); if (t) setTool(t[0]);
        else if (k === 'm') $('.pf-mx').click(); else if (k === '+' || k === '=') $('.pf-zin').click(); else if (k === '-') $('.pf-zout').click(); else if (k === '0') $('.pf-fit').click(); else if (k === '#') $('.pf-grid').click();
        else if (k === 'x') $('.pf-swap').click(); else if (k === '[') setSize(S.size - 1); else if (k === ']') setSize(S.size + 1);
        else if (k === 'k') cycleBg(); else if (k === 'y') $('.pf-vision').click(); else if (k === 'h') toggleRef(); else if (k === 'c') $('.pf-changes').click(); else if (k === 'v') $('.pf-context').click(); else if (e.key === '\\') { e.preventDefault(); peek(true); } else if (k === ',') stepMember(-1); else if (k === '.') stepMember(1);
        else if (k === 't') $('.pf-tile').click(); else if (k === 'n') $('.pf-onion').click(); else if (e.key === '?') $('.pf-help').click();
        else if (k === ' ') { space = true; e.preventDefault(); }
      }
    }
    const keyup = (e) => { if (e.key === ' ') space = false; if (e.key === '\\') peek(false); };
    let pasteSoon = 0;
    async function onPaste(e) {
      if (!root.isConnected || root.querySelector('dialog[open]') || !doc()) return;
      const tag = (e.target.tagName || '').toLowerCase(); if (tag === 'input' || tag === 'textarea') return;
      const file = [...((e.clipboardData && e.clipboardData.files) || [])].find((f) => /^image\//.test(f.type)); if (!file) return;
      e.preventDefault(); clearTimeout(pasteSoon);
      try { const img = await decodePng(file); pastePx(img.px, img.w, img.h); } catch (err) { note('Could not paste that image: ' + err.message); }
    }
    document.addEventListener('keydown', keydown); document.addEventListener('keyup', keyup); document.addEventListener('paste', onPaste);
    const leaveGuard = (e) => { if ([...S.docs.values()].some((d) => d.unsaved && d.changed)) { e.preventDefault(); e.returnValue = ''; } }; /* unsaved work would be lost: ask first */
    window.addEventListener('beforeunload', leaveGuard);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { const had = doc(); resizeView(); if (had && !S.touched) fit(); render(); }) : null; if (ro) ro.observe(stage);
    resizeView(); renderAuth(); applyBg(); init();

    const ctrl = {
      get docs() { return S.docs; }, get current() { return doc(); }, open: openSprite, save, setColor, setColor2, setTool, undo, redo, selectAll, state: S,
      dispose() { document.removeEventListener('keydown', keydown); document.removeEventListener('keyup', keyup); document.removeEventListener('paste', onPaste); document.removeEventListener('pointerdown', bgOutside); window.removeEventListener('pointerup', peekOff); window.removeEventListener('beforeunload', leaveGuard); if (ro) ro.disconnect(); clearInterval(S.anim.timer); host.innerHTML = ''; delete host.__pf; },
    };
    host.__pf = ctrl;
    return ctrl;
  }

  return { mount, createPullRequest, prBody, png: { decode: decodePngBytes, encode: encodePngBytes }, auth: { signIn: githubSignIn, refresh: githubRefresh, user: githubUser, listRepos, explainError: explainGithubError, tokenUrl: PAT_URL }, sources: { githubSource, folderSource, staticSource, serverSource, applyConfig }, core: { pack, unpack, toHex, fromHex, parsePalette, nearestColor, linePoints, rectPoints, ellipsePoints, brushOffsets, ditherOn, floodFill, fillSame, outlinePx, toHsv, fromHsv, shadeColor, hueRamp, copyRect, pasteRect, rectBetween, constrain, colorsOf, groupSprites, encodeGif, shiftColor, variantPath, flipH, flipV, rotateCW, shiftWrap, resizePx, countDiff, Doc } };
});
