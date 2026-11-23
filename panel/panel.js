const form = document.querySelector('#create-router');
const message = document.querySelector('#message');
const inventory = document.querySelector('#inventory');
let busy = false;
async function api(url, data) {
  const response = await fetch(url, data === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OceanVoice-Action': '1' }, body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'No se pudo completar la operación.');
  return result;
}
function cell(row, text) { const td = document.createElement('td'); td.textContent = text; row.append(td); return td; }
async function refresh() {
  await refreshRouters();
  const rows = await api('/api/certificates');
  inventory.replaceChildren();
  document.querySelector('#count').textContent = `${rows.length} certificados · ${rows.filter(r => r.status === 'valid').length} vigentes`;
  for (const item of rows) {
    const row = document.createElement('tr');
    cell(row, `${item.name} / ${item.site || 'Sin sede'}`);
    cell(row, [item.model, item.firmware].filter(Boolean).join(' · ') || '—');
    const state = cell(row, { valid: 'Vigente', revoked: 'Revocado', expired: 'Caducado' }[item.status]);
    state.className = item.status;
    cell(row, new Date(item.expires).toLocaleDateString('es-ES'));
    const actions = cell(row, '');
    if (item.status === 'valid') {
      const link = document.createElement('a');
      link.href = `/api/certificates/${item.id}/profile`; link.textContent = 'Descargar .ovpn'; actions.append(link);
    }
    const revoke = document.createElement('button'); revoke.type = 'button';
    revoke.textContent = item.status === 'revoked' ? 'Republicar revocación' : 'Revocar';
    revoke.className = 'danger';
    revoke.addEventListener('click', () => {
      if (busy || !confirm(`¿Revocar el acceso de ${item.name} (${item.site})? El perfil dejará de permitir nuevas conexiones.`)) return;
      perform(async () => { await api(`/api/certificates/${item.id}/revoke`, {}); message.textContent = 'Revocación publicada. El perfil ya no permite nuevas conexiones.'; });
    });
    actions.append(revoke); inventory.append(row);
  }
  if (!rows.length) { const row = document.createElement('tr'); const td = cell(row, 'No hay certificados de clientes. Da de alta el primer router.'); td.colSpan = 5; inventory.append(row); }
}
async function perform(action) {
  if (busy) return;
  busy = true; document.querySelectorAll('#create-router button, #inventory button, #refresh').forEach(b => b.disabled = true);
  message.textContent = 'Procesando…';
  try { await action(); await refresh(); }
  catch (error) { message.textContent = error.message; }
  finally { busy = false; document.querySelectorAll('#create-router button, #inventory button, #refresh').forEach(b => b.disabled = false); }
}
form.addEventListener('submit', event => {
  event.preventDefault();
  perform(async () => { await api('/api/certificates', Object.fromEntries(new FormData(form))); form.reset(); message.textContent = 'Certificado creado. Descarga el perfil .ovpn desde el inventario.'; });
});
document.querySelector('#refresh').addEventListener('click', () => perform(async () => { message.textContent = ''; }));
refresh().catch(error => { message.textContent = error.message; document.querySelector('#count').textContent = 'Inventario no disponible'; });
function dateTime(value) { return value ? new Date(value).toLocaleString('es-ES') : 'Sin registro'; }
async function refreshRouters() {
  const result = await api('/api/routers');
  document.querySelector('#metric-total').textContent = result.routers.length;
  document.querySelector('#metric-online').textContent = result.available ? result.routers.filter(r => r.connection === 'connected').length : '—';
  document.querySelector('#metric-offline').textContent = result.available ? result.routers.filter(r => r.connection === 'disconnected').length : '—';
  const target = document.querySelector('#routers'); target.replaceChildren();
  document.querySelector('#connection-summary').textContent = result.available
    ? `${result.routers.filter(r => r.connection === 'connected').length} conectados · Estado del servidor: ${dateTime(result.updatedAt)}`
    : 'Estado de conexión no disponible: esperando un informe reciente de OpenVPN.';
  for (const item of result.routers) {
    const row = document.createElement('tr');
    cell(row, `${item.name} / ${item.site || 'Sin sede'}`);
    const state = cell(row, { connected: 'Conectado', disconnected: 'Desconectado', unknown: 'Sin datos recientes' }[item.connection]);
    state.className = item.connection === 'connected' ? 'valid' : '';
    cell(row, item.tunnelIP || (item.lastTunnelIP ? `${item.lastTunnelIP} (última)` : 'Sin asignar'));
    cell(row, item.remoteAddress || (item.lastRemoteAddress ? `${item.lastRemoteAddress} (último)` : 'Sin registro'));
    cell(row, dateTime(item.connectedSince || item.lastConnected));
    cell(row, dateTime(item.lastSeen)); target.append(row);
  }
  if (!result.routers.length) { const row = document.createElement('tr'); const td = cell(row, 'Todavía no hay routers. Da de alta el primero en Certificados.'); td.colSpan = 6; target.append(row); }
}
setInterval(() => {
  if (!busy) refreshRouters().catch(() => {
    document.querySelector('#connection-summary').textContent = 'No se pudo actualizar el estado. Los datos de la tabla pueden estar desactualizados.';
    document.querySelector('#metric-online').textContent = '—';
    document.querySelector('#metric-offline').textContent = '—';
    document.querySelectorAll('#routers tr td:nth-child(2)').forEach(td => { td.textContent = 'Sin datos recientes'; td.className = ''; });
  });
}, 10000);

const tabs = [...document.querySelectorAll('[role="tab"]')];
function selectTab(id) {
  if (!tabs.some(tab => tab.getAttribute('aria-controls') === id)) id = 'monitor';
  for (const tab of tabs) {
    const selected = tab.getAttribute('aria-controls') === id;
    tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
  }
}
for (const tab of tabs) {
  tab.addEventListener('click', () => { location.hash = tab.getAttribute('aria-controls'); });
  tab.addEventListener('keydown', event => {
    const index = tabs.indexOf(tab);
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
    if (next === null) return;
    event.preventDefault(); tabs[next].focus(); tabs[next].click();
  });
}
window.addEventListener('hashchange', () => selectTab(location.hash.slice(1)));
selectTab(location.hash.slice(1));

const endpointForm = document.querySelector('#endpoint-form');
const settingsMessage = document.querySelector('#settings-message');
const saveSettings = document.querySelector('#save-settings');
function showEndpoint(settings) {
  document.querySelector('#vpn-host').value = settings.host;
  document.querySelector('#vpn-port').value = settings.port;
  const host = settings.host.includes(':') ? `[${settings.host}]` : settings.host;
  document.querySelector('#endpoint-summary').textContent = `${host}:${settings.port} / UDP`;
  document.querySelector('#settings-source').textContent = settings.source === 'panel' ? `Guardado: ${dateTime(settings.updatedAt)}` : 'Valores iniciales del despliegue';
}
api('/api/settings').then(settings => { showEndpoint(settings); saveSettings.disabled = false; }).catch(error => {
  settingsMessage.textContent = error.message;
  document.querySelector('#endpoint-summary').textContent = 'Configuración no disponible';
});
endpointForm.addEventListener('input', () => { settingsMessage.textContent = 'Cambios sin guardar. Las descargas siguen usando la configuración guardada.'; });
endpointForm.addEventListener('submit', async event => {
  event.preventDefault(); if (saveSettings.disabled) return;
  saveSettings.disabled = true;
  endpointForm.querySelectorAll('input').forEach(input => input.readOnly = true);
  settingsMessage.textContent = 'Guardando…';
  try {
    const settings = await api('/api/settings', Object.fromEntries(new FormData(endpointForm)));
    showEndpoint(settings);
    settingsMessage.textContent = 'Configuración guardada. Las próximas descargas .ovpn usarán este servidor y puerto.';
  } catch (error) { settingsMessage.textContent = error.message; }
  finally { saveSettings.disabled = false; endpointForm.querySelectorAll('input').forEach(input => input.readOnly = false); }
});
