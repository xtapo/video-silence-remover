/* Bat cross-origin isolation tren GitHub Pages (khong the tu dat HTTP header).
 * Script nay chay o CA HAI che do: script cua trang va service worker.
 * Nho do trinh duyet cho phep SharedArrayBuffer -> ffmpeg.wasm chay da luong.
 * Dua tren y tuong cua coi-serviceworker (MIT).
 */
(function () {
  if (typeof window === 'undefined') {
    // ----- Che do service worker -----
    self.addEventListener('install', function () { self.skipWaiting(); });
    self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
    self.addEventListener('fetch', function (event) {
      var req = event.request;
      if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
      event.respondWith(
        fetch(req)
          .then(function (res) {
            if (res.status === 0) return res;
            var headers = new Headers(res.headers);
            headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
            headers.set('Cross-Origin-Opener-Policy', 'same-origin');
            headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
            return new Response(res.body, { status: res.status, statusText: res.statusText, headers: headers });
          })
          .catch(function (e) { console.error('[coi] ' + e); })
      );
    });
    return;
  }

  // ----- Che do trang -----
  if (window.crossOriginIsolated) return;
  if (!('serviceWorker' in navigator)) return;
  var src = (document.currentScript && document.currentScript.src) || 'coi-serviceworker.js';

  navigator.serviceWorker.register(src).then(function (reg) {
    if (!reg) return;
    if (reg.active && !navigator.serviceWorker.controller) window.location.reload();
  }).catch(function (e) { console.warn('[coi] khong dang ky duoc service worker:', e); });

  var reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });
})();
