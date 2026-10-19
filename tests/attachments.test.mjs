import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../apps/server/src/storage/json-store.mjs';
import { SshService } from '../apps/server/src/ssh/ssh-service.mjs';
import { AgentService } from '../apps/server/src/ssh/agent-service.mjs';
import { decodeAttachments, chatAttachments } from '../apps/server/src/ssh/agent-attachments.mjs';
import { extractDocument } from '../apps/server/src/ssh/document-parser.mjs';
import { attachmentLimits } from '../packages/contracts/src/attachments.mjs';
import { attachmentAccept, attachmentNameError } from '../packages/contracts/src/attachments.mjs';
import { body } from '../apps/server/src/http.mjs';
import { collectMarkdown } from '../apps/app/src/workspaces/markdown-directory.mjs';
import { sshFixture } from './helpers/ssh-fixture.mjs';
import { png, pdf, docx, pptx, officePackage, payload } from './helpers/attachment-fixtures.mjs';

const finished = (agent, id) => new Promise(resolve => {
  if (!agent.active.has(id)) { resolve(); return; }
  const listener = event => { if (event.type === 'status') { agent.events.off(id, listener); resolve(); } };
  agent.events.on(id, listener);
});
async function workspace(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cozypad-tt-attachments-'));
  const fixture = await sshFixture(), store = new JsonStore(directory);
  const profiles = { find: async (owner, id) => {
    if (owner !== 'alice' || id !== 'server') throw Object.assign(new Error('Not found'), { status: 404 });
    return { id, defaultPath: '~', host: '127.0.0.1', port: fixture.port, username: 'tester', fingerprints: [fixture.fingerprint], credential: fixture.privateKey };
  } };
  const ssh = new SshService(profiles, { open: value => ({ privateKey: value }) }), agent = new AgentService(store, profiles, ssh);
  t.after(async () => { agent.close(); ssh.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); });
  return { fixture, store, profiles, ssh, agent };
}

test('browser-selected Markdown content reaches the remote Codex input and complete readable attachment', { timeout: 15000 }, async t => {
  const { agent, fixture } = await workspace(t);
  const root = { name: 'markdown_bank', kind: 'directory', async *values() {
    for (let index = 0; index < 6; index++) yield { name: `筆記-${index}.md`, kind: 'file', async getFile() {
      const blob = new Blob([`# MD-${index}\n本機文件-${index}\n${index === 5 ? '長文'.repeat(35000) + 'MD_SENTINEL_END' : '全文'}`]);
      return { size: blob.size, arrayBuffer: () => blob.arrayBuffer() };
    } };
  } };
  const snapshot = await collectMarkdown({ root });
  const data = JSON.stringify({ format: 'cozypad-browser-markdown-v1', ...snapshot });
  const task = await agent.start('alice', { serverId: 'server', prompt: '請讀取本機 MD', localContext: { rootName: 'markdown_bank', path: '', incomplete: true, entries: [] }, attachments: [payload('本機MD-markdown_bank.txt', data)] });
  await finished(agent, task.id);
  assert.equal((await agent.find('alice', task.id)).status, 'completed');
  const inputs = fixture.chatRequests.find(request => request.method === 'turn/start').params.input;
  const document = JSON.parse(inputs.find(input => input.type === 'text' && input.text.startsWith('附件資料')).text.split('\n').slice(1).join('\n'));
  assert.match(document.content, /本機文件-0/); assert.ok(document.notice);
  const complete = JSON.parse(fixture.fileMap.get(document.extractedTextPath).toString('utf8'));
  assert.equal(complete.files.length, 6); assert.equal(complete.files.at(-1).path, '筆記-5.md'); assert.match(complete.files.at(-1).content, /MD_SENTINEL_END$/);
  assert.equal(complete.incomplete, false); assert.equal(fixture.stats.authenticated, 1);
});

test('attachment validation rejects unsafe names, formats, base64 and excessive sizes', () => {
  assert.deepEqual(decodeAttachments(), []);
  const [image] = decodeAttachments([{ ...payload('螢幕截圖.PNG', png), mimeType: 'text/html' }]);
  assert.equal(image.metadata.kind, 'image'); assert.equal(image.metadata.mimeType, 'image/png');
  for (const value of [null, {}, [payload('../key.txt', 'key')], [payload('a\\b.txt', 'x')], [payload('evil.svg', '<svg />')], [payload('fake.png', '<script>')], [{ name: 'x.txt', content: '!!!=' }], [{ name: 'x.txt', content: 'YR==' }], [{ name: 'x.txt', content: '' }], Array.from({ length: 6 }, () => payload('x.txt', 'x'))]) {
    assert.throws(() => decodeAttachments(value), error => [400, 415].includes(error.status));
  }
  assert.throws(() => decodeAttachments([payload('big.txt', Buffer.alloc(attachmentLimits.bytes + 1))]), error => error.status === 400 || error.status === 413);
  const [maximum] = decodeAttachments([payload('maximum.txt', Buffer.alloc(attachmentLimits.bytes, 'x'))]);
  assert.equal(maximum.metadata.size, 30 * 1048576);
  assert.throws(() => decodeAttachments([payload('a.txt', Buffer.alloc(16000000, 'a')), payload('b.txt', Buffer.alloc(16000000, 'b'))]), error => error.status === 413);
});

