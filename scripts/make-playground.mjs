// Draws examples/playground: small sprites made to show each editor feature at a glance (see its README).
// node scripts/make-playground.mjs   (rewrites the PNGs; uses the editor's own lossless encoder)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

await import('../spritewright.js');
const PF = globalThis.Spritewright;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'playground');

/* ---------- a tiny canvas ---------- */
const hex = (h) => { const n = parseInt(h.replace('#', ''), 16); return (0xff000000 | ((n & 0xff) << 16) | (n & 0xff00) | ((n >> 16) & 0xff)) >>> 0; };
function img(w, h) {
  const px = new Uint32Array(w * h);
  const set = (x, y, c) => { if (x >= 0 && y >= 0 && x < w && y < h) px[y * w + x] = c; };
  return {
    w, h, px, set,
    rect(x, y, rw, rh, c) { for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) set(x + i, y + j, c); },
    box(x, y, rw, rh, c) { for (let i = 0; i < rw; i++) { set(x + i, y, c); set(x + i, y + rh - 1, c); } for (let j = 0; j < rh; j++) { set(x, y + j, c); set(x + rw - 1, y + j, c); } },
    line(x0, y0, x1, y1, c) { for (const [x, y] of PF.core.linePoints(x0, y0, x1, y1)) set(x, y, c); },
    disc(cx, cy, r, c) { for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r + r * 0.6) set(cx + x, cy + y, c); },
    ring(cx, cy, r, c) { for (let y = -r - 1; y <= r + 1; y++) for (let x = -r - 1; x <= r + 1; x++) { const d = Math.sqrt(x * x + y * y); if (d > r - 0.5 && d <= r + 0.5) set(cx + x, cy + y, c); } },
    digit(n, x, y, c) { const g = DIGITS[n]; for (let j = 0; j < 5; j++) for (let i = 0; i < 3; i++) if (g[j][i] === '#') set(x + i, y + j, c); },
  };
}
const DIGITS = { 0: ['###', '#.#', '#.#', '#.#', '###'], 1: ['.#.', '##.', '.#.', '.#.', '###'], 2: ['##.', '..#', '.#.', '#..', '###'], 3: ['##.', '..#', '.#.', '..#', '##.'], 4: ['#.#', '#.#', '###', '..#', '..#'] };
async function save(rel, im) { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, await PF.png.encode(im.w, im.h, im.px)); console.log('  ' + rel, im.w + '×' + im.h); }

/* ---------- the palette (8 colours: also the indexed-mode palette and the colour budget) ---------- */
const P = { ink: hex('#1a1426'), stone: hex('#4a3f63'), stoneLt: hex('#7d6e9e'), moss: hex('#3e7a4f'), gold: hex('#e3b04b'), red: hex('#c8434b'), sky: hex('#5aa7d6'), bone: hex('#efe6d2') };
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, 'palette.hex'), Object.values(P).map((c) => [c & 255, (c >> 8) & 255, (c >> 16) & 255].map((v) => v.toString(16).padStart(2, '0')).join('')).join('\n') + '\n');
console.log('  palette.hex  8 colours');

