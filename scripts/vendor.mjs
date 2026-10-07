import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { scramjetPath } = require('@mercuryworkshop/scramjet/path');
const { baremuxPath } = require('@mercuryworkshop/bare-mux/node');
const { libcurlPath } = require('@mercuryworkshop/libcurl-transport');
// Remove the previous transport from incremental local builds as well.
await rm('web/runtime/vendor/epoxy', {recursive:true, force:true});
for (const [name, path] of Object.entries({ scram: scramjetPath, baremux: baremuxPath, libcurl: libcurlPath })) {
  await mkdir(`web/runtime/vendor/${name}`, { recursive: true });
  await cp(path, `web/runtime/vendor/${name}`, { recursive: true });
}

// Patch the document bootstrap, including rewritten srcdoc frames, rather than
// disabling browser features in the trusted runtime or changing website HTML.
const scramPath = 'web/runtime/vendor/scram/scramjet.all.js';
const scramSource = await readFile(scramPath, 'utf8');
const bootstrap = '\n\t\t$scramjetLoadClient().loadAndHook(';
if (scramSource.split(bootstrap).length !== 2) {
  throw new Error('Scramjet document bootstrap changed; review document compatibility.');
}
const compatibility = await readFile('scripts/compat/document.js', 'utf8');
// This source is inserted inside the upstream bootstrap's template literal.
const escaped = compatibility.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('${', '\\${');
await writeFile(scramPath, scramSource.replace(bootstrap, () => '\n' + escaped + bootstrap));

// libcurl.js 0.7.4 closes a response stream even when the transfer fails after
// headers arrive. The already-resolved fetch promise cannot report that error,
// so Scramjet would execute a truncated script instead of retrying its body.
// Preserve libcurl's transfer result on the stream; do not change TLS checks.
const modulePath = 'web/runtime/vendor/libcurl/index.mjs';
const source = await readFile(modulePath, 'utf8');
const original = `          stream_controller.close();
        } catch {
        }
        end_callback(error);`;
if (source.split(original).length !== 2) {
  throw new Error('libcurl response stream changed; review the transfer-error patch.');
}
await writeFile(modulePath, source.replace(original, `          if (error) stream_controller.error(new TypeError('Response transfer failed: ' + error));
          else stream_controller.close();
        } catch {
        }
        end_callback(error);`));
