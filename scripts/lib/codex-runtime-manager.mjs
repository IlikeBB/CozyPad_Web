import crypto from "node:crypto";

const DEFAULT_INITIALIZE_PARAMS = {
  clientInfo: {
    name: "cozypad-web-agent",
    title: "CozyPad Web Agent",
    version: "0.1.0",
  },
  capabilities: {
    experimentalApi: true,
  },
};

export function normalizeCodexRuntimeMode(value) {
  const mode = String(value || "legacy").trim().toLowerCase();
  return mode === "app-server" || mode === "auto" ? mode : "legacy";
}

function requiredIdentityPart(value, name) {
  const part = String(value || "").trim();
  if (!part) throw new Error(`Codex runtime identity requires ${name}`);
  return part;
}

export function normalizeCodexRuntimeIdentity(identity) {
  return Object.freeze({
    owner: requiredIdentityPart(identity?.owner, "owner"),
    connectionProfileId: requiredIdentityPart(
      identity?.connectionProfileId,
      "connectionProfileId",
    ),
    remoteHostFingerprint: requiredIdentityPart(
      identity?.remoteHostFingerprint,
      "remoteHostFingerprint",
    ),
    codexHomeNamespace: requiredIdentityPart(
      identity?.codexHomeNamespace,
      "codexHomeNamespace",
    ),
  });
}

export function codexRuntimeKey(identity) {
  const normalized = normalizeCodexRuntimeIdentity(identity);
  return crypto
    .createHash("sha256")
    .update(
      [
        normalized.owner,
        normalized.connectionProfileId,
        normalized.remoteHostFingerprint,
        normalized.codexHomeNamespace,
      ].join("\0"),
    )
    .digest("hex");
}

function createRpcError(message, code, data) {
  const error = new Error(message || "Codex app-server request failed");
  if (code !== undefined) error.code = code;
  if (data !== undefined) error.data = data;
  return error;
}

function extractProtocolIds(params) {
  const thread = params?.thread || params?.item?.thread;
  const turn = params?.turn || params?.item?.turn;
  const item = params?.item;
  return {
    threadId: String(params?.threadId || thread?.id || "") || undefined,
    turnId: String(params?.turnId || turn?.id || "") || undefined,
    itemId: String(params?.itemId || item?.id || "") || undefined,
  };
}

export class CodexRuntime {
  constructor(options) {
    this.identity = normalizeCodexRuntimeIdentity(options.identity);
    this.key = codexRuntimeKey(this.identity);
    this.context = options.context;
    this.startTransport = options.startTransport;
    this.initializeParams = options.initializeParams || DEFAULT_INITIALIZE_PARAMS;
    this.requestTimeoutMs = Math.max(1_000, Number(options.requestTimeoutMs || 30_000));
    this.maxReplayEvents = Math.max(50, Number(options.maxReplayEvents || 2_000));
    this.maxRestartAttempts = Math.max(0, Number(options.maxRestartAttempts ?? 2));
    this.restartBaseDelayMs = Math.max(50, Number(options.restartBaseDelayMs || 1_000));
    this.serverRequestTimeoutMs = Math.max(
      10_000,
      Number(options.serverRequestTimeoutMs || 5 * 60_000),
    );
    this.listeners = new Set();
    this.pending = new Map();
    this.serverRequests = new Map();
    this.serverRequestTimers = new Map();
    this.events = [];
    this.sequence = 0;
    this.nextRequestId = 1;
    this.restartAttempts = 0;
    this.status = "starting";
    this.statusDetail = "";
    this.transport = null;
    this.stdoutBuffer = "";
    this.stderrTail = "";
    this.closed = false;
    this.startPromise = null;
    this.restartTimer = null;
  }

  snapshot() {
    return {
      key: this.key,
      identity: this.identity,
      status: this.status,
      detail: this.statusDetail,
      sequence: this.sequence,
      subscribers: this.listeners.size,
      restartAttempts: this.restartAttempts,
    };
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(message) {
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch {
        // A broken browser subscriber must not stop the shared runtime.
      }
    }
  }

  setStatus(status, detail = "") {
    this.status = status;
    this.statusDetail = String(detail || "").slice(0, 2_000);
    this.emit({ type: "status", runtime: this.snapshot() });
  }