/* 1. tile grid and stylus: a 64×64 sheet of 16×16 dungeon tiles */
{
  const t = img(64, 64);
  for (let ty = 0; ty < 4; ty++) for (let tx = 0; tx < 4; tx++) {
    const x0 = tx * 16, y0 = ty * 16, kind = (tx + ty) % 4;
    if (kind === 0) { t.rect(x0, y0, 16, 16, P.stone); for (let j = 0; j < 16; j += 4) t.line(x0, y0 + j, x0 + 15, y0 + j, P.ink); for (let j = 0; j < 4; j++) t.line(x0 + (j % 2 ? 4 : 11), y0 + j * 4, x0 + (j % 2 ? 4 : 11), y0 + j * 4 + 3, P.ink); }
    else if (kind === 1) { t.rect(x0, y0, 16, 16, P.stone); t.set(x0 + 3, y0 + 4, P.stoneLt); t.set(x0 + 10, y0 + 9, P.stoneLt); t.set(x0 + 6, y0 + 13, P.stoneLt); }
    else if (kind === 2) { t.rect(x0, y0, 16, 16, P.stone); t.rect(x0 + 2, y0 + 10, 12, 4, P.moss); t.set(x0 + 5, y0 + 9, P.moss); t.set(x0 + 11, y0 + 8, P.moss); }
    else { t.rect(x0, y0, 16, 16, P.ink); t.box(x0 + 1, y0 + 1, 14, 14, P.stoneLt); t.disc(x0 + 8, y0 + 8, 3, P.gold); }
  }
  await save('tiles/dungeon-tiles.png', t);
}

/* 2. dither gradient: a window of empty sky in a stone frame, and a flat orb */
{
  const s = img(48, 32);
  s.rect(0, 0, 48, 32, P.stone); s.rect(3, 3, 42, 20, 0); s.box(2, 2, 44, 22, P.ink); s.rect(0, 26, 48, 6, P.moss); s.line(0, 25, 47, 25, P.ink);
  await save('gradient/sky-window.png', s);
  const o = img(24, 24); o.disc(12, 12, 9, P.sky); o.ring(12, 12, 10, P.ink);
  await save('gradient/orb.png', o);
}

/* 3. selection: same-colour islands (wand: area vs same colour), an L, a ring with a hole, a star for the lasso */
{
  const b = img(32, 32);
  b.disc(6, 6, 3, P.red); b.disc(25, 7, 3, P.red); b.disc(15, 26, 2, P.red); // three red islands, not touching
  b.rect(3, 15, 3, 9, P.sky); b.rect(3, 21, 9, 3, P.sky); // a blue L
  b.ring(22, 21, 5, P.moss); // a green ring: the wand inside it picks the hole
  for (const [x, y] of [[15, 9], [14, 11], [16, 11], [12, 12], [18, 12], [15, 13], [13, 15], [17, 15]]) b.set(x, y, P.gold); b.line(13, 12, 17, 12, P.gold); b.line(14, 14, 16, 14, P.gold); b.set(15, 10, P.gold);
  await save('selection/islands.png', b);
}

/* 4. pixel check: one sprite full of the mistakes it marks, one clean sprite it must leave alone */
{
  const m = img(32, 32);
  m.rect(2, 2, 14, 12, P.stoneLt); m.box(2, 2, 14, 12, P.ink);
  m.set(8, 7, 0); // a hole in the fill
  m.rect(10, 4, 3, 3, (P.stoneLt - 4) >>> 0); // a patch 4 values off the fill: a near-duplicate colour
  m.set(24, 3, P.ink); m.set(29, 12, P.gold); // dust on the clear background
  for (let i = 0; i < 6; i++) { m.set(3 + i, 18 + i, P.red); m.set(4 + i, 18 + i, P.red); } // a jagged diagonal, every step doubled
  m.line(17, 18, 27, 28, P.sky); // the same diagonal drawn clean, for comparison
  await save('lint/mistakes.png', m);
  const c = img(32, 32);
  c.rect(2, 2, 14, 12, P.stoneLt); c.box(2, 2, 14, 12, P.ink); // box corners are fine
  c.set(6, 5, P.bone); c.set(11, 9, P.bone); // highlights inside a fill are fine
  c.line(3, 18, 12, 27, P.red); // a clean diagonal
  c.rect(18, 18, 10, 10, P.moss); c.set(20, 20, P.stone); c.set(24, 22, P.stone); c.set(22, 26, P.stone); // grain in a texture
  c.rect(18, 3, 3, 12, P.sky); // a thick line
  await save('lint/clean.png', c);
}

