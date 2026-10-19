import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../apps/server/src/storage/json-store.mjs';
import { KeyVault } from '../apps/server/src/storage/key-vault.mjs';
import { ProfileRepository } from '../apps/server/src/ssh/profile-repository.mjs';
import { SshService, quoteShell, remoteDirectory } from '../apps/server/src/ssh/ssh-service.mjs';
import { FilesService } from '../apps/server/src/ssh/files-service.mjs';
import { AgentService } from '../apps/server/src/ssh/agent-service.mjs';
import { CodexModels, runOptions } from '../apps/server/src/ssh/codex-models.mjs';
import { codexChatCommand } from '../apps/server/src/ssh/remote-shell.mjs';
import { approvalSettings } from '../apps/server/src/ssh/approval-settings.mjs';
import { sshFixture } from './helpers/ssh-fixture.mjs';

test('shell paths quote spaces and embedded quotes without expanding commands', () => {
  assert.equal(quoteShell("a'b"), "'a'\"'\"'b'");
  assert.equal(remoteDirectory('~/my project'), '"$HOME"/\'my project\'');
  assert.match(codexChatCommand('~/my project'), /codex app-server/);
  assert.match(codexChatCommand('~'), /__COZYPAD_CWD__/);
  assert.deepEqual(runOptions({ model: '', reasoningEffort: '' }), {});
  assert.deepEqual(runOptions({ model: 'provider/model-v4', reasoningEffort: 'high' }), { model: 'provider/model-v4', reasoningEffort: 'high' });
  for (const model of ['bad;command', '--model', '$(id)', 'a\nb', 'a'.repeat(129), {}]) assert.throws(() => runOptions({ model }), error => error.status === 400);
  assert.throws(() => runOptions({ reasoningEffort: 'high;id' }), error => error.status === 400);
  assert.deepEqual(approvalSettings(), { sandbox: 'workspace-write', approvalPolicy: 'on-request' });
  assert.deepEqual(approvalSettings('ask'), { sandbox: 'read-only', approvalPolicy: 'untrusted' });
  assert.deepEqual(approvalSettings('full-access'), { sandbox: 'danger-full-access', approvalPolicy: 'never' });
  for (const mode of ['constructor', 'danger-full-access', null, {}, 'workspaceWrite']) assert.throws(() => approvalSettings(mode), error => error.status === 400);
});
test('isolated profiles, host-key approval, SSH execution, SFTP and Codex streaming', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cozypad-tt-ssh-'));
  const fixture = await sshFixture();
  const store = new JsonStore(directory), vault = new KeyVault(directory); await vault.initialize();
  const profiles = new ProfileRepository(store, vault), ssh = new SshService(profiles, vault);
  t.after(async () => { ssh.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); });
  const profile = await profiles.save('alice', { name: 'test', host: '127.0.0.1', username: 'tester', port: fixture.port, defaultPath: '~', privateKey: fixture.privateKey, keyName: 'test.pem' });
  assert.equal(profile.hasKey, true); assert.equal(profile.privateKey, undefined);
  assert.equal((await profiles.list('bob')).length, 0);
  await assert.rejects(profiles.find('bob', profile.id), /找不到/);
  await assert.rejects(profiles.delete('bob', profile.id), /找不到/);
  assert.ok(!(await readFile(store.resolve(profiles.file('alice')), 'utf8')).includes('PRIVATE KEY'));
  await assert.rejects(ssh.connect('alice', profile.id), error => error.code === 'HOST_KEY' && error.fingerprint === fixture.fingerprint);
  await ssh.trust('alice', profile.id, fixture.fingerprint);
  await ssh.connect('alice', profile.id);
  const connections = fixture.stats.connections;
  const reused = await Promise.all([ssh.connect('alice', profile.id), ssh.connect('alice', profile.id), ssh.connect('alice', profile.id)]);
  assert.ok(reused.every(client => client === reused[0]));
  assert.match((await ssh.exec('alice', profile.id, 'hostname')).stdout, /fixture-linux/);
  const files = new FilesService(ssh);
  const listing = await files.list('alice', profile.id, '~'); assert.equal(listing.path, '/home/tester'); assert.equal(listing.entries[0].name, 'readme.txt');
  assert.equal((await files.read('alice', profile.id, '~/readme.txt')).data.toString(), 'CozyPad test file\n');
  await files.write('alice', profile.id, '~/readme.txt', 'Updated\n'); assert.equal(fixture.fileMap.get('/home/tester/readme.txt').toString(), 'Updated\n');
  const agent = new AgentService(store, profiles, ssh);
  const catalog = new CodexModels(profiles, ssh);
  await assert.rejects(catalog.list('bob', profile.id), /找不到/);
  const models = await catalog.list('alice', profile.id);
  assert.deepEqual(models.map(item => item.model), ['fixture-codex', 'fixture-fast']);
  assert.deepEqual(models[0].reasoningEfforts, ['low', 'medium', 'high']);
  assert.deepEqual(fixture.modelRequests.map(item => item.method), ['initialize', 'initialized', 'model/list', 'model/list']);
  await assert.rejects(agent.start('alice', { serverId: profile.id, prompt: 'test', model: 'bad;command' }), error => error.status === 400);
  const task = await agent.start('alice', { serverId: profile.id, prompt: 'test task', model: 'fixture-codex', reasoningEffort: 'high' });
  const streamed = [];
  agent.events.on(task.id, event => streamed.push(event));
  await assert.rejects(agent.start('alice', { serverId: profile.id, prompt: 'duplicate', resumeTaskId: task.id }), error => error.status === 409);
  await assert.rejects(agent.delete('alice', task.id), error => error.status === 409);
  await new Promise(resolve => { agent.events.on(task.id, event => { if (event.type === 'status') resolve(); }); });
  await new Promise(resolve => setTimeout(resolve, 100));
  const finished = await agent.find('alice', task.id);
  assert.equal(finished.status, 'completed'); assert.equal(finished.threadId, 'test-thread-01');
  assert.equal(finished.model, 'fixture-codex'); assert.equal(finished.reasoningEffort, 'high');
  assert.equal(fixture.commands.at(-1), codexChatCommand('~'));
  assert.equal(fixture.chatRequests.find(item => item.method === 'turn/start').params.model, 'fixture-codex');
  assert.equal(fixture.chatRequests.find(item => item.method === 'turn/start').params.effort, 'high');
  assert.equal(fixture.chatRequests.find(item => item.method === 'thread/start').params.sandbox, 'workspace-write');
  assert.equal(fixture.chatRequests.find(item => item.method === 'thread/start').params.approvalPolicy, 'on-request');
  const replies = streamed.filter(event => event.type === 'assistant');
  assert.ok(replies.some(event => event.text === 'SSH '));
  assert.ok(replies.some(event => event.text === 'SSH 測試完成：test task'));
  assert.equal(finished.events.filter(event => event.type === 'assistant').length, 1);
  assert.ok(finished.events.some(event => event.type === 'command')); assert.ok(finished.events.some(event => event.type === 'assistant' && event.text.includes('SSH 測試完成')));
  assert.equal((await agent.list('bob')).length, 0);
  await assert.rejects(agent.find('bob', task.id), /找不到/);
  const resumed = await agent.start('alice', { serverId: profile.id, prompt: 'continue', resumeTaskId: task.id, model: 'fixture-fast' });
  await new Promise(resolve => { agent.events.on(resumed.id, event => { if (event.type === 'status') resolve(); }); });
  assert.equal(resumed.id, task.id);
  assert.equal(fixture.chatRequests.find(item => item.method === 'thread/resume').params.threadId, 'test-thread-01');
  assert.equal(fixture.chatRequests.find(item => item.method === 'thread/resume').params.sandbox, 'workspace-write');
  const conversation = await agent.find('alice', resumed.id);
  assert.equal(conversation.model, 'fixture-fast'); assert.equal(conversation.turnCount, 2);
  assert.deepEqual(conversation.events.filter(event => event.type === 'user').map(event => event.text), ['test task', 'continue']);
  assert.equal(conversation.events.filter(event => event.type === 'assistant').length, 2);
  assert.equal((await new AgentService(store, profiles, ssh).list('alice')).length, 1);
  const stopTask = await agent.start('alice', { serverId: profile.id, prompt: 'stop this', resumeTaskId: task.id });
  await new Promise(resolve => { const listener = event => { if (event.type === 'assistant' && event.text === 'SSH ') { agent.events.off(stopTask.id, listener); resolve(); } }; agent.events.on(stopTask.id, listener); });
  const stopped = new Promise(resolve => { const listener = event => { if (event.type === 'status') { agent.events.off(task.id, listener); resolve(); } }; agent.events.on(task.id, listener); });
  await agent.cancel('alice', stopTask.id); await stopped;
  assert.equal((await agent.find('alice', task.id)).status, 'cancelled');
  assert.ok(fixture.chatRequests.some(item => item.method === 'turn/interrupt'));
  const rollout = fixture.threads.get(finished.threadId).rolloutPath;
  assert.ok(fixture.rollouts.has(rollout));
  await agent.delete('alice', task.id);
  assert.equal((await new AgentService(store, profiles, ssh).list('alice')).length, 0);
  assert.equal(fixture.rollouts.has(rollout), false);
  assert.equal(fixture.threads.has(finished.threadId), false);
  assert.equal(fixture.fileMap.get('/home/tester/readme.txt').toString(), 'Updated\n');
  assert.deepEqual(fixture.cleanupRequests.map(request => request.method), ['initialize', 'initialized', 'thread/delete']);
  assert.deepEqual(fixture.cleanupRequests.at(-1).params, { threadId: finished.threadId });
  assert.equal(fixture.stats.connections, connections);
  assert.equal(fixture.stats.authenticated, 1);
  const result = await profiles.importConfig('alice', { rawConfig: 'Host copied\n HostName 127.0.0.1\n IdentityFile "~/.ssh/test.pem"\nHost *\n User tester\n Port 22' });
  assert.equal(result.imported, 1); assert.equal(result.profiles.find(item => item.name === 'copied').hasKey, true);
  assert.equal((await profiles.list('bob')).length, 0);
  const skipped = await profiles.importConfig('bob', { rawConfig: 'Host jump\n HostName test\n User tester\n ProxyJump bastion' }); assert.equal(skipped.skipped, 1);
  await profiles.save('alice', { ...profile, name: 'edited' }); assert.equal((await profiles.find('alice', profile.id)).name, 'edited');
  assert.equal((await profiles.find('alice', profile.id)).credential != null, true);
  await profiles.delete('alice', profile.id); assert.equal((await profiles.list('alice')).length, 1);
});

