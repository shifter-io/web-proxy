#!/usr/bin/env python3
"""Node-side native release installer. Preserve configuration; keep Cap disabled."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def run(*args):
    return subprocess.check_output(args, stderr=subprocess.PIPE, timeout=90).decode().strip()


def get_json(url, origin=None):
    req = urllib.request.Request(url, headers={'Origin': origin} if origin else {})
    with urllib.request.urlopen(req, timeout=8) as response:
        return json.load(response)


def env_for(role):
    pid = run('systemctl', 'show', 'web-proxy-' + role, '-p', 'MainPID', '--value')
    require(pid != '0', 'service has no running PID: ' + role)
    return dict(x.decode().split('=', 1) for x in Path('/proc/' + pid + '/environ').read_bytes().split(b'\0') if b'=' in x)


def config_hashes():
    roots = [Path('/etc/web-proxy')]
    roots += list(Path('/etc/systemd/system').glob('web-proxy-*.service*'))
    return {str(p): digest(p) for root in roots for p in ([root] if root.is_file() else root.rglob('*')) if p.is_file()}


def check(node, expected=None, baseline=None):
    require(run('hostname') == node['hostname'], 'hostname mismatch')
    identity = run('curl', '-fsS', '--max-time', '5', 'http://169.254.169.254/metadata/v1/id')
    require(identity == str(node['id']), 'Droplet ID mismatch')
    release = Path('/opt/web-proxy/current').resolve(strict=True)
    if expected:
        require('commit=' + expected in (release / 'BUILD.txt').read_text().splitlines(), 'release commit mismatch')
        subprocess.run(['sha256sum', '-c', 'SHA256SUMS'], cwd=release, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=30)
    providers = []
    for role, port in [('api', 3000), ('gateway', 3001)]:
        require(run('systemctl', 'is-active', 'web-proxy-' + role) == 'active', 'service not active: ' + role)
        env = env_for(role)
        if expected:
            pid = run('systemctl', 'show', 'web-proxy-' + role, '-p', 'MainPID', '--value')
            require(digest('/proc/' + pid + '/exe') == digest(release / 'shifter-web'), 'running binary mismatch')
        require(env.get('APP_ENV') == 'production', 'not production: ' + role)
        require(env.get('CAPTCHA_PROVIDER', 'recaptcha') == 'recaptcha', 'Cap must remain disabled')
        require(env.get('CAPTCHA_ACCEPT_BOTH', 'false') == 'false', 'dual verification must remain disabled')
        require(not any(k.startswith('CAP_') for k in env), 'unexpected Cap configuration')
        require(env.get('LISTEN') == node['private_ip'] + ':' + str(port), 'listen address mismatch')
        base = 'http://' + node['private_ip'] + ':' + str(port)
        require(get_json(base + '/health').get('ok') is True, 'health failed: ' + role)
        if role == 'api':
            for integration in json.loads(env['INTEGRATIONS']):
                origin = integration['origin'].replace('https://*.', 'https://rollout-check.')
                for query in ['', '?captcha=cap']:
                    result = get_json(base + '/api/v1/config' + query, origin)
                    require(result.get('captchaProvider', 'recaptcha') == 'recaptcha', 'API advertises Cap')
                    require(result.get('captchaSiteKey') == env['RECAPTCHA_SITE_KEY'], 'reCAPTCHA site key changed')
                    require(not result.get('capEndpoint'), 'API exposes Cap endpoint')
                    require(result.get('site') == integration['site'], 'integration changed')
            providers.append('recaptcha')
        if expected:
            for name in ['manifest.json', 'client.js', 'captcha.js']:
                path = 'web/sdk/releases/1.0.12/' + name
                with urllib.request.urlopen(base + '/sdk/releases/1.0.12/' + name, timeout=8) as response:
                    require(hashlib.sha256(response.read()).hexdigest() == digest(release / path), 'served asset mismatch: ' + role + '/' + name)
    hashes = config_hashes()
    if baseline:
        require(hashes == baseline['config_hashes'], 'configuration changed during deployment')
    return {'hostname': node['hostname'], 'release': str(release), 'config_hashes': hashes,
            'provider': 'recaptcha', 'services': 'active', 'loader_sha256': digest(release / 'web/sdk/v1/shifter-web-proxy.js')}


def validate_archive(path, commit):
    with tarfile.open(path) as archive:
        files = {}
        for member in archive:
            name = member.name.removeprefix('./')
            require(not Path(name).is_absolute() and '..' not in Path(name).parts, 'unsafe archive path')
            require(member.isfile() or member.isdir(), 'archive links/devices forbidden')
            if member.isfile():
                require(name not in files, 'duplicate archive entry')
                files[name] = archive.extractfile(member).read()
        require('commit=' + commit in files['BUILD.txt'].decode().splitlines(), 'artifact commit mismatch')
        covered = set()
        for line in files['SHA256SUMS'].decode().splitlines():
            sha, name = line.split(None, 1)
            name = name.removeprefix('*').removeprefix('./')
            require(name in files and hashlib.sha256(files[name]).hexdigest() == sha, 'artifact checksum mismatch')
            covered.add(name)
        require(set(files) - {'SHA256SUMS'} <= covered, 'unhashed artifact files')
        binary = files['shifter-web']
        require(binary[:6] == b'\x7fELF\x02\x01' and binary[18:20] == b'\x3e\x00', 'not Linux amd64')


def switch(release):
    link = Path('/opt/web-proxy/current.next')
    require(not link.exists() and not link.is_symlink(), 'pending release symlink exists')
    link.symlink_to(release)
    link.replace('/opt/web-proxy/current')


def release_permissions(release):
    # The archive's '.' entry can restore a root-only temporary directory mode.
    release.chmod(0o755)
    for path in release.rglob('*'):
        path.chmod(0o755 if path.is_dir() or path.name == 'shifter-web' else 0o644)


def main(args):
    node, mode, commit, artifact, sha = args
    node = json.loads(node)
    before = check(node)
    if mode == 'audit':
        print(json.dumps(before))
        return
    require(mode == 'apply', 'invalid mode')
    require(digest(artifact) == sha, 'uploaded artifact mismatch')
    validate_archive(artifact, commit)
    previous = Path(before['release'])
    release = Path('/opt/web-proxy/releases') / (commit[:12] + '-' + sha[:12])
    if release == previous:
        result = check(node, commit)
        print(json.dumps({**result, 'result': 'already_current'}))
        return
    require(not release.exists(), 'candidate directory already exists; inspect before retry')
    require(shutil.disk_usage(previous).free > 512 * 1024 * 1024, 'insufficient free disk')
    release.mkdir(mode=0o755)
    with tarfile.open(artifact) as archive:
        archive.extractall(release, filter='data')
    release_permissions(release)
    for role in ['api', 'gateway']:
        run('runuser', '-u', 'web-' + role, '--', 'test', '-x', str(release))
        run('runuser', '-u', 'web-' + role, '--', 'test', '-x', str(release / 'shifter-web'))
        run('runuser', '-u', 'web-' + role, '--', 'test', '-r', str(release / 'web/sdk/v1/shifter-web-proxy.js'))
    require(digest(release / 'web/sdk/v1/shifter-web-proxy.js') == before['loader_sha256'], 'stable loader promotion is not authorized')
    for old in (previous / 'web/sdk/releases').rglob('*'):
        if old.is_file():
            new = release / old.relative_to(previous)
            require(new.is_file() and digest(old) == digest(new), 'immutable SDK release changed or missing')
    backup = Path('/root/shifter-web-backups') / ('native-' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()))
    backup.mkdir(parents=True, mode=0o700)
    (backup / 'previous-release').write_text(str(previous) + '\n')
    (backup / 'preflight.json').write_text(json.dumps(before, indent=2))
    switched = False
    try:
        switch(release)
        switched = True
        run('systemctl', 'restart', 'web-proxy-api', 'web-proxy-gateway')
        for attempt in range(20):
            try:
                result = check(node, commit, before)
                break
            except Exception:
                if attempt == 19:
                    raise
                time.sleep(2)
        time.sleep(10)
        result = check(node, commit, before)
        print(json.dumps({**result, 'result': 'updated', 'backup': str(backup)}))
    except Exception as error:
        if switched:
            switch(previous)
            run('systemctl', 'restart', 'web-proxy-api', 'web-proxy-gateway')
            for attempt in range(20):
                try:
                    check(node, baseline=before)
                    break
                except Exception:
                    if attempt == 19:
                        raise RuntimeError('deployment failed; rollback health also failed') from None
                    time.sleep(2)
            raise RuntimeError('deployment failed; previous release restored and healthy: ' + type(error).__name__) from None
        raise


if __name__ == '__main__':
    os.umask(0o077)
    try:
        main(sys.argv[1:])
    except Exception as error:
        # Never print subprocess output or environment values, which can contain secrets.
        print(json.dumps({'error_type': type(error).__name__, 'error': str(error) if isinstance(error, RuntimeError) else 'node operation failed'}))
        sys.exit(1)
