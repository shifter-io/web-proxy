#!/usr/bin/env python3
"""Native systemd Cap transition. JSON input and sanitized JSON output only."""
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def run(*cmd):
    return subprocess.check_output(cmd, stderr=subprocess.PIPE, timeout=90).decode().strip()


def request(url, origin=None, body=None):
    headers = {'Origin': origin} if origin else {}
    if body is not None:
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, headers=headers, data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


def env(role):
    pid = run('systemctl', 'show', 'web-proxy-' + role, '-p', 'MainPID', '--value')
    require(pid != '0', 'service PID missing')
    return dict(x.decode().split('=', 1) for x in Path('/proc/' + pid + '/environ').read_bytes().split(b'\0') if b'=' in x)


def atomic(path, data, mode=0o600, group=0):
    path = Path(path)
    tmp = path.with_name(path.name + '.cutover-new')
    require(not tmp.exists() and not tmp.is_symlink(), 'pending file exists')
    with tmp.open('xb') as f:
        f.write(data)
        f.flush()
        os.fchmod(f.fileno(), mode)
        os.fchown(f.fileno(), 0, group)
        os.fsync(f.fileno())
    tmp.replace(path)


def check(node, provider=None, dual=None):
    require(run('hostname') == node['hostname'], 'hostname mismatch')
    require(run('curl', '-fsS', '--max-time', '5', 'http://169.254.169.254/metadata/v1/id') == str(node['id']), 'Droplet ID mismatch')
    api = env('api')
    gateway = env('gateway')
    for role, port, values in [('api', 3000, api), ('gateway', 3001, gateway)]:
        require(run('systemctl', 'is-active', 'web-proxy-' + role) == 'active', 'inactive service')
        require(values.get('APP_ENV') == 'production', 'not production')
        require(values.get('LISTEN') == node['private_ip'] + ':' + str(port), 'unexpected binding')
        require(request('http://' + values['LISTEN'] + '/health')[1].get('ok'), 'unhealthy service')
    require(not any(k.startswith('CAP_') for k in gateway), 'Cap settings leaked to gateway')
    current_provider = api.get('CAPTCHA_PROVIDER', 'recaptcha')
    current_dual = api.get('CAPTCHA_ACCEPT_BOTH', 'false')
    if provider is not None:
        require(current_provider == provider, 'provider mismatch')
    if dual is not None:
        require(current_dual == str(dual).lower(), 'dual mode mismatch')
    for entry in json.loads(api['INTEGRATIONS']):
        origin = entry['origin'].replace('https://*.', 'https://cutover-check.')
        for query in ['', '?captcha=cap']:
            code, body = request('http://' + api['LISTEN'] + '/api/v1/config' + query, origin)
            expected = 'cap' if current_provider == 'cap' and query else 'recaptcha'
            require(code == 200 and body['captchaProvider'] == expected, 'public provider mismatch')
            require(body['site'] == entry['site'], 'integration changed')
            if expected == 'cap':
                require(body['capEndpoint'].startswith(api['CAP_PUBLIC_URL'] + '/'), 'wrong Cap endpoint')
            else:
                require(body['captchaSiteKey'] == api['RECAPTCHA_SITE_KEY'] and not body.get('capEndpoint'), 'legacy client incompatibility')
    release = Path('/opt/web-proxy/current').resolve()
    loader = (release / 'web/sdk/v1/shifter-web-proxy.js').read_text().split("const RELEASE = '")[1].split("'")[0]
    return {'hostname': node['hostname'], 'provider': current_provider, 'dual': current_dual,
            'services': 'active', 'release': str(release), 'loader_version': loader}


