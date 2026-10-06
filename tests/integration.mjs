import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {Visitor,Wisp,sleep,origin,runtime} from './client.mjs';
const results=[];
async function check(name,fn) { const start=performance.now();await fn();results.push({name,passed:true,ms:Math.round(performance.now()-start)});console.log('PASS',name); }
function redis(...args) {
  const command=['docker','compose','exec','-T','redis','redis-cli','-n','1','--raw',...args];
  return (process.platform==='darwin'?execFileSync('/bin/zsh',['-c','exec "$@"','sh',...command],{encoding:'utf8'}):execFileSync(command[0],command.slice(1),{encoding:'utf8'})).trim();
}
const metadata=await fetch(`${origin}/api/countries`).then(r=>r.json());
assert.equal(metadata.testMode,true,'Integration mutation tests require the mock Docker profile');
const open=[];
try {
  await check('Reject missing/invalid countries and extra routing fields',async()=>{
    const v=new Visitor();await v.api('sessions','POST',{},422);await v.api('sessions','POST',{country:'xx'},400);
    await v.api('sessions','POST',{country:'us',sid:'injected'},422);
  });
  await check('Reject cross-origin session creation',async()=>{
    const r=await fetch(`${origin}/api/sessions`,{method:'POST',headers:{Origin:'https://untrusted.invalid','Content-Type':'application/json'},body:'{"country":"us"}'});assert.equal(r.status,403);
  });
  await check('Reject forged ticket',async()=>{await assert.rejects(()=>Wisp.connect('a'.repeat(32)));});
  const a=new Visitor(),b=new Visitor();await a.start('us');await b.start('de');
  const ca=await a.connect(),cb=await b.connect();open.push(ca,cb);
  let firstA,firstB;
  await check('Concurrent countries and SIDs are isolated',async()=>{
    [firstA,firstB]=await Promise.all([ca.json(),cb.json()]);
    assert.equal(firstA.country,'us');assert.equal(firstB.country,'de');assert.notEqual(firstA.sid,firstB.sid);
    const next=await ca.json();assert.equal(next.sid,firstA.sid);assert.equal(next.ip,firstA.ip);
  });
  await check('A second active connection is denied',async()=>{await assert.rejects(()=>a.connect());});
  await check('Malformed Wisp packets terminate only their connection',async()=>{
    const v=new Visitor();await v.start();const c=await v.connect();open.push(c);c.ws.send(Buffer.from([1]));await sleep(250);assert.ok(c.closed);
    assert.equal((await ca.json()).country,'us');
  });
  await check('Private addresses, infrastructure, ports, and UDP are denied',async()=>{
    for(const [host,options] of [['127.0.0.1',{}],['169.254.169.254',{}],['p.shifter.io',{}],['fixture.test',{port:22}],['fixture.test',{type:2}],['::ffff:127.0.0.1',{}]]) await assert.rejects(()=>ca.request(host,'/',options));
  });
  await check('Ticket is single-use and bound to runtime origin',async()=>{
    const v=new Visitor();await v.start();const t=await v.ticket();const c=await Wisp.connect(t);await c.close();await sleep(250);
    await assert.rejects(()=>Wisp.connect(t));
    const t2=await v.ticket();await assert.rejects(()=>Wisp.connect(t2,'https://untrusted.invalid'));
  });
  await check('Reconnect preserves SID and allowance',async()=>{
    const before=await a.api('session');await ca.close();await sleep(250);
    const c=await a.connect();open.push(c);const identity=await c.json();assert.equal(identity.sid,firstA.sid);
    const after=await a.api('session');assert.equal(after.expiresAt,before.expiresAt);assert.ok(after.remainingBytes<before.remainingBytes);await c.close();
  });
  await check('Country change revokes old streams and preserves allowance',async()=>{
    const before=await b.api('session');const next=await b.api('session/country','POST',{country:'gb'});
    assert.equal(next.expiresAt,before.expiresAt);assert.equal(next.remainingBytes,before.remainingBytes);
    await sleep(1400);assert.ok(cb.closed);const c=await b.connect();open.push(c);const x=await c.json();assert.equal(x.country,'gb');assert.notEqual(x.sid,firstB.sid);await c.close();
  });
  await check('Synthetic login form and redirect response survive transport',async()=>{
    const v=new Visitor();await v.start();const c=await v.connect();open.push(c);
    const response=(await c.request('fixture.test','/login',{method:'POST',body:'username=alice',headers:{'Content-Type':'application/x-www-form-urlencoded'}})).toString();
    assert.match(response,/302 Found/);assert.match(response,/Set-Cookie: fixture_user=alice/);
    const page=(await c.request('fixture.test','/',{headers:{Cookie:'fixture_user=alice'}})).toString();assert.match(page,/Signed in as alice/);await c.close();
  });
  await check('Hard byte cap across concurrent streams, reconnect and country change',async()=>{
    const v=new Visitor();await v.start();redis('HSET',v.key,'limit','5000');const c=await v.connect();open.push(c);
    await Promise.allSettled([c.request('fixture.test','/bytes?n=8192'),c.request('fixture.test','/bytes?n=8192')]);await sleep(1200);
    assert.equal(Number(redis('HGET',v.key,'used')),5000);assert.ok(c.closed);
    await v.api('session/tickets','POST',undefined,410);await v.api('session/country','POST',{country:'de'},410);
    const resumed=await v.start();assert.equal(resumed.remainingBytes,0);
  });
  await check('Hard expiry closes a running stream and rejects reconnect',async()=>{
    const v=new Visitor();await v.start();redis('HSET',v.key,'exp',String(Date.now()+1500));
    const c=await v.connect();open.push(c);await c.request('fixture.test','/slow').catch(()=>{});await sleep(600);
    assert.ok(c.closed);await v.api('session/tickets','POST',undefined,410);
    const resumed=await v.start();assert.equal(resumed.status,'expired');
  });
  await check('Stop then resume retains the original time and byte budget',async()=>{
    const v=new Visitor();const before=await v.start();const c=await v.connect();open.push(c);await c.json();
    await v.api('session','DELETE');await sleep(1200);assert.ok(c.closed);
    const resumed=await v.start('de');assert.equal(resumed.expiresAt,before.expiresAt);assert.ok(resumed.remainingBytes<before.remainingBytes);assert.equal(resumed.country,'de');
  });
} finally {await Promise.all(open.map(c=>c.close()));}
await mkdir('artifacts',{recursive:true});
await writeFile('artifacts/integration.json',JSON.stringify({at:new Date().toISOString(),results},null,2));
console.log(`${results.length} integration checks passed`);
