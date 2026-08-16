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
import {
  DEFAULT_MANAGED_GOAL_POLICY,
  advanceManagedGoalRuntime,
  buildManagedGoalObjective,
  createManagedGoalRuntime,
  goalHasTokensRemaining,
  normalizeManagedGoalPolicy,
  type ManagedGoalPolicy,
  type ManagedGoalRuntime,
} from './codexGoalController';
import {
  CODEX_DISPLAY_ITEM_BATCH,
  CODEX_DISPLAY_TEXT_PREVIEW_CHARS,
  codexDisplayText,
  codexDisplayWindow,
} from './codexDisplayWindow';
import {
  buildCodexSkillTurnInput,
  normalizeCodexSkills,
  type CodexSkill,
} from './codexSkillManager';

type ThreadListResponse = { data?: CodexThreadSummary[] };
type ThreadResponse = {
  thread?: CodexThreadSummary;
  instructionSources?: string[];
};
type InstructionRule = { path: string; content: string };
type FsReadFileResponse = { dataBase64?: string };
type ModelListResponse = {
  data?: Array<{ id?: string; model?: string; slug?: string }>;
};
type CollaborationMode = {
  mode: string;
  model?: string;
  settings?: Record<string, unknown>;
};
type CollaborationModeListResponse = { data?: CollaborationMode[] };
type SkillsListResponse = { data?: unknown[] };
type ThreadGoal = {
  threadId: string;
  objective: string;
  status: string;
  tokenBudget?: number | null;
  tokensUsed?: number;
  timeUsedSeconds?: number;
};
type ThreadGoalResponse = { goal?: ThreadGoal | null };
type ReviewPermissionMode = 'ask' | 'autoReview' | 'fullAccess';
type ReviewPermissionSettings = {
  approvalPolicy: 'on-request' | 'never';
  approvalsReviewer: 'user' | 'auto_review';
  sandbox: 'workspace-write' | 'danger-full-access';
  sandboxPolicy:
    | { type: 'dangerFullAccess' }
    | {
        type: 'workspaceWrite';
        writableRoots: string[];
        networkAccess: boolean;
        excludeTmpdirEnvVar: boolean;
        excludeSlashTmp: boolean;
      };
};

const CODEX_MODEL_STORAGE_KEY = 'cozypad3.remoteCodex.model.v1';
const CODEX_EFFORT_STORAGE_KEY = 'cozypad3.remoteCodex.reasoningEffort.v1';
const CODEX_REVIEW_PERMISSION_STORAGE_KEY = 'cozypad3.remoteCodex.reviewPermission.v1';
const CODEX_THREADS_COLLAPSED_STORAGE_KEY = 'cozypad3.remoteCodex.threadsCollapsed.v1';
const CODEX_TOKEN_USAGE_STORAGE_PREFIX = 'cozypad3.remoteCodex.tokenUsage.v1';
const CODEX_GOAL_POLICY_STORAGE_KEY = 'cozypad3.remoteCodex.goalPolicy.v1';
const CODEX_GOAL_RUNTIME_STORAGE_PREFIX = 'cozypad3.remoteCodex.goalRuntime.v1';
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
const CODEX_REVIEW_PERMISSION_OPTIONS: Array<{
  value: ReviewPermissionMode;
  label: string;
}> = [
  { value: 'ask', label: 'Ask for approval' },
  { value: 'autoReview', label: 'Approve for me' },
  { value: 'fullAccess', label: 'Full access' },
];

function reviewPermissionLabel(mode: ReviewPermissionMode): string {
  return CODEX_REVIEW_PERMISSION_OPTIONS.find((option) => option.value === mode)?.label || mode;
}

