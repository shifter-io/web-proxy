// Derive the public allowlist from a local copy of session-manager/config/weights.json.
// Never copy the private weights tree, provider counts, or operational metadata into this repo.
import {readFile, writeFile, mkdir, copyFile, access} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';

export function eligibleCountryCodes(weights) {
  if (weights.providers?.shifter !== true || !weights.locations || typeof weights.locations !== 'object' || Array.isArray(weights.locations)) {
    throw new Error('Expected an enabled Shifter provider and country location tree');
  }
  function count(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('Invalid location tree');
    let total = 0;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'shifter') {
        if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid Shifter weight');
        total += value;
      } else if (value && typeof value === 'object') total += count(value);
    }
    return total;
  }
  const codes = Object.entries(weights.locations).filter(([code, tree]) => {
    if (!/^[A-Z]{2}$/.test(code)) throw new Error('Invalid country code');
    return count(tree) > 250;
  }).map(([code]) => code.toLowerCase());
  if (!codes.length) throw new Error('No eligible countries; refusing to replace the allowlist');
  return codes.sort();
}

async function main() {
  const [weightsFile, shifterDirectory] = process.argv.slice(2);
  if (!weightsFile || !shifterDirectory) throw new Error('Usage: node scripts/sync-countries.mjs <local-weights.json> <local-Shifter-Astro-directory>');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const codes = eligibleCountryCodes(JSON.parse(await readFile(weightsFile, 'utf8')));
  const catalog = JSON.parse(await readFile(path.join(shifterDirectory, 'src/data/country-ip-pools.json'), 'utf8'));
  const names = new Map(catalog.map(c => [c.code, c.country]));
  const countries = codes.map(code => {
    const name = names.get(code);
    if (!name) throw new Error(`Missing Shifter country name: ${code}`);
    return {code, name};
  }).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  // Validate all assets before changing any files.
  for (const {code} of countries) await access(path.join(shifterDirectory, `public/images/flags/${code}.svg`));
  const configFile = path.join(root, 'src/config.rs');
  const config = await readFile(configFile, 'utf8');
  const block = /pub const COUNTRIES: &\[\(&str, &str\)\] = &\[[\s\S]*?\n\];/;
  if (!block.test(config)) throw new Error('Country allowlist not found');
  const rust = 'pub const COUNTRIES: &[(&str, &str)] = &[\n' + countries.map(({code,name}) => `    (${JSON.stringify(code)}, ${JSON.stringify(name)}),`).join('\n') + '\n];';
  await mkdir(path.join(root, 'web/control/assets/flags'), {recursive:true});
  for (const {code} of countries) await copyFile(path.join(shifterDirectory, `public/images/flags/${code}.svg`), path.join(root, `web/control/assets/flags/${code}.svg`));
  await writeFile(configFile, config.replace(block, rust));
  console.log(`Updated ${countries.length} countries (Shifter weight > 250) and copied matching flag assets.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
