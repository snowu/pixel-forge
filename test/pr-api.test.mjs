import test from 'node:test';
import assert from 'node:assert/strict';
await import('../spritewright.js');
const PF = globalThis.Spritewright;

const j = (status, obj) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj) });
/* A canned GitHub API: routes are [method, pathname, handler(url, body) -> response]. */
function mock(state, extra = {}) {
  const calls = [];
  const routes = {
    'GET /user': () => j(200, { login: 'artist' }),
    'GET /repos/me/game': () => j(200, { name: 'game', default_branch: 'main', permissions: state.push === false ? {} : { push: true } }),
    'GET /repos/artist/game': () => j(state.forkReady === false ? 404 : 200, state.forkReady === false ? { message: 'not there yet' } : {}),
    'POST /repos/me/game/forks': () => { state.forked = true; return j(202, { full_name: 'artist/game' }); },
    'POST /repos/artist/game/merge-upstream': () => j(200, {}),
    ...extra,
  };
  const fetch = async (url, opts = {}) => {
    const u = new URL(url), key = (opts.method || 'GET') + ' ' + u.pathname;
    calls.push({ method: opts.method || 'GET', path: u.pathname, query: u.search, body: opts.body ? JSON.parse(opts.body) : null, auth: (opts.headers || {}).Authorization });
    const h = routes[key];
    if (!h) return j(404, { message: 'unexpected ' + key });
    return h(u, opts.body ? JSON.parse(opts.body) : null);
  };
  return { calls, fetch };
}
const refs = (state) => ({
  [`GET /repos/me/game/git/ref/heads/main`]: () => j(200, { object: { sha: 'base1' } }),
  [`GET /repos/me/game/git/commits/base1`]: () => j(200, { tree: { sha: 'tree0' } }),
});
const blobTree = {
  'POST /repos/me/game/git/blobs': () => j(201, { sha: 'blob9' }),
  'POST /repos/me/game/git/trees': () => j(201, { sha: 'tree9' }),
  'POST /repos/me/game/git/commits': () => j(201, { sha: 'c9' }),
};
const png = new Uint8Array([1, 2, 3]);

test('pushSprites commits to a new branch from the base', async () => {
  const state = {}, { calls, fetch } = mock(state, {
    ...refs(state),
    ...blobTree,
    'POST /repos/me/game/git/refs': () => j(201, {}),
  });
  const res = await PF.pushSprites({ token: 't', repo: 'me/game', branch: 'art/a', files: [{ path: 'a/x.png', blob: png }], message: 'chunk one', fetch });
  assert.deepEqual(res, { branch: 'art/a', headRepo: 'me/game', headOwner: null, forked: false, commit: 'c9', base: 'main', baseSha: 'base1', created: true });
  const tree = calls.find((c) => c.path.endsWith('/git/trees')).body;
  assert.equal(tree.base_tree, 'tree0');
  assert.deepEqual(tree.tree, [{ path: 'a/x.png', mode: '100644', type: 'blob', sha: 'blob9' }]);
  const commit = calls.find((c) => c.path.endsWith('/git/commits')).body;
  assert.deepEqual(commit.parents, ['base1']);
  assert.equal(commit.message, 'chunk one');
  const ref = calls.find((c) => c.path.endsWith('/git/refs')).body;
  assert.deepEqual(ref, { ref: 'refs/heads/art/a', sha: 'c9' });
  assert.ok(calls.every((c) => c.auth === 'Bearer t'), 'the token goes on every call');
});

test('pushSprites appends to an existing branch without touching the base', async () => {
  const state = {}, { calls, fetch } = mock(state, {
    'GET /repos/me/game/git/ref/heads/art/a': () => j(200, { object: { sha: 'tip7' } }),
    'GET /repos/me/game/git/commits/tip7': () => j(200, { tree: { sha: 'treeT' } }),
    'POST /repos/me/game/git/blobs': () => j(201, { sha: 'blob9' }),
    'POST /repos/me/game/git/trees': () => j(201, { sha: 'tree9' }),
    'POST /repos/me/game/git/commits': () => j(201, { sha: 'c9' }),
    'PATCH /repos/me/game/git/refs/heads/art/a': () => j(200, {}),
  });
  const res = await PF.pushSprites({ token: 't', repo: 'me/game', branch: 'art/a', files: [{ path: 'a/y.png', blob: png }], fetch });
  assert.equal(res.created, false);
  assert.equal(res.baseSha, null);
  const tree = calls.find((c) => c.path.endsWith('/git/trees')).body;
  assert.equal(tree.base_tree, 'treeT');
  assert.deepEqual(calls.find((c) => c.path.endsWith('/git/commits')).body.parents, ['tip7']);
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.path, '/repos/me/game/git/refs/heads/art/a');
  assert.deepEqual(patch.body, { sha: 'c9' });
  assert.ok(!calls.some((c) => c.path.includes('/ref/heads/main')), 'the base is never read when the branch exists');
});

