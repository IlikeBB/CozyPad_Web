import crypto from 'node:crypto';
import SSHConfig from 'ssh-config';
import ssh2 from 'ssh2';

const { utils } = ssh2;

function text(value, max = 256) {
  const result = String(value ?? '').trim();
  if (result.length > max || /[\x00-\x1f]/.test(result)) throw Object.assign(new Error('欄位內容不正確。'), { status: 400 });
  return result;
}
export class ProfileRepository {
  constructor(store, vault) { this.store = store; this.vault = vault; }
  file(owner) { return this.store.userPath(owner, 'ssh-servers.json'); }
  async all(owner) { return this.store.read(this.file(owner), []); }
  public(profile) {
    const { id, name, host, port, username, defaultPath } = profile;
    return { id, name, host, port, username, defaultPath, hasKey: Boolean(profile.credential), fingerprint: profile.fingerprints?.[0] || null };
  }
  async list(owner) { return (await this.all(owner)).map(item => this.public(item)); }
  async find(owner, id) {
    const profile = (await this.all(owner)).find(item => item.id === id);
    if (!profile) throw Object.assign(new Error('找不到此使用者的連線設定。'), { status: 404 });
    return profile;
  }
  async save(owner, draft, options = {}) {
    const name = text(draft.name), host = text(draft.host), username = text(draft.username), defaultPath = text(draft.defaultPath || '~', 2048);
    const port = Number(draft.port || 22);
    if (!name || !host || !username || !Number.isInteger(port) || port < 1 || port > 65535 || /\s/.test(host)) {
      throw Object.assign(new Error('請填寫名稱、Host、Username 與有效 Port。'), { status: 400 });
    }
    let credential;
    if (draft.privateKey) {
      if (typeof draft.privateKey !== 'string' || draft.privateKey.length > 131072) throw Object.assign(new Error('SSH 私鑰格式不正確。'), { status: 400 });
      const parsed = utils.parseKey(draft.privateKey, draft.passphrase || undefined);
      if (parsed instanceof Error || !parsed?.isPrivateKey?.()) throw Object.assign(new Error('SSH 私鑰無法讀取，請檢查金鑰與 passphrase。'), { status: 400 });
      credential = this.vault.seal({ privateKey: draft.privateKey, passphrase: draft.passphrase || '', keyName: text(draft.keyName || '') });
    }
    return this.store.update(this.file(owner), [], profiles => {
      const index = draft.id ? profiles.findIndex(item => item.id === draft.id) : -1;
      if (draft.id && index < 0 && !options.migration) throw Object.assign(new Error('此連線已被刪除。'), { status: 404 });
      const previous = profiles[index];
      const changedHost = previous && (previous.host !== host || previous.port !== port);
      const profile = { id: previous?.id || crypto.randomUUID(), name, host, username, port, defaultPath,
        credential: credential || previous?.credential || null,
        fingerprints: options.fingerprints || (changedHost ? [] : previous?.fingerprints || []) };
      if (index < 0) profiles.push(profile); else profiles[index] = profile;
      return this.public(profile);
    });
  }
  async delete(owner, id) {
    await this.store.update(this.file(owner), [], profiles => {
      const index = profiles.findIndex(item => item.id === id);
      if (index < 0) throw Object.assign(new Error('找不到連線設定。'), { status: 404 });
      profiles.splice(index, 1);
    });
  }
  async pin(owner, id, fingerprint) {
    await this.store.update(this.file(owner), [], profiles => {
      const profile = profiles.find(item => item.id === id);
      if (!profile) throw Object.assign(new Error('找不到連線設定。'), { status: 404 });
      if (profile.fingerprints?.length) throw Object.assign(new Error('主機金鑰已變更，請先向伺服器管理員確認。'), { status: 409 });
      profile.fingerprints = [fingerprint];
    });
  }
  async importConfig(owner, { rawConfig, keyFiles = [] }) {
    if (typeof rawConfig !== 'string' || Buffer.byteLength(rawConfig) > 1048576 || !Array.isArray(keyFiles) || keyFiles.length > 50) {
      throw Object.assign(new Error('SSH config 或金鑰檔案超過上限。'), { status: 400 });
    }
    const config = SSHConfig.parse(rawConfig.replace(/^\uFEFF/, ''));
    const aliases = new Set();
    for (const section of config) {
      if (String(section.param).toLowerCase() === 'host') {
        for (const alias of (Array.isArray(section.value) ? section.value : String(section.value).split(/\s+/))) {
          if (alias && !/[!*?\[\]]/.test(alias)) aliases.add(alias);
        }
      }
    }
    const existing = await this.all(owner);
    const reusableKeys = new Map();
    for (const profile of existing) if (profile.credential) {
      const credential = this.vault.open(profile.credential);
      if (credential.keyName) reusableKeys.set(credential.keyName, credential);
    }
    let imported = 0, skipped = 0;
    const warnings = [];
    for (const alias of aliases) {
      // Never execute uploaded Match exec directives or open arbitrary local paths.
      const computed = config.compute(alias, { ignoreCase: true, matchExec: false });
      if (computed.proxyjump || computed.proxycommand) { skipped++; warnings.push(`${alias}: ProxyJump / ProxyCommand 尚未支援`); continue; }
      const keyPath = computed.identityfile?.[0] || '';
      const keyName = keyPath.replace(/\\/g, '/').split('/').at(-1);
      const uploaded = keyFiles.find(item => item.name === keyName);
      const savedKey = reusableKeys.get(keyName);
      const credential = uploaded || savedKey;
      if (!computed.user) { skipped++; warnings.push(`${alias}: 缺少 User`); continue; }
      const prior = existing.find(item => item.name === alias);
      await this.save(owner, { id: prior?.id, name: alias, host: computed.hostname || alias, port: Number(computed.port || 22),
        username: computed.user, defaultPath: prior?.defaultPath || '~', privateKey: credential?.privateKey,
        passphrase: credential?.passphrase, keyName });
      imported++;
      if (!credential && !prior?.credential) warnings.push(`${alias}: 請上傳對應的私鑰 ${keyName || ''}`);
    }
    return { imported, skipped, warnings, profiles: await this.list(owner) };
  }
}
