import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { searchOptions, searchLimits } from '../packages/contracts/src/search.mjs';
import { FileSearchService } from '../apps/server/src/ssh/file-search-service.mjs';
import { searchInstruction } from '../apps/server/src/ssh/search-instruction.mjs';
import { CodexChat } from '../apps/server/src/ssh/codex-chat.mjs';
import { FilesService } from '../apps/server/src/ssh/files-service.mjs';
import { SshService } from '../apps/server/src/ssh/ssh-service.mjs';
import { sshFixture } from './helpers/ssh-fixture.mjs';
import { seedSearchFiles, searchRoot } from './helpers/search-fixtures.mjs';

async function workspace(t) {
  const fixture = await sshFixture(); seedSearchFiles(fixture);
  const profiles = { find: async (owner, id) => {
    assert.equal(owner, 'alice'); assert.equal(id, 'server');
    return { id, host: '127.0.0.1', port: fixture.port, username: 'tester', fingerprints: [fixture.fingerprint], credential: fixture.privateKey };
  } };
  const ssh = new SshService(profiles, { open: value => ({ privateKey: value }) }), files = new FilesService(ssh), search = new FileSearchService(files);
  t.after(async () => { ssh.close(); await fixture.close(); });
  const find = options => search.search('alice', 'server', { root: searchRoot, glob: '*', ...options });
  return { fixture, ssh, search, find };
}

test('search conditions require a root and filename scope with fixed maximum budgets', () => {
  const defaults = searchOptions({ root: '/project', glob: '*.py' });
  for (const [key, value] of Object.entries(searchLimits)) assert.equal(defaults[key], value);
  assert.equal(searchOptions({ root: '/project', glob: '*.py', maxDepth: 0 }).maxDepth, 0);
  for (const options of [null, {}, { root: '/', glob: '' }, { root: '/project', glob: '../*' }, { root: '/project', glob: '*', text: 'needle' }, { root: '/project', glob: '*.py', text: '' }, { root: '/project', glob: '*.py', text: 'a\nb' }]) assert.throws(() => searchOptions(options), error => error.status === 400);
  for (const [key, maximum] of Object.entries(searchLimits)) {
    for (const value of [-1, 1.5, maximum + 1, '2']) assert.throws(() => searchOptions({ root: '/project', glob: '*', [key]: value }), error => error.status === 400);
  }
});

test('filename then literal UTF-8 content searches reuse one SSH connection without shell commands', async t => {
  const { fixture, ssh, find } = await workspace(t);
  await assert.rejects(find({}), error => error.code === 'SSH_DISCONNECTED'); assert.equal(fixture.stats.connections, 0);
  await ssh.connect('alice', 'server');
  const names = await find({ root: `${searchRoot}/src`, glob: '*.py' });
  assert.equal(names.complete, true); assert.deepEqual(names.results.map(item => item.name), ['main.py']); assert.equal(names.counts.bytes, 0);
  assert.equal(fixture.sftpRequests.filter(item => item.method === 'open').length, 0);
  const text = await find({ root: `${searchRoot}/src`, glob: '*.py', text: 'needle' });
  assert.equal(text.complete, true); assert.deepEqual(text.results.map(item => item.line), [1, 2]);
  assert.equal(text.counts.bytes, fixture.fileMap.get(`${searchRoot}/src/main.py`).length);
  assert.equal(text.results[1].excerpt, 'second needle');
  assert.equal((await find({ root: `${searchRoot}/src`, glob: '*.py', text: 'NEEDLE' })).results.length, 1);
  assert.equal((await find({ root: `${searchRoot}/src`, glob: '*.py', text: '.*' })).results.length, 0);
  assert.equal(fixture.stats.authenticated, 1); assert.deepEqual(fixture.commands, []);
});

test('secrets, generated directories, links, binary, oversized and non-UTF-8 files are skipped explicitly', async t => {
  const { fixture, ssh, find } = await workspace(t); await ssh.connect('alice', 'server');
  const result = await find({ glob: '*.md', text: 'needle' });
  assert.equal(result.complete, false);
  for (const code of ['private_names_skipped', 'excluded_directories', 'links_skipped', 'large_files_skipped', 'binary_files_skipped', 'non_utf8_files_skipped']) assert.ok(result.limitations.includes(code), code);
  assert.deepEqual(result.results.map(item => item.name), ['README.md', 'notes.md']);
  for (const item of fixture.sftpRequests) assert.ok(!/\.env|node_modules|\.git|link\.md|large\.md/.test(item.path), item.path);
  const empty = await find({ glob: '*.absent' }); assert.equal(empty.results.length, 0); assert.equal(empty.complete, false);
});

test('root, entire home, private subdirectories and redirected roots are rejected without reading files', async t => {
  const { fixture, ssh, find } = await workspace(t); await ssh.connect('alice', 'server');
  for (const root of ['/', '~', '/home/tester', '/home/tester/.ssh', `${searchRoot}/../.codex`]) await assert.rejects(find({ root }), error => error.status === 403);
  fixture.directories.set(`${searchRoot}/redirected`, 0o755); fixture.symlinks.add(`${searchRoot}/redirected`);
  await assert.rejects(find({ root: `${searchRoot}/redirected` }), error => error.status === 400);
  await assert.rejects(find({ root: '/missing' }), error => error.status === 404);
  assert.equal(fixture.sftpRequests.length, 0);
});

