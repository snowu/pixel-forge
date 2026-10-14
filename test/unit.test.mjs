import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { scan, readPngSize, slugFromRemote, gitInfo, globToRegExp, suggestConfig } from '../src/scan.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { createServer, safeResolve } from '../src/serve.mjs';
import { encodePng, decodePng, fromRows, encodeRaw } from './png.mjs';
await import('../spritewright.js');
const PF = globalThis.Spritewright, C = PF.core;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pf-'));
const SLIME = fromRows(['.gg.', 'gGGg', 'gGGg', '.gg.'], { g: [60, 180, 80], G: [120, 230, 130] });

/* ---------- drawing core ---------- */
test('groupSprites: folders, families by base name or numbered frames, animations, and no grouping by mere category prefixes', () => {
  const g = C.groupSprites(['e/archer_0.png', 'e/archer_atk.png', 'e/archer_block.png', 'e/king_0.png', 'e/king_atk.png', 'e/king_dark_0.png', 'e/king_dark_atk.png', 'p/flame_2.png', 'p/flame_0.png', 'p/flame_1.png',
    't/floor_crypt_grave.png', 't/floor_crypt.png', 't/floor_crypt_drain.png', 'i/ic_gem.png', 'i/ic_ring.png', 'i/ic_gem_emerald.png', 'w/icon-512.png', 'w/icon-192.png', 'lone.png']);
  const fam = (dir) => Object.fromEntries(g.find((d) => d.dir === dir).families.map((f) => [f.key, f.members.map((m) => m.split('/').pop().replace('.png', '')).join(',') + (f.animated ? ' ▶' : '')]));
  assert.deepEqual(g.map((d) => d.dir), ['', 'e', 'i', 'p', 't', 'w']);
  assert.deepEqual(fam('e'), { archer: 'archer_0,archer_atk,archer_block', king: 'king_0,king_atk', king_dark: 'king_dark_0,king_dark_atk' }, 'poses group; the longer shared prefix wins');
  assert.deepEqual(fam('p'), { flame: 'flame_0,flame_1,flame_2 ▶' }, 'numbered frames, in order, are an animation');
  assert.deepEqual(fam('t'), { floor_crypt: 'floor_crypt,floor_crypt_drain,floor_crypt_grave' }, 'the base image comes first, then its variants');
  assert.deepEqual(fam('i'), { ic_gem: 'ic_gem,ic_gem_emerald', ic_ring: 'ic_ring' }, 'a shared prefix like ic_ is a category, not a family');
  assert.deepEqual(fam('w'), { icon: 'icon-192,icon-512' }, 'numbers that are not a 0/1-based run are not animation frames');
  assert.deepEqual(fam(''), { lone: 'lone' });
});
test('applyConfig without a config skips docs, screenshots and previews folders; a config decides for itself', () => {
  const items = ['art/a.png', 'docs/previews/x.png', 'game/screenshots/s.png', 'art/tests/t.png', 'node_modules/p/q.png'].map((path) => ({ path }));
  assert.deepEqual(PF.sources.applyConfig(items, {}).map((x) => x.path), ['art/a.png']);
  assert.deepEqual(PF.sources.applyConfig(items, { dirs: ['docs'] }).map((x) => x.path), ['docs/previews/x.png']);
  assert.deepEqual(PF.sources.applyConfig(items, { keepDocs: true }).map((x) => x.path), ['art/a.png', 'docs/previews/x.png', 'game/screenshots/s.png', 'art/tests/t.png']);
});
const grid = (pts, w, h, ox = 0, oy = 0) => { const g = Array.from({ length: h }, () => Array(w).fill('.')); for (const [x, y] of pts) g[y + oy][x + ox] = '#'; return g.map((r) => r.join('')); };
test('ellipse: a symmetric 1-pixel ring, filled disc, and the same result whichever corner you start from', () => {
  assert.deepEqual(grid(C.ellipsePoints(0, 0, 8, 8, false), 9, 9), ['..#####..', '.#.....#.', '#.......#', '#.......#', '#.......#', '#.......#', '#.......#', '.#.....#.', '..#####..']);
  assert.deepEqual(grid(C.ellipsePoints(0, 0, 4, 4, true), 5, 5), ['.###.', '#####', '#####', '#####', '.###.']);
  const key = (p) => p.map(([x, y]) => x + ',' + y).sort().join(' ');
  assert.equal(key(C.ellipsePoints(11, 6, 0, 0, false)), key(C.ellipsePoints(0, 0, 11, 6, false)));
  const ring = C.ellipsePoints(0, 0, 11, 6, false); assert.deepEqual(grid(ring, 12, 7), grid(ring.map(([x, y]) => [11 - x, y]), 12, 7), 'mirror symmetric');
  assert.deepEqual(C.ellipsePoints(3, 3, 3, 3, false), [[3, 3]], 'a one-pixel ellipse is one pixel');
});
test('brush tips: sizes, round vs square, centred on the cursor', () => {
  assert.deepEqual(C.brushOffsets(1, 'round'), [[0, 0]]);
  assert.deepEqual(grid(C.brushOffsets(3, 'round'), 3, 3, 1, 1), ['.#.', '###', '.#.']);
  assert.deepEqual(grid(C.brushOffsets(3, 'square'), 3, 3, 1, 1), ['###', '###', '###']);
  assert.deepEqual(grid(C.brushOffsets(5, 'round'), 5, 5, 2, 2), ['.###.', '#####', '#####', '#####', '.###.']);
  assert.equal(C.brushOffsets(4, 'square').length, 16); assert.equal(C.brushOffsets(99, 'square').length, 32 * 32, 'capped at 32');
});
test('thicken: a 1-pixel path stamped with a bigger brush, every pixel once', () => {
  const line = C.linePoints(1, 2, 5, 2);
  assert.equal(C.thicken(line, 1, 'square'), line, 'size 1 leaves the path alone');
  assert.deepEqual(grid(C.thicken(line, 3, 'square'), 7, 5), ['.......', '#######', '#######', '#######', '.......']);
  const ring = C.thicken(C.rectPoints(0, 0, 5, 5, false), 2, 'square');
  assert.equal(new Set(ring.map(String)).size, ring.length, 'no duplicates');
  assert.equal(C.thicken([[0, 0]], 3, 'round').length, 5, 'a single point becomes the brush tip');
});
test('dither pattern is a checkerboard and the phase flips it', () => {
  assert.equal(C.ditherOn(0, 0), true); assert.equal(C.ditherOn(1, 0), false); assert.equal(C.ditherOn(1, 1), true); assert.equal(C.ditherOn(0, 0, 1), false);
});
test('fillSame replaces one colour everywhere, not just the connected area', () => {
  const r = C.pack(255, 0, 0), b = C.pack(0, 0, 255), px = new Uint32Array([r, b, r, b, r, b]);
  assert.deepEqual(C.fillSame(px, 0, 0, 3, b), [0, 2, 4]); assert.ok(px.every((v) => v === b));
  const clear = new Uint32Array([0, C.pack(1, 2, 3, 0), r]); C.fillSame(clear, 0, 0, 3, b); assert.deepEqual([...clear], [b, b, r], 'every fully clear pixel counts as the same colour');
});
test('outline: side neighbours only, or with corners', () => {
  const k = C.pack(0, 0, 0), g = C.pack(0, 255, 0), px = new Uint32Array(25); px[12] = g;
  const side = C.outlinePx(px, 5, 5, k, false), all = C.outlinePx(px, 5, 5, k, true);
  assert.deepEqual([...side].map((v, i) => (v === k ? i : -1)).filter((i) => i >= 0), [7, 11, 13, 17]);
  assert.equal([...all].filter((v) => v === k).length, 8); assert.equal(px[7], 0, 'the input is not modified');
});
test('hue-shifted ramps and shading: darker drifts to blue, lighter to yellow, greys stay grey', () => {
  const red = C.pack(200, 60, 60), ramp = C.hueRamp(red, 5);
  assert.equal(ramp.length, 5); assert.equal(ramp[2], red, 'the middle of an odd ramp is the colour itself');
  const lum = (c) => { const [r, g, b] = C.unpack(c); return 0.299 * r + 0.587 * g + 0.114 * b; };
  for (let i = 1; i < 5; i++) assert.ok(lum(ramp[i]) > lum(ramp[i - 1]), 'ramp goes dark to light');
  const hue = (c) => C.toHsv(c)[0];
  assert.ok(hue(ramp[0]) > 300 && hue(ramp[0]) < 360, 'the shadow of red leans toward purple/blue: ' + hue(ramp[0]));
  assert.ok(hue(ramp[4]) > 0 && hue(ramp[4]) < 60, 'the highlight of red leans toward orange/yellow: ' + hue(ramp[4]));
  for (const c of C.hueRamp(C.pack(128, 128, 128), 5)) { const [r, g, b] = C.unpack(c); assert.ok(r === g && g === b, 'grey ramp stays grey ' + C.toHex(c)); }
  assert.ok(lum(C.shadeColor(red, 1)) > lum(red) && lum(C.shadeColor(red, -1)) < lum(red));
  const pal = [C.pack(0, 0, 0), C.pack(80, 20, 40), red, C.pack(255, 180, 120), C.pack(255, 255, 255)];
  assert.equal(C.shadeColor(red, 1, pal), pal[3]); assert.equal(C.shadeColor(red, -1, pal), pal[1], 'with a palette, shading steps to palette colours');
  assert.equal(C.shadeColor(0, 1), 0, 'clear stays clear');
  for (const c of [C.pack(0, 0, 0), C.pack(255, 255, 255), C.pack(10, 200, 250, 128)]) { C.shadeColor(c, 1); C.shadeColor(c, -1); }
  assert.equal(C.shadeColor(C.pack(10, 200, 250, 128), -1) >>> 24, 128, 'alpha is kept');
  assert.equal(C.fromHsv(...C.toHsv(C.pack(12, 200, 99))), C.pack(12, 200, 99), 'HSV round trip');
});
test('selection helpers: copy, paste with and without transparency, clipping, constrain', () => {
  const a = C.pack(255, 0, 0), b = C.pack(0, 255, 0), px = new Uint32Array([a, b, 0, 0, a, b, 0, 0, 0]);
  assert.deepEqual([...C.copyRect(px, 3, 3, { x: 0, y: 0, w: 2, h: 2 })], [a, b, 0, a]);
  assert.deepEqual([...C.copyRect(px, 3, 3, { x: 2, y: 2, w: 2, h: 2 })], [0, 0, 0, 0], 'outside comes back clear');
  const dst = new Uint32Array(9).fill(b); C.pasteRect(dst, 3, 3, new Uint32Array([a, 0]), 2, 1, 2, 0, false);
  assert.deepEqual([...dst.slice(0, 3)], [b, b, a], 'clear source pixels keep what is underneath, and the part off the edge is dropped');
  const op = new Uint32Array(4).fill(b); C.pasteRect(op, 2, 2, new Uint32Array([a, 0]), 2, 1, 0, 0, true); assert.deepEqual([...op.slice(0, 2)], [a, 0]);
  assert.deepEqual(C.rectBetween({ x: 5, y: -2 }, { x: 1, y: 3 }, 4, 4), { x: 1, y: 0, w: 3, h: 4 });
  assert.equal(C.rectBetween({ x: 9, y: 9 }, { x: 12, y: 12 }, 4, 4), null);
  assert.deepEqual(C.constrain({ x: 0, y: 0 }, { x: 5, y: -2 }, 'box'), { x: 5, y: -5 });
  assert.deepEqual(C.constrain({ x: 0, y: 0 }, { x: 6, y: 1 }, 'line'), { x: 6, y: 0 });
  assert.deepEqual(C.constrain({ x: 0, y: 0 }, { x: 5, y: 4 }, 'line'), { x: 4, y: 4 });
});
test('colour packing round-trips and parses hex', () => {
  assert.equal(C.toHex(C.pack(255, 0, 128)), '#ff0080');
  assert.equal(C.fromHex('#ff0080'), C.pack(255, 0, 128));
  assert.equal(C.fromHex('00ff00'), C.pack(0, 255, 0));
  assert.equal(C.fromHex('#12345680'), C.pack(0x12, 0x34, 0x56, 0x80));
  assert.equal(C.fromHex('nope'), null);
});
test('palette parsing accepts .hex files and removes duplicates', () => {
  const p = C.parsePalette('1a1c2c\n5d275d\n#B13E53\n1a1c2c\n\nzz');
  assert.deepEqual(p.map(C.toHex), ['#1a1c2c', '#5d275d', '#b13e53']);
});
test('nearestColor: closest by RGB, first wins ties', () => {
  const pal = [C.pack(0, 0, 0), C.pack(255, 255, 255), C.pack(255, 0, 0)];
  assert.equal(C.nearestColor(C.pack(200, 30, 30), pal), pal[2]);
  assert.equal(C.nearestColor(C.pack(1, 1, 1), [C.pack(0, 0, 0), C.pack(2, 2, 2)]), C.pack(0, 0, 0));
});
test('linePoints covers both endpoints with no gaps', () => {
  for (const [a, b, c, d] of [[0, 0, 5, 0], [0, 0, 0, 5], [0, 0, 5, 3], [4, 4, 0, 0], [2, 7, 9, 1], [3, 3, 3, 3]]) {
    const pts = C.linePoints(a, b, c, d);
    assert.deepEqual(pts[0], [a, b]); assert.deepEqual(pts.at(-1), [c, d]);
    for (let i = 1; i < pts.length; i++) assert.ok(Math.max(Math.abs(pts[i][0] - pts[i - 1][0]), Math.abs(pts[i][1] - pts[i - 1][1])) === 1, 'adjacent');
  }
  assert.equal(C.linePoints(0, 0, 5, 0).length, 6);
});
test('rectPoints: outline and filled counts', () => {
  assert.equal(C.rectPoints(1, 1, 4, 3, true).length, 12);
  assert.equal(C.rectPoints(1, 1, 4, 3, false).length, 10);
  assert.equal(C.rectPoints(4, 3, 1, 1, true).length, 12);
});
test('floodFill is 4-connected and stops at other colours', () => {
  // 1 1 2 1
  // 1 2 1 1      the 1 at (2,1) touches the filled region only diagonally, so it must stay
  // 2 2 2 1
  const w = 4, h = 3, px = new Uint32Array([1, 1, 2, 1, 1, 2, 1, 1, 2, 2, 2, 1]);
  const ch = C.floodFill(px, w, h, 0, 0, 9);
  assert.equal(ch.length, 3);
  assert.deepEqual([...px], [9, 9, 2, 1, 9, 2, 1, 1, 2, 2, 2, 1]);
  assert.equal(C.floodFill(px, w, h, 0, 0, 9).length, 0, 'filling with the same colour is a no-op');
});
test('flip, rotate, shift and resize', () => {
  const px = Uint32Array.from([1, 2, 3, 4, 5, 6]); // 3 wide, 2 tall
  assert.deepEqual([...C.flipH(px, 3, 2)], [3, 2, 1, 6, 5, 4]);
  assert.deepEqual([...C.flipV(px, 3, 2)], [4, 5, 6, 1, 2, 3]);
  assert.deepEqual([...C.rotateCW(px, 3, 2)], [4, 1, 5, 2, 6, 3]); // result is 2 wide, 3 tall
  assert.deepEqual([...C.shiftWrap(px, 3, 2, 1, 0)], [3, 1, 2, 6, 4, 5]);
  assert.deepEqual([...C.shiftWrap(px, 3, 2, 0, -1)], [4, 5, 6, 1, 2, 3]);
  assert.deepEqual([...C.resizePx(px, 3, 2, 4, 3, 'tl')], [1, 2, 3, 0, 4, 5, 6, 0, 0, 0, 0, 0]);
  assert.deepEqual([...C.resizePx(px, 3, 2, 1, 1, 'tl')], [1]);
});
test('canvas size: nine anchors, scaling, trim bounds', () => {
  const px = Uint32Array.from([1, 2, 3, 4, 5, 6]); // 3 wide, 2 tall
  assert.deepEqual(C.anchorOffset(3, 2, 5, 4, 'br'), { x: 2, y: 2 });
  assert.deepEqual(C.anchorOffset(3, 2, 5, 4, 't'), { x: 1, y: 0 });
  assert.deepEqual(C.anchorOffset(3, 2, 5, 4, 'l'), { x: 0, y: 1 });
  assert.deepEqual(C.anchorOffset(3, 2, 5, 4, 'c'), { x: 1, y: 1 });
  assert.deepEqual([...C.resizePx(px, 3, 2, 4, 2, 'r')], [0, 1, 2, 3, 0, 4, 5, 6]);
  assert.deepEqual([...C.resizePx(px, 3, 2, 1, 1, 'br')], [6], 'shrinking keeps the anchored corner');
  assert.deepEqual([...C.resizePx(px, 3, 2, 3, 3, 'b')], [0, 0, 0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...C.scalePx(px, 3, 2, 6, 4)], [1, 1, 2, 2, 3, 3, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 4, 4, 5, 5, 6, 6], 'doubling repeats each pixel 2x2');
  assert.deepEqual([...C.scalePx(C.scalePx(px, 3, 2, 6, 4), 6, 4, 3, 2)], [...px], 'halving it back is exact');
  const A = 0xff000000, img = new Uint32Array(25); img[6] = A; img[13] = A | 5;
  assert.deepEqual(C.opaqueBounds(img, 5, 5), { x: 1, y: 1, w: 3, h: 2 });
  assert.equal(C.opaqueBounds(new Uint32Array(4), 2, 2), null);
  assert.equal(C.opaqueBounds(Uint32Array.from([0x00ffffff]), 1, 1), null, 'invisible colour (alpha 0) counts as empty');
});
test('zipFiles writes a zip that unzip tools read, folders kept', () => {
  const dir = tmp(), a = encodePng(2, 2, new Uint8Array(16).fill(255)), b = new TextEncoder().encode('hello');
  const z = C.zipFiles([{ name: 'art/enemies/slime.png', bytes: a }, { name: 'notes/ü.txt', bytes: b }]);
  fs.writeFileSync(path.join(dir, 'x.zip'), z);
  const r = spawnSync('python3', ['-I', '-c', 'import zipfile,sys,json; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps({n.filename: len(z.read(n)) for n in z.infolist()}))', path.join(dir, 'x.zip')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { 'art/enemies/slime.png': a.length, 'notes/ü.txt': 5 });
});
test('colorsOf counts by use and lists transparent last', () => {
  const a = C.pack(1, 2, 3), b = C.pack(9, 9, 9);
  const out = C.colorsOf(Uint32Array.from([a, b, a, 0, a, 0]));
  assert.deepEqual(out, [[a, 3], [b, 1], [0, 2]]);
});

/* ---------- scanner ---------- */
test('PNG fixtures round-trip through the test encoder', () => {
  const d = decodePng(SLIME.png);
  assert.equal(d.w, 4); assert.deepEqual([...d.rgba], [...SLIME.rgba]);
});
test('scan lists small PNGs, skips big ones, ignored folders, links and non-PNGs', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'assets/sprites'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules/x'), { recursive: true }); fs.mkdirSync(path.join(root, '.godot'));
  fs.writeFileSync(path.join(root, 'assets/sprites/slime.png'), SLIME.png);
  fs.writeFileSync(path.join(root, 'assets/hero.png'), SLIME.png);
  fs.writeFileSync(path.join(root, 'node_modules/x/dep.png'), SLIME.png); fs.writeFileSync(path.join(root, '.godot/cache.png'), SLIME.png);
  fs.writeFileSync(path.join(root, 'assets/notes.txt'), 'x'); fs.writeFileSync(path.join(root, 'assets/fake.png'), 'not a png at all, just text that is long enough');
  const big = encodePng(2048, 1, Buffer.alloc(2048 * 4)); fs.writeFileSync(path.join(root, 'assets/huge.png'), big);
  fs.symlinkSync(path.join(root, 'assets'), path.join(root, 'loop'));
  const m = scan(root);
  assert.deepEqual(m.sprites.map((s) => s.path), ['assets/hero.png', 'assets/sprites/slime.png']);
  assert.equal(m.sprites[0].w, 4); assert.equal(m.sprites[0].h, 4);
  assert.equal(readPngSize(path.join(root, 'assets/fake.png')), null);
});
test('config: dirs, exclude, maxSize, frames (exact and glob) and palette', () => {
  const root = tmp();
  for (const d of ['art', 'other', 'art/wip']) fs.mkdirSync(path.join(root, d), { recursive: true });
  for (const f of ['art/a.png', 'art/b.png', 'art/wip/c.png', 'other/d.png']) fs.writeFileSync(path.join(root, f), SLIME.png);
  fs.writeFileSync(path.join(root, 'pal.hex'), '1a1c2c\n5d275d\n');
  fs.writeFileSync(path.join(root, 'spritewright.config.json'), JSON.stringify({ dirs: ['art'], exclude: ['art/wip/**'], palette: 'pal.hex', frames: { 'art/a.png': { w: 2, h: 4, fps: 6 }, 'art/b*': { w: 4, h: 2 } } }));
  const m = scan(root);
  assert.deepEqual(m.sprites.map((s) => s.path), ['art/a.png', 'art/b.png']);
  assert.deepEqual(m.sprites[0].frames, { w: 2, h: 4, fps: 6 }); assert.deepEqual(m.sprites[1].frames, { w: 4, h: 2 });
  assert.deepEqual(m.palette, ['#1a1c2c', '#5d275d']);
  assert.equal(scan(root, { maxSize: 2, dirs: ['art'] }).sprites.length, 0);
});
test('git info: slug from the remote and the folder prefix inside the repo', () => {
  assert.equal(slugFromRemote('git@github.com:me/my-game.git'), 'me/my-game');
  assert.equal(slugFromRemote('https://github.com/me/my-game'), 'me/my-game');
  assert.equal(slugFromRemote('https://gitlab.com/a/b.git'), null);
  const repo = tmp(); fs.mkdirSync(path.join(repo, '.git')); fs.mkdirSync(path.join(repo, 'game/art'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git/config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:me/game.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
  assert.deepEqual(gitInfo(repo), { slug: 'me/game', prefix: '' });
  assert.deepEqual(gitInfo(path.join(repo, 'game')), { slug: 'me/game', prefix: 'game/' });
  assert.equal(globToRegExp('a/**/b*.png').test('a/x/y/bz.png'), true);
  assert.equal(globToRegExp('a/*.png').test('a/x/y.png'), false);
});

/* ---------- server ---------- */
function req(url, { method = 'GET', headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url), r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { ...headers, ...(host ? { host } : {}) } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
    });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}
