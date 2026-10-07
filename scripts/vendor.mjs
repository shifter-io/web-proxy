import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { scramjetPath } = require('@mercuryworkshop/scramjet/path');
const { baremuxPath } = require('@mercuryworkshop/bare-mux/node');
const { epoxyPath } = require('@mercuryworkshop/epoxy-transport');
for (const [name, path] of Object.entries({ scram: scramjetPath, baremux: baremuxPath, epoxy: epoxyPath })) {
  await mkdir(`web/runtime/vendor/${name}`, { recursive: true });
  await cp(path, `web/runtime/vendor/${name}`, { recursive: true });
}

// Scope pacing to Epoxy's native Wisp WebSocket constructors. Do not replace
// the worker's global WebSocket or mutate the installed dependency package.
const epoxyModule = 'web/runtime/vendor/epoxy/index.mjs';
const source = await readFile(epoxyModule, 'utf8');
if ((source.match(/new WebSocket\(/g) || []).length !== 2) {
  throw new Error('Epoxy WebSocket bindings changed; review the Wisp pacing integration.');
}
await writeFile(epoxyModule, "import {FlowControlledWebSocket} from '../../wisp-transport.mjs';\n" +
  source.replaceAll('new WebSocket(', 'new FlowControlledWebSocket('));
