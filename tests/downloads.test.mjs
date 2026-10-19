import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { remoteFilePath } from '../packages/contracts/src/remote-file-links.mjs';
import { JsonStore } from '../apps/server/src/storage/json-store.mjs';
import { AgentService } from '../apps/server/src/ssh/agent-service.mjs';
import { SshService } from '../apps/server/src/ssh/ssh-service.mjs';
import { FilesService } from '../apps/server/src/ssh/files-service.mjs';
import { AgentFileDownloads } from '../apps/server/src/ssh/agent-file-downloads.mjs';
import { sshFixture } from './helpers/ssh-fixture.mjs';
import { generatedDocument, unusualName, seedDownloadFiles } from './helpers/download-fixtures.mjs';

test('Markdown file destinations retain encoded names and handle sandbox, file and source citations safely', () => {
  for (const [url, expected] of [
    ['/home/user/report.docx', '/home/user/report.docx'],
    ['outputs/report.pdf', 'outputs/report.pdf'],
    ['../report.pdf', '../report.pdf'],
    ['~/report.pdf', '~/report.pdf'],
    ['sandbox:/mnt/data/report.pdf', '/mnt/data/report.pdf'],
    ['file:///home/user/report.pdf', '/home/user/report.pdf'],
    ['sandbox:/mnt/data/a%20%2B%20%23%20%3F.docx', '/mnt/data/a + # ?.docx'],
    ['/home/user/script.py:12:3', '/home/user/script.py'],
    ['/home/user/script.py#L12', '/home/user/script.py'],
    ['README.md?download=1', 'README.md']
  ]) assert.equal(remoteFilePath(url), expected);
  for (const invalid of [null, '', '#section', '?query=1', 'https://example.com/a.pdf', '//example.com/a.pdf', 'mailto:user@example.com', 'javascript:alert(1)', 'data:text/html,x', 'file://other-host/file.pdf', '/api/health', '/api', '/', '~', '/file%00.pdf', '/file%0A.pdf', '/file%ZZ.pdf', 'sandbox://other-host/file.pdf', 'C:\\file.pdf', 'java%73cript%3Aalert%281%29']) assert.equal(remoteFilePath(invalid), null, String(invalid));
});

test('task downloads use the owning server and recorded working directory without authenticating again', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cozypad-tt-downloads-'));
  const fixture = await sshFixture(); seedDownloadFiles(fixture);
  const store = new JsonStore(directory);
  const profiles = { find: async (owner, id) => {
    assert.equal(owner, 'alice'); assert.equal(id, 'own-server');
    return { id, host: '127.0.0.1', port: fixture.port, username: 'tester', fingerprints: [fixture.fingerprint], credential: fixture.privateKey };
  } };
  const ssh = new SshService(profiles, { open: value => ({ privateKey: value }) });
  const agents = new AgentService(store, profiles, ssh), files = new FilesService(ssh), downloads = new AgentFileDownloads(agents, files);
  t.after(async () => { agents.close(); ssh.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); });
  const task = { id: 'download-task', serverId: 'own-server', prompt: 'outputs', path: '~/my project', cwd: '/home/tester/my project', status: 'completed', createdAt: 1,
    events: [{ id: 1, type: 'assistant', text: 'old file', cwd: '/home/tester/older', time: 1 }] };
  await agents.chats.save('alice', task);
  await assert.rejects(downloads.read('alice', task.id, 'downloads/output.docx'), error => error.code === 'SSH_DISCONNECTED');
  assert.equal(fixture.stats.connections, 0);
  await ssh.connect('alice', task.serverId);
  const results = await Promise.all(Array.from({ length: 4 }, () => downloads.read('alice', task.id, `downloads/${unusualName}`)));
  assert.ok(results.every(result => result.data.equals(generatedDocument)));
  assert.equal((await downloads.read('alice', task.id, 'readme.txt', '/home/tester/older')).data.toString(), 'older working directory\n');
  assert.match((await downloads.read('alice', task.id, '/home/tester/report.pdf')).data.toString(), /^%PDF/);
  await assert.rejects(downloads.read('bob', task.id, '/home/tester/report.pdf'), error => error.status === 404);
  await assert.rejects(downloads.read('alice', task.id, 'readme.txt', '/unrecorded'), error => error.status === 400);
  await assert.rejects(downloads.read('alice', task.id, '/home/tester/missing.docx'), error => error.status === 404 && /找不到/.test(error.message));
  await assert.rejects(downloads.read('alice', task.id, '/home/tester'), error => error.status === 400 && /一般檔案/.test(error.message));
  for (const invalid of [null, '', 'https://example.com/key', '/file\0.docx', '//other-host/file', 'C:\\file.pdf']) await assert.rejects(downloads.read('alice', task.id, invalid), error => error.status === 400);
  fixture.fileMap.set('/home/tester/large.bin', Buffer.alloc(11 * 1048576, 42));
  assert.equal((await downloads.read('alice', task.id, '/home/tester/large.bin')).data.length, 11 * 1048576);
  fixture.fileMap.set('/home/tester/too-large.bin', Buffer.alloc(30 * 1048576 + 1));
  await assert.rejects(downloads.read('alice', task.id, '/home/tester/too-large.bin'), error => error.status === 413);
  const restored = new AgentFileDownloads(new AgentService(store, profiles, ssh), files);
  assert.ok((await restored.read('alice', task.id, `downloads/${unusualName}`)).data.equals(generatedDocument));
  assert.equal(fixture.stats.connections, 1); assert.equal(fixture.stats.authenticated, 1); assert.deepEqual(fixture.commands, []);
});
