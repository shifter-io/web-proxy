let googleLoad;
function loadGoogle(nonce) {
  if (window.grecaptcha?.render) return Promise.resolve(window.grecaptcha);
  if (!googleLoad) {
    googleLoad = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://www.google.com/recaptcha/api.js?render=explicit';
      script.async = true;
      if (nonce) script.nonce = nonce;
      const timer = setTimeout(() => finish(new Error('Verification did not load. Check your connection and try again.')), 15000);
      function finish(error) {
        clearTimeout(timer);
        if (error) { script.remove(); googleLoad = undefined; reject(error); }
        else resolve(window.grecaptcha);
      }
      script.onerror = () => finish(new Error('Verification could not load. Please try again.'));
      script.onload = () => window.grecaptcha?.ready(() => finish());
      document.head.append(script);
    });
  }
  return googleLoad;
}

export function challenge(siteKey, {nonce, signal} = {}) {
  if (!siteKey) return Promise.reject(Object.assign(new Error('Verification is not configured.'), {code:'CAPTCHA_UNAVAILABLE'}));
  const previous = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'shifter-web-proxy-verification';
  dialog.setAttribute('aria-label', 'Verify to start browsing');
  dialog.setAttribute('aria-modal','true');
  const backdrop = document.createElement('div');
  backdrop.className = 'shifter-web-proxy-backdrop';
  const previousOverflow = document.body.style.overflow;
  const style = document.createElement('style');
  if (nonce) style.nonce = nonce;
  style.textContent = `.shifter-web-proxy-backdrop{position:fixed;inset:0;z-index:1000000000;display:grid;place-items:center;background:#101521aa}.shifter-web-proxy-backdrop dialog{position:relative;margin:auto}.shifter-web-proxy-verification{box-sizing:border-box;background:#fff;color:#182329;border:1px solid #ddd;border-radius:18px;padding:28px;width:min(390px,calc(100vw - 20px));font:16px/1.5 system-ui;box-shadow:0 20px 80px #0004}.shifter-web-proxy-verification::backdrop{background:#101521aa}.shifter-web-proxy-verification h2{font:600 22px/1.3 system-ui;margin:0 32px 12px 0}.shifter-web-proxy-verification p{font:14px/1.5 system-ui;margin:12px 0}.shifter-web-proxy-verification button{position:absolute;right:12px;top:10px;border:0;background:transparent;color:#333;font:26px system-ui;cursor:pointer;padding:4px 10px}.shifter-web-proxy-verification [data-widget]{min-height:80px}.shifter-web-proxy-verification [role=status]{color:#5b6269}`;
  const title = document.createElement('h2'); title.textContent = 'One quick check';
  const text = document.createElement('p'); text.textContent = 'Verify you’re human to start browsing.';
  const close = document.createElement('button'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label','Close verification');
  const widget = document.createElement('div'); widget.dataset.widget = '';
  const status = document.createElement('p'); status.setAttribute('role','status'); status.textContent = 'Loading verification…';
  dialog.append(style, close, title, text, widget, status);
  backdrop.append(dialog); document.body.append(backdrop);
  document.body.style.overflow = 'hidden';
  return new Promise((resolve, reject) => {
    let settled = false, widgetId;
    function finish(error, token) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', cancel);
      if (widgetId !== undefined) { try { window.grecaptcha.reset(widgetId); } catch {} }
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('focusin', focusin);
      dialog.close(); backdrop.remove(); document.body.style.overflow = previousOverflow;
      if (previous?.isConnected) previous.focus({preventScroll:true});
      if (error) reject(error); else resolve(token);
    }
    function cancel() { finish(Object.assign(new Error('Verification cancelled.'), {code:'CANCELLED'})); }
    function isGoogleFrame(element) {
      return element?.tagName === 'IFRAME' && /^https:\/\/(www\.)?(google\.com|recaptcha\.net)\/recaptcha\//.test(element.src);
    }
    function focusin(event) {
      // Google's image challenge is appended outside our dialog. It must remain interactive.
      if (!dialog.contains(event.target) && !isGoogleFrame(event.target)) close.focus();
    }
    function keydown(event) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); }
      if (event.key === 'Tab' && event.shiftKey && document.activeElement === close) {
        const last = dialog.querySelector('iframe') || close; event.preventDefault(); last.focus();
      }
    }
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('focusin', focusin);
    close.onclick = cancel;
    dialog.addEventListener('cancel', event => { event.preventDefault(); cancel(); });
    signal?.addEventListener('abort', cancel, {once:true});
    if (signal?.aborted) { cancel(); return; }
    // Non-top-layer dialog: native showModal() makes Google's external challenge inert.
    dialog.show(); close.focus();
    loadGoogle(nonce).then(google => {
      if (settled) return;
      status.textContent = '';
      widgetId = google.render(widget, {
        sitekey:siteKey, size:window.innerWidth < 370 ? 'compact' : 'normal',
        callback:token => finish(null, token),
        'expired-callback':() => { status.textContent = 'Verification expired. Please try again.'; google.reset(widgetId); },
        'error-callback':() => finish(Object.assign(new Error('Verification failed to connect. Please try again.'), {code:'CAPTCHA_UNAVAILABLE'})),
      });
    }).catch(error => finish(Object.assign(error, {code:'CAPTCHA_UNAVAILABLE'})));
  });
}
