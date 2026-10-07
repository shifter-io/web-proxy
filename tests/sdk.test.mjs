import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {create, destination} from '../web/sdk/src/client.js';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const flush = async () => { for(let i=0;i<12;i++) await Promise.resolve(); };

async function watchedRuntime(t) {
  t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:Date.now()});
  const e=environment(t);await e.start();
  Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
  e.sent=[];
  e.ready=async()=>{
    document.querySelector('#view iframe').contentWindow.postMessage=data=>e.sent.push(data);
    e.runtimeMessage('ready',{heartbeat:true});await flush();
  };
  e.advance=async ms=>{t.mock.timers.tick(ms);await flush();};
  e.silence=async()=>{for(let i=0;i<4;i++)await e.advance(5000);};
  await e.ready();return e;
}

test('dead runtime is replaced without CAPTCHA, storage reset or allowance renewal',async t=>{
  const e=await watchedRuntime(t),before=e.proxy.getState().session;
  const old=document.querySelector('#view iframe'),engine=e.sent.at(-1).engineId;
  e.runtimeMessage('loaded',{engineId:engine});
  await e.silence();assert.equal(e.proxy.getState().status,'connecting');
  e.runtimeMessage('loaded',{engineId:engine});assert.equal(e.proxy.getState().status,'connecting');
  await e.advance(300);await e.advance(6500);
  const replacement=document.querySelector('#view iframe');
  assert.notEqual(replacement,old);assert.equal(new URL(replacement.src).pathname,'/index.html');
  assert.notEqual(new URL(old.src).searchParams.get('channel'),new URL(replacement.src).searchParams.get('channel'));
  await e.ready();e.runtimeMessage('loaded',{engineId:e.sent.at(-1).engineId});
  assert.equal(e.proxy.getState().status,'browsing');
  assert.equal(e.requests.filter(r=>r.url.endsWith('/sessions')).length,1);
  assert.equal(e.requests.filter(r=>r.url.endsWith('/tickets')).length,2);
  assert.equal(e.proxy.getState().session.expiresAt,before.expiresAt);
  assert.equal(e.proxy.getState().session.remainingBytes,before.remainingBytes);
  assert.equal(JSON.parse(e.requests.find(r=>r.url.endsWith('/recover')).options.body).reason,'websocket');
});

test('watchdog accepts only the current probe and engine, and responsive runtimes stay mounted',async t=>{
  const e=await watchedRuntime(t),frame=document.querySelector('#view iframe');
  for(let i=0;i<5;i++) {
    await e.advance(5000);const ping=e.sent.at(-1);assert.equal(ping.command,'ping');
    e.runtimeMessage('pong',{probe:ping.probe,engineId:ping.engineId});
  }
  assert.equal(document.querySelector('#view iframe'),frame);
  assert.ok(!e.requests.some(r=>r.url.endsWith('/recover')));
  await e.advance(5000);const ping=e.sent.at(-1);
  e.runtimeMessage('pong',{probe:'stale',engineId:ping.engineId});
  e.runtimeMessage('pong',{probe:ping.probe,engineId:'stale'});
  for(let i=0;i<3;i++)await e.advance(5000);
  await e.advance(300);assert.equal(e.requests.filter(r=>r.url.endsWith('/recover')).length,1);
});

test('hidden tabs and a suspended host get fresh probes instead of false crash recovery',async t=>{
  const e=await watchedRuntime(t);
  await e.advance(5000);
  Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
  document.dispatchEvent(new window.Event('visibilitychange'));
  await e.advance(60000);
  Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
  document.dispatchEvent(new window.Event('visibilitychange'));
  await e.advance(5000);
  await e.advance(60000);
  assert.ok(!e.requests.some(r=>r.url.endsWith('/recover')));
  await e.advance(5000);const ping=e.sent.at(-1);
  e.runtimeMessage('pong',{probe:ping.probe,engineId:ping.engineId});
  assert.equal(e.proxy.getState().active,true);
});

test('Stop cancels dead-runtime replacement during lease retirement',async t=>{
  const e=await watchedRuntime(t);await e.silence();await e.advance(300);
  const stop=e.proxy.stop();await flush();e.runtimeMessage('cleared');await stop;
  await e.advance(10000);
  assert.equal(document.querySelector('iframe'),null);
  assert.equal(e.requests.filter(r=>r.url.endsWith('/tickets')).length,1);
});

