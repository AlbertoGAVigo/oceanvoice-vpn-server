import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createPKI, failure } from './pki.mjs';
const pki = createPKI();
import { createConnections } from './connections.mjs';
const connections = createConnections();
import { createSettings } from './settings.mjs';
const settings = createSettings();
import { createAccess } from './access.mjs';
const access = createAccess(pki);

const username = process.env.PANEL_USERNAME ?? '';
const password = process.env.PANEL_PASSWORD ?? '';
const configured = username.length > 0 && !username.includes(':') && password.length > 0;
if (configured) {
  const sample = () => connections.sample().catch(error => console.error('Connection sampling failed:', error.code ?? 'internal'));
  sample();
  setInterval(sample, 5000).unref();
}
const hash = (value) => createHash('sha256').update(value).digest();
const expected = hash(Buffer.from(username + ':' + password).toString('base64'));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/panel.js', ['panel.js', 'text/javascript; charset=utf-8']],
  ['/panel.css', ['panel.css', 'text/css; charset=utf-8']],
].map(([route, [file, type]]) => [route, [readFileSync(new URL(file, import.meta.url)), type]]));

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  const send = (status, body, type = 'text/plain; charset=utf-8') => {
    response.writeHead(status, { 'Content-Type': type });
    response.end(request.method === 'HEAD' ? undefined : body);
  };

  if (!configured) {
    send(503, 'Panel pendiente de configurar en Portainer.');
    return;
  }
  const supplied = /^Basic ([A-Za-z0-9+/=]+)$/i.exec(request.headers.authorization ?? '')?.[1] ?? '';
  if (!timingSafeEqual(hash(supplied), expected)) {
    response.setHeader('WWW-Authenticate', 'Basic realm="OceanVoice VPN", charset="UTF-8"');
    send(401, 'Autenticacion requerida.');
    return;
  }
  try {
    const route = new URL(request.url, 'http://panel').pathname;
    if (route.startsWith('/api/')) {
      if (request.method === 'POST' && (request.headers['x-oceanvoice-action'] !== '1' ||
          !request.headers['content-type']?.startsWith('application/json') ||
          (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site']))))
        throw failure(403, 'Solicitud no permitida.');
      let result;
      if (route === '/api/settings' && request.method === 'GET') result = await settings.get();
      else if (route === '/api/access' && request.method === 'GET') result = await access.get();
      else if (route === '/api/routers' && request.method === 'GET') {
        const rows = await pki.list();
        const snapshot = await connections.sample();
        let assignments = {};
        try { assignments = JSON.parse(readFileSync(`${process.env.VPN_STATE ?? '/var/lib/openvpn'}/vpn-addresses.json`, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        result = { available: snapshot.available, updatedAt: snapshot.updatedAt ?? null, routers: rows.map(row => {
          const live = snapshot.clients.find(client => client.id === row.id);
          return { ...row, ...snapshot.history[row.id], ...live, assignedIP: assignments[row.id] ?? null,
            connection: !snapshot.available ? 'unknown' : live ? 'connected' : 'disconnected' };
        }) };
      }
      else if (route === '/api/certificates' && request.method === 'GET') result = await pki.list();
      else if (['/api/certificates', '/api/settings', '/api/access'].includes(route) && request.method === 'POST') {
        let body = '';
        for await (const chunk of request) {
          body += chunk;
          if (Buffer.byteLength(body) > (route === '/api/access' ? 120000 : 4096)) throw failure(413, 'Formulario demasiado grande.');
        }
        let input;
        try { input = JSON.parse(body); } catch { throw failure(400, 'Formulario inválido.'); }
        result = route === '/api/settings' ? await settings.save(input) : route === '/api/access' ? await access.save(input) : await pki.create(input);
      } else {
        const match = /^\/api\/certificates\/([a-zA-Z0-9_-]+)\/(profile|revoke)$/.exec(route);
        if (match?.[2] === 'profile' && request.method === 'GET') {
          const profile = await pki.profile(match[1]);
          response.setHeader('Content-Disposition', `attachment; filename="${match[1]}.ovpn"`);
          send(200, profile, 'application/x-openvpn-profile');
          return;
        }
        if (match?.[2] === 'revoke' && request.method === 'POST') result = await pki.revoke(match[1]);
        else throw failure(404, 'Recurso no encontrado.');
      }
      send(200, JSON.stringify(result), 'application/json; charset=utf-8');
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      send(405, 'Método no permitido.'); return;
    }
  } catch (error) {
    console.error('Panel operation failed:', error.status ?? error.code ?? 'internal');
    send(error.status ?? 503, JSON.stringify({ error: error.status ? error.message : 'Operación PKI fallida. Comprueba el volumen, los logs y el inventario antes de reintentar.' }), 'application/json; charset=utf-8');
    return;
  }
  const asset = assets.get(request.url?.split('?')[0]);
  if (!asset) {
    send(404, 'Recurso no encontrado.');
    return;
  }
  send(200, ...asset);
});

server.listen(8080, '0.0.0.0', () => {
  console.log(configured ? 'OceanVoice panel ready on port 8080' : 'Set PANEL_USERNAME and PANEL_PASSWORD to enable the panel');
});
