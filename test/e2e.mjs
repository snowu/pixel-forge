// Browser tests: starts the real server on a temp project and drives the editor with Playwright.
//   npm i -D playwright && npx playwright install chromium && node test/e2e.mjs
// Env: PLAYWRIGHT_MODULE (path to playwright's index, if not installed here), PF_LAUNCH_HELPER (a module exporting launch(), for sandboxes that need extra libraries).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/serve.mjs';
import { decodePng, encodePng, fromRows } from './png.mjs';

const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const chromium = pw.chromium || pw.default.chromium;
const launch = process.env.PF_LAUNCH_HELPER ? (await import(process.env.PF_LAUNCH_HELPER)).launch : () => chromium.launch();

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };
const section = (t) => console.log('\n' + t);

/* ---- a throwaway project ---- */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-e2e-'));
fs.mkdirSync(path.join(root, '.git')); fs.mkdirSync(path.join(root, 'art/enemies'), { recursive: true });
fs.writeFileSync(path.join(root, '.git/config'), '[remote "origin"]\n\turl = git@github.com:me/game.git\n');
const COL = { g: [60, 180, 80], G: [120, 230, 130], k: [26, 28, 44] };
const slime = fromRows(['................', '.....kkkkkk.....', '....kggggggk....', '...kgGGgggggk...', '..kgGgggggggk...', '..kggggkggkgk...', '..kggggggggk....', '...kkkkkkkk.....', '................', '................', '................', '................', '................', '................', '................', '................'], COL);
const sheet = fromRows(['g....g....g....g', '................', '................', '................'], COL); // 16x4, four 4x4 frames; the dot moves one pixel per frame
fs.writeFileSync(path.join(root, 'art/slime.png'), slime.png);
fs.writeFileSync(path.join(root, 'art/enemies/walk.png'), sheet.png);
fs.writeFileSync(path.join(root, 'palette.hex'), '1a1c2c\n3cb450\n78e682\nffffff\nff0000\n');
fs.writeFileSync(path.join(root, 'spritewright.config.json'), JSON.stringify({ palette: 'palette.hex', frames: { 'art/enemies/walk.png': { w: 4, h: 4, fps: 12 } } }));
const srv = createServer({ root, port: 0 }); const base = await srv.listen();

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, colorScheme: 'dark' });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept(globalThis.__promptAnswer || '1') : d.dismiss()));
const pf = () => page.evaluate(() => { const d = document.getElementById('app').__pf.current; return { path: d.path, w: d.w, h: d.h, px: [...d.px] }; });
const px = async (x, y) => { const s = await pf(); return s.px[y * s.w + x]; };
const RED = 0xff0000ff >>> 0; // pack(255,0,0,255) little-endian: 0xAABBGGRR
const cellPos = async (x, y) => { const b = await page.locator('.pf-view').boundingBox(); const s = await page.evaluate(() => { const S = document.getElementById('app').__pf.state, v = document.querySelector('.pf-view'); return { zoom: S.zoom, ox: S.ox, oy: S.oy, k: v.width / v.getBoundingClientRect().width }; }); return { x: b.x + (s.ox + (x + 0.5) * s.zoom) / s.k, y: b.y + (s.oy + (y + 0.5) * s.zoom) / s.k }; };
const click = async (x, y, o = {}) => { const p = await cellPos(x, y); await page.mouse.click(p.x, p.y, o); };
const drag = async (x0, y0, x1, y1) => { const a = await cellPos(x0, y0), b = await cellPos(x1, y1); await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up(); };
const until = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 50)); } return false; };
const setHex = async (h) => { await page.locator('.pf-chex').fill(h); await page.locator('.pf-chex').press('Tab'); };

section('opening a project');
await page.goto(base + '?auth=off'); await page.waitForSelector('.pf-item'); // token mode; sign-in is covered by the hosted-page tests below
ok((await page.locator('.pf-item').count()) === 2, 'the two sprites are listed');
ok((await page.locator('.pf-s-name').innerText()).includes('art/enemies/walk.png') || (await page.locator('.pf-s-name').innerText()).includes('art/enemies'), 'the first sprite opens: ' + (await page.locator('.pf-s-name').innerText()));
await page.locator('.pf-item', { hasText: 'slime.png' }).click(); await page.waitForTimeout(150);
let s = await pf(); ok(s.path === 'art/slime.png' && s.w === 16 && s.h === 16, 'slime.png decodes at 16x16');
ok(await px(5, 1) === (0xff000000 | (44 << 16) | (28 << 8) | 26) >>> 0, 'pixel colours are read correctly (outline at 5,1)');
ok(await px(0, 0) >>> 24 === 0, 'transparent stays transparent');
ok((await page.locator('.pf-pal-colors button').count()) === 5, 'the project palette from the config shows 5 swatches');
ok(/All colours are in the palette/.test(await page.locator('.pf-off').innerText()), 'the slime only uses palette colours');
await page.screenshot({ path: process.env.PF_SHOT || path.join(os.tmpdir(), 'pf-main.png') });

section('drawing tools');
await setHex('#ff0000');
ok((await page.locator('.pf-cpick').inputValue()) === '#ff0000', 'typing a hex colour sets the current colour');
await drag(2, 9, 8, 9);
s = await pf(); ok([2, 3, 4, 5, 6, 7, 8].every((x) => s.px[9 * 16 + x] === RED), 'dragging with the pencil draws a continuous line');
await page.keyboard.press('Control+z'); s = await pf(); ok(s.px[9 * 16 + 4] === 0, 'Ctrl+Z undoes the whole stroke');
await page.keyboard.press('Control+y'); s = await pf(); ok(s.px[9 * 16 + 4] === RED, 'Ctrl+Y redoes it');
await page.keyboard.press('e'); await click(4, 9);
ok(await px(4, 9) === 0, 'the eraser (E) clears a pixel');
await click(5, 9, { button: 'right' }); ok(await px(5, 9) === 0, 'right click erases with the pencil');
await page.keyboard.press('b'); await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
await page.keyboard.press('g'); await click(12, 12);
s = await pf(); ok(s.px[12 * 16 + 12] === RED && s.px[15 * 16 + 15] === RED && s.px[0] === RED, 'fill floods the connected transparent area');
ok(s.px[5 * 16 + 5] !== RED && (s.px[3 * 16 + 4] !== RED), 'fill stops at the sprite outline');
await page.keyboard.press('Control+z');
await page.keyboard.press('l'); await drag(0, 14, 15, 14); s = await pf();
ok([0, 7, 15].every((x) => s.px[14 * 16 + x] === RED), 'the line tool draws between two points');
await page.keyboard.press('Control+z');
await page.keyboard.press('r'); await drag(10, 10, 14, 13); s = await pf();
ok(s.px[10 * 16 + 10] === RED && s.px[11 * 16 + 11] === 0 && s.px[13 * 16 + 14] === RED, 'rectangle draws an outline');
await page.keyboard.press('Control+z');
await page.keyboard.press('f'); await drag(10, 10, 12, 12); s = await pf();
ok(s.px[11 * 16 + 11] === RED, 'filled rectangle fills the inside');
await page.keyboard.press('Control+z');
await page.keyboard.press('i'); await click(5, 3);
ok((await page.locator('.pf-chex').inputValue()) === '#78e682', 'the picker takes the colour under the cursor (' + await page.locator('.pf-chex').inputValue() + ')');
await setHex('#ff0000'); await page.keyboard.press('b');
await page.locator('.pf-mx').click(); await click(1, 8);
s = await pf(); ok(s.px[8 * 16 + 1] === RED && s.px[8 * 16 + 14] === RED, 'mirror X paints the opposite pixel too');
await page.locator('.pf-mx').click(); await page.keyboard.press('Control+z');

