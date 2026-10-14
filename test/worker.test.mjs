import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, signState, verifyState } from '../worker/index.js';

const env = { GITHUB_CLIENT_ID: 'Iv1.test', GITHUB_CLIENT_SECRET: 'sekrit', STATE_SECRET: 'a-long-random-string', ALLOWED_ORIGINS: 'https://snowu.github.io, http://localhost:5173' };
const NONCE = 'ab'.repeat(16), req = (path) => new Request('https://auth.example' + path);

test('login redirects to GitHub with a signed state, only for allowed origins', async () => {
  const r = await handle(req(`/login?origin=${encodeURIComponent('https://snowu.github.io')}&nonce=${NONCE}`), env);
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(loc.searchParams.get('client_id'), 'Iv1.test');
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://auth.example/callback');
  assert.equal(loc.searchParams.has('scope'), false, 'a GitHub App needs no scope parameter');
  const st = await verifyState(env, loc.searchParams.get('state'));
  assert.deepEqual({ o: st.o, n: st.n }, { o: 'https://snowu.github.io', n: NONCE });
  assert.equal((await handle(req(`/login?origin=${encodeURIComponent('https://evil.example')}&nonce=${NONCE}`), env)).status, 403);
  assert.equal((await handle(req(`/login?origin=${encodeURIComponent('https://snowu.github.io')}&nonce=zz`), env)).status, 400);
  const withScope = await handle(req(`/login?origin=${encodeURIComponent('http://localhost:5173')}&nonce=${NONCE}`), { ...env, OAUTH_SCOPE: 'public_repo' });
  assert.equal(new URL(withScope.headers.get('location')).searchParams.get('scope'), 'public_repo');
});

test('callback exchanges the code with the secret and posts the token to the verified origin only', async () => {
  const state = await signState(env, { o: 'https://snowu.github.io', n: NONCE, t: 1000 });
  let sent;
  const fetchMock = async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return { json: async () => ({ access_token: 'ghu_secrettoken', expires_in: 28800, refresh_token: 'ghr_x', token_type: 'bearer' }) }; };
  const r = await handle(req(`/callback?code=abc&state=${encodeURIComponent(state)}`), env, fetchMock, 2000);
  assert.equal(r.status, 200);
  assert.equal(sent.url, 'https://github.com/login/oauth/access_token');
  assert.deepEqual(sent.body, { client_id: 'Iv1.test', client_secret: 'sekrit', code: 'abc', redirect_uri: 'https://auth.example/callback' });
  const html = await r.text();
  assert.match(html, /postMessage\(\{"type":"pf-auth","nonce":"abababab[a-f0-9]*","token":"ghu_secrettoken","expires_in":28800,"refresh_token":"ghr_x","refresh_token_expires_in":null\},"https:\/\/snowu\.github\.io"\)/);
  assert.ok(!html.includes('sekrit'), 'the client secret never reaches the page');
  assert.match(r.headers.get('cache-control'), /no-store/); assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
});

test('forged, tampered, expired or replayed-for-another-origin states are rejected', async () => {
  const good = await signState(env, { o: 'https://snowu.github.io', n: NONCE, t: 5000 });
  const [body, sig] = good.split('.');
  const forged = Buffer.from(JSON.stringify({ o: 'https://evil.example', n: NONCE, t: 5000 })).toString('base64url') + '.' + sig;
  for (const s of ['', 'x', 'a.b', forged, body + '.' + sig.slice(0, -2) + 'AA']) assert.equal((await handle(req(`/callback?code=c&state=${encodeURIComponent(s)}`), env, async () => { throw new Error('must not call GitHub'); }, 5000)).status, 400, 'state: ' + s.slice(0, 12));
  const old = await handle(req(`/callback?code=c&state=${encodeURIComponent(good)}`), env, async () => { throw new Error('must not call GitHub'); }, 5000 + 11 * 60 * 1000);
  assert.equal(old.status, 400);
  const notAllowed = await signState({ ...env }, { o: 'https://evil.example', n: NONCE, t: 5000 }); // correctly signed but the origin is not allow-listed
  assert.equal((await handle(req(`/callback?code=c&state=${encodeURIComponent(notAllowed)}`), env, async () => ({}), 5000)).status, 400);
});

