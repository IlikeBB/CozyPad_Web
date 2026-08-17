import { scopedStorageKey, userStorage } from '../../platform/userStorage';

export const CODEX_TASK_QUEUE_STORAGE_KEY = 'cozypad3.pendingCodexTrainingTasks.v1';

export const CODEX_TASK_QUEUE_EVENT = 'cozypad3:codex-training-task-queued';

export type QueuedTrainingAgent = 'claude' | 'codex' | 'agy' | 'bailian';

export type QueuedCodexTrainingTask = {
  id: string;
  agent: QueuedTrainingAgent;
  title: string;
  prompt: string;
  remotePath?: string;
  serverId?: string;
  createdAt: string;
};

type QueuedCodexTrainingTaskInput =
  Omit<QueuedCodexTrainingTask, 'id' | 'createdAt' | 'agent'> &
  Partial<Pick<QueuedCodexTrainingTask, 'id' | 'createdAt' | 'agent'>>;

type QueuedCodexTrainingTaskLike = Pick<QueuedCodexTrainingTask, 'title' | 'prompt'>;

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function createQueuedTaskId(): string {
  if (hasWindow() && window.crypto?.randomUUID) {
    return `training:${window.crypto.randomUUID()}`;
  }
  return `training:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeQueuedTrainingAgent(agent: unknown): QueuedTrainingAgent {
  if (agent === 'codex' || agent === 'agy' || agent === 'bailian') {
    return agent;
  }
  return 'codex';
}

function queuedTrainingTaskKey(task: QueuedCodexTrainingTaskInput | QueuedCodexTrainingTask): string {
  return [
    normalizeQueuedTrainingAgent(task.agent),
    String(task.serverId || ''),
    String(task.remotePath || ''),
    String(task.title || ''),
    String(task.prompt || '').trim(),
  ].join('\u001f');
}

export function isQueuedStartTrainingTask(task: QueuedCodexTrainingTaskLike): boolean {
  const title = String(task.title || '').trim().toLowerCase();
  const prompt = String(task.prompt || '').trim().toLowerCase();
  return title === 'start training' || prompt.startsWith('start training');
}

function dedupeQueuedTrainingTasks(tasks: QueuedCodexTrainingTask[]): QueuedCodexTrainingTask[] {
  const seen = new Set<string>();
  return tasks.filter((task) => {
    const key = queuedTrainingTaskKey(task);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function readQueuedCodexTrainingTasks(): QueuedCodexTrainingTask[] {
  if (!hasWindow()) return [];
  try {
    const raw = userStorage.getItem(CODEX_TASK_QUEUE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((task) => task && typeof task.prompt === 'string' && task.prompt.trim())
      .map((task) => ({
        id: String(task.id || createQueuedTaskId()),
        agent: normalizeQueuedTrainingAgent(task.agent),
        title: String(task.title || '開始訓練'),
        prompt: String(task.prompt),
        remotePath: typeof task.remotePath === 'string' ? task.remotePath : undefined,
        serverId: typeof task.serverId === 'string' ? task.serverId : undefined,
        createdAt: String(task.createdAt || new Date().toISOString()),
      }))
      .filter(isQueuedStartTrainingTask);
  } catch {
    return [];
  }
}

function writeQueuedCodexTrainingTasks(tasks: QueuedCodexTrainingTask[]): void {
  if (!hasWindow()) return;
  try {
    userStorage.setItem(CODEX_TASK_QUEUE_STORAGE_KEY, JSON.stringify(dedupeQueuedTrainingTasks(tasks).slice(-24)));
  } catch {
    // Browser storage is best-effort.
  }
}

function dispatchCodexTrainingQueueEvent(detail: Record<string, unknown> = {}): void {
  if (!hasWindow()) return;
  window.dispatchEvent(new CustomEvent(CODEX_TASK_QUEUE_EVENT, { detail }));
}

export function queueCodexTrainingTasks(
  tasksToQueue: QueuedCodexTrainingTaskInput[],
): QueuedCodexTrainingTask[] {
  const queuedTasks: QueuedCodexTrainingTask[] = tasksToQueue
    .map((task) => ({
      id: task.id || createQueuedTaskId(),
      agent: normalizeQueuedTrainingAgent(task.agent),
      title: task.title || 'Codex task',
      prompt: task.prompt,
      remotePath: task.remotePath,
      serverId: task.serverId,
      createdAt: task.createdAt || new Date().toISOString(),
    }))
    .filter((task) => task.prompt.trim() && isQueuedStartTrainingTask(task));
  if (queuedTasks.length === 0) return [];

  writeQueuedCodexTrainingTasks([...readQueuedCodexTrainingTasks(), ...queuedTasks]);
  dispatchCodexTrainingQueueEvent({ task: queuedTasks[0], tasks: queuedTasks });
  return queuedTasks;
}

export function queueCodexTrainingTask(
  task: QueuedCodexTrainingTaskInput,
): QueuedCodexTrainingTask {
  const queuedTask: QueuedCodexTrainingTask = {
    id: task.id || createQueuedTaskId(),
    agent: normalizeQueuedTrainingAgent(task.agent),
    title: task.title || '開始訓練',
    prompt: task.prompt,
    remotePath: task.remotePath,
    serverId: task.serverId,
    createdAt: task.createdAt || new Date().toISOString(),
  };
  if (!queuedTask.prompt.trim() || !isQueuedStartTrainingTask(queuedTask)) {
    return queuedTask;
  }
  const tasks = readQueuedCodexTrainingTasks();
  const sameDestinationTasks = (candidate: QueuedCodexTrainingTask) =>
    candidate.agent === queuedTask.agent &&
    String(candidate.serverId || '') === String(queuedTask.serverId || '') &&
    isQueuedStartTrainingTask(candidate);
  const keptTasks = tasks.filter((candidate) => !sameDestinationTasks(candidate));
  const existingTask = tasks.find((candidate) => queuedTrainingTaskKey(candidate) === queuedTrainingTaskKey(queuedTask));
  if (existingTask) {
    writeQueuedCodexTrainingTasks([...keptTasks, existingTask]);
    dispatchCodexTrainingQueueEvent({ task: existingTask });
    return existingTask;
  }
  writeQueuedCodexTrainingTasks([...keptTasks, queuedTask]);
  dispatchCodexTrainingQueueEvent({ task: queuedTask });
  return queuedTask;
}

export function takeQueuedCodexTrainingTasks(
  predicate: (task: QueuedCodexTrainingTask) => boolean,
): QueuedCodexTrainingTask[] {
  const tasks = readQueuedCodexTrainingTasks();
  const taken: QueuedCodexTrainingTask[] = [];
  const remaining: QueuedCodexTrainingTask[] = [];
  tasks.forEach((task) => {
    if (predicate(task)) {
      taken.push(task);
    } else {
      remaining.push(task);
    }
  });
  if (taken.length > 0) {
    writeQueuedCodexTrainingTasks(remaining);
    dispatchCodexTrainingQueueEvent({ takenTaskIds: taken.map((task) => task.id) });
  }
  return taken;
}

export function removeQueuedCodexTrainingTask(taskId: string): void {
  writeQueuedCodexTrainingTasks(readQueuedCodexTrainingTasks().filter((task) => task.id !== taskId));
  dispatchCodexTrainingQueueEvent({ removedTaskId: taskId });
}

export function subscribeCodexTrainingTasks(callback: (detail?: Record<string, unknown>) => void): () => void {
  if (!hasWindow()) return () => undefined;
  const onQueueEvent = (event: Event) => {
    callback(event instanceof CustomEvent ? event.detail : undefined);
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === scopedStorageKey(CODEX_TASK_QUEUE_STORAGE_KEY)) callback();
  };
  window.addEventListener(CODEX_TASK_QUEUE_EVENT, onQueueEvent);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CODEX_TASK_QUEUE_EVENT, onQueueEvent);
    window.removeEventListener('storage', onStorage);
  };
}
