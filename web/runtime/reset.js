// Run before loading the engine, when this document holds no Scramjet database handles.
(async () => {
  let bridge;
  try {
    bridge = await createRuntimeBridge();
    localStorage.clear(); sessionStorage.clear();
    for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
    for (const key of await caches.keys()) await caches.delete(key);
    const databases = await indexedDB.databases();
    for (const {name} of databases) {
      await new Promise((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onerror = () => reject(new Error('Could not open browser storage'));
        open.onsuccess = () => {
          const db = open.result;
          const stores = [...db.objectStoreNames];
          if (!stores.length) { db.close(); resolve(); return; }
          const tx = db.transaction(stores, 'readwrite');
          stores.forEach(store => tx.objectStore(store).clear());
          tx.oncomplete = () => {db.close(); resolve();};
          tx.onerror = () => {db.close(); reject(new Error('Could not clear browser storage'));};
        };
      });
    }
    if (location.hash === '#stop') {
      bridge.send('cleared');
      document.body.textContent = 'Browsing session cleared.';
    } else location.replace('/index.html?' + bridge.query);
  } catch {
    bridge?.send('error',{message:'Could not clear the previous browsing session. Reload this page before retrying.'});
    document.body.textContent = 'Could not clear the previous session. Close this tab and clear this site’s storage before retrying.';
  }
})();
