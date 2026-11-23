"""Real VPN packet tests in disposable docker36 containers; no production mounts."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

DOCKER = str(Path(os.environ['LOCALAPPDATA']) / 'Programs/docker/docker.exe')
IMAGE = 'oceanvoice/openvpn-server-test:20261123'
LABELS = ['--label', 'es.tempomar.dev.owner=claude-code', '--label', 'es.tempomar.dev.env=devalberto']
prefix = 'ovpn-test-' + uuid.uuid4().hex[:8]
network = prefix + '-net'
server = prefix + '-server'
names = [server] + [prefix + '-' + letter for letter in 'abc']
identities = ['teltonika-' + letter * 8 for letter in 'abc']
created = []


def docker(*args, timeout=120):
    result = subprocess.run([DOCKER, '--context', 'docker36', *args], capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'docker {args[0]} failed: {result.stderr[-2000:]} {result.stdout[-1000:]}')
    return (result.stdout + (result.stderr if args[0] == 'logs' else '')).strip()


def ready(check, seconds=45):
    start = time.monotonic()
    while time.monotonic() - start < seconds:
        try:
            if check():
                return
        except RuntimeError:
            pass
        time.sleep(1)
    raise RuntimeError('Timed out waiting for test VPN')


try:
    docker('network', 'create', *LABELS, network)
    docker('run', '-d', '--name', server, *LABELS, '--network', network, '--cap-add', 'NET_ADMIN',
           '--device', '/dev/net/tun:/dev/net/tun', '--sysctl', 'net.ipv4.ip_forward=1', IMAGE)
    created.append(server)
    ready(lambda: 'Initialization Sequence Completed' in docker('logs', server))
    print('Test VPN initialized with isolated policy.', flush=True)
    for identity in identities:
        docker('exec', '-e', 'EASYRSA_PKI=/var/lib/openvpn/pki', server, '/usr/share/easy-rsa/easyrsa', '--batch', 'build-client-full', identity, 'nopass')
    ready(lambda: len(json.loads(docker('exec', server, 'cat', '/var/lib/openvpn/vpn-addresses.json'))) == 3)
    addresses = json.loads(docker('exec', server, 'cat', '/var/lib/openvpn/vpn-addresses.json'))
    with tempfile.TemporaryDirectory(prefix='oceanvoice-vpn-smoke-') as temporary:
        generator = """from pathlib import Path
import sys
s=Path('/var/lib/openvpn'); name=sys.argv[1]; remote=sys.argv[2]
text='client\\ndev tun0\\nproto udp\\nremote '+remote+' 1194\\nnobind\\nremote-cert-tls server\\nverify-x509-name oceanvoice-server name\\ndata-ciphers AES-256-GCM:AES-128-GCM\\nverb 3\\n'
for tag, filename in [('ca','pki/ca.crt'),('cert','pki/issued/'+name+'.crt'),('key','pki/private/'+name+'.key'),('tls-crypt','tls-crypt.key')]:
 text+='<'+tag+'>\\n'+(s/filename).read_text()+'\\n</'+tag+'>\\n'
Path('/tmp/client.ovpn').write_text(text)
"""
        for name, identity in zip(names[1:], identities):
            docker('exec', server, 'python3', '-c', generator, identity, server)
            local = str(Path(temporary) / (identity + '.ovpn'))
            docker('cp', server + ':/tmp/client.ovpn', local)
            docker('create', '--name', name, *LABELS, '--network', network, '--cap-add', 'NET_ADMIN',
                   '--device', '/dev/net/tun:/dev/net/tun', '--entrypoint', 'openvpn', IMAGE, '--config', '/tmp/client.ovpn')
            created.append(name)
            docker('cp', local, name + ':/tmp/client.ovpn')
            docker('start', name)
            ready(lambda: 'Initialization Sequence Completed' in docker('logs', name))
    for name in names[1:]:
        docker('exec', '-d', name, 'python3', '-c',
               "import socket; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); s.bind(('0.0.0.0',9999)); s.listen();\nwhile True:\n c,a=s.accept(); c.sendall(b'ok'); c.close()")

    def probe(source, destination, allowed):
        code = "import socket,sys\ntry:\n s=socket.create_connection((sys.argv[1],9999),2); assert s.recv(2)==b'ok'; print('allowed')\nexcept OSError:\n print('blocked')"
        actual = docker('exec', source, 'python3', '-c', code, destination)
        assert actual == ('allowed' if allowed else 'blocked'), f'{source} -> {destination}: {actual}'

    def apply(mode, groups):
        revision = uuid.uuid4().hex
        policy = json.dumps({'mode': mode, 'groups': groups, 'revision': revision})
        docker('exec', server, 'python3', '-c',
               "from pathlib import Path; import sys; p=Path('/var/lib/openvpn/access-policy.json'); t=p.with_suffix('.tmp'); t.write_text(sys.argv[1]); t.replace(p)", policy)
        ready(lambda: json.loads(docker('exec', server, 'cat', '/var/lib/openvpn/access-applied.json')).get('revision') == revision)

    a, b, c = identities
    probe(names[1], addresses[b], False)
    apply('groups', [{'name': 'Test group', 'master': a, 'children': [b, c]}])
    probe(names[1], addresses[b], True)
    probe(names[2], addresses[a], True)
    probe(names[1], addresses[c], True)
    probe(names[3], addresses[b], False)
    probe(names[3], addresses[a], True)
    probe(names[2], addresses[c], False)
    print('Master A reaches B/C and receives replies; B/C cannot reach each other.', flush=True)
    apply('all', [])
    probe(names[1], addresses[c], True)
    probe(names[3], addresses[b], True)
    apply('isolated', [])
    probe(names[1], addresses[b], False)
    probe(names[3], addresses[b], False)
    docker('restart', names[1])
    ready(lambda: addresses[a] in docker('exec', names[1], 'ip', '-4', 'addr', 'show', 'tun0'))
    assert json.loads(docker('exec', server, 'cat', '/var/lib/openvpn/vpn-addresses.json')) == addresses
    docker('restart', server)
    ready(lambda: 'tun0' in docker('exec', server, 'ip', 'link', 'show', 'tun0'))
    assert json.loads(docker('exec', server, 'cat', '/var/lib/openvpn/vpn-addresses.json')) == addresses
    for name in names[1:]:
        docker('restart', name)
    for name, identity in zip(names[1:], identities):
        ready(lambda: addresses[identity] in docker('exec', name, 'ip', '-4', 'addr', 'show', 'tun0'))
    print('PASS: real OpenVPN clients, isolation, master/children groups, all-to-all, removal, and persistent IP reservations.', flush=True)
except Exception:
    for name in created:
        print(name, docker('logs', '--tail', '30', name), flush=True)
    raise
finally:
    for name in reversed(created):
        labels = json.loads(docker('inspect', name, '--format', '{{json .Config.Labels}}'))
        if labels.get('es.tempomar.dev.owner') == 'claude-code' and labels.get('es.tempomar.dev.env') == 'devalberto':
            docker('rm', '-f', name)
    labels = json.loads(docker('network', 'inspect', network, '--format', '{{json .Labels}}'))
    if labels.get('es.tempomar.dev.owner') == 'claude-code' and labels.get('es.tempomar.dev.env') == 'devalberto':
        docker('network', 'rm', network)
