import { remoteCommand } from './remote-shell.mjs';

export class CodexThreads {
  constructor(profiles, ssh) { this.profiles = profiles; this.ssh = ssh; }
  async delete(owner, serverId, threadId) {
    if (typeof threadId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(threadId)) {
      throw Object.assign(new Error('無效的遠端 Codex 工作階段 ID，已停止刪除。'), { status: 400 });
    }
    const profile = await this.profiles.find(owner, serverId);
    let channel, pending = '', failure, finished = false, requestId = 1;
    const send = value => channel.write(`${JSON.stringify(value)}\n`);
    const stop = error => {
      failure = Object.assign(error, { status: 502 });
      channel.end(); channel.close();
    };
    const receive = line => {
      let response;
      try { response = JSON.parse(line); } catch { return; }
      if (!response || typeof response !== 'object' || response.id !== requestId || response.method) return;
      if (response.error) {
        stop(new Error(response.error.code === -32601
          ? '遠端 Codex CLI 不支援工作階段刪除，請更新 CLI 後再試。本機紀錄已保留。'
          : `遠端工作階段清理失敗：${response.error.message || 'Codex 請求失敗'}。本機紀錄已保留。`));
        return;
      }
      if (!response.result || typeof response.result !== 'object' || Array.isArray(response.result)) {
        stop(new Error('遠端 Codex 未確認刪除結果，本機紀錄已保留。')); return;
      }
      if (requestId === 1) {
        send({ method: 'initialized', params: {} });
        // The native endpoint owns rollout paths and metadata; never delete the project directory.
        send({ method: 'thread/delete', id: ++requestId, params: { threadId } });
      } else {
        finished = true; channel.end(); channel.close();
      }
    };
    // exec reuses an authenticated connection and does not reconnect automatically.
    const launch = options => this.ssh.launchCodex ? this.ssh.launchCodex(owner, profile.id, profile.kind === 'local' ? profile.defaultPath : '~', options, 'cleanup') : this.ssh.exec(owner, profile.id, remoteCommand('~', 'codex app-server'), options);
    await launch({
      timeout: 20000, keepStdinOpen: true,
      onChannel: stream => {
        channel = stream;
        send({ method: 'initialize', id: requestId, params: { clientInfo: { name: 'cozypad_tt_cleanup', title: 'CozyPad TT', version: '4.0.0' } } });
      },
      onData: (text, type) => {
        if (type !== 'stdout' || finished || failure) return;
        pending += text;
        const lines = pending.split('\n'); pending = lines.pop();
        for (const line of lines) { if (finished || failure) break; receive(line); }
      }
    });
    if (failure) throw failure;
    if (!finished) throw Object.assign(new Error('遠端工作階段清理未完成，本機紀錄已保留。請確認 SSH 與 Codex CLI 狀態後再試。'), { status: 502 });
  }
}