test('safeResolve rejects traversal, hidden and ignored paths', () => {
  const root = fs.realpathSync(tmp());
  assert.equal(safeResolve(root, 'a/b.png'), path.join(root, 'a/b.png'));
  for (const bad of ['../x.png', 'a/../../x.png', '%2e%2e/x.png', 'a%2f..%2f..%2fx.png', '/etc/passwd', '.git/config', 'node_modules/a.png', 'a\\b.png', '', 'a/%00.png']) assert.equal(safeResolve(root, bad), null, bad);
});
test('the server lists, serves and writes sprites, and refuses everything else', async () => {
  const root = tmp(); fs.mkdirSync(path.join(root, 'art')); fs.writeFileSync(path.join(root, 'art/slime.png'), SLIME.png); fs.writeFileSync(path.join(root, 'secret.txt'), 'top secret');
  const s = createServer({ root, port: 0 }), base = await s.listen();
  try {
    const mf = JSON.parse((await req(base + 'api/manifest')).body);
    assert.deepEqual(mf.sprites.map((x) => x.path), ['art/slime.png']);
    const home = (await req(base)).body.toString(); assert.match(home, new RegExp(`name="pf-token" content="${s.token}"`));
    assert.equal((await req(base + 'spritewright.js')).status, 200);
    const png = await req(base + 'project/art/slime.png'); assert.equal(png.status, 200); assert.ok(png.body.equals(SLIME.png));
    assert.equal((await req(base + 'project/secret.txt')).status, 403, 'only png/hex are served');
    assert.equal((await req(base + 'project/..%2fsecret.txt')).status, 400);
    assert.equal((await req(base + 'project/.git/config')).status, 400);
    const edited = fromRows(['rrrr', 'rrrr'], { r: [255, 0, 0] }).png;
    assert.equal((await req(base + 'project/art/slime.png', { method: 'PUT', body: edited })).status, 403, 'no token');
    assert.equal((await req(base + 'project/art/slime.png', { method: 'PUT', headers: { 'x-spritewright': 'wrong' }, body: edited })).status, 403, 'wrong token');
    assert.equal((await req(base + 'project/art/slime.png', { method: 'PUT', headers: { 'x-spritewright': s.token }, body: Buffer.from('hello hello hello hello hello hello hello hello') })).status, 400, 'not a PNG');
    assert.equal((await req(base + 'project/art/run.sh', { method: 'PUT', headers: { 'x-spritewright': s.token }, body: edited })).status, 400, 'only png');
    assert.equal((await req(base + 'project/..%2f..%2fx.png', { method: 'PUT', headers: { 'x-spritewright': s.token }, body: edited })).status, 400, 'traversal');
    assert.equal((await req(base + 'project/art/slime.png', { method: 'PUT', headers: { 'x-spritewright': s.token }, body: edited })).status, 200);
    assert.ok(fs.readFileSync(path.join(root, 'art/slime.png')).equals(edited), 'written to disk');
    assert.equal((await req(base + 'project/art/new/dir/x.png', { method: 'PUT', headers: { 'x-spritewright': s.token }, body: edited })).status, 200);
    assert.ok(fs.existsSync(path.join(root, 'art/new/dir/x.png')), 'new files and folders can be created inside the project');
    assert.deepEqual(fs.readdirSync(path.join(root, 'art')).filter((n) => n.includes('pf-tmp')), [], 'no temp files left behind');
    assert.equal((await req(base + 'project/art/slime.png', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'x-spritewright' } })).headers['access-control-allow-origin'], undefined, 'no CORS preflight approval');
    assert.equal((await req(base + 'api/manifest', { host: 'evil.example' })).status, 403, 'DNS-rebinding style host header');
    assert.equal((await req(base + 'api/manifest', { host: `localhost:${new URL(base).port}` })).status, 200);
  } finally { await s.close(); }
});

