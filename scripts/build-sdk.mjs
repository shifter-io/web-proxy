// Publish an immutable SDK directory from its single maintained source.
import {mkdir, readFile, writeFile, readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root = new URL('../web/sdk/', import.meta.url);
const semantic = /^\d+\.\d+\.\d+$/;
const publish = process.argv[2] !== undefined;
const version = publish ? process.argv[2] : (await readdir(new URL('releases/',root)))
  .filter(name => semantic.test(name)).sort((a,b) => a.localeCompare(b,'en',{numeric:true})).at(-1);
if (!version || !semantic.test(version)) throw new Error('Pass a semantic release version.');
const output = new URL(`releases/${version}/`,root);
if (publish) await mkdir(output,{recursive:true});
const hashes = {};
for (const file of (await readdir(new URL('src/',root))).filter(f => f.endsWith('.js')).sort()) {
  const bytes = await readFile(new URL(`src/${file}`,root));
  const target = new URL(file,output);
  const existing = await readFile(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!existing && !publish) throw new Error(`Release ${version} is missing ${file}.`);
  if (existing && !existing.equals(bytes)) throw new Error(`Release ${version} already exists with different content. Publish a new version.`);
  if (!existing) await writeFile(target,bytes,{flag:'wx'});
  hashes[file] = createHash('sha256').update(bytes).digest('hex');
}
const manifest = new URL('manifest.json',output);
const expected = JSON.stringify({version,protocolVersion:1,sha256:hashes},null,2)+'\n';
const existing = await readFile(manifest,'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; });
if (!existing && publish) await writeFile(manifest,expected,{flag:'wx'});
else if (existing !== expected) throw new Error(`Release ${version} manifest does not match its assets.`);
console.log(`SDK release ${version} verified`);