test('depth, candidates, result count, per-file bytes and total bytes stop within their own budgets', async t => {
  const { ssh, find } = await workspace(t); await ssh.connect('alice', 'server');
  const cases = [
    [{ maxDepth: 0 }, 'max_depth', result => result.results.every(item => !item.path.includes('/src/'))],
    [{ glob: '*.md', text: 'missing', maxFiles: 1 }, 'max_files', result => result.counts.candidateFiles === 1],
    [{ maxResults: 1 }, 'max_results', result => result.results.length === 1],
    [{ glob: '*.md', text: 'needle', maxBytes: 8 }, 'large_files_skipped', result => result.results.length === 0],
    [{ glob: '*.md', text: 'needle', maxTotalBytes: 1 }, 'max_total_bytes', result => result.counts.bytes <= 1]
  ];
  for (const [options, code, verify] of cases) { const result = await find(options); assert.equal(result.complete, false); assert.ok(result.limitations.includes(code), code); assert.ok(verify(result), code); }
});

test('entry budget stops paged directory enumeration before fetching the remaining tree', async t => {
  const { fixture, ssh, find } = await workspace(t); await ssh.connect('alice', 'server');
  fixture.directories.set(`${searchRoot}/large-directory`, 0o755);
  for (let index = 0; index < 300; index++) fixture.fileMap.set(`${searchRoot}/large-directory/${index}.txt`, Buffer.from('bounded'));
  const result = await find({ root: `${searchRoot}/large-directory`, glob: '*.md', maxEntries: 5 });
  assert.equal(result.counts.entries, 5); assert.deepEqual(result.limitations, ['max_entries']);
  assert.equal(fixture.sftpRequests.filter(item => item.method === 'readdir').length, 1);
});

test('cross-user searches never reconnect or reuse another owner channel', async t => {
  const { fixture, ssh, search } = await workspace(t); await ssh.connect('alice', 'server');
  await assert.rejects(search.search('bob', 'server', { root: searchRoot, glob: '*' }), error => error.code === 'SSH_DISCONNECTED');
  assert.equal(fixture.stats.authenticated, 1); assert.equal(search.active.size, 0);
});

function stalledSearch() {
  const sftp = new EventEmitter(); let ended = 0;
  sftp.end = () => { ended++; };
  sftp.realpath = (file, callback) => callback(null, file === '.' ? '/home/tester' : file);
  sftp.lstat = (file, callback) => callback(null, { isDirectory: () => true, isSymbolicLink: () => false });
  sftp.opendir = () => {};
  const files = { ssh: { key: (owner, id) => `${owner}:${id}`, sftp: async () => sftp }, location: async () => searchRoot };
  return { search: new FileSearchService(files), ended: () => ended };
}

test('timeout, cancellation and concurrent searches release only their SFTP channel and clear the busy guard', async () => {
  const timed = stalledSearch();
  const result = await timed.search.search('alice', 'server', { root: searchRoot, glob: '*', timeoutMs: 20 });
  assert.equal(result.complete, false); assert.ok(result.limitations.includes('timeout')); assert.equal(timed.search.active.size, 0); assert.ok(timed.ended());
  const cancelled = stalledSearch(), controller = new AbortController();
  const pending = cancelled.search.search('alice', 'server', { root: searchRoot, glob: '*' }, controller.signal);
  await assert.rejects(cancelled.search.search('alice', 'server', { root: searchRoot, glob: '*' }), error => error.status === 409);
  controller.abort(); await assert.rejects(pending, error => error.status === 499);
  assert.equal(cancelled.search.active.size, 0); assert.ok(cancelled.ended());
});

test('the deadline also bounds opening SFTP and a late channel is closed without reconnecting', async () => {
  let accept, ended = 0;
  const files = { ssh: { key: () => 'alice:server', sftp: () => new Promise(resolve => { accept = resolve; }) } };
  const search = new FileSearchService(files);
  await assert.rejects(search.search('alice', 'server', { root: searchRoot, glob: '*', timeoutMs: 20 }), error => error.status === 408);
  assert.equal(search.active.size, 0);
  accept({ end: () => { ended++; } }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(ended, 1);
});

test('new and resumed Codex threads get scoped developer instructions without changing user input or approvals', () => {
  for (const threadId of [undefined, 'existing-thread']) {
    const input = [{ type: 'text', text: 'user prompt' }], sent = [];
    const chat = new CodexChat({}, 'alice', { threadId, executionMode: 'general', approvalMode: 'ask' }, input, { thread() {} });
    chat.channel = { write: data => sent.push(JSON.parse(data)) }; chat.cwd = '/project'; chat.version = 'codex-cli 0.161.0';
    chat.receive(JSON.stringify({ id: 1, result: {} }));
    const thread = sent.find(item => item.id === 2);
    assert.equal(thread.method, threadId ? 'thread/resume' : 'thread/start');
    assert.ok(thread.params.developerInstructions.startsWith(searchInstruction())); assert.equal(thread.params.sandbox, 'read-only');
    assert.match(thread.params.developerInstructions, /not an execution sandbox/); assert.match(thread.params.developerInstructions, /5000 directory entries/);
    chat.receive(JSON.stringify({ id: 2, result: { thread: { id: 'existing-thread' } } }));
    assert.deepEqual(sent.at(-1).params.input, input); assert.equal(input.length, 1);
  }
});
