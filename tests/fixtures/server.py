"""Bounded synthetic SOCKS5 upstream and HTTP website; never connects to the Internet."""
import asyncio, hashlib, json, re
from urllib.parse import urlsplit, parse_qs

PAGE = '''<!doctype html><html><head><title>Shifter fixture</title></head><body style="font:18px system-ui;padding:32px;background:#f3f8eb;color:#234">
<h1>Proxy test destination</h1><p id="identity">COUNTRY / SID</p>
<nav><a href="/next">Next page</a> · <a href="/redirect">Redirect</a> · <a href="http://second.test/">Second origin</a> · <a href="/logout">Log out</a></nav>
<p id="result">JavaScript request pending</p><form action="/login" method="post"><label>Synthetic username <input name="username" value="alice"></label><button>Sign in</button></form>
<p id="login">LOGIN</p><script>fetch('/api').then(r=>r.json()).then(d=>document.getElementById('result').textContent='JavaScript fetch OK: '+d.country);</script></body></html>'''

async def handle(reader, writer):
    try:
        version, n = await reader.readexactly(2)
        methods = await reader.readexactly(n)
        if version != 5 or 2 not in methods: return
        writer.write(b'\x05\x02'); await writer.drain()
        version, n = await reader.readexactly(2)
        username = (await reader.readexactly(n)).decode()
        n = (await reader.readexactly(1))[0]
        password = await reader.readexactly(n)
        match = re.fullmatch(r'customer-fixture-country-([a-z]{2})-strict-true-sid-([a-f0-9]{32})-ttl-1800-pool-shifter', username)
        if not match or password != b'fixture-password':
            writer.write(b'\x01\x01'); await writer.drain(); return
        country, sid = match.groups()
        writer.write(b'\x01\x00'); await writer.drain()
        version, cmd, _, kind = await reader.readexactly(4)
        if kind == 1: address = await reader.readexactly(4)
        elif kind == 4: address = await reader.readexactly(16)
        elif kind == 3: address = await reader.readexactly((await reader.readexactly(1))[0])
        else: return
        port = int.from_bytes(await reader.readexactly(2), 'big')
        writer.write(b'\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00'); await writer.drain()
        head = (await reader.readuntil(b'\r\n\r\n')).decode('latin1')
        lines=head.split('\r\n'); method, path, _=lines[0].split(' ',2)
        headers=dict(line.lower().split(': ',1) for line in lines[1:] if ': ' in line)
        length=int(headers.get('content-length','0'))
        if length>65536: return
        body=await reader.readexactly(length) if length else b''
        uri=urlsplit(path); extra=''; code='200 OK'; content_type='text/html; charset=utf-8'
        identity={'country':country,'sid':sid,'ip':'198.51.100.'+str(int(hashlib.sha256(sid.encode()).hexdigest()[:2],16)), 'host':headers.get('host','')}
        if uri.path in ['/api','/ip']:
            payload=json.dumps(identity).encode();content_type='application/json'
        elif uri.path=='/bytes':
            count=min(int(parse_qs(uri.query).get('n',['1024'])[0]),4*1024*1024)
            payload=b'x'*count;content_type='application/octet-stream'
        elif uri.path=='/slow':
            writer.write(b'HTTP/1.1 200 OK\r\nContent-Length: 10000000\r\nContent-Type: text/plain\r\n\r\n');await writer.drain()
            for _ in range(1000):
                writer.write(b'x'*1024); await writer.drain(); await asyncio.sleep(.1)
            return
        elif uri.path=='/login':
            user=parse_qs(body.decode()).get('username',['alice'])[0]
            user=re.sub('[^a-zA-Z0-9]','',user)[:20]
            extra=f'Set-Cookie: fixture_user={user}; Path=/; HttpOnly; SameSite=Lax\r\nLocation: /\r\n';code='302 Found';payload=b''
        elif uri.path=='/logout':
            extra='Set-Cookie: fixture_user=; Path=/; Max-Age=0\r\nLocation: /\r\n';code='302 Found';payload=b''
        elif uri.path=='/redirect':
            extra='Location: /next\r\n';code='302 Found';payload=b''
        elif uri.path=='/redirect-private':
            extra='Location: http://127.0.0.1/\r\n';code='302 Found';payload=b''
        elif uri.path=='/next':
            payload=b'<h1>Navigation works</h1><a href="/">Back to fixture</a>'
        else:
            cookies=headers.get('cookie','')
            user=re.search(r'fixture_user=([a-zA-Z0-9]+)',cookies)
            page=PAGE.replace('COUNTRY / SID',country+' / '+sid[:8]).replace('LOGIN','Signed in as '+user[1] if user else 'Not signed in')
            payload=page.encode()
        writer.write(f'HTTP/1.1 {code}\r\nContent-Type: {content_type}\r\nContent-Length: {len(payload)}\r\nConnection: close\r\n{extra}\r\n'.encode()+payload)
        await writer.drain()
    except (asyncio.IncompleteReadError,ConnectionError,ValueError,asyncio.LimitOverrunError): pass
    finally:
        writer.close()
        try: await writer.wait_closed()
        except ConnectionError: pass

async def main():
    server=await asyncio.start_server(handle,'0.0.0.0',1080,limit=65536)
    async with server: await server.serve_forever()
asyncio.run(main())
