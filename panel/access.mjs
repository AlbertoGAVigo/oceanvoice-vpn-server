import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { failure } from './pki.mjs';

export function createAccess(pki, state = process.env.VPN_STATE ?? '/var/lib/openvpn') {
  const target = path.join(state, 'access-policy.json');
  async function read(name, fallback) {
    try { return JSON.parse(await readFile(path.join(state, name), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  }
  return {
    async get() {
      const policy = await read('access-policy.json', { mode: 'isolated', groups: [], revision: 'initial' });
      const applied = await read('access-applied.json', null);
      const assignments = await read('vpn-addresses.json', {});
      const routers = (await pki.list()).map(row => ({ id: row.id, name: row.name, site: row.site,
        status: row.status, vpnIP: assignments[row.id] ?? null }));
      const healthy = applied?.revision === policy.revision && !applied.error && Date.now() - Date.parse(applied.checkedAt) < 15000;
      return { ...policy, applied, healthy, routers };
    },
    async save(input) {
      if (!['isolated', 'all', 'groups'].includes(input?.mode) || !Array.isArray(input?.groups) || input.groups.length > 100)
        throw failure(400, 'Selecciona un modo válido y hasta 100 grupos.');
      const active = new Set((await pki.list()).filter(row => row.status === 'valid').map(row => row.id));
      const groups = [];
      const names = new Set();
      for (const group of input.groups) {
        const name = typeof group?.name === 'string' ? group.name.trim() : '';
        if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name) || names.has(name.toLowerCase()) ||
            !active.has(group.master) || !Array.isArray(group.children) || !group.children.length || group.children.length > 252 ||
            !group.children.every(id => typeof id === 'string' && active.has(id) && id !== group.master))
          throw failure(400, 'Cada grupo necesita un nombre único, un maestro y al menos un hijo distinto con certificado vigente.');
        names.add(name.toLowerCase());
        groups.push({ name, master: group.master, children: [...new Set(group.children)].sort() });
      }
      const policy = { mode: input.mode, groups, revision: randomUUID(), updatedAt: new Date().toISOString() };
      const temporary = `${target}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, JSON.stringify(policy, null, 2), { mode: 0o600 }); await rename(temporary, target); }
      finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      return policy;
    },
  };
}