test('navigation during crash recovery replaces the dead frame at the requested URL',async t=>{
  const e=await watchedRuntime(t);await e.silence();await e.advance(300);
  const navigate=e.proxy.navigate('example.org');await flush();await e.advance(6500);await navigate;
  await e.ready();
  assert.equal(e.sent.at(-1).command,'start');assert.equal(e.sent.at(-1).url,'https://example.org/');
});

test('unresponsive replacements stop after two automatic recoveries; Reload remains available',async t=>{
  const e=await watchedRuntime(t);
  for(let i=1;i<=2;i++) {
    await e.silence();await e.advance(i*300);await e.advance(6500);await e.ready();
  }
  await e.silence();await e.advance(1000);
  assert.equal(e.proxy.getState().status,'interrupted');
  assert.equal(e.requests.filter(r=>r.url.endsWith('/recover')).length,2);
  const frame=document.querySelector('#view iframe'),reload=e.proxy.reload();
  await flush();await e.advance(6500);await reload;
  assert.notEqual(document.querySelector('#view iframe'),frame);
});
function environment(t) {
  const dom = new JSDOM('<button id="search">Search</button><div id="view"></div>', {url:'https://example.com'});
  const originals = {};
  for (const key of ['window','document','HTMLElement','location','localStorage']) { originals[key]=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:dom.window[key]}); }
  dom.window.HTMLDialogElement.prototype.show = function() {this.open=true;};
  dom.window.HTMLDialogElement.prototype.close = function() {this.open=false;};
  const session = {country:'us', status:'active',serverTime:Date.now(), expiresAt:Date.now()+600000,remainingBytes:1000,byteLimit:1000,connected:false};
  const requests = []; let widget, failStart = false, statusResponse, resets = 0;
  dom.window.grecaptcha = {render:(_node,options) => {widget=options;return 0;},reset() {resets++;}};
  t.mock.method(globalThis,'fetch',async (url, options) => {
    requests.push({url,options});
    let data;
    if(url.endsWith('/config')) data={site:'shifter',countries:[{code:'us',name:'United States'},{code:'de',name:'Germany'}],runtimeOrigin:'https://proxy.example.net',captchaSiteKey:'public-site-key',protocolVersion:1};
    else if(url.endsWith('/sessions')) {
      if(failStart) return {ok:false,status:403,json:async()=>({code:'CAPTCHA_REJECTED',error:'Please retry verification'})};
      data={session,credential:'a'.repeat(64)};
    } else if(url.endsWith('/tickets')) data={ticket:'one-use-ticket',revision:1};
    else if(url.endsWith('/country')) data={...session,country:JSON.parse(options.body).country};
    else data=statusResponse || session;
    return {ok:true,status:200,json:async()=>data};
  });
  const proxy=create({container:document.querySelector('#view'),apiOrigin:'https://proxy.example.net'});
  t.after(()=>{proxy.destroy();dom.window.close();for(const [key,descriptor] of Object.entries(originals)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}});
  function runtimeMessage(type, overrides={}) {
    const frame=document.querySelector('iframe');
    const params=new URL(frame.src).searchParams;
    dom.window.dispatchEvent(new dom.window.MessageEvent('message',{origin:'https://proxy.example.net',source:frame.contentWindow,data:{source:'shifter-runtime',protocolVersion:1,channel:params.get('channel'),type,...overrides}}));
  }
  async function start() {
    await proxy.init();
    const result=proxy.search({url:'example.com',country:'us'});await flush();widget.callback('synthetic-response');await result;
  }
  return {proxy,requests,start,runtimeMessage,solve:()=>widget.callback('synthetic-response'),widgetError:()=>widget['error-callback'](),expire:()=>widget['expired-callback'](),resets:()=>resets,failStart:()=>{failStart=true;},setStatus:value=>{statusResponse=value;},dom};
}

test('URL normalization rejects credentials, non-web schemes and ports',()=>{
  assert.equal(destination('example.com'),'https://example.com/');
  for(const input of ['', 'javascript:alert(1)','ftp://example.com','https://u:p@example.com','http://example.com:22']) assert.throws(()=>destination(input));
});

