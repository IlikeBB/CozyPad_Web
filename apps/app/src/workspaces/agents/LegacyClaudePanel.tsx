import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChatItem } from '@cozypad/contracts';
import { useRef } from 'react';
import { ChatComposer } from './ChatComposer';
import { ChatTimeline } from './ChatTimeline';
import {
  getLegacyClaudeStatus,
  openLegacyClaudeSession,
  resetLegacyRemoteAgentCooldown,
  serializeLegacyRemoteAgentStreamPayload,
  stopLegacyAgentLatestTask,
  type LegacyClaudeStatus,
  type LegacySshServer,
} from './legacySshApi';
import {
  isQueuedStartTrainingTask,
  subscribeCodexTrainingTasks,
  takeQueuedCodexTrainingTasks,
} from './codexTaskQueue';
import { isWorkRunDeleted, markWorkRunDeleted } from '../workRuns';
import { userStorage } from '../../platform/userStorage';

const STORAGE_KEY = 'cozypad3.legacyClaudeTasks.v1';
const CLAUDE_MODEL_STORAGE_KEY = 'cozypad3.remoteClaude.model.v1';
const WORK_REFRESH_EVENT = 'cozypad-research-runs-updated';
const MAX_TASKS = 24;
const MAX_OUTPUT_LENGTH = 120_000;
const CLAUDE_WS_STALE_RECONNECT_MS = 90_000;
const CLAUDE_MODEL_FALLBACKS = [
  'opus',
  'sonnet',
  'haiku',
  'fable',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-5',
  'claude-3-5-haiku',
];

type ClaudeTaskStatus = 'completed' | 'running' | 'failed';

type ClaudeTask = {
  id: string;
  title: string;
  prompt: string;
  output: string;
  status: ClaudeTaskStatus;
  running: boolean;
  connected: boolean;
  profileId: string;
  profileName: string;
  serverTarget: string;
  remotePath: string;
  allowedDirs: string[];
  model: string;
  createdAt: string;
  updatedAt: string;
  items: ChatItem[];
};

