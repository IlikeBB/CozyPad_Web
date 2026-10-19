import { Client } from 'ssh2';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { ExecOutput } from './exec-output.mjs';
import { monitorCommand } from './monitor-command.mjs';

export const quoteShell = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;
export const remoteDirectory = value => value === '~' || !value ? '"$HOME"' : value.startsWith('~/') ? `"$HOME"/${quoteShell(value.slice(2))}` : quoteShell(value);
export class SshService {
  connections = new Map();
  connecting = new Map();
  pendingClients = new Map();
  revisions = new Map();
  observed = new Map();
  failedEndpoints = new Map();
  endpointQueues = new Map();
  closed = false;
  constructor(profiles, vault, { now = Date.now } = {}) { this.profiles = profiles; this.vault = vault; this.now = now; }
  key(owner, id) { return `${owner.toLowerCase()}:${id}`; }
  async connect(owner, id) {
    if (this.closed) throw Object.assign(new Error('SSH 服務已停止。'), { status: 503 });
    const key = this.key(owner, id);
    if (this.connections.has(key)) return this.connections.get(key);
    if (this.connecting.has(key)) return this.connecting.get(key);
    const operation = this.open(owner, id, key, this.revisions.get(key) || 0);
    this.connecting.set(key, operation);
    try { return await operation; } finally { if (this.connecting.get(key) === operation) this.connecting.delete(key); }
  }
  async open(owner, id, key, revision) {
    const profile = await this.profiles.find(owner, id);
    const endpoint = `${profile.host.toLowerCase()}:${profile.port}`;
    // Different profiles may target the same host; serialize authentication attempts too.
    const previous = this.endpointQueues.get(endpoint) || Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.openEndpoint(profile, endpoint, key, revision));
    this.endpointQueues.set(endpoint, operation);
    try { return await operation; } finally { if (this.endpointQueues.get(endpoint) === operation) this.endpointQueues.delete(endpoint); }
  }
  cooldown(endpoint) {
    const failures = (this.failedEndpoints.get(endpoint)?.failures || 0) + 1;
    this.failedEndpoints.set(endpoint, { failures, retryAt: this.now() + Math.min(300000, 30000 * 2 ** Math.min(failures - 1, 4)) });
  }
  async openEndpoint(profile, endpoint, key, revision) {
    if (this.closed || (this.revisions.get(key) || 0) !== revision) throw Object.assign(new Error('連線已取消，請重新連線。'), { status: 409 });
    const retryAt = this.failedEndpoints.get(endpoint)?.retryAt || 0;
    if (retryAt > this.now()) throw Object.assign(new Error(`SSH 連線失敗後暫停重試，請於 ${Math.ceil((retryAt - this.now()) / 1000)} 秒後再連線。`), { status: 429, code: 'SSH_COOLDOWN' });
    if (!profile.credential) throw Object.assign(new Error('此連線尚未儲存 SSH 私鑰。'), { status: 400 });
    const credentials = this.vault.open(profile.credential);
    const client = new Client();
    this.pendingClients.set(key, client);
    let fingerprint;
    try { return await new Promise((resolve, reject) => {
      let ready = false;
      client.on('error', error => {
        if (!ready) {
          client.destroy();
          reject(fingerprint && !profile.fingerprints?.includes(fingerprint)
            ? Object.assign(new Error(profile.fingerprints?.length ? 'SSH 主機金鑰已變更，已停止連線。' : '請確認 SSH 主機金鑰指紋。'),
              { status: 409, code: 'HOST_KEY', fingerprint, changed: Boolean(profile.fingerprints?.length) })
            : Object.assign(new Error(`SSH 連線失敗：${error.message}`), { status: 502 }));
        }
      });
      client.once('close', () => {
        if (this.connections.get(key) === client) this.connections.delete(key);
        if (this.pendingClients.get(key) === client) this.pendingClients.delete(key);
        if (!ready) reject(Object.assign(new Error('SSH 連線已中斷。'), { status: 502 }));
        else if (!this.closed && (this.revisions.get(key) || 0) === revision) this.cooldown(endpoint);
      });
      client.once('ready', () => {
        if ((this.revisions.get(key) || 0) !== revision) { client.end(); reject(Object.assign(new Error('連線設定已更新，請重新連線。'), { status: 409 })); return; }
        ready = true;
        this.failedEndpoints.delete(endpoint);
        if (this.pendingClients.get(key) === client) this.pendingClients.delete(key);
        this.connections.set(key, client); resolve(client);
      });
      client.connect({ host: profile.host, port: profile.port, username: profile.username,
        privateKey: credentials.privateKey, passphrase: credentials.passphrase || undefined,
        readyTimeout: 20000, keepaliveInterval: 15000, keepaliveCountMax: 3,
        hostVerifier: publicKey => {
          fingerprint = `SHA256:${crypto.createHash('sha256').update(publicKey).digest('base64').replace(/=+$/, '')}`;
          const trusted = profile.fingerprints?.includes(fingerprint);
          if (!trusted) this.observed.set(key, { fingerprint, expiresAt: Date.now() + 300000, host: profile.host, port: profile.port });
          return Boolean(trusted);
        }
      });
    }); } catch (error) {
      if (error.status === 502 && (this.revisions.get(key) || 0) === revision) this.cooldown(endpoint);
      throw error;
    }
  }
  async trust(owner, id, fingerprint) {
    const observed = this.observed.get(this.key(owner, id));
    const profile = await this.profiles.find(owner, id);
    if (!observed || observed.expiresAt < Date.now() || observed.fingerprint !== fingerprint || observed.host !== profile.host || observed.port !== profile.port) {
      throw Object.assign(new Error('主機驗證已過期，請重新連線。'), { status: 400 });
    }
    await this.profiles.pin(owner, id, fingerprint);
    this.observed.delete(this.key(owner, id));
  }
  disconnect(owner, id) {
    const key = this.key(owner, id);
    this.revisions.set(key, (this.revisions.get(key) || 0) + 1);
    this.connections.get(key)?.end();
    this.pendingClients.get(key)?.destroy();
    this.pendingClients.delete(key);
    this.connecting.delete(key);
    this.connections.delete(key);
  }
  disconnectUser(owner) {
    for (const key of new Set([...this.connections.keys(), ...this.pendingClients.keys()])) if (key.startsWith(`${owner.toLowerCase()}:`)) this.disconnect(owner, key.slice(owner.length + 1));
  }
  async connectedClient(owner, id) {
    const key = this.key(owner, id);
    const client = this.connections.get(key) || await this.connecting.get(key);
    if (!client) throw Object.assign(new Error('SSH 尚未連線或已中斷，請按連線後再試。'), { status: 409, code: 'SSH_DISCONNECTED' });
    return client;
  }
  async exec(owner, id, command, options = {}) {
    const output = new ExecOutput(options);
    const client = await this.connectedClient(owner, id);
    return new Promise((resolve, reject) => {
      client.exec(command, (error, channel) => {
        if (error) return reject(error);
        let settled = false;
        const finish = (error, code = -1) => {
          if (settled) return; settled = true; clearTimeout(timer);
          if (error) { reject(error); channel.close(); }
          else resolve(output.result(code));
        };
        const timer = setTimeout(() => finish(Object.assign(new Error('遠端指令執行逾時。'), { status: 504 })), options.timeout || 30000);
        const stdoutDecoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8');
        const receive = (data, type) => {
          if (settled) return;
          try { output.receive((type === 'stdout' ? stdoutDecoder : stderrDecoder).write(data), type, data.length); }
          catch (error) { finish(error); }
        };
        channel.on('data', data => receive(data, 'stdout'));
        channel.stderr.on('data', data => receive(data, 'stderr'));
        channel.once('error', error => finish(error));
        channel.once('close', code => {
          if (settled) return;
          try { output.receive(stdoutDecoder.end(), 'stdout', 0); output.receive(stderrDecoder.end(), 'stderr', 0); finish(null, code ?? -1); }
          catch (error) { finish(error); }
        });
        try { options.onChannel?.(channel); if (!options.keepStdinOpen) channel.end(options.input || ''); }
        catch (error) { finish(error); }
      });
    });
  }
  async shell(owner, id, size, tool) {
    const client = await this.connectedClient(owner, id);
    const pty = { term: 'xterm-256color', cols: size.cols, rows: size.rows };
    const command = tool ? monitorCommand(tool) : null;
    return new Promise((resolve, reject) => {
      const done = (error, channel) => error ? reject(error) : resolve(channel);
      if (command) client.exec(command, { pty }, done);
      else client.shell(pty, done);
    });
  }
  async sftp(owner, id) {
    const client = await this.connectedClient(owner, id);
    return new Promise((resolve, reject) => client.sftp((error, channel) => error ? reject(error) : resolve(channel)));
  }
  close() { this.closed = true; for (const client of this.connections.values()) client.end(); for (const client of this.pendingClients.values()) client.destroy(); this.connections.clear(); this.pendingClients.clear(); }
}