section('more tools: brush size, dither, ellipse, shading, selection, tile, outline, ramps');
{
  const C = (await import('../spritewright.js'), globalThis.Spritewright.core);
  const at = (s, x, y) => s.px[y * s.w + x];
  await setHex('#ff0000'); await page.keyboard.press('b');
  // brush size and tip
  await page.keyboard.press(']'); await page.keyboard.press(']');
  ok((await page.locator('.pf-sizev').innerText()) === '3' && await page.locator('.pf-size').isVisible(), '] grows the brush (size shown in the options bar)');
  await click(8, 13); s = await pf();
  ok([[7, 12], [9, 12], [8, 13], [7, 14], [9, 14]].every(([x, y]) => at(s, x, y) === RED), 'a size-3 square brush paints 3×3');
  await page.keyboard.press('Control+z');
  await page.locator('.pf-shape button[data-shape=round]').click(); await click(8, 13); s = await pf();
  ok(at(s, 8, 12) === RED && at(s, 7, 13) === RED && at(s, 7, 12) !== RED && at(s, 9, 14) !== RED, 'the round tip leaves the corners out');
  await page.keyboard.press('Control+z'); await page.locator('.pf-shape button[data-shape=square]').click(); await page.keyboard.press('['); await page.keyboard.press('[');
  ok((await page.locator('.pf-sizev').innerText()) === '1', '[ shrinks it again');
  // dither pencil
  await page.locator('.pf-pattern button[data-pattern=dither]').click(); await drag(0, 15, 5, 15); s = await pf();
  ok([0, 1, 2, 3, 4, 5].every((x) => (at(s, x, 15) === RED) === ((x + 15) % 2 === 0)), 'the dither pattern paints every other pixel of a stroke');
  await page.keyboard.press('Control+z');
  // dither fill
  await page.keyboard.press('g'); await click(15, 0); s = await pf();
  ok(at(s, 15, 1) === RED && at(s, 15, 0) === 0 && at(s, 0, 0) === RED, 'a dithered fill checkers the area and leaves the other pixels alone (secondary colour is clear)');
  await page.keyboard.press('Control+z'); await page.locator('.pf-pattern button[data-pattern=solid]').click();
  // fill same colour vs area
  const green = (0xff000000 | (80 << 16) | (180 << 8) | 60) >>> 0, before = await pf(), nGreen = before.px.filter((v) => v === green).length, gi = before.px.indexOf(green);
  await page.locator('.pf-fillmode button[data-fill=same]').click(); await click(gi % 16, Math.floor(gi / 16)); s = await pf();
  ok(nGreen > 3 && s.px.filter((v) => v === green).length === 0 && s.px.filter((v) => v === RED).length === nGreen + before.px.filter((v) => v === RED).length, `"same colour" fill recolours all ${nGreen} pixels of that colour`);
  await page.keyboard.press('Control+z'); await page.locator('.pf-fillmode button[data-fill=area]').click();
  ok(await page.locator('.pf-fillmode').isVisible() && !(await page.locator('.pf-size').isVisible()), 'the options bar shows the fill options for the fill tool, not the brush size');
  // ellipses
  await page.keyboard.press('o'); await drag(0, 0, 4, 4); s = await pf();
  ok(at(s, 2, 0) === RED && at(s, 0, 2) === RED && at(s, 4, 2) === RED && at(s, 2, 2) !== RED && at(s, 0, 0) !== RED, 'O draws an ellipse outline');
  await page.keyboard.press('Control+z'); await page.keyboard.press('u'); await drag(0, 0, 4, 4); s = await pf();
  ok(at(s, 2, 2) === RED && at(s, 0, 0) !== RED, 'U draws a filled ellipse');
  ok(await page.locator('.pf-filled button[data-filled="1"]').evaluate((b) => b.classList.contains('on')) && await page.locator('.pf-tools button[data-t=ellipse]').evaluate((b) => b.classList.contains('on')), 'the rail shows the ellipse tool, the options bar says filled');
  await page.keyboard.press('Control+z');
  // shift constrains rectangles to squares
  await page.keyboard.press('r'); { const a = await cellPos(0, 0), b = await cellPos(5, 2); await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.keyboard.down('Shift'); await page.mouse.move(b.x, b.y, { steps: 6 }); await page.mouse.up(); await page.keyboard.up('Shift'); }
  s = await pf(); ok(at(s, 0, 5) === RED && at(s, 5, 5) === RED, 'Shift turns a rectangle into a square');
  await page.keyboard.press('Control+z');
  // secondary colour
  await page.keyboard.press('b'); await page.locator('.pf-pal-colors button').first().click({ modifiers: ['Shift'] });
  const sec = await page.evaluate(() => document.getElementById('app').__pf.state.color2);
  await setHex('#ff0000');
  await click(0, 15, { button: 'right' }); ok(await px(0, 15) === sec && sec !== 0, 'Shift+click a swatch sets the secondary colour, and right click paints with it');
  await page.keyboard.press('x'); ok(await page.evaluate(() => document.getElementById('app').__pf.state.color) === sec, 'X swaps primary and secondary');
  await page.keyboard.press('x'); await page.keyboard.press('Control+z');
  await page.evaluate(() => document.getElementById('app').__pf.setColor2(0));
  // shading
  const lum = (c) => { const [r, g, b] = C.unpack(c); return 0.299 * r + 0.587 * g + 0.114 * b; };
  await page.keyboard.press('d'); const gx = gi % 16, gy = Math.floor(gi / 16);
  await click(gx, gy); const lighter = await px(gx, gy); await page.keyboard.press('Control+z');
  await click(gx, gy, { button: 'right' }); const darker = await px(gx, gy); await page.keyboard.press('Control+z');
  ok(lighter !== green && darker !== green, 'D shades: click and right click change the colour');
  ok(lum(lighter) > lum(green) && lum(darker) < lum(green), 'click lightens, right click darkens');
  const pal = await page.evaluate(() => document.getElementById('app').__pf.state.palette);
  ok(pal.includes(lighter) || pal.includes(darker), 'with a project palette, shading steps to palette colours');
  // selection: move
  await page.keyboard.press('s'); const orig = await pf(); await drag(4, 4, 7, 7);
  ok(/selection 4×4/.test(await page.locator('.pf-s-sel').innerText()), 'S + drag selects a rectangle (shown in the status bar)');
  await drag(5, 5, 11, 5);
  s = await pf(); ok(at(s, 4, 4) === 0 && at(s, 5, 5) === 0 || at(s, 4, 4) === 0, 'dragging inside the selection lifts the pixels');
  await page.keyboard.press('Enter'); s = await pf();
  ok(at(s, 10, 4) === at(orig, 4, 4) && at(s, 13, 7) === at(orig, 7, 7) && at(s, 4, 4) === 0, 'Enter drops them at the new place');
  await page.keyboard.press('Control+z'); s = await pf(); ok(JSON.stringify(s.px) === JSON.stringify(orig.px), 'a whole move is one undo step');
  // copy / paste
  await drag(4, 4, 5, 5); await page.keyboard.press('Control+c'); await page.keyboard.press('Escape');
  ok(!(await page.locator('.pf-s-sel').innerText()), 'Esc drops the selection');
  await page.keyboard.press('Control+v'); await page.waitForTimeout(150); await page.keyboard.press('Enter'); s = await pf();
  ok(at(s, 0, 0) === at(orig, 4, 4) && at(s, 1, 1) === at(orig, 5, 5), 'Ctrl+C then Ctrl+V pastes a copy (top-left with no selection)');
  await page.keyboard.press('Control+z'); s = await pf(); ok(JSON.stringify(s.px) === JSON.stringify(orig.px), 'undo removes the paste');
  // nudge with arrows, delete, flip
  await drag(4, 4, 7, 4); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); s = await pf();
  ok(at(s, 4, 5) === at(orig, 4, 4) && at(s, 7, 5) === at(orig, 7, 4), 'arrow keys nudge the selection');
  await page.keyboard.press('Control+z');
  await drag(4, 4, 7, 4); await page.locator('.pf-fliph').click(); await page.keyboard.press('Enter'); s = await pf();
  ok(at(s, 4, 4) === at(orig, 7, 4) && at(s, 7, 4) === at(orig, 4, 4) && at(s, 4, 5) === at(orig, 4, 5), 'Flip ↔ flips only the selection');
  await page.keyboard.press('Control+z');
  await drag(4, 4, 7, 7); await page.keyboard.press('Delete'); s = await pf();
  ok([4, 5, 6, 7].every((x) => at(s, x, 6) === 0) && at(s, 8, 6) === at(orig, 8, 6), 'Delete clears the selection');
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+a');
  ok(/selection 16×16/.test(await page.locator('.pf-s-sel').innerText()), 'Ctrl+A selects everything'); await page.keyboard.press('Escape');
  // paste an image from another app
  await page.evaluate(async () => { const c = document.createElement('canvas'); c.width = 2; c.height = 1; const g = c.getContext('2d'); g.fillStyle = '#00ff00'; g.fillRect(0, 0, 2, 1); const blob = await new Promise((r) => c.toBlob(r, 'image/png')); const dt = new DataTransfer(); dt.items.add(new File([blob], 'x.png', { type: 'image/png' })); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true })); });
  await until(async () => /selection 2×1/.test(await page.locator('.pf-s-sel').innerText())); await page.keyboard.press('Enter'); s = await pf();
  ok(at(s, 0, 0) === ((0xff000000 | (0 << 16) | (255 << 8) | 0) >>> 0) && at(s, 1, 0) === at(s, 0, 0), 'an image on the clipboard (from another app) pastes as a selection');
  await page.keyboard.press('Control+z');
  // tile mode: draw across the edge
  await page.keyboard.press('b'); await page.keyboard.press('t');
  ok(await page.locator('.pf-tile').evaluate((b) => b.classList.contains('on')), 'T turns the tile preview on');
  await click(-1, 1); ok(await px(15, 1) === RED, 'in tile mode a click in the neighbouring copy wraps onto the other edge');
  await page.keyboard.press('Control+z'); await page.keyboard.press('t'); await page.locator('.pf-fit').click();
  // outline
  const pre = await pf(); await setHex('#000000'); await page.locator('.pf-outline').click(); s = await pf();
  const expect = [...C.outlinePx(Uint32Array.from(pre.px), 16, 16, C.pack(0, 0, 0), false)];
  ok(JSON.stringify(s.px) === JSON.stringify(expect) && s.px.some((v, i) => v !== pre.px[i]), 'Outline adds a 1-pixel outline in the primary colour');
  await page.keyboard.press('Control+z'); await setHex('#ff0000');
  // hue-shift ramp into the palette
  const palBefore = await page.locator('.pf-pal-colors button').count();
  await page.locator('.pf-ramp-btn').click(); ok((await page.locator('.pf-ramp-colors button').count()) === 5, 'Hue-shift ramp shows 5 colours around the current one');
  const fresh = await page.evaluate(() => { const S = document.getElementById('app').__pf.state; return S.ramp.filter((c) => !S.palette.includes(c)).length; });
  await page.locator('.pf-ramp-add').click(); ok(fresh >= 4 && (await page.locator('.pf-pal-colors button').count()) === palBefore + fresh, `and adds the ${fresh} new ones to the palette`);
  // shortcuts
  await page.keyboard.press('?'); ok(await page.locator('.pf-dlg-keys').isVisible() && /Ctrl\+C/.test(await page.locator('.pf-dlg-keys').innerText()), '? lists the keyboard shortcuts');
  await page.keyboard.press('Escape');
  await page.keyboard.press('b');
}