test('Search owns CAPTCHA, rejects duplicate clicks, and cancellation never calls sessions',async t=>{
  const e=environment(t);await e.proxy.init();document.querySelector('#search').focus();
  const attempt=e.proxy.search({url:'example.com',country:'us'});await flush();
  assert.ok(document.querySelector('dialog').open);
  await assert.rejects(e.proxy.search({url:'example.com',country:'us'}),{code:'BUSY'});
  document.querySelector('dialog button').click();await assert.rejects(attempt,{code:'CANCELLED'});
  assert.equal(document.activeElement.id,'search');assert.equal(e.proxy.getState().busy,false);
  assert.ok(!e.requests.some(r=>r.url.endsWith('/sessions')));
});

test('sessions use cookie-free bearer auth and runtime only receives a single-use ticket',async t=>{
  const e=environment(t);await e.start();
  assert.equal(e.proxy.getState().active,true);
  const sent=[];document.querySelector('iframe').contentWindow.postMessage=(data,origin)=>sent.push({data,origin});
  e.runtimeMessage('ready');await flush();
  assert.equal(sent[0].data.ticket,'one-use-ticket');
  assert.ok(!JSON.stringify(sent).includes('a'.repeat(64)));
  const request=e.requests.find(r=>r.url.endsWith('/tickets'));
  assert.equal(request.options.headers.Authorization,`Bearer ${'a'.repeat(64)}`);
  assert.ok(e.requests.every(r=>r.options.credentials==='omit'));
  e.runtimeMessage('loaded',{channel:'stale'});assert.equal(e.proxy.getState().loading,true);
  e.runtimeMessage('loaded',{protocolVersion:2});assert.equal(e.proxy.getState().loading,true);
  e.runtimeMessage('loaded');assert.equal(e.proxy.getState().loading,false);
  await e.proxy.navigate('example.org');
  assert.equal(e.requests.filter(r=>r.url.endsWith('/sessions')).length,1);
});

test('failed verification unlocks Search without creating a runtime',async t=>{
  const e=environment(t);await e.proxy.init();e.failStart();
  const attempt=e.proxy.search({url:'example.com',country:'us'});await flush();e.solve();
  await assert.rejects(attempt,{code:'CAPTCHA_REJECTED'});assert.equal(e.proxy.getState().busy,false);
  assert.equal(document.querySelector('iframe'),null);
});

test('provider errors preserve the widget, never authorize, and allow retry or cancellation',async t=>{
  const e=environment(t);await e.proxy.init();
  const attempt=e.proxy.search({url:'example.com',country:'us'});await flush();
  e.widgetError();await flush();
  assert.ok(document.querySelector('dialog').open);
  assert.match(document.querySelector('[role=status]').textContent,/Google could not initialize/);
  assert.equal(e.resets(),0,'error handling must not reset and cancel the provider error document');
  assert.ok(!e.requests.some(r=>r.url.endsWith('/sessions')));
  await assert.rejects(e.proxy.search({url:'example.org',country:'us'}),{code:'BUSY'});
  document.querySelector('[data-retry]').click();await flush();assert.equal(e.resets(),1);
  e.solve();await attempt;assert.equal(e.proxy.getState().active,true);
});

test('expired/error widget can be closed and stale callbacks cannot reopen it',async t=>{
  const e=environment(t);await e.proxy.init();document.querySelector('#search').focus();
  const attempt=e.proxy.search({url:'example.com',country:'us'});await flush();
  e.expire();assert.equal(e.resets(),0);assert.match(document.querySelector('[role=status]').textContent,/expired/);
  document.querySelector('[data-close]').click();await assert.rejects(attempt,{code:'CANCELLED'});
  e.widgetError();e.solve();await flush();
  assert.equal(document.querySelector('dialog'),null);assert.equal(document.activeElement.id,'search');
  assert.equal(e.proxy.getState().busy,false);assert.ok(!e.requests.some(r=>r.url.endsWith('/sessions')));
});

