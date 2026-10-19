import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { TerminalSessions } from '../apps/server/src/ssh/terminal-sessions.mjs';

class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; packets = [];
  send(raw, callback) { this.packets.push(JSON.parse(raw)); callback?.(); }
  close(code = 1000) { this.readyState = 3; this.code = code; this.emit('close'); }
  terminate() { this.close(1006); }
}
class Channel extends EventEmitter {
  stderr = new EventEmitter(); writes = []; closes = 0;
  write(data) { this.writes.push(data); }
  close() { this.closes++; this.emit('close'); }
}
function fixture(options = {}) {
  const channels = [];
  const ssh = { shell: async () => { const channel = new Channel(); channels.push(channel); return channel; } };
  const profiles = { find: async () => ({ defaultPath: '/home/tester' }) };
  return { channels, sessions: new TerminalSessions(ssh, profiles, options) };
}

test('a transport drop retains the original shell and replays only unseen output in sequence', async t => {
  const { sessions, channels } = fixture(); t.after(() => sessions.close());
  const first = new Socket(), terminal = await sessions.attach('Alice', 'server-a', first);
  channels[0].emit('data', Buffer.from('already visible\r\n'));
  const sequence = terminal.sequence;
  first.close(1006);
  assert.equal(channels[0].closes, 0);
  channels[0].emit('data', Buffer.from('while offline\r\n'));
  channels[0].stderr.emit('data', Buffer.from('offline error\r\n'));
  const resumed = new Socket();
  assert.equal(await sessions.attach('alice', 'server-a', resumed, { sessionId: terminal.id, after: sequence }), terminal);
  assert.equal(channels.length, 1);
  assert.deepEqual(channels[0].writes, ["cd '/home/tester'\r"]);
  assert.deepEqual(resumed.packets.filter(packet => packet.type === 'output').map(packet => packet.data), ['while offline\r\n', 'offline error\r\n']);
  assert.equal(resumed.packets.at(-1).resumed, true);
  assert.equal(resumed.packets.at(-1).sessionId, terminal.id);
  channels[0].emit('data', Buffer.from('live again\r\n'));
  assert.equal(resumed.packets.at(-1).sequence, sequence + 3);
});

test('resume is isolated by owner and server and never creates a replacement shell for a missing session', async t => {
  const { sessions, channels } = fixture(); t.after(() => sessions.close());
  const terminal = await sessions.attach('alice', 'server-a', new Socket());
  for (const [owner, serverId, sessionId] of [['bob', 'server-a', terminal.id], ['alice', 'server-b', terminal.id], ['alice', 'server-a', 'missing']]) {
    await assert.rejects(sessions.attach(owner, serverId, new Socket(), { sessionId }), { code: 'TERMINAL_MISSING' });
  }
  assert.equal(channels.length, 1);
});

test('an obsolete socket closing cannot detach its replacement and replay memory is bounded', async t => {
  const { sessions, channels } = fixture({ maxReplayBytes: 16, maxReplayPackets: 3 }); t.after(() => sessions.close());
  const first = new Socket(), terminal = await sessions.attach('alice', 'server-a', first);
  for (let i = 0; i < 12; i++) channels[0].emit('data', Buffer.from('中文'));
  assert.ok(terminal.bytes <= 16); assert.ok(terminal.packets.length <= 3);
  const second = new Socket(); await sessions.attach('alice', 'server-a', second, { sessionId: terminal.id });
  assert.equal(first.code, 4009);
  assert.equal(terminal.ws, second); assert.equal(channels[0].closes, 0);
  assert.equal(second.packets[0].type, 'notice');
  channels[0].emit('data', Buffer.from('new'));
  assert.equal(second.packets.at(-1).data, 'new');
});

test('detached sessions expire, while explicit release and shell exit dispose immediately', async t => {
  const { sessions, channels } = fixture({ detachMs: 30 }); t.after(() => sessions.close());
  const first = new Socket(), terminal = await sessions.attach('alice', 'server-a', first);
  first.close(1006); await delay(60);
  assert.equal(channels[0].closes, 1); assert.equal(sessions.sessions.size, 0);
  await assert.rejects(sessions.attach('alice', 'server-a', new Socket(), { sessionId: terminal.id }), { code: 'TERMINAL_MISSING' });
  const second = new Socket(), next = await sessions.attach('alice', 'server-a', second);
  sessions.dispose(next); assert.equal(channels[1].closes, 1); assert.equal(second.readyState, 3);
  const third = new Socket(); await sessions.attach('alice', 'server-a', third);
  channels[2].emit('close'); assert.equal(third.packets.at(-1).type, 'ended'); assert.equal(sessions.sessions.size, 0);
});

test('a pending shell is closed if its disconnected session expires before creation completes', async t => {
  let resolveShell;
  const channel = new Channel();
  const sessions = new TerminalSessions({ shell: () => new Promise(resolve => { resolveShell = resolve; }) }, { find: async () => ({}) }, { detachMs: 20 });
  t.after(() => sessions.close());
  const socket = new Socket(), opening = sessions.attach('alice', 'server-a', socket);
  const rejected = assert.rejects(opening, { code: 'TERMINAL_MISSING' });
  await delay(1); socket.close(1006); await delay(40); resolveShell(channel);
  await rejected; assert.equal(channel.closes, 1); assert.equal(sessions.sessions.size, 0);
});

test('failed shell creation releases capacity and detached sessions count toward the limit', async t => {
  const broken = new TerminalSessions({ shell: async () => { throw Object.assign(new Error('SSH disconnected'), { code: 'SSH_DISCONNECTED' }); } }, { find: async () => ({}) });
  await assert.rejects(broken.attach('alice', 'server-a', new Socket()), { code: 'SSH_DISCONNECTED' });
  assert.equal(broken.sessions.size, 0);
  const { sessions, channels } = fixture({ maxPerOwner: 1 }); t.after(() => sessions.close());
  const socket = new Socket(); await sessions.attach('alice', 'server-a', socket); socket.close(1006);
  await assert.rejects(sessions.attach('alice', 'server-b', new Socket()), { code: 'TERMINAL_LIMIT' }); assert.equal(channels.length, 1);
});
