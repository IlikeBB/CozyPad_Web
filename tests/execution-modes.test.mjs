import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../apps/server/src/storage/json-store.mjs';
import { SshService } from '../apps/server/src/ssh/ssh-service.mjs';
import { AgentService } from '../apps/server/src/ssh/agent-service.mjs';
import { CodexChat } from '../apps/server/src/ssh/codex-chat.mjs';
import { delegationDetails, executionMode, executionConfig, executionInstruction, supportsDelegation } from '../apps/server/src/ssh/execution-settings.mjs';
import { sshFixture } from './helpers/ssh-fixture.mjs';
import { png, payload } from './helpers/attachment-fixtures.mjs';

async function workspace(t, options) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cozypad-tt-modes-'));
  const fixture = await sshFixture(options), store = new JsonStore(directory);
  const profiles = { find: async () => ({ id: 'test', defaultPath: '~', host: '127.0.0.1', port: fixture.port, username: 'tester', fingerprints: [fixture.fingerprint], credential: fixture.privateKey }) };
  const ssh = new SshService(profiles, { open: value => ({ privateKey: value }) });
  const agent = new AgentService(store, profiles, ssh);
  t.after(async () => { agent.close(); ssh.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); });
  const event = (id, match) => new Promise(resolve => {
    const listener = value => { if (match(value)) { agent.events.off(id, listener); resolve(value); } };
    agent.events.on(id, listener);
  });
  return { agent, fixture, ssh, store, profiles, event, finish: id => event(id, event => event.type === 'status') };
}

test('execution modes validate presets, supported versions and bounded delegation previews', () => {
  assert.equal(executionMode(), 'general');
  assert.deepEqual(executionConfig('general'), { 'agents.enabled': false });
  assert.deepEqual(executionConfig('delegated'), { 'agents.enabled': true, 'agents.max_concurrent_threads_per_session': 2 });
  for (const invalid of ['constructor', 'proactive', 'general;id', null, {}, true]) assert.throws(() => executionMode(invalid), error => error.status === 400);
  for (const version of ['codex-cli 0.161.0', 'codex-cli 0.162.1', 'codex-cli 1.0.0']) assert.equal(supportsDelegation(version), true);
  for (const version of ['', 'codex-cli 0.160.0', '0.161.0', 'codex-cli unknown']) assert.equal(supportsDelegation(version), false);
  assert.match(executionInstruction('general'), /不建立或委派/);
  assert.match(executionInstruction('delegated'), /精簡摘要/);
  const details = delegationDetails({ tool: 'spawnAgent', status: 'completed', prompt: 'x'.repeat(5000), agentsStates: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [String(index), { status: 'completed', message: 'x'.repeat(10000) }])) });
  assert.equal(details.prompt.length, 2048); assert.equal(details.agents.length, 8); assert.equal(details.agents[0].message.length, 4096);
});

test('delegation retains bounded approval previews, not child transcripts or command output', () => {
  const chat = new CodexChat({}, 'alice', { threadId: 'root', executionMode: 'delegated' }, [], { item() {} });
  chat.childThreads.add('child');
  const receive = (threadId, item) => chat.receive(JSON.stringify({ method: 'item/started', params: { threadId, item } }));
  receive('child', { id: 'message', type: 'agentMessage', text: 'x'.repeat(100000) });
  assert.equal(chat.items.size, 0);
  receive('child', { id: 'file', type: 'fileChange', changes: Array.from({ length: 10 }, () => ({ path: '/tmp/file', diff: 'x'.repeat(100000) })) });
  assert.equal(chat.items.get('child:file').changes.length, 5); assert.equal(chat.items.get('child:file').changes[0].diff.length, 2048);
  for (let index = 0; index < 300; index++) receive('root', { id: `command-${index}`, type: 'commandExecution', command: 'x'.repeat(6000), aggregatedOutput: 'x'.repeat(100000) });
  assert.equal(chat.items.size, 256); assert.equal(chat.items.get('root:command-299').command.length, 4096);
  assert.equal(chat.items.get('root:command-299').aggregatedOutput, undefined);
});

