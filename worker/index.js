// spritewright-auth: the tiny service behind "Sign in with GitHub".
//
// Why it exists: GitHub exchanges the login code for an access token with a client SECRET, and that endpoint has no CORS, so a static page
// cannot do it alone. This Worker holds the secret, does the exchange, hands the token to the page that opened the popup, and forgets it.
// It stores nothing and logs nothing.
//
//   GET  /login?origin=<page origin>&nonce=<random>   -> redirects to github.com to sign in
//   GET  /callback?code&state                          -> exchanges the code, then posts {type:'pf-auth', nonce, token, refresh_token} to the opener page
//   POST /refresh  {"refresh_token": "..."}            -> a new access token (GitHub App tokens last 8 hours, the refresh token ~6 months),
//                                                        so the page keeps people signed in without another popup. Only for ALLOWED_ORIGINS.
//   POST /feedback  {kind, what, details, screenshot}  -> the editor's Feedback button, for people signed in with GitHub (Authorization:
//                                                        Bearer <their token>, checked against GitHub). The screenshot (a base64 PNG) is
//                                                        committed to the FEEDBACK_BRANCH of FEEDBACK_REPO with FEEDBACK_TOKEN, which never
//                                                        leaves the Worker. The issue is opened there with the reporter's own token, so it is
//                                                        theirs (needs the app's Issues: write); if GitHub refuses, FEEDBACK_TOKEN opens it.
//   GET  /health
//
// Config (wrangler.toml / secrets):
//   GITHUB_CLIENT_ID      public id of the GitHub App (or OAuth App)
//   GITHUB_CLIENT_SECRET  secret   (wrangler secret put GITHUB_CLIENT_SECRET)
//   STATE_SECRET          secret, any long random string, signs the state so it cannot be forged (wrangler secret put STATE_SECRET)
//   ALLOWED_ORIGINS       comma separated list of page origins allowed to sign in, e.g. https://snowu.github.io
//   ALLOW_LOOPBACK        optional "true": also allow http://localhost:* and http://127.0.0.1:* (the local `spritewright` server)
//   OAUTH_SCOPE           optional: only for an OAuth App (a GitHub App uses its own permissions), e.g. "public_repo"
//   FEEDBACK_TOKEN        secret, enables /feedback: a fine-grained token for FEEDBACK_REPO with Contents + Issues read and write
//   FEEDBACK_REPO         where feedback goes (default snowu/spritewright); FEEDBACK_BRANCH holds the screenshots (default feedback-screenshots)
//   FEEDBACK_LIMIT        optional rate limiting binding (wrangler.toml [[ratelimits]]): sends per signed-in person

const enc = new TextEncoder();
const MAX_AGE_MS = 10 * 60 * 1000;
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const key = (secret, usage) => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);

export async function signState(env, payload) {
  const body = b64u(enc.encode(JSON.stringify(payload)));
  return body + '.' + b64u(await crypto.subtle.sign('HMAC', await key(env.STATE_SECRET, 'sign'), enc.encode(body)));
}
export async function verifyState(env, state, now = Date.now()) {
  const [body, sig] = String(state || '').split('.');
  if (!body || !sig) return null;
  let ok = false;
  try { ok = await crypto.subtle.verify('HMAC', await key(env.STATE_SECRET, 'verify'), unb64u(sig), enc.encode(body)); } catch { return null; }
  if (!ok) return null;
  try { const p = JSON.parse(new TextDecoder().decode(unb64u(body))); return now - p.t <= MAX_AGE_MS && now >= p.t - 1000 ? p : null; } catch { return null; }
}

const allowed = (env) => String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
// ALLOW_LOOPBACK="true" also allows http://localhost:<any port> and http://127.0.0.1:<any port>, for `npx spritewright` on someone's machine.
const isAllowed = (env, origin) => allowed(env).includes(origin) || (env.ALLOW_LOOPBACK === 'true' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(origin));
const text = (msg, status = 400) => new Response(msg, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
const SAFE = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'" };

/** The popup's last page: hand the result to the opener (only to the verified origin) and close. */
function result(data, origin) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c'), target = JSON.stringify(origin).replace(/</g, '\\u003c');
  return new Response(`<!doctype html><meta charset="utf-8"><title>spritewright sign-in</title><p>${data.error ? 'Sign-in failed. You can close this window.' : 'Signed in. You can close this window.'}</p><script>(function(){try{window.opener&&window.opener.postMessage(${json},${target})}catch(e){}window.close()})()</script>`, { headers: SAFE });
}

