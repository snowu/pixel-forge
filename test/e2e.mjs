// Browser tests: starts the real server on a temp project and drives the editor with Playwright.
//   npm i -D playwright && npx playwright install chromium && node test/e2e.mjs
// Env: PLAYWRIGHT_MODULE (path to playwright's index, if not installed here), PF_LAUNCH_HELPER (a module exporting launch(), for sandboxes that need extra libraries).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from '../src/serve.mjs';
import { decodePng, encodePng, fromRows } from './png.mjs';

const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const chromium = pw.chromium || pw.default.chromium;
const launch = process.env.PF_LAUNCH_HELPER ? (await import(process.env.PF_LAUNCH_HELPER)).launch : () => chromium.launch();

let pass = 0, fail = 0;
// Watchdog: some awaits (page.evaluate, input on a stuck page) have no timeout of their own, so one hung step could hold CI for
// hours. Two quiet minutes in a row fail the run instead, naming where it stopped.
let lastSection = '', lastCheck = '', watchdog = null;
const kick = () => { clearTimeout(watchdog); watchdog = setTimeout(() => { console.log(`\n  FAIL stuck for 2 minutes in "${lastSection}" after "${lastCheck}"`); process.exit(1); }, 120000); watchdog.unref(); };
const ok = (c, m) => { kick(); lastCheck = m; if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };
const section = (t) => { kick(); lastSection = t; lastCheck = '(start)'; console.log('\n' + t); };

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
page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept(globalThis.__promptAnswer || '1') : globalThis.__confirmYes && d.type() === 'confirm' ? d.accept() : d.dismiss()));
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

section('stylus and tile grid');
{
  const sp2 = await ctx.newPage(); const serr = []; sp2.on('pageerror', (e) => serr.push(e.message));
  await sp2.goto(base + '?auth=off'); await sp2.waitForSelector('.pf-item'); await sp2.locator('.pf-item', { hasText: 'slime.png' }).click(); await sp2.waitForTimeout(250);
  const st = () => sp2.evaluate(() => { const a = document.getElementById('app').__pf, S = a.state, v = document.querySelector('.pf-view'), r = v.getBoundingClientRect(); return { ox: S.ox, oy: S.oy, zoom: S.zoom, k: v.width / r.width, left: r.left, top: r.top, px: [...a.current.px] }; });
  const s0 = await st(), at = (x, y) => ({ x: s0.left + (s0.ox + (x + .5) * s0.zoom) / s0.k, y: s0.top + (s0.oy + (y + .5) * s0.zoom) / s0.k });
  const ptr = (type, kind, id, p) => sp2.evaluate(([type, kind, id, p]) => document.querySelector('.pf-view').dispatchEvent(new PointerEvent(type, { pointerType: kind, pointerId: id, clientX: p.x, clientY: p.y, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, isPrimary: true })), [type, kind, id, p]);
  await sp2.keyboard.press('b');
  await ptr('pointerdown', 'pen', 7, at(2, 2)); await ptr('pointerup', 'pen', 7, at(2, 2));
  const s1 = await st(); ok(s1.px[2 * 16 + 2] !== s0.px[2 * 16 + 2], 'a pencil draws');
  await ptr('pointerdown', 'pen', 7, at(5, 5)); await ptr('pointerdown', 'touch', 8, at(9, 9)); await ptr('pointermove', 'touch', 8, { x: at(9, 9).x + 40, y: at(9, 9).y }); await ptr('pointerup', 'touch', 8, at(9, 9)); await ptr('pointerup', 'pen', 7, at(5, 5));
  const s2 = await st(); ok(s2.px[9 * 16 + 9] === s1.px[9 * 16 + 9] && s2.ox === s1.ox, 'a palm touching while the pen draws is ignored: no pixel, no pan');
  await ptr('pointerdown', 'touch', 9, at(12, 12)); await ptr('pointermove', 'touch', 9, { x: at(12, 12).x + 60, y: at(12, 12).y + 30 }); await ptr('pointerup', 'touch', 9, at(12, 12));
  const s3 = await st(); ok(JSON.stringify(s3.px) === JSON.stringify(s2.px) && s3.ox !== s2.ox, 'after the pen, a finger pans instead of drawing: ' + s2.ox + ' → ' + s3.ox);
  await sp2.locator('.pf-grid-more').click(); await sp2.waitForSelector('.pf-tgmenu');
  ok((await sp2.locator('.pf-tgmenu button').allInnerTexts()).join('|') === 'Tile grid off|8 × 8|16 × 16|32 × 32|64 × 64', 'the ▾ next to Grid offers tile grid sizes');
  await sp2.locator('.pf-tgmenu [data-v="8"]').click();
  ok(await sp2.evaluate(() => document.getElementById('app').__pf.state.tgrid === 8) && await sp2.locator('.pf-grid-more.on').count() === 1 && await sp2.locator('.pf-tgmenu').count() === 0, 'picking 8 × 8 turns it on and closes the menu');
  await sp2.reload(); await sp2.waitForSelector('.pf-item'); await sp2.waitForTimeout(200);
  ok(await sp2.evaluate(() => document.getElementById('app').__pf.state.tgrid === 8), 'and it is remembered for the project');
  await sp2.locator('.pf-grid-more').click(); await sp2.locator('.pf-tgmenu [data-v="0"]').click();
  ok(serr.length === 0, 'no page errors ' + serr.join('|'));
  await sp2.close();
}

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
  // brush size on shapes
  await page.keyboard.press('l'); await page.keyboard.press(']');
  ok(await page.locator('.pf-size').isVisible(), 'the line tool has a size too');
  const pre0 = await pf(); await drag(2, 10, 6, 10); s = await pf();
  ok([2, 4, 6, 7].every((x) => at(s, x, 10) === RED && at(s, x, 11) === RED) && [1, 2, 4, 6, 7].every((x) => at(s, x, 9) === at(pre0, x, 9) && at(s, x, 12) === at(pre0, x, 12)) && at(s, 1, 10) === at(pre0, 1, 10), 'a size-2 line is two pixels thick (the tip leans down-right of the cursor)');
  await page.keyboard.press('Control+z'); await page.keyboard.press('f');
  ok(!(await page.locator('.pf-size').isVisible()), 'filled shapes have no stroke size');
  await page.keyboard.press('b'); await page.keyboard.press('[');
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
await page.keyboard.press('b');
const strokeThrough = async (pts) => { const p0 = await cellPos(...pts[0]); await page.mouse.move(p0.x, p0.y); await page.mouse.down(); for (const q of pts.slice(1)) { const pq = await cellPos(...q); await page.mouse.move(pq.x, pq.y, { steps: 6 }); } await page.mouse.up(); };
ok(!(await page.locator('.pf-pp').evaluate((b) => b.classList.contains('on'))), 'clean lines starts off');
{ await strokeThrough([[1, 12], [5, 12], [5, 13], [1, 13]]); s = await pf();
  const holes = [1, 2, 3, 4, 5].flatMap((x) => [12, 13].filter((y) => s.px[y * 16 + x] !== RED).map((y) => x + ',' + y));
  ok(holes.length === 0, 'with clean lines off, dragging back and forth fills an area with no gaps at the turns' + (holes.length ? ' (holes at ' + holes.join(' ') + ')' : ''));
  await page.keyboard.press('Control+z'); }
await page.locator('.pf-pp').click(); // on
{ await strokeThrough([[1, 12], [5, 12], [2, 12], [2, 13]]); s = await pf();
  ok([1, 2, 3, 4, 5].every((x) => s.px[12 * 16 + x] === RED), 'with clean lines on, going back over your own stroke never erases what it drew');
  await page.keyboard.press('Control+z'); }
const a = await cellPos(1, 12), b2 = await cellPos(2, 12), c2 = await cellPos(2, 13);
await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b2.x, b2.y, { steps: 3 }); await page.mouse.move(c2.x, c2.y, { steps: 3 }); await page.mouse.up();
s = await pf(); ok(s.px[12 * 16 + 1] === RED && s.px[13 * 16 + 2] === RED && s.px[12 * 16 + 2] === 0, 'pixel-perfect mode drops the corner pixel of an L-shaped stroke');
await page.keyboard.press('Control+z');
await page.locator('.pf-pp').click(); ok(await page.evaluate(() => localStorage.getItem('pf:cleanlines')) === '0', 'the clean-lines choice is remembered');
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
await page.locator('.pf-rot').hover(); ok((await page.locator('.pf-imgtip').innerText()).startsWith('Rotate 90°'), 'Image panel: icon buttons, the one under the pointer is named below: ' + await page.locator('.pf-imgtip').innerText());
ok(await page.locator('.pf-imgtools button:visible').evaluateAll((bs) => new Set(bs.map((b) => Math.round(b.getBoundingClientRect().width) + 'x' + Math.round(b.getBoundingClientRect().height))).size === 1), 'every button in the grid is the same size');
await page.locator('.pf-resize').click(); await page.locator('.pf-sz-anchor [data-a="tl"]').click(); await page.locator('.pf-sz-w').fill('20'); await page.locator('.pf-sz-h').fill('12'); await page.locator('.pf-sz-ok').click();
s = await pf(); ok(s.w === 20 && s.h === 12 && s.px.every((v, i) => (i % 20) >= 16 || ((i / 20) | 0) >= 12 ? v === 0 : v === orig.px[((i / 20) | 0) * 16 + (i % 20)]), 'canvas resize anchored top-left keeps every pixel where it was');
await page.keyboard.press('Control+z'); s = await pf(); ok(s.w === 16 && s.h === 16, 'and can be undone');
await page.locator('.pf-s-size').click(); ok(await page.locator('.pf-dlg-size').evaluate((d) => d.open), 'clicking the size in the status bar opens Canvas size');
ok((await page.locator('.pf-sz-info').innerText()).includes('16×16 → 16×16'), 'the dialog previews old → new size');
await page.locator('.pf-sz-anchor [data-a="br"]').click(); await page.locator('.pf-sz-w').fill('18'); await page.locator('.pf-sz-h').fill('18');
ok(await page.locator('.pf-sz-cv').evaluate((c) => c.width === 18 && c.height === 18), 'the preview follows the inputs');
await page.locator('.pf-sz-ok').click(); s = await pf();
ok(s.w === 18 && s.px[(2 + 1) * 18 + 2 + 5] === orig.px[1 * 16 + 5] && s.px[0] === 0, 'anchored bottom-right the new space goes top-left');
await page.keyboard.press('Control+z');
await page.keyboard.press('Control+Alt+c'); await page.locator('.pf-sz-mode [data-mode="scale"]').click(); await page.locator('.pf-sz-quick [data-q="double"]').click();
ok((await page.locator('.pf-sz-w').inputValue()) === '32' && (await page.locator('.pf-sz-h').inputValue()) === '32', 'Ctrl+Alt+C opens it; ×2 doubles both sides');
await page.locator('.pf-sz-ok').click(); s = await pf();
ok(s.w === 32 && s.px[(2 * 1) * 32 + 2 * 5] === orig.px[1 * 16 + 5] && s.px[(2 * 1 + 1) * 32 + 2 * 5 + 1] === orig.px[1 * 16 + 5], 'scale image ×2 turns each pixel into a 2×2 block');
await page.keyboard.press('Control+z');
{ const ob = await page.evaluate(() => { const d = document.getElementById('app').__pf.current; return window.Spritewright.core.opaqueBounds(d.px, d.w, d.h); });
  await page.locator('.pf-trim').click(); s = await pf();
  ok(ob && s.w === ob.w && s.h === ob.h && s.px[0] === orig.px[ob.y * 16 + ob.x], `Trim cuts away the empty border (${ob && ob.w}×${ob && ob.h})`);
  await page.keyboard.press('Control+z'); }
await page.keyboard.press('s');
{ const a = await cellPos(2, 2), b = await cellPos(6, 4); await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 4 }); await page.mouse.up(); }
await page.locator('.pf-sel-crop').click(); s = await pf();
ok(s.w === 5 && s.h === 3 && s.px[0] === orig.px[2 * 16 + 2], 'select an area, then crop the canvas to it: ' + s.w + '×' + s.h);
await page.keyboard.press('Control+z'); await page.keyboard.press('b');
await page.locator('.pf-rot').click(); s = await pf(); ok(s.w === 16 && s.h === 16 && s.px[5 * 16 + 14] === orig.px[1 * 16 + 5], 'rotate clockwise');
await page.keyboard.press('Control+z');

section('saving into the project');
{ await page.mouse.move(5, 5); await page.waitForTimeout(100); const before = await page.locator('.pf-view').boundingBox(), hb = (await page.locator('.pf-status').boundingBox()).height;
  const p = await cellPos(3, 3); await page.mouse.move(p.x, p.y); await page.evaluate(() => { document.getElementById('app').__pf.state.notice = 'a long message '.repeat(20); });
  await page.locator('.pf-zin').click(); await page.locator('.pf-zout').click(); await page.mouse.move(p.x, p.y + 2); await page.waitForTimeout(100);
  const after = await page.locator('.pf-view').boundingBox(), ha = (await page.locator('.pf-status').boundingBox()).height;
  ok(/x 3\s+y 3/.test(await page.locator('.pf-s-pos').innerText()) && ha === hb && after.y === before.y && after.height === before.height, `the status bar stays one line (${hb}px → ${ha}px) when the cursor readout and a long message appear, so the canvas never moves`);
  await page.evaluate(() => { document.getElementById('app').__pf.state.notice = ''; }); }
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
await page.locator('.pf-new').click();
{ const q = await page.locator('.pf-n-quick button').allInnerTexts(), cur = await pf(), on = await page.locator('.pf-n-quick button.on').allInnerTexts();
  ok(q.length === 4 && q.includes('16×16') && q.includes('32×32'), 'New offers four common sizes as one click: ' + q.join(' '));
  ok(on.join() === cur.w + '×' + cur.h && (await page.locator('.pf-nw').inputValue()) === String(cur.w), 'it starts at the open sprite\'s size, marked: ' + on);
  await page.locator('.pf-n-quick button', { hasText: '32×32' }).click();
  ok((await page.locator('.pf-nw').inputValue()) === '32' && (await page.locator('.pf-nh').inputValue()) === '32' && (await page.locator('.pf-n-quick button.on').innerText()) === '32×32', 'clicking a size fills width and height');
  await page.locator('.pf-nw').fill('24'); ok(await page.locator('.pf-n-quick button.on').count() === 0, 'any other size (24×32) can still be typed, and no preset stays marked'); }
