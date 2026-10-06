import assert from 'node:assert/strict';
import {isIP} from 'node:net';

function privateAddress(address) {
  if (isIP(address)===4) {
    const [first,second]=address.split('.').map(Number);
    return first===10 || (first===172 && second>=16 && second<=31) || (first===192 && second===168);
  }
  return isIP(address)===6 && /^f[cd]/i.test(address);
}
function hasBindings(ports={}) {
  return Object.values(ports||{}).some(bindings=>bindings?.length>0);
}
export function assertRedisPrivate(redis, network, allowedIds) {
  assert.notEqual(redis.HostConfig?.NetworkMode,'host','Redis must not use host networking');
  assert.equal(redis.HostConfig?.PublishAllPorts,false,'Redis must not publish exposed ports');
  assert.ok(!hasBindings(redis.HostConfig?.PortBindings),'Redis must not configure host port bindings');
  assert.ok(!hasBindings(redis.NetworkSettings?.Ports),'Redis must not publish any port, including loopback');
  const endpoints=Object.values(redis.NetworkSettings?.Networks||{});
  assert.equal(endpoints.length,1,'Redis must attach only to its private state network');
  assert.equal(endpoints[0].NetworkID,network.Id,'Redis must use the inspected state network');
  assert.equal(network.Internal,true,'Redis state network must be internal');
  assert.equal(network.Driver,'bridge','Redis state network must use the bridge driver');
  for (const family of ['ipv4','ipv6']) {
    assert.equal(network.Options?.[`com.docker.network.bridge.gateway_mode_${family}`],'isolated','Redis state bridge must use isolated gateway modes');
  }
  assert.equal(network.Labels?.['com.docker.compose.network'],'session_state','Redis must use session_state');
  const addresses=[endpoints[0].IPAddress,endpoints[0].GlobalIPv6Address].filter(Boolean);
  assert.ok(addresses.length>0 && addresses.every(privateAddress),'Redis must have only RFC1918/ULA addresses');
  const members=Object.keys(network.Containers||{});
  assert.ok(members.includes(redis.Id),'Redis must be a member of the state network');
  assert.ok(members.every(id=>allowedIds.includes(id)),'Only Redis, API and gateways may join the state network');
}