/* ---------- pull request client ---------- */
function fakeGithub({ canPush = true, forkReadyAfter = 0 } = {}) {
  const calls = []; let forkChecks = 0;
  const json = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
  const fetch = async (url, init = {}) => {
    const u = new URL(url), p = u.pathname, method = init.method || 'GET', body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, p, body, auth: init.headers.Authorization });
    if (init.headers.Authorization !== 'Bearer good') return json(401, { message: 'Bad credentials' });
    if (method === 'GET' && p === '/user') return json(200, { login: 'artist' });
    if (method === 'GET' && p === '/repos/me/game') return json(200, { name: 'game', default_branch: 'main', permissions: { push: canPush } });
    if (method === 'POST' && p === '/repos/me/game/forks') return json(202, { full_name: 'artist/game' });
    if (method === 'GET' && p === '/repos/artist/game') return forkChecks++ < forkReadyAfter ? json(404, { message: 'Not Found' }) : json(200, { name: 'game' });
    if (method === 'POST' && p === '/repos/artist/game/merge-upstream') return json(200, { merge_type: 'none' });
    if (method === 'GET' && p === '/repos/me/game/git/ref/heads/main') return json(200, { object: { sha: 'base123' } });
    if (method === 'GET' && p === '/repos/me/game/git/commits/base123') return json(200, { tree: { sha: 'tree0' } });
    const head = canPush ? 'me/game' : 'artist/game';
    if (method === 'POST' && p === `/repos/${head}/git/blobs`) return json(201, { sha: 'blob' + calls.filter((c) => c.p.endsWith('/blobs')).length });
    if (method === 'POST' && p === `/repos/${head}/git/trees`) return json(201, { sha: 'tree1' });
    if (method === 'POST' && p === `/repos/${head}/git/commits`) return json(201, { sha: 'commit1' });
    if (method === 'POST' && p === `/repos/${head}/git/refs`) return json(201, { ref: body.ref });
    if (method === 'POST' && p === '/repos/me/game/pulls') return json(201, { html_url: 'https://github.com/me/game/pull/7', number: 7 });
    return json(404, { message: 'unexpected ' + method + ' ' + p });
  };
  return { fetch, calls };
}
const FILES = [{ path: 'art/slime.png', blob: SLIME.png }, { path: 'art/hero.png', blob: new Uint8Array([1, 2, 3]) }];
test('PR: with push access the branch goes to the repo itself', async () => {
  const gh = fakeGithub(); const log = [];
  const r = await PF.createPullRequest({ token: 'good', repo: 'me/game', title: 'Update slime', body: (ctx) => 'base=' + ctx.baseSha, prefix: 'game/', files: FILES, branch: 'art/update', fetch: gh.fetch, onProgress: (m) => log.push(m) });
  assert.equal(r.url, 'https://github.com/me/game/pull/7'); assert.equal(r.forked, false);
  assert.deepEqual(gh.calls.map((c) => c.method + ' ' + c.p), ['GET /user', 'GET /repos/me/game', 'GET /repos/me/game/git/ref/heads/main', 'GET /repos/me/game/git/commits/base123', 'POST /repos/me/game/git/blobs', 'POST /repos/me/game/git/blobs', 'POST /repos/me/game/git/trees', 'POST /repos/me/game/git/commits', 'POST /repos/me/game/git/refs', 'POST /repos/me/game/pulls']);
  const blobBody = gh.calls.find((c) => c.p.endsWith('/blobs')).body; assert.equal(blobBody.encoding, 'base64'); assert.ok(Buffer.from(blobBody.content, 'base64').equals(SLIME.png), 'the PNG bytes survive base64');
  const tree = gh.calls.find((c) => c.p.endsWith('/trees')).body; assert.equal(tree.base_tree, 'tree0'); assert.deepEqual(tree.tree.map((t) => t.path), ['game/art/slime.png', 'game/art/hero.png']); assert.ok(tree.tree.every((t) => t.mode === '100644' && t.type === 'blob'));
  const commit = gh.calls.find((c) => c.p.endsWith('/commits') && c.method === 'POST').body; assert.deepEqual(commit.parents, ['base123']); assert.equal(commit.tree, 'tree1');
  assert.equal(gh.calls.find((c) => c.p.endsWith('/refs')).body.ref, 'refs/heads/art/update');
  const pr = gh.calls.find((c) => c.p.endsWith('/pulls')).body; assert.equal(pr.head, 'art/update'); assert.equal(pr.base, 'main'); assert.equal(pr.body, 'base=base123'); assert.equal(pr.title, 'Update slime');
  assert.ok(log.length >= 5);
});
test('PR: without push access it forks, waits for the fork, and opens the PR from artist:branch', async () => {
  const gh = fakeGithub({ canPush: false, forkReadyAfter: 2 });
  const r = await PF.createPullRequest({ token: 'good', repo: 'me/game', title: 'Fix', files: FILES.slice(0, 1), branch: 'art/fix', fetch: gh.fetch, forkDelay: 1 });
  assert.equal(r.forked, true);
  const seq = gh.calls.map((c) => c.method + ' ' + c.p);
  assert.ok(seq.indexOf('POST /repos/me/game/forks') < seq.indexOf('POST /repos/artist/game/git/blobs'), 'fork first');
  assert.equal(seq.filter((s) => s === 'GET /repos/artist/game').length, 3, 'polled until the fork existed');
  assert.ok(seq.includes('POST /repos/artist/game/git/refs') && !seq.includes('POST /repos/me/game/git/refs'), 'branch is created on the fork');
  assert.equal(gh.calls.find((c) => c.p === '/repos/me/game/pulls').body.head, 'artist:art/fix');
});
test('PR: clear errors for bad input and bad tokens', async () => {
  const gh = fakeGithub();
  await assert.rejects(PF.createPullRequest({ token: '', repo: 'me/game', title: 't', files: FILES, fetch: gh.fetch }), /token is required/);
  await assert.rejects(PF.createPullRequest({ token: 'good', repo: 'nonsense', title: 't', files: FILES, fetch: gh.fetch }), /owner\/name/);
  await assert.rejects(PF.createPullRequest({ token: 'good', repo: 'me/game', title: 't', files: [], fetch: gh.fetch }), /no changed sprites/);
  await assert.rejects(PF.createPullRequest({ token: 'bad', repo: 'me/game', title: 't', files: FILES, fetch: gh.fetch }), /401.*Bad credentials/);
});
test('prBody lists the files and pixel counts', () => {
  const b = PF.prBody({ files: [{ path: 'a/b.png', w: 16, h: 16, pixels: 12 }], description: 'Better eyes', repo: 'me/game', baseSha: 'abc', commit: 'def', prefix: '' });
  assert.match(b, /Better eyes/); assert.match(b, /\| `a\/b.png` \| 16×16 \| 12 \|/); assert.match(b, /raw.githubusercontent.com\/me\/game\/abc\/a\/b.png/); assert.match(b, /raw.githubusercontent.com\/me\/game\/def\/a\/b.png/);
});