test('approval presets and per-action decisions preserve ownership, history and one SSH connection', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cozypad-tt-approval-'));
  const fixture = await sshFixture(), store = new JsonStore(directory);
  const profiles = { find: async () => ({ id: 'test', defaultPath: '~', host: '127.0.0.1', port: fixture.port, username: 'tester', fingerprints: [fixture.fingerprint], credential: fixture.privateKey }) };
  const ssh = new SshService(profiles, { open: value => ({ privateKey: value }) }), agent = new AgentService(store, profiles, ssh);
  t.after(async () => { agent.close(); ssh.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); });
  const finish = id => new Promise(resolve => { const listener = event => { if (event.type === 'status') { agent.events.off(id, listener); resolve(); } }; agent.events.on(id, listener); });
  const approval = id => new Promise(resolve => { const listener = event => { if (event.type === 'approval' && JSON.parse(event.text).status === 'pending') { agent.events.off(id, listener); resolve(JSON.parse(event.text)); } }; agent.events.on(id, listener); });
  await assert.rejects(agent.start('alice', { serverId: 'test', prompt: 'test', approvalMode: 'invalid' }), error => error.status === 400);
  assert.equal(fixture.stats.connections, 0);
  const task = await agent.start('alice', { serverId: 'test', prompt: '[approval]', approvalMode: 'ask' });
  const first = await approval(task.id);
  assert.equal(first.kind, 'command'); assert.equal(first.command, 'fixture-command');
  await assert.rejects(agent.approve('bob', task.id, { requestId: first.id, decision: 'accept' }), error => error.status === 404);
  await assert.rejects(agent.approve('alice', task.id, { requestId: first.id, decision: 'acceptForSession' }), error => error.status === 400);
  await assert.rejects(agent.approve('alice', task.id, { requestId: 'missing', decision: 'accept' }), error => error.status === 409);
  const completed = finish(task.id);
  await agent.approve('alice', task.id, { requestId: first.id, decision: 'accept' });
  await assert.rejects(agent.approve('alice', task.id, { requestId: first.id, decision: 'accept' }), error => error.status === 409);
  await completed;
  assert.equal((await agent.find('alice', task.id)).status, 'completed');
  assert.deepEqual(fixture.chatRequests.find(request => request.method === 'thread/start').params.approvalPolicy, 'untrusted');
  assert.equal(fixture.chatRequests.find(request => request.method === 'thread/start').params.sandbox, 'read-only');
  const next = await agent.start('alice', { serverId: 'test', prompt: '[file-approval]', approvalMode: 'auto', resumeTaskId: task.id });
  const file = await approval(next.id);
  assert.equal(file.kind, 'file-change'); assert.equal(file.grantRoot, '/tmp'); assert.equal(file.changes[0].path, '/tmp/fixture.txt'); assert.equal(file.changes[0].diff, '+test change');
  const declined = finish(task.id); await agent.approve('alice', task.id, { requestId: file.id, decision: 'decline' }); await declined;
  const full = await agent.start('alice', { serverId: 'test', prompt: '[approval]', approvalMode: 'full-access', resumeTaskId: task.id }); await finish(full.id);
  const final = await agent.find('alice', task.id);
  const requests = final.events.filter(event => event.type === 'approval').map(event => JSON.parse(event.text));
  assert.deepEqual(requests.map(request => request.status), ['accepted', 'declined']);
  assert.equal(final.turnCount, 3); assert.equal(final.approvalMode, 'full-access');
  assert.equal(fixture.chatRequests.filter(request => request.method === 'thread/resume').at(-1).params.sandbox, 'danger-full-access');
  assert.equal(fixture.chatRequests.filter(request => request.method === 'thread/resume').at(-1).params.approvalPolicy, 'never');
  const cancelled = await agent.start('alice', { serverId: 'test', prompt: '[approval]', approvalMode: 'ask', resumeTaskId: task.id });
  const pending = await approval(cancelled.id), stopped = finish(cancelled.id);
  await agent.cancel('alice', cancelled.id); await stopped;
  await assert.rejects(agent.approve('alice', task.id, { requestId: pending.id, decision: 'accept' }), error => error.status === 409);
  assert.equal(JSON.parse((await agent.find('alice', task.id)).events.filter(event => event.type === 'approval').at(-1).text).status, 'cancelled');
  assert.equal(fixture.stats.connections, 1); assert.equal(fixture.stats.authenticated, 1);
  assert.deepEqual(fixture.chatRequests.filter(request => !request.method && request.result?.decision).map(request => request.result.decision), ['accept', 'decline']);
});

