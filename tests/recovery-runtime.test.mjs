import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {MessageChannel} from 'node:worker_threads';
import {JSDOM} from 'jsdom';
const source=await readFile(new URL('../web/runtime/runtime.js',import.meta.url),'utf8');
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
async function runtime(t) {
  const dom=new JSDOM('<div id="loading">Loading</div>',{url:'https://runtime.test/index.html'});
  const {window}=dom, frames=[],sent=[],lookups=[];
  class Frame extends window.EventTarget {
    constructor(){super();this.frame=window.document.createElement('iframe');frames.push(this);}
    go(url){this.url=url;this.dispatchEvent(Object.assign(new window.Event('navigate'),{url}));this.frame.src='https://runtime.test/service/'+encodeURIComponent(url);}
  }
  const controller={postMessage:(data,ports)=>{lookups.push({data,reply:value=>ports[0].postMessage(value)});}};
  const bridge={query:'channel=fixture-generation',send:(type,data)=>sent.push({type,...data}),accepts:()=>true};
  await runInNewContext(source,{prepareRuntimeData:async()=>{},createRuntimeBridge:async()=>bridge,document:window.document,window,location:window.location,navigator:{serviceWorker:{register:async(url,options)=>{assert.equal(options.scope,'/');assert.equal(url,'/sw.js?'+bridge.query);controller.scriptURL='https://runtime.test'+url;},ready:Promise.resolve(),controller}},$scramjetLoadController:()=>({ScramjetController:class {async init(){}createFrame(){return new Frame();}}}),BareMux:{BareMuxConnection:class {async setTransport(){}}},URL,MessageChannel,setTimeout,clearTimeout,queueMicrotask,console});
  t.after(()=>window.close());
  async function command(command,data={}){window.dispatchEvent(new window.MessageEvent('message',{data:{command,...data}}));await flush();}
  async function load(marker){
    const frame=frames.at(-1).frame,doc=frame.contentDocument;
    doc.open();doc.write(marker?`<p id="shifter-connection-failure" data-id="${marker}">Connecting</p>`:'<h1>Website HTTP error or CAPTCHA</h1>');doc.close();
    frame.dispatchEvent(new window.Event('load'));await flush();
  }
  const waitFor=async predicate=>{for(let i=0;i<20&&!predicate();i++)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(predicate());};
  return {frames,sent,lookups,command,load,waitFor};
}
test('runtime keeps proxy error document hidden and sends recovery details instead of loaded',async t=>{
  const r=await runtime(t);await r.command('start',{ticket:'fixture-ticket',url:'https://example.com/',engineId:'first',recovery:true});
  await r.load('worker-capability');assert.equal(r.frames[0].frame.style.visibility,'hidden');
  for(const lookup of r.lookups)lookup.reply({reason:'websocket',method:'GET',url:'https://example.com/'});
  await r.waitFor(()=>r.sent.some(m=>m.type==='proxy-failure'));
  assert.ok(!r.sent.some(m=>m.type==='loaded'));
  const failure=r.sent.find(m=>m.type==='proxy-failure');assert.equal(failure.engineId,'first');assert.equal(failure.method,'GET');
  await r.command('go',{url:'https://example.org/'});await r.load();
  assert.equal(r.frames[0].frame.style.visibility,'','a later successful navigation must become visible');
});
test('older SDK gets a friendly error and destination error pages remain normal loaded pages',async t=>{
  const r=await runtime(t);await r.command('start',{ticket:'fixture-ticket',url:'https://example.com/'});
  await r.load();assert.ok(r.sent.some(m=>m.type==='loaded'));r.sent.length=0;
  await r.load('worker-capability');for(const lookup of r.lookups)lookup.reply({reason:'upstream',method:'POST',url:'https://example.com/'});
  await r.waitFor(()=>r.sent.some(m=>m.type==='error'));
  assert.ok(!r.sent.some(m=>m.type==='proxy-failure'));assert.doesNotMatch(r.sent.find(m=>m.type==='error').message,/Hyper|stack/);
});
test('worker response from a replaced runtime cannot fail the new navigation',async t=>{
  const r=await runtime(t);await r.command('start',{ticket:'fixture-ticket',url:'https://example.com/',engineId:'first',recovery:true});
  await r.load('worker-capability');await r.command('reconnect',{ticket:'fresh-ticket',url:'https://example.org/',engineId:'second',recovery:true});
  for(const lookup of r.lookups)lookup.reply({reason:'upstream',method:'GET',url:'https://example.com/'});
  await r.load();await r.waitFor(()=>r.sent.some(m=>m.type==='loaded'));
  assert.ok(!r.sent.some(m=>m.type==='proxy-failure'));assert.equal(r.sent.find(m=>m.type==='loaded').engineId,'second');
});

test('runtime echoes authenticated probes only for the active engine',async t=>{
  const r=await runtime(t);
  assert.equal(r.sent.find(m=>m.type==='ready').heartbeat,true);
  await r.command('start',{ticket:'fixture-ticket',url:'https://example.com/',engineId:'current'});
  await r.command('ping',{engineId:'stale',probe:'old'});
  assert.ok(!r.sent.some(m=>m.type==='pong'));
  await r.command('ping',{engineId:'current',probe:'fresh'});
  assert.equal(r.sent.at(-1).type,'pong');assert.equal(r.sent.at(-1).probe,'fresh');
  assert.equal(r.sent.at(-1).engineId,'current');
});

test('browser error document cannot be reported as successfully loaded',async t=>{
  const r=await runtime(t);
  await r.command('start',{ticket:'fixture-ticket',url:'https://example.com/',engineId:'current'});
  const frame=r.frames[0].frame;
  Object.defineProperty(frame,'contentDocument',{value:null});
  frame.dispatchEvent(new frame.ownerDocument.defaultView.Event('load'));await flush();
  assert.ok(r.sent.some(m=>m.type==='error'));assert.ok(!r.sent.some(m=>m.type==='loaded'));
});