function createTaskId(): string {
  if (window.crypto?.randomUUID) return `claude:${window.crypto.randomUUID()}`;
  return `claude:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function titleFromPrompt(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim().slice(0, 32) || 'Claude 工作';
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

function normalizeAllowedDir(value: string): string {
  const dir = value.trim().slice(0, 240);
  if (!dir || dir === '~') return '';
  if (!dir.startsWith('/') && !dir.startsWith('~/')) return '';
  if (/[\r\n\0]/.test(dir)) return '';
  return dir;
}

function mergeAllowedDirs(...sources: Array<string[] | string | undefined>): string[] {
  const dirs: string[] = [];
  const add = (value: string | undefined) => {
    const dir = normalizeAllowedDir(value || '');
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  };
  for (const source of sources) {
    if (Array.isArray(source)) {
      source.forEach(add);
    } else {
      add(source);
    }
  }
  return dirs.slice(0, 12);
}

function normalizeAgentModel(value: string): string {
  const model = value.trim().slice(0, 80);
  return /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(model) ? model : '';
}

function readStoredAgentModel(storageKey: string): string {
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

function modelForQueuedClaudeTraining(model: string, status: LegacyClaudeStatus | null): string {
  const cleanModel = normalizeAgentModel(model);
  if (!cleanModel) return '';
  const lower = cleanModel.toLowerCase();
  if (lower === 'opus' || lower === 'sonnet' || lower === 'haiku' || lower === 'fable') {
    return cleanModel;
  }
  if (!status?.available || status.transport === 'terminal') return '';
  const statusModels = status.models ?? [];
  const statusDefault = normalizeAgentModel(status.defaultModel || '');
  const isKnownModel =
    statusDefault.toLowerCase() === lower ||
    statusModels.some((candidate) => normalizeAgentModel(String(candidate || '')).toLowerCase() === lower);
  return isKnownModel ? cleanModel : '';
}

function parseAddDirCommand(value: string): string {
  const match = value.trim().match(/^\/add-dir\s+(.+)$/i);
  if (!match?.[1]) return '';
  return normalizeAllowedDir(match[1].replace(/^["']|["']$/g, ''));
}

function extractAllowedDirFromApproval(item: Extract<ChatItem, { kind: 'approval' }>): string {
  const fromCommand = item.command.match(/(\/[^\s，。；、)]+)/)?.[1] || '';
  const fromRisk = item.riskSummary.match(/(\/[^\s，。；、)]+)/)?.[1] || '';
  return normalizeAllowedDir(fromCommand || fromRisk);
}

function normalizeStatus(value: unknown, running: unknown): ClaudeTaskStatus {
  if (value === 'completed' || value === 'running' || value === 'failed') return value;
  return running ? 'running' : 'completed';
}

function sanitizeClaudeChatItem(item: unknown): ChatItem | null {
  if (!item || typeof item !== 'object') return null;
  const next = { ...(item as Record<string, unknown>) };
  if (typeof next.text === 'string') {
    const friendly = friendlyClaudeMessage(next.text);
    if (friendly !== next.text) {
      next.text = next.text.includes('Remote Claude') ? `**Remote Claude**\n\n${friendly}` : friendly;
    }
  }
  return next as ChatItem;
}

function claudeTaskDedupeKey(task: ClaudeTask): string {
  return [
    task.title.trim(),
    task.prompt.trim(),
    task.profileId,
    task.serverTarget,
    task.remotePath,
    task.model,
  ].join('\u001f');
}

function dedupeClaudeTasks(tasks: ClaudeTask[]): ClaudeTask[] {
  const seen = new Set<string>();
  return tasks.filter((task) => {
    const key = claudeTaskDedupeKey(task);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readStoredTasks(): ClaudeTask[] {
  try {
    const raw = userStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    const tasks = parsed
      .filter((task) => task && typeof task.id === 'string')
      .filter((task) => !isWorkRunDeleted(`claude:${String(task.id)}`))
      .map((task) => {
        const status = normalizeStatus(task.status, task.running);
        const items = Array.isArray(task.items) ? task.items.map(sanitizeClaudeChatItem).filter(Boolean) : [];
        return {
          id: String(task.id),
          title: String(task.title || 'Claude 工作'),
          prompt: String(task.prompt || ''),
          output: String(task.output || '').slice(-MAX_OUTPUT_LENGTH),
          status,
          running: status === 'running',
          connected: false,
          profileId: String(task.profileId || ''),
          profileName: String(task.profileName || '未綁 SSH'),
          serverTarget: String(task.serverTarget || ''),
          remotePath: String(task.remotePath || '~'),
          allowedDirs: mergeAllowedDirs(
            Array.isArray(task.allowedDirs) ? task.allowedDirs.map(String) : [],
            String(task.remotePath || ''),
          ),
          model: normalizeAgentModel(String(task.model || '')),
          createdAt: String(task.createdAt || new Date().toISOString()),
          updatedAt: String(task.updatedAt || task.createdAt || new Date().toISOString()),
          items: items as ChatItem[],
        };
      });
    return dedupeClaudeTasks(tasks).slice(0, MAX_TASKS);
  } catch {
    return [];
  }
}

function writeStoredTasks(tasks: ClaudeTask[]): void {
  try {
    const serializable = dedupeClaudeTasks(tasks).slice(0, MAX_TASKS).map((task) => ({
      ...task,
      connected: false,
      running: task.running,
      status: task.running ? 'running' : task.status,
      output: task.output.slice(-MAX_OUTPUT_LENGTH),
    }));
    userStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
    window.dispatchEvent(new Event(WORK_REFRESH_EVENT));
  } catch {
    // Browser storage is best-effort.
  }
}

function taskOutput(prompt: string, reply: string): string {
  return [`[CozyPad User]`, prompt, `[CozyPad Claude]`, reply].join('\n');
}

function detectClaudeApprovalRequest(reply: string, cwd: string): Extract<ChatItem, { kind: 'approval' }> | null {
  const text = reply.trim();
  if (!text) return null;

  const lower = text.toLowerCase();
  const asksForDecision =
    /需要我.+嗎[？?]?/.test(text) ||
    /要我.+嗎[？?]?/.test(text) ||
    text.includes('是否允許') ||
    text.includes('請允許') ||
    lower.includes('allow') ||
    lower.includes('deny') ||
    lower.includes('approval');
  const permissionContext =
    text.includes('/add-dir') ||
    lower.includes('additionaldirectories') ||
    lower.includes('settings.json') ||
    text.includes('允許工作目錄') ||
    text.includes('權限') ||
    text.includes('核准') ||
    text.includes('授權');

  if (!asksForDecision || !permissionContext) return null;

  const addDirMatch = text.match(/\/add-dir\s+([^\s`，。；、)]+)/);
  const additionalDirMatch = text.match(/additionalDirectories[\s\S]*?["'`](\/[^"'`\]\s]+)["'`]/i);
  const targetPath = addDirMatch?.[1] || additionalDirMatch?.[1] || '';
  const command = targetPath
    ? `允許 Claude 存取 ${targetPath}`
    : text.includes('settings.json')
      ? '更新 Claude settings.json 權限設定'
      : '允許 Claude 繼續執行需要核准的操作';

  return {
    kind: 'approval',
    id: `claude-approval:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
    command,
    cwd: cwd || '~',
    riskSummary: targetPath ? `新增可存取目錄：${targetPath}` : 'Claude 要求使用者確認後才繼續。',
    resolution: 'pending',
    timestamp: new Date().toISOString(),
  };
}

