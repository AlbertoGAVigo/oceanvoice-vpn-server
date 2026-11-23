import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export function validateEndpoint(input) {
  const host = typeof input?.host === 'string' ? input.host.trim().toLowerCase() : '';
  const portText = String(input?.port ?? '');
  const domain = host.length <= 253 && host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  if (!host || (!isIP(host) && (!domain || /^[\d.]+$/.test(host))))
    throw Object.assign(new Error('Introduce un nombre de servidor o una IP válidos, sin https://, rutas ni puerto.'), { status: 400 });
  if (!/^\d{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535)
    throw Object.assign(new Error('El puerto debe ser un número entero entre 1 y 65535.'), { status: 400 });
  return { host, port: Number(portText) };
}

export function createSettings(state = process.env.VPN_STATE ?? '/var/lib/openvpn') {
  const target = path.join(state, 'panel-settings.json');
  return {
    async get() {
      let stored;
      try { stored = JSON.parse(await readFile(target, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const endpoint = validateEndpoint(stored ?? { host: process.env.VPN_HOST ?? 'vpn.oceanvoice.es', port: process.env.VPN_PORT ?? '1194' });
      return { ...endpoint, protocol: 'UDP', source: stored ? 'panel' : 'environment', updatedAt: stored?.updatedAt ?? null };
    },
    async save(input) {
      const endpoint = validateEndpoint(input);
      const temporary = `${target}.${randomUUID()}.tmp`;
      const stored = { ...endpoint, updatedAt: new Date().toISOString() };
      try {
        await writeFile(temporary, JSON.stringify(stored, null, 2), { mode: 0o600 });
        await rename(temporary, target);
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      return { ...stored, protocol: 'UDP', source: 'panel' };
    },
  };
}
