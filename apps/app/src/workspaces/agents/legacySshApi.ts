import { createLegacyWebSocketUrl, resolveLegacyHttpPath } from '../../platform/legacyApiRoutes';

export type LegacyAuthUser = {
  username: string;
  role: string;
  capabilities: LegacyCapability[];
};

export type LegacyCapability =
  | 'agent.use'
  | 'research.use'
  | 'ssh.manage-own'
  | 'ssh.import-system-config'
  | 'public.read'
  | 'public.manage'
  | 'developer.simulate-drop';

export type LegacySessionResponse = {
  authenticated: boolean;
  user: LegacyAuthUser | null;
};

export type LegacyTwoFactorSetup = {
  issuer: string;
  account: string;
  secret: string;
  otpauthUrl: string;
};

export type LegacyLoginResponse = {
  ok?: boolean;
  user?: LegacyAuthUser;
  requiresTwoFactor?: boolean;
  requiresTwoFactorSetup?: boolean;
  challengeId?: string;
  setup?: LegacyTwoFactorSetup;
  error?: string;
};

const RESEARCH_API_PREFIX = '/cozypad-research';
const RESEARCH_RPC_PREFIX = '/cozypad-rpc/research';
const AGENT_API_PREFIX = '/cozypad-agent';
const AGENT_RPC_PREFIX = '/cozypad-rpc/ssh';
const LEGACY_API_SAFE_RETRY_DELAYS_MS = [600, 1600, 3200];
const LEGACY_API_DEFAULT_TIMEOUT_MS = 45_000;
const LEGACY_API_SAFE_TIMEOUT_MS = 30_000;

export type LegacySshServer = {
  id: string;
  source: 'local' | 'ssh-config' | 'system';
  name: string;
  alias?: string;
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  hasIdentityFile?: boolean;
  identityFileReady?: boolean;
  configFile?: string;
  knownHostsFile?: string;
  strictHostKeyChecking?: string;
  defaultPath?: string;
  localOnly?: boolean;
  provisioningStatus?: 'pending' | 'ready' | 'failed' | 'cleanup-required';
  provisioningError?: {
    code: string;
    stage: LegacySshProvisioningStage;
    message: string;
    cleanup: string;
  };
};

export type LegacySshProvisioningStage =
  | 'validating'
  | 'verifying-host'
  | 'generating-key'
  | 'installing-key'
  | 'testing-key'
  | 'saving-profile'
  | 'ready'
  | 'rolling-back'
  | 'failed'
  | 'cleanup-required';

export type LegacyCondaEnv = {
  name: string;
  path: string;
  active?: boolean;
};

export type LegacyCodexBinding = LegacySshServer & {
  apiBaseUrl?: string;
  commandToken?: string;
  commandExpiresAt?: string;
};

export type LegacyCodexReasoningEffort =
  | ''
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra';

export type LegacyCodexWorkflow = {
  id: string;
  title: string;
  serverId: string;
  serverName: string;
  serverTarget?: string;
  remotePath: string;
  mode?: 'server';
  prompt: string;
  output: string;
  model?: string;
  reasoningEffort?: LegacyCodexReasoningEffort;
  status?: 'completed' | 'running' | 'failed';
  running: boolean;
  connected: boolean;
  historyId: string;
  createdAt: string;
  updatedAt: string;
};

export type LegacyCodexHistory = {
  id: string;
  serverId: string;
  serverName: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  messages?: Array<{
    role: string;
    content: string;
    createdAt: string;
  }>;
};

export type LegacyClaudeStatus = {
  server: LegacySshServer;
  available: boolean;
  path: string;
  version: string;
  error: string;
  checkedAt: string;
  transport?: 'local' | 'ssh' | 'terminal' | 'api';
  terminalId?: string;
  models?: string[];
  defaultModel?: string;
};

export type LegacyClaudeRunResponse = {
  server: LegacySshServer;
  status: 'completed' | 'failed';
  output: string;
  stderr: string;
  code: number;
  durationMs: number;
  transport?: 'local' | 'ssh' | 'terminal' | 'api';
  terminalId?: string;
};

export type LegacyAgyStatus = {
  server: LegacySshServer;
  available: boolean;
  path: string;
  version: string;
  error: string;
  checkedAt: string;
  transport?: 'local' | 'ssh' | 'terminal' | 'api';
  terminalId?: string;
  models?: string[];
  defaultModel?: string;
};

export type LegacyAgyRunResponse = {
  server: LegacySshServer;
  status: 'completed' | 'failed';
  output: string;
  stderr: string;
  code: number;
  durationMs: number;
  transport?: 'local' | 'ssh' | 'terminal' | 'api';
  terminalId?: string;
};

export type LegacyCodexStatus = LegacyAgyStatus & {
  models?: string[];
  defaultModel?: string;
};
export type LegacyCodexRunResponse = LegacyAgyRunResponse;
export type LegacyBailianStatus = LegacyAgyStatus;
export type LegacyBailianRunResponse = LegacyAgyRunResponse;

type LegacyRemoteAgentKind = 'claude' | 'agy' | 'bailian' | 'codex';

export type LegacyRemoteAgentStreamKind = 'claude' | 'agy' | 'bailian';

export type LegacyRemoteAgentStreamPayload = {
  agent: LegacyRemoteAgentStreamKind;
  serverId: string;
  prompt: string;
  remotePath?: string;
  allowedDirs?: string[];
  apiKey?: string;
  model?: string;
  terminalId?: string;
};

type LegacyRemoteAgentRunJobResponse = {
  ok: boolean;
  jobId?: string;
  agent?: LegacyRemoteAgentKind;
  status?: 'queued' | 'running' | 'completed' | 'failed';
  queued?: boolean;
  server?: LegacySshServer;
  output?: string;
  stderr?: string;
  code?: number;
  durationMs?: number;
  transport?: 'local' | 'ssh' | 'terminal' | 'api';
  terminalId?: string;
  result?: LegacyAgyRunResponse;
  error?: string;
};

export type LegacyAgentStopResponse = {
  ok: boolean;
  stopped: boolean;
  agent: LegacyRemoteAgentKind;
  serverId: string;
  taskId: string;
  pendingCleared: number;
  message: string;
};

