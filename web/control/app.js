import {PageLoading} from './page-loading.js';
import {initShifterReveals} from './shifter-reveal.js';
import {renderCountryOrbits} from './country-orbits.js';
import {renderCountryMarquee} from './country-marquee.js';
import {CountryPicker} from './country-picker.js';
initShifterReveals();
const $ = id => document.getElementById(id);
const runtime = $('runtime');
const pageLoading = new PageLoading($('page-loading'), $('viewport'), () => {
  if (active) {
    status('Page is taking longer than expected');
    notice('This page is taking longer to load. You can wait, select Reload, or try another website.');
  }
});
const countryPicker = new CountryPicker();
// Set before loading this module when integrating the example into the Shifter site.
const apiOrigin = (window.SHIFTER_API_ORIGIN || '').replace(/\/$/, '');
let runtimeOrigin, active = false, ready = false, session = null, offset = 0;
let pendingUrl = null, busy = false, wasConnected = false, configured = false;
let verificationResolve;
let landingScroll = 0, generation = 0, runtimeTimer;

function status(text) { $('status').textContent = text; $('session-menu').querySelector('summary').title = text + ' · Session details and browser controls'; }
function allowance(id, text) { $(id).textContent = text; $('menu-' + id).textContent = text; }
function notice(text = '') { $('notice').textContent = text; $('notice').hidden = !text; }
function lock(value) {
  busy = value;
  $('go').disabled = value || !configured;
  countryPicker.setDisabled(value || !configured);
  for (const id of ['back', 'forward']) $(id).disabled = value || !active || !ready;
  $('reload').disabled = value || !active;
  $('stop').disabled = value || !active;
  document.querySelectorAll('[data-browser-action]').forEach(button => { button.disabled = $(button.dataset.browserAction).disabled; });
}
function browserMode(on) {
  if (on && !document.body.classList.contains('is-browsing')) landingScroll = window.scrollY;
  document.body.classList.toggle('is-browsing', on);
  $('session-menu').open = false;
  $('browser').setAttribute('aria-label', on ? 'Web proxy browser' : 'Start browsing');
  $('resume').hidden = !active || on;
  $('go-label').textContent = on ? 'Go' : 'Search';
  $('address').placeholder = on ? 'Website URL' : 'Enter a website URL';
  if (!on) { window.scrollTo(0, landingScroll); $('address').focus({preventScroll:true}); }
  else $('browser').focus({preventScroll:true});
}
async function api(path, method = 'GET', body) {
  const response = await fetch(apiOrigin + '/api/' + path, { method, credentials: 'include', headers: body ? {'Content-Type':'application/json'} : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function send(command, data = {}) {
  if (active && ['start','go','reconnect'].includes(command)) pageLoading.start();
  if (runtimeOrigin) runtime.contentWindow?.postMessage({ source:'shifter-control', command, ...data }, runtimeOrigin);
}
function update(s) {
  session = s; offset = s.serverTime - Date.now();
  allowance('traffic', `${(s.remainingBytes / 1048576).toFixed(1)} MiB`);
  if (s.connected) wasConnected = true;
  if (active && wasConnected && !s.connected && s.status === 'active') {
    pageLoading.finish();
    status('Connection interrupted'); notice('Select Reload to reconnect.');
  }
  if (['expired','exhausted'].includes(s.status)) expire();
}
function expire() {
  pageLoading.finish();
  clearTimeout(runtimeTimer);
  generation++;
  if (active) send('clear');
  active = false; ready = false; pendingUrl = null; runtime.hidden = true;
  $('empty').hidden = true; $('expired').hidden = false; $('resume').hidden = true;
  status('Daily allowance ended'); allowance('timer', '00:00');
  browserMode(true); lock(false);
}
async function authorize(url) {
  const attempt = generation;
  const {ticket} = await api('session/tickets', 'POST');
  if (active && attempt === generation) send('start', {ticket, url});
}
function openRuntime(url) {
  pageLoading.start();
  clearTimeout(runtimeTimer);
  status('Connecting through Shifter…');
  runtimeTimer = setTimeout(() => {
    if (active && !ready) {
      pageLoading.finish();
      status('Connection taking longer than expected');
      notice('The browsing engine did not start. Select Reload to try again, or End session to return.');
    }
  }, 20000);
  pendingUrl = url; ready = false; wasConnected = false; runtime.hidden = false;
  $('empty').hidden = true; $('expired').hidden = true;
  runtime.src = `${runtimeOrigin}/reset.html`;
  lock(busy);
}
function destination(value) {
  let input = value.trim();
  if (!input) throw new Error('Enter a website address to continue.');
  if (/^[a-z][a-z\d+.-]*:/i.test(input) && !/^https?:\/\//i.test(input)) throw new Error('Enter an HTTP or HTTPS website address.');
  if (!/^https?:\/\//i.test(input)) input = 'https://' + input;
  const url = new URL(input);
  if (!['http:','https:'].includes(url.protocol) || !url.hostname.includes('.') || url.username || url.password || (url.port && !['80','443'].includes(url.port))) throw new Error('Enter an HTTP or HTTPS website on port 80 or 443.');
  return url.href;
}
function verifyVisitor() {
  // Interaction preview only: real CAPTCHA tokens must be verified by the backend.
  $('captcha').checked = false;
  $('verification').returnValue = '';
  return new Promise(resolve => {
    verificationResolve = resolve;
    $('verification').showModal();
  });
}
$('captcha').addEventListener('change', () => {
  if ($('captcha').checked && $('verification').open) $('verification').close('verified');
});
$('verification-close').onclick = () => $('verification').close('cancel');
$('verification').addEventListener('cancel', () => { $('verification').returnValue = 'cancel'; });
$('verification').addEventListener('close', () => {
  const passed = $('verification').returnValue === 'verified' && $('captcha').checked;
  $('captcha').checked = false;
  verificationResolve?.(passed); verificationResolve = null;
});
window.addEventListener('message', async event => {
  if (event.origin !== runtimeOrigin || event.source !== runtime.contentWindow || event.data?.source !== 'shifter-runtime') return;
  const data = event.data;
  try {
    if (data.type === 'ready') {
      clearTimeout(runtimeTimer);
      ready = true;
      if (active && pendingUrl) { const url = pendingUrl; pendingUrl = null; await authorize(url); }
      lock(busy);
    } else if (data.type === 'loading' && active) {
      pageLoading.start(); status('Loading through Shifter…');
    } else if (data.type === 'loaded' && active) {
      pageLoading.finish(); status('Browsing through Shifter');
    } else if (data.type === 'url' && active) {
      $('address').value = data.url; status('Browsing through Shifter');
    } else if (data.type === 'error' && active) { pageLoading.finish(); status('Connection interrupted'); notice(data.message); }
    else if (data.type === 'cleared' && !active && !['expired','exhausted'].includes(session?.status)) status('Browsing stopped');
  } catch (error) { pageLoading.finish(); notice(error.message); status('Unable to connect'); }
});
$('navigate').addEventListener('submit', async event => {
  event.preventDefault(); if (busy || !configured) return;
  notice();
  let url;
  try { url = destination($('address').value); }
  catch (error) { notice(error.message); $('address').focus(); return; }
  lock(true);
  try {
    if (!document.body.classList.contains('is-browsing') && !(await verifyVisitor())) return;
    $('address').value = url;
    if (!active) {
      const selectedCountry = $('country').value;
      update(await api('sessions', 'POST', {country:selectedCountry}));
      if (session.status !== 'active') return;
      // A returning visitor may have a server session in a different country.
      if (session.country !== selectedCountry) {
        update(await api('session/country', 'POST', {country:selectedCountry}));
        if (session.status !== 'active') return;
      }
      countryPicker.setValue(session.country); active = true; generation++;
      openRuntime(url);
    } else if (ready) send('go', {url});
    else pendingUrl = url;
    browserMode(true); status('Connecting through Shifter…');
  } catch (error) { pageLoading.finish(); status('Unable to browse'); notice(error.message); }
  finally { lock(false); }
});
$('country').addEventListener('change', async () => {
  if (!active || busy) return;
  const selected = $('country').value, previous = session.country;
  lock(true); notice();
  try {
    pageLoading.start(); status('Changing location…');
    update(await api('session/country', 'POST', {country:selected}));
    if (!active) return;
    send('clear'); ready = false;
    // Let the old relay release its connection lease before starting its replacement.
    await new Promise(resolve => setTimeout(resolve, 1400));
    notice('Location changed. You may need to sign in to the website again.');
    openRuntime($('address').value);
  } catch (error) { pageLoading.finish(); countryPicker.setValue(previous); notice(error.message); }
  finally { lock(false); }
});
for (const command of ['back','forward']) $(command).onclick = () => active && ready && !busy && send(command);
$('reload').onclick = async () => {
  if (!active || busy) return;
  lock(true); wasConnected = false;
  const attempt = generation;
  try {
    pageLoading.start(); status('Reconnecting…'); notice();
    await api('session/reconnect','POST');
    // A dead replica retains its connection lease for at most six seconds.
    await new Promise(resolve => setTimeout(resolve, 6500));
    if (!active || attempt !== generation) return;
    if (!ready) { openRuntime(destination($('address').value)); return; }
    const {ticket} = await api('session/tickets','POST');
    if (active && attempt === generation) send('reconnect',{ticket,url:destination($('address').value)});
  } catch(error) { pageLoading.finish(); notice(error.message); }
  finally { lock(false); }
};
$('stop').onclick = async () => {
  if (busy) return;
  lock(true);
  try {
    await api('session','DELETE');
    pageLoading.finish();
    clearTimeout(runtimeTimer);
    send('clear'); generation++; active = false; ready = false; session = null; pendingUrl = null;
    runtime.hidden = true; $('empty').hidden = false; $('expired').hidden = true;
    countryPicker.setValue('us');
    status('Browsing stopped'); notice(); browserMode(false);
  } catch (error) { notice('Could not end the session. Please try again.'); }
  finally { lock(false); }
};
document.querySelectorAll('[data-browser-action]').forEach(button => {
  button.onclick = () => { $('session-menu').open = false; $(button.dataset.browserAction).click(); };
});
$('home').onclick = () => browserMode(false);
$('expired-home').onclick = () => browserMode(false);
$('resume').onclick = () => browserMode(true);
$('menu-toggle').onclick = () => {
  const open = $('menu-toggle').getAttribute('aria-expanded') !== 'true';
  $('menu-toggle').setAttribute('aria-expanded', String(open));
  $('site-nav').classList.toggle('open', open);
};
document.addEventListener('click', event => {
  if (!$('session-menu').contains(event.target)) $('session-menu').open = false;
  for (const menu of document.querySelectorAll('.nav-group[open]')) if (!menu.contains(event.target)) menu.open = false;
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if ($('session-menu').open) { $('session-menu').open = false; $('session-menu').querySelector('summary').focus(); }
  document.querySelectorAll('.nav-group[open]').forEach(menu => { menu.open = false; });
  $('menu-toggle').setAttribute('aria-expanded', 'false'); $('site-nav').classList.remove('open');
});
let polling = false;
setInterval(async () => {
  if (!active || polling || busy) return;
  polling = true;
  try { update(await api('session')); }
  catch { status('Session service unavailable'); }
  finally { polling = false; }
}, 1500);
setInterval(() => {
  if (!session || !active) return;
  const seconds = Math.max(0, Math.ceil((session.expiresAt - Date.now() - offset)/1000));
  allowance('timer', `${Math.floor(seconds/60).toString().padStart(2,'0')}:${(seconds%60).toString().padStart(2,'0')}`);
  if (!seconds) expire();
}, 250);
(async () => {
  lock(false);
  try {
    const config = await api('countries'); runtimeOrigin = config.runtimeOrigin;
    countryPicker.setCountries(config.countries);
    renderCountryMarquee(config.countries);
    renderCountryOrbits(config.countries);
    $('country-count').textContent = config.countries.length;
    configured = true;
    // Restore allowance without replacing the United States default.
    try { update(await api('session')); } catch {}
    lock(false);
  } catch { notice('The browsing service is unavailable. Please try again shortly.'); lock(false); }
})();
