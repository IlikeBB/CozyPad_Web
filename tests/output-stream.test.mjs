import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExecOutput } from '../apps/server/src/ssh/exec-output.mjs';
import { ProtocolLines } from '../packages/contracts/src/codex-protocol-lines.mjs';
import { SshService } from '../apps/server/src/ssh/ssh-service.mjs';
import { AgentService } from '../apps/server/src/ssh/agent-service.mjs';
import { JsonStore } from '../apps/server/src/storage/json-store.mjs';
import { sshFixture } from './helpers/ssh-fixture.mjs';

test('streamed exec delivers more than 4 MB without accumulating stdout/stderr, while ordinary exec remains byte-bounded', () => {
  let bytes = 0;
  const streamed = new ExecOutput({ collectOutput: false, onData: text => { bytes += Buffer.byteLength(text); } });
  const block = '輸出' + 'a'.repeat(65536);
  for (let index = 0; index < 100; index++) streamed.receive(block, index % 2 ? 'stderr' : 'stdout');
  assert.ok(bytes > 4 * 1024 * 1024); assert.deepEqual(streamed.result(0), { stdout: '', stderr: '', code: 0 });
  assert.throws(() => new ExecOutput({ collectOutput: false }), error => error.status === 400);
  const captured = new ExecOutput();
  captured.receive('a'.repeat(2 * 1024 * 1024), 'stdout'); captured.receive('b'.repeat(2 * 1024 * 1024), 'stderr');
  assert.throws(() => captured.receive('中', 'stdout'), error => error.status === 413);
});

test('protocol framing handles many small records, Unicode fragments, multiple lines and bounds only the pending record', () => {
  const lines = new ProtocolLines(1024); let count = 0;
  const record = JSON.stringify({ text: '中文' + 'x'.repeat(512) });
  for (let index = 0; index < 12000; index++) {
    lines.write(record.slice(0, 15), () => { throw new Error('Partial record must not be delivered'); });
    lines.write(record.slice(15) + '\n', text => { assert.equal(text, record); count++; });
  }
  assert.equal(count, 12000); assert.equal(lines.bytes, 0); assert.equal(lines.parts.length, 0);
  const small = new ProtocolLines(9), found = [];
  small.write('中文', line => found.push(line)); small.write('字\nA\n', line => found.push(line));
  assert.deepEqual(found, ['中文字', 'A']);
  assert.throws(() => small.write('中文文字', () => {}), error => error.status === 413);
  assert.equal(small.bytes, 0); assert.equal(small.parts.length, 0);
});

test('SSH consumer failures close only their exec channel and reject without crashing or accepting a synchronous close', async () => {
  const channel = new EventEmitter(); channel.stderr = new EventEmitter(); channel.end = () => {};
  let closed = 0; channel.close = () => { closed++; channel.emit('close', 0); };
  const ssh = new SshService({}, {}); ssh.connectedClient = async () => ({ exec: (_command, callback) => callback(null, channel) });
  await assert.rejects(ssh.exec('alice', 'test', 'test', { collectOutput: false, onChannel: () => queueMicrotask(() => channel.emit('data', Buffer.from('data'))), onData: () => { throw new Error('consumer rejected'); } }), /consumer rejected/);
  assert.equal(closed, 1);
});

test('SSH UTF-8 fragments are decoded and the final partial code point is flushed on channel close', async () => {
  const channel = new EventEmitter(); channel.stderr = new EventEmitter(); channel.end = () => {}; channel.close = () => {};
  const ssh = new SshService({}, {}); ssh.connectedClient = async () => ({ exec: (_command, callback) => callback(null, channel) });
  const result = await ssh.exec('alice', 'test', 'test', { onChannel: () => queueMicrotask(() => {
    const bytes = Buffer.from('中文'); channel.emit('data', bytes.subarray(0, 1)); channel.emit('data', bytes.subarray(1));
    channel.stderr.emit('data', Buffer.from([0xe4])); channel.emit('close', 0);
  }) });
  assert.equal(result.stdout, '中文'); assert.equal(result.stderr, '\ufffd');
});

test('real SSH output above 4 MB completes a Codex turn, keeps history bounded and reuses authentication after ordinary exec overflows', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cozypad-stream-test-'));
  const fixture = await sshFixture(), store = new JsonStore(directory);
  const profiles = { find: async () => ({ id: 'test', defaultPath: '~', host: '127.0.0.1', port: fixture.port, username: 'tester', fingerprints: [fixture.fingerprint], credential: fixture.privateKey }) };
  const ssh = new SshService(profiles, { open: value => ({ privateKey: value }) }), agents = new AgentService(store, profiles, ssh);
  t.after(async () => {
    agents.close(); ssh.close(); await fixture.close();
    const checked = path.resolve(directory); assert.ok(checked.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(checked).startsWith('cozypad-stream-test-'));
    await rm(checked, { recursive: true, force: true });
  });
  await ssh.connect('alice', 'test');
  await assert.rejects(ssh.exec('alice', 'test', 'fixture-bulk-output'), error => error.status === 413 && error.message.includes('4 MB'));
  let bytes = 0, tail = '';
  const streamed = await ssh.exec('alice', 'test', 'fixture-bulk-output', { collectOutput: false, onData: text => { bytes += Buffer.byteLength(text); tail = (tail + text).slice(-100); } });
  assert.ok(bytes > 4 * 1024 * 1024); assert.match(tail, /末尾標記/); assert.equal(streamed.stdout, '');
  const task = await agents.start('alice', { serverId: 'test', prompt: '[large-stream]' });
  const deadline = Date.now() + 15000;
  while (agents.active.has(task.id)) { assert.ok(Date.now() < deadline, 'Large Codex stream must finish'); await new Promise(resolve => setTimeout(resolve, 20)); }
  const completed = await agents.find('alice', task.id);
  assert.equal(completed.status, 'completed');
  assert.match(completed.events.find(event => event.type === 'assistant').text, /後續回覆仍可收到/);
  assert.ok(completed.events.every(event => event.text.length <= 131072));
  assert.equal(fixture.stats.authenticated, 1);
  assert.equal(fixture.chatRequests.filter(request => request.method === 'turn/start').length, 1);
  assert.match((await ssh.exec('alice', 'test', 'hostname')).stdout, /fixture-linux/);
});
