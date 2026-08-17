import {
  CODEX_TASK_QUEUE_STORAGE_KEY,
  readQueuedCodexTrainingTasks,
  removeQueuedCodexTrainingTask,
} from './agents/codexTaskQueue';
import { scopedStorageKey, userStorage } from '../platform/userStorage';

const CODEX_TASKS_STORAGE_KEY = 'cozypad3.legacyCodexTasks.v1';
const CLAUDE_TASKS_STORAGE_KEY = 'cozypad3.legacyClaudeTasks.v1';
const AGY_TASKS_STORAGE_KEY = 'cozypad3.legacyAgyTasks.v1';
const BAILIAN_TASKS_STORAGE_KEY = 'cozypad3.legacyBailianTasks.v1';
const DELETED_WORK_RUNS_STORAGE_KEY = 'cozypad3.deletedWorkRunIds.v1';
const MAX_DELETED_WORK_RUNS = 512;

export const WORK_REFRESH_EVENT = 'cozypad-research-runs-updated';
export const WORK_STORAGE_KEYS = [
  CODEX_TASKS_STORAGE_KEY,
  CLAUDE_TASKS_STORAGE_KEY,
  AGY_TASKS_STORAGE_KEY,
  BAILIAN_TASKS_STORAGE_KEY,
  CODEX_TASK_QUEUE_STORAGE_KEY,
  DELETED_WORK_RUNS_STORAGE_KEY,
] as const;

export function currentWorkStorageKeys(): string[] {
  return WORK_STORAGE_KEYS.map((key) => scopedStorageKey(key)).filter(Boolean);
}

type AgentKind = 'codex' | 'claude' | 'agy' | 'bailian';

export type WorkRunStatus = 'completed' | 'running' | 'failed';

