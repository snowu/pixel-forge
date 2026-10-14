#!/usr/bin/env node
// One-click GitHub App setup for spritewright sign-in, using GitHub's "app manifest" flow.
//   node worker/create-app.mjs [--name spritewright] [--worker https://spritewright-auth.<you>.workers.dev] [--port 8737]
// 1. Opens a local page that sends a pre-filled app definition to github.com (you only press "Create GitHub App").
// 2. GitHub redirects back here with a one-time code; the script converts it into the app's credentials,
//    writes the Client ID into wrangler.toml, stores the client secret as a Worker secret (it is never printed), and redeploys.
// 3. It prints the link to install the app on your repositories.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const NAME = arg('--name', 'spritewright');
const WORKER = (arg('--worker', 'https://spritewright-auth.zancato-t.workers.dev')).replace(/\/$/, '');
const PORT = +arg('--port', '8737');
const API = process.env.GITHUB_API || 'https://api.github.com';
const DRY = process.argv.includes('--dry-run'); // tests: do not call wrangler
const state = crypto.randomBytes(16).toString('hex');

export const manifest = (name, worker, port) => ({
  name,
  url: 'https://snowu.github.io/spritewright/',
  description: 'Sign in to spritewright, the pixel art editor, to edit sprites in your repositories and propose pull requests.',
  hook_attributes: { url: worker + '/health', active: false },
  redirect_url: `http://localhost:${port}/done`,
  callback_urls: [worker + '/callback'],
  public: true,
  request_oauth_on_install: false,
  default_permissions: { contents: 'write', pull_requests: 'write', issues: 'write', metadata: 'read' },
  default_events: [],
});

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (body) => `<!doctype html><meta charset="utf-8"><title>spritewright setup</title><body style="font:15px system-ui;background:#07090b;color:#d6e4dc;max-width:640px;margin:40px auto;line-height:1.5">${body}</body>`;

function run(cmd, args, input) {
  if (DRY) return { status: 0, stdout: '', stderr: '' };
  return spawnSync(cmd, args, { cwd: here, input, encoding: 'utf8', timeout: 180000 });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/') {
    const m = JSON.stringify(manifest(NAME, WORKER, PORT));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(page(`<h2>Create the spritewright GitHub App</h2><p>You will be sent to GitHub with everything filled in. Check the name (it must be unique on GitHub) and press <b>Create GitHub App</b>.</p>
      <form id="f" action="https://github.com/settings/apps/new?state=${state}" method="post"><input type="hidden" name="manifest" value="${esc(m)}"><button style="font-size:16px;padding:10px 16px">Continue to GitHub</button></form>
      <script>setTimeout(() => document.getElementById('f').submit(), 800)</script>`));
  }
  if (url.pathname === '/done') {
    const code = url.searchParams.get('code');
    if (url.searchParams.get('state') !== state || !/^[\w-]+$/.test(code || '')) { res.writeHead(400, { 'content-type': 'text/plain' }); return res.end('This link is not from this setup run. Start again.'); }
    let app;
    try {
      const r = await fetch(`${API}/app-manifests/${code}/conversions`, { method: 'POST', headers: { accept: 'application/vnd.github+json', 'user-agent': 'spritewright-setup' } });
      app = await r.json();
      if (!r.ok || !app.client_id || !app.client_secret) throw new Error((app && app.message) || r.status);
    } catch (e) { res.writeHead(500, { 'content-type': 'text/plain' }); console.error('Could not finish with GitHub:', e.message); res.end('GitHub did not return the app credentials: ' + e.message); return; }
    // 1. Client ID (public) into wrangler.toml
    const toml = path.join(here, 'wrangler.toml');
    fs.writeFileSync(toml, fs.readFileSync(toml, 'utf8').replace(/GITHUB_CLIENT_ID = ".*"/, `GITHUB_CLIENT_ID = "${app.client_id}"`));
    // 2. Client secret straight into the Worker's secrets (never printed or written to disk)
    const sec = run('npx', ['--yes', 'wrangler@4', 'secret', 'put', 'GITHUB_CLIENT_SECRET'], app.client_secret + '\n');
    const dep = sec.status === 0 ? run('npx', ['--yes', 'wrangler@4', 'deploy']) : { status: 1, stderr: 'skipped' };
    const ok = sec.status === 0 && dep.status === 0;
    const install = `${app.html_url}/installations/new`;
    console.log(`\nGitHub App "${app.slug}" created (Client ID ${app.client_id}).`);
    console.log(ok ? 'Client secret stored in the Worker and the Worker redeployed.' : 'Storing the secret or deploying failed:\n' + (sec.stderr || '') + (dep.stderr || ''));
    console.log(`Next: install it on your repositories: ${install}\n`);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page(`<h2>${ok ? 'Done' : 'Almost done'}</h2><p>App <b>${esc(app.slug)}</b> created. Client ID <code>${esc(app.client_id)}</code>.</p>
      <p>${ok ? 'The secret is stored in the sign-in Worker, which has been redeployed.' : 'Storing the secret or redeploying failed: see the terminal.'}</p>
      <p><b>Last step:</b> <a style="color:#39ff7a" href="${esc(install)}">install the app on the repositories</a> your artists will edit (for example your game).</p>
      <p style="color:#7f948a">GitHub also generated a private key for the app; spritewright does not use it and it was not saved.</p>`));
    setTimeout(() => { server.close(); process.exit(ok ? 0 : 1); }, 300);
    return;
  }
  res.writeHead(404); res.end();
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, '127.0.0.1', () => console.log(`Open this in your browser (Windows or Linux both work):\n\n  http://localhost:${PORT}/\n\nWaiting for GitHub...`));
}
export { server, state };