test('prBody with previews: upscaled copies from the preview commit, shown at their real size (no blurry scaling)', () => {
  const b = PF.prBody({ files: [{ path: 'a/b.png', w: 32, h: 32, pixels: 5, scale: 8, baseW: 32 }, { path: 'new.png', w: 16, h: 16, pixels: 256, scale: 16, isNew: true }], repo: 'me/game', headRepo: 'artist/game', baseSha: 'abc', commit: 'def', previewSha: 'p1' });
  assert.match(b, /<img src="https:\/\/raw.githubusercontent.com\/artist\/game\/p1\/0-before.png" width="256">/);
  assert.match(b, /<img src="https:\/\/raw.githubusercontent.com\/artist\/game\/p1\/0-after.png" width="256">/);
  assert.match(b, /a\/b.png\*\* \(shown 8×\)/); assert.match(b, /_new file_ \| <img src="[^"]*\/1-after.png" width="256">/);
  assert.ok(!/width="128"/.test(b), 'no browser-scaled images');
});
test('PR: previews go in a commit on no branch, kept by a hidden ref; the PR files and branch are untouched', async () => {
  const gh = fakeGithub(); let ctxSeen;
  const r = await PF.createPullRequest({ token: 'good', repo: 'me/game', title: 't', files: FILES.slice(0, 1), previews: [{ before: new Uint8Array([9]), after: new Uint8Array([8]) }], branch: 'art/x', fetch: gh.fetch, body: (ctx) => { ctxSeen = ctx; return 'b'; } });
  const trees = gh.calls.filter((c) => c.p.endsWith('/trees')).map((c) => c.body), commits = gh.calls.filter((c) => c.method === 'POST' && c.p.endsWith('/commits')).map((c) => c.body), refs = gh.calls.filter((c) => c.p.endsWith('/refs')).map((c) => c.body);
  assert.deepEqual(trees[0].tree.map((t) => t.path), ['0-before.png', '0-after.png']); assert.equal(trees[0].base_tree, undefined, 'the preview tree is standalone');
  assert.deepEqual(commits[0].parents, [], 'the preview commit is not part of any branch');
  assert.deepEqual(trees[1].tree.map((t) => t.path), ['art/slime.png'], 'the branch commit only has the sprite'); assert.deepEqual(commits[1].parents, ['base123']);
  assert.deepEqual(refs.map((x) => x.ref), ['refs/spritewright/previews/art/x', 'refs/heads/art/x']);
  assert.equal(ctxSeen.previewSha, 'commit1'); assert.equal(ctxSeen.previewDir, ''); assert.equal(r.previewSha, 'commit1');
});
test('PR: if the hidden ref is refused, previews go in a commit under the change, which removes them again', async () => {
  const gh = fakeGithub(); let n = 0;
  const f = async (url, init = {}) => {
    if (String(url).endsWith('/git/refs') && init.body && init.body.includes('refs/spritewright')) return { ok: false, status: 403, text: async () => '{"message":"Resource not accessible by integration"}' };
    const res = await gh.fetch(url, init); if (String(url).endsWith('/git/commits') && init.method === 'POST') { n++; return { ok: true, status: 201, text: async () => JSON.stringify({ sha: 'c' + n }) }; } return res;
  };
  let ctx; const r = await PF.createPullRequest({ token: 'good', repo: 'me/game', title: 't', files: FILES.slice(0, 1), previews: [{ before: new Uint8Array([9]), after: new Uint8Array([8]) }], branch: 'art/z', fetch: f, body: (c) => { ctx = c; return 'b'; } });
  const trees = gh.calls.filter((c) => c.p.endsWith('/trees')).map((c) => c.body), commits = gh.calls.filter((c) => c.method === 'POST' && c.p.endsWith('/commits')).map((c) => c.body);
  assert.equal(trees.length, 3, 'standalone preview tree (refused), preview tree on the base, sprite tree');
  assert.deepEqual(trees[1].tree.map((t) => t.path), ['.spritewright-previews/0-before.png', '.spritewright-previews/0-after.png']); assert.equal(trees[1].base_tree, 'tree0');
  assert.deepEqual(commits[1].parents, ['base123']); assert.deepEqual(commits[2].parents, ['c2'], 'the change sits on top of the preview commit');
  assert.equal(trees[2].base_tree, 'tree0', 'the change is built from the base tree, so the previews are gone again and the PR diff is only the sprite');
  assert.equal(ctx.previewSha, 'c2'); assert.equal(ctx.previewDir, '.spritewright-previews/'); assert.equal(r.commit, 'c3');
  assert.match(PF.prBody({ files: [{ path: 'a.png', w: 32, h: 32, pixels: 1, scale: 8 }], repo: 'me/game', previewSha: 'c2', previewDir: ctx.previewDir }), /me\/game\/c2\/\.spritewright-previews\/0-after\.png" width="256"/);
});
test('PR: if previews fail altogether the PR still opens, with plain links', async () => {
  const gh = fakeGithub(), log = [];
  const f = async (url, init = {}) => (String(url).endsWith('/git/trees') && init.body && init.body.includes('-after.png') ? { ok: false, status: 500, text: async () => '{"message":"boom"}' } : gh.fetch(url, init));
  const r = await PF.createPullRequest({ token: 'good', repo: 'me/game', title: 't', files: FILES.slice(0, 1), previews: [{ after: new Uint8Array([8]) }], branch: 'art/y', fetch: f, body: (ctx) => 'p=' + ctx.previewSha, onProgress: (m) => log.push(m) });
  assert.equal(r.previewSha, null); assert.equal(gh.calls.find((c) => c.p.endsWith('/pulls')).body.body, 'p=null'); assert.ok(log.some((m) => /Previews skipped/.test(m)));
  assert.deepEqual(gh.calls.filter((c) => c.method === 'POST' && c.p.endsWith('/commits')).map((c) => c.body.parents), [['base123']]);
});

test('githubSource: public repositories read files from the raw CDN at the listed commit; private ones and failures use the API; hidden files are reported', async () => {
  const mk = (isPrivate, rawOk = true) => { const calls = []; const fetch = async (url) => { calls.push(String(url)); const u = new URL(url);
      const json = (o) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(o) });
      if (u.host === 'raw.example') return rawOk ? { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([7, 7]).buffer } : { ok: false, status: 404 };
      if (u.pathname === '/repos/me/g') return json({ default_branch: 'main', private: isPrivate });
      if (u.pathname === '/repos/me/g/git/ref/heads/main') return json({ object: { sha: 'c9' } });
      if (u.pathname === '/repos/me/g/git/commits/c9') return json({ tree: { sha: 't9' } });
      if (u.pathname === '/repos/me/g/git/trees/t9') return json({ tree: [{ path: 'art/a b.png', type: 'blob', sha: 's1', size: 10 }, { path: 'docs/screenshots/x.png', type: 'blob', sha: 's2', size: 10 }] });
      if (u.pathname === '/repos/me/g/git/blobs/s1') return json({ encoding: 'base64', content: Buffer.from([1, 2]).toString('base64') });
      return { ok: false, status: 404, headers: { get: () => null }, text: async () => '{}' }; }; return { fetch, calls }; };
  const pub = mk(false), src = await PF.sources.githubSource({ repo: 'me/g', fetch: pub.fetch, rawBase: 'https://raw.example' });
  assert.equal(src.thumbs, true, 'thumbnails are on for GitHub repositories');
  assert.deepEqual(src.sprites.map((x) => x.path), ['art/a b.png']); assert.deepEqual(src.hidden.map((x) => x.path), ['docs/screenshots/x.png'], 'screenshots are left out by default but reported');
  assert.deepEqual([...await src.read('art/a b.png')], [7, 7]); assert.ok(pub.calls.includes('https://raw.example/me/g/c9/art/a%20b.png'), 'the raw URL is pinned to the commit and encoded');
  assert.ok(!pub.calls.some((c) => c.includes('/git/blobs/')), 'no API call for the file');
  const priv = mk(true), ps = await PF.sources.githubSource({ repo: 'me/g', fetch: priv.fetch, rawBase: 'https://raw.example' });
  assert.deepEqual([...await ps.read('art/a b.png')], [1, 2]); assert.ok(!priv.calls.some((c) => c.includes('raw.example')), 'private repositories never use the CDN');
  const down = mk(false, false), ds = await PF.sources.githubSource({ repo: 'me/g', fetch: down.fetch, rawBase: 'https://raw.example' });
  assert.deepEqual([...await ds.read('art/a b.png')], [1, 2], 'a CDN failure falls back to the API');
  const ghe = mk(false), gs = await PF.sources.githubSource({ repo: 'me/g', fetch: ghe.fetch, apiBase: 'https://api.example' });
  await gs.read('art/a b.png').catch(() => {}); assert.ok(!ghe.calls.some((c) => c.includes('raw')), 'a custom apiBase (GitHub Enterprise) does not guess a CDN');
});

