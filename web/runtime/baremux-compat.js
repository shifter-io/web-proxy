// Older Android browsers lack SharedWorker. Keep one dedicated transport worker
// in the trusted outer runtime, and lend fresh ports to its documents and SW.
// Do not emulate SharedWorker for destination websites.
if (typeof SharedWorker === 'undefined' && typeof Worker !== 'undefined') {
  let worker;
  window.__shifterBareMuxPort = () => {
    worker ||= new Worker('/baremux-worker.js');
    const channel = new MessageChannel();
    worker.postMessage({port:channel.port2}, [channel.port2]);
    return channel.port1;
  };
  navigator.serviceWorker?.addEventListener('message', event => {
    if (event.data?.type !== 'getPort' || !event.data.port
      || event.source !== navigator.serviceWorker.controller) return;
    const port = window.__shifterBareMuxPort();
    event.data.port.postMessage(port, [port]);
  });
  window.addEventListener('pagehide', () => { worker?.terminate(); worker = null; }, {once:true});
}