await page.locator('.pf-nw').fill('8'); await page.locator('.pf-nh').fill('8'); await page.locator('.pf-nn').fill('art/items/gem.png'); await page.locator('.pf-new-ok').click(); await page.waitForTimeout(200);
s = await pf(); ok(s.path === 'art/items/gem.png' && s.w === 8, 'New creates a blank sprite at a path inside the project');
await setHex('#00ff00'); await page.keyboard.press('b'); await click(3, 3); await page.keyboard.press('Control+s'); await until(() => fs.existsSync(path.join(root, 'art/items/gem.png')));
ok(fs.existsSync(path.join(root, 'art/items/gem.png')) && decodePng(fs.readFileSync(path.join(root, 'art/items/gem.png'))).w === 8, 'saving it creates the file and its folder');
await page.locator('.pf-download').click(); ok(await page.locator('.pf-dlmenu [data-dl]').count() === 6, 'Download opens a menu: this PNG, 2/4/8/16×, all changed');
const dl = page.waitForEvent('download'); await page.locator('.pf-dlmenu [data-dl="4"]').click(); const d1 = await dl;
const out = path.join(os.tmpdir(), 'pf-export.png'); await d1.saveAs(out); const ex = decodePng(fs.readFileSync(out));
ok(d1.suggestedFilename() === 'gem@4x.png' && ex.w === 32 && ex.h === 32, 'Download at 4× gives ' + d1.suggestedFilename() + ' ' + ex.w + 'x' + ex.h);
const idx = (12 * 32 + 12) * 4; ok(ex.rgba[idx] === 0 && ex.rgba[idx + 1] === 255 && ex.rgba[idx + 3] === 255 && ex.rgba[(15 * 32 + 15) * 4 + 1] === 255, 'the upscale is nearest-neighbour (each pixel becomes a 4x4 block)');
const imp = fromRows(['rr', 'rr'], { r: [255, 0, 0] }); const impFile = path.join(os.tmpdir(), 'imported.png'); fs.writeFileSync(impFile, imp.png);
await page.locator('.pf-file').setInputFiles(impFile); await page.waitForTimeout(300);
s = await pf(); ok(s.path === 'imported.png' && s.w === 2, 'Open PNG imports a file from disk');
{ let dls = 0; const h = () => dls++; page.on('download', h); await page.keyboard.press('Control+s'); await page.waitForTimeout(500); page.off('download', h);
  ok(dls === 0 && !fs.existsSync(path.join(root, 'imported.png')), 'Save on an import neither downloads it nor writes it into the project by surprise');
  ok(/kept in this browser/.test(await page.locator('.pf-s-name').innerText()), 'it says the import is kept in this browser'); }
{ const dl3 = page.waitForEvent('download'); await page.keyboard.press('Control+Shift+s'); const d3 = await dl3; ok(d3.suggestedFilename() === 'imported.png', 'Ctrl+Shift+S downloads the PNG'); }
ok(await page.locator('.pf-delete').isVisible(), 'an import can be deleted (it is not in the project)');
globalThis.__confirmYes = true; await page.locator('.pf-delete').click(); await page.waitForTimeout(300); globalThis.__confirmYes = false;
ok(!(await page.locator('.pf-item .n').allInnerTexts()).some((n) => n.startsWith('imported.png')) && !fs.existsSync(path.join(root, 'imported.png')), 'Delete sprite removes it from the list (after asking, since it has pixels)');
await page.evaluate(() => document.getElementById('app').__pf.open('art/items/gem.png')); await page.waitForTimeout(200);
ok(await page.locator('.pf-delete').isHidden(), 'a new sprite already saved into the project is a real file now: no Delete here');
await page.evaluate(() => document.getElementById('app').__pf.open('art/slime.png')); await page.waitForTimeout(200);
ok(await page.locator('.pf-delete').isHidden(), 'nor for the project\'s own sprites');

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
const refs = { main: 'base1' }; const pulls = []; // refs and pull requests the test run creates, so later sections build on them
await ctx.route('https://api.github.com/**', async (route) => {
  const r = route.request(), u = new URL(r.url()), p = u.pathname, m = r.method(), body = r.postData() ? JSON.parse(r.postData()) : null; calls.push({ m, p, body, auth: r.headers().authorization }); if (m !== 'OPTIONS') authSeen.add(r.headers().authorization);
  const j = (status, obj) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(obj) });
  if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type,accept,x-github-api-version', 'access-control-allow-methods': '*' } });
  if (p === '/user') return j(200, { login: 'artist' });
  if (p === '/repos/me/game' && m === 'GET') return j(200, { name: 'game', default_branch: 'main', permissions: { push: pushAccess } });
  if (p === '/repos/me/game/branches') return j(200, [{ name: 'main', protected: true }, { name: 'art/wip', protected: false }]);
  { const mr = /^\/repos\/me\/game\/git\/ref\/heads\/(.+)$/.exec(p);
    if (mr && m === 'GET') { const b = decodeURIComponent(mr[1]); return refs[b] ? j(200, { object: { sha: refs[b] } }) : j(404, { message: 'no such ref' }); } }
  { const mc = /^\/repos\/me\/game\/git\/commits\/([^/]+)$/.exec(p);
    if (mc && m === 'GET') return j(200, { tree: { sha: 'tree-of-' + mc[1] } }); }
  if (p.endsWith('/git/blobs')) return j(201, { sha: 'b' + calls.length });
  if (p.endsWith('/git/trees') && m === 'POST') return j(201, { sha: 'tree1' });
  if (p.endsWith('/git/commits') && m === 'POST') return j(201, { sha: 'c1' });
  if (p.endsWith('/git/refs') && m === 'POST') { refs[body.ref.replace(/^refs\/heads\//, '')] = body.sha; return j(201, {}); }
  { const mp = /^\/repos\/me\/game\/git\/refs\/heads\/(.+)$/.exec(p);
    if (mp && m === 'PATCH') { refs[decodeURIComponent(mp[1])] = body.sha; return j(200, {}); } }
  if (p === '/repos/me/game/pulls' && m === 'POST') { const n = 3 + pulls.length; const pr = { html_url: 'https://github.com/me/game/pull/' + n, number: n, title: body.title, head: body.head, base: body.base }; pulls.push(pr); return j(201, pr); }
  if (p === '/repos/me/game/pulls' && m === 'GET') { const head = u.searchParams.get('head'); const list = pulls.filter((x) => !head || x.head === head || x.head.split(':').pop() === String(head).split(':').pop()).map(({ number, html_url, title }) => ({ number, html_url, title })); return j(200, list); }
  return j(404, { message: 'unexpected ' + m + ' ' + p });
});
await page.locator('.pf-item', { hasText: 'slime.png' }).click(); await page.waitForTimeout(200);
ok(!(await page.locator('.pf-prbtn').isDisabled()), 'Propose PR is enabled because sprites changed this session');
await page.locator('.pf-prbtn').click(); await page.waitForSelector('.pf-dlg-pr[open]');
ok((await page.locator('.pf-pr-repo').inputValue()) === 'me/game', 'the repository is filled in from the project');
const changedNames = await page.locator('.pf-chg > span').allInnerTexts(); ok(changedNames.length === 2 && changedNames.some((t) => t.includes('slime.png')) && changedNames.some((t) => t.includes('gem.png')), 'the dialog lists exactly the changed sprites (' + changedNames.map((t) => t.split('\n')[0]).join(', ') + ')');
ok((await page.locator('.pf-dirchg').allInnerTexts()).join() === '1 changed,1 changed', 'folder headers count the changed sprites, folded or not');
await page.locator('.pf-pr-token').fill('ghp_testtoken'); await page.locator('.pf-pr-title').fill('Improve slime'); await page.locator('.pf-pr-desc').fill('Redder eyes');
await page.locator('.pf-pr-go').click();
try { await page.waitForFunction(() => /Done/.test(document.querySelector('.pf-log').textContent), null, { timeout: 8000 }); } catch { console.log('   PR log:', JSON.stringify(await page.locator('.pf-log').innerText()), calls.map((c) => c.m + ' ' + c.p).join(' | ')); }
ok(await page.locator('.pf-log a').getAttribute('href') === 'https://github.com/me/game/pull/3', 'a link to the new pull request appears');
ok([...authSeen].join() === 'Bearer ghp_testtoken', 'the token is sent as a bearer header and nowhere else');
const blobs = calls.filter((c) => c.p.endsWith('/blobs')); const tree = calls.find((c) => c.p.endsWith('/trees') && c.body.base_tree).body;
ok(blobs.length === 6 && tree.tree.map((t) => t.path).sort().join() === 'art/items/gem.png,art/slime.png', 'the branch tree has just the two sprites, with repo-relative paths: ' + tree.tree.map((t) => t.path).join(','));
{ const trees = [calls.find((c) => c.p.endsWith('/trees') && !c.body.base_tree).body], pcommit = calls.filter((c) => c.m === 'POST' && c.p.endsWith('/commits'))[0].body;
  ok(trees[0].tree.map((t) => t.path).join() === '0-before.png,0-after.png,1-before.png,1-after.png' && pcommit.parents.length === 0 && calls.some((c) => c.p.endsWith('/refs') && /^refs\/spritewright\/previews\/art\/improve-slime-/.test(c.body.ref)), 'upscaled before/after previews go in a separate commit on no branch, kept by a hidden ref');
  const iAfter = trees[0].tree.findIndex((t) => t.path.endsWith('-after.png') && t.path.startsWith(String(tree.tree.findIndex((x) => x.path === 'art/slime.png'))));
  const prev = decodePng(Buffer.from(blobs[2 + iAfter].body.content, 'base64'));
  ok(prev.w === 256 && prev.h === 256 && prev.rgba[0] === 255 && prev.rgba[(15 * 256 + 15) * 4] === 255, 'the slime preview is 16× nearest-neighbour (256 px, crisp blocks): ' + prev.w + 'x' + prev.h); }
const slimeBlob = decodePng(Buffer.from(blobs[tree.tree.findIndex((t) => t.path === 'art/slime.png')].body.content, 'base64'));
ok(slimeBlob.w === 16 && slimeBlob.rgba[0] === 255 && slimeBlob.rgba[3] === 255, 'the committed PNG contains the edit');
const prCall = calls.find((c) => c.p === '/repos/me/game/pulls'); ok(prCall.body.title === 'Improve slime' && /Redder eyes/.test(prCall.body.body) && /pixels changed/i.test(prCall.body.body) && /raw\.githubusercontent\.com\/me\/game\/c1\/\d-after\.png" width="256"/.test(prCall.body.body) && prCall.body.head.startsWith('art/improve-slime-') && prCall.body.base === 'main', 'PR title, body (description + table) and branch are right');
await page.locator('.pf-dlg-pr button[value=cancel]').click();
ok(await page.locator('.pf-prbtn').isDisabled(), 'after the PR, nothing is pending any more');
ok(await page.evaluate(() => sessionStorage.getItem('pf:token')) !== null && (await page.evaluate(() => localStorage.getItem('pf:token'))) === null, 'the token is kept for the tab only unless "remember" is ticked');

section('commit in chunks, branches, pull requests later');
await page.locator('.pf-item', { hasText: 'slime.png' }).click();
await page.waitForFunction(() => document.getElementById('app').__pf.current.path.endsWith('slime.png'));
await page.keyboard.press('b');
await setHex('#00ff00'); await click(3, 3);
await page.locator('.pf-item', { hasText: 'gem.png' }).click();
await page.waitForFunction(() => document.getElementById('app').__pf.current.path.endsWith('gem.png'));
await click(4, 4);
await page.locator('.pf-commit > summary').click(); // the panel rests collapsed
await page.waitForFunction(() => document.querySelectorAll('.pf-commit-list input[type=checkbox]').length === 2);
ok((await page.locator('.pf-commit-list input[type=checkbox]').count()) === 2, 'the commit panel lists both changed sprites');
await page.locator('.pf-commit-list input[type=checkbox]').first().uncheck();
await page.locator('.pf-commit-msg').fill('chunk one');
await page.waitForFunction(() => document.querySelectorAll('.pf-commit-branches option').length >= 2);
ok((await page.locator('.pf-commit-branches option').allInnerTexts()).join().includes('art/wip'), 'the branch picker lists the repository branches');
await page.locator('.pf-commit-branches').selectOption('');
await page.locator('.pf-commit-branch').fill('art/chunks');
const at = calls.length;
await page.locator('.pf-commit-go').click();
try { await page.waitForFunction(() => /Created|Committed/.test(document.querySelector('.pf-commit-note').textContent), null, { timeout: 8000 }); } catch { console.log('   commit note:', JSON.stringify(await page.locator('.pf-commit-note').innerText()), calls.slice(at).map((c) => c.m + ' ' + c.p).join(' | ')); }
const chunkTree = calls.slice(at).find((c) => c.p.endsWith('/git/trees') && c.body.base_tree);
ok(chunkTree && chunkTree.body.tree.length === 1, 'only the ticked sprite is committed');
ok(await page.locator('.pf-commit-openpr').count() === 1, 'with no open pull request for the branch, the panel offers to open one');
await page.locator('.pf-commit-openpr').click();
try { await page.waitForFunction(() => /pull\/4/.test(document.querySelector('.pf-commit-note').innerHTML), null, { timeout: 8000 }); } catch { console.log('   open-pr note:', JSON.stringify(await page.locator('.pf-commit-note').innerText())); }
ok((await page.locator('.pf-commit-note a').getAttribute('href')) === 'https://github.com/me/game/pull/4', 'one click opens the pull request for the whole branch');
await setHex('#0000ff'); await click(5, 5);
await page.waitForFunction(() => document.querySelectorAll('.pf-commit-list input[type=checkbox]').length >= 1);
await page.locator('.pf-commit-msg').fill('chunk two');
const pullsBefore = calls.filter((c) => c.p === '/repos/me/game/pulls' && c.m === 'POST').length;
await page.locator('.pf-commit-go').click();
try { await page.waitForFunction(() => /added to|pull request/.test(document.querySelector('.pf-commit-note').textContent), null, { timeout: 8000 }); } catch { console.log('   chunk-two note:', JSON.stringify(await page.locator('.pf-commit-note').innerText())); }
console.log('   chunk-two state:', JSON.stringify(await page.locator('.pf-commit-note').innerText()), 'pulls POSTs:', calls.filter((c) => c.p === '/repos/me/game/pulls' && c.m === 'POST').length, 'api:', calls.filter((c) => /pulls|git\/ref/.test(c.p)).map((c) => c.m + ' ' + c.p).join(' | '));
const afterCount = calls.filter((c) => c.p === '/repos/me/game/pulls' && c.m === 'POST').length;
const noteHtml = await page.locator('.pf-commit-note').innerHTML();
ok(afterCount === pullsBefore, 'the second chunk opens no new pull request');
ok(/pull\/4/.test(noteHtml), 'it joins pull request #4');
ok(calls.some((c) => c.m === 'PATCH' && /art\/chunks$/.test(c.p)), 'appending to the branch updates its ref');
ok((await page.locator('.pf-commit-branches').inputValue()) === 'art/chunks', 'the picker stays on the branch the chunks go to');

section('standalone: hosted page + GitHub repository (no server, no manifest)');
{
  const http = await import('node:http');
  const pkg = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  // a static host that only serves the editor, like GitHub Pages would
  const stat = http.createServer((req, res) => { const f = req.url.split('?')[0] === '/spritewright.js' ? 'spritewright.js' : req.url.split('?')[0] === '/' ? 'index.html' : null; if (!f) { res.writeHead(404); return res.end('nope'); } res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(fs.readFileSync(path.join(pkg, f))); });
  await new Promise((r) => stat.listen(0, '127.0.0.1', r)); const sbase = `http://127.0.0.1:${stat.address().port}/`;
  const REPO = { 'art/hero.png': slime.png, 'art/enemies/walk.png': sheet.png, 'docs/shot.png': slime.png, 'spritewright.config.json': Buffer.from(JSON.stringify({ dirs: ['art'], palette: 'palette.hex' })), 'palette.hex': Buffer.from('1a1c2c\n3cb450\n78e682\nff0000\n') };
  const tree = Object.entries(REPO).map(([p, b], i) => ({ path: p, type: 'blob', sha: 'sha' + i, size: b.length }));
  const gcalls = [], rawSeen = []; let canPush = true, tokenOnly = false, isPublic = false;
  const gctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, colorScheme: 'dark' });
  await gctx.route('https://api.github.com/**', async (route) => {
    const r = route.request(), u = new URL(r.url()), p = u.pathname, m = r.method(), body = r.postData() ? JSON.parse(r.postData()) : null; gcalls.push({ m, p, body, auth: r.headers().authorization });
    const j = (st, o) => route.fulfill({ status: st, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(o) });
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type,accept,x-github-api-version', 'access-control-allow-methods': '*' } });
    if (p === '/user') return j(200, { login: 'artist' });
    if (p === '/repos/me/game' && m === 'GET') return tokenOnly && !r.headers().authorization ? j(404, { message: 'Not Found' }) : j(200, { name: 'game', default_branch: 'main', permissions: { push: canPush }, ...(isPublic ? { private: false } : {}) });
    if (p === '/repos/nope/x') return j(404, { message: 'Not Found' });
    if (p === '/repos/me/game/branches') return j(200, [{ name: 'main', protected: true }, { name: 'art/test', protected: false }]);
    if (p === '/repos/me/game/git/ref/heads/main') return j(200, { object: { sha: 'c1' } });
    if (p === '/repos/me/game/git/ref/heads/art/test') return j(200, { object: { sha: 'c1' } });
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
  await gctx.route('https://raw.githubusercontent.com/**', (route) => { const u = new URL(route.request().url()), m = /^\/me\/game\/c1\/(.+)$/.exec(u.pathname), f = m && REPO[decodeURIComponent(m[1])]; rawSeen.push(u.pathname); return f ? route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: f }) : route.fulfill({ status: 404, body: '' }); });
  const thumbsPainted = (pg) => pg.evaluate(() => [...document.querySelectorAll('.pf-item')].map((b) => { const c = b.querySelector('canvas'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let on = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) on++; return { on, size: b.querySelector('small').textContent }; }));
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
  { let th = []; await until(async () => (th = await thumbsPainted(gp)).every((t) => t.on > 0));
    ok(th.length === 2 && th.every((t) => t.on > 0 && !/\?/.test(t.size)), 'every sprite\'s thumbnail and size load straight away, without clicking: ' + th.map((t) => t.on + 'px ' + t.size).join(' | ')); }
  ok(await gp.locator('.pf-pal-colors button').count() === 4, 'the repository palette is loaded');
  ok(/me\/game/.test(await gp.locator('.pf-source').innerText()) && /⎇ main/.test(await gp.locator('.pf-source').innerText()), 'the sidebar names the repo and branch, zsh style: ' + await gp.locator('.pf-source').innerText());
  await gp.locator('.pf-source').click(); await gp.waitForSelector('.pf-brmenu');
  await gp.waitForFunction(() => document.querySelectorAll('.pf-brmenu [data-branch]').length === 2);
  ok((await gp.locator('.pf-brmenu [data-branch]').allInnerTexts()).join() === '⎇ main,⎇ art/test', 'clicking it lists the branches');
  await gp.locator('.pf-brmenu [data-branch="art/test"]').click();
  await gp.waitForFunction(() => document.querySelector('.pf-source').textContent.includes('art/test'));
  await gp.waitForFunction(() => document.getElementById('app').__pf.current);
  ok(/⎇ art\/test/.test(await gp.locator('.pf-source').innerText()) && (await gp.locator('.pf-item').count()) === 2, 'switching branches reopens the repo there: ' + await gp.locator('.pf-source').innerText());
  await gp.locator('.pf-source').click(); await gp.waitForSelector('.pf-brmenu');
  await gp.waitForFunction(() => document.querySelectorAll('.pf-brmenu [data-branch]').length === 2);
  await gp.locator('.pf-brmenu [data-branch="main"]').click();
  await gp.waitForFunction(() => /⎇ main/.test(document.querySelector('.pf-source').textContent));
  await gp.waitForFunction(() => document.getElementById('app').__pf.current);
  ok(/⎇ main/.test(await gp.locator('.pf-source').innerText()), 'and back again');
  ok(await gp.evaluate(() => { const pf = document.getElementById('app').__pf; return pf.current.path === pf.state.sprites[0].path; }), 'switching branches opens the first sprite again');
  await gp.locator('.pf-item', { hasText: 'hero.png' }).click(); await gp.waitForTimeout(250);
  const gview = await gp.locator('.pf-view').boundingBox();
  const gS = await gp.evaluate(() => { const S = document.getElementById('app').__pf.state, v = document.querySelector('.pf-view'); return { z: S.zoom, ox: S.ox, oy: S.oy, k: v.width / v.getBoundingClientRect().width }; });
  await gp.locator('.pf-chex').fill('#ff0000'); await gp.locator('.pf-chex').press('Tab');
  await gp.mouse.click(gview.x + (gS.ox + 0.5 * gS.z) / gS.k, gview.y + (gS.oy + 0.5 * gS.z) / gS.k);
  ok(await gp.evaluate(() => document.getElementById('app').__pf.current.px[0]) === RED, 'drawing works on a repository sprite');
  { let dls = 0; const h = () => dls++; gp.on('download', h); await gp.keyboard.press('Control+s'); await gp.waitForTimeout(400); gp.off('download', h);
    ok(dls === 0 && /kept in this browser, not in a PR yet/.test(await gp.locator('.pf-s-name').innerText()), 'Save does not download: the edit is kept in this browser, not in a PR yet');
    ok((await gp.locator('.pf-save').innerText()) === 'Saved', 'the Save button says Saved'); }
  await gp.reload(); await gp.waitForFunction(() => { const a = document.getElementById('app').__pf; return a && a.current && a.current.path === 'art/hero.png'; });
  ok(!(await gp.locator('.pf-dlg-connect').evaluate((d) => d.open)), 'after a reload the last repository reopens by itself');
  ok(await gp.evaluate(() => document.getElementById('app').__pf.current.px[0]) === RED && /restored from this browser/.test(await gp.locator('.pf-s-note').innerText()), 'and the edited sprite comes back with the edit, opened first');
  ok(await gp.locator('.pf-item .dot.base').count() === 1, 'the list marks it as changed (not in a PR yet)');
  await gp.locator('.pf-prbtn').click(); await gp.waitForSelector('.pf-dlg-pr[open]');
  ok((await gp.locator('.pf-pr-repo').inputValue()) === 'me/game' && (await gp.locator('.pf-pr-base').inputValue()) === 'main' && (await gp.locator('.pf-pr-token').inputValue()) === 'ghp_standalone', 'the PR dialog is prefilled from the connection (repo, branch, token)');
  await gp.locator('.pf-pr-title').fill('Hero update'); await gp.locator('.pf-pr-go').click(); await gp.waitForFunction(() => /Done/.test(document.querySelector('.pf-log').textContent), null, { timeout: 8000 });
  const gtree = gcalls.find((c) => c.p.endsWith('/git/trees') && c.m === 'POST' && c.body.base_tree).body;
  ok(gtree.tree.length === 1 && gtree.tree[0].path === 'art/hero.png', 'the commit touches only the edited sprite, at its repository path (' + gtree.tree.map((t) => t.path) + ')');
  ok(gcalls.some((c) => c.p === '/repos/me/game/pulls') && !gcalls.some((c) => c.p.endsWith('/forks')), 'a PR was opened directly on the repo (the token can push)');
  await gp.locator('.pf-dlg-pr button[value=cancel]').click();
  // fork flow
  canPush = false; gcalls.length = 0;
  await gp.locator('.pf-item', { hasText: 'walk.png' }).click(); await gp.waitForTimeout(250);
  await gp.locator('.pf-clear').click(); await gp.locator('.pf-prbtn').click(); await gp.waitForSelector('.pf-dlg-pr[open]');
  await gp.locator('.pf-pr-go').click(); await gp.waitForFunction(() => /Done/.test(document.querySelector('.pf-log').textContent), null, { timeout: 12000 });
  ok(gcalls.some((c) => c.p.endsWith('/forks')) && gcalls.find((c) => c.p === '/repos/me/game/pulls').body.head.startsWith('artist:'), 'without push access it forks and opens the PR from the fork');
  await gp.waitForTimeout(500);
  ok(await gp.evaluate(async () => (await window.Spritewright.core.browserDrafts().list('github:me/game@main')).length) === 0, 'once the changes are in pull requests the browser copies are dropped');
  await gp.close();
  // public repository: files come from GitHub's file CDN (no API rate limit), the API is only used to list them
  { isPublic = true; const before = gcalls.filter((c) => /\/git\/blobs\/sha/.test(c.p)).length, rawBefore = rawSeen.length;
    const pp = await gctx.newPage(); pp.on('pageerror', (e) => gerr.push(e.message)); await pp.goto(sbase + '?auth=off&repo=me/game'); await pp.waitForSelector('.pf-item');
    let th = []; await until(async () => (th = await thumbsPainted(pp)).every((t) => t.on > 0));
    const apiBlobs = gcalls.filter((c) => /\/git\/blobs\/sha/.test(c.p)).length - before;
    ok(th.every((t) => t.on > 0) && rawSeen.length - rawBefore >= 4 && apiBlobs === 0, `public repository: thumbnails, config and palette come from raw.githubusercontent.com (${rawSeen.length - rawBefore} files), with no API blob calls (${apiBlobs})`);
    ok(rawSeen.slice(rawBefore).every((p) => p.startsWith('/me/game/c1/')), 'pinned to the exact commit that was listed');
    await pp.close(); isPublic = false; }
  // deep link
  const dp = await gctx.newPage(); canPush = true; await dp.goto(sbase + '?repo=me/game'); await dp.waitForSelector('.pf-item'); ok(await dp.locator('.pf-item').count() === 2, '?repo=owner/name opens the repository directly (token remembered for this tab from before is reused)');
  await dp.close();
  ok(gerr.length === 0, 'no page errors in GitHub mode ' + gerr.join('|'));
  await gctx.close(); stat.close();
}

