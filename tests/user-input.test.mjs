import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexChat } from '../apps/server/src/ssh/codex-chat.mjs';
import { JsonStore } from '../apps/server/src/storage/json-store.mjs';
import { SshService } from '../apps/server/src/ssh/ssh-service.mjs';
import { AgentService } from '../apps/server/src/ssh/agent-service.mjs';
import { choiceQuestion } from '../apps/app/src/components/choice-question.mjs';
import { sshFixture } from './helpers/ssh-fixture.mjs';
import { choiceReply, cropChoiceReply, cropOptions, gpuChoiceReply, gpuOptions, gpuQuestion, initializationChoiceReply, initializationOptions, nativeQuestion, professionChoiceReply, professionOptions, randomChoicePrompt, randomChoiceReply, randomOptions, wordOptions } from './helpers/question-fixtures.mjs';

test('the profession screenshot is recognized as a decision, not an ordinary result list', () => {
  assert.deepEqual(choiceQuestion(professionChoiceReply).options.map(option => option.label), professionOptions);
});

test('initialization screenshot and alternatives after a separate question become selectable', () => {
  for (const reply of [
    initializationChoiceReply,
    initializationChoiceReply.replace('？還是', '？\n\n還是'),
    initializationChoiceReply.replace('？還是', '？\n還是'),
    'Reset everything? Or keep equipment?\n\n- Reset everything\n- Keep equipment'
  ]) {
    const choice = choiceQuestion(reply);
    assert.ok(choice, 'Explicit alternative question must be selectable');
    if (reply.includes('初始化')) assert.deepEqual(choice.options.map(option => option.label), initializationOptions);
  }
});

test('only explicit final Markdown choice questions become selectable', () => {
  const choice = choiceQuestion(choiceReply);
  assert.deepEqual(choice.options.map(option => option.label), wordOptions);
  assert.match(choice.before, /哪份 Word/);
  assert.equal(choiceQuestion(gpuChoiceReply).question, gpuQuestion);
  assert.deepEqual(choiceQuestion(gpuChoiceReply).options.map(option => option.label), gpuOptions);
  assert.deepEqual(choiceQuestion(cropChoiceReply).options.map(option => option.label), cropOptions);
  assert.deepEqual(choiceQuestion('Should I keep the crop folder or skip its images?\n\n- Keep the folder\n- Skip its images').options.map(option => option.label), ['Keep the folder', 'Skip its images']);
  assert.deepEqual(choiceQuestion('Which document would you like?\n\n1. **Main report**\n2. `Review.docx`').options.map(option => option.label), ['Main report', 'Review.docx']);
  for (const text of [
    '已完成以下項目：\n\n- 主檔\n- 回填表',
    '哪份 Word？\n\n- [下載主檔](sandbox:/mnt/data/main.docx)\n- [下載表格](sandbox:/mnt/data/review.docx)',
    '哪份 Word？\n\n- [ ] 主檔\n- [x] 回填表',
    '哪份 Word？\n\n- 主檔\n  - 子項目\n- 回填表',
    '哪份 Word？\n\n- 主檔\n- 主檔',
    '哪份 Word？\n\n- 主檔',
    '哪份 Word？\n\n- 主檔\n- 回填表\n\n下一段說明',
    '```text\n哪份 Word？\n- 主檔\n- 回填表\n```',
    '執行結果如何？\n\n- 完成\n- 失敗'
  ]) assert.equal(choiceQuestion(text), null, text);
});