test('switching execution modes resumes one conversation and reuses one authenticated SSH connection', { timeout: 15000 }, async t => {
  const { agent, fixture, store, profiles, ssh, finish } = await workspace(t);
  await assert.rejects(agent.start('alice', { serverId: 'test', prompt: 'invalid', executionMode: 'invalid' }), error => error.status === 400);
  assert.equal(fixture.stats.connections, 0);
  const task = await agent.start('alice', { serverId: 'test', prompt: 'general' }); await finish(task.id);
  assert.equal((await agent.find('alice', task.id)).executionMode, 'general');
  assert.equal(fixture.chatRequests.find(request => request.method === 'thread/start').params.config['agents.enabled'], false);
  const next = await agent.start('alice', { serverId: 'test', prompt: '[delegation]', resumeTaskId: task.id, executionMode: 'delegated', model: 'fixture-codex', reasoningEffort: 'high', approvalMode: 'ask' }); await finish(next.id);
  assert.equal(next.id, task.id);
  let saved = await agent.find('alice', task.id);
  assert.equal(saved.threadId, task.threadId || 'test-thread-01');
  assert.equal(saved.approvalMode, 'ask'); assert.equal(saved.model, 'fixture-codex'); assert.equal(saved.reasoningEffort, 'high');
  const resume = fixture.chatRequests.filter(request => request.method === 'thread/resume').at(-1);
  assert.equal(resume.params.config['agents.enabled'], true); assert.equal(resume.params.config['agents.max_concurrent_threads_per_session'], 2);
  assert.equal(resume.params.sandbox, 'read-only'); assert.equal(resume.params.approvalPolicy, 'untrusted');
  const turn = fixture.chatRequests.filter(request => request.method === 'turn/start').at(-1);
  assert.equal(turn.params.effort, 'high'); assert.equal(turn.params.model, 'fixture-codex');
  assert.equal(turn.params.input[0].text, '[delegation]'); assert.match(turn.params.input.at(-1).text, /Codex 子代理/);
  const activities = saved.events.filter(event => event.type === 'delegation').map(event => JSON.parse(event.text));
  assert.deepEqual(activities.map(item => item.tool), ['spawnAgent', 'wait']);
  assert.equal(activities[1].agents[0].status, 'completed');
  assert.match(activities[1].agents[0].message, /只回傳摘要/);
  const inherited = await agent.start('alice', { serverId: 'test', prompt: 'inherit', resumeTaskId: task.id }); await finish(inherited.id);
  assert.equal((await agent.find('alice', task.id)).executionMode, 'delegated');
  const general = await agent.start('alice', { serverId: 'test', prompt: 'back to general', resumeTaskId: task.id, executionMode: 'general' }); await finish(general.id);
  assert.equal(fixture.chatRequests.filter(request => request.method === 'thread/resume').at(-1).params.config['agents.enabled'], false);
  saved = (await new AgentService(store, profiles, ssh).list('alice'))[0];
  assert.equal(saved.executionMode, 'general'); assert.equal(saved.turnCount, 4);
  assert.deepEqual(saved.events.filter(event => event.type === 'user').map(event => event.executionMode), ['general', 'delegated', 'delegated', 'general']);
  await assert.rejects(agent.find('bob', task.id), error => error.status === 404);
  assert.equal(fixture.stats.connections, 1); assert.equal(fixture.stats.authenticated, 1);
  assert.equal(fixture.commands.length, 4);
  const attached = await agent.start('alice', { serverId: 'test', resumeTaskId: task.id, prompt: '[delegation] with attachments', executionMode: 'delegated', attachments: [payload('scope.png', png), payload('scope.txt', '委派附件內容')] }); await finish(attached.id);
  const input = fixture.chatRequests.filter(request => request.method === 'turn/start').at(-1).params.input;
  assert.deepEqual(input.map(item => item.type), ['text', 'localImage', 'text', 'text']);
  assert.ok(fixture.fileMap.get(input[1].path).equals(png)); assert.match(input[2].text, /委派附件內容/); assert.match(input[3].text, /Codex 子代理/);
  assert.equal(fixture.stats.authenticated, 1); assert.equal(fixture.commands.length, 5);
  await agent.delete('alice', task.id); assert.equal(fixture.threads.size, 0); assert.equal(fixture.rollouts.size, 0);
  assert.equal(fixture.stats.connections, 1);
});

