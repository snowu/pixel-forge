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
    button.className = 'sw-install-btn';
    button.title = 'Install spritewright as an app: fullscreen editing, works offline';
    button.addEventListener('click', install);
    ensureStyle();
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
      '<span>Install as an app <small>· fullscreen, offline</small></span>' +
      '<button type="button" data-install>Install</button>' +
      '<button type="button" data-dismiss aria-label="Not now" title="Not now">✕</button>';
    el.querySelector('[data-install]').addEventListener('click', install);
    el.querySelector('[data-dismiss]').addEventListener('click', () => {
      stamp(Date.now());
      el.remove(); // Keep the event for the explicit header button.
    });
    ensureStyle();
    document.body.appendChild(el);
  }
  /* A small toast in the bottom-right corner, out of the canvas's way; touch screens keep finger-sized buttons. */
  const STYLE = '#installBanner{position:fixed;right:calc(14px + env(safe-area-inset-right));bottom:calc(40px + env(safe-area-inset-bottom));z-index:10000;display:flex;align-items:center;gap:6px;padding:5px 5px 5px 10px;background:#150e24;color:#e6dcf7;border:1px solid #443070;box-shadow:0 8px 24px rgba(0,0,0,.5);font:11.5px/1.3 ui-monospace,monospace;max-width:calc(100vw - 28px);box-sizing:border-box}#installBanner small{color:#9a86c4;font-size:inherit}#installBanner button{min-height:26px;padding:2px 9px;background:transparent;color:#9a86c4;border:1px solid transparent;font:inherit;cursor:pointer}#installBanner button:hover{color:#e6dcf7;border-color:#443070}#installBanner [data-install]{background:#b98cff;border-color:#b98cff;color:#12081f;font-weight:700}#installBanner [data-install]:hover{background:#cba8ff;color:#12081f}@media (pointer:coarse){#installBanner{left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom))}#installBanner>span{flex:1}#installBanner button{min-height:40px;padding:4px 14px}}' +
    '.sw-install-btn{min-height:28px;padding:3px 10px;background:transparent;color:#9a86c4;border:1px solid #443070;font:inherit;font-size:12px;cursor:pointer}.sw-install-btn:hover{color:#e6dcf7;border-color:#b98cff}@media (pointer:coarse){.sw-install-btn{min-height:40px}}';

  function ensureStyle() {
    if (document.querySelector('#installStyle')) return;
    const style = document.createElement('style');
    style.id = 'installStyle';
    style.textContent = STYLE;
    (document.head || document.body).appendChild(style);
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