test('standalone choices use the requesting turn, while ordinary lists stay Markdown', () => {
  const choice = choiceQuestion(randomChoiceReply, randomChoicePrompt);
  assert.equal(choice.question, randomChoicePrompt);
  assert.equal(choice.before, '');
  assert.deepEqual(choice.options.map(option => option.label), randomOptions);
  assert.deepEqual(choiceQuestion(randomChoiceReply, 'Give me three options to choose from.').options.map(option => option.label), randomOptions);
  assert.deepEqual(choiceQuestion(`隨機選一個，沒有任何意義：\n${randomChoiceReply}`).options.map(option => option.label), randomOptions);
  assert.deepEqual(choiceQuestion(`請選擇一個項目：\n${randomChoiceReply}`).options.map(option => option.label), randomOptions);
  for (const prompt of ['', '列出三個已完成的工作', '不要給我選項，直接執行', 'Do not provide options.']) assert.equal(choiceQuestion(randomChoiceReply, prompt), null, prompt);
  for (const text of [
    '已完成以下項目：\n\n- 主檔\n- 回填表',
    '1. [下載](sandbox:/mnt/data/report.pdf)\n2. 其他',
    '- [ ] 主檔\n- [x] 回填表',
    '- 主檔\n  - 子項目\n- 回填表',
    '- 主檔\n- 主檔',
    '```text\n1. 主檔\n2. 回填表\n```'
  ]) assert.equal(choiceQuestion(text, randomChoicePrompt), null, text);
});

function chatFixture() {
  const sent = [], events = [];
  const chat = new CodexChat({}, 'alice', { threadId: 'root', executionMode: 'delegated' }, [], { question: value => events.push(value), process() {} });
  chat.turnId = 'turn'; chat.channel = { write: value => sent.push(JSON.parse(value)), end() {}, close() {} };
  const request = (id = 'remote', questions = [nativeQuestion], threadId = 'root', turnId = 'turn', method = 'item/tool/requestUserInput') => chat.receive(JSON.stringify({ id, method, params: { threadId, turnId, itemId: 'question', questions } }));
  return { chat, sent, events, request };
}

test('native and known child questions are manual, validated, bounded and resolved by thread', () => {
  const { chat, sent, events, request } = chatFixture();
  request(); request(); assert.equal(events.length, 1); assert.equal(sent.length, 0);
  const id = events[0].id;
  for (const answers of [{}, [], null, { document_scope: '' }, { document_scope: 'x'.repeat(4097) }, { document_scope: '主檔', extra: 'x' }]) assert.throws(() => chat.answer(id, answers), error => error.status === 400);
  assert.equal(sent.length, 0);
  chat.answer(id, { document_scope: '自訂範圍' });
  assert.deepEqual(sent[0], { id: 'remote', result: { answers: { document_scope: { answers: ['自訂範圍'] } } } });
  assert.equal(events.at(-1).status, 'answered'); assert.throws(() => chat.answer(id, { document_scope: '主檔' }), error => error.status === 409);
  request('stale', [nativeQuestion], 'root', 'previous'); request('foreign', [nativeQuestion], 'foreign');
  assert.equal(sent.at(-1).error.code, -32602);
  request('bad', [{ ...nativeQuestion, id: '__proto__' }]); request('duplicate', [nativeQuestion, nativeQuestion]); request('oversized', [{ ...nativeQuestion, options: Array(9).fill(nativeQuestion.options[0]) }]);
  assert.equal(events.length, 2);
  chat.childThreads.add('child'); request('child-request', [nativeQuestion], 'child', 'child-turn', 'tool/requestUserInput');
  const child = events.at(-1);
  chat.receive(JSON.stringify({ method: 'serverRequest/resolved', params: { threadId: 'root', requestId: 'child-request' } }));
  assert.equal(chat.questions.requests.size, 1);
  chat.receive(JSON.stringify({ method: 'serverRequest/resolved', params: { threadId: 'child', requestId: 'child-request' } }));
  assert.equal(events.at(-1).status, 'cancelled'); assert.throws(() => chat.answer(child.id, {}), error => error.status === 409);
  request('closed', [{ ...nativeQuestion, isOther: false }]); const closed = events.at(-1);
  assert.throws(() => chat.answer(closed.id, { document_scope: '其他內容' }), error => error.status === 400);
  chat.end(); assert.equal(events.at(-1).status, 'cancelled'); assert.equal(chat.questions.requests.size, 0);
});

test('secret answers are sent but never included in history events', () => {
  const { chat, sent, events, request } = chatFixture();
  request('secret', [{ id: 'secret', header: '確認', question: '請輸入內容', isSecret: true, options: null }]);
  chat.answer(events[0].id, { secret: 'do-not-persist' });
  assert.equal(sent[0].result.answers.secret.answers[0], 'do-not-persist');
  assert.equal(JSON.stringify(events).includes('do-not-persist'), false);
});

