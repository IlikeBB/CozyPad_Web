import { codexChatCommand } from './remote-shell.mjs';
import crypto from 'node:crypto';
import { approvalSettings } from './approval-settings.mjs';
import { delegationDetails, executionConfig, executionInstruction, supportsDelegation } from './execution-settings.mjs';
import { UserInputRequests } from './user-input-requests.mjs';
import { searchInstruction } from './search-instruction.mjs';
import { questionInstruction } from './question-instruction.mjs';
import { ProtocolLines } from '../../../../packages/contracts/src/codex-protocol-lines.mjs';
import { cooperationInstruction, cooperationTools } from './cooperation.mjs';

export class CodexChat {
  constructor(ssh, owner, task, input, callbacks) {
    Object.assign(this, { ssh, owner, task, input, callbacks });
    this.approvals = new Map();
    this.items = new Map();
    this.childThreads = new Set();
    this.toolRequests = new Map();
    this.toolQueue = Promise.resolve();
    this.steers = new Map();
    this.nextRequestId = 100;
    this.questions = new UserInputRequests({
      matches: params => !this.finished && !this.cancelled && (params.threadId === this.task.threadId ? !!this.turnId && params.turnId === this.turnId : this.childThreads.has(params.threadId) && typeof params.turnId === 'string' && !!params.turnId),
      send: value => this.send(value), emit: request => this.callbacks.question?.(request)
    });
  }
  send(value) { if (!this.channel?.destroyed) this.channel?.write(`${JSON.stringify(value)}\n`); }
  started(id) {
    if (typeof id !== 'string' || !id || this.finished || this.turnId === id) return;
    this.turnId = id;
    clearTimeout(this.bootTimer);
    this.callbacks.turn?.(id);
  }
  steer(text, expectedTurnId, accepted, timeoutMs = 15000) {
    if (this.finished || this.cancelled || !this.turnId || expectedTurnId !== this.turnId || !this.channel || this.channel.destroyed) {
      throw Object.assign(new Error('目前回合尚未就緒或已結束，草稿已保留。'), { status: 409 });
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const pending = { expectedTurnId, accepted, resolve, reject };
      // Retain timed-out IDs until the turn ends: a late acknowledgement is still meaningful.
      pending.timer = setTimeout(() => reject(Object.assign(new Error('尚未確認 Codex 是否收到引導，請等待對話更新；再次送出相同草稿只會查詢這次結果。'), { status: 504 })), timeoutMs);
      this.steers.set(id, pending);
      try { this.send({ method: 'turn/steer', id, params: { threadId: this.task.threadId, expectedTurnId, input: [{ type: 'text', text }] } }); }
      catch (error) { clearTimeout(pending.timer); this.steers.delete(id); reject(error); }
    });
  }
  clearSteers() {
    for (const pending of this.steers.values()) {
      clearTimeout(pending.timer);
      pending.reject(Object.assign(new Error('回合已結束，未取得引導確認；草稿已保留，請先確認對話內容。'), { status: 409 }));
    }
    this.steers.clear();
  }
  end(error) {
    if (this.finished) return;
    this.finished = true; this.error = error;
    this.clearSteers();
    this.clearApprovals();
    this.questions.clear();
    clearTimeout(this.bootTimer); clearTimeout(this.cancelTimer);
    this.channel?.end(); this.channel?.close();
  }
  clearApprovals() {
    for (const request of this.approvals.values()) this.callbacks.approval({ ...request.details, status: 'cancelled' });
    this.approvals.clear();
  }
  approve(id, decision) {
    const request = this.approvals.get(id);
    if (!request || this.finished || this.cancelled) throw Object.assign(new Error('此核准請求已結束。'), { status: 409 });
    if (decision === 'accept' && !request.details.canAccept) throw Object.assign(new Error('遠端不允許本次核准。'), { status: 400 });
    this.send({ id: request.remoteId, result: { decision } });
    this.approvals.delete(id);
    this.callbacks.approval({ ...request.details, status: decision === 'accept' ? 'accepted' : 'declined' });
  }
  answer(id, answers) {
    if (this.finished || this.cancelled) throw Object.assign(new Error('此對話已結束。'), { status: 409 });
    this.questions.answer(id, answers);
  }
  requestApproval(message) {
    const params = message.params || {};
    const child = this.childThreads.has(params.threadId);
    if ((!child && (params.threadId !== this.task.threadId || params.turnId !== this.turnId)) || (child && (typeof params.turnId !== 'string' || !params.turnId))) {
      this.send({ id: message.id, error: { code: -32602, message: 'Approval request does not match the active turn.' } }); return;
    }
    if ([...this.approvals.values()].some(request => request.remoteId === message.id)) return;
    const item = this.items.get(`${params.threadId}:${params.itemId}`);
    const preview = (value, limit = 4096) => typeof value === 'string' ? value.slice(0, limit) : '';
    const details = {
      id: crypto.randomUUID(), kind: message.method === 'item/fileChange/requestApproval' ? 'file-change' : 'command', status: 'pending',
      command: preview(params.command || item?.command), cwd: preview(params.cwd || this.cwd),
      reason: preview(params.reason, 2048), grantRoot: preview(params.grantRoot),
      ...(child ? { agentThreadId: params.threadId } : {}),
      network: params.networkApprovalContext ? { host: preview(params.networkApprovalContext.host, 256), protocol: preview(params.networkApprovalContext.protocol, 32), port: params.networkApprovalContext.port } : null,
      changes: (Array.isArray(item?.changes) ? item.changes : []).slice(0, 5).map(change => ({ path: preview(change.path, 2048), diff: preview(change.diff, 2048) })),
      canAccept: !Array.isArray(params.availableDecisions) || params.availableDecisions.includes('accept')
    };
    this.approvals.set(details.id, { remoteId: message.id, details });
    this.callbacks.approval(details);
  }
  cancel() {
    this.cancelled = true;
    if (this.turnId && !this.finished) {
      this.send({ method: 'turn/interrupt', id: 4, params: { threadId: this.task.threadId, turnId: this.turnId } });
      this.cancelTimer = setTimeout(() => this.end(), 5000);
    } else this.end();
  }
  receive(line) {
    if (line.startsWith('__COZYPAD_CWD__')) { this.cwd = line.slice('__COZYPAD_CWD__'.length); return; }
    if (line.startsWith('__COZYPAD_CODEX_VERSION__')) { this.version = line.slice('__COZYPAD_CODEX_VERSION__'.length).trim(); return; }
    let message;
    try { message = JSON.parse(line); } catch { this.callbacks.process(line); return; }
    if (!message || typeof message !== 'object') return;
    if (message.id != null && message.method) {
      if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') { this.requestApproval(message); return; }
      if (message.method === 'item/tool/requestUserInput' || message.method === 'tool/requestUserInput') { this.questions.request(message); return; }
      if (message.method === 'item/tool/call') { this.requestTool(message); return; }
      // Never grant permissions or answer interactive questions on the user's behalf.
      this.send({ id: message.id, error: { code: -32601, message: 'Interactive requests are not supported by CozyPad chat.' } });
      this.callbacks.process('遠端要求互動式核准，請改用終端機處理。');
      return;
    }
    if (message.id != null) {
      const pending = this.steers.get(message.id);
      if (pending) {
        clearTimeout(pending.timer); this.steers.delete(message.id);
        if (message.error) pending.reject(Object.assign(new Error(`Codex 未接受引導：${message.error.message || '此版本不支援途中引導。'} 草稿已保留。`), { status: 409 }));
        else if (message.result?.turnId !== pending.expectedTurnId) pending.reject(Object.assign(new Error('Codex 傳回的回合不符合目前工作，草稿已保留。'), { status: 409 }));
        else { pending.accepted(message.result.turnId); pending.resolve(message.result.turnId); }
        return;
      }
      // Late responses to a settled steering request must never terminate generation.
      if (typeof message.id === 'number' && message.id >= 100) return;
      if (message.error) { this.end(new Error(message.error.message || 'Codex 串流請求失敗。')); return; }
      if (message.id === 1) {
        if (!this.cwd?.startsWith('/') || this.cwd.length > 4096 || /[\x00-\x1f\x7f]/.test(this.cwd)) { this.end(new Error('無法取得遠端工作目錄。')); return; }
        this.task.cwd = this.cwd;
        if (this.task.executionMode === 'delegated' && !supportsDelegation(this.version)) {
          this.end(new Error('委派處理需要遠端 Codex CLI 0.161.0 或更新版本。請更新該 SSH 帳號的 Codex，或切換一般處理後再送出。')); return;
        }
        this.send({ method: 'initialized', params: {} });
        this.send({ method: this.task.threadId ? 'thread/resume' : 'thread/start', id: 2, params: {
          ...(this.task.threadId ? { threadId: this.task.threadId } : {}), cwd: this.cwd, developerInstructions: `${searchInstruction()}\n${questionInstruction()}${this.task.executionMode === 'cooperative' ? `\n${cooperationInstruction(this.task)}` : ''}`,
          ...(!this.task.threadId && this.task.executionMode === 'cooperative' ? { dynamicTools: cooperationTools } : {}),
          ...approvalSettings(this.task.approvalMode), ...(this.task.model ? { model: this.task.model } : {}),
          config: { ...executionConfig(this.task.executionMode), 'features.default_mode_request_user_input': true, ...(!supportsDelegation(this.version) ? { 'features.multi_agent': false } : {}) }
        } });
      } else if (message.id === 2) {
        const thread = message.result?.thread;
        if (typeof thread?.id !== 'string') { this.end(new Error('Codex 未傳回對話 ID。')); return; }
        this.task.threadId = thread.id;
        if (this.task.executionMode === 'cooperative') this.task.cooperationToolEnabled = true;
        this.callbacks.thread();
        this.send({ method: 'turn/start', id: 3, params: {
          threadId: thread.id, input: this.task.executionMode === 'delegated' ? [...this.input, { type: 'text', text: executionInstruction('delegated') }] : this.input, cwd: this.cwd,
          ...(this.task.model ? { model: this.task.model } : {}), ...(this.task.reasoningEffort ? { effort: this.task.reasoningEffort } : {})
        } });
      } else if (message.id === 3) {
        this.started(message.result?.turn?.id);
        if (this.cancelled) this.cancel();
      }
      return;
    }
    const params = message.params || {};
    if (params.threadId && params.threadId !== this.task.threadId) {
      // Retain only known child previews for manual approvals, not their entire transcripts.
      if (this.childThreads.has(params.threadId) && ['item/started', 'item/completed'].includes(message.method) && params.item?.id) {
        this.rememberItem(params.threadId, params.item);
        if (params.item.type === 'collabAgentToolCall') this.collaboration(params.item);
      }
      if (this.childThreads.has(params.threadId) && message.method === 'serverRequest/resolved') { this.resolveApproval(params.requestId); this.questions.resolve(params.requestId, params.threadId); }
      return;
    }
    if (params.turnId && this.turnId && params.turnId !== this.turnId) return;
    if (message.method === 'turn/started') { this.started(params.turn?.id); }
    else if (message.method === 'serverRequest/resolved') {
      this.resolveApproval(params.requestId);
      this.questions.resolve(params.requestId, params.threadId);
    }
    else if (message.method === 'item/agentMessage/delta') this.callbacks.delta(params.itemId, 'assistant', params.delta);
    else if (message.method === 'item/commandExecution/outputDelta') this.callbacks.delta(params.itemId, 'command', params.delta);
    else if (message.method === 'item/started' || message.method === 'item/completed') {
      const item = params.item;
      if (!item?.id) return;
      this.rememberItem(params.threadId || this.task.threadId, item);
      if (item.type === 'agentMessage') this.callbacks.item(item.id, 'assistant', item.text || '', message.method === 'item/completed');
      else if (item.type === 'commandExecution') this.callbacks.item(item.id, 'command', `${item.command || ''}\n${item.aggregatedOutput || ''}`);
      else if (item.type === 'fileChange' && message.method === 'item/completed') this.callbacks.item(item.id, 'process', (item.changes || []).map(change => change.path).join('\n'));
      else if (item.type === 'mcpToolCall' && message.method === 'item/completed') this.callbacks.item(item.id, 'process', `${item.server || ''}: ${item.tool || ''} · ${item.status || ''}`);
      else if (item.type === 'collabAgentToolCall' && this.task.executionMode === 'delegated') {
        this.collaboration(item);
      }
    } else if (message.method === 'thread/tokenUsage/updated') {
      const usage = params.tokenUsage?.last;
      if (usage) this.callbacks.usage({ input_tokens: usage.inputTokens, cached_input_tokens: usage.cachedInputTokens, output_tokens: usage.outputTokens });
    } else if (message.method === 'error') this.callbacks.error(params.error?.message || 'Codex 發生錯誤。');
    else if (message.method === 'turn/completed') {
      const status = params.turn?.status;
      this.status = status === 'completed' ? 'completed' : status === 'interrupted' ? 'cancelled' : 'failed';
      this.end(this.status === 'failed' ? new Error(params.turn?.error?.message || 'Codex 回覆失敗。') : undefined);
    }
  }
  rememberItem(threadId, item) {
    if (!['commandExecution', 'fileChange'].includes(item.type)) return;
    const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
    this.items.set(`${threadId}:${item.id}`, {
      command: text(item.command, 4096),
      changes: (Array.isArray(item.changes) ? item.changes : []).slice(0, 5).map(change => ({ path: text(change.path, 2048), diff: text(change.diff, 2048) }))
    });
    while (this.items.size > 256) this.items.delete(this.items.keys().next().value);
  }
  requestTool(message) {
    const params = message.params || {};
    if (this.finished || this.cancelled || this.task.executionMode !== 'cooperative' || params.threadId !== this.task.threadId || !this.turnId || params.turnId !== this.turnId || !cooperationTools.some(tool => tool.name === params.tool) || !this.callbacks.tool) {
      this.send({ id: message.id, error: { code: -32602, message: 'Tool does not match the active cooperative turn.' } }); return;
    }
    const key = JSON.stringify(message.id);
    if (this.toolRequests.has(key)) return;
    if (this.toolRequests.size >= 64) { this.send({ id: message.id, error: { code: -32602, message: 'Too many cooperation calls.' } }); return; }
    this.toolRequests.set(key, true);
    // Serialize state-changing tools so duplicated/overlapping requests cannot create extra work.
    this.toolQueue = this.toolQueue.catch(() => {}).then(async () => {
      let result;
      try { result = { contentItems: [{ type: 'inputText', text: JSON.stringify(await this.callbacks.tool(params)) }], success: true }; }
      catch (error) { result = { contentItems: [{ type: 'inputText', text: String(error.message).slice(0, 1024) }], success: false }; }
      if (!this.finished && !this.cancelled) this.send({ id: message.id, result });
    });
  }
  collaboration(item) {
    if (this.task.executionMode !== 'delegated' || (item.senderThreadId !== this.task.threadId && !this.childThreads.has(item.senderThreadId))) return;
    for (const id of (Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [])) {
      if (typeof id === 'string' && id && id !== this.task.threadId && id.length <= 128 && this.childThreads.size < 64) this.childThreads.add(id);
    }
    this.callbacks.item(`${item.senderThreadId}:${item.id}`, 'delegation', JSON.stringify(delegationDetails(item)));
  }
  resolveApproval(remoteId) {
    for (const [id, request] of this.approvals) if (request.remoteId === remoteId) {
      this.approvals.delete(id); this.callbacks.approval({ ...request.details, status: 'cancelled' });
    }
  }
  async run() {
    const lines = new ProtocolLines();
    try {
      const launch = options => this.ssh.launchCodex ? this.ssh.launchCodex(this.owner, this.task.serverId, this.task.path, options, 'chat') : this.ssh.exec(this.owner, this.task.serverId, codexChatCommand(this.task.path), options);
      await launch({
        timeout: 1800000, keepStdinOpen: true, collectOutput: false,
        onChannel: channel => {
          this.channel = channel;
          if (this.cancelled) { channel.close(); return; }
          this.bootTimer = setTimeout(() => this.end(new Error('遠端 Codex 啟動逾時。')), 60000);
          this.send({ method: 'initialize', id: 1, params: { clientInfo: { name: 'cozypad_tt', title: 'CozyPad TT', version: '4.0.0' }, capabilities: { experimentalApi: true } } });
        },
        onData: (text, type) => {
          if (this.finished) return;
          if (type === 'stderr') { this.callbacks.process(text); return; }
          try { lines.write(text, line => { if (!this.finished && line.trim()) this.receive(line); return !this.finished; }); }
          catch (error) { this.end(error); }
        }
      });
      if (this.error) throw this.error;
      if (!this.finished && !this.cancelled) throw new Error('Codex 串流提前中斷。請確認遠端 CLI 版本及登入狀態。');
      return this.cancelled ? 'cancelled' : this.status;
    } finally { lines.clear(); this.clearSteers(); this.clearApprovals(); this.questions.clear(); clearTimeout(this.bootTimer); clearTimeout(this.cancelTimer); }
  }
}
