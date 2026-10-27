import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM, VirtualConsole} from 'jsdom';
import {rankCountries} from '../web/control/country-order.js';
import {CountryPicker} from '../web/control/country-picker.js';

// API order, deliberately unranked; `ips` stands for any extra field the API sends.
const LIST = [
  ['zw', 'Zimbabwe'], ['fr', 'France'], ['ng', 'Nigeria'], ['us', 'United States'], ['pl', 'Poland'],
  ['dz', 'Algeria'], ['de', 'Germany'], ['ro', 'Romania'], ['gb', 'United Kingdom'],
].map(([code, name], ips) => ({code, name, ips}));
const RANKED = ['us', 'gb', 'de', 'fr', 'pl', 'ro', 'dz', 'ng', 'zw'];
const STORAGE = 'Browser storage is unavailable. Your session will not be remembered after this page closes.';
const LOCATION = 'Location changed. You may need to sign in to the website again.';
const GLOBALS = ['window', 'document', 'HTMLElement', 'Event', 'KeyboardEvent', 'matchMedia', 'ShifterWebProxy'];
const originals = new Map(GLOBALS.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const settle = () => new Promise(resolve => setImmediate(resolve));
let instance = 0;

function install(values) {
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, {configurable: true, writable: true, value});
}
function restore() {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
}

// The control page on a fresh document; scripts are not executed and no resources load.
async function dom(t, url = 'http://localhost:8080/') {
  const html = await readFile(new URL('../web/control/index.html', import.meta.url), 'utf8');
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  const {window} = new JSDOM(html, {url, pretendToBeVisual: true, virtualConsole});
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  install({window, document: window.document, HTMLElement: window.HTMLElement, Event: window.Event,
    KeyboardEvent: window.KeyboardEvent, matchMedia: () => ({matches: true, addEventListener() {}})});
  t.after(async () => {
    // The picker checks focus in a zero-delay timeout after focusout; let it run against this page.
    await new Promise(resolve => setTimeout(resolve, 0));
    restore();
    window.close();
    assert.deepEqual(errors, [], 'jsdom reported errors');
  });
  return window;
}

function fakeProxy() {
  const calls = [], impl = {};
  let state = {status: 'initializing', countries: [], active: false, busy: false, loading: false};
  let listener, resolveInit;
  const initialized = new Promise(resolve => { resolveInit = resolve; });
  const facade = {
    getState: () => structuredClone(state),
    subscribe(callback) { listener = callback; callback(structuredClone(state)); return () => { listener = undefined; }; },
    init() { calls.push(['init']); return initialized; },
  };
  for (const method of ['search', 'navigate', 'back', 'forward', 'reload', 'changeCountry', 'stop', 'destroy']) {
    facade[method] = (...args) => { calls.push([method, ...args]); return impl[method] ? impl[method](...args) : Promise.resolve(); };
  }
  const fake = {
    calls, impl, options: undefined,
    create(options) { fake.options = options; return facade; },
    emit(patch) { state = {...state, ...patch}; listener?.(structuredClone(state)); },
    resolveInit: () => resolveInit(),
    called: method => calls.filter(([name]) => name === method),
  };
  return fake;
}

async function loadApp(t, {apiOrigin} = {}) {
  const window = await dom(t);
  const fake = fakeProxy();
  install({ShifterWebProxy: {create: options => fake.create(options)}});
  if (apiOrigin) window.SHIFTER_API_ORIGIN = apiOrigin;
  await import(new URL(`../web/control/app.js?case=${++instance}`, import.meta.url));
  return page(window, {fake});
}

async function start(t, state = {}) {
  const app = await loadApp(t);
  app.fake.resolveInit();
  await settle();
  app.fake.emit({status: 'ready', countries: LIST, ...state});
  return app;
}

async function picker(t) {
  const window = await dom(t);
  const countryPicker = new CountryPicker();
  countryPicker.setDisabled(false);
  countryPicker.setCountries(LIST);
  return page(window, {picker: countryPicker});
}

