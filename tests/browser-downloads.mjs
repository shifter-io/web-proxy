// Run through browser-recovery.mjs --downloads against the disposable local stack.
// Chrome downloads are ALLOWED in the harness: only product policy may block them.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';

async function positiveDownloads(control, formats, cdp, folder, finished) {
  // Positive controls prove that Chrome and automation can actually save every fixture.
  for(const extension of Object.keys(formats)) {
    const completion=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{cdp.off('Browser.downloadProgress',done);reject(Error('Control download timed out: '+extension));},10000);
      const done=event=>{if(event.state==='completed'){clearTimeout(timer);cdp.off('Browser.downloadProgress',done);resolve();}};
      cdp.on('Browser.downloadProgress',done);
    });
    await control.$eval('#download',(a,extension)=>{a.href='/downloads/file.'+extension;},extension);
    await control.click('#download');await completion;
  }
  assert.equal(finished.length,Object.keys(formats).length);
  for(const file of await readdir(folder)) assert.match(await readFile(join(folder,file),'utf8'),/Harmless proxy download regression fixture/);
}

async function checkFetches(destination) {
  const fetches=await destination().evaluate(async()=>{
    const paths=['/downloads/file.txt','/downloads/file.zip?disposition=none','/downloads/get?format=exe&disposition=none'];
    const blocked=await Promise.all(paths.map(async url=>{const r=await fetch(url);return [r.status,(await r.text()).length];}));
    const range=await fetch('/downloads/file.txt',{headers:{Range:'bytes=0-9'}});
    const binary=await fetch('/downloads/binary?disposition=none');
    const json=await fetch('/api');
    return {blocked,range:range.status,binary:[binary.status,(await binary.text()).length],json:(await json.json()).country};
  });
  assert.deepEqual(fetches.blocked,[[403,0],[403,0],[403,0]]);
  assert.equal(fetches.range,403);assert.equal(fetches.binary[0],200);assert.ok(fetches.binary[1]>0);assert.equal(fetches.json,'us');
}

async function checkScriptLoaders(destination) {
  const loads=await destination().evaluate(async()=>{
    const results=[];
    for(const disposition of ['none','inline','attachment']) {
      const url='/downloads/loader.js?disposition='+disposition;
      const response=await fetch(url);
      results.push([response.status,await response.text()]);
      results.push(await new Promise((resolve,reject)=>{
        const xhr=new XMLHttpRequest();xhr.open('GET',url);xhr.timeout=10000;
        xhr.onload=()=>resolve([xhr.status,xhr.responseText]);
        xhr.onerror=xhr.ontimeout=()=>reject(Error('Script XHR failed'));xhr.send();
      }));
    }
    return results;
  });
  for(const [status,body] of loads.slice(0,4)) {assert.equal(status,200);assert.match(body,/scriptLoaderFixture/);}
  assert.deepEqual(loads.slice(4),[[403,''],[403,'']]);
}

async function checkDirectPage(browser, destination, navigate, started, baseline) {
  let direct=await browser.newPage();
  try {
    const response=await direct.goto(destination().url());
    // Chrome can partition the embedded runtime's worker away from top-level tabs.
    // Without that worker, the server must refuse the raw /service/ path entirely.
    if(!response.fromServiceWorker()) {
      assert.ok(!process.argv.includes('--same-site-downloads'),'same-site check requires an active worker/transport');
      assert.equal(response.status(),404);assert.doesNotMatch(await response.text(),/Download checks/);
    } else {
      assert.equal(response.status(),200);await direct.waitForSelector('#ready');
      assert.equal(await direct.evaluate(()=>window.fixtureScript),true);
      assert.match(response.headers()['content-security-policy'],/sandbox/);
      for(const id of ['attribute','blob','data']) {await direct.click('#'+id);await delay(400);}
      for(const type of ['image/x-unrecognized','audio/x-unrecognized','video/x-unrecognized','image/tiff']) {
        await navigate('/downloads/get?disposition=none&type='+encodeURIComponent(type));
        // A fresh tab has no prior document whose sandbox could mask a bypass.
        await direct.close();direct=await browser.newPage();
        const denied=await direct.goto(destination().url());
        assert.equal(denied.fromServiceWorker(),true,type);
        assert.equal(denied.status(),403,type);
        assert.match(await direct.$eval('body',node=>node.textContent),/Downloads are disabled/);
        await delay(200);assert.equal(started.length,baseline,type);
      }
      await navigate('/downloads');
    }
    assert.equal(started.length,baseline,'direct proxied URLs cannot download');
  } finally {await direct.close();}
}