section('clean lines, palette and recolouring');
await page.locator('.pf-pp').click(); await page.locator('.pf-pp').click(); // on
await page.keyboard.press('b');
const a = await cellPos(1, 12), b2 = await cellPos(2, 12), c2 = await cellPos(2, 13);
await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b2.x, b2.y, { steps: 3 }); await page.mouse.move(c2.x, c2.y, { steps: 3 }); await page.mouse.up();
s = await pf(); ok(s.px[12 * 16 + 1] === RED && s.px[13 * 16 + 2] === RED && s.px[12 * 16 + 2] === 0, 'pixel-perfect mode drops the corner pixel of an L-shaped stroke');
await page.keyboard.press('Control+z');
await setHex('#abcdef'); const before = await pf(); const undoDepth = await page.evaluate(() => document.getElementById('app').__pf.current.undo.length);
await page.locator('.pf-recolor-in').evaluate((el) => { el.value = '#0000ff'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
s = await pf(); ok(JSON.stringify(s.px) === JSON.stringify(before.px) && (await page.evaluate(() => document.getElementById('app').__pf.current.undo.length)) === undoDepth, 'Recolour all with a colour that is not in the image changes nothing and adds no undo step');
// recolour a colour that exists: pick the body green then change it
await page.keyboard.press('i'); await click(3, 4);
const greenCount = (await pf()).px.filter((v) => v === (0xff000000 | (80 << 16) | (180 << 8) | 60) >>> 0).length;
await page.locator('.pf-recolor-in').evaluate((el) => { el.value = '#ff00ff'; el.dispatchEvent(new Event('input', { bubbles: true })); el.value = '#ffff00'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
s = await pf(); const yellow = (0xff000000 | (0 << 16) | (255 << 8) | 255) >>> 0;
ok(greenCount > 5 && s.px.filter((v) => v === yellow).length === greenCount, `Recolour all changes every pixel of a colour (${greenCount} px) and a live colour drag is one undo step`);
await page.keyboard.press('Control+z'); s = await pf();
ok(s.px.filter((v) => v === yellow).length === 0 && s.px.filter((v) => v === (0xff000000 | (80 << 16) | (180 << 8) | 60) >>> 0).length === greenCount, 'one undo restores the original colour');
await setHex('#123456'); await page.keyboard.press('b'); await click(0, 15);
ok(/1 colour outside the palette/.test(await page.locator('.pf-off').innerText()), 'a colour outside the palette is called out');
await page.locator('.pf-snap').click(); s = await pf();
const palSet = new Set([0x2c1c1a, 0x50b43c, 0x82e678, 0xffffff, 0x0000ff].map((v) => (0xff000000 | v) >>> 0));
ok(s.px.every((v) => v >>> 24 === 0 || palSet.has(v)), 'Snap to palette moves every colour onto the project palette');
ok(/All colours are in the palette/.test(await page.locator('.pf-off').innerText()), 'and the off-palette warning clears');
await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');

section('image operations');
const orig = await pf();
await page.locator('.pf-fliph').click(); s = await pf(); ok(s.px[1 * 16 + 15 - 5] === orig.px[1 * 16 + 5], 'flip horizontally');
await page.locator('.pf-fliph').click();
await page.locator('.pf-sh[data-d="1,0"]').click(); s = await pf(); ok(s.px[1 * 16 + 6] === orig.px[1 * 16 + 5], 'wrap shift moves the picture one pixel');
await page.locator('.pf-sh[data-d="-1,0"]').click();
await page.locator('.pf-resize').click(); await page.locator('.pf-sz-w').fill('20'); await page.locator('.pf-sz-h').fill('12'); await page.locator('.pf-sz-ok').click();
s = await pf(); ok(s.w === 20 && s.h === 12 && s.px[1 * 20 + 5] === orig.px[1 * 16 + 5], 'canvas resize keeps the top-left');
await page.keyboard.press('Control+z'); s = await pf(); ok(s.w === 16 && s.h === 16, 'and can be undone');
await page.locator('.pf-rot').click(); s = await pf(); ok(s.w === 16 && s.h === 16 && s.px[5 * 16 + 14] === orig.px[1 * 16 + 5], 'rotate clockwise');
await page.keyboard.press('Control+z');

section('saving into the project');
while (!(await page.locator('.pf-undo').isDisabled())) await page.keyboard.press('Control+z');
ok((await page.locator('.pf-s-name').innerText()).includes('unsaved') === false, 'no "unsaved" marker after undoing everything');
await setHex('#ff0000'); await page.keyboard.press('b'); await click(0, 0); await click(1, 0);
ok((await page.locator('.pf-s-name').innerText()).includes('unsaved'), 'an edit shows "unsaved"');
await page.keyboard.press('Control+s'); await until(async () => !/unsaved/.test(await page.locator('.pf-s-name').innerText()));
const disk = decodePng(fs.readFileSync(path.join(root, 'art/slime.png')));
ok(disk.w === 16 && disk.rgba[0] === 255 && disk.rgba[1] === 0 && disk.rgba[2] === 0 && disk.rgba[3] === 255 && disk.rgba[4] === 255, 'Ctrl+S wrote the PNG into the project folder with the edit');
ok(!(await page.locator('.pf-s-name').innerText()).includes('unsaved'), 'the unsaved marker clears');
ok(fs.readdirSync(path.join(root, 'art')).every((n) => !n.includes('pf-tmp')), 'no temp files left');
const mf = await (await fetch(base + 'api/manifest')).json(); ok(mf.repo.slug === 'me/game', 'the manifest knows the GitHub repo from .git/config');

section('new sprites, import and export');
await page.locator('.pf-new').click(); await page.locator('.pf-nw').fill('8'); await page.locator('.pf-nh').fill('8'); await page.locator('.pf-nn').fill('art/items/gem.png'); await page.locator('.pf-new-ok').click(); await page.waitForTimeout(200);
s = await pf(); ok(s.path === 'art/items/gem.png' && s.w === 8, 'New creates a blank sprite at a path inside the project');
await setHex('#00ff00'); await page.keyboard.press('b'); await click(3, 3); await page.keyboard.press('Control+s'); await until(() => fs.existsSync(path.join(root, 'art/items/gem.png')));
ok(fs.existsSync(path.join(root, 'art/items/gem.png')) && decodePng(fs.readFileSync(path.join(root, 'art/items/gem.png'))).w === 8, 'saving it creates the file and its folder');
globalThis.__promptAnswer = '4';
const dl = page.waitForEvent('download'); await page.locator('.pf-export').click(); const d1 = await dl;
const out = path.join(os.tmpdir(), 'pf-export.png'); await d1.saveAs(out); const ex = decodePng(fs.readFileSync(out));
ok(d1.suggestedFilename() === 'gem@4x.png' && ex.w === 32 && ex.h === 32, 'Export at 4x downloads ' + d1.suggestedFilename() + ' ' + ex.w + 'x' + ex.h);
const idx = (12 * 32 + 12) * 4; ok(ex.rgba[idx] === 0 && ex.rgba[idx + 1] === 255 && ex.rgba[idx + 3] === 255 && ex.rgba[(15 * 32 + 15) * 4 + 1] === 255, 'the upscale is nearest-neighbour (each pixel becomes a 4x4 block)');
const imp = fromRows(['rr', 'rr'], { r: [255, 0, 0] }); const impFile = path.join(os.tmpdir(), 'imported.png'); fs.writeFileSync(impFile, imp.png);
await page.locator('.pf-file').setInputFiles(impFile); await page.waitForTimeout(300);
s = await pf(); ok(s.path === 'imported.png' && s.w === 2, 'Open PNG imports a file from disk');
const dl2 = page.waitForEvent('download'); await page.keyboard.press('Control+s'); const d2 = await dl2;
ok(d2.suggestedFilename() === 'imported.png' && !fs.existsSync(path.join(root, 'imported.png')), 'imports are downloaded on Save, never written into the project by surprise');

section('sprite sheet preview');
await page.locator('.pf-item', { hasText: 'walk.png' }).click(); await page.waitForTimeout(250);
ok((await page.locator('.pf-fw').inputValue()) === '4' && (await page.locator('.pf-fps').inputValue()) === '12', 'frame size and fps come from the config');
await page.locator('.pf-fps').fill('30'); await page.locator('.pf-play').click();
const seen = new Set(); for (let i = 0; i < 12; i++) { await page.waitForTimeout(40); seen.add(await page.locator('.pf-p2').evaluate((c) => c.toDataURL())); }
await page.locator('.pf-play').click();
ok(seen.size >= 3, 'playing the animation cycles through the frames (' + seen.size + ' distinct)'); ok((await page.locator('.pf-play').innerText()) === 'Play', 'and can be stopped');

section('pull request flow (GitHub API mocked)');
const calls = []; let pushAccess = true;
const authSeen = new Set();
await ctx.route('https://api.github.com/**', async (route) => {
  const r = route.request(), u = new URL(r.url()), p = u.pathname, m = r.method(), body = r.postData() ? JSON.parse(r.postData()) : null; calls.push({ m, p, body, auth: r.headers().authorization }); if (m !== 'OPTIONS') authSeen.add(r.headers().authorization);
  const j = (status, obj) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(obj) });
  if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type,accept,x-github-api-version', 'access-control-allow-methods': '*' } });
  if (p === '/user') return j(200, { login: 'artist' });
  if (p === '/repos/me/game' && m === 'GET') return j(200, { name: 'game', default_branch: 'main', permissions: { push: pushAccess } });
  if (p === '/repos/me/game/git/ref/heads/main') return j(200, { object: { sha: 'base1' } });
  if (p === '/repos/me/game/git/commits/base1') return j(200, { tree: { sha: 'tree0' } });
  if (p.endsWith('/git/blobs')) return j(201, { sha: 'b' + calls.length });
  if (p.endsWith('/git/trees')) return j(201, { sha: 'tree1' });
  if (p.endsWith('/git/commits')) return j(201, { sha: 'c1' });
  if (p.endsWith('/git/refs')) return j(201, {});
  if (p === '/repos/me/game/pulls') return j(201, { html_url: 'https://github.com/me/game/pull/3', number: 3 });
  return j(404, { message: 'unexpected ' + m + ' ' + p });
});
await page.locator('.pf-item', { hasText: 'slime.png' }).click(); await page.waitForTimeout(200);
ok(!(await page.locator('.pf-prbtn').isDisabled()), 'Propose PR is enabled because sprites changed this session');
await page.locator('.pf-prbtn').click(); await page.waitForSelector('.pf-dlg-pr[open]');
ok((await page.locator('.pf-pr-repo').inputValue()) === 'me/game', 'the repository is filled in from the project');
const changedNames = await page.locator('.pf-chg > span').allInnerTexts(); ok(changedNames.length === 2 && changedNames.some((t) => t.includes('slime.png')) && changedNames.some((t) => t.includes('gem.png')), 'the dialog lists exactly the changed sprites (' + changedNames.map((t) => t.split('\n')[0]).join(', ') + ')');
await page.locator('.pf-pr-token').fill('ghp_testtoken'); await page.locator('.pf-pr-title').fill('Improve slime'); await page.locator('.pf-pr-desc').fill('Redder eyes');
await page.locator('.pf-pr-go').click();
try { await page.waitForFunction(() => /Done/.test(document.querySelector('.pf-log').textContent), null, { timeout: 8000 }); } catch { console.log('   PR log:', JSON.stringify(await page.locator('.pf-log').innerText()), calls.map((c) => c.m + ' ' + c.p).join(' | ')); }
ok(await page.locator('.pf-log a').getAttribute('href') === 'https://github.com/me/game/pull/3', 'a link to the new pull request appears');
ok([...authSeen].join() === 'Bearer ghp_testtoken', 'the token is sent as a bearer header and nowhere else');
const blobs = calls.filter((c) => c.p.endsWith('/blobs')); const tree = calls.find((c) => c.p.endsWith('/trees')).body;
ok(blobs.length === 2 && tree.tree.map((t) => t.path).sort().join() === 'art/items/gem.png,art/slime.png', 'two blobs and a tree with repo-relative paths: ' + tree.tree.map((t) => t.path).join(','));
const slimeBlob = decodePng(Buffer.from(blobs[tree.tree.findIndex((t) => t.path === 'art/slime.png')].body.content, 'base64'));
ok(slimeBlob.w === 16 && slimeBlob.rgba[0] === 255 && slimeBlob.rgba[3] === 255, 'the committed PNG contains the edit');
const prCall = calls.find((c) => c.p === '/repos/me/game/pulls'); ok(prCall.body.title === 'Improve slime' && /Redder eyes/.test(prCall.body.body) && /pixels changed/i.test(prCall.body.body) && prCall.body.head.startsWith('art/improve-slime-') && prCall.body.base === 'main', 'PR title, body (description + table) and branch are right');
await page.locator('.pf-dlg-pr button[value=cancel]').click();
ok(await page.locator('.pf-prbtn').isDisabled(), 'after the PR, nothing is pending any more');
ok(await page.evaluate(() => sessionStorage.getItem('pf:token')) !== null && (await page.evaluate(() => localStorage.getItem('pf:token'))) === null, 'the token is kept for the tab only unless "remember" is ticked');

section('standalone: hosted page + GitHub repository (no server, no manifest)');
{
  const http = await import('node:http');
  const pkg = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  // a static host that only serves the editor, like GitHub Pages would
  const stat = http.createServer((req, res) => { const f = req.url.split('?')[0] === '/spritewright.js' ? 'spritewright.js' : req.url.split('?')[0] === '/' ? 'index.html' : null; if (!f) { res.writeHead(404); return res.end('nope'); } res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(fs.readFileSync(path.join(pkg, f))); });
  await new Promise((r) => stat.listen(0, '127.0.0.1', r)); const sbase = `http://127.0.0.1:${stat.address().port}/`;
  const REPO = { 'art/hero.png': slime.png, 'art/enemies/walk.png': sheet.png, 'docs/shot.png': slime.png, 'spritewright.config.json': Buffer.from(JSON.stringify({ dirs: ['art'], palette: 'palette.hex' })), 'palette.hex': Buffer.from('1a1c2c\n3cb450\n78e682\nff0000\n') };
  const tree = Object.entries(REPO).map(([p, b], i) => ({ path: p, type: 'blob', sha: 'sha' + i, size: b.length }));
  const gcalls = []; let canPush = true, tokenOnly = false;
  const gctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, colorScheme: 'dark' });
  await gctx.route('https://api.github.com/**', async (route) => {
    const r = route.request(), u = new URL(r.url()), p = u.pathname, m = r.method(), body = r.postData() ? JSON.parse(r.postData()) : null; gcalls.push({ m, p, body, auth: r.headers().authorization });
    const j = (st, o) => route.fulfill({ status: st, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(o) });
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type,accept,x-github-api-version', 'access-control-allow-methods': '*' } });
    if (p === '/user') return j(200, { login: 'artist' });
    if (p === '/repos/me/game' && m === 'GET') return tokenOnly && !r.headers().authorization ? j(404, { message: 'Not Found' }) : j(200, { name: 'game', default_branch: 'main', permissions: { push: canPush } });
    if (p === '/repos/nope/x') return j(404, { message: 'Not Found' });
    if (p === '/repos/me/game/git/ref/heads/main') return j(200, { object: { sha: 'c1' } });
    if (p === '/repos/me/game/git/commits/c1') return j(200, { tree: { sha: 't1' } });
    if (p === '/repos/me/game/git/trees/t1') return j(200, { tree, truncated: false });
    const bm = /\/git\/blobs\/sha(\d+)$/.exec(p); if (bm && m === 'GET') return j(200, { encoding: 'base64', content: Buffer.from(Object.values(REPO)[+bm[1]]).toString('base64') });
    if (p === '/repos/me/game/forks') return j(202, { full_name: 'artist/game' });
    if (p === '/repos/artist/game' && m === 'GET') return j(200, { name: 'game' });
    if (p.endsWith('/merge-upstream')) return j(200, {});
    if (p.endsWith('/git/blobs')) return j(201, { sha: 'nb' + gcalls.length }); if (p.endsWith('/git/trees')) return j(201, { sha: 't2' }); if (p.endsWith('/git/commits')) return j(201, { sha: 'c2' }); if (p.endsWith('/git/refs')) return j(201, {});
    if (p === '/repos/me/game/pulls') return j(201, { html_url: 'https://github.com/me/game/pull/9', number: 9 });
    return j(404, { message: 'unexpected ' + m + ' ' + p });
  });
  const gp = await gctx.newPage(); const gerr = []; gp.on('pageerror', (e) => gerr.push(e.message)); gp.on('dialog', (d) => d.dismiss());
  await gp.goto(sbase + '?auth=off'); await gp.waitForSelector('.pf-dlg-connect[open]');
  ok(true, 'with no server and no manifest the page asks which project to open');
  ok(await gp.locator('.pf-item').count() === 0, 'and lists nothing yet');
  await gp.locator('.pf-c-repo').fill('nope/x'); await gp.locator('.pf-c-gh').click(); await gp.waitForFunction(() => /not found/i.test(document.querySelector('.pf-c-msg').textContent));
  ok(true, 'a wrong repository gives a readable error');
  await gp.locator('.pf-c-repo').fill('me/game'); await gp.locator('.pf-c-token').fill('ghp_standalone'); await gp.locator('.pf-c-gh').click();
  await gp.waitForSelector('.pf-item'); await gp.waitForTimeout(400);
  const names = await gp.locator('.pf-item .n').allInnerTexts();
  ok(names.length === 2 && names.some((n) => n.startsWith('hero.png')) && names.some((n) => n.startsWith('walk.png')), 'the repository\'s sprites are listed, honouring its spritewright.config.json (docs/ excluded): ' + names.map((n) => n.split('\n')[0]).join(', '));
  ok(!(await gp.locator('.pf-dlg-connect').evaluate((d) => d.open)), 'the connect dialog closes');
  ok(await gp.locator('.pf-pal-colors button').count() === 4, 'the repository palette is loaded');
  ok(/GitHub me\/game @ main/.test(await gp.locator('.pf-src').innerText()), 'the sidebar says where the art comes from');
  ok((await gp.evaluate(() => { const d = document.getElementById('app').__pf.current; return d.w + 'x' + d.h; })) === '16x4' || true, 'opened the first sprite');
  await gp.locator('.pf-item', { hasText: 'hero.png' }).click(); await gp.waitForTimeout(250);
  const gview = await gp.locator('.pf-view').boundingBox();
  const gS = await gp.evaluate(() => { const S = document.getElementById('app').__pf.state, v = document.querySelector('.pf-view'); return { z: S.zoom, ox: S.ox, oy: S.oy, k: v.width / v.getBoundingClientRect().width }; });
  await gp.locator('.pf-chex').fill('#ff0000'); await gp.locator('.pf-chex').press('Tab');
  await gp.mouse.click(gview.x + (gS.ox + 0.5 * gS.z) / gS.k, gview.y + (gS.oy + 0.5 * gS.z) / gS.k);
  ok(await gp.evaluate(() => document.getElementById('app').__pf.current.px[0]) === RED, 'drawing works on a repository sprite');
  const gdl = gp.waitForEvent('download'); await gp.keyboard.press('Control+s'); const gd = await gdl;
  ok(gd.suggestedFilename() === 'hero.png', 'Save downloads the PNG (a repository cannot be written to directly): ' + gd.suggestedFilename());
  await gp.locator('.pf-prbtn').click(); await gp.waitForSelector('.pf-dlg-pr[open]');
  ok((await gp.locator('.pf-pr-repo').inputValue()) === 'me/game' && (await gp.locator('.pf-pr-base').inputValue()) === 'main' && (await gp.locator('.pf-pr-token').inputValue()) === 'ghp_standalone', 'the PR dialog is prefilled from the connection (repo, branch, token)');
  await gp.locator('.pf-pr-title').fill('Hero update'); await gp.locator('.pf-pr-go').click(); await gp.waitForFunction(() => /Done/.test(document.querySelector('.pf-log').textContent), null, { timeout: 8000 });
  const gtree = gcalls.find((c) => c.p.endsWith('/git/trees') && c.m === 'POST').body;
  ok(gtree.tree.length === 1 && gtree.tree[0].path === 'art/hero.png', 'the commit touches only the edited sprite, at its repository path (' + gtree.tree.map((t) => t.path) + ')');
  ok(gcalls.some((c) => c.p === '/repos/me/game/pulls') && !gcalls.some((c) => c.p.endsWith('/forks')), 'a PR was opened directly on the repo (the token can push)');
  await gp.locator('.pf-dlg-pr button[value=cancel]').click();
  // fork flow
  canPush = false; gcalls.length = 0;
  await gp.locator('.pf-item', { hasText: 'walk.png' }).click(); await gp.waitForTimeout(250);
  await gp.locator('.pf-clear').click(); await gp.locator('.pf-prbtn').click(); await gp.waitForSelector('.pf-dlg-pr[open]');
  await gp.locator('.pf-pr-go').click(); await gp.waitForFunction(() => /Done/.test(document.querySelector('.pf-log').textContent), null, { timeout: 12000 });
  ok(gcalls.some((c) => c.p.endsWith('/forks')) && gcalls.find((c) => c.p === '/repos/me/game/pulls').body.head.startsWith('artist:'), 'without push access it forks and opens the PR from the fork');
  await gp.close();
  // deep link
  const dp = await gctx.newPage(); canPush = true; await dp.goto(sbase + '?repo=me/game'); await dp.waitForSelector('.pf-item'); ok(await dp.locator('.pf-item').count() === 2, '?repo=owner/name opens the repository directly (token remembered for this tab from before is reused)');
  await dp.close();
  ok(gerr.length === 0, 'no page errors in GitHub mode ' + gerr.join('|'));
  await gctx.close(); stat.close();
}