export type LegacySshRuntimeTerminal = {
  id: string;
  serverId: string;
  serverName: string;
  transport?: string;
  attachedSockets: number;
  detached: boolean;
  createdAt: string;
  detachedAt: string;
  lastAttachedAt: string;
  lastOutputAt: string;
  idleMs: number;
  bufferBytes: number;
  agentBusy: boolean;
  agentJobId: string;
  agent: string;
};

export type LegacySshRuntimeCodexSession = {
  key: string;
  taskId: string;
  serverId: string;
  serverName: string;
  running: boolean;
  status: string;
  socketCount: number;
  pendingPrompts: number;
  createdAt: string;
  lastAttachedAt: string;
  lastOutputAt: string;
  idleMs: number;
};

export type LegacySshRuntimeAgentSession = {
  key: string;
  agent: string;
  taskId: string;
  serverId: string;
  serverName: string;
  running: boolean;
  status: string;
  socketCount: number;
  pendingPrompts: number;
  createdAt: string;
  lastAttachedAt: string;
  lastOutputAt: string;
  idleMs: number;
};

export type LegacySshRuntimeWorker = {
  key: string;
  agent: string;
  serverId: string;
  serverName: string;
  running: boolean;
  queuedJobs: number;
  pid: number;
  lastUsedAt: string;
  idleMs: number;
};

export type LegacySshRuntimeMonitorStream = {
  key: string;
  serverId: string;
  serverName: string;
  target: string;
  subscribers: number;
  online: boolean;
  connecting: boolean;
  blocked: boolean;
  createdAt: string;
  lastUpdatedAt: string;
  idleMs: number;
};

export type LegacySshRuntimeSnapshot = {
  ok: boolean;
  type: 'ssh-runtime';
  generatedAt: string;
  terminalBridgeEnabled: boolean;
  intervalMs: number;
  totals: {
    terminals: number;
    attachedTerminals: number;
    busyTerminals: number;
    codexSessions: number;
    runningCodexSessions: number;
    remoteAgentSessions?: number;
    runningRemoteAgentSessions?: number;
    remoteAgentWorkers: number;
    monitorStreams?: number;
  };
  terminals: LegacySshRuntimeTerminal[];
  monitorStreams?: LegacySshRuntimeMonitorStream[];
  codexSessions: LegacySshRuntimeCodexSession[];
  remoteAgentSessions?: LegacySshRuntimeAgentSession[];
  remoteAgentWorkers: LegacySshRuntimeWorker[];
};

export type LegacyPublicWorkflowStatus = {
  ok: boolean;
  publicUrl: string;
  originUrl: string;
  tunnelId: string;
  protocol: string;
  api: {
    online: boolean;
    port: number;
  };
  origin: {
    online: boolean;
    status: number;
    statusText: string;
  };
  tunnel: {
    running: boolean;
    count: number;
    pids: number[];
    error?: string;
  };
  publicSite: {
    reachable: boolean;
    status: number;
    statusText: string;
    securityBlocked: boolean;
  };
  checkedAt: string;
};

export type LegacyPublicWorkflowStartResponse = {
  ok: boolean;
  code?: number;
  error?: string;
  stdout?: string;
  stderr?: string;
  script?: {
    publicUrl: string;
    originUrl: string;
    apiPort: number;
    apiPids: number[];
    webPids: number[];
    tunnelRunning: boolean;
    tunnelPids: number[];
    protocol: string;
  } | null;
  status: LegacyPublicWorkflowStatus;
};

export type LegacyServerCreatePayload = {
  name: string;
  host: string;
  user: string;
  port: number;
  password: string;
  defaultPath: string;
};

export type LegacyServerUpdatePayload = Omit<LegacyServerCreatePayload, 'password'>;

export type LegacySshFileItem = {
  name: string;
  path: string;
  type: 'directory' | 'file' | 'symlink' | 'unknown' | string;
  isDirectory: boolean;
  size: number;
  mtime: number;
  mode: string;
  error?: string;
};

export type LegacySshFileListing = {
  ok: boolean;
  path: string;
  parent?: string;
  items: LegacySshFileItem[];
  totalItems?: number;
  maxItems?: number;
  truncated?: boolean;
  stderr?: string;
  error?: string;
};

export type LegacyFilePreviewKind =
  | 'text'
  | 'markdown'
  | 'pdf'
  | 'image'
  | 'audio'
  | 'video'
  | 'binary'
  | 'error';

export type LegacySshFilePreview = {
  ok: boolean;
  path: string;
  name: string;
  size: number;
  mtime: number;
  mime: string;
  kind: LegacyFilePreviewKind;
  encoding: 'base64';
  contentBase64: string;
  stderr?: string;
  error?: string;
};

export type LegacyMarkdownSummaryFile = {
  name: string;
  content: string;
};

export type LegacyMarkdownSummaryResponse = {
  ok: boolean;
  summary?: string;
  markdown?: string;
  result?: unknown;
  fileCount?: number;
  modelPath?: string;
  server?: LegacySshServer;
  stderr?: string;
  error?: string;
  traceback?: string;
};

export type LegacyResearchFlowchartNode = {
  id: string;
  kind: string;
  title: string;
  subtitle: string;
  role: string;
  x: number;
  y: number;
  inputs: number;
  outputs: number;
};

export type LegacyResearchFlowchartEdge = {
  id: string;
  from: string;
  to: string;
  fromTitle: string;
  toTitle: string;
};

export type LegacyResearchFlowchartBatchResult = {
  id?: string;
  title?: string;
  fileName?: string;
  path?: string;
  ok?: boolean;
  markdown?: string;
  summary?: string;
  content?: string;
  result?: unknown;
  error?: string;
};

export type LegacyResearchFlowchartMarkdownResponse = {
  ok: boolean;
  jobId?: string;
  status?: 'queued' | 'running' | 'completed' | 'failed';
  queued?: boolean;
  markdown?: string;
  summary?: string;
  content?: string;
  result?: unknown;
  items?: LegacyResearchFlowchartBatchResult[];
  results?: LegacyResearchFlowchartBatchResult[];
  fileCount?: number;
  modelPath?: string;
  nodeCount?: number;
  edgeCount?: number;
  server?: LegacySshServer;
  idleGpuCount?: number;
  availableGpuCount?: number;
  freeGpuCount?: number;
  concurrency?: number;
  stderr?: string;
  error?: string;
  traceback?: string;
};