export async function checkDownloads(browser, page, destination, runtime) {
  const formats=JSON.parse(await readFile(new URL('./fixtures/downloads.json',import.meta.url)));
  const folder=await mkdtemp(join(tmpdir(),'shifter-download-check-'));
  const args=[new URL('./fixtures/downloads.py',import.meta.url).pathname,'0'];
  const server=process.platform==='darwin'
    ?spawn('/bin/zsh',['-c','exec \"$@\"','sh','python3',...args],{stdio:['ignore','pipe','inherit']})
    :spawn('python3',args,{stdio:['ignore','pipe','inherit']});
  const cdp=await browser.target().createCDPSession();
  const started=[],finished=[];
  cdp.on('Browser.downloadWillBegin',event=>started.push(event));
  cdp.on('Browser.downloadProgress',event=>{if(event.state==='completed')finished.push(event);});
  let control;
  try {
    const [port]=await once(server.stdout,'data');
    const origin='http://127.0.0.1:'+String(port).trim();
    await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:folder,eventsEnabled:true});
    control=await browser.newPage();await control.goto(origin+'/downloads');
    await positiveDownloads(control, formats, cdp, folder, finished);
    await control.close();control=null;
    const baseline=started.length;
    const navigate=async path=>{
      const navigation=destination().waitForNavigation({waitUntil:'domcontentloaded',timeout:20000});
      await page.evaluate(url=>testProxy.navigate(url),'http://fixture.test'+path);
      await navigation;
    };
    const denied=async path=>{
      await navigate(path);
      assert.match(await destination().evaluate(()=>document.body.textContent),/Downloads are disabled/,path);
      assert.equal(started.length,baseline,path);
      assert.equal(await page.evaluate(()=>testProxy.getState().status),'browsing');
    };
    for(const extension of Object.keys(formats)) await denied('/downloads/file.'+extension);
    const dangerous=['exe','msi','bat','cmd','ps1','js','vbs','jar','apk','dmg','pkg','deb','rpm','zip','rar','7z','tar','gz','iso'];
    for(const extension of dangerous) await denied('/downloads/file.'+extension+'?disposition=none&type=text/plain');
    await denied('/downloads/get?format=zip');
    await denied('/downloads/redirect');
    await denied('/downloads/binary?disposition=none');
    await navigate('/downloads');
    assert.equal(await destination().evaluate(()=>window.fixtureScript),true);
    await checkFetches(destination);
    await checkScriptLoaders(destination);
    for(const id of ['attribute','blob','data']) {
      await destination().click('#'+id);await delay(400);
      assert.equal(started.length,baseline,id+' must not create a Chrome download');
    }
    const post=destination().waitForNavigation({waitUntil:'domcontentloaded'});
    await destination().click('#post');await post;
    assert.match(await destination().evaluate(()=>document.body.textContent),/Downloads are disabled/);
    await navigate('/downloads');
    // The response CSP must survive removal of the DOM sandbox attribute.
    await runtime().$eval('iframe',frame=>frame.removeAttribute('sandbox'));
    await page.$eval('#view iframe',frame=>frame.removeAttribute('sandbox'));
    await navigate('/downloads');
    for(const id of ['attribute','blob','data']) {await destination().click('#'+id);await delay(400);}
    assert.equal(started.length,baseline,'response CSP still blocks after removing iframe sandbox attributes');
    await checkDirectPage(browser, destination, navigate, started, baseline);
    await destination().evaluate(()=>{const frame=document.createElement('iframe');frame.id='nested';frame.srcdoc='<a id="save" download="nested.txt" href="data:text/plain,nested">Save</a>';document.body.append(frame);});
    const nested=await (await destination().$('#nested')).contentFrame();
    await nested.waitForSelector('#save');await nested.click('#save');await delay(400);
    assert.equal(started.length,baseline,'nested srcdoc inherits the download restriction');
    await page.evaluate(()=>testProxy.reload());
    await page.waitForFunction(()=>testProxy.getState().status==='browsing'&&!testProxy.getState().loading,{timeout:30000});
    const results=[`${Object.keys(formats).length} harmless file formats downloaded in unsandboxed localhost controls and were blocked through the proxy`,
      `${dangerous.length} executable/archive/script filenames blocked even with text/plain and no attachment header`,
      'Extensionless, redirected, POST, Range, Blob, data URL and download-attribute downloads blocked; ordinary HTML, script, JSON and binary fetch still work',
      'Response CSP blocks downloads after iframe sandbox removal and in nested srcdoc frames; direct proxied URLs are protected or refused'];
    const sameSite=process.argv.includes('--same-site-downloads');
    if(sameSite)results.push('Active worker and transport verified by direct HTML/script response; four unsupported media types denied on fresh top-level navigation');
    results.push('JavaScript Fetch and XHR loaders succeed for inline/no disposition and reject attachment responses');
    await writeFile(`artifacts/browser-downloads${sameSite?'-same-site':''}.json`,JSON.stringify({chrome:await browser.version(),formats:Object.keys(formats),positiveDownloads:finished.length,proxyDownloads:started.length-baseline,results},null,2));
    return results;
  } finally {
    if(control)await control.close();
    server.kill();await once(server,'exit');
    await cdp.detach();await rm(folder,{recursive:true,force:true});
  }
}