export async function handle(request, env, doFetch = fetch, now = Date.now()) {
  const url = new URL(request.url);
  if (url.pathname === '/refresh') return refresh(request, env, doFetch);
  if (url.pathname === '/feedback') return feedback(request, env, doFetch, now);
  if (request.method !== 'GET') return text('Method not allowed', 405);
  if (url.pathname === '/health') return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.STATE_SECRET) return text('The sign-in service is not configured.', 500);

  if (url.pathname === '/login') {
    const origin = url.searchParams.get('origin') || '', nonce = url.searchParams.get('nonce') || '';
    if (!isAllowed(env, origin)) return text('This site is not allowed to use the sign-in service.', 403);
    if (!/^[0-9a-f]{16,64}$/.test(nonce)) return text('Bad request', 400);
    const state = await signState(env, { o: origin, n: nonce, t: now });
    const gh = new URL('https://github.com/login/oauth/authorize');
    gh.searchParams.set('client_id', env.GITHUB_CLIENT_ID); gh.searchParams.set('redirect_uri', url.origin + '/callback'); gh.searchParams.set('state', state);
    if (env.OAUTH_SCOPE) gh.searchParams.set('scope', env.OAUTH_SCOPE);
    return Response.redirect(gh.toString(), 302);
  }

  if (url.pathname === '/callback') {
    const st = await verifyState(env, url.searchParams.get('state'), now);
    if (!st || !isAllowed(env, st.o)) return text('This sign-in link is invalid or has expired. Close this window and try again.', 400);
    const fail = (error) => result({ type: 'pf-auth', nonce: st.n, error }, st.o);
    if (url.searchParams.get('error')) return fail(url.searchParams.get('error_description') || url.searchParams.get('error'));
    const code = url.searchParams.get('code');
    if (!code) return fail('GitHub did not send a login code.');
    let data;
    try {
      const r = await doFetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'spritewright-auth' },
        body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: url.origin + '/callback' }) });
      data = await r.json();
    } catch { return fail('Could not reach GitHub. Try again.'); }
    if (!data || !data.access_token) return fail((data && (data.error_description || data.error)) || 'GitHub did not return a token.');
    return result({ type: 'pf-auth', nonce: st.n, token: data.access_token, expires_in: data.expires_in || null, refresh_token: data.refresh_token || null, refresh_token_expires_in: data.refresh_token_expires_in || null }, st.o);
  }
  return text('Not found', 404);
}

/** Trade a refresh token for a fresh access token. Called with fetch() from the page, so it answers CORS for allowed origins only. */
async function refresh(request, env, doFetch) {
  const origin = request.headers.get('origin') || '';
  if (!isAllowed(env, origin)) return text('This site is not allowed to use the sign-in service.', 403);
  const cors = { 'access-control-allow-origin': origin, vary: 'origin', 'cache-control': 'no-store' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' } });
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return new Response('The sign-in service is not configured.', { status: 500, headers: cors });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
  let rt = '';
  try { rt = String((await request.json()).refresh_token || ''); } catch { /* handled below */ }
  if (!rt || rt.length > 512) return json({ error: 'Missing refresh token.' }, 400);
  let data;
  try {
    const r = await doFetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'spritewright-auth' },
      body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: rt }) });
    data = await r.json();
  } catch { return json({ error: 'Could not reach GitHub. Try again.' }, 502); }
  if (!data || !data.access_token) return json({ error: (data && (data.error_description || data.error)) || 'GitHub did not return a token.' }, 401);
  return json({ token: data.access_token, expires_in: data.expires_in || null, refresh_token: data.refresh_token || null, refresh_token_expires_in: data.refresh_token_expires_in || null });
}

