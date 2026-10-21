import test from 'node:test';
import assert from 'node:assert/strict';
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
  const ssh = new SshService(profiles, { open: value => ({ privateKey: value }) }), moves = new FoldersService(new FilesService(ssh));
  fixture.directories.set('/home/tester/歸檔', 0o700);
  fixture.directories.set('/home/tester/second', 0o700);
  t.after(async () => { ssh.close(); await fixture.close(); });
  return { fixture, ssh, moves };
}

test('moving Unicode files uses one SFTP rename, preserves bytes and reuses the authenticated connection', async t => {
  const { fixture, ssh, moves } = await workspace(t);
  const source = "/home/tester/檔案 ' ; $(literal).jpg", data = Buffer.from([255, 216, 255, 0, 1, 2, 3]);
  fixture.fileMap.set(source, data);
  await assert.rejects(moves.moveFile('alice', 'server', source, '~/歸檔'), error => error.code === 'SSH_DISCONNECTED');
  assert.equal(fixture.stats.connections, 0);
  await ssh.connect('alice', 'server');
  const result = await moves.moveFile('alice', 'server', source, '~/歸檔');
  assert.equal(result.moved, true); assert.equal(result.source, source); assert.equal(result.directory, '/home/tester/歸檔');
  assert.deepEqual(fixture.fileMap.get(result.path), data); assert.equal(fixture.fileMap.has(source), false);
  const same = await moves.moveFile('alice', 'server', result.path, result.directory);
  assert.equal(same.moved, false);
  assert.equal(fixture.sftpRequests.filter(request => request.method === 'rename').length, 1);
  assert.equal(fixture.stats.authenticated, 1); assert.deepEqual(fixture.commands, []);
});

test('moves never overwrite a file, folder or link and concurrent moves serialize without losing either source', async t => {
  const { fixture, ssh, moves } = await workspace(t); await ssh.connect('alice', 'server');
  for (const name of ['duplicate.txt', 'folder.txt', 'link.txt']) fixture.fileMap.set(`/home/tester/${name}`, Buffer.from('source'));
  fixture.fileMap.set('/home/tester/歸檔/duplicate.txt', Buffer.from('original target'));
  fixture.directories.set('/home/tester/歸檔/folder.txt', 0o700);
  fixture.symlinks.add('/home/tester/歸檔/link.txt');
  for (const name of ['duplicate.txt', 'folder.txt', 'link.txt']) {
    await assert.rejects(moves.moveFile('alice', 'server', `/home/tester/${name}`, '~/歸檔'), error => error.status === 409);
    assert.equal(fixture.fileMap.get(`/home/tester/${name}`).toString(), 'source');
  }
  assert.equal(fixture.fileMap.get('/home/tester/歸檔/duplicate.txt').toString(), 'original target');
  fixture.fileMap.set('/home/tester/race.txt', Buffer.from('first')); fixture.fileMap.set('/home/tester/second/race.txt', Buffer.from('second'));
  const attempts = await Promise.allSettled([moves.moveFile('alice', 'server', '/home/tester/race.txt', '~/歸檔'), moves.moveFile('alice', 'server', '/home/tester/second/race.txt', '~/歸檔')]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(result => result.status === 'rejected').reason.status, 409);
  assert.equal(fixture.fileMap.get('/home/tester/second/race.txt').toString(), 'second');
  assert.equal(fixture.fileMap.get('/home/tester/歸檔/race.txt').toString(), 'first');
});

test('moves reject directories, symlinks, malformed paths and foreign owners without another SSH login', async t => {
  const { fixture, ssh, moves } = await workspace(t); await ssh.connect('alice', 'server');
  fixture.fileMap.set('/home/tester/link.txt', Buffer.from('link')); fixture.symlinks.add('/home/tester/link.txt');
  fixture.symlinks.add('/home/tester/linked-directory');
  for (const [source, destination, status] of [
    ['/home/tester/second', '~/歸檔', 400], ['/home/tester/link.txt', '~/歸檔', 400],
    ['/home/tester/readme.txt', '/home/tester/linked-directory', 400], ['/home/tester/missing.txt', '~/歸檔', 404],
    ['/home/tester/readme.txt', '~/missing', 404], ['../readme.txt', '~/歸檔', 400],
    ['/home/tester/../readme.txt', '~/歸檔', 400], ['/home/tester/readme.txt', '/bad\0path', 400],
    [null, '~/歸檔', 400], ['/home/tester/readme.txt', '', 400]
  ]) await assert.rejects(moves.moveFile('alice', 'server', source, destination), error => error.status === status, `${source} -> ${destination}`);
  await assert.rejects(moves.moveFile('bob', 'server', '/home/tester/readme.txt', '~/歸檔'), error => error.code === 'SSH_DISCONNECTED');
  assert.equal(fixture.fileMap.get('/home/tester/readme.txt').toString(), 'CozyPad test file\n');
  assert.equal(fixture.sftpRequests.filter(request => request.method === 'rename').length, 0);
  assert.equal(fixture.stats.authenticated, 1);
});
