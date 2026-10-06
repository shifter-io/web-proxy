// Local-only integration: real HAProxy TLS, production API/gateways, isolated ACL Redis.
// Set HTTPS_TEST_REDIS_TLS=1 to also run the application flow with verified Redis TLS.
// No destination streams are opened and no paid upstream traffic is generated.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdir, mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import WebSocket from 'ws';
import {docker} from './docker.mjs';
import {assertRedisPrivate} from './redis-network-policy.mjs';

const root = path.resolve(import.meta.dirname, '..');
process.chdir(root);
const endpoint = (await docker(['context','inspect','--format','{{.Endpoints.docker.Host}}'])).trim();
assert.ok(endpoint.startsWith('unix://'), 'This test must use a local Docker socket');
await mkdir('artifacts', {recursive:true});
const dir = await mkdtemp(path.join(root,'artifacts/https-check-'));
// Mounted fixture directory must be traversable by the non-root application/Redis users.
execFileSync('chmod',['755',dir]);
const project = `shifter-https-${randomBytes(4).toString('hex')}`;
const network = `${project}-state`;
const image = process.env.HTTPS_TEST_IMAGE || 'shifter-web:https-check';
const redisTls = process.env.HTTPS_TEST_REDIS_TLS === '1';
const control = 'example.com', runtime = 'proxy.example.net';
const secret = randomBytes(24).toString('hex');
const file = name => path.join(dir,name);
const compose = ['compose','--project-name',project,'--env-file',file('test.env'),'-f','compose.production.example.yaml','-f',file('override.yaml')];
const dc = args => docker([...compose,...args]);
function openssl(args) {
  const options={cwd:dir,stdio:'ignore'};
  if (process.platform==='darwin') execFileSync('/bin/zsh',['-c','exec "$@"','sh','openssl',...args],options);
  else execFileSync('openssl',args,options);
}
async function cert(name, san) {
  openssl(['req','-new','-newkey','rsa:2048','-nodes','-keyout',`${name}.key`,'-out',`${name}.csr`,'-subj',`/CN=${name}`]);
  await writeFile(file(`${name}.ext`),`subjectAltName=${san}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
  openssl(['x509','-req','-in',`${name}.csr`,'-CA','ca.crt','-CAkey','ca.key','-CAcreateserial','-out',`${name}.crt`,'-days','2','-extfile',`${name}.ext`]);
}
let networkCreated = false;
try {
  openssl(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.crt','-days','2','-subj','/CN=Local HTTPS test CA','-addext','basicConstraints=critical,CA:TRUE']);
  await cert('ingress',`DNS:${runtime}`);
  await cert('redis','DNS:redis');
  await mkdir(file('https'));
  await writeFile(file('https/ingress.pem'),Buffer.concat([await readFile(file('ingress.crt')),await readFile(file('ingress.key'))]));
  await writeFile(file('redis-url'),`${redisTls?'rediss':'redis'}://proxy:${secret}@redis:${redisTls?6380:6379}/0`);
  await writeFile(file('tls-url'),`rediss://proxy:${secret}@redis:6380/0`);
  await writeFile(file('bad-password'),`redis://proxy:wrong@redis:6379/0`);
  await writeFile(file('bad-hostname'),`rediss://proxy:${secret}@wrong-redis:6380/0`);
  await writeFile(file('redis.acl'),`user default off\nuser proxy on >${secret} ~daily:* ~ticket:* +ping +hello +select +client|setinfo +evalsha +script|load +exists +hset +pexpireat +hget +hincrby +hgetall +hdel +setex +getdel\n`);
  await writeFile(file('redis.conf'), 'bind 0.0.0.0\nprotected-mode yes\nport 6379\ntls-port 6380\ntls-cert-file /fixtures/redis.crt\ntls-key-file /fixtures/redis.key\ntls-ca-cert-file /fixtures/ca.crt\ntls-auth-clients no\naclfile /fixtures/redis.acl\nsave ""\nappendonly no\n');
  // Redis's unprivileged image user needs its generated fixture key; these are disposable keys.
  execFileSync('chmod',['644',file('redis.key')]);
  await writeFile(file('test.env'),`CONTROL_ORIGIN=https://${control}\nRUNTIME_HOST=${runtime}\nTLS_CERT_DIR=${file('https')}\nREDIS_NETWORK=${network}\nREDIS_URL_SECRET_FILE=${file('redis-url')}\nREDIS_TLS_DIR=${dir}\nREDIS_CA_FILE=${redisTls?'/run/redis-tls/ca.crt':''}\nSHIFTER_CREDENTIALS_FILE=${path.join(root,'tests/fixtures/credentials.example.toml')}\n`);
  // Override only image, local published ports and fixture mounts. Use production app settings.
  await writeFile(file('override.yaml'),`services:
  haproxy:
    ports: !override ["127.0.0.1::8080", "127.0.0.1::8443"]
    volumes:
      - ${JSON.stringify(path.join(root,'deploy/haproxy.production.example.cfg')+':/usr/local/etc/haproxy/haproxy.cfg:ro')}
  api:
    image: ${image}
    depends_on: {redis: {condition: service_started}}
  gateway-a:
    image: ${image}
    depends_on: {redis: {condition: service_started}}
  gateway-b:
    image: ${image}
    depends_on: {redis: {condition: service_started}}
  redis:
    image: redis:7.4-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499
    command: [redis-server, /fixtures/redis.conf]
    volumes: [${JSON.stringify(dir+':/fixtures:ro')}]
    networks:
      session_state:
        aliases: [wrong-redis]
`);
  await docker(['network','create','--internal','--driver','bridge','--opt','com.docker.network.bridge.gateway_mode_ipv4=isolated','--opt','com.docker.network.bridge.gateway_mode_ipv6=isolated','--label','com.docker.compose.network=session_state',network]);
  networkCreated = true;
  await dc(['run','--rm','--no-deps','haproxy','haproxy','-c','-f','/usr/local/etc/haproxy/haproxy.cfg']);
  await dc(['up','-d','--no-build','--wait','--wait-timeout','90']);
  const tlsPort = Number((await dc(['port','haproxy','8443'])).trim().split(':').at(-1));
  const httpPort = Number((await dc(['port','haproxy','8080'])).trim().split(':').at(-1));
  const ca = await readFile(file('ca.crt'));
  const lookup = (_host,options,callback) => options.all
    ? callback(null,[{address:'127.0.0.1',family:4}]) : callback(null,'127.0.0.1',4);
  async function request(host, route, {plain=false,method='GET',headers={},body,trust=ca}={}) {
    return new Promise((resolve,reject) => {
      const req=(plain?http:https).request({hostname:host,servername:host,port:plain?httpPort:tlsPort,path:route,method,ca:trust,lookup,headers:{Host:host,...headers},timeout:10000},res=>{
        let data='';res.on('data',chunk=>data+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:data}));
      });
      req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('request timed out')));
      req.end(body===undefined?undefined:JSON.stringify(body));
    });
  }
  for (const host of [runtime]) {
    const redirect=await request(host,'/hello?x=1',{plain:true});
    assert.equal(redirect.status,308);assert.equal(redirect.headers.location,`https://${host}/hello?x=1`);
    const response=await request(host,'/');assert.equal(response.status,200);
    assert.equal(response.headers['strict-transport-security'],'max-age=31536000');
    assert.equal((await request(host,'/metrics')).status,403);
  }
  assert.equal((await request(runtime,'/',{headers:{Host:'unexpected.example'}})).status,421);
  assert.equal((await request('unexpected.example','/',{plain:true})).status,421);
  await assert.rejects(request(runtime,'/',{trust:''}));
  const preflight=await request(runtime,'/api/sessions',{method:'OPTIONS',headers:{Origin:`https://${control}`,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type'}});
  assert.equal(preflight.headers['access-control-allow-origin'],`https://${control}`);
  assert.equal(preflight.headers['access-control-allow-credentials'],'true');
  const foreign=await request(runtime,'/api/sessions',{method:'POST',headers:{Origin:'https://wrong.example','Content-Type':'application/json'},body:{country:'us'}});
  assert.equal(foreign.status,403);
  assert.notEqual(foreign.headers['access-control-allow-origin'],'https://wrong.example');
  const started=await request(runtime,'/api/sessions',{method:'POST',headers:{Origin:`https://${control}`,'Content-Type':'application/json'},body:{country:'us'}});
  assert.equal(started.status,200,started.body);
  assert.equal(JSON.parse(started.body).developmentIdentity,true);
  const cookie=started.headers['set-cookie'][0];assert.match(cookie,/; Secure/);assert.match(cookie,/HttpOnly/);
  const apiHeaders={Origin:`https://${control}`,Cookie:cookie.split(';')[0]};
  assert.equal(started.headers['access-control-allow-origin'],`https://${control}`);
  const ticketResponse=await request(runtime,'/api/session/tickets',{method:'POST',headers:apiHeaders});
  assert.equal(ticketResponse.status,200,ticketResponse.body);
  const ticket=JSON.parse(ticketResponse.body).ticket;
  async function websocket(ticket, origin=`https://${runtime}`) {
    return new Promise((resolve,reject)=>{
      const ws=new WebSocket(`wss://${runtime}:${tlsPort}/wisp/${ticket}/`,{ca,lookup,headers:{Host:runtime},origin,handshakeTimeout:10000});
      ws.on('error',()=>{});
      ws.once('open',()=>{ws.close();resolve(101);});
      ws.once('unexpected-response',(_,res)=>{res.resume();ws.terminate();resolve(res.statusCode);});
      ws.once('error',reject);
    });
  }
  assert.equal(await websocket(ticket,'https://wrong.example'),403);
  assert.equal(await websocket(ticket),101);
  assert.notEqual(await websocket(ticket),101,'tickets must remain single use');
  for (const [urlFile,caFile] of [['bad-password',''],['bad-hostname','/run/redis-tls/ca.crt'],['tls-url','']]) {
    let rejected=false;
    try {await dc(['run','--rm','--no-deps','-e',`REDIS_URL_FILE=/run/redis-tls/${urlFile}`,'-e',`REDIS_CA_FILE=${caFile}`,'api']);}
    catch(error) {rejected=String(error.stderr||'').includes('Redis connection failed');assert.ok(!String(error.stderr).includes(secret));}
    assert.ok(rejected,`must reject ${urlFile} with CA ${caFile}`);
  }
  const ids=(await dc(['ps','-q'])).trim().split('\n');
  const containers=JSON.parse(await docker(['inspect',...ids]));
  const service=c=>c.Config.Labels['com.docker.compose.service'];
  const redis=containers.find(c=>service(c)==='redis');
  const [state]=JSON.parse(await docker(['network','inspect',network]));
  assertRedisPrivate(redis,state,containers.filter(c=>['redis','api','gateway-a','gateway-b'].includes(service(c))).map(c=>c.Id));
  for (const name of ['api','gateway-a','gateway-b']) {
    assert.equal(JSON.parse(await dc(['exec','-T',name,'curl','-fsS','http://localhost:3000/health'])).ok,true);
  }
  let denied=false;
  try {await dc(['exec','-T','haproxy','nc','-z','-w','2',Object.values(redis.NetworkSettings.Networks)[0].IPAddress,'6379']);}
  catch(error){assert.equal(error.code,1);denied=true;}
  assert.ok(denied,'HAProxy must not reach Redis');
  assert.match(await dc(['exec','-T','redis','redis-cli','-h','redis','PING']),/NOAUTH/);
  // Stop only this disposable fixture; the API must fail closed on lost quota storage.
  await dc(['stop','redis']);
  assert.equal((await request(runtime,'/api/session/tickets',{method:'POST',headers:apiHeaders})).status,503);
  const logs=await dc(['logs','--no-color','api','gateway-a','gateway-b','haproxy']);
  assert.ok(!logs.includes(secret) && !logs.includes(ticket),'credentials/tickets must not appear in logs');
  const result={passed:true,https:true,redirects:true,secureCookies:true,credentialedCors:true,authenticatedWss:true,singleUseTickets:true,redisAcl:true,redisTls,rejectBadPassword:true,rejectWrongHostname:true,rejectUntrustedCa:true,redisPrivate:true,redisUnreachableFromHAProxy:true,storageFailureClosed:true};
  await writeFile(path.join(root,`artifacts/https-deployment${redisTls?'-redis-tls':''}.json`),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
} catch (error) {
  const logs=await dc(['logs','--no-color','--tail','12','redis','api','gateway-a']).catch(()=> '');
  console.error(logs.replaceAll(secret,'[redacted]'));
  console.error(String(error).replaceAll(secret,'[redacted]'));
  throw error;
} finally {
  await dc(['down','--volumes','--remove-orphans']).catch(()=>{});
  if (networkCreated) await docker(['network','rm',network]);
  await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:250});
}