test('pushSprites forks first without write access, like a pull request', async () => {
  const state = { push: false, forkReady: true }, { calls, fetch } = mock(state, {
    'GET /repos/me/game/git/ref/heads/main': () => j(200, { object: { sha: 'base1' } }),
    'GET /repos/me/game/git/commits/base1': () => j(200, { tree: { sha: 'tree0' } }),
    'POST /repos/artist/game/git/blobs': () => j(201, { sha: 'blob9' }),
    'POST /repos/artist/game/git/trees': () => j(201, { sha: 'tree9' }),
    'POST /repos/artist/game/git/commits': () => j(201, { sha: 'c9' }),
    'POST /repos/artist/game/git/refs': () => j(201, {}),
  });
  const res = await PF.pushSprites({ token: 't', repo: 'me/game', branch: 'art/a', files: [{ path: 'a/x.png', blob: png }], fetch });
  assert.deepEqual([res.headRepo, res.headOwner, res.forked], ['artist/game', 'artist', true]);
  assert.ok(state.forked, 'forked before writing anything');
});

test('pushSprites validates its inputs', async () => {
  const { fetch } = mock({});
  await assert.rejects(() => PF.pushSprites({ repo: 'me/game', branch: 'b', files: [{ path: 'x', blob: png }], fetch }), /token/);
  await assert.rejects(() => PF.pushSprites({ token: 't', repo: 'nope', branch: 'b', files: [{ path: 'x', blob: png }], fetch }), /owner\/name/);
  await assert.rejects(() => PF.pushSprites({ token: 't', repo: 'me/game', branch: 'b', files: [], fetch }), /no changed sprites/);
});

test('openPulls lists open pull requests for a head branch', async () => {
  const { calls, fetch } = mock({}, {
    'GET /repos/me/game/pulls': () => j(200, [{ number: 4, html_url: 'https://github.com/me/game/pull/4', title: 'chunks' }]),
  });
  const pulls = await PF.openPulls({ token: 't', repo: 'me/game', branch: 'art/a', fetch });
  assert.deepEqual(pulls, [{ number: 4, url: 'https://github.com/me/game/pull/4', title: 'chunks' }]);
  const q = calls[0].query;
  assert.ok(q.includes('state=open') && q.includes('head=me%3Aart%2Fa'), 'state and owner:branch go on the query: ' + q);
});

test('openPull opens a pull request for a branch that already has the changes', async () => {
  const { calls, fetch } = mock({}, {
    'POST /repos/me/game/pulls': () => j(201, { html_url: 'https://github.com/me/game/pull/5', number: 5 }),
  });
  const res = await PF.openPull({ token: 't', repo: 'me/game', branch: 'art/a', base: 'main', title: 'Chunks', body: 'all of it', fetch });
  assert.deepEqual(res, { url: 'https://github.com/me/game/pull/5', number: 5 });
  const body = calls[0].body;
  assert.equal(body.head, 'art/a');
  assert.equal(body.base, 'main');
  const forked = await PF.openPull({ token: 't', repo: 'me/game', branch: 'art/a', base: 'main', headOwner: 'artist', fetch });
  assert.equal(forked.number, 5);
});

test('listBranches names the branches', async () => {
  const { fetch } = mock({}, {
    'GET /repos/me/game/branches': () => j(200, [{ name: 'main' }, { name: 'art/a' }]),
  });
  assert.deepEqual(await PF.listBranches({ token: 't', repo: 'me/game', fetch }), ['main', 'art/a']);
});
