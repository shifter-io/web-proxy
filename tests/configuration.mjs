import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {docker} from './docker.mjs';
import {assertRedisPrivate} from './redis-network-policy.mjs';
let productionRejected=false;
try {await docker(['run','--rm','-e','APP_ENV=production',process.env.CONFIG_TEST_IMAGE || 'shifter-web:local']);}
catch(error){productionRejected=String(error.stderr||error.message).includes('production requires HTTPS');}
assert.ok(productionRejected);
const ids=(await docker(['compose','ps','-q'])).trim().split('\n');
const containers=JSON.parse(await docker(['inspect',...ids]));
const gateways=containers.filter(c=>c.Name.includes('-gateway-'));
assert.equal(gateways.length,2);
assert.ok(gateways.every(c=>c.Mounts.some(m=>m.Destination==='/run/secrets/shifter_credentials'&&m.RW===false)));
for (const c of containers) {
  const isApi = c.Config.Labels['com.docker.compose.service'] === 'api';
  for (const mount of c.Mounts) {
    if (mount.Destination.startsWith('/run/secrets/')) {
      assert.equal(mount.RW, false, 'Secret mounts must be read-only');
    }
    if (mount.Destination === '/run/secrets/recaptcha_secret') {
      assert.ok(isApi, 'Only the API may mount the CAPTCHA secret');
    }
    assert.ok(!mount.Destination.startsWith('/app/web/') || !/secret|\.env/i.test(mount.Source), 'Secrets must not be mounted under the public web directory');
  }
  assert.ok(!c.Config.Env.some(value=>value.startsWith('RECAPTCHA_SECRET_KEY=')), 'Raw CAPTCHA secrets must not be placed in container environment metadata');
}
assert.ok(containers.every(c=>Object.values(c.NetworkSettings.Ports||{}).every(bindings=>!bindings||bindings.every(b=>b.HostIp==='127.0.0.1'))));
const service=c=>c.Config.Labels['com.docker.compose.service'];
const redis=containers.find(c=>service(c)==='redis');assert.ok(redis,'Redis container must exist');
const stateNetworks=Object.values(redis.NetworkSettings.Networks);assert.equal(stateNetworks.length,1,'Redis must attach only to session_state');
const [stateNetwork]=JSON.parse(await docker(['network','inspect',stateNetworks[0].NetworkID]));
const allowed=containers.filter(c=>['redis','api','gateway-a','gateway-b'].includes(service(c))).map(c=>c.Id);
assertRedisPrivate(redis,stateNetwork,allowed);
for(const c of containers.filter(c=>['api','gateway-a','gateway-b'].includes(service(c)))) {
  assert.ok(Object.values(c.NetworkSettings.Networks).some(n=>n.NetworkID===stateNetwork.Id),'API/gateways must join the private state network');
  let target;
  try {target=new URL((c.Config.Env.find(value=>value.startsWith('REDIS_URL='))||'').slice('REDIS_URL='.length));}
  catch {throw new Error('Application Redis URL must be valid');}
  assert.ok(['redis:','rediss:'].includes(target.protocol) && target.hostname==='redis' && (!target.port || target.port==='6379'),'Local API/gateways must use the private Redis service');
}
for (const service of ['api','gateway-a','gateway-b']) {
  const health=JSON.parse(await docker(['compose','exec','-T',service,'curl','--max-time','5','-fsS','http://localhost:3000/health']));
  assert.equal(health.ok,true,'Application health must confirm Redis access');
}
const redisAddress=stateNetworks[0].IPAddress;
assert.ok(redisAddress,'Local network isolation probe requires a Redis IPv4 address');
let denied=false;
try {await docker(['compose','exec','-T','haproxy','nc','-z','-w','2',redisAddress,'6379']);}
catch(error){assert.equal(error.code,1,'Expected a refused/timed-out connection rather than an execution error');denied=true;}
assert.ok(denied,'HAProxy must not be able to connect to the private Redis port');
const result={at:new Date().toISOString(),productionRejected,readOnlyGatewaySecrets:true,onlyLoopbackPortsPublished:true,redisNoPublishedPorts:true,redisInternalNetworkOnly:true,redisPrivateAddresses:true,redisRestrictedNetworkMembers:true,redisReachableFromApps:true,redisUnreachableFromHAProxy:true,containers:containers.map(c=>({name:c.Name.slice(1),running:c.State.Running,health:c.State.Health?.Status||'running'}))};
await writeFile('artifacts/configuration.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
