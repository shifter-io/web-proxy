// Disposable local Docker stack. Does not replace the developer's active stack/configuration.
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import assert from 'node:assert/strict';
import {docker} from './docker.mjs';
const root=path.resolve(import.meta.dirname,'..');process.chdir(root);
assert.ok((await docker(['context','inspect','--format','{{.Endpoints.docker.Host}}'])).trim().startsWith('unix://'),'Local Docker required');
await mkdir('artifacts',{recursive:true});
const dir=await mkdtemp(path.join(root,'artifacts/sdk-check-'));
const project=path.basename(dir).toLowerCase(),file=path.join(dir,'override.yaml');
const image=process.env.SDK_TEST_IMAGE || 'shifter-web:sdk-check';
const origins=JSON.stringify([{origin:'http://localhost:8180',site:'local'},{origin:'http://127.0.0.1:8180',site:'second-local'},{origin:'https://example.com',site:'shifter'},{origin:'https://second.example.com',site:'ip-info'},{origin:'https://staging.example.com',site:'shifter'}]);
await writeFile(file,`services:
  haproxy:
    ports: !override ["127.0.0.1:8180:8080", "127.0.0.1:8181:8081"]
    volumes: !override [${JSON.stringify(path.join(root,'deploy/haproxy.example.cfg')+':/usr/local/etc/haproxy/haproxy.cfg:ro')}]
  api:
    image: ${image}
    volumes: [${JSON.stringify(path.join(root,'web')+':/app/web:ro')}]
    environment:
      CONTROL_ORIGIN: http://localhost:8180
      RUNTIME_ORIGIN: http://localhost:8181
      INTEGRATIONS: '${origins}'
      RECAPTCHA_SITE_KEY: 6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI
  gateway-a:
    image: ${image}
    volumes: [${JSON.stringify(path.join(root,'web')+':/app/web:ro')}]
    environment:
      CONTROL_ORIGIN: http://localhost:8180
      RUNTIME_ORIGIN: http://localhost:8181
      INTEGRATIONS: '${origins}'
  gateway-b:
    image: ${image}
    volumes: [${JSON.stringify(path.join(root,'web')+':/app/web:ro')}]
    environment:
      CONTROL_ORIGIN: http://localhost:8180
      RUNTIME_ORIGIN: http://localhost:8181
      INTEGRATIONS: '${origins}'
`);
const env={...process.env,COMPOSE_PROJECT_NAME:project,COMPOSE_FILE:[path.join(root,'compose.example.yaml'),path.join(root,'compose.test.example.yaml'),file].join(':'),COMPOSE_PROFILES:'test',SHIFTER_CREDENTIALS_FILE:path.join(root,'tests/fixtures/credentials.example.toml'),CONTROL_ORIGIN:'http://localhost:8180',RUNTIME_ORIGIN:'http://localhost:8181',CONFIG_TEST_IMAGE:image};
const run=promisify(execFile);
async function command(cmd,args){const r=await run(process.platform==='darwin'?'/bin/zsh':cmd,process.platform==='darwin'?['-c','exec "$@"','sh',cmd,...args]:args,{cwd:root,env,maxBuffer:4*1024*1024});process.stdout.write(r.stdout);return r;}
let success=false;
try {
  await command('node',['scripts/vendor.mjs']);
  await command('node',['scripts/build-sdk.mjs']);
  await command('docker',['compose','up','-d','--no-build','--wait','--wait-timeout','90']);
  await command('node',['tests/sdk-integration.mjs']);
  await command('node',['tests/public-files.mjs']);
  await command('node',['tests/integration.mjs']);
  await command('node',['tests/limits.mjs']);
  await command('node',['tests/configuration.mjs']);
  if(process.argv.includes('--browser')) await command('node',['tests/browser-recovery.mjs']);
  success=true;
  if(process.argv.includes('--keep')) {
    await writeFile(path.join(root,'artifacts/sdk-test-context.json'),JSON.stringify({project,dir,composeFile:env.COMPOSE_FILE}));
    console.log('Kept disposable browser fixture at http://localhost:8180; context in artifacts/sdk-test-context.json');
  }
} finally {
  if(!success || !process.argv.includes('--keep')) {await command('docker',['compose','down','--volumes','--remove-orphans']);await rm(dir,{recursive:true,force:true});}
}