// a small, independent GIF reader to check the encoder against
function readGif(u8) {
  const r16 = (o) => u8[o] | (u8[o + 1] << 8);
  assert.equal(String.fromCharCode(...u8.slice(0, 6)), 'GIF89a');
  const W = r16(6), H = r16(8), packed = u8[10], gct = 1 << ((packed & 7) + 1), pal = [];
  for (let i = 0; i < gct; i++) pal.push([u8[13 + i * 3], u8[14 + i * 3], u8[15 + i * 3]]);
  let o = 13 + gct * 3, loop = false; const frames = []; let gce = null;
  while (u8[o] !== 0x3b) {
    if (u8[o] === 0x21) { const label = u8[o + 1]; if (label === 0xff && String.fromCharCode(...u8.slice(o + 3, o + 14)) === 'NETSCAPE2.0') loop = true; if (label === 0xf9) gce = { transparent: u8[o + 3] & 1, delay: r16(o + 4), index: u8[o + 6] }; o += 2; while (u8[o]) o += u8[o] + 1; o++; continue; }
    assert.equal(u8[o], 0x2c); const w = r16(o + 5), h = r16(o + 7), min = u8[o + 10]; o += 11; const data = []; while (u8[o]) { data.push(...u8.slice(o + 1, o + 1 + u8[o])); o += u8[o] + 1; } o++;
    // LZW decode
    const clear = 1 << min, eoi = clear + 1; let size = min + 1, dict = [], prev = null, bitpos = 0; const out = [];
    const reset = () => { dict = []; for (let i = 0; i < clear; i++) dict[i] = [i]; dict[clear] = []; dict[eoi] = null; size = min + 1; prev = null; };
    reset();
    for (;;) { let code = 0; for (let b = 0; b < size; b++, bitpos++) code |= ((data[bitpos >> 3] >> (bitpos & 7)) & 1) << b;
      if (code === clear) { reset(); continue; } if (code === eoi) break;
      let entry = dict[code]; if (!entry) entry = prev.concat(prev[0]); out.push(...entry);
      if (prev) dict.push(prev.concat(entry[0])); prev = entry; if (dict.length === 1 << size && size < 12) size++; }
    frames.push({ w, h, idx: out, gce }); gce = null;
  }
  return { W, H, pal, loop, frames };
}
test('encodeGif: looping animation, exact colours, transparency, scale, and frames bottom-centred', () => {
  const R = C.pack(255, 0, 0), B = C.pack(0, 0, 255), f1 = { w: 2, h: 2, px: new Uint32Array([R, 0, 0, B]) }, f2 = { w: 1, h: 1, px: new Uint32Array([B]) };
  const g = readGif(C.encodeGif([f1, f2], { delay: 10, scale: 2 }));
  assert.equal(g.W, 4); assert.equal(g.H, 4); assert.equal(g.loop, true); assert.equal(g.frames.length, 2);
  for (const f of g.frames) { assert.equal(f.gce.transparent, 1); assert.equal(f.gce.index, 0); assert.equal(f.gce.delay, 10); assert.equal(f.idx.length, 16); }
  const col = (fr, x, y) => { const i = g.frames[fr].idx[y * 4 + x]; return i === 0 ? 'clear' : g.pal[i].join(','); };
  assert.deepEqual([col(0, 0, 0), col(0, 1, 1), col(0, 2, 0), col(0, 3, 3)], ['255,0,0', '255,0,0', 'clear', '0,0,255'], 'scaled 2x, red top-left, blue bottom-right');
  assert.deepEqual([col(1, 1, 2), col(1, 1, 3), col(1, 2, 3), col(1, 0, 0)], ['0,0,255', '0,0,255', 'clear', 'clear'], 'a smaller frame sits at the bottom, centred (rounding left)');
  // many colours and long runs: the LZW table fills and resets correctly
  const big = { w: 64, h: 64, px: new Uint32Array(64 * 64).map((_, i) => C.pack((i * 7) & 255, (i * 13) & 255, (i >> 6) * 3)) };
  const gb = readGif(C.encodeGif([big]));
  const exact = gb.frames[0].idx.filter((v, i) => { const c = big.px[i]; return gb.pal[v].join() === [c & 255, (c >> 8) & 255, (c >> 16) & 255].join(); }).length;
  assert.equal(gb.frames[0].idx.length, 4096); assert.equal(exact, 255, 'all 4096 colours are distinct: the 255 kept ones are exact'); assert.ok(gb.frames[0].idx.every((v) => v >= 1 && v <= 255), 'the rest map to a kept colour (none turn transparent)');
  const flat = readGif(C.encodeGif([{ w: 100, h: 100, px: new Uint32Array(10000).fill(R) }]));
  assert.ok(flat.frames[0].idx.every((v) => v === 1));
});

test('variants: shiftColor keeps clear and outlines, variantPath names the copies', () => {
  const red = C.pack(200, 40, 40);
  assert.equal(C.shiftColor(0, 90, 0, 0, true), 0);
  assert.equal(C.shiftColor(C.pack(10, 10, 12), 120, 0, 0, true), C.pack(10, 10, 12), 'near-black outline kept');
  const [h] = C.toHsv(C.shiftColor(red, 120, 0, 0, true)); assert.ok(Math.abs(h - 120) < 2, 'hue rotated: ' + h);
  assert.equal(C.shiftColor(C.pack(10, 200, 250, 128), 0, 0, 0, false) >>> 24, 128, 'alpha kept');
  assert.ok(C.toHsv(C.shiftColor(red, 0, 0, -0.5, false))[2] < C.toHsv(red)[2]);
  assert.equal(C.variantPath('e/king_atk.png', 'king', 'dark'), 'e/king_dark_atk.png');
  assert.equal(C.variantPath('king.png', 'king', 'dark'), 'king_dark.png');
  assert.equal(C.variantPath('p/flame_2.png', 'flame', 'blue'), 'p/flame_blue_2.png');
});

