// Run against an isolated APP_ENV=test stack. Never connects to a real upstream.
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {docker} from './docker.mjs';
import {Wisp, sleep} from './client.mjs';
const base=process.env.CONTROL_ORIGIN || 'http://localhost:8180';
const origins=['https://example.com','https://second.example.com'];
const hash=value=>createHash('sha256').update(value).digest('hex');
const redis=(...args)=>docker(['compose','exec','-T','redis','redis-cli','-n','1','--raw',...args]).then(s=>s.trim());
const check=await fetch(base+'/api/countries').then(r=>r.json());
assert.equal(check.testMode,true);
async function challenge(origin=origins[0],ttl=180) {
  const token=randomBytes(32).toString('hex');
  await redis('SET',`test-captcha:${hash(token)}`,new URL(origin).hostname,'EX',String(ttl));return token;
}
async function api(path,{origin=origins[0],method='GET',body,credential,expected=200}={}) {
  const response=await fetch(`${base}/api/v1/${path}`,{method,headers:{Origin:origin,...(body?{'Content-Type':'application/json'}:{}),...(credential?{Authorization:`Bearer ${credential}`}:{})},body:body?JSON.stringify(body):undefined});
  const data=await response.json().catch(()=>({}));
  assert.equal(response.status,expected,`${method} ${path}: ${data.code || response.status}`);return data;
}
for(const origin of origins) assert.equal((await api('config',{origin})).countries.length,54);
for(const origin of ['https://www.example.com','https://www.second.example.com','https://untrusted.invalid','http://example.com']) await api('config',{origin,expected:403});
const preflight=await fetch(base+'/api/v1/session',{method:'OPTIONS',headers:{Origin:origins[1],'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'authorization'}});
assert.equal(preflight.headers.get('access-control-allow-origin'),origins[1]);assert.match(preflight.headers.get('access-control-allow-headers'),/authorization/);
assert.notEqual(preflight.headers.get('access-control-allow-credentials'),'true');
await api('sessions',{method:'POST',body:{country:'us'},expected:422});
await api('sessions',{method:'POST',body:{country:'us',captchaToken:''},expected:400});
await api('sessions',{method:'POST',body:{country:'us',captchaToken:'bad'},expected:403});
await api('sessions',{method:'POST',body:{country:'us',captchaToken:await challenge(origins[1])},expected:403});
const expired=await challenge();await redis('DEL',`test-captcha:${hash(expired)}`);
await api('sessions',{method:'POST',body:{country:'us',captchaToken:expired},expected:403});
const token=await challenge();
const first=await api('sessions',{method:'POST',body:{country:'us',captchaToken:token}});
assert.equal(first.credential.length,64);assert.equal(first.session.developmentIdentity,undefined);
await api('sessions',{method:'POST',body:{country:'us',captchaToken:token},expected:403});
const concurrent=await challenge();
const responses=await Promise.all([1,2].map(()=>fetch(base+'/api/v1/sessions',{method:'POST',headers:{Origin:origins[0],'Content-Type':'application/json'},body:JSON.stringify({country:'us',captchaToken:concurrent})})));
assert.deepEqual(responses.map(r=>r.status).sort(),[200,403]);
const identity=JSON.parse(await redis('GET',`identity:${hash(first.credential)}`));
assert.equal(identity.site,'shifter');assert.ok(!JSON.stringify(identity).includes(first.credential));
await api('session',{credential:first.credential,origin:origins[1],expected:401});
await api('session',{expected:401});
await api('session',{credential:'a'.repeat(64),expected:401});
const key=`daily:shifter:${identity.visitor}:${Math.floor(Date.now()/86400000)}`;
await redis('HSET',key,'used','1000');
await redis('EXPIRE',`identity:${hash(first.credential)}`,'60');
await api('session',{method:'DELETE',credential:first.credential});
await api('session/tickets',{method:'POST',credential:first.credential,expected:410});
const resumed=await api('sessions',{method:'POST',credential:first.credential,body:{country:'de',captchaToken:await challenge()}});
assert.equal(resumed.credential,null);assert.equal(resumed.session.expiresAt,first.session.expiresAt);assert.equal(resumed.session.remainingBytes,first.session.remainingBytes-1000);
assert.ok(Number(await redis('TTL',`identity:${hash(first.credential)}`))>29*86400);
const second=await api('sessions',{method:'POST',origin:origins[1],body:{country:'us',captchaToken:await challenge(origins[1])}});
assert.equal(second.session.remainingBytes,first.session.remainingBytes);
const {ticket}=await api('session/tickets',{method:'POST',credential:first.credential});assert.equal(ticket.length,32);
const credential=first.credential;
let revision=Number(await redis('HGET',key,'rev'));
const sid=await redis('HGET',key,'sid');
const recovery={revision,url:'http://failed-upstream.test/',reason:'upstream'};
await api('session/recover',{method:'POST',body:recovery,expected:401});
await api('session/recover',{method:'POST',body:recovery,credential,origin:origins[1],expected:401});
await api('session/recover',{method:'POST',body:recovery,credential,expected:409});
const connection=await Wisp.connect(ticket);
try {
  await assert.rejects(connection.request('failed-upstream.test'));
  assert.equal(await redis('GET',`${key}:failure:failed-upstream.test`),String(revision));
  // The gateway must not record DNS/policy rejections as upstream failures.
  await assert.rejects(connection.request('127.0.0.1'));
  assert.equal(await redis('GET',`${key}:failure:127.0.0.1`),'');
  const races=await Promise.all([1,2].map(()=>fetch(base+'/api/v1/session/recover',{method:'POST',headers:{Origin:origins[0],Authorization:`Bearer ${credential}`,'Content-Type':'application/json'},body:JSON.stringify(recovery)})));
  assert.deepEqual(races.map(r=>r.status).sort(),[200,409]);
  assert.notEqual(await redis('HGET',key,'sid'),sid);
  assert.equal(await redis('HGET',key,'used'),'1000');
  assert.equal(await redis('HGET',key,'exp'),String(first.session.expiresAt));
  assert.equal(await redis('HGET',key,'country'),'de');
  await sleep(1500);assert.equal(connection.closed,true,'revision change retires the old transport');
} finally {await connection.close();}
const rotatedSid=await redis('HGET',key,'sid');
const fresh=await api('session/tickets',{method:'POST',credential});
const restored=await Wisp.connect(fresh.ticket);
try {assert.equal((await restored.json()).sid,rotatedSid);} finally {await restored.close();}
revision=fresh.revision;
await api('session/recover',{method:'POST',credential,body:{...recovery,revision,reason:'websocket'}});
assert.equal(await redis('HGET',key,'sid'),rotatedSid,'WebSocket reconnect preserves assignment');
await api('session/recover',{method:'POST',credential,body:{...recovery,revision:revision+1,reason:'websocket'},expected:409});
await redis('HSET',key,'used',String(first.session.byteLimit));
await api('session/recover',{method:'POST',credential,body:{...recovery,revision:revision+1},expected:410});
await redis('HSET',key,'used','1000','stopped','1');
await api('session/recover',{method:'POST',credential,body:{...recovery,revision:revision+1},expected:410});
await redis('HSET',key,'stopped','0','exp',String(Date.now()-1));
await api('session/recover',{method:'POST',credential,body:{...recovery,revision:revision+1},expected:410});
console.log('PASS recovery: gateway-attested SID rotation, WebSocket assignment retention, concurrent/stale rejection, two-attempt budget, country/expiry/quota preservation, stopped/expired/exhausted denial');
const sdk=await fetch(base+'/sdk/v1/shifter-web-proxy.js');assert.equal(sdk.status,200);assert.match(sdk.headers.get('cache-control'),/no-cache/);
const release=await fetch(base+'/sdk/releases/1.0.0/client.js');assert.equal(release.status,200);assert.match(release.headers.get('cache-control'),/immutable/);
assert.ok(!(await fetch(base+'/')).headers.has('cross-origin-embedder-policy'));
console.log('PASS SDK API: exact origins, CORS, CAPTCHA missing/invalid/expired/replayed/wrong-host, concurrent replay, bearer binding, separate quotas, Stop/resume, identity TTL, asset caching');
