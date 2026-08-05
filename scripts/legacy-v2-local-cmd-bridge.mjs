import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const PORT = Number(process.env.COZYPAD_LOCAL_CMD_PORT || 5175);
const PAIRING_TOKEN = String(process.env.COZYPAD_LOCAL_CMD_TOKEN || "").trim();
const ALLOWED_ORIGINS = new Set(
  [
    "https://cozypad.modoubletw.com",
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    ...String(process.env.COZYPAD_LOCAL_CMD_ALLOWED_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  ]
    .map(normalizeOrigin)
    .filter(Boolean),
);
const localCodexSessions = new Map();
const LOCAL_CODEX_BUFFER_LIMIT = Number(process.env.COZYPAD_LOCAL_CODEX_BUFFER_LIMIT || 160000);
const LOCAL_CODEX_PENDING_LIMIT = Number(process.env.COZYPAD_LOCAL_CODEX_PENDING_LIMIT || 8);
const LOCAL_HELPER_DATA_DIR = String(
  process.env.COZYPAD_LOCAL_CMD_DATA_DIR || path.join(os.homedir(), ".cozypad", "local-helper"),
);
const LOCAL_HELPER_KNOWN_HOSTS_FILE = path.join(LOCAL_HELPER_DATA_DIR, "known_hosts");

function compactText(value, maxLength = 160) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function codexPromptArg(value) {
  return String(value || "").replace(/\r?\n/g, "\\n");
}

function normalizeLocalCodexSessionId(value) {
  const id = String(value || "default").trim();
  return /^[A-Za-z0-9:_-]{1,160}$/.test(id) ? id : "default";
}

function getLocalCodexSession(id = "default") {
  const sessionId = normalizeLocalCodexSessionId(id);
  const existing = localCodexSessions.get(sessionId);
  if (existing) {
    return existing;
  }

  const session = {
    id: sessionId,
    activeChild: null,
    buffer: "",
    pendingRequests: [],
    sockets: new Set(),
  };
  localCodexSessions.set(sessionId, session);
  return session;
}

function batchQuote(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function powershellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function serverTargetLabel(server) {
  const host = server?.source === "ssh-config" ? server.alias || server.name : server?.host;
  const userPrefix = server?.user ? `${server.user}@` : "";
  const portSuffix = server?.port ? `:${server.port}` : "";
  return `${userPrefix}${host || "unknown"}${portSuffix}`;
}

function getStrictHostKeyChecking(server) {
  const value = String(server?.strictHostKeyChecking || "accept-new").trim().toLowerCase();
  return value === "yes" ? "yes" : "accept-new";
}

function validateRemoteBindingForLocalHelper(server) {
  if (server?.apiBaseUrl && server?.commandToken) {
    return;
  }

  if (server?.source === "local" && server.identityFile && !existsSync(server.identityFile)) {
    throw new Error("SSH key is not available on this computer. Refresh CozyPad and use API binding.");
  }

  if (server?.source === "ssh-config" && server.configFile && !existsSync(server.configFile)) {
    throw new Error("SSH config is not available on this computer.");
  }
}

function normalizeApiBaseUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "";
    }
    return url.origin;
  } catch {
    return "";
  }
}

function buildSshArgs(server, options = {}) {
  const args = [];
  const connectTimeout = options.connectTimeout || 12;
  const connectionAttempts = options.connectionAttempts || 1;
  const knownHostsFile = options.knownHostsFile || LOCAL_HELPER_KNOWN_HOSTS_FILE;

  if (options.batch !== false) {
    args.push("-o", "BatchMode=yes");
  }

  args.push(
    "-o",
    `ConnectTimeout=${connectTimeout}`,
    "-o",
    `ConnectionAttempts=${connectionAttempts}`,
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    "-o",
    `UserKnownHostsFile=${knownHostsFile}`,
    "-o",
    "GlobalKnownHostsFile=NUL",
    "-o",
    `StrictHostKeyChecking=${getStrictHostKeyChecking(server)}`,
    "-o",
    "HashKnownHosts=yes",
  );

  if (server?.source === "ssh-config") {
    if (server.configFile) {
      args.push("-F", server.configFile);
    }
    args.push(server.alias || server.name);
    return args;
  }

  if (server?.identityFile) {
    args.push("-o", "IdentitiesOnly=yes");
    args.push("-i", server.identityFile);
  }

  if (server?.port) {
    args.push("-p", String(server.port));
  }

  const target = server?.user ? `${server.user}@${server.host}` : server?.host;
  args.push(target);
  return args;
}