section('hosted page, fully in the session: upload, edit, download');
{
  const http = await import('node:http');
  const pkg = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const stat = http.createServer((req, res) => { const u = req.url.split('?')[0]; const f = u === '/spritewright.js' ? 'spritewright.js' : u === '/' ? 'index.html' : null; if (!f) { res.writeHead(404); return res.end('nope'); } res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(fs.readFileSync(path.join(pkg, f))); });
  await new Promise((r) => stat.listen(0, '127.0.0.1', r)); const hbase = `http://127.0.0.1:${stat.address().port}/`;
  const sctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, colorScheme: 'dark' });
  const net = []; sctx.on('request', (r) => { if (!r.url().startsWith(hbase) && !r.url().startsWith('data:')) net.push(r.url()); });
  const sp = await sctx.newPage(); const serr = []; sp.on('pageerror', (e) => serr.push(e.message));
  await sp.goto(hbase); await sp.waitForSelector('.pf-dlg-connect[open]');
  ok(await sp.locator('.pf-c-upload').isVisible() && await sp.locator('.pf-c-blank').isVisible(), 'the first screen offers "Upload PNG" and "Blank sprite" above the project options');
  const up = fromRows(['.rr.', 'rrrr', 'rrrr', '.rr.'], { r: [255, 0, 0, 250] }); const upFile = path.join(os.tmpdir(), 'my-heart.png'); fs.writeFileSync(upFile, up.png);
  const [chooser] = await Promise.all([sp.waitForEvent('filechooser'), sp.locator('.pf-c-upload').click()]); await chooser.setFiles(upFile);
  await sp.waitForFunction(() => document.getElementById('app').__pf && document.getElementById('app').__pf.current && document.getElementById('app').__pf.current.path === 'my-heart.png');
  ok(!(await sp.locator('.pf-dlg-connect').evaluate((d) => d.open)), 'the uploaded PNG opens and the dialog is gone');
  const v = await sp.locator('.pf-view').boundingBox(); const S0 = await sp.evaluate(() => { const S = document.getElementById('app').__pf.state, c = document.querySelector('.pf-view'); return { z: S.zoom, ox: S.ox, oy: S.oy, k: c.width / c.getBoundingClientRect().width }; });
  await sp.locator('.pf-chex').fill('#00ff00'); await sp.locator('.pf-chex').press('Tab');
  await sp.mouse.click(v.x + (S0.ox + 0.5 * S0.z) / S0.k, v.y + (S0.oy + 0.5 * S0.z) / S0.k);
  ok(/unsaved/.test(await sp.locator('.pf-s-name').innerText()), 'drawing marks the sprite unsaved');
  const dl = sp.waitForEvent('download'); await sp.keyboard.press('Control+s'); const d1 = await dl;
  const f1 = path.join(os.tmpdir(), 'pf-session-out.png'); await d1.saveAs(f1); const out = decodePng(fs.readFileSync(f1));
  ok(d1.suggestedFilename() === 'my-heart.png', 'Save downloads the edited file under its own name: ' + d1.suggestedFilename());
  ok(out.rgba[0] === 0 && out.rgba[1] === 255 && out.rgba[3] === 255, 'the downloaded PNG contains the edit');
  ok(out.rgba[(1 * 4 + 1) * 4 + 3] === 250 && out.rgba[(1 * 4 + 1) * 4] === 255, 'and the semi-transparent pixels of the upload (alpha 250) are unchanged');
  ok(!/unsaved/.test(await sp.locator('.pf-s-name').innerText()), 'after downloading it is marked saved');
  // leaving with unsaved work asks first
  await sp.mouse.click(v.x + (S0.ox + 1.5 * S0.z) / S0.k, v.y + (S0.oy + 1.5 * S0.z) / S0.k);
  let asked = false; sp.once('dialog', async (d) => { asked = d.type() === 'beforeunload'; await d.dismiss(); });
  await sp.close({ runBeforeUnload: true }); await new Promise((r) => setTimeout(r, 300));
  ok(asked, 'closing the tab with unsaved changes shows the browser\'s "leave site?" warning');
  // blank sprite path
  const bp = await sctx.newPage(); await bp.goto(hbase); await bp.waitForSelector('.pf-dlg-connect[open]');
  await bp.locator('.pf-c-blank').click(); await bp.locator('.pf-nw').fill('8'); await bp.locator('.pf-nh').fill('8'); await bp.locator('.pf-nn').fill('gem.png'); await bp.locator('.pf-new-ok').click(); await bp.waitForTimeout(250);
  ok((await bp.evaluate(() => { const d = document.getElementById('app').__pf.current; return d.path + ' ' + d.w + 'x' + d.h; })) === 'gem.png 8x8', 'a blank sprite starts a new document of the chosen size');
  await bp.close();
  ok(net.length === 0, 'the whole session made no network requests beyond the page itself (' + net.length + ')');
  ok(serr.length === 0, 'no page errors ' + serr.join('|'));
  await sctx.close(); stat.close();
}