  async start() {
    if (this.closed) throw new Error("Codex runtime is closed");
    if (this.status === "ready" && this.transport) return this;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.startOnce()
      .then(() => this)
      .finally(() => {
        this.startPromise = null;
      });
    return this.startPromise;
  }

  async startOnce() {
    this.setStatus(this.restartAttempts ? "reconnecting" : "starting");
    const transport = await this.startTransport(this.identity, this.context);
    if (this.closed) {
      transport.kill?.();
      throw new Error("Codex runtime closed during startup");
    }

    this.transport = transport;
    this.stdoutBuffer = "";
    transport.stdout?.on("data", (chunk) => this.handleStdout(chunk));
    transport.stderr?.on("data", (chunk) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-8_000);
    });
    transport.on?.("error", (error) => this.handleTransportEnd(error));
    transport.on?.("close", (code) => {
      const detail = this.stderrTail || `Codex app-server exited with code ${code ?? "unknown"}`;
      this.handleTransportEnd(new Error(detail));
    });

    await this.call("initialize", this.initializeParams, { allowStarting: true });
    this.notify("initialized", {});
    this.restartAttempts = 0;
    this.setStatus("ready");
  }

  notify(method, params = {}) {
    this.writeMessage({ method, params });
  }

  call(method, params = {}, options = {}) {
    if (!options.allowStarting && this.status !== "ready") {
      return Promise.reject(new Error(`Codex runtime is not ready (${this.status})`));
    }
    const id = this.nextRequestId++;
    const timeoutMs = Math.max(1_000, Number(options.timeoutMs || this.requestTimeoutMs));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.writeMessage({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  respond(id, result, error) {
    if (!this.serverRequests.has(id)) {
      throw new Error("Unknown or already resolved Codex app-server request");
    }
    this.serverRequests.delete(id);
    clearTimeout(this.serverRequestTimers.get(id));
    this.serverRequestTimers.delete(id);
    if (error) {
      this.writeMessage({ id, error });
      return;
    }
    this.writeMessage({ id, result: result ?? {} });
  }

  writeMessage(message) {
    const stdin = this.transport?.stdin;
    if (!stdin?.writable) throw new Error("Codex app-server stdin is unavailable");
    stdin.write(`${JSON.stringify(message)}\n`, "utf8");
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk.toString("utf8");
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() || "";
    for (const line of lines) this.handleLine(line);
  }

  handleLine(line) {
    const text = String(line || "").trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      this.emit({ type: "protocol_error", error: "Codex app-server emitted invalid JSON" });
      return;
    }

    if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || message.error)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(createRpcError(message.error.message, message.error.code, message.error.data));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (Object.hasOwn(message, "id") && message.method) {
      const request = { id: message.id, method: message.method, params: message.params || {} };
      this.serverRequests.set(message.id, request);
      const timer = setTimeout(() => {
        this.serverRequestTimers.delete(message.id);
        if (!this.serverRequests.delete(message.id) || !this.transport) return;
        if (message.method.includes("commandExecution") || message.method.includes("fileChange")) {
          this.writeMessage({ id: message.id, result: { decision: "decline" } });
        } else if (message.method.includes("permissions")) {
          this.writeMessage({
            id: message.id,
            result: { permissions: {}, scope: "turn" },
          });
        } else if (message.method === "item/tool/requestUserInput") {
          this.writeMessage({ id: message.id, result: { answers: {} } });
        } else {
          this.writeMessage({
            id: message.id,
            error: { code: -32_000, message: "CozyPad client request timed out" },
          });
        }
      }, this.serverRequestTimeoutMs);
      timer.unref?.();
      this.serverRequestTimers.set(message.id, timer);
      this.emit({
        type: "server_request",
        request,
      });
      return;
    }

    if (message.method) {
      const params = message.params || {};
      const ids = extractProtocolIds(params);
      const event = {
        eventId: crypto.randomUUID(),
        sequence: ++this.sequence,
        localSessionId: this.key,
        connectionProfileId: this.identity.connectionProfileId,
        ...ids,
        method: message.method,
        timestamp: new Date().toISOString(),
        rawEventVersion: "v1",
        payload: params,
      };
      this.events.push(event);
      if (this.events.length > this.maxReplayEvents) {
        this.events.splice(0, this.events.length - this.maxReplayEvents);
      }
      this.emit({ type: "event", event });
    }
  }

  replay(afterSequence = 0) {
    const cursor = Math.max(0, Number(afterSequence || 0));
    return this.events.filter((event) => event.sequence > cursor);
  }

  pendingServerRequests() {
    return [...this.serverRequests.values()];
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  handleTransportEnd(error) {
    if (this.closed || !this.transport) return;
    this.transport = null;
    for (const timer of this.serverRequestTimers.values()) clearTimeout(timer);
    this.serverRequestTimers.clear();
    this.serverRequests.clear();
    this.rejectPending(error);
    this.scheduleRestart(error);
  }

  scheduleRestart(error) {
    if (this.closed || this.restartTimer) return;
    if (this.restartAttempts >= this.maxRestartAttempts) {
      this.setStatus("unavailable", error?.message || "Codex app-server stopped");
      return;
    }

    this.restartAttempts += 1;
    const delay = Math.min(30_000, this.restartBaseDelayMs * 2 ** (this.restartAttempts - 1));
    this.setStatus("reconnecting", error?.message || "Codex app-server stopped");
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.start().catch((restartError) => {
        this.scheduleRestart(restartError);
      });
    }, delay);
    this.restartTimer.unref?.();
  }

  close(reason = "Codex runtime closed") {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.rejectPending(new Error(reason));
    for (const timer of this.serverRequestTimers.values()) clearTimeout(timer);
    this.serverRequestTimers.clear();
    this.serverRequests.clear();
    try {
      this.transport?.kill?.();
    } catch {
      // Best-effort shutdown.
    }
    this.transport = null;
    this.setStatus("stopped", reason);
    this.listeners.clear();
  }
}

