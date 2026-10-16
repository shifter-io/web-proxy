import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
const source=await readFile(new URL('../web/runtime/sw.js',import.meta.url),'utf8');

function worker({headers={},status=200,path='/file',direct=false,cancelFails=false}={}) {
  const listeners={};let reads=0,cancels=0,calls=0;
  class Engine extends EventTarget {
    constructor(){super();this.client={fetch:async()=>{
      calls++;
      const response=new Response(new ReadableStream({
        pull(){reads++;},cancel(){cancels++;if(cancelFails)throw Error('cancel failed');},
      },{highWaterMark:0}),{status,headers});
      response.finalURL='https://fixture.test'+path;
      return response;
    }};}
    loadConfig(){} route(){return true;}
    async fetch(event){
      this.dispatchEvent(Object.assign(new Event('request'),{url:'https://fixture.test'+path}));
      const response=await this.client.fetch('https://fixture.test'+path);
      this.dispatchEvent(new Event('handleResponse'));
      return response;
    }
  }
  // A synthetic engine response (blob/data/nested worker) can bypass BareMux.
  if(direct)Engine.prototype.fetch=async function(){return new Response('synthetic',{status,headers});};
  const context={self:{location:{origin:'https://runtime.test'},addEventListener:(name,fn)=>listeners[name]=fn},URL,Response,Headers,Proxy,Date,setTimeout,importScripts(){},installRequestBodyCompatibility(){},$scramjetLoadWorker:()=>({ScramjetServiceWorker:Engine})};
  runInNewContext(source,context,{filename:new URL('../web/runtime/sw.js',import.meta.url).pathname});
  return {counts:()=>({reads,cancels,calls}),async fetch(mode='navigate',destination='iframe'){
    let response;listeners.fetch({request:{url:'https://runtime.test/service/'+encodeURIComponent('https://fixture.test'+path),mode,destination,method:'GET'},respondWith:r=>response=r});return response;
  }};
}

for(const [name,options] of [
  ['attachment HTML',{headers:{'Content-Type':'text/html','Content-Disposition':'attachment; filename="page.html"'}}],
  ['mixed-case attachment',{headers:{'Content-Type':'text/plain','Content-Disposition':'AtTaChMeNt'}}],
  ['unknown disposition',{headers:{'Content-Type':'text/plain','Content-Disposition':'download; filename=file.txt'}}],
  ['executable MIME',{headers:{'Content-Type':'application/x-msdownload'}}],
  ['archive MIME',{headers:{'Content-Type':'application/zip; charset=binary'}}],
  ['encoded executable filename',{headers:{'Content-Type':'text/plain','Content-Disposition':"inline; filename*=UTF-8''setup%2Eexe"}}],
  ['binary package MIME',{headers:{'Content-Type':'application/vnd.debian.binary-package'}}],
  ['malformed filename encoding',{headers:{'Content-Type':'text/plain','Content-Disposition':'inline; filename=bad%ZZ.exe'}}],
  ['trailing filename dots',{headers:{'Content-Type':'text/plain','Content-Disposition':'inline; filename=setup.exe. '}}],
  ['mislabelled URL',{path:'/setup.EXE',headers:{'Content-Type':'text/plain'}}],
  ['partial attachment',{status:206,headers:{'Content-Type':'text/plain','Content-Disposition':'attachment; filename=chunk.txt'}}],
  ['failed cancellation',{cancelFails:true,headers:{'Content-Disposition':'attachment'}}],
]) {
  test(`blocks ${name} before reading the upstream body`,async()=>{
    for(const [mode,destination] of [['navigate','iframe'],['cors',''],['no-cors','script'],['no-cors','style']]) {
      const w=worker(options),response=await w.fetch(mode,destination);
      assert.equal(response.status,403);
      assert.equal(response.headers.get('content-disposition'),null);
      assert.equal(response.headers.get('cache-control'),'no-store');
      assert.deepEqual(w.counts(),{reads:0,cancels:1,calls:1});
      const body=await response.text();
      if(mode==='navigate')assert.match(body,/Downloads are disabled/);else assert.equal(body,'');
    }
  });
}
test('binary API fetch remains usable but binary navigation is blocked',async()=>{
  const w=worker({headers:{'Content-Type':'application/octet-stream'}});
  const response=await w.fetch('cors','');assert.equal(response.status,200);await response.body.cancel();
  assert.equal((await w.fetch()).status,403);
});
test('ordinary web formats render with an enforced download sandbox',async()=>{
  for(const type of ['text/html','text/plain','application/json','application/pdf','image/png','audio/mpeg','video/mp4']) {
    const w=worker({headers:{'Content-Type':type}}),response=await w.fetch();
    assert.equal(response.status,200,type);
    assert.match(response.headers.get('content-security-policy'),/sandbox allow-scripts allow-same-origin allow-forms/);
    assert.doesNotMatch(response.headers.get('content-security-policy'),/allow-downloads/);
    await response.body.cancel();
  }
});
test('redirects pass through for a separately checked final request',async()=>{
  const w=worker({status:302,headers:{Location:'https://fixture.test/file.zip'}}),response=await w.fetch();
  assert.equal(response.status,302);await response.body.cancel();
});
test('final response policy also covers synthetic engine responses',async()=>{
  for(const mode of ['navigate','cors']) {
    const w=worker({direct:true,headers:{'Content-Disposition':'attachment; filename=generated.txt'}});
    assert.equal((await w.fetch(mode)).status,403);
  }
});
test('both published iframe layers omit download and sandbox escape permissions',async()=>{
  for(const file of ['web/sdk/src/client.js','web/runtime/runtime.js']) {
    const script=await readFile(new URL('../'+file,import.meta.url),'utf8');
    assert.doesNotMatch(script,/allow-downloads|allow-popups-to-escape-sandbox|allow-top-navigation/);
  }
});

