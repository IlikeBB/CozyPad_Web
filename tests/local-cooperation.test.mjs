import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../apps/server/src/storage/json-store.mjs';
import { LocalBridge } from '../apps/server/src/local/local-bridge.mjs';
import { HybridProfiles } from '../apps/server/src/local/hybrid-profiles.mjs';
import { HybridConnections } from '../apps/server/src/local/hybrid-connections.mjs';
import { ConnectorFilesystem } from '../tools/local-connector/filesystem.mjs';
import { AgentService } from '../apps/server/src/ssh/agent-service.mjs';
import { SshService } from '../apps/server/src/ssh/ssh-service.mjs';
import { CodexModels } from '../apps/server/src/ssh/codex-models.mjs';
import { RemoteDirectories } from '../apps/server/src/ssh/remote-directories.mjs';
import { DirectoryHistory } from '../apps/server/src/ssh/directory-history.mjs';
import { FilesService } from '../apps/server/src/ssh/files-service.mjs';
import { BrowserDirectory, directoryFromFiles } from '../apps/app/src/workspaces/browser-directory.mjs';
import { browserDirectoryContext, virtualDirectoryPath, displayDirectoryPath } from '../packages/contracts/src/directory-context.mjs';
import { localConnectorFixture } from './helpers/local-connector-fixture.mjs';
import { sshFixture } from './helpers/ssh-fixture.mjs';
import { readCredentials, saveCredentials } from '../tools/local-connector/credentials.mjs';
import { connectorIdentity } from '../apps/server/src/local/connector-package.mjs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import { connectorArchive } from '../scripts/connector-archive.mjs';

