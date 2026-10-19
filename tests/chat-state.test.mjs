import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeEvent, mergeHistory } from '../apps/app/src/workspaces/chat-state.ts';

const chat = (id, sequence = 1) => ({ id, serverId: 'server', prompt: 'hello', path: '~', createdAt: 100, updatedAt: 100, status: 'running', eventSequence: sequence,
  events: [{ id: sequence, order: 1, type: 'assistant', text: 'partial', time: 100, messageId: 'answer' }] });

test('stream deltas update one stable message without duplicating or accepting old revisions', () => {
  const first = chat('chat');
  const updated = mergeEvent(first, { ...first.events[0], id: 2, text: 'complete' });
  assert.equal(updated.events.length, 1); assert.equal(updated.events[0].order, 1); assert.equal(updated.events[0].text, 'complete');
  assert.equal(mergeEvent(updated, first.events[0]), updated);
  const stopped = mergeEvent(updated, { id: 3, order: 3, type: 'status', text: 'completed', time: 101 });
  assert.equal(stopped.status, 'completed'); assert.equal(stopped.eventSequence, 3);
});

test('stale history polls preserve new chats and newer streamed messages', () => {
  const current = chat('current', 5), fresh = { ...chat('new'), createdAt: 200, updatedAt: 200 };
  const history = mergeHistory([current, fresh], [chat('current', 2), { ...chat('other'), serverId: 'different' }], 'server');
  assert.deepEqual(history.map(item => item.id), ['new', 'current']); assert.equal(history[1], current);
  const finished = { ...current, status: 'completed', threadId: 'remote-thread' };
  assert.equal(mergeHistory(history, [finished, fresh], 'server')[1].threadId, 'remote-thread');
});

test('stale polls cannot restore explicitly deleted conversations', () => {
  const deleted = new Set(['removed']);
  const kept = chat('kept', 5);
  const history = mergeHistory([kept, chat('removed')], [chat('removed', 2), chat('kept', 2)], 'server', deleted);
  assert.deepEqual(history, [kept]);
  assert.deepEqual(mergeHistory([], [chat('removed')], 'server', deleted), []);
});
