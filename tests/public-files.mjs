// Use raw HTTP paths: fetch/URL would normalize away some traversal probes.
import assert from 'node:assert/strict';
import http from 'node:http';
import {pathToFileURL} from 'node:url';

export const privatePaths = [
  '/.env', '/.env.captcha', '/.env.production', '/.git/config', '/.git/HEAD',
  '/.secrets/recaptcha-secret', '/secrets/recaptcha-secret', '/run/secrets/recaptcha_secret',
  '/proc/self/environ', '/etc/passwd', '/compose.yaml', '/Dockerfile', '/Cargo.toml',
  '/README.md', '/src/config.rs', '/artifacts/configuration.json', '/deploy/haproxy.cfg',
  '/redis.conf', '/dump.rdb', '/credentials.json', '/index.html.bak', '/app.js~',
  '/%2eenv.captcha', '/%252eenv.captcha', '/%2e%2e/.env.captcha',
  '/../.env.captcha', '/app.js/../../.env.captcha', '//.env.captcha',
  '/..%2f.env.captcha', '/..%5c.env.captcha', '/%2fetc%2fpasswd', '/.env.captcha%00.js',
  '/sdk/.env.captcha', '/sdk/v1/.env.captcha', '/sdk/src/client.js', '/sdk/releases/1.0.0/.env',
  '/sdk/releases/1.0.0/client.js.bak', '/sdk/releases/1.0.0/../../../../.env.captcha',
  '/vendor/.env.captcha', '/vendor/scram/scramjet.all.js.map',
  '/api/../.env.captcha', '/api/%2e%2e/.env.captcha',
];

export async function assertPrivateFilesDenied(request) {
  for (const path of privatePaths) {
    for (const method of ['GET', 'HEAD']) {
      const response = await request(path, {method});
      assert.equal(response.status, 404, `Private path must return 404: ${method} ${path}`);
      assert.ok(!response.headers.location, `No redirect for private path: ${path}`);
      assert.match(response.headers['cache-control'], /no-store/, `Do not cache denial: ${path}`);
    }
  }
}

function request(base, path, {method='GET'}={}) {
  const origin = new URL(base);
  return new Promise((resolve,reject) => {
    const req = http.request({hostname:origin.hostname,port:origin.port,path,method,timeout:5000},res=> {
      let body=''; res.on('data',chunk=>body+=chunk); res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));
    });
    req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('Request timeout')));req.end();
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const control = process.env.CONTROL_ORIGIN || 'http://localhost:8080';
  const runtime = process.env.RUNTIME_ORIGIN || 'http://localhost:8081';
  for (const base of [control,runtime]) {
    await assertPrivateFilesDenied((path,options)=>request(base,path,options));
    for (const path of ['/sdk/v1/shifter-web-proxy.js','/sdk/releases/1.0.0/client.js','/sdk/releases/1.0.0/captcha.js']) {
      assert.equal((await request(base,path)).status,200,`Public asset: ${path}`);
    }
  }
  for (const path of ['/','/minimal.html','/app.js','/style.css','/assets/flags/us.svg']) {
    assert.equal((await request(control,path)).status,200,`Control asset: ${path}`);
  }
  for (const path of ['/','/reset.html','/reset.js','/bridge.js','/runtime.js','/sw.js','/transport-compat.js','/vendor/scram/scramjet.all.js','/vendor/scram/scramjet.sync.js','/vendor/scram/scramjet.wasm.wasm','/vendor/baremux/index.js','/vendor/baremux/worker.js','/vendor/epoxy/index.mjs']) {
    assert.equal((await request(runtime,path)).status,200,`Runtime asset: ${path}`);
  }
  console.log(`PASS public-file boundary: ${privatePaths.length*4} raw GET/HEAD denial probes; SDK, control, and runtime assets remain available`);
}