function page(window, extra) {
  const {document} = window;
  const $ = id => document.getElementById(id);
  return {
    window, document, $, body: document.body, ...extra,
    key(element, key) {
      const event = new window.KeyboardEvent('keydown', {key, bubbles: true, cancelable: true});
      element.dispatchEvent(event);
      return event;
    },
    type(text) { $('country-search').value = text; $('country-search').dispatchEvent(new window.Event('input', {bubbles: true})); },
    pointer(element) { element.dispatchEvent(new window.Event('pointerdown', {bubbles: true})); },
    options: () => [...document.querySelectorAll('#country-options [role=option]')].map(option => option.id.replace('country-option-', '')),
    groups: () => [...document.querySelectorAll('#country-options > [role=group]')].map(group => group.getAttribute('aria-labelledby')),
    highlighted: () => ({
      active: $('country-options').getAttribute('aria-activedescendant'),
      marked: [...document.querySelectorAll('#country-options .highlighted')].map(option => option.id),
    }),
    notice: () => ($('notice').hidden ? null : $('notice').textContent),
    controls: () => ['back', 'forward', 'reload', 'stop'].map($)
      .concat([...document.querySelectorAll('[data-browser-action]')]).map(button => button.disabled),
  };
}

const at = code => ({active: `country-option-${code}`, marked: [`country-option-${code}`]});

test('control page: rankCountries orders tiers by configured position, then alphabetically', () => {
  const input = structuredClone(LIST);
  const ranked = rankCountries(input);
  assert.deepEqual(ranked.map(country => country.code), RANKED);
  assert.deepEqual(ranked.map(country => country.tier), [1, 1, 1, 1, 2, 2, 3, 3, 3]);
  for (const country of ranked) assert.deepEqual(country, {...LIST.find(item => item.code === country.code), tier: country.tier});
  assert.deepEqual(input, LIST, 'input is not mutated');
  assert.deepEqual(rankCountries([{code: 'zw', name: 'Zimbabwe'}]), [{code: 'zw', name: 'Zimbabwe', tier: 3}]);
  assert.deepEqual(rankCountries([]), []);
});

test('control page: picker defaults to the United States and renders ranked tier groups', async t => {
  const {$, document, options, groups} = await picker(t);
  assert.equal($('country').value, 'us');
  assert.equal($('country-name').textContent, 'United States');
  assert.equal($('country-flag').getAttribute('src'), '/assets/flags/us.svg');
  assert.deepEqual(groups(), ['country-tier-1', 'country-tier-2', 'country-tier-3']);
  for (const tier of [1, 2, 3]) assert.equal($(`country-tier-${tier}`).textContent, `Tier ${tier}`);
  assert.deepEqual(options(), RANKED);
  for (const option of document.querySelectorAll('#country-options [role=option]')) {
    const code = option.id.replace('country-option-', '');
    assert.equal(option.querySelector('img').getAttribute('src'), `/assets/flags/${code}.svg`);
    assert.equal(option.getAttribute('aria-selected'), String(code === 'us'));
  }
});

test('control page: picker search filters by name or code and keeps ranking and tiers', async t => {
  const {$, options, groups, type} = await picker(t);
  $('country-trigger').click();
  type('ger');
  assert.deepEqual(options(), ['de', 'dz', 'ng']);
  assert.deepEqual(groups(), ['country-tier-1', 'country-tier-3']);
  assert.equal($('country-empty').hidden, true);
  type(' ZW ');
  assert.deepEqual(options(), ['zw']);
  type('xyz');
  assert.deepEqual(options(), []);
  assert.equal($('country-empty').hidden, false);
  type('');
  assert.deepEqual(options(), RANKED);
  assert.equal($('country-empty').hidden, true);
});

test('control page: picker opens and moves the highlight with the keyboard', async t => {
  const {$, document, key, highlighted} = await picker(t);
  key($('country-trigger'), 'ArrowDown');
  assert.equal($('country-popup').hidden, false);
  assert.equal($('country-trigger').getAttribute('aria-expanded'), 'true');
  assert.equal(document.activeElement, $('country-search'));
  key($('country-search'), 'ArrowDown');
  assert.deepEqual(highlighted(), at('us'));
  assert.equal(document.activeElement, $('country-options'));
  key($('country-options'), 'ArrowDown');
  assert.deepEqual(highlighted(), at('gb'));
  key($('country-options'), 'ArrowUp');
  assert.deepEqual(highlighted(), at('us'));
  key($('country-options'), 'End');
  assert.deepEqual(highlighted(), at('zw'));
  const home = key($('country-search'), 'Home');
  assert.equal(home.defaultPrevented, false, 'Home edits the search text');
  assert.deepEqual(highlighted(), at('zw'));
  key($('country-options'), 'Home');
  assert.deepEqual(highlighted(), at('us'));
});