test('question timeouts never pick a recommendation automatically', () => {
  const { chat, sent, events } = chatFixture();
  chat.receive(JSON.stringify({ id: 'question-timeout', method: 'item/tool/requestUserInput', params: { threadId: 'root', turnId: 'turn', autoResolutionMs: 0, questions: [nativeQuestion] } }));
  assert.equal(sent.length, 0); assert.equal(events[0].status, 'pending');
  chat.cancel(); assert.equal(sent.some(message => message.result?.answers), false);
  chat.end();
});

async function workspace(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cozypad-tt-questions-'));
  const fixture = await sshFixture(), store = new JsonStore(directory);
  const profiles = { find: async () => ({ id: 'test', defaultPath: '~', host: '127.0.0.1', port: fixture.port, username: 'tester', fingerprints: [fixture.fingerprint], credential: fixture.privateKey }) };
  const ssh = new SshService(profiles, { open: value => ({ privateKey: value }) });
  const agent = new AgentService(store, profiles, ssh);
  t.after(async () => { agent.close(); ssh.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); });
  const event = (id, type) => new Promise(resolve => {
    const listener = value => { if (value.type === type) { agent.events.off(id, listener); resolve(value); } };
    agent.events.on(id, listener);
  });
  return { agent, fixture, store, ssh, profiles, event };
}

test('general mode enables blocking questions on new and existing threads, with no command before confirmation', { timeout: 15000 }, async t => {
  const { agent, fixture, event } = await workspace(t);
  let task = await agent.start('alice', { serverId: 'test', prompt: '[question-profession]' });
  for (let round = 0; round < 2; round++) {
    const question = JSON.parse((await event(task.id, 'question')).text);
    await new Promise(resolve => setTimeout(resolve, 250));
    const pending = await agent.find('alice', task.id);
    assert.equal(pending.status, 'running');
    assert.equal(pending.events.filter(item => item.type === 'command').length, round ? 1 : 0);
    assert.equal(fixture.chatRequests.filter(request => request.result?.answers).length, round);
    const setup = fixture.chatRequests.filter(request => ['thread/start', 'thread/resume'].includes(request.method)).at(-1);
    assert.equal(setup.params.config['features.default_mode_request_user_input'], true);
    assert.match(setup.params.developerInstructions, /request_user_input/);
    assert.match(setup.params.developerInstructions, /END the turn immediately/);
    const done = event(task.id, 'status');
    await agent.answer('alice', task.id, { requestId: question.id, answers: { profession: professionOptions[1] } }); await done;
    assert.equal((await agent.find('alice', task.id)).events.filter(item => item.type === 'command').length, round + 1);
    if (!round) task = await agent.start('alice', { serverId: 'test', prompt: '[question-profession]', resumeTaskId: task.id });
  }
  assert.equal(fixture.stats.authenticated, 1);
  assert.equal(fixture.chatRequests.filter(request => request.method === 'turn/start').length, 2);
});