const gitRepo = () => { const root = tmp(); const g = (...a) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' }); g('init', '-q'); return { root, g }; };
test('local server: a sprite\'s git history and the file as it was', async () => {
  const { root, g } = gitRepo(); fs.mkdirSync(path.join(root, 'art'));
  const v1 = fromRows(['r'], { r: [255, 0, 0] }).png, v2 = fromRows(['b'], { b: [0, 0, 255] }).png;
  fs.writeFileSync(path.join(root, 'art/x.png'), v1); g('add', '.'); g('commit', '-qm', 'first red');
  fs.writeFileSync(path.join(root, 'art/x.png'), v2); g('commit', '-qam', 'now blue');
  const s = createServer({ root, port: 0 }); const base = await s.listen();
  try {
    const list = await (await fetch(base + 'api/history?path=art/x.png')).json();
    assert.deepEqual(list.map((c) => c.message), ['now blue', 'first red']); assert.equal(list[0].author, 't'); assert.match(list[0].sha, /^[0-9a-f]{40}$/);
    const old = Buffer.from(await (await fetch(`${base}api/file-at?path=art/x.png&sha=${list[1].sha}`)).arrayBuffer());
    assert.ok(old.equals(v1), 'the old version, byte for byte');
    assert.equal((await fetch(`${base}api/file-at?path=art/x.png&sha=nothex`)).status, 400);
    assert.equal((await fetch(`${base}api/history?path=../etc/passwd`)).status, 400);
    assert.equal((await fetch(`${base}api/history?path=README.md`)).status, 400, 'PNGs only');
  } finally { await s.close(); }
  const plain = tmp(); fs.mkdirSync(path.join(plain, 'a')); fs.writeFileSync(path.join(plain, 'a/y.png'), v1);
  const s2 = createServer({ root: plain, port: 0 }); const b2 = await s2.listen();
  try { assert.deepEqual(await (await fetch(b2 + 'api/history?path=a/y.png')).json(), [], 'no git: no history, no error'); } finally { await s2.close(); }
});

test('spritewright check: errors, warnings and the PR summary', async () => {
  const { check, markdown } = await import('../src/check.mjs');
  const { root, g } = gitRepo(); fs.mkdirSync(path.join(root, 'art'));
  const px = (rows, map) => fromRows(rows, map).png;
  fs.writeFileSync(path.join(root, 'palette.hex'), 'ff0000\n0000ff\n');
  fs.writeFileSync(path.join(root, 'spritewright.config.json'), JSON.stringify({ palette: 'palette.hex' }));
  fs.writeFileSync(path.join(root, 'art/a.png'), px(['rr', 'rr'], { r: [255, 0, 0] }));
  fs.writeFileSync(path.join(root, 'art/keep.png'), px(['b'], { b: [0, 0, 255] }));
  g('add', '.'); g('commit', '-qm', 'base');
  fs.writeFileSync(path.join(root, 'art/a.png'), px(['rrr', 'rrr'], { r: [255, 0, 0] }));             // size changed
  fs.writeFileSync(path.join(root, 'art/off.png'), px(['g'], { g: [0, 255, 0] }));                      // off palette
  fs.writeFileSync(path.join(root, 'art/walk_0.png'), px(['r'], { r: [255, 0, 0] }));
  fs.writeFileSync(path.join(root, 'art/walk_1.png'), px(['rr'], { r: [255, 0, 0] }));                 // frames differ in size
  fs.writeFileSync(path.join(root, 'art/empty.png'), px(['.'], {}));                                     // fully transparent
  fs.writeFileSync(path.join(root, 'art/broken.png'), Buffer.concat([readFileSyncSafe(path.join(root, 'art/keep.png')).subarray(0, 40), Buffer.alloc(30)])); // corrupt
  g('add', '.'); g('commit', '-qm', 'changes');
  const res = await check(root, { since: 'HEAD~1' });
  const row = (p) => res.rows.find((r) => r.path === p);
  assert.deepEqual(res.rows.map((r) => r.path).sort(), ['art/a.png', 'art/broken.png', 'art/empty.png', 'art/off.png', 'art/walk_0.png', 'art/walk_1.png'], 'only changed sprites, keep.png untouched');
  assert.match(row('art/a.png').warnings.join(), /size changed from 2×2/);
  assert.match(row('art/off.png').warnings.join(), /1 colour outside the palette \(#00ff00\)/);
  assert.match(row('art/walk_1.png').warnings.join(), /frames of "walk" differ in size/);
  assert.match(row('art/empty.png').warnings.join(), /fully transparent/);
  assert.equal(row('art/broken.png').errors.length, 1);
  assert.equal(res.errors, 1); assert.ok(res.warnings >= 5);
  const md = markdown(res); assert.match(md, /\| `art\/off\.png` \| 1×1 \| 1 \| new \| ⚠️ 1 colour outside the palette/); assert.match(md, /\*\*1 error, \d+ warnings\*\*/);
  const cli = spawnSync(process.execPath, ['bin/spritewright.mjs', 'check', root, '--since', 'HEAD~1', '--summary', path.join(root, 'summary.md')], { encoding: 'utf8' });
  assert.equal(cli.status, 1, 'errors fail the run'); assert.match(fs.readFileSync(path.join(root, 'summary.md'), 'utf8'), /## Art check/);
  const clean = spawnSync(process.execPath, ['bin/spritewright.mjs', 'check', root, '--since', 'HEAD'], { encoding: 'utf8' });
  assert.equal(clean.status, 0); assert.match(clean.stdout, /No sprites changed since `HEAD`/);
});
const readFileSyncSafe = (p) => fs.readFileSync(p);

/* ---------- lossless PNG codec ---------- */
const rgbaOf = (r) => [...new Uint8Array(r.px.buffer)];
test('codec: RGBA round trip is exact, including semi-transparent pixels (a game may use an alpha value such as 250 as a marker)', async () => {
  const w = 16, h = 16, rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { const a = [255, 250, 250, 128, 1, 0][i % 6]; rgba.set(a === 0 ? [0, 0, 0, 0] : [(i * 37) & 255, (i * 91 + 13) & 255, (i * 53 + 200) & 255, a], i * 4); }
  const png = await PF.png.encode(w, h, new Uint32Array(rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.length)));
  const viaTestDecoder = decodePng(Buffer.from(png));
  assert.deepEqual([...viaTestDecoder.rgba], [...rgba], 'an independent decoder reads back what we wrote');
  const back = await PF.png.decode(new Uint8Array(png));
  assert.deepEqual(rgbaOf(back), [...rgba], 'and so do we');
});
test('codec: transparent pixels keep their hidden RGB too (nothing is premultiplied)', async () => {
  const px = new Uint32Array([C.pack(10, 20, 30, 0), C.pack(255, 255, 255, 3)]);
  const back = await PF.png.decode(await PF.png.encode(2, 1, px));
  assert.deepEqual([...back.px], [...px]);
});
test('codec: scaled export repeats every pixel', async () => {
  const px = new Uint32Array([C.pack(1, 2, 3), C.pack(4, 5, 6)]);
  const big = await PF.png.decode(await PF.png.encode(2, 1, px, 3));
  assert.equal(big.w, 6); assert.equal(big.h, 3);
  assert.deepEqual([...big.px], [px[0], px[0], px[0], px[1], px[1], px[1], px[0], px[0], px[0], px[1], px[1], px[1], px[0], px[0], px[0], px[1], px[1], px[1]]);
});
test('codec: reads every filter type (rows cycle through 0-4)', async () => {
  const w = 7, h = 10, rows = Array.from({ length: h }, (_, y) => Uint8Array.from({ length: w * 4 }, (_, i) => (y * 31 + i * 17 + ((i * y) % 7)) & 255));
  const r = await PF.png.decode(new Uint8Array(encodeRaw({ w, h, depth: 8, ct: 6, rows })));
  assert.deepEqual(rgbaOf(r), rows.flatMap((x) => [...x]));
});
test('codec: reads 8-bit RGB, grey and grey+alpha', async () => {
  const rgb = await PF.png.decode(new Uint8Array(encodeRaw({ w: 2, h: 2, depth: 8, ct: 2, rows: [[1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12]] })));
  assert.deepEqual(rgbaOf(rgb), [1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]);
  const grey = await PF.png.decode(new Uint8Array(encodeRaw({ w: 3, h: 1, depth: 8, ct: 0, rows: [[0, 128, 255]] })));
  assert.deepEqual(rgbaOf(grey), [0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255]);
  const ga = await PF.png.decode(new Uint8Array(encodeRaw({ w: 2, h: 1, depth: 8, ct: 4, rows: [[50, 200, 90, 0]] })));
  assert.deepEqual(rgbaOf(ga), [50, 50, 50, 200, 90, 90, 90, 0]);
});
test('codec: reads indexed PNGs at 1, 2, 4 and 8 bits with tRNS transparency', async () => {
  const plte = [255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30];
  for (const [depth, row, idx] of [[8, [0, 1, 2, 3], [0, 1, 2, 3]], [4, [0x01, 0x23], [0, 1, 2, 3]], [2, [0b00011011], [0, 1, 2, 3]], [1, [0b01000000], [0, 1, 0, 0]]]) {
    const n = idx.length;
    const r = await PF.png.decode(new Uint8Array(encodeRaw({ w: n, h: 1, depth, ct: 3, rows: [row], plte, trns: [255, 128], filters: [0] })));
    const want = idx.flatMap((k) => [plte[k * 3], plte[k * 3 + 1], plte[k * 3 + 2], k === 0 ? 255 : k === 1 ? 128 : 255]);
    assert.deepEqual(rgbaOf(r), want, depth + '-bit indexed');
  }
});
test('codec: grey tRNS colour key and 16-bit images', async () => {
  const k = await PF.png.decode(new Uint8Array(encodeRaw({ w: 2, h: 1, depth: 8, ct: 0, rows: [[7, 9]], trns: [0, 7] })));
  assert.deepEqual(rgbaOf(k), [7, 7, 7, 0, 9, 9, 9, 255]);
  const sixteen = await PF.png.decode(new Uint8Array(encodeRaw({ w: 1, h: 1, depth: 16, ct: 6, rows: [[0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xff, 0xff]] })));
  assert.deepEqual(rgbaOf(sixteen), [0x12, 0x56, 0x9a, 0xff], '16-bit is reduced to its high byte');
});
test('codec: refuses damaged, non-PNG and interlaced input with a clear error', async () => {
  await assert.rejects(PF.png.decode(new Uint8Array(50)), /not a PNG/);
  const ok = encodePng(2, 2, Buffer.alloc(16));
  await assert.rejects(PF.png.decode(new Uint8Array(ok.subarray(0, 40))), /damaged/);
  const inter = Buffer.from(ok); inter[28] = 1; await assert.rejects(PF.png.decode(new Uint8Array(inter)), /interlaced/);
});

/* ---------- sources: GitHub repository ---------- */
function fakeRepo({ files, branch = 'main', canPush = true, truncated = false, tokenRequired = false, rate = false }) {
  const tree = Object.entries(files).map(([path, bytes], i) => ({ path, type: 'blob', sha: 'sha' + i, size: bytes.length })), calls = [];
  const res = (status, body, headers = {}) => ({ ok: status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => JSON.stringify(body) });
  const fetch = async (url, init = {}) => {
    const u = new URL(url), p = u.pathname; calls.push(p + u.search);
    if (rate) return res(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' });
    if (tokenRequired && !init.headers.Authorization) return res(404, { message: 'Not Found' });
    if (init.headers.Authorization === 'Bearer bad') return res(401, { message: 'Bad credentials' });
    if (p === '/repos/me/game') return res(200, { default_branch: branch, permissions: { push: canPush } });
    if (p === '/repos/me/game/git/ref/heads/' + branch) return res(200, { object: { sha: 'c1' } });
    if (p === '/repos/me/game/git/commits/c1') return res(200, { tree: { sha: 't1' } });
    if (p === '/repos/me/game/git/trees/t1') return res(200, { tree, truncated });
    const m = /\/git\/blobs\/(sha\d+)$/.exec(p); if (m) { const e = tree[+m[1].slice(3)]; return res(200, { encoding: 'base64', content: Buffer.from(files[e.path]).toString('base64').replace(/(.{60})/g, '$1\n') }); }
    return res(404, { message: 'Not Found' });
  };
  return { fetch, calls };
}
test('GitHub source: lists PNGs, applies the repo config, skips junk, and reads exact bytes', async () => {
  const files = { 'art/hero.png': SLIME.png, 'art/wip/x.png': SLIME.png, 'docs/shot.png': SLIME.png, 'node_modules/a/b.png': SLIME.png, 'art/readme.md': Buffer.from('x'), 'art/big.png': Buffer.alloc(300000),
    'pal.hex': Buffer.from('1a1c2c\n5d275d\n'), 'spritewright.config.json': Buffer.from(JSON.stringify({ dirs: ['art'], exclude: ['art/wip/**'], palette: 'pal.hex', frames: { 'art/hero.png': { w: 2, h: 4, fps: 6 } } })) };
  const gh = fakeRepo({ files }), src = await PF.sources.githubSource({ repo: 'me/game', fetch: gh.fetch });
  assert.equal(src.kind, 'github'); assert.equal(src.branch, 'main');
  assert.deepEqual(src.sprites.map((s) => s.path), ['art/hero.png']);
  assert.deepEqual(src.sprites[0].frames, { w: 2, h: 4, fps: 6 });
  assert.deepEqual(src.palette, ['#1a1c2c', '#5d275d']);
  assert.deepEqual(src.repo, { slug: 'me/game', base: 'main', defaultBranch: 'main', prefix: '', canPush: true });
  assert.ok(Buffer.from(await src.read('art/hero.png')).equals(SLIME.png), 'the PNG survives the base64 transport byte for byte (even with line breaks in the base64)');
  await assert.rejects(src.read('nope.png'), /not in the repository/);
});
test('GitHub source: branch names with slashes, truncated trees, and helpful errors', async () => {
  const gh = fakeRepo({ files: { 'a.png': SLIME.png }, branch: 'release/1.0' });
  const src = await PF.sources.githubSource({ repo: 'me/game', branch: 'release/1.0', fetch: gh.fetch });
  assert.equal(src.sprites.length, 1); assert.ok(gh.calls.includes('/repos/me/game/git/ref/heads/release/1.0'), 'slashes are kept in the ref path');
  assert.match((await PF.sources.githubSource({ repo: 'me/game', fetch: fakeRepo({ files: {}, truncated: true }).fetch })).note, /incomplete/);
  await assert.rejects(PF.sources.githubSource({ repo: 'me/game', fetch: fakeRepo({ files: {}, tokenRequired: true }).fetch }), /not found.*private repository/s);
  await assert.rejects(PF.sources.githubSource({ repo: 'me/game', token: 'bad', fetch: fakeRepo({ files: {} }).fetch }), /rejected the sign-in or token/);
  await assert.rejects(PF.sources.githubSource({ repo: 'me/game', fetch: fakeRepo({ files: {}, rate: true }).fetch }), /rate limit/);
  await assert.rejects(PF.sources.githubSource({ repo: 'nonsense' }), /owner\/name/);
  assert.equal((await PF.sources.githubSource({ repo: 'me/game', token: 'good', fetch: fakeRepo({ files: {}, tokenRequired: true }).fetch })).sprites.length, 0, 'with a token a private repository opens');
});
test('PR client: a base branch with slashes works', async () => {
  const seen = [];
  const fetch = async (url, init) => { const p = new URL(url).pathname; seen.push(p); const j = (st, b) => ({ ok: true, status: st, text: async () => JSON.stringify(b) });
    if (p === '/user') return j(200, { login: 'a' }); if (p === '/repos/me/game') return j(200, { name: 'game', default_branch: 'main', permissions: { push: true } });
    if (p.includes('/git/ref/heads/')) return j(200, { object: { sha: 'b' } }); if (p.includes('/git/commits/')) return j(200, { tree: { sha: 't' } });
    if (p.endsWith('/blobs')) return j(201, { sha: 'x' }); if (p.endsWith('/trees')) return j(201, { sha: 't2' }); if (p.endsWith('/commits')) return j(201, { sha: 'c' }); if (p.endsWith('/refs')) return j(201, {});
    return j(201, { html_url: 'https://github.com/me/game/pull/1', number: 1 }); };
  await PF.createPullRequest({ token: 't', repo: 'me/game', base: 'release/1.0', title: 'x', files: [{ path: 'a.png', blob: new Uint8Array([1]) }], fetch });
  assert.ok(seen.includes('/repos/me/game/git/ref/heads/release/1.0'));
});
test('applyConfig: dirs, ignore, exclude and frames', () => {
  const items = ['art/a.png', 'art/sub/b.png', 'other/c.png', 'art/node_modules/d.png', 'art/tmp/e.png'].map((path) => ({ path }));
  const out = PF.sources.applyConfig(items, { dirs: ['art'], exclude: ['art/tmp/**'], frames: { 'art/sub/*.png': { w: 8, h: 8 } } });
  assert.deepEqual(out.map((x) => x.path), ['art/a.png', 'art/sub/b.png']); assert.deepEqual(out[1].frames, { w: 8, h: 8 });
  assert.equal(PF.sources.applyConfig(items, {}).length, 4, 'no config: everything except ignored folders');
});

/* ---------- init ---------- */
test('scan with no config leaves out docs, screenshots and previews folders; init still sees everything', () => {
  const root = tmp(); for (const d of ['art', 'docs/previews', 'game/screenshots']) fs.mkdirSync(path.join(root, d), { recursive: true });
  for (const f of ['art/a.png', 'docs/previews/p.png', 'game/screenshots/s.png']) fs.writeFileSync(path.join(root, f), SLIME.png);
  assert.deepEqual(scan(root).sprites.map((x) => x.path), ['art/a.png']);
  assert.deepEqual(scan(root).hidden.map((x) => x.path), ['docs/previews/p.png', 'game/screenshots/s.png'], 'and reports what it left out, so the editor can offer to show it');
  assert.equal(scan(root, { dirs: [] }).sprites.length, 3, 'init scans with dirs: [] and sees all of them');
  fs.writeFileSync(path.join(root, 'spritewright.config.json'), JSON.stringify({ keepDocs: true }));
  assert.equal(scan(root).sprites.length, 3, 'keepDocs: true lists them');
});
test('suggestConfig picks the art folders and skips docs, screenshots and previews', () => {
  const sprites = ['art/hero.png', 'art/enemies/bat.png', 'art/previews/bat-preview.png', 'public/ui/icon.png', 'docs/previews/a.png', 'docs/b.png', 'tests/fixtures/c.png'].map((path) => ({ path }));
  const { config, kept, skipped } = suggestConfig({ sprites });
  assert.deepEqual(config.dirs, ['art', 'public']); assert.deepEqual(config.exclude, ['art/previews/**']); assert.equal(kept, 3); assert.equal(skipped, 4);
  assert.deepEqual(suggestConfig({ sprites: [{ path: 'hero.png' }, { path: 'bat.png' }] }).config, {}, 'sprites at the project root: scan everything');
});
test('the init command writes a config that makes the next scan skip the junk, and refuses to overwrite', () => {
  const root = tmp(); for (const d of ['assets/art', 'docs/previews']) fs.mkdirSync(path.join(root, d), { recursive: true });
  for (const f of ['assets/art/a.png', 'assets/art/b.png', 'docs/previews/p.png']) fs.writeFileSync(path.join(root, f), SLIME.png);
  const bin = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'spritewright.mjs');
  const r = spawnSync('node', [bin, 'init', root], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /3 PNGs found, 2 look like game art/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'spritewright.config.json'), 'utf8')).dirs, ['assets']);
  assert.deepEqual(scan(root).sprites.map((s) => s.path), ['assets/art/a.png', 'assets/art/b.png']);
  assert.equal(spawnSync('node', [bin, 'init', root], { encoding: 'utf8' }).status, 1, 'second run refuses');
  assert.equal(spawnSync('node', [bin, 'init', root, '--force'], { encoding: 'utf8' }).status, 0);
});