export class CodexRuntimeManager {
  constructor(options = {}) {
    if (typeof options.startTransport !== "function") {
      throw new Error("CodexRuntimeManager requires startTransport");
    }
    this.mode = normalizeCodexRuntimeMode(options.mode);
    this.options = options;
    this.runtimes = new Map();
    this.creating = new Map();
  }

  async acquire(identity, context) {
    if (this.mode === "legacy") {
      throw new Error("Codex app-server runtime is disabled by feature flag");
    }
    const normalized = normalizeCodexRuntimeIdentity(identity);
    const key = codexRuntimeKey(normalized);
    const existing = this.runtimes.get(key);
    if (existing && !existing.closed) {
      existing.context = context;
      await existing.start();
      return existing;
    }
    if (this.creating.has(key)) return this.creating.get(key);

    const creation = (async () => {
      const runtime = new CodexRuntime({
        ...this.options,
        identity: normalized,
        context,
      });
      this.runtimes.set(key, runtime);
      try {
        await runtime.start();
        return runtime;
      } catch (error) {
        runtime.close(error instanceof Error ? error.message : "Codex runtime startup failed");
        if (this.runtimes.get(key) === runtime) this.runtimes.delete(key);
        throw error;
      }
    })();
    this.creating.set(key, creation);
    try {
      return await creation;
    } finally {
      if (this.creating.get(key) === creation) this.creating.delete(key);
    }
  }

  get(identity) {
    return this.runtimes.get(codexRuntimeKey(identity)) || null;
  }

  list(owner = "") {
    return [...this.runtimes.values()]
      .filter((runtime) => !owner || runtime.identity.owner === owner)
      .map((runtime) => runtime.snapshot());
  }

  close(identity, reason) {
    const key = codexRuntimeKey(identity);
    const runtime = this.runtimes.get(key);
    if (!runtime) return false;
    runtime.close(reason);
    this.runtimes.delete(key);
    return true;
  }

  closeOwner(owner, reason = "Codex runtime owner disconnected") {
    let closed = 0;
    for (const [key, runtime] of this.runtimes) {
      if (runtime.identity.owner !== owner) continue;
      runtime.close(reason);
      this.runtimes.delete(key);
      closed += 1;
    }
    return closed;
  }

  shutdown(reason = "Codex runtime manager shutdown") {
    for (const runtime of this.runtimes.values()) runtime.close(reason);
    this.runtimes.clear();
  }
}
