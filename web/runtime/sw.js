importScripts('/vendor/scram/scramjet.all.js');
const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  event.respondWith((async () => {
    // Runtime/reset assets must remain reachable after reset clears the engine DB.
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin || !url.pathname.startsWith('/service/')) return fetch(event.request);
    await scramjet.loadConfig();
    return scramjet.route(event) ? scramjet.fetch(event) : fetch(event.request);
  })());
});
