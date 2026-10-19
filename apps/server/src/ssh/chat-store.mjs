export class ChatStore {
  initializations = new Map();
  constructor(store) { this.store = store; }
  file(owner) { return this.store.userPath(owner, 'codex-chats.json'); }
  async initialize(owner) {
    const file = this.file(owner);
    if (!this.initializations.has(file)) {
      const operation = (async () => {
        if (await this.store.read(file, null) !== null) return;
        const legacy = await this.store.read(this.store.userPath(owner, 'codex-tasks.json'), []);
        // Leave the original per-turn file untouched while merging its shared CLI threads.
        const groups = new Map();
        for (const task of [...legacy].sort((a, b) => a.createdAt - b.createdAt)) {
          const key = `${task.serverId}:${task.threadId || task.id}`;
          let chat = groups.get(key);
          if (!chat) {
            chat = { ...task, events: [], legacyIds: [], eventSequence: 0, turnCount: 0 };
            groups.set(key, chat);
          }
          chat.legacyIds.push(task.id); chat.turnCount++;
          for (const event of [{ type: 'user', text: task.prompt, time: task.createdAt }, ...task.events]) {
            const id = ++chat.eventSequence;
            chat.events.push({ ...event, id, order: id, messageId: `legacy:${task.id}:${id}` });
          }
          Object.assign(chat, { status: task.status === 'running' ? 'failed' : task.status, path: task.path, model: task.model, reasoningEffort: task.reasoningEffort, updatedAt: task.createdAt });
        }
        await this.store.write(file, [...groups.values()].sort((a, b) => b.updatedAt - a.updatedAt));
      })();
      this.initializations.set(file, operation);
      operation.catch(() => this.initializations.delete(file));
    }
    await this.initializations.get(file);
  }
  async list(owner) { await this.initialize(owner); return this.store.read(this.file(owner), []); }
  async save(owner, task) {
    await this.initialize(owner);
    const snapshot = structuredClone(task);
    await this.store.update(this.file(owner), [], tasks => {
      const index = tasks.findIndex(item => item.id === snapshot.id);
      if (index >= 0) tasks.splice(index, 1);
      tasks.unshift(snapshot);
      tasks.splice(100);
    });
  }
  async delete(owner, id) {
    await this.initialize(owner);
    await this.store.update(this.file(owner), [], tasks => {
      const index = tasks.findIndex(task => task.id === id);
      if (index < 0) throw Object.assign(new Error('找不到此使用者的對話。'), { status: 404 });
      tasks.splice(index, 1);
    });
  }
}
