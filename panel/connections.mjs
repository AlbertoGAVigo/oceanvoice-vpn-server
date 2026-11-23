import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

export function parseStatus(text, now = Date.now()) {
  const lines = text.trim().split(/\r?\n/).map(line => line.split('\t'));
  const time = Number(lines.find(row => row[0] === 'TIME')?.at(-1)) * 1000;
  if (!lines.some(row => row[0] === 'END') || !Number.isFinite(time) || now - time > 45000 || time > now + 5000)
    return { available: false, clients: [] };
  const header = lines.find(row => row[0] === 'HEADER' && row[1] === 'CLIENT_LIST')?.slice(2);
  if (!header) return { available: false, clients: [] };
  const clients = lines.filter(row => row[0] === 'CLIENT_LIST').map(row => {
    const entry = Object.fromEntries(header.map((key, i) => [key, row[i + 1]]));
    const connected = Number(entry['Connected Since (time_t)']) * 1000;
    return { id: entry['Common Name'], tunnelIP: entry['Virtual Address'] || null,
      remoteAddress: entry['Real Address'] || null,
      connectedSince: Number.isFinite(connected) && connected > 0 ? new Date(connected).toISOString() : null,
      bytesReceived: Number(entry['Bytes Received']) || 0, bytesSent: Number(entry['Bytes Sent']) || 0 };
  });
  return { available: true, updatedAt: new Date(time).toISOString(), clients };
}

export function createConnections(state = process.env.VPN_STATE ?? '/var/lib/openvpn') {
  let pending = Promise.resolve();
  async function sample() {
    let history = {};
    try { history = JSON.parse(await readFile(path.join(state, 'connections.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let snapshot = { available: false, clients: [] };
    try { snapshot = parseStatus(await readFile(path.join(state, 'status.tsv'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let changed = false;
    for (const client of snapshot.clients) {
      if (!/^[a-zA-Z0-9_-]+$/.test(client.id)) continue;
      const record = { lastConnected: client.connectedSince, lastSeen: snapshot.updatedAt,
        lastTunnelIP: client.tunnelIP, lastRemoteAddress: client.remoteAddress };
      if (JSON.stringify(history[client.id]) !== JSON.stringify(record)) { history[client.id] = record; changed = true; }
    }
    if (changed) {
      const target = path.join(state, 'connections.json');
      await writeFile(target + '.tmp', JSON.stringify(history, null, 2), { mode: 0o600 });
      await rename(target + '.tmp', target);
    }
    return { ...snapshot, history };
  }
  return {
    sample() { const result = pending.then(sample); pending = result.catch(() => {}); return result; },
  };
}
