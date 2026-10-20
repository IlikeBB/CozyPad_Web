import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mediaType } from '../packages/contracts/src/media-types.mjs';
import { mediaRange, serveMedia } from '../apps/server/src/ssh/media-preview.mjs';
import { SshService } from '../apps/server/src/ssh/ssh-service.mjs';
import { FilesService } from '../apps/server/src/ssh/files-service.mjs';
import { failure } from '../apps/server/src/http.mjs';
import { sshFixture } from './helpers/ssh-fixture.mjs';
import { mediaRoot, mediaImageName, mediaSvg, mediaVideoName, mediaVideo, seedMediaFiles } from './helpers/media-fixtures.mjs';

test('media types and single byte ranges handle Unicode names, suffixes, open ends and invalid inputs', () => {
  assert.equal(mediaType(mediaImageName)?.mimeType, 'image/svg+xml');
  for (const file of ['a.png', 'a.JPEG', 'a.webp', 'a.avif', 'a.gif', 'a.bmp', 'a.ico']) assert.equal(mediaType(file)?.kind, 'image');
  for (const file of ['a.mp4', 'a.M4V', 'a.webm', 'a.ogv', 'a.mov']) assert.equal(mediaType(file)?.kind, 'video');
  for (const file of [null, '', 'png', 'a.txt', 'x.html', 'x.svg.html', 'x.__proto__', 'x.constructor']) assert.equal(mediaType(file), null);
  assert.deepEqual(mediaRange(null, 10), { start: 0, end: 9, partial: false });
  assert.deepEqual(mediaRange('bytes=2-5', 10), { start: 2, end: 5, partial: true });
  assert.deepEqual(mediaRange('bytes=8-', 10), { start: 8, end: 9, partial: true });
  assert.deepEqual(mediaRange('bytes=-3', 10), { start: 7, end: 9, partial: true });
  assert.deepEqual(mediaRange('bytes=0-999', 10), { start: 0, end: 9, partial: true });
  assert.deepEqual(mediaRange('bytes=-100', 10), { start: 0, end: 9, partial: true });
  for (const range of ['bytes=-0', 'bytes=10-', 'bytes=5-2', 'bytes=-', 'bytes=0-1,4-5', 'items=0-2', 'bytes=abc', 'bytes=9007199254740992-']) assert.equal(mediaRange(range, 10), null, range);
  assert.equal(mediaRange('bytes=0-', 0), null);
});

async function setup(t) {
  const fixture = await sshFixture(); seedMediaFiles(fixture);
  const profiles = { find: async (owner, id) => {
    if (owner !== 'alice' || id !== 'own-server') throw Object.assign(new Error('找不到伺服器。'), { status: 404 });
    return { id, host: '127.0.0.1', port: fixture.port, username: 'tester', fingerprints: [fixture.fingerprint], credential: fixture.privateKey };
  } };
  const ssh = new SshService(profiles, { open: value => ({ privateKey: value }) }), files = new FilesService(ssh);
  let activeChannels = 0;
  const originalSftp = ssh.sftp.bind(ssh);
  ssh.sftp = async (...args) => { const channel = await originalSftp(...args); activeChannels++; channel.once('end', () => activeChannels--); return channel; };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      await serveMedia(request, response, files, request.headers['x-owner'] || 'alice', url.searchParams.get('serverId') || 'own-server', url.searchParams.get('path'), url.searchParams.get('download') === '1');
    } catch (error) { failure(response, error); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); ssh.close(); await fixture.close(); });
  const request = (file, options) => fetch(`http://127.0.0.1:${server.address().port}/?${new URLSearchParams({ path: file })}`, options);
  return { fixture, ssh, request, channels: () => activeChannels };
}

