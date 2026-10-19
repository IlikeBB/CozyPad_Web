import { codexChatCommand, remoteCommand } from '../ssh/remote-shell.mjs';
import { LocalSftp } from './local-sftp.mjs';

export class HybridConnections {
  constructor(remote, bridge, profiles) { Object.assign(this, { remote, bridge, profiles }); }
  key(owner, id) { return this.remote.key(owner, id); }
  async connect(owner, id) { await this.profiles.find(owner, id); return id.startsWith('local-') ? this.bridge.connection(owner, id) : this.remote.connect(owner, id); }
  disconnect(owner, id) { if (!id.startsWith('local-')) this.remote.disconnect(owner, id); }
  disconnectUser(owner) { this.remote.disconnectUser(owner); }
  trust(owner, id, fingerprint) { return this.remote.trust(owner, id, fingerprint); }
  exec(owner, id, command, options) { if (id.startsWith('local-')) throw Object.assign(new Error('本機連接器不接受任意遠端 shell 指令。'), { status: 400 }); return this.remote.exec(owner, id, command, options); }
  launchCodex(owner, id, directory, options, purpose = 'chat') { return id.startsWith('local-') ? this.bridge.exec(owner, id, directory, options, purpose) : this.remote.exec(owner, id, purpose === 'chat' ? codexChatCommand(directory) : remoteCommand(directory, 'codex app-server'), options); }
  async sftp(owner, id) { const profile = await this.profiles.find(owner, id); if (!id.startsWith('local-')) return this.remote.sftp(owner, id); this.bridge.connection(owner, id); return new LocalSftp(this.bridge, owner, id, profile.platform); }
  shell(owner, id, options) { if (id.startsWith('local-')) throw Object.assign(new Error('本機模式不提供互動式終端機。'), { status: 400 }); return this.remote.shell(owner, id, options); }
  async displayPath(owner, id, file) { if (!id.startsWith('local-')) return file; const profile = await this.profiles.find(owner, id); return profile.platform === 'win32' && /^\/[A-Za-z]:\//.test(file) ? file.slice(1).replaceAll('/', '\\') : file; }
  close() { this.remote.close(); this.bridge.close(); }
}
