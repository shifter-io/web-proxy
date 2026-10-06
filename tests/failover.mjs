import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import {Visitor,sleep,origin} from './client.mjs';
import {docker} from './docker.mjs';
assert.equal((await fetch(`${origin}/api/countries`).then(r=>r.json())).testMode,true);
const results=[];const clients=[];
async function healthy(service) {
  for(let i=0;i<30;i++) {try {await docker(['compose','exec','-T','api','curl','-fsS',`http://${service}:3000/health`]);await sleep(4500);return;}catch{await sleep(500);}}
  throw new Error(`${service} did not recover`);
}
try {
  console.log('Checking concurrent visitors on gateway-a');
  await docker(['compose','stop','gateway-b']);await sleep(9000);
  const a=new Visitor(),b=new Visitor();const before=await a.start('us');await b.start('de');
  const ca=await a.connect(),cb=await b.connect();clients.push(ca,cb);
  const [ia,ib]=await Promise.all([ca.json(),cb.json()]);assert.equal(ia.country,'us');assert.equal(ib.country,'de');assert.notEqual(ia.sid,ib.sid);
  const metrics=JSON.parse(await docker(['compose','exec','-T','api','curl','-fsS','http://gateway-a:3000/metrics']));assert.ok(metrics.connections>=2);
  results.push({name:'Different countries and SIDs on the same replica',passed:true});
  console.log('Checking replica failure and reconnect');
  await docker(['compose','start','gateway-b']);await healthy('gateway-b');
  const interrupted=ca.request('fixture.test','/slow').then(()=>false,()=>true);
  await sleep(250);await docker(['compose','stop','gateway-a']);assert.ok(await interrupted);await sleep(6500);
  const recovered=await a.connect();clients.push(recovered);const identity=await recovered.json();assert.equal(identity.sid,ia.sid);assert.equal(identity.country,'us');assert.equal(identity.ip,ia.ip);
  const after=await a.api('session');assert.equal(after.expiresAt,before.expiresAt);assert.ok(after.remainingBytes<before.remainingBytes);
  results.push({name:'Replica failure reconnects through surviving replica with same SID and remaining allowance',passed:true});
  await docker(['compose','start','gateway-a']);await healthy('gateway-a');
  console.log('Checking Redis outage');
  await docker(['compose','pause','redis']);await sleep(4500);assert.ok(recovered.closed);
  const result=await fetch(`${origin}/api/session`,{headers:{Cookie:a.cookie},signal:AbortSignal.timeout(5000)});assert.equal(result.status,503);
  results.push({name:'Redis outage closes active traffic and fails authorization closed',passed:true});
} finally {
  await docker(['compose','unpause','redis']).catch(()=>{});
  await docker(['compose','start','gateway-a','gateway-b']).catch(()=>{});
  await Promise.all(clients.map(c=>c.close()));
}
await mkdir('artifacts',{recursive:true});await writeFile('artifacts/failover.json',JSON.stringify({at:new Date().toISOString(),results},null,2));
results.forEach(r=>console.log('PASS',r.name));
