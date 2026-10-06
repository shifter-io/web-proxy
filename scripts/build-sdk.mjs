// Publish an immutable SDK directory from its single maintained source.
import {mkdir, readFile, writeFile, readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const loader = await readFile(new URL('../web/sdk/v1/shifter-web-proxy.js',import.meta.url),'utf8');
const version = process.argv[2] || loader.match(/const RELEASE = '(\d+\.\d+\.\d+)'/)?.[1];
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Pass a semantic release version.');
const root = new URL('../web/sdk/', import.meta.url);
const output = new URL(`releases/${version}/`,root);
await mkdir(output,{recursive:true});
const hashes = {};
for (const file of (await readdir(new URL('src/',root))).filter(f => f.endsWith('.js')).sort()) {
  const bytes = await readFile(new URL(`src/${file}`,root));
  const target = new URL(file,output);
  const existing = await readFile(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (existing && !existing.equals(bytes)) throw new Error(`Release ${version} already exists with different content. Publish a new version.`);
  await writeFile(target,bytes);
  hashes[file] = createHash('sha256').update(bytes).digest('hex');
}
await writeFile(new URL('manifest.json',output),JSON.stringify({version,protocolVersion:1,sha256:hashes},null,2)+'\n');
console.log(`SDK release ${version} verified`);