def render(provider, public, verify):
    require(provider in ['cap', 'recaptcha'], 'invalid provider')
    for url in [public, verify]:
        p = urllib.parse.urlsplit(url)
        require(p.scheme == 'https' and p.hostname and p.path in ['', '/'] and not p.query
                and not p.fragment and not p.username and not any(c.isspace() for c in url), 'invalid HTTPS origin')
    return (f'CAPTCHA_PROVIDER={provider}\nCAPTCHA_ACCEPT_BOTH=true\n'
            f'CAP_PUBLIC_URL={public}\nCAP_VERIFY_URL={verify}\n'
            'CAP_SITES_FILE=/etc/web-proxy/api/cap-sites.json\n').encode()


def rejected_by_verifier(code, body):
    # Do not mistake an authentication failure for a working verifier credential.
    return code == 404 and body.get('success') is False and body.get('error') == 'Token not found'


def promote_loader(release):
    source = release / 'web/sdk/v1/shifter-web-proxy.js'
    old = source.read_text()
    require(old.count("const RELEASE = '1.0.10';") == 1, 'unexpected source loader')
    candidate = release.with_name(release.name + '-sdk1.0.12')
    require(not candidate.exists(), 'promotion directory already exists; inspect before retry')
    shutil.copytree(release, candidate)
    target = candidate / 'web/sdk/v1/shifter-web-proxy.js'
    target.write_text(old.replace("const RELEASE = '1.0.10';", "const RELEASE = '1.0.12';"))
    with (candidate / 'BUILD.txt').open('a') as f:
        f.write('\nstable_loader=1.0.12\n')
    manifest = ''.join(hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + str(p.relative_to(candidate)) + '\n'
                       for p in sorted(candidate.rglob('*')) if p.is_file() and p.name != 'SHA256SUMS')
    (candidate / 'SHA256SUMS').write_text(manifest)
    for p in candidate.rglob('*'):
        if p.is_dir():
            p.chmod(0o755)
    candidate.chmod(0o755)
    (candidate / 'SHA256SUMS').chmod(0o644)
    return candidate


def activate_link(release):
    link = Path('/opt/web-proxy/current.cutover-new')
    require(not link.exists() and not link.is_symlink(), 'pending release link exists')
    link.symlink_to(release)
    link.replace('/opt/web-proxy/current')


def verify_served_sdk(node, release):
    for port in [3000, 3001]:
        for relative in ['sdk/v1/shifter-web-proxy.js', 'sdk/releases/1.0.12/manifest.json',
                         'sdk/releases/1.0.12/client.js', 'sdk/releases/1.0.12/captcha.js']:
            with urllib.request.urlopen('http://' + node['private_ip'] + ':' + str(port) + '/' + relative, timeout=15) as response:
                require(response.read() == (release / 'web' / relative).read_bytes(), 'served SDK asset mismatch')


