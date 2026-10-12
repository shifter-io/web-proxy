import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const lifecycle = await readFile(new URL('../web/runtime/lifecycle.js',import.meta.url),'utf8');
const reset = await readFile(new URL('../web/runtime/reset.js',import.meta.url),'utf8');
const runtime = await readFile(new URL('../web/runtime/runtime.js',import.meta.url),'utf8');
const flush = async () => { for (let i=0;i<50;i++) await Promise.resolve(); };

async function cleanup(t, {enumerate=true, abort=false, hang=false, denied=false, stop=false, absent=false}={}) {
  t.mock.timers.enable({apis:['setTimeout']});
  const opened=[],cleared=[],sent=[],redirects=[];
  const context={setTimeout,clearTimeout,Set,Promise,
    createRuntimeBridge:async()=>({query:'channel=fixture',send:(type,data)=>sent.push({type,...data})}),
    localStorage:{clear(){if(denied)throw new Error('sensitive browser exception');}},sessionStorage:{clear(){}},
    navigator:{serviceWorker:{getRegistrations:async()=>[{unregister:async()=>{}}]}},
    caches:{keys:async()=>['old-cache'],delete:async()=>{}},
    indexedDB:{...(enumerate?{databases:async()=>[{name:'destination-db'}]}:{}),open(name){
      opened.push(name);
      const request={result:{objectStoreNames:['cookies','config'],close(){},transaction(){
        const tx={objectStore(store){return {clear(){cleared.push({name,store});}};}};
        queueMicrotask(()=>abort?tx.onabort():tx.oncomplete());return tx;
      }}};
      if(!hang)queueMicrotask(()=>{
        if(absent) {
          request.transaction={abort:()=>queueMicrotask(()=>request.onerror())};
          request.onupgradeneeded({oldVersion:0});
        } else request.onsuccess();
      });
      return request;
    }},location:{hash:stop?'#stop':'',replace:url=>redirects.push(url)},document:{body:{textContent:''}}};
  const task=runInNewContext(lifecycle+'\n'+reset,context);
  await flush();
  return {task,context,opened,cleared,sent,redirects};
}

test('cleanup clears the pinned engine database without IndexedDB enumeration',async t=>{
  const e=await cleanup(t,{enumerate:false});await e.task;
  assert.deepEqual(e.opened,['$scramjet']);assert.equal(e.cleared.length,2);
  assert.deepEqual(e.redirects,['/index.html?channel=fixture']);
});

test('cleanup includes engine data even when enumeration omits it and clears other destination stores',async t=>{
  const e=await cleanup(t);await e.task;
  assert.deepEqual(e.opened,['$scramjet','destination-db']);assert.equal(e.cleared.length,4);
});

test('cold-profile cleanup never creates an empty engine schema',async t=>{
  const e=await cleanup(t,{enumerate:false,absent:true});await e.task;
  assert.deepEqual(e.opened,['$scramjet']);assert.equal(e.cleared.length,0);
  assert.deepEqual(e.redirects,['/index.html?channel=fixture']);
});

for(const options of [{abort:true},{hang:true},{denied:true}]) {
  test(`failed cleanup never opens a browsing runtime: ${JSON.stringify(options)}`,async t=>{
    const e=await cleanup(t,options);
    t.mock.timers.tick(6000);await e.task;
    assert.equal(e.redirects.length,0);assert.equal(e.sent.at(-1).type,'error');
    assert.match(e.context.document.body.textContent,/Reload/);
    assert.doesNotMatch(e.context.document.body.textContent,/sensitive/);
  });
}

test('Stop acknowledges clearing only after every store commits',async t=>{
  const e=await cleanup(t,{stop:true});await e.task;
  assert.equal(e.cleared.length,4);assert.equal(e.sent.at(-1).type,'cleared');
  assert.equal(e.redirects.length,0);
});

test('service worker activation times out and removes its listener; ready does not imply control',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const listeners=new Set();
  const serviceWorker={ready:Promise.resolve(),controller:{scriptURL:'https://old.test/sw.js?channel=fixture'},
    addEventListener:(type,listener)=>listeners.add(listener),removeEventListener:(type,listener)=>listeners.delete(listener)};
  const context={setTimeout,clearTimeout,URL,Promise,navigator:{serviceWorker},location:{href:'https://runtime.test/index.html'}};
  runInNewContext(lifecycle,context);
  const task=context.waitForRuntimeWorker('/sw.js?channel=fixture');
  const rejection=assert.rejects(task,/did not activate/);
  await flush();assert.equal(listeners.size,1);
  t.mock.timers.tick(12000);await rejection;assert.equal(listeners.size,0);
  const success=context.waitForRuntimeWorker('/sw.js?channel=fixture');await flush();
  serviceWorker.controller.scriptURL='https://runtime.test/sw.js?channel=fixture';
  for(const changed of listeners)changed();await success;assert.equal(listeners.size,0);
});

for(const step of ['features','storage','register','transport']) {
  test(`runtime ${step} failure replaces Preparing with a bounded actionable error`,async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    const sent=[],loading={textContent:'Preparing your browsing session…'},window=new EventTarget();
    const hang=()=>new Promise(()=>{});
    const context={setTimeout,clearTimeout,URL,Promise,WebAssembly,SharedWorker:class{},window,
      location:{href:'https://runtime.test/index.html'},document:{getElementById:()=>loading},
      createRuntimeBridge:async()=>({query:'fixture',send:(type,data)=>sent.push({type,...data}),accepts:()=>true}),
      prepareRuntimeData:async()=>{},
      navigator:{...(step==='features'?{}:{serviceWorker:{controller:{scriptURL:'https://runtime.test/sw.js?fixture'},register:step==='register'?hang:async()=>{}}})},
      $scramjetLoadController:()=>({ScramjetController:class {init(){return step==='storage'?hang():Promise.resolve();}}}),
      BareMux:{BareMuxConnection:class {setTransport(){return hang();}}}};
    const task=runInNewContext(lifecycle+'\n'+runtime,context);
    await flush();
    if(step==='transport') {
      assert.equal(sent.at(-1).type,'ready');
      const event=new Event('message');event.data={command:'start',engineId:'test',ticket:'test',url:'https://example.com'};
      window.dispatchEvent(event);await flush();
    }
    t.mock.timers.tick(12000);await flush();await task;
    assert.equal(sent.at(-1).type,'error');assert.match(loading.textContent,/Reload|full browser/);
    assert.doesNotMatch(loading.textContent,/Preparing/);
  });
}
