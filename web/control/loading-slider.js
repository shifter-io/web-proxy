// Shifter product slides shown while a proxied page loads. Story style: progress bars,
// tap the left third for back and the rest for next, swipe on touch screens.
const UTM = 'utm_source=web-proxy&utm_medium=loading-slider';
const RESIDENTIAL = `https://shifter.io/services/residential-proxies?${UTM}`;
export const SLIDES = [
  {label:'Powered by Shifter', title:'You are browsing through [[Shifter]]',
    text:'Every page you open here goes through a real household IP from our 205M+ residential pool.',
    chips:['205M+ residential IPs','195 countries','Unlimited connections'], stat:'From $0.10/GB', cta:'Explore Residential Proxies', href:RESIDENTIAL, visual:'route'},
  {label:'Residential Proxies', title:'Residential proxies from [[$0.10/GB]]',
    text:'Rotate on every request or keep a sticky session. Target any country, region, city or ASN.',
    chips:['205M+ residential IPs','City and ASN targeting','Unlimited concurrent connections'], stat:'From $0.10/GB', cta:'See Residential plans', href:RESIDENTIAL, visual:'ips'},
  {label:'ISP Proxies', title:'ISP proxies locked to [[your city and ISP]]',
    text:'Each IP stays on the city and ISP (ASN) you pick for the whole billing period.',
    chips:['Real residential ISPs','99.9% uptime SLA','Unlimited bandwidth'], stat:'From $1.00 per IP', cta:'Explore ISP Proxies', href:`https://shifter.io/services/isp-proxies?${UTM}`, visual:'isp'},
  {label:'Web Scraping API', title:'Scrape any website with [[one API call]]',
    text:'JavaScript rendering, CAPTCHA solving and proxy rotation behind a single REST endpoint.',
    chips:['Headless browser rendering','Auto-retry on failure','Geo-targeting per request'], stat:'From $44/month', cta:'Explore the Scraping API', href:`https://shifter.io/services/scraping-api?${UTM}`, visual:'code'},
  {label:'SERP API', title:'Search results as [[clean JSON]]',
    text:'Google, Bing and more, localized by country, city or device. Pay only for successful searches.',
    chips:['Parsed JSON','Mobile and desktop SERPs','Localized in 195+ countries'], stat:'195+ countries', cta:'Explore the SERP API', href:`https://shifter.io/services/serp-api?${UTM}`, visual:'serp'},
];

const ICONS = {
  arrow:'<path d="M5 12h14M12 5l7 7-7 7"/>',
  check:'<path d="m5 12.5 4.5 4.5L19 7" stroke-width="3"/>',
  globe:'<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20"/>',
  laptop:'<path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/>',
  lock:'<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  search:'<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
};
const esc = value => String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
const flag = code => `<img src="/assets/flags/${code}.svg" alt="" width="18" height="18">`;
const highlight = text => esc(text).replace(/\[\[(.+?)\]\]/, '<span class="ls-hl">$1</span>');
const live = text => `<span class="ls-live"><i></i>${text}</span>`;

const IPS = [['us','73.162.••.14','New York, Comcast'],['de','91.64.••.203','Berlin, Vodafone'],['gb','86.142.••.9','London, BT'],['fr','90.27.••.118','Paris, Orange'],
  ['jp','126.77.••.40','Tokyo, SoftBank'],['br','179.218.••.66','Sao Paulo, Claro'],['ca','174.88.••.31','Toronto, Bell'],['nl','84.84.••.152','Amsterdam, Ziggo']];
const REQUEST = 'POST /v1/scrape\n{\n  "url": "https://example.com",\n  "render": true,\n  "country": "us"\n}';
const RESPONSE = ['<span class="ls-m">{</span>','  <span class="ls-k">"status"</span>: <span class="ls-n">200</span>,','  <span class="ls-k">"country"</span>: <span class="ls-s">"us"</span>,',
  '  <span class="ls-k">"rendered"</span>: <span class="ls-n">true</span>,','  <span class="ls-k">"html"</span>: <span class="ls-s">"&lt;!doctype html&gt;..."</span>','<span class="ls-m">}</span>'];
const RESULTS = [['Best Running Shoes of 2026, Tested','"position": 1, "type": "organic"'],['Top Picks for Road and Trail','"position": 2, "type": "organic"'],
  ['People also ask (4 questions)','"type": "people_also_ask"'],['Shopping results (12 products)','"type": "shopping"']];

