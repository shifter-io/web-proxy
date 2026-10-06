import { cp, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { scramjetPath } = require('@mercuryworkshop/scramjet/path');
const { baremuxPath } = require('@mercuryworkshop/bare-mux/node');
const { epoxyPath } = require('@mercuryworkshop/epoxy-transport');
for (const [name, path] of Object.entries({ scram: scramjetPath, baremux: baremuxPath, epoxy: epoxyPath })) {
  await mkdir(`web/runtime/vendor/${name}`, { recursive: true });
  await cp(path, `web/runtime/vendor/${name}`, { recursive: true });
}
