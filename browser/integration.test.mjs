// Disposable test container only. Never mount production PKI or broker authentication.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, access, readdir, stat } from 'node:fs/promises';
import { randomBytes, createHash, createHmac } from 'node:crypto';
import { WebSocket } from 'ws';
const exec = promisify(execFile);
await mkdir('/run/browser-auth', { recursive: true });
const key = randomBytes(32); await writeFile('/run/browser-auth/key', key, { mode: 0o600 });
const host = Object.values(networkInterfaces()).flat().find(item => item.family === 'IPv4' && !item.internal).address;
await exec('ip', ['addr', 'add', '10.80.0.2/32', 'dev', 'lo']);
await exec('ip', ['addr', 'add', '10.80.0.3/32', 'dev', 'lo']);
let requests = 0;
const mock = createServer((request, response) => { requests++; response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><h1>TEST DEVICE</h1><input aria-label="Username"><button>Login</button>'); });
const other = createServer((request, response) => response.end('OTHER DEVICE'));
await new Promise(resolve => mock.listen(80, '10.80.0.2', resolve));
await new Promise(resolve => other.listen(80, '10.80.0.3', resolve));
function signed(method, path, body = '') {
  const timestamp = String(Date.now());
  return { 'X-OV-Time': timestamp, 'X-OV-Signature': createHmac('sha256', key)
    .update(`${timestamp}\n${method}\n${path}\n${createHash('sha256').update(body).digest('hex')}`).digest('hex') };
}
async function request(method, path, data) {
  const body = data ? JSON.stringify(data) : '';
  const response = await fetch(`http://${host}:8091${path}`, { method, headers: { ...signed(method, path, body), 'Content-Type': 'application/json' }, body: body || undefined });
  return { status: response.status, body: await response.json() };
}
const owner = 'a'.repeat(64); const stranger = 'b'.repeat(64);
const input = { owner, clientId: 'teltonika-aaaaaaaa', name: 'TEST DEVICE', ip: '10.80.0.2', protocol: 'http', port: 80 };
const ids = [];
try {
  assert.equal((await fetch(`http://${host}:8091/sessions`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await request('POST', '/sessions', { ...input, ip: '192.168.0.11' })).status, 400);
  const created = await request('POST', '/sessions', input);
  assert.equal(created.status, 200, JSON.stringify(created.body)); const session = created.body; ids.push(session.id);
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert(requests > 0, 'Chromium must load the target page');
  assert.equal((await request('GET', `/sessions/${session.id}?owner=${stranger}`)).status, 404);
  await new Promise((resolve, reject) => {
    const path = `/sessions/${session.id}/ws?owner=${owner}`;
    const ws = new WebSocket(`ws://${host}:8091${path}`, { headers: signed('GET', path) });
    ws.once('message', data => { try { assert(data.toString().startsWith('RFB ')); ws.close(); resolve(); } catch (error) { reject(error); } });
    ws.on('error', reject); setTimeout(() => reject(new Error('VNC greeting timed out')), 5000).unref();
  });
  const check = `const a=await fetch('http://10.80.0.2/',{signal:AbortSignal.timeout(2000)}); if(a.status!==200)process.exit(2); try{await fetch('http://10.80.0.3/',{signal:AbortSignal.timeout(1000)});process.exit(3)}catch{};console.log('filtered')`;
  const result = await exec(process.execPath, ['--input-type=module', '-e', check], { uid: 20000, gid: 20000 });
  assert.equal(result.stdout.trim(), 'filtered');
  const second = await request('POST', '/sessions', { ...input, owner: stranger });
  assert.equal(second.status, 200, JSON.stringify(second.body)); ids.push(second.body.id);
  assert.notEqual(second.body.id, session.id);
  const profiles = (await readdir('/tmp')).filter(name => name.startsWith('oceanvoice-session-'));
  assert.equal(profiles.length, 2);
  assert.equal((await stat(`/tmp/oceanvoice-session-${session.id}/profile`)).uid, 20000);
  assert.equal((await stat(`/tmp/oceanvoice-session-${second.body.id}/profile`)).uid, 20001);
  assert.equal((await request('POST', `/sessions/${session.id}/touch`, { owner })).status, 200);
  assert.equal((await request('POST', `/sessions/${session.id}/close`, { owner: stranger })).status, 404);
  assert.equal((await request('POST', `/sessions/${session.id}/close`, { owner })).status, 200);
  await assert.rejects(access(`/tmp/oceanvoice-session-${session.id}`));
  const again = await request('POST', '/sessions', input);
  assert.equal(again.status, 200, JSON.stringify(again.body)); ids.push(again.body.id);
  // Test the panel-to-broker HTTP and WebSocket bridge using real Chromium/VNC.
  process.env.BROWSER_AUTH_DIR = '/run/browser-auth'; process.env.REMOTE_BROWSER_URL = `http://${host}:8091`;
  const { createRemote } = await import('./panel-remote.mjs');
  let valid = true;
  const remote = createRemote({ list: async () => [{ id: input.clientId, name: 'TEST DEVICE', status: valid ? 'valid' : 'revoked' }] },
    { sample: async () => ({ available: true, clients: [{ id: input.clientId, tunnelIP: input.ip }] }) });
  const panel = createServer(async (request, response) => {
    try {
      let body = ''; for await (const chunk of request) body += chunk;
      const result = await remote.handle(new URL(request.url, 'http://panel').pathname, request.method, body ? JSON.parse(body) : null, request, response);
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result));
    } catch (error) { response.writeHead(error.status ?? 500); response.end(JSON.stringify({ error: error.message })); }
  });
  remote.attach(panel, true); await new Promise(resolve => panel.listen(8080, host, resolve));
  try {
    const started = await fetch(`http://${host}:8080/api/remote/start`, { method: 'POST', body: JSON.stringify({ clientId: input.clientId, protocol: 'http', port: 80 }) });
    assert.equal(started.status, 200); const bridge = await started.json();
    const cookie = started.headers.get('set-cookie').split(';')[0];
    assert(started.headers.get('set-cookie').includes('HttpOnly'));
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${host}:8080/remote-ws/${bridge.id}`, { headers: { Cookie: cookie, Origin: `http://${host}:8080` } });
      ws.once('message', data => { try { assert(data.toString().startsWith('RFB ')); ws.close(); resolve(); } catch (error) { reject(error); } });
      ws.on('error', reject); setTimeout(() => reject(new Error('Panel VNC forwarding timed out')), 5000).unref();
    });
    const foreign = await fetch(`http://${host}:8080/api/remote/${bridge.id}`, { headers: { Cookie: `ov_remote=${'0'.repeat(64)}` } });
    assert.equal(foreign.status, 404);
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${host}:8080/remote-ws/${bridge.id}`, { headers: { Cookie: cookie, Origin: 'http://foreign.invalid' } });
      ws.once('open', () => { ws.close(); reject(new Error('Foreign-origin WebSocket accepted')); });
      ws.once('unexpected-response', (request, response) => { assert.equal(response.statusCode, 403); response.resume(); ws.terminate(); resolve(); });
      ws.on('error', () => {}); setTimeout(() => reject(new Error('Origin validation timed out')), 3000).unref();
    });
    valid = false;
    const revoked = await fetch(`http://${host}:8080/api/remote/${bridge.id}`, { headers: { Cookie: cookie } });
    assert.equal(revoked.status, 404);
    await assert.rejects(access(`/tmp/oceanvoice-session-${bridge.id}`));
  } finally { panel.closeAllConnections(); panel.close(); }
  console.log('PASS: sandboxed Chromium page load, authenticated broker, owner isolation, VNC WebSocket, network filtering, profile separation and cleanup/reuse.');
} finally {
  for (const id of ids) { await request('POST', `/sessions/${id}/close`, { owner }); await request('POST', `/sessions/${id}/close`, { owner: stranger }); }
  mock.close(); other.close();
}