test('destroy cancels a pending CAPTCHA and detaches listeners and timers',async t=>{
  const e=environment(t);await e.proxy.init();
  const pending=e.proxy.search({url:'example.com',country:'us'});await flush();e.proxy.destroy();
  await assert.rejects(pending,{code:'CANCELLED'});
  assert.equal(document.querySelector('dialog'),null);
  assert.equal(e.proxy.getState().status,'destroyed');
  assert.throws(()=>e.proxy.init(),{code:'DESTROYED'});
});

test('runtime bridge binds origin, source, protocol and channel',async()=>{
  const source=await readFile(new URL('../web/runtime/bridge.js',import.meta.url),'utf8');
  const parent={postMessage(){}}, window={};
  const channel='12345678-1234-1234-1234-123456789abc';
  runInNewContext(source,{window,parent,URLSearchParams,location:{search:`?parentOrigin=https%3A%2F%2Fexample.com&channel=${channel}&protocolVersion=1`},fetch:async()=>({ok:true,json:async()=>({allowedOrigins:['https://example.com'],protocolVersions:[1]})})});
  const bridge=await window.createRuntimeBridge();
  const event={origin:'https://example.com',source:parent,data:{source:'shifter-control',channel,protocolVersion:1}};
  assert.ok(bridge.accepts(event));
  for(const altered of [{origin:'https://www.example.com'},{source:{}},{data:{...event.data,channel:'stale'}},{data:{...event.data,protocolVersion:2}}]) assert.ok(!bridge.accepts({...event,...altered}));
  assert.match(bridge.query,/parentOrigin=/);
});

test('first-party storage denial preserves the current in-memory session',async t=>{
  const e=environment(t);
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem(){throw new Error('disabled');},setItem(){throw new Error('disabled');},removeItem(){}}});
  await e.start();assert.equal(e.proxy.getState().persistent,false);
  e.runtimeMessage('ready');await flush();
  assert.ok(e.requests.find(r=>r.url.endsWith('/tickets')).options.headers.Authorization);
});

test('Stop waits for runtime cleanup and retains anonymous identity',async t=>{
  const e=environment(t);await e.start();e.runtimeMessage('ready');await flush();
  const stop=e.proxy.stop();await flush();
  assert.equal(e.proxy.getState().active,false);
  assert.equal(document.querySelector('#view iframe'),null,'cleanup must not depend on a hidden UI viewport');
  assert.ok(document.querySelector('body > iframe'),'cleanup runs in its own frame after engine teardown');
  e.runtimeMessage('cleared');await stop;
  assert.equal(document.querySelector('iframe'),null);
  assert.equal(e.proxy.getState().status,'stopped');
  assert.ok(localStorage.length>0,'ending access retains the visitor credential');
});

test('a Google challenge outside the dialog remains focusable and Escape cancels',async t=>{
  const e=environment(t);await e.proxy.init();
  const attempt=e.proxy.search({url:'example.com',country:'us'});await flush();
  const frame=document.createElement('iframe');frame.src='https://www.google.com/recaptcha/api2/bframe';document.body.append(frame);frame.focus();
  assert.equal(document.activeElement,frame);
  document.dispatchEvent(new e.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  await assert.rejects(attempt,{code:'CANCELLED'});
  assert.equal(document.querySelector('.shifter-web-proxy-backdrop'),null);
});

test('expired allowance never starts a runtime even after a valid challenge',async t=>{
  const e=environment(t);await e.proxy.init();
  const realFetch=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async (url,options)=>{
    const response=await realFetch(url,options);
    if(url.endsWith('/sessions')) {const data=await response.json();data.session.status='expired';return {ok:true,status:200,json:async()=>data};}
    return response;
  });
  const attempt=e.proxy.search({url:'example.com',country:'us'});await flush();e.solve();await attempt;
  assert.equal(e.proxy.getState().status,'expired');assert.equal(e.proxy.getState().active,false);assert.equal(document.querySelector('iframe'),null);
});

test('release manifest matches immutable source and loader selects the published version',async()=>{
  const {createHash}=await import('node:crypto');
  const root=new URL('../web/sdk/',import.meta.url);
  const loader=await readFile(new URL('v1/shifter-web-proxy.js',root),'utf8');
  const version=loader.match(/const RELEASE = '(\d+\.\d+\.\d+)'/)[1];
  const manifest=JSON.parse(await readFile(new URL(`releases/${version}/manifest.json`,root),'utf8'));
  for(const [file,expected] of Object.entries(manifest.sha256)) {
    const bytes=await readFile(new URL(`releases/${version}/${file}`,root));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),expected);
    assert.deepEqual(bytes,await readFile(new URL(`src/${file}`,root)));
  }
  assert.ok(loader.includes(`const RELEASE = '${manifest.version}'`));assert.equal(manifest.protocolVersion,1);
});