test('inline script filenames remain usable as scripts, but not as navigation',async()=>{
  for(const destination of ['script','worker','sharedworker']) {
    const w=worker({path:'/bundle%2Ejs',headers:{'Content-Type':'application/javascript','Content-Disposition':'inline; filename="bundle.js"'}});
    const response=await w.fetch('no-cors',destination);assert.equal(response.status,200);await response.body.cancel();
    assert.equal((await w.fetch()).status,403);
  }
});
test('missing, generic binary and unknown navigation MIME types fail closed',async()=>{
  for(const type of ['', 'application/octet-stream','application/unknown','text/csv','image/x-unrecognized','audio/x-unrecognized','video/x-unrecognized','image/tiff']) {
    for(const destination of ['iframe','document']) {
      const w=worker({headers:{'Content-Type':type}});
      const response=await w.fetch('navigate',destination);assert.equal(response.status,403,type);
      assert.deepEqual(w.counts(),{reads:0,cancels:1,calls:1});
    }
  }
});
test('JavaScript Fetch/XHR loaders work without allowing script downloads',async()=>{
  for(const type of ['application/javascript','text/javascript; charset=utf-8']) {
    for(const disposition of ['', 'inline; filename="bundle.js"']) {
      for(const mode of ['cors','same-origin','no-cors']) {
        const w=worker({path:'/bundle%2Ejs',headers:{'Content-Type':type,'Content-Disposition':disposition}});
        const response=await w.fetch(mode,'');assert.equal(response.status,200);await response.body.cancel();
        assert.equal((await w.fetch('navigate','document')).status,403);
      }
    }
    assert.equal((await worker({path:'/bundle.js',headers:{'Content-Type':type,'Content-Disposition':'attachment; filename="bundle.js"'}}).fetch('cors','')).status,403);
  }
  for(const type of ['text/plain','application/octet-stream','application/x-msdownload']) {
    assert.equal((await worker({path:'/bundle.js',headers:{'Content-Type':type}}).fetch('cors','')).status,403);
  }
});
