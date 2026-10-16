"""Harmless download fixtures, shared by SOCKS upstream and localhost controls.

Bodies are inert text, regardless of filename/MIME; nothing is executable.
"""
import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

FORMATS = json.loads(Path(__file__).with_name('downloads.json').read_text())
BODY = b'Harmless proxy download regression fixture.\n'
PAGE = b'''<!doctype html><meta charset="utf-8"><title>Download checks</title>
<h1 id="ready">Download checks</h1><a id="download" href="/downloads/file.txt">Attachment</a>
<a id="attribute" href="/downloads/file.txt?disposition=inline" download="saved.txt">Download attribute</a>
<button id="blob">Blob download</button><button id="data">Data download</button>
<form action="/downloads/file.txt" method="post"><button id="post">POST download</button></form>
<script>
window.fixtureScript = true;
for (const kind of ['blob','data']) document.getElementById(kind).onclick = () => {
  const a = document.createElement('a');
  a.href = kind === 'blob' ? URL.createObjectURL(new Blob(['harmless generated file'],{type:'application/octet-stream'}))
    : 'data:application/octet-stream;base64,aGFybWxlc3M=';
  a.download = 'generated.txt'; document.body.append(a); a.click(); a.remove();
};
</script>'''


def response(path, headers):
    uri = urlsplit(path)
    query = parse_qs(uri.query)
    if uri.path == '/downloads':
        return '200 OK', 'text/html', '', PAGE
    if uri.path == '/downloads/redirect':
        return '302 Found', 'text/plain', 'Location: /downloads/file.zip\r\n', b''
    extension = query.get('format', [uri.path.rsplit('.', 1)[-1]])[0]
    content_type = query.get('type', [FORMATS.get(extension, 'application/octet-stream')])[0]
    disposition = query.get('disposition', ['attachment'])[0]
    extra = '' if disposition == 'none' else f'Content-Disposition: {disposition}; filename="fixture.{extension}"\r\n'
    if 'range' in headers:
        return '206 Partial Content', content_type, extra + f'Content-Range: bytes 0-9/{len(BODY)}\r\n', BODY[:10]
    body = b'globalThis.scriptLoaderFixture = true;' if uri.path == '/downloads/loader.js' else BODY
    return '200 OK', content_type, extra, body


if __name__ == '__main__':
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    import sys

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            status, content_type, extra, body = response(self.path, self.headers)
            self.send_response(int(status.split()[0]))
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            for line in extra.strip().split('\r\n'):
                if line:
                    name, value = line.split(': ', 1)
                    self.send_header(name, value)
            self.end_headers()
            self.wfile.write(body)

        do_POST = do_GET

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), Handler)
    print(server.server_port, flush=True)
    server.serve_forever()