function reviewPermissionSettings(mode: ReviewPermissionMode): ReviewPermissionSettings {
  if (mode === 'fullAccess') {
    return {
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'danger-full-access',
      sandboxPolicy: { type: 'dangerFullAccess' },
    };
  }
  return {
    approvalPolicy: 'on-request',
    approvalsReviewer: mode === 'autoReview' ? 'auto_review' : 'user',
    sandbox: 'workspace-write',
    sandboxPolicy: {
      type: 'workspaceWrite',
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
  };
}

function decodeBase64Text(value: string): string {
  const bytes = Uint8Array.from(window.atob(value), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

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

function readGoalPolicy(): ManagedGoalPolicy {
  try {
    const value = window.localStorage.getItem(CODEX_GOAL_POLICY_STORAGE_KEY);
    return normalizeManagedGoalPolicy(value ? JSON.parse(value) : DEFAULT_MANAGED_GOAL_POLICY);
  } catch {
    return DEFAULT_MANAGED_GOAL_POLICY;
  }
}

function goalRuntimeStorageKey(serverId: string, threadId: string): string {
  return `${CODEX_GOAL_RUNTIME_STORAGE_PREFIX}:${serverId}:${threadId}`;
}

function readGoalRuntime(serverId: string, threadId: string): ManagedGoalRuntime | null {
  if (!serverId || !threadId) return null;
  try {
    const value = window.localStorage.getItem(goalRuntimeStorageKey(serverId, threadId));
    return value ? JSON.parse(value) as ManagedGoalRuntime : null;
  } catch {
    return null;
  }
}

function rememberGoalRuntime(
  serverId: string,
  threadId: string,
  runtime: ManagedGoalRuntime | null,
): void {
  if (!serverId || !threadId) return;
  const key = goalRuntimeStorageKey(serverId, threadId);
  if (runtime) window.localStorage.setItem(key, JSON.stringify(runtime));
  else window.localStorage.removeItem(key);
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

type CodexDisplayEntry =
  | { kind: 'item'; item: CodexThreadItem }
  | { kind: 'activity'; id: string; items: CodexThreadItem[] };

function isConversationMessage(item: CodexThreadItem): boolean {
  return item.type === 'userMessage'
    || (item.type === 'agentMessage' && item.phase !== 'commentary');
}

export function groupCodexActivity(items: CodexThreadItem[]): CodexDisplayEntry[] {
  const entries: CodexDisplayEntry[] = [];
  let activity: CodexThreadItem[] = [];
  const flushActivity = () => {
    if (!activity.length) return;
    entries.push({ kind: 'activity', id: `activity-${activity[0]?.id || entries.length}`, items: activity });
    activity = [];
  };

  for (const item of items) {
    if (isConversationMessage(item)) {
      flushActivity();
      entries.push({ kind: 'item', item });
    } else {
      activity.push(item);
    }
  }
  flushActivity();
  return entries;
}

function CodexActivityGroup({
  items,
  serverId,
  onOpenFilesPath,
}: {
  items: CodexThreadItem[];
  serverId: string;
  onOpenFilesPath?: (target: { serverId: string; path: string }) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const markdownComponents = useMemo(
    () => createMarkdownComponents(onOpenFilesPath, { serverId }),
    [onOpenFilesPath, serverId],
  );
  const latestText = [...items]
    .reverse()
    .map((item) => readableItemText(item).replace(/\s+/g, ' ').trim())
    .find(Boolean) || 'Working';

  return (
    <section className="codex-app-activity-group" data-open={expanded ? 'true' : 'false'}>
      <button
        type="button"
        className="codex-app-activity-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="codex-app-activity-chevron" aria-hidden="true">›</span>
        <strong>Codex activity</strong>
        <code>{latestText}</code>
        <small>{items.length} {items.length === 1 ? 'update' : 'updates'}</small>
      </button>
      {expanded ? <div className="codex-app-activity-feed">
        {items.map((item) => {
          const text = readableItemText(item);
          return (
            <section key={item.id} className="codex-app-activity-entry">
              <header>{item.type === 'agentMessage' ? 'Commentary' : itemTitle(item)}</header>
              <div className="legacy-codex-markdown">
                <ReactMarkdown components={markdownComponents}>
                  {linkifyRemotePathLines(text || 'No additional details.', serverId)}
                </ReactMarkdown>
              </div>
            </section>
          );
        })}
      </div> : null}
    </section>
  );
}

function CodexItemCard({
  item,
  serverId,
  onOpenFilesPath,
  onOpenNewTask,
  onEditUserMessage,
}: {
  item: CodexThreadItem;
  serverId: string;
  onOpenFilesPath?: (target: { serverId: string; path: string }) => void;
  onOpenNewTask: (text: string) => void;
  onEditUserMessage: (text: string) => void;
}) {
  const text = item.type === 'userMessage' ? itemTextContent(item) : readableItemText(item);
  const cardRef = useRef<HTMLElement>(null);
  const selectedTextRef = useRef('');
  const [copied, setCopied] = useState(false);
  const [showFullText, setShowFullText] = useState(false);
  const displayedText = codexDisplayText(text, showFullText);
  const markdownComponents = useMemo(
    () => createMarkdownComponents(onOpenFilesPath, { serverId }),
    [onOpenFilesPath, serverId],
  );
  const selectedCardText = () => {
    const selection = window.getSelection();
    const selected = selection?.toString().trim() || '';
    if (
      selected &&
      cardRef.current &&
      selection?.anchorNode &&
      selection.focusNode &&
      cardRef.current.contains(selection.anchorNode) &&
      cardRef.current.contains(selection.focusNode)
    ) {
      selectedTextRef.current = selected;
    }
    return selectedTextRef.current;
  };
  const copyText = async () => {
    const value = selectedCardText() || text;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  if (item.type === 'agentMessage' || item.type === 'userMessage') {
    return (
      <article ref={cardRef} className={`codex-app-item codex-app-item-${item.type}`}>
        <header>
          <span>{itemTitle(item)}</span>
          <div className="codex-app-message-actions">
            <button type="button" onClick={() => void copyText()} disabled={!text}>
              {copied ? 'Copied' : 'Copy'}
            </button>
            {item.type === 'agentMessage' ? (
              <button
                type="button"
                onClick={() => onOpenNewTask(selectedCardText() || text)}
                disabled={!text}
                title="Use selected text, or the full response when nothing is selected"
              >
                New task
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onEditUserMessage(text)}
                disabled={!text}
                title="Put this message back in the composer without sending it"
              >
                Edit &amp; resend
              </button>
            )}
          </div>
        </header>
        <div
          className="legacy-codex-markdown"
          onMouseUp={() => selectedCardText()}
          onKeyUp={() => selectedCardText()}
        >
          <ReactMarkdown components={markdownComponents}>
            {linkifyRemotePathLines(displayedText || '…', serverId)}
          </ReactMarkdown>
        </div>
        {text.length > CODEX_DISPLAY_TEXT_PREVIEW_CHARS ? (
          <button
            type="button"
            className="codex-app-expand-content"
            onClick={() => setShowFullText((current) => !current)}
          >
            {showFullText ? 'Show less' : `Show full content (${text.length.toLocaleString()} characters)`}
          </button>
        ) : null}
      </article>
    );
  }
  if (item.type === 'commandExecution') {
    return (
      <details className="codex-app-item codex-app-tool">
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
      <details className="codex-app-item codex-app-tool codex-app-file-change">
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
  connected,
  legacyServer,
  onOpenFilesPath,
  onUseLegacy,
}: {
  selectedProfile: ConnectionProfile | null;
  connected: boolean;
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
  const [reviewPermissionMode, setReviewPermissionMode] = useState<ReviewPermissionMode>(() => {
    const stored = window.localStorage.getItem(CODEX_REVIEW_PERMISSION_STORAGE_KEY);
    return stored === 'ask' || stored === 'autoReview' || stored === 'fullAccess'
      ? stored
      : 'autoReview';
  });
  const [threadsCollapsed, setThreadsCollapsed] = useState(
    () => window.localStorage.getItem(CODEX_THREADS_COLLAPSED_STORAGE_KEY) === 'true',
  );
  const [instructionRules, setInstructionRules] = useState<InstructionRule[]>([]);
  const [skills, setSkills] = useState<CodexSkill[]>([]);
  const [skillQuery, setSkillQuery] = useState('');
  const [selectedSkill, setSelectedSkill] = useState<CodexSkill | null>(null);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillError, setSkillError] = useState('');
  const [goal, setGoal] = useState<ThreadGoal | null>(null);
  const [goalPolicy, setGoalPolicy] = useState<ManagedGoalPolicy>(readGoalPolicy);
  const [goalRuntime, setGoalRuntime] = useState<ManagedGoalRuntime | null>(null);
  const unavailableThreadIdsRef = useRef(new Set<string>());
  const viewRef = useRef<CodexStructuredState>(EMPTY_CODEX_STRUCTURED_STATE);
  const goalRef = useRef<ThreadGoal | null>(null);
  const goalPolicyRef = useRef(goalPolicy);
  const goalRuntimeRef = useRef<ManagedGoalRuntime | null>(null);
  const goalWatchdogBusyRef = useRef(false);
  const itemsScrollRef = useRef<HTMLDivElement>(null);
  const olderItemsScrollAnchorRef = useRef<{ height: number; top: number } | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const followLatestRef = useRef(true);
  const lastScrolledThreadIdRef = useRef<string | null>(null);
  const [cwd, setCwd] = useState(() => readCodexCwd(serverId, defaultCwd));
  const cwdRef = useRef(cwd);
  const [model, setModel] = useState(() => window.localStorage.getItem(CODEX_MODEL_STORAGE_KEY) || '');
  const [effort, setEffort] = useState(() => window.localStorage.getItem(CODEX_EFFORT_STORAGE_KEY) || '');
  const [models, setModels] = useState<string[]>(CODEX_MODEL_FALLBACKS);
  const [collaborationMode, setCollaborationMode] = useState('default');
  const [renderedItemLimit, setRenderedItemLimit] = useState(CODEX_DISPLAY_ITEM_BATCH);
  const previousNonPlanModeRef = useRef('default');
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
  const planCollaborationMode = useMemo(
    () => collaborationModes.find((candidate) => candidate.mode === 'plan') || null,
    [collaborationModes],
  );
  const nonPlanCollaborationModes = useMemo(
    () => collaborationModes.filter((candidate) => candidate.mode !== 'plan'),
    [collaborationModes],
  );
  const contextBudget = useMemo(
    () => (view.tokenUsage ? codexContextBudget(view.tokenUsage) : null),
    [view.tokenUsage],
  );
  const displayWindow = useMemo(
    () => codexDisplayWindow(view.items, renderedItemLimit),
    [renderedItemLimit, view.items],
  );
  const { visibleItems, hiddenItemCount } = displayWindow;
  const displayEntries = useMemo(() => groupCodexActivity(visibleItems), [visibleItems]);
  const runtimeStatusLabel = connected ? runtime?.status || 'connecting' : 'disconnected';
  const visibleSkills = useMemo(() => {
    const query = skillQuery.trim().toLowerCase();
    if (!query) return skills;
    return skills.filter((skill) => [
      skill.name,
      skill.displayName,
      skill.description,
      skill.shortDescription,
      skill.path,
    ].some((value) => value.toLowerCase().includes(query)));
  }, [skillQuery, skills]);

  useEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId]);

  useEffect(() => {
    cwdRef.current = cwd;
  }, [cwd]);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    goalRef.current = goal;
  }, [goal]);

  useEffect(() => {
    goalPolicyRef.current = goalPolicy;
    window.localStorage.setItem(CODEX_GOAL_POLICY_STORAGE_KEY, JSON.stringify(goalPolicy));
  }, [goalPolicy]);

  useEffect(() => {
    goalRuntimeRef.current = goalRuntime;
    if (selectedThreadId) rememberGoalRuntime(serverId, selectedThreadId, goalRuntime);
  }, [goalRuntime, selectedThreadId, serverId]);

  useEffect(() => {
    if (!goal || goal.status !== 'active' || !goalRuntime || !selectedThreadId) return;
    const timer = window.setInterval(() => {
      const runtimeState = goalRuntimeRef.current;
      const activeGoal = goalRef.current;
      const client = clientRef.current;
      if (!runtimeState || activeGoal?.status !== 'active' || !client) return;
      const elapsedMinutes = (Date.now() - runtimeState.startedAt) / 60_000;
      if (elapsedMinutes < goalPolicyRef.current.maxMinutes || goalWatchdogBusyRef.current) return;

      goalWatchdogBusyRef.current = true;
      const stoppedRuntime = {
        ...runtimeState,
        stopReason: `The managed Goal reached its ${goalPolicyRef.current.maxMinutes}-minute safety limit.`,
        nextStep: 'Review the latest checkpoint and explicitly resume with more time if continued work is appropriate.',
      };
      goalRuntimeRef.current = stoppedRuntime;
      setGoalRuntime(stoppedRuntime);
      void (async () => {
        try {
          const activeView = viewRef.current;
          if (activeView.turnId && /progress|running/i.test(activeView.turnStatus)) {
            await client.call('turn/interrupt', {
              threadId: selectedThreadId,
              turnId: activeView.turnId,
            }).catch(() => undefined);
          }
          const response = await client.call<ThreadGoalResponse>('thread/goal/set', {
            threadId: selectedThreadId,
            status: 'paused',
          });
          goalRef.current = response.goal || activeGoal;
          setGoal(response.goal || activeGoal);
        } catch (timerError) {
          setError(timerError instanceof Error ? timerError.message : 'Goal time limit could not pause the run');
        } finally {
          goalWatchdogBusyRef.current = false;
        }
      })();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [goal, goalRuntime, selectedThreadId]);

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

  useLayoutEffect(() => {
    const element = itemsScrollRef.current;
    const anchor = olderItemsScrollAnchorRef.current;
    if (!element || !anchor) return;
    element.scrollTop = anchor.top + (element.scrollHeight - anchor.height);
    olderItemsScrollAnchorRef.current = null;
  }, [renderedItemLimit]);

  useEffect(() => {
    setRenderedItemLimit(CODEX_DISPLAY_ITEM_BATCH);
    olderItemsScrollAnchorRef.current = null;
  }, [view.threadId]);

  useEffect(() => {
    setCwd(readCodexCwd(serverId, defaultCwd));
    setInstructionRules([]);
    setSkills([]);
    setSelectedSkill(null);
    setSkillError('');
    return subscribeCodexCwd(serverId, setCwd);
  }, [defaultCwd, serverId]);

  useEffect(() => {
    if (model) window.localStorage.setItem(CODEX_MODEL_STORAGE_KEY, model);
    else window.localStorage.removeItem(CODEX_MODEL_STORAGE_KEY);
  }, [model]);

  useEffect(() => {
    window.localStorage.setItem(CODEX_REVIEW_PERMISSION_STORAGE_KEY, reviewPermissionMode);
  }, [reviewPermissionMode]);

  useEffect(() => {
    window.localStorage.setItem(
      CODEX_THREADS_COLLAPSED_STORAGE_KEY,
      String(threadsCollapsed),
    );
  }, [threadsCollapsed]);

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

  const refreshSkills = async (
    client: CodexAppServerSocket,
    forceReload = false,
    targetCwd = cwdRef.current,
  ) => {
    const normalizedCwd = targetCwd.trim() || '~';
    setSkillsLoading(true);
    setSkillError('');
    try {
      const response = await client.call<SkillsListResponse>('skills/list', {
        cwds: [normalizedCwd],
        forceReload,
      });
      const discovered = normalizeCodexSkills(response);
      setSkills(discovered);
      setSelectedSkill((current) => {
        if (!current) return null;
        return discovered.find((skill) =>
          (skill.path && skill.path === current.path) ||
          (!skill.path && skill.name === current.name),
        ) || null;
      });
    } catch (nextError) {
      setSkills([]);
      setSelectedSkill(null);
      setSkillError(nextError instanceof Error ? nextError.message : 'Unable to load Skills');
    } finally {
      setSkillsLoading(false);
    }
  };

  const selectSkill = (skill: CodexSkill) => {
    setSelectedSkill(skill.enabled ? skill : null);
    setSkillError('');
  };

  useEffect(() => {
    const client = clientRef.current;
    if (!client || runtime?.status !== 'ready') return;
    const timer = window.setTimeout(() => {
      void refreshSkills(client, false, cwd).catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [cwd, runtime?.status, serverId]);

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
      goalRef.current = null;
      return;
    }
    const response = await client.call<ThreadGoalResponse>('thread/goal/get', { threadId });
    const nextGoal = response.goal || null;
    goalRef.current = nextGoal;
    setGoal(nextGoal);
  };

  const refreshInstructionRules = async (
    client: CodexAppServerSocket,
    sources: unknown,
  ) => {
    const paths = Array.isArray(sources)
      ? sources.map((source) => String(source || '').trim()).filter(Boolean)
      : [];
    if (!paths.length) {
      setInstructionRules([]);
      return;
    }
    const loaded = await Promise.all(paths.map(async (path): Promise<InstructionRule | null> => {
      try {
        const response = await client.call<FsReadFileResponse>('fs/readFile', { path });
        const content = response.dataBase64 ? decodeBase64Text(response.dataBase64).trim() : '';
        return content ? { path, content } : null;
      } catch {
        return null;
      }
    }));
    setInstructionRules(loaded.filter((rule): rule is InstructionRule => Boolean(rule)));
  };

  const forgetUnavailableThread = (threadId: string) => {
    unavailableThreadIdsRef.current.add(threadId);
    selectedThreadIdRef.current = '';
    setThreads((current) => current.filter((thread) => thread.id !== threadId));
    setSelectedThreadId('');
    setView(EMPTY_CODEX_STRUCTURED_STATE);
    viewRef.current = EMPTY_CODEX_STRUCTURED_STATE;
    setGoalRuntime(null);
    goalRuntimeRef.current = null;
    setInstructionRules([]);
  };

  const startNewThreadDraft = () => {
    selectedThreadIdRef.current = '';
    setSelectedThreadId('');
    setView(EMPTY_CODEX_STRUCTURED_STATE);
    viewRef.current = EMPTY_CODEX_STRUCTURED_STATE;
    setApprovals([]);
    setGoal(null);
    goalRef.current = null;
    setGoalRuntime(null);
    goalRuntimeRef.current = null;
    setInstructionRules([]);
    setError('');
  };

  const focusPromptWithText = (text: string) => {
    setDraft(text);
    window.requestAnimationFrame(() => {
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(text.length, text.length);
    });
  };

  const startNewTaskFromText = (text: string) => {
    if (!text.trim()) return;
    startNewThreadDraft();
    focusPromptWithText(text.trim());
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
      const resumedView = structuredStateFromThread(resumed, readTokenUsage(serverId, resumed.id));
      viewRef.current = resumedView;
      setView(resumedView);
      const savedRuntime = readGoalRuntime(serverId, resumed.id);
      goalRuntimeRef.current = savedRuntime;
      setGoalRuntime(savedRuntime);
      await Promise.all([
        refreshGoal(client, resumed.id).catch(() => setGoal(null)),
        refreshInstructionRules(client, response.instructionSources).catch(() => {
          setInstructionRules([]);
        }),
      ]);
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
    if (!serverId || !connected) {
      clientRef.current = null;
      setRuntime(serverId ? {
        key: serverId,
        status: 'stopped',
        detail: 'Connect SSH to start Codex app-server.',
        sequence: 0,
      } : null);
      setBusy(false);
      setApprovals([]);
      setError('');
      return;
    }
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
                  const resumedView = structuredStateFromThread(
                    response.thread,
                    readTokenUsage(serverId, response.thread.id),
                  );
                  viewRef.current = resumedView;
                  setView(resumedView);
                  const savedRuntime = readGoalRuntime(serverId, response.thread.id);
                  goalRuntimeRef.current = savedRuntime;
                  setGoalRuntime(savedRuntime);
                  void refreshGoal(client, response.thread.id).catch(() => undefined);
                  void refreshInstructionRules(client, response.instructionSources).catch(() => {
                    setInstructionRules([]);
                  });
                }
              })
              .catch((resumeError) => {
                if (isMissingRolloutError(resumeError)) forgetUnavailableThread(threadId);
              });
          }
        }
      } else if (message.type === 'event') {
        if (message.event.method === 'skills/changed') {
          void refreshSkills(client, true).catch(() => undefined);
        }
        const currentView = viewRef.current;
        const nextView = reduceCodexRuntimeEvent(currentView, message.event);
        viewRef.current = nextView;
        setView(nextView);
        if (nextView.tokenUsage && nextView.tokenUsage !== currentView.tokenUsage) {
          rememberTokenUsage(
            serverId,
            nextView.threadId || message.event.threadId || '',
            nextView.tokenUsage,
          );
        }
        if (message.event.method === 'turn/completed') {
          const completedTurnId = nextView.turnId;
          setBusy(false);
          void refreshThreads(client).catch(() => undefined);
          const threadId = selectedThreadIdRef.current;
          if (threadId) {
            void (async () => {
              try {
                const response = await client.call<ThreadGoalResponse>('thread/goal/get', { threadId });
                const latestGoal = response.goal || null;
                goalRef.current = latestGoal;
                setGoal(latestGoal);
                const currentRuntime = goalRuntimeRef.current;
                if (latestGoal?.status !== 'active' || !currentRuntime || goalWatchdogBusyRef.current) return;

                let nextRuntime = advanceManagedGoalRuntime(
                  currentRuntime,
                  goalPolicyRef.current,
                  nextView.items,
                );
                const nextContextBudget = nextView.tokenUsage
                  ? codexContextBudget(nextView.tokenUsage)
                  : null;
                if (nextContextBudget && nextContextBudget.remainingPercent <= 15) {
                  nextRuntime = {
                    ...nextRuntime,
                    stopReason: `Only ${nextContextBudget.remainingPercent}% of the usable context window remains.`,
                    nextStep: 'Use Fresh task to continue from the saved checkpoint with the same cwd and a clean context.',
                  };
                } else if (
                  nextContextBudget && nextContextBudget.remainingPercent <= 30 &&
                  !nextRuntime.checkpoint
                ) {
                  nextRuntime = {
                    ...nextRuntime,
                    checkpoint: `Context warning: ${nextContextBudget.remainingPercent}% remains.\nTurns completed: ${nextRuntime.turnsCompleted}`,
                  };
                }
                goalRuntimeRef.current = nextRuntime;
                setGoalRuntime(nextRuntime);
                rememberGoalRuntime(serverId, threadId, nextRuntime);
                if (!nextRuntime.stopReason) return;

                goalWatchdogBusyRef.current = true;
                const paused = await client.call<ThreadGoalResponse>('thread/goal/set', {
                  threadId,
                  status: 'paused',
                });
                goalRef.current = paused.goal || latestGoal;
                setGoal(paused.goal || latestGoal);

                const activeView = viewRef.current;
                if (
                  activeView.turnId && activeView.turnId !== completedTurnId &&
                  /progress|running/i.test(activeView.turnStatus)
                ) {
                  await client.call('turn/interrupt', {
                    threadId,
                    turnId: activeView.turnId,
                  }).catch(() => undefined);
                }

                if (goalHasTokensRemaining(latestGoal)) {
                  setBusy(true);
                  const report = await client.call<{ turn?: { id?: string; status?: string } }>(
                    'turn/start',
                    {
                      threadId,
                      clientUserMessageId: crypto.randomUUID(),
                      input: [{
                        type: 'text',
                        text: [
                          'CozyPad paused the managed Goal because its no-progress or safety limit was reached.',
                          `Controller reason: ${nextRuntime.stopReason}`,
                          'Do not resume implementation in this turn. Using evidence already present in this thread, reply with exactly these sections:',
                          'Why progress cannot continue',
                          'Evidence',
                          'Next action',
                          'Make the next action concrete enough for the user to perform or approve.',
                        ].join('\n'),
                        text_elements: [],
                      }],
                    },
                  );
                  viewRef.current = {
                    ...viewRef.current,
                    turnId: String(report.turn?.id || viewRef.current.turnId),
                    turnStatus: String(report.turn?.status || 'inProgress'),
                  };
                  setView(viewRef.current);
                }
              } catch (watchdogError) {
                setBusy(false);
                setError(watchdogError instanceof Error
                  ? `Goal watchdog: ${watchdogError.message}`
                  : 'Goal watchdog could not pause the Goal');
              } finally {
                goalWatchdogBusyRef.current = false;
              }
            })();
          }
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
  }, [connected, serverId]);

  const createThread = async (): Promise<string> => {
    const client = clientRef.current;
    if (!client) throw new Error('Codex app-server is not connected');
    const permissions = reviewPermissionSettings(reviewPermissionMode);
    const response = await client.call<ThreadResponse>('thread/start', {
      cwd,
      model: model || undefined,
      approvalPolicy: permissions.approvalPolicy,
      approvalsReviewer: permissions.approvalsReviewer,
      sandbox: permissions.sandbox,
      config: effort ? { model_reasoning_effort: effort } : undefined,
      collaborationMode: activeCollaborationMode,
    });
    const thread = response.thread;
    if (!thread?.id) throw new Error('Codex did not return a thread id');
    await refreshInstructionRules(client, response.instructionSources);
    setThreads((current) => [thread, ...current.filter((candidate) => candidate.id !== thread.id)]);
    setSelectedThreadId(thread.id);
    const nextView = structuredStateFromThread(thread);
    viewRef.current = nextView;
    setView(nextView);
    return thread.id;
  };

  const runTurn = async (text: string, goalObjective = '') => {
    const client = clientRef.current;
    if (!text || !client || busy) return;
    setBusy(true);
    setError('');
    try {
      let threadId = selectedThreadId || (await createThread());
      const managedObjective = goalObjective
        ? buildManagedGoalObjective(goalObjective, goalPolicy)
        : '';
      if (goalObjective) {
        const goalResponse = await client.call<ThreadGoalResponse>('thread/goal/set', {
          threadId,
          objective: managedObjective,
          status: 'active',
          tokenBudget: goalPolicy.tokenBudget,
        });
        const nextGoal = goalResponse.goal || null;
        goalRef.current = nextGoal;
        setGoal(nextGoal);
        const nextRuntime = createManagedGoalRuntime(viewRef.current.items);
        goalRuntimeRef.current = nextRuntime;
        setGoalRuntime(nextRuntime);
        rememberGoalRuntime(serverId, threadId, nextRuntime);
      }
      const permissions = reviewPermissionSettings(reviewPermissionMode);
      const skillForTurn = selectedSkill?.enabled ? selectedSkill : null;
      const startTurn = (targetThreadId: string) =>
        client.call<{ turn?: { id?: string; status?: string } }>('turn/start', {
          threadId: targetThreadId,
          clientUserMessageId: crypto.randomUUID(),
          input: buildCodexSkillTurnInput(managedObjective || text, skillForTurn),
          cwd,
          approvalPolicy: permissions.approvalPolicy,
          approvalsReviewer: permissions.approvalsReviewer,
          sandboxPolicy: permissions.sandboxPolicy,
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
      const nextView = {
        ...viewRef.current,
        threadId,
        turnId: String(response.turn?.id || viewRef.current.turnId),
        turnStatus: String(response.turn?.status || 'inProgress'),
      };
      viewRef.current = nextView;
      setView(nextView);
      if (skillForTurn) setSelectedSkill(null);
    } catch (nextError) {
      setBusy(false);
      setError(nextError instanceof Error ? nextError.message : 'Unable to start Codex turn');
    }
  };

  const sendTurn = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    await runTurn(text, goalMode ? text : '');
    if (goalMode) setGoalMode(false);
  };

  const selectCollaborationMode = (nextMode: string) => {
    if (nextMode !== 'plan') previousNonPlanModeRef.current = nextMode;
    setCollaborationMode(nextMode);
    const nextEffort = collaborationModes.find(
      (candidate) => candidate.mode === nextMode,
    )?.settings?.reasoning_effort;
    if (typeof nextEffort === 'string') setEffort(nextEffort);
  };

  const togglePlanMode = () => {
    if (collaborationMode === 'plan') {
      const fallbackMode = nonPlanCollaborationModes.some(
        (candidate) => candidate.mode === previousNonPlanModeRef.current,
      )
        ? previousNonPlanModeRef.current
        : nonPlanCollaborationModes[0]?.mode || 'default';
      selectCollaborationMode(fallbackMode);
      return;
    }
    selectCollaborationMode('plan');
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
      const nextGoal = response.goal || null;
      goalRef.current = nextGoal;
      setGoal(nextGoal);
      if (status === 'active' && goalRuntimeRef.current) {
        const resumedRuntime = {
          ...goalRuntimeRef.current,
          noProgressTurns: 0,
          stopReason: '',
          nextStep: '',
        };
        goalRuntimeRef.current = resumedRuntime;
        setGoalRuntime(resumedRuntime);
      }
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
      goalRef.current = null;
      setGoalRuntime(null);
      goalRuntimeRef.current = null;
      rememberGoalRuntime(serverId, selectedThreadId, null);
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

  const stopGoalNow = async () => {
    const client = clientRef.current;
    if (!client || !selectedThreadId || !goal) return;
    setError('');
    try {
      if (view.turnId && /progress|running/i.test(view.turnStatus)) {
        await client.call('turn/interrupt', {
          threadId: selectedThreadId,
          turnId: view.turnId,
        }).catch(() => undefined);
      }
      await updateGoalStatus('paused');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to stop Goal');
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
            {runtimeStatusLabel}
          </span>
          <button type="button" onClick={startNewThreadDraft} disabled={runtime?.status !== 'ready'}>
            New thread
          </button>
          <button type="button" onClick={onUseLegacy}>Legacy fallback</button>
        </div>
      </header>

      {error || view.error ? <div className="codex-app-error">{error || view.error}</div> : null}

      <div className="agent-panes legacy-codex-panes codex-app-layout">
        <aside
          className={`session-sidebar legacy-codex-sidebar codex-app-threads${
            threadsCollapsed ? ' collapsed' : ''
          }`}
        >
          <div className="codex-app-threads-header">
            {!threadsCollapsed ? <strong>Threads</strong> : null}
            <button
              type="button"
              className="codex-app-threads-toggle"
              aria-label={threadsCollapsed ? 'Expand Threads' : 'Collapse Threads'}
              aria-expanded={!threadsCollapsed}
              title={threadsCollapsed ? 'Expand Threads' : 'Collapse Threads'}
              onClick={() => setThreadsCollapsed((current) => !current)}
            >
              {threadsCollapsed ? '›' : '‹'}
            </button>
          </div>
          {!threadsCollapsed ? (
            <>
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
              {!visibleThreads.length ? (
                <p>{threads.length ? 'No matching thread.' : 'No saved thread yet.'}</p>
              ) : null}
            </>
          ) : null}
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
            {hiddenItemCount ? (
              <div className="codex-app-display-window" role="status">
                <span>{hiddenItemCount.toLocaleString()} earlier items are hidden to keep the browser responsive.</span>
                <button
                  type="button"
                  onClick={() => {
                    const element = itemsScrollRef.current;
                    if (element) {
                      olderItemsScrollAnchorRef.current = {
                        height: element.scrollHeight,
                        top: element.scrollTop,
                      };
                    }
                    followLatestRef.current = false;
                    setRenderedItemLimit((current) => Math.min(
                      view.items.length,
                      current + CODEX_DISPLAY_ITEM_BATCH,
                    ));
                  }}
                >
                  Load earlier
                </button>
              </div>
            ) : null}
            {displayEntries.map((entry) => entry.kind === 'activity' ? (
              <CodexActivityGroup
                key={entry.id}
                items={entry.items}
                serverId={serverId}
                onOpenFilesPath={onOpenFilesPath}
              />
            ) : (
              <CodexItemCard
                key={entry.item.id}
                item={entry.item}
                serverId={serverId}
                onOpenFilesPath={onOpenFilesPath}
                onOpenNewTask={startNewTaskFromText}
                onEditUserMessage={focusPromptWithText}
              />
            ))}
            {!view.items.length ? (
              <div className="codex-app-empty">
                {connected
                  ? 'Start a structured Codex thread on this server.'
                  : 'Connect SSH to start or resume a Codex thread.'}
              </div>
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
                ref={promptRef}
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
                placeholder={goalMode
                    ? 'Describe the outcome and success criteria for this goal…'
                    : selectedThreadId
                      ? 'Continue this Codex thread…'
                      : 'Start a Codex task…'}
                rows={3}
              />
              <button
                type="submit"
                disabled={
                  !draft.trim() || busy ||
                  runtime?.status !== 'ready'
                }
              >
                {busy ? 'Running…' : goalMode ? 'Start goal' : 'Send'}
              </button>
            </div>
            <div className="codex-app-composer-controls">
              {selectedSkill ? (
                <button
                  type="button"
                  className="codex-app-selected-skill"
                  title={`Remove $${selectedSkill.name} from the next prompt`}
                  onClick={() => setSelectedSkill(null)}
                >
                  ${selectedSkill.name} <span aria-hidden="true">×</span>
                </button>
              ) : null}
              <button
                type="button"
                className={`codex-app-mode-button${goalMode ? ' active' : ''}`}
                aria-pressed={goalMode}
                onClick={() => {
                  setGoalMode((current) => !current);
                }}
                disabled={busy || runtime?.status !== 'ready'}
              >
                ◎ Goal
              </button>
              {planCollaborationMode ? (
                <button
                  type="button"
                  className={`codex-app-mode-button${collaborationMode === 'plan' ? ' active' : ''}`}
                  aria-pressed={collaborationMode === 'plan'}
                  onClick={togglePlanMode}
                  disabled={busy || runtime?.status !== 'ready'}
                  title={collaborationMode === 'plan' ? 'Disable Plan mode' : 'Enable Plan mode'}
                >
                  ◇ Plan
                </button>
              ) : null}
              <label className="codex-app-review-permission">
                <span>Review</span>
                <select
                  value={reviewPermissionMode}
                  onChange={(event) => {
                    const nextMode = event.target.value as ReviewPermissionMode;
                    if (
                      nextMode === 'fullAccess' &&
                      !window.confirm(
                        'Full access lets Codex modify any file, run commands, and use the network without approval. Enable it?',
                      )
                    ) {
                      event.currentTarget.value = reviewPermissionMode;
                      return;
                    }
                    setReviewPermissionMode(nextMode);
                  }}
                  disabled={busy || runtime?.status !== 'ready'}
                >
                  {CODEX_REVIEW_PERMISSION_OPTIONS.map((option) => (
                    <option value={option.value} key={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
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
              {nonPlanCollaborationModes.length > 1 ? (
                <label>
                  <span>Mode</span>
                  <select
                    value={collaborationMode === 'plan'
                      ? previousNonPlanModeRef.current
                      : collaborationMode}
                    onChange={(event) => selectCollaborationMode(event.target.value)}
                  >
                    {nonPlanCollaborationModes.map((option) => (
                      <option value={option.mode} key={option.mode}>{option.mode}</option>
                    ))}
                  </select>
                </label>
              ) : !planCollaborationMode && collaborationModes.length === 1 ? (
                <button
                  type="button"
                  className="codex-app-mode-button active"
                  onClick={() => selectCollaborationMode(collaborationModes[0]?.mode || 'default')}
                  disabled={busy || runtime?.status !== 'ready'}
                  title="Activate collaboration mode"
                >
                  ◉ Mode · {collaborationModes[0]?.mode || 'default'}
                </button>
              ) : null}
              {goalMode ? <span className="codex-app-goal-hint">Goal mode enabled for the next prompt</span> : null}
            </div>
            {goalMode ? (
              <details className="codex-app-goal-safety">
                <summary>Goal safety</summary>
                <fieldset className="codex-app-goal-setup">
                  <legend className="sr-only">Goal safety controls</legend>
                  <label>
                    <span>Token budget</span>
                    <input
                      type="number" min={1_000} step={1_000} value={goalPolicy.tokenBudget}
                      onChange={(event) => setGoalPolicy((current) => normalizeManagedGoalPolicy({
                        ...current, tokenBudget: Number(event.target.value),
                      }))}
                    />
                  </label>
                  <label>
                    <span>Max minutes</span>
                    <input
                      type="number" min={1} value={goalPolicy.maxMinutes}
                      onChange={(event) => setGoalPolicy((current) => normalizeManagedGoalPolicy({
                        ...current, maxMinutes: Number(event.target.value),
                      }))}
                    />
                  </label>
                  <label>
                    <span>Max turns</span>
                    <input
                      type="number" min={1} value={goalPolicy.maxTurns}
                      onChange={(event) => setGoalPolicy((current) => normalizeManagedGoalPolicy({
                        ...current, maxTurns: Number(event.target.value),
                      }))}
                    />
                  </label>
                  <label>
                    <span>No progress turns</span>
                    <input
                      type="number" min={1} value={goalPolicy.noProgressLimit}
                      onChange={(event) => setGoalPolicy((current) => normalizeManagedGoalPolicy({
                        ...current, noProgressLimit: Number(event.target.value),
                      }))}
                    />
                  </label>
                  <label className="wide">
                    <span>Done when</span>
                    <textarea
                      rows={2} value={goalPolicy.successCriteria}
                      placeholder="Tests, measurements, or artifacts that prove completion"
                      onChange={(event) => setGoalPolicy((current) => ({
                        ...current, successCriteria: event.target.value,
                      }))}
                    />
                  </label>
                  <label className="wide">
                    <span>Constraints / do not change</span>
                    <textarea
                      rows={2} value={goalPolicy.constraints}
                      onChange={(event) => setGoalPolicy((current) => ({
                        ...current, constraints: event.target.value,
                      }))}
                    />
                  </label>
                  <label className="wide">
                    <span>Additional stop conditions</span>
                    <textarea
                      rows={2} value={goalPolicy.stopConditions}
                      onChange={(event) => setGoalPolicy((current) => ({
                        ...current, stopConditions: event.target.value,
                      }))}
                    />
                  </label>
                  <small className="wide">
                    If progress stalls, CozyPad pauses the Goal and asks Codex for the reason, evidence, and a concrete next action while tokens remain.
                  </small>
                </fieldset>
              </details>
            ) : null}
          </form>
        </main>

        <aside className="context-panel legacy-codex-context codex-app-context" tabIndex={0}>
          <h3>Context</h3>
          <dl>
            <dt>Agent</dt>
            <dd>Codex app-server</dd>
            <dt>Mode</dt>
            <dd>remote SSH server</dd>
            <dt>Review</dt>
            <dd>{reviewPermissionLabel(reviewPermissionMode)}</dd>
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
                disabled={!connected || !serverId || !cwd.trim()}
                onClick={() => {
                  if (serverId && cwd.trim()) onOpenFilesPath?.({ serverId, path: cwd.trim() });
                }}
              >
                File
              </button>
            </dd>
            <dt>Status</dt>
            <dd><span className={`chip chip-${runtime?.status === 'ready' ? 'ready' : 'disconnected'}`}>{runtimeStatusLabel}</span></dd>
          </dl>
          {instructionRules.length ? (
            <section className="codex-app-instruction-rules" aria-label="Personalized rules">
              <h3>Personalized rules</h3>
              {instructionRules.map((rule) => (
                <details key={rule.path}>
                  <summary title={rule.path}>
                    {rule.path.split(/[\\/]/).pop() || rule.path}
                  </summary>
                  <pre>{rule.content}</pre>
                </details>
              ))}
            </section>
          ) : null}
          <details className="codex-app-skill-manager">
            <summary>
              <span>Skills</span>
              <small>{skillsLoading ? 'Loading…' : `${skills.length} available`}</small>
            </summary>
            <div className="codex-app-skill-tools">
              <input
                type="search"
                value={skillQuery}
                onChange={(event) => setSkillQuery(event.target.value)}
                placeholder="Search Skills"
                aria-label="Search Skills"
              />
              <button
                type="button"
                onClick={() => {
                  const client = clientRef.current;
                  if (client) void refreshSkills(client, true);
                }}
                disabled={skillsLoading || runtime?.status !== 'ready'}
              >
                Refresh
              </button>
            </div>
            {selectedSkill ? (
              <div className="codex-app-skill-selected" role="status">
                <span><b>${selectedSkill.name}</b> applies to the next prompt.</span>
                <button type="button" onClick={() => setSelectedSkill(null)}>Clear</button>
              </div>
            ) : null}
            {skillError ? <p className="codex-app-skill-error" role="alert">{skillError}</p> : null}
            <div className="codex-app-skill-list">
              {visibleSkills.map((skill) => {
                const active = Boolean(
                  selectedSkill && (
                    (skill.path && selectedSkill.path === skill.path) ||
                    (!skill.path && selectedSkill.name === skill.name)
                  ),
                );
                return (
                  <article
                    className={active ? 'active' : ''}
                    key={`${skill.cwd}:${skill.path || skill.name}`}
                    title={skill.path || skill.description}
                  >
                    <button
                      type="button"
                      className="codex-app-skill-use"
                      aria-pressed={active}
                      disabled={!skill.enabled}
                      onClick={() => selectSkill(skill)}
                    >
                      <span>
                        <strong>{skill.displayName}</strong>
                        <small>${skill.name}</small>
                      </span>
                      <p>{skill.shortDescription || skill.description || 'No description provided.'}</p>
                      <span className="codex-app-skill-meta">
                        <em>{skill.enabled ? 'Enabled' : 'Disabled'}</em>
                        {skill.dependencies.length ? (
                          <small>{skill.dependencies.length} dependencies</small>
                        ) : null}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="codex-app-skill-file"
                      disabled={!connected || !serverId || !skill.path || !onOpenFilesPath}
                      title={skill.path ? `Open ${skill.path} in File` : 'SKILL.md path unavailable'}
                      onClick={() => {
                        if (serverId && skill.path) {
                          onOpenFilesPath?.({ serverId, path: skill.path });
                        }
                      }}
                    >
                      File
                    </button>
                  </article>
                );
              })}
              {!skillsLoading && !visibleSkills.length ? (
                <p className="hint">No Skills match this cwd and search.</p>
              ) : null}
            </div>
          </details>
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
                <dt>Usage</dt><dd>{Number(goal.tokensUsed || 0).toLocaleString()} / {Number(goal.tokenBudget || 0).toLocaleString()} tokens · {Number(goal.timeUsedSeconds || 0)}s</dd>
                {goalRuntime ? (
                  <>
                    <dt>Turns</dt><dd>{goalRuntime.turnsCompleted} / {goalPolicy.maxTurns}</dd>
                    <dt>No progress</dt><dd>{goalRuntime.noProgressTurns} / {goalPolicy.noProgressLimit}</dd>
                  </>
                ) : null}
              </dl>
            ) : <p className="hint">No active goal on this thread.</p>}
            {goalRuntime?.stopReason ? (
              <div className="codex-app-goal-stop-reason" role="status">
                <strong>Paused by safety control</strong>
                <p>{goalRuntime.stopReason}</p>
                <p><b>Next:</b> {goalRuntime.nextStep}</p>
              </div>
            ) : null}
            {goal && contextBudget && contextBudget.remainingPercent <= 30 ? (
              <div className="codex-app-goal-context-warning" role="status">
                Context remaining: {contextBudget.remainingPercent}%.
                {contextBudget.remainingPercent <= 15
                  ? ' CozyPad will pause and recommend a fresh task.'
                  : ' A checkpoint will be prepared before the context becomes fragile.'}
              </div>
            ) : null}
            {goalRuntime?.checkpoint ? (
              <details className="codex-app-goal-checkpoint">
                <summary>Latest checkpoint</summary>
                <pre>{goalRuntime.checkpoint}</pre>
              </details>
            ) : null}
            <div className="codex-app-goal-actions">
              <button type="button" onClick={() => void refreshGoal(clientRef.current!, selectedThreadId)} disabled={!selectedThreadId || runtime?.status !== 'ready'}>Refresh</button>
              <button type="button" onClick={() => void updateGoalStatus('paused')} disabled={!goal || goal.status !== 'active'}>Pause after turn</button>
              <button type="button" className="danger" onClick={() => void stopGoalNow()} disabled={!goal || goal.status !== 'active'}>Stop now</button>
              <button type="button" onClick={() => void updateGoalStatus('active')} disabled={!goal || goal.status !== 'paused'}>Resume</button>
              <button
                type="button"
                onClick={() => startNewTaskFromText([
                  'Continue this work in a fresh task using the checkpoint below.',
                  goalRuntime?.checkpoint || goal?.objective || '',
                  goalRuntime?.stopReason ? `Previous stop reason: ${goalRuntime.stopReason}` : '',
                ].filter(Boolean).join('\n\n'))}
                disabled={!goalRuntime?.checkpoint}
              >Fresh task</button>
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
