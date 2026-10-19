import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserDirectory } from '../apps/app/src/workspaces/browser-directory.mjs';

const file = name => ({ name, kind: 'file', getFile() { throw new Error('File contents must not be read.'); } });
const never = () => new Promise(() => {});
function directory(entries, stalled = false, name = 'markdown-project') {
  return { name, kind: 'directory', values() {
    let index = 0;
    return { [Symbol.asyncIterator]() { return this; }, next() {
      return index < entries.length ? Promise.resolve({ value: entries[index++], done: false }) : stalled ? never() : Promise.resolve({ done: true });
    }, return() { return Promise.resolve({ done: true }); } };
  }, async getDirectoryHandle(child) {
    const value = entries.find(value => value.name === child && value.kind === 'directory');
    if (!value) throw new DOMException('Missing directory', 'NotFoundError');
    return value;
  } };
}

test('ordinary Markdown folder streams metadata and finishes complete without reading bodies', async () => {
  const progress = [];
  const result = await new BrowserDirectory(directory([file('README.md'), file('研究筆記.md')])).read([], undefined, { onProgress: value => progress.push(value) });
  assert.equal(result.context.incomplete, false); assert.equal(result.stopReason, undefined);
  assert.equal(result.items.length, 2); assert.equal(progress[0].items.length, 0);
  assert.equal(progress[1].items.length, 1); assert.ok(progress.every(value => value.context.incomplete));
});

test('slow enumeration preserves acquired Markdown entries and reports an incomplete timeout', async () => {
  const result = await new BrowserDirectory(directory([file('notes.md')], true)).read([], undefined, { timeoutMs: 25 });
  assert.equal(result.stopReason, 'timeout'); assert.equal(result.context.incomplete, true);
  assert.deepEqual(result.context.entries, [{ name: 'notes.md', kind: 'file' }]);
});

test('a stalled first batch is bounded and explicit stop preserves partial entries', async () => {
  const empty = await new BrowserDirectory(directory([], true)).read([], undefined, { timeoutMs: 25 });
  assert.equal(empty.stopReason, 'timeout'); assert.equal(empty.context.incomplete, true); assert.deepEqual(empty.items, []);
  const controller = new AbortController();
  const result = await new BrowserDirectory(directory([file('notes.md')], true)).read([], controller.signal, {
    onProgress(value) { if (value.items.length) controller.abort(); }
  });
  assert.equal(result.stopReason, 'cancelled'); assert.equal(result.items[0].name, 'notes.md'); assert.equal(result.context.incomplete, true);
});

test('pre-cancelled reads and unopened subfolder timeouts never claim a directory listing', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(new BrowserDirectory(directory([])).read([], controller.signal), { name: 'AbortError' });
  let progress = 0;
  const root = directory([]); root.getDirectoryHandle = never;
  await assert.rejects(new BrowserDirectory(root).read(['sub'], undefined, { timeoutMs: 25, onProgress() { progress++; } }), { name: 'TimeoutError' });
  assert.equal(progress, 0);
});

test('subfolder progress belongs to the opened target and keeps existing exclusions and limits', async () => {
  const sub = directory([file('plan.md'), file('.env')], false, 'sub');
  const progress = [], result = await new BrowserDirectory(directory([sub])).read(['sub'], undefined, { onProgress: value => progress.push(value) });
  assert.ok(progress.every(value => value.context.path === 'sub'));
  assert.deepEqual(result.context.entries, [{ name: 'plan.md', kind: 'file' }]); assert.equal(result.context.incomplete, true);
  const limited = await new BrowserDirectory(directory(Array.from({ length: 60 }, (_, index) => file(`note-${index}.md`)))).read();
  assert.equal(limited.items.length, 50); assert.equal(limited.stopReason, 'limit'); assert.equal(limited.context.incomplete, true);
  const restricted = directory([file('notes.md')]); restricted.values = () => { throw new DOMException('Denied', 'NotAllowedError'); };
  await assert.rejects(new BrowserDirectory(restricted).read(), { name: 'NotAllowedError' });
});
