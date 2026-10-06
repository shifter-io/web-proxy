import {challenge} from './captcha.js';
const mounted = new WeakMap();
const protocolVersion = 1;
export function destination(value) {
  let input = String(value || '').trim();
  if (!input) throw failure('INVALID_URL', 'Enter a website address to continue.');
  if (/^[a-z][a-z\d+.-]*:/i.test(input) && !/^https?:\/\//i.test(input)) throw failure('INVALID_URL','Enter an HTTP or HTTPS website address.');
  if (!/^https?:\/\//i.test(input)) input = 'https://' + input;
  let url;
  try { url = new URL(input); } catch { throw failure('INVALID_URL','Enter a valid website address.'); }
  if (!['http:','https:'].includes(url.protocol) || !url.hostname.includes('.') || url.username || url.password || (url.port && !['80','443'].includes(url.port))) throw failure('INVALID_URL','Enter an HTTP or HTTPS website on port 80 or 443.');
  return url.href;
}
function failure(code, message) { return Object.assign(new Error(message), {code}); }

export function create({container, apiOrigin, nonce} = {}) {
  if (!(container instanceof HTMLElement)) throw new TypeError('A proxy container element is required.');
  if (mounted.has(container)) throw new Error('This container already has a web proxy instance.');
  apiOrigin = new URL(apiOrigin).origin;
  let state = {status:'idle', active:false, busy:false, loading:false, countries:[], country:'us', url:'', session:null, remainingSeconds:0, persistent:true, error:null};
  let config, credential, storageKey, frame, channel, generation = 0, ready = false, pendingUrl, wasConnected = false;
  let destroyed = false, initialized, cleanupResolve, loadingTimer, runtimeTimer, polling = false;
  let revision, engineId, retries = 0, recoveryTask, recoveryAbort, recoveryVersion = 0, needsTransport = false;
  const listeners = new Set(), controller = new AbortController(), waits = new Map();
  const emit = patch => {
    if (destroyed) return;
    state = {...state, ...patch};
    for (const listener of listeners) { try { listener(structuredClone(state)); } catch (error) { console.error('Web proxy UI callback failed', error); } }
  };
  function ensure() { if (destroyed) throw failure('DESTROYED','This proxy instance was destroyed.'); }
  function report(error) {
    if (error.code !== 'CANCELLED' && error.name !== 'AbortError') emit({error:{code:error.code || 'CONNECTION_ERROR', message:error.message}});
  }
  async function api(path, method = 'GET', body) {
    ensure();
    const response = await fetch(`${apiOrigin}/api/v1/${path}`, {
      method, credentials:'omit', signal:AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      headers:{...(credential ? {Authorization:`Bearer ${credential}`} : {}), ...(body ? {'Content-Type':'application/json'} : {})},
      body:body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    ensure();
    if (!response.ok) {
      if (response.status === 401) { credential = undefined; try { localStorage.removeItem(storageKey); } catch {} }
      throw failure(data.code || 'SERVICE_UNAVAILABLE', data.error || `Request failed (${response.status})`);
    }
    return data;
  }
  function persist(value) {
    credential = value;
    try { localStorage.setItem(storageKey, value); }
    catch { emit({persistent:false}); }
  }
  function delay(ms, signal) {
    ensure();
    return new Promise((resolve, reject) => {
      const cancel = () => { clearTimeout(timer); waits.delete(timer); reject(failure('CANCELLED','Recovery cancelled.')); };
      const timer = setTimeout(() => { waits.delete(timer); signal?.removeEventListener('abort',cancel); resolve(); }, ms);
      waits.set(timer, reject);
      signal?.addEventListener('abort',cancel,{once:true});
      if (signal?.aborted) cancel();
    });
  }
  function loading(on) {
    clearTimeout(loadingTimer);
    emit({loading:on});
    if (on) loadingTimer = setTimeout(() => {
      emit({loading:false, error:{code:'LOAD_TIMEOUT',message:'This page is taking longer than expected. Select Reload or try another website.'}});
    }, 25000);
  }
  function send(command, data = {}) {
    if (frame && config) frame.contentWindow?.postMessage({source:'shifter-control', protocolVersion, channel, command, ...data}, config.runtimeOrigin);
  }
  function update(session) {
    emit({session, country:session.country, remainingSeconds:Math.max(0,Math.ceil((session.expiresAt-session.serverTime)/1000))});
    state.clockOffset = session.serverTime - Date.now();
    if (session.connected) wasConnected = true;
    if (state.active && wasConnected && !session.connected && session.status === 'active') {
      // A dropped idle socket need not disrupt an already displayed page.
      // The next failed navigation provides its actual method and recovery reason.
      wasConnected = false;
    }
    if (['expired','exhausted'].includes(session.status) || (session.status === 'stopped' && state.active)) expire(session.status);
  }
  function expire(status) {
    recoveryVersion++; recoveryAbort?.abort();
    generation++; clearTimeout(runtimeTimer); loading(false);
    ready = false; pendingUrl = null;
    emit({active:false,status,remainingSeconds:0,session:state.session ? {...state.session,status} : null});
    clearRuntime().catch(report);
  }
  async function authorize(url) {
    const attempt = generation;
    const authorization = await api('session/tickets','POST');
    if (state.active && attempt === generation && !destroyed) connect('start', authorization, url);
  }
  function connect(command, authorization, url) {
    revision = authorization.revision; engineId = crypto.randomUUID(); needsTransport = false;
    send(command, {ticket:authorization.ticket,url,engineId,recovery:true});
  }
  function interrupted() {
    loading(false);
    emit({status:'interrupted',error:{code:'CONNECTION_INTERRUPTED',message:'The connection could not be restored. Please try again or choose another website.'}});
  }
  async function recover(data) {
    if (recoveryTask || !state.active || state.busy) return;
    if (data.method !== 'GET' || !['websocket','upstream'].includes(data.reason) || !Number.isSafeInteger(revision) || retries >= 2) { interrupted(); return; }
    let url;
    try { url = destination(data.url); } catch { interrupted(); return; }
    const version = ++recoveryVersion, attempt = generation;
    recoveryAbort = new AbortController();
    const signal = recoveryAbort.signal;
    const current = () => !destroyed && state.active && version === recoveryVersion && attempt === generation;
    retries++; wasConnected = false; loading(true); emit({status:'connecting',error:null,url});
    const task = (async () => {
      try {
        await delay(retries * 300, signal);
        if (!current()) return;
        needsTransport = true;
        await api('session/recover','POST',{revision,url,reason:data.reason});
        if (!current()) return;
        loading(true);
        // Keep the prior lease intact until the old gateway has stopped forwarding.
        await delay(6500, signal);
        if (!current()) return;
        const authorization = await api('session/tickets','POST');
        if (!current()) return;
        connect('reconnect',authorization,url);
        loading(true);
      } catch (error) {
        if (!current()) return;
        if (error.code === 'SESSION_ENDED') {
          try {
            const session = await api('session');
            if (!current()) return;
            update(session);
            if (state.active) interrupted();
          } catch { if (current()) interrupted(); }
        } else interrupted();
      }
    })();
    recoveryTask = task;
    try { await task; } finally { if (recoveryTask === task) recoveryTask = null; }
  }
  function openRuntime(url) {
    ensure();
    if (state.session?.status !== 'active') return;
    generation++; channel = crypto.randomUUID(); ready = false; wasConnected = false; pendingUrl = url;
    frame?.remove(); frame = document.createElement('iframe');
    frame.title = 'Proxied browsing session';
    frame.setAttribute('sandbox','allow-scripts allow-same-origin allow-forms allow-downloads');
    frame.style.cssText = 'border:0;width:100%;height:100%;display:block';
    const params = new URLSearchParams({parentOrigin:location.origin,channel,protocolVersion:String(protocolVersion)});
    frame.src = `${config.runtimeOrigin}/reset.html?${params}`;
    container.append(frame); loading(true); emit({status:'connecting',active:true,url});
    clearTimeout(runtimeTimer);
    runtimeTimer = setTimeout(() => {
      if (!ready) { loading(false); emit({status:'interrupted',error:{code:'RUNTIME_TIMEOUT',message:'The browser engine did not start. Select Reload to try again.'}}); }
    }, 20000);
  }
  async function clearRuntime() {
    if (!frame) return;
    generation++; pendingUrl = null; ready = false;
    clearTimeout(runtimeTimer);
    // Tear down engine handles before clearing storage. Keep cleanup independent
    // of the website hiding its viewport when active becomes false.
    frame.remove();
    channel = crypto.randomUUID();
    frame = document.createElement('iframe');
    frame.title = 'Clearing browsing session';
    frame.setAttribute('aria-hidden','true'); frame.tabIndex = -1;
    frame.setAttribute('sandbox','allow-scripts allow-same-origin');
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0';
    let timer;
    const cleared = new Promise((resolve, reject) => {
      cleanupResolve = resolve;
      timer = setTimeout(() => reject(failure('CLEANUP_FAILED','The previous browsing context could not be cleared. Reload this page before trying again.')),8000);
    });
    frame.src = `${config.runtimeOrigin}/reset.html?${new URLSearchParams({parentOrigin:location.origin,channel,protocolVersion:String(protocolVersion)})}#stop`;
    document.body.append(frame);
    try { await cleared; frame?.remove(); frame = null; }
    finally { clearTimeout(timer); cleanupResolve = null; ready = false; }
  }
  async function message(event) {
    const data = event.data;
    if (destroyed || event.origin !== config?.runtimeOrigin || event.source !== frame?.contentWindow
      || data?.source !== 'shifter-runtime' || data.protocolVersion !== protocolVersion || data.channel !== channel) return;
    if (data.engineId && data.engineId !== engineId) return;
    try {
      if (data.type === 'ready' && !cleanupResolve) {
        clearTimeout(runtimeTimer); ready = true;
        if (state.active && pendingUrl) { const url = pendingUrl; pendingUrl = null; await authorize(url); }
      } else if (data.type === 'cleared') cleanupResolve?.();
      else if (data.type === 'loading' && state.active) loading(true);
      else if (data.type === 'loaded' && state.active && !recoveryTask) { retries = 0; loading(false); emit({status:'browsing',error:null}); }
      else if (data.type === 'proxy-failure' && data.engineId === engineId && state.active) await recover(data);
      else if (data.type === 'url' && state.active && typeof data.url === 'string') emit({url:data.url});
      else if (data.type === 'error') {
        loading(false); clearTimeout(runtimeTimer);
        emit({status:'interrupted',error:{code:'RUNTIME_ERROR',message:String(data.message || 'The browser runtime failed.')}});
      }
    } catch (error) { loading(false); report(error); }
  }
  window.addEventListener('message', message);
  const pollTimer = setInterval(async () => {
    if (destroyed || !state.active || state.busy || recoveryTask || polling) return;
    polling = true;
    const attempt = generation;
    try { const session = await api('session'); if (attempt === generation && state.active && !recoveryTask) update(session); } catch (error) { if (!recoveryTask) report(error); }
    finally { polling = false; }
  }, 1500);
  const clockTimer = setInterval(() => {
    if (!state.active || !state.session) return;
    const seconds = Math.max(0, Math.ceil((state.session.expiresAt-Date.now()-(state.clockOffset || 0))/1000));
    if (state.remainingSeconds !== seconds) emit({remainingSeconds:seconds});
    if (!seconds) expire('expired');
  }, 250);
  async function operation(fn) {
    ensure();
    if (state.busy) throw failure('BUSY','A proxy operation is already in progress.');
    emit({busy:true,error:null});
    recoveryVersion++; recoveryAbort?.abort(); retries = 0;
    try { if (recoveryTask) await recoveryTask; ensure(); return await fn(); }
    catch (error) { loading(false); report(error); throw error; }
    finally { emit({busy:false}); }
  }
  const client = {
    getState:() => structuredClone(state),
    subscribe(callback) { ensure(); listeners.add(callback); callback(client.getState()); return () => listeners.delete(callback); },
    init() {
      ensure();
      if (!initialized) initialized = (async () => {
        config = await api('config');
        if (config.protocolVersion !== protocolVersion) throw failure('VERSION_MISMATCH','The proxy library needs an update. Reload this page.');
        config.runtimeOrigin = new URL(config.runtimeOrigin).origin;
        storageKey = `shifter-web-proxy:v1:${apiOrigin}:${config.site}`;
        try { credential = localStorage.getItem(storageKey) || undefined; } catch { emit({persistent:false}); }
        emit({countries:config.countries,status:'ready'});
        if (credential) { try { update(await api('session')); } catch (error) { if (!['AUTH_REQUIRED','NO_SESSION'].includes(error.code)) throw error; } }
        return client.getState();
      })().catch(error => { initialized = undefined; report(error); throw error; });
      return initialized;
    },
    search({url,country} = {}) { return operation(async () => {
      await client.init(); url = destination(url);
      if (!config.countries.some(c => c.code === country)) throw failure('INVALID_COUNTRY','Select an available country.');
      const previousStatus = state.status;
      emit({status:'verifying'});
      let captchaToken;
      try { captchaToken = await challenge(config.captchaSiteKey,{nonce,signal:controller.signal}); }
      finally { emit({status:previousStatus}); }
      const result = await api('sessions','POST',{country,captchaToken});
      if (result.credential) persist(result.credential);
      update(result.session);
      if (result.session.status !== 'active') return client.getState();
      if (result.session.country !== country) {
        update(await api('session/country','POST',{country}));
        await clearRuntime(); await delay(1400); openRuntime(url);
      } else if (state.active && ready && !needsTransport && result.session.connected && state.status !== 'interrupted') { send('go',{url}); loading(true); emit({url}); }
      else {
        if (result.session.connected) { await api('session/reconnect','POST'); await delay(6500); }
        openRuntime(url);
      }
      return client.getState();
    }); },
    navigate(url) { return operation(async () => {
      if (!state.active) throw failure('NO_SESSION','Start a browsing session first.');
      url = destination(url); emit({url}); loading(true);
      if (needsTransport && ready) {
        await delay(6500);
        connect('reconnect',await api('session/tickets','POST'),url);
      } else if (ready) send('go',{url}); else pendingUrl = url;
    }); },
    back() { return operation(async () => { if (needsTransport) { interrupted(); return; } if (state.active && ready) { loading(true); send('back'); } }); },
    forward() { return operation(async () => { if (needsTransport) { interrupted(); return; } if (state.active && ready) { loading(true); send('forward'); } }); },
    reload() { return operation(async () => {
      if (!state.active) throw failure('NO_SESSION','Start a browsing session first.');
      wasConnected = false; emit({status:'connecting'}); loading(true);
      await api('session/reconnect','POST'); await delay(6500);
      if (!state.active) return;
      if (!ready) { openRuntime(state.url); return; }
      connect('reconnect',await api('session/tickets','POST'),state.url);
    }); },
    changeCountry(country) { return operation(async () => {
      if (!state.active) throw failure('NO_SESSION','Start a browsing session first.');
      if (!config.countries.some(c => c.code === country)) throw failure('INVALID_COUNTRY','Select an available country.');
      update(await api('session/country','POST',{country}));
      await clearRuntime(); await delay(1400); openRuntime(state.url);
    }); },
    stop() { return operation(async () => {
      await api('session','DELETE'); generation++; emit({active:false,status:'stopped'}); loading(false);
      await clearRuntime(); emit({session:null});
    }); },
    destroy() {
      if (destroyed) return;
      send('clear'); emit({status:'destroyed',active:false,busy:false,loading:false}); destroyed = true;
      controller.abort(); generation++; recoveryVersion++; recoveryAbort?.abort();
      clearInterval(pollTimer); clearInterval(clockTimer); clearTimeout(loadingTimer); clearTimeout(runtimeTimer);
      for (const [timer,reject] of waits) { clearTimeout(timer); reject(failure('DESTROYED','This proxy instance was destroyed.')); }
      waits.clear(); cleanupResolve?.(); frame?.remove(); listeners.clear();
      window.removeEventListener('message',message); mounted.delete(container);
    },
  };
  mounted.set(container,client);
  return Object.freeze(client);
}
