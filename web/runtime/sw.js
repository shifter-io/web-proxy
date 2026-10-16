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
  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><title>Downloads disabled · Shifter Web Proxy</title>
<style>
*{box-sizing:border-box}html{color-scheme:dark;background:#090b13}
body{margin:0;min-height:100vh;min-height:100svh;display:grid;place-items:center;padding:32px 20px;color:#f5f6fa;font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:radial-gradient(ellipse at 50% 15%,#182b483d,transparent 65%)}
main{width:100%;max-width:560px;padding:36px;border:1px solid #ffffff14;border-radius:20px;background:linear-gradient(145deg,#141b2a,#0e131e);box-shadow:0 24px 80px #0003}
.brand{display:flex;align-items:center;gap:9px;color:#aab5c8;font-size:11px;font-weight:650;letter-spacing:1.8px}
.brand span{width:7px;height:7px;border-radius:50%;background:#5ba3ff}
.symbol{display:grid;place-items:center;width:56px;height:56px;margin:28px 0 20px;border:1px solid #5ba3ff30;border-radius:16px;background:#2b7fff12;color:#79b3ff}
.symbol svg{width:28px;height:28px}h1{margin:0;font-size:32px;line-height:1.2;letter-spacing:-1px;font-weight:650}
.intro{margin:12px 0 24px;color:#aab4c6;font-size:16px}
.reason{padding:18px 20px;border:1px solid #ffffff0b;border-radius:12px;background:#ffffff03}
h2{margin:0 0 8px;font-size:13px;line-height:1.5;color:#e4e9f2;font-weight:650}
.reason p{margin:0;color:#b3bdcf;font-size:14px;line-height:1.75}.reason strong{font-weight:600;color:#dce5f7}
.policy{margin:12px 0 0;color:#8e9bb1;font-size:12px}
.continue{display:flex;align-items:flex-start;gap:12px;margin-top:26px;padding-top:24px;border-top:1px solid #ffffff0c}
.continue svg{width:18px;height:18px;flex-shrink:0;margin-top:3px;color:#79b3ff}
.continue h2{margin:0 0 4px}.continue p{margin:0;color:#9eabc0;font-size:13px;line-height:1.65}
@media(max-width:480px){body{padding:20px 14px}main{padding:26px 22px;border-radius:16px}h1{font-size:28px;letter-spacing:-.7px}.intro{font-size:15px}.reason{padding:16px}.symbol{margin-top:24px}}
@media(max-height:520px) and (min-width:481px){body{padding:16px}main{padding:24px}.symbol{margin:16px 0;width:44px;height:44px}.intro{margin-bottom:16px}.continue{margin-top:18px;padding-top:16px}}
</style></head><body>
<main aria-labelledby="notice-title">
<div class="brand"><span aria-hidden="true"></span>SHIFTER WEB PROXY</div>
<div class="symbol" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4 6v5c0 5 4.5 8 8 10 3.5-2 8-5 8-10V6z"/><path d="M12 8v5m-2-2 2 2 2-2M9 16h6"/></svg></div>
<h1 id="notice-title">Downloads are disabled</h1>
<p class="intro">This free proxy is for browsing websites only.</p>
<section class="reason" aria-labelledby="reason-title">
<h2 id="reason-title">Why this restriction?</h2>
<p>We’ve disabled file downloads following abuse of our service to download malware. This misuse violates our <strong>Terms of Service</strong>.</p>
</section>
<p class="policy">This restriction applies to all files.</p>
<div class="continue"><svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m10 6-6 6 6 6m-6-6h16"/></svg><div><h2>You can keep browsing</h2><p>Use the proxy’s Back button or enter another website.</p></div></div>
</main></body></html>`;
  return Object.assign(new Response(request.mode === 'navigate' ? page : null, {
    status:403, headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',
      'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; sandbox allow-same-origin"},
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
