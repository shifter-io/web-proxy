// Exercise Docker's actual ignore matching using disposable synthetic files.
import assert from 'node:assert/strict';
import {copyFile, mkdir, mkdtemp, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {docker} from './docker.mjs';
import {execFileSync} from 'node:child_process';

assert.ok((await docker(['context','inspect','--format','{{.Endpoints.docker.Host}}'])).trim().startsWith('unix://'), 'Local Docker required');
await mkdir('artifacts',{recursive:true});
const dir = await mkdtemp(path.resolve('artifacts/build-context-'));
const context = path.join(dir,'context');
const tag = `shifter-build-context:${path.basename(dir)}`;
const publicFiles = ['Cargo.toml','src/main.rs','web/control/index.html','web/runtime/runtime.js','web/sdk/v1/shifter-web-proxy.js','web/sdk/releases/1.0.0/client.js'];
const privateFiles = [
  '.env.captcha','.secrets/recaptcha-secret','compose.yaml','artifacts/evidence.json',
  'web/control/.env.captcha','web/control/.secrets/private','web/control/secrets/private',
  'web/control/.git/config','web/control/credentials.local.json','web/control/credentials.private.json',
  'web/control/private.key','web/control/private.pem','web/control/private.p12',
  'web/control/config.toml','web/control/config.yaml','web/control/redis.conf',
  'web/control/index.html.bak','web/control/index.html~','web/control/dump.rdb',
  'web/runtime/.env','web/sdk/releases/1.0.0/.env','web/sdk/src/client.js',
];
let container;
try {
  for (const file of [...publicFiles,...privateFiles]) {
    await mkdir(path.dirname(path.join(context,file)),{recursive:true});
    await writeFile(path.join(context,file),'synthetic-build-fixture');
  }
  await copyFile('.dockerignore',path.join(context,'.dockerignore'));
  await writeFile(path.join(context,'Dockerfile'),'FROM scratch\nCOPY . /context/\nCMD ["/never-executed"]\n');
  await docker(['build','--quiet','--tag',tag,context]);
  container = (await docker(['create',tag])).trim();
  const archive = path.join(dir,'image.tar');
  await docker(['export','--output',archive,container]);
  const args = ['-tf',archive];
  const names = execFileSync(process.platform==='darwin'?'/bin/zsh':'tar',process.platform==='darwin'?['-c','exec "$@"','sh','tar',...args]:args,{encoding:'utf8'}).split('\n');
  for (const file of publicFiles) assert.ok(names.includes(`context/${file}`),`Expected build input: ${file}`);
  for (const file of privateFiles) assert.ok(!names.includes(`context/${file}`),`Private build input must be excluded: ${file}`);
  console.log(`PASS Docker build boundary: ${privateFiles.length} private file fixtures excluded; public inputs preserved`);
} finally {
  if(container) await docker(['rm',container]);
  await docker(['image','rm',tag]).catch(()=>{});
  await rm(dir,{recursive:true,force:true});
}
