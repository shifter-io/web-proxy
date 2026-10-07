// Scramjet v1 otherwise downloads the PSL through BareMux on cross-origin
// requests. Concurrent cold requests duplicate that download, and one failed
// download can prevent an unrelated website script or image from loading.
async function prepareRuntimeData() {
  const response = await fetch('/public-suffix-list.dat', {cache:'no-cache'});
  if (!response.ok) throw new Error('Runtime suffix data unavailable');
  const data = (await response.text()).split('\n')
    .map(line => line.trim().split(/\s/)[0])
    .filter(line => line && !line.startsWith('//'));
  if (data.length < 1000 || !['com','co.uk','github.io','*.ck','!www.ck'].every(rule => data.includes(rule))) {
    throw new Error('Invalid runtime suffix data');
  }
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('$scramjet', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('publicSuffixList', 'readwrite');
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('Runtime suffix data could not be stored'));
      // Sessions last at most 30 minutes. Every new outer runtime refreshes the
      // engine's one-hour cache before any destination requests can start.
      tx.objectStore('publicSuffixList').put({data, expiry:Date.now()+60*60*1000}, 'publicSuffixList');
    });
  } finally { db.close(); }
}