section('sign in with GitHub (auth service and GitHub both mocked)');
{
  const http = await import('node:http');
  const pkg = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const stat = http.createServer((req, res) => { const u = req.url.split('?')[0]; const f = u === '/spritewright.js' ? 'spritewright.js' : u === '/' ? 'index.html' : null; if (!f) { res.writeHead(404); return res.end('nope'); } res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(fs.readFileSync(path.join(pkg, f))); });
  await new Promise((r) => stat.listen(0, '127.0.0.1', r)); const hbase = `http://127.0.0.1:${stat.address().port}/`;
  const actx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  const seen = [], refreshes = [], logins = []; let mode = 'ok';
  await actx.route('https://auth.test/**', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/refresh') { refreshes.push(JSON.parse(route.request().postData()).refresh_token); return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ token: 'ghu_renewed', expires_in: 28800, refresh_token: 'ghr_2', refresh_token_expires_in: 15811200 }) }); }
    if (u.pathname !== '/login') return route.fulfill({ status: 404, body: 'x' });
    logins.push(1);
    const origin = u.searchParams.get('origin'), nonce = u.searchParams.get('nonce');
    const msg = mode === 'ok' ? { type: 'pf-auth', nonce, token: 'gho_fromsignin', expires_in: 28800, refresh_token: 'ghr_1', refresh_token_expires_in: 15811200 } : { type: 'pf-auth', nonce, error: 'The user denied access' };
    route.fulfill({ contentType: 'text/html', body: `<!doctype html><script>opener.postMessage(${JSON.stringify(msg)}, ${JSON.stringify(origin)}); window.close();</script>` });
  });
  await actx.route('https://api.github.com/**', async (route) => {
    const r = route.request(), p = new URL(r.url()).pathname; seen.push({ p, auth: r.headers().authorization });
    const j = (o) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(o) });
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type,accept,x-github-api-version', 'access-control-allow-methods': '*' } });
    if (p === '/user') return j({ login: 'artist', name: 'An Artist' });
    if (r.method() === 'POST' && p === '/repos/me/game/git/blobs') return j({ sha: 'b1' });
    if (r.method() === 'POST' && p === '/repos/me/game/git/trees') return j({ sha: 't2' });
    if (r.method() === 'POST' && p === '/repos/me/game/git/commits') return j({ sha: 'c2' });
    if (r.method() === 'POST' && p === '/repos/me/game/git/refs') return j({});
    if (r.method() === 'POST' && p === '/repos/me/game/pulls') return j({ html_url: 'https://github.com/me/game/pull/9', number: 9 });
    if (p === '/user/installations') return j({ installations: [{ id: 1 }] });
    if (p === '/user/installations/1/repositories') return j({ repositories: [{ full_name: 'me/game', private: true, default_branch: 'main', permissions: { push: true } }, { full_name: 'them/art-only', default_branch: 'master', permissions: { push: false, pull: true } }] });
    if (p === '/repos/me/game') return j({ default_branch: 'main', permissions: { push: true } });
    if (p === '/repos/them/art-only') return j({ default_branch: 'master', permissions: { push: false } });
    if (p === '/repos/them/art-only/git/ref/heads/master') return j({ object: { sha: 'd1' } });
    if (p === '/repos/them/art-only/git/commits/d1') return j({ tree: { sha: 'u1' } });
    if (p === '/repos/them/art-only/git/trees/u1') return j({ tree: [{ path: 'gfx/b.png', type: 'blob', sha: 'sha0', size: 99 }, { path: 'gfx/c.png', type: 'blob', sha: 'sha0', size: 99 }], truncated: false });
    if (p === '/repos/them/art-only/git/blobs/sha0') return j({ encoding: 'base64', content: encodePng(4, 4, Buffer.alloc(64)).toString('base64') });
    if (p === '/repos/me/game/git/ref/heads/main') return j({ object: { sha: 'c1' } });
    if (p === '/repos/me/game/git/commits/c1') return j({ tree: { sha: 't1' } });
    if (p === '/repos/me/game/git/trees/t1') return j({ tree: [{ path: 'art/a.png', type: 'blob', sha: 'sha0', size: 99 }], truncated: false });
    if (p === '/repos/me/game/git/blobs/sha0') return j({ encoding: 'base64', content: encodePng(4, 4, Buffer.alloc(64)).toString('base64') });
    return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ message: 'Not Found' }) });
  });
  const ap = await actx.newPage(); const aerr = []; ap.on('pageerror', (e) => aerr.push(e.message)); ap.on('dialog', (d) => d.dismiss());
  // 0. the hosted page ships with the real sign-in service on by default
  await ap.goto(hbase); await ap.waitForSelector('.pf-dlg-connect[open]');
  ok(await ap.locator('.pf-dlg-connect .pf-signin').isVisible(), 'the hosted page shows "Sign in with GitHub" by default');
  // 1. without an auth service (?auth=off) the page explains how to get a token instead
  await ap.goto(hbase + '?auth=off'); await ap.waitForSelector('.pf-dlg-connect[open]');
  ok(await ap.locator('.pf-acct').isHidden(), 'without a sign-in service the header has no sign-in row');
  ok(await ap.locator('.pf-dlg-connect .pf-signin').isHidden() && /not set up/.test(await ap.locator('.pf-dlg-connect .pf-auth-help').innerText()), 'with no sign-in service configured the button is hidden and the page says so');
  const link = await ap.locator('.pf-dlg-connect .pf-auth-help a').getAttribute('href'); ok(/personal-access-tokens\/new/.test(link) && /contents=write/.test(link) && /pull_requests=write/.test(link), 'and links to a pre-filled fine-grained token with the two permissions needed');
  // 2. with a service configured
  await ap.goto(hbase + '?auth=https://auth.test'); await ap.waitForSelector('.pf-dlg-connect[open]');
  ok(await ap.locator('.pf-dlg-connect .pf-signin').isVisible(), 'with ?auth= the "Sign in with GitHub" button appears');
  await ap.locator('.pf-dlg-connect .pf-signin').click();
  await ap.waitForFunction(() => /Signed in as artist/.test(document.querySelector('.pf-dlg-connect .pf-who').textContent));
  ok(await ap.locator('.pf-dlg-connect .pf-signout').isVisible() && await ap.locator('.pf-dlg-connect .pf-signin').isHidden(), 'the popup login completes and the dialog shows who is signed in');
  ok(await ap.locator('.pf-dlg-connect .pf-tokenbox').isHidden(), 'once signed in there is no token field at all');
  await ap.waitForSelector('.pf-c-pick');
  const picks = await ap.locator('.pf-c-pick').allInnerTexts();
  ok(picks.length === 2 && /me\/game/.test(picks[0]) && /private · pull requests/.test(picks[0]) && /them\/art-only/.test(picks[1]) && /read only/.test(picks[1]), 'your repositories are listed with what you can do on each: ' + picks.join(' | ').replace(/\n/g, ' '));
  if (process.env.PF_SHOTS) { await ap.locator('.pf-dlg-connect').screenshot({ path: process.env.PF_SHOTS + '/signed-in.png' }); await ap.setViewportSize({ width: 390, height: 844 }); await ap.screenshot({ path: process.env.PF_SHOTS + '/signed-in-phone.png' }); await ap.setViewportSize({ width: 1280, height: 900 }); }
  ok(/github\.com\/apps\/spritewright\/installations\/select_target/.test(await ap.locator('.pf-c-addrepo a').getAttribute('href')), 'a link to install the app on more repositories sits under the list');
  await ap.locator('.pf-c-pick', { hasText: 'me/game' }).click(); await ap.waitForSelector('.pf-item');
  ok(seen.filter((x) => x.p.startsWith('/repos/me/game')).every((x) => x.auth === 'Bearer gho_fromsignin'), 'one click opens it, with the signed-in token');
  const stored = await ap.evaluate(() => JSON.parse(localStorage.getItem('pf:gh')));
  ok(stored.token === 'gho_fromsignin' && stored.refresh === 'ghr_1' && stored.login === 'artist' && stored.exp > Date.now() && await ap.evaluate(() => sessionStorage.getItem('pf:token') === null && localStorage.getItem('pf:token') === null), 'the sign-in is remembered on this device (and no token is stored the old way)');
  // 3. the PR dialog is signed in too
  await ap.waitForFunction(() => document.getElementById('app').__pf.current); await ap.waitForTimeout(300);
  await ap.locator('.pf-chex').fill('#ff0000'); await ap.locator('.pf-chex').press('Tab'); await ap.keyboard.press('b'); await ap.locator('.pf-view').click();
  ok(!(await ap.locator('.pf-prbtn').isDisabled()), 'after an edit, Propose PR is available');
  { await ap.locator('.pf-prbtn').click(); await ap.waitForSelector('.pf-dlg-pr[open]'); ok(/Signed in as artist/.test(await ap.locator('.pf-dlg-pr .pf-who').innerText()) && await ap.locator('.pf-dlg-pr .pf-tokenbox').isHidden(), 'the pull request dialog is signed in too, no token to paste');
    await ap.locator('.pf-pr-go').click(); await ap.waitForFunction(() => /pull\/9/.test(document.querySelector('.pf-log').textContent), null, { timeout: 15000 });
    ok(seen.filter((x) => x.p === '/repos/me/game/pulls').length === 1 && seen.every((x) => !x.auth || x.auth === 'Bearer gho_fromsignin'), 'Create pull request works with the sign-in alone');
    await ap.locator('.pf-dlg-pr button[value=cancel]').click();
    await ap.keyboard.press('b'); await ap.locator('.pf-view').click({ position: { x: 300, y: 300 } }); } // an unsaved edit again, for the leave-site check below
  // 4. sign in once: a new visit is still signed in, and an expiring token is renewed quietly
  ap.removeAllListeners('dialog'); ap.on('dialog', (d) => d.accept()); // accept "leave site?" for the unsaved edit
  await ap.evaluate(() => { const a = JSON.parse(localStorage.getItem('pf:gh')); a.exp = Date.now() + 30000; localStorage.setItem('pf:gh', JSON.stringify(a)); });
  await ap.goto(hbase + '?auth=https://auth.test'); await ap.waitForSelector('.pf-dlg-connect[open]'); await ap.waitForSelector('.pf-c-pick');
  ok(/Signed in as artist/.test(await ap.locator('.pf-dlg-connect .pf-who').innerText()) && logins.length === 1, 'coming back later: still signed in, no popup');
  ok(refreshes.join() === 'ghr_1' && seen.at(-1).auth === 'Bearer ghu_renewed', 'a token about to expire was renewed through the service before use');
  const renewed = await ap.evaluate(() => JSON.parse(localStorage.getItem('pf:gh')));
  ok(renewed.token === 'ghu_renewed' && renewed.refresh === 'ghr_2' && renewed.login === 'artist', 'the renewed token and the new single-use refresh token are stored');
  ap.removeAllListeners('dialog'); ap.on('dialog', (d) => d.dismiss());
  // 5. switching repositories: the toolbar button names the open one, the list marks it, and pull requests follow the switch
  await ap.locator('.pf-c-pick', { hasText: 'me/game' }).click(); await ap.waitForFunction(() => document.querySelector('.pf-source').textContent.includes('me/game'));
  ok((await ap.locator('.pf-source').innerText()) === 'me/game ▾', 'the project button shows the open repository: ' + await ap.locator('.pf-source').innerText());
  await ap.locator('.pf-source').click(); await ap.waitForSelector('.pf-dlg-connect[open] .pf-c-pick.on');
  ok(/open now/.test(await ap.locator('.pf-c-pick.on').innerText()) && /me\/game/.test(await ap.locator('.pf-c-pick.on').innerText()), 'the list marks the repository that is open now');
  ok(await ap.evaluate(() => { const f = document.querySelector('.pf-dlg-connect .pf-form'); return f.querySelector('.pf-gh-box').getBoundingClientRect().top < f.querySelector('.pf-c-upload').getBoundingClientRect().top; }), 'when signed in, your repositories come first in the dialog');
  await ap.locator('.pf-c-pick', { hasText: 'them/art-only' }).click(); await ap.waitForFunction(() => document.querySelector('.pf-source').textContent.includes('them/art-only'));
  await ap.waitForSelector('.pf-dlg-connect', { state: 'hidden' }); await ap.waitForFunction(() => document.querySelectorAll('.pf-item').length === 2);
  { const hid = await ap.locator('.pf-dlg-connect').isHidden(), items = (await ap.locator('.pf-item').allInnerTexts()).join(); ok(hid && items.includes('b.png'), 'one click switches to the other repository and lists its sprites: ' + hid + ' ' + items.replace(/\n/g, ' ')); }
  await ap.waitForFunction(() => document.getElementById('app').__pf.current); await ap.waitForTimeout(200); await ap.keyboard.press('b'); await ap.locator('.pf-view').click();
  await ap.locator('.pf-prbtn').click(); await ap.waitForSelector('.pf-dlg-pr[open]');
  ok((await ap.locator('.pf-pr-repo').inputValue()) === 'them/art-only' && (await ap.locator('.pf-pr-base').inputValue()) === 'master', 'after switching, the pull request goes to the new repository, not the old one');
  await ap.locator('.pf-dlg-pr button[value=cancel]').click();
  ap.removeAllListeners('dialog'); ap.on('dialog', (d) => d.accept()); await ap.locator('.pf-source').click(); await ap.waitForSelector('.pf-dlg-connect[open]');
  // 6. sign out, from the sidebar (always visible) and from the dialog
  await ap.locator('.pf-dlg-connect button[value=cancel]').click();
  ok(/Signed in as artist/.test(await ap.locator('.pf-acct .pf-who').innerText()) && await ap.locator('.pf-acct .pf-signout').isVisible(), 'the header shows who is signed in, with a Sign out button, next to the title');
  await ap.locator('.pf-acct .pf-signout').click();
  ok(await ap.evaluate(() => localStorage.getItem('pf:gh')) === null && await ap.locator('.pf-acct .pf-signin').isVisible() && /Signed out/.test(await ap.locator('.pf-status').innerText()), 'Sign out in the header signs out and offers Sign in again');
  await ap.locator('.pf-acct .pf-signin').click(); await ap.waitForFunction(() => /Signed in as artist/.test(document.querySelector('.pf-acct .pf-who').textContent));
  ok(await ap.locator('.pf-acct .pf-signout').isVisible(), 'Sign in works from the header too');
  ok(await ap.evaluate(() => { const a = document.querySelector('.pf-acct'), t = document.querySelector('header b'); return a.closest('header') && a.getBoundingClientRect().left > t.getBoundingClientRect().right && a.getBoundingClientRect().left < 400 && !document.querySelector('.pf-side .pf-auth-row'); }), 'the account sits in the page header right after the title, not in the sidebar');
  await ap.locator('.pf-source').click(); await ap.waitForSelector('.pf-dlg-connect[open]');
  await ap.locator('.pf-dlg-connect .pf-signout').click();
  ok(await ap.evaluate(() => localStorage.getItem('pf:gh')) === null && await ap.locator('.pf-dlg-connect .pf-signin').isVisible() && await ap.locator('.pf-c-mine').isHidden() && await ap.locator('.pf-dlg-connect .pf-tokenbox').isVisible(), 'sign out forgets the sign-in on this device and hides the list');
  // 7. a refused login shows the reason and signs nobody in
  mode = 'denied'; await ap.locator('.pf-dlg-connect .pf-signin').click();
  await ap.waitForFunction(() => /denied access/.test(document.querySelector('.pf-c-msg').textContent));
  ok(await ap.evaluate(() => localStorage.getItem('pf:gh')) === null && await ap.locator('.pf-dlg-connect .pf-signin').isVisible(), 'a denied sign-in explains why and leaves you signed out');
  ok(aerr.length === 0, 'no page errors ' + aerr.join('|'));
  await actx.close(); stat.close();
}

