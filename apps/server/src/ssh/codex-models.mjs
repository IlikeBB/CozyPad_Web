import { remoteCommand } from './remote-shell.mjs';

export function runOptions(payload) {
  const result = {};
  for (const [key, pattern, max] of [
    ['model', /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/, 128],
    ['reasoningEffort', /^[a-z][a-z0-9_-]*$/, 24]
  ]) {
    const value = payload[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' || value.length > max || !pattern.test(value)) {
      throw Object.assign(new Error(`無效的 Codex ${key}。`), { status: 400 });
    }
    result[key] = value;
  }
  return result;
}

export class CodexModels {
  constructor(profiles, ssh) { this.profiles = profiles; this.ssh = ssh; }
  async list(owner, serverId) {
    const profile = await this.profiles.find(owner, serverId);
    let channel, pending = '', failure, finished = false, requestId = 1, pages = 0;
    const models = new Map();
    const send = value => channel.write(`${JSON.stringify(value)}\n`);
    const stop = error => { failure = Object.assign(error, { status: 502 }); channel.end(); channel.close(); };
    const nextPage = cursor => {
      if (++pages > 20) { stop(new Error('Codex 模型清單分頁超過上限。')); return; }
      send({ method: 'model/list', id: ++requestId, params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) } });
    };
    const receive = line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (!message || typeof message !== 'object') return;
      if (message.id !== requestId) return;
      if (message.error) { stop(new Error(message.error.message || '遠端 Codex 無法列出模型。')); return; }
      if (requestId === 1) {
        send({ method: 'initialized', params: {} });
        nextPage();
        return;
      }
      if (!Array.isArray(message.result?.data)) { stop(new Error('遠端 Codex 傳回的模型清單格式無效。')); return; }
      for (const item of message.result.data) {
        if (!item || typeof item !== 'object') continue;
        const model = item.model || item.id;
        try { runOptions({ model }); } catch { continue; }
        if (!model || item.hidden) continue;
        const reasoningEfforts = (Array.isArray(item.supportedReasoningEfforts) ? item.supportedReasoningEfforts : []).map(option => option?.reasoningEffort).filter(value => {
          try { return !!runOptions({ reasoningEffort: value }).reasoningEffort; } catch { return false; }
        });
        models.set(model, { model, displayName: typeof item.displayName === 'string' ? item.displayName.slice(0, 160) : model, isDefault: item.isDefault === true, reasoningEfforts: [...new Set(reasoningEfforts)] });
      }
      if (message.result.nextCursor) nextPage(message.result.nextCursor);
      else { finished = true; channel.end(); channel.close(); }
    };
    // Keep stdin open until initialize is acknowledged, then request each catalog page.
    const launch = options => this.ssh.launchCodex ? this.ssh.launchCodex(owner, profile.id, profile.kind === 'local' ? profile.defaultPath : '~', options, 'model') : this.ssh.exec(owner, profile.id, remoteCommand('~', 'codex app-server'), options);
    await launch({
      timeout: 20000, keepStdinOpen: true,
      onChannel: stream => {
        channel = stream;
        send({ method: 'initialize', id: requestId, params: { clientInfo: { name: 'cozypad_tt', title: 'CozyPad TT', version: '4.0.0' } } });
      },
      onData: (text, type) => {
        if (type !== 'stdout' || finished || failure) return;
        pending += text;
        const lines = pending.split('\n'); pending = lines.pop();
        for (const line of lines) { if (finished || failure) break; receive(line); }
      }
    });
    if (failure) throw failure;
    if (!finished) throw Object.assign(new Error('無法讀取遠端模型清單。請確認此 SSH 帳號的 Codex CLI 版本與登入狀態。'), { status: 502 });
    return [...models.values()];
  }
}
