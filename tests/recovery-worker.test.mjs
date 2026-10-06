import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';
const source=await readFile(new URL('../web/runtime/sw.js',import.meta.url),'utf8');
function worker() {
  const listeners={};
  class Engine extends EventTarget {
    constructor(){super();this.client={fetch:async(url)=>{
      if(url.includes('websocket')) throw new Error('Hyper: WebSocketConnectFailed (Wisp WebSocket failed to connect)');
      if(url.includes('upstream')) throw new Error('stream unreachable');
      return new Response('Destination error or CAPTCHA',{status:503});
    }};}
    loadConfig(){} route(){return true;}
    async fetch(event){
      try {
        this.dispatchEvent(Object.assign(new Event('request'),{url:event.request.url}));
        if(event.request.url.includes('engine-error')) throw new Error('raw engine stack');
        const response=await this.client.fetch(event.request.url);
        this.dispatchEvent(new Event('handleResponse'));
        return response;
      } catch {return new Response('Uh oh! Raw diagnostic stack',{status:500});}
    }
  }
  runInNewContext(source,{self:{location:{origin:'https://runtime.test'},addEventListener:(name,fn)=>listeners[name]=fn},URL,Response,Proxy,Date,crypto:{randomUUID},importScripts(){},$scramjetLoadWorker:()=>({ScramjetServiceWorker:Engine})});
  return {
    async fetch(path,method='GET',mode='navigate') {
      let response;listeners.fetch({request:{url:'https://runtime.test/service/'+path,method,mode},respondWith:r=>{response=r;}});return response;
    },
    lookup(id,url='https://runtime.test/index.html'){let response='no reply';listeners.message({source:{url},data:{type:'proxy-failure',id},ports:[{postMessage:value=>{response=value;}}]});return response;},
  };
}
test('only thrown transport failures produce a trusted recovery capability; website 503 passes through',async()=>{
  const w=worker();
  const website=await w.fetch('website');assert.equal(website.status,503);assert.equal(await website.text(),'Destination error or CAPTCHA');
  const results=await Promise.all(['websocket','upstream','engine-error'].map(async path=>{
    const response=await w.fetch(path),text=await response.text();assert.doesNotMatch(text,/Uh oh|stack|Hyper/);
    assert.match(response.headers.get('cache-control'),/no-store/);
    const id=text.match(/data-id="([^"]+)"/)[1];
    assert.equal(w.lookup(id,'https://runtime.test/service/destination'),'no reply');
    const failure=w.lookup(id);assert.equal(failure.method,'GET');assert.equal(w.lookup(id),null);
    return failure.reason;
  }));
  assert.deepEqual(results,['websocket','upstream','runtime']);
  assert.equal(w.lookup(randomUUID()),null,'a forged destination marker cannot request recovery');
});
test('worker carries the actual POST method and ignores subresource failures',async()=>{
  const w=worker(),response=await w.fetch('websocket','POST');
  const id=(await response.text()).match(/data-id="([^"]+)"/)[1];assert.equal(w.lookup(id).method,'POST');
  assert.match(await (await w.fetch('upstream','GET','cors')).text(),/Raw diagnostic/,'only document navigation is eligible');
});