function normalizeRemoteBinding(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const name = compactText(value.name, 80);
  const source = value.source === "ssh-config" ? "ssh-config" : "local";
  const host = compactText(value.host, 180);
  const alias = compactText(value.alias, 100);
  const target = source === "ssh-config" ? alias || name : host;

  if (!name || !target) {
    return null;
  }

  const port = Number(value.port || 0);
  return {
    id: compactText(value.id, 120),
    source,
    name,
    alias,
    host,
    user: compactText(value.user, 120),
    port: Number.isFinite(port) && port > 0 ? port : undefined,
    identityFile: compactText(value.identityFile, 500),
    configFile: compactText(value.configFile, 500),
    knownHostsFile: compactText(value.knownHostsFile, 500),
    strictHostKeyChecking: compactText(value.strictHostKeyChecking, 40),
    defaultPath: compactText(value.defaultPath || "~", 200),
    apiBaseUrl: normalizeApiBaseUrl(value.apiBaseUrl),
    commandToken: compactText(value.commandToken, 260),
    commandExpiresAt: compactText(value.commandExpiresAt, 80),
  };
}

async function createRemoteSshWrapper(server) {
  validateRemoteBindingForLocalHelper(server);
  await mkdir(LOCAL_HELPER_DATA_DIR, { recursive: true });
  const wrapperDir = await mkdtemp(path.join(os.tmpdir(), "cozypad-codex-ssh-"));
  const wrapperPath = path.join(wrapperDir, "cozypad-ssh.cmd");

  if (server.apiBaseUrl && server.commandToken) {
    const bridgeScriptPath = path.join(wrapperDir, "cozypad-ssh-api.mjs");
    const powershellWrapperPath = path.join(wrapperDir, "cozypad-ssh.ps1");
    await writeFile(
      bridgeScriptPath,
      [
        `const uri = ${JSON.stringify(`${server.apiBaseUrl}/api/ssh/codex-command`)};`,
        `const token = ${JSON.stringify(server.commandToken)};`,
        `const cwd = ${JSON.stringify(server.defaultPath || "")};`,
        "const remoteCommand = process.argv.slice(2).join(' ').trim();",
        "if (!remoteCommand) {",
        "  process.stderr.write('Remote command is required\\n');",
        "  process.exit(1);",
        "}",
        "try {",
        "  const response = await fetch(uri, {",
        "    method: 'POST',",
        "    headers: {",
        "      authorization: `Bearer ${token}`,",
        "      'content-type': 'application/json; charset=utf-8',",
        "      'x-cozypad-request': 'app',",
        "    },",
        "    body: JSON.stringify({ command: remoteCommand, cwd }),",
        "  });",
        "  const text = await response.text();",
        "  let result = null;",
        "  try {",
        "    result = text ? JSON.parse(text) : null;",
        "  } catch {",
        "    result = null;",
        "  }",
        "  if (result?.stdout) { process.stdout.write(String(result.stdout)); }",
        "  if (result?.stderr) { process.stderr.write(String(result.stderr)); }",
        "  if (!response.ok || !result?.ok) {",
        "    if (!result && text) { process.stderr.write(text); }",
        "    process.exit(1);",
        "  }",
        "} catch (error) {",
        "  process.stderr.write(`${error?.message || String(error)}\\n`);",
        "  process.exit(1);",
        "}",
        "",
      ].join("\r\n"),
      "utf8",
    );
    await writeFile(
      wrapperPath,
      [
        "@echo off",
        "setlocal",
        `${batchQuote(process.execPath)} "%~dp0cozypad-ssh-api.mjs" %*`,
        "exit /b %ERRORLEVEL%",
        "",
      ].join("\r\n"),
      "utf8",
    );
    await writeFile(
      powershellWrapperPath,
      [
        "param([Parameter(ValueFromRemainingArguments=$true)][string[]]$RemoteCommand)",
        `& ${powershellSingleQuote(wrapperPath)} @RemoteCommand`,
        "exit $LASTEXITCODE",
        "",
      ].join("\r\n"),
      "utf8",
    );
    return { wrapperDir, wrapperPath };
  }

  const sshArgs = buildSshArgs(server).map(batchQuote).join(" ");
  const powershellWrapperPath = path.join(wrapperDir, "cozypad-ssh.ps1");
  await writeFile(
    wrapperPath,
    [
      "@echo off",
      "setlocal",
      `ssh.exe ${sshArgs} %*`,
      "exit /b %ERRORLEVEL%",
      "",
    ].join("\r\n"),
    "utf8",
  );
  await writeFile(
    powershellWrapperPath,
    [
      "param([Parameter(ValueFromRemainingArguments=$true)][string[]]$RemoteCommand)",
      `& ${powershellSingleQuote(wrapperPath)} @RemoteCommand`,
      "exit $LASTEXITCODE",
      "",
    ].join("\r\n"),
    "utf8",
  );

  return { wrapperDir, wrapperPath };
}