const identity = { protocol: 1, release: '4.0.0', payloadHash: 'fixture-payload' };
async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cozypad-tt-local-')), project = path.join(directory, 'project'); await mkdir(project);
  const store = new JsonStore(path.join(directory, 'data')), fixture = await sshFixture({ cwd: '/home/tester' });
  const remote = { find: async (owner, id) => { if (owner !== 'alice' || id !== 'ssh') throw Object.assign(new Error('Not found'), { status: 404 }); return { id, kind: 'ssh', defaultPath: '/home/tester', host: '127.0.0.1', port: fixture.port, username: 'tester', fingerprints: [fixture.fingerprint], credential: fixture.privateKey }; }, list: async owner => owner === 'alice' ? [await remote.find(owner, 'ssh')] : [] };
  const bridge = new LocalBridge(store, identity), profiles = new HybridProfiles(remote, bridge), ssh = new HybridConnections(new SshService(remote, { open: value => ({ privateKey: value }) }), bridge, profiles);
  const server = createServer(); bridge.attach(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `ws://127.0.0.1:${server.address().port}/api/local/bridge`, filesystem = await ConnectorFilesystem.create([project]);
  const connector = await localConnectorFixture(url, identity, filesystem, { code: bridge.pair('alice').code });
  const id = connector.credentials.deviceId, root = filesystem.virtual(project), agents = new AgentService(store, profiles, ssh), files = new FilesService(ssh);
  t.after(async () => { agents.close(); await connector.close(); ssh.close(); await fixture.close(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const wait = async predicate => { const deadline = Date.now() + 10000; while (!predicate()) { if (Date.now() > deadline) throw new Error('Fixture wait timed out'); await new Promise(resolve => setTimeout(resolve, 20)); } };
  const finish = async task => { await wait(() => !agents.active.has(task.id)); return agents.find('alice', task.id); };
  return { directory, project, store, fixture, bridge, profiles, ssh, connector, id, root, agents, files, filesystem, url, wait, finish };
}

test('local connector pairs per user, checks release identity, rejects duplicates and revokes immediately', { timeout: 15000 }, async t => {
  const env = await setup(t), { bridge, id, profiles, url, filesystem, connector } = env;
  assert.equal((await profiles.find('alice', id)).kind, 'local'); assert.equal((await profiles.find('alice', id)).online, true);
  assert.deepEqual(await bridge.list('bob'), []); await assert.rejects(profiles.find('bob', id), error => error.status === 404);
  assert.throws(() => bridge.connection('bob', id), error => error.status === 409);
  const auth = { owner: 'alice', deviceId: id, token: connector.credentials.token };
  await assert.rejects(localConnectorFixture(url, { ...identity, payloadHash: 'wrong' }, filesystem, auth), /rejected/);
  await assert.rejects(localConnectorFixture(url, identity, filesystem, auth), /rejected/);
  assert.equal(bridge.connection('alice', id).id, id);
  const saved = await bridge.devices('alice'); assert.equal(saved[0].token, undefined); assert.equal(saved[0].tokenDigest.length, 64);
  await bridge.remove('alice', id); assert.throws(() => bridge.connection('alice', id)); assert.deepEqual(await bridge.list('alice'), []);
});

test('local pwd history and files use granted roots, never an SSH login or another user scope', { timeout: 15000 }, async t => {
  const { project, root, agents, profiles, files, ssh, id, fixture, filesystem } = await setup(t);
  const sub = path.join(project, 'sub'); await mkdir(sub); await writeFile(path.join(sub, 'note.txt'), 'local content', 'utf8');
  const directories = new RemoteDirectories(files, agents.directories, profiles);
  const selected = await directories.select('alice', id, sub); assert.equal(selected.path, filesystem.virtual(sub));
  assert.equal((await directories.list('alice', id))[0].path, selected.path);
  assert.deepEqual(await agents.directories.list('bob', id), []); await assert.rejects(directories.list('bob', id), error => error.status === 404);
  assert.equal((await files.read('alice', id, 'note.txt', 1024, selected.path)).data.toString(), 'local content');
  assert.equal((await files.list('alice', id, root)).entries[0].name, 'sub');
  await assert.rejects(files.read('alice', id, '../data/auth-users.json'), /outside|sensitive/);
  await assert.rejects(files.read('alice', id, path.join(project, '.env')), /sensitive/);
  const models = await new CodexModels(profiles, ssh).list('alice', id); assert.equal(models[0].model, 'local-fixture');
  assert.equal(fixture.stats.authenticated, 0);
});

test('local and SSH Codex cooperate in both directions; tool submission and resume reuse one SSH authentication', { timeout: 25000 }, async t => {
  const { agents, id, root, fixture, finish } = await setup(t);
  const first = await agents.start('alice', { serverId: id, path: root, prompt: '[cooperate]', executionMode: 'cooperative', cooperationTargetId: 'ssh', cooperationPath: '/home/tester' });
  let saved = await finish(first); assert.equal(saved.status, 'completed'); assert.equal(saved.cooperationToolEnabled, true);
  assert.match(saved.events.find(event => event.type === 'assistant').text, /SSH 測試完成：peer-work/);
  const second = await agents.start('alice', { serverId: 'ssh', prompt: '[cooperate]', executionMode: 'cooperative', cooperationTargetId: id, cooperationPath: root });
  assert.equal((await finish(second)).status, 'completed');
  const children = (await agents.list('alice')).filter(task => task.parentTaskId);
  assert.equal(children.length, 2); assert.ok(children.every(task => task.status === 'completed' && task.executionMode === 'general'));
  assert.equal(fixture.chatRequests.filter(request => request.method === 'thread/start' && request.params.dynamicTools?.length === 3).length, 1);
  const resumed = await agents.start('alice', { serverId: 'ssh', resumeTaskId: second.id, prompt: 'continue', executionMode: 'cooperative' }); saved = await finish(resumed);
  assert.equal(saved.id, second.id); assert.equal(fixture.chatRequests.find(request => request.method === 'thread/resume').params.dynamicTools, undefined);
  assert.equal(fixture.stats.authenticated, 1); assert.equal(fixture.stats.connections, 1);
  await assert.rejects(agents.find('bob', first.id), error => error.status === 404);
  const old = await agents.start('alice', { serverId: id, prompt: 'ordinary' }); await finish(old);
  await assert.rejects(agents.start('alice', { serverId: id, resumeTaskId: old.id, prompt: 'switch', executionMode: 'cooperative', cooperationTargetId: 'ssh' }), error => error.status === 409);
});

test('local Codex output above 4 MB completes without buffering the transport and keeps displayed history bounded', { timeout: 15000 }, async t => {
  const { agents, id, root, fixture, finish } = await setup(t);
  const task = await agents.start('alice', { serverId: id, path: root, prompt: '[large-stream]' });
  const saved = await finish(task);
  assert.equal(saved.status, 'completed', saved.events.filter(event => event.type === 'error' || event.type === 'process').map(event => event.text).join('\n'));
  assert.match(saved.events.find(event => event.type === 'assistant').text, /本機大型串流已完成/);
  assert.ok(saved.events.every(event => event.text.length <= 131072));
  assert.equal(fixture.stats.authenticated, 0);
});

test('browser-only cooperation runs on two owned SSH profiles, reuses both connections and rejects same-target or cross-user work', { timeout: 15000 }, async t => {
  const { fixture, store } = await setup(t);
  const profiles = { find: async (owner, id) => {
    if (owner !== 'alice' || !['primary', 'peer'].includes(id)) throw Object.assign(new Error('Not found'), { status: 404 });
    return { id, defaultPath: '/home/tester', host: '127.0.0.1', port: fixture.port, username: 'tester', fingerprints: [fixture.fingerprint], credential: fixture.privateKey };
  } };
  const ssh = new SshService(profiles, { open: value => ({ privateKey: value }) }), agents = new AgentService(store, profiles, ssh);
  t.after(() => { agents.close(); ssh.close(); });
  await assert.rejects(agents.start('alice', { serverId: 'primary', prompt: 'invalid', executionMode: 'cooperative', cooperationTargetId: 'primary' }), error => error.status === 400);
  await assert.rejects(agents.start('bob', { serverId: 'primary', prompt: 'invalid', executionMode: 'cooperative', cooperationTargetId: 'peer' }), error => error.status === 404);
  assert.equal(fixture.stats.authenticated, 0);
  const task = await agents.start('alice', { serverId: 'primary', prompt: '[cooperate]', executionMode: 'cooperative', cooperationTargetId: 'peer' });
  const deadline = Date.now() + 10000;
  while (agents.active.has(task.id)) { if (Date.now() > deadline) throw new Error('SSH collaboration timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.equal((await agents.find('alice', task.id)).status, 'completed');
  const children = (await agents.list('alice')).filter(child => child.parentTaskId === task.id);
  assert.equal(children.length, 1); assert.equal(children[0].serverId, 'peer'); assert.equal(children[0].status, 'completed');
  assert.equal(fixture.stats.authenticated, 2); assert.equal(fixture.stats.connections, 2);
  await ssh.connect('alice', 'primary'); await ssh.connect('alice', 'peer'); assert.equal(fixture.stats.authenticated, 2);
});

test('cancelling a parent cancels its peer, leaves manual questions unanswered and never resubmits', { timeout: 15000 }, async t => {
  const { agents, id, root, wait, finish, fixture } = await setup(t);
  const parent = await agents.start('alice', { serverId: id, path: root, prompt: '[cooperate][cancel]', executionMode: 'cooperative', cooperationTargetId: 'ssh' });
  await wait(() => [...agents.active.values()].some(runtime => runtime.task.parentTaskId === parent.id && runtime.task.events.some(event => event.type === 'question')));
  const child = [...agents.active.values()].find(runtime => runtime.task.parentTaskId === parent.id).task;
  await agents.cancel('alice', parent.id); assert.equal((await finish(parent)).status, 'cancelled'); assert.equal((await finish(child)).status, 'cancelled');
  assert.equal(fixture.chatRequests.filter(request => request.result?.answers).length, 0); assert.equal(fixture.stats.authenticated, 1);
});

test('file delivery is explicit, bounded, exclusive, hash-verified and deduplicated by durable receipt', { timeout: 15000 }, async t => {
  const { agents, id, root, files, project, fixture } = await setup(t);
  const task = { id: 'parent', turnCount: 1, serverId: id, path: root, cwd: root, status: 'running', executionMode: 'cooperative', approvalMode: 'auto', cooperationTargetId: 'ssh', cooperationPath: '/home/tester', events: [] };
  const runtime = { owner: 'alice', task, abort: new AbortController() };
  await files.ssh.connect('alice', 'ssh'); await writeFile(path.join(project, 'result.txt'), 'verified result', 'utf8');
  const args = { direction: 'to-peer', source: 'result.txt', name: 'delivered.txt' }, call = { tool: 'cozypad_transfer_file', callId: 'delivery-1', arguments: args };
  const receipt = await agents.cooperation.call(runtime, call); assert.equal(receipt.status, 'delivered'); assert.equal(receipt.delivery.sha256.length, 64);
  assert.equal(fixture.fileMap.get('/home/tester/delivered.txt').toString(), 'verified result');
  assert.equal((await agents.cooperation.call(runtime, call)).id, receipt.id);
  await assert.rejects(agents.cooperation.transfer(runtime, args)); assert.equal(fixture.fileMap.get('/home/tester/delivered.txt').toString(), 'verified result');
  await agents.cooperation.transfer(runtime, { direction: 'from-peer', source: 'delivered.txt', name: 'returned.txt' });
  assert.equal(await readFile(path.join(project, 'returned.txt'), 'utf8'), 'verified result');
  await assert.rejects(agents.cooperation.transfer(runtime, { ...args, source: '../outside.txt' }), error => error.status === 403);
  await assert.rejects(agents.cooperation.transfer(runtime, { ...args, name: '.env' }), /Invalid/);
  task.approvalMode = 'ask'; await assert.rejects(agents.cooperation.transfer(runtime, args), error => error.status === 403);
  assert.equal(fixture.stats.authenticated, 1);
});

test('local full access and config overrides are refused by the connector before a turn starts', { timeout: 15000 }, async t => {
  const { agents, id, connector, finish } = await setup(t);
  const task = await agents.start('alice', { serverId: id, prompt: 'should not run', approvalMode: 'full-access' });
  const saved = await finish(task); assert.equal(saved.status, 'failed'); assert.match(saved.events.find(event => event.type === 'error').text, /--allow-full-access/);
  assert.equal(connector.requests.filter(request => request.method === 'codex.write' && request.params.data.includes('"method":"turn/start"')).length, 0);
});

test('browser-local reference metadata is bounded and never implicitly reads file contents', async () => {
  let reads = 0;
  const files = [{ name: 'note.txt', webkitRelativePath: 'project/sub/note.txt', text() { reads++; }, }, { name: '.env', webkitRelativePath: 'project/.env' }];
  const directory = directoryFromFiles(files), first = await directory.read(); assert.equal(reads, 0); assert.equal(first.context.incomplete, true);
  assert.deepEqual(first.context.entries, [{ name: 'sub', kind: 'directory' }]); assert.equal((await directory.read(['sub'])).context.path, 'sub'); assert.equal(reads, 0);
  assert.throws(() => browserDirectoryContext({ rootName: 'project', path: '../secret', entries: [] }));
  assert.equal(virtualDirectoryPath('F:\\project', 'win32'), '/F:/project'); assert.equal(displayDirectoryPath('/F:/project', 'win32'), 'F:\\project');
  const controller = new AbortController(); controller.abort(); await assert.rejects(directory.read([], controller.signal), error => error.name === 'AbortError');
  assert.throws(() => new BrowserDirectory({ name: '.ssh', kind: 'directory' }));
});

test('pwd history persists and caps each owner/target without polluting other targets', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cozypad-tt-pwd-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonStore(directory), history = new DirectoryHistory(store);
  for (let index = 0; index < 25; index++) await history.remember('alice', 'one', `/project/${index}`);
  await history.remember('alice', 'one', '/project/20');
  assert.equal((await new DirectoryHistory(store).list('alice', 'one')).length, 20); assert.equal((await history.list('alice', 'one'))[0].path, '/project/20');
  assert.deepEqual(await history.list('alice', 'two'), []); assert.deepEqual(await history.list('bob', 'one'), []);
});

test('local credentials round-trip atomically and Windows stores DPAPI ciphertext, not a plain token', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cozypad-tt-credentials-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'fixture.auth'), credentials = { owner: 'fixture', deviceId: 'local-fixture', token: 'not-a-real-credential' };
  assert.equal(await readCredentials(file), null); await saveCredentials(file, credentials); assert.deepEqual(await readCredentials(file), credentials);
  if (process.platform === 'win32') assert.equal((await readFile(file)).includes(Buffer.from(credentials.token)), false);
  await saveCredentials(file, { ...credentials, token: 'replacement-fixture' }); assert.equal((await readCredentials(file)).token, 'replacement-fixture');
});

test('connector download archive contains only the explicit tool payload and matches the runtime identity', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url)), identity = await connectorIdentity(root);
  const archive = await JSZip.loadAsync((await connectorArchive(root)).data);
  const manifest = JSON.parse(await archive.file('connector-manifest.json').async('string'));
  assert.equal(manifest.payloadHash, identity.payloadHash);
  for (const [file, expected] of Object.entries(identity.hashes)) assert.equal(crypto.createHash('sha256').update(await archive.file(file).async('nodebuffer')).digest('hex'), expected);
  assert.equal(Object.values(archive.files).filter(file => !file.dir).length, Object.keys(identity.hashes).length + 2);
  assert.equal(Object.keys(archive.files).some(file => file.startsWith('data/') || file === '.env'), false);
});
