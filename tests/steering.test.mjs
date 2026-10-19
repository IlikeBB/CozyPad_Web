import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../apps/server/src/storage/json-store.mjs';
import { SshService } from '../apps/server/src/ssh/ssh-service.mjs';
import { AgentService } from '../apps/server/src/ssh/agent-service.mjs';
import { CodexChat } from '../apps/server/src/ssh/codex-chat.mjs';
import { sshFixture } from './helpers/ssh-fixture.mjs';
import { cropChoiceReply } from './helpers/question-fixtures.mjs';

async function workspace(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cozypad-steering-'));
  const fixture = await sshFixture(), store = new JsonStore(directory);
  const profiles = { find: async () => ({ id: 'test', defaultPath: '~', host: '127.0.0.1', port: fixture.port, username: 'tester', fingerprints: [fixture.fingerprint], credential: fixture.privateKey }) };
  const ssh = new SshService(profiles, { open: value => ({ privateKey: value }) });
  const agent = new AgentService(store, profiles, ssh);
  t.after(async () => {
    agent.close();
    for (let attempt = 0; attempt < 100 && agent.active.size; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    ssh.close(); await fixture.close(); await rm(directory, { recursive: true, force: true });
  });
  const task = await agent.start('alice', { serverId: 'test', path: '~', prompt: '[steer-hold]' });
  for (let attempt = 0; attempt < 100 && !agent.active.get(task.id)?.task.activeTurnId; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  const active = await agent.find('alice', task.id);
  assert.ok(active.activeTurnId);
  return { agent, fixture, task: active, payload: prompt => ({ prompt, expectedTurnId: active.activeTurnId, requestId: crypto.randomUUID() }) };
}

test('steering appends input to the same turn, deduplicates concurrent retries and persists acceptance', async t => {
  const { agent, fixture, task, payload } = await workspace(t);
  const guidance = payload('介面請改為上下排列');
  const [first, second] = await Promise.all([agent.steer('alice', task.id, guidance), agent.steer('alice', task.id, guidance)]);
  assert.equal(first.event.id, second.event.id);
  assert.equal(first.event.steeringTurnId, task.activeTurnId);
  const next = await agent.steer('alice', task.id, payload('保留編輯中的草稿'));
  assert.ok(next.event.id > first.event.id);
  assert.equal(task.turnCount, 1);
  assert.equal(fixture.stats.authenticated, 1);
  assert.equal(fixture.chatRequests.filter(x => x.method === 'turn/start').length, 1);
  assert.equal(fixture.chatRequests.filter(x => x.method === 'turn/steer').length, 2);
  const params = fixture.chatRequests.find(x => x.method === 'turn/steer').params;
  assert.deepEqual(Object.keys(params).sort(), ['expectedTurnId', 'input', 'threadId']);
  assert.equal(fixture.chatRequests.filter(x => x.method === 'turn/interrupt').length, 0);
  const finished = new Promise(resolve => agent.events.on(task.id, event => { if (event.type === 'status') resolve(event); }));
  await agent.steer('alice', task.id, payload('[finish]'));
  await finished;
  assert.equal(task.status, 'completed'); assert.equal(task.activeTurnId, undefined);
  assert.equal((await agent.steer('alice', task.id, guidance)).event.id, first.event.id);
  await assert.rejects(agent.steer('bob', task.id, guidance), error => error.status === 404);
});

test('invalid, stale and rejected guidance leaves generation running and cancellation available', async t => {
  const { agent, fixture, task, payload } = await workspace(t);
  await assert.rejects(agent.steer('alice', task.id, payload('')), error => error.status === 400);
  await assert.rejects(agent.steer('alice', task.id, { ...payload('wrong'), expectedTurnId: 'stale' }), error => error.status === 409);
  await assert.rejects(agent.steer('alice', task.id, payload('[reject]')), /未接受引導/);
  assert.equal(task.status, 'running'); assert.equal(agent.active.get(task.id).controller.finished, undefined);
  assert.equal(task.events.filter(event => event.steeringTurnId).length, 0);
  await agent.steer('alice', task.id, payload('修正設計方向'));
  const finished = new Promise(resolve => agent.events.on(task.id, event => { if (event.type === 'status') resolve(event); }));
  await agent.cancel('alice', task.id); await finished;
  assert.equal(task.status, 'cancelled');
  assert.equal(fixture.chatRequests.filter(x => x.method === 'turn/interrupt').length, 1);
});

test('completion racing with guidance rejects it without creating a replacement turn', async t => {
  const { agent, fixture, task, payload } = await workspace(t);
  await assert.rejects(agent.steer('alice', task.id, payload('[finish-race]')), /未取得引導確認/);
  assert.equal(fixture.chatRequests.filter(x => x.method === 'turn/start').length, 1);
  assert.equal(task.events.filter(event => event.steeringTurnId).length, 0);
});

test('late acknowledgement survives timeout and unrelated steering errors cannot end the turn', async () => {
  const sent = [], accepted = [];
  const chat = new CodexChat({}, 'alice', { threadId: 'thread' }, [], {});
  chat.channel = { write: line => sent.push(JSON.parse(line)), end() {}, close() {} };
  chat.started('turn');
  await assert.rejects(chat.steer('延後確認', 'turn', id => accepted.push(id), 5), error => error.status === 504);
  chat.receive(JSON.stringify({ id: sent[0].id, result: { turnId: 'turn' } }));
  assert.deepEqual(accepted, ['turn']);
  chat.receive(JSON.stringify({ id: sent[0].id, error: { message: 'duplicate response' } }));
  assert.equal(chat.finished, undefined);
  const mismatched = chat.steer('wrong acknowledgement', 'turn', () => assert.fail('must not accept'));
  chat.receive(JSON.stringify({ id: sent.at(-1).id, result: { turnId: 'different-turn' } }));
  await assert.rejects(mismatched, error => error.status === 409);
  chat.end();
});

test('choice steering waits for complete content, preserves its question and accepts only one answer', async t => {
  const { agent, fixture, task, payload } = await workspace(t);
  const partial = agent.append(task, 'assistant', cropChoiceReply, 'choice:test', undefined, undefined, undefined, undefined, false);
  await assert.rejects(agent.steer('alice', task.id, { ...payload('略過資料夾'), replyToEventId: partial.id }), error => error.status === 409);
  const complete = agent.append(task, 'assistant', cropChoiceReply, 'choice:test', undefined, undefined, undefined, undefined, true);
  const selected = { ...payload('不要使用 crop_MTCNN 內的圖片'), replyToEventId: complete.id };
  const [first, retry] = await Promise.all([agent.steer('alice', task.id, selected), agent.steer('alice', task.id, { ...selected, requestId: crypto.randomUUID() })]);
  assert.equal(first.event.id, retry.event.id);
  assert.equal(first.event.replyToEventId, complete.id);
  assert.equal(task.turnCount, 1); assert.equal(task.status, 'running');
  assert.equal(fixture.chatRequests.filter(request => request.method === 'turn/steer').length, 1);
  await assert.rejects(agent.steer('alice', task.id, { ...payload('改選另一個'), replyToEventId: complete.id }), error => error.status === 409);
  await assert.rejects(agent.steer('bob', task.id, selected), error => error.status === 404);
});