function buildRemoteCodexPrompt(server, userPrompt) {
  return `
You are Codex connected through CozyPad to the SSH server shown beside the terminal.

Binding:
- server name: ${server.name}
- target: ${serverTargetLabel(server)}
- default remote path: ${server.defaultPath || "~"}

All work requested by the user must happen on this remote SSH server.
Treat "this machine", "home", "~", file paths, shell commands, installs, git work,
and diagnostics as referring to the remote SSH server unless the user explicitly says otherwise.

Use this PowerShell helper invocation for every inspection or modification:
& $env:COZYPAD_SSH_COMMAND "<remote POSIX shell command>"

Rules:
- Do not inspect, edit, create, delete, install, or execute on the local Windows computer.
- Do not mention or reveal local key paths, temporary helper paths, or local config paths.
- Do not print, echo, or reveal the value of COZYPAD_SSH_COMMAND.
- Prefer non-interactive remote shell commands through COZYPAD_SSH_COMMAND.
- If SSH auth, permissions, or command execution fails, report the exact remote failure.
- Keep the final answer concise and state what changed on ${server.name}.

User request:
${String(userPrompt || "").trim()}
`.trim();
}

function parseCodexRequest(rawText) {
  const text = String(rawText || "").trim();
  if (!text) {
    return { prompt: "", binding: null };
  }

  try {
    const data = JSON.parse(text);
    if (data?.type === "prompt") {
      const prompt = String(data.prompt || "").trim();
      const workflowContext = String(data.workflowContext || data.context || "").trim();
      return {
        prompt,
        displayPrompt: String(data.displayPrompt || prompt).trim(),
        workflowContext,
        binding: normalizeRemoteBinding(data.binding),
      };
    }
  } catch {
    // Backward compatibility for older browser clients that send plain text.
  }

  return { prompt: text, displayPrompt: text, workflowContext: "", binding: null };
}

function getSpawnTarget(command, args = []) {
  if (process.platform === "win32" && /\.cmd$/i.test(command)) {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", command, ...args],
    };
  }

  return { command, args };
}