test('SSH authentication attempts are serialized per endpoint with escalating cooldown', { timeout: 10000 }, async t => {
  const fixture = await sshFixture();
  let now = 100000;
  const profiles = { find: async (owner, id) => ({ id, host: '127.0.0.1', port: fixture.port, username: id === 'working' ? 'tester' : 'invalid-user', fingerprints: [fixture.fingerprint], credential: fixture.privateKey }) };
  const ssh = new SshService(profiles, { open: value => ({ privateKey: value }) }, { now: () => now });
  t.after(async () => { ssh.close(); await fixture.close(); });
  const working = await ssh.connect('alice', 'working');
  const attempts = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => ssh.connect(index % 2 ? 'alice' : 'bob', `invalid-${index}`)));
  assert.equal(attempts.filter(result => result.reason?.status === 502).length, 1);
  assert.equal(attempts.filter(result => result.reason?.code === 'SSH_COOLDOWN').length, 19);
  assert.equal(fixture.stats.connections, 2);
  assert.equal(await ssh.connect('alice', 'working'), working);
  assert.match((await ssh.exec('alice', 'working', 'hostname')).stdout, /fixture-linux/);
  await assert.rejects(ssh.connect('carol', 'another'), error => error.code === 'SSH_COOLDOWN');
  assert.equal(fixture.stats.connections, 2);
  now += 30001;
  await assert.rejects(ssh.connect('bob', 'invalid'), error => error.status === 502);
  assert.equal(fixture.stats.connections, 3);
  now += 30001;
  await assert.rejects(ssh.connect('bob', 'invalid'), error => error.code === 'SSH_COOLDOWN');
  assert.equal(fixture.stats.connections, 3);
  now += 30001;
  await assert.rejects(ssh.connect('bob', 'invalid'), error => error.status === 502);
  assert.equal(fixture.stats.connections, 4);
  assert.equal(fixture.stats.authenticated, 1);
  ssh.disconnect('alice', 'working');
  now += 300001;
  const background = await Promise.allSettled([
    ssh.exec('alice', 'working', 'hostname'), ssh.sftp('alice', 'working'), ssh.shell('alice', 'working', { cols: 80, rows: 24 }),
    new CodexModels(profiles, ssh).list('alice', 'working')
  ]);
  assert.ok(background.every(result => result.status === 'rejected' && result.reason.code === 'SSH_DISCONNECTED'));
  assert.equal(fixture.stats.connections, 4);
  await ssh.connect('alice', 'working');
  assert.equal(fixture.stats.connections, 5);
});