section('art folders: a repository without spritewright.config.json asks once, and the pick goes into the pull request');
{
  const http = await import('node:http');
  const pkg = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const stat = http.createServer((req, res) => { const f = req.url.split('?')[0] === '/spritewright.js' ? 'spritewright.js' : req.url.split('?')[0] === '/' ? 'index.html' : null; if (!f) { res.writeHead(404); return res.end('nope'); } res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(fs.readFileSync(path.join(pkg, f))); });
  await new Promise((r) => stat.listen(0, '127.0.0.1', r)); const abase = `http://127.0.0.1:${stat.address().port}/`;
  const REPO = { 'icon.png': slime.png, 'assets/sprites/hero.png': slime.png, 'assets/tiles/floor.png': slime.png, 'docs/shot.png': slime.png, 'public/screenshots/s.png': slime.png };
  const tree = Object.entries(REPO).map(([p, b], i) => ({ path: p, type: 'blob', sha: 'sha' + i, size: b.length }));
  const blobs = [], posts = [];
  const actx2 = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  await actx2.route('https://api.github.com/**', async (route) => {
    const r = route.request(), p = new URL(r.url()).pathname, m = r.method(), body = r.postData() ? JSON.parse(r.postData()) : null;
    const j = (st, o) => route.fulfill({ status: st, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(o) });
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type,accept,x-github-api-version', 'access-control-allow-methods': '*' } });
    if (m === 'POST') posts.push({ p, body });
    if (p === '/user') return j(200, { login: 'artist' });
    if (p === '/repos/me/art' && m === 'GET') return j(200, { name: 'art', default_branch: 'main', permissions: { push: true } });
    if (p === '/repos/me/empty' && m === 'GET') return j(200, { name: 'empty', default_branch: 'main', permissions: { push: true } });
    if (p === '/repos/me/empty/git/ref/heads/main') return j(200, { object: { sha: 'e1' } });
    if (p === '/repos/me/empty/git/commits/e1') return j(200, { tree: { sha: 'et' } });
    if (p === '/repos/me/empty/git/trees/et') return j(200, { tree: [{ path: 'src', type: 'tree' }, { path: 'src/app.js', type: 'blob', sha: 'x', size: 10 }, { path: 'assets', type: 'tree' }, { path: 'node_modules', type: 'tree' }], truncated: false });
    if (p === '/repos/me/art/git/ref/heads/main') return j(200, { object: { sha: 'c1' } });
    if (p === '/repos/me/art/git/commits/c1') return j(200, { tree: { sha: 't1' } });
    if (p === '/repos/me/art/git/trees/t1') return j(200, { tree, truncated: false });
    const bm = /\/git\/blobs\/sha(\d+)$/.exec(p); if (bm && m === 'GET') return j(200, { encoding: 'base64', content: Buffer.from(Object.values(REPO)[+bm[1]]).toString('base64') });
    if (p.endsWith('/git/blobs')) { blobs.push(Buffer.from(body.content, 'base64')); return j(201, { sha: 'nb' + blobs.length }); }
    if (p.endsWith('/git/trees')) return j(201, { sha: 't2' }); if (p.endsWith('/git/commits')) return j(201, { sha: 'c2' }); if (p.endsWith('/git/refs')) return j(201, {});
    if (p === '/repos/me/art/pulls') return j(201, { html_url: 'https://github.com/me/art/pull/1', number: 1 });
    return j(404, { message: 'unexpected ' + m + ' ' + p });
  });
  const fp2 = await actx2.newPage(); const aerr2 = []; fp2.on('pageerror', (e) => aerr2.push(e.message)); fp2.on('dialog', (d) => d.dismiss());
  await fp2.goto(abase + '?auth=off&repo=me/art'); await fp2.waitForSelector('.pf-dlg-folders[open]');
  const rows = await fp2.locator('.pf-af-list label').evaluateAll((ls) => ls.map((l) => (l.querySelector('input').checked ? '+' : '-') + l.querySelector('code').textContent));
  ok(rows.join(' ') === '+(top level) +assets/sprites/ +assets/tiles/ -docs/ -public/screenshots/', 'opening it asks which folders hold the art, docs and screenshots unticked: ' + rows.join(' '));
  if (process.env.PF_SHOTS) await fp2.locator('.pf-dlg-folders').screenshot({ path: process.env.PF_SHOTS + '/art-folders.png' });
  await fp2.locator('.pf-af-list input[value=""]').uncheck(); await fp2.click('.pf-af-go');
  ok(/Art folders picked/.test(await fp2.locator('.pf-setup').innerText()), 'the sprite list says the pick goes with the next pull request, with a way to change it');
  await fp2.waitForFunction(() => document.querySelectorAll('.pf-item').length === 2);
  ok((await fp2.locator('.pf-item').evaluateAll((b) => b.map((x) => x.dataset.path).sort())).join() === 'assets/sprites/hero.png,assets/tiles/floor.png', 'the list narrows to the picked folders at once');
  await fp2.reload(); await fp2.waitForSelector('.pf-item'); await fp2.waitForTimeout(300);
  ok(!(await fp2.locator('.pf-dlg-folders').evaluate((d) => d.open)) && await fp2.locator('.pf-item').count() === 2, 'reopening it in this browser does not ask again, and keeps the pick');
  await fp2.locator('.pf-source').click(); await fp2.locator('.pf-br-folders').click(); await fp2.waitForSelector('.pf-dlg-folders[open]');
  ok((await fp2.locator('.pf-af-list input:checked').evaluateAll((i) => i.map((x) => x.value))).join() === 'assets/sprites,assets/tiles', 'Art folders… in the project menu reopens it with the current pick');
  await fp2.keyboard.press('Escape');
  await fp2.locator('.pf-item', { hasText: 'hero' }).click(); await fp2.waitForTimeout(200); await fp2.keyboard.press('b');
  const vb2 = await fp2.locator('.pf-view').boundingBox(); await fp2.mouse.click(vb2.x + vb2.width / 2, vb2.y + vb2.height / 2); await fp2.waitForTimeout(200);
  await fp2.locator('.pf-prbtn').click(); await fp2.waitForSelector('.pf-dlg-pr[open]');
  await fp2.locator('.pf-pr-token').fill('ghp_test'); await fp2.locator('.pf-pr-go').click();
  await fp2.waitForFunction(() => /Done/.test(document.querySelector('.pf-log').textContent), null, { timeout: 15000 });
  const tr = posts.find((x) => x.p.endsWith('/git/trees') && x.body.tree.some((t) => t.path === 'spritewright.config.json'));
  const cfgBlob = tr && blobs[+tr.body.tree.find((t) => t.path === 'spritewright.config.json').sha.slice(2) - 1];
  ok(!!tr && tr.body.tree.some((t) => t.path === 'assets/sprites/hero.png'), 'the pull request carries spritewright.config.json next to the sprite');
  ok(cfgBlob && JSON.stringify(JSON.parse(cfgBlob.toString()).dirs) === '["assets/sprites","assets/tiles"]', 'with the picked folders: ' + (cfgBlob && cfgBlob.toString().replace(/\s+/g, ' ')));
  ok(/Also adds `spritewright\.config\.json`/.test(posts.find((x) => x.p.endsWith('/pulls')).body.body), 'and the description says so');
  ok(await fp2.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('pf:folders:')).every((k) => JSON.parse(localStorage.getItem(k)).sent)), 'it is sent once: the next pull request does not carry it again');
  ok(await fp2.locator('.pf-setup').isHidden(), 'and the setup note goes away');
  // a repository with no art yet: nothing to tick, so it asks where the art goes
  await fp2.goto(abase + '?auth=off&repo=me/empty'); await fp2.waitForFunction(() => document.querySelector('.pf-source').textContent.includes('me/empty')); await fp2.waitForTimeout(300);
  ok(!(await fp2.locator('.pf-dlg-folders').evaluate((d) => d.open)) && /No sprites here yet/.test(await fp2.locator('.pf-setup').innerText()), 'a repository without sprites does not pop the question, but the sprite list offers to set it up');
  await fp2.locator('.pf-setup-go').click(); await fp2.waitForSelector('.pf-dlg-folders[open] .pf-af-dir');
  ok((await fp2.locator('#pf-af-dirs option').evaluateAll((o) => o.map((x) => x.value))).join() === 'assets,src' && await fp2.locator('.pf-af-all').isHidden(), 'it asks which folder the art goes in, suggesting the repository\'s folders');
  await fp2.locator('.pf-af-dir').fill('assets/sprites'); await fp2.click('.pf-af-go');
  await fp2.locator('.pf-new').click(); await fp2.waitForSelector('.pf-dlg-new[open]');
  ok((await fp2.locator('.pf-nn').inputValue()) === 'assets/sprites/new_sprite.png', 'and New puts the first sprite there: ' + await fp2.locator('.pf-nn').inputValue());
  await fp2.keyboard.press('Escape');
  ok(aerr2.length === 0, 'no page errors ' + aerr2.join('|'));
  await actx2.close(); stat.close();
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
  const app = (pg, fn) => pg.evaluate(fn);
  await sp.waitForFunction(() => /kept in this browser/.test(document.querySelector('.pf-s-name').textContent));
  ok(true, 'a drawn pixel is kept in this browser straight away (no download, no button)');
  { let dls = 0; const h = () => dls++; sp.on('download', h); await sp.keyboard.press('Control+s'); await sp.waitForTimeout(400); sp.off('download', h);
    ok(dls === 0 && (await sp.locator('.pf-save').innerText()) === 'Saved', 'Ctrl+S does not download anything; the button says Saved'); }
  const dl = sp.waitForEvent('download'); await sp.locator('.pf-download').click(); await sp.locator('.pf-dlmenu [data-dl="1"]').click(); const d1 = await dl;
  const f1 = path.join(os.tmpdir(), 'pf-session-out.png'); await d1.saveAs(f1); const out = decodePng(fs.readFileSync(f1));
  ok(d1.suggestedFilename() === 'my-heart.png', 'Download gives the edited file under its own name: ' + d1.suggestedFilename());
  ok(out.rgba[0] === 0 && out.rgba[1] === 255 && out.rgba[3] === 255, 'the downloaded PNG contains the edit');
  ok(out.rgba[(1 * 4 + 1) * 4 + 3] === 250 && out.rgba[(1 * 4 + 1) * 4] === 255, 'and the semi-transparent pixels of the upload (alpha 250) are unchanged');
  // a reload brings it all back
  await sp.reload(); await sp.waitForFunction(() => { const a = document.getElementById('app').__pf; return a && a.current && a.current.path === 'my-heart.png'; });
  ok(!(await sp.locator('.pf-dlg-connect').evaluate((d) => d.open)), 'after a reload the page carries on with the sprite from this browser (no project dialog)');
  { const px = await app(sp, () => [...document.getElementById('app').__pf.current.px]); ok(px[0] === (0xff00ff00 >>> 0) && px[1 * 4 + 1] >>> 24 === 250, 'with the edit, and every pixel exact (alpha 250 too)'); }
  { const dz = sp.waitForEvent('download'); await sp.locator('.pf-download').click(); await sp.locator('.pf-dlmenu [data-dl="all"]').click(); const z = await dz; const zf = path.join(os.tmpdir(), 'pf-all.zip'); await z.saveAs(zf);
    const r = spawnSync('python3', ['-I', '-c', 'import zipfile,sys; print(",".join(zipfile.ZipFile(sys.argv[1]).namelist()))', zf], { encoding: 'utf8' });
    ok(z.suggestedFilename() === 'Sketches-changed.zip' && r.stdout.trim() === 'my-heart.png', 'Download → all changed sprites gives a .zip: ' + z.suggestedFilename() + ' [' + r.stdout.trim() + ']'); }
  // leaving: only asks while an edit is not kept yet
  { const v2 = await sp.locator('.pf-view').boundingBox(), S1 = await sp.evaluate(() => { const S = document.getElementById('app').__pf.state, c = document.querySelector('.pf-view'); return { z: S.zoom, ox: S.ox, oy: S.oy, k: c.width / c.getBoundingClientRect().width }; });
    await sp.mouse.click(v2.x + (S1.ox + 1.5 * S1.z) / S1.k, v2.y + (S1.oy + 1.5 * S1.z) / S1.k); }
  let asked = false; sp.once('dialog', async (d) => { asked = d.type() === 'beforeunload'; await d.dismiss(); });
  await sp.close({ runBeforeUnload: true }); await new Promise((r) => setTimeout(r, 300));
  ok(asked, 'closing the tab in the instant before an edit is kept shows the "leave site?" warning');
  await sp.waitForFunction(() => /kept in this browser/.test(document.querySelector('.pf-s-name').textContent));
  const lastPx = await sp.evaluate(() => document.getElementById('app').__pf.current.px[1 * 4 + 1]);
  asked = false; sp.once('dialog', async (d) => { asked = true; await d.dismiss(); });
  await sp.close({ runBeforeUnload: true }); await new Promise((r) => setTimeout(r, 300));
  ok(!asked && sp.isClosed(), 'once it is kept the tab closes without a warning (nothing would be lost)');
  // blank sprite path, next to the kept one
  const bp = await sctx.newPage(); await bp.goto(hbase); await bp.waitForFunction(() => { const a = document.getElementById('app').__pf; return a && a.current; });
  ok((await bp.evaluate(() => document.getElementById('app').__pf.current.px[1 * 4 + 1])) === lastPx && lastPx !== (0xfa0000ff >>> 0), 'a new tab shows the latest edit too');
  ok((await bp.locator('.pf-source').innerText()) === 'Sketches', 'what was drawn without a project shows as "Sketches", a project in this browser');
  await bp.locator('.pf-source').click(); await bp.waitForSelector('.pf-dlg-connect[open]'); await bp.waitForSelector('.pf-c-lp');
  ok((await bp.locator('.pf-c-lp').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()).join('|').startsWith('Sketches 1 sprite · open'), 'the dialog lists the projects in this browser: ' + (await bp.locator('.pf-c-lp').allInnerTexts()).join('|').replace(/\s+/g, ' '));
  await bp.locator('.pf-c-blank').click(); await bp.waitForSelector('.pf-dlg-new[open]');
  ok((await bp.locator('.pf-source').innerText()) === 'Untitled 1' && await bp.locator('.pf-item').count() === 0, 'New blank project starts an empty project in this browser, nothing linked, and asks for the first sprite');
  ok(await bp.evaluate(() => document.querySelector('.pf-p2').width === 0 && document.querySelector('.pf-p1').width === 0 && /no image open/.test(document.querySelector('.pf-img-colors').textContent) && document.querySelector('.pf-fam').hidden), 'and the right-hand panels drop the last project\'s sprite (preview, frames, colours)');
  await bp.locator('.pf-nw').fill('8'); await bp.locator('.pf-nh').fill('8'); await bp.locator('.pf-nn').fill('gem.png'); await bp.locator('.pf-new-ok').click(); await bp.waitForTimeout(400);
  ok((await bp.evaluate(() => { const d = document.getElementById('app').__pf.current; return d.path + ' ' + d.w + 'x' + d.h; })) === 'gem.png 8x8', 'a blank sprite starts a new document of the chosen size');
  await bp.locator('.pf-new').click(); await bp.locator('.pf-nn').fill('scrap.png'); await bp.locator('.pf-new-ok').click(); await bp.waitForTimeout(400);
  await bp.reload(); await bp.waitForFunction(() => { const a = document.getElementById('app').__pf; return a && a.current; }); await bp.waitForTimeout(300);
  { const names = (await bp.locator('.pf-item .n').allInnerTexts()).map((n) => n.split('\n')[0]).sort(); ok(names.join() === 'gem.png,scrap.png' && (await bp.locator('.pf-source').innerText()) === 'Untitled 1', 'after a reload the same project reopens with its sprites: ' + names); }
  // delete a sprite that only exists here
  await bp.evaluate(() => document.getElementById('app').__pf.open('scrap.png')); await bp.waitForTimeout(200);
  ok(await bp.locator('.pf-delete').isVisible(), 'Delete sprite is offered for a sprite that only exists in this browser');
  await bp.locator('.pf-delete').click(); await bp.waitForTimeout(500);
  ok((await bp.locator('.pf-item .n').allInnerTexts()).map((n) => n.split('\n')[0]).join() === 'gem.png' && (await bp.evaluate(() => document.getElementById('app').__pf.current.path)) === 'gem.png', 'it disappears (an empty one without asking) and the next sprite opens');
  await bp.reload(); await bp.waitForFunction(() => { const a = document.getElementById('app').__pf; return a && a.current; }); await bp.waitForTimeout(300);
  ok(await bp.locator('.pf-item').count() === 1, 'and it stays deleted after a reload');
  // switch between projects in this browser, rename, delete
  await bp.locator('.pf-source').click(); await bp.waitForSelector('.pf-c-lp');
  await bp.locator('.pf-c-lp', { hasText: 'Sketches' }).locator('.pf-c-lopen').click(); await bp.waitForFunction(() => document.querySelector('.pf-source').textContent === 'Sketches');
  ok((await bp.evaluate(() => document.getElementById('app').__pf.current.path)) === 'my-heart.png', 'one click switches to another project in this browser, with its own sprites');
  await bp.locator('.pf-source').click(); await bp.waitForSelector('.pf-c-lp');
  bp.once('dialog', (d) => d.accept('Dungeon tiles')); await bp.locator('.pf-c-lp', { hasText: 'Untitled 1' }).locator('.pf-c-lren').click(); await bp.waitForTimeout(300);
  ok((await bp.locator('.pf-c-lp').allInnerTexts()).some((t) => t.startsWith('Dungeon tiles')), 'projects can be renamed');
  bp.once('dialog', (d) => d.accept()); await bp.locator('.pf-c-lp', { hasText: 'Dungeon tiles' }).locator('.pf-c-ldel').click(); await bp.waitForTimeout(500);
  ok(!(await bp.locator('.pf-c-lp').allInnerTexts()).some((t) => t.startsWith('Dungeon')) && await bp.evaluate(async () => (await window.Spritewright.core.browserDrafts().list('browser:/#' + JSON.parse(localStorage.getItem('pf:local-projects') || '[]').map((x) => x.id)[0])).length) === 0, 'and deleted, with their sprites');
  await bp.keyboard.press('Escape');
  ok(!(await bp.locator('.pf-delete').isVisible()) || (await bp.evaluate(() => document.getElementById('app').__pf.current.local)), 'Delete sprite only shows for sprites that exist only here');
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
  const actx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' }); let installed = false;
  await actx.grantPermissions(['clipboard-read', 'clipboard-write']);
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
    if (p === '/user/installations') return j({ installations: installed ? [{ id: 1 }] : [] });
    if (p === '/user/installations/1/repositories') return j({ repositories: [{ full_name: 'me/game', private: true, default_branch: 'main', permissions: { push: true } }, { full_name: 'them/art-only', default_branch: 'master', permissions: { push: false, pull: true } }] });
    if (p === '/repos/me/game') return j({ default_branch: 'main', permissions: { push: true } });
    if (p === '/repos/them/art-only') return j({ default_branch: 'master', permissions: { push: false } });
    if (p === '/repos/them/art-only/git/ref/heads/master') return j({ object: { sha: 'd1' } });
    if (p === '/repos/them/art-only/git/commits/d1') return j({ tree: { sha: 'u1' } });
    if (p === '/repos/them/art-only/git/trees/u1') return j({ tree: [{ path: 'gfx/b.png', type: 'blob', sha: 'sha0', size: 99 }, { path: 'gfx/c.png', type: 'blob', sha: 'sha0', size: 99 }], truncated: false });
    if (p === '/repos/them/art-only/git/blobs/sha0') return j({ encoding: 'base64', content: encodePng(4, 4, Buffer.alloc(64)).toString('base64') });
    if (p === '/repos/me/game/git/ref/heads/main') return j({ object: { sha: 'c1' } });
    if (p === '/repos/me/game/git/commits/c1') return j({ tree: { sha: 't1' } });
    if (p === '/repos/me/game/git/trees/t1') await new Promise((r) => setTimeout(r, 400)); // slow enough to see it loading
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
  // first visit: the app is on none of their repositories yet
  await ap.waitForSelector('.pf-c-start');
  ok(/select_target/.test(await ap.locator('.pf-c-install').getAttribute('href')) && /Choose which repositories/.test(await ap.locator('.pf-c-start').innerText()), 'with nothing installed the dialog says what to do next and links to picking repositories');
  ok(/github\.com\/new\?/.test(await ap.locator('.pf-c-start a', { hasText: 'Create one' }).getAttribute('href')), 'and to creating a repository for someone without one');
  ok(await ap.locator('.pf-c-addrepo').isHidden(), 'without the "missing a repository?" line underneath');
  if (process.env.PF_SHOTS) await ap.locator('.pf-dlg-connect').screenshot({ path: process.env.PF_SHOTS + '/first-visit.png' });
  installed = true; await ap.evaluate(() => window.dispatchEvent(new Event('focus'))); // back from github.com
  await ap.waitForSelector('.pf-c-pick');
  ok(await ap.locator('.pf-c-start').count() === 0, 'coming back to the tab fills in the list by itself');
  const picks = await ap.locator('.pf-c-pick').allInnerTexts();
  ok(picks.length === 2 && /me\/game/.test(picks[0]) && /private · pull requests/.test(picks[0]) && /them\/art-only/.test(picks[1]) && /read only/.test(picks[1]), 'your repositories are listed with what you can do on each: ' + picks.join(' | ').replace(/\n/g, ' '));
  if (process.env.PF_SHOTS) { await ap.locator('.pf-dlg-connect').screenshot({ path: process.env.PF_SHOTS + '/signed-in.png' }); await ap.setViewportSize({ width: 390, height: 844 }); await ap.screenshot({ path: process.env.PF_SHOTS + '/signed-in-phone.png' }); await ap.setViewportSize({ width: 1280, height: 900 }); }
  ok(/github\.com\/apps\/spritewright\/installations\/select_target/.test(await ap.locator('.pf-c-addrepo a').getAttribute('href')), 'a link to install the app on more repositories sits under the list');
  await ap.locator('.pf-c-pick', { hasText: 'me/game' }).click();
  ok(await ap.waitForSelector('.pf-list .pf-loading .pf-spin', { timeout: 2000 }).then(() => true, () => false) && !(await ap.locator('.pf-dlg-connect').evaluate((d) => d.open)), 'picking a repository closes the dialog and the sprite list shows a spinner while it loads');
  ok(/me\/game/.test(await ap.locator('.pf-loading b').innerText()) && /Reading|Listing|setup/.test(await ap.locator('.pf-loading-step').innerText()), 'naming the repository and the current step: ' + await ap.locator('.pf-loading-step').innerText().catch(() => '-'));
  await ap.waitForSelector('.pf-item');
  await ap.locator('.pf-source').click(); await ap.waitForSelector('.pf-brmenu .pf-br-share'); await ap.locator('.pf-br-share').click();
  ok((await ap.evaluate(() => navigator.clipboard.readText())) === 'https://snowu.github.io/spritewright/?repo=me%2Fgame', 'Copy link to this project: a link that opens the repository (the hosted editor, from a local page)');
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
  await ap.goto(hbase + '?auth=https://auth.test'); await ap.waitForFunction(() => document.querySelector('.pf-source').textContent.includes('me/game'));
  ok(!(await ap.locator('.pf-dlg-connect').evaluate((d) => d.open)), 'coming back later: the last repository reopens by itself');
  await ap.locator('.pf-source').click(); await ap.waitForSelector('.pf-brmenu'); await ap.locator('.pf-br-other').click(); await ap.waitForSelector('.pf-c-pick');
  ok(/Signed in as artist/.test(await ap.locator('.pf-dlg-connect .pf-who').innerText()) && logins.length === 1, 'still signed in, no popup');
  ok(refreshes.join() === 'ghr_1' && seen.at(-1).auth === 'Bearer ghu_renewed', 'a token about to expire was renewed through the service before use');
  const renewed = await ap.evaluate(() => JSON.parse(localStorage.getItem('pf:gh')));
  ok(renewed.token === 'ghu_renewed' && renewed.refresh === 'ghr_2' && renewed.login === 'artist', 'the renewed token and the new single-use refresh token are stored');
  ap.removeAllListeners('dialog'); ap.on('dialog', (d) => d.dismiss());
  // 5. switching repositories: the toolbar button names the open one, the list marks it, and pull requests follow the switch
  await ap.locator('.pf-c-pick', { hasText: 'me/game' }).click(); await ap.waitForFunction(() => document.querySelector('.pf-source').textContent.includes('me/game'));
  ok(/me\/game/.test(await ap.locator('.pf-source').innerText()) && /⎇/.test(await ap.locator('.pf-source').innerText()), 'the project button shows the open repository and branch: ' + await ap.locator('.pf-source').innerText());
  await ap.locator('.pf-source').click(); await ap.waitForSelector('.pf-brmenu'); await ap.locator('.pf-br-other').click(); await ap.waitForSelector('.pf-dlg-connect[open] .pf-c-pick.on');
  ok(/open now/.test(await ap.locator('.pf-c-pick.on').innerText()) && /me\/game/.test(await ap.locator('.pf-c-pick.on').innerText()), 'the list marks the repository that is open now');
  ok(await ap.evaluate(() => { const f = document.querySelector('.pf-dlg-connect .pf-form'); return f.querySelector('.pf-gh-box').getBoundingClientRect().top < f.querySelector('.pf-c-upload').getBoundingClientRect().top; }), 'when signed in, your repositories come first in the dialog');
  await ap.locator('.pf-c-pick', { hasText: 'them/art-only' }).click(); await ap.waitForFunction(() => document.querySelector('.pf-source').textContent.includes('them/art-only'));
  await ap.waitForSelector('.pf-dlg-connect', { state: 'hidden' }); await ap.waitForFunction(() => document.querySelectorAll('.pf-item').length === 2);
  { const hid = await ap.locator('.pf-dlg-connect').isHidden(), items = (await ap.locator('.pf-item').allInnerTexts()).join(); ok(hid && items.includes('b.png'), 'one click switches to the other repository and lists its sprites: ' + hid + ' ' + items.replace(/\n/g, ' ')); }
  await ap.waitForFunction(() => document.getElementById('app').__pf.current); await ap.waitForTimeout(200); await ap.keyboard.press('b'); await ap.locator('.pf-view').click();
  await ap.locator('.pf-prbtn').click(); await ap.waitForSelector('.pf-dlg-pr[open]');
  ok((await ap.locator('.pf-pr-repo').inputValue()) === 'them/art-only' && (await ap.locator('.pf-pr-base').inputValue()) === 'master', 'after switching, the pull request goes to the new repository, not the old one: ' + await ap.locator('.pf-pr-repo').inputValue() + ' @ ' + await ap.locator('.pf-pr-base').inputValue());
  await ap.locator('.pf-dlg-pr button[value=cancel]').click();
  ap.removeAllListeners('dialog'); ap.on('dialog', (d) => d.accept()); await ap.locator('.pf-source').click(); await ap.waitForSelector('.pf-brmenu'); await ap.locator('.pf-br-other').click(); await ap.waitForSelector('.pf-dlg-connect[open]');
  // 6. sign out, from the sidebar (always visible) and from the dialog
  await ap.locator('.pf-dlg-connect button[value=cancel]').click();
  ok(/Signed in as artist/.test(await ap.locator('.pf-acct .pf-who').innerText()) && await ap.locator('.pf-acct .pf-signout').isVisible(), 'the header shows who is signed in, with a Sign out button, next to the title');
  await ap.locator('.pf-acct .pf-signout').click();
  ok(await ap.evaluate(() => localStorage.getItem('pf:gh')) === null && await ap.locator('.pf-acct .pf-signin').isVisible() && /Signed out/.test(await ap.locator('.pf-status').innerText()), 'Sign out in the header signs out and offers Sign in again');
  await ap.locator('.pf-acct .pf-signin').click(); await ap.waitForFunction(() => /Signed in as artist/.test(document.querySelector('.pf-acct .pf-who').textContent));
  ok(await ap.locator('.pf-acct .pf-signout').isVisible(), 'Sign in works from the header too');
  ok(await ap.evaluate(() => { const a = document.querySelector('.pf-acct'), t = document.querySelector('header b'); return a.closest('header') && a.getBoundingClientRect().left > t.getBoundingClientRect().right && a.getBoundingClientRect().left < 400 && !document.querySelector('.pf-side .pf-auth-row'); }), 'the account sits in the page header right after the title, not in the sidebar');
  await ap.locator('.pf-source').click(); await ap.waitForSelector('.pf-brmenu'); await ap.locator('.pf-br-other').click(); await ap.waitForSelector('.pf-dlg-connect[open]');
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

