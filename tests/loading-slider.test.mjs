import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';

async function setup(t) {
  const dom = new JSDOM('<section id="slider"></section>', {url:'https://web.p.shifter.io/'});
  for (const key of ['window','document','HTMLElement']) globalThis[key] = dom.window[key];
  t.after(() => { for (const key of ['window','document','HTMLElement']) delete globalThis[key]; });
  t.mock.timers.enable({apis:['setTimeout','setInterval']});
  const {LoadingSlider, SLIDES} = await import('../web/control/loading-slider.js');
  const root = dom.window.document.getElementById('slider');
  const slider = new LoadingSlider(root, {interval:5000});
  const track = root.querySelector('.ls-slides');
  track.getBoundingClientRect = () => ({left:0, top:0, width:300, height:400});
  const pointer = (type, x, y, pointerType = 'touch', target = track) => {
    const event = new dom.window.MouseEvent(type, {bubbles:true, clientX:x, clientY:y});
    Object.defineProperty(event, 'pointerType', {value:pointerType});
    target.dispatchEvent(event);
  };
  const active = () => [...root.querySelectorAll('.ls-slide')].findIndex(slide => slide.classList.contains('on'));
  return {root, slider, track, pointer, active, SLIDES};
}

test('slides advance on their own, loop, and only the visible slide is reachable', async t => {
  const {root, slider, active, SLIDES} = await setup(t);
  slider.start();
  assert.equal(active(), 0);
  t.mock.timers.tick(5000);
  assert.equal(active(), 1);
  const slides = [...root.querySelectorAll('.ls-slide')];
  assert.deepEqual(slides.map(slide => slide.inert), slides.map((_, i) => i !== 1));
  assert.equal(root.querySelectorAll('.ls-bars .done').length, 1);
  assert.equal(root.querySelector('.ls-bars .run'), root.querySelectorAll('.ls-bars button')[1]);
  for (let i = 1; i < SLIDES.length; i++) t.mock.timers.tick(5000);
  assert.equal(active(), 0, 'the last slide wraps to the first');
  slider.stop();
});

test('stop freezes the slider and the next page load continues with the next product', async t => {
  const {slider, active} = await setup(t);
  slider.start();
  slider.stop();
  for (let i = 0; i < 4; i++) t.mock.timers.tick(5000);
  assert.equal(active(), 0);
  slider.start();
  assert.equal(active(), 1);
  slider.stop();
});

test('touch swipes move back and forward; mouse drags and vertical scrolls do not', async t => {
  const {slider, pointer, active} = await setup(t);
  slider.start();
  pointer('pointerdown', 200, 100); pointer('pointerup', 120, 110);
  assert.equal(active(), 1, 'swipe left shows the next slide');
  pointer('pointerdown', 100, 100); pointer('pointerup', 190, 95);
  assert.equal(active(), 0, 'swipe right shows the previous slide');
  pointer('pointerdown', 100, 100); pointer('pointerup', 160, 300);
  assert.equal(active(), 0, 'a mostly vertical gesture is a scroll');
  pointer('pointerdown', 200, 100, 'mouse'); pointer('pointerup', 100, 100, 'mouse');
  assert.equal(active(), 0, 'mouse drags select text instead of switching');
  pointer('pointerdown', 200, 100); t.mock.timers.tick(3000); pointer('pointerup', 120, 100);
  t.mock.timers.tick(4999);
  assert.equal(active(), 1, 'a manual move restarts the slide timer');
  t.mock.timers.tick(1);
  assert.equal(active(), 2);
  slider.stop();
});

test('taps on the left third go back, elsewhere go forward, and links keep working', async t => {
  const {root, slider, pointer, active} = await setup(t);
  slider.start();
  pointer('pointerdown', 250, 100); pointer('pointerup', 250, 100);
  assert.equal(active(), 1);
  pointer('pointerdown', 50, 100); pointer('pointerup', 52, 101);
  assert.equal(active(), 0);
  const link = root.querySelectorAll('.ls-slide')[0].querySelector('a');
  pointer('pointerdown', 250, 100, 'touch', link); pointer('pointerup', 250, 100, 'touch', link);
  assert.equal(active(), 0, 'tapping the call to action does not switch slides');
  root.querySelector('[data-step="1"]').click();
  assert.equal(active(), 1);
  root.querySelectorAll('.ls-bars button')[4].click();
  assert.equal(active(), 4);
  slider.stop();
});

test('calls to action open shifter.io in a new tab with campaign tags', async t => {
  const {root} = await setup(t);
  const links = [...root.querySelectorAll('.ls-button')];
  assert.equal(links.length, 5);
  for (const link of links) {
    const url = new URL(link.href);
    assert.equal(url.origin, 'https://shifter.io');
    assert.equal(url.searchParams.get('utm_source'), 'web-proxy');
    assert.equal(link.target, '_blank');
    assert.equal(link.rel, 'noopener');
  }
});