test('control page: Enter chooses the highlighted or first matching country', async t => {
  const {$, document, key, type} = await picker(t);
  const changes = [];
  $('navigate').addEventListener('change', event => changes.push(event.target.value));
  key($('country-trigger'), 'ArrowDown');
  key($('country-search'), 'ArrowDown');
  key($('country-options'), 'ArrowDown');
  key($('country-options'), 'ArrowDown');
  key($('country-options'), 'Enter');
  assert.equal($('country').value, 'de');
  assert.equal($('country-name').textContent, 'Germany');
  assert.deepEqual(changes, ['de']);
  assert.equal($('country-trigger').getAttribute('aria-expanded'), 'false');
  assert.equal($('country-popup').hidden, true);
  assert.equal(document.activeElement, $('country-trigger'));
  key($('country-trigger'), 'ArrowDown');
  type('pol');
  key($('country-search'), 'Enter');
  assert.equal($('country').value, 'pl');
  assert.deepEqual(changes, ['de', 'pl']);
});

test('control page: Escape closes the picker without choosing and stops propagation', async t => {
  const {$, document, key, highlighted} = await picker(t);
  const seen = [];
  document.addEventListener('keydown', event => seen.push(event.key));
  key($('country-trigger'), 'ArrowDown');
  key($('country-search'), 'ArrowDown');
  key($('country-options'), 'ArrowDown');
  assert.deepEqual(highlighted(), at('gb'));
  const escape = key($('country-options'), 'Escape');
  assert.equal(escape.defaultPrevented, true);
  assert.equal($('country').value, 'us');
  assert.equal($('country-popup').hidden, true);
  assert.equal($('country-trigger').getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, $('country-trigger'));
  assert.deepEqual(seen, ['ArrowDown', 'ArrowDown', 'ArrowDown']);
});

test('control page: picker closes on outside pointer and stays closed while disabled', async t => {
  const {$, picker: countryPicker, pointer} = await picker(t);
  $('country-trigger').click();
  pointer($('country-search'));
  assert.equal($('country-popup').hidden, false);
  pointer($('address'));
  assert.equal($('country-popup').hidden, true);
  assert.equal($('country-trigger').getAttribute('aria-expanded'), 'false');
  $('country-trigger').click();
  assert.equal($('country-popup').hidden, false);
  countryPicker.setDisabled(true);
  assert.equal($('country-popup').hidden, true);
  assert.equal($('country-trigger').disabled, true);
  countryPicker.open();
  $('country-trigger').click();
  assert.equal($('country-popup').hidden, true);
});

test('control page: picker keeps its value for unknown codes and ignores unchanged choices', async t => {
  const {$, picker: countryPicker} = await picker(t);
  const changes = [];
  $('country').addEventListener('change', () => changes.push($('country').value));
  countryPicker.setValue('xx');
  assert.equal($('country').value, 'us');
  assert.equal($('country-name').textContent, 'United States');
  assert.equal($('country-flag').getAttribute('src'), '/assets/flags/us.svg');
  $('country-trigger').click();
  $('country-option-us').click();
  assert.equal($('country-popup').hidden, true);
  assert.deepEqual(changes, []);
});

test('control page: creates the SDK in the runtime host and enables input after init', async t => {
  const {$, fake} = await loadApp(t);
  assert.equal(fake.options.container, $('runtime-host'));
  assert.equal('apiOrigin' in fake.options, false);
  fake.emit({status: 'ready', countries: LIST});
  assert.equal($('go').disabled, true);
  assert.equal($('country-trigger').disabled, true);
  fake.resolveInit();
  await settle();
  assert.equal($('go').disabled, false);
  assert.equal($('country-trigger').disabled, false);
  const configured = await loadApp(t, {apiOrigin: 'http://api.test'});
  assert.equal(configured.fake.options.apiOrigin, 'http://api.test');
});

