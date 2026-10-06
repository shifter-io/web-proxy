import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {eligibleCountryCodes} from '../scripts/sync-countries.mjs';
const tree = (...leaves) => ({region:{city:{member:Object.fromEntries(leaves.map((leaf,i)=>[`AS${i}`,leaf]))}}});
test('only Shifter counts qualify, summed across ASN leaves with a strict cutoff', () => {
  assert.deepEqual(eligibleCountryCodes({providers:{shifter:true},locations:{
    SE:tree({shifter:250}), AU:tree({shifter:204,alpha:10000}),
    US:tree({shifter:200},{shifter:51,gamma:900}), GB:tree({shifter:251}),
    FR:tree({alpha:9000,gamma:8000}),
  }}), ['gb','us']);
});
test('disabled, empty and malformed inputs cannot silently replace the allowlist', () => {
  for(const weights of [
    {providers:{shifter:false},locations:{US:tree({shifter:900})}},
    {providers:{shifter:true},locations:{SE:tree({shifter:250})}},
    {providers:{shifter:true},locations:{US:tree({shifter:'999'})}},
    {providers:{shifter:true},locations:{US:tree({shifter:-1})}},
  ]) assert.throws(()=>eligibleCountryCodes(weights));
});
test('every backend country has a local flag and the default US remains available', async () => {
  const config = await readFile(new URL('../src/config.rs', import.meta.url),'utf8');
  const block = config.match(/pub const COUNTRIES:[\s\S]*?\n\];/)[0];
  const codes = [...block.matchAll(/\("([a-z]{2})",/g)].map(m=>m[1]);
  assert.equal(codes.length,new Set(codes).size);
  assert.ok(codes.includes('us'));
  for(const code of codes) await access(new URL(`../web/control/assets/flags/${code}.svg`,import.meta.url));
});
