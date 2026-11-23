#!/usr/bin/env python3
"""Deploy a native artifact without enabling Cap or rewriting node configuration."""
import argparse
import concurrent.futures
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import time


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def targets(data, project, tag):
    require(data['project_id'] == project and data['deployment_tag'] == tag, 'inventory scope mismatch')
    nodes = [n for n in data['nodes'] if n['role'] == 'node']
    require(nodes and len({n['id'] for n in nodes}) == len(nodes), 'missing/duplicate targets')
    for n in nodes:
        require(tag in n['tags'], 'target deployment tag mismatch')
        require(re.fullmatch(r'web-node-[a-z0-9]+-\d+', n['hostname']), 'invalid node hostname')
        ipaddress.IPv4Address(n['public_ip'])
        ipaddress.IPv4Address(n['private_ip'])
    return sorted(nodes, key=lambda n: (n['region'] != 'fra1', n['region'], n['hostname']))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for key in ['inventory', 'artifact', 'commit', 'identity', 'expected-project', 'expected-tag', 'report']:
        p.add_argument('--' + key, required=True)
    p.add_argument('--workers', type=int, default=8)
    p.add_argument('--apply', action='store_true')
    p.add_argument('--host')
    a = p.parse_args()
    require(1 <= a.workers <= 8, 'workers must be 1..8; one node per region at a time')
    require(re.fullmatch('[0-9a-f]{40}', a.commit), 'full commit required')
    data = json.loads(Path(a.inventory).read_text())
    nodes = targets(data, a.expected_project, a.expected_tag)
    artifact = Path(a.artifact).resolve()
    require(re.fullmatch(r'web-proxy-release-[0-9a-f]{40}\.tar\.gz', artifact.name), 'invalid artifact filename')
    sha = hashlib.sha256(artifact.read_bytes()).hexdigest()
    node_script = Path(__file__).with_name('native-release-node.py').read_text()
    selected = [n for n in nodes if not a.host or n['hostname'] == a.host]
    require(selected, 'no selected hosts')
    report = {'commit': a.commit, 'artifact_sha256': sha, 'apply': a.apply, 'targets': len(selected), 'preflight': [], 'results': []}
    report_path = Path(a.report)
    require(not report_path.exists(), 'report already exists; choose a new filename')
    def save():
        tmp = report_path.with_suffix('.tmp')
        tmp.write_text(json.dumps(report, indent=2) + '\n')
        tmp.replace(report_path)
    def ssh(n, command, stdin=None, timeout=180):
        args = ['ssh', '-i', a.identity, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2',
                'root@' + n['public_ip'], command]
        r = subprocess.run(args, input=stdin, capture_output=True, text=True, timeout=timeout)
        require(r.returncode == 0, n['hostname'] + ': remote operation failed rc=' + str(r.returncode) +
                (' ' + r.stdout.strip()[-1000:] if r.stdout.strip().startswith('{') else ''))
        return r.stdout
    def node_call(n, mode):
        command = shlex.join(['python3', '-', json.dumps(n), mode, a.commit, '/root/' + artifact.name, sha])
        return json.loads(ssh(n, command, node_script, 300))
    def ha_check(region):
        ha = [n for n in data['nodes'] if n['role'] == 'haproxy' and n['region'] == region]
        require(len(ha) == 1, 'ambiguous regional HAProxy')
        expected = {(n['hostname'], n['private_ip'] + ':' + str(port)) for n in nodes if n['region'] == region for port in [3000, 3001]}
        config = ssh(ha[0], 'cat /etc/haproxy/haproxy.cfg')
        actual = set(re.findall(r'^\s*server\s+(\S+)\s+(\S+)', config, re.M))
        require(actual == expected, 'HAProxy inventory mismatch: ' + region)
        socket_match = re.search(r'^\s*stats socket (\S+)', config, re.M)
        require(socket_match, 'HAProxy stats socket missing')
        script = '''import csv,io,json,socket,sys
s=socket.socket(socket.AF_UNIX);s.settimeout(10);s.connect(sys.argv[1]);s.sendall(b"show stat\\n");s.shutdown(socket.SHUT_WR)
b=b""
while True:
 c=s.recv(65536)
 if not c:break
 b+=c
rows=list(csv.DictReader(io.StringIO(b.decode().removeprefix("# "))))
print(json.dumps([{k:r[k] for k in ["pxname","svname","status"]} for r in rows if r["svname"].startswith("web-node-")]))
'''
        rows = json.loads(ssh(ha[0], shlex.join(['python3', '-c', script, socket_match[1]])))
        require(len(rows) == len(expected) and all(r['status'] == 'UP' for r in rows), 'HAProxy backends not all UP: ' + region)
        return {'region': region, 'backends_up': len(rows)}
    lock = open('/run/lock/shifter-web-proxy-update.lock', 'a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    save()
    with concurrent.futures.ThreadPoolExecutor(max_workers=a.workers) as pool:
        for result in pool.map(lambda n: node_call(n, 'audit'), selected):
            report['preflight'].append(result)
            print('PREFLIGHT ' + result['hostname'] + ' recaptcha active', flush=True)
    for region in sorted({n['region'] for n in selected}):
        print(json.dumps(ha_check(region)), flush=True)
    save()
    if not a.apply:
        print('DRY_RUN_OK targets=' + str(len(selected)), flush=True)
        return
    def deploy(n):
        dest = 'root@' + n['public_ip'] + ':/root/' + artifact.name
        cmd = ['scp', '-i', a.identity, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
               '-o', 'ConnectTimeout=10', str(artifact), dest]
        r = subprocess.run(cmd, capture_output=True, timeout=120)
        require(r.returncode == 0, n['hostname'] + ': artifact transfer failed')
        result = node_call(n, 'apply')
        result['haproxy'] = ha_check(n['region'])
        print('OK ' + n['hostname'] + ' ' + result['result'] + ' recaptcha active', flush=True)
        return result
    try:
        report['results'].append(deploy(selected[0]))
        save()
        remaining = selected[1:]
        while remaining:
            regions = set()
            wave = []
            for n in remaining:
                if n['region'] not in regions and len(wave) < a.workers:
                    regions.add(n['region'])
                    wave.append(n)
            failed = []
            with concurrent.futures.ThreadPoolExecutor(max_workers=a.workers) as pool:
                jobs = {pool.submit(deploy, n): n for n in wave}
                for job in concurrent.futures.as_completed(jobs):
                    n = jobs[job]
                    try:
                        report['results'].append(job.result())
                    except Exception as error:
                        failed.append(n['hostname'])
                        report['results'].append({'hostname': n['hostname'], 'error': str(error)})
                    save()
            require(not failed, 'stopped after failed wave: ' + ','.join(failed))
            remaining = [n for n in remaining if n not in wave]
        report['complete'] = True
    except Exception as error:
        report['complete'] = False
        report['error'] = str(error)
        raise
    finally:
        save()
    print('COMPLETE ' + str(len(selected)) + '/' + str(len(selected)) + ' Cap disabled report=' + str(report_path), flush=True)


if __name__ == '__main__':
    os.umask(0o077)
    main()
