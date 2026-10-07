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
const env=JSON.parse(await docker(['compose','exec','-T','gateway-a','sh','-c','printf \'{"max":%s,"rate":%s,"burst":%s,"idle":%s}\' "$MAX_STREAMS" "$STREAM_RATE" "$STREAM_BURST" "$IDLE_TIMEOUT_SECONDS"']));
assert.ok(env.max>=32 && env.max<=128 && env.rate>0 && env.burst>0);
let c=await a.connect();
try {
 const count=Math.min(env.max*2,96),start=performance.now();
 const responses=await Promise.all(Array.from({length:count},()=>c.json()));
 assert.equal(new Set(responses.map(r=>r.sid)).size,1);assert.equal(c.closed,false);
 assert.ok(performance.now()-start >= Math.max(0,(count-env.burst)/env.rate*1000-150),'token bucket must still pace a burst');
 assert.equal((await c.json()).country,'de');
 results.push(`${count} burst requests finish on one transport without dropping scripts or bypassing rate limits`);
} finally {await c.close();}
const flood=new Visitor();await flood.start();c=await flood.connect();
try {
 for(let id=1;id<=257;id++) {
   const host='fixture.test',packet=Buffer.alloc(8+host.length);
   packet[0]=1;packet.writeUInt32LE(id,1);packet[5]=1;packet.writeUInt16LE(80,6);packet.write(host,8);c.ws.send(packet);
 }
 for(let i=0;i<30&&!c.closed;i++)await sleep(100);
 assert.equal(c.closed,true);
 results.push('A CONNECT flood still terminates the abusive transport');
} finally {await c.close();}
const b=new Visitor();await b.start();c=await b.connect();const tunnels=[];
try {
 const active=async()=>{
   const metrics=await Promise.all(['gateway-a','gateway-b'].map(service=>docker(['compose','exec','-T',service,'curl','-fsS','http://localhost:3000/metrics']).then(JSON.parse)));
   return metrics.reduce((n,m)=>n+m.streams,0);
 };
 for(let i=0;i<env.max;i++) {
   const socket=c.tunnel('fixture.test',80);socket.on('error',()=>{});socket.resume();
   socket.write('GET /slow HTTP/1.1\r\nHost: fixture.test\r\n\r\n');tunnels.push(socket);
 }
 for(let i=0;i<100 && await active()<env.max;i++)await sleep(100);
 assert.equal(await active(),env.max);
 let completed=false;const queued=c.json().then(r=>{completed=true;return r;});
 await sleep(300);assert.equal(completed,false);assert.equal(await active(),env.max);
 tunnels[0].destroy();assert.equal((await queued).country,'us');
 assert.ok(await active()<=env.max);assert.equal(c.closed,false);
 results.push('Concurrent cap is enforced; a queued navigation succeeds when an earlier stream closes');
 // Fill the bounded active+pending capacity. Overflow is per-stream and must
 // leave the Wisp transport alive so another navigation can still succeed.
 for(let i=0;i<env.max+1;i++) {
   const socket=c.tunnel('fixture.test',80);socket.on('error',()=>{});socket.resume();
   socket.write('GET /slow HTTP/1.1\r\nHost: fixture.test\r\n\r\n');tunnels.push(socket);
 }
 await sleep(300);
 await assert.rejects(()=>c.json(),/Stream closed \(73\)/);
 assert.equal(c.closed,false);assert.ok(await active()<=env.max);
 results.push('Bounded admission overflow rejects only the excess stream and preserves the connection');
} finally {for(const socket of tunnels)socket.destroy();await c.close();}

const idle=new Visitor();await idle.start();c=await idle.connect();
try {
 const socket=c.tunnel('fixture.test',80);socket.on('error',()=>{});socket.resume();
 const closed=new Promise(resolve=>socket.once('end',resolve));
 const start=performance.now();await Promise.race([closed,sleep((env.idle+3)*1000).then(()=>{throw new Error('Idle stream was not retired');})]);
 assert.ok(performance.now()-start>=env.idle*1000-200);
 assert.equal(c.closed,false);assert.equal((await c.json()).country,'us');
 results.push('Idle destination streams retire without closing the session transport');
} finally {await c.close();}
await writeFile('artifacts/limits.json',JSON.stringify({at:new Date().toISOString(),results:results.map(name=>({name,passed:true}))},null,2));results.forEach(name=>console.log('PASS',name));
