import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import { userId } from '../storage/json-store.mjs';
import { ExecOutput } from '../ssh/exec-output.mjs';

const problem = (message, status = 409) => Object.assign(new Error(message), { status });
const digest = token => crypto.createHash('sha256').update(token).digest('hex');
export class LocalBridge {
  pairs = new Map(); connections = new Map(); sequence = 0;
  constructor(store, identity) { this.store = store; this.identity = identity; }
  file(owner) { return this.store.userPath(owner, 'local-devices.json'); }
  async devices(owner) { return this.store.read(this.file(owner), []); }
  public(owner, device) { return { id: device.id, kind: 'local', name: device.name, host: 'local', port: 0, username: owner, defaultPath: device.roots[0], platform: device.platform, roots: device.roots, hasKey: false, fingerprint: null, online: this.connections.has(device.id) }; }
  async list(owner) { return (await this.devices(owner)).map(device => this.public(owner, device)); }
  async find(owner, id) { const device = (await this.devices(owner)).find(value => value.id === id); if (!device) throw problem('找不到此使用者的本機連接器。', 404); return device; }
  pair(owner, onReady) {
    for (const [code, value] of this.pairs) if (value.owner === owner || value.expiresAt < Date.now()) this.pairs.delete(code);
    const code = crypto.randomBytes(24).toString('base64url'), expiresAt = Date.now() + 120000;
    this.pairs.set(code, { owner, expiresAt, onReady }); return { code, expiresAt };
  }
  async remove(owner, id) {
    await this.find(owner, id);
    await this.store.update(this.file(owner), [], devices => { const index = devices.findIndex(value => value.id === id); if (index >= 0) devices.splice(index, 1); });
    const connection = this.connections.get(id);
    if (connection) { this.connections.delete(id); connection.ws.close(4403, 'Device revoked'); }
  }
  connection(owner, id) { const value = this.connections.get(id); if (!value || value.owner !== owner || value.ws.readyState !== 1) throw problem('本機連接器未上線，請先在自己的電腦啟動。'); return value; }
  async request(owner, id, method, params = {}, timeout = 20000) {
    const connection = this.connection(owner, id), requestId = String(++this.sequence);
    if (connection.pending.size >= 64) throw problem('本機連接器請求過多。', 429);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { connection.pending.delete(requestId); reject(problem('本機連接器請求逾時。', 504)); }, timeout);
      connection.pending.set(requestId, { resolve, reject, timer });
      connection.ws.send(JSON.stringify({ type: 'request', id: requestId, method, params }));
    });
  }
  async exec(owner, id, directory, options = {}, purpose = 'chat') {
    const output = new ExecOutput(options, '本機 Codex 輸出超過 4 MB。');
    const connection = this.connection(owner, id);
    const channelId = crypto.randomUUID(); let done = false, timer;
    return new Promise((resolve, reject) => {
      const finish = error => {
        if (done) return; done = true; clearTimeout(timer); connection.events.off(channelId, receive); connection.events.off('disconnect', disconnect);
        channel.destroyed = true; error ? reject(error) : resolve({ stdout: '', stderr: '', code: 0 });
      };
      const stop = () => { if (connection.ws.readyState === 1) connection.ws.send(JSON.stringify({ type: 'notify', method: 'codex.close', params: { channel: channelId } })); };
      const channel = { destroyed: false, write: data => { if (!done) connection.ws.send(JSON.stringify({ type: 'notify', method: 'codex.write', params: { channel: channelId, data } })); }, end() {}, close: stop };
      const disconnect = () => finish(problem('本機連接器已中斷；未自動重送工作。', 502));
      const receive = event => {
        if (event.event === 'data') {
          if (typeof event.data !== 'string' || !['stdout', 'stderr'].includes(event.stream)) { stop(); finish(problem('本機輸出格式不正確。', 502)); return; }
          try { output.receive(event.data, event.stream); }
          catch (error) { stop(); finish(error); }
        } else if (event.event === 'exit') finish(event.error ? problem(event.error, 502) : undefined);
      };
      connection.events.on(channelId, receive); connection.events.once('disconnect', disconnect);
      timer = setTimeout(() => { stop(); finish(problem('本機 Codex 工作逾時。', 504)); }, options.timeout || 30000);
      void this.request(owner, id, 'codex.open', { channel: channelId, directory, purpose }, 60000).then(info => {
        if (done) { stop(); return; }
        if (purpose === 'chat') options.onData?.(`__COZYPAD_CWD__${info.directory}\n__COZYPAD_CODEX_VERSION__${info.version}\n`, 'stdout');
        options.onChannel?.(channel);
      }).catch(error => { stop(); finish(error); });
    });
  }
  attach(server) {
    const sockets = this.sockets = new WebSocketServer({ noServer: true, maxPayload: 262144 });
    server.on('upgrade', (request, socket, head) => {
      if (new URL(request.url, 'http://localhost').pathname !== '/api/local/bridge') return;
      // Native connectors authenticate inside the first frame, never in a URL or browser cookie.
      if (request.headers.origin || sockets.clients.size >= 64) { socket.end('HTTP/1.1 403 Rejected\r\nConnection: close\r\n\r\n'); return; }
      sockets.handleUpgrade(request, socket, head, ws => this.accept(ws));
    });
    return sockets;
  }
  accept(ws) {
    let authenticated = false, busy = false, connection, alive = true;
    const deadline = setTimeout(() => ws.close(4401, 'Authentication required'), 10000);
    const ping = setInterval(() => { if (!alive) { ws.terminate(); return; } alive = false; ws.ping(); }, 30000); ping.unref();
    ws.on('pong', () => { alive = true; }); ws.on('error', () => {});
    ws.on('close', () => {
      clearTimeout(deadline); clearInterval(ping);
      if (!connection) return;
      if (this.connections.get(connection.id) === connection) this.connections.delete(connection.id);
      for (const pending of connection.pending.values()) { clearTimeout(pending.timer); pending.reject(problem('本機連接器已中斷。', 502)); }
      connection.pending.clear(); connection.events.emit('disconnect');
    });
    ws.on('message', async raw => {
      try {
        if (!authenticated && (busy || raw.length > 8192)) throw problem('Invalid handshake');
        const message = JSON.parse(raw.toString());
        if (!authenticated) {
          if (message.type !== 'hello') throw problem('Authentication required');
          busy = true;
          if (!this.identity || message.protocol !== this.identity.protocol || message.release !== this.identity.release || message.payloadHash !== this.identity.payloadHash) throw problem('Connector release mismatch');
          const metadata = message.metadata;
          if (!metadata || typeof metadata.name !== 'string' || !metadata.name.trim() || metadata.name.length > 128 || /[\x00-\x1f\x7f]/.test(metadata.name) || !['win32', 'linux', 'darwin'].includes(metadata.platform) || !Array.isArray(metadata.roots) || !metadata.roots.length || metadata.roots.length > 10 || metadata.roots.some(root => typeof root !== 'string' || !root.startsWith('/') || root.length > 4096 || /[\x00-\x1f\x7f]/.test(root))) throw problem('Invalid device metadata');
          let owner, device, token, onReady;
          if (typeof message.code === 'string') {
            const pair = this.pairs.get(message.code);
            if (!pair || pair.expiresAt < Date.now()) throw problem('Pairing code invalid or expired');
            this.pairs.delete(message.code); owner = pair.owner; onReady = pair.onReady; token = crypto.randomBytes(32).toString('base64url');
            let previous;
            if (message.previous?.owner === owner && typeof message.previous.deviceId === 'string' && typeof message.previous.token === 'string' && message.previous.token.length <= 128) {
              previous = (await this.devices(owner)).find(value => value.id === message.previous.deviceId);
              if (previous && !crypto.timingSafeEqual(Buffer.from(digest(message.previous.token)), Buffer.from(previous.tokenDigest))) throw problem('Invalid previous device proof');
              if (previous && this.connections.has(previous.id)) throw problem('Device already connected; running work was not interrupted');
            }
            device = { id: previous?.id || `local-${crypto.randomUUID()}`, name: metadata.name, roots: metadata.roots, platform: metadata.platform, tokenDigest: digest(token) };
            await this.store.update(this.file(owner), [], devices => {
              const index = previous ? devices.findIndex(value => value.id === previous.id) : -1;
              if (index >= 0) devices[index] = device;
              else { if (devices.length >= 10) throw problem('Too many local devices'); devices.push(device); }
            });
          } else {
            if (typeof message.owner !== 'string' || typeof message.deviceId !== 'string' || typeof message.token !== 'string' || message.token.length > 128) throw problem('Invalid device credentials');
            owner = userId(message.owner); device = await this.find(owner, message.deviceId);
            const actual = digest(message.token);
            if (!crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(device.tokenDigest))) throw problem('Device credentials invalid');
            if (JSON.stringify(device.roots) !== JSON.stringify(metadata.roots) || device.platform !== metadata.platform) throw problem('Device scope changed; pair it again');
          }
          if (this.connections.has(device.id)) throw problem('Device already connected');
          if (ws.readyState !== 1) return;
          connection = { ws, owner, id: device.id, pending: new Map(), events: new EventEmitter() };
          this.connections.set(device.id, connection); authenticated = true; clearTimeout(deadline);
          onReady?.(device.id);
          ws.send(JSON.stringify({ type: 'ready', owner, deviceId: device.id, ...(token ? { token } : {}) })); return;
        }
        if (message.type === 'response') {
          const pending = connection.pending.get(message.id); if (!pending) return;
          clearTimeout(pending.timer); connection.pending.delete(message.id);
          if (message.error) pending.reject(Object.assign(problem(String(message.error.message || '本機請求失敗。').slice(0, 512), Number(message.error.status) || 502), { code: message.error.code }));
          else pending.resolve(message.value);
        } else if (message.type === 'event' && typeof message.channel === 'string') connection.events.emit(message.channel, message);
        else throw problem('Invalid connector message');
      } catch { ws.close(4403, 'Connector authentication or protocol rejected'); }
    });
  }
  close() { for (const connection of this.connections.values()) connection.ws.close(); this.sockets?.close(); this.pairs.clear(); }
}
