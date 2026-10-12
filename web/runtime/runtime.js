(async () => {
  let bridge;
  try { bridge = await createRuntimeBridge(); }
  catch { document.getElementById('loading').textContent = 'This browsing frame is not authorized.'; return; }
  let engineId;
  const send = (type, data = {}) => bridge.send(type, {...data, engineId});
  let frame, connection, started = false, commandVersion = 0, targetUrl;
  const showError = message => {
    const loading = document.getElementById('loading');
    if (loading) loading.textContent = message;
    send('error', {message});
  };
  async function failureDetails(id) {
    return new Promise(resolve => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => { channel.port1.close(); resolve({reason:'runtime'}); }, 2000);
      channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data); };
      navigator.serviceWorker.controller.postMessage({type:'proxy-failure',id}, [channel.port2]);
    });
  }
  try {
    if (!navigator.serviceWorker || typeof WebAssembly !== 'object'
      || (typeof SharedWorker === 'undefined' && typeof window.__shifterBareMuxPort !== 'function')) {
      throw new Error('This browser lacks the features needed for proxy browsing. Open the page in an updated full browser.');
    }
    const { ScramjetController } = $scramjetLoadController();
    const scramjet = new ScramjetController({flags:{syncxhr:false},prefix:'/service/',files:{wasm:'/vendor/scram/scramjet.wasm.wasm',all:'/vendor/scram/scramjet.all.js',sync:'/vendor/scram/scramjet.sync.js'}});
    await runtimeDeadline(() => scramjet.init(), 'Browser storage could not initialize. Allow site storage and select Reload.');
    await runtimeDeadline(() => prepareRuntimeData(), 'Browser setup timed out. Select Reload to try again.');
    // A crashed renderer can leave the old worker's engine/transport state
    // unusable. Install a fresh worker for this outer frame, retaining its DB
    // and cookie jar. Waiting for ready alone can return the previous worker.
    const workerUrl = '/sw.js?' + bridge.query;
    await runtimeDeadline(() => navigator.serviceWorker.register(workerUrl, {scope:'/'}), 'The browser could not register its service worker. Open this page in a full browser and select Reload.');
    await waitForRuntimeWorker(workerUrl);
    connection = new BareMux.BareMuxConnection('/vendor/baremux/worker.js');
    window.addEventListener('message', async event => {
      if (!bridge.accepts(event)) return;
      const {command,ticket,url} = event.data;
      if (command === 'ping') {
        if (event.data.engineId === engineId) send('pong', {probe:event.data.probe});
        return;
      }
      const version = ['clear','start','reconnect'].includes(command) ? ++commandVersion : commandVersion;
      try {
        if (command === 'clear') { frame?.frame.remove(); frame = null; location.replace('/reset.html?' + bridge.query + '#stop'); return; }
        if ((command === 'start' && !started) || command === 'reconnect') {
          engineId = event.data.engineId;
          targetUrl = url;
          started = true;
          frame?.frame.remove();
          frame = null;
          const websocket = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/wisp/${encodeURIComponent(ticket)}/`;
          await runtimeDeadline(() => connection.setTransport('/vendor/libcurl/index.mjs',[{websocket}]), 'The browser transport did not start. Select Reload to try again.');
          if (version !== commandVersion) return;
          frame = scramjet.createFrame();
          frame.frame.setAttribute('sandbox','allow-scripts allow-same-origin allow-forms allow-downloads');
          frame.frame.title = 'Destination website';
          const currentFrame = frame;
          let navigation = 0;
          const isCurrent = () => frame === currentFrame;
          currentFrame.addEventListener('urlchange', event => {
            if (isCurrent()) send('url',{url:String(event.url)});
          });
          currentFrame.addEventListener('navigate', event => {
            navigation++;
            // Anchor changes do not load a document, and must not leave an overlay.
            let sameDocument = false;
            try {
              const current = new URL(currentFrame.url);
              const next = new URL(event.url, current);
              sameDocument = current.href !== next.href && current.origin === next.origin && current.pathname === next.pathname && current.search === next.search;
            } catch {}
            queueMicrotask(() => {
              if (isCurrent() && !event.defaultPrevented && !sameDocument) send('loading');
            });
          });
          currentFrame.frame.addEventListener('load', async () => {
            if (!isCurrent()) return;
            const currentNavigation = navigation;
            const destinationWindow = currentFrame.frame.contentWindow;
            try { if (destinationWindow.location.href === 'about:blank') return; } catch {}
            const document = currentFrame.frame.contentDocument;
            if (!document) {
              // Browser-generated errors are not usable destination documents.
              send('error', {message:'The website could not load. Select Reload to try again.'});
              return;
            }
            const id = document?.getElementById('shifter-connection-failure')?.dataset.id;
            if (id) {
              currentFrame.frame.style.visibility = 'hidden';
              const failure = await failureDetails(id);
              if (!isCurrent() || navigation !== currentNavigation || currentFrame.frame.contentDocument !== document) return;
              if (failure) {
                send(event.data.recovery ? 'proxy-failure' : 'error', {
                  ...failure, message:'The connection could not be restored. Please try again.',
                });
                return;
              }
              currentFrame.frame.style.visibility = '';
            }
            currentFrame.frame.style.visibility = '';
            send('loaded');
            // Covers links, forms and history traversal that bypass frame.go().
            destinationWindow.addEventListener('pagehide', () => {
              if (isCurrent()) send('loading');
            }, {once:true});
            destinationWindow.addEventListener('pageshow', event => {
              if (isCurrent() && event.persisted) send('loaded');
            });
          });
          document.getElementById('loading')?.remove();
          frame.go(targetUrl);
          document.body.appendChild(frame.frame);
        } else if (command === 'go') { targetUrl = url; if (frame) frame.go(url); }
        else if (frame && ['back','forward','reload'].includes(command)) frame[command]();
      } catch { if (version !== commandVersion) return; showError('The connection could not be established. Select Reload to try again; your remaining allowance is preserved.'); }
    });
    send('ready', {heartbeat:true});
  } catch (error) {
    // Only our setup messages are shown; never surface engine internals.
    const message = /^(This browser lacks|Browser storage could|Browser setup timed|The browser (did not activate|could not register))/.test(error.message || '')
      ? error.message : 'The browser runtime could not initialize. Allow site storage and select Reload to try again.';
    showError(message);
  }
})();
