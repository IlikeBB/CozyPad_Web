import test from 'node:test';
import assert from 'node:assert/strict';
import { folderNameError } from '../packages/contracts/src/folders.mjs';
import { FoldersService } from '../apps/server/src/ssh/folders-service.mjs';
import { FilesService } from '../apps/server/src/ssh/files-service.mjs';
import { SshService } from '../apps/server/src/ssh/ssh-service.mjs';
import { sshFixture } from './helpers/ssh-fixture.mjs';

async function workspace(t) {
  const fixture = await sshFixture();
  const profiles = { find: async (owner, id) => {
    assert.equal(owner, 'alice'); assert.equal(id, 'server');
    return { id, host: '127.0.0.1', port: fixture.port, username: 'tester', fingerprints: [fixture.fingerprint], credential: fixture.privateKey };
  } };
  const ssh = new SshService(profiles, { open: value => ({ privateKey: value }) }), files = new FilesService(ssh), folders = new FoldersService(files);
  fixture.directories.set('/', 0o755); fixture.directories.set('/home', 0o755);
  t.after(async () => { ssh.close(); await fixture.close(); });
  return { fixture, ssh, files, folders };
}

test('folder names accept Unicode and literal shell punctuation but reject traversal and excessive UTF-8 length', () => {
  for (const name of ['中文資料夾', '.hidden', "folder ' ; $(touch anything)", 'a'.repeat(255)]) assert.equal(folderNameError(name), '');
  for (const name of [null, '', ' ', '.', '..', '../folder', 'a/b', 'a\\b', 'a\0b', 'a\nb', 'a'.repeat(256), '中'.repeat(86)]) assert.ok(folderNameError(name));
});

test('create, rename and empty-folder deletion preserve contents and use only one authenticated SSH connection', async t => {
  const { fixture, ssh, files, folders } = await workspace(t);
  await assert.rejects(folders.create('alice', 'server', '~', 'first'), error => error.code === 'SSH_DISCONNECTED');
  assert.equal(fixture.stats.connections, 0);
  await ssh.connect('alice', 'server');
  const name = "中文資料夾 ' ; $(literal)";
  assert.equal((await folders.create('alice', 'server', '~', name)).path, `/home/tester/${name}`);
  assert.equal(fixture.directories.get(`/home/tester/${name}`), 0o755);
  fixture.fileMap.set(`/home/tester/${name}/data.txt`, Buffer.from('preserve me'));
  fixture.directories.set(`/home/tester/${name}/nested`, 0o700);
  await folders.rename('alice', 'server', '~', name, '更名後');
  assert.equal(fixture.fileMap.get('/home/tester/更名後/data.txt').toString(), 'preserve me');
  assert.ok(fixture.directories.has('/home/tester/更名後/nested')); assert.ok(!fixture.directories.has(`/home/tester/${name}`));
  assert.ok((await files.list('alice', 'server', '~')).entries.some(entry => entry.name === '更名後'));
  await folders.create('alice', 'server', '~', 'empty'); await folders.delete('alice', 'server', '~', 'empty');
  assert.ok(!fixture.directories.has('/home/tester/empty'));
  const simultaneous = await Promise.allSettled([folders.create('alice', 'server', '~', 'collision'), folders.create('alice', 'server', '~', 'collision')]);
  assert.equal(simultaneous.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(simultaneous.find(result => result.status === 'rejected').reason.status, 409);
  await assert.rejects(folders.rename('alice', 'server', '~', '更名後', 'collision'), error => error.status === 409);
  await assert.rejects(folders.create('alice', 'server', '~', 'readme.txt'), error => error.status === 409);
  await assert.rejects(folders.rename('alice', 'server', '~', 'readme.txt', 'other'), error => error.status === 400);
  await assert.rejects(folders.create('bob', 'server', '~', 'unauthorized'), error => error.code === 'SSH_DISCONNECTED');
  assert.equal(fixture.fileMap.get('/home/tester/readme.txt').toString(), 'CozyPad test file\n');
  assert.equal(fixture.stats.connections, 1); assert.equal(fixture.stats.authenticated, 1); assert.deepEqual(fixture.commands, []);
});

test('recursive deletion requires exact confirmation, blocks home and links, and never follows child symlinks', async t => {
  const { fixture, ssh, folders } = await workspace(t); await ssh.connect('alice', 'server');
  await folders.create('alice', 'server', '~', 'tree'); await folders.create('alice', 'server', '~/tree', 'child');
  fixture.fileMap.set('/home/tester/tree/child/data.txt', Buffer.from('delete only this'));
  fixture.fileMap.set('/home/tester/tree/.hidden', Buffer.from('hidden'));
  fixture.fileMap.set('/home/tester/tree/link', Buffer.from('link')); fixture.symlinks.add('/home/tester/tree/link');
  await assert.rejects(folders.delete('alice', 'server', '~', 'tree'), error => error.status === 409);
  await assert.rejects(folders.delete('alice', 'server', '~', 'tree', true, 'incorrect'), error => error.status === 400);
  await assert.rejects(folders.delete('alice', 'server', '~', 'tree', 'true', 'tree'), error => error.status === 400);
  await assert.rejects(folders.delete('alice', 'server', '/home', 'tester', true, 'tester'), error => error.status === 403);
  await assert.rejects(folders.rename('alice', 'server', '/home', 'tester', 'different'), error => error.status === 403);
  await assert.rejects(folders.delete('alice', 'server', '/', '..'), error => error.status === 400);
  await assert.rejects(folders.delete('alice', 'server', '~/tree', 'link'), error => error.status === 400);
  assert.ok(fixture.fileMap.has('/home/tester/tree/.hidden'));
  assert.equal((await folders.delete('alice', 'server', '~', 'tree', true, 'tree')).removed, 5);
  assert.ok(![...fixture.fileMap.keys(), ...fixture.directories.keys()].some(file => file.startsWith('/home/tester/tree')));
  assert.ok(!fixture.symlinks.has('/home/tester/tree/link'));
  assert.equal(fixture.fileMap.get('/home/tester/readme.txt').toString(), 'CozyPad test file\n');
  assert.equal(fixture.stats.connections, 1);
});

test('deletion preflight bounds total items and depth before removing any files', async t => {
  const { fixture, ssh, folders } = await workspace(t); await ssh.connect('alice', 'server');
  await folders.create('alice', 'server', '~', 'large');
  for (let index = 0; index < 2000; index++) fixture.fileMap.set(`/home/tester/large/${index}.txt`, Buffer.from('safe'));
  await assert.rejects(folders.delete('alice', 'server', '~', 'large', true, 'large'), error => error.status === 413);
  assert.equal([...fixture.fileMap.keys()].filter(file => file.startsWith('/home/tester/large/')).length, 2000);
  fixture.directories.set('/home/tester/deep', 0o700); let target = '/home/tester/deep';
  for (let index = 0; index < 33; index++) { target += '/child'; fixture.directories.set(target, 0o700); }
  fixture.fileMap.set(`${target}/safe.txt`, Buffer.from('preserve'));
  await assert.rejects(folders.delete('alice', 'server', '~', 'deep', true, 'deep'), error => error.status === 413);
  assert.ok(fixture.fileMap.has(`${target}/safe.txt`));
});
