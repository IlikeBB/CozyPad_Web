import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { remoteDirectory } from './ssh-service.mjs';

export function sendTerminal(ws, payload) {
  if (ws?.readyState !== 1) return;
  // A slow/disconnected browser must not accumulate unbounded output in ws.
  if (ws.bufferedAmount > 2 * 1024 * 1024) { ws.terminate(); return; }
  ws.send(JSON.stringify(payload), error => { if (error) ws.terminate(); });
}

export class TerminalSessions {
  constructor(ssh, profiles, { detachMs = 10 * 60 * 1000, maxReplayBytes = 1024 * 1024, maxReplayPackets = 4096, maxSessions = 128, maxPerOwner = 8 } = {}) {
    Object.assign(this, { ssh, profiles, detachMs, maxReplayBytes, maxReplayPackets, maxSessions, maxPerOwner });
    this.sessions = new Map();
  }

  async attach(owner, serverId, ws, { sessionId, after = 0, tool = '' } = {}) {
    owner = owner.toLowerCase();
    let terminal = sessionId && this.sessions.get(sessionId);
    if (sessionId && (!terminal || terminal.owner !== owner || terminal.serverId !== serverId || terminal.tool !== tool)) {
      throw Object.assign(new Error('原終端機已結束或保留時間已到。請按「重新開啟終端機」建立新工作階段。'), { code: 'TERMINAL_MISSING' });
    }
    if (!terminal) {
      if (this.sessions.size >= this.maxSessions || [...this.sessions.values()].filter(item => item.owner === owner).length >= this.maxPerOwner) {
        throw Object.assign(new Error('終端機數量已達上限。請關閉不使用的終端機後再試。'), { code: 'TERMINAL_LIMIT' });
      }
      terminal = { id: randomUUID(), owner, serverId, tool, sequence: 0, packets: [], bytes: 0, live: false, closed: false };
      this.sessions.set(terminal.id, terminal);
      terminal.opening = this.open(terminal);
    }
    clearTimeout(terminal.expiry);
    const previous = terminal.ws;
    terminal.ws = ws; terminal.live = false;
    // Only the current transport can write to the retained shell.
    if (previous && previous !== ws) previous.close(4009, 'Terminal attached elsewhere');
    ws.once('close', () => this.detach(terminal, ws));
    if (ws.readyState !== 1) this.detach(terminal, ws);
    await terminal.opening;
    if (terminal.closed) throw Object.assign(new Error('終端機工作階段已結束。'), { code: 'TERMINAL_MISSING' });
    if (terminal.ws !== ws || ws.readyState !== 1) return terminal;
    after = Number.isSafeInteger(after) && after >= 0 ? Math.min(after, terminal.sequence) : 0;
    const first = terminal.packets[0]?.sequence ?? terminal.sequence + 1;
    if (after < first - 1) sendTerminal(ws, { type: 'notice', text: '斷線期間輸出超過保留上限，部分較早的輸出已略過。' });
    for (const packet of terminal.packets) if (packet.sequence > after) sendTerminal(ws, packet);
    terminal.live = true;
    sendTerminal(ws, { type: 'ready', sessionId: terminal.id, resumed: Boolean(sessionId) });
    return terminal;
  }

  async open(terminal) {
    try {
      const profile = await this.profiles.find(terminal.owner, terminal.serverId);
      const channel = await this.ssh.shell(terminal.owner, terminal.serverId, { rows: 24, cols: 100 }, terminal.tool);
      terminal.channel = channel;
      if (terminal.closed) { channel.close(); return; }
      const stdout = new StringDecoder('utf8'), stderr = new StringDecoder('utf8');
      channel.on('data', data => this.output(terminal, stdout.write(data)));
      channel.stderr.on('data', data => this.output(terminal, stderr.write(data)));
      channel.on('error', error => {
        sendTerminal(terminal.ws, { type: 'error', code: 'TERMINAL_ENDED', text: error.message });
        this.dispose(terminal);
      });
      channel.on('exit', code => {
        if (terminal.tool && code) sendTerminal(terminal.ws, { type: 'error', code: 'TERMINAL_ENDED', text: code === 127
          ? `遠端尚未安裝 ${terminal.tool}。請安裝後重新開啟。`
          : `${terminal.tool} 已結束（狀態 ${code}）。請查看終端畫面的錯誤訊息。` });
      });
      channel.on('close', () => {
        this.output(terminal, stdout.end()); this.output(terminal, stderr.end());
        sendTerminal(terminal.ws, { type: 'ended' }); this.dispose(terminal, false);
      });
      // Initialization runs only once, never when replacing the WebSocket.
      if (!terminal.tool && profile.defaultPath && profile.defaultPath !== '~') channel.write(`cd ${remoteDirectory(profile.defaultPath)}\r`);
    } catch (error) { this.dispose(terminal, false, false); throw error; }
  }

  output(terminal, data) {
    if (!data || terminal.closed) return;
    // Split exceptional large chunks on Unicode code point boundaries.
    const fragments = data.length > 8192 ? data.match(/[\s\S]{1,8192}/gu) : [data];
    for (const fragment of fragments) {
      const packet = { type: 'output', sequence: ++terminal.sequence, data: fragment };
      terminal.packets.push(packet); terminal.bytes += Buffer.byteLength(fragment);
      while (terminal.bytes > this.maxReplayBytes || terminal.packets.length > this.maxReplayPackets) {
        terminal.bytes -= Buffer.byteLength(terminal.packets.shift().data);
      }
      if (terminal.live) sendTerminal(terminal.ws, packet);
    }
  }

  detach(terminal, ws) {
    if (terminal.closed || terminal.ws !== ws) return;
    terminal.ws = null; terminal.live = false;
    terminal.expiry = setTimeout(() => this.dispose(terminal), this.detachMs);
    terminal.expiry.unref();
  }

  dispose(terminal, closeChannel = true, closeSocket = true) {
    if (terminal.closed) return;
    terminal.closed = true; clearTimeout(terminal.expiry);
    this.sessions.delete(terminal.id); terminal.packets = []; terminal.bytes = 0;
    if (closeSocket) terminal.ws?.close(1000);
    if (closeChannel) terminal.channel?.close();
  }

  close() { for (const terminal of this.sessions.values()) this.dispose(terminal); }
  releaseSocket(ws) { for (const terminal of this.sessions.values()) if (terminal.ws === ws) this.dispose(terminal); }
}