test('control page: countries render once from the first list', async t => {
  const {$, document, fake, options} = await start(t);
  assert.equal($('country-count').textContent, '9');
  assert.deepEqual(options(), RANKED);
  assert.equal(document.querySelectorAll('#country-rows .country-row').length, 3);
  assert.equal(document.querySelectorAll('#orbit-rings .orbit-ring').length, 3);
  const rendered = ['country-options', 'country-rows', 'orbit-rings'].map(id => $(id).innerHTML);
  fake.emit({countries: [{code: 'ca', name: 'Canada'}]});
  assert.equal($('country-count').textContent, '9');
  assert.deepEqual(['country-options', 'country-rows', 'orbit-rings'].map(id => $(id).innerHTML), rendered);
});

test('control page: status labels', async t => {
  const {$, fake} = await start(t);
  const labels = {idle: 'Ready to browse', initializing: 'Preparing…', ready: 'Ready to browse',
    verifying: 'Verify to start browsing', connecting: 'Connecting through Shifter…', browsing: 'Browsing through Shifter',
    interrupted: 'Connection interrupted', stopped: 'Browsing stopped', expired: 'Daily allowance ended',
    exhausted: 'Daily allowance ended', unknown: 'Ready to browse'};
  for (const [status, label] of Object.entries(labels)) {
    fake.emit({status});
    assert.equal($('status').textContent, label, status);
    assert.equal($('session-menu').querySelector('summary').title, `${label} · Session details and browser controls`);
  }
});

test('control page: browser controls follow busy and active', async t => {
  const {$, fake, controls} = await start(t);
  fake.emit({active: true});
  assert.deepEqual(controls(), Array(8).fill(false));
  fake.emit({busy: true});
  assert.deepEqual(controls(), Array(8).fill(true));
  assert.equal($('go').disabled, true);
  fake.emit({busy: false, active: false});
  assert.deepEqual(controls(), Array(8).fill(true));
  assert.equal($('go').disabled, false);
});

test('control page: allowance shows remaining time and traffic', async t => {
  const {$, fake} = await start(t);
  fake.emit({remainingSeconds: 3661, session: {remainingBytes: 2_500_000_000}});
  for (const id of ['timer', 'menu-timer']) assert.equal($(id).textContent, '01:01:01');
  for (const id of ['traffic', 'menu-traffic']) assert.equal($(id).textContent, '2.50 GB');
  fake.emit({session: undefined});
  for (const id of ['traffic', 'menu-traffic']) assert.equal($(id).textContent, '0.00 GB');
});

test('control page: ended sessions show the allowance message in browser mode', async t => {
  const {$, body, fake} = await start(t);
  for (const status of ['exhausted', 'expired']) {
    fake.emit({status, active: false});
    assert.equal($('expired').hidden, false, status);
    assert.equal($('empty').hidden, true);
    assert.equal($('runtime-host').hidden, true);
    assert.equal(body.classList.contains('is-browsing'), true);
    $('expired-home').click();
    assert.equal(body.classList.contains('is-browsing'), false);
  }
});

test('control page: loading indicator, SDK errors and the storage warning', async t => {
  const {$, fake, notice} = await start(t);
  fake.emit({loading: true});
  assert.equal($('page-loading').hidden, false);
  assert.equal($('viewport').getAttribute('aria-busy'), 'true');
  fake.emit({loading: false});
  assert.equal($('page-loading').hidden, true);
  assert.equal($('viewport').getAttribute('aria-busy'), 'false');
  fake.emit({error: {code: 'NETWORK', message: 'Connection lost'}});
  assert.equal(notice(), 'Connection lost');
  fake.emit({error: null, persistent: false});
  assert.equal(notice(), STORAGE);
  fake.emit({loading: true});
  assert.equal(notice(), STORAGE);
  fake.emit({loading: false});
  assert.equal(notice(), STORAGE);
});

