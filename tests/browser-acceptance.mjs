// Synthetic browser acceptance of the Shifter control page (web/control) and the hosted SDK loader.
// The page runs cross-site (127.0.0.1:8180, runtime on localhost:8181) in a disposable headless
// Chrome profile against the synthetic SOCKS upstream; CAPTCHA tokens are test-only records in
// Redis DB 1 of the disposable stack. Never contacts a real upstream, CAPTCHA service or profile.
// Run: node tests/run-sdk-tests.mjs --acceptance, or node tests/browser-acceptance.mjs after --keep.
// ACCEPTANCE_IDLE_SECONDS (default 65, at least 60) sets the idle wait of the idle-stability step.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';
import {useKeptStack,redis,seedCaptcha,launchChrome,runtimeOrigin,sha256} from './test-stack.mjs';

await useKeptStack();
const host='http://127.0.0.1:8180',fixture='http://fixture.test/';
const idleSeconds=Number(process.env.ACCEPTANCE_IDLE_SECONDS ?? 65);
assert.ok(Number.isFinite(idleSeconds) && idleSeconds>=60,'ACCEPTANCE_IDLE_SECONDS must be at least 60');
assert.equal((await fetch('http://localhost:8180/api/countries').then(r=>r.json())).testMode,true);
const loader=await readFile(new URL('../web/sdk/v1/shifter-web-proxy.js',import.meta.url),'utf8');
const release=loader.match(/const RELEASE = '(\d+\.\d+\.\d+)'/)[1];
const browser=await launchChrome([host,runtimeOrigin],['--site-per-process']);
const results=[],consoleErrors=[],sids=new Set();
let page,lastSession;

// Polls a condition (200 ms interval) until it returns a truthy value or the timeout passes.
async function until(check,what,timeout=60000) {
  const end=Date.now()+timeout;let last;
  for(;;) {
    try {const value=await check();if(value)return value;last=undefined;} catch(error) {last=error.message;}
    if(Date.now()>end) throw new Error(`Timed out after ${timeout} ms waiting for ${what}${last?` (${last})`:''}`);
    await sleep(200);
  }
}
const destination=()=>page.frames().find(frame=>frame.url().startsWith(runtimeOrigin+'/service/'));
async function text(frame,selector) {
  if(!frame) throw new Error('destination frame not ready');
  return frame.$eval(selector,node=>node.textContent.trim());
}
const waitText=(selector,matcher,timeout=60000)=>until(async()=>{
  const value=await text(destination(),selector);
  return (typeof matcher==='string'?value===matcher:matcher.test(value)) && value;
},`destination ${selector} ${matcher}`,timeout);
const view=()=>page.evaluate(()=>{
  const $=id=>document.getElementById(id);
  return {status:$('status').textContent,loading:!$('page-loading').hidden,browsing:document.body.classList.contains('is-browsing'),
    runtimeHidden:$('runtime-host').hidden,expiredHidden:$('expired').hidden,goDisabled:$('go').disabled,notice:$('notice').textContent,address:$('address').value};
});
const browsing=()=>until(async()=>{const v=await view();return v.status==='Browsing through Shifter' && !v.loading;},'Browsing through Shifter');
async function session() {
  lastSession=await page.evaluate(async host=>{
    const key=Object.keys(localStorage).find(name=>name.startsWith('shifter-web-proxy:v1:'));
    const response=await fetch(host+'/api/v1/session',{credentials:'omit',headers:{Authorization:`Bearer ${localStorage.getItem(key)}`}});
    return response.json();
  },host);
  return lastSession;
}
async function sessionKey() {
  const credential=await page.evaluate(()=>localStorage.getItem(Object.keys(localStorage).find(name=>name.startsWith('shifter-web-proxy:v1:'))));
  const record=JSON.parse(await redis('GET','identity:'+sha256(credential)));
  return `daily:${record.site}:${record.visitor}:rolling`;
}
async function submit(url) {
  await until(async()=>!(await view()).goDisabled,'#go enabled',30000);
  await page.evaluate(url=>{document.getElementById('address').value=url;document.getElementById('navigate').requestSubmit();},url);
  await browsing();
}
const search=submit,go=submit;
// DOM click: at narrow widths the controls sit in the session menu.
async function press(id) {
  await until(()=>page.evaluate(id=>!document.getElementById(id).disabled,id),`#${id} enabled`,30000);
  await page.evaluate(id=>document.getElementById(id).click(),id);
}
// Select by visible text, never by href: the engine rewrites link attributes. The click runs
// after evaluate returns, so a navigation cannot fail the call and cause a second click.
const follow=label=>until(()=>destination()?.evaluate(label=>{
  const target=[...document.querySelectorAll('a,button')].find(node=>node.textContent.trim()===label);
  if(target) setTimeout(()=>target.click());
  return Boolean(target);
},label),`destination control "${label}"`);
async function startSlow() {
  await destination().evaluate(()=>{
    window.slowBytes=0;
    fetch('/slow').then(async response=>{
      const reader=response.body.getReader();
      for(let chunk=await reader.read();!chunk.done;chunk=await reader.read()) window.slowBytes+=chunk.value.length;
    }).catch(error=>{window.slowError=String(error);});
  });
  await until(()=>destination().evaluate(()=>window.slowBytes>4096),'slow download in progress',30000);
}
const identity=async pattern=>{const value=await waitText('#identity',pattern);return value.split(' / ')[1];};
async function freshSid(pattern) {
  const sid=await until(async()=>{const value=await identity(pattern);return !sids.has(value) && value;},`a new SID matching ${pattern}`);
  sids.add(sid);return sid;
}
const sameAllowance=(after,before,label)=>{
  assert.equal(after.expiresAt,before.expiresAt,`${label}: expiry`);
  assert.ok(after.remainingBytes<=before.remainingBytes,`${label}: allowance must not grow`);
};
const ended=(timeout,label)=>until(async()=>{const v=await view();return !v.expiredHidden && v.runtimeHidden && v.status==='Daily allowance ended';},label,timeout);
const disconnected=()=>until(async()=>(await session()).connected===false,'gateway transport released',10000);
function pass(result) {results.push(result);console.log('PASS',result);}

