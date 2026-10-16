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
// This is a browsing policy, not malware detection or server-side enforcement.
// Headers are checked before Scramjet reads/rewrites a BareMux response body.
const blockedFile = /\.(?:exe|dll|com|scr|msi|msp|msix|msixbundle|appx|appxbundle|bat|cmd|ps1|vbs|vbe|js|jse|wsf|wsh|hta|cpl|reg|lnk|chm|jar|apk|dmg|pkg|deb|rpm|iso|img|zip|rar|7z|tar|gz|bz2|xz|zst|cab)$/i;
const blockedMime = /^application\/(?:x-)?(?:msdownload|msdos-program|dosexec|portable-executable|msi|ms-installer|executable|sharedlib|mach-binary|apple-diskimage|apple-installer\+xml|java-archive|vnd\.android\.package-archive|vnd\.microsoft\.portable-executable|vnd\.ms-(?:cab-compressed|download|installer)|zip(?:-compressed)?|rar(?:-compressed)?|vnd\.rar|7z-compressed|tar|gtar|gzip|bzip2?|xz|zstd|compressed|debian-package|vnd\.debian\.binary-package|sh|bat|rpm)$/i;
const displayMime = /^(?:text\/(?:html|plain|css|javascript|xml)|application\/(?:xhtml\+xml|javascript|json|xml|pdf)|(?:image|audio|video)\/[a-z0-9.+-]+)$/i;
function downloadable(response, request, url = '') {
  // Redirect targets get their own check; no-body HTTP responses cannot download.
  if ([204,205,301,302,303,304,307,308].includes(response.status)) return false;
  const disposition = response.headers?.get('content-disposition')?.trim() || '';
  if (disposition && (!/^inline(?:\s*;|$)/i.test(disposition) || /,\s*attachment\b/i.test(disposition))) return true;
  const type = (response.headers?.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (blockedMime.test(type)) return true;
  const filenames = [...disposition.matchAll(/\bfilename\*?\s*=\s*(?:"([^"]*)"|([^;]*))/gi)].map(match => match[1] || match[2]);
  try { filenames.push(new URL(url).pathname.split('/').pop()); } catch { /* Synthetic response without an upstream URL. */ }
  for (let name of filenames) {
    try { name = decodeURIComponent(name); } catch { /* Inspect the literal filename if malformed. */ }
    name = name.trim().replace(/[. ]+$/, '');
    // Inline JavaScript used as a script/worker is an ordinary web asset.
    if (/\.js$/i.test(name) && ['script','worker','sharedworker'].includes(request.destination)) continue;
    if (blockedFile.test(name)) return true;
  }
  return request.mode === 'navigate' && !displayMime.test(type);
}
function cancelDownload(response) {
  // Cancellation may reject or hang in a transport; it must never delay denial.
  try { void response.body?.cancel().catch(() => {}); } catch { /* Already locked/closed. */ }
}
function downloadDenied(request) {
  const page = '<!doctype html><meta charset="utf-8"><title>Downloads disabled</title><h1>Downloads are disabled</h1><p>This proxy supports browsing only. File downloads are not available.</p>';
  return Object.assign(new Response(request.mode === 'navigate' ? page : null, {
    status:403, headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',
      'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox allow-same-origin"},
  }), {downloadBlocked:true});
}
async function protectedFetch(engine, event) {
  let blocked = false;
  const context = Object.create(engine);
  context.dispatch = engine.dispatch?.bind(engine);
  context.dispatchEvent = engine.dispatchEvent?.bind(engine);
  context.client = new Proxy(engine.client, {get(target, name) {
    if (name === 'fetch') return async (...args) => {
      const response = await target.fetch(...args);
      if (!downloadable(response, event.request, response.finalURL || String(args[0]))) return response;
      blocked = true;
      cancelDownload(response);
      // Supply the engine's BareResponse shape without the upstream body/headers.
      const denied = new Response(null, {status:403, headers:{'content-type':'text/plain'}});
      denied.rawHeaders = {'content-type':'text/plain'};
      return denied;
    };
    const value = target[name];
    return typeof value === 'function' ? value.bind(target) : value;
  }});
  const response = await context.fetch(event);
  if (blocked || downloadable(response, event.request)) {
    cancelDownload(response);
    return downloadDenied(event.request);
  }
  if (event.request.mode !== 'navigate') return response;
  // Apply after rewriting (the engine strips upstream CSP). This also protects
  // directly opened proxied documents and cannot be removed via iframe DOM edits.
  const secured = new Response(response.body, {status:response.status,statusText:response.statusText,headers:response.headers});
  secured.headers.append('Content-Security-Policy', 'sandbox allow-scripts allow-same-origin allow-forms');
  return secured;
}
async function fetchResource(event) {
  // Scramjet catches a failed response-body read and turns it into an empty
  // 500. A single lost application bundle then leaves a page on its skeleton.
  // Retry only an incomplete successful GET script/style response, once, on
  // the same authorized transport. Website errors and rewriting errors pass on.
  for (let attempt = 0; attempt < 2; attempt++) {
    let incomplete = false;
    const context = Object.create(scramjet);
    context.dispatch = scramjet.dispatch?.bind(scramjet);
    context.dispatchEvent = scramjet.dispatchEvent.bind(scramjet);
    context.client = new Proxy(scramjet.client, {get(target, name) {
      if (name === 'fetch') return async (...args) => {
        const response = await target.fetch(...args);
        if (response.status >= 200 && response.status < 300) {
          for (const method of ['arrayBuffer', 'text']) {
            const read = response[method].bind(response);
            response[method] = async () => {
              try { return await read(); }
              catch (error) { incomplete = true; throw error; }
            };
          }
        }
        return response;
      };
      const value = target[name];
      return typeof value === 'function' ? value.bind(target) : value;
    }});
    const response = await protectedFetch(context, event);
    if (!incomplete || attempt || event.request.signal?.aborted) return response;
    await new Promise(resolve => setTimeout(resolve, 150));
    if (event.request.signal?.aborted) return response;
  }
}
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
    if (wasmScript) return scramjet.fetch(event);
    if (event.request.mode !== 'navigate') {
      if (url.pathname.startsWith('/service/') && event.request.method === 'GET' && ['script','style'].includes(event.request.destination)) return fetchResource(event);
      return protectedFetch(scramjet, event);
    }
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
      const response = await protectedFetch(context, event);
      // Genuine website responses (including 4xx/5xx/CAPTCHA) pass unchanged.
      if (responded || response.downloadBlocked) return response;
    } catch { /* Suppress engine diagnostics in the destination document. */ }
    return unavailable({reason:transportFailure || 'runtime', url:destination, method:event.request.method});
  })());
});