test('service worker can load reset assets even when engine configuration is unavailable',async()=>{
  const source=await readFile(new URL('../web/runtime/sw.js',import.meta.url),'utf8');
  const listeners={};let loads=0;
  const worker={location:{origin:'https://runtime.test'},addEventListener:(name,fn)=>listeners[name]=fn};
  runInNewContext(source,{self:worker,URL,importScripts(){},installRequestBodyCompatibility(){},$scramjetLoadWorker:()=>({ScramjetServiceWorker:class{loadConfig(){loads++;return new Promise(()=>{});}}}),fetch:async request=>({url:request.url})});
  let result;
  listeners.fetch({request:{url:'https://runtime.test/reset.html'},respondWith:response=>result=response});
  assert.equal((await result).url,'https://runtime.test/reset.html');assert.equal(loads,0);
});

test('country change waits for cleanup and reload preserves the assignment',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const e=environment(t);await e.start();e.runtimeMessage('ready');await flush();
  const before=e.proxy.getState().session.expiresAt;
  const change=e.proxy.changeCountry('de');await flush();
  assert.ok(document.querySelector('body > iframe'));
  e.runtimeMessage('cleared');await flush();t.mock.timers.tick(1400);await change;
  assert.equal(e.proxy.getState().country,'de');assert.equal(e.proxy.getState().session.expiresAt,before);
  e.runtimeMessage('ready');await flush();
  const sent=[];document.querySelector('iframe').contentWindow.postMessage=data=>sent.push(data);
  const reload=e.proxy.reload();await flush();t.mock.timers.tick(6500);await reload;
  assert.equal(sent.at(-1).command,'reconnect');assert.equal(e.proxy.getState().country,'de');
});

async function recoveryEnvironment(t) {
  t.mock.timers.enable({apis:['setTimeout']});
  const e=environment(t);await e.start();
  const sent=[];document.querySelector('iframe').contentWindow.postMessage=data=>sent.push(data);
  e.runtimeMessage('ready');await flush();
  e.fail=(overrides={})=>e.runtimeMessage('proxy-failure',{engineId:sent.at(-1).engineId,method:'GET',url:'https://example.com/',reason:'websocket',...overrides});
  e.sent=sent;
  e.advance=async(ms)=>{t.mock.timers.tick(ms);await flush();};
  return e;
}

test('safe proxy failures recover twice without exposing errors; stale transports cannot complete a retry',async t=>{
  const e=await recoveryEnvironment(t), states=[];e.proxy.subscribe(state=>states.push(state));
  const original=e.sent.at(-1).engineId;
  const expiry=e.proxy.getState().session.expiresAt;
  for(let i=1;i<=2;i++) {
    e.fail();e.fail();await e.advance(i*300);
    assert.equal(e.requests.filter(r=>r.url.endsWith('/recover')).length,i);
    assert.equal(e.proxy.getState().loading,true);assert.equal(e.proxy.getState().error,null);
    await e.advance(6500);
    assert.equal(e.sent.at(-1).command,'reconnect');assert.notEqual(e.sent.at(-1).engineId,original);
    e.runtimeMessage('loaded',{engineId:original});assert.equal(e.proxy.getState().loading,true);
  }
  assert.ok(states.every(s=>s.error===null));
  e.fail();await flush();assert.equal(e.proxy.getState().status,'interrupted');
  assert.equal(e.requests.filter(r=>r.url.endsWith('/recover')).length,2);
  assert.equal(e.proxy.getState().session.expiresAt,expiry);
  assert.equal(e.proxy.getState().session.remainingBytes,1000);
});

