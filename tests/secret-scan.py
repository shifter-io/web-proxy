"""Check the project's deliverables and container logs without printing credentials."""
import json, os, pathlib, shlex, subprocess, sys, tarfile, tomllib
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
# Include the real local CAPTCHA secret without printing it or scanning its
# intended private storage as though that were a public deliverable.
captcha_env = pathlib.Path('.env.captcha')
if captcha_env.exists():
    captcha = {}
    for line in captcha_env.read_text().splitlines():
        key, sep, value = line.partition('=')
        if sep and not key.strip().startswith('#'):
            parts = shlex.split(value)
            captcha[key.strip()] = parts[0] if parts else ''
    if captcha.get('RECAPTCHA_SECRET_KEY'):
        secrets.append(captcha['RECAPTCHA_SECRET_KEY'].encode())
    if captcha.get('RECAPTCHA_SECRET_FILE'):
        stored = pathlib.Path(captcha['RECAPTCHA_SECRET_FILE']).read_bytes().strip()
        if stored: secrets.append(stored)
secrets = list(set(secrets))
failures = []; checked = 0
for folder in ['src', 'web', 'tests', 'scripts', 'deploy', 'docs', 'artifacts']:
    for path in pathlib.Path(folder).rglob('*'):
        if path.is_file() and path.suffix not in ['.png', '.jpg', '.pyc']:
            checked += 1
            if any(secret in path.read_bytes() for secret in secrets): failures.append(str(path))
for name in ['Dockerfile', 'compose.yaml', 'compose.test.yaml', 'Cargo.toml', 'package.json', 'README.md']:
    checked += 1
    if any(secret in pathlib.Path(name).read_bytes() for secret in secrets): failures.append(name)
def docker(args):
    return ['/bin/zsh','-c','exec "$@"','sh','docker',*args] if sys.platform == 'darwin' else ['docker',*args]

for args in [['compose','logs','--no-color','gateway-a','gateway-b','api','haproxy'],['history','--no-trunc','shifter-web:local'],['image','inspect','shifter-web:local']]:
    data = subprocess.check_output(docker(args),stderr=subprocess.DEVNULL)
    checked += 1
    if any(secret in data for secret in secrets): failures.append('container logs or image metadata/history')
ids = subprocess.check_output(docker(['compose','ps','-q']),stderr=subprocess.DEVNULL).decode().split()
if not ids: raise RuntimeError('Start the local demo before scanning its container metadata')
metadata = subprocess.check_output(docker(['inspect',*ids]),stderr=subprocess.DEVNULL)
checked += 1
if any(secret in metadata for secret in secrets): failures.append('running container metadata')
# Inspect the final image without mounting any live secrets or starting its app.
container = subprocess.check_output(docker(['create','shifter-web:local']),stderr=subprocess.DEVNULL).decode().strip()
try:
    process = subprocess.Popen(docker(['export',container]),stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    with tarfile.open(fileobj=process.stdout,mode='r|') as archive:
        for entry in archive:
            if not entry.isfile(): continue
            checked += 1
            stream = archive.extractfile(entry)
            overlap = b''
            while chunk := stream.read(1024*1024):
                data = overlap + chunk
                if any(secret in data for secret in secrets):
                    failures.append('image filesystem: ' + entry.name)
                    break
                overlap = data[-max(map(len,secrets)):]
    process.stdout.close()
    if process.wait(): raise RuntimeError('Image export failed')
finally:
    subprocess.run(docker(['rm',container]),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
result = {'passed':not failures,'checkedFilesAndStreams':checked,'failedLocations':failures,'scope':'Source, browser assets, evidence, application/HAProxy logs, image metadata/history and final image filesystem; exact upstream/CAPTCHA secret values never printed.'}
pathlib.Path('artifacts').mkdir(exist_ok=True)
pathlib.Path('artifacts/secret-scan.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result))
raise SystemExit(bool(failures))