export type LegacyResearchDiagramCodexResponse = {
  ok: boolean;
  raw: string;
  diagram?: unknown;
  server?: LegacySshServer;
  stderr?: string;
  error?: string;
};

export class LegacyApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly confirmation?: unknown;
  readonly stage?: LegacySshProvisioningStage;
  readonly retryable?: boolean;
  readonly cleanup?: string;

  constructor(status: number, message: string, details: {
    code?: string;
    confirmation?: unknown;
    stage?: LegacySshProvisioningStage;
    retryable?: boolean;
    cleanup?: string;
  } = {}) {
    super(message);
    this.name = 'LegacyApiError';
    this.status = status;
    this.code = details.code;
    this.confirmation = details.confirmation;
    this.stage = details.stage;
    this.retryable = details.retryable;
    this.cleanup = details.cleanup;
  }
}

export function isLegacyAuthError(error: unknown): boolean {
  return error instanceof LegacyApiError && error.status === 401;
}

let legacySshExecutionEnabled = false;

export function setLegacySshExecutionEnabled(enabled: boolean): void {
  legacySshExecutionEnabled = enabled;
}

function assertLegacySshExecutionEnabled(): void {
  if (!legacySshExecutionEnabled) {
    throw new LegacyApiError(428, 'Press Connect before starting SSH operations.');
  }
}

export function openLegacyRemoteAgentStream(options: { allowWithoutConnect?: boolean } = {}): WebSocket {
  if (!options.allowWithoutConnect) assertLegacySshExecutionEnabled();
  return new WebSocket(createLegacyWebSocketUrl('/api/agent/session').toString());
}

export function openLegacyClaudeSession(options: {
  serverId: string;
  remotePath?: string;
  taskId?: string;
  suppressReplay?: boolean;
}): WebSocket {
  assertLegacySshExecutionEnabled();
  const url = createLegacyWebSocketUrl('/api/claude/session');
  url.searchParams.set('serverId', options.serverId);
  if (options.remotePath) url.searchParams.set('remotePath', options.remotePath);
  if (options.taskId) url.searchParams.set('taskId', options.taskId);
  if (options.suppressReplay) url.searchParams.set('suppressReplay', '1');
  return new WebSocket(url.toString());
}

export function openLegacyAgySession(options: {
  serverId: string;
  remotePath?: string;
  taskId?: string;
  suppressReplay?: boolean;
}): WebSocket {
  assertLegacySshExecutionEnabled();
  const url = createLegacyWebSocketUrl('/api/agy/session');
  url.searchParams.set('serverId', options.serverId);
  if (options.remotePath) url.searchParams.set('remotePath', options.remotePath);
  if (options.taskId) url.searchParams.set('taskId', options.taskId);
  if (options.suppressReplay) url.searchParams.set('suppressReplay', '1');
  return new WebSocket(url.toString());
}

export function openLegacyBailianSession(options: {
  serverId: string;
  remotePath?: string;
  taskId?: string;
  suppressReplay?: boolean;
}): WebSocket {
  assertLegacySshExecutionEnabled();
  const url = createLegacyWebSocketUrl('/api/bailian/session');
  url.searchParams.set('serverId', options.serverId);
  if (options.remotePath) url.searchParams.set('remotePath', options.remotePath);
  if (options.taskId) url.searchParams.set('taskId', options.taskId);
  if (options.suppressReplay) url.searchParams.set('suppressReplay', '1');
  return new WebSocket(url.toString());
}

export function serializeLegacyRemoteAgentStreamPayload(payload: LegacyRemoteAgentStreamPayload): string {
  return JSON.stringify(payload);
}

type LegacyApiErrorBody = {
  code?: string;
  error?: string;
  stderr?: string;
  stdout?: string;
  traceback?: string;
  confirmation?: unknown;
  stage?: LegacySshProvisioningStage;
  retryable?: boolean;
  cleanup?: string;
  result?: {
    stderr?: string;
    stdout?: string;
    code?: number;
  };
};