const VISUALS = {
  route:() => `<div class="ls-panel-h"><span>Your connection</span>${live('Live')}</div>
    <div class="ls-route"><div class="ls-node"><b>${icon('laptop')}</b><strong>You</strong></div><div class="ls-wire"><i></i><i></i></div>
    <div class="ls-node is-shifter"><b>${icon('globe')}</b><strong>Shifter</strong>Residential IP</div><div class="ls-wire"><i></i><i></i></div>
    <div class="ls-node"><b>${icon('globe')}</b><strong>Website</strong></div></div>
    <dl class="ls-kv ls-route-kv"><dt>Exit</dt><dd>${flag('us')}United States</dd><dt>IP type</dt><dd>Residential</dd><dt>ISP</dt><dd>Comcast Cable</dd></dl>`,
  ips:() => `<div class="ls-panel-h"><span>Rotating residential IPs</span>${live('Live')}</div><div class="ls-ips" data-ips></div>`,
  isp:() => `<div class="ls-panel-h"><span>Your ISP proxy</span>${live('Active')}</div>
    <dl class="ls-kv"><dt>City</dt><dd>${flag('de')}Frankfurt, Germany</dd><dt class="ls-extra">ISP</dt><dd class="ls-extra">Deutsche Telekom</dd>
    <dt class="ls-extra">ASN</dt><dd class="ls-extra">AS3320</dd><dt>IP</dt><dd>84.150.••.27 ${icon('lock')}</dd></dl>
    <div class="ls-lockline"><span>Same IP all billing period</span><b data-day>Day 1 of 30</b></div><div class="ls-days" data-days>${'<i></i>'.repeat(30)}</div>`,
  code:() => `<div class="ls-panel-h ls-request"><span>Request</span>${live('200 OK')}</div><pre class="ls-code ls-request" data-type></pre>
    <div class="ls-panel-h"><span>Response</span><span>1.8 s</span></div><pre class="ls-code" data-response>${RESPONSE.map(line => `<span class="ls-ln">${line}</span>`).join('\n')}</pre>`,
  serp:() => `<div class="ls-panel-h"><span>Google, United States</span>${live('Live')}</div><div class="ls-search">${icon('search')}<span data-query></span><span class="ls-caret"></span></div>
    <div class="ls-results">${RESULTS.map(([title, json], index) => `<div class="ls-result"><span>${index + 1}</span><div><b>${title}</b><code>${esc(json)}</code></div></div>`).join('')}</div>`,
};

// Each animation returns its own cleanup so only the visible slide does work.
const ANIMATIONS = {
  ips(slide) {
    const list = slide.querySelector('[data-ips]'); let next = 0; list.textContent = '';
    const add = () => {
      const [code, ip, place] = IPS[next++ % IPS.length];
      list.querySelector('em')?.remove();
      list.insertAdjacentHTML('afterbegin', `<div class="ls-ip">${flag(code)}<code>${ip}</code><span>${place}</span><em>new</em></div>`);
      while (list.children.length > 5) list.lastElementChild.remove();
    };
    for (let i = 0; i < 4; i++) add();
    const timer = setInterval(add, 1100);
    return () => clearInterval(timer);
  },
  isp(slide) {
    const days = [...slide.querySelectorAll('[data-days] i')], label = slide.querySelector('[data-day]'); let day = 0;
    days.forEach(cell => cell.classList.remove('on'));
    const timer = setInterval(() => { if (day < days.length) { days[day++].classList.add('on'); label.textContent = `Day ${day} of 30`; } }, 140);
    return () => clearInterval(timer);
  },
  code(slide) {
    const request = slide.querySelector('[data-type]'), lines = [...slide.querySelectorAll('[data-response] .ls-ln')], timers = []; let typed = 0;
    lines.forEach(line => line.classList.remove('on'));
    const timer = setInterval(() => {
      request.innerHTML = esc(REQUEST.slice(0, ++typed)).replace(/&quot;(.*?)&quot;/g, '<span class="ls-s">&quot;$1&quot;</span>') + '<span class="ls-caret"></span>';
      if (typed >= REQUEST.length) { clearInterval(timer); lines.forEach((line, i) => timers.push(setTimeout(() => line.classList.add('on'), 250 + i * 160))); }
    }, 28);
    return () => { clearInterval(timer); timers.forEach(clearTimeout); };
  },
  serp(slide) {
    const query = slide.querySelector('[data-query]'), rows = [...slide.querySelectorAll('.ls-result')], text = 'best running shoes', timers = []; let typed = 0;
    query.textContent = ''; rows.forEach(row => row.classList.remove('on'));
    const timer = setInterval(() => {
      query.textContent = text.slice(0, ++typed);
      if (typed >= text.length) { clearInterval(timer); rows.forEach((row, i) => timers.push(setTimeout(() => row.classList.add('on'), 300 + i * 220))); }
    }, 60);
    return () => { clearInterval(timer); timers.forEach(clearTimeout); };
  },
};

