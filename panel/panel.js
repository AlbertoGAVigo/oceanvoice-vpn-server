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
function detailCell(row, title, subtitle) {
  const td = cell(row, ''); const strong = document.createElement('strong'); strong.textContent = title;
  const small = document.createElement('small'); small.textContent = subtitle; td.append(strong, small); return td;
}
function cell(row, text) { const td = document.createElement('td'); td.textContent = text; row.append(td); return td; }
async function refresh() {
  await refreshRouters();
  const rows = await api('/api/certificates');
  inventory.replaceChildren();
  document.querySelector('#count').textContent = `${rows.length} certificados · ${rows.filter(r => r.status === 'valid').length} vigentes`;
  for (const item of rows) {
    const row = document.createElement('tr');
    detailCell(row, item.name, item.site || 'Sin sede');
    detailCell(row, item.model || '—', item.firmware ? `SO: ${item.firmware}` : '');
    const state = cell(row, { valid: 'Vigente', revoked: 'Revocado', expired: 'Caducado' }[item.status]);
    state.className = item.status;
    cell(row, new Date(item.expires).toLocaleDateString('es-ES'));
    const actions = cell(row, '');
    const controls = document.createElement('div'); controls.className = 'row-actions'; actions.append(controls);
    if (item.status === 'valid') {
      const link = document.createElement('a');
      link.href = `/api/certificates/${item.id}/profile`; link.textContent = 'Descargar .ovpn'; link.className = 'button'; controls.append(link);
    }
    const revoke = document.createElement('button'); revoke.type = 'button';
    revoke.textContent = item.status === 'revoked' ? 'Republicar CRL' : 'Revocar';
    revoke.className = 'danger';
    revoke.addEventListener('click', () => {
      if (busy || !confirm(`¿Revocar el acceso de ${item.name} (${item.site})? El perfil dejará de permitir nuevas conexiones.`)) return;
      perform(async () => { await api(`/api/certificates/${item.id}/revoke`, {}); message.textContent = 'Revocación publicada. El perfil ya no permite nuevas conexiones.'; });
    });
    controls.append(revoke); inventory.append(row);
  }
  if (!rows.length) { const row = document.createElement('tr'); const td = cell(row, 'No hay certificados de clientes. Da de alta el primer cliente.'); td.colSpan = 5; inventory.append(row); }
}
async function perform(action) {
  if (busy) return;
  busy = true; document.querySelectorAll('#create-router button, #inventory button, #refresh').forEach(b => b.disabled = true);
  message.textContent = 'Procesando…';
  try { await action(); await refresh(); if (!accessDirty) await refreshAccess(true); }
  catch (error) { message.textContent = error.message; }
  finally { busy = false; document.querySelectorAll('#create-router button, #inventory button, #refresh').forEach(b => b.disabled = false); }
}
form.addEventListener('submit', event => {
  event.preventDefault();
  perform(async () => { await api('/api/certificates', Object.fromEntries(new FormData(form))); form.reset(); message.textContent = 'Certificado creado. Descarga el perfil .ovpn desde el inventario.'; });
});
document.querySelector('#refresh').addEventListener('click', () => perform(async () => { message.textContent = ''; }));
refresh().then(() => refreshAccess(true)).catch(error => { message.textContent = error.message; document.querySelector('#count').textContent = 'Inventario no disponible'; });
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
    detailCell(row, item.name, item.site || 'Sin sede');
    const state = cell(row, { connected: 'Conectado', disconnected: 'Desconectado', unknown: 'Sin datos recientes' }[item.connection]);
    state.className = item.connection === 'connected' ? 'valid' : '';
    cell(row, item.assignedIP || item.tunnelIP || item.lastTunnelIP || 'Reserva pendiente');
    cell(row, item.remoteAddress || (item.lastRemoteAddress ? `${item.lastRemoteAddress} (último)` : 'Sin registro'));
    cell(row, dateTime(item.connectedSince || item.lastConnected));
    cell(row, dateTime(item.lastSeen));
    const management = cell(row, '');
    const ip = item.assignedIP || item.tunnelIP;
    if (item.connection === 'connected' && item.status === 'valid' && /^10\.80\.0\.\d{1,3}$/.test(ip ?? '')) {
      const remote = document.createElement('a'); remote.className = 'button';
      remote.href = `/remote.html?client=${encodeURIComponent(item.id)}`; remote.target = '_blank'; remote.rel = 'noopener noreferrer';
      remote.textContent = 'Gestionar cliente'; remote.title = 'Abrir un navegador remoto desde el servidor por la VPN.';
      management.append(remote);
      const link = document.createElement('a'); link.className = 'button secondary';
      link.href = `https://${ip}/`; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.textContent = 'Acceso directo ↗'; link.title = 'Tu ordenador necesita acceso a la red VPN.';
      management.append(link); management.className = 'management-actions';
    } else management.textContent = '—';
    target.append(row);
  }
  if (!result.routers.length) { const row = document.createElement('tr'); const td = cell(row, 'Todavía no hay clientes. Da de alta el primero en Clientes y perfiles.'); td.colSpan = 7; target.append(row); }
}
setInterval(() => {
  if (!busy) refreshRouters().then(() => refreshAccess(false)).catch(() => {
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

const accessForm = document.querySelector('#access-form');
const accessMode = document.querySelector('#access-mode');
const accessMessage = document.querySelector('#access-message');
const saveAccess = document.querySelector('#save-access');
let accessDirty = false;
let accessRouters = [];
let accessGroups = [];
let accessSaving = false;
function routerLabel(id) {
  const router = accessRouters.find(row => row.id === id);
  return router ? `${router.name} / ${router.site} · ${router.vpnIP || 'IP pendiente'}` : 'Dispositivo no vigente';
}
function renderChildren() {
  const selected = new Set([...document.querySelectorAll('#group-children input:checked')].map(input => input.value));
  const target = document.querySelector('#group-children'); target.replaceChildren();
  const master = document.querySelector('#group-master').value;
  for (const router of accessRouters.filter(row => row.id !== master)) {
    const label = document.createElement('label'); const input = document.createElement('input');
    input.type = 'checkbox'; input.value = router.id; input.checked = selected.has(router.id); input.disabled = accessSaving;
    label.append(input, document.createTextNode(routerLabel(router.id))); target.append(label);
  }
  if (accessRouters.length < 2) target.textContent = 'Da de alta al menos dos dispositivos para crear un grupo.';
}
function renderGroups() {
  document.querySelector('#group-editor').hidden = accessMode.value !== 'groups';
  const list = document.querySelector('#group-list'); list.replaceChildren();
  for (const [index, group] of accessGroups.entries()) {
    const item = document.createElement('li'); const description = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = group.name;
    const master = document.createElement('p'); master.textContent = `Maestro: ${routerLabel(group.master)}`;
    const children = document.createElement('p'); children.textContent = `Hijos: ${group.children.map(routerLabel).join(' · ')}`;
    description.append(title, master, children);
    const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = 'Editar'; edit.disabled = accessSaving;
    edit.addEventListener('click', () => {
      document.querySelector('#group-name').value = group.name;
      document.querySelector('#group-master').value = group.master; renderChildren();
      document.querySelectorAll('#group-children input').forEach(input => { input.checked = group.children.includes(input.value); });
      accessGroups.splice(index, 1); accessDirty = true; renderGroups();
      accessMessage.textContent = 'Edita el grupo y pulsa Añadir grupo antes de guardar los permisos.';
    });
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Quitar'; remove.disabled = accessSaving;
    remove.addEventListener('click', () => { accessGroups.splice(index, 1); accessDirty = true; accessMessage.textContent = 'Cambios sin guardar.'; renderGroups(); });
    const actions = document.createElement('div'); actions.className = 'group-actions'; actions.append(edit, remove);
    item.append(description, actions); list.append(item);
  }
  if (!accessGroups.length) { const item = document.createElement('li'); item.textContent = 'Sin grupos: en este modo los dispositivos permanecen aislados.'; list.append(item); }
  document.querySelector('#add-group').disabled = accessRouters.length < 2 || accessSaving;
}
async function refreshAccess(loadForm) {
  const data = await api('/api/access');
  const applied = document.querySelector('#access-applied');
  applied.textContent = data.healthy ? `Aplicado en el servidor · ${dateTime(data.applied.checkedAt)}`
    : data.applied?.error ? 'Error al aplicar. Revisa el servicio VPN en Portainer.' : 'Pendiente de confirmación del servidor';
  applied.className = data.healthy ? 'valid' : '';
  if (!loadForm || accessSaving) return;
  accessRouters = data.routers.filter(router => router.status === 'valid');
  accessGroups = data.groups.map(group => ({ ...group, children: group.children.filter(id => accessRouters.some(router => router.id === id)) }))
    .filter(group => accessRouters.some(router => router.id === group.master) && group.children.length);
  accessMode.value = data.mode;
  const select = document.querySelector('#group-master'); select.replaceChildren();
  for (const router of accessRouters) {
    const option = document.createElement('option'); option.value = router.id; option.textContent = routerLabel(router.id); select.append(option);
  }
  accessDirty = false; accessMode.disabled = false; saveAccess.disabled = false; renderChildren(); renderGroups();
}
accessMode.addEventListener('change', () => { accessDirty = true; accessMessage.textContent = 'Cambios sin guardar.'; renderGroups(); });
document.querySelector('#group-master').addEventListener('change', renderChildren);
document.querySelector('#add-group').addEventListener('click', () => {
  const name = document.querySelector('#group-name').value.trim();
  const master = document.querySelector('#group-master').value;
  const children = [...document.querySelectorAll('#group-children input:checked')].map(input => input.value);
  if (!name || !master || !children.length) { accessMessage.textContent = 'Indica un nombre, un maestro y al menos un hijo.'; return; }
  if (accessGroups.some(group => group.name.toLowerCase() === name.toLowerCase())) { accessMessage.textContent = 'Ya existe un grupo con ese nombre.'; return; }
  accessGroups.push({ name, master, children }); accessDirty = true;
  document.querySelector('#group-name').value = '';
  document.querySelectorAll('#group-children input').forEach(input => { input.checked = false; });
  accessMessage.textContent = 'Grupo añadido. Guarda los permisos para aplicarlo en el servidor.'; renderGroups();
});
accessForm.addEventListener('submit', async event => {
  event.preventDefault(); if (accessSaving || saveAccess.disabled) return;
  if (document.querySelector('#group-name').value.trim()) { accessMessage.textContent = 'Hay un grupo en edición. Pulsa Añadir grupo antes de guardar los permisos.'; return; }
  if (!confirm('¿Aplicar estos permisos en el servidor VPN? En modo Grupos, cada maestro tendrá acceso bidireccional a sus hijos; no se autoriza acceso entre hijos.')) return;
  accessSaving = true; saveAccess.disabled = true; accessMode.disabled = true; renderGroups(); renderChildren();
  accessMessage.textContent = 'Guardando permisos…';
  try {
    await api('/api/access', { mode: accessMode.value, groups: accessGroups });
    accessDirty = false; accessMessage.textContent = 'Permisos guardados. Esperando confirmación de aplicación en el servidor.';
  } catch (error) { accessMessage.textContent = error.message; }
  finally { accessSaving = false; accessMode.disabled = false; saveAccess.disabled = false; renderGroups(); renderChildren(); }
  await refreshAccess(false).catch(error => { accessMessage.textContent = error.message; });
});
