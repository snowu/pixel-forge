import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the manifest asks for exactly the permissions and URLs sign-in needs', async () => {
  const { manifest } = await import('../worker/create-app.mjs');
  const m = manifest('spritewright', 'https://w.example', 8737);
  assert.deepEqual(m.default_permissions, { contents: 'write', pull_requests: 'write', issues: 'write', metadata: 'read' });
  assert.deepEqual(m.callback_urls, ['https://w.example/callback']);
  assert.equal(m.redirect_url, 'http://localhost:8737/done');
  assert.equal(m.hook_attributes.active, false);
  assert.deepEqual(m.default_events, []);
});

test('end to end with a fake GitHub: code -> credentials -> Client ID in wrangler.toml, secret never printed', async () => {
  const toml = path.join(root, 'worker/wrangler.toml'), before = fs.readFileSync(toml, 'utf8');
  const fake = http.createServer((req, res) => { if (req.method === 'POST' && req.url === '/app-manifests/abc123/conversions') { res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ slug: 'spritewright-x', client_id: 'Iv23liTEST', client_secret: 'SUPER_SECRET_VALUE', html_url: 'https://github.com/apps/spritewright-x', pem: '---' })); } else { res.writeHead(404); res.end('{}'); } });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const port = 18000 + Math.floor(Math.random() * 1000);
  const child = spawn('node', [path.join(root, 'worker/create-app.mjs'), '--port', String(port), '--dry-run'], { env: { ...process.env, GITHUB_API: `http://127.0.0.1:${fake.address().port}` } });
  let out = ''; child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
  try {
    for (let i = 0; i < 50 && !out.includes('Waiting'); i++) await new Promise((r) => setTimeout(r, 100));
    const home = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(home, /action="https:\/\/github\.com\/settings\/apps\/new\?state=[0-9a-f]{32}"/);
    const st = /state=([0-9a-f]{32})/.exec(home)[1];
    assert.equal((await fetch(`http://127.0.0.1:${port}/done?code=abc123&state=wrong`)).status, 400, 'a code without our state is refused');
    const done = await (await fetch(`http://127.0.0.1:${port}/done?code=abc123&state=${st}`)).text();
    assert.match(done, /Iv23liTEST/); assert.match(done, /apps\/spritewright-x\/installations\/new/);
    await new Promise((r) => child.on('exit', r));
    assert.match(fs.readFileSync(toml, 'utf8'), /GITHUB_CLIENT_ID = "Iv23liTEST"/);
    assert.ok(!out.includes('SUPER_SECRET_VALUE') && !done.includes('SUPER_SECRET_VALUE') && !fs.readFileSync(toml, 'utf8').includes('SUPER_SECRET_VALUE'), 'the secret is not printed, shown or written');
  } finally { fs.writeFileSync(toml, before); fake.close(); child.kill(); }
});
