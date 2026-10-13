/* Install banner: invite installation when the browser fires beforeinstallprompt.
   Automatic banner respects a 30-day dismissal; an explicit Install button stays available.
   Never promotes installation in standalone mode.
   Chromium-only path: other browsers never fire the event, so nothing renders there. */
(() => {
  'use strict';
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
    });
  }
  // Ignore the old origin-wide key: it also stored effectively permanent install stamps.
  const KEY = 'spritewright:installDismiss:' + new URL('.', document.baseURI).pathname, COOLDOWN = 30 * 24 * 3600 * 1000, DELAY = 1200;
  let deferred = null, scheduled = false;

  const standalone = () =>
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    (window.navigator && window.navigator.standalone === true);
  const dismissed = () => {
    try {
      const t = Number(JSON.parse(localStorage.getItem(KEY) || '0'));
      return Number.isFinite(t) && t > 0 && t <= Date.now() && Date.now() - t < COOLDOWN;
    } catch { return false; }
  };
  const stamp = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch {} };

  const clearDismissal = () => { try { localStorage.removeItem(KEY); } catch {} };
  function removeUI() {
    document.querySelector('#installBanner')?.remove();
    document.querySelector('#installApp')?.remove();
  }
  async function install() {
    const event = deferred;
    if (!event) return;
    deferred = null; // Each browser event may only be prompted once.
    removeUI();
    try {
      const choice = await event.prompt();
      const result = event.userChoice ? await event.userChoice : choice;
      if (result?.outcome === 'dismissed') stamp(Date.now());
      else clearDismissal();
    } catch {
      // A failed prompt must not suppress a later valid install event.
      clearDismissal();
    }
  }
  function offerInstall() {
    if (standalone() || !deferred || document.querySelector('#installApp')) return;
    const header = document.querySelector('body > header');
    if (!header) return;
    const button = document.createElement('button');
    button.id = 'installApp';
    button.type = 'button';
    button.textContent = 'Install app';
    button.style.cssText = 'min-height:44px;padding:8px 12px;background:#2a1b45;color:#e6dcf7;border:1px solid #b98cff;font:inherit;cursor:pointer';
    button.addEventListener('click', install);
    header.appendChild(button);
  }

  function show() {
    if (document.querySelector('#installBanner') || !deferred || standalone() || dismissed()) return;
    // Modal editor dialogs occupy the browser's top layer; wait until they close.
    if (document.querySelector('dialog[open]')) { maybe(); return; }
    const el = document.createElement('div');
    el.id = 'installBanner';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Install spritewright');
    el.innerHTML =
      '<span>Install spritewright for fullscreen editing + offline</span>' +
      '<button type="button" class="btn primary" data-install>Install</button>' +
      '<button type="button" class="btn" data-dismiss aria-label="Dismiss">Later</button>';
    el.querySelector('[data-install]').addEventListener('click', install);
    el.querySelector('[data-dismiss]').addEventListener('click', () => {
      stamp(Date.now());
      el.remove(); // Keep the event for the explicit header button.
    });
    const style = document.createElement('style');
    style.textContent = '#installBanner{position:fixed;bottom:calc(16px + env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);z-index:10000;display:flex;align-items:center;gap:12px;padding:12px 16px;background:#150e24;color:#e6dcf7;border:1px solid #b98cff;box-shadow:0 0 26px -6px #b98cff;font:12px ui-monospace,monospace;width:max-content;max-width:calc(100vw - 32px);box-sizing:border-box;flex-wrap:wrap}#installBanner button{min-height:44px;padding:8px 14px;background:#2a1b45;color:#e6dcf7;border:1px solid #b98cff;font:inherit;cursor:pointer}#installBanner [data-install]{background:#b98cff;color:#12081f}';
    el.appendChild(style);
    document.body.appendChild(el);
  }

  function maybe() {
    if (scheduled || document.querySelector('#installBanner')) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; show(); }, DELAY);
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    if (standalone()) return;
    try { e.preventDefault(); } catch {}
    deferred = e;
    offerInstall();
    maybe();
  });
  window.addEventListener('appinstalled', () => {
    clearDismissal();
    deferred = null;
    removeUI();
  });
})();
