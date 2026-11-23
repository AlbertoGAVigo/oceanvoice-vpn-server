import { readFile, writeFile, rename, mkdir, rmdir, chmod, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, X509Certificate } from 'node:crypto';
import path from 'node:path';

const exec = promisify(execFile);
process.umask(0o077);
export const failure = (status, message) => Object.assign(new Error(message), { status });
export function createPKI(state = process.env.VPN_STATE ?? '/var/lib/openvpn') {
  const pki = path.join(state, 'pki');
  const file = (...parts) => path.join(pki, ...parts);
  const run = (...args) => exec('/usr/share/easy-rsa/easyrsa', ['--batch', ...args], {
    env: { ...process.env, EASYRSA_PKI: pki, EASYRSA_BATCH: '1' }, timeout: 120000,
  });
  async function locked(action) {
    await access(file('ca.crt'));
    const lock = path.join(state, '.panel-pki-lock');
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (e) { if (e.code === 'EEXIST') throw failure(409, 'PKI ocupada. Reintenta en unos segundos.'); throw e; }
    try { return await action(); } finally { await rmdir(lock); }
  }
  async function metadata() {
    try { return JSON.parse(await readFile(path.join(state, 'routers.json'), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
  }
  async function inventory() {
    const meta = await metadata();
    const index = await readFile(file('index.txt'), 'utf8');
    const result = [];
    for (const line of index.trim().split('\n')) {
      const [flag, , revokedAt, serial, , subject] = line.split('\t');
      const id = /(?:^|\/)CN=([^/\r\n]+)/.exec(subject ?? '')?.[1];
      if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) continue;
      const certPath = flag === 'R' ? file('revoked', 'certs_by_serial', `${serial}.crt`) : file('certs_by_serial', `${serial}.pem`);
      const cert = new X509Certificate(await readFile(certPath));
      if (!cert.keyUsage?.includes('1.3.6.1.5.5.7.3.2')) continue;
      result.push({ id, serial, name: meta[id]?.name ?? id, site: meta[id]?.site ?? '', model: meta[id]?.model ?? '', firmware: meta[id]?.firmware ?? '',
        expires: new Date(cert.validTo).toISOString(), revokedAt: revokedAt || null,
        status: flag === 'R' ? 'revoked' : Date.parse(cert.validTo) <= Date.now() ? 'expired' : 'valid' });
    }
    return result;
  }
  async function publishCRL() {
    // Easy-RSA 3.1 generates into a temporary file and atomically renames it.
    await run('gen-crl');
    await chmod(file('crl.pem'), 0o644);
  }
  return {
    list: () => locked(inventory),
    create: (input) => locked(async () => {
      const name = typeof input?.name === 'string' ? input.name.trim() : ''; const site = typeof input?.site === 'string' ? input.site.trim() : '';
      const model = typeof input?.model === 'string' ? input.model.trim() : '';
      const firmware = typeof input?.firmware === 'string' ? input.firmware.trim() : '';
      if ( model.length > 80 || firmware.length > 80 || /[\x00-\x1f\x7f]/.test(model + firmware)) throw failure(400, 'Indica modelo y versiÃ³n de RutOS (hasta 80 caracteres).');
      if (typeof name !== 'string' || typeof site !== 'string' || !name || !site ||
          name.length > 80 || site.length > 120 || /[\x00-\x1f\x7f]/.test(name + site))
        throw failure(400, 'Indica nombre (hasta 80 caracteres) y sede (hasta 120).');
      const all = await inventory();
      if (all.some(row => row.name.toLowerCase() === name.toLowerCase() && row.site.toLowerCase() === site.toLowerCase() && row.status === 'valid'))
        throw failure(409, 'Ya existe un certificado vigente para ese nombre y sede.');
      const id = `teltonika-${randomUUID()}`;
      const meta = await metadata();
      // Persist identification before issuing so a command failure cannot orphan the site.
      meta[id] = { name, site, model, firmware };
      const target = path.join(state, 'routers.json');
      await writeFile(target + '.tmp', JSON.stringify(meta, null, 2), { mode: 0o600 });
      await rename(target + '.tmp', target);
      await run('build-client-full', id, 'nopass');
      return (await inventory()).find(row => row.id === id);
    }),
    revoke: (id) => locked(async () => {
      const row = (await inventory()).find(row => row.id === id);
      if (!row) throw failure(404, 'Certificado no encontrado.');
      if (row.status !== 'revoked') await run('revoke', id);
      // Retrying a revoked certificate also repairs a previously failed CRL publication.
      await publishCRL();
      return { ok: true };
    }),
    profile: (id) => locked(async () => {
      const row = (await inventory()).find(row => row.id === id);
      if (!row) throw failure(404, 'Certificado no encontrado.');
      if (row.status !== 'valid') throw failure(409, 'El certificado no estÃƒÂ¡ vigente.');
      const host = process.env.VPN_HOST ?? 'vpn.oceanvoice.es';
      const port = process.env.VPN_PORT ?? '1194';
      if (!/^[a-zA-Z0-9.-]+$/.test(host) || !/^\d+$/.test(port) || +port < 1 || +port > 65535) throw failure(503, 'Endpoint VPN mal configurado.');
      const ca = await readFile(file('ca.crt'), 'utf8');
      const cert = new X509Certificate(await readFile(file('issued', `${id}.crt`))).toString();
      const key = await readFile(file('private', `${id}.key`), 'utf8');
      const tls = await readFile(path.join(state, 'tls-crypt.key'), 'utf8');
      return `client\ndev tun\nproto udp\nremote ${host} ${port}\nresolv-retry infinite\nnobind\npersist-key\npersist-tun\nremote-cert-tls server\nverify-x509-name oceanvoice-server name\ntls-version-min 1.2\ndata-ciphers AES-256-GCM:AES-128-GCM\nauth SHA256\nverb 3\n<ca>\n${ca.trim()}\n</ca>\n<cert>\n${cert.trim()}\n</cert>\n<key>\n${key.trim()}\n</key>\n<tls-crypt>\n${tls.trim()}\n</tls-crypt>\n`;
    }),
  };
}