function friendlyClaudeMessage(value: string): string {
  const text = value.trim();
  const lower = text.toLowerCase();
  if (!text) return '';
  if (lower.includes('paused after a transport failure')) {
    const seconds = /after\s+(\d+)s/i.exec(text)?.[1] ?? '一段時間';
    return `遠端 Claude SSH 連線因 transport failure 已暫停，CozyPad 不會自動重試。可等待 ${seconds} 秒後再試，或按「解除暫停並檢查」手動重試。`;
  }
  if (
    lower.includes('connection closed by') ||
    lower.includes('connection reset') ||
    lower.includes('kex_exchange_identification') ||
    lower.includes('getsockname failed') ||
    lower.includes('not a socket') ||
    lower.includes('read from remote host')
  ) {
    return '遠端 SSH 連線在 Claude 啟動前被關閉；CozyPad 已停止本次執行且不會自動重試。請稍後再試，或先確認該 server 沒有限制新的 SSH 連線。';
  }
  if (lower.includes('__cozypad_claude_missing__') || lower.includes('remote claude cli not found')) {
    return '這台 server 尚未偵測到 Claude CLI。請在遠端安裝 Claude 後再執行。';
  }
  return text;
}

function isClaudeStreamDone(value: string): boolean {
  return value.toLowerCase().includes('[cozypad] remote claude ready');
}

function isClaudeStreamFailed(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.includes('[cozypad] remote claude failed') ||
    lower.includes('[cozypad] remote claude exited with code') ||
    lower.includes('[cozypad] remote agent failed')
  );
}

function isClaudeStreamRunningSignal(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.includes('[cozypad] remote claude is still running') ||
    lower.includes('[cozypad] remote claude queued follow-up') ||
    lower.includes('[cozypad] remote claude running queued follow-up') ||
    lower.includes('another remote claude task is already running')
  );
}

function visibleClaudeStreamText(value: string): string {
  return value
    .split(/\r?\n/)
    .filter((line) => {
      const lower = line.trim().toLowerCase();
      return (
        lower &&
        lower !== '[cozypad] remote agent stream ready' &&
        !lower.startsWith('[cozypad] remote claude attached') &&
        lower !== '[cozypad] remote claude starting' &&
        lower !== '[cozypad] remote claude heartbeat' &&
        !lower.startsWith('[cozypad] remote claude queued follow-up') &&
        !lower.startsWith('[cozypad] remote claude running queued follow-up') &&
        !lower.startsWith('[cozypad] remote claude is still running') &&
        !lower.includes('another remote claude task is already running') &&
        !lower.startsWith('[cozypad] remote claude ready')
      );
    })
    .join('\n');
}

function buildClaudeAssistantItems(taskId: string, reply: string, cwd: string): ChatItem[] {
  const timestamp = new Date().toISOString();
  const items: ChatItem[] = [
    {
      kind: 'message',
      id: `${taskId}:assistant:${Date.now()}`,
      role: 'assistant',
      text: reply,
      timestamp,
    },
  ];
  const approval = detectClaudeApprovalRequest(reply, cwd);
  if (approval) items.push(approval);
  return items;
}

function buildApprovalResolutionMessage(
  item: Extract<ChatItem, { kind: 'approval' }>,
  resolution: 'allowed' | 'denied',
): string {
  if (resolution === 'allowed') {
    const approvedDir = extractAllowedDirFromApproval(item);
    return approvedDir
      ? `已允許 Claude 存取 \`${approvedDir}\`。下一次執行會帶入這個允許目錄。`
      : '已允許這個 Claude 操作。下一次執行會套用目前核准狀態。';
  }

  return `已拒絕：${item.command}`;
}

