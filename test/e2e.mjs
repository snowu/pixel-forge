// Browser tests: starts the real server on a temp project and drives the editor with Playwright.
//   npm i -D playwright && npx playwright install chromium && node test/e2e.mjs
// Env: PLAYWRIGHT_MODULE (path to playwright's index, if not installed here), PF_LAUNCH_HELPER (a module exporting launch(), for sandboxes that need extra libraries).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/serve.mjs';
import { decodePng, fromRows } from './png.mjs';

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
fs.writeFileSync(path.join(root, 'pixel-forge.config.json'), JSON.stringify({ palette: 'palette.hex', frames: { 'art/enemies/walk.png': { w: 4, h: 4, fps: 12 } } }));
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
await page.goto(base); await page.waitForSelector('.pf-item');
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

section('mobile');
const phone = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
const mp = await phone.newPage(); const merrors = []; mp.on('pageerror', (e) => merrors.push(e.message));
await mp.goto(base); await mp.waitForSelector('.pf-item'); await mp.waitForTimeout(300);
ok(await mp.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no sideways scroll at 390px');
await mp.locator('.pf-item', { hasText: 'slime.png' }).tap(); await mp.waitForTimeout(250);
const vb = await mp.locator('.pf-view').boundingBox(); ok(vb.width > 300 && vb.height > 250, 'the canvas gets a usable size on a phone: ' + Math.round(vb.width) + 'x' + Math.round(vb.height));
const mS = await mp.evaluate(() => { const S = document.getElementById('app').__pf.state, v = document.querySelector('.pf-view'); return { zoom: S.zoom, ox: S.ox, oy: S.oy, k: v.width / v.getBoundingClientRect().width }; });
await mp.touchscreen.tap(vb.x + (mS.ox + 10.5 * mS.zoom) / mS.k, vb.y + (mS.oy + 12.5 * mS.zoom) / mS.k);
const mpx = await mp.evaluate(() => document.getElementById('app').__pf.current.px[12 * 16 + 10]);
ok(mpx !== 0, 'a tap draws a pixel');
ok((await mp.locator('.pf-save').boundingBox()).height >= 36, 'buttons are touch sized');
ok(merrors.length === 0, 'no errors on mobile ' + merrors.join('|'));
await mp.screenshot({ path: path.join(os.tmpdir(), 'pf-mobile.png'), fullPage: true });
await phone.close();

ok(errors.length === 0, 'no page errors ' + JSON.stringify(errors.slice(0, 3)));
await browser.close(); await srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
