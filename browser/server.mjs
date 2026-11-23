import { createServer } from 'node:http';
import { createHmac, createHash, timingSafeEqual, randomBytes, randomUUID } from 'node:crypto';
import { readFile, mkdir, chmod, chown, writeFile, rm } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { networkInterfaces } from 'node:os';
import { connect } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';

const exec = promisify(execFile);
process.umask(0o077);
const authFile = process.env.BROWSER_AUTH_FILE ?? '/run/browser-auth/key';
const sessions = new Map();
const maxSessions = Math.min(8, Math.max(1, Number(process.env.BROWSER_MAX_SESSIONS) || 4));
const idleMs = 10 * 60 * 1000;
const lifetimeMs = 60 * 60 * 1000;
const fail = (status, message) => Object.assign(new Error(message), { status });
let mutation = Promise.resolve();
function serialize(action) { const result = mutation.then(action); mutation = result.catch(() => {}); return result; }
const digest = text => createHash('sha256').update(text).digest('hex');
async function authenticate(request, body = '') {
  const timestamp = request.headers['x-ov-time'];
  const signature = request.headers['x-ov-signature'];
  if (!/^\d+$/.test(timestamp ?? '') || Math.abs(Date.now() - Number(timestamp)) > 30000 || !/^[a-f0-9]{64}$/.test(signature ?? '')) throw fail(401, 'Invalid broker authentication');
  const key = await readFile(authFile);
  const expected = createHmac('sha256', key).update(`${timestamp}\n${request.method}\n${request.url}\n${digest(body)}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw fail(401, 'Invalid broker authentication');
}
function owned(id, owner) {
  const session = sessions.get(id);
  if (!session || session.owner !== owner) throw fail(404, 'La sesión no existe o ha caducado.');
  return session;
}
function metadata(session) {
  return { id: session.id, clientId: session.clientId, name: session.name, ip: session.ip, protocol: session.protocol,
    port: session.port, vncPassword: session.password, expiresAt: new Date(session.created + lifetimeMs).toISOString(), idleMinutes: 10 };
}
async function firewall() {
  const lines = ['add table inet oceanvoice_browser', 'flush table inet oceanvoice_browser',
    'add chain inet oceanvoice_browser output { type filter hook output priority -20; policy accept; }'];
  for (const session of sessions.values()) {
    const ports = [...new Set([80, 443, session.port])].join(', ');
    lines.push(`add rule inet oceanvoice_browser output meta skuid ${session.uid} ip daddr ${session.ip} tcp dport { ${ports} } accept`);
    // x11vnc replies only to the controller's localhost connection.
    lines.push(`add rule inet oceanvoice_browser output meta skuid ${session.uid} ip daddr 127.0.0.1 tcp sport ${session.rfbPort} accept`);
  }
  lines.push('add rule inet oceanvoice_browser output meta skuid 20000-20007 counter drop', '');
  await new Promise((resolve, reject) => {
    const child = spawn('nft', ['-f', '-'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let error = ''; child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Remote browser firewall failed: ${error}`)));
    child.stdin.end(lines.join('\n'));
  });
}
function startChild(session, command, args) {
  const env = { PATH: process.env.PATH, LANG: 'en_US.UTF-8', HOME: session.directory, USER: `browser${session.slot}`,
    DISPLAY: `:${session.display}`, XAUTHORITY: `${session.directory}/.Xauthority` };
  const child = spawn(command, args, { uid: session.uid, gid: 20000, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', error => { session.error = error.message; });
  child.stdout.on('data', () => {});
  child.stderr.on('data', chunk => { session.logs = (session.logs + chunk.toString()).slice(-3000); });
  session.processes.push(child);
  return child;
}
async function waitFor(check, session) {
  for (let i = 0; i < 100; i++) {
    if (session.error || session.processes.some(child => child.exitCode !== null || child.signalCode !== null)) throw new Error(`Remote browser startup failed: ${session.logs}`);
    try { if (await check()) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Remote browser startup timed out: ${session.logs}`);
}
async function tcpReady(port) {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(200); socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false)); socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}
async function destroy(id) {
  const session = sessions.get(id); if (!session) return;
  sessions.delete(id);
  for (const socket of session.sockets) socket.close(1000, 'Session closed');
  for (const child of session.processes) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  // Chromium crash handlers can detach into their own process groups.
  await exec('pkill', ['-KILL', '-u', String(session.uid)]).catch(error => { if (error.code !== 1) throw error; });
  await Promise.all(session.processes.filter(child => child.exitCode === null && child.pid).map(child => new Promise(resolve => {
    child.once('exit', resolve); setTimeout(resolve, 2000).unref();
  })));
  await rm(`/tmp/.X${session.display}-lock`, { force: true });
  await rm(`/tmp/.X11-unix/X${session.display}`, { force: true });
  await rm(session.directory, { recursive: true, force: true });
  await firewall();
}
async function create(input) {
  if (!/^[a-f0-9]{64}$/.test(input.owner ?? '') || !/^teltonika-[a-f0-9-]+$/.test(input.clientId ?? '') ||
      !/^10\.80\.0\.(?:[2-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-4])$/.test(input.ip ?? '') ||
      !['http', 'https'].includes(input.protocol) || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw fail(400, 'Destino de gestión inválido.');
  if (sessions.size >= maxSessions) throw fail(429, 'Se ha alcanzado el límite de sesiones. Cierra una sesión e inténtalo de nuevo.');
  const used = new Set([...sessions.values()].map(session => session.slot));
  const slot = [...Array(8).keys()].find(value => !used.has(value));
  const session = { ...input, id: randomUUID(), slot, uid: 20000 + slot, display: 100 + slot, rfbPort: 5900 + slot,
    password: randomBytes(6).toString('base64'), created: Date.now(), lastUsed: Date.now(), processes: [], sockets: new Set(), logs: '' };
  session.directory = `/tmp/oceanvoice-session-${session.id}`;
  await mkdir(session.directory, { mode: 0o700 }); await chown(session.directory, session.uid, 20000);
  sessions.set(session.id, session);
  try {
    await firewall();
    const authority = `${session.directory}/.Xauthority`;
    await writeFile(authority, '', { mode: 0o600 }); await chown(authority, session.uid, 20000);
    await exec('xauth', ['-f', authority, 'add', `:${session.display}`, '.', randomBytes(16).toString('hex')], { uid: session.uid, gid: 20000 });
    startChild(session, 'Xvfb', [`:${session.display}`, '-screen', '0', '1366x768x24', '-nolisten', 'tcp', '-auth', authority]);
    await waitFor(() => readFile(`/tmp/.X${session.display}-lock`).then(() => true), session);
    await exec('x11vnc', ['-storepasswd', session.password, `${session.directory}/vnc.pass`], { uid: session.uid, gid: 20000 });
    startChild(session, 'x11vnc', ['-display', `:${session.display}`, '-auth', authority, '-rfbauth', `${session.directory}/vnc.pass`,
      '-rfbport', String(session.rfbPort), '-listen', '127.0.0.1', '-forever', '-shared', '-noxdamage', '-quiet']);
    await waitFor(() => tcpReady(session.rfbPort), session);
    const browser = startChild(session, '/usr/bin/chromium', [`--user-data-dir=${session.directory}/profile`, '--no-first-run',
      '--no-default-browser-check', '--disable-dev-shm-usage', '--disable-background-networking', '--disable-extensions', '--disable-sync',
      '--password-store=basic', '--window-size=1366,768', '--window-position=0,0', `${session.protocol}://${session.ip}:${session.port}/`]);
    await new Promise(resolve => setTimeout(resolve, 1500));
    if (browser.exitCode !== null || browser.signalCode !== null) throw new Error(`Chromium startup failed: ${session.logs}`);
    return metadata(session);
  } catch (error) { await destroy(session.id); throw error; }
}
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  try {
    let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 8192) throw fail(413, 'Request too large'); }
    await authenticate(request, body);
    const url = new URL(request.url, 'http://broker');
    const input = body ? JSON.parse(body) : {};
    let result;
    if (request.method === 'POST' && url.pathname === '/sessions') result = await serialize(() => create(input));
    else {
      const match = /^\/sessions\/([a-f0-9-]+)(\/touch|\/close)?$/.exec(url.pathname);
      if (!match) throw fail(404, 'Session not found');
      const session = owned(match[1], input.owner ?? url.searchParams.get('owner'));
      if (request.method === 'GET' && !match[2]) result = metadata(session);
      else if (request.method === 'POST' && match[2] === '/touch') { session.lastUsed = Date.now(); result = { ok: true }; }
      else if (request.method === 'POST' && match[2] === '/close') { await serialize(() => destroy(session.id)); result = { ok: true }; }
      else throw fail(405, 'Method not allowed');
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result));
  } catch (error) {
    console.error('Remote browser request:', error.status ?? error.message);
    response.writeHead(error.status ?? 503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: error.status ? error.message : 'No se pudo iniciar el navegador remoto. Revisa los logs del servicio browser.' }));
  }
});
const wsServer = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
server.on('upgrade', async (request, socket, head) => {
  try {
    await authenticate(request);
    const url = new URL(request.url, 'http://broker'); const match = /^\/sessions\/([a-f0-9-]+)\/ws$/.exec(url.pathname);
    if (!match) throw fail(404, 'Unknown session'); const session = owned(match[1], url.searchParams.get('owner'));
    wsServer.handleUpgrade(request, socket, head, ws => {
      const tcp = connect(session.rfbPort, '127.0.0.1'); session.sockets.add(ws);
      ws.on('message', data => tcp.write(data));
      tcp.on('data', data => {
        if (ws.bufferedAmount > 8 * 1024 * 1024) { ws.close(); tcp.destroy(); }
        else if (ws.readyState === WebSocket.OPEN) ws.send(data);
      });
      ws.on('close', () => { tcp.destroy(); session.sockets.delete(ws); });
      ws.on('error', () => tcp.destroy()); tcp.on('error', () => ws.close()); tcp.on('close', () => ws.close());
    });
  } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
});
setInterval(() => serialize(async () => {
  for (const session of sessions.values()) if (Date.now() - session.lastUsed > idleMs || Date.now() - session.created > lifetimeMs || session.processes.some(child => child.exitCode !== null || child.signalCode !== null)) await destroy(session.id);
}).catch(error => console.error('Session cleanup:', error.message)), 15000).unref();
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => serialize(async () => {
  for (const id of [...sessions.keys()]) await destroy(id); server.close(); process.exit(0);
}));
const bindIP = process.env.BROWSER_BIND_IP ?? Object.values(networkInterfaces()).flat().find(item => item.family === 'IPv4' && !item.internal && !item.address.startsWith('10.80.'))?.address;
if (!bindIP) throw new Error('No private broker interface found');
await firewall();
server.listen(8091, bindIP, () => console.log(`Remote browser broker ready on ${bindIP}:8091`));