function batchCommandQuote(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function getPathValue(env = process.env) {
  return String(env.PATH || env.Path || env.path || "");
}

function splitPathEntries(value) {
  const seen = new Set();
  return String(value || "")
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean)
    .filter((entry) => {
      const key = entry.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function pushCodexCandidate(candidates, source, command, args = []) {
  if (!command) {
    return;
  }

  candidates.push({ source, command, args });
}

function pushExistingCodexCommand(candidates, source, command, args = []) {
  if (command && existsSync(command)) {
    pushCodexCandidate(candidates, source, command, args);
  }
}

function getCodexSearchDirectories() {
  const directories = [
    path.join(os.homedir(), ".codex", ".sandbox-bin"),
    path.join(os.homedir(), ".codex", "plugins", ".plugin-appserver"),
    path.join(os.homedir(), ".codex", "bin"),
    process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : "",
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "nodejs") : "",
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "nodejs") : "",
    process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "nodejs") : "",
    process.env.npm_config_prefix ? String(process.env.npm_config_prefix) : "",
    path.dirname(process.execPath),
    ...splitPathEntries(getPathValue()),
  ];
  const seen = new Set();

  return directories
    .filter(Boolean)
    .map((directory) => path.resolve(directory))
    .filter((directory) => {
      const key = directory.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function getCodexCandidates() {
  const candidates = [];
  const configuredCommand = String(process.env.COZYPAD_CODEX_COMMAND || "").trim();

  if (configuredCommand) {
    pushCodexCandidate(candidates, "configured", configuredCommand);
  }

  const executableNames =
    process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex"] : ["codex"];
  for (const directory of getCodexSearchDirectories()) {
    for (const executableName of executableNames) {
      const source =
        directory.toLowerCase().includes(`${path.sep}.codex${path.sep}`) ||
        directory.toLowerCase().endsWith(`${path.sep}.codex`)
          ? "native-user"
          : directory.toLowerCase().includes(`${path.sep}npm`)
            ? "npm-global"
            : "auto";
      pushExistingCodexCommand(candidates, source, path.join(directory, executableName));
    }
  }

  candidates.push(
    { source: "native-path", command: "codex.exe", args: [] },
    { source: "path-cmd", command: "codex.cmd", args: [] },
    { source: "path", command: "codex", args: [] },
  );

  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.command}\0${candidate.args.join("\0")}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function detectCodexCli() {
  let lastError = "";

  for (const candidate of getCodexCandidates()) {
    const result = await runProcess(candidate.command, [...candidate.args, "--version"], {
      timeoutMs: 8000,
    });
    const version = (result.stdout || result.stderr || "").trim().split(/\r?\n/)[0] || "";

    if (result.ok && version) {
      return {
        available: true,
        source: candidate.source,
        command: candidate.command,
        args: candidate.args,
        version,
      };
    }

    lastError = (result.stderr || result.stdout || `exit ${result.code ?? "unknown"}`).trim();
  }

  return {
    available: false,
    source: "",
    command: "",
    args: [],
    version: "",
    error: lastError || "Codex CLI not found",
  };
}

function normalizeOrigin(value) {
  try {
    return new URL(String(value || "")).origin.toLowerCase();
  } catch {
    return "";
  }
}

function corsHeaders(request) {
  const origin = normalizeOrigin(request.headers.origin);
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    return {};
  }

  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-cozypad-request, x-cozypad-local-token",
    "access-control-allow-private-network": "true",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

function isAllowedOrigin(request) {
  const origin = normalizeOrigin(request.headers.origin);
  return Boolean(origin && ALLOWED_ORIGINS.has(origin));
}

function getRequestToken(request, url = null) {
  const headerToken = String(request.headers["x-cozypad-local-token"] || "").trim();
  if (headerToken) {
    return headerToken;
  }

  return String(url?.searchParams.get("token") || "").trim();
}

function isAuthorized(request, url = null) {
  if (!PAIRING_TOKEN) {
    return true;
  }

  return getRequestToken(request, url) === PAIRING_TOKEN;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;

    try {
      const target = getSpawnTarget(command, args);
      child = spawn(target.command, target.args, {
        cwd: options.cwd || os.homedir(),
        env: options.env || process.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ ok: false, code: -1, stdout, stderr: error.message });
      return;
    }

    const timeout = setTimeout(() => {
      child.kill();
    }, options.timeoutMs || 10000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ ok: false, code: -1, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

async function getCodexStatus() {
  const cli = await detectCodexCli();

  if (!cli.available) {
    return {
      available: false,
      version: "",
      bound: false,
      source: "",
      error: cli.error || "Codex CLI not found",
    };
  }

  const loginResult = await runProcess(cli.command, [...cli.args, "login", "status"], {
    timeoutMs: 12000,
  });
  const loginOutput = `${loginResult.stdout}\n${loginResult.stderr}`.trim();
  const loginRequired = /not logged in|not authenticated|not signed in|login required|please log in/i.test(
    loginOutput,
  );

  return {
    available: true,
    version: cli.version,
    bound: loginResult.ok && !loginRequired,
    source: cli.source,
    status: loginOutput,
  };
}

async function launchCodexLogin() {
  const cli = await detectCodexCli();
  if (!cli.available) {
    throw new Error(cli.error || "Codex CLI not found");
  }

  const loginCommand = [
    batchCommandQuote(cli.command),
    ...cli.args.map(batchCommandQuote),
    "login",
  ].join(" ");
  const child = spawn("cmd.exe", ["/d", "/k", `title CozyPad Codex Login & ${loginCommand}`], {
    cwd: os.homedir(),
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  return child.pid;
}

function sendJson(response, statusCode, payload, headers = {}) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

function websocketAccept(key) {
  return crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function sendWebSocketText(socket, text) {
  if (socket.destroyed || !socket.writable) {
    return;
  }

  const payload = Buffer.from(String(text), "utf8");
  let header;

  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  try {
    socket.write(Buffer.concat([header, payload]));
  } catch {
    // The browser closed while cmd.exe was still writing.
  }
}

function closeWebSocket(socket) {
  if (!socket.destroyed) {
    try {
      socket.end(Buffer.from([0x88, 0x00]));
    } catch {
      socket.destroy();
    }
  }
}

function trimLocalCodexBuffer(value) {
  const text = String(value || "");
  if (text.length <= LOCAL_CODEX_BUFFER_LIMIT) {
    return text;
  }
  return `[CozyPad Local Codex] output truncated\r\n${text.slice(-LOCAL_CODEX_BUFFER_LIMIT)}`;
}

function broadcastLocalCodex(session, text) {
  const output = String(text || "");
  if (!output) {
    return;
  }

  session.buffer = trimLocalCodexBuffer(`${session.buffer}${output}`);
  for (const socket of session.sockets) {
    sendWebSocketText(socket, output);
  }
}

function queueLocalCodexRequest(session, request) {
  if (session.pendingRequests.length >= LOCAL_CODEX_PENDING_LIMIT) {
    broadcastLocalCodex(
      session,
      `\r\n[CozyPad Local Codex] follow-up queue is full (${LOCAL_CODEX_PENDING_LIMIT}). Wait for the current run to finish.\r\n`,
    );
    return;
  }

  session.pendingRequests.push({ ...request, queuedDuringRun: true });
  broadcastLocalCodex(
    session,
    `\r\n[CozyPad Local Codex] queued follow-up (${session.pendingRequests.length} pending)\r\n`,
  );
}

function runNextQueuedCodexRequest(session) {
  const nextRequest = session.pendingRequests.shift();
  if (!nextRequest) {
    broadcastLocalCodex(session, "[CozyPad Local Codex] ready\r\n");
    return;
  }

  broadcastLocalCodex(
    session,
    `\r\n[CozyPad Local Codex] running queued follow-up (${session.pendingRequests.length} remaining)\r\n`,
  );
  setTimeout(() => {
    void runLocalCodexRequest(session, nextRequest);
  }, 0);
}

async function runLocalCodexRequest(session, request) {
  const { prompt, displayPrompt, workflowContext, binding, queuedDuringRun } = request;
  if (!prompt) {
    return;
  }

  if (session.activeChild) {
    queueLocalCodexRequest(session, request);
    return;
  }

  let codexPrompt = prompt;
  let codexEnv = process.env;
  const queuedTranscript =
    queuedDuringRun && session.buffer
      ? `Latest CozyPad Codex transcript before this follow-up:\n${String(session.buffer).slice(-80000)}`
      : "";
  const contextParts = [workflowContext, queuedTranscript].filter((part) =>
    String(part || "").trim(),
  );
  const effectivePrompt =
    contextParts.length > 0
      ? `${contextParts.join("\n\n")}\n\nNew user request:\n${prompt}`
      : prompt;

  if (binding) {
    try {
      const wrapper = await createRemoteSshWrapper(binding);
      const wrapperPathValue = `${wrapper.wrapperDir}${path.delimiter}${getPathValue(process.env)}`;
      codexPrompt = buildRemoteCodexPrompt(binding, effectivePrompt);
      codexEnv = {
        ...process.env,
        PATH: wrapperPathValue,
        Path: wrapperPathValue,
        path: wrapperPathValue,
        COZYPAD_BOUND_SSH_SERVER: binding.name,
        COZYPAD_SSH_COMMAND: wrapper.wrapperPath,
      };
      broadcastLocalCodex(
        session,
        `[CozyPad Local Codex] bound to SSH server ${binding.name} (${serverTargetLabel(
          binding,
        )})\r\n`,
      );
    } catch (error) {
      broadcastLocalCodex(
        session,
        `\r\n[CozyPad Local Codex] remote binding failed: ${error.message}\r\n`,
      );
      runNextQueuedCodexRequest(session);
      return;
    }
  } else {
    broadcastLocalCodex(
      session,
      "[CozyPad Local Codex] warning: no SSH server binding was provided\r\n",
    );
    codexPrompt = effectivePrompt;
  }

  broadcastLocalCodex(session, `> ${displayPrompt || prompt}\r\n`);
  const cli = await detectCodexCli();
  if (!cli.available) {
    broadcastLocalCodex(
      session,
      `\r\n[CozyPad Local Codex] ${cli.error || "Codex CLI not found"}\r\n`,
    );
    runNextQueuedCodexRequest(session);
    return;
  }

  const codexStatus = await getCodexStatus();
  if (!codexStatus.bound) {
    broadcastLocalCodex(
      session,
      "\r\n[CozyPad Local Codex] Codex CLI is not logged in. Press 登入 Codex once, finish OpenAI login, then press 重新檢查.\r\n",
    );
    runNextQueuedCodexRequest(session);
    return;
  }

  const target = getSpawnTarget(cli.command, [
    ...cli.args,
    "exec",
    "--skip-git-repo-check",
    "--color",
    "never",
    "--dangerously-bypass-approvals-and-sandbox",
    codexPromptArg(codexPrompt),
  ]);
  try {
    session.activeChild = spawn(target.command, target.args, {
      cwd: os.homedir(),
      env: codexEnv,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    broadcastLocalCodex(session, `\r\n[CozyPad Local Codex] ${error.message}\r\n`);
    session.activeChild = null;
    runNextQueuedCodexRequest(session);
    return;
  }

  session.activeChild.stdout.on("data", (data) =>
    broadcastLocalCodex(session, data.toString("utf8")),
  );
  session.activeChild.stderr.on("data", (data) =>
    broadcastLocalCodex(session, data.toString("utf8")),
  );
  session.activeChild.on("error", (error) => {
    broadcastLocalCodex(session, `\r\n[CozyPad Local Codex] ${error.message}\r\n`);
    session.activeChild = null;
    runNextQueuedCodexRequest(session);
  });
  session.activeChild.on("close", (code) => {
    broadcastLocalCodex(
      session,
      `\r\n[CozyPad Local Codex] exited with code ${code ?? "unknown"}\r\n`,
    );
    session.activeChild = null;
    runNextQueuedCodexRequest(session);
  });
}

function attachLocalCodexSocket(session, socket) {
  session.sockets.add(socket);
  socket.setKeepAlive?.(true, 30000);

  if (session.buffer) {
    sendWebSocketText(socket, session.buffer);
  } else {
    sendWebSocketText(
      socket,
      `[CozyPad Local Codex] connected ${os.userInfo().username}@${os.hostname()}\r\n`,
    );
  }
  sendWebSocketText(
    socket,
    session.activeChild
      ? "[CozyPad Local Codex] codex is still running in background\r\n"
      : "[CozyPad Local Codex] ready\r\n",
  );

  socket.on("close", () => {
    session.sockets.delete(socket);
  });
  socket.on("error", () => {
    session.sockets.delete(socket);
  });
}

function rejectSocket(socket, statusCode, message) {
  socket.write(`HTTP/1.1 ${statusCode} ${message}\r\n\r\n`);
  socket.destroy();
}

function readWebSocketFrames(state, chunk, onMessage, onClose) {
  state.buffer = Buffer.concat([state.buffer, chunk]);

  while (state.buffer.length >= 2) {
    const first = state.buffer[0];
    const second = state.buffer[1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (state.buffer.length < 4) {
        return;
      }
      length = state.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (state.buffer.length < 10) {
        return;
      }
      const bigLength = state.buffer.readBigUInt64BE(2);
      if (bigLength > BigInt(1024 * 1024)) {
        onClose();
        return;
      }
      length = Number(bigLength);
      offset = 10;
    }

    const maskOffset = masked ? 4 : 0;
    const frameLength = offset + maskOffset + length;
    if (state.buffer.length < frameLength) {
      return;
    }

    let payload = state.buffer.slice(offset + maskOffset, frameLength);
    if (masked) {
      const mask = state.buffer.slice(offset, offset + 4);
      payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    }

    state.buffer = state.buffer.slice(frameLength);

    if (opcode === 0x8) {
      onClose();
      return;
    }

    if (opcode === 0x1 || opcode === 0x2) {
      onMessage(payload);
    }
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  const headers = corsHeaders(request);

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      ...headers,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/local-cmd/health") {
    if (!isAllowedOrigin(request)) {
      sendJson(response, 403, { ok: false, error: "Origin is not allowed" }, headers);
      return;
    }

    const authorized = isAuthorized(request, url);
    const codex = authorized
      ? await getCodexStatus()
      : { available: false, version: "", bound: false };
    sendJson(
      response,
      200,
      {
        ok: true,
        requiresToken: Boolean(PAIRING_TOKEN),
        authorized,
        shell: "cmd.exe",
        codex,
        ...(authorized
          ? {
              host: os.hostname(),
              user: os.userInfo().username,
            }
          : {}),
        port: PORT,
      },
      headers,
    );
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/local-codex/login") {
    if (!isAllowedOrigin(request)) {
      sendJson(response, 403, { ok: false, error: "Origin is not allowed" }, headers);
      return;
    }

    if (!isAuthorized(request, url)) {
      sendJson(response, 401, { ok: false, error: "Pairing token is required" }, headers);
      return;
    }

    try {
      const pid = await launchCodexLogin();
      sendJson(response, 200, { ok: true, pid }, headers);
    } catch (error) {
      sendJson(
        response,
        500,
        { ok: false, error: error instanceof Error ? error.message : "Failed to launch codex login" },
        headers,
      );
    }
    return;
  }

  sendJson(response, 404, { ok: false, error: "Not found" }, headers);
});

server.on("upgrade", (request, socket) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  const isCmdTerminal = url.pathname === "/api/local-cmd/terminal";
  const isCodexSession = url.pathname === "/api/local-codex/session";

  if (!isCmdTerminal && !isCodexSession) {
    rejectSocket(socket, 404, "Not Found");
    return;
  }

  if (!isAllowedOrigin(request)) {
    rejectSocket(socket, 403, "Origin is not allowed");
    return;
  }

  if (!isAuthorized(request, url)) {
    rejectSocket(socket, 401, "Pairing token is required");
    return;
  }

  const key = request.headers["sec-websocket-key"];
  if (!key) {
    rejectSocket(socket, 400, "Bad Request");
    return;
  }

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
      "\r\n",
    ].join("\r\n"),
  );

  if (isCodexSession) {
    const frameState = { buffer: Buffer.alloc(0) };
    const localCodexSession = getLocalCodexSession(url.searchParams.get("sessionId") || "default");

    attachLocalCodexSocket(localCodexSession, socket);

    socket.on("data", (chunk) => {
      readWebSocketFrames(
        frameState,
        chunk,
        async (payload) => {
          const { prompt, displayPrompt, workflowContext, binding } = parseCodexRequest(
            payload.toString("utf8"),
          );
          if (!prompt) {
            return;
          }

          await runLocalCodexRequest(localCodexSession, {
            prompt,
            displayPrompt,
            workflowContext,
            binding,
          });
        },
        () => {
          closeWebSocket(socket);
        },
      );
    });
    return;
  }

  const child = spawn("cmd.exe", ["/Q"], {
    cwd: os.homedir(),
    env: { ...process.env, PROMPT: "$P$G" },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const frameState = { buffer: Buffer.alloc(0) };

  sendWebSocketText(
    socket,
    `[CozyPad Local CMD] connected ${os.userInfo().username}@${os.hostname()}\r\n`,
  );

  child.stdout.on("data", (chunk) => sendWebSocketText(socket, chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => sendWebSocketText(socket, chunk.toString("utf8")));
  child.on("error", (error) => {
    sendWebSocketText(socket, `\r\n[CozyPad Local CMD] ${error.message}\r\n`);
    closeWebSocket(socket);
  });
  child.on("close", (code) => {
    sendWebSocketText(socket, `\r\n[CozyPad Local CMD] cmd exited with code ${code ?? "unknown"}\r\n`);
    closeWebSocket(socket);
  });

  socket.on("data", (chunk) => {
    readWebSocketFrames(
      frameState,
      chunk,
      (payload) => child.stdin.write(payload.toString("utf8")),
      () => {
        child.kill();
        closeWebSocket(socket);
      },
    );
  });

  socket.on("close", () => child.kill());
  socket.on("error", () => child.kill());
});

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(
      `CozyPad Local CMD bridge is already running on http://127.0.0.1:${PORT}. You can keep using the existing helper.`,
    );
    process.exit(0);
  }

  console.error(error);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`CozyPad Local CMD bridge listening on http://127.0.0.1:${PORT}`);
  console.log(`Allowed origins: ${[...ALLOWED_ORIGINS].join(", ")}`);
  if (PAIRING_TOKEN) {
    console.log("");
    console.log("Pairing token for this Windows user:");
    console.log(PAIRING_TOKEN);
    console.log("");
    console.log("Paste this token into CozyPad Local CMD for the matching logged-in user.");
  } else {
    console.log("Pairing token disabled. Access is limited to allowed browser origins on this computer.");
  }
});
