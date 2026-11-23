import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const username = process.env.PANEL_USERNAME ?? '';
const password = process.env.PANEL_PASSWORD ?? '';
const configured = username.length > 0 && !username.includes(':') && password.length > 0;
const hash = (value) => createHash('sha256').update(value).digest();
const expected = hash(Buffer.from(username + ':' + password).toString('base64'));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/panel.css', ['panel.css', 'text/css; charset=utf-8']],
].map(([route, [file, type]]) => [route, [readFileSync(new URL(file, import.meta.url)), type]]));

const server = createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'");
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
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    send(405, 'Metodo no permitido.');
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