function createTask(prompt: string, server: LegacySshServer, model = ''): ClaudeTask {
  const now = new Date().toISOString();
  const id = createTaskId();
  return {
    id,
    title: titleFromPrompt(prompt),
    prompt,
    output: taskOutput(prompt, ''),
    status: 'running',
    running: true,
    connected: false,
    profileId: server.id,
    profileName: server.name,
    serverTarget: legacyServerTarget(server),
    remotePath: server.defaultPath || '~',
    allowedDirs: mergeAllowedDirs(server.defaultPath || '~'),
    model: normalizeAgentModel(model),
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

export function LegacyClaudePanel({
  legacyServer,
  connected = false,
  focusTaskId = '',
  focusRequestNonce = 0,
  onOpenFilesPath,
}: {
  legacyServer: LegacySshServer | null;
  connected?: boolean;
  focusTaskId?: string;
  focusRequestNonce?: number;
  onOpenFilesPath?: (target: { serverId: string; path: string }) => void;
}) {
  const [tasks, setTasks] = useState<ClaudeTask[]>(() => readStoredTasks());
  const [activeTaskId, setActiveTaskId] = useState(() => readStoredTasks()[0]?.id ?? '');
  const [taskFilter, setTaskFilter] = useState('');
  const [composerText, setComposerText] = useState('');
  const [cwdInput, setCwdInput] = useState('~');
  const [status, setStatus] = useState<LegacyClaudeStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [helperError, setHelperError] = useState('');
  const [stoppingTaskId, setStoppingTaskId] = useState('');
  const [claudeModelInput, setClaudeModelInput] = useState(() =>
    readStoredAgentModel(CLAUDE_MODEL_STORAGE_KEY),
  );
  const tasksRef = useRef<ClaudeTask[]>(tasks);
  const socketsRef = useRef(new Map<string, WebSocket>());
  const socketActivityRef = useRef(new Map<string, number>());
  const completedSocketTaskIdsRef = useRef(new Set<string>());
  const replaceNextVisibleTextRef = useRef(new Set<string>());
  const awaitingRunStartRef = useRef(new Set<string>());
  const drainingTrainingQueueRef = useMemo(() => ({ current: false }), []);

  const serverTarget = legacyServerTarget(legacyServer);
  const activeTask = tasks.find((task) => task.id === activeTaskId) ?? null;
  const claudeModel = normalizeAgentModel(claudeModelInput);
  const claudeModelOptions = useMemo(
    () =>
      mergeAgentModelOptions(
        [status?.defaultModel, claudeModelInput, activeTask?.model],
        status?.models,
        CLAUDE_MODEL_FALLBACKS,
      ),
    [activeTask?.model, claudeModelInput, status?.defaultModel, status?.models],
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
    writeStoredTasks(tasks);
    tasksRef.current = tasks;
  }, [tasks]);

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
    },
    [],
  );

  useEffect(() => {
    try {
      userStorage.setItem(CLAUDE_MODEL_STORAGE_KEY, claudeModel);
    } catch {
      // Browser storage is best-effort.
    }
  }, [claudeModel]);

  const checkClaude = useCallback(() => {
    if (!legacyServer) {
      setStatus(null);
      setHelperError('');
      return;
    }
    if (!connected) {
      setStatus(null);
      setHelperError('Press Connect before checking Claude.');
      return;
    }
    setChecking(true);
    setHelperError('');
    void getLegacyClaudeStatus(legacyServer.id)
      .then(setStatus)
      .catch((error) => {
        setStatus(null);
        setHelperError(friendlyClaudeMessage(error instanceof Error ? error.message : '遠端 Claude 檢查失敗'));
      })
      .finally(() => setChecking(false));
  }, [connected, legacyServer]);

  const resetClaudeCooldown = useCallback(() => {
    if (!legacyServer || !connected) return;
    setChecking(true);
    setHelperError('');
    void resetLegacyRemoteAgentCooldown('Claude', legacyServer.id)
      .then(() => getLegacyClaudeStatus(legacyServer.id))
      .then(setStatus)
      .catch((error) => {
        setStatus(null);
        setHelperError(friendlyClaudeMessage(error instanceof Error ? error.message : 'Remote Claude retry failed'));
      })
      .finally(() => setChecking(false));
  }, [connected, legacyServer]);

  useEffect(() => {
    setStatus(null);
    setHelperError('');
    setChecking(false);
  }, [connected, legacyServer?.id]);

  useEffect(() => {
    if (!legacyServer) return;
    const serverTasks = readStoredTasks().filter((task) => task.profileId === legacyServer.id);
    setTasks((current) => {
      const other = current.filter((task) => task.profileId !== legacyServer.id);
      return [...serverTasks, ...other].slice(-MAX_TASKS);
    });
    setActiveTaskId(serverTasks[0]?.id ?? '');
    setCwdInput(serverTasks[0]?.remotePath || legacyServer.defaultPath || '~');
  }, [legacyServer?.id]);

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

  const updateTask = useCallback((taskId: string, updater: (task: ClaudeTask) => ClaudeTask) => {
    setTasks((current) => current.map((task) => (task.id === taskId ? updater(task) : task)));
  }, []);

  const connectTask = useCallback((
    task: ClaudeTask,
    payload?: {
      prompt: string;
      remotePath: string;
      allowedDirs: string[];
      model: string;
    },
    options: { assistantId?: string } = {},
  ) => {
    if (!connected) {
      setHelperError('Press Connect before opening Claude SSH sessions.');
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
      if (payload && existing.readyState === WebSocket.OPEN) {
        awaitingRunStartRef.current.add(task.id);
        existing.send(
          serializeLegacyRemoteAgentStreamPayload({
            agent: 'claude',
            serverId: legacyServer.id,
            prompt: payload.prompt,
            remotePath: taskRemotePath,
            allowedDirs: payload.allowedDirs,
            model: payload.model,
          }),
        );
      }
      return;
    }
    existing?.close();

    if (payload) {
      awaitingRunStartRef.current.add(task.id);
    } else {
      replaceNextVisibleTextRef.current.add(task.id);
    }

    const socket = openLegacyClaudeSession({
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
          agent: 'claude',
          serverId: legacyServer.id,
          prompt: payload.prompt,
          remotePath: taskRemotePath,
          allowedDirs: payload.allowedDirs,
          model: payload.model,
        }),
      );
    });
    socket.addEventListener('message', (event) => {
      socketActivityRef.current.set(task.id, Date.now());
      const text = String(event.data || '');
      const lower = text.toLowerCase();
      const startSignal = lower.includes('[cozypad] remote claude starting');
      if (awaitingRunStartRef.current.has(task.id)) {
        if (startSignal) {
          awaitingRunStartRef.current.delete(task.id);
        } else if (!isClaudeStreamFailed(text)) {
          return;
        }
      }

      const done = isClaudeStreamDone(text);
      const failed = isClaudeStreamFailed(text);
      const runningSignal = startSignal || isClaudeStreamRunningSignal(text);
      const visible = visibleClaudeStreamText(text);
      if (!visible.trim() && !done && !failed && !runningSignal) return;
      if (!payload && done && !visible.trim() && replaceNextVisibleTextRef.current.has(task.id)) {
        replaceNextVisibleTextRef.current.delete(task.id);
        completedSocketTaskIdsRef.current.add(task.id);
        updateTask(task.id, (current) => {
          const message =
            'Claude session 已不在 CozyPad API 中。可能是 API 重啟或 SSH worker 已被關閉；請手動重新送出這個任務。';
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
            output: taskOutput(current.prompt || task.prompt, message),
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
        const replaceVisible = Boolean(visible && replaceNextVisibleTextRef.current.has(task.id));
        if (replaceVisible) {
          replaceNextVisibleTextRef.current.delete(task.id);
        }
        const items = current.items.map((item) => {
          if (item.kind === 'usage') alreadyHasUsage = true;
          if (item.kind !== 'message' || item.id !== assistantId) return item;
          sawAssistant = true;
          reply = replaceVisible
            ? visible
            : `${item.text || ''}${visible ? `${item.text ? '\n' : ''}${visible}` : ''}`.trim();
          return {
            ...item,
            text: failed ? friendlyClaudeMessage(reply || visible || text) : reply,
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
                text: failed ? friendlyClaudeMessage(visible || text) : visible,
                streaming: !(done || failed),
                timestamp: new Date().toISOString(),
              },
            ];
        const finalReply = String(
          (nextItems.find((item) => item.kind === 'message' && item.id === assistantId) as
            | Extract<ChatItem, { kind: 'message' }>
            | undefined)?.text || '',
        );
        const approval = done ? detectClaudeApprovalRequest(finalReply, current.remotePath || taskRemotePath) : null;
        return {
          ...current,
          output: taskOutput(current.prompt || task.prompt, finalReply),
          status: failed ? 'failed' : done ? 'completed' : runningSignal ? 'running' : current.status,
          running: failed || done ? false : runningSignal ? true : current.running,
          connected: !(done || failed),
          updatedAt: new Date().toISOString(),
          items: [
            ...nextItems,
            ...(approval ? [approval] : []),
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
    if (!connected || !legacyServer?.id) return;

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
          now - lastActivity > CLAUDE_WS_STALE_RECONNECT_MS;
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
          connectTask(task);
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
  }, [connectTask, connected, legacyServer?.id]);

  useEffect(() => {
    if (!connected || !legacyServer?.id) return;

    tasksRef.current
      .filter(
        (task) =>
          task.profileId === legacyServer.id &&
          task.status === 'running' &&
          !socketsRef.current.has(task.id),
      )
      .forEach((task) => connectTask(task));
  }, [connectTask, connected, legacyServer?.id, tasks]);

  const sendPrompt = useCallback(async (
    text: string,
    options: { title?: string; remotePath?: string; forceNew?: boolean; queuedTraining?: boolean } = {},
  ): Promise<boolean> => {
    const prompt = text.trim();
    if (!prompt || !legacyServer || checking) return false;
    if (!connected) {
      setHelperError('Press Connect before running Claude.');
      return false;
    }
    if (status && !status.available) {
      setHelperError(friendlyClaudeMessage(status.error || '這台 server 尚未偵測到 Claude CLI。'));
      return false;
    }

    setComposerText('');
    const runModel = options.queuedTraining ? modelForQueuedClaudeTraining(claudeModel, status) : claudeModel;
    const addDir = parseAddDirCommand(prompt);
    if (addDir) {
      const now = new Date().toISOString();
      const task =
        !options.forceNew && activeTask
          ? activeTask
          : {
              ...createTask(prompt, legacyServer, claudeModel),
              model: runModel,
              title: options.title || titleFromPrompt(prompt),
            };
      const taskId = task.id;
      const userItem: ChatItem = {
        kind: 'message',
        id: `${taskId}:user:${Date.now()}`,
        role: 'user',
        text: prompt,
        timestamp: now,
      };
      const assistantItem: ChatItem = {
        kind: 'message',
        id: `${taskId}:assistant:${Date.now()}`,
        role: 'assistant',
        text: `已加入 Claude 啟動允許目錄：\`${addDir}\`\n\n下一次執行會使用 \`claude --dangerously-skip-permissions --add-dir ${addDir}\`。`,
        timestamp: now,
      };
      setCwdInput(addDir);
      if (!options.forceNew && activeTask) {
        updateTask(taskId, (current) => ({
          ...current,
          prompt: [current.prompt, prompt].filter(Boolean).join('\n\n').slice(-12000),
          remotePath: addDir,
          allowedDirs: mergeAllowedDirs(current.allowedDirs, addDir),
          model: runModel,
          updatedAt: now,
          items: [...current.items, userItem, assistantItem],
        }));
      } else {
        const nextTask: ClaudeTask = {
          ...task,
          status: 'completed',
          running: false,
          remotePath: addDir,
          allowedDirs: mergeAllowedDirs(task.allowedDirs, addDir),
          model: runModel,
          output: taskOutput(prompt, assistantItem.text),
          updatedAt: now,
          items: [userItem, assistantItem],
        };
        setTasks((current) =>
          [nextTask, ...current].slice(-MAX_TASKS),
        );
        setActiveTaskId(taskId);
      }
      return true;
    }

    const remotePath = normalizeRemotePath(options.remotePath ?? cwdInput);
    const task =
      !options.forceNew && activeTask
        ? activeTask
        : {
            ...createTask(prompt, legacyServer, runModel),
            title: options.title || titleFromPrompt(prompt),
          };
    const allowedDirs = mergeAllowedDirs(task.allowedDirs, remotePath);
    const now = new Date().toISOString();
    const taskId = task.id;
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
        output: taskOutput(prompt, ''),
        running: true,
        status: 'running',
        connected: false,
        remotePath,
        allowedDirs,
        model: runModel,
        updatedAt: now,
        items: [...current.items, userItem],
      }));
    } else {
      setTasks((current) =>
        [{ ...task, remotePath, allowedDirs, model: runModel, items: [userItem] }, ...current].slice(
          -MAX_TASKS,
        ),
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
      completedSocketTaskIdsRef.current.delete(taskId);
      connectTask(
        {
          ...task,
          remotePath,
          allowedDirs,
          model: runModel,
          status: 'running',
          running: true,
        },
        {
          prompt,
          remotePath,
          allowedDirs,
          model: runModel,
        },
        { assistantId },
      );
      return true;
    } catch (error) {
      const message = friendlyClaudeMessage(error instanceof Error ? error.message : '遠端 Claude 執行失敗');
      updateTask(taskId, (current) => ({
        ...current,
        output: taskOutput(prompt, message),
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
            text: `**Remote Claude**\n\n${message}`,
            timestamp: new Date().toISOString(),
          },
        ],
      }));
      return false;
    }
  }, [activeTask, checking, claudeModel, connectTask, connected, cwdInput, legacyServer, status, updateTask]);

  const drainQueuedTrainingTasks = useCallback(async () => {
    if (drainingTrainingQueueRef.current || !connected || !legacyServer?.id || activeTask?.running || checking) {
      return;
    }
    if (status && !status.available) {
      setHelperError(friendlyClaudeMessage(status.error || '這台 server 尚未偵測到 Claude CLI。'));
      return;
    }

    const queuedTasks = takeQueuedCodexTrainingTasks(
      (task) =>
        task.agent === 'claude' &&
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
        queuedTraining: true,
      });
    } finally {
      drainingTrainingQueueRef.current = false;
    }
  }, [activeTask?.running, checking, connected, drainingTrainingQueueRef, legacyServer?.id, sendPrompt, status]);

  useEffect(() => {
    void drainQueuedTrainingTasks();
    return subscribeCodexTrainingTasks((detail) => {
      const queuedAgent = (detail?.task as { agent?: string } | undefined)?.agent;
      if (!queuedAgent || queuedAgent === 'claude') void drainQueuedTrainingTasks();
    });
  }, [drainQueuedTrainingTasks]);

  const resolveApproval = (itemId: string, resolution: 'allowed' | 'denied') => {
    if (!activeTask || activeTask.running) return;
    const approval = activeTask.items.find(
      (item): item is Extract<ChatItem, { kind: 'approval' }> =>
        item.kind === 'approval' && item.id === itemId,
    );
    if (!approval || approval.resolution !== 'pending') return;

    const approvedDir = resolution === 'allowed' ? extractAllowedDirFromApproval(approval) : '';
    if (approvedDir) setCwdInput(approvedDir);
    const now = new Date().toISOString();

    updateTask(activeTask.id, (task) => ({
      ...task,
      remotePath: approvedDir || task.remotePath,
      allowedDirs:
        resolution === 'allowed'
          ? mergeAllowedDirs(task.allowedDirs, approvedDir || undefined)
          : task.allowedDirs,
      items: task.items.map((item) =>
        item.kind === 'approval' && item.id === itemId ? { ...item, resolution } : item,
      ).concat({
        kind: 'message',
        id: `${activeTask.id}:approval-resolution:${Date.now()}`,
        role: 'assistant',
        text: buildApprovalResolutionMessage(approval, resolution),
        timestamp: now,
      }),
      updatedAt: now,
    }));
  };

  const removeTask = (taskId: string) => {
    socketsRef.current.get(taskId)?.close();
    socketsRef.current.delete(taskId);
    completedSocketTaskIdsRef.current.delete(taskId);
    replaceNextVisibleTextRef.current.delete(taskId);
    awaitingRunStartRef.current.delete(taskId);
    markWorkRunDeleted(`claude:${taskId}`);
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
        agent: 'claude',
        serverId: legacyServer.id,
        taskId,
      });
      const message = result.stopped
        ? 'Stopped by user.'
        : result.message || 'No running Claude task was found.';
      const now = new Date().toISOString();
      updateTask(taskId, (task) => ({
        ...task,
        status: 'failed',
        running: false,
        connected: false,
        output: taskOutput(task.prompt, message),
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
            text: `**Remote Claude**\n\n${message}`,
            timestamp: now,
          },
        ],
      }));
      socketsRef.current.get(taskId)?.close();
      socketsRef.current.delete(taskId);
    } catch (error) {
      setHelperError(friendlyClaudeMessage(error instanceof Error ? error.message : 'Remote Claude stop failed'));
    } finally {
      setStoppingTaskId('');
    }
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

  const available = Boolean(legacyServer && status?.available);
  const hasCheckedClaude = Boolean(status || helperError);
  const cooldownBlocked = /paused after a transport failure/i.test(
    `${status?.error || ''}\n${helperError}`,
  );
  const localMode = isLocalLegacyServer(legacyServer);
  const modeLabel = status?.transport === 'terminal' ? 'terminal bridge' : localMode ? 'local mode' : 'server mode';

  return (
    <div className="legacy-codex-panel">
      <header className="legacy-codex-head">
        <div>
          <h2>Claude CLI</h2>
          <span>{legacyServer ? `${localMode ? 'Local' : 'Remote'} Claude on ${legacyServer.name}` : '請先選擇 SSH server'}</span>
        </div>
        <div className="legacy-codex-actions">
          <button type="button" onClick={checkClaude} disabled={!connected || !legacyServer || checking}>
            {checking ? 'Checking...' : '檢查 Claude'}
          </button>
          <span className="chip chip-ready">{claudeModel || 'default'}</span>
          <span className={`chip chip-${available ? 'ready' : 'disconnected'}`}>
            {available ? modeLabel : hasCheckedClaude ? 'no service' : 'unchecked'}
          </span>
        </div>
      </header>

      {!legacyServer ? (
        <div className="legacy-codex-alert">
          <strong>請先選擇 SSH server</strong>
          <span>Claude CLI 會在選取的遠端伺服器上執行，不使用本機 Claude。</span>
        </div>
      ) : null}

      {legacyServer && !connected ? (
        <div className="legacy-codex-alert">
          <strong>Connect required</strong>
          <span>Press Connect before checking or running Claude; no SSH starts while disconnected.</span>
        </div>
      ) : null}

      {legacyServer && connected && hasCheckedClaude && !available ? (
        <div className="legacy-codex-alert">
          <strong>{localMode ? 'Local Claude' : 'Remote Claude'}</strong>
          <span>
            {checking
              ? '正在檢查遠端 Claude CLI...'
              : friendlyClaudeMessage(status?.error || helperError || '這台 server 上尚未偵測到 claude 指令。')}
          </span>
          {cooldownBlocked ? (
            <button type="button" onClick={resetClaudeCooldown} disabled={!connected || checking}>
              Reset pause & check
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="agent-panes legacy-codex-panes">
        <aside className="session-sidebar legacy-codex-sidebar">
          <input
            className="session-filter"
            placeholder="搜尋 Claude 工作..."
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
                <button type="button" onClick={() => removeTask(task.id)} title="移除工作">
                  x
                </button>
              </div>
            ))}
            {visibleTasks.length === 0 ? (
              <p className="hint session-empty">尚無符合的 Claude 工作。</p>
            ) : null}
          </div>
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
                <button type="button" onClick={() => setActiveTaskId('')}>
                  新工作
                </button>
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
                serverId={activeTask.profileId || legacyServer?.id || ''}
                onOpenFilesPath={onOpenFilesPath}
                onResolveApproval={resolveApproval}
                onAnswerQuestion={() => undefined}
              />
            </>
          ) : (
            <div className="placeholder">
              <p>
                {legacyServer
                  ? '輸入 prompt 建立新的 Claude 工作；也可以先手動檢查遠端 Claude CLI。'
                  : '請先選擇 SSH server。'}
              </p>
            </div>
          )}
          <ChatComposer
            agentLabel="Claude"
            value={composerText}
            commands={[]}
            disabled={!connected || !legacyServer || checking}
            placeholder="Message Claude...（Enter 送出，會在目前 SSH server 執行）"
            onChange={setComposerText}
            onSend={(text) => void sendPrompt(text)}
          />
        </section>

        <aside className="context-panel legacy-codex-context">
          <h3>Context</h3>
          <dl>
            <dt>Agent</dt>
            <dd>Claude CLI</dd>
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
            </dd>
            <dt>Status</dt>
            <dd>
              <span className={`chip chip-${available ? 'ready' : 'disconnected'}`}>
                {available ? 'ready' : hasCheckedClaude ? 'missing' : 'unchecked'}
              </span>
            </dd>
            <dt>CLI</dt>
            <dd className="mono">{status?.version || status?.path || '-'}</dd>
          </dl>
          <h3>Runtime</h3>
          <div className="legacy-codex-settings">
            <label className="legacy-codex-setting">
              <span>Model</span>
              <select
                value={claudeModelInput}
                onChange={(event) => setClaudeModelInput(event.target.value)}
              >
                <option value="">default</option>
                {claudeModelOptions.map((model) => (
                  <option value={model} key={model}>
                    {model}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <h3>Workflow</h3>
          <p className="hint">
            Claude prompt 會送到選取的遠端 server 執行，啟動時會帶
            {' '}
            <code>--dangerously-skip-permissions</code>，輸出會保存到 Work。
          </p>
        </aside>
      </div>
    </div>
  );
}

