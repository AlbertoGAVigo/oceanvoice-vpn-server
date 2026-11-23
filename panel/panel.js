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
  busy = true; document.querySelectorAll('button').forEach(b => b.disabled = true);
  message.textContent = 'Procesando…';
  try { await action(); await refresh(); }
  catch (error) { message.textContent = error.message; }
  finally { busy = false; document.querySelectorAll('button').forEach(b => b.disabled = false); }
}
form.addEventListener('submit', event => {
  event.preventDefault();
  perform(async () => { await api('/api/certificates', Object.fromEntries(new FormData(form))); form.reset(); message.textContent = 'Certificado creado. Descarga el perfil .ovpn desde el inventario.'; });
});
document.querySelector('#refresh').addEventListener('click', () => perform(async () => { message.textContent = ''; }));
refresh().catch(error => { message.textContent = error.message; document.querySelector('#count').textContent = 'Inventario no disponible'; });