test('errors from GitHub or the user are passed to the page as a message, never as a token', async () => {
  const state = await signState(env, { o: 'https://snowu.github.io', n: NONCE, t: 1000 });
  const denied = await (await handle(req(`/callback?error=access_denied&error_description=${encodeURIComponent('The user denied access')}&state=${encodeURIComponent(state)}`), env, async () => ({}), 2000)).text();
  assert.match(denied, /"error":"The user denied access"/); assert.ok(!/"token"/.test(denied));
  const bad = await (await handle(req(`/callback?code=old&state=${encodeURIComponent(state)}`), env, async () => ({ json: async () => ({ error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' }) }), 2000)).text();
  assert.match(bad, /incorrect or expired/);
  const down = await (await handle(req(`/callback?code=c&state=${encodeURIComponent(state)}`), env, async () => { throw new Error('network'); }, 2000)).text();
  assert.match(down, /Could not reach GitHub/);
  const xss = await signState(env, { o: 'https://snowu.github.io', n: NONCE, t: 1000 });
  const html = await (await handle(req(`/callback?error=${encodeURIComponent('</script><script>alert(1)</script>')}&state=${encodeURIComponent(xss)}`), env, async () => ({}), 2000)).text();
  assert.ok(!html.includes('</script><script>alert(1)'), 'user supplied text cannot break out of the script block');
});

test('only GET is served, health works, and a missing secret is a clear server error', async () => {
  assert.equal((await handle(new Request('https://auth.example/login', { method: 'POST' }), env)).status, 405);
  assert.deepEqual(await (await handle(req('/health'), env)).json(), { ok: true });
  assert.equal((await handle(req('/nope'), env)).status, 404);
  assert.equal((await handle(req('/login'), { ...env, GITHUB_CLIENT_SECRET: '' })).status, 500);
});

test('refresh trades a refresh token for a new access token, only for allowed origins', async () => {
  const post = (body, origin = 'https://snowu.github.io', method = 'POST') => new Request('https://auth.example/refresh', { method, headers: { origin, 'content-type': 'text/plain' }, body: method === 'POST' ? JSON.stringify(body) : undefined });
  let sent;
  const gh = async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return { json: async () => ({ access_token: 'ghu_new', expires_in: 28800, refresh_token: 'ghr_next', refresh_token_expires_in: 15811200 }) }; };
  const r = await handle(post({ refresh_token: 'ghr_old' }), env, gh);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://snowu.github.io');
  assert.deepEqual(sent.body, { client_id: 'Iv1.test', client_secret: 'sekrit', grant_type: 'refresh_token', refresh_token: 'ghr_old' });
  assert.deepEqual(await r.json(), { token: 'ghu_new', expires_in: 28800, refresh_token: 'ghr_next', refresh_token_expires_in: 15811200 });
  const never = async () => { throw new Error('must not call GitHub'); };
  assert.equal((await handle(post({ refresh_token: 'ghr_old' }, 'https://evil.example'), env, never)).status, 403, 'other sites cannot use it');
  assert.equal((await handle(post({}), env, never)).status, 400);
  const pre = await handle(post(null, 'https://snowu.github.io', 'OPTIONS'), env, never);
  assert.equal(pre.status, 204); assert.match(pre.headers.get('access-control-allow-methods'), /POST/);
  const expired = await handle(post({ refresh_token: 'ghr_used' }), env, async () => ({ json: async () => ({ error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' }) }));
  assert.equal(expired.status, 401); assert.match((await expired.json()).error, /incorrect or expired/);
});

test('loopback origins are allowed only when ALLOW_LOOPBACK is on', async () => {
  const login = (origin, e) => handle(req(`/login?origin=${encodeURIComponent(origin)}&nonce=${NONCE}`), e);
  assert.equal((await login('http://localhost:5173', { ...env, ALLOWED_ORIGINS: 'https://snowu.github.io' })).status, 403);
  const lb = { ...env, ALLOWED_ORIGINS: 'https://snowu.github.io', ALLOW_LOOPBACK: 'true' };
  for (const o of ['http://localhost:5173', 'http://127.0.0.1:41234', 'http://localhost']) assert.equal((await login(o, lb)).status, 302, o);
  for (const o of ['https://localhost.evil.example', 'http://localhost.evil.example', 'http://localhost:5173.evil.example', 'http://127.0.0.2:80', 'https://evil.example']) assert.equal((await login(o, lb)).status, 403, o);
});

/* ---------- /feedback ---------- */
const FB_ENV = { ...env, FEEDBACK_TOKEN: 'github_pat_feedback', FEEDBACK_REPO: 'snowu/spritewright' };
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(40, 7)]);
const fbReq = (body, { token = 'ghu_reporter', origin = 'https://snowu.github.io', method = 'POST' } = {}) => new Request('https://auth.example/feedback', { method, headers: { origin, 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: method === 'POST' ? JSON.stringify(body) : undefined });
/** A fake GitHub: who is signed in, a missing screenshot branch the first time, and what was written. */
function fakeGithub({ user = 'reporter', branch = false, userIssues = true } = {}) {
  const calls = [];
  const fetchMock = async (url, init = {}) => {
    const p = new URL(url).pathname, method = init.method || 'GET', auth = init.headers.authorization, body = init.body ? JSON.parse(init.body) : null; calls.push({ p, method, auth, body });
    const res = (status, o) => ({ ok: status < 300, status, json: async () => o });
    if (p === '/user') return auth === 'Bearer ghu_reporter' ? res(200, { login: user }) : res(401, { message: 'Bad credentials' });
    if (auth === 'Bearer ghu_reporter' && p === '/repos/snowu/spritewright/issues' && method === 'POST') return userIssues ? res(201, { number: 41, html_url: 'https://github.com/snowu/spritewright/issues/41' }) : res(403, { message: 'Resource not accessible by integration' });
    if (auth !== 'Bearer github_pat_feedback') return res(403, { message: 'wrong token' });
    if (/^\/repos\/snowu\/spritewright\/issues\/\d+\/labels$/.test(p) && method === 'POST') return res(200, []);
    if (p === '/repos/snowu/spritewright/git/ref/heads/feedback-screenshots') return branch ? res(200, { object: { sha: 's0' } }) : res(404, { message: 'Not Found' });
    if (p === '/repos/snowu/spritewright') return res(200, { default_branch: 'main' });
    if (p === '/repos/snowu/spritewright/git/ref/heads/main') return res(200, { object: { sha: 'm1' } });
    if (p === '/repos/snowu/spritewright/git/refs' && method === 'POST') { branch = true; return res(201, {}); }
    if (p.startsWith('/repos/snowu/spritewright/contents/feedback/') && method === 'PUT') return res(201, { commit: { sha: 'c9' } });
    if (p === '/repos/snowu/spritewright/issues' && method === 'POST') return res(201, { number: 42, html_url: 'https://github.com/snowu/spritewright/issues/42' });
    return res(404, { message: 'Not Found' });
  };
  return { calls, fetchMock };
}

test('feedback: a signed-in person\'s report becomes their own issue, with the screenshot stored in the repository and shown inline', async () => {
  const gh = fakeGithub(), now = Date.UTC(2026, 9, 14, 12, 30, 5);
  const r = await handle(fbReq({ kind: 'idea', what: '  Onion skin for numbered files please  ', details: '| | |\n|---|---|\n| Sprite | 16×16 |', screenshot: PNG.toString('base64') }), FB_ENV, gh.fetchMock, now);
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { number: 41, url: 'https://github.com/snowu/spritewright/issues/41', by: 'user' });
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://snowu.github.io');
  assert.deepEqual(gh.calls.find((c) => c.p === '/repos/snowu/spritewright/git/refs').body, { ref: 'refs/heads/feedback-screenshots', sha: 'm1' }, 'the screenshot branch is made from the default branch the first time');
  const put = gh.calls.find((c) => c.method === 'PUT');
  assert.match(put.p, /^\/repos\/snowu\/spritewright\/contents\/feedback\/2026-10\/2026-10-14-12-30-05-reporter-[0-9a-f]{8}\.png$/);
  assert.equal(put.body.branch, 'feedback-screenshots'); assert.deepEqual(Buffer.from(put.body.content, 'base64'), PNG);
  assert.equal(put.auth, 'Bearer github_pat_feedback', 'the screenshot is stored with the service\'s token');
  const opened = gh.calls.filter((c) => c.p.endsWith('/issues'));
  assert.equal(opened.length, 1); assert.equal(opened[0].auth, 'Bearer ghu_reporter', 'the issue is opened as the reporter');
  const issue = opened[0].body;
  assert.equal(issue.title, 'Idea: Onion skin for numbered files please');
  assert.match(issue.body, /^Onion skin for numbered files please\n\n!\[Screenshot\]\(https:\/\/raw\.githubusercontent\.com\/snowu\/spritewright\/c9\/feedback\/2026-10\/[^)]+\.png\)/);
  assert.match(issue.body, /\| Sprite \| 16×16 \|[\s\S]*Sent from the spritewright editor\.$/);
  const label = gh.calls.find((c) => c.p === '/repos/snowu/spritewright/issues/41/labels');
  assert.equal(label.auth, 'Bearer github_pat_feedback'); assert.deepEqual(label.body, { labels: ['feedback'] }, 'the service labels it');
  const again = fakeGithub({ branch: true });
  assert.equal((await handle(fbReq({ kind: 'bug', what: 'no picture' }), FB_ENV, again.fetchMock)).status, 200);
  assert.ok(!again.calls.some((c) => c.method === 'PUT' || c.p.endsWith('/git/refs')), 'no screenshot, nothing stored');
  assert.match(again.calls.find((c) => c.p.endsWith('/issues')).body.body, /_No screenshot\._/);
});

test('feedback: when GitHub will not let the reporter open it, the service opens the issue for them and names them', async () => {
  const gh = fakeGithub({ branch: true, userIssues: false });
  const r = await handle(fbReq({ kind: 'bug', what: 'Fill leaks' }), FB_ENV, gh.fetchMock);
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { number: 42, url: 'https://github.com/snowu/spritewright/issues/42', by: 'service' });
  const [mine, theirs] = gh.calls.filter((c) => c.p.endsWith('/issues'));
  assert.equal(mine.auth, 'Bearer ghu_reporter'); assert.equal(theirs.auth, 'Bearer github_pat_feedback');
  assert.deepEqual(theirs.body.labels, ['feedback']); assert.match(theirs.body.body, /Sent from the spritewright editor by @reporter\.$/);
  assert.ok(!gh.calls.some((c) => c.p.endsWith('/labels')), 'labelled when opened');
});

test('feedback: only signed-in GitHub accounts, from allowed pages, with a real PNG', async () => {
  const gh = fakeGithub(), send = (body, o) => handle(fbReq(body, o), FB_ENV, gh.fetchMock);
  assert.equal((await send({ what: 'hi' }, { token: '' })).status, 401, 'no sign-in, no feedback');
  assert.equal((await send({ what: 'hi' }, { token: 'ghu_forged' })).status, 401, 'a token GitHub does not accept');
  assert.equal((await send({ what: 'hi' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await send({ what: '   ' })).status, 400, 'an empty report');
  assert.equal((await send({ what: 'hi', screenshot: Buffer.from('<svg/>').toString('base64') })).status, 400, 'not a PNG');
  assert.equal((await send({ what: 'hi', screenshot: Buffer.concat([PNG, Buffer.alloc(4.1 * 1024 * 1024)]).toString('base64') })).status, 413);
  assert.ok(!gh.calls.some((c) => c.p.endsWith('/issues')), 'none of these opened an issue');
  const pre = await handle(fbReq(null, { method: 'OPTIONS' }), FB_ENV, gh.fetchMock);
  assert.equal(pre.status, 204); assert.match(pre.headers.get('access-control-allow-headers'), /authorization/);
  assert.equal((await handle(fbReq({ what: 'hi' }), env, gh.fetchMock)).status, 503, 'not set up without FEEDBACK_TOKEN');
  const limited = await handle(fbReq({ what: 'hi' }), { ...FB_ENV, FEEDBACK_LIMIT: { limit: async ({ key }) => ({ success: key !== 'reporter' }) } }, gh.fetchMock);
  assert.equal(limited.status, 429, 'the rate limit is per GitHub account');
});
