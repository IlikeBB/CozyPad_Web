import test from 'node:test';
import assert from 'node:assert/strict';
import { pathAfterMove, treeAfterMove } from '../packages/contracts/src/file-moves.mjs';
import { FilesService } from '../apps/server/src/ssh/files-service.mjs';

const folder = path => ({ path, name: path.split('/').at(-1), directory: true });
const file = path => ({ ...folder(path), directory: false });
const move = { source: '/project/src', path: '/project/archive/src', directory: '/project/archive', moved: true, kind: 'directory' };

test('folder move retargets loaded subtrees and paths without changing prefix siblings or the input', () => {
  const tree = { '/project': [folder('/project/src'), folder('/project/src2'), folder('/project/archive')], '/project/src': [folder('/project/src/nested')], '/project/src/nested': [file('/project/src/nested/a.txt')], '/project/archive': [file('/project/archive/existing.txt')], '/project/archive/src': [file('/project/archive/src/stale.txt')] };
  const before = structuredClone(tree), next = treeAfterMove(tree, move);
  assert.deepEqual(tree, before); assert.deepEqual(next['/project'].map(entry => entry.path), ['/project/src2', '/project/archive']);
  assert.deepEqual(next['/project/archive/src/nested'], [file('/project/archive/src/nested/a.txt')]);
  assert.deepEqual(next['/project/archive/src'], [folder('/project/archive/src/nested')]);
  assert.equal(next['/project/src'], undefined);
  assert.deepEqual(next['/project/archive'].map(entry => entry.path), ['/project/archive/src', '/project/archive/existing.txt']);
  assert.equal(pathAfterMove('/project/src2/file', move), '/project/src2/file');
  assert.equal(pathAfterMove('/project/src/nested', move), '/project/archive/src/nested');
});

test('moving to an unread folder keeps its listing unknown, and no-op moves preserve state', () => {
  const tree = { '/project': [folder(move.source), folder(move.directory)] };
  assert.equal(treeAfterMove(tree, move)[move.directory], undefined);
  assert.equal(treeAfterMove(tree, { ...move, moved: false }), tree);
  const fileMove = { ...move, kind: 'file' };
  assert.equal(pathAfterMove('/project/src/child', fileMove), '/project/src/child');
});

test('absolute listings skip home lookup while relative, tilde and Windows paths retain resolution', async () => {
  const calls = [], sftp = { platform: 'linux', realpath: (value, callback) => { calls.push(value); callback(null, '/home/tester'); }, readdir: (value, callback) => { calls.push(`list:${value}`); callback(null, []); }, end() {} };
  const files = new FilesService({ sftp: async () => sftp });
  assert.deepEqual(await files.list('owner', 'server', '/project/one/../two'), { path: '/project/two', entries: [] });
  assert.deepEqual(calls, ['list:/project/two']); calls.length = 0;
  assert.equal(await files.location(sftp, '~/project'), '/home/tester/project');
  assert.equal(await files.location(sftp, 'child', '~/project'), '/home/tester/project/child');
  assert.deepEqual(calls, ['.', '.']); calls.length = 0; sftp.platform = 'win32';
  assert.equal(await files.location(sftp, 'C:\\Users\\tester'), '/C:/Users/tester'); assert.deepEqual(calls, []);
});
