import test from 'node:test';
import assert from 'node:assert/strict';
import { collectMarkdown, markdownLimits, preloadMarkdownDirectory } from '../apps/app/src/workspaces/markdown-directory.mjs';
const file = (name, text, visited) => ({ name, kind: 'file', async getFile() { visited?.push(name); const blob = new Blob([text]); return { size: blob.size, arrayBuffer: () => blob.arrayBuffer() }; } });
const folder = (name, children) => ({ name, kind: 'directory', async *values() { yield* children; }, async getDirectoryHandle(name) { const child = children.find(value => value.name === name && value.kind === 'directory'); if (!child) throw new Error('Missing'); return child; } });
const directory = root => ({ root, incomplete: false });

function browserFileReader(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'FileReader');
  Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: class {
    readAsDataURL(blob) {
      void blob.arrayBuffer().then(data => { this.result = `data:text/plain;base64,${Buffer.from(data).toString('base64')}`; this.onload?.(); }, reason => { this.error = reason; this.onerror?.(); });
    }
  } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'FileReader', previous); else delete globalThis.FileReader; });
}

test('reads complete Chinese Markdown bodies and subfolders beyond the 50-item preview without touching unrelated files', async () => {
  const visited = [], root = folder('markdown_bank', [
    ...Array.from({ length: 55 }, (_, index) => file(`note-${index}.md`, `# 文件 ${index}\n內容-${index}`, visited)),
    file('picture.png', 'not an MD', visited), folder('.git', [file('hidden.md', 'private', visited)]),
    folder('sub', [file('研究.MD', '# 研究\n保留全文', visited), file('.env.md', 'private', visited)])
  ]);
  const snapshot = await collectMarkdown(directory(root));
  assert.equal(snapshot.files.length, 56); assert.ok(snapshot.files.some(value => value.path === 'sub/研究.MD' && value.content.endsWith('保留全文')));
  assert.equal(visited.length, 56); assert.ok(!visited.includes('picture.png')); assert.ok(!visited.includes('hidden.md')); assert.ok(snapshot.incomplete);
});

test('selecting a subfolder constrains the read scope and reads empty, UTF-8 and UTF-16 Markdown correctly', async () => {
  const visited = [], root = folder('project', [file('outside.md', 'outside', visited), folder('sub', [file('empty.md', '', visited), file('筆記.markdown', new Uint8Array([255, 254, 65, 0]), visited)])]);
  const snapshot = await collectMarkdown(directory(root), ['sub']);
  assert.equal(snapshot.path, 'sub'); assert.equal(snapshot.incomplete, false); assert.equal(snapshot.files.length, 2);
  assert.equal(snapshot.files.find(file => file.path === '筆記.markdown').content, 'A'); assert.ok(!visited.includes('outside.md'));
});

test('limits never silently truncate a document and mark incomplete snapshots, while absent MD is a complete empty result', async () => {
  const root = folder('project', [file('big.md', 'x'.repeat(100)), file('small.md', 'ok'), file('last.md', 'last')]);
  const snapshot = await collectMarkdown(directory(root), [], { limits: { ...markdownLimits, fileBytes: 10, files: 1 } });
  assert.deepEqual(snapshot.files, [{ path: 'small.md', content: 'ok' }]); assert.ok(snapshot.incomplete); assert.ok(snapshot.limitations.length >= 2);
  const empty = await collectMarkdown(directory(folder('project', [file('readme.txt', 'text')])));
  assert.deepEqual(empty.files, []); assert.equal(empty.incomplete, false);
});

test('a stalled scan cannot send an empty metadata-only substitute, and cancellation preserves the draft', async () => {
  const root = folder('project', []); root.values = () => ({ [Symbol.asyncIterator]() { return this; }, next: () => new Promise(() => {}) });
  await assert.rejects(collectMarkdown(directory(root), [], { timeoutMs: 20 }), /未取得任何 MD 內容.*訊息尚未送出/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(collectMarkdown(directory(root), [], { signal: controller.signal }), { name: 'AbortError' });
});

test('failed file reads and unsupported encodings stay explicit alongside readable Markdown', async () => {
  const broken = { name: 'failed.md', kind: 'file', getFile() { throw new Error('Unavailable'); } };
  const root = folder('project', [file('good.md', '可讀'), broken, file('bad.md', new Uint8Array([0xff, 0xff]))]);
  const snapshot = await collectMarkdown(directory(root));
  assert.deepEqual(snapshot.files, [{ path: 'good.md', content: '可讀' }]); assert.ok(snapshot.incomplete);
  assert.ok(snapshot.limitations.some(value => value.includes('failed.md'))); assert.ok(snapshot.limitations.some(value => value.includes('bad.md')));
});

test('preloads full Markdown before sending and reuses it even when later disk enumeration stalls', async t => {
  browserFileReader(t);
  const visited = [], root = folder('project', [file('研究.md', '# 研究\n完整內容', visited)]);
  const preload = preloadMarkdownDirectory(directory(root)); t.after(() => preload.abort());
  const prepared = await preload.result;
  assert.deepEqual(visited, ['研究.md']);
  root.values = () => { throw new Error('Sending must not enumerate the disk again'); };
  const turns = await Promise.all(Array.from({ length: 4 }, () => preload.read(new AbortController().signal)));
  for (const bundle of turns) assert.equal(bundle, prepared);
  assert.equal(JSON.parse(Buffer.from(prepared.content, 'base64').toString('utf8')).files[0].content, '# 研究\n完整內容');
  assert.equal(visited.length, 1);
  preload.abort(); await assert.rejects(preload.read(new AbortController().signal), { name: 'AbortError' });
});

test('cancelling a waiting send preserves the shared preload for the next turn', async t => {
  browserFileReader(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; }), original = file('note.md', '全文');
  const handle = { ...original, async getFile() { await gate; return original.getFile(); } };
  const preload = preloadMarkdownDirectory(directory(folder('project', [handle]))); t.after(() => preload.abort());
  const controller = new AbortController(), waiting = preload.read(controller.signal);
  controller.abort(); await assert.rejects(waiting, { name: 'AbortError' });
  release();
  assert.equal((await preload.read(new AbortController().signal)).count, 1);
});

test('refresh creates a different content version while the previous snapshot stays immutable', async t => {
  browserFileReader(t);
  const root = folder('project', [file('note.md', '舊版')]);
  const old = preloadMarkdownDirectory(directory(root)); t.after(() => old.abort());
  const first = await old.result;
  root.values = async function* () { yield file('note.md', '新版'); };
  assert.equal(await old.read(new AbortController().signal), first);
  const updated = preloadMarkdownDirectory(directory(root)); t.after(() => updated.abort());
  const second = await updated.result;
  assert.notEqual(first.name, second.name);
  assert.equal(JSON.parse(Buffer.from(second.content, 'base64').toString('utf8')).files[0].content, '新版');
});

test('failed preloads do not retry a disk scan on every send or substitute directory metadata', async t => {
  let scans = 0;
  const root = folder('project', []); root.values = () => { scans++; throw new Error('Permission lost'); };
  const preload = preloadMarkdownDirectory(directory(root)); t.after(() => preload.abort());
  await assert.rejects(preload.result, /未取得任何 MD 內容/);
  for (let turn = 0; turn < 3; turn++) await assert.rejects(preload.read(new AbortController().signal), /訊息尚未送出/);
  assert.equal(scans, 1);
});
