"""Check this prototype's deliverables and container logs without printing credentials."""
import json, os, pathlib, shlex, subprocess, sys, tomllib
root = pathlib.Path(__file__).resolve().parents[1]
os.chdir(root)
env = {}
for line in pathlib.Path('.env').read_text().splitlines():
    if line.strip() and not line.startswith('#') and '=' in line:
        key, value = line.split('=', 1)
        env[key] = shlex.split(value)[0]
with open(env['SHIFTER_CREDENTIALS_FILE'], 'rb') as handle:
    account = tomllib.load(handle)['shifter']
secrets = [account['account'].encode(), account['password'].encode()]
failures = []; checked = 0
for folder in ['src', 'web', 'tests', 'scripts', 'deploy', 'docs', 'artifacts']:
    for path in pathlib.Path(folder).rglob('*'):
        if path.is_file() and path.suffix not in ['.png', '.jpg', '.pyc']:
            checked += 1
            if any(secret in path.read_bytes() for secret in secrets): failures.append(str(path))
for name in ['Dockerfile', 'compose.yaml', 'compose.test.yaml', 'Cargo.toml', 'package.json']:
    checked += 1
    if any(secret in pathlib.Path(name).read_bytes() for secret in secrets): failures.append(name)
for args in [['compose','logs','--no-color','gateway-a','gateway-b','api','haproxy'],['history','--no-trunc','shifter-web:local']]:
    command = ['/bin/zsh','-c','exec "$@"','sh','docker',*args] if sys.platform == 'darwin' else ['docker',*args]
    data = subprocess.check_output(command,stderr=subprocess.DEVNULL)
    checked += 1
    if any(secret in data for secret in secrets): failures.append('container logs or image history')
result = {'passed':not failures,'checkedFilesAndStreams':checked,'failedLocations':failures,'scope':'Source, generated browser assets, test evidence, application and HAProxy logs, image history; exact account/password values never printed.'}
pathlib.Path('artifacts').mkdir(exist_ok=True)
pathlib.Path('artifacts/secret-scan.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result))
raise SystemExit(bool(failures))
