import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { terminalSockets } from '../apps/server/src/ssh/terminal-sockets.mjs';
const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const { WebSocket } = require('ws');

async function waitFor(condition) {
  for (let count = 0; count < 300; count++) { if (condition()) return; await delay(5); }
  assert.fail('Terminal condition timed out');
}
async function fixture(t, options = {}) {
  const server = createServer(), channels = [], allowed = { value: true };
  const auth = { require: async request => {
    if (!allowed.value) throw Object.assign(new Error('Expired'), { status: 401 });
    return { user: { username: request.headers['x-test-user'] || 'alice' } };
  } };
  const ssh = { shell: async () => {
    const channel = new EventEmitter(); channel.stderr = new EventEmitter(); channel.writes = []; channel.closes = 0;
    channel.write = data => channel.writes.push(data); channel.setWindow = () => {};
    channel.close = () => { channel.closes++; channel.emit('close'); };
    channels.push(channel); return channel;
  } };
  const sockets = terminalSockets(server, auth, ssh, { find: async () => ({ defaultPath: '~' }) }, { detachMs: 2000, heartbeatMs: 5000, authCheckMs: 5000, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { sockets.disposeTerminals(); for (const ws of sockets.clients) ws.terminate(); await new Promise(resolve => server.close(resolve)); });
  const connect = (query = '', socketOptions = {}) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/terminal?serverId=server-a${query}`, { headers: { origin: 'http://localhost:5673', ...socketOptions.headers }, ...socketOptions });
    ws.packets = []; ws.on('message', raw => ws.packets.push(JSON.parse(raw))); ws.on('error', () => {});
    return ws;
  };
  return { sockets, channels, connect, allowed };
}

test('actual abrupt WebSocket 1006 resumes the same shell, replays offline output, and never repeats input', async t => {
  const { sockets, channels, connect } = await fixture(t);
  const first = connect(); await waitFor(() => first.packets.some(packet => packet.type === 'ready'));
  const sessionId = first.packets.find(packet => packet.type === 'ready').sessionId;
  first.send(JSON.stringify({ type: 'input', data: 'run-once\r' }));
  await waitFor(() => channels[0].writes.length === 1);
  channels[0].emit('data', Buffer.from('before drop'));
  await waitFor(() => first.packets.some(packet => packet.type === 'output'));
  const sequence = first.packets.at(-1).sequence, closed = once(first, 'close');
  [...sockets.clients][0].terminate(); assert.equal((await closed)[0], 1006);
  assert.equal(channels[0].closes, 0);
  channels[0].emit('data', Buffer.from('after drop'));
  const second = connect(`&sessionId=${sessionId}&after=${sequence}`);
  await waitFor(() => second.packets.some(packet => packet.type === 'ready'));
  assert.equal(channels.length, 1); assert.deepEqual(channels[0].writes, ['run-once\r']);
  assert.deepEqual(second.packets.filter(packet => packet.type === 'output').map(packet => packet.data), ['after drop']);
  const release = once(second, 'close'); second.send(JSON.stringify({ type: 'release' })); await release;
  assert.equal(channels[0].closes, 1);
});

test('server protocol heartbeat detects a silent broken client without closing the retained shell', async t => {
  const { channels, connect } = await fixture(t, { heartbeatMs: 25 });
  const first = connect('', { autoPong: false });
  const closed = once(first, 'close'); let pings = 0; first.on('ping', () => pings++);
  await waitFor(() => first.packets.some(packet => packet.type === 'ready'));
  const sessionId = first.packets.find(packet => packet.type === 'ready').sessionId;
  assert.equal((await closed)[0], 1006); assert.ok(pings >= 1); assert.equal(channels[0].closes, 0);
  const second = connect(`&sessionId=${sessionId}`);
  await waitFor(() => second.packets.some(packet => packet.type === 'ready'));
  await delay(100); assert.equal(second.readyState, WebSocket.OPEN); assert.equal(channels.length, 1);
  assert.deepEqual(channels[0].writes, []);
});

test('expired login stops the transport and shell with an explicit 4401 status', async t => {
  const { channels, connect, allowed } = await fixture(t, { authCheckMs: 20 });
  const ws = connect(); const closed = once(ws, 'close');
  await waitFor(() => ws.packets.some(packet => packet.type === 'ready'));
  allowed.value = false;
  assert.equal((await closed)[0], 4401); assert.equal(channels[0].closes, 1);
});

test('another account cannot attach to a retained terminal over the authenticated WebSocket', async t => {
  const { channels, connect } = await fixture(t);
  const first = connect(); await waitFor(() => first.packets.some(packet => packet.type === 'ready'));
  const sessionId = first.packets.find(packet => packet.type === 'ready').sessionId;
  // The test auth adapter authenticates bob; profile lookup alone is insufficient.
  const other = connect(`&sessionId=${sessionId}`, { headers: { origin: 'http://localhost:5673', 'x-test-user': 'bob' } });
  await waitFor(() => other.packets.some(packet => packet.type === 'error'));
  assert.equal(other.packets.at(-1).code, 'TERMINAL_MISSING'); assert.equal(channels.length, 1);
  assert.equal(first.readyState, WebSocket.OPEN); assert.equal(channels[0].closes, 0);
});
