import assert from 'node:assert/strict';
import tls from 'node:tls';
import {writeFile} from 'node:fs/promises';
import {Visitor,origin} from './client.mjs';
import {docker} from './docker.mjs';
assert.equal((await fetch(`${origin}/api/countries`).then(r=>r.json())).testMode,false);
const ceiling=20*1024*1024;
const priorBytes=Number(await docker(['compose','exec','-T','redis','redis-cli','EVAL',"local n=0; for _,k in ipairs(redis.call('KEYS','daily:*')) do n=n+tonumber(redis.call('HGET',k,'used') or '0'); end; return n",'0']));
const cap=Math.min(1024*1024,ceiling-priorBytes);assert.ok(cap>0);
const v=new Visitor();await v.start('us');await docker(['compose','exec','-T','redis','redis-cli','HSET',v.key,'limit',String(cap)]);
const c=await v.connect();let result;
try {
  const response=await new Promise((resolve,reject)=>{
    const socket=tls.connect({socket:c.tunnel('example.com'),servername:'example.com',rejectUnauthorized:true});
    let data=Buffer.alloc(0);const timer=setTimeout(()=>socket.destroy(new Error('TLS test timeout')),20000);
    socket.once('secureConnect',()=>{assert.ok(socket.authorized);socket.write('GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n');});
    socket.on('data',chunk=>{data=Buffer.concat([data,chunk]);if(data.length>128*1024)socket.destroy(new Error('Response cap reached'));});
    socket.on('error',reject);socket.on('close',()=>clearTimeout(timer));socket.once('end',()=>resolve(data.toString()));
  });
  assert.match(response,/HTTP\/1.[01] 200/);assert.match(response,/Example Domain/);
  const used=(await v.api('session')).byteLimit-(await v.api('session')).remainingBytes;
  result={at:new Date().toISOString(),passed:true,hostname:'example.com',certificateVerified:true,country:'us',chargedBytes:used,priorBytes,cumulativeChargedBytes:priorBytes+used,ceilingBytes:ceiling,note:'Node TLS over the actual Wisp/Shifter path; browser TLS and frontend production certificates are separate checks.'};
} finally {await c.close();await v.api('session','DELETE').catch(()=>{});}
await writeFile('artifacts/live-tls.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