test('successful recovery completes loading and resets the retry budget',async t=>{
  const e=await recoveryEnvironment(t);e.fail();await e.advance(300);await e.advance(6500);
  e.runtimeMessage('loaded',{engineId:e.sent.at(-1).engineId});
  assert.equal(e.proxy.getState().loading,false);assert.equal(e.proxy.getState().status,'browsing');
  e.fail({reason:'upstream'});await e.advance(300);
  assert.equal(JSON.parse(e.requests.filter(r=>r.url.endsWith('/recover')).at(-1).options.body).reason,'upstream');
});

for(const overrides of [{method:'POST'},{method:'PUT'},{reason:'runtime'},{engineId:'stale'}]) {
  test(`unsafe or stale failure is never replayed: ${JSON.stringify(overrides)}`,async t=>{
    const e=await recoveryEnvironment(t);e.fail(overrides);await e.advance(1000);
    assert.ok(!e.requests.some(r=>r.url.endsWith('/recover')));
  });
}

test('Stop cancels recovery backoff and never creates another ticket',async t=>{
  const e=await recoveryEnvironment(t);e.fail();
  const stop=e.proxy.stop();await flush();e.runtimeMessage('cleared');await stop;
  await e.advance(10000);
  assert.equal(e.proxy.getState().status,'stopped');
  assert.ok(!e.requests.some(r=>r.url.endsWith('/recover')));
  assert.equal(e.requests.filter(r=>r.url.endsWith('/tickets')).length,1);
});

test('destroy during recovery prevents future reconnects',async t=>{
  const e=await recoveryEnvironment(t);e.fail();await e.advance(300);e.proxy.destroy();await e.advance(10000);
  assert.equal(e.sent.filter(d=>d.command==='reconnect').length,0);
  assert.equal(e.requests.filter(r=>r.url.endsWith('/tickets')).length,1);
});

test('server authorization/quota/storage refusal never loops or exposes technical details',async t=>{
  const e=await recoveryEnvironment(t), originalFetch=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async(url,options)=>url.endsWith('/recover')?{ok:false,status:503,json:async()=>({code:'STORAGE_UNAVAILABLE',error:'internal Redis trace'})}:originalFetch(url,options));
  e.fail();await e.advance(300);await e.advance(10000);
  assert.equal(e.sent.filter(d=>d.command==='reconnect').length,0);
  assert.equal(e.proxy.getState().status,'interrupted');assert.equal(e.proxy.getState().error,null);
});

test('navigation after refused recovery revokes the old lease before requesting a ticket',async t=>{
  const e=await recoveryEnvironment(t),originalFetch=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async(url,options)=>url.endsWith('/recover')?{ok:false,status:409,json:async()=>({code:'RECOVERY_UNAVAILABLE'})}:originalFetch(url,options));
  e.fail();await e.advance(300);assert.equal(e.proxy.getState().status,'interrupted');
  const navigate=e.proxy.navigate('example.org');await flush();
  assert.ok(e.requests.some(r=>r.url.endsWith('/reconnect')));
  assert.equal(e.requests.filter(r=>r.url.endsWith('/tickets')).length,1);
  await e.advance(6500);await navigate;
  assert.equal(e.sent.at(-1).url,'https://example.org/');
  assert.equal(e.requests.filter(r=>r.url.endsWith('/tickets')).length,2);
});

test('Stop during the retired-lease wait cancels the pending replacement ticket',async t=>{
  const e=await recoveryEnvironment(t);e.fail();await e.advance(300);
  const stop=e.proxy.stop();await flush();e.runtimeMessage('cleared');await stop;
  await e.advance(10000);
  assert.equal(e.requests.filter(r=>r.url.endsWith('/tickets')).length,1);
  assert.equal(e.proxy.getState().status,'stopped');
});

test('a new navigation cancels recovery and uses its own URL after transport revocation',async t=>{
  const e=await recoveryEnvironment(t);e.fail();await e.advance(300);
  const navigation=e.proxy.navigate('example.org');await flush();await e.advance(6500);await navigation;
  assert.equal(e.sent.at(-1).url,'https://example.org/');
  assert.equal(e.sent.filter(d=>d.command==='reconnect').length,1);
});

