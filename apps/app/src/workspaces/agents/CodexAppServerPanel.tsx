import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { ConnectionProfile } from '@cozypad/contracts';
import {
  createMarkdownComponents,
  linkifyRemotePathLines,
} from '../../components/markdownComponents';
import type { LegacySshServer } from './legacySshApi';
import {
  readCodexCwd,
  rememberCodexCwd,
  subscribeCodexCwd,
} from './codexCwdPreference';
import {
  CodexAppServerSocket,
  type CodexAppServerRequest,
  type CodexAppServerRuntimeStatus,
} from './codexAppServerClient';
import {
  EMPTY_CODEX_STRUCTURED_STATE,
  codexContextBudget,
  codexTokenUsageFrom,
  reduceCodexRuntimeEvent,
  structuredStateFromThread,
  type CodexStructuredState,
  type CodexThreadItem,
  type CodexThreadSummary,
  type CodexTokenUsage,
} from './codexAppServerState';

type ThreadListResponse = { data?: CodexThreadSummary[] };
type ThreadResponse = { thread?: CodexThreadSummary };
type ModelListResponse = {
  data?: Array<{ id?: string; model?: string; slug?: string }>;
};
type CollaborationMode = {
  mode: string;
  model?: string;
  settings?: Record<string, unknown>;
};
type CollaborationModeListResponse = { data?: CollaborationMode[] };
type ThreadGoal = {
  threadId: string;
  objective: string;
  status: string;
  tokenBudget?: number | null;
  tokensUsed?: number;
  timeUsedSeconds?: number;
};
type ThreadGoalResponse = { goal?: ThreadGoal | null };
type ReviewTargetType = 'uncommittedChanges' | 'baseBranch' | 'commit' | 'custom';
type ReviewTarget =
  | { type: 'uncommittedChanges' }
  | { type: 'baseBranch'; branch: string }
  | { type: 'commit'; sha: string; title: string | null }
  | { type: 'custom'; instructions: string };
type ReviewStartResponse = {
  turn?: { id?: string; status?: string };
  reviewThreadId?: string;
};

