importScripts('/vendor/scram/scramjet.all.js', '/transport-compat.js');
const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();
installRequestBodyCompatibility(scramjet.client);
// Scramjet v1 persists its cookie jar as an object, but CookieStore.load only
// restores strings (its object branch returns without assigning the jar).
// Normalize before the constructor's asynchronous IndexedDB restore finishes.
if (scramjet.cookieStore?.load) {
  const load = scramjet.cookieStore.load.bind(scramjet.cookieStore);
  scramjet.cookieStore.load = value => load(typeof value === 'string' ? value : JSON.stringify(value));
}
// Failure capabilities stay in the worker. A destination cannot trigger recovery
// by displaying an error-looking page or fabricating a postMessage.
const failures = new Map();
self.addEventListener('message', event => {
  if (event.data?.type !== 'proxy-failure' || !event.ports?.[0]) return;
  const source = event.source && new URL(event.source.url);
  if (!source || source.origin !== self.location.origin || !['/', '/index.html'].includes(source.pathname)) return;
  const item = failures.get(event.data.id);
  failures.delete(event.data.id);
  event.ports[0].postMessage(item && item.until > Date.now() ? item.failure : null);
});
function unavailable(failure) {
  for (const [id, item] of failures) if (item.until <= Date.now()) failures.delete(id);
  if (failures.size >= 256) failures.delete(failures.keys().next().value);
  const id = crypto.randomUUID();
  failures.set(id, {until:Date.now()+60000, failure});
  return new Response(`<!doctype html><html><head><meta name="robots" content="noindex"><meta charset="utf-8"><title>Connecting</title></head><body style="background:#080b13;color:#aab3c2;font:16px system-ui"><p id="shifter-connection-failure" data-id="${id}">Connecting to the website…</p></body></html>`, {
    // The enclosing runtime enforces the configured ancestor allowlist. This
    // inert child document must also work beneath that cross-origin embedder.
    status:503, headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store', 'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'"},
  });
}
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  event.respondWith((async () => {
    // Runtime/reset assets must remain reachable after reset clears the engine DB.
    const url = new URL(event.request.url);
    // v1 injects the WASM URL as a script and serves a JavaScript wrapper for it.
    // Passing that script straight to the static server breaks destination JS.
    const wasmScript = url.pathname === '/vendor/scram/scramjet.wasm.wasm' && event.request.destination === 'script';
    if (url.origin !== self.location.origin || (!url.pathname.startsWith('/service/') && !wasmScript)) return fetch(event.request);
    await scramjet.loadConfig();
    if (!scramjet.route(event)) return fetch(event.request);
    if (event.request.mode !== 'navigate') return scramjet.fetch(event);
    let transportFailure, destination, responded = false;
    // Per-request facade keeps concurrent frames and subresources independent.
    const context = Object.create(scramjet);
    // Cookie acknowledgements share the engine's monotonically increasing token.
    context.dispatch = scramjet.dispatch?.bind(scramjet);
    context.dispatchEvent = item => {
      if (item.type === 'request') destination = String(item.url);
      if (item.type === 'handleResponse') responded = true;
      return scramjet.dispatchEvent(item);
    };
    context.client = new Proxy(scramjet.client, {get(target, name) {
      if (name === 'fetch') return async (...args) => {
        try { return await target.fetch(...args); }
        catch (error) {
          transportFailure = /WebSocketConnectFailed|[Ww]isp [Ww]eb[Ss]ocket|[Ww]eb[Ss]ocket.*(?:closed|connect)/.test(String(error)) ? 'websocket' : 'upstream';
          throw error;
        }
      };
      const value = target[name];
      return typeof value === 'function' ? value.bind(target) : value;
    }});
    try {
      const response = await context.fetch(event);
      // Genuine website responses (including 4xx/5xx/CAPTCHA) pass unchanged.
      if (responded) return response;
    } catch { /* Suppress engine diagnostics in the destination document. */ }
    return unavailable({reason:transportFailure || 'runtime', url:destination, method:event.request.method});
  })());
});