test('failed and interrupted remote streams stay in the same persisted conversation', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cozypad-tt-failed-chat-'));
  const fixture = await sshFixture(), store = new JsonStore(directory);
  const profiles = { find: async () => ({ id: 'test', defaultPath: '~', host: '127.0.0.1', port: fixture.port, username: 'tester', fingerprints: [fixture.fingerprint], credential: fixture.privateKey }) };
  const ssh = new SshService(profiles, { open: value => ({ privateKey: value }) });
  const agent = new AgentService(store, profiles, ssh);
  t.after(async () => { agent.close(); ssh.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); });
  const finish = id => new Promise(resolve => { const listener = event => { if (event.type === 'status') { agent.events.off(id, listener); resolve(); } }; agent.events.on(id, listener); });
  const failed = await agent.start('alice', { serverId: 'test', prompt: '[fail]' }); await finish(failed.id);
  assert.equal((await agent.find('alice', failed.id)).status, 'failed');
  assert.ok((await agent.find('alice', failed.id)).events.some(event => event.type === 'error' && event.text.includes('fixture turn failed')));
  const interrupted = await agent.start('alice', { serverId: 'test', prompt: '[disconnect]', resumeTaskId: failed.id }); await finish(interrupted.id);
  assert.equal((await agent.find('alice', failed.id)).status, 'failed');
  const retried = await agent.start('alice', { serverId: 'test', prompt: 'try again', resumeTaskId: failed.id }); await finish(retried.id);
  const history = await new AgentService(store, profiles, ssh).list('alice');
  assert.equal(history.length, 1); assert.equal(history[0].id, failed.id); assert.equal(history[0].turnCount, 3); assert.equal(history[0].status, 'completed');
  assert.equal(history[0].threadId, 'test-thread-01');
  assert.deepEqual(history[0].events.filter(event => event.type === 'user').map(event => event.text), ['[fail]', '[disconnect]', 'try again']);
  assert.equal(fixture.stats.connections, 1); assert.equal(fixture.stats.authenticated, 1);
});

