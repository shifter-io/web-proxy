// Run before loading the engine, when this document holds no Scramjet database handles.
(async () => {
  let bridge;
  try {
    await runtimeDeadline(async () => {
      bridge = await createRuntimeBridge();
      localStorage.clear(); sessionStorage.clear();
      for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
      for (const key of await caches.keys()) await caches.delete(key);
      // Enumeration is optional on older engines. Scramjet's pinned database
      // must always be cleared, including when enumeration omits it.
      const databases = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
      const names = new Set(['$scramjet', ...databases.map(db => db.name).filter(Boolean)]);
      for (const name of names) {
        await new Promise((resolve, reject) => {
          const open = indexedDB.open(name);
          let absent = false;
          // Opening an absent DB would create a schema-less v1 database and
          // prevent Scramjet's own v1 upgrade from installing its stores.
          open.onupgradeneeded = event => {
            if (event.oldVersion === 0) { absent = true; open.transaction.abort(); }
          };
          open.onerror = () => absent ? resolve() : reject(new Error('Could not open browser storage'));
          open.onsuccess = () => {
            const db = open.result;
            const stores = [...db.objectStoreNames];
            if (!stores.length) { db.close(); resolve(); return; }
            const tx = db.transaction(stores, 'readwrite');
            stores.forEach(store => tx.objectStore(store).clear());
            tx.oncomplete = () => {db.close(); resolve();};
            tx.onerror = tx.onabort = () => {db.close(); reject(new Error('Could not clear browser storage'));};
          };
        });
      }
    }, 'Browser storage cleanup timed out. Close other proxy tabs and select Reload.', 6000);
    if (location.hash === '#stop') {
      bridge.send('cleared');
      document.body.textContent = 'Browsing session cleared.';
    } else location.replace('/index.html?' + bridge.query);
  } catch (error) {
    const message = error.message?.includes('timed out') ? error.message : 'The browser could not reset site storage. Allow site storage, close other proxy tabs, and select Reload.';
    bridge?.send('error',{message});
    document.body.textContent = message;
  }
})();