test('native questions survive history reload, stay owner-isolated and answer over the same SSH channel', { timeout: 15000 }, async t => {
  const { agent, fixture, store, ssh, profiles, event } = await workspace(t);
  const task = await agent.start('alice', { serverId: 'test', prompt: '[question-multiple]' });
  const question = JSON.parse((await event(task.id, 'question')).text);
  assert.equal(fixture.chatRequests.find(request => request.method === 'initialize').params.capabilities.experimentalApi, true);
  assert.equal(question.questions.length, 2);
  assert.equal((await agent.list('alice'))[0].events.filter(event => event.type === 'question').length, 1);
  assert.equal(fixture.chatRequests.filter(request => request.result?.answers).length, 0);
  await assert.rejects(agent.answer('bob', task.id, { requestId: question.id, answers: {} }), error => error.status === 404);
  await assert.rejects(agent.answer('alice', task.id, { requestId: question.id, answers: { document_scope: wordOptions[2] } }), error => error.status === 400);
  const done = event(task.id, 'status');
  await agent.answer('alice', task.id, { requestId: question.id, answers: { document_scope: wordOptions[2], style: '繁體中文' } }); await done;
  const saved = (await new AgentService(store, profiles, ssh).list('alice'))[0];
  assert.equal(JSON.parse(saved.events.find(event => event.type === 'question').text).status, 'answered');
  assert.equal(saved.turnCount, 1); assert.equal(fixture.commands.length, 1); assert.equal(fixture.stats.authenticated, 1);
  await assert.rejects(agent.answer('alice', task.id, { requestId: question.id, answers: {} }), error => error.status === 409);
  const next = await agent.start('alice', { serverId: 'test', prompt: '[question]', resumeTaskId: task.id });
  const pending = JSON.parse((await event(next.id, 'question')).text); const stopped = event(next.id, 'status');
  await agent.cancel('alice', next.id); await stopped;
  assert.equal(JSON.parse((await agent.find('alice', task.id)).events.filter(event => event.type === 'question').at(-1).text).status, 'cancelled');
  await assert.rejects(agent.answer('alice', task.id, { requestId: pending.id, answers: { document_scope: wordOptions[0] } }), error => error.status === 409);
  assert.equal(fixture.stats.authenticated, 1);
});

test('ordinary choice replies resume one chat and stale or duplicate confirmations cannot start more work', { timeout: 12000 }, async t => {
  const { agent, fixture, event } = await workspace(t);
  const task = await agent.start('alice', { serverId: 'test', prompt: '[choice-list]' }); await event(task.id, 'status');
  const saved = await agent.find('alice', task.id), assistant = saved.events.filter(event => event.type === 'assistant').at(-1);
  const payload = { serverId: 'test', prompt: wordOptions[1], resumeTaskId: task.id, replyToEventId: assistant.id };
  await assert.rejects(agent.start('alice', { ...payload, replyToEventId: 9999 }), error => error.status === 409);
  const attempts = await Promise.allSettled([agent.start('alice', payload), agent.start('alice', payload)]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  await event(task.id, 'status');
  await assert.rejects(agent.start('alice', payload), error => error.status === 409);
  const resumed = await agent.find('alice', task.id);
  assert.equal(resumed.id, task.id); assert.equal(resumed.threadId, saved.threadId); assert.equal(resumed.turnCount, 2);
  assert.equal(resumed.events.filter(event => event.type === 'user').at(-1).replyToEventId, assistant.id);
  assert.equal(fixture.chatRequests.filter(request => request.method === 'turn/start').length, 2); assert.equal(fixture.stats.authenticated, 1);
});

test('earlier choice questions remain answerable after more assistant messages and later turns', { timeout: 15000 }, async t => {
  const { agent, fixture, event } = await workspace(t);
  const task = await agent.start('alice', { serverId: 'test', prompt: '[choice-continued]' });
  await event(task.id, 'status');
  const initial = await agent.find('alice', task.id);
  const question = initial.events.find(item => item.type === 'assistant' && item.text === gpuChoiceReply);
  assert.notEqual(initial.events.filter(item => item.type === 'assistant').at(-1).id, question.id);
  const later = event(task.id, 'status');
  await agent.start('alice', { serverId: 'test', prompt: '後續訊息', resumeTaskId: task.id }); await later;
  const payload = { serverId: 'test', prompt: `針對先前的問題「${gpuQuestion}」，我的選擇是：${gpuOptions[1]}`, resumeTaskId: task.id, replyToEventId: question.id };
  await assert.rejects(agent.start('bob', payload), error => error.status === 404);
  const done = event(task.id, 'status');
  await agent.start('alice', payload); await done;
  await assert.rejects(agent.start('alice', payload), error => error.status === 409);
  const saved = await agent.find('alice', task.id);
  assert.equal(saved.id, task.id); assert.equal(saved.threadId, initial.threadId);
  assert.equal(saved.events.filter(item => item.type === 'user').at(-1).replyToEventId, question.id);
  assert.equal(saved.turnCount, 3); assert.equal(fixture.stats.authenticated, 1);
});