function sanitizeLegacyApiMessage(value: unknown): string {
  return String(value || '')
    .replace(/[A-Za-z]:\\(?:[^\\\r\n]+\\)*[^\\\r\n\s'"]*/g, '[local path]')
    .replace(/[A-Za-z]:\/(?:[^/\r\n]+\/)*[^/\r\n\s'"]*/g, '[local path]')
    .trim();
}

function isBareStatusMessage(value: string, status: number): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === String(status) || normalized === `${status} bad gateway`;
}

function formatLegacyApiErrorMessage(
  status: number,
  statusText: string,
  body: LegacyApiErrorBody | null,
): string {
  const candidates = [
    body?.error,
    body?.stderr,
    body?.result?.stderr,
    body?.stdout,
    body?.result?.stdout,
    body?.traceback,
  ]
    .map(sanitizeLegacyApiMessage)
    .filter(Boolean);

  for (const candidate of candidates) {
    if (!isBareStatusMessage(candidate, status)) return candidate;
  }

  if (status === 502) {
    return 'CozyPad API 回傳 502：請確認本機 5173 web、5174 API 與 Cloudflare tunnel 都正常；若遠端 SSH/API 失敗，詳細錯誤會另外顯示。';
  }

  if (status === 524) {
    return '524: Cloudflare timed out waiting for CozyPad API. Long remote-agent work should use background jobs or the Agents streaming queue instead of a synchronous POST.';
  }

  if (status === 403) {
    if (!body) {
      return '403: Cloudflare edge/security returned a non-JSON response before CozyPad API could handle it.';
    }
    return '403：請求被 Cloudflare Security、CozyPad API 權限檢查，或 baillian API 拒絕。若只在公開網址發生，請檢查 Cloudflare 規則是否擋到 /api/* POST。';
  }

  return `${status} ${statusText}`.trim();
}

function isCloudflareEdgeBlock(error: unknown): error is LegacyApiError {
  return (
    error instanceof LegacyApiError &&
    error.status === 403 &&
    /Cloudflare edge\/security/i.test(error.message)
  );
}

function isRecoverableCloudflareTransportError(error: unknown): error is LegacyApiError {
  return (
    error instanceof LegacyApiError &&
    (error.status === 0 ||
      error.status === 524 ||
      error.status === 522 ||
      isCloudflareEdgeBlock(error))
  );
}

function shouldTryLocalLegacyApiFallback(error: unknown): boolean {
  return isRecoverableCloudflareTransportError(error);
}

function localLegacyApiUrl(path: string): string | null {
  if (typeof window === 'undefined') return null;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const host = window.location.hostname.toLowerCase();
  if (host === '127.0.0.1' || host === 'localhost') return null;
  return `http://127.0.0.1:5174${normalizedPath}`;
}

function createLegacyNetworkError(error: unknown): LegacyApiError {
  const detail = error instanceof Error && error.message ? error.message : String(error || '');
  const name = error instanceof Error ? error.name : '';
  if (/AbortError|TimeoutError/i.test(name) || /timed out|timeout/i.test(detail)) {
    return new LegacyApiError(
      0,
      'CozyPad API request timed out. Please retry; if the page was idle, CozyPad will refresh stale connections automatically.',
    );
  }
  return new LegacyApiError(
    0,
    detail === 'Failed to fetch'
      ? 'CozyPad API 連線失敗：請確認本機 API、Cloudflare Tunnel 或瀏覽器安全驗證是否正常。'
      : `CozyPad API 連線失敗：${detail || 'network unavailable'}`,
  );
}

function isSafeLegacyApiMethod(init?: RequestInit): boolean {
  const method = String(init?.method || 'GET').trim().toUpperCase();
  return method === 'GET' || method === 'HEAD';
}

function legacyApiTimeoutMs(init?: RequestInit): number {
  if (init?.signal) return 0;
  return isSafeLegacyApiMethod(init) ? LEGACY_API_SAFE_TIMEOUT_MS : LEGACY_API_DEFAULT_TIMEOUT_MS;
}

function withLegacyApiTimeout(init?: RequestInit): {
  init?: RequestInit;
  cleanup: () => void;
} {
  const timeoutMs = legacyApiTimeoutMs(init);
  if (timeoutMs <= 0) {
    return { init, cleanup: () => undefined };
  }

  const controller = new AbortController();
  const timer = window.setTimeout(
    () => controller.abort(new DOMException(`CozyPad API request timed out after ${timeoutMs}ms`, 'TimeoutError')),
    timeoutMs,
  );

  return {
    init: { ...init, signal: controller.signal },
    cleanup: () => window.clearTimeout(timer),
  };
}

function isRetryableLegacyApiError(error: unknown): boolean {
  if (!(error instanceof LegacyApiError)) return false;
  return error.status === 0 || isCloudflareEdgeBlock(error);
}

function waitForLegacyApiRetry(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('Request aborted'));

  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort() {
      window.clearTimeout(timer);
      reject(new Error('Request aborted'));
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function readLegacyApiResponse<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type') || '';
  const isJson = contentType.toLowerCase().includes('application/json');
  const body = isJson ? ((await response.json()) as LegacyApiErrorBody) : null;

  if (!response.ok) {
    throw new LegacyApiError(
      response.status,
      formatLegacyApiErrorMessage(response.status, response.statusText, body),
      {
        code: body?.code,
        confirmation: body?.confirmation,
        stage: body?.stage,
        retryable: body?.retryable,
        cleanup: body?.cleanup,
      },
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  if (!isJson) {
    await response.text().catch(() => '');
    throw new LegacyApiError(
      response.status,
      'Legacy API 沒有回傳 JSON，請確認 v1 SSH API server 已啟動。',
    );
  }

  return body as T;
}

async function fetchLegacyApi(path: string, init?: RequestInit, extraHeaders: Record<string, string> = {}) {
  let response: Response;
  const request = withLegacyApiTimeout(init);
  try {
    response = await fetch(resolveLegacyHttpPath(path), {
      ...request.init,
      credentials: 'include',
      headers: {
        'x-cozypad-request': 'app',
        ...(request.init?.body && !(request.init.body instanceof FormData)
          ? { 'content-type': 'application/json' }
          : {}),
        ...request.init?.headers,
        ...extraHeaders,
      },
    });
  } catch (error) {
    throw createLegacyNetworkError(error);
  } finally {
    request.cleanup();
  }

  return response;
}

export async function legacyApiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const retryDelays = isSafeLegacyApiMethod(init) ? LEGACY_API_SAFE_RETRY_DELAYS_MS : [];

  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetchLegacyApi(path, init);

      return await readLegacyApiResponse<T>(response);
    } catch (error) {
      const retryDelayMs = retryDelays[attempt];
      if (retryDelayMs === undefined || !isRetryableLegacyApiError(error)) {
        throw error;
      }
      await waitForLegacyApiRetry(retryDelayMs, init?.signal);
    }
  }
}

async function legacyTextRpcRequest<T>(path: string, payload: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'text/plain;charset=UTF-8',
        'x-cozypad-request': 'app',
        'x-cozypad-rpc': 'base64url-json',
      },
      body: encodeBase64UrlUtf8(JSON.stringify(payload)),
    });
  } catch (error) {
    throw createLegacyNetworkError(error);
  }

  return readLegacyApiResponse<T>(response);
}

async function legacyApiRequestWithLocalFallback<T>(
  path: string,
  init?: RequestInit,
  fallbackPath = path,
): Promise<T> {
  try {
    return await legacyApiRequest<T>(path, init);
  } catch (error) {
    const localUrl = localLegacyApiUrl(fallbackPath);
    if (!localUrl || !shouldTryLocalLegacyApiFallback(error)) {
      throw error;
    }
    return legacyApiRequest<T>(localUrl, init);
  }
}

async function legacyTextRpcRequestWithLocalFallback<T>(
  path: string,
  payload: unknown,
  fallbackPath = path,
): Promise<T> {
  try {
    return await legacyTextRpcRequest<T>(path, payload);
  } catch (error) {
    const localUrl = localLegacyApiUrl(fallbackPath);
    if (!localUrl || !shouldTryLocalLegacyApiFallback(error)) {
      throw error;
    }
    return legacyTextRpcRequest<T>(localUrl, payload);
  }
}