function slideMarkup(slide) {
  return `<div class="ls-copy"><span class="ls-label"><i></i>${esc(slide.label)}</span><h3>${highlight(slide.title)}</h3><p>${esc(slide.text)}</p>
    <div class="ls-chips">${slide.chips.map(chip => `<span>${icon('check')}${esc(chip)}</span>`).join('')}</div>
    <div class="ls-row"><a class="ls-button" href="${esc(slide.href)}" target="_blank" rel="noopener">${esc(slide.cta)} ${icon('arrow')}</a><span class="ls-stat">${esc(slide.stat)}</span></div></div>
    <div class="ls-panel">${VISUALS[slide.visual]()}</div>`;
}

export class LoadingSlider {
  constructor(root, {slides = SLIDES, interval = 5000} = {}) {
    this.root = root;
    this.slides = slides;
    this.interval = interval;
    this.index = -1;
    root.innerHTML = `<div class="ls-bars">${slides.map((_, i) => `<button type="button" aria-label="Show slide ${i + 1} of ${slides.length}"><i></i></button>`).join('')}</div>
      <div class="ls-story"><div class="ls-slides">${slides.map(slide => `<div class="ls-slide" inert>${slideMarkup(slide)}</div>`).join('')}</div>
      <button type="button" class="ls-edge" data-step="-1" aria-label="Previous slide">${icon('arrow')}</button><button type="button" class="ls-edge" data-step="1" aria-label="Next slide">${icon('arrow')}</button></div>`;
    this.bars = [...root.querySelectorAll('.ls-bars button')];
    this.items = [...root.querySelectorAll('.ls-slide')];
    this.track = root.querySelector('.ls-slides');
    this.bars.forEach((bar, i) => { bar.onclick = () => this.show(i); });
    root.querySelectorAll('.ls-edge').forEach(button => { button.onclick = () => this.step(Number(button.dataset.step)); });
    let start = null;
    this.track.addEventListener('pointerdown', event => { start = {x:event.clientX, y:event.clientY}; });
    this.track.addEventListener('pointercancel', () => { start = null; });
    this.track.addEventListener('pointerup', event => {
      if (!start) return;
      const dx = event.clientX - start.x, dy = event.clientY - start.y; start = null;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) { if (event.pointerType !== 'mouse') this.step(dx < 0 ? 1 : -1); return; }
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && !event.target.closest('a,button')) {
        const box = this.track.getBoundingClientRect();
        this.step(event.clientX < box.left + box.width / 3 ? -1 : 1);
      }
    });
  }
  // Each page load continues with the next product instead of repeating the first one.
  start() { this.running = true; this.show(this.index + 1); }
  stop() {
    this.running = false;
    clearTimeout(this.timer); this.cleanup?.(); this.cleanup = null;
  }
  step(delta) { this.show(this.index + delta); }
  show(target) {
    const previous = this.index, count = this.items.length;
    this.index = (target % count + count) % count;
    this.items.forEach((item, i) => {
      const active = i === this.index;
      item.classList.toggle('on', active);
      item.classList.toggle('out', i === previous && !active);
      item.inert = !active;
    });
    this.bars.forEach((bar, i) => { bar.className = i < this.index ? 'done' : ''; bar.style.setProperty('--ls-duration', `${this.interval}ms`); });
    void this.root.offsetWidth;
    this.bars[this.index].className = 'run';
    this.cleanup?.(); this.cleanup = null;
    clearTimeout(this.timer);
    if (!this.running) return;
    this.cleanup = ANIMATIONS[this.slides[this.index].visual]?.(this.items[this.index]) || null;
    this.timer = setTimeout(() => this.step(1), this.interval);
  }
}