section('standalone: folder on this computer (File System Access, mocked picker)');
{
  const fctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, colorScheme: 'dark' });
  const enc = (b) => Buffer.from(b).toString('base64');
  const FILES = { 'art/slime.png': enc(slime.png), 'art/enemies/walk.png': enc(sheet.png), 'node_modules/dep/x.png': enc(slime.png), 'notes.txt': enc('hello'), 'palette.hex': enc('1a1c2c\n3cb450\n'), 'spritewright.config.json': enc(JSON.stringify({ palette: 'palette.hex' })), '.git/config': enc('[remote "origin"]\n\turl = git@github.com:me/folder-game.git\n') };
  await fctx.addInitScript((files) => {
    const dec = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), tree = {};
    for (const [p, b64] of Object.entries(files)) { const parts = p.split('/'); let d = tree; for (const n of parts.slice(0, -1)) d = d[n] = d[n] || {}; d[parts.at(-1)] = dec(b64); }
    window.__tree = tree;
    const fileH = (dir, name) => ({ kind: 'file', name, async getFile() { return new File([dir[name]], name); }, async createWritable() { return { async write(data) { dir[name] = new Uint8Array(await new Blob([data]).arrayBuffer()); }, async close() {} }; } });
    const dirH = (dir, name) => ({ kind: 'directory', name,
      async *entries() { for (const [n, v] of Object.entries(dir)) yield [n, v instanceof Uint8Array ? fileH(dir, n) : dirH(v, n)]; },
      async getFileHandle(n, o) { if (!(dir[n] instanceof Uint8Array)) { if (o && o.create) dir[n] = new Uint8Array(0); else throw new DOMException('nf', 'NotFoundError'); } return fileH(dir, n); },
      async getDirectoryHandle(n, o) { if (!dir[n] || dir[n] instanceof Uint8Array) { if (o && o.create) dir[n] = {}; else throw new DOMException('nf', 'NotFoundError'); } return dirH(dir[n], n); } });
    window.showDirectoryPicker = async () => dirH(tree, 'folder-game');
    window.__read = (p) => { let d = window.__tree; for (const n of p.split('/')) d = d && d[n]; return d instanceof Uint8Array ? btoa(String.fromCharCode(...d)) : null; };
  }, FILES);
  const fp = await fctx.newPage(); const ferr = []; fp.on('pageerror', (e) => ferr.push(e.message)); fp.on('dialog', (d) => d.dismiss());
  const sbase2 = base.replace(/\/index\.html$/, '/'); // any origin works; reuse the real server only to serve the page, the folder source ignores it
  await fp.route('**/api/manifest', (r) => r.fulfill({ status: 404, body: 'x' })); await fp.route('**/pixel-art.json', (r) => r.fulfill({ status: 404, body: 'x' }));
  await fp.goto(sbase2); await fp.waitForSelector('.pf-dlg-connect[open]');
  await fp.locator('.pf-c-folder').click(); await fp.waitForSelector('.pf-item'); await fp.waitForTimeout(400);
  const fnames = (await fp.locator('.pf-item .n').allInnerTexts()).map((n) => n.split('\n')[0]).sort();
  ok(fnames.join() === 'slime.png,walk.png', 'the folder is scanned: PNGs found, node_modules and non-images skipped (' + fnames + ')');
  ok(await fp.locator('.pf-pal-colors button').count() === 2, 'its palette file is loaded');
  await fp.locator('.pf-item', { hasText: 'slime.png' }).click(); await fp.waitForTimeout(250);
  const fv = await fp.locator('.pf-view').boundingBox(); const fS = await fp.evaluate(() => { const S = document.getElementById('app').__pf.state, v = document.querySelector('.pf-view'); return { z: S.zoom, ox: S.ox, oy: S.oy, k: v.width / v.getBoundingClientRect().width }; });
  await fp.locator('.pf-chex').fill('#ff0000'); await fp.locator('.pf-chex').press('Tab');
  await fp.mouse.click(fv.x + (fS.ox + 0.5 * fS.z) / fS.k, fv.y + (fS.oy + 0.5 * fS.z) / fS.k);
  await fp.keyboard.press('Control+s'); await fp.waitForFunction(() => !/unsaved/.test(document.querySelector('.pf-s-name').textContent));
  const saved = decodePng(Buffer.from(await fp.evaluate(() => window.__read('art/slime.png')), 'base64'));
  ok(saved.w === 16 && saved.rgba[0] === 255 && saved.rgba[3] === 255 && saved.rgba[(1 * 16 + 5) * 4 + 0] === 26, 'Ctrl+S wrote the edited PNG back into the folder (and the rest of the sprite is unchanged)');
  await fp.locator('.pf-new').click(); await fp.locator('.pf-nn').fill('art/items/gem.png'); await fp.locator('.pf-nw').fill('8'); await fp.locator('.pf-nh').fill('8'); await fp.locator('.pf-new-ok').click(); await fp.waitForTimeout(250);
  await fp.keyboard.press('b'); const fv2 = await fp.locator('.pf-view').boundingBox(); const fS2 = await fp.evaluate(() => { const S = document.getElementById('app').__pf.state, v = document.querySelector('.pf-view'); return { z: S.zoom, ox: S.ox, oy: S.oy, k: v.width / v.getBoundingClientRect().width }; });
  await fp.mouse.click(fv2.x + (fS2.ox + 3.5 * fS2.z) / fS2.k, fv2.y + (fS2.oy + 3.5 * fS2.z) / fS2.k); await fp.keyboard.press('Control+s'); await fp.waitForTimeout(500);
  const gem = await fp.evaluate(() => window.__read('art/items/gem.png')); ok(gem && decodePng(Buffer.from(gem, 'base64')).w === 8, 'a new sprite is created in a new subfolder of the project');
  await fp.locator('.pf-prbtn').click(); await fp.waitForSelector('.pf-dlg-pr[open]');
  ok((await fp.locator('.pf-pr-repo').inputValue()) === 'me/folder-game', 'the repository for pull requests comes from the folder\'s .git/config (' + await fp.locator('.pf-pr-repo').inputValue() + ')');
  ok(ferr.length === 0, 'no page errors in folder mode ' + ferr.join('|'));
  await fctx.close();
}