test('30 MB attachments fit the HTTP JSON envelope without relaxing other routes', async () => {
  const requestData = Buffer.from(JSON.stringify({ attachments: [payload('large.txt', Buffer.alloc(attachmentLimits.bytes, 'x'))] }));
  const request = () => ({ headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield requestData.subarray(0, 1000000); yield requestData.subarray(1000000); } });
  const parsed = await body(request(), Math.ceil(attachmentLimits.bytes / 3) * 4 + 262144);
  assert.equal(decodeAttachments(parsed.attachments)[0].metadata.size, attachmentLimits.bytes);
  await assert.rejects(body(request()), error => error.status === 413);
});

test('PPTX slides follow presentation order and include notes while rejecting malformed packages', { timeout: 15000 }, async () => {
  assert.ok(attachmentAccept.includes('.pptx'));
  assert.match(attachmentNameError('old.ppt'), /PPTX 或 PDF/);
  const data = await pptx({ order: [1, 0] });
  assert.equal(decodeAttachments([payload('簡報.PPTX', data)])[0].metadata.mimeType, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  const text = await extractDocument(data, 'pptx');
  assert.ok(text.indexOf('簡報第二頁') < text.indexOf('簡報第一頁'));
  assert.match(text, /第 1 頁\n簡報第二頁/); assert.match(text, /簡報第一頁 & 重點/); assert.match(text, /講者備註測試/); assert.ok(!text.includes('Ignore slide number'));
  await assert.rejects(extractDocument(await docx(), 'pptx'), /不是有效/);
  await assert.rejects(extractDocument(await pptx({ slides: [''], notes: [] }), 'pptx'), /沒有可讀文字/);
  await assert.rejects(extractDocument(await pptx({ slides: Array(101).fill('slide') }), 'pptx'), /100 頁/);
  await assert.rejects(extractDocument(await pptx({ slides: ['x'.repeat(1000001)] }), 'pptx'), /1,000,000/);
  await assert.rejects(extractDocument(await pptx({ slideTarget: '../../outside.xml' }), 'pptx'), /超出允許範圍/);
  await assert.rejects(extractDocument(await pptx({ extra: { 'ppt/slides/slide1.xml': '<!DOCTYPE xml [<!ENTITY payload SYSTEM "file:///C:/secret">]><xml/>' } }), 'pptx'), /DTD/);
  await assert.rejects(extractDocument(await pptx({ extra: { 'ppt/slides/slide1.xml': '<xml><broken>' } }), 'pptx'), /格式不正確/);
  await assert.rejects(extractDocument(await officePackage({ 'ppt/presentation.xml': 'x', 'bomb.bin': Buffer.alloc(68000000) }), 'pptx'), /解壓縮內容過大/);
});

test('document parsing extracts PDF, DOCX and encoded text, with resource limits and cancellation', { timeout: 15000 }, async () => {
  assert.match(await extractDocument(pdf(), 'pdf'), /Attachment PDF text/);
  assert.match(await extractDocument(await docx(), 'docx'), /文件測試內容/);
  assert.equal(await extractDocument(Buffer.from('中文 CSV,42'), 'csv'), '中文 CSV,42');
  assert.equal(await extractDocument(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Windows 中文文件', 'utf16le')]), 'txt'), 'Windows 中文文件');
  await assert.rejects(extractDocument(pdf('No more than 100 pages', 101), 'pdf'), /100 頁/);
  await assert.rejects(extractDocument(pdf(''), 'pdf'), /沒有可讀文字/);
  assert.equal((await extractDocument(Buffer.from('x'.repeat(60001)), 'txt')).length, 60001);
  await assert.rejects(extractDocument(Buffer.from('x'.repeat(1000001)), 'txt'), /1,000,000/);
  await assert.rejects(extractDocument(Buffer.from([0xc0, 0xff]), 'txt'), error => error.status === 415);
  await assert.rejects(extractDocument(Buffer.from('binary\0content'), 'txt'), /二進位/);
  await assert.rejects(extractDocument(await docx('x'.repeat(68000000)), 'docx'), /解壓縮內容過大/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(extractDocument(pdf(), 'pdf', controller.signal), /取消/);
});

test('Word streams complex formatting without a DOM and preserves tables, breaks and referenced notes', { timeout: 15000 }, async () => {
  const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const run = '<w:r><w:rPr><w:b/><w:color w:val="333333"/><w:sz w:val="24"/></w:rPr><w:t></w:t></w:r>';
  const document = `<w:document xmlns:w="${ns}"><w:body><w:p>${run.repeat(100000)}<w:r><w:t>中文 &amp; 表格</w:t><w:tab/><w:t>欄位</w:t><w:br/><w:t>換行</w:t><w:footnoteReference w:id="1"/></w:r><w:del><w:r><w:t>不應含已刪除內容</w:t></w:r></w:del></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`;
  const data = await officePackage({ 'word/document.xml': document, 'word/media/ignored.png': Buffer.alloc(32000000, 7), 'word/footnotes.xml': `<w:footnotes xmlns:w="${ns}"><w:footnote w:id="-1"><w:p><w:r><w:t>忽略分隔註</w:t></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:r><w:t>註腳文字</w:t></w:r></w:p></w:footnote></w:footnotes>` });
  const text = await extractDocument(data, 'docx');
  assert.match(text, /中文 & 表格\t欄位\n換行/); assert.match(text, /A\n\n\tB/); assert.match(text, /註腳文字/); assert.ok(!text.includes('不應含')); assert.ok(!text.includes('忽略分隔註'));
  await assert.rejects(extractDocument(await officePackage({ 'word/document.xml': '<!DOCTYPE xml><xml/>' }), 'docx'), /DTD/);
  await assert.rejects(extractDocument(await officePackage({ 'word/document.xml': '<xml><broken>' }), 'docx'), /Word/);
  await assert.rejects(extractDocument(await docx('x'.repeat(1000001)), 'docx'), /1,000,000/);
  assert.match(await extractDocument(await docx('失敗後仍可解析'), 'docx'), /失敗後仍可解析/);
});

test('long Word documents keep full remote text while only bounded excerpts enter the prompt', { timeout: 15000 }, async t => {
  const { agent, fixture } = await workspace(t);
  const text = `${'document text '.repeat(6500)}最後一段`;
  const task = await agent.start('alice', { serverId: 'server', prompt: 'read long Word', attachments: [payload('large.docx', await docx(text)), payload('second.docx', await docx(text)), payload('third.docx', await docx(text))] });
  await finished(agent, task.id);
  assert.equal((await agent.find('alice', task.id)).status, 'completed');
  const input = fixture.chatRequests.find(request => request.method === 'turn/start').params.input.slice(1).map(item => JSON.parse(item.text.split('\n').slice(1).join('\n')));
  assert.equal(input.reduce((length, document) => length + document.content.length, 0), 120000);
  assert.ok(input.every(document => document.totalCharacters > 60000 && document.notice));
  assert.ok(input.every(document => fixture.fileMap.get(document.extractedTextPath).toString('utf8').includes('最後一段')));
  assert.equal(fixture.stats.connections, 1);
});

test('image and document attachments reach the same Codex conversation using one SSH connection', { timeout: 15000 }, async t => {
  const { agent, fixture, store, profiles, ssh } = await workspace(t);
  const files = [payload('截圖.png', png), payload('report.pdf', pdf()), payload('報告.docx', await docx()), payload('簡報.pptx', await pptx())];
  const task = await agent.start('alice', { serverId: 'server', prompt: '分析附件', approvalMode: 'ask', attachments: files });
  assert.equal(task.events[0].attachments.length, 4);
  assert.ok(!JSON.stringify(task).includes(files[0].content));
  await finished(agent, task.id);
  const first = await agent.find('alice', task.id);
  assert.equal(first.status, 'completed'); assert.equal(first.attachmentManifest.length, 4);
  const input = fixture.chatRequests.find(request => request.method === 'turn/start').params.input;
  assert.deepEqual(input.map(item => item.type), ['text', 'localImage', 'text', 'text', 'text']);
  assert.ok(input.some(item => item.text?.includes('Attachment PDF text')));
  assert.ok(input.some(item => item.text?.includes('文件測試內容')));
  assert.ok(input.some(item => item.text?.includes('講者備註測試')));
  assert.ok(fixture.fileMap.get(input[1].path).equals(png));
  assert.ok(input[1].path.startsWith(`/home/tester/.cozypad-tt/attachments/alice/${task.id}/`));
  assert.ok([...fixture.directories.entries()].filter(([file]) => file.includes('.cozypad-tt')).every(([, mode]) => mode === 0o700));
  const attachment = first.attachmentManifest[0];
  assert.ok((await agent.attachments.read('alice', first, attachment.id)).data.equals(png));
  await assert.rejects(agent.find('bob', task.id), error => error.status === 404);
  await assert.rejects(agent.attachments.read('bob', first, attachment.id), error => error.status === 404);
  await assert.rejects(agent.attachments.read('alice', first, '../../key'), error => error.status === 404);
  const resumed = await agent.start('alice', { serverId: 'server', prompt: '', resumeTaskId: task.id, attachments: [payload('截圖.png', png), payload('資料.csv', '名稱,數字\n測試,42')] });
  await finished(agent, resumed.id);
  const final = await agent.find('alice', task.id);
  assert.equal(final.turnCount, 2); assert.equal(final.id, first.id); assert.equal(final.threadId, first.threadId);
  assert.equal(chatAttachments(final).length, 6);
  assert.equal(new Set(chatAttachments(final).map(file => file.id)).size, 6);
  assert.match(fixture.chatRequests.filter(request => request.method === 'turn/start').at(-1).params.input.at(-1).text, /測試,42/);
  const restored = await new AgentService(store, profiles, ssh).find('alice', task.id);
  assert.ok((await agent.attachments.read('alice', restored, attachment.id)).data.equals(png));
  // Cleanup still has its manifest if old user messages were trimmed from the timeline.
  restored.events = restored.events.filter(event => event.type !== 'user'); await agent.chats.save('alice', restored);
  await agent.delete('alice', task.id);
  assert.equal(fixture.fileMap.get('/home/tester/readme.txt').toString(), 'CozyPad test file\n');
  assert.ok(![...fixture.fileMap.keys(), ...fixture.directories.keys()].some(file => file.startsWith(first.remoteAttachmentDirectory)));
  await assert.rejects(readdir(agent.attachments.localDirectory('alice', final)), error => error.code === 'ENOENT');
  assert.deepEqual(await agent.list('alice'), []);
  assert.equal(fixture.stats.connections, 1); assert.equal(fixture.stats.authenticated, 1);
});

test('partial attachment cleanup retains history, cannot resume, and can retry without deleting the thread twice', { timeout: 10000 }, async t => {
  const { agent, fixture } = await workspace(t);
  const task = await agent.start('alice', { serverId: 'server', prompt: 'image', attachments: [payload('image.png', png)] });
  await finished(agent, task.id);
  const final = await agent.find('alice', task.id), unknown = `${final.remoteAttachmentDirectory}/keep-project.txt`;
  fixture.symlinks.add(final.remoteAttachmentDirectory);
  await assert.rejects(agent.delete('alice', task.id), error => error.status === 409);
  assert.ok([...fixture.fileMap.keys()].some(file => file.startsWith(final.remoteAttachmentDirectory)));
  assert.equal(fixture.fileMap.get('/home/tester/readme.txt').toString(), 'CozyPad test file\n');
  fixture.symlinks.clear();
  fixture.fileMap.set(unknown, Buffer.from('Do not delete'));
  await assert.rejects(agent.delete('alice', task.id), error => error.status === 502);
  const remaining = await agent.find('alice', task.id);
  assert.equal(remaining.remoteThreadDeleted, true); assert.ok(fixture.fileMap.has(unknown));
  await assert.rejects(agent.start('alice', { serverId: 'server', prompt: 'resume', resumeTaskId: task.id }), error => error.status === 409);
  assert.ok((await agent.attachments.read('alice', remaining, remaining.attachmentManifest[0].id)).data.equals(png));
  fixture.fileMap.delete(unknown);
  await agent.delete('alice', task.id);
  assert.equal(fixture.cleanupRequests.filter(request => request.method === 'thread/delete').length, 1);
  assert.equal(fixture.stats.connections, 1);
});

test('symlinked remote directories are rejected and cancelled parsing never starts Codex', { timeout: 10000 }, async t => {
  const { agent, fixture } = await workspace(t);
  fixture.symlinks.add('/home/tester/.cozypad-tt');
  const unsafe = await agent.start('alice', { serverId: 'server', prompt: 'image', attachments: [payload('image.png', png)] });
  await finished(agent, unsafe.id);
  assert.equal((await agent.find('alice', unsafe.id)).status, 'failed');
  assert.ok((await agent.find('alice', unsafe.id)).events.some(event => event.type === 'error' && /不是一般目錄/.test(event.text)));
  assert.equal(fixture.chatRequests.length, 0);
  await agent.delete('alice', unsafe.id);
  fixture.symlinks.clear();
  const cancelled = await agent.start('alice', { serverId: 'server', prompt: 'cancel', attachments: [payload('report.pdf', pdf())] });
  const stopped = finished(agent, cancelled.id); await agent.cancel('alice', cancelled.id); await stopped;
  assert.equal((await agent.find('alice', cancelled.id)).status, 'cancelled');
  assert.equal(fixture.chatRequests.length, 0);
  await agent.delete('alice', cancelled.id);
  assert.equal(fixture.fileMap.size, 1); assert.equal(fixture.stats.connections, 1);
});