section('families and animations: grouped list, frame strip, flipbook, onion skin across files');
{
  const r2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-fam-'));
  for (const d of ['chars', 'tiles', 'docs/previews']) fs.mkdirSync(path.join(r2, d), { recursive: true });
  const dot = (x, c = 'r') => fromRows(['....', '....', '....', '....'].map((row, y) => (y === 1 ? row.slice(0, x) + c + row.slice(x + 1) : row)), { r: [255, 0, 0], b: [0, 0, 255] });
  [0, 1, 2].forEach((i) => fs.writeFileSync(path.join(r2, `chars/hero_${i}.png`), dot(i).png));
  fs.writeFileSync(path.join(r2, 'chars/hero_atk.png'), dot(3, 'b').png);
  fs.writeFileSync(path.join(r2, 'chars/bat.png'), dot(0, 'b').png);
  fs.writeFileSync(path.join(r2, 'tiles/floor.png'), dot(0).png); fs.writeFileSync(path.join(r2, 'tiles/floor_moss.png'), dot(1).png);
  fs.writeFileSync(path.join(r2, 'docs/previews/shot.png'), dot(0).png);
  const s2 = createServer({ root: r2, port: 0 }), b2 = await s2.listen();
  const fp = await ctx.newPage(); const ferr2 = []; fp.on('pageerror', (e) => ferr2.push(e.message));
  await fp.goto(b2 + '?auth=off'); await fp.waitForSelector('.pf-item');
  const dirs = await fp.locator('.pf-dir .pf-dirname').allInnerTexts();
  ok(dirs.join() === 'chars,tiles', 'the list is grouped by folder, and docs/previews is left out by default: ' + dirs.join(','));
  { const t = fp.locator('.pf-hidden-toggle'); ok(/Show 1 image from docs/.test(await t.innerText()), 'the list says what the default left out: ' + await t.innerText());
    await t.click(); ok((await fp.locator('.pf-dir .pf-dirname').allInnerTexts()).includes('docs/previews') && /Hide 1 image/.test(await fp.locator('.pf-hidden-toggle').innerText()), 'one click shows them as a normal folder');
    await fp.locator('.pf-hidden-toggle').click(); ok(!(await fp.locator('.pf-dir .pf-dirname').allInnerTexts()).includes('docs/previews'), 'and one click hides them again'); }
  const cells = await fp.locator('.pf-cell .n').allInnerTexts();
  ok(cells.map((t) => t.split('\n')[0]).join() === 'bat.png,hero,floor', 'one tile per family (hero_0..2 + hero_atk → "hero", floor + floor_moss → "floor"): ' + cells.map((t) => t.split('\n')[0]).join(','));
  ok((await fp.locator('.pf-cell', { hasText: 'hero' }).locator('.pf-badge.anim').innerText()) === '▶4' && (await fp.locator('.pf-cell', { hasText: 'floor' }).locator('.pf-badge').innerText()) === '2', 'badges: ▶ for animations, a count for variant families');
  await fp.locator('.pf-dir', { hasText: 'tiles' }).click();
  ok((await fp.locator('.pf-cell').count()) === 2 && /▸/.test(await fp.locator('.pf-dir', { hasText: 'tiles' }).innerText()), 'a folder folds');
  await fp.reload(); await fp.waitForSelector('.pf-item', { state: 'attached' });
  ok((await fp.locator('.pf-cell').count()) === 2, 'and stays folded after a reload');
  await fp.locator('.pf-dir', { hasText: 'tiles' }).click(); ok((await fp.locator('.pf-cell').count()) === 3, 'click again to unfold');
  await fp.locator('.pf-dir', { hasText: 'chars' }).click();
  ok((await fp.locator('.pf-cell').count()) === 1 && /▸/.test(await fp.locator('.pf-dir', { hasText: 'chars' }).innerText()), 'the folder with the open sprite folds too');
  await fp.locator('.pf-unfold-all').click(); ok((await fp.locator('.pf-cell').count()) === 3, 'unfold all brings every folder back');
  await fp.locator('.pf-fold-all').click(); ok((await fp.locator('.pf-cell').count()) === 0, 'fold all folds every folder, including the open sprite’s');
  await fp.locator('.pf-q').fill('hero_0'); await fp.locator('.pf-item').first().click(); await fp.waitForTimeout(250); await fp.locator('.pf-q').fill('');
  ok((await fp.evaluate(() => document.getElementById('app').__pf.current.path)) === 'chars/hero_0.png' && (await fp.locator('.pf-cell').count()) === 2, 'opening a sprite reveals its folder and leaves the other folded');
  await fp.locator('.pf-unfold-all').click(); ok((await fp.locator('.pf-cell').count()) === 3, 'and unfold all restores the rest');
  await fp.locator('.pf-dir', { hasText: 'chars' }).click();
  ok((await fp.locator('.pf-openrow .n').innerText()) === 'hero_0.png', 'a folded folder still shows the sprite being edited');
  await fp.locator('.pf-openrow').click(); ok((await fp.locator('.pf-cell').count()) === 3, 'clicking it unfolds the folder');
  await fp.locator('.pf-cell', { hasText: 'bat.png' }).click(); await fp.waitForTimeout(250);
  ok((await fp.locator('.pf-fam-kind').innerText()) === 'single sprite', 'a lone sprite shows its one-member family');
  await fp.locator('.pf-fam-add').click(); await fp.waitForTimeout(400);
  ok((await fp.evaluate(() => document.getElementById('app').__pf.current.path)) === 'chars/bat_1.png', '+ frame on a lone sprite starts its numbering');
  await fp.locator('.pf-new').click(); await fp.waitForSelector('.pf-dlg-new[open]');
  ok((await fp.locator('.pf-nn').inputValue()) === 'new_sprite.png', 'New suggests a name that does not collide');
  await fp.locator('.pf-new-ok').click(); await fp.waitForTimeout(400);
  ok((await fp.evaluate(() => document.getElementById('app').__pf.current.path)) === 'new_sprite.png', 'and creates it');
  await fp.locator('.pf-new').click(); await fp.waitForSelector('.pf-dlg-new[open]');
  ok((await fp.locator('.pf-nn').inputValue()) === 'new_sprite1.png', 'then the next one after that');
  await fp.locator('.pf-dlg-new button[value=cancel]').click();
  // family strip
  await fp.locator('.pf-cell', { hasText: 'hero' }).click(); await fp.waitForTimeout(250);
  ok((await fp.evaluate(() => document.getElementById('app').__pf.current.path)) === 'chars/hero_0.png', 'clicking a family opens its first frame');
  await until(async () => (await fp.locator('.pf-fam-m').count()) === 4);
  ok((await fp.locator('.pf-fam-m span').allInnerTexts()).join() === '0,1,2,atk' && /animation · 4 frames/.test(await fp.locator('.pf-fam-kind').innerText()), 'the preview shows the family strip in order: 0,1,2,atk');
  const stripOk = await until(async () => (await fp.evaluate(() => [...document.querySelectorAll('.pf-fam-m canvas')].every((c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 4) if (d[i]) return true; return false; }))));
  ok(stripOk, 'every frame in the strip has its picture, loaded without opening it');
  await fp.keyboard.press('.'); await fp.waitForTimeout(200);
  ok((await fp.evaluate(() => document.getElementById('app').__pf.current.path)) === 'chars/hero_1.png' && (await fp.locator('.pf-fam-m.on span').innerText()) === '1', '. steps to the next frame');
  await fp.keyboard.press(','); await fp.keyboard.press(','); await fp.waitForTimeout(200);
  ok((await fp.evaluate(() => document.getElementById('app').__pf.current.path)) === 'chars/hero_atk.png', ', steps back and wraps around');
  await fp.locator('.pf-fam-m', { hasText: '2' }).click(); await fp.waitForTimeout(200);
  ok((await fp.evaluate(() => document.getElementById('app').__pf.current.path)) === 'chars/hero_2.png', 'clicking a frame in the strip opens it');
  ok((await fp.locator('.pf-cell', { hasText: 'hero' }).getAttribute('data-path')) === 'chars/hero_2.png', 'the family tile follows the open frame');
  // flipbook: the animated preview walks through the files
  const redX = () => fp.evaluate(() => { const c = document.querySelector('.pf-p2'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, s = c.width / 4; for (let x = 0; x < 4; x++) { const i = ((1 * s + 1) * c.width + x * s + 1) * 4; if (d[i + 3]) return d[i] > 200 ? 'r' + x : 'b' + x; } return '-'; });
  await fp.locator('.pf-play').click(); const seen = new Set(); for (let i = 0; i < 30; i++) { seen.add(await redX()); await fp.waitForTimeout(40); }
  await fp.locator('.pf-play').click();
  ok(['r0', 'r1', 'r2', 'b3'].every((x) => seen.has(x)), 'Play flips through all four images of the family: ' + [...seen].join(','));
  // onion skin across files: on hero_1, hero_0 shows faintly underneath
  await fp.keyboard.press(','); await fp.waitForTimeout(150); await fp.keyboard.press('n'); await fp.waitForTimeout(150);
  const at = async (x, y) => fp.evaluate(([x, y]) => { const S = document.getElementById('app').__pf.state, c = document.querySelector('.pf-view'), d = c.getContext('2d').getImageData(Math.round(S.ox + (x + 0.5) * S.zoom), Math.round(S.oy + (y + 0.5) * S.zoom), 1, 1).data; return [...d]; }, [x, y]);
  const ghost = await at(0, 1), own = await at(1, 1), empty = await at(3, 3);
  ok((await fp.evaluate(() => document.getElementById('app').__pf.current.path)) === 'chars/hero_1.png' && ghost[0] > empty[0] + 25 && ghost[0] < own[0] - 60, `onion skin: the previous file's pixel shows faintly (${ghost.slice(0, 3)} between ${empty.slice(0, 3)} and ${own.slice(0, 3)})`);
  await fp.keyboard.press('n');
  // filtering flattens the list
  await fp.locator('.pf-q').fill('hero_'); ok((await fp.locator('.pf-item').count()) === 4 && (await fp.locator('.pf-dir').count()) === 0, 'typing a filter shows a flat list of matching files');
  ok(await fp.evaluate(() => [...document.querySelectorAll('.pf-list .pf-badge')].every((b) => { const i = b.closest('.pf-item').getBoundingClientRect(), r = b.getBoundingClientRect(); return r.top >= i.top - 1 && r.bottom <= i.bottom + 1 && r.right <= i.right + 1; })), 'family badges stay inside their row in the flat list');
  await fp.locator('.pf-q').fill('');
  // animation tools: new frame, reorder, GIF
  await fp.locator('.pf-cell', { hasText: 'hero' }).click(); await fp.waitForTimeout(200);
  await fp.locator('.pf-fam-m', { hasText: '2' }).click(); await fp.waitForTimeout(200);
  await fp.locator('.pf-fam-add').click(); await fp.waitForTimeout(400);
  ok((await fp.evaluate(() => document.getElementById('app').__pf.current.path)) === 'chars/hero_3.png' && (await fp.locator('.pf-fam-m span').allInnerTexts()).join() === '0,1,2,3,atk', '+ frame adds hero_3.png, a copy of the frame you were on, and opens it');
  ok((await fp.locator('.pf-cell', { hasText: 'hero' }).locator('.pf-badge').innerText()) === '▶5', 'the family tile now counts 5');
  await fp.keyboard.press('Control+s'); await fp.waitForTimeout(400);
  ok(fs.existsSync(path.join(r2, 'chars/hero_3.png')) && decodePng(fs.readFileSync(path.join(r2, 'chars/hero_3.png'))).rgba[(1 * 4 + 2) * 4] === 255, 'Save writes the new frame into the project folder');
  const h0 = await fp.evaluate(async () => { const a = document.getElementById('app').__pf; await a.open('chars/hero_0.png'); return [...a.current.px]; });
  await fp.evaluate(() => document.getElementById('app').__pf.open('chars/hero_1.png')); await fp.waitForTimeout(200);
  const h1 = await fp.evaluate(() => [...document.getElementById('app').__pf.current.px]);
  ok(await fp.locator('.pf-fam-left').isEnabled(), '◀ is available on a middle frame');
  await fp.locator('.pf-fam-left').click(); await fp.waitForTimeout(300);
  const after0 = await fp.evaluate(() => { const a = document.getElementById('app').__pf; return { path: a.current.path, px: [...a.current.px], other: [...a.docs.get('chars/hero_1.png').px] }; });
  ok(after0.path === 'chars/hero_0.png' && JSON.stringify(after0.px) === JSON.stringify(h1) && JSON.stringify(after0.other) === JSON.stringify(h0), '◀ moves the frame earlier (swaps it with the one before) and follows it');
  ok(await fp.locator('.pf-fam-left').isDisabled(), '◀ is disabled on the first frame');
  await fp.locator('.pf-fam-right').click(); await fp.waitForTimeout(300);
  ok(JSON.stringify(await fp.evaluate(() => [...document.getElementById('app').__pf.docs.get('chars/hero_0.png').px])) === JSON.stringify(h0), '▶ moves it back');
  fp.once('dialog', (dlg) => dlg.accept('3'));
  const [gifDl] = await Promise.all([fp.waitForEvent('download'), fp.locator('.pf-gif').click()]);
  const gif = fs.readFileSync(await gifDl.path());
  const gifFrames = (() => { let o = 13 + (gif[10] & 0x80 ? 3 << ((gif[10] & 7) + 1) : 0), n = 0; while (gif[o] !== 0x3b) { if (gif[o] === 0x21) { o += 2; while (gif[o]) o += gif[o] + 1; o++; continue; } n++; o += 10; if (gif[o - 1] & 0x80) o += 3 << ((gif[o - 1] & 7) + 1); o++; while (gif[o]) o += gif[o] + 1; o++; } return n; })();
  ok(gifDl.suggestedFilename() === 'hero@3x.gif' && gif.toString('latin1', 0, 6) === 'GIF89a' && gif.readUInt16LE(6) === 12 && gifFrames === 5, `GIF… downloads the family as an animation: ${gifDl.suggestedFilename()}, ${gif.readUInt16LE(6)}×${gif.readUInt16LE(8)}, ${gifFrames} frames`);
  const shown = await fp.evaluate(async (b64) => { const img = new Image(); img.src = 'data:image/gif;base64,' + b64; await img.decode(); const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; const g = c.getContext('2d'); g.drawImage(img, 0, 0); return { w: img.naturalWidth, red: [...g.getImageData(1, 4, 1, 1).data], clear: g.getImageData(10, 10, 1, 1).data[3] }; }, gif.toString('base64'));
  ok(shown.w === 12 && shown.red[0] === 255 && shown.red[3] === 255 && shown.clear === 0, 'and the browser decodes it: red pixel where hero_0 has it, transparency kept');
  // context: the sprite at game scale next to its folder neighbours, live
  await fp.locator('.pf-cell', { hasText: 'bat' }).click(); await fp.waitForTimeout(200);
  await fp.keyboard.press('v'); await fp.waitForTimeout(300);
  const has = (rgb) => fp.evaluate((rgb) => { const c = document.querySelector('.pf-ctx-cv'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 0; i < d.length; i += 4) if (d[i] === rgb[0] && d[i + 1] === rgb[1] && d[i + 2] === rgb[2]) return true; return false; }, rgb);
  ok(await fp.locator('.pf-ctx').isVisible() && /2× · 1 neighbour from chars/.test(await fp.locator('.pf-ctx-note').innerText()), 'V shows the sprite in context with its neighbour from the same folder: ' + await fp.locator('.pf-ctx-note').innerText());
  ok(await has([0, 0, 255]) && await has([255, 0, 0]), 'the strip draws the sprite (blue bat) and its neighbour (red hero frame)');
  await fp.locator('.pf-chex').fill('#12ab34'); await fp.locator('.pf-chex').press('Tab'); await fp.keyboard.press('b');
  { const b = await fp.locator('.pf-view').boundingBox(), st = await fp.evaluate(() => { const S = document.getElementById('app').__pf.state, v = document.querySelector('.pf-view'); return { z: S.zoom, ox: S.ox, oy: S.oy, k: v.width / v.getBoundingClientRect().width }; }); await fp.mouse.click(b.x + (st.ox + 2.5 * st.z) / st.k, b.y + (st.oy + 2.5 * st.z) / st.k); }
  ok(await has([0x12, 0xab, 0x34]), 'an edit shows up in the context strip straight away');
  await fp.locator('.pf-ctx-scale button[data-scale="4"]').click(); ok(/^4×/.test(await fp.locator('.pf-ctx-note').innerText()), 'the scale buttons change the game scale');
  await fp.keyboard.press('Control+z');
  await fp.reload(); await fp.waitForSelector('.pf-item', { state: 'attached' }); ok(await fp.locator('.pf-ctx').isVisible(), 'the context strip stays on after a reload');
  await fp.keyboard.press('v'); ok(await fp.locator('.pf-ctx').isHidden(), 'V hides it');
  // the explorer does not blink while you draw and save: the open sprite's thumbnail keeps its canvas and is never blank
  await fp.locator('.pf-cell', { hasText: 'bat' }).click(); await fp.waitForTimeout(300);
  await fp.evaluate(() => {
    const row = () => document.querySelector('.pf-item.on canvas'), w = (window.__blink = { cv: row(), swapped: 0, blank: 0, frames: 0, markers: [] });
    const tick = () => { const c = row(); if (!w.on) return; w.frames++; if (c !== w.cv) w.swapped++; if (c) { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let on = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) on++; if (!on) w.blank++; } const m = document.querySelector('.pf-item.on .dot'); const mk = m ? m.className : 'gone'; if (w.markers.at(-1) !== mk) w.markers.push(mk); w.dot = w.dot || m; if (m && m !== w.dot) w.dotSwapped = true; requestAnimationFrame(tick); };
    w.on = true; requestAnimationFrame(tick);
  });
  { const b = await fp.locator('.pf-view').boundingBox(), st = await fp.evaluate(() => { const S = document.getElementById('app').__pf.state, v = document.querySelector('.pf-view'); return { z: S.zoom, ox: S.ox, oy: S.oy, k: v.width / v.getBoundingClientRect().width }; });
    await fp.keyboard.press('b'); await fp.mouse.click(b.x + (st.ox + 3.5 * st.z) / st.k, b.y + (st.oy + 3.5 * st.z) / st.k); }
  await fp.waitForTimeout(500); await fp.keyboard.press('Control+s'); await fp.waitForTimeout(600);
  const blink = await fp.evaluate(() => { const w = window.__blink; w.on = false; return { swapped: w.swapped, blank: w.blank, frames: w.frames, markers: w.markers, dotSwapped: !!w.dotSwapped }; });
  ok(blink.frames > 10 && blink.swapped === 0 && blink.blank === 0 && !blink.dotSwapped, `drawing then saving never swaps or blanks the open sprite's thumbnail, and only its marker changes (${blink.frames} frames, markers: ${blink.markers.join(' → ')})`);
  ok(blink.markers.join() === 'dot base,dot,dot base', 'the marker goes changed → not saved → saved, on the same element: ' + blink.markers.join(' → '));
  // context groups from the config: the sprites it is seen with, on the group's background; and the project's alpha rule
  fs.writeFileSync(path.join(r2, 'groups.json'), JSON.stringify({ 'Floor-mates': { background: '#203040', sprites: ['tiles/floor_moss.png', 'chars/bat.png'] }, Heroes: ['chars/hero_0.png'] }));
  fs.writeFileSync(path.join(r2, 'spritewright.config.json'), JSON.stringify({ groups: 'groups.json', alpha: { clear: 15, solid: 245, keep: [250] } }));
  await fp.reload(); await fp.waitForSelector('.pf-item', { state: 'attached' });
  await fp.locator('.pf-cell', { hasText: 'bat' }).click(); await fp.waitForTimeout(200);
  await fp.keyboard.press('v'); await fp.waitForTimeout(300);
  ok((await fp.locator('.pf-ctx-group option').allInnerTexts()).join() === 'Floor-mates,Same folder' && await fp.locator('.pf-ctx-group').inputValue() === 'Floor-mates', 'Context opens on the config group that holds the sprite, and offers the folder too: ' + (await fp.locator('.pf-ctx-group option').allInnerTexts()).join(' | '));
  ok(/1 neighbour from Floor-mates/.test(await fp.locator('.pf-ctx-note').innerText()) && await has([0x20, 0x30, 0x40]) && await has([255, 0, 0]), 'its neighbours come from the group, drawn on the group background: ' + await fp.locator('.pf-ctx-note').innerText());
  { // clicking a neighbour in the strip opens it
    const at = await fp.evaluate(() => { const c = document.querySelector('.pf-ctx-cv'), r = c.getBoundingClientRect(), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4) if (d[i] === 255 && d[i + 1] === 0 && d[i + 2] === 0) { const x = (i / 4) % c.width, y = Math.floor(i / 4 / c.width); return { x: r.left + x * r.width / c.width, y: r.top + y * r.height / c.height }; } return null; });
    await fp.mouse.click(at.x, at.y); await fp.waitForTimeout(300);
    ok(await fp.evaluate(() => document.getElementById('app').__pf.current.path) === 'tiles/floor_moss.png', 'clicking a neighbour in the context strip opens it on the canvas');
    await fp.locator('.pf-cell', { hasText: 'bat' }).click(); await fp.waitForTimeout(200);
  }
  await fp.locator('.pf-ctx-group').selectOption(''); await fp.waitForTimeout(150);
  ok(/neighbour from chars/.test(await fp.locator('.pf-ctx-note').innerText()), 'Same folder goes back to the folder neighbours');
  await fp.reload(); await fp.waitForSelector('.pf-item', { state: 'attached' }); await fp.locator('.pf-cell', { hasText: 'bat' }).click(); await fp.waitForTimeout(300);
  ok(await fp.locator('.pf-ctx-group').inputValue() === '', 'the choice is remembered across a reload');
  await fp.locator('.pf-ctx-group').selectOption('Floor-mates'); await fp.waitForTimeout(150);
  await fp.locator('.pf-cell', { hasText: 'hero' }).click(); await fp.waitForTimeout(300);
  ok(await fp.locator('.pf-ctx-group').inputValue() === 'Heroes', 'a frame of a family uses the group its family is in (hero_1 → Heroes)');
  await fp.keyboard.press('v');
  await fp.locator('.pf-cell', { hasText: 'bat' }).click(); await fp.waitForTimeout(200);
  await fp.evaluate(async () => { const a = document.getElementById('app').__pf, d = a.current; d.snapshot(); d.px[5] = ((252 << 24) | 0x00ff00) >>> 0; d.px[6] = ((3 << 24) | 0x00ff00) >>> 0; await a.save(); });
  { const out = decodePng(fs.readFileSync(path.join(r2, 'chars/bat.png'))).rgba;
    ok(out[5 * 4 + 3] === 255 && out[5 * 4 + 1] === 255 && out[6 * 4 + 3] === 0, 'Save snaps stray alpha to the project rule: 252 → solid, 3 → clear'); }
  ok(/saved chars\/bat\.png · 2 stray-alpha pixels snapped/.test(await fp.evaluate(() => document.getElementById('app').__pf.state.notice)), 'and says so: ' + await fp.evaluate(() => document.getElementById('app').__pf.state.notice));
  await fp.keyboard.press('Control+z'); ok(await fp.evaluate(() => document.getElementById('app').__pf.current.px[5] >>> 24) === 252, 'undo brings the stray value back');
  // fullscreen on a phone held sideways: canvas and tools fill the screen, menus slide in from the edges
  ok(await fp.locator('.pf-fs-go').isHidden(), 'no fullscreen button on a desktop with a mouse');
  { const vw = async () => (await fp.locator('.pf-stage').boundingBox()).width, w0 = await vw();
    await fp.locator('.pf-fs-hl').click(); await fp.waitForTimeout(200); const w1 = await vw();
    ok(w1 > w0 + 150 && await fp.locator('.pf-side').evaluate((e) => getComputedStyle(e).visibility === 'hidden') && (await fp.locator('.pf-fs-hl').innerText()) === '›', `on a wide screen ‹ folds the sprite list away and the canvas takes its room (${Math.round(w0)} → ${Math.round(w1)}px)`);
    await fp.locator('.pf-fs-hr').click(); await fp.waitForTimeout(200);
    ok(await vw() > w1 + 150 && (await fp.locator('.pf-fs-hr').innerText()) === '‹', '› folds the colour panel away too');
    await fp.reload(); await fp.waitForSelector('.pf-item', { state: 'attached' }); await fp.waitForTimeout(200);
    ok(await fp.evaluate(() => document.querySelector('.pf').matches('.pf-lhide.pf-rhide')), 'the folded panels stay folded after a reload');
    await fp.locator('.pf-fs-hl').click(); await fp.locator('.pf-fs-hr').click(); await fp.waitForTimeout(200);
    ok(Math.abs(await vw() - w0) < 2 && await fp.locator('.pf-side').isVisible(), 'and come back'); }
  { const mctx = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true }), mp = await mctx.newPage(), merr = []; mp.on('pageerror', (e) => merr.push(e.message));
    await mp.goto(b2); await mp.waitForSelector('.pf-item'); await mp.locator('.pf-cell', { hasText: 'bat' }).tap(); await mp.waitForTimeout(300);
    await mp.locator('.pf-fs-go').tap(); await mp.waitForTimeout(500);
    const box = (sel) => mp.locator(sel).boundingBox();
    const st = await box('.pf-stage'), rail = await box('.pf-rail'), side = await box('.pf-side'), right = await box('.pf-right');
    ok(await mp.evaluate(() => document.querySelector('.pf').classList.contains('pf-fs')) && st.height >= 380 && st.x + st.width >= 840 && rail.height >= 380, `the canvas and tool rail fill the screen (stage ${Math.round(st.width)}×${Math.round(st.height)}, rail ${Math.round(rail.width)}px)`);
    ok(side.x + side.width <= 0 && right.x >= 844 && await mp.evaluate(() => document.documentElement.scrollWidth) <= 844, 'menus are off screen, nothing scrolls sideways');
    const bot = await mp.evaluate(() => { const r = document.querySelector('.pf-rail').getBoundingClientRect(); return Math.max(...[...document.querySelectorAll('.pf-rail button')].map((b) => b.getBoundingClientRect().bottom)) <= r.bottom + 1; });
    ok(bot, 'every tool fits in the rail without scrolling');
    const v = await mp.evaluate(() => { const S = document.getElementById('app').__pf.state, c = document.querySelector('.pf-view'), r = c.getBoundingClientRect(); return { x: r.left + (S.ox + 2.5 * S.zoom) * r.width / c.width, y: r.top + (S.oy + 2.5 * S.zoom) * r.height / c.height }; });
    await mp.touchscreen.tap(v.x, v.y); await mp.waitForTimeout(200);
    ok(await mp.evaluate(() => document.getElementById('app').__pf.current.changed), 'tapping the canvas draws');
    await mp.locator('.pf-fs-undo').tap(); await mp.waitForTimeout(200);
    ok(!(await mp.evaluate(() => document.getElementById('app').__pf.current.changed)), 'the floating undo undoes it');
    await mp.locator('.pf-fs-hl').tap(); await mp.waitForTimeout(400);
    ok((await box('.pf-side')).x >= 0 && (await mp.locator('.pf-fs-hl').innerText()) === '‹', '› slides the sprite list in from the left (and turns into ‹)');
    await mp.locator('.pf-cell', { hasText: 'hero' }).tap(); await mp.waitForTimeout(500);
    ok(/hero/.test(await mp.evaluate(() => document.getElementById('app').__pf.current.path)) && (await box('.pf-side')).x + (await box('.pf-side')).width <= 0, 'picking a sprite opens it and closes the list');
    await mp.locator('.pf-fs-hr').tap(); await mp.waitForTimeout(400);
    ok((await box('.pf-right')).x + (await box('.pf-right')).width <= 845 && await mp.locator('.pf-right .pf-bar .pf-save').isVisible() && await mp.locator('.pf-right .pf-opts').count() === 1, '‹ slides in the colours with the toolbar and tool options on top (Save is there)');
    await mp.locator('.pf-fs-scrim').tap({ position: { x: 150, y: 200 } }); await mp.waitForTimeout(400);
    ok((await box('.pf-right')).x >= 844, 'tapping the dimmed canvas closes it');
    await mp.locator('.pf-fs-exit').tap(); await mp.waitForTimeout(400);
    ok(await mp.evaluate(() => { const m = document.querySelector('.pf-main'); return !document.querySelector('.pf').classList.contains('pf-fs') && m.firstElementChild.classList.contains('pf-bar') && m.children[1].classList.contains('pf-opts'); }), 'leaving fullscreen puts the toolbar and options back where they were');
    ok(merr.length === 0, 'no page errors on the phone ' + merr.join('|'));
    await mctx.close(); }
  ok(ferr2.length === 0, 'no page errors ' + ferr2.join('|'));
  await fp.close(); await s2.close();
}

