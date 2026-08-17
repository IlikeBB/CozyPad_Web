import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { ConnectionProfile } from '@cozypad/contracts';
import { userStorage } from '../../platform/userStorage';
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
import {
  CODEX_PASTED_TEXT_MAX_ATTACHMENTS,
  CODEX_PASTED_TEXT_MAX_BYTES,
  createPastedTextAttachment,
  pastedTextFallbackPrompt,
  pastedTextInputItems,
  shouldConvertPastedText,
  type CodexPastedTextAttachment,
} from './codexPastedText';

type ThreadListResponse = { data?: CodexThreadSummary[] };
type ThreadResponse = {
  thread?: CodexThreadSummary;
  instructionSources?: string[];
  model?: string;
  modelProvider?: string;
  reasoningEffort?: string | null;
};
type ConfirmedThreadRuntime = {
  threadId: string;
  model: string;
  modelProvider: string;
  effort: string;
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
type ThreadContextMenu = {
  thread: CodexThreadSummary;
  x: number;
  y: number;
};
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
    const value = userStorage.getItem(tokenUsageStorageKey(serverId, threadId));
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
  userStorage.setItem(
    tokenUsageStorageKey(serverId, threadId),
    JSON.stringify(tokenUsage),
  );
}

function readGoalPolicy(): ManagedGoalPolicy {
  try {
    const value = userStorage.getItem(CODEX_GOAL_POLICY_STORAGE_KEY);
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
    const value = userStorage.getItem(goalRuntimeStorageKey(serverId, threadId));
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
  if (runtime) userStorage.setItem(key, JSON.stringify(runtime));
  else userStorage.removeItem(key);
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

function markdownCodeBlock(value: unknown, language = ''): string {
  const text = String(value || '').trimEnd();
  if (!text) return '';
  const longestFence = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, longestFence + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}

export function readableItemText(item: CodexThreadItem): string {
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
  if (item.type === 'commandExecution') {
    const exitCode = item.exitCode ?? item.exit_code;
    return [
      item.command ? `**Command**\n\n${markdownCodeBlock(item.command, 'shell')}` : '',
      item.cwd ? `**Working directory:** ${String(item.cwd)}` : '',
      item.status ? `**Status:** ${String(item.status)}` : '',
      exitCode !== undefined && exitCode !== null ? `**Exit code:** ${String(exitCode)}` : '',
      item.aggregatedOutput
        ? `**Output**\n\n${markdownCodeBlock(item.aggregatedOutput, 'text')}`
        : '',
    ].filter(Boolean).join('\n\n');
  }
  if (item.type === 'fileChange') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    return changes.map((change) => {
      const value = change && typeof change === 'object'
        ? change as Record<string, unknown>
        : {};
      const operation = String(value.kind || value.type || value.status || 'Changed');
      const path = String(value.path || value.filePath || value.file || '').trim();
      return path ? `${operation}: ${path}` : operation;
    }).filter(Boolean).join('\n');
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

export function visibleCodexActivityItems(items: CodexThreadItem[]): CodexThreadItem[] {
  return items.filter((item) => {
    if (item.type === 'commandExecution') {
      return Boolean(
        String(item.command || '').trim()
        || String(item.cwd || '').trim()
        || String(item.status || '').trim()
        || item.exitCode !== undefined
        || item.exit_code !== undefined
        || String(item.aggregatedOutput || '').trim(),
      );
    }
    if (item.type === 'reasoning') {
      const summary = Array.isArray(item.summary) ? item.summary : [];
      const content = Array.isArray(item.content) ? item.content : [];
      return Boolean(
        String(item.text || '').trim()
        || summary.some((entry) => String(entry || '').trim())
        || content.some((entry) => {
          const value = entry && typeof entry === 'object'
            ? entry as Record<string, unknown>
            : {};
          return Boolean(String(value.text || value.summary || '').trim());
        }),
      );
    }
    if (item.type === 'fileChange') return Array.isArray(item.changes) && item.changes.length > 0;
    if (item.type === 'mcpToolCall') {
      return Boolean(item.server || item.arguments || item.result || item.error);
    }
    if (item.type === 'webSearch') return Boolean(item.query || item.results);
    if (item.type === 'collabToolCall') return Boolean(item.prompt || item.agentStatus);
    if (item.type === 'enteredReviewMode' || item.type === 'exitedReviewMode') return true;
    return Boolean(String(item.text || '').trim());
  });
}

const CODEX_ACTIVITY_SUMMARY_CHARS = 220;
const CODEX_FOLLOW_LATEST_THRESHOLD_PX = 48;

function compactActivitySummary(value: unknown): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= CODEX_ACTIVITY_SUMMARY_CHARS) return text;
  return `${text.slice(0, CODEX_ACTIVITY_SUMMARY_CHARS - 1)}…`;
}

export function codexActivitySummary(item: CodexThreadItem): string {
  if (item.type === 'commandExecution') {
    const command = compactActivitySummary(item.command);
    const status = compactActivitySummary(item.status);
    if (command && status) return compactActivitySummary(`${status} · ${command}`);
    return command || status || 'Command output';
  }
  return compactActivitySummary(readableItemText(item));
}

export function codexActivityKindLabel(item: CodexThreadItem, running = false): string {
  if (item.type === 'commandExecution') return running ? 'Running command' : 'Command';
  if (item.type === 'fileChange') return running ? 'Editing files' : 'File changes';
  if (item.type === 'reasoning') return running ? 'Thinking' : 'Reasoning';
  if (item.type === 'webSearch') return running ? 'Searching' : 'Web search';
  if (item.type === 'mcpToolCall') return running ? 'Using tool' : 'Tool call';
  if (item.type === 'collabToolCall') return running ? 'Coordinating' : 'Agent activity';
  if (item.type === 'enteredReviewMode' || item.type === 'exitedReviewMode') return 'Review';
  return running ? 'Working' : 'Codex activity';
}

export type CodexExecutionSnapshot = {
  label: string;
  detail: string;
  tone: 'idle' | 'running' | 'waiting' | 'success' | 'error' | 'offline';
  active: boolean;
  commands: number;
  files: number;
  tools: number;
};

export function codexExecutionSnapshot({
  items,
  turnStatus,
  busy,
  approvalCount,
  connected,
  runtimeStatus,
}: {
  items: CodexThreadItem[];
  turnStatus: string;
  busy: boolean;
  approvalCount: number;
  connected: boolean;
  runtimeStatus?: CodexAppServerRuntimeStatus['status'];
}): CodexExecutionSnapshot {
  let startIndex = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.type === 'userMessage') {
      startIndex = index;
      break;
    }
  }
  const roundItems = items.slice(startIndex + 1);
  const activityItems = visibleCodexActivityItems(roundItems);
  const latest = activityItems[activityItems.length - 1];
  const commands = roundItems.filter((item) => item.type === 'commandExecution').length;
  const files = roundItems
    .filter((item) => item.type === 'fileChange')
    .reduce((count, item) => count + (Array.isArray(item.changes) ? item.changes.length : 0), 0);
  const tools = roundItems.filter((item) =>
    item.type === 'mcpToolCall' || item.type === 'webSearch' || item.type === 'collabToolCall').length;
  const active = busy || /progress|running/i.test(turnStatus);
  const base = { active, commands, files, tools };

  if (!connected) {
    return { ...base, active: false, label: 'SSH disconnected', detail: 'Connect SSH before starting Codex.', tone: 'offline' };
  }
  if (runtimeStatus !== 'ready') {
    return {
      ...base,
      active: false,
      label: runtimeStatus === 'reconnecting' ? 'Runtime reconnecting' : 'Runtime unavailable',
      detail: 'Codex app-server is not ready to accept work.',
      tone: runtimeStatus === 'reconnecting' || runtimeStatus === 'starting' ? 'waiting' : 'error',
    };
  }
  if (approvalCount > 0) {
    return {
      ...base,
      label: 'Waiting for approval',
      detail: `${approvalCount} request${approvalCount === 1 ? '' : 's'} need your response.`,
      tone: 'waiting',
    };
  }
  if (/fail|error/i.test(turnStatus)) {
    return { ...base, active: false, label: 'Turn failed', detail: 'Open the latest activity for the error details.', tone: 'error' };
  }
  if (/interrupt|cancel/i.test(turnStatus)) {
    return { ...base, active: false, label: 'Interrupted', detail: 'The current Codex turn was stopped.', tone: 'error' };
  }
  if (!active) {
    return {
      ...base,
      label: /complete|success/i.test(turnStatus) ? 'Turn completed' : 'Ready',
      detail: latest ? `Last confirmed: ${codexActivitySummary(latest)}` : 'No Codex turn is running.',
      tone: /complete|success/i.test(turnStatus) ? 'success' : 'idle',
    };
  }
  if (!latest) {
    return { ...base, label: 'Starting Codex', detail: 'Waiting for the first app-server event.', tone: 'running' };
  }
  if (latest.type === 'commandExecution') {
    const commandRunning = /progress|running/i.test(String(latest.status || ''));
    return {
      ...base,
      label: commandRunning ? 'Running command' : 'Command finished',
      detail: compactActivitySummary(latest.command || latest.aggregatedOutput || 'Command activity'),
      tone: 'running',
    };
  }
  if (latest.type === 'fileChange') {
    return { ...base, label: 'Files changed', detail: codexActivitySummary(latest), tone: 'running' };
  }
  return {
    ...base,
    label: codexActivityKindLabel(latest, true),
    detail: codexActivitySummary(latest) || 'Codex is working.',
    tone: 'running',
  };
}

function formatCodexDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes ? `${minutes}:${String(remainder).padStart(2, '0')}` : `${remainder}s`;
}

const CodexExecutionStrip = memo(function CodexExecutionStrip({
  snapshot,
  runtimeStatus,
  turnStartedAt,
  lastActivityAt,
}: {
  snapshot: CodexExecutionSnapshot;
  runtimeStatus?: CodexAppServerRuntimeStatus['status'];
  turnStartedAt: number | null;
  lastActivityAt: number | null;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!snapshot.active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [snapshot.active, lastActivityAt, turnStartedAt]);
  const eventAge = lastActivityAt === null ? null : Math.max(0, now - lastActivityAt);
  const elapsed = turnStartedAt === null ? null : Math.max(0, now - turnStartedAt);

  return (
    <section className="codex-execution-strip" data-tone={snapshot.tone} aria-live="polite">
      <span className="codex-execution-indicator" aria-hidden="true" />
      <div className="codex-execution-current">
        <strong>{snapshot.label}</strong>
        <span title={snapshot.detail}>{snapshot.detail}</span>
      </div>
      <div className="codex-execution-metrics">
        <span title="Codex app-server connection">CLI · {runtimeStatus || 'stopped'}</span>
        {elapsed !== null ? <span title="Elapsed turn time">Time · {formatCodexDuration(elapsed)}</span> : null}
        {eventAge !== null ? (
          <span title="Time since the latest app-server event">
            Event · {eventAge < 1_000 ? 'now' : `${formatCodexDuration(eventAge)} ago`}
          </span>
        ) : null}
        <span title="Confirmed activity in this turn">
          {snapshot.commands} cmd · {snapshot.files} files · {snapshot.tools} tools
        </span>
      </div>
    </section>
  );
});