def main(a):
    node, mode = a['node'], a['mode']
    before = check(node)
    if mode == 'audit':
        return before
    require(mode in ['prepare', 'enable', 'rollback', 'loader'], 'invalid mode')
    require(a.get('apply') is True, 'apply required')
    release = Path(before['release'])
    require('commit=' + a['commit'] in (release / 'BUILD.txt').read_text().splitlines(), 'wrong application revision')
    if mode == 'loader' and before['loader_version'] == '1.0.12':
        require(before['dual'] == 'true', 'prepare dual verification first')
        verify_served_sdk(node, release)
        return {**before, 'mode': mode, 'result': 'already_current'}
    # Preserve all old environment and credential files; only an additive API drop-in is managed here.
    managed = [Path('/etc/web-proxy/cap-transition.env'),
               Path('/etc/systemd/system/web-proxy-api.service.d/90-cap-transition.conf')]
    backup = Path('/root/shifter-web-backups') / ('cap-' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + mode)
    require(not backup.exists(), 'backup collision')
    backup.mkdir(parents=True, mode=0o700)
    prior = [p.read_bytes() if p.exists() else None for p in managed]
    (backup / 'state.json').write_text(json.dumps({'release': str(release), 'provider': before['provider'], 'mode': mode}))
    for i, content in enumerate(prior):
        if content is not None:
            (backup / str(i)).write_bytes(content)
    gateway_pid = run('systemctl', 'show', 'web-proxy-gateway', '-p', 'MainPID', '--value')
    original_env = env('api')
    provider = 'cap' if mode == 'enable' else 'recaptcha' if mode in ['prepare', 'rollback'] else before['provider']
    services = ['web-proxy-api'] if mode != 'loader' else ['web-proxy-api', 'web-proxy-gateway']
    changed = False
    try:
        if mode == 'loader':
            require(before['dual'] == 'true', 'prepare dual verification first')
            if "const RELEASE = '1.0.12';" not in (release / 'web/sdk/v1/shifter-web-proxy.js').read_text():
                candidate = promote_loader(release)
                changed = True
                activate_link(candidate)
        else:
            sites = a['sites']
            require({s['origin'] for s in sites} == {e['origin'] for e in json.loads(original_env['INTEGRATIONS'])}, 'Cap origin set mismatch')
            require(len({s['siteKey'] for s in sites}) == len(sites) and all(s['secret'] for s in sites), 'invalid Cap sites')
            # Verify authenticated TLS transport before touching the service.
            for site in ([] if mode == 'rollback' else sites):
                code, body = request(a['verify_url'] + '/' + site['siteKey'] + '/siteverify',
                                     body={'secret': site['secret'], 'response': site['siteKey'] + ':invalid:' + uuid.uuid4().hex})
                require(rejected_by_verifier(code, body), 'verifier connectivity/rejection check failed')
            secret = Path('/etc/web-proxy/api/cap-sites.json')
            if secret.exists():
                require(json.loads(secret.read_text()) == sites, 'existing Cap credentials differ')
            else:
                atomic(secret, json.dumps(sites).encode(), 0o640, pwd.getpwnam('web-api').pw_gid)
            run('runuser', '-u', 'web-api', '--', 'test', '-r', str(secret))
            changed = True
            atomic(managed[0], render(provider, a['public_url'], a['verify_url']))
            managed[1].parent.mkdir(exist_ok=True)
            atomic(managed[1], b'[Service]\nEnvironmentFile=/etc/web-proxy/cap-transition.env\n', 0o644)
            run('systemctl', 'daemon-reload')
        run('systemctl', 'restart', *services)
        for attempt in range(20):
            try:
                result = check(node, provider, True)
                break
            except Exception:
                if attempt == 19:
                    raise
                time.sleep(2)
        after_env = env('api')
        for k, v in original_env.items():
            if k not in ['INVOCATION_ID', 'JOURNAL_STREAM', 'SYSTEMD_EXEC_PID'] and not k.startswith('CAP'):
                require(after_env.get(k) == v, 'unrelated API environment changed: ' + k)
        if mode != 'loader':
            require(run('systemctl', 'show', 'web-proxy-gateway', '-p', 'MainPID', '--value') == gateway_pid, 'gateway restarted unexpectedly')
        time.sleep(3)
        result = check(node, provider, True)
        if mode == 'loader':
            current = Path(result['release'])
            require(result['loader_version'] == '1.0.12', 'loader promotion missing')
            verify_served_sdk(node, current)
        return {**result, 'backup': str(backup), 'mode': mode}
    except Exception:
        if not changed:
            raise
        if mode == 'loader':
            activate_link(release)
        else:
            for p, content in zip(managed, prior):
                if content is None:
                    p.unlink(missing_ok=True)
                else:
                    atomic(p, content, 0o644 if p.suffix == '.conf' else 0o600)
            run('systemctl', 'daemon-reload')
        run('systemctl', 'restart', *services)
        time.sleep(3)
        check(node, before['provider'], before['dual'] == 'true')
        raise


if __name__ == '__main__':
    os.umask(0o077)
    try:
        print(json.dumps(main(json.load(sys.stdin))))
    except Exception as error:
        print(json.dumps({'error': type(error).__name__, 'detail': str(error) if isinstance(error, RuntimeError) else 'operation failed; inspect protected host logs'}))
        sys.exit(1)