test('legacy per-turn tasks migrate into conversations without changing the source file', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cozypad-tt-chats-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonStore(directory);
  const legacy = [
    { id: 'second', serverId: 's1', threadId: 'shared', prompt: 'second question', createdAt: 200, status: 'completed', path: '~', events: [{ id: 1, type: 'assistant', text: 'second reply', time: 210 }] },
    { id: 'first', serverId: 's1', threadId: 'shared', prompt: 'first question', createdAt: 100, status: 'completed', path: '~', events: [{ id: 1, type: 'assistant', text: 'first reply', time: 110 }] },
    { id: 'isolated', serverId: 's2', threadId: 'shared', prompt: 'other server', createdAt: 300, status: 'running', path: '~', events: [] }
  ];
  await store.write(store.userPath('alice', 'codex-tasks.json'), legacy);
  const agent = new AgentService(store, {}, {}), tasks = await agent.list('alice');
  assert.equal(tasks.length, 2);
  const chat = await agent.find('alice', 'second');
  assert.equal(chat.id, 'first'); assert.equal(chat.turnCount, 2);
  assert.deepEqual(chat.events.map(event => event.text), ['first question', 'first reply', 'second question', 'second reply']);
  assert.equal(tasks.find(item => item.id === 'isolated').status, 'failed');
  assert.deepEqual(await store.read(store.userPath('alice', 'codex-tasks.json'), []), legacy);
  assert.equal((await agent.list('bob')).length, 0);
  await assert.rejects(agent.find('bob', 'first'), /找不到/);
});

