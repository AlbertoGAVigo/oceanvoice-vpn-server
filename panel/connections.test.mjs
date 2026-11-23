import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseStatus, createConnections } from './connections.mjs';
const now = Math.floor(Date.now() / 1000);
const fixture = (timestamp = now, connected = true) => [
  `TIME\tdate\t${timestamp}`,
  'HEADER\tCLIENT_LIST\tCommon Name\tReal Address\tVirtual Address\tVirtual IPv6 Address\tBytes Received\tBytes Sent\tConnected Since\tConnected Since (time_t)\tUsername',
  ...(connected ? [`CLIENT_LIST\tteltonika-test\t198.51.100.1:54321\t10.80.0.2\t\t100\t200\tdate\t${timestamp - 60}\tUNDEF`] : []),
  'END',
].join('\n');
test('parses a real status-v3 layout and rejects stale or incomplete reports', () => {
  const result = parseStatus(fixture(), now * 1000);
  assert.equal(result.available, true);
  assert.equal(result.clients[0].tunnelIP, '10.80.0.2');
  assert.equal(result.clients[0].remoteAddress, '198.51.100.1:54321');
  assert.equal(result.clients[0].connectedSince, new Date((now - 60) * 1000).toISOString());
  assert.equal(parseStatus(fixture(now - 60), now * 1000).available, false);
  assert.equal(parseStatus(fixture().replace('END', ''), now * 1000).available, false);
  assert.equal(parseStatus('', now * 1000).available, false);
});
test('retains last connection and IP after disconnect and panel restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oceanvoice-status-'));
  try {
    const monitor = createConnections(directory);
    assert.equal((await monitor.sample()).available, false);
    await writeFile(path.join(directory, 'status.tsv'), fixture());
    const live = await monitor.sample();
    assert.equal(live.history['teltonika-test'].lastTunnelIP, '10.80.0.2');
    await writeFile(path.join(directory, 'status.tsv'), fixture(now, false));
    const offline = await createConnections(directory).sample();
    assert.equal(offline.clients.length, 0);
    assert.equal(offline.history['teltonika-test'].lastConnected, new Date((now - 60) * 1000).toISOString());
    await writeFile(path.join(directory, 'status.tsv'), fixture(now - 100));
    const stale = await monitor.sample();
    assert.equal(stale.available, false);
    assert.equal(stale.history['teltonika-test'].lastSeen, live.updatedAt);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
