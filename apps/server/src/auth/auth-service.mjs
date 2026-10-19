import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { userId } from '../storage/json-store.mjs';
import { secret, matchingStep } from './totp.mjs';

const scrypt = promisify(crypto.scrypt);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const version = user => hash(`${user.salt}:${user.passwordHash}:${user.twoFactor?.secretBase32 || ''}`);
const publicUser = user => ({ username: user.username, role: user.role || 'user' });
export function authError(message, status = 401) { return Object.assign(new Error(message), { status }); }
export function cookies(request) {
  return Object.fromEntries(String(request.headers.cookie || '').split(';').map(item => {
    const equal = item.indexOf('=');
    return equal > 0 ? [item.slice(0, equal).trim(), item.slice(equal + 1)] : ['', ''];
  }));
}

export class AuthService {
  challenges = new Map();
  rateLimits = new Map();
  constructor(store, settings, clock = Date.now) {
    this.store = store; this.settings = settings; this.clock = clock;
    this.sessionName = settings.secureCookie ? '__Host-cozypad_tt_session' : 'cozypad_tt_session';
    this.trustName = settings.secureCookie ? '__Host-cozypad_tt_trust' : 'cozypad_tt_trust';
  }
  cookie(name, token, age) {
    return `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(age / 1000))}${this.settings.secureCookie ? '; Secure' : ''}`;
  }
  async bootstrap() {
    const users = await this.store.read('auth-users.json', {});
    if (Object.keys(users).length) return;
    const password = process.env.COZYPAD_ADMIN_PASSWORD;
    if (!password || password.length < 12) throw new Error('Import existing users or set COZYPAD_ADMIN_PASSWORD (at least 12 characters).');
    const salt = crypto.randomBytes(16).toString('base64url');
    users.admin = { username: 'admin', role: 'admin', salt, passwordHash: (await scrypt(password, salt, 64)).toString('base64url') };
    await this.store.write('auth-users.json', users);
  }
  limit(request, label) {
    const now = this.clock();
    for (const [key, value] of this.rateLimits) if (value.until <= now) this.rateLimits.delete(key);
    const key = `${request.socket.remoteAddress}:${label}`;
    const value = this.rateLimits.get(key) || { count: 0, until: now + 600000 };
    if (++value.count > 10) throw authError('登入嘗試太多次，請於 10 分鐘後再試。', 429);
    this.rateLimits.set(key, value);
    return key;
  }
  async login(request, payload) {
    const limitKey = this.limit(request, `login:${hash(String(payload.username || '').trim().toLowerCase()).slice(0, 16)}`);
    let id;
    try { id = userId(payload.username); } catch { throw authError('帳號或密碼不正確。'); }
    const users = await this.store.read('auth-users.json', {});
    const user = users[id];
    const candidate = await scrypt(String(payload.password || ''), user?.salt || 'cozypad-invalid-user', 64);
    const expected = Buffer.from(user?.passwordHash || '', 'base64url');
    if (!user || expected.length !== candidate.length || !crypto.timingSafeEqual(candidate, expected)) throw authError('帳號或密碼不正確。');
    this.rateLimits.delete(limitKey);
    const token = cookies(request)[this.trustName];
    const state = await this.store.read('auth-state.json', { sessions: {}, trusted: {} });
    const trusted = token ? state.trusted[hash(token)] : null;
    if (trusted && trusted.username === id && trusted.expiresAt > this.clock() && trusted.version === version(user) &&
      trusted.browser === hash(String(request.headers['user-agent'] || ''))) {
      return this.issue(user, request, false);
    }
    for (const [key, item] of this.challenges) if (item.expiresAt <= this.clock()) this.challenges.delete(key);
    const setup = !user.twoFactor?.enabled;
    const secretBase32 = setup ? secret() : user.twoFactor.secretBase32;
    const challengeId = crypto.randomBytes(24).toString('base64url');
    this.challenges.set(challengeId, { username: id, secretBase32, setup, version: version(user), attempts: 0, expiresAt: this.clock() + 300000 });
    const params = new URLSearchParams({ secret: secretBase32, issuer: 'CozyPad TT', algorithm: 'SHA1', digits: '6', period: '30' });
    return { body: { challengeId, ...(setup ? { setup: { secret: secretBase32, otpauthUrl: `otpauth://totp/${encodeURIComponent(`CozyPad TT:${user.username}`)}?${params}` } } : {}) }, cookies: [] };
  }
  async verify(request, payload) {
    const challenge = this.challenges.get(payload.challengeId);
    if (!challenge || challenge.expiresAt <= this.clock()) throw authError('驗證已過期，請重新登入。');
    const limitKey = this.limit(request, `verify:${challenge.username}`);
    if (++challenge.attempts > 5) { this.challenges.delete(payload.challengeId); throw authError('驗證次數過多，請重新登入。', 429); }
    const step = matchingStep(challenge.secretBase32, String(payload.code || ''), this.clock());
    if (step === null) throw authError('驗證碼不正確。');
    const user = await this.store.update('auth-users.json', {}, users => {
      const user = users[challenge.username];
      if (!user || version(user) !== challenge.version) throw authError('帳號設定已更新，請重新登入。');
      if (user.lastTotpStep != null && step <= user.lastTotpStep) throw authError('此驗證碼已使用，請等待下一組驗證碼。');
      if (challenge.setup) user.twoFactor = { enabled: true, secretBase32: challenge.secretBase32 };
      user.lastTotpStep = step;
      return user;
    });
    this.challenges.delete(payload.challengeId);
    this.rateLimits.delete(limitKey);
    return this.issue(user, request, payload.remember !== false);
  }
  async issue(user, request, remember) {
    const now = this.clock();
    const token = crypto.randomBytes(32).toString('base64url');
    const trustToken = remember ? crypto.randomBytes(32).toString('base64url') : null;
    const sessionAge = this.settings.sessionHours * 3600000;
    const trustAge = this.settings.trustDays * 86400000;
    await this.store.update('auth-state.json', { sessions: {}, trusted: {} }, state => {
      for (const entries of [state.sessions, state.trusted]) for (const [key, item] of Object.entries(entries)) if (item.expiresAt <= now) delete entries[key];
      state.sessions[hash(token)] = { username: userId(user.username), expiresAt: now + sessionAge, version: version(user) };
      if (trustToken) state.trusted[hash(trustToken)] = { username: userId(user.username), expiresAt: now + trustAge, version: version(user), browser: hash(String(request.headers['user-agent'] || '')) };
    });
    const responseCookies = [this.cookie(this.sessionName, token, sessionAge)];
    if (trustToken) responseCookies.push(this.cookie(this.trustName, trustToken, trustAge));
    return { body: { user: publicUser(user) }, cookies: responseCookies };
  }
  async session(request) {
    const parsed = cookies(request);
    const token = parsed[this.sessionName];
    const state = await this.store.read('auth-state.json', { sessions: {}, trusted: {} });
    const record = token ? state.sessions[hash(token)] : null;
    const users = await this.store.read('auth-users.json', {});
    const user = record ? users[record.username] : null;
    const valid = user && record.expiresAt > this.clock() && record.version === version(user);
    const trust = parsed[this.trustName] ? state.trusted[hash(parsed[this.trustName])] : null;
    return { user: valid ? publicUser(user) : null, trustDays: this.settings.trustDays,
      trustedUntil: valid && trust?.username === record.username && trust.version === version(user) && trust.expiresAt > this.clock() ? trust.expiresAt : null,
      expiresAt: valid ? record.expiresAt : null };
  }
  async require(request) {
    const session = await this.session(request);
    if (!session.user) throw authError('登入已過期，請重新登入。');
    return session;
  }
  async logout(request, forget = false) {
    const parsed = cookies(request);
    await this.store.update('auth-state.json', { sessions: {}, trusted: {} }, state => {
      if (parsed[this.sessionName]) delete state.sessions[hash(parsed[this.sessionName])];
      if (forget && parsed[this.trustName]) delete state.trusted[hash(parsed[this.trustName])];
    });
    return [this.cookie(this.sessionName, '', 0), ...(forget ? [this.cookie(this.trustName, '', 0)] : [])];
  }
  async forget(request) {
    const parsed = cookies(request);
    await this.store.update('auth-state.json', { sessions: {}, trusted: {} }, state => {
      if (parsed[this.trustName]) delete state.trusted[hash(parsed[this.trustName])];
    });
    return [this.cookie(this.trustName, '', 0)];
  }
}
