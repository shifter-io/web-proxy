import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {Visitor,sleep,origin} from './client.mjs';
import {docker} from './docker.mjs';
assert.equal((await fetch(`${origin}/api/countries`).then(r=>r.json())).testMode,false,'Switch to the live stack first');
const results=[];const ceiling=20*1024*1024;
const priorBytes=Number(await docker(['compose','exec','-T','redis','redis-cli','EVAL',"local n=0; for _,k in ipairs(redis.call('KEYS','daily:*')) do n=n+tonumber(redis.call('HGET',k,'used') or '0'); end; return n",'0']));
let chargedBytes=priorBytes;assert.ok(priorBytes<ceiling,'The cumulative live smoke ceiling has already been reached');
const perVisitorCap=Math.floor((ceiling-priorBytes)/2);
for (const country of ['us','de']) {
  const visitor=new Visitor();await visitor.start(country);
  // Each of exactly two smoke visitors is capped server-side at 10 MiB, including both directions.
  await docker(['compose','exec','-T','redis','redis-cli','HSET',visitor.key,'limit',String(perVisitorCap)]);
  let connection=await visitor.connect();
  try {
    const samples=[];
    for (let i=0;i<2;i++) {
      const begin=performance.now();const data=await connection.json('second.example.com','/json');
      const detected=(data.country_code||data.countryCode||data.country||'').toLowerCase();
      assert.equal(detected,country,`Unexpected exit country for ${country}`);
      samples.push({ip:data.ip||data.query,country:detected,latencyMs:Math.round(performance.now()-begin)});
    }
    await connection.close();await sleep(500);connection=await visitor.connect();
    const data=await connection.json('second.example.com','/json');
    const detected=(data.country_code||data.countryCode||data.country||'').toLowerCase();
    assert.equal(detected,country);samples.push({ip:data.ip||data.query,country:detected,reconnected:true});
    assert.ok(samples.every(x=>x.ip),'IP endpoint did not return addresses');
    const state=await visitor.api('session');
    const used=state.byteLimit-state.remainingBytes;chargedBytes+=used;
    const result={country,samples,stickyObserved:samples.every(x=>x.ip===samples[0].ip),chargedBytes:used};
    results.push(result);console.log(JSON.stringify(result));
  } finally {await connection.close();await visitor.api('session','DELETE').catch(()=>{});}
}
assert.ok(chargedBytes<=ceiling);
await mkdir('artifacts',{recursive:true});await writeFile('artifacts/live-smoke.json',JSON.stringify({at:new Date().toISOString(),ceilingBytes:ceiling,priorBytes,chargedBytes,results},null,2));
console.log(`Live smoke traffic: ${chargedBytes} bytes of ${ceiling} allowed; six HTTP destination requests`);
