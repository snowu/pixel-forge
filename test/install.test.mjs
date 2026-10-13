import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {versionPages} from '../scripts/version-pages.mjs';
const code = fs.readFileSync(new URL('../pages/install.js', import.meta.url), 'utf8');
const KEY = 'spritewright:installDismiss:/spritewright/';
function browser({storage = new Map(), standalone = false, scope = '/spritewright/', blockedStorage = false} = {}) {
  const nodes = new Map(), events = new Map(), timers = [];
  class Element {
    children = []; listeners = new Map(); style = {};
    setAttribute() {}
    set innerHTML(value) { if (value.includes('data-install')) { this.install = new Element(); this.dismiss = new Element(); } }
    appendChild(el) { this.children.push(el); if (el.id) nodes.set('#' + el.id, el); }
    querySelector(selector) { return selector === '[data-install]' ? this.install : this.dismiss; }
    addEventListener(type, fn) { this.listeners.set(type, fn); }
    remove() { nodes.delete('#' + this.id); }
    click() { return this.listeners.get('click')(); }
  }
  nodes.set('body > header', new Element());
  const window = {navigator: {}, matchMedia: () => ({matches: standalone}), addEventListener: (type, fn) => events.set(type, fn)};
  const document = {baseURI: `https://snowu.github.io${scope}`, body: new Element(), querySelector: (s) => nodes.get(s), createElement: () => new Element()};
  vm.runInNewContext(code, {window, document, navigator: {}, URL, Date, setTimeout: (fn) => timers.push(fn), localStorage: {
    getItem: k => { if (blockedStorage) throw Error('blocked'); return storage.get(k) ?? null; },
    setItem: (k,v) => { if (blockedStorage) throw Error('blocked'); storage.set(k,v); },
    removeItem: k => { if (blockedStorage) throw Error('blocked'); storage.delete(k); },
  }});
  return {storage, get: s => nodes.get(s), emit: type => events.get(type)?.(), tick: () => timers.splice(0).forEach(fn => fn()), eligible(outcome = 'accepted', fail = false) {
    const event = {calls: 0, prevented: false, preventDefault() { this.prevented = true; }, async prompt() { this.calls++; if (fail) throw Error('prompt failed'); }, userChoice: Promise.resolve({outcome})};
    events.get('beforeinstallprompt')(event); return event;
  }};
}
test('a previous install cannot permanently hide reinstall controls', async () => {
  const storage = new Map([['pf:installDismiss', String(Date.now() + 1e15)]]);
  const b = browser({storage}), e = b.eligible(); b.tick();
  assert.ok(b.get('#installBanner')); assert.ok(b.get('#installApp')); assert.equal(e.prevented, true);
  await b.get('#installBanner').install.click(); assert.equal(e.calls, 1); assert.equal(storage.has(KEY), false);
  b.emit('appinstalled'); assert.equal(b.get('#installApp'), undefined);
  const afterUninstall = browser({storage}); afterUninstall.eligible(); afterUninstall.tick();
  assert.ok(afterUninstall.get('#installBanner')); assert.ok(afterUninstall.get('#installApp'));
});
test('Later dismisses only the banner; explicit install still works with the saved event', async () => {
  const b = browser(), e = b.eligible(); b.tick();
  b.get('#installBanner').dismiss.click();
  assert.equal(b.get('#installBanner'), undefined); assert.ok(b.get('#installApp'));
  await b.get('#installApp').click(); assert.equal(e.calls, 1); assert.equal(b.storage.has(KEY), false);
});
test('a recent dismissal cools down the banner but not the header button', async () => {
  const b = browser({storage: new Map([[KEY, String(Date.now())]])}); b.eligible('dismissed'); b.tick();
  assert.equal(b.get('#installBanner'), undefined); assert.ok(b.get('#installApp'));
  await b.get('#installApp').click(); const stamp = Number(b.storage.get(KEY));
  assert.ok(stamp <= Date.now() && stamp > Date.now() - 10000);
  b.eligible(); b.tick(); assert.equal(b.get('#installBanner'), undefined); assert.ok(b.get('#installApp'));
});
test('future timestamps and another Pages app cannot suppress this app', () => {
  for (const storage of [new Map([[KEY, String(Date.now() + 1e15)]]), new Map([['spritewright:installDismiss:/other-app/', String(Date.now())]])]) {
    const b = browser({storage}); b.eligible(); b.tick(); assert.ok(b.get('#installBanner'));
  }
});
test('standalone mode does not show install controls or suppress the browser event', () => {
  const b = browser({standalone: true}), e = b.eligible(); b.tick();
  assert.equal(e.prevented, false); assert.equal(b.get('#installApp'), undefined); assert.equal(b.get('#installBanner'), undefined);
});
test('failed prompts and unavailable storage do not block future attempts', async () => {
  const b = browser({blockedStorage: true}), first = b.eligible('accepted', true); b.tick();
  await b.get('#installApp').click(); assert.equal(first.calls, 1);
  const second = b.eligible(); b.tick(); assert.ok(b.get('#installBanner'));
  await b.get('#installApp').click(); assert.equal(second.calls, 1);
});
test('content changes refresh install metadata without changing app identity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritewright-pages-'));
  try {
    const manifest = JSON.parse(fs.readFileSync(new URL('../pages/manifest.webmanifest', import.meta.url)));
    fs.mkdirSync(path.join(dir, 'icons'));
    for (const icon of manifest.icons) fs.writeFileSync(path.join(dir, icon.src), icon.src);
    fs.writeFileSync(path.join(dir, 'icons/apple-touch-icon.png'), 'apple');
    fs.writeFileSync(path.join(dir, 'install.js'), 'install-v1');
    fs.writeFileSync(path.join(dir, 'manifest.webmanifest'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir, 'index.html'), '<link rel="manifest" href="manifest.webmanifest"><link rel="apple-touch-icon" href="icons/apple-touch-icon.png"><script src="install.js" defer></script>');
    versionPages(dir);
    const firstManifest = fs.readFileSync(path.join(dir, 'manifest.webmanifest'), 'utf8');
    const firstHTML = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    versionPages(dir); assert.equal(fs.readFileSync(path.join(dir, 'manifest.webmanifest'), 'utf8'), firstManifest); assert.equal(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), firstHTML);
    fs.writeFileSync(path.join(dir, 'icons/icon-512.png'), 'new artwork');
    fs.writeFileSync(path.join(dir, 'install.js'), 'install-v2');
    versionPages(dir);
    const updated = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.webmanifest'))), previous = JSON.parse(firstManifest);
    for (const key of ['id','start_url','scope']) assert.equal(updated[key], manifest[key]);
    assert.notEqual(updated.icons[1].src, previous.icons[1].src); assert.equal(updated.icons[0].src, previous.icons[0].src);
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    for (const asset of ['manifest.webmanifest','install.js']) {
      const get = s => s.match(new RegExp(asset.replace('.', '\\.') + '\\?v=([a-f0-9]+)'))[1];
      assert.notEqual(get(html), get(firstHTML));
    }
    for (const icon of updated.icons) assert.ok(fs.existsSync(path.join(dir, icon.src.split('?')[0])));
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