test('control page: submit searches from the landing view and navigates while browsing', async t => {
  const {$, body, fake, notice} = await start(t);
  const submit = async address => { $('address').value = address; $('navigate').requestSubmit(); await settle(); };
  fake.impl.search = async () => fake.emit({active: true, status: 'browsing'});
  await submit('example.com');
  assert.deepEqual(fake.called('search'), [['search', {url: 'example.com', country: 'us'}]]);
  assert.equal(body.classList.contains('is-browsing'), true);
  await submit('second.example');
  assert.deepEqual(fake.called('navigate'), [['navigate', 'second.example']]);
  fake.emit({busy: true});
  await submit('third.example');
  assert.equal(fake.calls.length, 3, 'a busy page starts nothing');
  fake.emit({busy: false, active: false});
  $('home').click();
  fake.impl.search = () => Promise.reject({code: 'CANCELLED', message: 'Verification closed'});
  await submit('example.com');
  assert.equal(notice(), null);
  fake.impl.search = () => Promise.reject({code: 'CAPTCHA_REJECTED', message: 'Please retry verification'});
  await submit('example.com');
  assert.equal(fake.called('search').length, 3);
  assert.equal(notice(), 'Please retry verification');
});

test('control page: country change notices stay until the next visitor action', async t => {
  const {$, window, fake, notice} = await start(t, {active: true, country: 'us', status: 'browsing'});
  const choose = async code => { $('country-trigger').click(); $(`country-option-${code}`).click(); await settle(); };
  fake.impl.changeCountry = async country => fake.emit({country});
  await choose('de');
  assert.deepEqual(fake.called('changeCountry'), [['changeCountry', 'de']]);
  assert.equal(notice(), LOCATION);
  fake.emit({remainingSeconds: 3599});
  assert.equal(notice(), LOCATION, 'a clock tick keeps the notice');
  $('reload').click();
  await settle();
  fake.emit({remainingSeconds: 3598});
  assert.equal(notice(), null, 'the next action clears it');

  fake.emit({country: 'us'});
  fake.impl.changeCountry = () => Promise.reject({code: 'SESSION_ENDED', message: 'Session ended'});
  await choose('de');
  assert.equal($('country').value, 'us');
  assert.equal(notice(), 'Session ended');
  fake.emit({remainingSeconds: 3597});
  assert.equal(notice(), 'Session ended');
  fake.emit({error: {code: 'NETWORK', message: 'Connection lost'}});
  assert.equal(notice(), 'Connection lost', 'SDK errors take precedence');

  fake.emit({error: null, busy: true});
  $('country').value = 'gb';
  $('country').dispatchEvent(new window.Event('change', {bubbles: true}));
  fake.emit({busy: false, active: false});
  await choose('fr');
  assert.equal(fake.called('changeCountry').length, 2, 'busy or inactive pages change nothing');
});

test('control page: stop, menu actions, Escape and pagehide', async t => {
  const {$, document, window, body, fake, key} = await start(t, {active: true, country: 'de', status: 'browsing'});
  fake.impl.stop = async () => fake.emit({active: false, status: 'stopped'});
  $('resume').click();
  assert.equal(body.classList.contains('is-browsing'), true);
  assert.equal($('country').value, 'de');
  $('stop').click();
  await settle();
  assert.deepEqual(fake.called('stop'), [['stop']]);
  assert.equal($('country').value, 'us');
  assert.equal(body.classList.contains('is-browsing'), false);

  fake.emit({active: true, status: 'browsing'});
  $('session-menu').open = true;
  document.querySelector('[data-browser-action="back"]').click();
  await settle();
  assert.equal($('session-menu').open, false);
  assert.deepEqual(fake.called('back'), [['back']]);

  $('menu-toggle').click();
  assert.equal($('menu-toggle').getAttribute('aria-expanded'), 'true');
  $('session-menu').open = true;
  key(body, 'Escape');
  assert.equal($('session-menu').open, false);
  assert.equal($('menu-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal($('site-nav').classList.contains('open'), false);

  window.dispatchEvent(new window.Event('pagehide'));
  window.dispatchEvent(new window.Event('pagehide'));
  assert.deepEqual(fake.called('destroy'), [['destroy']]);
});
