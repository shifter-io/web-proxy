// Helpers for checks against the disposable APP_ENV=test stack started by tests/run-sdk-tests.mjs.
// Every Docker call goes through tests/docker.mjs, so a rootless DOCKER_HOST works unchanged.
import {readFile} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {docker} from './docker.mjs';

export const runtimeOrigin='http://localhost:8181';
export const sha256=value=>createHash('sha256').update(value).digest('hex');

// Reuse a stack kept by `run-sdk-tests.mjs --keep` when the runner did not pass its compose context.
export async function useKeptStack() {
  if (process.env.COMPOSE_FILE) return;
  const context=JSON.parse(await readFile('artifacts/sdk-test-context.json'));
  Object.assign(process.env,{COMPOSE_FILE:context.composeFile,COMPOSE_PROJECT_NAME:context.project,COMPOSE_PROFILES:'test',SHIFTER_CREDENTIALS_FILE:new URL('./fixtures/credentials.example.toml',import.meta.url).pathname});
}

// Test-only Redis database 1 of the disposable stack.
export const redis=(...args)=>docker(['compose','exec','-T','redis','redis-cli','-n','1','--raw',...args]).then(s=>s.trim());

// One-use token the mock CAPTCHA verifier accepts for pages on `hostname`.
export async function seedCaptcha(hostname,ttl=180) {
  const token=randomBytes(32).toString('hex');
  await redis('SET',`test-captcha:${sha256(token)}`,hostname,'EX',String(ttl));
  return token;
}

// Headless Chrome with a disposable profile, allowed to reach the loopback stack from `origins`.
export async function launchChrome(origins,args=[]) {
  const {default:puppeteer}=await import('puppeteer-core');
  const browser=await puppeteer.launch({channel:'chrome',headless:true,args});
  try {
    const permissions=await browser.target().createCDPSession();
    for(const origin of origins) await permissions.send('Browser.grantPermissions',{origin,permissions:['localNetworkAccess','localNetwork','loopbackNetwork']});
    await permissions.detach();
  } catch(error) {await browser.close();throw error;}
  return browser;
}
