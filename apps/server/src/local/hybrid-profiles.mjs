export class HybridProfiles {
  constructor(remote, bridge) { Object.assign(this, { remote, bridge }); }
  async list(owner) { return [...await this.remote.list(owner), ...await this.bridge.list(owner)]; }
  async find(owner, id) { return typeof id === 'string' && id.startsWith('local-') ? { ...this.bridge.public(owner, await this.bridge.find(owner, id)) } : this.remote.find(owner, id); }
  async save(owner, draft, options) {
    if (draft.id?.startsWith('local-')) throw Object.assign(new Error('本機連接器的範圍由自己的電腦設定；需要變更時請移除並重新配對。'), { status: 400 });
    return this.remote.save(owner, draft, options);
  }
  delete(owner, id) { return id.startsWith('local-') ? this.bridge.remove(owner, id) : this.remote.delete(owner, id); }
  importConfig(owner, draft) { return this.remote.importConfig(owner, draft); }
  pin(owner, id, fingerprint) { return this.remote.pin(owner, id, fingerprint); }
}
