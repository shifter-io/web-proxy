#!/usr/bin/env python3
"""Management-side phased Cap cutover; no secrets in argv, output or reports."""
import argparse
import concurrent.futures
import fcntl
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


def selected_nodes(inv, project, tag):
    require(inv['project_id'] == project and inv['deployment_tag'] == tag, 'scope mismatch')
    nodes = [n for n in inv['nodes'] if n['role'] == 'node']
    require(nodes and len({n['id'] for n in nodes}) == len(nodes), 'duplicate/missing nodes')
    for n in nodes:
        require(tag in n['tags'] and n['hostname'].startswith('web-node-'), 'unexpected target')
        ipaddress.IPv4Address(n['public_ip'])
        ipaddress.IPv4Address(n['private_ip'])
    return nodes


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for name in ['inventory', 'sites-file', 'identity', 'expected-project', 'expected-tag', 'commit', 'report', 'public-url', 'verify-url']:
        p.add_argument('--' + name, required=True)
    p.add_argument('--phase', choices=['audit', 'prepare', 'enable', 'rollback', 'loader'], required=True)
    p.add_argument('--host')
    p.add_argument('--region')
    p.add_argument('--workers', type=int, default=5)
    p.add_argument('--apply', action='store_true')
    a = p.parse_args()
    require(1 <= a.workers <= 5, 'workers must be 1..5')
    inv = json.loads(Path(a.inventory).read_text())
    nodes = selected_nodes(inv, a.expected_project, a.expected_tag)
    selected = [n for n in nodes if (not a.host or n['hostname'] == a.host) and (not a.region or n['region'] == a.region)]
    require(selected, 'empty selection')
    sites = json.loads(Path(a.sites_file).read_text())
    source = Path(__file__).with_name('cap-cutover-node.py').read_text()
    report_path = Path(a.report)
    require(not report_path.exists(), 'report exists')
    report = {'phase': a.phase, 'apply': a.apply, 'started': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'results': [], 'complete': False}
    lock = open('/run/lock/shifter-web-proxy-update.lock', 'a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    def save():
        temp = report_path.with_suffix('.tmp')
        temp.write_text(json.dumps(report, indent=2) + '\n')
        temp.replace(report_path)
    def invoke(n, mode):
        # Source code contains no credentials; protected input is sent over SSH stdin.
        command = shlex.join(['python3', '-c', source])
        args = ['ssh', '-i', a.identity, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2', 'root@' + n['public_ip'], command]
        payload = dict(node=n, mode=mode, apply=a.apply, commit=a.commit, sites=sites, public_url=a.public_url, verify_url=a.verify_url)
        r = subprocess.run(args, input=json.dumps(payload), text=True, capture_output=True, timeout=360)
        if r.returncode:
            detail = r.stdout.strip()[-1000:] if r.stdout.strip().startswith('{') else 'SSH operation failed; inspect target before retry'
            raise RuntimeError(n['hostname'] + ': ' + detail)
        return json.loads(r.stdout)
    def check_backends(region):
        hosts = [n for n in inv['nodes'] if n['role'] == 'haproxy' and n['region'] == region]
        require(len(hosts) == 1, 'ambiguous regional HAProxy')
        ssh = ['ssh', '-i', a.identity, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
               '-o', 'ConnectTimeout=10', 'root@' + hosts[0]['public_ip']]
        config = subprocess.check_output(ssh + ['cat /etc/haproxy/haproxy.cfg'], text=True, timeout=30)
        expected = {(n['hostname'], n['private_ip'] + ':' + str(port)) for n in nodes if n['region'] == region for port in [3000, 3001]}
        require(set(re.findall(r'^\s*server\s+(\S+)\s+(\S+)', config, re.M)) == expected, 'backend membership mismatch')
        match = re.search(r'^\s*stats socket (\S+)', config, re.M)
        require(match, 'stats socket missing')
        code = '''import socket,csv,io,json,sys
s=socket.socket(socket.AF_UNIX);s.settimeout(10);s.connect(sys.argv[1]);s.sendall(b"show stat\\n");s.shutdown(socket.SHUT_WR);b=b""
while True:
 c=s.recv(65536)
 if not c:break
 b+=c
rows=list(csv.DictReader(io.StringIO(b.decode().removeprefix("# "))))
print(json.dumps([r['status'] for r in rows if r['svname'].startswith('web-node-')]))
'''
        states = json.loads(subprocess.check_output(ssh + [shlex.join(['python3', '-c', code, match[1]])], text=True, timeout=30))
        require(len(states) == len(expected) and all(s == 'UP' for s in states), 'backends not all UP')
        return len(states)
    try:
        if a.phase in ['enable', 'loader'] and a.apply:
            with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
                for result in pool.map(lambda n: invoke(n, 'audit'), nodes):
                    require(result['dual'] == 'true', 'all APIs must accept both providers before advertising Cap or promoting SDK')
                    print('PREFLIGHT ' + result['hostname'] + ' dual=true', flush=True)
        for region in sorted({n['region'] for n in selected}, key=lambda r: (r != 'fra1', r)):
            targets = sorted([n for n in selected if n['region'] == region], key=lambda n:n['hostname'])
            failures = []
            with concurrent.futures.ThreadPoolExecutor(max_workers=a.workers) as pool:
                jobs = {pool.submit(invoke, n, a.phase if a.apply else 'audit'): n for n in targets}
                for job in concurrent.futures.as_completed(jobs):
                    n = jobs[job]
                    try:
                        r = job.result()
                        print('OK ' + n['hostname'] + ' phase=' + a.phase + ' provider=' + r['provider'] + ' dual=' + r['dual'], flush=True)
                    except Exception as error:
                        r = {'hostname': n['hostname'], 'error': str(error)}
                        failures.append(n['hostname'])
                        print('FAIL ' + n['hostname'] + ' ' + str(error), flush=True)
                    report['results'].append(r)
                    save()
            require(not failures, 'stopped after failed region ' + region)
            count = check_backends(region)
            report.setdefault('backends', {})[region] = count
            save()
            print('REGION_OK ' + region + ' backends_up=' + str(count), flush=True)
        report['complete'] = True
    except Exception as error:
        report['error'] = str(error)
        raise
    finally:
        save()
    print('COMPLETE ' + str(len(selected)) + ' phase=' + a.phase, flush=True)


if __name__ == '__main__':
    os.umask(0o077)
    main()