try {
  page=await browser.newPage();
  await page.setViewport({width:1280,height:900});
  page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
  await page.exposeFunction('acceptanceToken',()=>seedCaptcha('127.0.0.1'));
  // Test-only widget: every challenge receives a fresh one-use token, as the real widget would supply.
  await page.evaluateOnNewDocument(origin=>{
    if(location.origin!==origin) return;
    window.grecaptcha={render:(_node,options)=>{acceptanceToken().then(options.callback);return 0;},reset(){}};
  },host);

  await page.goto(host+'/');
  await search(fixture);
  assert.ok((await view()).browsing);
  const sid1=await identity(/^us \/ [0-9a-f]{8}$/);sids.add(sid1);
  await session();
  pass('The control page loads the synthetic fixture cross-site through the hosted SDK');

  await waitText('#result','JavaScript fetch OK: us');
  await waitText('#login','Not signed in');
  await follow('Sign in');
  await waitText('#login','Signed in as alice');
  pass('Destination JavaScript runs and the synthetic login sets its cookie');

  await follow('Next page');
  await waitText('h1','Navigation works');
  await press('back');
  await waitText('#login','Signed in as alice');
  await press('forward');
  await waitText('h1','Navigation works');
  await follow('Back to fixture');
  await waitText('#identity',`us / ${sid1}`);
  pass('Next, Back and Forward navigate the destination history');

  await sleep(idleSeconds*1000);
  await follow('Next page');
  await waitText('h1','Navigation works');
  await follow('Back to fixture');
  await waitText('#identity',`us / ${sid1}`);
  assert.equal((await view()).status,'Browsing through Shifter');
  pass(`The session stays usable with the same SID after ${idleSeconds} s idle`);

  await follow('Redirect');
  await waitText('h1','Navigation works');
  await until(async()=>new URL((await view()).address).href===fixture+'next','address bar shows the redirect target');
  await go(fixture);
  await waitText('#identity',`us / ${sid1}`);
  await follow('Second origin');
  await until(async()=>new URL((await view()).address).hostname==='second.test','address bar shows the second origin');
  await waitText('#login','Not signed in');
  await waitText('#identity',`us / ${sid1}`);
  pass('A redirect is followed and a second origin does not receive the first origin\'s cookie');

  await go(fixture);
  await waitText('#login','Signed in as alice');
  await press('reload');
  await until(async()=>(await view()).status==='Connecting through Shifter…','Reload reconnects');
  await browsing();
  await waitText('#login','Signed in as alice');
  await waitText('#identity',`us / ${sid1}`);
  pass('Returning to the first origin and Reload retain its cookie and SID');

  let before=await session();
  await page.evaluate(()=>document.getElementById('country-trigger').click());
  await page.type('#country-search','Germany');
  await page.keyboard.press('Enter');
  await freshSid(/^de \/ [0-9a-f]{8}$/);
  await waitText('#login','Not signed in');
  let after=await session();
  assert.equal(after.country,'de');assert.equal(after.byteLimit,before.byteLimit);
  sameAllowance(after,before,'country change');
  pass('A country change starts a fresh website session with a new SID and keeps the allowance');

  await follow('Sign in');
  await waitText('#login','Signed in as alice');
  before=await session();
  await press('stop');
  await until(async()=>{const v=await view();return !v.browsing && v.runtimeHidden;},'landing after Stop',30000);
  assert.equal((await session()).status,'stopped');
  await search(fixture);
  await freshSid(/^us \/ [0-9a-f]{8}$/);
  await waitText('#login','Not signed in');
  after=await session();
  assert.equal(after.byteLimit,before.byteLimit);
  sameAllowance(after,before,'resume after Stop');
  pass('Stop ends browsing; the next search resumes with a new SID, cleared cookies and the same allowance');

  await follow('Sign in');
  await waitText('#login','Signed in as alice');
  before=await session();
  await page.reload();
  await until(async()=>{const v=await view();return !v.browsing && v.runtimeHidden && !v.goDisabled;},'landing after the tab reload',30000);
  await search(fixture);
  await waitText('#identity',/^us \/ [0-9a-f]{8}$/);
  await waitText('#login','Not signed in');
  sameAllowance(await session(),before,'interrupted tab');
  pass('An interrupted tab\'s website state is cleared before the next load and the allowance is kept');

  let key=await sessionKey();
  await startSlow();
  await redis('HSET',key,'used',await redis('HGET',key,'limit'));
  await ended(15000,'allowance-ended panel after exhaustion');
  const exhausted=await session();
  assert.equal(exhausted.status,'exhausted');assert.equal(exhausted.remainingBytes,0);
  await disconnected();
  await redis('HSET',key,'used','0');
  await press('expired-home');
  pass('Exhausting the allowance during traffic shows the ended panel and closes the transport');

  await search(fixture);
  await waitText('#identity',/^us \/ [0-9a-f]{8}$/);
  key=await sessionKey();
  await startSlow();
  const deadline=Date.now()+20000;
  await redis('HSET',key,'period','0','exp',String(Date.now()+3000));
  await ended(20000,'allowance-ended panel after hard expiry');
  await until(async()=>(await session()).status==='expired','session status expired',Math.max(0,deadline-Date.now()));
  await disconnected();
  pass('Hard expiry during traffic of a session without auto-renew shows the ended panel and closes the transport');

  await writeFile('artifacts/browser-acceptance.json',JSON.stringify({at:new Date().toISOString(),release,idleSeconds,results},null,2));
} catch(error) {
  for(const message of new Set(consoleErrors)) console.error(message);
  if(page) {
    console.error(JSON.stringify(await view().catch(()=>({view:'unavailable'}))));
    console.error('session',JSON.stringify(lastSession),'destination',destination()?.url() ?? 'none');
  }
  throw error;
} finally {await browser.close();}
