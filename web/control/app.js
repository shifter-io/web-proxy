const $ = id => document.getElementById(id);
let runtimeOrigin, active = false, ready = false, session = null, offset = 0, pendingUrl = null, busy = false, wasConnected = false;
const runtime = $('runtime');
function status(text) { $('status').textContent = text; }
function notice(text = '') { $('notice').textContent = text; }
async function api(path, method = 'GET', body) {
  const response = await fetch('/api/' + path, { method, headers: body ? {'Content-Type':'application/json'} : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function send(command, data = {}) { runtime.contentWindow?.postMessage({ source:'shifter-control', command, ...data }, runtimeOrigin); }
function update(s) {
  session = s; offset = s.serverTime - Date.now();
  $('traffic').textContent = `${(s.remainingBytes / 1048576).toFixed(1)} MiB`;
  if (s.connected) wasConnected = true;
  if (active && wasConnected && !s.connected && s.status === 'active') { status('Connection interrupted'); notice('Select Reload to reconnect. Interrupted requests are not replayed automatically.'); }
  if (['expired','exhausted'].includes(s.status)) expire();
}
function expire() {
  if (active) send('clear');
  active = false; ready = false; runtime.hidden = true;
  $('empty').hidden = true; $('expired').hidden = false;
  status('Daily allowance ended'); $('timer').textContent = '00:00';
}
async function authorize(url) {
  const {ticket} = await api('session/tickets', 'POST');
  send('start', {ticket, url});
}
async function openRuntime(url) {
  pendingUrl = url; ready = false; runtime.hidden = false;
  $('empty').hidden = true; $('expired').hidden = true;
  runtime.src = `${runtimeOrigin}/reset.html`;
}
window.addEventListener('message', async event => {
  if (event.origin !== runtimeOrigin || event.source !== runtime.contentWindow || event.data?.source !== 'shifter-runtime') return;
  const data = event.data;
  try {
    if (data.type === 'ready') {
      ready = true;
      if (active && pendingUrl) { const url = pendingUrl; pendingUrl = null; await authorize(url); }
    } else if (data.type === 'url') {
      $('address').value = data.url; status('Browsing through Shifter');
    } else if (data.type === 'error') { status('Connection interrupted'); notice(data.message); }
    else if (data.type === 'cleared' && !['expired','exhausted'].includes(session?.status)) { status('Browsing stopped'); }
  } catch (error) { notice(error.message); status('Unable to connect'); }
});
$('navigate').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  busy = true; $('go').disabled = true; notice();
  try {
    let input = $('address').value.trim();
    if (!/^https?:\/\//i.test(input)) input = 'https://' + input;
    const url = new URL(input);
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80','443'].includes(url.port))) throw new Error('Enter an HTTP or HTTPS website on port 80 or 443.');
    if (!active) {
      update(await api('sessions', 'POST', {country:$('country').value}));
      if (session.status !== 'active') return;
      $('country').value = session.country; active = true;
      await openRuntime(url.href);
    } else if (ready) send('go', {url:url.href});
    status('Connecting through Shifter…');
  } catch (error) { status('Unable to browse'); notice(error.message); }
  finally { busy = false; $('go').disabled = false; }
});
$('country').addEventListener('change', async () => {
  if (!active) return;
  const selected = $('country').value;
  try {
    status('Changing location…');
    update(await api('session/country', 'POST', {country:selected}));
    send('clear');
    // Allow the old relay to observe revocation and release its lease before the replacement starts.
    await new Promise(resolve => setTimeout(resolve, 1400));
    notice('Country changed. This is a fresh website session; you may need to sign in again.');
    await openRuntime($('address').value);
  } catch (error) { notice(error.message); }
});
for (const command of ['back','forward']) $(command).onclick = () => active && ready && send(command);
$('reload').onclick = async () => {
  if (!active || !ready || busy) return;
  busy = true; wasConnected = false;
  try {
    status('Reconnecting…'); notice();
    await api('session/reconnect','POST');
    // A dead replica retains its connection lease for at most six seconds.
    await new Promise(resolve => setTimeout(resolve, 6500));
    const {ticket} = await api('session/tickets','POST');
    send('reconnect',{ticket,url:$('address').value});
  } catch(error) {notice(error.message);} finally {busy = false;}
};
$('stop').onclick = async () => {
  try { await api('session','DELETE'); } catch (error) { notice(error.message); }
  send('clear'); active = false; ready = false; session = null;
  runtime.hidden = true; $('empty').hidden = false; status('Browsing stopped');
};
setInterval(async () => {
  if (!active) return;
  try { update(await api('session')); }
  catch { status('Session service unavailable'); }
}, 1500);
setInterval(() => {
  if (!session || !active) return;
  const seconds = Math.max(0, Math.ceil((session.expiresAt - Date.now() - offset)/1000));
  $('timer').textContent = `${Math.floor(seconds/60).toString().padStart(2,'0')}:${(seconds%60).toString().padStart(2,'0')}`;
  if (!seconds) expire();
}, 250);
(async () => {
  try {
    const config = await api('countries'); runtimeOrigin = config.runtimeOrigin;
    $('country').replaceChildren(...config.countries.map(({code,name}) => new Option(name,code)));
    try { const s = await api('session'); update(s); $('country').value = s.country; } catch {}
  } catch { notice('The local session service is unavailable.'); $('go').disabled = true; }
})();