export function getLegacySession(): Promise<LegacySessionResponse> {
  return legacyApiRequest<LegacySessionResponse>('/api/auth/session');
}

export function loginLegacy(username: string, password: string): Promise<LegacyLoginResponse> {
  return legacyApiRequest<LegacyLoginResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

export function verifyLegacyTwoFactor(
  challengeId: string,
  code: string,
): Promise<LegacyLoginResponse> {
  return legacyApiRequest<LegacyLoginResponse>('/api/auth/2fa/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId, code }),
  });
}

export function logoutLegacy(): Promise<{ ok: boolean }> {
  return legacyApiRequest<{ ok: boolean }>('/api/auth/logout', {
    method: 'POST',
  });
}

export async function listLegacyServers(
  refresh = false,
  init?: Pick<RequestInit, 'signal'>,
): Promise<LegacySshServer[]> {
  const data = await legacyApiRequest<{
    servers: LegacySshServer[];
  }>(refresh ? '/api/ssh/servers/refresh' : '/api/ssh/servers', {
    method: refresh ? 'POST' : 'GET',
    ...init,
  });
  return Array.isArray(data.servers) ? data.servers : [];
}

export async function listLegacyCondaEnvs(
  serverId: string,
  init?: Pick<RequestInit, 'signal'>,
): Promise<LegacyCondaEnv[]> {
  const data = await legacyApiRequest<{ envs: LegacyCondaEnv[] }>(
    `/api/ssh/servers/${encodeURIComponent(serverId)}/conda-envs`,
    {
      method: 'GET',
      ...init,
    },
  );
  return Array.isArray(data.envs) ? data.envs : [];
}