export type CodexDiffLineKind = 'addition' | 'deletion' | 'metadata' | 'context';

export function codexDiffLineKind(line: string): CodexDiffLineKind {
  if (
    line.startsWith('+++')
    || line.startsWith('---')
    || line.startsWith('@@')
    || line.startsWith('diff ')
    || line.startsWith('index ')
    || line.startsWith('\\ No newline')
  ) return 'metadata';
  if (line.startsWith('+')) return 'addition';
  if (line.startsWith('-')) return 'deletion';
  return 'context';
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

const CodexActivityGroup = memo(function CodexActivityGroup({
  items,
  serverId,
  running,
  onOpenFilesPath,
}: {
  items: CodexThreadItem[];
  serverId: string;
  running: boolean;
  onOpenFilesPath?: (target: { serverId: string; path: string }) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);
  const followFeedLatestRef = useRef(true);
  const markdownComponents = useMemo(
    () => createMarkdownComponents(onOpenFilesPath, { serverId }),
    [onOpenFilesPath, serverId],
  );
  const visibleItems = useMemo(() => visibleCodexActivityItems(items), [items]);
  const latestItem = visibleItems[visibleItems.length - 1];
  const activityLabel = latestItem
    ? codexActivityKindLabel(latestItem, running)
    : running ? 'Working' : 'Codex activity';
  let latestText = 'Working';
  for (let index = visibleItems.length - 1; index >= 0; index -= 1) {
    const summary = codexActivitySummary(visibleItems[index]!);
    if (!summary) continue;
    latestText = summary;
    break;
  }

  useLayoutEffect(() => {
    const feed = feedRef.current;
    if (!expanded || !feed || !followFeedLatestRef.current) return;
    const bottom = Math.max(0, feed.scrollHeight - feed.clientHeight);
    if (Math.abs(feed.scrollTop - bottom) > 1) feed.scrollTop = bottom;
  }, [expanded, visibleItems]);

  if (!visibleItems.length) return null;

  return (
    <section
      className="codex-app-activity-group"
      data-open={expanded ? 'true' : 'false'}
      data-running={running ? 'true' : 'false'}
    >
      <button
        type="button"
        className="codex-app-activity-toggle"
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} Codex activity: ${activityLabel}`}
        onClick={() => setExpanded((current) => {
          if (!current) followFeedLatestRef.current = true;
          return !current;
        })}
      >
        <span className="codex-app-activity-chevron" aria-hidden="true">›</span>
        <span className="codex-app-activity-state">
          <span className="codex-app-activity-dot" aria-hidden="true" />
          <strong>{activityLabel}</strong>
        </span>
        <code>{latestText}</code>
        <small title={`${visibleItems.length} activity updates`}>{visibleItems.length}</small>
      </button>
      {expanded ? <div
        className="codex-app-activity-feed"
        ref={feedRef}
        onWheel={(event) => {
          if (event.deltaY < 0) followFeedLatestRef.current = false;
        }}
        onScroll={(event) => {
          const feed = event.currentTarget;
          followFeedLatestRef.current =
            feed.scrollHeight - feed.scrollTop - feed.clientHeight
              < CODEX_FOLLOW_LATEST_THRESHOLD_PX;
        }}
      >
        {visibleItems.map((item) => (
          <CodexActivityEntry
            key={item.id}
            item={item}
            serverId={serverId}
            markdownComponents={markdownComponents}
            onOpenFilesPath={onOpenFilesPath}
          />
        ))}
      </div> : null}
    </section>
  );
}, (previous, next) => (
  previous.serverId === next.serverId
  && previous.running === next.running
  && previous.onOpenFilesPath === next.onOpenFilesPath
  && previous.items.length === next.items.length
  && previous.items.every((item, index) => item === next.items[index])
));

const CodexActivityEntry = memo(function CodexActivityEntry({
  item,
  serverId,
  markdownComponents,
  onOpenFilesPath,
}: {
  item: CodexThreadItem;
  serverId: string;
  markdownComponents: ReturnType<typeof createMarkdownComponents>;
  onOpenFilesPath?: (target: { serverId: string; path: string }) => void;
}) {
  if (item.type === 'commandExecution') {
    return <CodexCommandActivityEntry item={item} />;
  }
  if (item.type === 'fileChange') {
    return (
      <CodexFileChangeActivityEntry
        item={item}
        serverId={serverId}
        onOpenFilesPath={onOpenFilesPath}
      />
    );
  }
  return (
    <CodexMarkdownActivityEntry
      item={item}
      serverId={serverId}
      markdownComponents={markdownComponents}
    />
  );
});

function CodexMarkdownActivityEntry({
  item,
  serverId,
  markdownComponents,
}: {
  item: CodexThreadItem;
  serverId: string;
  markdownComponents: ReturnType<typeof createMarkdownComponents>;
}) {
  const [showFullText, setShowFullText] = useState(false);
  const text = readableItemText(item);
  const displayedText = codexDisplayText(text, showFullText);

  return (
    <section className="codex-app-activity-entry">
      <header>{item.type === 'agentMessage' ? 'Commentary' : itemTitle(item)}</header>
      <div className="legacy-codex-markdown">
        <ReactMarkdown components={markdownComponents}>
          {linkifyRemotePathLines(displayedText, serverId)}
        </ReactMarkdown>
      </div>
      {text.length > CODEX_DISPLAY_TEXT_PREVIEW_CHARS ? (
        <button
          type="button"
          className="codex-app-expand-content"
          onClick={() => setShowFullText((current) => !current)}
        >
          {showFullText ? 'Show less' : 'Show full output'}
        </button>
      ) : null}
    </section>
  );
}

function CodexCommandActivityEntry({ item }: { item: CodexThreadItem }) {
  const [showFullOutput, setShowFullOutput] = useState(false);
  const output = String(item.aggregatedOutput || '');
  const displayedOutput = codexDisplayText(output, showFullOutput);
  const exitCode = item.exitCode ?? item.exit_code;

  return (
    <section className="codex-app-activity-entry codex-app-command-activity">
      <header>Command</header>
      <div className="codex-app-activity-detail">
        <div className="codex-app-command-head">
          <code>{String(item.command || 'Command')}</code>
          {item.status ? <span>{String(item.status)}</span> : null}
        </div>
        {item.cwd || exitCode !== undefined ? (
          <div className="codex-app-command-meta">
            {item.cwd ? <small>cwd · {String(item.cwd)}</small> : null}
            {exitCode !== undefined && exitCode !== null
              ? <small>exit · {String(exitCode)}</small>
              : null}
          </div>
        ) : null}
        {displayedOutput ? <pre>{displayedOutput}</pre> : null}
        {output.length > CODEX_DISPLAY_TEXT_PREVIEW_CHARS ? (
          <button
            type="button"
            className="codex-app-expand-content"
            onClick={() => setShowFullOutput((current) => !current)}
          >
            {showFullOutput ? 'Show less' : 'Show full output'}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function CodexFileChangeActivityEntry({
  item,
  serverId,
  onOpenFilesPath,
}: {
  item: CodexThreadItem;
  serverId: string;
  onOpenFilesPath?: (target: { serverId: string; path: string }) => void;
}) {
  const [showFullDiff, setShowFullDiff] = useState(false);
  const changes = Array.isArray(item.changes)
    ? item.changes.map((change) =>
        change && typeof change === 'object' ? change as Record<string, unknown> : {})
    : [];
  const hasLongDiff = changes.some(
    (change) => String(change.diff || '').length > CODEX_DISPLAY_TEXT_PREVIEW_CHARS,
  );

  return (
    <section className="codex-app-activity-entry codex-app-file-activity">
      <header>File changes</header>
      <div className="codex-app-activity-detail codex-app-file-diffs">
        {changes.map((change, changeIndex) => {
          const path = String(change.path || change.filePath || change.file || '').trim();
          const operation = String(change.kind || change.type || change.status || 'update');
          const rawDiff = String(change.diff || '');
          const diff = codexDisplayText(rawDiff, showFullDiff);
          return (
            <section className="codex-app-file-diff" key={`${path || 'change'}-${changeIndex}`}>
              <header>
                <span>{operation}</span>
                {path && onOpenFilesPath ? (
                  <button type="button" onClick={() => onOpenFilesPath({ serverId, path })}>
                    {path}
                  </button>
                ) : <code>{path || 'File'}</code>}
              </header>
              {diff ? (
                <pre aria-label={`Diff for ${path || 'file'}`}>
                  {diff.split('\n').map((line, lineIndex) => (
                    <span
                      data-kind={codexDiffLineKind(line)}
                      key={`${lineIndex}-${line.slice(0, 24)}`}
                    >
                      {line || ' '}
                    </span>
                  ))}
                </pre>
              ) : <small>No textual diff was provided.</small>}
            </section>
          );
        })}
        {!changes.length ? <small>No file details were provided.</small> : null}
        {hasLongDiff ? (
          <button
            type="button"
            className="codex-app-expand-content"
            onClick={() => setShowFullDiff((current) => !current)}
          >
            {showFullDiff ? 'Show less' : 'Show full diff'}
          </button>
        ) : null}
      </div>
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
  const [pastedTextAttachments, setPastedTextAttachments] = useState<CodexPastedTextAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [runtimeSettingsBusy, setRuntimeSettingsBusy] = useState(false);
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const [lastActivityAt, setLastActivityAt] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [threadQuery, setThreadQuery] = useState('');
  const [threadContextMenu, setThreadContextMenu] = useState<ThreadContextMenu | null>(null);
  const [confirmedThreadRuntime, setConfirmedThreadRuntime] = useState<ConfirmedThreadRuntime | null>(null);
  const [goalMode, setGoalMode] = useState(false);
  const [reviewPermissionMode, setReviewPermissionMode] = useState<ReviewPermissionMode>(() => {
    const stored = userStorage.getItem(CODEX_REVIEW_PERMISSION_STORAGE_KEY);
    return stored === 'ask' || stored === 'autoReview' || stored === 'fullAccess'
      ? stored
      : 'ask';
  });
  const [threadsCollapsed, setThreadsCollapsed] = useState(
    () => userStorage.getItem(CODEX_THREADS_COLLAPSED_STORAGE_KEY) === 'true',
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
  const runtimeSelectionDirtyRef = useRef(false);
  const runtimeSettingsRequestRef = useRef(0);
  const [cwd, setCwd] = useState(() => readCodexCwd(serverId, defaultCwd));
  const cwdRef = useRef(cwd);
  const [model, setModel] = useState(() => userStorage.getItem(CODEX_MODEL_STORAGE_KEY) || '');
  const [effort, setEffort] = useState(() => userStorage.getItem(CODEX_EFFORT_STORAGE_KEY) || '');
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
      settings: {
        ...(preset.settings || {}),
        model: selectedModel,
        ...(effort ? { reasoning_effort: effort } : {}),
      },
    } : undefined;
  }, [collaborationMode, collaborationModes, effort, model, models]);
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
  const executionSnapshot = useMemo(() => codexExecutionSnapshot({
    items: view.items,
    turnStatus: view.turnStatus,
    busy: busy && turnStartedAt !== null,
    approvalCount: approvals.length,
    connected,
    runtimeStatus: runtime?.status,
  }), [approvals.length, busy, connected, runtime?.status, turnStartedAt, view.items, view.turnStatus]);
  const runtimeStatusLabel = connected ? runtime?.status || 'connecting' : 'disconnected';
  const selectedRuntimeModel = model || 'default';
  const selectedRuntimeEffort = effort || 'auto';
  const runtimeSelectionPending = Boolean(
    confirmedThreadRuntime && (
      (model && model !== confirmedThreadRuntime.model) ||
      (effort && effort !== confirmedThreadRuntime.effort)
    ),
  );
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
    userStorage.setItem(CODEX_GOAL_POLICY_STORAGE_KEY, JSON.stringify(goalPolicy));
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
      const bottom = Math.max(0, element.scrollHeight - element.clientHeight);
      if (Math.abs(element.scrollTop - bottom) > 1) element.scrollTop = bottom;
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
    if (model) userStorage.setItem(CODEX_MODEL_STORAGE_KEY, model);
    else userStorage.removeItem(CODEX_MODEL_STORAGE_KEY);
  }, [model]);

  useEffect(() => {
    userStorage.setItem(CODEX_REVIEW_PERMISSION_STORAGE_KEY, reviewPermissionMode);
  }, [reviewPermissionMode]);

  useEffect(() => {
    userStorage.setItem(
      CODEX_THREADS_COLLAPSED_STORAGE_KEY,
      String(threadsCollapsed),
    );
  }, [threadsCollapsed]);

  useEffect(() => {
    if (effort) userStorage.setItem(CODEX_EFFORT_STORAGE_KEY, effort);
    else userStorage.removeItem(CODEX_EFFORT_STORAGE_KEY);
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

  const recordConfirmedThreadRuntime = (
    response: ThreadResponse,
    fallbackThreadId = '',
    forceSelectionSync = false,
  ) => {
    const threadId = response.thread?.id || fallbackThreadId;
    const confirmedModel = String(response.model || '').trim();
    if (!threadId || !confirmedModel) return;
    const confirmedEffort = String(response.reasoningEffort || '').trim();
    setModels((current) => current.includes(confirmedModel)
      ? current
      : [confirmedModel, ...current]);
    if (forceSelectionSync || !runtimeSelectionDirtyRef.current) {
      setModel(confirmedModel);
      setEffort(confirmedEffort);
      runtimeSelectionDirtyRef.current = false;
    }
    setConfirmedThreadRuntime({
      threadId,
      model: confirmedModel,
      modelProvider: String(response.modelProvider || 'unknown').trim() || 'unknown',
      effort: confirmedEffort || 'auto',
    });
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
    setConfirmedThreadRuntime(null);
    setInstructionRules([]);
    setTurnStartedAt(null);
    setLastActivityAt(null);
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
    setConfirmedThreadRuntime(null);
    setInstructionRules([]);
    setError('');
    setTurnStartedAt(null);
    setLastActivityAt(null);
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
    setTurnStartedAt(null);
    setLastActivityAt(null);
    setError('');
    try {
      const response = await client.call<ThreadResponse>('thread/resume', { threadId: thread.id });
      const resumed = response.thread || thread;
      recordConfirmedThreadRuntime(response, resumed.id, true);
      setSelectedThreadId(resumed.id);
      const resumedView = structuredStateFromThread(resumed, readTokenUsage(serverId, resumed.id));
      viewRef.current = resumedView;
      setView(resumedView);
      if (/progress|running/i.test(resumedView.turnStatus)) {
        const observedAt = Date.now();
        setTurnStartedAt(observedAt);
        setLastActivityAt(observedAt);
      }
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
      if (message.type === 'event' || message.type === 'server_request') {
        const observedAt = Date.now();
        setLastActivityAt(observedAt);
        if (message.type === 'event' && message.event.method === 'turn/started') {
          setTurnStartedAt(observedAt);
        }
      }
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
                  recordConfirmedThreadRuntime(response, response.thread.id);
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
            void client
              .call<ThreadResponse>('thread/resume', { threadId })
              .then((response) => recordConfirmedThreadRuntime(response, threadId, true))
              .catch(() => undefined);
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
    recordConfirmedThreadRuntime(response, thread.id, true);
    await refreshInstructionRules(client, response.instructionSources);
    setThreads((current) => [thread, ...current.filter((candidate) => candidate.id !== thread.id)]);
    setSelectedThreadId(thread.id);
    const nextView = structuredStateFromThread(thread);
    viewRef.current = nextView;
    setView(nextView);
    return thread.id;
  };

  const runTurn = async (
    text: string,
    goalObjective = '',
    textAttachments: CodexPastedTextAttachment[] = [],
  ): Promise<boolean> => {
    const client = clientRef.current;
    if (!text || !client || busy) return false;
    setBusy(true);
    setTurnStartedAt(Date.now());
    setLastActivityAt(Date.now());
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
      const startTurn = (targetThreadId: string) => {
        const input = buildCodexSkillTurnInput(managedObjective || text, skillForTurn);
        input.push(...pastedTextInputItems(textAttachments));
        return client.call<{ turn?: { id?: string; status?: string } }>('turn/start', {
          threadId: targetThreadId,
          clientUserMessageId: crypto.randomUUID(),
          input,
          cwd,
          approvalPolicy: permissions.approvalPolicy,
          approvalsReviewer: permissions.approvalsReviewer,
          sandboxPolicy: permissions.sandboxPolicy,
          model: model || undefined,
          effort: effort || undefined,
          collaborationMode: activeCollaborationMode,
        });
      };
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
      return true;
    } catch (nextError) {
      setBusy(false);
      setTurnStartedAt(null);
      setLastActivityAt(null);
      setError(nextError instanceof Error ? nextError.message : 'Unable to start Codex turn');
      return false;
    }
  };

  const attachLargePastedText = (text: string): boolean => {
    if (!shouldConvertPastedText(text)) return false;
    const attachment = createPastedTextAttachment(text);
    if (attachment.size > CODEX_PASTED_TEXT_MAX_BYTES) {
      setError('Pasted text is larger than 1 MB. Save it as a file and open it from the File panel.');
      return true;
    }
    if (pastedTextAttachments.length >= CODEX_PASTED_TEXT_MAX_ATTACHMENTS) {
      setError(`A prompt can contain at most ${CODEX_PASTED_TEXT_MAX_ATTACHMENTS} pasted-text files.`);
      return true;
    }
    setPastedTextAttachments((current) => [...current, attachment]);
    setError('');
    return true;
  };

  const sendTurn = async (event: React.FormEvent) => {
    event.preventDefault();
    const attachments = pastedTextAttachments;
    const text = draft.trim() || pastedTextFallbackPrompt(attachments);
    if (!draft.trim() && !attachments.length) return;
    const sent = await runTurn(text, goalMode ? text : '', attachments);
    if (sent) {
      setDraft('');
      setPastedTextAttachments([]);
      if (goalMode) setGoalMode(false);
    }
  };

  const applyRuntimeSettings = async (nextModel: string, nextEffort: string) => {
    runtimeSelectionDirtyRef.current = true;
    setModel(nextModel);
    setEffort(nextEffort);

    const client = clientRef.current;
    const threadId = selectedThreadIdRef.current;
    if (!client || !threadId) return;

    const requestId = runtimeSettingsRequestRef.current + 1;
    runtimeSettingsRequestRef.current = requestId;
    setRuntimeSettingsBusy(true);
    setError('');
    try {
      await client.call<Record<string, never>>('thread/settings/update', {
        threadId,
        model: nextModel || null,
        effort: nextEffort || null,
      });
      const response = await client.call<ThreadResponse>('thread/resume', { threadId });
      if (requestId !== runtimeSettingsRequestRef.current) return;
      recordConfirmedThreadRuntime(response, threadId, true);
    } catch (nextError) {
      if (requestId !== runtimeSettingsRequestRef.current) return;
      if (confirmedThreadRuntime?.threadId === threadId) {
        setModel(confirmedThreadRuntime.model);
        setEffort(confirmedThreadRuntime.effort === 'auto' ? '' : confirmedThreadRuntime.effort);
      }
      runtimeSelectionDirtyRef.current = false;
      setError(nextError instanceof Error
        ? nextError.message
        : 'Failed to update Codex runtime settings');
    } finally {
      if (requestId === runtimeSettingsRequestRef.current) setRuntimeSettingsBusy(false);
    }
  };

  const selectCollaborationMode = (nextMode: string) => {
    if (nextMode !== 'plan') previousNonPlanModeRef.current = nextMode;
    setCollaborationMode(nextMode);
    const nextEffort = collaborationModes.find(
      (candidate) => candidate.mode === nextMode,
    )?.settings?.reasoning_effort;
    if (typeof nextEffort === 'string') {
      runtimeSelectionDirtyRef.current = true;
      setEffort(nextEffort);
    }
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

  const renameThread = async (thread: CodexThreadSummary) => {
    const client = clientRef.current;
    if (!client || busy) return;
    const currentName = String(thread.name || thread.preview || '').trim();
    const requestedName = window.prompt('Rename thread', currentName);
    if (requestedName === null) return;
    const name = requestedName.trim();
    if (!name || name === currentName) return;
    setBusy(true);
    setError('');
    try {
      await client.call('thread/name/set', { threadId: thread.id, name });
      setThreads((current) => current.map((candidate) => (
        candidate.id === thread.id ? { ...candidate, name } : candidate
      )));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to rename Codex thread');
    } finally {
      setBusy(false);
    }
  };

  const archiveThread = async (threadId: string) => {
    const client = clientRef.current;
    if (!client || !threadId || busy) return;
    setBusy(true);
    setError('');
    try {
      await client.call('thread/archive', { threadId });
      if (threadId === selectedThreadId) startNewThreadDraft();
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
                  onContextMenu={(event) => {
                    event.preventDefault();
                    const menuWidth = 220;
                    const menuHeight = 130;
                    setThreadContextMenu({
                      thread,
                      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
                      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
                    });
                  }}
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
          </div>

          <CodexExecutionStrip
            snapshot={executionSnapshot}
            runtimeStatus={runtime?.status}
            turnStartedAt={turnStartedAt}
            lastActivityAt={lastActivityAt}
          />

          <div
            className="codex-app-items"
            ref={itemsScrollRef}
            aria-label="Codex conversation"
            onWheel={(event) => {
              if (event.deltaY < 0) followLatestRef.current = false;
            }}
            onScroll={(event) => {
              const element = event.currentTarget;
              followLatestRef.current =
                element.scrollHeight - element.scrollTop - element.clientHeight
                  < CODEX_FOLLOW_LATEST_THRESHOLD_PX;
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
            {displayEntries.map((entry, entryIndex) => entry.kind === 'activity' ? (
              <CodexActivityGroup
                key={entry.id}
                items={entry.items}
                serverId={serverId}
                running={
                  entryIndex === displayEntries.length - 1
                  && (busy || /progress|running/i.test(view.turnStatus))
                }
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
            {pastedTextAttachments.length ? (
              <div className="composer-attachments codex-app-pasted-text-attachments" aria-label="Attached pasted text files">
                {pastedTextAttachments.map((attachment) => (
                  <div className="composer-attachment composer-text-attachment" key={attachment.id}>
                    <span className="composer-text-file-icon" aria-hidden="true">TXT</span>
                    <span title={attachment.name}>{attachment.name}</span>
                    <button
                      type="button"
                      title={`Remove ${attachment.name}`}
                      onClick={() => setPastedTextAttachments((current) =>
                        current.filter((candidate) => candidate.id !== attachment.id))}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="codex-app-prompt-row">
              <textarea
                ref={promptRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onPaste={(event) => {
                  const pastedText = event.clipboardData.getData('text/plain');
                  if (pastedText && attachLargePastedText(pastedText)) event.preventDefault();
                }}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing &&
                    Boolean(draft.trim() || pastedTextAttachments.length) &&
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
                  (!draft.trim() && !pastedTextAttachments.length) || busy ||
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
                <select
                  value={model}
                  onChange={(event) => {
                    void applyRuntimeSettings(event.target.value, effort);
                  }}
                  disabled={busy || runtimeSettingsBusy || runtime?.status !== 'ready'}
                >
                  <option value="">default</option>
                  {models.map((option) => <option value={option} key={option}>{option}</option>)}
                </select>
              </label>
              <label>
                <span>Effort</span>
                <select
                  value={effort}
                  onChange={(event) => {
                    void applyRuntimeSettings(model, event.target.value);
                  }}
                  disabled={busy || runtimeSettingsBusy || runtime?.status !== 'ready'}
                >
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
          <div className="codex-app-runtime-config" aria-label="Codex runtime configuration">
            <p>
              <span>Selected</span>
              <strong>{selectedRuntimeModel} · effort {selectedRuntimeEffort} · {collaborationMode}</strong>
            </p>
            {confirmedThreadRuntime ? (
              <p>
                <span>Confirmed</span>
                <strong>
                  {confirmedThreadRuntime.model} · effort {confirmedThreadRuntime.effort}
                </strong>
                <small title={`Provider: ${confirmedThreadRuntime.modelProvider}`}>
                  {runtimeSettingsBusy
                    ? 'applying…'
                    : runtimeSelectionPending
                      ? 'pending next turn'
                      : `via ${confirmedThreadRuntime.modelProvider}`}
                </small>
              </p>
            ) : (
              <p>
                <span>Confirmed</span>
                <small>Available after a thread starts or resumes</small>
              </p>
            )}
          </div>
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
          <p className="hint">
            Model and effort update the current thread immediately; cwd applies when the next thread starts.
          </p>
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

      {threadContextMenu ? (
        <>
          <div
            className="menu-backdrop"
            aria-hidden="true"
            onClick={() => setThreadContextMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setThreadContextMenu(null);
            }}
          />
          <div
            className="context-menu codex-thread-context-menu"
            role="menu"
            aria-label="Thread actions"
            style={{ left: threadContextMenu.x, top: threadContextMenu.y }}
          >
            <div className="menu-header">
              <span className="menu-title">
                {threadContextMenu.thread.name || threadContextMenu.thread.preview || 'Untitled thread'}
              </span>
              <span className="menu-subtitle">Thread</span>
            </div>
            <button
              type="button"
              className="menu-item"
              role="menuitem"
              disabled={busy}
              onClick={() => {
                const thread = threadContextMenu.thread;
                setThreadContextMenu(null);
                void renameThread(thread);
              }}
            >
              Rename
            </button>
            <button
              type="button"
              className="menu-item menu-item-danger menu-sep"
              role="menuitem"
              disabled={busy}
              onClick={() => {
                const threadId = threadContextMenu.thread.id;
                setThreadContextMenu(null);
                void archiveThread(threadId);
              }}
            >
              Archive
              <span className="menu-hint">Hide this thread without deleting its history</span>
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