test('quota exhaustion during recovery retains the exhausted state and clears the runtime',async t=>{
  const e=await recoveryEnvironment(t), originalFetch=globalThis.fetch;
  e.setStatus({...e.proxy.getState().session,status:'exhausted',remainingBytes:0});
  t.mock.method(globalThis,'fetch',async(url,options)=>url.endsWith('/recover')?{ok:false,status:410,json:async()=>({code:'SESSION_ENDED',error:'Browsing session ended'})}:originalFetch(url,options));
  e.fail();await e.advance(300);
  assert.equal(e.proxy.getState().status,'exhausted');assert.equal(e.proxy.getState().active,false);
  e.runtimeMessage('cleared');await flush();
  assert.equal(e.sent.filter(d=>d.command==='reconnect').length,0);
});

test('slow page releases its overlay without a timeout notice',async t=>{
  const e=await recoveryEnvironment(t);
  await e.advance(25000);
  assert.equal(e.proxy.getState().loading,false);assert.equal(e.proxy.getState().error,null);
});

test('background API failure retries quietly and preserves the loaded destination and SID',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval','Date']});
  const e=environment(t);await e.start();e.runtimeMessage('ready');await flush();e.runtimeMessage('loaded');
  const before=e.proxy.getState(), original=globalThis.fetch, states=[];
  let reads=0, offline=true;
  e.proxy.subscribe(s=>states.push(s));
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    if(url.endsWith('/session')){reads++;if(offline)throw new TypeError('Failed to fetch');}
    return original(url,options);
  });
  for(const ms of [1500,500,1000]){t.mock.timers.tick(ms);await flush();}
  assert.equal(reads,3);assert.ok(states.every(s=>s.error===null));
  assert.equal(e.proxy.getState().status,'browsing');assert.deepEqual(e.proxy.getState().session,before.session);
  t.mock.timers.tick(1500);await flush();assert.equal(reads,3,'status polling backs off after failure');
  offline=false;t.mock.timers.tick(3000);await flush();assert.equal(reads,4);
  assert.ok(!e.requests.some(r=>r.url.endsWith('/recover')||r.url.endsWith('/reconnect')),'polling never resets Google or rotates SID');
});

test('gateway 502 API reads retry before initialization succeeds',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const e=environment(t), original=globalThis.fetch;let calls=0;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    if(url.endsWith('/config')&&++calls<3)return {ok:false,status:502,json:async()=>{throw new Error('HTML gateway response');}};
    return original(url,options);
  });
  const init=e.proxy.init();await flush();
  t.mock.timers.tick(500);await flush();t.mock.timers.tick(1000);await init;
  assert.equal(calls,3);assert.equal(e.proxy.getState().error,null);
});

test('destroy cancels queued API retries',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const e=environment(t);let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;throw new TypeError('Failed to fetch');});
  const init=e.proxy.init();await flush();e.proxy.destroy();
  await assert.rejects(init);t.mock.timers.tick(5000);await flush();assert.equal(calls,1);
});

test('explicit storage refusal is not retried as an API network failure',async t=>{
  const e=environment(t);let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return {ok:false,status:503,json:async()=>({code:'STORAGE_UNAVAILABLE',error:'Service unavailable'})};});
  await assert.rejects(e.proxy.init(),{code:'STORAGE_UNAVAILABLE'});assert.equal(calls,1);
});

test('ticket network failure retries silently before starting the destination once',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const e=environment(t);await e.start();
  const original=globalThis.fetch,sent=[];let tickets=0;
  document.querySelector('iframe').contentWindow.postMessage=data=>sent.push(data);
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    if(url.endsWith('/tickets')&&++tickets<3)throw new TypeError('Failed to fetch');
    return original(url,options);
  });
  e.runtimeMessage('ready');await flush();t.mock.timers.tick(500);await flush();t.mock.timers.tick(1000);await flush();
  assert.equal(tickets,3);assert.equal(sent.length,1);assert.equal(sent[0].command,'start');assert.equal(e.proxy.getState().error,null);
});

test('ambiguous mutating API failure never repeats the request or exposes a raw banner',async t=>{
  const e=await recoveryEnvironment(t),original=globalThis.fetch;let changes=0;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    if(url.endsWith('/country')){changes++;throw new TypeError('Failed to fetch');}
    return original(url,options);
  });
  await e.proxy.changeCountry('de');await e.advance(10000);
  assert.equal(changes,1);assert.equal(e.proxy.getState().error,null);assert.equal(e.proxy.getState().status,'interrupted');
});