test('model discovery reports remote protocol errors and does not start a task', async t => {
  const fixture = await sshFixture({ modelError: true });
  const profiles = { find: async () => ({ id: 'test' }) };
  const ssh = new SshService({ find: async () => ({ id: 'test', host: '127.0.0.1', port: fixture.port, username: 'tester', fingerprints: [fixture.fingerprint], credential: fixture.privateKey }) }, { open: value => ({ privateKey: value }) });
  t.after(async () => { ssh.close(); await fixture.close(); });
  await ssh.connect('alice', 'test');
  await assert.rejects(new CodexModels(profiles, ssh).list('alice', 'test'), /fixture catalog unavailable/);
  assert.equal(fixture.chatRequests.length, 0);
});

test('deleting saved conversations is owner-isolated, persistent and serialized with resume', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cozypad-tt-delete-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonStore(directory);
  let connections = 0;
  const profiles = { find: async () => ({ id: 'server', defaultPath: '~' }) };
  const ssh = { connect: async () => { connections++; throw new Error('Unexpected SSH connection'); } };
  const agent = new AgentService(store, profiles, ssh);
  const saved = (id, status) => ({ id, status, serverId: 'server', prompt: id, path: '~', createdAt: 1, events: [] });
  for (const status of ['completed', 'failed', 'cancelled']) await agent.chats.save('alice', saved(status, status));
  await agent.chats.save('bob', saved('completed', 'completed'));
  await assert.rejects(agent.delete('bob', 'failed'), error => error.status === 404);
  const finalizing = saved('cancelled', 'cancelled');
  agent.active.set(finalizing.id, { owner: 'alice', task: finalizing });
  await assert.rejects(agent.delete('alice', finalizing.id), error => error.status === 409);
  agent.active.delete(finalizing.id);
  const [removed, resumed] = await Promise.allSettled([
    agent.delete('alice', 'completed'),
    agent.start('alice', { serverId: 'server', prompt: 'resume', resumeTaskId: 'completed' })
  ]);
  assert.equal(removed.status, 'fulfilled');
  assert.equal(resumed.status, 'rejected'); assert.equal(resumed.reason.status, 404);
  await assert.rejects(agent.delete('alice', 'completed'), error => error.status === 404);
  await agent.delete('alice', 'failed'); await agent.delete('alice', 'cancelled');
  assert.equal((await new AgentService(store, profiles, ssh).list('alice')).length, 0);
  assert.equal((await agent.list('bob')).length, 1);
  assert.equal(connections, 0);
});

test('deleting migrated legacy aliases does not restore them on restart', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cozypad-tt-delete-legacy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonStore(directory);
  const legacy = [
    { id: 'first', serverId: 'server', threadId: 'shared', prompt: 'first', createdAt: 1, status: 'completed', path: '~', events: [] },
    { id: 'second', serverId: 'server', threadId: 'shared', prompt: 'second', createdAt: 2, status: 'completed', path: '~', events: [] }
  ];
  const file = store.userPath('alice', 'codex-tasks.json');
  await store.write(file, legacy);
  const agent = new AgentService(store, {}, {});
  const cleanups = [];
  agent.threads = { delete: async (...args) => { cleanups.push(args); } };
  await agent.delete('alice', 'second');
  assert.deepEqual(cleanups, [['alice', 'server', 'shared']]);
  assert.deepEqual(await store.read(file, []), legacy);
  assert.deepEqual(await store.read(agent.chats.file('alice'), null), []);
  assert.deepEqual(await new AgentService(store, {}, {}).list('alice'), []);
  await assert.rejects(agent.find('alice', 'first'), error => error.status === 404);
});

