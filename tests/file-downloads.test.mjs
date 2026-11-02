import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { serveRemoteFile } from '../apps/server/src/ssh/media-preview.mjs';
import { serveFolderArchive } from '../apps/server/src/ssh/folder-download.mjs';
import { FilesService } from '../apps/server/src/ssh/files-service.mjs';
import { SshService } from '../apps/server/src/ssh/ssh-service.mjs';
import { failure } from '../apps/server/src/http.mjs';
import { sshFixture } from './helpers/ssh-fixture.mjs';
import { downloadFolderName, downloadFileName, nestedText, expectedArchiveCommand, seedFolderDownloads } from './helpers/folder-download-fixtures.mjs';

const root = '/home/tester/downloads';
async function setup(t, options) {
  const fixture = await sshFixture(), seeded = await seedFolderDownloads(fixture, root);
  const ssh = new SshService({ find: async (owner, id) => {
    assert.equal(owner, 'alice'); assert.equal(id, 'server');
    return { id, host: '127.0.0.1', port: fixture.port, username: 'tester', fingerprints: [fixture.fingerprint], credential: fixture.privateKey };
  } }, { open: value => ({ privateKey: value }) });
  const files = new FilesService(ssh);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    try { await (url.pathname === '/archive' ? serveFolderArchive(request, response, files, request.headers['x-owner'] || 'alice', 'server', url.searchParams.get('path'), options) : serveRemoteFile(request, response, files, request.headers['x-owner'] || 'alice', 'server', url.searchParams.get('path'))); }
    catch (error) { failure(response, error); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); ssh.close(); await fixture.close(); });
  const request = (type, file, options) => fetch(`http://127.0.0.1:${server.address().port}/${type}?${new URLSearchParams({ path: file })}`, options);
  return { fixture, ssh, request, ...seeded };
}

test('single-file downloads stream binary files above 10 MB, preserve names and support ranges and empty files', async t => {
  const { fixture, ssh, request } = await setup(t); const file = `${root}/${downloadFileName}`;
  assert.equal((await request('download', file)).status, 409); assert.equal(fixture.stats.connections, 0);
  await ssh.connect('alice', 'server');
  const response = await request('download', file);
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.match(response.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''/);
  assert.equal(decodeURIComponent(response.headers.get('content-disposition').split("''")[1]), downloadFileName);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), fixture.fileMap.get(file));
  const partial = await request('download', file, { headers: { range: 'bytes=100-120' } });
  assert.equal(partial.status, 206); assert.deepEqual(Buffer.from(await partial.arrayBuffer()), fixture.fileMap.get(file).subarray(100, 121));
  const head = await request('download', file, { method: 'HEAD' }); assert.equal(Number(head.headers.get('content-length')), 11 * 1048576 + 5);
  const empty = await request('download', `${root}/empty.txt`); assert.equal(empty.status, 200); assert.equal((await empty.arrayBuffer()).byteLength, 0);
  assert.equal(fixture.stats.authenticated, 1); assert.deepEqual(fixture.commands, []);
});

test('folder downloads preserve a real archive above 4 MB, nested and empty directories, hidden files and Unicode names', async t => {
  const { fixture, ssh, request, directory, archive } = await setup(t); await ssh.connect('alice', 'server');
  const response = await request('archive', directory); assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/gzip');
  assert.equal(decodeURIComponent(response.headers.get('content-disposition').split("''")[1]), `${downloadFolderName}.tar.gz`);
  assert.ok(archive.length > 4 * 1048576); const received = Buffer.from(await response.arrayBuffer()); assert.deepEqual(received, archive);
  const listing = execFileSync('tar', ['-tzf', '-'], { input: received, encoding: 'utf8' });
  assert.ok(listing.includes('/nested/empty/')); assert.ok(listing.includes('/.hidden'));
  assert.ok(gunzipSync(received).includes(Buffer.from(`${downloadFolderName}/nested/筆記.txt`, 'utf8')));
  const text = execFileSync('tar', ['-xOzf', '-', '--', `${downloadFolderName}/nested/筆記.txt`], { input: received, encoding: 'utf8' }); assert.equal(text, nestedText);
  assert.deepEqual(fixture.commands, [expectedArchiveCommand(directory)]); assert.equal(fixture.stats.authenticated, 1);
  assert.equal(fixture.fileMap.get(`${directory}/nested/筆記.txt`).toString('utf8'), nestedText);
});

test('downloads enforce ownership and source types, report missing tar, and fail interrupted archives instead of completing them', async t => {
  const { fixture, ssh, request, directory } = await setup(t); await ssh.connect('alice', 'server');
  fixture.symlinks.add(`${root}/linked`);
  for (const [source, status] of [['/', 400], [`${root}/missing`, 404], [`${root}/${downloadFileName}`, 400], [`${root}/linked`, 400], ['/bad\0path', 400]]) {
    const result = await request('archive', source); assert.equal(result.status, status); await result.arrayBuffer();
  }
  for (const type of ['archive', 'download']) { const result = await request(type, directory, { headers: { 'x-owner': 'bob' } }); assert.equal(result.status, 409); await result.arrayBuffer(); }
  assert.equal(fixture.commands.length, 0);
  fixture.archiveControl.exitCode = 127; const missing = await request('archive', directory); assert.equal(missing.status, 502); assert.match((await missing.json()).error, /未安裝 tar/);
  fixture.archiveControl.exitCode = 2; const partial = await request('archive', directory); await assert.rejects(partial.arrayBuffer());
  fixture.archiveControl.exitCode = 0; assert.equal((await request('download', `${root}/empty.txt`)).status, 200);
  assert.equal(fixture.stats.authenticated, 1);
});

test('folder timeout and cancellation close only the download channel while SSH stays usable', async t => {
  const { fixture, ssh, request, directory } = await setup(t, { timeoutMs: 150 }); await ssh.connect('alice', 'server');
  fixture.archiveControl.stall = true; const timeout = await request('archive', directory); assert.equal(timeout.status, 504); await timeout.arrayBuffer();
  fixture.archiveControl.stall = false;
  const controller = new AbortController(), result = await request('archive', directory, { signal: controller.signal });
  const reader = result.body.getReader(); await reader.read(); controller.abort(); await reader.cancel().catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(fixture.archiveStats.opened, fixture.archiveStats.closed);
  assert.equal((await request('download', `${root}/empty.txt`)).status, 200); assert.equal(fixture.stats.authenticated, 1);
});