/* 5. rotation and smooth ×2: an outlined sword (try Rotate… 30°, 45°), and diagonals and a circle (try Smooth ×2) */
{
  const sw = img(16, 32);
  sw.rect(7, 2, 2, 19, P.bone); sw.line(6, 3, 6, 20, P.ink); sw.line(9, 3, 9, 20, P.ink); sw.set(7, 1, P.ink); sw.set(8, 1, P.ink); sw.line(8, 3, 8, 19, P.stoneLt);
  sw.rect(3, 21, 10, 2, P.gold); sw.box(2, 20, 12, 4, P.ink); sw.rect(7, 24, 2, 5, P.red); sw.line(6, 24, 6, 28, P.ink); sw.line(9, 24, 9, 28, P.ink); sw.disc(7, 30, 1, P.gold);
  await save('rotate/sword.png', sw);
  const dg = img(16, 16);
  dg.line(0, 15, 15, 0, P.ink); dg.line(0, 7, 7, 0, P.red); dg.line(8, 15, 15, 8, P.sky); dg.ring(8, 8, 4, P.moss); dg.line(2, 12, 13, 6, P.gold); // 45°, a 2:1 slope and a circle
  await save('rotate/diagonals.png', dg);
}

/* 6. animation: a 4-frame sheet with the frame number in each frame (reorder, copy, delete, holds), and a numbered family */
{
  const sh = img(64, 16);
  for (let k = 0; k < 4; k++) { const x0 = k * 16; sh.box(x0, 0, 16, 16, P.stone); sh.digit(k + 1, x0 + 2, 2, P.bone); sh.disc(x0 + 5 + k * 2, 11, 2, P.red); }
  await save('animation/counter-sheet.png', sh);
  for (let k = 0; k < 4; k++) {
    const f = img(16, 16), h = [10, 12, 11, 13][k], lean = [0, 1, 0, -1][k]; // taller, leaning a little each frame
    for (let y = 0; y < h; y++) { const wdt = Math.max(1, Math.round((h - y) / 2.4)), sx = 8 - wdt + Math.round((lean * y) / h * 2); f.rect(sx, 15 - y, wdt * 2, 1, y < 3 ? P.red : y < h - 3 ? P.gold : P.bone); }
    f.digit(k, 0, 0, P.stoneLt);
    await save(`animation/flame_${k}.png`, f);
  }
}

/* 7. indexed mode and the colour budget: 10 colours, two of them a few values off palette colours */
{
  const p = img(16, 16);
  p.rect(6, 1, 4, 2, P.stone); p.rect(5, 3, 6, 2, P.ink); p.disc(8, 10, 5, P.red); p.ring(8, 10, 5, P.ink); p.rect(5, 7, 2, 2, P.bone); p.set(10, 12, P.gold);
  p.rect(6, 11, 3, 2, hex('#cc474f')); // red, slightly off: not in the palette (Snap or Indexed fixes it)
  p.set(5, 9, hex('#f2e9d6')); // bone, slightly off
  p.rect(7, 3, 2, 1, P.stoneLt); p.set(11, 8, P.sky); p.set(4, 13, P.moss);
  await save('indexed/potion.png', p);
}

/* 8. review notes: a face with one eye a pixel too high, something to pin a note to */
{
  const f = img(24, 24);
  f.disc(12, 12, 9, P.bone); f.ring(12, 12, 10, P.ink); f.rect(7, 9, 2, 2, P.ink); f.rect(15, 8, 2, 2, P.ink); f.line(8, 16, 16, 16, P.red); f.set(7, 15, P.red); f.set(17, 15, P.red);
  await save('notes/face.png', f);
}

