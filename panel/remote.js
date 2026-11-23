import RFB from '/novnc/core/rfb.js';
const status = document.querySelector('#status');
const screen = document.querySelector('#screen');
const protocol = document.querySelector('#protocol');
const port = document.querySelector('#port');
const finish = document.querySelector('#finish');
const reconnect = document.querySelector('#reconnect');
let session;
let rfb;
let working = false;
let lastTouch = 0;
const initialClient = new URLSearchParams(location.search).get('client');
const options = new URLSearchParams(location.search);
if (options.get('protocol') === 'http') { protocol.value = 'http'; port.value = 80; }
if (/^\d{1,5}$/.test(options.get('port') ?? '') && +options.get('port') > 0 && +options.get('port') <= 65535) port.value = options.get('port');
let currentClient = initialClient;
async function api(path, input) {
  const response = await fetch(path, input === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OceanVoice-Action': '1' }, body: JSON.stringify(input) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error ?? 'Operación fallida.'); return data;
}
function display(data) {
  session = data;
  currentClient = data.clientId;
  history.replaceState(null, '', `/remote.html#${data.id}`);
  protocol.value = data.protocol; port.value = data.port;
  document.querySelector('#client').textContent = `${data.name} · ${data.ip}`;
  document.querySelector('#expiry').textContent = `Fin máximo: ${new Date(data.expiresAt).toLocaleTimeString('es-ES')}`;
  rfb?.disconnect(); screen.replaceChildren();
  const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/remote-ws/${data.id}`;
  rfb = new RFB(screen, url, { credentials: { password: data.vncPassword }, shared: false });
  rfb.scaleViewport = true; rfb.resizeSession = false;
  rfb.addEventListener('connect', () => { status.textContent = 'Conectado. Puedes utilizar el navegador remoto.'; });
  rfb.addEventListener('disconnect', () => { status.textContent = 'Sesión desconectada. Pulsa Conectar para abrir otra.'; });
  rfb.addEventListener('securityfailure', () => { status.textContent = 'No se pudo autenticar la pantalla remota.'; });
  finish.disabled = false; reconnect.disabled = false;
}
async function start(clientId) {
  if (working) return;
  working = true; reconnect.disabled = true; finish.disabled = true; status.textContent = 'Iniciando navegador remoto…';
  try {
    if (session) { rfb?.disconnect(); await api(`/api/remote/${session.id}/close`, {}).catch(() => {}); }
    display(await api('/api/remote/start', { clientId, protocol: protocol.value, port: Number(port.value) }));
  } catch (error) { status.textContent = error.message; reconnect.disabled = false; }
  finally { working = false; }
}
protocol.addEventListener('change', () => { port.value = protocol.value === 'http' ? 80 : 443; });
document.querySelector('#target').addEventListener('submit', event => { event.preventDefault(); start(currentClient); });
finish.addEventListener('click', async () => {
  if (!session || working) return;
  working = true; finish.disabled = true;
  try { await api(`/api/remote/${session.id}/close`, {}); rfb?.disconnect(); screen.replaceChildren(); status.textContent = 'Sesión cerrada. Los datos del navegador remoto se han eliminado.'; session = null; }
  catch (error) { status.textContent = error.message; finish.disabled = false; }
  finally { working = false; }
});
function touch() {
  if (!session || working || Date.now() - lastTouch < 30000) return;
  lastTouch = Date.now(); api(`/api/remote/${session.id}/touch`, {}).catch(error => { status.textContent = error.message; rfb?.disconnect(); });
}
for (const event of ['pointerdown', 'pointermove', 'keydown', 'wheel']) screen.addEventListener(event, touch, { capture: true, passive: true });
if (initialClient) start(initialClient);
else if (/^[a-f0-9-]+$/.test(location.hash.slice(1))) {
  api(`/api/remote/${location.hash.slice(1)}`).then(display).catch(error => { status.textContent = error.message; });
} else status.textContent = 'Abre Gestionar cliente desde Monitorización.';
