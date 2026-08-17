import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatItem } from '@cozypad/contracts';
import { ChatComposer } from './ChatComposer';
import { ChatTimeline } from './ChatTimeline';
import { EditSentMessageDialog } from './EditSentMessageDialog';
import {
  getLegacyAgyStatus,
  getLegacyBailianStatus,
  getLegacyCodexStatus,
  clearLegacyBailianSessionKey,
  openLegacyAgySession,
  openLegacyBailianSession,
  openLegacyRemoteAgentStream,
  resetLegacyRemoteAgentCooldown,
  serializeLegacyRemoteAgentStreamPayload,
  stopLegacyAgentLatestTask,
  syncLegacyBailianSessionKey,
  type LegacyAgyStatus,
  type LegacySshServer,
} from './legacySshApi';
import {
  clearBailianRuntimeKey,
  extractBailianRuntimeKey,
  getBailianRuntimeKey,
  setBailianRuntimeKey,
} from './bailianRuntimeKey';
import {
  isQueuedStartTrainingTask,
  subscribeCodexTrainingTasks,
  takeQueuedCodexTrainingTasks,
} from './codexTaskQueue';
import { isWorkRunDeleted, markWorkRunDeleted } from '../workRuns';
import { commonAgentSlashCommands } from './slashCommands';
import { userStorage } from '../../platform/userStorage';

const AGENT_CONFIG = {
  codex: {
    label: 'Codex',
    title: 'Codex CLI',
    storageKey: 'cozypad3.legacyCodexTasks.v1',
    getStatus: getLegacyCodexStatus,
  },
  agy: {
    label: 'agy',
    title: 'agy CLI',
    storageKey: 'cozypad3.legacyAgyTasks.v1',
    getStatus: getLegacyAgyStatus,
  },
  bailian: {
    label: 'baillian',
    title: 'baillian',
    storageKey: 'cozypad3.legacyBailianTasks.v1',
    getStatus: getLegacyBailianStatus,
  },
} as const;

const WORK_REFRESH_EVENT = 'cozypad-research-runs-updated';
const MAX_TASKS = 24;
const MAX_OUTPUT_LENGTH = 120_000;
const MAX_KEY_TEXT_LENGTH = 24_000;
const AGENT_WS_STALE_RECONNECT_MS = 90_000;
const AGY_MODEL_STORAGE_KEY = 'cozypad3.remoteAgy.model.v1';
const BAILIAN_MODEL_STORAGE_KEY = 'cozypad3.remoteBailian.model.v1';
const AGY_MODEL_FALLBACKS = [
  'gemini-3.6-flash-high',
  'gemini-3.6-flash-medium',
  'gemini-3.6-flash-low',
  'gemini-3.5-flash-high',
  'gemini-3.5-flash-medium',
  'gemini-3.5-flash-low',
  'gemini-3.1-pro-high',
  'gemini-3.1-pro-low',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium',
];
const BAILIAN_MODEL_FALLBACKS = [
  'qwen-plus',
  'qwen3.8-max',
  'qwen3.7-max',
  'qwen3.7-plus',
  'qwen3.6-flash',
  'deepseek-r1',
  'deepseek-v3',
  'deepseek-r1-0528',
  'kimi-k2.7-code',
  'glm-5.2',
  'MiniMax-M2.5',
  'qwen-max',
  'qwen-turbo',
  'qwen-long',
  'deepseek-v3.2',
  'deepseek-v3.2-exp',
  'deepseek-v3.1',
  'deepseek-r1-distill-qwen-32b',
  'deepseek-r1-distill-qwen-14b',
  'deepseek-r1-distill-qwen-7b',
];
const BAILIAN_INACCESSIBLE_MODEL_FALLBACKS = new Set([
  'deepseek-v4-pro',
  'deepseek-v4-pro-us',
  'deepseek-v4-flash',
  'deepseek-v4-flash-us',
]);

type LegacyAgentName = keyof typeof AGENT_CONFIG;
type AgentTaskStatus = 'completed' | 'running' | 'failed';

type AgentTask = {
  id: string;
  title: string;
  prompt: string;
  output: string;
  status: AgentTaskStatus;
  running: boolean;
  connected: boolean;
  profileId: string;
  profileName: string;
  serverTarget: string;
  remotePath: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  items: ChatItem[];
};