test('unsupported or policy-blocked delegation fails before starting work and never retries or falls back', { timeout: 10000 }, async t => {
  for (const options of [{ codexVersion: 'codex-cli 0.160.0' }, { codexVersion: '' }, { delegationBlocked: true }]) {
    const { agent, fixture, finish } = await workspace(t, options);
    const task = await agent.start('alice', { serverId: 'test', prompt: '[delegation]', executionMode: 'delegated' }); await finish(task.id);
    const saved = await agent.find('alice', task.id);
    assert.equal(saved.status, 'failed');
    assert.equal(fixture.chatRequests.filter(request => request.method === 'turn/start').length, 0);
    assert.equal(fixture.commands.length, 1); assert.equal(fixture.stats.authenticated, 1);
    assert.ok(saved.events.some(event => event.type === 'error' && /0\.161\.0|administrator/.test(event.text)));
    const retry = await agent.start('alice', { serverId: 'test', resumeTaskId: task.id, prompt: 'user chose general', executionMode: 'general' }); await finish(retry.id);
    assert.equal((await agent.find('alice', task.id)).status, 'completed');
    assert.equal(fixture.chatRequests.filter(request => request.method === 'turn/start').length, 1);
    assert.equal(fixture.stats.authenticated, 1);
  }
});

test('known child approvals remain manual and owner-isolated; cancel does not reconnect SSH', { timeout: 12000 }, async t => {
  const { agent, fixture, event, finish } = await workspace(t);
  const pending = id => event(id, value => value.type === 'approval' && JSON.parse(value.text).status === 'pending');
  const task = await agent.start('alice', { serverId: 'test', prompt: '[child-approval]', executionMode: 'delegated', approvalMode: 'ask' });
  const request = JSON.parse((await pending(task.id)).text);
  assert.match(request.agentThreadId, /:child-1$/); assert.equal(request.changes[0].diff, '+test change');
  assert.equal(fixture.chatRequests.filter(request => request.result?.decision).length, 0);
  await assert.rejects(agent.approve('bob', task.id, { requestId: request.id, decision: 'accept' }), error => error.status === 404);
  const completed = finish(task.id); await agent.approve('alice', task.id, { requestId: request.id, decision: 'accept' }); await completed;
  assert.ok(fixture.chatRequests.some(request => typeof request.id === 'string' && request.id.startsWith('foreign:') && request.error?.code === -32602));
  assert.equal((await agent.find('alice', task.id)).status, 'completed');
  const next = await agent.start('alice', { serverId: 'test', resumeTaskId: task.id, prompt: '[child-approval]', executionMode: 'delegated', approvalMode: 'ask' });
  const cancelledRequest = JSON.parse((await pending(next.id)).text);
  const stopped = finish(next.id); await agent.cancel('alice', next.id); await stopped;
  const saved = await agent.find('alice', task.id);
  assert.equal(saved.status, 'cancelled');
  assert.equal(JSON.parse(saved.events.filter(event => event.type === 'approval').at(-1).text).status, 'cancelled');
  await assert.rejects(agent.approve('alice', task.id, { requestId: cancelledRequest.id, decision: 'accept' }), error => error.status === 409);
  assert.equal(fixture.stats.connections, 1); assert.equal(fixture.stats.authenticated, 1);
});
