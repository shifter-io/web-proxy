import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
const source=await readFile(new URL('../web/runtime/sw.js',import.meta.url),'utf8');
function worker({failures=1,status=200,rewriteError=false,connectionError=false}={}) {
  let calls=0;const listeners={},methods=[];
  class Engine extends EventTarget {
    constructor(){super();this.client={fetch:async()=>{
      calls++;
      if(connectionError)throw new Error('connection refused');
      const broken=calls<=failures;
      return new Response(new ReadableStream({start(controller){
        if(broken)controller.error(new TypeError('Failed to fetch'));
        else {controller.enqueue(new TextEncoder().encode('window.ready=true;'));controller.close();}
      }}),{status});
    }};}
    loadConfig(){} route(){return true;}
    async fetch(event) {
      try {
        this.dispatchEvent(new Event('request'));
        const response=await this.client.fetch(event.request.url);
        methods.push(event.request.destination==='style'?'text':'arrayBuffer');
        const body=await response[methods.at(-1)]();
        if(rewriteError)throw new Error('rewrite failed');
        this.dispatchEvent(new Event('handleResponse'));
        return new Response(body,{status});
      }catch{return new Response('',{status:500});}
    }
  }
  runInNewContext(source,{self:{location:{origin:'https://runtime.test'},addEventListener:(name,fn)=>listeners[name]=fn},URL,Response,Proxy,Date,setTimeout,importScripts(){},installRequestBodyCompatibility(){},$scramjetLoadWorker:()=>({ScramjetServiceWorker:Engine})});
  return {calls:()=>calls,async fetch({method='GET',destination='script',signal}={}){
    let response;listeners.fetch({request:{url:'https://runtime.test/service/resource',mode:'no-cors',method,destination,signal},respondWith:value=>{response=value;}});return response;
  }};
}
test('incomplete successful GET scripts and styles retry once on the same resource',async()=>{
  for(const destination of ['script','style']){
    const w=worker();const response=await w.fetch({destination});
    assert.equal(response.status,200);assert.equal(await response.text(),'window.ready=true;');assert.equal(w.calls(),2);
  }
});
test('repeated truncation stops at two attempts',async()=>{
  const w=worker({failures:99});assert.equal((await w.fetch()).status,500);assert.equal(w.calls(),2);
});
test('website failures, connection refusals, rewriting failures, other requests and cancellation do not retry',async()=>{
  const cases=[
    [{status:503},{},500],
    [{status:503,failures:0},{},503],
    [{failures:0,rewriteError:true},{},500],
    [{connectionError:true},{},500],
    [{},{method:'POST'},500],
    [{},{destination:'image'},500],
    [{},{destination:''},500],
    [{},{signal:AbortSignal.abort()},500],
  ];
  for(const [options,request,status] of cases){
    const w=worker(options),response=await w.fetch(request);
    assert.equal(response.status,status);
    assert.equal(w.calls(),1);
  }
});