function createTaskId(agentName: LegacyAgentName): string {
  if (window.crypto?.randomUUID) return `${agentName}:${window.crypto.randomUUID()}`;
  return `${agentName}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function titleFromPrompt(prompt: string, agentName: LegacyAgentName): string {
  return prompt.replace(/\s+/g, ' ').trim().slice(0, 32) || `${agentName} 工作`;
}

function legacyServerTarget(server: LegacySshServer | null): string {
  if (!server) return '';
  if (server.source === 'system') return server.alias || server.name;
  if (server.source === 'ssh-config') return server.alias || server.name;
  return `${server.user ? `${server.user}@` : ''}${server.host}${server.port ? `:${server.port}` : ''}`;
}

function isLocalLegacyServer(server: LegacySshServer | null): boolean {
  if (!server) return false;
  if (server.localOnly) return true;
  if (server.source === 'system' && server.id === 'system:localhost') return true;

  const host = server.host.trim().toLowerCase();
  const labels = [server.id, server.name, server.alias, server.source]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  const labelledLocalTerminal = labels.some(
    (value) => value === 'local terminal' || value.includes('local terminal'),
  );
  const noSshPort =
    server.port === undefined ||
    server.port === null ||
    Number(server.port) <= 0 ||
    !Number.isFinite(Number(server.port));

  return (
    (host === 'localhost' || host === '::1' || host.startsWith('127.')) &&
    (labelledLocalTerminal || noSshPort)
  );
}

function normalizeRemotePath(value: string): string {
  return value.trim().slice(0, 240) || '~';
}

function normalizeAgentModel(value: string): string {
  const model = value.trim().slice(0, 80);
  return /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(model) ? model : '';
}

function readStoredAgentModel(storageKey: string): string {
  if (!storageKey) return '';
  try {
    return normalizeAgentModel(userStorage.getItem(storageKey) || '');
  } catch {
    return '';
  }
}

function mergeAgentModelOptions(...groups: Array<Array<string | undefined> | undefined>): string[] {
  const seen = new Set<string>();
  const options: string[] = [];
  for (const group of groups) {
    for (const value of group || []) {
      const model = normalizeAgentModel(String(value || ''));
      const key = model.toLowerCase();
      if (!model || seen.has(key)) continue;
      seen.add(key);
      options.push(model);
    }
  }
  return options;
}

function normalizeStatus(value: unknown, running: unknown): AgentTaskStatus {
  if (value === 'completed' || value === 'running' || value === 'failed') return value;
  return running ? 'running' : 'completed';
}

function friendlyAgentMessage(value: string, agentName: LegacyAgentName): string {
  const text = value
    .replace(/__COZYPAD_CODEX_MISSING__/g, '')
    .replace(/__COZYPAD_AGY_MISSING__/g, '')
    .replace(/__COZYPAD_BAILIAN_MISSING__/g, '')
    .trim();
  const lower = text.toLowerCase();
  if (!text) return '';
  if (
    lower.includes('connection closed by') ||
    lower.includes('connection reset') ||
    lower.includes('kex_exchange_identification') ||
    lower.includes('getsockname failed') ||
    lower.includes('not a socket') ||
    lower.includes('read from remote host')
  ) {
    return `遠端 SSH 連線在 ${agentName} 啟動前被關閉；CozyPad 已停止本次執行且不會自動重試。請稍後再試，或先確認該 server 沒有限制新的 SSH 連線。`;
  }
  if (lower.includes(`remote ${agentName} cli not found`) || lower.includes('not found')) {
    return `這台 server 尚未偵測到 ${agentName} CLI。請在遠端安裝 ${agentName} 後再執行。`;
  }
  return text;
}

function streamAgentLabel(agentName: LegacyAgentName): string {
  return agentName === 'bailian' ? 'bailian' : agentName;
}

function isAgentStreamDone(value: string, agentName: LegacyAgentName): boolean {
  return value.toLowerCase().includes(`[cozypad] remote ${streamAgentLabel(agentName)} ready`);
}

function isAgentStreamFailed(value: string, agentName: LegacyAgentName): boolean {
  const lower = value.toLowerCase();
  const label = streamAgentLabel(agentName);
  return (
    lower.includes(`[cozypad] remote ${label} failed`) ||
    lower.includes(`[cozypad] remote ${label} exited with code`) ||
    lower.includes('[cozypad] remote agent failed')
  );
}

function isAgentStreamRunningSignal(value: string, agentName: LegacyAgentName): boolean {
  const lower = value.toLowerCase();
  const label = streamAgentLabel(agentName);
  return (
    lower.includes(`[cozypad] remote ${label} is still running`) ||
    lower.includes(`[cozypad] remote ${label} queued follow-up`) ||
    lower.includes(`[cozypad] remote ${label} running queued follow-up`) ||
    lower.includes(`another remote ${label} task is already running`)
  );
}

function visibleAgentStreamText(value: string, agentName: LegacyAgentName): string {
  const label = streamAgentLabel(agentName);
  return String(value || '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r(?!\n)/g, '\n')
    .split(/\r?\n/)
    .filter((line) => {
      const lower = line.trim().toLowerCase();
      return (
        lower &&
        lower !== '[cozypad] remote agent stream ready' &&
        !lower.startsWith(`[cozypad] remote ${label} attached`) &&
        lower !== `[cozypad] remote ${label} starting` &&
        lower !== `[cozypad] remote ${label} heartbeat` &&
        !lower.startsWith(`[cozypad] remote ${label} queued follow-up`) &&
        !lower.startsWith(`[cozypad] remote ${label} running queued follow-up`) &&
        !lower.startsWith(`[cozypad] remote ${label} is still running`) &&
        !lower.includes(`another remote ${label} task is already running`) &&
        !lower.startsWith(`[cozypad] remote ${label} ready`)
      );
    })
    .join('\n');
}

function suffixPrefixOverlapLength(left: string, right: string): number {
  const max = Math.min(left.length, right.length);
  for (let length = max; length > 0; length -= 1) {
    if (left.slice(-length) === right.slice(0, length)) return length;
  }
  return 0;
}

function appendVisibleDelta(current: string, delta: string): string {
  const next = delta.trim();
  if (!next) return current;
  if (!current) return next;
  if (current === next || current.endsWith(next)) return current;
  if (next.startsWith(current)) return next;

  const overlap = suffixPrefixOverlapLength(current, next);
  if (overlap > 0) {
    return `${current}${next.slice(overlap)}`;
  }
  return `${current}\n${next}`.trim();
}

function assistantVisibleTranscript(items: ChatItem[]): string {
  return items
    .filter(
      (item): item is Extract<ChatItem, { kind: 'message' }> =>
        item.kind === 'message' && item.role === 'assistant' && Boolean(item.text?.trim()),
    )
    .map((item) => item.text.trim())
    .join('\n');
}

function buildBailianConversationPrompt(items: ChatItem[], nextPrompt: string): string {
  const history = items
    .filter(
      (item): item is Extract<ChatItem, { kind: 'message' }> =>
        item.kind === 'message' && Boolean(item.text?.trim()),
    )
    .map((item) => {
      const role = item.role === 'user' ? 'User' : 'bailian';
      return `${role}:\n${item.text.trim()}`;
    })
    .join('\n\n')
    .slice(-18_000);

  if (!history) return nextPrompt;
  return [
    'You are continuing an existing CozyPad Bailian conversation.',
    'Use the conversation history below as context and answer only the latest user request.',
    '',
    'Conversation history:',
    history,
    '',
    'Latest user request:',
    nextPrompt,
  ].join('\n');
}

function nextVisibleDelta(
  consumedByTask: Map<string, string>,
  taskId: string,
  visible: string,
): { delta: string; consumedBefore: string } {
  const next = visible.trim();
  const consumedBefore = consumedByTask.get(taskId) || '';
  if (!next) return { delta: '', consumedBefore };

  if (!consumedBefore) {
    consumedByTask.set(taskId, next);
    return { delta: next, consumedBefore };
  }

  if (next === consumedBefore || consumedBefore.endsWith(next)) {
    return { delta: '', consumedBefore };
  }

  if (next.startsWith(consumedBefore)) {
    const delta = next.slice(consumedBefore.length).replace(/^\r?\n/, '').trim();
    consumedByTask.set(taskId, next);
    return { delta, consumedBefore };
  }

  const overlap = suffixPrefixOverlapLength(consumedBefore, next);
  if (overlap > 0) {
    const delta = next.slice(overlap).trim();
    consumedByTask.set(taskId, `${consumedBefore}${delta}`);
    return { delta, consumedBefore };
  }

  consumedByTask.set(taskId, appendVisibleDelta(consumedBefore, next));
  return { delta: next, consumedBefore };
}

function sanitizeChatItem(item: unknown, agentName: LegacyAgentName): ChatItem | null {
  if (!item || typeof item !== 'object') return null;
  const next = { ...(item as Record<string, unknown>) };
  if (typeof next.text === 'string') {
    next.text = friendlyAgentMessage(next.text, agentName);
  }
  return next as ChatItem;
}

function chatItemTime(item: ChatItem): number {
  const time = Date.parse(item.timestamp || '');
  return Number.isFinite(time) ? time : 0;
}

function isDuplicateChatItem(left: ChatItem, right: ChatItem): boolean {
  if (left.id === right.id) return true;
  if (left.kind !== right.kind) return false;
  const closeInTime = Math.abs(chatItemTime(left) - chatItemTime(right)) <= 1500;
  if (!closeInTime) return false;

  if (left.kind === 'message' && right.kind === 'message') {
    return left.role === right.role && left.text.trim() === right.text.trim();
  }
  if (left.kind === 'usage' && right.kind === 'usage') {
    return left.inputTokens === right.inputTokens && left.outputTokens === right.outputTokens;
  }
  if (left.kind === 'tool_call' && right.kind === 'tool_call') {
    return left.name === right.name && left.summary === right.summary && left.status === right.status;
  }
  if (left.kind === 'file_diff' && right.kind === 'file_diff') {
    return left.path === right.path && left.diff === right.diff;
  }
  if (left.kind === 'approval' && right.kind === 'approval') {
    return left.command === right.command && left.cwd === right.cwd;
  }
  if (left.kind === 'question' && right.kind === 'question') {
    return left.prompt === right.prompt;
  }
  return false;
}

function dedupeChatItems(items: ChatItem[]): ChatItem[] {
  const byId = new Set<string>();
  const next: ChatItem[] = [];
  for (const item of items) {
    if (byId.has(item.id)) continue;
    const previous = next[next.length - 1];
    if (previous && isDuplicateChatItem(previous, item)) continue;
    byId.add(item.id);
    next.push(item);
  }
  return next;
}

function normalizeTaskItems(task: AgentTask): AgentTask {
  return {
    ...task,
    items: dedupeChatItems(task.items),
  };
}

function agentTaskDedupeKey(task: AgentTask): string {
  return [
    task.title.trim(),
    task.prompt.trim(),
    task.profileId,
    task.serverTarget,
    task.remotePath,
    task.model,
  ].join('\u001f');
}

function dedupeAgentTasks(tasks: AgentTask[]): AgentTask[] {
  const seen = new Set<string>();
  return tasks.filter((task) => {
    const key = agentTaskDedupeKey(task);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readStoredTasks(storageKey: string, agentName: LegacyAgentName): AgentTask[] {
  try {
    const raw = userStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    const tasks = parsed
      .filter((task) => task && typeof task.id === 'string')
      .filter((task) => !isWorkRunDeleted(`${agentName}:${String(task.id)}`))
      .map((task) => {
        const status = normalizeStatus(task.status, task.running);
        const items = Array.isArray(task.items)
          ? task.items.map((item: unknown) => sanitizeChatItem(item, agentName)).filter(Boolean)
          : [];
        return normalizeTaskItems({
          id: String(task.id),
          title: String(task.title || `${agentName} 工作`),
          prompt: String(task.prompt || ''),
          output: String(task.output || '').slice(-MAX_OUTPUT_LENGTH),
          status,
          running: status === 'running',
          connected: false,
          profileId: String(task.profileId || ''),
          profileName: String(task.profileName || '未選 SSH'),
          serverTarget: String(task.serverTarget || ''),
          remotePath: String(task.remotePath || '~'),
          model: normalizeAgentModel(String(task.model || '')),
          createdAt: String(task.createdAt || new Date().toISOString()),
          updatedAt: String(task.updatedAt || task.createdAt || new Date().toISOString()),
          items: items as ChatItem[],
        });
      });
    return dedupeAgentTasks(tasks).slice(0, MAX_TASKS);
  } catch {
    return [];
  }
}

function writeStoredTasks(storageKey: string, tasks: AgentTask[]): void {
  try {
    const serializable = dedupeAgentTasks(tasks).slice(0, MAX_TASKS).map((task) => ({
      ...task,
      items: dedupeChatItems(task.items),
      connected: false,
      running: task.running,
      status: task.running ? 'running' : task.status,
      output: task.output.slice(-MAX_OUTPUT_LENGTH),
    }));
    userStorage.setItem(storageKey, JSON.stringify(serializable));
    window.dispatchEvent(new Event(WORK_REFRESH_EVENT));
  } catch {
    // Browser storage is best-effort.
  }
}

function taskOutput(prompt: string, reply: string, agentName: LegacyAgentName): string {
  return ['[CozyPad User]', prompt, `[CozyPad ${agentName}]`, reply].join('\n');
}

function createTask(
  prompt: string,
  server: LegacySshServer,
  agentName: LegacyAgentName,
  model = '',
): AgentTask {
  const now = new Date().toISOString();
  const id = createTaskId(agentName);
  return {
    id,
    title: titleFromPrompt(prompt, agentName),
    prompt,
    output: taskOutput(prompt, '', agentName),
    status: 'running',
    running: true,
    connected: false,
    profileId: server.id,
    profileName: server.name,
    serverTarget: legacyServerTarget(server),
    remotePath: server.defaultPath || '~',
    model: agentName === 'agy' || agentName === 'bailian' ? normalizeAgentModel(model) : '',
    createdAt: now,
    updatedAt: now,
    items: [
      {
        kind: 'message',
        id: `${id}:user:0`,
        role: 'user',
        text: prompt,
        timestamp: now,
      },
    ],
  };
}

export function LegacyAgyPanel({
  agentName = 'agy',
  legacyServer,
  connected = false,
  focusTaskId = '',
  focusRequestNonce = 0,
  onOpenFilesPath,
}: {
  agentName?: LegacyAgentName;
  legacyServer: LegacySshServer | null;
  connected?: boolean;
  focusTaskId?: string;
  focusRequestNonce?: number;
  onOpenFilesPath?: (target: { serverId: string; path: string }) => void;
}) {
  const config = AGENT_CONFIG[agentName];
  const supportsModel = agentName === 'agy' || agentName === 'bailian';
  const agentModelStorageKey =
    agentName === 'agy' ? AGY_MODEL_STORAGE_KEY : agentName === 'bailian' ? BAILIAN_MODEL_STORAGE_KEY : '';
  const [tasks, setTasks] = useState<AgentTask[]>(() =>
    readStoredTasks(config.storageKey, agentName),
  );
  const [activeTaskId, setActiveTaskId] = useState(
    () => readStoredTasks(config.storageKey, agentName)[0]?.id ?? '',
  );
  const [taskFilter, setTaskFilter] = useState('');
  const [composerText, setComposerText] = useState('');
  const [cwdInput, setCwdInput] = useState('~');
  const [status, setStatus] = useState<LegacyAgyStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [helperError, setHelperError] = useState('');
  const [stoppingTaskId, setStoppingTaskId] = useState('');
  const [editingUserMessage, setEditingUserMessage] = useState<{
    taskId: string;
    messageId: string;
    text: string;
  } | null>(null);
  const [bailianKey, setBailianKey] = useState(() => getBailianRuntimeKey());
  const [agentModelInput, setAgentModelInput] = useState(() =>
    readStoredAgentModel(agentModelStorageKey),
  );
  const keyInputRef = useRef<HTMLInputElement | null>(null);
  const tasksRef = useRef<AgentTask[]>(tasks);
  const socketsRef = useRef(new Map<string, WebSocket>());
  const socketActivityRef = useRef(new Map<string, number>());
  const completedSocketTaskIdsRef = useRef(new Set<string>());
  const replaceNextVisibleTextRef = useRef(new Set<string>());
  const awaitingRunStartRef = useRef(new Set<string>());
  const consumedVisibleTextRef = useRef(new Map<string, string>());
  const drainingTrainingQueueRef = useRef(false);
  const lastSendRef = useRef<{ key: string; at: number } | null>(null);

  const serverTarget = legacyServerTarget(legacyServer);
  const activeTask = tasks.find((task) => task.id === activeTaskId) ?? null;
  const rawAgentModel = supportsModel ? normalizeAgentModel(agentModelInput) : '';
  const agentModel =
    agentName === 'bailian' && BAILIAN_INACCESSIBLE_MODEL_FALLBACKS.has(rawAgentModel.toLowerCase())
      ? 'qwen-plus'
      : rawAgentModel;
  const agentModelFallbacks =
    agentName === 'agy' ? AGY_MODEL_FALLBACKS : agentName === 'bailian' ? BAILIAN_MODEL_FALLBACKS : [];
  const agentModelOptions = useMemo(
    () =>
      supportsModel
        ? mergeAgentModelOptions(
            [status?.defaultModel, agentModelInput, activeTask?.model],
            status?.models,
            agentModelFallbacks,
          )
        : [],
    [activeTask?.model, agentModelFallbacks, agentModelInput, status?.defaultModel, status?.models, supportsModel],
  );
  const visibleTasks = useMemo(
    () =>
      tasks
        .filter((task) => !legacyServer || task.profileId === legacyServer.id)
        .filter((task) =>
          taskFilter.trim()
            ? `${task.title} ${task.profileName} ${task.remotePath}`
                .toLowerCase()
                .includes(taskFilter.trim().toLowerCase())
            : true,
        ),
    [legacyServer, taskFilter, tasks],
  );

  useEffect(() => {
    for (const socket of socketsRef.current.values()) {
      socket.close();
    }
    socketsRef.current.clear();
    socketActivityRef.current.clear();
    completedSocketTaskIdsRef.current.clear();
    replaceNextVisibleTextRef.current.clear();
    awaitingRunStartRef.current.clear();
    consumedVisibleTextRef.current.clear();
    const stored = readStoredTasks(config.storageKey, agentName);
    setTasks(stored);
    setActiveTaskId(stored[0]?.id ?? '');
    setTaskFilter('');
    setComposerText('');
    setStatus(null);
    setHelperError('');
    setAgentModelInput(
      readStoredAgentModel(
        agentName === 'agy' ? AGY_MODEL_STORAGE_KEY : agentName === 'bailian' ? BAILIAN_MODEL_STORAGE_KEY : '',
      ),
    );
  }, [agentName, config.storageKey]);

  useEffect(() => {
    writeStoredTasks(config.storageKey, tasks);
    tasksRef.current = tasks;
    if (agentName === 'agy' || agentName === 'bailian') {
      for (const task of tasks) {
        if (!consumedVisibleTextRef.current.has(task.id)) {
          consumedVisibleTextRef.current.set(task.id, assistantVisibleTranscript(task.items));
        }
      }
    }
  }, [agentName, config.storageKey, tasks]);

  useEffect(
    () => () => {
      for (const socket of socketsRef.current.values()) {
        socket.close();
      }
      socketsRef.current.clear();
      socketActivityRef.current.clear();
      completedSocketTaskIdsRef.current.clear();
      replaceNextVisibleTextRef.current.clear();
      awaitingRunStartRef.current.clear();
      consumedVisibleTextRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    if (!supportsModel) return;
    if (agentName === 'bailian' && BAILIAN_INACCESSIBLE_MODEL_FALLBACKS.has(agentModelInput.toLowerCase())) {
      setAgentModelInput('qwen-plus');
      return;
    }
    try {
      userStorage.setItem(agentModelStorageKey, agentModel);
    } catch {
      // Browser storage is best-effort.
    }
  }, [agentModel, agentModelInput, agentModelStorageKey, agentName, supportsModel]);

  const checkAgent = useCallback(() => {
    if (!legacyServer) {
      setStatus(null);
      setHelperError('');
      return;
    }
    if (!connected) {
      setStatus(null);
      setHelperError('Press Connect before checking remote agents.');
      return;
    }
    setChecking(true);
    setHelperError('');
    const statusPromise =
      agentName === 'bailian'
        ? getLegacyBailianStatus(legacyServer.id, { hasApiKey: Boolean(bailianKey.trim()) })
        : agentName === 'agy'
          ? resetLegacyRemoteAgentCooldown('agy', legacyServer.id)
              .catch(() => null)
              .then(() => config.getStatus(legacyServer.id))
          : config.getStatus(legacyServer.id);
    void statusPromise
      .then(setStatus)
      .catch((error) => {
        setStatus(null);
        setHelperError(
          friendlyAgentMessage(
            error instanceof Error ? error.message : `${config.label} 檢查失敗`,
            agentName,
          ),
        );
      })
      .finally(() => setChecking(false));
  }, [agentName, bailianKey, config, connected, legacyServer]);

  useEffect(() => {
    setStatus(null);
    setHelperError('');
    setChecking(false);
  }, [connected, legacyServer?.id]);

  useEffect(() => {
    if (!legacyServer) return;
    const serverTasks = readStoredTasks(config.storageKey, agentName).filter(
      (task) => task.profileId === legacyServer.id,
    );
    setTasks((current) => {
      const other = current.filter((task) => task.profileId !== legacyServer.id);
      return [...serverTasks, ...other].slice(-MAX_TASKS);
    });
    setActiveTaskId(serverTasks[0]?.id ?? '');
    setCwdInput(serverTasks[0]?.remotePath || legacyServer.defaultPath || '~');
  }, [agentName, config.storageKey, legacyServer?.id]);

  useEffect(() => {
    if (activeTask) setCwdInput(activeTask.remotePath || '~');
  }, [activeTask?.id, activeTask?.remotePath]);

  useEffect(() => {
    if (!focusTaskId) return;
    const matchedTask = tasks.find((task) => task.id === focusTaskId);
    if (!matchedTask) return;
    setTaskFilter('');
    setActiveTaskId(matchedTask.id);
    setCwdInput(matchedTask.remotePath || '~');
  }, [focusRequestNonce, focusTaskId, tasks]);

  const updateTask = useCallback((taskId: string, updater: (task: AgentTask) => AgentTask) => {
    setTasks((current) =>
      current.map((task) => (task.id === taskId ? normalizeTaskItems(updater(task)) : task)),
    );
  }, []);

  const connectAgyTask = useCallback((
    task: AgentTask,
    payload?: {
      prompt: string;
      remotePath: string;
      model: string;
    },
    options: { assistantId?: string } = {},
  ) => {
    if (!connected) {
      setHelperError('Press Connect before opening agy SSH sessions.');
      return;
    }
    if (!legacyServer?.id) {
      setHelperError('請先選擇 SSH server。');
      return;
    }

    const taskRemotePath = normalizeRemotePath(
      payload?.remotePath || task.remotePath || legacyServer.defaultPath || '~',
    );
    const existing = socketsRef.current.get(task.id);
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
      if (!payload) {
        return;
      }
      existing.close();
      socketsRef.current.delete(task.id);
    }
    existing?.close();

    const storedTask = tasksRef.current.find((item) => item.id === task.id) || task;
    if (payload) {
      consumedVisibleTextRef.current.set(task.id, '');
      awaitingRunStartRef.current.add(task.id);
    } else {
      if (!consumedVisibleTextRef.current.has(task.id)) {
        consumedVisibleTextRef.current.set(task.id, assistantVisibleTranscript(storedTask.items));
      }
      replaceNextVisibleTextRef.current.add(task.id);
    }

    const socket = openLegacyAgySession({
      serverId: legacyServer.id,
      remotePath: taskRemotePath,
      taskId: task.id,
      suppressReplay: Boolean(payload),
    });
    socketsRef.current.set(task.id, socket);
    socketActivityRef.current.set(task.id, Date.now());
    updateTask(task.id, (current) => ({ ...current, connected: false }));

    socket.addEventListener('open', () => {
      socketActivityRef.current.set(task.id, Date.now());
      updateTask(task.id, (current) => ({ ...current, connected: true }));
      if (!payload) return;
      socket.send(
        serializeLegacyRemoteAgentStreamPayload({
          agent: 'agy',
          serverId: legacyServer.id,
          prompt: payload.prompt,
          remotePath: taskRemotePath,
          ...(payload.model ? { model: payload.model } : {}),
        }),
      );
    });
    socket.addEventListener('message', (event) => {
      socketActivityRef.current.set(task.id, Date.now());
      const text = String(event.data || '');
      const lower = text.toLowerCase();
      const startSignal = lower.includes('[cozypad] remote agy starting');
      if (awaitingRunStartRef.current.has(task.id)) {
        if (startSignal) {
          awaitingRunStartRef.current.delete(task.id);
        } else if (!isAgentStreamFailed(text, 'agy')) {
          return;
        }
      }

      const done = isAgentStreamDone(text, 'agy');
      const failed = isAgentStreamFailed(text, 'agy');
      const runningSignal = startSignal || isAgentStreamRunningSignal(text, 'agy');
      const rawVisible = visibleAgentStreamText(text, 'agy');
      const { delta: visible, consumedBefore } = nextVisibleDelta(
        consumedVisibleTextRef.current,
        task.id,
        rawVisible,
      );
      const replaceVisible = Boolean(
        visible &&
          replaceNextVisibleTextRef.current.has(task.id) &&
          !consumedBefore.trim(),
      );
      if (rawVisible.trim()) {
        replaceNextVisibleTextRef.current.delete(task.id);
      }
      if (!visible.trim() && !done && !failed && !runningSignal) return;
      if (!payload && done && !rawVisible.trim() && replaceNextVisibleTextRef.current.has(task.id)) {
        replaceNextVisibleTextRef.current.delete(task.id);
        completedSocketTaskIdsRef.current.add(task.id);
        updateTask(task.id, (current) => {
          const message =
            'agy session is no longer available in CozyPad API. The API may have restarted or the SSH worker was closed; please send this task again manually.';
          const assistantId =
            [...current.items]
              .reverse()
              .find(
                (item): item is Extract<ChatItem, { kind: 'message' }> =>
                  item.kind === 'message' && item.role === 'assistant',
              )?.id || `${task.id}:assistant:${Date.now()}`;
          const hasAssistant = current.items.some((item) => item.kind === 'message' && item.id === assistantId);
          return {
            ...current,
            output: taskOutput(current.prompt || task.prompt, message, 'agy'),
            status: 'failed',
            running: false,
            connected: false,
            updatedAt: new Date().toISOString(),
            items: hasAssistant
              ? current.items.map((item) =>
                  item.kind === 'message' && item.id === assistantId
                    ? { ...item, text: message, streaming: false }
                    : item,
                )
              : [
                  ...current.items,
                  {
                    kind: 'message' as const,
                    id: assistantId,
                    role: 'assistant' as const,
                    text: message,
                    streaming: false,
                    timestamp: new Date().toISOString(),
                  },
                ],
          };
        });
        socket.close();
        return;
      }

      updateTask(task.id, (current) => {
        let reply = '';
        let sawAssistant = false;
        let alreadyHasUsage = false;
        const currentAssistant =
          [...current.items]
            .reverse()
            .find(
              (item): item is Extract<ChatItem, { kind: 'message' }> =>
                item.kind === 'message' && item.role === 'assistant',
            ) || null;
        const assistantId = options.assistantId || currentAssistant?.id || `${task.id}:assistant:${Date.now()}`;
        const items = current.items.map((item) => {
          if (item.kind === 'usage') alreadyHasUsage = true;
          if (item.kind !== 'message' || item.id !== assistantId) return item;
          sawAssistant = true;
          reply = replaceVisible
            ? visible
            : appendVisibleDelta(item.text || '', visible);
          return {
            ...item,
            text: failed ? friendlyAgentMessage(reply || visible || text, 'agy') : reply,
            streaming: !(done || failed),
          };
        });
        const nextItems = sawAssistant
          ? items
          : [
              ...items,
              {
                kind: 'message' as const,
                id: assistantId,
                role: 'assistant' as const,
                text: failed ? friendlyAgentMessage(visible || text, 'agy') : visible,
                streaming: !(done || failed),
                timestamp: new Date().toISOString(),
              },
            ];
        const finalReply = String(
          (nextItems.find((item) => item.kind === 'message' && item.id === assistantId) as
            | Extract<ChatItem, { kind: 'message' }>
            | undefined)?.text || '',
        );
        return {
          ...current,
          output: taskOutput(current.prompt || task.prompt, finalReply, 'agy'),
          status: failed ? 'failed' : done ? 'completed' : runningSignal ? 'running' : current.status,
          running: failed || done ? false : runningSignal ? true : current.running,
          connected: !(done || failed),
          updatedAt: new Date().toISOString(),
          items: [
            ...nextItems,
            ...((done || failed) && !alreadyHasUsage
              ? [
                  {
                    kind: 'usage' as const,
                    id: `${task.id}:usage:${Date.now()}`,
                    inputTokens: current.prompt.length,
                    outputTokens: finalReply.length,
                    timestamp: new Date().toISOString(),
                  },
                ]
              : []),
          ],
        };
      });
      if (done || failed) {
        completedSocketTaskIdsRef.current.add(task.id);
        awaitingRunStartRef.current.delete(task.id);
        replaceNextVisibleTextRef.current.delete(task.id);
        socket.close();
      }
    });
    socket.addEventListener('close', () => {
      if (socketsRef.current.get(task.id) !== socket) return;
      socketsRef.current.delete(task.id);
      socketActivityRef.current.delete(task.id);
      updateTask(task.id, (current) =>
        current.running && !completedSocketTaskIdsRef.current.has(task.id)
          ? {
              ...current,
              connected: false,
              updatedAt: new Date().toISOString(),
            }
          : { ...current, connected: false },
      );
    });
    socket.addEventListener('error', () => {
      updateTask(task.id, (current) => ({ ...current, connected: false, updatedAt: new Date().toISOString() }));
      try {
        socket.close();
      } catch {
        // Browser WebSocket close can fail if the socket is already closed.
      }
    });
  }, [connected, legacyServer, updateTask]);

  const connectBailianTask = useCallback((
    task: AgentTask,
    payload?: {
      prompt: string;
      remotePath: string;
      model: string;
      apiKey: string;
    },
    options: { assistantId?: string } = {},
  ) => {
    if (!connected) {
      setHelperError('Press Connect before opening bailian SSH sessions.');
      return;
    }
    if (!legacyServer?.id) {
      setHelperError('Select an SSH server first.');
      return;
    }

    const taskRemotePath = normalizeRemotePath(
      payload?.remotePath || task.remotePath || legacyServer.defaultPath || '~',
    );
    const existing = socketsRef.current.get(task.id);
    const serializedPayload = payload
      ? serializeLegacyRemoteAgentStreamPayload({
          agent: 'bailian',
          serverId: legacyServer.id,
          prompt: payload.prompt,
          remotePath: taskRemotePath,
          ...(payload.model ? { model: payload.model } : {}),
          ...(payload.apiKey ? { apiKey: payload.apiKey } : {}),
        })
      : '';

    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
      if (!payload) {
        return;
      }
      existing.close();
      socketsRef.current.delete(task.id);
    }
    existing?.close();

    const storedTask = tasksRef.current.find((item) => item.id === task.id) || task;
    if (payload) {
      consumedVisibleTextRef.current.set(task.id, '');
      awaitingRunStartRef.current.add(task.id);
    } else {
      consumedVisibleTextRef.current.set(task.id, assistantVisibleTranscript(storedTask.items));
      replaceNextVisibleTextRef.current.add(task.id);
    }

    const socket = openLegacyBailianSession({
      serverId: legacyServer.id,
      remotePath: taskRemotePath,
      taskId: task.id,
      suppressReplay: Boolean(payload),
    });
    socketsRef.current.set(task.id, socket);
    socketActivityRef.current.set(task.id, Date.now());
    updateTask(task.id, (current) => ({ ...current, connected: false }));

    socket.addEventListener('open', () => {
      socketActivityRef.current.set(task.id, Date.now());
      updateTask(task.id, (current) => ({ ...current, connected: true }));
      if (!payload) return;
      socket.send(serializedPayload);
    });

    socket.addEventListener('message', (event) => {
      socketActivityRef.current.set(task.id, Date.now());
      const text = String(event.data || '');
      const lower = text.toLowerCase();
      const startSignal = lower.includes('[cozypad] remote bailian starting');
      if (awaitingRunStartRef.current.has(task.id)) {
        if (startSignal) {
          awaitingRunStartRef.current.delete(task.id);
        } else if (!isAgentStreamFailed(text, 'bailian')) {
          return;
        }
      }

      const done = isAgentStreamDone(text, 'bailian');
      const failed = isAgentStreamFailed(text, 'bailian');
      const runningSignal = startSignal || isAgentStreamRunningSignal(text, 'bailian');
      const rawVisible = visibleAgentStreamText(text, 'bailian');
      const { delta: visible, consumedBefore } = nextVisibleDelta(
        consumedVisibleTextRef.current,
        task.id,
        rawVisible,
      );
      const replaceVisible = Boolean(
        visible &&
          replaceNextVisibleTextRef.current.has(task.id) &&
          !consumedBefore.trim(),
      );
      if (rawVisible.trim()) {
        replaceNextVisibleTextRef.current.delete(task.id);
      }
      if (!visible.trim() && !done && !failed && !runningSignal) return;
      if (!payload && done && !rawVisible.trim() && replaceNextVisibleTextRef.current.has(task.id)) {
        replaceNextVisibleTextRef.current.delete(task.id);
        completedSocketTaskIdsRef.current.add(task.id);
        updateTask(task.id, (current) => {
          const message =
            'bailian session is no longer available in CozyPad API. The API may have restarted or the SSH worker was closed; please send this task again manually.';
          const assistantId =
            [...current.items]
              .reverse()
              .find(
                (item): item is Extract<ChatItem, { kind: 'message' }> =>
                  item.kind === 'message' && item.role === 'assistant',
              )?.id || `${task.id}:assistant:${Date.now()}`;
          const hasAssistant = current.items.some((item) => item.kind === 'message' && item.id === assistantId);
          return {
            ...current,
            output: taskOutput(current.prompt || task.prompt, message, 'bailian'),
            status: 'failed',
            running: false,
            connected: false,
            updatedAt: new Date().toISOString(),
            items: hasAssistant
              ? current.items.map((item) =>
                  item.kind === 'message' && item.id === assistantId
                    ? { ...item, text: message, streaming: false }
                    : item,
                )
              : [
                  ...current.items,
                  {
                    kind: 'message' as const,
                    id: assistantId,
                    role: 'assistant' as const,
                    text: message,
                    streaming: false,
                    timestamp: new Date().toISOString(),
                  },
                ],
          };
        });
        socket.close();
        return;
      }

      updateTask(task.id, (current) => {
        let reply = '';
        let sawAssistant = false;
        let alreadyHasUsage = false;
        const currentAssistant =
          [...current.items]
            .reverse()
            .find(
              (item): item is Extract<ChatItem, { kind: 'message' }> =>
                item.kind === 'message' && item.role === 'assistant',
            ) || null;
        const assistantId = options.assistantId || currentAssistant?.id || `${task.id}:assistant:${Date.now()}`;
        const items = current.items.map((item) => {
          if (item.kind === 'usage') alreadyHasUsage = true;
          if (item.kind !== 'message' || item.id !== assistantId) return item;
          sawAssistant = true;
          reply = replaceVisible
            ? visible
            : appendVisibleDelta(item.text || '', visible);
          return {
            ...item,
            text: failed ? friendlyAgentMessage(reply || visible || text, 'bailian') : reply,
            streaming: !(done || failed),
          };
        });
        const nextItems = sawAssistant
          ? items
          : [
              ...items,
              {
                kind: 'message' as const,
                id: assistantId,
                role: 'assistant' as const,
                text: failed ? friendlyAgentMessage(visible || text, 'bailian') : visible,
                streaming: !(done || failed),
                timestamp: new Date().toISOString(),
              },
            ];
        const finalReply = String(
          (nextItems.find((item) => item.kind === 'message' && item.id === assistantId) as
            | Extract<ChatItem, { kind: 'message' }>
            | undefined)?.text || '',
        );
        return {
          ...current,
          output: taskOutput(current.prompt || task.prompt, finalReply, 'bailian'),
          status: failed ? 'failed' : done ? 'completed' : runningSignal ? 'running' : current.status,
          running: failed || done ? false : runningSignal ? true : current.running,
          connected: !(done || failed),
          updatedAt: new Date().toISOString(),
          items: [
            ...nextItems,
            ...((done || failed) && !alreadyHasUsage
              ? [
                  {
                    kind: 'usage' as const,
                    id: `${task.id}:usage:${Date.now()}`,
                    inputTokens: current.prompt.length,
                    outputTokens: finalReply.length,
                    timestamp: new Date().toISOString(),
                  },
                ]
              : []),
          ],
        };
      });

      if (done || failed) {
        completedSocketTaskIdsRef.current.add(task.id);
        awaitingRunStartRef.current.delete(task.id);
        replaceNextVisibleTextRef.current.delete(task.id);
        socket.close();
      }
    });

    socket.addEventListener('close', () => {
      if (socketsRef.current.get(task.id) !== socket) return;
      socketsRef.current.delete(task.id);
      socketActivityRef.current.delete(task.id);
      updateTask(task.id, (current) =>
        current.running && !completedSocketTaskIdsRef.current.has(task.id)
          ? {
              ...current,
              connected: false,
              updatedAt: new Date().toISOString(),
            }
          : { ...current, connected: false },
      );
    });
    socket.addEventListener('error', () => {
      updateTask(task.id, (current) => ({ ...current, connected: false, updatedAt: new Date().toISOString() }));
      try {
        socket.close();
      } catch {
        // Browser WebSocket close can fail if the socket is already closed.
      }
    });
  }, [connected, legacyServer, updateTask]);

  useEffect(() => {
    if ((agentName !== 'agy' && agentName !== 'bailian') || !connected || !legacyServer?.id) return;

    const refreshStaleStreams = () => {
      if (document.visibilityState && document.visibilityState !== 'visible') return;
      const now = Date.now();
      for (const task of tasksRef.current) {
        if (task.profileId !== legacyServer.id || task.status !== 'running' || !task.running) continue;
        const socket = socketsRef.current.get(task.id);
        const lastActivity = socketActivityRef.current.get(task.id) ?? 0;
        const socketIsStale =
          socket &&
          (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) &&
          now - lastActivity > AGENT_WS_STALE_RECONNECT_MS;
        if (socketIsStale) {
          try {
            socket.close();
          } catch {
            // Browser WebSocket close can fail if the socket is already closed.
          }
          socketsRef.current.delete(task.id);
          socketActivityRef.current.delete(task.id);
        }
        if (!socket || socketIsStale) {
          if (agentName === 'agy') {
            connectAgyTask(task);
          } else {
            connectBailianTask(task);
          }
        }
      }
    };

    window.addEventListener('focus', refreshStaleStreams);
    window.addEventListener('pageshow', refreshStaleStreams);
    document.addEventListener('visibilitychange', refreshStaleStreams);
    return () => {
      window.removeEventListener('focus', refreshStaleStreams);
      window.removeEventListener('pageshow', refreshStaleStreams);
      document.removeEventListener('visibilitychange', refreshStaleStreams);
    };
  }, [agentName, connectAgyTask, connectBailianTask, connected, legacyServer?.id]);

  useEffect(() => {
    if ((agentName !== 'agy' && agentName !== 'bailian') || !connected || !legacyServer?.id) return;

    tasksRef.current
      .filter(
        (task) =>
          task.profileId === legacyServer.id &&
          task.status === 'running' &&
          !socketsRef.current.has(task.id),
      )
      .forEach((task) => {
        if (agentName === 'agy') {
          connectAgyTask(task);
        } else {
          connectBailianTask(task);
        }
      });
  }, [agentName, connectAgyTask, connectBailianTask, connected, legacyServer?.id, tasks]);

  const handleKeyFile = async (file: File | undefined) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.txt')) {
      setHelperError('Key 檔案必須是 .txt。');
      return;
    }
    const text = (await file.text()).trim();
    const key = extractBailianRuntimeKey(text);
    if (!key) {
      setHelperError('Key 檔案是空的。');
      return;
    }
    if (key.length > MAX_KEY_TEXT_LENGTH) {
      setHelperError('Key 檔案太大，請確認只放 key 文字。');
      return;
    }
    setBailianKey(key);
    setBailianRuntimeKey(key);
    try {
      await syncLegacyBailianSessionKey(key);
      setHelperError('');
    } catch (error) {
      setHelperError(error instanceof Error ? error.message : 'Bailian key sync failed.');
    }
    if (keyInputRef.current) keyInputRef.current.value = '';
  };

  const sendPrompt = useCallback(async (
    text: string,
    options: { title?: string; remotePath?: string; forceNew?: boolean } = {},
  ): Promise<boolean> => {
    const prompt = text.trim();
    if (!prompt || !legacyServer || checking) return false;
    if (!connected) {
      setHelperError(`Press Connect before running ${config.label}.`);
      return false;
    }
    const sendKey = [
      agentName,
      legacyServer.id,
      activeTask?.id || 'new',
      options.forceNew ? 'new' : 'continue',
      prompt,
    ].join('\u001f');
    const nowMs = Date.now();
    if (lastSendRef.current?.key === sendKey && nowMs - lastSendRef.current.at < 1200) {
      return false;
    }
    lastSendRef.current = { key: sendKey, at: nowMs };
    const canUseBailianApi = agentName === 'bailian' && Boolean(bailianKey.trim());
    if (status && !status.available && !canUseBailianApi) {
      setHelperError(
        friendlyAgentMessage(status.error || `這台 server 尚未偵測到 ${config.label} CLI。`, agentName),
      );
      return false;
    }

    const legacyServerId = legacyServer.id;
    setComposerText('');
    const remotePath = normalizeRemotePath(options.remotePath ?? cwdInput);
    const task =
      !options.forceNew && activeTask
        ? activeTask
        : {
            ...createTask(prompt, legacyServer, agentName, agentModel),
            title: options.title || titleFromPrompt(prompt, agentName),
          };
    const taskId = task.id;
    const now = new Date().toISOString();
    const bailianPromptForRun =
      agentName === 'bailian' && !options.forceNew && activeTask
        ? buildBailianConversationPrompt(activeTask.items, prompt)
        : prompt;
    const userItem: ChatItem = {
      kind: 'message',
      id: `${taskId}:user:${Date.now()}`,
      role: 'user',
      text: prompt,
      timestamp: now,
    };

    if (!options.forceNew && activeTask) {
      updateTask(taskId, (current) => ({
        ...current,
        prompt: [current.prompt, prompt].filter(Boolean).join('\n\n').slice(-12000),
        output: taskOutput(prompt, '', agentName),
        running: true,
        status: 'running',
        connected: false,
        remotePath,
        model: agentModel,
        updatedAt: now,
        items: [...current.items, userItem],
      }));
    } else {
      setTasks((current) =>
        [{ ...task, remotePath, model: agentModel, items: [userItem] }, ...current].slice(-MAX_TASKS),
      );
      setActiveTaskId(taskId);
    }

    const assistantId = `${taskId}:assistant:${Date.now()}`;
    const assistantItem: ChatItem = {
      kind: 'message',
      id: assistantId,
      role: 'assistant',
      text: '',
      streaming: true,
      timestamp: now,
    };
    updateTask(taskId, (current) => ({
      ...current,
      items: current.items.some((item) => item.kind === 'message' && item.id === assistantId)
        ? current.items
        : [...current.items, assistantItem],
    }));

    try {
      if (agentName === 'codex') {
        throw new Error('Codex uses the dedicated Agents / Codex streaming panel.');
      }
      if (agentName === 'agy') {
        completedSocketTaskIdsRef.current.delete(taskId);
        connectAgyTask(
          {
            ...task,
            remotePath,
            model: agentModel,
            status: 'running',
            running: true,
          },
          {
            prompt,
            remotePath,
            model: agentModel,
          },
          { assistantId },
        );
        return true;
      }
      if (agentName === 'bailian') {
        completedSocketTaskIdsRef.current.delete(taskId);
        connectBailianTask(
          {
            ...task,
            remotePath,
            model: agentModel,
            status: 'running',
            running: true,
          },
          {
            prompt: bailianPromptForRun,
            remotePath,
            model: agentModel,
            apiKey: bailianKey.trim(),
          },
          { assistantId },
        );
        return true;
      }
      socketsRef.current.get(taskId)?.close();
      completedSocketTaskIdsRef.current.delete(taskId);
      consumedVisibleTextRef.current.set(
        taskId,
        assistantVisibleTranscript((tasksRef.current.find((item) => item.id === taskId) || task).items),
      );
      const socket = openLegacyRemoteAgentStream();
      socketsRef.current.set(taskId, socket);
      socket.addEventListener('open', () => {
        updateTask(taskId, (current) => ({ ...current, connected: true }));
        socket.send(
          serializeLegacyRemoteAgentStreamPayload({
            agent: agentName,
            serverId: legacyServerId,
            prompt,
            remotePath,
            ...(supportsModel && agentModel ? { model: agentModel } : {}),
            ...(agentName === 'bailian' && bailianKey.trim() ? { apiKey: bailianKey.trim() } : {}),
          }),
        );
      });
      socket.addEventListener('message', (event) => {
        const text = String(event.data || '');
        const done = isAgentStreamDone(text, agentName);
        const failed = isAgentStreamFailed(text, agentName);
        const rawVisible = visibleAgentStreamText(text, agentName);
        const { delta: visible } = nextVisibleDelta(consumedVisibleTextRef.current, taskId, rawVisible);
        if (!visible.trim() && !done && !failed) return;
        updateTask(taskId, (current) => {
          let reply = '';
          let sawAssistant = false;
          let alreadyHasUsage = false;
          const items = current.items.map((item) => {
            if (item.kind === 'usage') alreadyHasUsage = true;
            if (item.kind !== 'message' || item.id !== assistantId) return item;
            sawAssistant = true;
            reply = appendVisibleDelta(item.text || '', visible);
            return {
              ...item,
              text: failed ? friendlyAgentMessage(reply || visible || text, agentName) : reply,
              streaming: !(done || failed),
            };
          });
          const nextItems = sawAssistant ? items : [...items, { ...assistantItem, text: visible, streaming: !(done || failed) }];
          const finalReply = String(
            (nextItems.find((item) => item.kind === 'message' && item.id === assistantId) as
              | Extract<ChatItem, { kind: 'message' }>
              | undefined)?.text || '',
          );
          return {
            ...current,
            output: taskOutput(prompt, finalReply, agentName),
            status: failed ? 'failed' : done ? 'completed' : 'running',
            running: done || failed ? false : true,
            connected: !(done || failed),
            updatedAt: new Date().toISOString(),
            items: [
              ...nextItems,
              ...((done || failed) && !alreadyHasUsage
                ? [
                    {
                      kind: 'usage' as const,
                      id: `${taskId}:usage:${Date.now()}`,
                      inputTokens: prompt.length,
                      outputTokens: finalReply.length,
                      timestamp: new Date().toISOString(),
                    },
                  ]
                : []),
            ],
          };
        });
        if (done || failed) {
          completedSocketTaskIdsRef.current.add(taskId);
          socket.close();
        }
      });
      socket.addEventListener('close', () => {
        if (socketsRef.current.get(taskId) === socket) {
          socketsRef.current.delete(taskId);
        }
        updateTask(taskId, (current) =>
          current.running && !completedSocketTaskIdsRef.current.has(taskId)
            ? {
                ...current,
                status: 'failed',
                running: false,
                connected: false,
                updatedAt: new Date().toISOString(),
              }
            : { ...current, connected: false },
        );
      });
      socket.addEventListener('error', () => {
        updateTask(taskId, (current) => ({ ...current, connected: false, updatedAt: new Date().toISOString() }));
      });
      return true;
    } catch (error) {
      const message = friendlyAgentMessage(
        error instanceof Error ? error.message : `${config.label} 執行失敗`,
        agentName,
      );
      updateTask(taskId, (current) => ({
        ...current,
        output: taskOutput(prompt, message, agentName),
        status: 'failed',
        running: false,
        connected: false,
        updatedAt: new Date().toISOString(),
        items: [
          ...current.items,
          {
            kind: 'message',
            id: `${taskId}:assistant-error:${Date.now()}`,
            role: 'assistant',
            text: `**Remote ${config.label}**\n\n${message}`,
            timestamp: new Date().toISOString(),
          },
        ],
      }));
      return false;
    }
  }, [
    activeTask,
    agentName,
    agentModel,
    bailianKey,
    checking,
    config,
    connectAgyTask,
    connectBailianTask,
    connected,
    cwdInput,
    legacyServer,
    status,
    supportsModel,
    updateTask,
  ]);

  const drainQueuedTrainingTasks = useCallback(async () => {
    if (
       drainingTrainingQueueRef.current ||
       !legacyServer?.id ||
       !connected
    ) {
      return;
    }
    if (activeTask?.running || checking) return;

    const queuedTasks = takeQueuedCodexTrainingTasks(
      (task) =>
        task.agent === agentName &&
        (!task.serverId || task.serverId === legacyServer.id) &&
        isQueuedStartTrainingTask(task),
    );
    if (queuedTasks.length === 0) return;
    const sortedTasks = [...queuedTasks].sort(
      (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
    );
    const task = sortedTasks[sortedTasks.length - 1];
    if (!task) return;

    drainingTrainingQueueRef.current = true;
    try {
      await sendPrompt(task.prompt, {
        title: task.title || 'Start Training',
        remotePath: task.remotePath,
        forceNew: true,
      });
    } finally {
      drainingTrainingQueueRef.current = false;
    }
  }, [activeTask?.running, agentName, checking, connected, legacyServer?.id, sendPrompt]);

  useEffect(() => {
    void drainQueuedTrainingTasks();
    return subscribeCodexTrainingTasks((detail) => {
      const queuedAgent = (detail?.task as { agent?: string } | undefined)?.agent;
      if (!queuedAgent || queuedAgent === agentName) void drainQueuedTrainingTasks();
    });
  }, [drainQueuedTrainingTasks]);

  const removeTask = (taskId: string) => {
    socketsRef.current.get(taskId)?.close();
    socketsRef.current.delete(taskId);
    completedSocketTaskIdsRef.current.delete(taskId);
    replaceNextVisibleTextRef.current.delete(taskId);
    awaitingRunStartRef.current.delete(taskId);
    consumedVisibleTextRef.current.delete(taskId);
    markWorkRunDeleted(`${agentName}:${taskId}`);
    setTasks((current) => current.filter((task) => task.id !== taskId));
    if (activeTaskId === taskId) {
      const next = tasks.find((task) => task.id !== taskId);
      setActiveTaskId(next?.id ?? '');
    }
  };

  const stopActiveTask = async () => {
    if (!activeTask || !legacyServer?.id || !activeTask.running || stoppingTaskId) return;
    const taskId = activeTask.id;
    setStoppingTaskId(taskId);
    completedSocketTaskIdsRef.current.add(taskId);
    replaceNextVisibleTextRef.current.delete(taskId);
    awaitingRunStartRef.current.delete(taskId);

    try {
      const result = await stopLegacyAgentLatestTask({
        agent: agentName,
        serverId: legacyServer.id,
        taskId,
      });
      const message = result.stopped
        ? 'Stopped by user.'
        : result.message || `No running ${config.label} task was found.`;
      const now = new Date().toISOString();
      updateTask(taskId, (task) => ({
        ...task,
        status: 'failed',
        running: false,
        connected: false,
        output: taskOutput(task.prompt, message, agentName),
        updatedAt: now,
        items: [
          ...task.items.map((item) =>
            item.kind === 'message' && item.role === 'assistant' && item.streaming
              ? { ...item, streaming: false }
              : item,
          ),
          {
            kind: 'message',
            id: `${taskId}:assistant-stop:${Date.now()}`,
            role: 'assistant',
            text: `**Remote ${config.label}**\n\n${message}`,
            timestamp: now,
          },
        ],
      }));
      socketsRef.current.get(taskId)?.close();
      socketsRef.current.delete(taskId);
    } catch (error) {
      setHelperError(friendlyAgentMessage(error instanceof Error ? error.message : `${config.label} stop failed`, agentName));
    } finally {
      setStoppingTaskId('');
    }
  };

  const submitEditedUserMessage = async (nextText: string) => {
    const edit = editingUserMessage;
    const task = activeTask;
    if (!edit || !task || edit.taskId !== task.id) {
      setEditingUserMessage(null);
      return;
    }

    const rerunTitle = task.title || titleFromPrompt(nextText, agentName);
    const rerunPath = task.remotePath || cwdInput || '~';
    if (task.running) {
      await stopActiveTask();
    }

    updateTask(task.id, (current) => ({
      ...current,
      prompt: nextText,
      items: current.items.map((item) =>
        item.kind === 'message' && item.id === edit.messageId && item.role === 'user'
          ? { ...item, text: nextText }
          : item,
      ),
      updatedAt: new Date().toISOString(),
    }));
    setEditingUserMessage(null);
    await sendPrompt(nextText, {
      title: rerunTitle,
      remotePath: rerunPath,
      forceNew: true,
    });
  };

  const applyCwdInput = () => {
    const nextPath = normalizeRemotePath(cwdInput);
    setCwdInput(nextPath);
    if (activeTask) {
      updateTask(activeTask.id, (task) => ({
        ...task,
        remotePath: nextPath,
        updatedAt: new Date().toISOString(),
      }));
    }
  };

  const available = Boolean(
    legacyServer && (status?.available || (agentName === 'bailian' && bailianKey.trim())),
  );
  const hasChecked = Boolean(status || helperError);
  const localMode = isLocalLegacyServer(legacyServer);
  const modeLabel = status?.transport === 'terminal' ? 'terminal bridge' : localMode ? 'local mode' : 'server mode';

  return (
    <div className="legacy-codex-panel">
      <header className="legacy-codex-head">
        <div>
          <h2>{config.title}</h2>
          <span>
            {legacyServer
              ? `${localMode ? 'Local' : 'Remote'} ${config.label} on ${legacyServer.name}`
              : '請先選擇 SSH server'}
          </span>
        </div>
        <div className="legacy-codex-actions">
          {agentName === 'bailian' ? (
            <>
              <input
                ref={keyInputRef}
                type="file"
                accept=".txt,text/plain"
                hidden
                onChange={(event) => void handleKeyFile(event.currentTarget.files?.[0])}
              />
              <button type="button" onClick={() => keyInputRef.current?.click()}>
                新增 key
              </button>
              {bailianKey ? (
                <button type="button" onClick={() => {
                  setBailianKey('');
                  clearBailianRuntimeKey();
                  void clearLegacyBailianSessionKey().catch(() => undefined);
                }}>
                  清除 key
                </button>
              ) : null}
            </>
          ) : null}
          <button type="button" onClick={checkAgent} disabled={!connected || !legacyServer || checking}>
            {checking ? 'Checking...' : `檢查 ${config.label}`}
          </button>
          {supportsModel ? <span className="chip chip-ready">{agentModel || 'default'}</span> : null}
          <span className={`chip chip-${available ? 'ready' : 'disconnected'}`}>
            {available ? modeLabel : hasChecked ? 'no service' : 'unchecked'}
          </span>
        </div>
      </header>

      {!legacyServer ? (
        <div className="legacy-codex-alert">
          <strong>請先選擇 SSH server</strong>
          <span>{config.title} 會在選取的伺服器上執行。</span>
        </div>
      ) : null}

      {legacyServer && !connected ? (
        <div className="legacy-codex-alert">
          <strong>Connect required</strong>
          <span>Press Connect before checking or running {config.label}; no SSH starts while disconnected.</span>
        </div>
      ) : null}

      {legacyServer && connected && hasChecked && !available ? (
        <div className="legacy-codex-alert">
          <strong>{localMode ? `Local ${config.label}` : `Remote ${config.label}`}</strong>
          <span>
            {checking
              ? `正在檢查 ${config.label} CLI...`
              : friendlyAgentMessage(status?.error || helperError || `${config.label} CLI not found`, agentName)}
          </span>
        </div>
      ) : null}

      <div className="agent-panes legacy-codex-panes">
        <aside className="session-sidebar legacy-codex-sidebar">
          <input
            className="session-filter"
            placeholder={`搜尋 ${config.label} 工作...`}
            value={taskFilter}
            onChange={(event) => setTaskFilter(event.target.value)}
          />
          <div className="session-list">
            {visibleTasks.map((task) => (
              <div
                className={`session-item legacy-codex-session-item${
                  task.id === activeTask?.id ? ' session-item-active' : ''
                }`}
                key={task.id}
              >
                <button
                  type="button"
                  onClick={() => {
                    setActiveTaskId(task.id);
                    setCwdInput(task.remotePath || '~');
                  }}
                >
                  <span className="session-title">{task.title}</span>
                  <span className="session-meta">
                    {task.profileName} · {task.remotePath || '~'}
                  </span>
                  <span className="session-footer">
                    <span className={`chip chip-${task.running ? 'running' : task.status}`}>
                      {task.running ? 'running' : task.status}
                    </span>
                    <span className="session-time">
                      {new Date(task.updatedAt).toLocaleTimeString('zh-TW', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </span>
                </button>
                <button type="button" onClick={() => removeTask(task.id)} title="刪除工作">
                  x
                </button>
              </div>
            ))}
            {visibleTasks.length === 0 ? (
              <p className="hint session-empty">尚無 {config.label} 工作。</p>
            ) : null}
          </div>
          <button
            className="session-new"
            type="button"
            onClick={() => setActiveTaskId('')}
            disabled={!connected || !legacyServer || checking}
          >
            + 新工作
          </button>
        </aside>

        <section className="chat-column legacy-codex-output">
          {activeTask ? (
            <>
              <div className="legacy-codex-task-head">
                <div>
                  <strong>{activeTask.title}</strong>
                  <span>
                    {activeTask.profileName}
                    {activeTask.serverTarget ? ` · ${activeTask.serverTarget}` : ''} ·{' '}
                    {activeTask.remotePath || '~'} · {activeTask.running ? 'running' : 'saved'}
                  </span>
                </div>
                {activeTask.running ? (
                  <button
                    type="button"
                    className="danger"
                    onClick={() => void stopActiveTask()}
                    disabled={stoppingTaskId === activeTask.id}
                  >
                    {stoppingTaskId === activeTask.id ? 'Stopping...' : 'Stop'}
                  </button>
                ) : null}
              </div>
              <ChatTimeline
                sessionId={activeTask.id}
                items={activeTask.items}
                assistantLabel={config.label}
                serverId={activeTask.profileId || legacyServer?.id || ''}
                onOpenFilesPath={onOpenFilesPath}
                onEditUserMessage={(message) =>
                  setEditingUserMessage({
                    taskId: activeTask.id,
                    messageId: message.id,
                    text: message.text,
                  })
                }
                onResolveApproval={() => undefined}
                onAnswerQuestion={() => undefined}
              />
            </>
          ) : (
            <div className="placeholder">
              <p>
                {legacyServer
                  ? `輸入 prompt 建立新的 ${config.label} 工作。`
                  : '請先選擇 SSH server。'}
              </p>
            </div>
          )}
          <ChatComposer
            agentLabel={config.label}
            value={composerText}
            commands={commonAgentSlashCommands}
            disabled={!connected || !legacyServer || checking}
            placeholder={`Message ${config.label}...（Enter 送出）`}
            onChange={setComposerText}
            onSend={(value) => void sendPrompt(value)}
          />
        </section>

        <aside className="context-panel legacy-codex-context">
          <h3>Context</h3>
          <dl>
            <dt>Agent</dt>
            <dd>{config.title}</dd>
            <dt>Mode</dt>
            <dd>{localMode ? 'local machine' : 'remote SSH server'}</dd>
            <dt>Server</dt>
            <dd>{legacyServer?.name || '-'}</dd>
            <dt>Target</dt>
            <dd>{serverTarget || '-'}</dd>
            <dt>cwd</dt>
            <dd className="legacy-codex-cwd-cell">
              <input
                className="legacy-codex-cwd-input"
                value={cwdInput}
                onChange={(event) => setCwdInput(event.target.value)}
                onBlur={applyCwdInput}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') applyCwdInput();
                }}
              />
              <button
                type="button"
                className="legacy-codex-cwd-open"
                disabled={!legacyServer?.id || !cwdInput.trim()}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  const path = cwdInput.trim();
                  if (!legacyServer?.id || !path) return;
                  onOpenFilesPath?.({ serverId: legacyServer.id, path });
                }}
              >
                File
              </button>
            </dd>
            <dt>Status</dt>
            <dd>
              <span className={`chip chip-${available ? 'ready' : 'disconnected'}`}>
                {available ? 'ready' : hasChecked ? 'missing' : 'unchecked'}
              </span>
            </dd>
            <dt>CLI</dt>
            <dd className="mono">{status?.version || status?.path || '-'}</dd>
            {agentName === 'bailian' ? (
              <>
                <dt>Key</dt>
                <dd>{bailianKey ? 'loaded' : 'not loaded'}</dd>
              </>
            ) : null}
          </dl>
          {supportsModel ? (
            <>
              <h3>Runtime</h3>
              <div className="legacy-codex-settings">
                <label className="legacy-codex-setting">
                  <span>Model</span>
                  <select
                    value={agentModelInput}
                    onChange={(event) => setAgentModelInput(event.target.value)}
                  >
                    <option value="">default</option>
                    {agentModelOptions.map((model) => (
                      <option value={model} key={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </>
          ) : null}
          <h3>Workflow</h3>
          <p className="hint">
            {config.label} prompt 會送到選取的 server 執行，工作紀錄會顯示在 Work。
          </p>
        </aside>
      </div>
      {editingUserMessage ? (
        <EditSentMessageDialog
          agentLabel={config.label}
          initialText={editingUserMessage.text}
          running={Boolean(activeTask?.running)}
          onCancel={() => setEditingUserMessage(null)}
          onSubmit={submitEditedUserMessage}
        />
      ) : null}
    </div>
  );
}
