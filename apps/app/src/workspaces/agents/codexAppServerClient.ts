import type { CodexRuntimeEvent } from '@cozypad/contracts';
import { createLegacyWebSocketUrl, resolveLegacyHttpPath } from '../../platform/legacyApiRoutes';

export type CodexAppServerRuntimeStatus = {
  key: string;
  status: 'starting' | 'ready' | 'reconnecting' | 'unavailable' | 'stopped';
  detail?: string;
  sequence: number;
  restartAttempts?: number;
};

export type CodexAppServerRequest = {
  id: number | string;
  method: string;
  params: Record<string, unknown>;
};

export type CodexAppServerMessage =
  | { type: 'runtime_status' | 'status'; runtime: CodexAppServerRuntimeStatus }
  | { type: 'event'; event: CodexRuntimeEvent; replayed?: boolean }
  | { type: 'server_request'; request: CodexAppServerRequest }
  | { type: 'protocol_error'; error: string };

export type CodexAppServerStatusResponse = {
  ok: boolean;
  enabled: boolean;
  mode: 'legacy' | 'app-server' | 'auto';
  runtimes: CodexAppServerRuntimeStatus[];
};

type RpcResultMessage = {
  type: 'rpc_result';
  requestId: string;
  result?: unknown;
  error?: { message?: string; code?: number };
};

export async function getCodexAppServerStatus(
  serverId: string,
): Promise<CodexAppServerStatusResponse> {
  const response = await fetch(
    resolveLegacyHttpPath(
      `/api/codex/app-server/status?serverId=${encodeURIComponent(serverId)}`,
    ),
    { credentials: 'include' },
  );
  const body = (await response.json().catch(() => ({}))) as Partial<CodexAppServerStatusResponse> & {
    error?: string;
  };
  if (!response.ok) throw new Error(body.error || `Codex runtime status failed (${response.status})`);
  return body as CodexAppServerStatusResponse;
}

export class CodexAppServerSocket {
  private socket: WebSocket | null = null;
  private readonly listeners = new Set<(message: CodexAppServerMessage) => void>();
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private nextRequestId = 1;
  private explicitlyClosed = false;
  private reconnectTimer: number | undefined;
  private reconnectAttempts = 0;
  private lastSequence = 0;

  constructor(private readonly serverId: string) {}

  subscribe(listener: (message: CodexAppServerMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async connect(): Promise<void> {
    this.explicitlyClosed = false;
    if (this.socket?.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      const url = createLegacyWebSocketUrl('/api/codex/app-server/session');
      url.searchParams.set('serverId', this.serverId);
      if (this.lastSequence > 0) url.searchParams.set('afterSequence', String(this.lastSequence));
      const socket = new WebSocket(url.toString());
      this.socket = socket;
      let opened = false;
      socket.addEventListener('open', () => {
        opened = true;
        this.reconnectAttempts = 0;
        resolve();
      });
      socket.addEventListener('message', (event) => this.handleMessage(String(event.data || '')));
      socket.addEventListener('error', () => {
        if (!opened) reject(new Error('Codex app-server WebSocket failed to connect'));
      });
      socket.addEventListener('close', () => {
        if (this.socket === socket) this.socket = null;
        this.rejectPending(new Error('Codex app-server connection closed'));
        if (!this.explicitlyClosed) this.scheduleReconnect();
      });
    });
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Codex app-server is not connected'));
    }
    const requestId = `web-${this.nextRequestId++}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.socket?.send(JSON.stringify({ type: 'rpc', requestId, method, params }));
    });
  }

  respond(appServerRequestId: number | string, result?: unknown, error?: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error('Codex app-server is not connected');
    }
    this.socket.send(
      JSON.stringify({ type: 'server_request_result', appServerRequestId, result, error }),
    );
  }

  close(): void {
    this.explicitlyClosed = true;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.socket?.close();
    this.socket = null;
    this.rejectPending(new Error('Codex app-server client closed'));
  }

  private handleMessage(raw: string): void {
    let message: CodexAppServerMessage | RpcResultMessage;
    try {
      message = JSON.parse(raw) as CodexAppServerMessage | RpcResultMessage;
    } catch {
      return;
    }
    if (message.type === 'rpc_result') {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      if (message.error) pending.reject(new Error(message.error.message || 'Codex request failed'));
      else pending.resolve(message.result);
      return;
    }
    if (message.type === 'event') {
      this.lastSequence = Math.max(this.lastSequence, message.event.sequence);
    }
    for (const listener of this.listeners) listener(message);
  }

  private scheduleReconnect(): void {
    window.clearTimeout(this.reconnectTimer);
    const delay = Math.min(15_000, 500 * 2 ** Math.min(this.reconnectAttempts++, 5));
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(() => this.scheduleReconnect());
    }, delay);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