section('project folder: unsaved edits survive a reload; canvas size for a whole family');
{
  const r3 = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-keep-')); fs.mkdirSync(path.join(r3, 'chars'));
  const dot = (x) => fromRows(['....', '....', '....', '....'].map((row, y) => (y === 1 ? row.slice(0, x) + 'r' + row.slice(x + 1) : row)), { r: [255, 0, 0] });
  [0, 1].forEach((i) => fs.writeFileSync(path.join(r3, `chars/hero_${i}.png`), dot(i).png));
  const s3 = createServer({ root: r3, port: 0 }), b3 = await s3.listen();
  const kp = await ctx.newPage(); const kerr = []; kp.on('pageerror', (e) => kerr.push(e.message));
  await kp.goto(b3 + '?auth=off'); await kp.waitForSelector('.pf-item'); await kp.evaluate(() => document.getElementById('app').__pf.open('chars/hero_0.png')); await kp.waitForTimeout(200);
  const kpos = async (x, y) => { const b = await kp.locator('.pf-view').boundingBox(), st = await kp.evaluate(() => { const S = document.getElementById('app').__pf.state, v = document.querySelector('.pf-view'); return { z: S.zoom, ox: S.ox, oy: S.oy, k: v.width / v.getBoundingClientRect().width }; }); return { x: b.x + (st.ox + (x + 0.5) * st.z) / st.k, y: b.y + (st.oy + (y + 0.5) * st.z) / st.k }; };
  await kp.locator('.pf-chex').fill('#0000ff'); await kp.locator('.pf-chex').press('Tab'); await kp.keyboard.press('b');
  { const p = await kpos(3, 3); await kp.mouse.click(p.x, p.y); }
  await kp.waitForFunction(() => /unsaved \(kept in this browser meanwhile\)/.test(document.querySelector('.pf-s-name').textContent));
  ok((await kp.locator('.pf-save').innerText()) === 'Save', 'with a project folder Save still means "write the file"; until then the edit is kept in this browser');
  await kp.reload(); await kp.waitForFunction(() => { const a = document.getElementById('app').__pf; return a && a.current && a.current.path === 'chars/hero_0.png'; });
  { const st = await kp.evaluate(() => { const d = document.getElementById('app').__pf.current; return { px: d.px[3 * 4 + 3], unsaved: d.unsaved }; });
    ok(st.px === 0xffff0000 >>> 0 && st.unsaved && /unsaved/.test(await kp.locator('.pf-s-name').innerText()), 'after a reload the unsaved edit is back, still marked unsaved');
    ok(decodePng(fs.readFileSync(path.join(r3, 'chars/hero_0.png'))).rgba[(3 * 4 + 3) * 4 + 3] === 0, 'and the file on disk is untouched until Save'); }
  await kp.keyboard.press('Control+s'); await until(() => decodePng(fs.readFileSync(path.join(r3, 'chars/hero_0.png'))).rgba[(3 * 4 + 3) * 4 + 2] === 255); await kp.waitForTimeout(500);
  ok(await kp.evaluate(async () => (await window.Spritewright.core.browserDrafts().list('server:' + location.origin + location.pathname)).length) === 0, 'Ctrl+S writes the file and drops the browser copy');
  // canvas size for every frame
  await kp.locator('.pf-resize').click();
  ok(await kp.locator('.pf-sz-famrow').isVisible() && /all 2 frames of "hero"/.test(await kp.locator('.pf-sz-famtext').innerText()), 'for an animation the dialog offers to resize all its frames: ' + await kp.locator('.pf-sz-famtext').innerText());
  await kp.locator('.pf-sz-anchor [data-a="c"]').click(); await kp.locator('.pf-sz-w').fill('6'); await kp.locator('.pf-sz-h').fill('6'); await kp.locator('.pf-sz-ok').click(); await kp.waitForTimeout(300);
  { const ds = await kp.evaluate(() => { const a = document.getElementById('app').__pf; return ['chars/hero_0.png', 'chars/hero_1.png'].map((p) => { const d = a.docs.get(p); return { w: d.w, h: d.h, red: d.px.findIndex((v) => v === 0xff0000ff) }; }); });
    ok(ds.every((d) => d.w === 6 && d.h === 6) && ds[0].red === 2 * 6 + 1 && ds[1].red === 2 * 6 + 2, 'both frames are 6×6 now, centred: ' + JSON.stringify(ds)); }
  await kp.keyboard.press('Control+z'); ok(await kp.evaluate(() => document.getElementById('app').__pf.current.w) === 4, 'undo works per image');
  ok(kerr.length === 0, 'no page errors ' + kerr.join('|'));
  await kp.close(); await s3.close();
}

