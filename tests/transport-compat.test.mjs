import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
const source = await readFile(new URL('../web/runtime/transport-compat.js', import.meta.url), 'utf8');
// Exercise the installed BareClient: it constructs Request.body itself, so
// converting only the original caller's body would not fix this failure.
globalThis.self = globalThis;
const {BareClient} = await import('@mercuryworkshop/bare-mux');
function client(supported = false, fail = false) {
  const sent = [];
  const c = Object.create(BareClient.prototype);
  c.worker = {async sendMessage(message, transfers) {
    sent.push({message, transfers});
    if (!supported) assert.ok(!transfers.some(item => item instanceof ReadableStream));
    if (fail) throw new Error('upstream failed');
    return {fetch:{body:'ok',status:200,statusText:'OK',headers:{}}};
  }};
  const context = {ReadableStream, Uint8Array, MessageChannel:class {
    constructor() {
      this.port1 = {postMessage() {if (!supported) throw new DOMException('Cannot clone stream','DataCloneError');},close(){}};
      this.port2 = {close(){}};
    }
  }};
  runInNewContext(source, context);
  context.installRequestBodyCompatibility(c);
  return {c, sent};
}
test('Safari fallback preserves POST bytes, multipart boundaries and headers before one send', async () => {
  for (const body of ['search=hello%20world', (() => {const f = new FormData(); f.set('answer','hello'); return f;})()]) {
    const {c, sent} = client();
    const request = new Request('https://example.test/verify', {method:'POST',body});
    const expected = new Uint8Array(await request.clone().arrayBuffer());
    await c.fetch(request);
    assert.equal(sent.length,1);
    const {message,transfers} = sent[0];
    assert.equal(message.fetch.method,'POST');
    assert.equal(message.fetch.headers['content-type'],request.headers.get('content-type'));
    assert.deepEqual(new Uint8Array(message.fetch.body),expected);
    assert.equal(transfers[0],message.fetch.body);
  }
});
test('GET stays bodyless and capable browsers retain streaming', async () => {
  const safari = client(); await safari.c.fetch('https://example.test/');
  assert.equal(safari.sent[0].message.fetch.body,undefined);
  const chrome = client(true); await chrome.c.fetch('https://example.test/',{method:'POST',body:'hello'});
  assert.ok(chrome.sent[0].message.fetch.body instanceof ReadableStream);
  await chrome.sent[0].message.fetch.body.cancel();
});
test('oversized buffered uploads are cancelled before sending and failed POST is never retried', async () => {
  const {c,sent} = client(); let cancelled = false;
  const body = new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(5*1024*1024));},cancel(){cancelled=true;}});
  await assert.rejects(c.worker.sendMessage({type:'fetch',fetch:{method:'POST',body}},[body]),/compatibility limit/);
  assert.equal(sent.length,0); assert.equal(cancelled,true);
  const failed = client(false,true);
  await assert.rejects(failed.c.fetch('https://example.test/',{method:'POST',body:'answer=yes'}),/upstream failed/);
  assert.equal(failed.sent.length,1);
});
