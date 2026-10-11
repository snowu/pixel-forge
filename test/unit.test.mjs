import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { scan, readPngSize, slugFromRemote, gitInfo, globToRegExp } from '../src/scan.mjs';
import { createServer, safeResolve } from '../src/serve.mjs';
import { encodePng, decodePng, fromRows } from './png.mjs';
await import('../pixel-forge.js');
const PF = globalThis.PixelForge, C = PF.core;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pf-'));
const SLIME = fromRows(['.gg.', 'gGGg', 'gGGg', '.gg.'], { g: [60, 180, 80], G: [120, 230, 130] });

/* ---------- drawing core ---------- */
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
  fs.writeFileSync(path.join(root, 'pixel-forge.config.json'), JSON.stringify({ dirs: ['art'], exclude: ['art/wip/**'], palette: 'pal.hex', frames: { 'art/a.png': { w: 2, h: 4, fps: 6 }, 'art/b*': { w: 4, h: 2 } } }));
  const m = scan(root);
  assert.deepEqual(m.sprites.map((s) => s.path), ['art/a.png', 'art/b.png']);
  assert.deepEqual(m.sprites[0].frames, { w: 2, h: 4, fps: 6 }); assert.deepEqual(m.sprites[1].frames, { w: 4, h: 2 });
  assert.deepEqual(m.palette, ['#1a1c2c', '#5d275d']);
  assert.equal(scan(root, { maxSize: 2, dirs: ['art'] }).sprites.length, 0);
});
test('git info: slug from the remote and the folder prefix inside the repo', () => {
  assert.equal(slugFromRemote('git@github.com:snowu/looting-simulator.git'), 'snowu/looting-simulator');
  assert.equal(slugFromRemote('https://github.com/snowu/senior-interview-lab'), 'snowu/senior-interview-lab');
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
    assert.equal((await req(base + 'pixel-forge.js')).status, 200);
    const png = await req(base + 'project/art/slime.png'); assert.equal(png.status, 200); assert.ok(png.body.equals(SLIME.png));
    assert.equal((await req(base + 'project/secret.txt')).status, 403, 'only png/hex are served');
    assert.equal((await req(base + 'project/..%2fsecret.txt')).status, 400);
    assert.equal((await req(base + 'project/.git/config')).status, 400);
    const edited = fromRows(['rrrr', 'rrrr'], { r: [255, 0, 0] }).png;
    assert.equal((await req(base + 'project/art/slime.png', { method: 'PUT', body: edited })).status, 403, 'no token');
    assert.equal((await req(base + 'project/art/slime.png', { method: 'PUT', headers: { 'x-pixel-forge': 'wrong' }, body: edited })).status, 403, 'wrong token');
    assert.equal((await req(base + 'project/art/slime.png', { method: 'PUT', headers: { 'x-pixel-forge': s.token }, body: Buffer.from('hello hello hello hello hello hello hello hello') })).status, 400, 'not a PNG');
    assert.equal((await req(base + 'project/art/run.sh', { method: 'PUT', headers: { 'x-pixel-forge': s.token }, body: edited })).status, 400, 'only png');
    assert.equal((await req(base + 'project/..%2f..%2fx.png', { method: 'PUT', headers: { 'x-pixel-forge': s.token }, body: edited })).status, 400, 'traversal');
    assert.equal((await req(base + 'project/art/slime.png', { method: 'PUT', headers: { 'x-pixel-forge': s.token }, body: edited })).status, 200);
    assert.ok(fs.readFileSync(path.join(root, 'art/slime.png')).equals(edited), 'written to disk');
    assert.equal((await req(base + 'project/art/new/dir/x.png', { method: 'PUT', headers: { 'x-pixel-forge': s.token }, body: edited })).status, 200);
    assert.ok(fs.existsSync(path.join(root, 'art/new/dir/x.png')), 'new files and folders can be created inside the project');
    assert.deepEqual(fs.readdirSync(path.join(root, 'art')).filter((n) => n.includes('pf-tmp')), [], 'no temp files left behind');
    assert.equal((await req(base + 'project/art/slime.png', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'x-pixel-forge' } })).headers['access-control-allow-origin'], undefined, 'no CORS preflight approval');
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