/* ---------- feedback from the editor ---------- */
const FEEDBACK_KINDS = { bug: 'Bug', idea: 'Idea', other: 'Feedback' };
const MAX_SHOT = 4 * 1024 * 1024, MAX_WHAT = 4000, MAX_DETAILS = 6000;
const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
/** A starting title: the kind, then the first ten words (capped in characters too: a pasted run with no spaces is one word). */
export function feedbackTitle(text, kind = 'bug', n = 10, max = 100) {
  const words = String(text).trim().split(/\s+/).filter(Boolean), t = (FEEDBACK_KINDS[kind] || FEEDBACK_KINDS.other) + ': ' + (words.length > n ? words.slice(0, n).join(' ') + '…' : words.join(' '));
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
export function feedbackBody({ what, details, image, login }) {
  return [what, '', image ? `![Screenshot](${image})` : '_No screenshot._', '', '<details><summary>Details</summary>', '', details || '_none_', '', '</details>', '', '---', login ? `Sent from the spritewright editor by @${login}.` : 'Sent from the spritewright editor.'].join('\n');
}

/** Signed-in people only: the token they sign in with is checked against GitHub, so every report has a real account behind it. */
async function feedback(request, env, doFetch, now) {
  const origin = request.headers.get('origin') || '';
  if (!isAllowed(env, origin)) return text('This site is not allowed to send feedback.', 403);
  const cors = { 'access-control-allow-origin': origin, vary: 'origin', 'cache-control': 'no-store' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type, authorization', 'access-control-max-age': '86400' } });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  if (!env.FEEDBACK_TOKEN) return json({ error: 'Feedback is not set up on this service.' }, 503);
  const userToken = /^Bearer (\S{1,512})$/.exec(request.headers.get('authorization') || '');
  if (!userToken) return json({ error: 'Sign in with GitHub to send feedback.' }, 401);
  const gh = (path, token, init = {}) => doFetch('https://api.github.com' + path, { ...init, headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'spritewright-auth', authorization: 'Bearer ' + token, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
  let login = '';
  try { const r = await gh('/user', userToken[1]); if (r.ok) login = String((await r.json()).login || ''); } catch { return json({ error: 'Could not reach GitHub. Try again.' }, 502); }
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) return json({ error: 'GitHub did not accept your sign-in: sign in again.' }, 401);
  if (env.FEEDBACK_LIMIT) { try { if (!(await env.FEEDBACK_LIMIT.limit({ key: login })).success) return json({ error: 'That is a lot of feedback at once: try again in a minute.' }, 429); } catch { /* no limiter: carry on */ } }

  let b;
  try { b = await request.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  const what = String((b && b.what) || '').trim().slice(0, MAX_WHAT), details = String((b && b.details) || '').slice(0, MAX_DETAILS), kind = FEEDBACK_KINDS[b && b.kind] ? b.kind : 'other';
  if (!what) return json({ error: 'Write what happened first.' }, 400);
  let shot = null;
  if (b.screenshot) {
    try { shot = Uint8Array.from(atob(String(b.screenshot)), (c) => c.charCodeAt(0)); } catch { return json({ error: 'The screenshot is not a PNG.' }, 400); }
    if (shot.length > MAX_SHOT) return json({ error: 'The screenshot is too big.' }, 413);
    if (!PNG_SIG.every((v, i) => shot[i] === v)) return json({ error: 'The screenshot is not a PNG.' }, 400);
  }

  const repo = env.FEEDBACK_REPO || 'snowu/spritewright', branch = env.FEEDBACK_BRANCH || 'feedback-screenshots', tok = env.FEEDBACK_TOKEN;
  const fail = async (r, what) => { let m = ''; try { m = (await r.json()).message || ''; } catch { /* not json */ } return json({ error: `GitHub refused to ${what} (${r.status}${m ? ': ' + m : ''}).` }, 502); };
  let image = null;
  try {
    if (shot) {
      // The branch only holds screenshots; it is made from the default branch the first time.
      let ref = await gh(`/repos/${repo}/git/ref/heads/${branch}`, tok);
      if (ref.status === 404) {
        const info = await gh(`/repos/${repo}`, tok); if (!info.ok) return fail(info, 'read the repository');
        const head = await gh(`/repos/${repo}/git/ref/heads/${encodeURIComponent((await info.json()).default_branch)}`, tok); if (!head.ok) return fail(head, 'read the default branch');
        ref = await gh(`/repos/${repo}/git/refs`, tok, { method: 'POST', body: JSON.stringify({ ref: 'refs/heads/' + branch, sha: (await head.json()).object.sha }) });
        if (!ref.ok && ref.status !== 422) return fail(ref, 'create the screenshot branch'); // 422: someone else just made it
      } else if (!ref.ok) return fail(ref, 'read the screenshot branch');
      const stamp = new Date(now).toISOString(), file = `feedback/${stamp.slice(0, 7)}/${stamp.slice(0, 19).replace(/[:T]/g, '-')}-${login}-${crypto.randomUUID().slice(0, 8)}.png`;
      let bin = ''; for (let i = 0; i < shot.length; i += 0x8000) bin += String.fromCharCode(...shot.subarray(i, i + 0x8000));
      const put = await gh(`/repos/${repo}/contents/${file}`, tok, { method: 'PUT', body: JSON.stringify({ message: `Feedback screenshot from @${login}`, content: btoa(bin), branch }) });
      if (!put.ok) return fail(put, 'store the screenshot');
      image = `https://raw.githubusercontent.com/${repo}/${(await put.json()).commit.sha}/${file}`;
    }
    // The issue is the reporter's own when their sign-in may open one (the GitHub App has Issues: write and is installed on FEEDBACK_REPO);
    // otherwise the service opens it for them. GitHub drops labels set by people without triage access, so the service adds the label after.
    const title = feedbackTitle(what, kind);
    let by = 'user', issue = await gh(`/repos/${repo}/issues`, userToken[1], { method: 'POST', body: JSON.stringify({ title, body: feedbackBody({ what, details, image }) }) });
    if ([401, 403, 404, 410].includes(issue.status)) {
      by = 'service'; issue = await gh(`/repos/${repo}/issues`, tok, { method: 'POST', body: JSON.stringify({ title, body: feedbackBody({ what, details, image, login }), labels: ['feedback'] }) });
    }
    if (!issue.ok) return fail(issue, 'open the issue');
    const made = await issue.json();
    if (by === 'user') { try { await gh(`/repos/${repo}/issues/${made.number}/labels`, tok, { method: 'POST', body: JSON.stringify({ labels: ['feedback'] }) }); } catch { /* the issue is there; the label is a nicety */ } }
    return json({ number: made.number, url: made.html_url, by });
  } catch { return json({ error: 'Could not reach GitHub. Try again.' }, 502); }
}

export default { fetch: (request, env) => handle(request, env) };
