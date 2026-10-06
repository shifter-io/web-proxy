import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {create, destination} from '../web/sdk/src/client.js';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const flush = async () => { for(let i=0;i<12;i++) await Promise.resolve(); };
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
    } else if(url.endsWith('/tickets')) data={ticket:'one-use-ticket'};
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
  runInNewContext(source,{self:worker,URL,importScripts(){},$scramjetLoadWorker:()=>({ScramjetServiceWorker:class{loadConfig(){loads++;return new Promise(()=>{});}}}),fetch:async request=>({url:request.url})});
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
