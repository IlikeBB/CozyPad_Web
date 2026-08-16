import type {
  AppServerNotification,
  AppServerRequest,
  AppServerWireMessage,
  InitializeParams,
  JsonRpcErrorShape,
  JsonRpcId,
} from './protocol';

export interface AppServerRpcClientOptions {
  writeLine(line: string): void;
  requestTimeoutMs?: number;
}

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

export class AppServerRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'AppServerRpcError';
  }
}

/**
 * Transport-neutral JSONL client for `codex app-server --stdio`.
 *
 * SSH/process ownership intentionally lives outside this class. A runtime can
 * feed complete stdout lines into `ingestLine` and wire `writeLine` to the
 * process stdin, which keeps protocol behavior independently testable.
 */
export class AppServerRpcClient {
  private nextRequestId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly notificationListeners = new Set<(value: AppServerNotification) => void>();
  private readonly serverRequestListeners = new Set<(value: AppServerRequest) => void>();
  private initialized = false;
  private initializePromise: Promise<unknown> | null = null;
  private closedError: Error | null = null;

  constructor(private readonly options: AppServerRpcClientOptions) {}

  async initialize(params: InitializeParams): Promise<unknown> {
    if (this.initialized) return undefined;
    if (this.initializePromise) return this.initializePromise;

    this.initializePromise = this.callInternal('initialize', params)
      .then((result) => {
        this.notify('initialized', {});
        this.initialized = true;
        return result;
      })
      .finally(() => {
        this.initializePromise = null;
      });
    return this.initializePromise;
  }

  async call<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!this.initialized) {
      throw new Error(`Codex app-server is not initialized; cannot call ${method}`);
    }
    return this.callInternal(method, params) as Promise<T>;
  }

  notify(method: string, params: unknown): void {
    this.assertOpen();
    this.send({ method, params });
  }

  respond(requestId: JsonRpcId, result: unknown): void {
    this.assertOpen();
    this.send({ id: requestId, result });
  }

  respondError(requestId: JsonRpcId, error: JsonRpcErrorShape): void {
    this.assertOpen();
    this.send({ id: requestId, error });
  }

  onNotification(listener: (value: AppServerNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onServerRequest(listener: (value: AppServerRequest) => void): () => void {
    this.serverRequestListeners.add(listener);
    return () => this.serverRequestListeners.delete(listener);
  }

  ingestLine(line: string): void {
    if (this.closedError || !line.trim()) return;

    let message: AppServerWireMessage;
    try {
      message = JSON.parse(line) as AppServerWireMessage;
    } catch {
      return;
    }

    if (typeof message.id === 'number' && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new AppServerRpcError(
          message.error.message,
          message.error.code,
          message.error.data,
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method !== 'string') return;
    if (typeof message.id === 'number') {
      const request: AppServerRequest = {
        id: message.id,
        method: message.method,
        params: message.params ?? null,
      };
      for (const listener of this.serverRequestListeners) listener(request);
      return;
    }

    const notification: AppServerNotification = {
      method: message.method,
      params: message.params ?? null,
    };
    for (const listener of this.notificationListeners) listener(notification);
  }

  close(error: Error = new Error('Codex app-server transport closed')): void {
    if (this.closedError) return;
    this.closedError = error;
    this.initialized = false;
    this.initializePromise = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private callInternal(method: string, params: unknown): Promise<unknown> {
    this.assertOpen();
    const id = this.nextRequestId++;
    const timeoutMs = Math.max(100, this.options.requestTimeoutMs ?? 30_000);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private send(message: AppServerWireMessage): void {
    this.options.writeLine(JSON.stringify(message));
  }

  private assertOpen(): void {
    if (this.closedError) throw this.closedError;
  }
}
