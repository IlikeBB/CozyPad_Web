import type { AgentEvent, AgentTask } from '@cozypad/contracts';

export function mergeEvent(task: AgentTask, event: AgentEvent): AgentTask {
  const index = task.events.findIndex(item => event.messageId ? item.messageId === event.messageId : item.id === event.id);
  const previous = task.events[index];
  if (previous && previous.id >= event.id) return task;
  const events = [...task.events];
  if (index < 0) events.push(event); else events[index] = event;
  return { ...task, events, eventSequence: Math.max(task.eventSequence || 0, event.id), ...(event.type === 'turn' ? { activeTurnId: event.text } : {}), ...(event.type === 'status' ? { status: event.text as AgentTask['status'], activeTurnId: undefined } : {}) };
}

export function mergeHistory(previous: AgentTask[], incoming: AgentTask[], serverId: string, deleted: ReadonlySet<string> = new Set()): AgentTask[] {
  const history = incoming.filter(task => task.serverId === serverId && !deleted.has(task.id)).map(task => {
    const current = previous.find(item => item.id === task.id);
    return current && (current.eventSequence || 0) > (task.eventSequence || 0) ? current : task;
  });
  const ids = new Set(history.map(task => task.id));
  // A poll started before submission must not remove a newly created conversation.
  return [...history, ...previous.filter(task => task.serverId === serverId && !ids.has(task.id) && !deleted.has(task.id))]
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)).slice(0, 100);
}