type StoredAgentTask = {
  id?: string;
  title?: string;
  output?: string;
  running?: boolean;
  connected?: boolean;
  status?: string;
  profileId?: string;
  profileName?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type WorkRun = {
  sourceId: string;
  taskId: string;
  agent: AgentKind;
  run: string;
  status: WorkRunStatus;
  duration: string;
  seed: number;
  startDate: string;
  endDate: string;
  profileId: string;
  profileName: string;
  sortTime: number;
};

const USER_TRANSCRIPT_MARKER = '[CozyPad User]';
const CODEX_TRANSCRIPT_MARKER = '[CozyPad Codex]';

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function allocateRunId(agent: AgentKind, sourceId: string, used: Set<string>): string {
  let number = hashString(`${agent}:${sourceId}`) % 10000;
  for (let attempts = 0; attempts < 10000; attempts += 1) {
    const run = `${agent}-${String(number).padStart(4, '0')}`;
    if (!used.has(run)) {
      used.add(run);
      return run;
    }
    number = (number + 1) % 10000;
  }
  return `${agent}-${String(number).padStart(4, '0')}`;
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

export function formatWorkDate(value: Date | null): string {
  if (!value) return '-';
  return value.toLocaleString('zh-TW', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(start: Date | null, end: Date | null): string {
  if (!start || !end) return '-';
  const totalSeconds = Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

function readTaskArray(key: string): StoredAgentTask[] {
  try {
    const raw = userStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeTaskArray(key: string, tasks: StoredAgentTask[]): void {
  try {
    userStorage.setItem(key, JSON.stringify(tasks));
  } catch {
    // Browser storage is best-effort.
  }
}

function readDeletedWorkRunIds(): Set<string> {
  try {
    const raw = userStorage.getItem(DELETED_WORK_RUNS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.map((value) => String(value)) : []);
  } catch {
    return new Set();
  }
}

function writeDeletedWorkRunIds(ids: Set<string>): void {
  try {
    userStorage.setItem(
      DELETED_WORK_RUNS_STORAGE_KEY,
      JSON.stringify([...ids].slice(-MAX_DELETED_WORK_RUNS)),
    );
  } catch {
    // Browser storage is best-effort.
  }
}

function splitWorkRunSourceId(sourceId: string): { agent: AgentKind; taskId: string } | null {
  const separatorIndex = sourceId.indexOf(':');
  if (separatorIndex < 0) return null;
  const agent = sourceId.slice(0, separatorIndex);
  if (agent !== 'codex' && agent !== 'claude' && agent !== 'agy' && agent !== 'bailian') return null;
  return {
    agent,
    taskId: sourceId.slice(separatorIndex + 1),
  };
}

function taskMatchesSourceId(task: StoredAgentTask, taskId: string): boolean {
  return [task.id, task.title, task.createdAt].some((value) => String(value || '') === taskId);
}

function isResearchOnlyCodexTask(task: StoredAgentTask): boolean {
  const id = String(task.id || '').trim().toLowerCase();
  const title = String(task.title || '').trim().toLowerCase();
  const output = normalizeOutput(task.output).trim().toLowerCase();
  return (
    id.startsWith('research-codex:') ||
    title === 'research diagram draw' ||
    title === 'default analysis diagram' ||
    title === 'mix analysis diagram' ||
    output.includes('you are a json-only diagram generator for cozypad.') ||
    output.includes('you are analyzing a cozypad research flowchart.') ||
    output.includes('you are generating md.mix markdown files from a cozypad research flowchart.')
  );
}

function dispatchWorkRefresh(): void {
  try {
    window.dispatchEvent(new Event(WORK_REFRESH_EVENT));
  } catch {
    // Browser events are best-effort.
  }
}

export function markWorkRunDeleted(sourceId: string): void {
  const deleted = readDeletedWorkRunIds();
  deleted.add(sourceId);
  writeDeletedWorkRunIds(deleted);
  dispatchWorkRefresh();
}

export function isWorkRunDeleted(sourceId: string): boolean {
  return readDeletedWorkRunIds().has(sourceId);
}

export function deleteWorkRun(sourceId: string): void {
  markWorkRunDeleted(sourceId);

  const parsed = splitWorkRunSourceId(sourceId);
  if (!parsed) return;

  if (parsed.agent === 'codex') {
    writeTaskArray(
      CODEX_TASKS_STORAGE_KEY,
      readTaskArray(CODEX_TASKS_STORAGE_KEY).filter((task) => !taskMatchesSourceId(task, parsed.taskId)),
    );

    if (parsed.taskId.startsWith('training:')) {
      removeQueuedCodexTrainingTask(parsed.taskId);
    }
  }

  if (parsed.agent === 'claude') {
    writeTaskArray(
      CLAUDE_TASKS_STORAGE_KEY,
      readTaskArray(CLAUDE_TASKS_STORAGE_KEY).filter((task) => !taskMatchesSourceId(task, parsed.taskId)),
    );
  }

  if (parsed.agent === 'agy') {
    writeTaskArray(
      AGY_TASKS_STORAGE_KEY,
      readTaskArray(AGY_TASKS_STORAGE_KEY).filter((task) => !taskMatchesSourceId(task, parsed.taskId)),
    );
  }

  if (parsed.agent === 'bailian') {
    writeTaskArray(
      BAILIAN_TASKS_STORAGE_KEY,
      readTaskArray(BAILIAN_TASKS_STORAGE_KEY).filter(
        (task) => !taskMatchesSourceId(task, parsed.taskId),
      ),
    );
  }

  dispatchWorkRefresh();
}

function normalizeOutput(output: string | undefined): string {
  return String(output || '')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\r/g, '\n');
}

function normalizeRunStatus(value: string | undefined): WorkRunStatus | null {
  if (value === 'completed' || value === 'running' || value === 'failed') {
    return value;
  }
  return null;
}

function lineLooksLikeFatalStatus(line: string): boolean {
  const lower = line.trim().toLowerCase();
  if (!lower) return false;
  return (
    lower.startsWith('[cozypad] remote codex failed') ||
    lower.startsWith('[cozypad] codex failed') ||
    (lower.startsWith('[cozypad local codex]') && lower.includes('failed')) ||
    lower.includes('permission denied (publickey,password)') ||
    lower.includes('host key verification failed') ||
    lower.includes('connection reset') ||
    lower.includes('getsockname failed') ||
    lower.includes('not a socket') ||
    lower.includes('codex cli not found') ||
    lower.includes('remote codex cli not found') ||
    lower.includes('codex command is not recognized') ||
    lower.includes('spawn eperm') ||
    lower.includes('websocket error')
  );
}

function isCodexControlLine(line: string): boolean {
  const trimmed = line.trim();
  const lower = trimmed.toLowerCase();
  if (!trimmed) return true;
  if (trimmed === USER_TRANSCRIPT_MARKER || trimmed === CODEX_TRANSCRIPT_MARKER) return true;
  if (lower === 'user' || lower === 'codex' || lower === 'assistant') return true;
  if (trimmed.startsWith('>') || trimmed.startsWith('??')) return true;
  if (trimmed.startsWith('[CozyPad') || trimmed.startsWith('[Codex]')) return true;
  if (trimmed.startsWith('[Remote Codex]')) return true;
  if (lower.startsWith('exec') || lower.startsWith('tool:')) return true;
  if (lower.startsWith('tokens used') || lower.startsWith('wall time:')) return true;
  if (lower.startsWith('output:') || lower.startsWith('error=exit code')) return true;
  if (/^\d{4}-\d{2}-\d{2}t/i.test(trimmed)) return true;
  return lineLooksLikeFatalStatus(line);
}

function hasUsefulCodexOutput(output: string): boolean {
  const lines = normalizeOutput(output).split('\n');
  let role: 'user' | 'codex' = 'codex';

  for (const line of lines) {
    const trimmed = line.trim();
    const lower = trimmed.toLowerCase();

    if (trimmed === USER_TRANSCRIPT_MARKER || lower === 'user') {
      role = 'user';
      continue;
    }

    if (trimmed === CODEX_TRANSCRIPT_MARKER || lower === 'codex' || lower === 'assistant') {
      role = 'codex';
      continue;
    }

    if (trimmed.startsWith('>') || trimmed.startsWith('??')) {
      role = 'codex';
      continue;
    }

    if (role === 'codex' && !isCodexControlLine(line)) {
      return true;
    }
  }

  return false;
}

function hasFatalFailureSignal(output: string): boolean {
  return normalizeOutput(output)
    .split('\n')
    .some((line) => lineLooksLikeFatalStatus(line));
}

function inferStatus(task: StoredAgentTask): WorkRunStatus {
  const explicitStatus = normalizeRunStatus(task.status);
  if (explicitStatus) return explicitStatus;
  if (task.running) return 'running';
  const output = normalizeOutput(task.output);
  if (hasUsefulCodexOutput(output)) return 'completed';
  if (hasFatalFailureSignal(output)) return 'failed';
  return 'completed';
}

function taskToRun(
  agent: AgentKind,
  task: StoredAgentTask,
  usedRunIds: Set<string>,
): WorkRun | null {
  const sourceId = String(task.id || task.title || task.createdAt || '');
  if (!sourceId) return null;
  const startedAt = parseDate(task.createdAt);
  const updatedAt = parseDate(task.updatedAt) ?? startedAt;
  const status = inferStatus(task);
  const end = status === 'running' ? new Date() : updatedAt;
  return {
    sourceId: `${agent}:${sourceId}`,
    taskId: sourceId,
    agent,
    run: allocateRunId(agent, sourceId, usedRunIds),
    status,
    duration: formatDuration(startedAt, end),
    seed: hashString(sourceId) % 10000,
    startDate: formatWorkDate(startedAt),
    endDate: status === 'running' ? '-' : formatWorkDate(updatedAt),
    profileId: String(task.profileId || ''),
    profileName: String(task.profileName || ''),
    sortTime: updatedAt?.getTime() ?? startedAt?.getTime() ?? 0,
  };
}

export function readWorkRuns(): WorkRun[] {
  const usedRunIds = new Set<string>();
  const deletedRunIds = readDeletedWorkRunIds();
  const tasks: Array<[AgentKind, StoredAgentTask]> = [
    ...readTaskArray(CODEX_TASKS_STORAGE_KEY)
      .filter((task) => !isResearchOnlyCodexTask(task))
      .map((task): [AgentKind, StoredAgentTask] => [
        'codex',
        task,
      ]),
    ...readQueuedCodexTrainingTasks().map((task): [AgentKind, StoredAgentTask] => [
      task.agent,
      {
        id: task.id,
        title: task.title,
        output: task.prompt,
        running: true,
        status: 'running',
        profileId: task.serverId,
        createdAt: task.createdAt,
        updatedAt: task.createdAt,
      },
    ]),
    ...readTaskArray(CLAUDE_TASKS_STORAGE_KEY).map((task): [AgentKind, StoredAgentTask] => [
      'claude',
      task,
    ]),
    ...readTaskArray(AGY_TASKS_STORAGE_KEY).map((task): [AgentKind, StoredAgentTask] => [
      'agy',
      task,
    ]),
    ...readTaskArray(BAILIAN_TASKS_STORAGE_KEY).map((task): [AgentKind, StoredAgentTask] => [
      'bailian',
      task,
    ]),
  ];

  return tasks
    .map(([agent, task]) => taskToRun(agent, task, usedRunIds))
    .filter((run): run is WorkRun => run !== null)
    .filter((run) => !deletedRunIds.has(run.sourceId))
    .sort((left, right) => right.sortTime - left.sortTime);
}