export async function createLegacyServer(
  payload: LegacyServerCreatePayload,
): Promise<LegacySshServer> {
  const data = await legacyApiRequest<{ server: LegacySshServer }>('/api/ssh/servers', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return data.server;
}

export function provisionLegacyServer(
  serverId: string,
  payload: { password: string; expectedHostFingerprint?: string },
): Promise<{ ok: true; stage: 'ready'; server: LegacySshServer }> {
  return legacyApiRequest(`/api/ssh/servers/${encodeURIComponent(serverId)}/provision`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updateLegacyServer(
  serverId: string,
  payload: LegacyServerUpdatePayload,
): Promise<LegacySshServer> {
  const data = await legacyApiRequest<{ server: LegacySshServer }>(
    `/api/ssh/servers/${encodeURIComponent(serverId)}`,
    {
      method: 'PUT',
      body: JSON.stringify(payload),
    },
  );
  return data.server;
}

export function deleteLegacyServer(serverId: string): Promise<void> {
  return legacyApiRequest<void>(`/api/ssh/servers/${encodeURIComponent(serverId)}`, {
    method: 'DELETE',
  });
}

export function closeLegacyTerminal(terminalId: string): Promise<{ ok: boolean; closed: boolean }> {
  return legacyApiRequest<{ ok: boolean; closed: boolean }>('/api/ssh/terminal/close', {
    method: 'POST',
    body: JSON.stringify({ terminalId }),
  });
}

export function connectLegacySsh(serverId: string): Promise<{
  ok: boolean;
  serverId: string;
  status: 'ready';
}> {
  return legacyApiRequest('/api/ssh/connect', {
    method: 'POST',
    body: JSON.stringify({ serverId }),
  });
}

export function closeAllLegacySshRuntime(): Promise<{
  ok: boolean;
  closed: Record<string, number>;
}> {
  return legacyApiRequest<{ ok: boolean; closed: Record<string, number> }>(
    '/api/ssh/runtime/close-all',
    { method: 'POST' },
  );
}

export function getLegacySshRuntime(): Promise<LegacySshRuntimeSnapshot> {
  return legacyApiRequest<LegacySshRuntimeSnapshot>('/api/ssh/runtime');
}

export async function listLegacyServerFiles(
  serverId: string,
  remotePath: string,
  init?: Pick<RequestInit, 'signal'>,
): Promise<LegacySshFileListing> {
  assertLegacySshExecutionEnabled();
  const data = await legacyApiRequest<LegacySshFileListing>(
    `/api/ssh/servers/${encodeURIComponent(serverId)}/files?path=${encodeURIComponent(
      remotePath.trim() || '~',
    )}`,
    init,
  );
  return {
    ...data,
    items: Array.isArray(data.items) ? data.items : [],
  };
}

export function previewLegacyServerFile(
  serverId: string,
  remotePath: string,
): Promise<LegacySshFilePreview> {
  return legacyApiRequest<LegacySshFilePreview>(
    `/api/ssh/servers/${encodeURIComponent(serverId)}/file?path=${encodeURIComponent(
      remotePath,
    )}`,
  );
}

export type LegacySshFileMutationResult = {
  ok: boolean;
  action: 'mkdir' | 'touch' | 'rename' | 'delete' | 'copy' | 'move';
  path: string;
  parent: string;
};

export function createLegacyServerFile(
  serverId: string,
  directory: string,
  name: string,
): Promise<LegacySshFileMutationResult> {
  return legacyApiRequest<LegacySshFileMutationResult>(
    `/api/ssh/servers/${encodeURIComponent(serverId)}/files`,
    {
      method: 'POST',
      body: JSON.stringify({ action: 'touch', directory, name }),
    },
  );
}

export function createLegacyServerFolder(
  serverId: string,
  directory: string,
  name: string,
): Promise<LegacySshFileMutationResult> {
  return legacyApiRequest<LegacySshFileMutationResult>(
    `/api/ssh/servers/${encodeURIComponent(serverId)}/files`,
    {
      method: 'POST',
      body: JSON.stringify({ action: 'mkdir', directory, name }),
    },
  );
}

export function renameLegacyServerFile(
  serverId: string,
  remotePath: string,
  newName: string,
): Promise<LegacySshFileMutationResult> {
  return legacyApiRequest<LegacySshFileMutationResult>(
    `/api/ssh/servers/${encodeURIComponent(serverId)}/files`,
    {
      method: 'POST',
      body: JSON.stringify({ action: 'rename', path: remotePath, name: newName }),
    },
  );
}

export function deleteLegacyServerFile(
  serverId: string,
  remotePath: string,
): Promise<LegacySshFileMutationResult> {
  return legacyApiRequest<LegacySshFileMutationResult>(
    `/api/ssh/servers/${encodeURIComponent(serverId)}/files`,
    {
      method: 'POST',
      body: JSON.stringify({ action: 'delete', path: remotePath }),
    },
  );
}

export function transferLegacyServerFile(
  serverId: string,
  remotePath: string,
  destination: string,
  mode: 'copy' | 'move',
): Promise<LegacySshFileMutationResult> {
  return legacyApiRequest<LegacySshFileMutationResult>(
    `/api/ssh/servers/${encodeURIComponent(serverId)}/files`,
    {
      method: 'POST',
      body: JSON.stringify({ action: mode, path: remotePath, destination }),
    },
  );
}

export function summarizeLegacyMarkdown(
  serverId: string,
  files: LegacyMarkdownSummaryFile[],
  instruction = '',
): Promise<LegacyMarkdownSummaryResponse> {
  return legacyApiRequest<LegacyMarkdownSummaryResponse>('/api/markdown/summarize', {
    method: 'POST',
    body: JSON.stringify({ serverId, files, instruction }),
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function agentRunResultFromJob<T extends LegacyAgyRunResponse>(
  job: LegacyRemoteAgentRunJobResponse,
): T | null {
  if (job.result) return job.result as T;
  if (job.status !== 'completed' && job.status !== 'failed') return null;
  if (!job.server) return null;
  return {
    server: job.server,
    status: job.status === 'completed' ? 'completed' : 'failed',
    output: job.output || '',
    stderr: job.stderr || job.error || '',
    code: job.code ?? 0,
    durationMs: job.durationMs ?? 0,
    transport: job.transport,
    terminalId: job.terminalId,
  } as T;
}

async function getLegacyRemoteAgentRunJob(
  agent: LegacyRemoteAgentKind,
  jobId: string,
): Promise<LegacyRemoteAgentRunJobResponse> {
  const encodedJobId = encodeURIComponent(jobId);
  try {
    return await legacyApiRequest<LegacyRemoteAgentRunJobResponse>(
      `${AGENT_API_PREFIX}/ssh/${agent}/run/jobs/${encodedJobId}`,
    );
  } catch (error) {
    if (!isRecoverableCloudflareTransportError(error)) throw error;
    return legacyTextRpcRequestWithLocalFallback<LegacyRemoteAgentRunJobResponse>(
      `${AGENT_RPC_PREFIX}/${agent}/run/jobs/${encodedJobId}`,
      { jobId },
    );
  }
}

async function runLegacyRemoteAgentPromptJob<T extends LegacyAgyRunResponse>(
  agent: LegacyRemoteAgentKind,
  options: Record<string, unknown>,
): Promise<T> {
  let initial: LegacyRemoteAgentRunJobResponse;
  try {
    initial = await legacyApiRequest<LegacyRemoteAgentRunJobResponse>(
      `${AGENT_API_PREFIX}/ssh/${agent}/run/jobs`,
      {
        method: 'POST',
        body: JSON.stringify(options),
      },
    );
  } catch (error) {
    if (!isRecoverableCloudflareTransportError(error)) throw error;
    initial = await legacyTextRpcRequestWithLocalFallback<LegacyRemoteAgentRunJobResponse>(
      `${AGENT_RPC_PREFIX}/${agent}/run/jobs`,
      options,
    );
  }

  const immediateResult = agentRunResultFromJob<T>(initial);
  if (immediateResult && !initial.queued) return immediateResult;
  if (!initial.jobId) {
    throw new LegacyApiError(502, initial.error || `${agent} job did not return a job id.`);
  }

  const deadline = Date.now() + 15 * 60 * 1000;
  let delay = 1000;
  let transientPollFailures = 0;
  while (Date.now() < deadline) {
    await wait(delay);
    let job: LegacyRemoteAgentRunJobResponse;
    try {
      job = await getLegacyRemoteAgentRunJob(agent, initial.jobId);
      transientPollFailures = 0;
    } catch (error) {
      if (!isRecoverableCloudflareTransportError(error) || transientPollFailures >= 6) {
        throw error;
      }
      transientPollFailures += 1;
      delay = Math.min(8000, delay + 1000);
      continue;
    }
    const result = agentRunResultFromJob<T>(job);
    if (result) return result;
    if (job.status === 'failed') {
      throw new LegacyApiError(502, job.error || `${agent} remote job failed.`);
    }
    delay = Math.min(5000, delay + 500);
  }

  throw new LegacyApiError(504, `${agent} remote job timed out.`);
}

export function getLegacyResearchFlowchartJob(
  jobId: string,
): Promise<LegacyResearchFlowchartMarkdownResponse> {
  return legacyApiRequestWithLocalFallback<LegacyResearchFlowchartMarkdownResponse>(
    `${RESEARCH_API_PREFIX}/flowchart-markdown/jobs/${encodeURIComponent(jobId)}`,
  );
}

export async function analyzeLegacyResearchFlowchart(payload: {
  serverId?: string;
  apiKey?: string;
  nodes: LegacyResearchFlowchartNode[];
  edges: LegacyResearchFlowchartEdge[];
  note?: string;
  instruction?: string;
  model?: string;
}): Promise<LegacyResearchFlowchartMarkdownResponse> {
  let initial: LegacyResearchFlowchartMarkdownResponse;
  try {
    initial = await legacyApiRequestWithLocalFallback<LegacyResearchFlowchartMarkdownResponse>(
      `${RESEARCH_API_PREFIX}/flowchart-markdown`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    );
  } catch (error) {
    if (!isCloudflareEdgeBlock(error)) throw error;
    initial = await legacyTextRpcRequestWithLocalFallback<LegacyResearchFlowchartMarkdownResponse>(
      `${RESEARCH_RPC_PREFIX}/flowchart-markdown`,
      payload,
      `${RESEARCH_RPC_PREFIX}/flowchart-markdown`,
    );
  }

  if (!initial.jobId || initial.status === 'completed' || initial.markdown || initial.summary) {
    return initial;
  }

  const deadline = Date.now() + 15 * 60 * 1000;
  let delay = 1500;
  while (Date.now() < deadline) {
    await wait(delay);
    const job = await getLegacyResearchFlowchartJob(initial.jobId);
    if (job.status === 'completed' || job.markdown || job.summary || job.content) {
      return job;
    }
    if (job.status === 'failed') {
      throw new LegacyApiError(502, job.error || 'baillian 分析流程圖失敗。');
    }
    delay = Math.min(5000, delay + 500);
  }

  throw new LegacyApiError(504, 'baillian 分析仍在執行但等待逾時，請稍後再重新整理結果。');
}

export async function analyzeLegacyResearchFlowchartBatch(payload: {
  serverId?: string;
  apiKey?: string;
  items: Array<{
    id: string;
    title: string;
    fileName: string;
    nodes: LegacyResearchFlowchartNode[];
    edges: LegacyResearchFlowchartEdge[];
    note?: string;
    instruction?: string;
    prompt?: string;
  }>;
  model?: string;
}): Promise<LegacyResearchFlowchartMarkdownResponse> {
  let initial: LegacyResearchFlowchartMarkdownResponse;
  try {
    initial = await legacyApiRequestWithLocalFallback<LegacyResearchFlowchartMarkdownResponse>(
      `${RESEARCH_API_PREFIX}/flowchart-markdown/batch`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    );
  } catch (error) {
    if (!isCloudflareEdgeBlock(error)) throw error;
    initial = await legacyTextRpcRequestWithLocalFallback<LegacyResearchFlowchartMarkdownResponse>(
      `${RESEARCH_RPC_PREFIX}/flowchart-markdown/batch`,
      payload,
      `${RESEARCH_RPC_PREFIX}/flowchart-markdown/batch`,
    );
  }

  if (!initial.jobId || initial.status === 'completed' || initial.items?.length || initial.results?.length) {
    return initial;
  }

  const deadline = Date.now() + 15 * 60 * 1000;
  let delay = 1500;
  while (Date.now() < deadline) {
    await wait(delay);
    const job = await getLegacyResearchFlowchartJob(initial.jobId);
    if (job.status === 'completed' || job.items?.length || job.results?.length) {
      return job;
    }
    if (job.status === 'failed') {
      throw new LegacyApiError(502, job.error || 'baillian batch flowchart markdown analysis failed.');
    }
    delay = Math.min(5000, delay + 500);
  }

  throw new LegacyApiError(504, 'baillian batch flowchart markdown analysis timed out.');
}

export async function drawLegacyResearchDiagramWithBailian(payload: {
  serverId?: string;
  apiKey?: string;
  prompt: string;
  nodes: LegacyResearchFlowchartNode[];
  edges: LegacyResearchFlowchartEdge[];
  model?: string;
  reasoningEffort?: LegacyCodexReasoningEffort;
}): Promise<LegacyResearchDiagramCodexResponse> {
  try {
    return await legacyApiRequest<LegacyResearchDiagramCodexResponse>(`${RESEARCH_API_PREFIX}/diagram-bailian`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  } catch (error) {
    if (!isCloudflareEdgeBlock(error)) throw error;
    return legacyTextRpcRequest<LegacyResearchDiagramCodexResponse>(
      `${RESEARCH_RPC_PREFIX}/diagram-bailian`,
      payload,
    );
  }
}

export async function loadLegacyCodexBinding(serverId: string): Promise<LegacyCodexBinding> {
  const data = await legacyApiRequest<{ binding: LegacyCodexBinding }>(
    `/api/ssh/servers/${encodeURIComponent(serverId)}/codex-binding`,
  );
  return {
    ...data.binding,
    apiBaseUrl: window.location.origin,
  };
}

export async function getLegacyCodexStatus(serverId: string): Promise<LegacyCodexStatus> {
  assertLegacySshExecutionEnabled();
  try {
    return await legacyApiRequest<LegacyCodexStatus>(
      `${AGENT_API_PREFIX}/ssh/servers/${encodeURIComponent(serverId)}/codex-status`,
    );
  } catch (error) {
    if (!isCloudflareEdgeBlock(error)) throw error;
    return legacyTextRpcRequest<LegacyCodexStatus>(`${AGENT_RPC_PREFIX}/codex/status`, { serverId });
  }
}

export async function runLegacyCodexPrompt(options: {
  serverId: string;
  prompt: string;
  remotePath?: string;
  model?: string;
  reasoningEffort?: LegacyCodexReasoningEffort;
}): Promise<LegacyCodexRunResponse> {
  assertLegacySshExecutionEnabled();
  return runLegacyRemoteAgentPromptJob<LegacyCodexRunResponse>('codex', options);
}

export async function listLegacyCodexWorkflows(
  serverId: string,
): Promise<LegacyCodexWorkflow[]> {
  assertLegacySshExecutionEnabled();
  const data = await legacyApiRequest<{ workflows: LegacyCodexWorkflow[] }>(
    `/api/ssh/codex-workflows?serverId=${encodeURIComponent(serverId)}`,
  );
  return Array.isArray(data.workflows) ? data.workflows : [];
}

export async function createLegacyCodexHistory(
  serverId: string,
  title: string,
  options: { allowWithoutConnect?: boolean } = {},
): Promise<LegacyCodexHistory> {
  if (!options.allowWithoutConnect) assertLegacySshExecutionEnabled();
  const data = await legacyApiRequest<{ history: LegacyCodexHistory }>('/api/codex/histories', {
    method: 'POST',
    body: JSON.stringify({ serverId, title }),
  });
  return data.history;
}

export async function saveLegacyCodexWorkflow(
  workflow: LegacyCodexWorkflow,
): Promise<LegacyCodexWorkflow> {
  const data = await legacyApiRequest<{ workflow: LegacyCodexWorkflow }>(
    '/api/ssh/codex-workflows',
    {
      method: 'POST',
      body: JSON.stringify(workflow),
    },
  );
  return data.workflow;
}

export function deleteLegacyCodexWorkflow(workflowId: string, serverId: string): Promise<void> {
  return legacyApiRequest<void>(
    `/api/ssh/codex-workflows/${encodeURIComponent(workflowId)}?serverId=${encodeURIComponent(
      serverId,
    )}`,
    { method: 'DELETE' },
  );
}

export async function getLegacyClaudeStatus(serverId: string): Promise<LegacyClaudeStatus> {
  assertLegacySshExecutionEnabled();
  try {
    return await legacyApiRequest<LegacyClaudeStatus>(
      `${AGENT_API_PREFIX}/ssh/servers/${encodeURIComponent(serverId)}/claude-status`,
    );
  } catch (error) {
    if (!isCloudflareEdgeBlock(error)) throw error;
    return legacyTextRpcRequest<LegacyClaudeStatus>(`${AGENT_RPC_PREFIX}/claude/status`, { serverId });
  }
}

export async function runLegacyClaudePrompt(options: {
  serverId: string;
  prompt: string;
  remotePath?: string;
  allowedDirs?: string[];
  model?: string;
}): Promise<LegacyClaudeRunResponse> {
  assertLegacySshExecutionEnabled();
  return runLegacyRemoteAgentPromptJob<LegacyClaudeRunResponse>('claude', options);
}

export async function getLegacyAgyStatus(serverId: string): Promise<LegacyAgyStatus> {
  assertLegacySshExecutionEnabled();
  try {
    return await legacyApiRequest<LegacyAgyStatus>(
      `${AGENT_API_PREFIX}/ssh/servers/${encodeURIComponent(serverId)}/agy-status`,
    );
  } catch (error) {
    if (!isCloudflareEdgeBlock(error)) throw error;
    return legacyTextRpcRequest<LegacyAgyStatus>(`${AGENT_RPC_PREFIX}/agy/status`, { serverId });
  }
}

export async function runLegacyAgyPrompt(options: {
  serverId: string;
  prompt: string;
  remotePath?: string;
  apiKey?: string;
  model?: string;
}): Promise<LegacyAgyRunResponse> {
  assertLegacySshExecutionEnabled();
  return runLegacyRemoteAgentPromptJob<LegacyAgyRunResponse>('agy', options);
}

export async function getLegacyBailianStatus(
  serverId: string,
  options: { hasApiKey?: boolean } = {},
): Promise<LegacyBailianStatus> {
  assertLegacySshExecutionEnabled();
  const query = options.hasApiKey ? '?hasApiKey=1' : '';
  try {
    return await legacyApiRequest<LegacyBailianStatus>(
      `${AGENT_API_PREFIX}/ssh/servers/${encodeURIComponent(serverId)}/bailian-status${query}`,
    );
  } catch (error) {
    if (!isCloudflareEdgeBlock(error)) throw error;
    return legacyTextRpcRequest<LegacyBailianStatus>(`${AGENT_RPC_PREFIX}/bailian/status`, {
      serverId,
      hasApiKey: Boolean(options.hasApiKey),
    });
  }
}

function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return window.btoa(binary);
}

function encodeBase64UrlUtf8(value: string): string {
  return encodeBase64Utf8(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function syncLegacyBailianSessionKey(key: string): Promise<{ ok: boolean; hasKey: boolean }> {
  const payload = { encoded: encodeBase64Utf8(key) };
  try {
    return await legacyApiRequest<{ ok: boolean; hasKey: boolean }>(
      `${AGENT_API_PREFIX}/ssh/bailian/session-key`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    );
  } catch (error) {
    if (!isCloudflareEdgeBlock(error)) throw error;
    return legacyTextRpcRequest<{ ok: boolean; hasKey: boolean }>(
      `${AGENT_RPC_PREFIX}/bailian/session-key`,
      payload,
    );
  }
}

export async function clearLegacyBailianSessionKey(): Promise<{ ok: boolean; hasKey: boolean }> {
  const payload = { clear: true };
  try {
    return await legacyApiRequest<{ ok: boolean; hasKey: boolean }>(
      `${AGENT_API_PREFIX}/ssh/bailian/session-key`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    );
  } catch (error) {
    if (!isCloudflareEdgeBlock(error)) throw error;
    return legacyTextRpcRequest<{ ok: boolean; hasKey: boolean }>(
      `${AGENT_RPC_PREFIX}/bailian/session-key`,
      payload,
    );
  }
}

export async function runLegacyBailianPrompt(options: {
  serverId: string;
  prompt: string;
  remotePath?: string;
  apiKey?: string;
  model?: string;
}): Promise<LegacyBailianRunResponse> {
  assertLegacySshExecutionEnabled();
  return runLegacyRemoteAgentPromptJob<LegacyBailianRunResponse>('bailian', options);
}

export function resetLegacyRemoteAgentCooldown(
  agent: 'Claude' | 'Codex' | 'agy' | 'bailian',
  serverId: string,
): Promise<{ ok: boolean; cleared: boolean; agent: string; serverId: string }> {
  assertLegacySshExecutionEnabled();
  return legacyApiRequest<{ ok: boolean; cleared: boolean; agent: string; serverId: string }>(
    `${AGENT_API_PREFIX}/ssh/agent-cooldown/reset`,
    {
      method: 'POST',
      body: JSON.stringify({ agent, serverId }),
    },
  );
}

export function stopLegacyAgentLatestTask(options: {
  agent: LegacyRemoteAgentKind;
  serverId: string;
  taskId?: string;
}): Promise<LegacyAgentStopResponse> {
  assertLegacySshExecutionEnabled();
  return legacyApiRequest<LegacyAgentStopResponse>(`${AGENT_API_PREFIX}/ssh/agents/stop-latest`, {
    method: 'POST',
    body: JSON.stringify(options),
  });
}

export function getLegacyPublicWorkflowStatus(): Promise<LegacyPublicWorkflowStatus> {
  return legacyApiRequest<LegacyPublicWorkflowStatus>('/api/public/status');
}

export function startLegacyPublicWorkflow(
  restartTunnel = false,
): Promise<LegacyPublicWorkflowStartResponse> {
  return legacyApiRequest<LegacyPublicWorkflowStartResponse>('/api/public/start', {
    method: 'POST',
    body: JSON.stringify({ restartTunnel }),
  });
}
