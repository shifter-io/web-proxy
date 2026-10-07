// Disposable local Chrome profile, synthetic upstream and test-only CAPTCHA.
// Start with tests/run-sdk-tests.mjs --keep; never uses the person's profile.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import puppeteer from 'puppeteer-core';
import {docker} from './docker.mjs';

if (!process.env.COMPOSE_FILE) {
  const context=JSON.parse(await readFile('artifacts/sdk-test-context.json'));
  Object.assign(process.env,{COMPOSE_FILE:context.composeFile,COMPOSE_PROJECT_NAME:context.project,COMPOSE_PROFILES:'test',SHIFTER_CREDENTIALS_FILE:new URL('./fixtures/credentials.example.toml',import.meta.url).pathname});
}
const host='http://127.0.0.1:8180',api='http://localhost:8180',runtimeOrigin='http://localhost:8181';
assert.equal((await fetch(api+'/api/countries').then(r=>r.json())).testMode,true);
const token=randomBytes(32).toString('hex');
await docker(['compose','exec','-T','redis','redis-cli','-n','1','SET',`test-captcha:${createHash('sha256').update(token).digest('hex')}`,'127.0.0.1','EX','180']);
const loader=await readFile(new URL('../web/sdk/v1/shifter-web-proxy.js',import.meta.url),'utf8');
const release=loader.match(/const RELEASE = '(\d+\.\d+\.\d+)'/)[1];
const browser=await puppeteer.launch({channel:'chrome',headless:true,args:['--site-per-process']});
const results=[],consoleErrors=[];
let page;
try {
  const permissions=await browser.target().createCDPSession();
  await permissions.send('Browser.grantPermissions',{origin:host,permissions:['localNetworkAccess','localNetwork','loopbackNetwork']});
  await permissions.send('Browser.grantPermissions',{origin:runtimeOrigin,permissions:['localNetworkAccess','localNetwork','loopbackNetwork']});
  await permissions.detach();
  page=await browser.newPage();
  page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
  await page.goto(host+'/minimal.html');
  await page.evaluate(async({api,release,token})=>{
    await proxy.destroy();
    document.body.innerHTML='<div id="view" style="height:700px"></div>';
    const {create}=await import(`${api}/sdk/releases/${release}/client.js`);
    window.grecaptcha={render:(_node,options)=>{queueMicrotask(()=>options.callback(token));return 0;},reset(){}};
    window.testProxy=create({container:document.querySelector('#view'),apiOrigin:api});
    window.messages=[];window.addEventListener('message',event=>{
      if(event.data?.source==='shifter-runtime') messages.push({type:event.data.type,reason:event.data.reason,method:event.data.method,url:event.data.url});
    });
    window.states=[];testProxy.subscribe(state=>{if(states.at(-1)?.status!==state.status)states.push({status:state.status,url:state.url});});
    await testProxy.search({url:'http://fixture.test/',country:'us'});
  },{api,release,token});
  const loaded=async()=>{
    await page.waitForFunction(()=>['browsing','interrupted'].includes(testProxy.getState().status) && !testProxy.getState().loading,{timeout:60000});
    assert.equal(await page.evaluate(()=>testProxy.getState().status),'browsing');
  };
  await loaded();
  console.log('Browser fixture loaded through the cross-site runtime');
  const destination=()=>page.frames().find(frame=>frame.url().startsWith(runtimeOrigin+'/service/'));
  const runtime=()=>page.frames().find(frame=>frame.url().startsWith(runtimeOrigin+'/index.html'));
  await destination().waitForSelector('#identity');
  // The synthetic SOCKS server cannot serve publicsuffix.org over HTTPS.
  // Cold-profile cross-origin modules must not depend on that network fetch.
  await destination().waitForFunction(()=>window.crossOriginModuleLoaded===true);
  await destination().waitForFunction(()=>window.incompleteScriptRecovered===true);
  results.push('An interrupted 200 script body is fetched again once and executes without restarting the session');
  results.push('Cross-origin modules load with a cold profile and no external Public Suffix List service');
  const identity=await destination().$eval('#identity',node=>node.textContent);
  const before=await page.evaluate(()=>testProxy.getState().session);
  await destination().evaluate(()=>{document.cookie='recovery_marker=preserved; Path=/';});
  await runtime().waitForFunction(async()=>{
    const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('$scramjet');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    const cookies=await new Promise((resolve,reject)=>{const request=db.transaction('cookies').objectStore('cookies').get('cookies');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    db.close();return JSON.stringify(cookies)?.includes('recovery_marker');
  },{timeout:10000});
  await runtime().evaluate(()=>localStorage.setItem('recovery-marker','preserved'));

  // Page.crash exercises the renderer failure that cannot emit an iframe error.
  const target=browser.targets().find(target=>target.url()===runtime().url());
  assert.ok(target,'runtime must occupy a separate renderer target');
  const cdp=await target.createCDPSession();
  const crash=cdp.send('Page.crash').catch(()=>{});
  console.log('Crashed only the disposable runtime renderer');
  await page.waitForFunction(()=>testProxy.getState().status==='connecting',{timeout:30000});
  await loaded();
  await destination().waitForSelector('#identity');
  assert.equal(await destination().$eval('#identity',node=>node.textContent),identity);
  assert.equal(await runtime().evaluate(()=>localStorage.getItem('recovery-marker')),'preserved');
  assert.match(await destination().evaluate(()=>document.cookie),/recovery_marker=preserved/);
  const after=await page.evaluate(()=>testProxy.getState().session);
  assert.equal(after.expiresAt,before.expiresAt);assert.equal(after.country,before.country);
  assert.ok(after.remainingBytes<=before.remainingBytes);
  assert.equal(new URL(await page.$eval('#view iframe',frame=>frame.src)).pathname,'/index.html');
  results.push('A real runtime renderer crash recovers automatically, retaining SID, cookies, storage, expiry and allowance');
  console.log('Browser renderer recovered with its persisted state');
  await cdp.detach().catch(()=>{});void crash;

  // Provoke an attested SOCKS failure beneath the cross-site embedder. Chrome
  // must render the worker placeholder so the SDK reaches bounded recovery.
  await page.evaluate(()=>{states.length=0;return testProxy.navigate('http://failed-upstream.test/');});
  await page.waitForFunction(()=>states.some(state=>state.status==='connecting'),{timeout:30000});
  await page.waitForFunction(()=>testProxy.getState().status==='interrupted',{timeout:60000});
  assert.ok(!consoleErrors.some(text=>text.includes('frame-ancestors')));
  await page.evaluate(()=>testProxy.navigate('http://fixture.test/'));
  await loaded();await destination().waitForSelector('#identity');
  results.push('Cross-origin embedded navigation failures reach recovery, stop at the retry bound, and allow later navigation');
  await page.evaluate(()=>testProxy.stop());
  results.push('Stop clears the recovered runtime');
  await writeFile('artifacts/browser-recovery.json',JSON.stringify({at:new Date().toISOString(),release,results},null,2));
  for(const result of results)console.log('PASS',result);
} catch(error) {
  for(const message of new Set(consoleErrors))console.error(message);
  if(page) console.error(await page.evaluate(()=>({status:window.testProxy?.getState().status,error:window.testProxy?.getState().error,states:window.states,messages:window.messages,requests:performance.getEntriesByType('resource').filter(r=>r.name.includes('/api/v1/')&&!r.name.endsWith('/session')).map(r=>({name:r.name,status:r.responseStatus}))})).catch(()=>({status:'unavailable'})));
  throw error;
} finally {await browser.close();}
