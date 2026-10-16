// Render the actual worker response and CSP on localhost; no proxy account needed.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {runInNewContext} from 'node:vm';
import puppeteer from 'puppeteer-core';

const source=await readFile(new URL('../web/runtime/sw.js',import.meta.url),'utf8');
const response=runInNewContext(source+'\ndownloadDenied({mode:"navigate"})',{
  self:{addEventListener(){}},Response,importScripts(){},installRequestBodyCompatibility(){},
  $scramjetLoadWorker:()=>({ScramjetServiceWorker:class{}}),
});
const html=await response.text(),headers=Object.fromEntries(response.headers);
assert.equal(response.status,403);
assert.match(headers['content-security-policy'],/default-src 'none'/);
assert.match(headers['content-security-policy'],/sandbox allow-same-origin/);
assert.doesNotMatch(headers['content-security-policy'],/allow-scripts|allow-downloads/);
const server=createServer((_request,res)=>{res.writeHead(response.status,headers);res.end(html);});
server.listen(0,'127.0.0.1');await once(server,'listening');
let browser;
try {
  await mkdir('artifacts',{recursive:true});
  browser=await puppeteer.launch({channel:'chrome',headless:true});
  const page=await browser.newPage(),requests=[];
  page.on('request',request=>requests.push(request.url()));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const sizes=[['desktop',1280,800],['mobile',390,844],['narrow',320,568],['short',760,340]];
  for(const [name,width,height] of sizes) {
    await page.setViewport({width,height,deviceScaleFactor:1});
    assert.equal((await page.goto(origin+'/notice',{waitUntil:'networkidle0'})).status(),403);
    const layout=await page.evaluate(()=>({
      overflow:document.documentElement.scrollWidth>innerWidth,
      background:getComputedStyle(document.querySelector('main')).backgroundImage,
      title:document.querySelector('h1').textContent,
      reason:document.querySelector('.reason').textContent,
    }));
    assert.equal(layout.overflow,false,name+' has no horizontal overflow');
    assert.match(layout.background,/linear-gradient/,'CSP allows the notice styling');
    assert.equal(layout.title,'Downloads are disabled');
    assert.match(layout.reason,/malware/);assert.match(layout.reason,/Terms of Service/);
    if(['desktop','mobile'].includes(name)) await page.screenshot({path:`artifacts/download-notice-${name}.png`,fullPage:true});
  }
  await page.evaluate(()=>{const script=document.createElement('script');script.textContent='window.noticeScriptExecuted=true';document.body.append(script);});
  assert.equal(await page.evaluate(()=>window.noticeScriptExecuted),undefined,'notice scripts remain blocked');
  assert.ok(requests.every(url=>url.startsWith(origin+'/')),'no external resource requests');
  await writeFile('artifacts/download-notice.html',html);
  await writeFile('artifacts/notice-browser-results.json',JSON.stringify({chrome:await browser.version(),status:403,sizes:sizes.map(([name])=>name),horizontalOverflow:false,scriptsBlocked:true,externalRequests:0},null,2)+'\n');
  console.log('PASS actual 403 notice: desktop/mobile/narrow/short layouts, inline styling, blocked scripts, no external requests');
} finally {
  if(browser)await browser.close();
  await new Promise(resolve=>server.close(resolve));
}
