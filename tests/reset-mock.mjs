import assert from 'node:assert/strict';
import {origin} from './client.mjs';
import {docker} from './docker.mjs';
assert.equal((await fetch(`${origin}/api/countries`).then(r=>r.json())).testMode,true,'Only the isolated mock profile may be reset');
await docker(['compose','exec','-T','redis','redis-cli','-n','1','FLUSHDB']);
console.log('Cleared only this project’s mock database (DB 1). Reload the test page.');