const CODEX_MODEL_STORAGE_KEY = 'cozypad3.remoteCodex.model.v1';
const CODEX_EFFORT_STORAGE_KEY = 'cozypad3.remoteCodex.reasoningEffort.v1';
const CODEX_TOKEN_USAGE_STORAGE_PREFIX = 'cozypad3.remoteCodex.tokenUsage.v1';
const CODEX_MODEL_FALLBACKS = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'codex-auto-review',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex-spark',
];
const CODEX_EFFORT_OPTIONS = ['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

function formatTokenCount(value: number): string {
  return Math.max(0, value).toLocaleString();
}

function tokenUsageStorageKey(serverId: string, threadId: string): string {
  return `${CODEX_TOKEN_USAGE_STORAGE_PREFIX}:${serverId}:${threadId}`;
}

function readTokenUsage(serverId: string, threadId: string): CodexTokenUsage | null {
  if (!serverId || !threadId) return null;
  try {
    const value = window.localStorage.getItem(tokenUsageStorageKey(serverId, threadId));
    return value ? codexTokenUsageFrom(JSON.parse(value)) : null;
  } catch {
    return null;
  }
}

function rememberTokenUsage(
  serverId: string,
  threadId: string,
  tokenUsage: CodexTokenUsage,
): void {
  if (!serverId || !threadId) return;
  window.localStorage.setItem(
    tokenUsageStorageKey(serverId, threadId),
    JSON.stringify(tokenUsage),
  );
}

function isMissingRolloutError(error: unknown): boolean {
  return /no rollout found for thread id/i.test(
    error instanceof Error ? error.message : String(error || ''),
  );
}

function itemTextContent(item: CodexThreadItem): string {
  if (!Array.isArray(item.content)) return '';
  return item.content
    .map((content) => {
      const value = content && typeof content === 'object' ? (content as Record<string, unknown>) : {};
      return value.type === 'text' ? String(value.text || '') : `[${String(value.type || 'input')}]`;
    })
    .filter(Boolean)
    .join('\n');
}

function itemTitle(item: CodexThreadItem): string {
  switch (item.type) {
    case 'userMessage':
      return 'You';
    case 'agentMessage':
      return 'Codex';
    case 'commandExecution':
      return 'Command';
    case 'fileChange':
      return 'File changes';
    case 'reasoning':
      return 'Reasoning';
    case 'mcpToolCall':
      return `MCP · ${String(item.tool || 'tool')}`;
    case 'plan':
      return 'Plan';
    case 'webSearch':
      return 'Web search';
    case 'collabToolCall':
      return `Agent · ${String(item.tool || 'collaboration')}`;
    case 'enteredReviewMode':
      return 'Review started';
    case 'exitedReviewMode':
      return 'Review result';
    default:
      return item.type;
  }
}

function readableItemText(item: CodexThreadItem): string {
  if (item.type === 'enteredReviewMode' || item.type === 'exitedReviewMode') {
    return String(item.review || 'Code review');
  }
  if (item.type === 'reasoning') {
    const summary = Array.isArray(item.summary) ? item.summary.map(String).filter(Boolean) : [];
    const content = Array.isArray(item.content)
      ? item.content.map((entry) => {
          const value = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
          return String(value.text || value.summary || '');
        }).filter(Boolean)
      : [];
    return [...summary, ...content, String(item.text || '')].filter(Boolean).join('\n\n');
  }
  if (item.type === 'mcpToolCall') {
    return [
      item.server ? `Server: ${String(item.server)}` : '',
      item.arguments ? `Arguments:\n${JSON.stringify(item.arguments, null, 2)}` : '',
      item.result ? `Result:\n${JSON.stringify(item.result, null, 2)}` : '',
      item.error ? `Error:\n${JSON.stringify(item.error, null, 2)}` : '',
    ].filter(Boolean).join('\n\n');
  }
  if (item.type === 'webSearch') {
    return [item.query ? `Query: ${String(item.query)}` : '', item.results ? JSON.stringify(item.results, null, 2) : '']
      .filter(Boolean)
      .join('\n\n');
  }
  if (item.type === 'collabToolCall') {
    return [item.prompt ? String(item.prompt) : '', item.agentStatus ? `Status: ${String(item.agentStatus)}` : '']
      .filter(Boolean)
      .join('\n\n');
  }
  return String(item.text || '');
}

function CodexItemCard({
  item,
  serverId,
  onOpenFilesPath,
}: {
  item: CodexThreadItem;
  serverId: string;
  onOpenFilesPath?: (target: { serverId: string; path: string }) => void;
}) {
  const text = item.type === 'userMessage' ? itemTextContent(item) : readableItemText(item);
  const markdownComponents = useMemo(
    () => createMarkdownComponents(onOpenFilesPath, { serverId }),
    [onOpenFilesPath, serverId],
  );
  if (item.type === 'agentMessage' || item.type === 'userMessage') {
    return (
      <article className={`codex-app-item codex-app-item-${item.type}`}>
        <header>{itemTitle(item)}</header>
        <div className="legacy-codex-markdown">
          <ReactMarkdown components={markdownComponents}>
            {linkifyRemotePathLines(text || '…', serverId)}
          </ReactMarkdown>
        </div>
      </article>
    );
  }
  if (item.type === 'commandExecution') {
    return (
      <details className="codex-app-item codex-app-tool" open={item.status === 'inProgress'}>
        <summary>
          <span>{itemTitle(item)}</span>
          <code>{String(item.command || '')}</code>
          <small>{String(item.status || '')}</small>
        </summary>
        <pre>{String(item.aggregatedOutput || '') || 'Waiting for output…'}</pre>
      </details>
    );
  }
  if (item.type === 'fileChange') {
    const changes = Array.isArray(item.changes)
      ? item.changes as Array<Record<string, unknown>>
      : [];
    return (
      <details className="codex-app-item codex-app-tool codex-app-file-change" open={item.status === 'inProgress'}>
        <summary>
          <span>{itemTitle(item)}</span>
          <code>{changes.map((change) => String(change.path || '')).filter(Boolean).join(', ') || 'Pending changes'}</code>
          <small>{String(item.status || '')}</small>
        </summary>
        <div className="codex-app-change-list">
          {changes.map((change, index) => (
            <section key={`${String(change.path || 'change')}-${index}`}>
              <strong>{String(change.kind || 'update')} · {String(change.path || 'file')}</strong>
              {change.diff ? <pre>{String(change.diff)}</pre> : null}
            </section>
          ))}
          {!changes.length ? <p className="hint">No file details were provided.</p> : null}
        </div>
      </details>
    );
  }
  if (item.type === 'reasoning' && !text) return null;
  return (
    <details className="codex-app-item codex-app-tool">
      <summary>
        <span>{itemTitle(item)}</span>
        <small>{String(item.status || '')}</small>
      </summary>
      {text ? <pre>{text}</pre> : <pre>{JSON.stringify(item, null, 2)}</pre>}
    </details>
  );
}

function approvalDescription(request: CodexAppServerRequest): string {
  const params = request.params;
  if (request.method.includes('commandExecution')) {
    return String(params.command || params.reason || 'Codex wants to run a command.');
  }
  if (request.method.includes('fileChange')) {
    return String(params.reason || 'Codex wants to apply file changes.');
  }
  if (request.method.includes('permissions')) {
    return String(params.reason || 'Codex requests additional permissions.');
  }
  return request.method;
}

function CodexUserInputRequest({
  request,
  onSubmit,
}: {
  request: CodexAppServerRequest;
  onSubmit: (answers: Record<string, { answers: string[] }>) => void;
}) {
  const questions = Array.isArray(request.params.questions)
    ? (request.params.questions as Array<Record<string, unknown>>)
    : [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  return (
    <section className="codex-app-approval">
      <strong>Codex needs your input</strong>
      {questions.map((question) => {
        const id = String(question.id || 'question');
        const options = Array.isArray(question.options)
          ? (question.options as Array<Record<string, unknown>>)
          : [];
        return (
          <label key={id} className="codex-app-question">
            <span>{String(question.header || 'Question')}</span>
            <p>{String(question.question || '')}</p>
            {options.length ? (
              <select
                value={answers[id] || ''}
                onChange={(event) => setAnswers((current) => ({ ...current, [id]: event.target.value }))}
              >
                <option value="">Select…</option>
                {options.map((option) => {
                  const label = String(option.label || '');
                  return <option key={label} value={label}>{label}</option>;
                })}
              </select>
            ) : (
              <input
                type={question.isSecret ? 'password' : 'text'}
                value={answers[id] || ''}
                onChange={(event) => setAnswers((current) => ({ ...current, [id]: event.target.value }))}
              />
            )}
          </label>
        );
      })}
      <div>
        <button
          type="button"
          onClick={() =>
            onSubmit(
              Object.fromEntries(
                questions.map((question) => {
                  const id = String(question.id || 'question');
                  return [id, { answers: answers[id] ? [answers[id]] : [] }];
                }),
              ),
            )
          }
        >
          Submit
        </button>
      </div>
    </section>
  );
}

export function CodexAppServerPanel({
  selectedProfile,
  legacyServer,
  onOpenFilesPath,
  onUseLegacy,
}: {
  selectedProfile: ConnectionProfile | null;
  legacyServer: LegacySshServer | null;
  onOpenFilesPath?: (target: { serverId: string; path: string }) => void;
  onUseLegacy: () => void;
}) {
  const serverId = legacyServer?.id || selectedProfile?.id || '';
  const defaultCwd = legacyServer?.defaultPath || '~';
  const clientRef = useRef<CodexAppServerSocket | null>(null);
  const selectedThreadIdRef = useRef('');
  const [runtime, setRuntime] = useState<CodexAppServerRuntimeStatus | null>(null);
  const [threads, setThreads] = useState<CodexThreadSummary[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState('');
  const [view, setView] = useState<CodexStructuredState>(EMPTY_CODEX_STRUCTURED_STATE);
  const [approvals, setApprovals] = useState<CodexAppServerRequest[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [threadQuery, setThreadQuery] = useState('');
  const [goalMode, setGoalMode] = useState(false);
  const [reviewMode, setReviewMode] = useState(false);
  const [reviewTargetType, setReviewTargetType] = useState<ReviewTargetType>('uncommittedChanges');
  const [goal, setGoal] = useState<ThreadGoal | null>(null);
  const unavailableThreadIdsRef = useRef(new Set<string>());
  const itemsScrollRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  const lastScrolledThreadIdRef = useRef<string | null>(null);
  const [cwd, setCwd] = useState(() => readCodexCwd(serverId, defaultCwd));
  const [model, setModel] = useState(() => window.localStorage.getItem(CODEX_MODEL_STORAGE_KEY) || '');
  const [effort, setEffort] = useState(() => window.localStorage.getItem(CODEX_EFFORT_STORAGE_KEY) || '');
  const [models, setModels] = useState<string[]>(CODEX_MODEL_FALLBACKS);
  const [collaborationMode, setCollaborationMode] = useState('default');
  const [collaborationModes, setCollaborationModes] = useState<CollaborationMode[]>([
    { mode: 'default', settings: { developer_instructions: null } },
    { mode: 'plan', settings: { developer_instructions: null, reasoning_effort: 'medium' } },
  ]);

  const selectedThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) || null,
    [threads, selectedThreadId],
  );
  const visibleThreads = useMemo(() => {
    const query = threadQuery.trim().toLowerCase();
    if (!query) return threads;
    return threads.filter((thread) =>
      [thread.name, thread.preview, thread.cwd, thread.id]
        .some((value) => String(value || '').toLowerCase().includes(query)),
    );
  }, [threadQuery, threads]);
  const activeCollaborationMode = useMemo(() => {
    const preset = collaborationModes.find((candidate) => candidate.mode === collaborationMode);
    const selectedModel = model || models[0] || CODEX_MODEL_FALLBACKS[0];
    return preset ? {
      ...preset,
      model: selectedModel,
      settings: { ...(preset.settings || {}), model: selectedModel },
    } : undefined;
  }, [collaborationMode, collaborationModes, model, models]);
  const contextBudget = useMemo(
    () => (view.tokenUsage ? codexContextBudget(view.tokenUsage) : null),
    [view.tokenUsage],
  );

  useEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId]);

  useLayoutEffect(() => {
    const element = itemsScrollRef.current;
    if (!element) return;

    const threadChanged = lastScrolledThreadIdRef.current !== view.threadId;
    if (threadChanged) {
      lastScrolledThreadIdRef.current = view.threadId;
      followLatestRef.current = true;
    }

    if (threadChanged || followLatestRef.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [view.items, view.threadId]);

  useEffect(() => {
    setCwd(readCodexCwd(serverId, defaultCwd));
    return subscribeCodexCwd(serverId, setCwd);
  }, [defaultCwd, serverId]);

  useEffect(() => {
    if (model) window.localStorage.setItem(CODEX_MODEL_STORAGE_KEY, model);
    else window.localStorage.removeItem(CODEX_MODEL_STORAGE_KEY);
  }, [model]);

  useEffect(() => {
    if (effort) window.localStorage.setItem(CODEX_EFFORT_STORAGE_KEY, effort);
    else window.localStorage.removeItem(CODEX_EFFORT_STORAGE_KEY);
  }, [effort]);

  const refreshThreads = async (client: CodexAppServerSocket) => {
    const response = await client.call<ThreadListResponse>('thread/list', {
      limit: 50,
      sortKey: 'updated_at',
      sortDirection: 'desc',
    });
    setThreads(
      (Array.isArray(response?.data) ? response.data : []).filter(
        (thread) => !unavailableThreadIdsRef.current.has(thread.id),
      ),
    );
  };

  const refreshModels = async (client: CodexAppServerSocket) => {
    const response = await client.call<ModelListResponse>('model/list', {});
    const discovered = (Array.isArray(response?.data) ? response.data : [])
      .map((entry) => String(entry.id || entry.model || entry.slug || '').trim())
      .filter(Boolean);
    setModels([...new Set([...discovered, ...CODEX_MODEL_FALLBACKS])]);
  };

  const refreshCollaborationModes = async (client: CodexAppServerSocket) => {
    const response = await client.call<CollaborationModeListResponse>('collaborationMode/list', {});
    if (Array.isArray(response?.data) && response.data.length) {
      setCollaborationModes(response.data.map((candidate) => ({
        ...candidate,
        settings: {
          ...(candidate.settings || {}),
          developer_instructions: null,
          ...(candidate.mode === 'plan' && !candidate.settings?.reasoning_effort
            ? { reasoning_effort: 'medium' }
            : {}),
        },
      })));
    }
  };

  const refreshGoal = async (client: CodexAppServerSocket, threadId: string) => {
    if (!threadId) {
      setGoal(null);
      return;
    }
    const response = await client.call<ThreadGoalResponse>('thread/goal/get', { threadId });
    setGoal(response.goal || null);
  };

  const forgetUnavailableThread = (threadId: string) => {
    unavailableThreadIdsRef.current.add(threadId);
    selectedThreadIdRef.current = '';
    setThreads((current) => current.filter((thread) => thread.id !== threadId));
    setSelectedThreadId('');
    setView(EMPTY_CODEX_STRUCTURED_STATE);
  };

  const startNewThreadDraft = () => {
    selectedThreadIdRef.current = '';
    setSelectedThreadId('');
    setView(EMPTY_CODEX_STRUCTURED_STATE);
    setApprovals([]);
    setGoal(null);
    setError('');
  };

  const openThread = async (thread: CodexThreadSummary) => {
    const client = clientRef.current;
    if (!client) return;
    setBusy(true);
    setError('');
    try {
      const response = await client.call<ThreadResponse>('thread/resume', { threadId: thread.id });
      const resumed = response.thread || thread;
      setSelectedThreadId(resumed.id);
      setView(structuredStateFromThread(resumed, readTokenUsage(serverId, resumed.id)));
      await refreshGoal(client, resumed.id).catch(() => setGoal(null));
    } catch (nextError) {
      if (isMissingRolloutError(nextError)) {
        forgetUnavailableThread(thread.id);
        setError('This empty or expired thread has no saved rollout. Start a new task to continue.');
      } else {
        setError(nextError instanceof Error ? nextError.message : 'Unable to resume Codex thread');
      }
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!serverId) return;
    const client = new CodexAppServerSocket(serverId);
    clientRef.current = client;
    const unsubscribe = client.subscribe((message) => {
      if (message.type === 'runtime_status' || message.type === 'status') {
        setRuntime(message.runtime);
        if (message.runtime.status === 'ready') {
          void refreshThreads(client).catch(() => undefined);
          void refreshModels(client).catch(() => undefined);
          void refreshCollaborationModes(client).catch(() => undefined);
          const threadId = selectedThreadIdRef.current;
          if (threadId) {
            void client
              .call<ThreadResponse>('thread/resume', { threadId })
              .then((response) => {
                if (response.thread) {
                  setView(structuredStateFromThread(
                    response.thread,
                    readTokenUsage(serverId, response.thread.id),
                  ));
                  void refreshGoal(client, response.thread.id).catch(() => undefined);
                }
              })
              .catch((resumeError) => {
                if (isMissingRolloutError(resumeError)) forgetUnavailableThread(threadId);
              });
          }
        }
      } else if (message.type === 'event') {
        setView((current) => {
          const next = reduceCodexRuntimeEvent(current, message.event);
          if (next.tokenUsage && next.tokenUsage !== current.tokenUsage) {
            rememberTokenUsage(
              serverId,
              next.threadId || message.event.threadId || '',
              next.tokenUsage,
            );
          }
          return next;
        });
        if (message.event.method === 'turn/completed') {
          setBusy(false);
          void refreshThreads(client).catch(() => undefined);
          const threadId = selectedThreadIdRef.current;
          if (threadId) void refreshGoal(client, threadId).catch(() => undefined);
        }
      } else if (message.type === 'server_request') {
        setApprovals((current) =>
          current.some((request) => request.id === message.request.id)
            ? current
            : [...current, message.request],
        );
      } else if (message.type === 'protocol_error') {
        setError(message.error);
      }
    });
    void client
      .connect()
      .then(() => Promise.all([
        refreshThreads(client),
        refreshModels(client).catch(() => undefined),
        refreshCollaborationModes(client).catch(() => undefined),
      ]))
      .catch((nextError) =>
        setError(nextError instanceof Error ? nextError.message : 'Codex app-server failed to connect'),
      );
    return () => {
      unsubscribe();
      client.close();
      if (clientRef.current === client) clientRef.current = null;
    };
  }, [serverId]);

  const createThread = async (): Promise<string> => {
    const client = clientRef.current;
    if (!client) throw new Error('Codex app-server is not connected');
    const response = await client.call<ThreadResponse>('thread/start', {
      cwd,
      model: model || undefined,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
      config: effort ? { model_reasoning_effort: effort } : undefined,
      collaborationMode: activeCollaborationMode,
    });
    const thread = response.thread;
    if (!thread?.id) throw new Error('Codex did not return a thread id');
    setThreads((current) => [thread, ...current.filter((candidate) => candidate.id !== thread.id)]);
    setSelectedThreadId(thread.id);
    setView(structuredStateFromThread(thread));
    return thread.id;
  };

  const runTurn = async (text: string, goalObjective = '') => {
    const client = clientRef.current;
    if (!text || !client || busy) return;
    setBusy(true);
    setError('');
    try {
      let threadId = selectedThreadId || (await createThread());
      if (goalObjective) {
        const goalResponse = await client.call<ThreadGoalResponse>('thread/goal/set', {
          threadId,
          objective: goalObjective,
          status: 'active',
        });
        setGoal(goalResponse.goal || null);
      }
      const startTurn = (targetThreadId: string) =>
        client.call<{ turn?: { id?: string; status?: string } }>('turn/start', {
          threadId: targetThreadId,
          clientUserMessageId: crypto.randomUUID(),
          input: [{ type: 'text', text, text_elements: [] }],
          cwd,
          model: model || undefined,
          effort: effort || undefined,
          collaborationMode: activeCollaborationMode,
        });
      let response;
      try {
        response = await startTurn(threadId);
      } catch (turnError) {
        if (!selectedThreadId || !isMissingRolloutError(turnError)) throw turnError;
        forgetUnavailableThread(selectedThreadId);
        threadId = await createThread();
        response = await startTurn(threadId);
      }
      setView((current) => ({
        ...current,
        threadId,
        turnId: String(response.turn?.id || current.turnId),
        turnStatus: String(response.turn?.status || 'inProgress'),
      }));
    } catch (nextError) {
      setBusy(false);
      setError(nextError instanceof Error ? nextError.message : 'Unable to start Codex turn');
    }
  };

  const reviewTarget = (value: string): ReviewTarget => {
    switch (reviewTargetType) {
      case 'baseBranch':
        return { type: 'baseBranch', branch: value };
      case 'commit':
        return { type: 'commit', sha: value, title: null };
      case 'custom':
        return { type: 'custom', instructions: value };
      default:
        return { type: 'uncommittedChanges' };
    }
  };

  const runReview = async (value: string) => {
    const client = clientRef.current;
    if (!client || busy) return;
    setBusy(true);
    setError('');
    try {
      let threadId = selectedThreadId || (await createThread());
      const startReview = (targetThreadId: string) =>
        client.call<ReviewStartResponse>('review/start', {
          threadId: targetThreadId,
          delivery: 'inline',
          target: reviewTarget(value),
        });
      let response;
      try {
        response = await startReview(threadId);
      } catch (reviewError) {
        if (!selectedThreadId || !isMissingRolloutError(reviewError)) throw reviewError;
        forgetUnavailableThread(selectedThreadId);
        threadId = await createThread();
        response = await startReview(threadId);
      }
      setView((current) => ({
        ...current,
        threadId: response.reviewThreadId || threadId,
        turnId: String(response.turn?.id || current.turnId),
        turnStatus: String(response.turn?.status || 'inProgress'),
      }));
    } catch (nextError) {
      setBusy(false);
      setError(nextError instanceof Error ? nextError.message : 'Unable to start Codex review');
    }
  };

  const sendTurn = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text && !(reviewMode && reviewTargetType === 'uncommittedChanges')) return;
    setDraft('');
    if (reviewMode) {
      await runReview(text);
      setReviewMode(false);
      return;
    }
    await runTurn(text, goalMode ? text : '');
    if (goalMode) setGoalMode(false);
  };

  const updateGoalStatus = async (status: 'active' | 'paused') => {
    const client = clientRef.current;
    if (!client || !selectedThreadId) return;
    setError('');
    try {
      const response = await client.call<ThreadGoalResponse>('thread/goal/set', {
        threadId: selectedThreadId,
        status,
      });
      setGoal(response.goal || null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to update Goal');
    }
  };

  const clearGoal = async () => {
    const client = clientRef.current;
    if (!client || !selectedThreadId) return;
    setError('');
    try {
      await client.call('thread/goal/clear', { threadId: selectedThreadId });
      setGoal(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to clear Goal');
    }
  };

  const archiveSelectedThread = async () => {
    const client = clientRef.current;
    if (!client || !selectedThreadId || busy) return;
    setBusy(true);
    setError('');
    try {
      await client.call('thread/archive', { threadId: selectedThreadId });
      startNewThreadDraft();
      await refreshThreads(client);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to archive Codex thread');
    } finally {
      setBusy(false);
    }
  };

  const interrupt = async () => {
    const client = clientRef.current;
    if (!client || !view.threadId || !view.turnId) return;
    try {
      await client.call('turn/interrupt', { threadId: view.threadId, turnId: view.turnId });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to interrupt Codex');
    }
  };

  const resolveApproval = (request: CodexAppServerRequest, accept: boolean) => {
    const client = clientRef.current;
    if (!client) return;
    try {
      if (request.method.includes('permissions')) {
        client.respond(request.id, {
          permissions: accept ? request.params.permissions || {} : {},
          scope: 'turn',
        });
      } else {
        client.respond(request.id, { decision: accept ? 'accept' : 'decline' });
      }
      setApprovals((current) => current.filter((candidate) => candidate.id !== request.id));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to answer approval');
    }
  };

  const resolveUserInput = (
    request: CodexAppServerRequest,
    answers: Record<string, { answers: string[] }>,
  ) => {
    try {
      clientRef.current?.respond(request.id, { answers });
      setApprovals((current) => current.filter((candidate) => candidate.id !== request.id));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to submit Codex answer');
    }
  };

  return (
    <section className="legacy-codex-panel codex-app-panel">
      <header className="legacy-codex-head codex-app-head">
        <div>
          <h2>Codex Web Agent</h2>
          <span>
            Official app-server · {legacyServer?.name || selectedProfile?.name || 'server'} · {cwd}
          </span>
        </div>
        <div className="legacy-codex-actions codex-app-head-actions">
          <span className={`codex-app-runtime codex-app-runtime-${runtime?.status || 'starting'}`}>
            {runtime?.status || 'connecting'}
          </span>
          <button type="button" onClick={startNewThreadDraft} disabled={runtime?.status !== 'ready'}>
            New thread
          </button>
          <button type="button" onClick={onUseLegacy}>Legacy fallback</button>
        </div>
      </header>

      {error || view.error ? <div className="codex-app-error">{error || view.error}</div> : null}

      <div className="agent-panes legacy-codex-panes codex-app-layout">
        <aside className="session-sidebar legacy-codex-sidebar codex-app-threads">
          <strong>Threads</strong>
          <input
            className="codex-app-thread-search"
            value={threadQuery}
            onChange={(event) => setThreadQuery(event.target.value)}
            placeholder="Search threads"
            aria-label="Search Codex threads"
          />
          {visibleThreads.map((thread) => (
            <button
              type="button"
              key={thread.id}
              className={thread.id === selectedThreadId ? 'active' : ''}
              onClick={() => void openThread(thread)}
            >
              <span>{thread.name || thread.preview || 'Untitled thread'}</span>
              <small>{thread.cwd || cwd}</small>
            </button>
          ))}
          {!visibleThreads.length ? <p>{threads.length ? 'No matching thread.' : 'No saved thread yet.'}</p> : null}
        </aside>

        <main className="chat-column legacy-codex-output codex-app-conversation">
          <div className="codex-app-turn-head">
            <span>{selectedThread?.name || selectedThread?.preview || 'New Codex thread'}</span>
            <small>{view.turnStatus}</small>
            {view.turnStatus === 'inProgress' || busy ? (
              <button type="button" onClick={() => void interrupt()} disabled={!view.turnId}>
                Interrupt
              </button>
            ) : null}
            {selectedThreadId && !busy ? (
              <button type="button" className="danger" onClick={() => void archiveSelectedThread()}>
                Archive
              </button>
            ) : null}
          </div>

          <div
            className="codex-app-items"
            ref={itemsScrollRef}
            aria-live="polite"
            onScroll={(event) => {
              const element = event.currentTarget;
              followLatestRef.current =
                element.scrollHeight - element.scrollTop - element.clientHeight < 160;
            }}
          >
            {view.items.map((item) => (
              <CodexItemCard
                key={item.id}
                item={item}
                serverId={serverId}
                onOpenFilesPath={onOpenFilesPath}
              />
            ))}
            {!view.items.length ? (
              <div className="codex-app-empty">Start a structured Codex thread on this server.</div>
            ) : null}
          </div>

          {approvals.map((request) =>
            request.method === 'item/tool/requestUserInput' ? (
              <CodexUserInputRequest
                key={String(request.id)}
                request={request}
                onSubmit={(answers) => resolveUserInput(request, answers)}
              />
            ) : (
              <section className="codex-app-approval" key={String(request.id)}>
                <strong>Approval required</strong>
                <p>{approvalDescription(request)}</p>
                <small>{request.method}</small>
                <div>
                  <button type="button" onClick={() => resolveApproval(request, false)}>Deny</button>
                  <button type="button" onClick={() => resolveApproval(request, true)}>Allow once</button>
                </div>
              </section>
            ),
          )}

          <form className="codex-app-composer" onSubmit={sendTurn}>
            <div className="codex-app-prompt-row">
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing &&
                    Boolean(draft.trim()) &&
                    !busy &&
                    runtime?.status === 'ready'
                  ) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder={reviewMode
                  ? reviewTargetType === 'uncommittedChanges'
                    ? 'Review staged, unstaged, and untracked changes…'
                    : reviewTargetType === 'baseBranch'
                      ? 'Enter the base branch, for example main…'
                      : reviewTargetType === 'commit'
                        ? 'Enter the commit SHA to review…'
                        : 'Describe exactly what Codex should review…'
                  : goalMode
                    ? 'Describe the outcome and success criteria for this goal…'
                    : selectedThreadId
                      ? 'Continue this Codex thread…'
                      : 'Start a Codex task…'}
                rows={3}
              />
              <button
                type="submit"
                disabled={
                  (!draft.trim() && !(reviewMode && reviewTargetType === 'uncommittedChanges')) ||
                  busy ||
                  runtime?.status !== 'ready'
                }
              >
                {busy ? 'Running…' : reviewMode ? 'Start review' : goalMode ? 'Start goal' : 'Send'}
              </button>
            </div>
            <div className="codex-app-composer-controls">
              <button
                type="button"
                className={`codex-app-mode-button${goalMode ? ' active' : ''}`}
                aria-pressed={goalMode}
                onClick={() => {
                  setGoalMode((current) => !current);
                  setReviewMode(false);
                }}
                disabled={busy || runtime?.status !== 'ready'}
              >
                ◎ Goal
              </button>
              <button
                type="button"
                className={`codex-app-mode-button${reviewMode ? ' active' : ''}`}
                aria-pressed={reviewMode}
                onClick={() => {
                  setReviewMode((current) => !current);
                  setGoalMode(false);
                }}
                disabled={busy || runtime?.status !== 'ready'}
              >
                Review
              </button>
              {reviewMode ? (
                <label className="codex-app-review-target">
                  <span>Target</span>
                  <select
                    value={reviewTargetType}
                    onChange={(event) => {
                      setReviewTargetType(event.target.value as ReviewTargetType);
                      setDraft('');
                    }}
                  >
                    <option value="uncommittedChanges">Current changes</option>
                    <option value="baseBranch">Base branch</option>
                    <option value="commit">Commit</option>
                    <option value="custom">Custom</option>
                  </select>
                </label>
              ) : null}
              <label>
                <span>Model</span>
                <select value={model} onChange={(event) => setModel(event.target.value)}>
                  <option value="">default</option>
                  {models.map((option) => <option value={option} key={option}>{option}</option>)}
                </select>
              </label>
              <label>
                <span>Effort</span>
                <select value={effort} onChange={(event) => setEffort(event.target.value)}>
                  {CODEX_EFFORT_OPTIONS.map((option) => (
                    <option value={option} key={option || 'auto'}>{option || 'auto'}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Mode</span>
                <select
                  value={collaborationMode}
                  onChange={(event) => {
                    const nextMode = event.target.value;
                    setCollaborationMode(nextMode);
                    const nextEffort = collaborationModes.find(
                      (candidate) => candidate.mode === nextMode,
                    )?.settings?.reasoning_effort;
                    if (typeof nextEffort === 'string') setEffort(nextEffort);
                  }}
                >
                  {collaborationModes.map((option) => (
                    <option value={option.mode} key={option.mode}>{option.mode}</option>
                  ))}
                </select>
              </label>
              {goalMode ? <span className="codex-app-goal-hint">Goal mode enabled for the next prompt</span> : null}
              {reviewMode ? (
                <span className="codex-app-goal-hint">Review runs inline on this task</span>
              ) : null}
            </div>
          </form>
        </main>

        <aside className="context-panel legacy-codex-context codex-app-context" tabIndex={0}>
          <h3>Context</h3>
          <dl>
            <dt>Agent</dt>
            <dd>Codex app-server</dd>
            <dt>Mode</dt>
            <dd>remote SSH server</dd>
            <dt>Server</dt>
            <dd>{legacyServer?.name || selectedProfile?.name || 'Not selected'}</dd>
            <dt>Target</dt>
            <dd>
              {legacyServer
                ? `${legacyServer.user || ''}@${legacyServer.host}:${legacyServer.port || 22}`
                : selectedProfile
                  ? `${selectedProfile.username}@${selectedProfile.host}:${selectedProfile.port}`
                  : '-'}
            </dd>
            <dt>cwd</dt>
            <dd className="legacy-codex-cwd-cell">
              <input
                className="legacy-codex-cwd-input"
                value={cwd}
                onChange={(event) => setCwd(event.target.value)}
                onBlur={() => setCwd(rememberCodexCwd(serverId, cwd))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
                placeholder="~"
                spellCheck={false}
              />
              <button
                type="button"
                className="legacy-codex-cwd-open"
                disabled={!serverId || !cwd.trim()}
                onClick={() => {
                  if (serverId && cwd.trim()) onOpenFilesPath?.({ serverId, path: cwd.trim() });
                }}
              >
                File
              </button>
            </dd>
            <dt>Status</dt>
            <dd><span className={`chip chip-${runtime?.status === 'ready' ? 'ready' : 'disconnected'}`}>{runtime?.status || 'connecting'}</span></dd>
          </dl>
          <h3>Runtime</h3>
          <p className="hint">{model || 'default'} · effort {effort || 'auto'} · {collaborationMode}</p>
          <h3>Workflow</h3>
          <section className="codex-app-goal" aria-label="Codex goal controls">
            <strong>Goal</strong>
            <p className="hint">Enable Goal beside the prompt, then describe the outcome and success criteria in that same message.</p>
            {goal ? (
              <dl className="codex-app-goal-status">
                <dt>Status</dt><dd>{goal.status}</dd>
                <dt>Objective</dt><dd>{goal.objective}</dd>
                <dt>Usage</dt><dd>{Number(goal.tokensUsed || 0).toLocaleString()} tokens · {Number(goal.timeUsedSeconds || 0)}s</dd>
              </dl>
            ) : <p className="hint">No active goal on this thread.</p>}
            <div className="codex-app-goal-actions">
              <button type="button" onClick={() => void refreshGoal(clientRef.current!, selectedThreadId)} disabled={!selectedThreadId || runtime?.status !== 'ready'}>Refresh</button>
              <button type="button" onClick={() => void updateGoalStatus('paused')} disabled={!goal || goal.status !== 'active'}>Pause</button>
              <button type="button" onClick={() => void updateGoalStatus('active')} disabled={!goal || goal.status !== 'paused'}>Resume</button>
              <button type="button" className="danger" onClick={() => void clearGoal()} disabled={!goal}>Clear</button>
            </div>
          </section>
          <p className="hint">Model, effort, and cwd apply when the next thread starts.</p>
          <h3>Usage</h3>
          {view.tokenUsage ? (
            <section className="codex-app-usage" aria-label="Codex token usage">
              <div className="codex-app-usage-total">
                <span>Total tokens</span>
                <strong>{formatTokenCount(view.tokenUsage.total.totalTokens)}</strong>
              </div>
              {contextBudget ? (
                <div className="codex-app-context-budget">
                  <div className="codex-app-context-budget-head">
                    <span>Context remaining</span>
                    <strong>{contextBudget.remainingPercent}%</strong>
                  </div>
                  <div
                    className="codex-app-context-meter"
                    role="progressbar"
                    aria-label="Context window used"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={contextBudget.usedPercent}
                  >
                    <span style={{ width: `${contextBudget.usedPercent}%` }} />
                  </div>
                  <div className="codex-app-context-budget-counts">
                    <span>Used {formatTokenCount(contextBudget.usedTokens)}</span>
                    <span>Remaining {formatTokenCount(contextBudget.remainingTokens)}</span>
                  </div>
                  <small>
                    {formatTokenCount(contextBudget.reservedTokens)} reserved by Codex
                  </small>
                </div>
              ) : null}
              <dl className="codex-app-usage-details">
                <dt>Input</dt>
                <dd>{formatTokenCount(view.tokenUsage.total.inputTokens)}</dd>
                <dt>Cached input</dt>
                <dd>{formatTokenCount(view.tokenUsage.total.cachedInputTokens)}</dd>
                <dt>Output</dt>
                <dd>{formatTokenCount(view.tokenUsage.total.outputTokens)}</dd>
                <dt>Reasoning</dt>
                <dd>{formatTokenCount(view.tokenUsage.total.reasoningOutputTokens)}</dd>
                <dt>Current context</dt>
                <dd>{formatTokenCount(view.tokenUsage.last.totalTokens)}</dd>
                {view.tokenUsage.modelContextWindow ? (
                  <>
                    <dt>Context window</dt>
                    <dd>{formatTokenCount(view.tokenUsage.modelContextWindow)}</dd>
                  </>
                ) : null}
              </dl>
              <p className="hint">Live totals reported by the selected Codex thread.</p>
            </section>
          ) : (
            <p className="hint">Token usage appears after this thread runs its next turn.</p>
          )}
        </aside>
      </div>
    </section>
  );
}
