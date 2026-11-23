// How the SDK loads the self-hosted Cap widget, and how it recovers when that fails.
// Tests run in order: loadCap keeps one shared load per page, and only a failed load clears it.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {challenge} from '../web/sdk/src/captcha.js';

const endpoint = 'https://cap.example.net/example-key/';
const assets = 'https://cap.example.net/assets/';
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function page(t) {
  const dom = new JSDOM('<!doctype html><body></body>', {url: 'https://example.com'});
  const originals = {};
  for (const key of ['window', 'document']) {
    originals[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {configurable: true, writable: true, value: dom.window[key]});
  }
  dom.window.HTMLDialogElement.prototype.show = function() { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function() { this.open = false; };
  t.after(() => {
    dom.window.close();
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  const window = dom.window;
  return {
    window,
    scripts: () => [...window.document.head.querySelectorAll('script')],
    retry: () => window.document.querySelector('[data-retry]'),
    status: () => window.document.querySelector('[role=status]').textContent,
    fire: (target, type) => target.dispatchEvent(new window.Event(type)),
  };
}

test('Cap without its endpoint or assets is not configured and opens nothing', async t => {
  const p = page(t);
  for (const options of [{capAssets: assets}, {capEndpoint: endpoint}, {}]) {
    await assert.rejects(challenge('example-key', {provider: 'cap', ...options}),
      {code: 'CAPTCHA_UNAVAILABLE', message: 'Verification is not configured.'});
  }
  assert.equal(document.querySelector('dialog'), null);
  assert.deepEqual(p.scripts(), []);
  assert.equal(p.window.CAP_CUSTOM_WASM_URL, undefined);
});

test('a Cap widget that never loads times out and offers Try again', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const p = page(t);
  const result = challenge('example-key', {provider: 'cap', capEndpoint: endpoint, capAssets: assets});
  const [script] = p.scripts();
  assert.equal(script.src, `${assets}widget.js`);
  t.mock.timers.tick(14999); await flush();
  assert.equal(p.retry().hidden, true);
  t.mock.timers.tick(1); await flush();
  assert.equal(p.status(), 'Verification did not load. Check your connection and try again.');
  assert.equal(p.retry().hidden, false);
  assert.equal(script.isConnected, false);
  document.querySelector('[data-close]').click();
  await assert.rejects(result, {code: 'CANCELLED'});
});

test('Cap loads its widget with the nonce and wasm URLs, and Try again recovers from load and widget errors', async t => {
  const p = page(t);
  const result = challenge('example-key', {provider: 'cap', capEndpoint: endpoint, capAssets: assets, nonce: 'page-nonce'});
  const [first] = p.scripts();
  assert.equal(p.scripts().length, 1);
  assert.equal(first.src, `${assets}widget.js`);
  assert.equal(first.nonce, 'page-nonce');
  assert.equal(first.async, true);
  assert.equal(p.window.CAP_CUSTOM_WASM_URL, `${assets}cap_wasm_bg.wasm`);
  assert.equal(p.window.CAP_CUSTOM_HASHWX_URL, `${assets}hashwx.wasm`);
  assert.equal(p.status(), 'Loading verification…');
  assert.equal(p.retry().hidden, true);

  // The script fails: it is removed and the shared load is cleared so Try again can load it again.
  p.fire(first, 'error'); await flush();
  assert.equal(first.isConnected, false);
  assert.equal(p.status(), 'Verification could not load. Please try again.');
  assert.equal(p.retry().hidden, false);
  assert.equal(p.retry().disabled, false);
  assert.equal(document.querySelector('cap-widget'), null);

  p.retry().click(); await flush();
  assert.equal(p.retry().hidden, true);
  assert.equal(p.status(), 'Loading verification…');
  const [second] = p.scripts();
  assert.notEqual(second, first);
  assert.equal(second.src, `${assets}widget.js`);
  assert.equal(second.nonce, 'page-nonce');
  p.window.customElements.define('cap-widget', class extends p.window.HTMLElement {});
  p.fire(second, 'load'); await flush();
  const widget = document.querySelector('[data-widget] cap-widget');
  assert.equal(widget.getAttribute('data-cap-api-endpoint'), endpoint);
  assert.equal(p.status(), '');
  assert.equal(p.retry().hidden, true);

  // The widget reports an error: Try again replaces it without loading the script again.
  p.fire(widget, 'error'); await flush();
  assert.equal(p.status(), 'Verification could not complete. Please try again.');
  assert.equal(p.retry().hidden, false);
  p.retry().click(); await flush();
  assert.deepEqual(p.scripts(), [second]);
  const widgets = document.querySelectorAll('cap-widget');
  assert.equal(widgets.length, 1);
  assert.notEqual(widgets[0], widget);
  assert.equal(p.retry().hidden, true);

  widgets[0].dispatchEvent(new p.window.CustomEvent('solve', {detail: {token: 'example-key:challenge:answer'}}));
  assert.equal(await result, 'example-key:challenge:answer');
  assert.equal(document.querySelector('dialog'), null);
});
