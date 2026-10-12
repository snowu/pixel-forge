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
