#!/usr/bin/python3
"""Apply peer policies inside this container's network namespace only."""
import datetime
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

STATE = Path(os.environ.get('VPN_STATE', '/var/lib/openvpn'))
SUBNET = ipaddress.ip_network('10.80.0.0/24')


def atomic_json(name, value, mode=0o600):
    target = STATE / name
    temporary = target.with_suffix(target.suffix + '.tmp')
    temporary.write_text(json.dumps(value, indent=2))
    temporary.chmod(mode)
    temporary.replace(target)


def load(name, fallback):
    try:
        return json.loads((STATE / name).read_text())
    except FileNotFoundError:
        return fallback


def clients():
    """Keep only valid, panel-issued client certificates; never the server cert."""
    active = []
    for line in (STATE / 'pki/index.txt').read_text().splitlines():
        fields = line.split('\t')
        if len(fields) < 6 or fields[0] != 'V':
            continue
        match = re.fullmatch(r'/CN=(teltonika-[a-f0-9-]+)', fields[5])
        if not match:
            continue
        expiry = datetime.datetime.strptime(fields[1], '%y%m%d%H%M%SZ').replace(tzinfo=datetime.timezone.utc)
        if expiry > datetime.datetime.now(datetime.timezone.utc):
            active.append(match[1])
    return sorted(set(active))


def assign_addresses(active):
    assignments = load('vpn-addresses.json', {})
    used = set()
    for name, address in assignments.items():
        if not re.fullmatch(r'teltonika-[a-f0-9-]+', name):
            raise ValueError('Invalid assigned identity')
        ip = ipaddress.ip_address(address)
        if ip not in SUBNET or int(ip) - int(SUBNET.network_address) not in range(2, 255) or address in used:
            raise ValueError('Invalid or duplicate VPN address')
        used.add(address)
    # Preserve the IPs already allocated by the previous dynamic pool.
    pool = STATE / 'ipp.txt'
    old = {}
    if pool.exists():
        for line in pool.read_text().splitlines():
            fields = line.split(',')
            if len(fields) > 1:
                old[fields[0]] = fields[1]
    status = STATE / 'status.tsv'
    if status.exists():
        for line in status.read_text().splitlines():
            fields = line.split('\t')
            if len(fields) > 3 and fields[0] == 'CLIENT_LIST':
                old[fields[1]] = fields[3]
    candidates = [str(SUBNET.network_address + i) for i in range(2, 255)]
    # Reserve all known addresses first, so a new identity cannot take an old IP.
    for name in active:
        address = old.get(name)
        if name not in assignments and address in candidates and address not in used:
            assignments[name] = address
            used.add(address)
    for name in active:
        if name in assignments:
            continue
        address = next((ip for ip in candidates if ip not in used), None)
        if address is None:
            raise ValueError('VPN subnet has no free addresses')
        assignments[name] = address
        used.add(address)
    if load('vpn-addresses.json', None) != assignments:
        atomic_json('vpn-addresses.json', assignments, 0o644)
    directory = STATE / 'ccd'
    directory.mkdir(mode=0o711, exist_ok=True)
    directory.chmod(0o711)  # mkdir's mode is otherwise reduced by the process umask.
    for name in active:
        target = directory / name
        content = f'ifconfig-push {assignments[name]} 255.255.255.0\n'
        if not target.exists() or target.read_text() != content:
            temporary = directory / (name + '.tmp')
            temporary.write_text(content)
            temporary.chmod(0o644)
            temporary.replace(target)
    for target in directory.iterdir():
        if re.fullmatch(r'teltonika-[a-f0-9-]+', target.name) and target.name not in active:
            target.unlink()
    return {name: assignments[name] for name in active}


def rules(policy, addresses):
    mode = policy.get('mode')
    if mode not in ('isolated', 'all', 'groups') or not isinstance(policy.get('groups'), list):
        raise ValueError('Invalid access policy')
    allowed = set()
    if mode == 'all':
        allowed = {(a, b) for a in addresses.values() for b in addresses.values() if a != b}
    for group in policy['groups']:
        if not isinstance(group, dict) or not isinstance(group.get('children'), list) or not isinstance(group.get('master'), str):
            raise ValueError('Invalid access group')
        if mode == 'groups' and group['master'] in addresses:
            for child in group['children']:
                if child in addresses and child != group['master']:
                    a, b = addresses[group['master']], addresses[child]
                    allowed.update(((a, b), (b, a)))
    # No global established/related accept: removing a group also blocks its old flows.
    entries = ', '.join(f'{a} . {b}' for a, b in sorted(allowed))
    return '\n'.join([
        'add table inet oceanvoice_vpn',
        'flush table inet oceanvoice_vpn',
        'add set inet oceanvoice_vpn peers { type ipv4_addr . ipv4_addr; }',
        'flush set inet oceanvoice_vpn peers',
        *([f'add element inet oceanvoice_vpn peers {{ {entries} }}'] if entries else []),
        'add chain inet oceanvoice_vpn forward { type filter hook forward priority -10; policy accept; }',
        'add rule inet oceanvoice_vpn forward iifname "tun0" oifname "tun0" ip saddr . ip daddr @peers counter accept',
        'add rule inet oceanvoice_vpn forward iifname "tun0" counter drop',
        'add rule inet oceanvoice_vpn forward oifname "tun0" counter drop',
        '',
    ])


def reconcile(previous):
    policy = load('access-policy.json', {'mode': 'isolated', 'groups': [], 'revision': 'initial'})
    addresses = assign_addresses(clients())
    script = rules(policy, addresses)
    digest = hashlib.sha256(script.encode()).hexdigest()
    # Reapply if our own table was removed; never touch any other table or host namespace.
    exists = subprocess.run(['nft', 'list', 'table', 'inet', 'oceanvoice_vpn'], capture_output=True).returncode == 0
    if digest != previous or not exists:
        subprocess.run(['nft', '-f', '-'], input=script, text=True, capture_output=True, check=True)
    atomic_json('access-applied.json', {'revision': policy.get('revision'), 'mode': policy['mode'],
                'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'error': None})
    return digest


def learn_address(args):
    if args[0] == 'delete':
        return 0
    if len(args) < 3:
        return 1
    # Tie each source IP to the authenticated certificate, preventing IP spoofing.
    return 0 if load('vpn-addresses.json', {}).get(args[2]) == args[1] else 1


def supervise():
    child = None
    stopping = False

    def stop(signum, frame):
        nonlocal stopping
        stopping = True
        if child and child.poll() is None:
            child.send_signal(signal.SIGTERM)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        digest = reconcile(None)  # Firewall must be ready before OpenVPN starts.
        (STATE / 'status.tsv').write_text('')
        child = subprocess.Popen(['openvpn', '--config', '/etc/openvpn/server.conf'])
        while child.poll() is None and not stopping:
            time.sleep(2)
            if not stopping:
                digest = reconcile(digest)
        return child.wait(timeout=15)
    except Exception as error:
        atomic_json('access-applied.json', {'revision': None, 'error': type(error).__name__,
                    'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()})
        print('VPN policy failed; stopping VPN to prevent access with an outdated policy.', file=sys.stderr, flush=True)
        if child and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
        return 1


if __name__ == '__main__':
    os.umask(0o077)
    if len(sys.argv) > 1 and sys.argv[1] == 'learn':
        sys.exit(learn_address(sys.argv[2:]))
    sys.exit(supervise())