test('real SSH media serves full, partial, suffix and HEAD requests without binary text limits or another login', { timeout: 20000 }, async t => {
  const { fixture, ssh, request } = await setup(t);
  const image = `${mediaRoot}/${mediaImageName}`, video = `${mediaRoot}/${mediaVideoName}`;
  const before = await request(image); assert.equal(before.status, 409); await before.arrayBuffer();
  assert.equal(fixture.stats.connections, 0);
  await ssh.connect('alice', 'own-server');
  const result = await request(image);
  assert.equal(result.status, 200); assert.equal(result.headers.get('content-type'), 'image/svg+xml');
  assert.match(result.headers.get('content-disposition'), /^inline; filename\*=UTF-8''/);
  assert.match(result.headers.get('content-security-policy'), /sandbox/);
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(result.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.match(result.headers.get('cache-control'), /no-store/);
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), mediaSvg);
  for (const [range, first, last] of [['bytes=5-18', 5, 18], ['bytes=18-', 18, mediaVideo.length - 1], ['bytes=-19', mediaVideo.length - 19, mediaVideo.length - 1]]) {
    const part = await request(video, { headers: { range } });
    assert.equal(part.status, 206); assert.equal(part.headers.get('content-type'), 'video/webm');
    assert.equal(part.headers.get('content-range'), `bytes ${first}-${last}/${mediaVideo.length}`);
    assert.equal(Number(part.headers.get('content-length')), last - first + 1);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), mediaVideo.subarray(first, last + 1));
  }
  const head = await request(video, { method: 'HEAD', headers: { range: 'bytes=0-2' } });
  assert.equal(head.status, 200); assert.equal(Number(head.headers.get('content-length')), mediaVideo.length);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const whole = await request(video, { headers: { range: 'bytes=0-2', 'if-range': 'old-version' } });
  assert.equal(whole.status, 200); assert.equal((await whole.arrayBuffer()).byteLength, mediaVideo.length);
  const large = Buffer.alloc(11 * 1048576, 42); fixture.fileMap.set(`${mediaRoot}/large.mp4`, large);
  const largePart = await request(`${mediaRoot}/large.mp4`, { headers: { range: `bytes=${large.length - 8}-` } });
  assert.equal(largePart.status, 206); assert.equal(largePart.headers.get('content-range'), `bytes ${large.length - 8}-${large.length - 1}/${large.length}`);
  assert.deepEqual(Buffer.from(await largePart.arrayBuffer()), large.subarray(-8));
  const fullLarge = await request(`${mediaRoot}/large.mp4`);
  assert.equal(fullLarge.status, 200); assert.equal((await fullLarge.arrayBuffer()).byteLength, large.length);
  assert.equal(fixture.stats.authenticated, 1); assert.deepEqual(fixture.commands, []);
});

test('media rejects invalid ranges, non-media paths and other owners while closing only its SFTP channels', { timeout: 20000 }, async t => {
  const { fixture, ssh, request, channels } = await setup(t); await ssh.connect('alice', 'own-server');
  const video = `${mediaRoot}/${mediaVideoName}`;
  for (const range of ['bytes=999999999-', 'bytes=4-2', 'bytes=0-1,4-5', 'bytes=-0']) {
    const result = await request(video, { headers: { range } });
    assert.equal(result.status, 416); assert.equal(result.headers.get('content-range'), `bytes */${mediaVideo.length}`); await result.arrayBuffer();
  }
  for (const [file, status] of [[`${mediaRoot}/plain.txt`, 415], [`${mediaRoot}/missing.png`, 404], [mediaRoot, 415], [`${mediaRoot}/directory.png`, 400], ['/file\0.png', 400]]) {
    const result = await request(file); assert.equal(result.status, status); await result.arrayBuffer();
  }
  const denied = await request(video, { headers: { 'x-owner': 'bob' } }); assert.equal(denied.status, 409); await denied.arrayBuffer();
  fixture.fileMap.set(`${mediaRoot}/empty.mp4`, Buffer.alloc(0));
  const empty = await request(`${mediaRoot}/empty.mp4`); assert.equal(empty.status, 200); assert.equal((await empty.arrayBuffer()).byteLength, 0);
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(channels(), 0);
  assert.equal((await request(video, { method: 'HEAD' })).status, 200);
  assert.equal(fixture.stats.authenticated, 1);
});

test('aborting a media response releases the channel and leaves SSH usable', { timeout: 20000 }, async t => {
  const { fixture, ssh, request, channels } = await setup(t); await ssh.connect('alice', 'own-server');
  fixture.fileMap.set(`${mediaRoot}/long.mp4`, Buffer.alloc(20 * 1048576, 11));
  const controller = new AbortController();
  const result = await request(`${mediaRoot}/long.mp4`, { signal: controller.signal });
  const reader = result.body.getReader(); assert.ok((await reader.read()).value.length > 0);
  controller.abort(); await reader.cancel().catch(() => {});
  for (let count = 0; count < 100 && channels(); count++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(channels(), 0);
  assert.deepEqual((await new FilesService(ssh).read('alice', 'own-server', '/home/tester/readme.txt')).data.toString(), 'CozyPad test file\n');
  assert.equal(fixture.stats.authenticated, 1);
});
