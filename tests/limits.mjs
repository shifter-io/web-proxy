import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {Visitor,Wisp,sleep,origin} from './client.mjs';
import {docker} from './docker.mjs';
assert.equal((await fetch(`${origin}/api/countries`).then(r=>r.json())).testMode,true);
const results=[];
const a=new Visitor();await a.start();
const expired=await a.ticket();
const ttl=Number(await docker(['compose','exec','-T','redis','redis-cli','-n','1','TTL',`ticket:${expired}`]));assert.ok(ttl>0&&ttl<=30);
await docker(['compose','exec','-T','redis','redis-cli','-n','1','PEXPIRE',`ticket:${expired}`,'1']);await sleep(20);
await assert.rejects(()=>Wisp.connect(expired));results.push('Expired tickets are rejected; issued TTL is at most 30 seconds');
const stale=await a.ticket();await a.api('session/country','POST',{country:'de'});await assert.rejects(()=>Wisp.connect(stale));results.push('Country changes invalidate outstanding tickets');
await fetch(`${origin}/api/session/country`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({country:'de'})}).then(r=>assert.equal(r.status,401));
await fetch(`${origin}/api/session/country`,{method:'POST',headers:{Origin:'https://untrusted.invalid',Cookie:a.cookie,'Content-Type':'application/json'},body:JSON.stringify({country:'de'})}).then(r=>assert.equal(r.status,403));results.push('Unauthenticated and cross-origin country changes are denied');
let c=await a.connect();let tasks=[];
try {for(let i=0;i<24;i++) tasks.push(c.request('fixture.test','/slow').then(()=>true,()=>false));await sleep(700);assert.equal(c.streams.size,16);results.push('Admission burst is limited to sixteen streams');}
finally {await c.close();await Promise.all(tasks);}
const b=new Visitor();await b.start();c=await b.connect();tasks=[];
try {
 for(let group=0;group<4;group++){for(let i=0;i<8;i++)tasks.push(c.request('fixture.test','/slow').then(()=>true,()=>false));await sleep(1100);}
 assert.equal(c.streams.size,32);await assert.rejects(()=>c.request('fixture.test','/ip'));assert.equal(c.streams.size,32);results.push('Thirty-two active streams are allowed and the thirty-third is denied');
} finally {await c.close();await Promise.all(tasks);}
await writeFile('artifacts/limits.json',JSON.stringify({at:new Date().toISOString(),results:results.map(name=>({name,passed:true}))},null,2));results.forEach(name=>console.log('PASS',name));