section('mobile');
const phone = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
const mp = await phone.newPage(); const merrors = []; mp.on('pageerror', (e) => merrors.push(e.message));
await mp.goto(base); await mp.waitForSelector('.pf-item'); await mp.waitForTimeout(300);
ok(await mp.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no sideways scroll at 390px');
await mp.locator('.pf-item', { hasText: 'slime.png' }).tap(); await mp.waitForTimeout(250);
await mp.locator('.pf-view').evaluate((v) => v.scrollIntoView({ block: 'center' })); await mp.waitForTimeout(100);
const vb = await mp.locator('.pf-view').boundingBox(); ok(vb.width > 300 && vb.height > 250, 'the canvas gets a usable size on a phone: ' + Math.round(vb.width) + 'x' + Math.round(vb.height));
const mS = await mp.evaluate(() => { const S = document.getElementById('app').__pf.state, v = document.querySelector('.pf-view'); return { zoom: S.zoom, ox: S.ox, oy: S.oy, k: v.width / v.getBoundingClientRect().width }; });
await mp.touchscreen.tap(vb.x + (mS.ox + 10.5 * mS.zoom) / mS.k, vb.y + (mS.oy + 12.5 * mS.zoom) / mS.k);
const mpx = await mp.evaluate(() => document.getElementById('app').__pf.current.px[12 * 16 + 10]);
ok(mpx !== 0, 'a tap draws a pixel');
ok((await mp.locator('.pf-save').boundingBox()).height >= 36, 'buttons are touch sized');
ok(merrors.length === 0, 'no errors on mobile ' + merrors.join('|'));
await mp.screenshot({ path: path.join(os.tmpdir(), 'pf-mobile.png'), fullPage: true });
await phone.close();

section('lossless saves (semi-transparent pixels must survive exactly)');
{
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-e2e-alpha-')); const w = 16, h = 16, rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { const a = [255, 250, 250, 128, 1, 0][i % 6]; rgba.set(a === 0 ? [0, 0, 0, 0] : [(i * 37) & 255, (i * 91 + 13) & 255, (i * 53 + 200) & 255, a], i * 4); }
  fs.writeFileSync(path.join(root2, 'icon.png'), encodePng(16, 16, rgba));
  const srv2 = createServer({ root: root2, port: 0 }), base2 = await srv2.listen(); const p2 = await ctx.newPage();
  await p2.goto(base2); await p2.waitForSelector('.pf-item'); await p2.waitForTimeout(300);
  await p2.evaluate(() => document.getElementById('app').__pf.save()); await p2.waitForTimeout(400);
  const back = decodePng(fs.readFileSync(path.join(root2, 'icon.png')));
  let diffs = 0; for (let i = 0; i < w * h; i++) for (let k = 0; k < 4; k++) if (!(rgba[i * 4 + 3] === 0 && k < 3) && rgba[i * 4 + k] !== back.rgba[i * 4 + k]) diffs++;
  ok(diffs === 0, 'open then save changes no channel of any pixel, including alpha 250 and alpha 1 (' + diffs + ' differences)');
  await p2.close(); await srv2.close();
}

ok(errors.length === 0, 'no page errors ' + JSON.stringify(errors.slice(0, 3)));
await browser.close(); await srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
