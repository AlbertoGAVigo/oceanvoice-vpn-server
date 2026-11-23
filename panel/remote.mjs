import { randomBytes, createHash, createHmac } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { WebSocketServer, WebSocket } from 'ws';
import { failure } from './pki.mjs';

const authDirectory = process.env.BROWSER_AUTH_DIR ?? '/var/lib/oceanvoice-browser-auth';
const brokerURL = process.env.REMOTE_BROWSER_URL ?? 'http://openvpn:8091';
let keyPromise;
async function key() {
  if (!keyPromise) keyPromise = (async () => {
    await mkdir(authDirectory, { recursive: true, mode: 0o700 });
    try {
      const file = await open(`${authDirectory}/key`, 'wx', 0o600);
      try { await file.writeFile(randomBytes(32)); } finally { await file.close(); }
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const value = await readFile(`${authDirectory}/key`);
    if (value.length !== 32) throw new Error('Invalid remote browser key');
    return value;
  })().catch(error => { keyPromise = undefined; throw error; });
  return keyPromise;
}
async function signed(method, path, body = '') {
  const timestamp = String(Date.now());
  return { 'X-OV-Time': timestamp, 'X-OV-Signature': createHmac('sha256', await key())
    .update(`${timestamp}\n${method}\n${path}\n${createHash('sha256').update(body).digest('hex')}`).digest('hex') };
}
async function broker(method, path, data) {
  const body = data ? JSON.stringify(data) : '';
  let response;
  try { response = await fetch(new URL(path, brokerURL), { method, headers: { ...await signed(method, path, body), 'Content-Type': 'application/json' },
    body: body || undefined, signal: AbortSignal.timeout(25000) }); }
  catch { throw failure(503, 'El navegador remoto no está disponible. Reintenta en unos segundos.'); }
  const result = await response.json();
  if (!response.ok) throw failure(response.status, result.error ?? 'No se pudo abrir la sesión remota.');
  return result;
}
function owner(request, response) {
  let cookie = /(?:^|;\s*)ov_remote=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie ?? '')?.[1];
  if (!cookie) {
    if (!response) throw failure(401, 'Autenticación de sesión requerida.');
    cookie = randomBytes(32).toString('hex');
  }
  if (response) response.setHeader('Set-Cookie', `ov_remote=${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600${request.socket.encrypted ? '; Secure' : ''}`);
  return createHash('sha256').update(`${process.env.PANEL_USERNAME ?? ''}:${cookie}`).digest('hex');
}
function publicSession(result) {
  return { id: result.id, clientId: result.clientId, name: result.name, ip: result.ip, protocol: result.protocol,
    port: result.port, vncPassword: result.vncPassword, expiresAt: result.expiresAt, idleMinutes: result.idleMinutes };
}
export function createRemote(pki, connections) {
  async function authorizeTarget(clientId) {
    const client = (await pki.list()).find(row => row.id === clientId && row.status === 'valid');
    if (!client) throw failure(404, 'Cliente no encontrado o certificado no vigente.');
    const snapshot = await connections.sample();
    const live = snapshot.available && snapshot.clients.find(row => row.id === clientId);
    if (!live?.tunnelIP) throw failure(409, 'El cliente no está conectado a la VPN.');
    return { client, ip: live.tunnelIP };
  }
  return {
    async handle(route, method, input, request, response) {
      const identity = owner(request, response);
      if (route === '/api/remote/start' && method === 'POST') {
        const { client, ip } = await authorizeTarget(input?.clientId);
        const protocol = input.protocol ?? 'https'; const port = Number(input.port ?? (protocol === 'http' ? 80 : 443));
        if (!['http', 'https'].includes(protocol) || !Number.isInteger(port) || port < 1 || port > 65535) throw failure(400, 'Protocolo o puerto de gestión inválidos.');
        return publicSession(await broker('POST', '/sessions', { owner: identity, clientId: client.id, name: client.name, ip, protocol, port }));
      }
      const match = /^\/api\/remote\/([a-f0-9-]+)(\/touch|\/close)?$/.exec(route);
      if (!match) throw failure(404, 'Sesión no encontrada.');
      if (method === 'POST' && match[2] === '/close') return broker('POST', `/sessions/${match[1]}/close`, { owner: identity });
      const session = await broker('GET', `/sessions/${match[1]}?owner=${identity}`);
      try { await authorizeTarget(session.clientId); }
      catch (error) { await broker('POST', `/sessions/${match[1]}/close`, { owner: identity }); throw error; }
      if (method === 'GET' && !match[2]) return publicSession(session);
      if (method === 'POST' && match[2] === '/touch') return broker('POST', `/sessions/${match[1]}/touch`, { owner: identity });
      throw failure(405, 'Método no permitido.');
    },
    attach(server, enabled) {
      const wsServer = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
      const active = new Map();
      let checking = false;
      setInterval(async () => {
        if (!active.size || checking) return;
        checking = true;
        try {
          const clients = await pki.list(); const snapshot = await connections.sample();
          const valid = new Set(clients.filter(client => client.status === 'valid').map(client => client.id));
          const connected = new Set(snapshot.available ? snapshot.clients.map(client => client.id) : []);
          for (const [ws, record] of active) {
            if (!valid.has(record.session.clientId) || !connected.has(record.session.clientId)) {
              await broker('POST', `/sessions/${record.session.id}/close`, { owner: record.identity }).catch(() => {});
              ws.close(); record.upstream.close();
            }
          }
        } catch (error) { if (error.status !== 409) console.error('Remote session validation:', error.code ?? error.status ?? 'internal'); }
        finally { checking = false; }
      }, 10000).unref();
      server.on('upgrade', async (request, socket, head) => {
        let upstream;
        try {
          if (!enabled) throw new Error('Panel disabled');
          const origin = new URL(request.headers.origin ?? '');
          if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== request.headers.host) throw new Error('Invalid origin');
          const route = new URL(request.url, 'http://panel').pathname;
          const match = /^\/remote-ws\/([a-f0-9-]+)$/.exec(route);
          if (!match) throw new Error('Invalid session');
          const identity = owner(request);
          const session = await broker('GET', `/sessions/${match[1]}?owner=${identity}`);
          await authorizeTarget(session.clientId);
          const path = `/sessions/${match[1]}/ws?owner=${identity}`;
          const url = new URL(path, brokerURL); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
          upstream = new WebSocket(url, { headers: await signed('GET', path), maxPayload: 8 * 1024 * 1024, handshakeTimeout: 5000 });
          upstream.on('error', () => socket.destroy());
          // Buffer the VNC greeting until the browser-side handshake has completed.
          const pending = []; const buffer = data => pending.push(data); upstream.on('message', buffer);
          upstream.once('open', () => wsServer.handleUpgrade(request, socket, head, ws => {
            upstream.off('message', buffer);
            for (const data of pending) ws.send(data);
            upstream.on('message', data => {
              if (ws.bufferedAmount > 8 * 1024 * 1024) { ws.close(); upstream.close(); }
              else if (ws.readyState === WebSocket.OPEN) ws.send(data);
            });
            ws.on('message', data => { if (upstream.readyState === WebSocket.OPEN && upstream.bufferedAmount < 1024 * 1024) upstream.send(data); });
            active.set(ws, { session, identity, upstream });
            ws.on('close', () => { active.delete(ws); upstream.close(); }); ws.on('error', () => upstream.close());
            upstream.on('close', () => ws.close());
          }));
        } catch { upstream?.close(); socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
      });
    },
  };
}
