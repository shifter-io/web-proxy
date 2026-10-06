import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRedisPrivate} from './redis-network-policy.mjs';
function fixture() {
  return {
    redis:{Id:'redis',HostConfig:{NetworkMode:'state',PublishAllPorts:false,PortBindings:{}},NetworkSettings:{Ports:{'6379/tcp':null},Networks:{state:{NetworkID:'state',IPAddress:'172.28.0.2',GlobalIPv6Address:''}}}},
    network:{Id:'state',Internal:true,Driver:'bridge',Options:{'com.docker.network.bridge.gateway_mode_ipv4':'isolated','com.docker.network.bridge.gateway_mode_ipv6':'isolated'},Labels:{'com.docker.compose.network':'session_state'},Containers:{redis:{},api:{},gateway:{}}},
    allowed:['redis','api','gateway']
  };
}
test('accepts an internal Redis with no host ports and approved clients',()=>{
  const f=fixture();assert.doesNotThrow(()=>assertRedisPrivate(f.redis,f.network,f.allowed));
});
for(const host of ['0.0.0.0','127.0.0.1','::']) {
  test(`rejects a Redis port published on ${host}`,()=>{
    const f=fixture();f.redis.NetworkSettings.Ports['6379/tcp']=[{HostIp:host,HostPort:'6379'}];
    assert.throws(()=>assertRedisPrivate(f.redis,f.network,f.allowed),/must not publish any port/);
  });
}
test('rejects a configured port mapping before it becomes active',()=>{
  const f=fixture();f.redis.HostConfig.PortBindings={'6379/tcp':[{HostIp:'127.0.0.1',HostPort:'6379'}]};
  assert.throws(()=>assertRedisPrivate(f.redis,f.network,f.allowed),/host port bindings/);
});
test('rejects host networking and automatic port publication',()=>{
  const f=fixture();f.redis.HostConfig.NetworkMode='host';assert.throws(()=>assertRedisPrivate(f.redis,f.network,f.allowed),/host networking/);
  f.redis.HostConfig.NetworkMode='state';f.redis.HostConfig.PublishAllPorts=true;assert.throws(()=>assertRedisPrivate(f.redis,f.network,f.allowed),/exposed ports/);
});
test('rejects a state network with external routing',()=>{
  const f=fixture();f.network.Internal=false;assert.throws(()=>assertRedisPrivate(f.redis,f.network,f.allowed),/must be internal/);
});
test('rejects an additional Redis network',()=>{
  const f=fixture();f.redis.NetworkSettings.Networks.public={NetworkID:'public',IPAddress:'10.0.0.2'};
  assert.throws(()=>assertRedisPrivate(f.redis,f.network,f.allowed),/only to its private state network/);
});
test('rejects public IPv4 and IPv6 addresses',()=>{
  for(const address of ['8.8.8.8','2606:4700:4700::1111']) {
    const f=fixture();f.redis.NetworkSettings.Networks.state.IPAddress=address;
    assert.throws(()=>assertRedisPrivate(f.redis,f.network,f.allowed),/RFC1918\/ULA/);
  }
});
test('rejects unauthorized members such as HAProxy or destination fixtures',()=>{
  const f=fixture();f.network.Containers.haproxy={};assert.throws(()=>assertRedisPrivate(f.redis,f.network,f.allowed),/Only Redis, API and gateways/);
});

test('rejects a bridge without isolated gateway modes',()=>{
  for(const family of ['ipv4','ipv6']) {
    const f=fixture();delete f.network.Options[`com.docker.network.bridge.gateway_mode_${family}`];
    assert.throws(()=>assertRedisPrivate(f.redis,f.network,f.allowed),/isolated gateway modes/);
  }
});
