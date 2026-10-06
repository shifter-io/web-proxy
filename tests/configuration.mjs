import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {docker} from './docker.mjs';
let productionRejected=false;
try {await docker(['run','--rm','-e','APP_ENV=production','shifter-web:local']);}
catch(error){productionRejected=String(error.stderr||error.message).includes('production disabled');}
assert.ok(productionRejected);
const ids=(await docker(['compose','ps','-q'])).trim().split('\n');
const containers=JSON.parse(await docker(['inspect',...ids]));
const gateways=containers.filter(c=>c.Name.includes('-gateway-'));
assert.equal(gateways.length,2);
assert.ok(gateways.every(c=>c.Mounts.some(m=>m.Destination==='/run/secrets/shifter_credentials'&&m.RW===false)));
assert.ok(containers.every(c=>Object.values(c.NetworkSettings.Ports||{}).every(bindings=>!bindings||bindings.every(b=>b.HostIp==='127.0.0.1'))));
const result={at:new Date().toISOString(),productionRejected,readOnlyGatewaySecrets:true,onlyLoopbackPortsPublished:true,containers:containers.map(c=>({name:c.Name.slice(1),running:c.State.Running,health:c.State.Health?.Status||'running'}))};
await writeFile('artifacts/configuration.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