test('the file registers the global AND module.exports, so bundlers that treat it as CommonJS still work', async () => {
  const vm = await import('node:vm'); const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'spritewright.js'), 'utf8');
  const cjs = { module: { exports: {} } }; cjs.globalThis = cjs; vm.runInNewContext(src, cjs);
  assert.equal(typeof cjs.module.exports.mount, 'function'); assert.equal(typeof cjs.Spritewright.mount, 'function');
  const script = {}; script.globalThis = script; vm.runInNewContext(src, script);
  assert.equal(typeof script.Spritewright.mount, 'function', 'plain <script> use');
});

test('error explanations are in plain language and keep the raw detail', () => {
  const E = PF.auth.explainError;
  assert.match(E(401, 'Bad credentials', 'GET /user'), /expired or was revoked.*Sign in again/s);
  assert.match(E(403, 'Resource not accessible by integration', 'POST /x', 'me/game'), /not allowed.*me\/game.*Contents and Pull requests.*install the app/s);
  assert.match(E(403, 'Resource protected by organization SAML enforcement', 'GET /x'), /single sign-on/);
  assert.match(E(403, 'API rate limit exceeded', 'GET /x'), /rate limit/);
  assert.match(E(404, 'Not Found', 'GET /x', 'me/game'), /not found for me\/game.*private/s);
  assert.match(E(422, 'Reference already exists', 'POST /refs'), /already exists/);
  assert.match(E(500, 'oops', 'GET /x'), /500 oops/);
  assert.match(E(401, 'x', 'GET /user'), /\[GET \/user: 401 x\]/, 'the raw status and message stay at the end for bug reports');
});
test('listRepos prefers GitHub App installations and falls back to the user repos', async () => {
  const json = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
  const app = async (url) => (url.includes('/user/installations?') ? json({ installations: [{ id: 7 }] }) : url.includes('/installations/7/repositories') ? json({ repositories: [{ full_name: 'me/game' }, { full_name: 'me/art' }] }) : { ok: false, status: 404, text: async () => '{}' });
  assert.deepEqual(await PF.auth.listRepos('t', { fetch: app }), ['me/game', 'me/art']);
  const pat = async (url) => (url.includes('/user/repos') ? json([{ full_name: 'me/a' }, { full_name: 'me/a' }, { full_name: 'me/b' }]) : { ok: false, status: 404, text: async () => '{}' });
  assert.deepEqual(await PF.auth.listRepos('t', { fetch: pat }), ['me/a', 'me/b']);
  const det = async (url) => (url.includes('/user/installations?') ? json({ installations: [{ id: 7 }] }) : json({ repositories: [{ full_name: 'me/game', private: true, default_branch: 'master', permissions: { push: true } }, { full_name: 'them/art', permissions: { push: false, pull: true } }] }));
  assert.deepEqual(await PF.auth.listRepos('t', { fetch: det, details: true }), [{ name: 'me/game', private: true, push: true, branch: 'master' }, { name: 'them/art', private: false, push: false, branch: null }]);
});
test('auth.refresh posts the refresh token to the service and reports an expired one with its status', async () => {
  let sent;
  const ok = async (url, init) => { sent = { url, init }; return { ok: true, status: 200, text: async () => JSON.stringify({ token: 'ghu_2', expires_in: 28800, refresh_token: 'ghr_2', refresh_token_expires_in: 100 }) }; };
  assert.deepEqual(await PF.auth.refresh('https://auth.example/', 'ghr_1', { fetch: ok }), { token: 'ghu_2', expiresIn: 28800, refreshToken: 'ghr_2', refreshExpiresIn: 100 });
  assert.equal(sent.url, 'https://auth.example/refresh'); assert.equal(sent.init.method, 'POST'); assert.deepEqual(JSON.parse(sent.init.body), { refresh_token: 'ghr_1' });
  assert.equal(sent.init.headers['content-type'], 'text/plain', 'a simple request: no CORS preflight');
  const bad = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: 'The refresh token passed is incorrect or expired.' }) });
  await assert.rejects(PF.auth.refresh('https://auth.example', 'old', { fetch: bad }), (e) => e.status === 401 && /expired/.test(e.message));
});
test('githubSignIn: accepts only the right origin and nonce, reports popup problems', async () => {
  const listeners = []; let closed = false;
  const win = { location: { href: 'https://app.example/', origin: 'https://app.example' }, crypto: { getRandomValues: (a) => a.fill(7) }, addEventListener: (t, f) => listeners.push(f), removeEventListener: (t, f) => listeners.splice(listeners.indexOf(f), 1),
    open: (url) => { win.openedUrl = url; return { get closed() { return closed; }, close() { closed = true; } }; } };
  const p = PF.auth.signIn('https://auth.example', { win });
  assert.match(win.openedUrl, /^https:\/\/auth\.example\/login\?origin=https%3A%2F%2Fapp\.example&nonce=07070707/);
  const nonce = '07'.repeat(16);
  listeners[0]({ origin: 'https://evil.example', data: { type: 'pf-auth', nonce, token: 'stolen' } }); // wrong origin: ignored
  listeners[0]({ origin: 'https://auth.example', data: { type: 'pf-auth', nonce: 'other', token: 'x' } }); // wrong nonce: ignored
  listeners[0]({ origin: 'https://auth.example', data: { type: 'pf-auth', nonce, token: 'gho_ok', expires_in: 28800, refresh_token: 'ghr_1', refresh_token_expires_in: 15811200 } });
  assert.deepEqual(await p, { token: 'gho_ok', expiresIn: 28800, refreshToken: 'ghr_1', refreshExpiresIn: 15811200 });
  assert.equal(listeners.length, 0, 'the listener is removed afterwards');
  await assert.rejects(PF.auth.signIn('', { win }), /not set up/);
  await assert.rejects(PF.auth.signIn('https://auth.example', { win: { ...win, open: () => null } }), /blocked/);
  const w2 = { ...win, addEventListener: (t, f) => listeners.push(f), removeEventListener: () => {} };
  const err = PF.auth.signIn('https://auth.example', { win: w2 }); listeners.at(-1)({ origin: 'https://auth.example', data: { type: 'pf-auth', nonce, error: 'access_denied' } });
  await assert.rejects(err, /access_denied/);
});