/* 9. layers: a slime in three layers (colour, shading, line art), saved flat in slime.png and as layers in slime.layers.png */
{
  const colour = img(16, 16), shade = img(16, 16), line = img(16, 16);
  colour.disc(8, 10, 5, P.moss); colour.rect(3, 10, 11, 5, P.moss);
  shade.rect(4, 13, 9, 2, P.ink); shade.set(6, 7, P.bone); shade.set(7, 7, P.bone); shade.set(6, 8, P.bone);
  line.ring(8, 10, 5, P.ink); line.line(3, 15, 13, 15, P.ink); line.rect(6, 10, 1, 2, P.ink); line.rect(10, 10, 1, 2, P.ink);
  for (let i = 0; i < 16 * 16; i++) if (!colour.px[i] && (shade.px[i] || line.px[i])) { shade.px[i] = 0; } // shading only inside the body
  const layers = [{ name: 'colour', px: colour.px }, { name: 'shading', opacity: 60, px: shade.px }, { name: 'line art', px: line.px }];
  const flat = PF.core.flattenLayers(layers, 16 * 16);
  await save('layers/slime.png', { w: 16, h: 16, px: flat });
  const pk = PF.core.packLayers(layers, 16, 16), f = path.join(root, 'layers/slime.layers.png');
  fs.writeFileSync(f, await PF.png.encode(pk.w, pk.h, pk.px, 1, pk.text)); console.log('  layers/slime.layers.png', pk.w + '×' + pk.h, '3 layers');
}

/* 10. layers as an artist uses them: a 32×32 knight with a hidden rough sketch, flat colours, shading at 70 % and line art on top */
{
  const W = 32, sketch = img(W, W), colour = img(W, W), shade = img(W, W), line = img(W, W);
  sketch.ring(16, 9, 6, P.sky); sketch.line(16, 15, 16, 25, P.sky); sketch.line(16, 25, 11, 31, P.sky); sketch.line(16, 25, 21, 31, P.sky); sketch.line(9, 18, 23, 18, P.sky); // stick figure
  colour.disc(16, 9, 6, P.stoneLt); colour.rect(11, 15, 11, 10, P.stoneLt); colour.rect(12, 25, 3, 6, P.stone); colour.rect(18, 25, 3, 6, P.stone); colour.rect(13, 8, 7, 2, P.ink); // helmet, body, legs, visor
  colour.rect(23, 6, 2, 18, P.bone); colour.rect(21, 18, 6, 2, P.gold); colour.rect(6, 15, 5, 9, P.red); colour.rect(15, 1, 2, 3, P.red); // sword, guard, shield, plume
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) if (colour.px[y * W + x] === P.stoneLt && x >= 16 + (y < 15 ? 2 : 3)) shade.set(x, y, P.stone); // shadow on the right half
  shade.set(13, 5, P.bone); shade.set(14, 4, P.bone); shade.rect(7, 16, 1, 7, P.bone); // highlights
  line.ring(16, 9, 6, P.ink); line.box(10, 15, 13, 11, P.ink); line.box(11, 24, 5, 8, P.ink); line.box(17, 24, 5, 8, P.ink); line.box(5, 14, 7, 11, P.ink); line.box(22, 5, 4, 20, P.ink);
  const layers = [{ name: 'sketch', visible: false, px: sketch.px }, { name: 'flat colours', px: colour.px }, { name: 'shading', opacity: 70, px: shade.px }, { name: 'line art', px: line.px }];
  await save('layers/knight.png', { w: W, h: W, px: PF.core.flattenLayers(layers, W * W) });
  const pk = PF.core.packLayers(layers, W, W);
  fs.writeFileSync(path.join(root, 'layers/knight.layers.png'), await PF.png.encode(pk.w, pk.h, pk.px, 1, pk.text)); console.log('  layers/knight.layers.png', pk.w + '×' + pk.h, '4 layers');
}

fs.writeFileSync(path.join(root, 'spritewright.config.json'), JSON.stringify({
  palette: 'palette.hex', tileGrid: 16, maxColors: 8, background: '#2a2238',
  frames: { 'animation/counter-sheet.png': { w: 16, h: 16, fps: 4 } },
}, null, 2) + '\n');
console.log('  spritewright.config.json');
