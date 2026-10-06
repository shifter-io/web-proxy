(async () => {
  let bridge;
  try { bridge = await createRuntimeBridge(); }
  catch { document.getElementById('loading').textContent = 'This browsing frame is not authorized.'; return; }
  const send = bridge.send;
  let frame, connection, started = false;
  try {
    const { ScramjetController } = $scramjetLoadController();
    const scramjet = new ScramjetController({flags:{syncxhr:false},prefix:'/service/',files:{wasm:'/vendor/scram/scramjet.wasm.wasm',all:'/vendor/scram/scramjet.all.js',sync:'/vendor/scram/scramjet.sync.js'}});
    await scramjet.init();
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));
    connection = new BareMux.BareMuxConnection('/vendor/baremux/worker.js');
    window.addEventListener('message', async event => {
      if (!bridge.accepts(event)) return;
      const {command,ticket,url} = event.data;
      try {
        if (command === 'clear') { frame?.frame.remove(); location.replace('/reset.html?' + bridge.query + '#stop'); return; }
        if ((command === 'start' && !started) || command === 'reconnect') {
          started = true;
          frame?.frame.remove();
          const websocket = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/wisp/${encodeURIComponent(ticket)}/`;
          await connection.setTransport('/vendor/epoxy/index.mjs',[{wisp:websocket, wisp_v2:false}]);
          frame = scramjet.createFrame();
          frame.frame.setAttribute('sandbox','allow-scripts allow-same-origin allow-forms allow-downloads');
          frame.frame.title = 'Destination website';
          const currentFrame = frame;
          const isCurrent = () => frame === currentFrame;
          currentFrame.addEventListener('urlchange', event => {
            if (isCurrent()) send('url',{url:String(event.url)});
          });
          currentFrame.addEventListener('navigate', event => {
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
          currentFrame.frame.addEventListener('load', () => {
            if (!isCurrent()) return;
            const destinationWindow = currentFrame.frame.contentWindow;
            try { if (destinationWindow.location.href === 'about:blank') return; } catch {}
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
          frame.go(url);
          document.body.appendChild(frame.frame);
        } else if (frame && command === 'go') frame.go(url);
        else if (frame && ['back','forward','reload'].includes(command)) frame[command]();
      } catch (error) { console.error('Runtime start failed:','Transport initialization error'); send('error',{message:'The connection could not be established. Stop browsing and try again; your remaining allowance is preserved.'}); }
    });
    send('ready');
  } catch { send('error',{message:'The browser runtime could not initialize. Use a browser with service worker and WebAssembly support.'}); }
})();