test('snapAlpha: specks clear, near-opaque solid, kept values kept or restored from the original', () => {
  const rule = C.normAlpha({ clear: 15, solid: 245, keep: [250] }), px = (a) => ((a << 24) | 0x112233) >>> 0;
  const img = new Uint32Array([px(3), px(15), px(16), px(244), px(248), px(251), px(250), px(255), px(128), 0]);
  const base = new Uint32Array(img.length); base[5] = px(250);
  assert.equal(C.snapAlpha(img, rule, base), 4);
  assert.deepEqual([...img].map((v) => v >>> 24), [0, 0, 16, 244, 255, 250, 250, 255, 128, 0]);
  assert.equal(img[0], 0, 'a cleared speck loses its colour too');
  assert.equal(img[4] & 0xffffff, 0x112233, 'a snapped pixel keeps its colour');
  assert.equal(C.snapAlpha(img, null), 0, 'no rule, no change');
  assert.deepEqual(C.normAlpha({ clear: '9', solid: 999, keep: [0, 250, 255, 'x'] }), { clear: 9, solid: 255, keep: [250] });
  assert.equal(C.normAlpha(null), null);
});

test('normGroups: arrays or { sprites, background }, order kept, junk dropped', () => {
  const g = C.normGroups({ Crypt: { background: '#040308', sprites: ['a.png', 7, 'b.png'] }, Blades: ['c.png'], Empty: [], Bad: { background: 'red', sprites: ['d.png'] } });
  assert.deepEqual(g, [
    { name: 'Crypt', sprites: ['a.png', 'b.png'], background: '#040308' },
    { name: 'Blades', sprites: ['c.png'], background: null },
    { name: 'Bad', sprites: ['d.png'], background: null },
  ]);
  assert.deepEqual(C.normGroups(['x']), []);
  assert.deepEqual(C.normGroups(undefined), []);
});

test('scan reads groups (inline or from a file) and the alpha rule into the manifest', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'art')); fs.writeFileSync(path.join(dir, 'art/a.png'), encodePng(2, 2, new Uint8Array(16).fill(255)));
  fs.writeFileSync(path.join(dir, 'groups.json'), JSON.stringify({ Mobs: ['art/a.png'] }));
  fs.writeFileSync(path.join(dir, 'spritewright.config.json'), JSON.stringify({ groups: 'groups.json', alpha: { clear: 15, solid: 245, keep: [250] } }));
  const m = scan(dir);
  assert.deepEqual(m.groups, { Mobs: ['art/a.png'] });
  assert.deepEqual(m.alpha, { clear: 15, solid: 245, keep: [250] });
  fs.writeFileSync(path.join(dir, 'spritewright.config.json'), JSON.stringify({ groups: { Inline: ['art/a.png'] } }));
  assert.deepEqual(scan(dir).groups, { Inline: ['art/a.png'] });
  assert.equal(scan(dir).alpha, null);
});

test('countDiff: clear pixels are equal whatever colour they carry, so erasing nothing is no change', () => {
  const a = new Uint32Array([0x00ffffff, 0x00000000, 0xff0000ff]), b = new Uint32Array([0x00000000, 0x00123456, 0xff0000ff]);
  assert.equal(C.countDiff(a, b), 0);
  b[2] = 0x00000000; assert.equal(C.countDiff(a, b), 1, 'opaque to clear still counts');
});

/* ---------- feedback link ---------- */
test('feedback.url: a prefilled issue form in the repository, with the details whole and the link under GitHub\'s limit', () => {
  const F = PF.feedback, details = F.details([['Project', 'a|b'], ['Browser', 'Firefox\n128']]);
  assert.equal(details, '| | |\n|---|---|\n| Project | a\\|b |\n| Browser | Firefox 128 |');
  const u = new URL(F.url({ what: '  The fill tool leaks through diagonal gaps when I click near the edge  ', details, kind: 'bug' }));
  assert.equal(u.origin + u.pathname, 'https://github.com/snowu/spritewright/issues/new');
  assert.equal(u.searchParams.get('template'), 'feedback.yml');
  assert.equal(u.searchParams.get('title'), 'Bug: The fill tool leaks through diagonal gaps when I click…');
  assert.equal(u.searchParams.get('what'), 'The fill tool leaks through diagonal gaps when I click near the edge');
  assert.equal(u.searchParams.get('details'), details);
  assert.match(u.searchParams.get('body'), /### What happened\?\n\nThe fill tool[\s\S]*### Details\n\n\| \| \|/);
  assert.equal(new URL(F.url({ what: 'hi', kind: 'idea', repo: 'me/game' })).pathname, '/me/game/issues/new');
  assert.equal(new URL(F.url({ what: 'hi', kind: 'idea' })).searchParams.get('title'), 'Idea: hi');
  assert.equal(new URL(F.url({ what: '', details })).searchParams.has('title'), false, 'no words, no title: the reporter writes one');
  const long = F.url({ what: 'word '.repeat(5000), details });
  assert.ok(long.length <= 7500, 'a long description is trimmed to fit: ' + long.length);
  assert.equal(new URL(long).searchParams.get('details'), details, 'the details are never trimmed');
  assert.match(new URL(long).searchParams.get('what'), /trimmed to fit the link/);
  assert.ok(F.title('x'.repeat(500)).length <= 100, 'one long word is capped too');
});


/* ---------- art folders ---------- */
test('artFolders / folderConfig: folders two deep with counts, docs unticked, and the config a pick becomes', () => {
  const paths = ['icon.png', 'assets/sprites/a.png', 'assets/sprites/deep/b.png', 'assets/tiles/c.png', 'assets/sprites/screenshots/x.png', 'docs/d.png', 'node_modules/p/e.png'];
  assert.deepEqual(C.artFolders(paths), [{ dir: '', count: 1, art: true }, { dir: 'assets/sprites', count: 3, art: true }, { dir: 'assets/tiles', count: 1, art: true }, { dir: 'docs', count: 1, art: false }]);
  assert.deepEqual(C.folderConfig(paths, ['assets/sprites', 'assets/tiles']), { dirs: ['assets/sprites', 'assets/tiles'], exclude: ['assets/sprites/screenshots/**'] }, 'screenshots nested in a picked folder stay out');
  assert.deepEqual(C.folderConfig(paths, ['', 'assets/sprites', 'assets/tiles']), { exclude: ['assets/sprites/screenshots/**', 'docs/**'] }, 'with the top level picked, what was left out is excluded instead');
  assert.deepEqual(C.folderConfig(paths, ['assets/tiles', '']), { exclude: ['assets/sprites/**', 'docs/**'] });
  assert.deepEqual(C.folderConfig(['a/x.png', 'b.png'], ['a']), { dirs: ['a'], exclude: [] });
});

/* ---------- dither gradient ---------- */
test('ditherGradient: pure a at the start, pure b at the end, an even ordered dither between, and only inside the region', () => {
  const w = 17, h = 4, A = 1, B = 2, all = [...Array(w * h).keys()];
  const px = C.ditherGradient(new Uint32Array(w * h), w, all, 0, 0, 16, 0, A, B);
  const col = (x) => [0, 1, 2, 3].map((y) => px[y * w + x]);
  assert.deepEqual(col(0), [A, A, A, A], 'the start column is all a');
  assert.deepEqual(col(16), [B, B, B, B], 'the end column is all b');
  const share = (x0, x1) => { let n = 0, t = 0; for (let x = x0; x < x1; x++) for (const v of col(x)) { t++; if (v === B) n++; } return n / t; };
  assert.ok(share(0, 4) < share(6, 10) && share(6, 10) < share(13, 17), 'b grows along the drag');
  assert.ok(Math.abs(share(4, 12) - 0.5) < 0.15, 'about half and half in the middle: ' + share(4, 12));
  assert.ok([...px].every((v) => v === A || v === B), 'every pixel is one of the two colours, never a blend');
  const some = C.ditherGradient(new Uint32Array(w * h).fill(9), w, [0, 1, 2], 0, 0, 2, 0, A, B);
  assert.equal([...some].filter((v) => v === 9).length, w * h - 3, 'pixels outside the region are untouched');
});

/* ---------- selection masks ---------- */
test('selection masks: rect ↔ mask, lasso polygons, add and subtract', () => {
  const W = 8, H = 6;
  const r = C.selMask({ x: 1, y: 1, w: 3, h: 2 }, W, H); assert.equal(r.reduce((a, b) => a + b, 0), 6);
  assert.deepEqual(C.maskSel(r, W, H), { x: 1, y: 1, w: 3, h: 2 }, 'a full box comes back as a plain rectangle');
  const l = r.slice(); l[2 * W + 2] = 0; l[2 * W + 3] = 0; // an L
  const sel = C.maskSel(l, W, H); assert.deepEqual([sel.x, sel.y, sel.w, sel.h], [1, 1, 3, 2]); assert.deepEqual([...sel.mask], [1, 1, 1, 1, 0, 0]);
  assert.deepEqual([...C.selMask(sel, W, H)], [...l], 'and round-trips');
  assert.equal(C.maskSel(new Uint8Array(W * H), W, H), null, 'empty is no selection');
  const tri = C.lassoMask([[0, 0], [6, 0], [0, 5]], W, H), on = (x, y) => tri[y * W + x];
  assert.ok(on(0, 0) && on(6, 0) && on(0, 5) && on(1, 1) && on(2, 2), 'corners, edges and the inside');
  assert.ok(!on(6, 5) && !on(5, 4) && !on(7, 0), 'not outside the slope');
  const b = C.selMask({ x: 3, y: 1, w: 2, h: 1 }, W, H);
  assert.equal(C.combineMasks(r, b, 'add').reduce((a, v) => a + v, 0), 7, 'add');
  assert.equal(C.combineMasks(r, b, 'sub').reduce((a, v) => a + v, 0), 5, 'subtract');
  assert.equal(C.combineMasks(r, b, null), b, 'replace');
});
