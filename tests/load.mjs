import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {Visitor,sleep,origin} from './client.mjs';
import {docker} from './docker.mjs';
assert.equal((await fetch(`${origin}/api/countries`).then(r=>r.json())).testMode,true,'Load tests must use mock upstreams');
const results=[];
const stages=process.env.LOAD_STAGES?process.env.LOAD_STAGES.split(',').map(Number):[10,100,500,1000];
for(const count of stages) {
  const clients=[],errors=[],stats=[];let sampling=true;
  const sample=(async()=>{while(sampling){try{const out=await docker(['stats','--no-stream','--format','{{json .}}','shifter-web-gateway-a-1','shifter-web-gateway-b-1','shifter-web-redis-1','shifter-web-haproxy-1']);stats.push({at:new Date().toISOString(),containers:out.trim().split('\n').map(line=>JSON.parse(line))});}catch{} if(sampling)await sleep(500);}})();
  const setupStart=performance.now();
  for(let i=0;i<count;i+=50) {
    await Promise.all(Array.from({length:Math.min(50,count-i)},async(_,j)=>{
      try {const v=new Visitor();await v.start((i+j)%2?'de':'us');clients.push(await v.connect());}
      catch(e){errors.push(e.message);}
    }));
  }
  const establishedMs=performance.now()-setupStart;
  await sleep(1000);
  const replicas=await Promise.all(['gateway-a','gateway-b'].map(async service=>JSON.parse(await docker(['compose','exec','-T','api','curl','-fsS',`http://${service}:3000/metrics`]))));
  const latencies=[];const start=performance.now();let payloadBytes=0;
  await Promise.all(clients.map(async c=>{
    for(let round=0;round<2;round++) {
      const at=performance.now();
      try {const response=await c.request('fixture.test','/bytes?n=131072');const split=response.indexOf('\r\n\r\n');assert.equal(response.length-split-4,131072);payloadBytes+=131072;latencies.push(performance.now()-at);}
      catch(e){errors.push(e.message);}
    }
  }));
  const elapsedMs=performance.now()-start;
  await sleep(1000);sampling=false;await sample;
  latencies.sort((a,b)=>a-b);
  const pct=p=>Math.round(latencies[Math.min(latencies.length-1,Math.floor(latencies.length*p))]||0);
  const result={sessions:count,established:clients.length,establishedMs:Math.round(establishedMs),requests:latencies.length,errors:errors.length,errorSamples:errors.slice(0,3),payloadBytes,elapsedMs:Math.round(elapsedMs),throughputMiBps:Number((payloadBytes/1048576/(elapsedMs/1000)).toFixed(2)),latencyMs:{p50:pct(.5),p95:pct(.95),p99:pct(.99)},replicas,stats};
  results.push(result);console.log(JSON.stringify({...result,stats:`${stats.length} samples`}));
  await Promise.all(clients.map(c=>c.close()));await sleep(500);
}
await mkdir('artifacts',{recursive:true});await writeFile('artifacts/load.json',JSON.stringify({at:new Date().toISOString(),environment:'Local Docker on Apple Silicon; mock SOCKS5 upstream; 128 KiB HTTP bodies',results},null,2));
assert.ok(results.every(r=>r.errors===0&&r.established===r.sessions),'Load tests had errors; see artifacts/load.json');
