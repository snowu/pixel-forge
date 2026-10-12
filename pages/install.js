/* Install banner: invite installation when the browser fires beforeinstallprompt.
   Shows at most once per 30-day cooldown, never when already installed (standalone).
   Chromium-only path: other browsers never fire the event, so nothing renders there. */
(() => {
  'use strict';
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
    });
  }
  const KEY = 'pf:installDismiss', COOLDOWN = 30 * 24 * 3600 * 1000, DELAY = 1200;
  let deferred = null, scheduled = false;

  const standalone = () =>
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    (window.navigator && window.navigator.standalone === true);
  const dismissed = () => {
    try {
      const t = Number(JSON.parse(localStorage.getItem(KEY) || '0'));
      return Date.now() - t < COOLDOWN;
    } catch { return false; }
  };
  const stamp = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch {} };

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
    el.querySelector('[data-install]').addEventListener('click', async () => {
      try {
        if (deferred && typeof deferred.prompt === 'function') {
          await deferred.prompt();
          if (deferred.userChoice) await deferred.userChoice.catch(() => {});
        }
      } catch {}
      stamp(Date.now() + COOLDOWN * 365 * 100); // asked: stay quiet
      deferred = null;
      el.remove();
    });
    el.querySelector('[data-dismiss]').addEventListener('click', () => {
      stamp(Date.now());
      deferred = null;
      el.remove();
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
    try { e.preventDefault(); } catch {}
    deferred = e;
    maybe();
  });
  window.addEventListener('appinstalled', () => {
    stamp(Date.now() + COOLDOWN * 365 * 100);
    deferred = null;
    const el = document.querySelector('#installBanner');
    if (el) el.remove();
  });
})();
