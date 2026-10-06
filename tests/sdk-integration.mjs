// Run against an isolated APP_ENV=test stack. Never connects to a real upstream.
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {docker} from './docker.mjs';
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
const sdk=await fetch(base+'/sdk/v1/shifter-web-proxy.js');assert.equal(sdk.status,200);assert.match(sdk.headers.get('cache-control'),/no-cache/);
const release=await fetch(base+'/sdk/releases/1.0.0/client.js');assert.equal(release.status,200);assert.match(release.headers.get('cache-control'),/immutable/);
assert.ok(!(await fetch(base+'/')).headers.has('cross-origin-embedder-policy'));
console.log('PASS SDK API: exact origins, CORS, CAPTCHA missing/invalid/expired/replayed/wrong-host, concurrent replay, bearer binding, separate quotas, Stop/resume, identity TTL, asset caching');
