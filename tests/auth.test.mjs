import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AuthService } from '../apps/server/src/auth/auth-service.mjs';
import { JsonStore } from '../apps/server/src/storage/json-store.mjs';
import { generateTotp } from '../apps/server/src/auth/totp.mjs';
import { resetAuth } from '../scripts/reset-auth.mjs';

const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const settings = { secureCookie: false, sessionHours: 12, trustDays: 7 };
function request(cookie = '', browser = 'test-browser') { return { headers: { cookie, 'user-agent': browser }, socket: { remoteAddress: '127.0.0.1' } }; }
const cookieHeader = result => result.cookies.map(cookie => cookie.split(';')[0]).join('; ');
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cozypad-tt-auth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new JsonStore(root);
  const salt = 'test-salt';
  const user = { username: 'Tester', role: 'user', salt, passwordHash: crypto.scryptSync('test-password', salt, 64).toString('base64url'), twoFactor: { enabled: true, secretBase32: secret } };
  await store.write('auth-users.json', { tester: user, other: { ...user, username: 'Other' } });
  let time = 1720000000000;
  const auth = new AuthService(store, settings, () => time);
  const verify = async (remember = true) => {
    const challenge = await auth.login(request(), { username: 'Tester', password: 'test-password' });
    return auth.verify(request(), { challengeId: challenge.body.challengeId, code: generateTotp(secret, time), remember });
  };
  return { store, auth, verify, advance: value => { time += value; } };
}
test('TOTP matches the RFC 6238 SHA-1 reference vector', () => assert.equal(generateTotp(secret, 59000, 8), '94287082'));
test('trusted cookie survives logout and restart; expiration is fixed', async t => {
  const { store, auth, verify, advance } = await fixture(t);
  const result = await verify(); const cookie = cookieHeader(result);
  assert.ok(result.cookies.every(value => value.includes('HttpOnly') && value.includes('SameSite=Strict')));
  assert.ok((await auth.session(request(cookie))).trustedUntil);
  const before = await store.read('auth-state.json', {});
  await auth.logout(request(cookie));
  advance(6 * 86400000);
  const resumed = await auth.login(request(cookie), { username: 'Tester', password: 'test-password' });
  assert.equal(resumed.body.user.username, 'Tester');
  assert.deepEqual((await store.read('auth-state.json', {})).trusted, before.trusted);
  const restarted = new AuthService(store, settings, () => 1720000000000 + 6 * 86400000);
  assert.equal((await restarted.login(request(cookie), { username: 'Tester', password: 'test-password' })).body.user.username, 'Tester');
  advance(2 * 86400000);
  assert.ok((await auth.login(request(cookie), { username: 'Tester', password: 'test-password' })).body.challengeId);
});
test('trust does not bypass passwords or transfer to another account/browser', async t => {
  const { auth, verify } = await fixture(t); const cookie = cookieHeader(await verify());
  await assert.rejects(auth.login(request(cookie), { username: 'Tester', password: 'wrong' }), /帳號或密碼/);
  assert.ok((await auth.login(request(cookie), { username: 'Other', password: 'test-password' })).body.challengeId);
  assert.ok((await auth.login(request(cookie, 'different-browser'), { username: 'Tester', password: 'test-password' })).body.challengeId);
  assert.ok((await auth.login(request(cookie.replace('cozypad_tt_trust=', 'cozypad_tt_trust=tampered')), { username: 'Tester', password: 'test-password' })).body.challengeId);
});
test('forgetting trust and changing credentials require verification again', async t => {
  const { auth, verify, store } = await fixture(t); const cookie = cookieHeader(await verify());
  await auth.forget(request(cookie));
  assert.ok((await auth.login(request(cookie), { username: 'Tester', password: 'test-password' })).body.challengeId);
  await store.update('auth-users.json', {}, users => { users.tester.passwordHash = crypto.scryptSync('new-password', users.tester.salt, 64).toString('base64url'); });
  assert.equal((await auth.session(request(cookie))).user, null);
});
test('TOTP rejects reused codes and unremembered sessions do not create trust', async t => {
  const { auth, verify } = await fixture(t);
  const result = await verify(false); assert.equal(result.cookies.length, 1);
  await assert.rejects(verify(), /已使用/);
  assert.ok((await auth.login(request(cookieHeader(result)), { username: 'Tester', password: 'test-password' })).body.challengeId);
});
test('verification challenges expire and enforce attempt limits', async t => {
  const { auth, advance } = await fixture(t);
  const result = await auth.login(request(), { username: 'Tester', password: 'test-password' });
  advance(300001);
  await assert.rejects(auth.verify(request(), { challengeId: result.body.challengeId, code: '000000' }), /已過期/);
  const challenge = await auth.login(request(), { username: 'Tester', password: 'test-password' });
  for (let index = 0; index < 5; index++) await assert.rejects(auth.verify(request(), { challengeId: challenge.body.challengeId, code: 'invalid' }), /不正確/);
  await assert.rejects(auth.verify(request(), { challengeId: challenge.body.challengeId, code: 'invalid' }), /次數過多/);
});
test('failed login limits do not block another account behind the same proxy', async t => {
  const { auth } = await fixture(t);
  for (let index = 0; index < 10; index++) await assert.rejects(auth.login(request(), { username: 'Tester', password: 'wrong' }), /帳號或密碼/);
  await assert.rejects(auth.login(request(), { username: 'Tester', password: 'test-password' }), /嘗試太多次/);
  for (let index = 0; index < 12; index++) assert.ok((await auth.login(request(), { username: 'Other', password: 'test-password' })).body.challengeId);
});
test('auth reset revokes only the selected account and allows authenticator enrollment again', async t => {
  const { auth, store, verify } = await fixture(t);
  const users = await store.read('auth-users.json', {});
  const cookie = cookieHeader(await verify());
  const otherCookie = cookieHeader(await auth.issue(users.other, request(), true));
  const challenge = await auth.login(request(), { username: 'Tester', password: 'test-password' });
  const sshFile = store.userPath('tester', 'ssh-servers.json');
  await store.write(sshFile, [{ id: 'saved-connection', credential: 'encrypted-key' }]);
  const result = await resetAuth(store, 'Tester');
  assert.deepEqual(result, { username: 'tester', sessions: 1, trusted: 1 });
  const updated = await store.read('auth-users.json', {});
  assert.equal(updated.tester.passwordHash, users.tester.passwordHash);
  assert.equal(updated.tester.salt, users.tester.salt);
  assert.equal(updated.tester.role, users.tester.role);
  assert.equal(updated.tester.twoFactor, undefined);
  assert.equal(updated.tester.lastTotpStep, undefined);
  assert.deepEqual(updated.other, users.other);
  assert.deepEqual(await store.read(sshFile, []), [{ id: 'saved-connection', credential: 'encrypted-key' }]);
  assert.equal((await auth.session(request(cookie))).user, null);
  assert.equal((await auth.session(request(otherCookie))).user.username, 'Other');
  await assert.rejects(auth.verify(request(), { challengeId: challenge.body.challengeId, code: generateTotp(secret, 1720000000000) }), /設定已更新/);
  const enrollment = await auth.login(request(cookie), { username: 'Tester', password: 'test-password' });
  assert.ok(enrollment.body.setup?.otpauthUrl);
  const enrolled = await auth.verify(request(), { challengeId: enrollment.body.challengeId, code: generateTotp(enrollment.body.setup.secret, 1720000000000) });
  assert.equal(enrolled.body.user.username, 'Tester');
});
