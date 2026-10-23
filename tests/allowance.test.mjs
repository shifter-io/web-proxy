import {test} from 'node:test';
import assert from 'node:assert/strict';
import {formatTime, formatTraffic} from '../web/control/allowance.js';

test('allowance displays full hours and decimal GB', () => {
  assert.equal(formatTime(86400), '24:00:00');
  assert.equal(formatTime(86399), '23:59:59');
  assert.equal(formatTime(3600), '01:00:00');
  assert.equal(formatTime(59), '00:00:59');
  assert.equal(formatTime(), '00:00:00');
  assert.equal(formatTraffic(10_000_000_000), '10.00 GB');
  assert.equal(formatTraffic(5_000_000_000), '5.00 GB');
  assert.equal(formatTraffic(), '0.00 GB');
});