test('remote cleanup is acknowledged before local deletion and never reconnects or deletes project files', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cozypad-tt-remote-delete-'));
  const fixture = await sshFixture(), store = new JsonStore(directory);
  const profiles = { find: async () => ({ id: 'server', defaultPath: '~', host: '127.0.0.1', port: fixture.port, username: 'tester', fingerprints: [fixture.fingerprint], credential: fixture.privateKey }) };
  const ssh = new SshService(profiles, { open: value => ({ privateKey: value }) }), agent = new AgentService(store, profiles, ssh);
  t.after(async () => { agent.close(); ssh.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); });
  const task = { id: 'local-chat', serverId: 'server', threadId: 'parent-thread', prompt: 'old task', path: '~/shared-project', createdAt: 1, status: 'completed', events: [] };
  await agent.chats.save('alice', task);
  for (const [id, parentThreadId, location] of [
    ['parent-thread', undefined, 'sessions'], ['child-thread', 'parent-thread', 'sessions'], ['grandchild-thread', 'child-thread', 'archived_sessions'], ['unrelated-thread', undefined, 'sessions']
  ]) {
    const rolloutPath = `/home/tester/.codex/${location}/${id}.jsonl`;
    fixture.threads.set(id, { parentThreadId, rolloutPath }); fixture.rollouts.set(rolloutPath, Buffer.from('log'));
  }
  await assert.rejects(agent.delete('alice', task.id), error => error.code === 'SSH_DISCONNECTED');
  assert.equal(fixture.stats.connections, 0); assert.equal((await agent.list('alice')).length, 1);
  await ssh.connect('alice', 'server');
  await assert.rejects(agent.delete('bob', task.id), error => error.status === 404);
  agent.active.set(task.id, { owner: 'alice', task: { ...task, status: 'cancelled' } });
  await assert.rejects(agent.delete('alice', task.id), error => error.status === 409);
  agent.active.delete(task.id);
  assert.equal(fixture.cleanupRequests.length, 0);
  for (const failure of [
    { error: { code: -32601, message: 'Method not found' } },
    { error: { code: -32000, message: 'Permission denied' } },
    { disconnect: true }, { malformed: true }
  ]) {
    Object.assign(fixture.deletion, { error: null, disconnect: false, malformed: false }, failure);
    await assert.rejects(agent.delete('alice', task.id), error => error.status === 502 && /本機紀錄已保留/.test(error.message));
    assert.equal((await new AgentService(store, profiles, ssh).list('alice')).length, 1);
    assert.equal(fixture.threads.size, 4); assert.equal(fixture.rollouts.size, 4);
  }
  Object.assign(fixture.deletion, { error: null, disconnect: false, malformed: false });
  const originalExec = ssh.exec.bind(ssh);
  ssh.exec = async () => { throw Object.assign(new Error('timed out'), { status: 504 }); };
  await assert.rejects(agent.delete('alice', task.id), error => error.status === 504);
  assert.equal((await agent.list('alice')).length, 1);
  ssh.exec = originalExec;
  await agent.delete('alice', task.id);
  assert.deepEqual(await new AgentService(store, profiles, ssh).list('alice'), []);
  assert.deepEqual([...fixture.threads.keys()], ['unrelated-thread']);
  assert.deepEqual([...fixture.rollouts.keys()], ['/home/tester/.codex/sessions/unrelated-thread.jsonl']);
  assert.equal(fixture.fileMap.get('/home/tester/readme.txt').toString(), 'CozyPad test file\n');
  assert.ok(fixture.commands.every(command => command.includes('codex app-server') && !command.includes('rm ')));
  assert.ok(fixture.cleanupRequests.filter(request => request.method === 'thread/delete').every(request => request.params.threadId === task.threadId));
  assert.equal(fixture.stats.connections, 1); assert.equal(fixture.stats.authenticated, 1);
});

test('invalid remote thread IDs fail before SSH cleanup and retain local history', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cozypad-tt-delete-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const agent = new AgentService(new JsonStore(directory), {}, {});
  for (const threadId of ['../../project', '$(rm -rf ~)', 'thread\nother', 'x'.repeat(129)]) {
    const task = { id: 'invalid', threadId, serverId: 'server', prompt: 'test', path: '~', createdAt: 1, status: 'completed', events: [] };
    await agent.chats.save('alice', task);
    await assert.rejects(agent.delete('alice', task.id), error => error.status === 400);
    assert.equal((await agent.find('alice', task.id)).threadId, threadId);
  }
});