section('background behind transparent pixels');
{
  const r3 = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-bg-'));
  fs.mkdirSync(path.join(r3, 'art'));
  fs.writeFileSync(path.join(r3, 'art/dot.png'), fromRows(['....', '.r..', '....', '....'], { r: [255, 0, 0] }).png);
  fs.writeFileSync(path.join(r3, 'spritewright.config.json'), JSON.stringify({ background: '#20304a' }));
  const s3 = createServer({ root: r3, port: 0 }), b3 = await s3.listen();
  const bp = await ctx.newPage(); const berr = []; bp.on('pageerror', (e) => berr.push(e.message));
  await bp.goto(b3 + '?auth=off'); await bp.evaluate(() => localStorage.removeItem('pf:bg')); await bp.reload(); await bp.waitForSelector('.pf-item'); await bp.waitForTimeout(300);
  const cellRGB = (x, y) => bp.evaluate(([x, y]) => { const S = document.getElementById('app').__pf.state, c = document.querySelector('.pf-view'), d = c.getContext('2d').getImageData(Math.round(S.ox + (x + 0.5) * S.zoom), Math.round(S.oy + (y + 0.5) * S.zoom), 1, 1).data; return '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join(''); }, [x, y]);
  ok((await cellRGB(3, 3)) === '#20304a', 'a project background from spritewright.config.json is used by default: ' + await cellRGB(3, 3));
  ok((await cellRGB(1, 1)) === '#ff0000', 'the art draws on top of it');
  await bp.locator('.pf-bg').click();
  const items = await bp.locator('.pf-bgmenu [data-bg]').allInnerTexts();
  ok(items.length === 6 && /Project background\s+#20304a/.test(items[0]) && (await bp.locator('.pf-bgmenu [data-bg].on').getAttribute('data-bg')) === 'project', 'the Background menu lists project, dark/light checker, black, white, custom, and marks the current one');
  await bp.locator('.pf-bgmenu [data-bg=light]').click();
  ok(!(await bp.locator('.pf-bgmenu').count()) && ['#d6d6de', '#f2f2f6'].includes(await cellRGB(3, 3)), 'picking Light checker closes the menu and lightens the transparent area: ' + await cellRGB(3, 3));
  ok((await bp.evaluate(() => getComputedStyle(document.querySelector('.pf')).getPropertyValue('--pf-ck1').trim())) === '#d6d6de', 'list thumbnails, frame strip and previews follow (shared CSS variables)');
  await bp.keyboard.press('k'); ok((await cellRGB(3, 3)) === '#000000', 'K cycles to the next background (black)');
  await bp.locator('.pf-bg').click(); await bp.locator('.pf-bgcustom').evaluate((i) => { i.value = '#336699'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  ok((await cellRGB(3, 3)) === '#336699', 'a custom colour applies as you pick it');
  await bp.keyboard.press('Escape'); ok(!(await bp.locator('.pf-bgmenu').count()), 'Escape closes the menu');
  await bp.reload(); await bp.waitForSelector('.pf-item'); await bp.waitForTimeout(300);
  ok((await cellRGB(3, 3)) === '#336699', 'the choice is remembered after a reload');
  await bp.locator('.pf-bg').click(); await bp.mouse.click(5, 300); ok(!(await bp.locator('.pf-bgmenu').count()), 'clicking elsewhere closes the menu');
  await bp.evaluate(() => localStorage.setItem('pf:bg', JSON.stringify({ mode: 'project' })));
  await bp.goto(base + '?auth=off'); await bp.waitForSelector('.pf-item'); await bp.waitForTimeout(300);
  await bp.locator('.pf-bg').click();
  ok((await bp.locator('.pf-bgmenu [data-bg]').count()) === 5 && (await bp.locator('.pf-bgmenu [data-bg].on').getAttribute('data-bg')) === 'dark', 'a project without a background has no Project entry and falls back to the dark checker');
  await bp.keyboard.press('Escape');
  await bp.evaluate(() => localStorage.removeItem('pf:bg'));
  ok(berr.length === 0, 'no page errors ' + berr.join('|'));
  await bp.close(); await s3.close();
}

section('changes view: what you changed since opening, and the original on demand');
{
  const cp = await ctx.newPage(); const cerr = []; cp.on('pageerror', (e) => cerr.push(e.message));
  await cp.goto(base + '?auth=off'); await cp.waitForSelector('.pf-item'); await cp.locator('.pf-item', { hasText: 'slime.png' }).click(); await cp.waitForTimeout(250);
  const at = (x, y, dx = 0.5) => cp.evaluate(([x, y, dx]) => { const S = document.getElementById('app').__pf.state, c = document.querySelector('.pf-view'), d = c.getContext('2d').getImageData(Math.round(S.ox + (x + dx) * S.zoom), Math.round(S.oy + (y + 0.5) * S.zoom), 1, 1).data; return [...d.slice(0, 3)]; }, [x, y, dx]);
  const pos = async (x, y) => { const b = await cp.locator('.pf-view').boundingBox(); const s = await cp.evaluate(() => { const S = document.getElementById('app').__pf.state, v = document.querySelector('.pf-view'); return { zoom: S.zoom, ox: S.ox, oy: S.oy, k: v.width / v.getBoundingClientRect().width }; }); return { x: b.x + (s.ox + (x + 0.5) * s.zoom) / s.k, y: b.y + (s.oy + (y + 0.5) * s.zoom) / s.k }; };
  await cp.locator('.pf-chex').fill('#00ff00'); await cp.locator('.pf-chex').press('Tab'); await cp.keyboard.press('b');
  const p0 = await pos(5, 5); await cp.mouse.click(p0.x, p0.y); await cp.waitForFunction(() => /kept in this browser/.test(document.querySelector('.pf-s-name').textContent)); // settled: the status line is rewritten once the edit is kept
  ok(/1 px changed · hold \\ for before/.test(await cp.locator('.pf-s-name').innerText()), 'the status bar counts the changed pixels and says how to see the original');
  const plainBody = await at(4, 4), plainNew = await at(5, 5);
  await cp.keyboard.press('c');
  const dimBody = await at(4, 4), keptNew = await at(5, 5), edge = await at(5, 5, 0.02);
  ok(await cp.locator('.pf-changes').evaluate((b) => b.classList.contains('on')), 'C turns the changes view on');
  ok(dimBody.every((v, i) => v < plainBody[i] * 0.6 + 2), `untouched pixels are dimmed (${plainBody} → ${dimBody})`);
  ok(JSON.stringify(keptNew) === JSON.stringify(plainNew), 'the changed pixel keeps its colour');
  ok(edge[0] > 200 && edge[2] > 200 && edge[1] < 180, 'and is outlined in pink: ' + edge);
  await cp.keyboard.down('\\'); const before = await at(5, 5); await cp.keyboard.up('\\'); const after = await at(5, 5);
  ok(JSON.stringify(before) !== JSON.stringify(plainNew) && JSON.stringify(after) === JSON.stringify(keptNew), 'holding \\ shows the original pixel, letting go shows the edit again');
  const hint = await cp.locator('.pf-s-peek').boundingBox(); await cp.mouse.move(hint.x + 5, hint.y + 5); await cp.mouse.down(); const held = await at(5, 5); await cp.mouse.up();
  ok(JSON.stringify(held) === JSON.stringify(before) && JSON.stringify(await at(5, 5)) === JSON.stringify(after), 'pressing and holding the status-bar hint does the same (touch screens)');
  await cp.keyboard.press('c');
  ok(JSON.stringify(await at(4, 4)) === JSON.stringify(plainBody), 'C again turns it off');
  await cp.locator('.pf-prbtn').click(); await cp.waitForSelector('.pf-dlg-pr[open]');
  ok((await cp.locator('.pf-chg canvas[data-b]').count()) === 1 && (await cp.locator('.pf-chg canvas[data-p]').count()) === 1, 'the pull request dialog shows each changed sprite before → after');
  await cp.locator('.pf-dlg-pr button[value=cancel]').click();
  cp.on('dialog', (d) => d.accept()); ok(cerr.length === 0, 'no page errors ' + cerr.join('|'));
  await cp.close();
}

section('vision check, reference layer, variants and history');
{
  const { execFileSync } = await import('node:child_process');
  const r4 = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-more-')); const git = (...a) => execFileSync('git', ['-C', r4, '-c', 'user.name=artist', '-c', 'user.email=a@a', ...a], { stdio: 'pipe' });
  fs.mkdirSync(path.join(r4, 'art'));
  const dotPng = (rgb, x = 1) => fromRows(['....', '.'.repeat(x) + 'c' + '.'.repeat(3 - x), '....', '....'], { c: rgb }).png;
  git('init', '-q');
  fs.writeFileSync(path.join(r4, 'art/hero_0.png'), dotPng([255, 0, 0])); fs.writeFileSync(path.join(r4, 'art/hero_atk.png'), dotPng([0, 0, 255], 2));
  git('add', '.'); git('commit', '-qm', 'red hero');
  fs.writeFileSync(path.join(r4, 'art/hero_0.png'), dotPng([0, 200, 0])); git('commit', '-qam', 'green hero');
  const s4 = createServer({ root: r4, port: 0 }), b4 = await s4.listen();
  const mp2 = await ctx.newPage(); const merr = []; mp2.on('pageerror', (e) => merr.push(e.message)); mp2.on('dialog', (d) => d.accept());
  await mp2.goto(b4 + '?auth=off'); await mp2.evaluate(() => { localStorage.removeItem('pf:ctx'); localStorage.removeItem('pf:bg'); }); await mp2.reload(); await mp2.waitForSelector('.pf-item');
  await mp2.locator('.pf-cell', { hasText: 'hero' }).click(); await mp2.waitForTimeout(300);
  const st = () => mp2.evaluate(() => { const S = document.getElementById('app').__pf.state, v = document.querySelector('.pf-view'); return { z: S.zoom, ox: S.ox, oy: S.oy, k: v.width / v.getBoundingClientRect().width }; });
  const at = async (x, y) => { const s = await st(); return mp2.evaluate(([x, y, s]) => [...document.querySelector('.pf-view').getContext('2d').getImageData(Math.round(s.ox + (x + 0.5) * s.z), Math.round(s.oy + (y + 0.5) * s.z), 1, 1).data.slice(0, 3)], [x, y, s]); };
  const shotAt = async (x, y) => { const s = await st(), b = await mp2.locator('.pf-view').boundingBox(); const png = decodePng(await mp2.screenshot({ clip: { x: b.x + (s.ox + (x + 0.5) * s.z) / s.k, y: b.y + (s.oy + (y + 0.5) * s.z) / s.k, width: 1, height: 1 } })); return [...png.rgba.slice(0, 3)]; };
  // vision
  const green = await shotAt(1, 1);
  await mp2.keyboard.press('y');
  ok((await mp2.locator('.pf-vision-tag').innerText()).toLowerCase() === 'values (greyscale)' && /grayscale\(1\)/.test(await mp2.locator('.pf-view').evaluate((v) => getComputedStyle(v).filter)), 'Y shows the art by value (greyscale), labelled on the canvas');
  const grey = await shotAt(1, 1); ok(grey[0] === grey[1] && grey[1] === grey[2] && green[1] > green[0] + 100, `the green pixel turns grey on screen (${green} → ${grey})`);
  await mp2.keyboard.press('y'); ok(/protan/.test(await mp2.locator('.pf-view').evaluate((v) => getComputedStyle(v).filter)) && /protanopia/i.test(await mp2.locator('.pf-vision-tag').innerText()), 'then protanopia');
  await mp2.keyboard.press('y'); const deut = await shotAt(1, 1); ok(/deutan/.test(await mp2.locator('.pf-view').evaluate((v) => getComputedStyle(v).filter)) && JSON.stringify(deut) !== JSON.stringify(green), `then deuteranopia, which changes the pixel on screen (${green} → ${deut})`);
  await mp2.keyboard.press('y'); await mp2.keyboard.press('y');
  ok(await mp2.locator('.pf-vision-tag').isHidden() && (await mp2.locator('.pf-view').evaluate((v) => getComputedStyle(v).filter)) === 'none', 'and back to normal');
  // reference
  await mp2.locator('.pf-ref-sprite').focus(); await mp2.locator('.pf-ref-sprite').selectOption('art/hero_atk.png'); await mp2.waitForTimeout(200);
  const refPix = await at(2, 1);
  ok(!(await mp2.locator('.pf-ref-on').isHidden()) && /hero_atk\.png · 4×4/.test(await mp2.locator('.pf-ref-name').innerText()) && refPix[2] > refPix[0] + 40, 'a sprite as reference shows through where the art is transparent: ' + refPix);
  ok(JSON.stringify(await at(1, 1)) === JSON.stringify([0, 200, 0]), 'under the art by default (your pixels stay on top)');
  await mp2.keyboard.press('h'); const hidden = await at(2, 1); ok(!(hidden[2] > hidden[0] + 40), 'H hides it');
  await mp2.keyboard.press('h'); await mp2.locator('.pf-ref-clear').click(); ok(await mp2.locator('.pf-ref-on').isHidden(), 'remove clears it');
  // variants
  await mp2.locator('.pf-variant').click(); await mp2.waitForSelector('.pf-dlg-variant[open]');
  await mp2.locator('.pf-v-suffix').fill('night'); await mp2.locator('.pf-v-h').evaluate((r) => { r.value = '180'; r.dispatchEvent(new Event('input', { bubbles: true })); });
  ok(/hero_night_0\.png, hero_night_atk\.png/.test(await mp2.locator('.pf-v-names').innerText()) && (await mp2.locator('.pf-v-preview canvas').count()) === 2, 'Make variant names the whole family\'s copies and previews them');
  await mp2.locator('.pf-v-go').click(); await mp2.waitForTimeout(400);
  const vdoc = await mp2.evaluate(() => { const a = document.getElementById('app').__pf; return { path: a.current.path, px: a.current.px[1 * 4 + 1] }; });
  const vr = vdoc.px & 255, vg = (vdoc.px >>> 8) & 255, vb = (vdoc.px >>> 16) & 255;
  ok(vdoc.path === 'art/hero_night_0.png' && vr > vg && vb > vg, `the variant opens, hue rotated (green → ${vr},${vg},${vb})`);
  await mp2.keyboard.press('Control+s'); await mp2.waitForTimeout(300);
  ok(fs.existsSync(path.join(r4, 'art/hero_night_0.png')), 'Save writes the new variant file');
  ok((await mp2.locator('.pf-cell', { hasText: 'hero_night' }).count()) === 1, 'and the list shows the new family');
  // history
  await mp2.evaluate(() => document.getElementById('app').__pf.open('art/hero_0.png')); await mp2.waitForTimeout(200);
  await mp2.locator('.pf-hist summary').click(); await mp2.waitForSelector('.pf-hist-e');
  const ents = await mp2.locator('.pf-hist-e b').allInnerTexts();
  ok(ents.join() === 'green hero,red hero' && /artist/.test(await mp2.locator('.pf-hist-e small').first().innerText()), 'History lists the sprite\'s commits: ' + ents.join(' | '));
  await mp2.locator('.pf-hist-e', { hasText: 'red hero' }).click(); await mp2.locator('.pf-hist-restore').click(); await mp2.waitForTimeout(300);
  ok(JSON.stringify(await at(1, 1)) === JSON.stringify([255, 0, 0]), 'Restore brings back the old version');
  await mp2.keyboard.press('Control+z'); ok(JSON.stringify(await at(1, 1)) === JSON.stringify([0, 200, 0]), 'and Ctrl+Z undoes the restore');
  ok(merr.length === 0, 'no page errors ' + merr.join('|'));
  await mp2.close(); await s4.close();
}

section('feedback: signed out it is a prefilled GitHub issue; signed in it is sent, screenshot included, through the sign-in service');
{
  const fctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' }); const sent = []; let failNext = false;
  await fctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await fctx.route('https://auth.test/**', async (route) => {
    const r = route.request(), u = new URL(r.url()), cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type' };
    if (u.pathname === '/login') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><script>opener.postMessage(${JSON.stringify({ type: 'pf-auth', nonce: u.searchParams.get('nonce'), token: 'ghu_reporter', expires_in: 28800, refresh_token: 'ghr_1' })}, ${JSON.stringify(u.searchParams.get('origin'))}); window.close();</script>` });
    if (u.pathname === '/feedback' && r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-methods': 'POST' } });
    if (u.pathname === '/feedback' && failNext) { failNext = false; return route.fulfill({ status: 503, contentType: 'application/json', headers: cors, body: JSON.stringify({ error: 'Feedback is not set up on this service.' }) }); }
    if (u.pathname === '/feedback') { sent.push({ auth: r.headers().authorization, body: JSON.parse(r.postData()) }); return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ number: 42, url: 'https://github.com/snowu/spritewright/issues/42' }) }); }
    return route.fulfill({ status: 404, body: 'x' });
  });
  await fctx.route('https://api.github.com/user', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ login: 'reporter' }) }));
  const fp = await fctx.newPage(); const ferrors = []; fp.on('pageerror', (e) => ferrors.push(e.message));
  // no sign-in service: the prefilled link, and the screenshot on the clipboard
  await fp.goto(base + '?auth=off'); await fp.waitForSelector('.pf-item'); await fp.locator('.pf-item', { hasText: 'slime.png' }).click(); await fp.waitForTimeout(150);
  await fp.click('.pf-feedback'); await fp.waitForSelector('.pf-fb-shot img', { timeout: 10000 }).catch(() => {});
  ok(await fp.locator('.pf-fb-send').isHidden() && await fp.locator('.pf-dlg-feedback .pf-auth-row').isHidden() && await fp.locator('.pf-fb-go').isVisible(), 'without a sign-in service: Open on GitHub, no Send, no sign-in');
  await fp.locator('.pf-fb-text').fill('The fill tool leaks through diagonal gaps'); await fp.click('.pf-fb-kind [data-kind=idea]');
  const href = new URL(await fp.getAttribute('.pf-fb-go', 'href'));
  ok(href.pathname === '/snowu/spritewright/issues/new' && href.searchParams.get('template') === 'feedback.yml', 'the link opens the feedback issue form: ' + href.pathname);
  ok(href.searchParams.get('title') === 'Idea: The fill tool leaks through diagonal gaps' && href.searchParams.get('what') === 'The fill tool leaks through diagonal gaps', 'what was typed is the title and the description');
  ok(/\| Sprite \| 16×16/.test(href.searchParams.get('details')), 'the details go along as a table');
  await fctx.route('https://github.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<p>issue form</p>' }));
  const [tab] = await Promise.all([fctx.waitForEvent('page'), fp.click('.pf-fb-go')]);
  await tab.waitForLoadState().catch(() => {}); ok(tab.url().startsWith('https://github.com/snowu/spritewright/issues/new?'), 'Open on GitHub opens the issue form in a new tab: ' + tab.url().slice(0, 60)); await tab.close(); await fctx.unroute('https://github.com/**');
  ok((await fp.evaluate(async () => (await navigator.clipboard.read()).flatMap((i) => i.types))).includes('image/png'), 'and puts the screenshot on the clipboard to paste');
  ok(/Screenshot copied/.test(await fp.locator('.pf-fb-note').innerText()) && !/blocked/.test(await fp.locator('.pf-fb-note').innerText()), 'it says so (and does not cry popup blocker)');
  await fp.keyboard.press('Escape');
  await fp.goto(base + '?auth=https://auth.test'); await fp.waitForSelector('.pf-item'); await fp.locator('.pf-item', { hasText: 'slime.png' }).click(); await fp.waitForTimeout(150);
  await fp.click('.pf-feedback');
  ok(await fp.locator('.pf-dlg-feedback').evaluate((d) => d.open), 'the Feedback button opens the feedback dialog');
  ok(await fp.waitForSelector('.pf-fb-shot img', { timeout: 10000 }).then(() => true, () => false), 'a screenshot of the editor is shown');
  const shot = await fp.locator('.pf-fb-shot img').evaluate((img) => ({ w: img.naturalWidth, h: img.naturalHeight, ew: document.querySelector('.pf').getBoundingClientRect().width }));
  ok(shot.w >= shot.ew - 1 && shot.h > 300, 'the screenshot is the whole editor: ' + shot.w + 'x' + shot.h);
  const facts = await fp.locator('.pf-fb-facts').textContent(); // folded away under <details>, so not innerText
  ok(/local server/.test(facts) && /16×16/.test(facts) && /Browser/.test(facts), 'the details name the project kind, the sprite size and the browser');
  ok(!/slime\.png/.test(facts), 'no file names from a project that is not a public GitHub repository');
  ok(await fp.locator('.pf-fb-send').isHidden() && await fp.locator('.pf-fb-go').isVisible() && await fp.locator('.pf-dlg-feedback .pf-signin').isVisible() && /sign in with GitHub to send it from here/.test(await fp.locator('.pf-fb-note').innerText()), 'signed out: the prefilled link, and a sign-in to send it from here');
  await fp.locator('.pf-fb-text').fill('The fill tool leaks through diagonal gaps');
  await fp.click('.pf-dlg-feedback .pf-signin');
  ok(await fp.waitForSelector('.pf-fb-send:not([hidden]):not([disabled])', { timeout: 5000 }).then(() => true, () => false), 'signing in from the dialog unlocks Send');
  ok(await fp.locator('.pf-fb-link').isHidden(), 'and puts the link away');
  failNext = true; await fp.click('.pf-fb-kind [data-kind=idea]'); await fp.click('.pf-fb-send');
  ok(await fp.waitForSelector('.pf-fb-link:not([hidden])', { timeout: 5000 }).then(() => true, () => false) && /not set up[\s\S]*open it on GitHub yourself/.test(await fp.locator('.pf-fb-note').innerText()), 'a failed send says why and offers the link');
  ok(/Idea: The fill tool/.test(new URL(await fp.getAttribute('.pf-fb-go', 'href')).searchParams.get('title')), 'filled in with what was typed');
  await fp.click('.pf-fb-send');
  ok(await fp.waitForSelector('.pf-fb-done', { timeout: 5000 }).then(() => true, () => false), 'it says it was sent');
  const f = sent[0] || { body: {} };
  ok(sent.length === 1 && f.auth === 'Bearer ghu_reporter', 'one report, sent with the signed-in token');
  ok(f.body.kind === 'idea' && f.body.what === 'The fill tool leaks through diagonal gaps' && /\| Sprite \| 16×16/.test(f.body.details), 'with the kind, the text and the details table');
  const png = Buffer.from(f.body.screenshot || '', 'base64'); ok(png.subarray(1, 4).toString() === 'PNG' && png.length > 1000, 'and the screenshot as a PNG: ' + png.length + ' bytes');
  ok((await fp.getAttribute('.pf-fb-done a', 'href')) === 'https://github.com/snowu/spritewright/issues/42' && /#42/.test(await fp.locator('.pf-fb-done').innerText()), 'it links the new issue');
  ok(await fp.locator('.pf-fb-send').isDisabled(), 'and cannot be sent twice');
  ok(ferrors.length === 0, 'no errors around feedback ' + ferrors.join('|'));
  await fp.screenshot({ path: path.join(os.tmpdir(), 'pf-feedback-sent.png') });
  await fp.evaluate(() => { const a = document.createElement('div'); document.body.append(a); window.Spritewright.mount(a, { feedback: false, authBase: 'https://auth.test' }); window.__fbOff = a.querySelector('.pf-feedback').hidden; });
  ok(await fp.evaluate(() => window.__fbOff), 'feedback: false hides the button');
  ok(await fp.evaluate(() => { const b = document.createElement('div'); document.body.append(b); window.Spritewright.mount(b, { feedback: 'me/game' }); return !b.querySelector('.pf-feedback').hidden; }), 'a repository keeps it, sign-in service or not');
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
{ // pinch to zoom: the first finger lands a moment before the second; nothing may be drawn
  const cdp = await phone.newCDPSession(mp), at = (x, y) => ({ x: vb.x + (mS.ox + (x + 0.5) * mS.zoom) / mS.k, y: vb.y + (mS.oy + (y + 0.5) * mS.zoom) / mS.k });
  const before = await mp.evaluate(() => [...document.getElementById('app').__pf.current.px]), undos = await mp.evaluate(() => document.getElementById('app').__pf.current.undo.length), z0 = mS.zoom;
  const a = at(4, 4), b = at(9, 9);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...a, id: 1 }] }); await mp.waitForTimeout(60);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a.x + 6, y: a.y + 6, id: 1 }] }); await mp.waitForTimeout(30);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a.x + 6, y: a.y + 6, id: 1 }, { ...b, id: 2 }] });
  for (let i = 1; i <= 5; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a.x + 6 - i * 12, y: a.y + 6 - i * 12, id: 1 }, { x: b.x + i * 12, y: b.y + i * 12, id: 2 }] }); await mp.waitForTimeout(20); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await mp.waitForTimeout(100);
  const after = await mp.evaluate(() => ({ px: [...document.getElementById('app').__pf.current.px], undo: document.getElementById('app').__pf.current.undo.length, zoom: document.getElementById('app').__pf.state.zoom }));
  ok(after.zoom > z0, 'pinching zooms in: ' + z0 + '× → ' + after.zoom + '×');
  ok(JSON.stringify(after.px) === JSON.stringify(before) && after.undo === undos, 'and draws nothing, not even where the first finger landed (no undo step left behind either)');
  await cdp.detach();
}
ok((await mp.locator('.pf-save').boundingBox()).height >= 36, 'buttons are touch sized');
await mp.locator('.pf-feedback').tap(); await mp.waitForSelector('.pf-fb-shot img', { timeout: 10000 }).catch(() => {});
const fbBox = await mp.locator('.pf-dlg-feedback').boundingBox(); ok(fbBox && fbBox.x >= 0 && fbBox.x + fbBox.width <= 391, 'the feedback dialog fits a phone');
const mshot = await mp.locator('.pf-fb-shot img').evaluate((i) => i.naturalWidth / i.naturalHeight).catch(() => 0); ok(Math.abs(mshot - 390 / 800) < 0.1, 'on a phone the screenshot is what is on the screen, not the whole long page: ' + mshot.toFixed(2));
await mp.screenshot({ path: path.join(os.tmpdir(), 'pf-mobile-feedback.png') }); await mp.keyboard.press('Escape');
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
