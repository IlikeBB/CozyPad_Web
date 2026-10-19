import { attachmentLimits } from '../../../../packages/contracts/src/attachments.mjs';

export class AgentFileDownloads {
  constructor(agents, files) { this.agents = agents; this.files = files; }
  async read(owner, id, requested, cwd) {
    const task = await this.agents.find(owner, id);
    if (typeof requested !== 'string' || !requested || requested.length > 4096 || /[\x00-\x1f\x7f\\]/.test(requested) || requested.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(requested)) {
      throw Object.assign(new Error('下載檔案路徑不正確。'), { status: 400 });
    }
    const base = cwd || task.cwd || task.path;
    if (cwd && ![task.path, task.cwd, ...task.events.filter(event => event.type === 'assistant').map(event => event.cwd)].includes(cwd)) {
      throw Object.assign(new Error('下載工作目錄不屬於此對話。'), { status: 400 });
    }
    try { return await this.files.read(owner, task.serverId, requested, attachmentLimits.bytes, base); }
    catch (error) {
      if (error.code === 2) throw Object.assign(new Error('找不到遠端檔案，可能已移動或刪除。'), { status: 404 });
      if (error.code === 3) throw Object.assign(new Error('SSH 帳號沒有讀取此檔案的權限。'), { status: 403 });
      throw error;
    }
  }
}
