import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const source=await readFile(new URL('../web/runtime/runtime-data.js',import.meta.url),'utf8');
const suffixes=await readFile(new URL('../web/runtime/public-suffix-list.dat',import.meta.url),'utf8');
function environment(body=suffixes,status=200) {
  const requests=[],writes=[];let transaction,closed=false,opened=false;
  const context={Date,fetch:async(url,options)=>{requests.push({url,options});return new Response(body,{status});},indexedDB:{open(name,version){
    assert.equal(name,'$scramjet');assert.equal(version,1);opened=true;
    const request={result:{transaction(store,mode){
      assert.equal(store,'publicSuffixList');assert.equal(mode,'readwrite');
      transaction={objectStore(name){assert.equal(name,store);return {put(value,key){writes.push({value,key});}};}};
      return transaction;
    },close(){closed=true;}}};
    queueMicrotask(()=>request.onsuccess());return request;
  }}};
  runInNewContext(source,context);
  return {prepare:context.prepareRuntimeData,requests,writes,commit:()=>transaction.oncomplete(),abort:()=>transaction.onabort(),closed:()=>closed,opened:()=>opened};
}
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};

test('bundled suffix data commits the pinned engine cache before browsing can start',async()=>{
  const e=environment();let finished=false;const task=e.prepare().then(()=>{finished=true;});
  await flush();assert.equal(finished,false);assert.equal(e.writes.length,1);
  const {key,value}=e.writes[0];assert.equal(key,'publicSuffixList');
  for(const rule of ['com','co.uk','github.io','*.ck','!www.ck'])assert.ok(value.data.includes(rule));
  assert.ok(!value.data.some(line=>!line||line.startsWith('//')));
  assert.ok(value.expiry>Date.now()+59*60*1000);
  assert.equal(e.requests.length,1);assert.equal(e.requests[0].url,'/public-suffix-list.dat');
  assert.match(suffixes,/Mozilla Public/);assert.match(suffixes,/COMMIT: [a-f0-9]{40}/);
  e.commit();await task;assert.equal(e.closed(),true);
});

test('missing or invalid local suffix data fails initialization without a remote fallback',async()=>{
  for(const [body,status] of [['unavailable',503],['<html>error</html>',200]]) {
    const e=environment(body,status);await assert.rejects(e.prepare());
    assert.equal(e.opened(),false);assert.equal(e.requests.length,1);
  }
});

test('aborted suffix cache writes fail initialization and close the database',async()=>{
  const e=environment(),task=e.prepare();await flush();e.abort();
  await assert.rejects(task,/could not be stored/);assert.equal(e.closed(),true);
});
