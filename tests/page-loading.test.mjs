import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {PageLoading} from '../web/control/page-loading.js';

test('loading completes, cancels old deadlines, and releases the viewport on timeout', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const element = {hidden:true};
  const attributes = {};
  let timeouts = 0;
  const loader = new PageLoading(element, {setAttribute:(key,value) => attributes[key] = value}, () => timeouts++);
  loader.start();
  assert.equal(element.hidden, false);
  assert.equal(attributes['aria-busy'], 'true');
  t.mock.timers.tick(20000);
  loader.start();
  t.mock.timers.tick(5000);
  assert.equal(timeouts, 0, 'previous navigation must not time out the new one');
  loader.finish();
  t.mock.timers.tick(25000);
  assert.equal(timeouts, 0, 'loaded, failed or ended sessions must cancel the deadline');
  assert.equal(element.hidden, true);
  assert.equal(attributes['aria-busy'], 'false');
  loader.start();
  t.mock.timers.tick(25000);
  assert.equal(timeouts, 1);
  assert.equal(element.hidden, true, 'a stalled page cannot remain covered forever');
});

test('runtime reports document loads, ignores anchors/cancelled navigation and retired frames', async () => {
  const source = await readFile(new URL('../web/runtime/runtime.js', import.meta.url), 'utf8');
  const messages = [], frames = [];
  const parent = {postMessage:message => messages.push(message)};
  const window = new EventTarget();
  const emit = (target, type, data = {}, options = {}) => {
    const event = new Event(type, options);
    Object.assign(event, data);
    target.dispatchEvent(event);
  };
  class Frame extends EventTarget {
    constructor() {
      super();
      this.frame = new EventTarget();
      this.frame.style = {};
      this.frame.contentDocument = {getElementById:() => null};
      this.frame.setAttribute = () => {};
      this.frame.remove = () => {};
      this.frame.contentWindow = new EventTarget();
      this.frame.contentWindow.location = {href:'about:blank'};
      this.url = new URL('https://example.com/');
    }
    go(url) { this.url = new URL(url); this.frame.contentWindow.location.href = 'http://runtime.test/service/destination'; }
  }
  class Controller {
    async init() {}
    createFrame() { const frame = new Frame(); frames.push(frame); return frame; }
  }
  await runInNewContext(source, {
    prepareRuntimeData:async()=>{},
    createRuntimeBridge:async () => ({query:'bound', send:(type,data={})=>messages.push({type,...data}), accepts:event=>event.origin==='http://control.test' && event.source===parent && event.data?.source==='shifter-control'}),
    parent, window, URL, queueMicrotask, console,
    location:{protocol:'http:',host:'runtime.test',replace:() => {}},
    navigator:{serviceWorker:{register:async () => {},ready:Promise.resolve(),controller:{scriptURL:'http://runtime.test/sw.js?bound'}}},
    $scramjetLoadController:() => ({ScramjetController:Controller}),
    BareMux:{BareMuxConnection:class {async setTransport() {}}},
    document:{getElementById:() => null,body:{appendChild:frame => assert.notEqual(frame.contentWindow.location.href,'about:blank')}},
  });
  const command = async (command, origin = 'http://control.test') => {
    emit(window, 'message', {origin,source:parent,data:{source:'shifter-control',command,ticket:'test-ticket',url:'https://example.com/'}});
    await new Promise(resolve => setImmediate(resolve));
  };
  await command('start','http://untrusted.test');
  assert.equal(frames.length,0);
  await command('start');
  const first = frames[0];
  emit(first.frame,'load');
  assert.equal(messages.at(-1).type,'loaded');
  messages.length = 0;
  emit(first,'navigate',{url:'https://example.com/#section'});
  await Promise.resolve();
  assert.equal(messages.length,0, 'same-document navigation must not cover the page');
  first.addEventListener('navigate', event => event.preventDefault(), {once:true});
  emit(first,'navigate',{url:'https://example.com/cancelled'}, {cancelable:true});
  await Promise.resolve();
  assert.equal(messages.length,0);
  emit(first,'navigate',{url:'https://example.com/next'});
  await Promise.resolve();
  assert.equal(messages.at(-1).type,'loading');
  emit(first.frame,'load');
  assert.equal(messages.at(-1).type,'loaded');
  emit(first.frame.contentWindow,'pagehide');
  assert.equal(messages.at(-1).type,'loading');
  emit(first.frame.contentWindow,'pageshow',{persisted:true});
  assert.equal(messages.at(-1).type,'loaded');
  await command('reconnect');
  messages.length = 0;
  emit(first.frame,'load');
  emit(first,'navigate',{url:'https://example.com/stale'});
  await Promise.resolve();
  assert.equal(messages.length,0, 'a retired frame must not change the active loading state');
});
