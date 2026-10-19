import { remoteDirectoryPath } from '../../../../packages/contracts/src/directory-context.mjs';

export class DirectoryHistory {
  constructor(store) { this.store = store; }
  file(owner) { return this.store.userPath(owner, 'agent-directory-history.json'); }
  validId(id) { if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw Object.assign(new Error('伺服器識別碼不正確。'), { status: 400 }); }
  async list(owner, id) { this.validId(id); const history = await this.store.read(this.file(owner), {}); return Object.hasOwn(history, id) ? history[id] : []; }
  async remember(owner, id, directory) {
    const value = remoteDirectoryPath(directory);
    this.validId(id);
    return this.store.update(this.file(owner), {}, history => {
      const items = [{ path: value, usedAt: Date.now() }, ...(history[id] || []).filter(item => item.path !== value)].slice(0, 20);
      history[id] = items; return items;
    });
  }
}
