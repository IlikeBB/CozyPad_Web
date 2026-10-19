import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../apps/server/src/storage/json-store.mjs';
import { IssueService } from '../apps/server/src/issues/issue-service.mjs';

const user = { username: 'Tester', role: 'user' }, other = { username: 'Other', role: 'user' }, admin = { username: 'Admin', role: 'admin' };
const draft = (extra = {}) => ({ requestId: crypto.randomUUID(), title: '無法下載文件', category: 'files', description: '點擊連結後沒有下載。', ...extra });
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cozypad-tt-issues-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new JsonStore(root);
  let now = 1720000000000;
  return { store, service: new IssueService(store, () => now), advance: amount => { now += amount; } };
}

test('issues persist across restart, separate users and omit internal retry metadata', async t => {
  const { store, service } = await fixture(t);
  const report = await service.create(user, draft({ steps: '1. 開啟 Codex\n2. 點擊下載', expected: '取得文件' }));
  assert.equal(report.owner, 'tester'); assert.equal(report.status, 'open');
  assert.equal(report.diagnostics, null); assert.equal(report.requestId, undefined); assert.equal(report.digest, undefined);
  const restarted = new IssueService(store);
  assert.deepEqual(await restarted.find(user, report.id), report);
  assert.deepEqual((await restarted.list(user)).items[0].title, report.title);
  assert.equal((await restarted.list(other)).total, 0);
  await assert.rejects(restarted.find(other, report.id), { status: 404 });
  await assert.rejects(restarted.list(other, { scope: 'all' }), { status: 403 });
  assert.equal((await restarted.list(admin, { scope: 'all' })).total, 1);
  assert.deepEqual(await restarted.find(admin, report.id), report);
  assert.equal((await restarted.list(user)).items[0].description, undefined);
});
test('lost-response retries are idempotent, scoped by owner and reject a changed payload', async t => {
  const { service } = await fixture(t); const payload = draft();
  const results = await Promise.all(Array.from({ length: 5 }, () => service.create(user, payload)));
  assert.equal(new Set(results.map(report => report.id)).size, 1);
  assert.equal((await service.list(user)).total, 1);
  assert.notEqual((await service.create(other, payload)).id, results[0].id);
  await assert.rejects(service.create(user, { ...payload, title: '別的問題' }), { status: 409 });
});
test('only admins can reply, validate updates and reject stale revisions without overwriting', async t => {
  const { service, advance } = await fixture(t); const report = await service.create(user, draft());
  await assert.rejects(service.update(user, report.id, { status: 'resolved', revision: 1 }), { status: 403 });
  await assert.rejects(service.update(admin, report.id, { status: 'invalid', revision: 1 }), { status: 400 });
  await assert.rejects(service.update(admin, report.id, { status: 'resolved', response: 'a'.repeat(4001), revision: 1 }), { status: 400 });
  await assert.rejects(service.update(admin, report.id, { status: 'resolved', revision: 1, owner: 'other' }), { status: 400 });
  advance(1000);
  const updated = await service.update(admin, report.id, { status: 'in_progress', response: '已收到，正在修正。', revision: 1 });
  assert.equal(updated.revision, 2); assert.equal(updated.respondedBy, 'admin'); assert.equal(updated.updatedAt, report.updatedAt + 1000);
  await assert.rejects(service.update(admin, report.id, { status: 'closed', response: '舊版覆寫', revision: 1 }), { status: 409 });
  assert.equal((await service.find(user, report.id)).response, '已收到，正在修正。');
  const resolved = await service.update(admin, report.id, { status: 'resolved', revision: 2 });
  assert.equal(resolved.respondedAt, updated.respondedAt);
  assert.equal(resolved.response, updated.response);
  assert.equal((await service.list(user, { status: 'resolved' })).total, 1);
});
test('issue input validates types, lengths, categories and diagnostic allowlist', async t => {
  const { service } = await fixture(t);
  for (const input of [
    { title: ' ' }, { description: '' }, { description: 5 }, { category: 'invalid' }, { requestId: '../bad' },
    { title: 'a'.repeat(161) }, { description: 'a'.repeat(8001) }, { steps: 'a'.repeat(4001) }, { expected: 'a'.repeat(2001) },
    { title: 'unsafe\u0000title' }, { owner: 'admin' }, { status: 'resolved' }, { diagnostics: { cookie: 'secret' } },
    { diagnostics: { userAgent: 'a'.repeat(501), viewport: '1440 x 900', version: 'V4' } }
  ]) await assert.rejects(service.create(user, draft(input)), { status: 400 });
  const diagnostics = { userAgent: 'Browser', viewport: '1440 x 900', version: 'V4' };
  assert.deepEqual((await service.create(user, draft({ diagnostics }))).diagnostics, diagnostics);
  await assert.rejects(service.find(user, '../../auth-users.json'), { status: 404 });
});
test('per-user rate limit is persistent and retries do not consume another slot', async t => {
  const { service, store, advance } = await fixture(t); const payload = draft();
  await service.create(user, payload);
  for (let i = 0; i < 9; i++) await service.create(user, draft());
  await service.create(user, payload);
  await assert.rejects(service.create(user, draft()), { status: 429 });
  assert.ok(await service.create(other, draft()));
  await assert.rejects(new IssueService(store, () => 1720000000000).create(user, draft()), { status: 429 });
  advance(3600001); assert.ok(await service.create(user, draft()));
});
test('concurrent writes survive and lists paginate and filter within visible reports', async t => {
  const { service, advance } = await fixture(t);
  const first = await Promise.all(Array.from({ length: 10 }, (_, i) => service.create(user, draft({ title: `Issue ${i}` }))));
  advance(3600001);
  await Promise.all(Array.from({ length: 10 }, (_, i) => service.create(user, draft({ title: `Issue ${i + 10}` }))));
  advance(3600001);
  await Promise.all(Array.from({ length: 7 }, (_, i) => service.create(user, draft({ title: `Issue ${i + 20}` }))));
  const page1 = await service.list(user), page2 = await service.list(user, { page: '2' });
  assert.equal(page1.total, 27); assert.equal(page1.items.length, 25); assert.equal(page2.items.length, 2);
  assert.equal(new Set([...page1.items, ...page2.items].map(report => report.id)).size, 27);
  await service.update(admin, first[0].id, { status: 'resolved', revision: 1 });
  assert.equal((await service.list(user, { status: 'resolved' })).total, 1);
  for (const query of [{ page: 0 }, { page: 'NaN' }, { limit: 101 }, { status: 'unknown' }, { scope: 'unknown' }]) await assert.rejects(service.list(user, query), { status: 400 });
});
