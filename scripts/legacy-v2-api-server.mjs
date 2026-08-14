import { spawn, spawnSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { Client as SshClient } from "ssh2";
import {
  CodexRuntimeManager,
  normalizeCodexRuntimeMode,
} from "./lib/codex-runtime-manager.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

loadLocalEnv(path.join(ROOT, ".env"));

const PORT = Number(process.env.COZYPAD_SSH_API_PORT || 5174);
const CLAUDE_SERVICES_ENABLED = process.env.COZYPAD_ENABLE_CLAUDE_SERVICES === "true";
const ADMIN_USERNAME = process.env.COZYPAD_ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = String(process.env.COZYPAD_ADMIN_PASSWORD || "").trim();
const EFAN_PASSWORD = String(process.env.COZYPAD_EFAN_PASSWORD || "").trim();
const YOUCHENG_PASSWORD = String(process.env.COZYPAD_YOUCHENG_PASSWORD || "").trim();
const REQUIRE_CF_ACCESS = process.env.COZYPAD_REQUIRE_CF_ACCESS === "true";
const CF_ACCESS_ISSUER = process.env.COZYPAD_CF_ACCESS_ISSUER || "";
const CF_ACCESS_AUD = process.env.COZYPAD_CF_ACCESS_AUD || "";
const CF_ACCESS_CERTS_URL =
  process.env.COZYPAD_CF_ACCESS_CERTS_URL ||
  (CF_ACCESS_ISSUER ? `${CF_ACCESS_ISSUER.replace(/\/+$/, "")}/cdn-cgi/access/certs` : "");
const CF_ACCESS_ALLOWED_EMAILS = new Set(
  String(process.env.COZYPAD_CF_ACCESS_ALLOWED_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
);
const GOOGLE_CLIENT_ID = String(process.env.COZYPAD_GOOGLE_CLIENT_ID || "").trim();
const GOOGLE_CERTS_URL =
  process.env.COZYPAD_GOOGLE_CERTS_URL || "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ALLOWED_EMAILS = parseCsvSet(process.env.COZYPAD_GOOGLE_ALLOWED_EMAILS);
const GOOGLE_ALLOWED_DOMAINS = parseCsvSet(process.env.COZYPAD_GOOGLE_ALLOWED_DOMAINS);
const GOOGLE_ADMIN_EMAILS = parseCsvSet(process.env.COZYPAD_GOOGLE_ADMIN_EMAILS);
const GOOGLE_USER_MAP = parseUserMap(process.env.COZYPAD_GOOGLE_USER_MAP);
const TWO_FACTOR_ENABLED = process.env.COZYPAD_ENABLE_2FA !== "false";
const TWO_FACTOR_ISSUER = String(process.env.COZYPAD_2FA_ISSUER || "CozyPad").trim() || "CozyPad";
const TWO_FACTOR_CHALLENGE_TTL_MS = Number(
  process.env.COZYPAD_2FA_CHALLENGE_TTL_MS || 5 * 60 * 1000,
);
const TWO_FACTOR_MAX_ATTEMPTS = Number(process.env.COZYPAD_2FA_MAX_ATTEMPTS || 5);
const AUTH_RATE_LIMIT_WINDOW_MS = Number(
  process.env.COZYPAD_AUTH_RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000,
);
const AUTH_RATE_LIMIT_MAX = Number(process.env.COZYPAD_AUTH_RATE_LIMIT_MAX || 8);
const SSH_CONFIG_REFRESH_COOLDOWN_MS = Number(
  process.env.COZYPAD_SSH_CONFIG_REFRESH_COOLDOWN_MS || 60 * 1000,
);
const FILE_PREVIEW_MAX_BYTES = Math.max(
  1024 * 1024,
  Number(process.env.COZYPAD_FILE_PREVIEW_MAX_BYTES || 64 * 1024 * 1024) || 64 * 1024 * 1024,
);
const FILE_LIST_MAX_ITEMS = Math.max(
  100,
  Number(process.env.COZYPAD_FILE_LIST_MAX_ITEMS || 2000) || 2000,
);
const FILE_LIST_STDOUT_LIMIT = Math.max(
  1024 * 1024,
  Number(process.env.COZYPAD_FILE_LIST_STDOUT_LIMIT || 8 * 1024 * 1024) || 8 * 1024 * 1024,
);
const MARKDOWN_SUMMARY_SERVER_KEYWORD = String(
  process.env.COZYPAD_MARKDOWN_SUMMARY_SERVER_KEYWORD || "91",
).trim();
const MARKDOWN_SUMMARY_SCRIPT = String(
  process.env.COZYPAD_MARKDOWN_SUMMARY_SCRIPT ||
    "/ssd8/chihyu/Foundation_model/markdown_summary_api.py",
).trim();
const MARKDOWN_SUMMARY_MODEL_PATH = String(
  process.env.COZYPAD_MARKDOWN_SUMMARY_MODEL_PATH ||
    "/ssd8/chihyu/Foundation_model/Qwen3-14B",
).trim();
const MARKDOWN_SUMMARY_MAX_FILES = Math.max(
  1,
  Number(process.env.COZYPAD_MARKDOWN_SUMMARY_MAX_FILES || 20) || 20,
);
const MARKDOWN_SUMMARY_MAX_TOTAL_BYTES = Math.max(
  128 * 1024,
  Number(process.env.COZYPAD_MARKDOWN_SUMMARY_MAX_TOTAL_BYTES || 8 * 1024 * 1024) ||
    8 * 1024 * 1024,
);
const MARKDOWN_SUMMARY_TIMEOUT_MS = Math.max(
  15000,
  Number(process.env.COZYPAD_MARKDOWN_SUMMARY_TIMEOUT_MS || 8 * 60 * 1000) || 8 * 60 * 1000,
);
const FLOWCHART_MARKDOWN_SCRIPT = String(
  process.env.COZYPAD_FLOWCHART_MARKDOWN_SCRIPT ||
    "/ssd8/chihyu/Foundation_model/flowchart_markdown_api.py",
).trim();
const FLOWCHART_MARKDOWN_MODEL_PATH = String(
  process.env.COZYPAD_FLOWCHART_MARKDOWN_MODEL_PATH || "",
).trim();
const FLOWCHART_MARKDOWN_TIMEOUT_MS = Math.max(
  15000,
  Number(process.env.COZYPAD_FLOWCHART_MARKDOWN_TIMEOUT_MS || 8 * 60 * 1000) ||
    8 * 60 * 1000,
);
const FLOWCHART_MARKDOWN_BATCH_URL = String(
  process.env.COZYPAD_FLOWCHART_MARKDOWN_BATCH_URL ||
    "http://127.0.0.1:8010/flowchart/markdown/batch",
).trim();
const FLOWCHART_MARKDOWN_BATCH_MIN_FILES = 2;
const FLOWCHART_MARKDOWN_BATCH_MAX_FILES = 3;
const FLOWCHART_MARKDOWN_BATCH_MAX_IMAGE_BASE64_BYTES = Math.max(
  256 * 1024,
  Number(process.env.COZYPAD_FLOWCHART_MARKDOWN_BATCH_MAX_IMAGE_BASE64_BYTES || 4 * 1024 * 1024) ||
    4 * 1024 * 1024,
);
const FLOWCHART_MARKDOWN_BATCH_MAX_BODY_BYTES = Math.max(
  512 * 1024,
  Number(process.env.COZYPAD_FLOWCHART_MARKDOWN_BATCH_MAX_BODY_BYTES || 12 * 1024 * 1024) ||
    12 * 1024 * 1024,
);
const FLOWCHART_MARKDOWN_MAX_NODES = Math.max(
  1,
  Number(process.env.COZYPAD_FLOWCHART_MARKDOWN_MAX_NODES || 120) || 120,
);
const FLOWCHART_MARKDOWN_MAX_EDGES = Math.max(
  1,
  Number(process.env.COZYPAD_FLOWCHART_MARKDOWN_MAX_EDGES || 240) || 240,
);
const CODEX_FEATURE_ENABLED = process.env.COZYPAD_ENABLE_CODEX !== "false";
const CODEX_RUNTIME_MODE = normalizeCodexRuntimeMode(
  process.env.COZYPAD_CODEX_RUNTIME || "legacy",
);
const BAILIAN_BASE_URL = normalizeBailianBaseUrl(
  process.env.COZYPAD_BAILIAN_BASE_URL ||
    process.env.BAILIAN_BASE_URL ||
    process.env.DASHSCOPE_BASE_URL ||
    process.env.ALIBABA_CLOUD_BASE_URL ||
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
);
const BAILIAN_MODEL =
  String(process.env.COZYPAD_BAILIAN_MODEL || process.env.BAILIAN_MODEL || process.env.DASHSCOPE_MODEL || "")
    .trim() || "qwen-plus";
const BAILIAN_MODEL_FALLBACKS = [
  BAILIAN_MODEL,
  "qwen3.8-max",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.6-flash",
  "deepseek-r1",
  "deepseek-v3",
  "deepseek-r1-0528",
  "kimi-k2.7-code",
  "glm-5.2",
  "MiniMax-M2.5",
  "qwen-plus",
  "qwen-max",
  "qwen-turbo",
  "qwen-long",
  "deepseek-v3.2",
  "deepseek-v3.2-exp",
  "deepseek-v3.1",
  "deepseek-r1-distill-qwen-32b",
  "deepseek-r1-distill-qwen-14b",
  "deepseek-r1-distill-qwen-7b",
];
const BAILIAN_INACCESSIBLE_MODEL_FALLBACKS = new Set([
  "deepseek-v4-pro",
  "deepseek-v4-pro-us",
  "deepseek-v4-flash",
  "deepseek-v4-flash-us",
]);
const BAILIAN_REQUEST_TIMEOUT_MS = Math.max(
  10000,
  Number(process.env.COZYPAD_BAILIAN_REQUEST_TIMEOUT_MS || 120000) || 120000,
);
const COOKIE_SECURE = process.env.COZYPAD_COOKIE_SECURE !== "false";
const SESSION_COOKIE = COOKIE_SECURE ? "__Host-cozypad_session" : "cozypad_session";
const LEGACY_SESSION_COOKIE = "cozypad_session";
const ALLOWED_ORIGINS = new Set(
  [
    "https://cozypad.modoubletw.com",
    "https://cozypad-ru035.loca.lt",
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    ...String(process.env.COZYPAD_ALLOWED_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  ]
    .map(normalizeOrigin)
    .filter(Boolean),
);
const DATA_DIR = path.resolve(process.env.COZYPAD_DATA_DIR || path.join(ROOT, "data"));
const SERVERS_FILE = path.join(DATA_DIR, "ssh-servers.json");
const USERS_FILE = path.join(DATA_DIR, "auth-users.json");
const SESSIONS_FILE = path.join(DATA_DIR, "auth-sessions.json");
const LOGIN_RECORDS_FILE = path.join(DATA_DIR, "auth-login-records.json");
const SSH_CONFIG_FILE = process.env.COZYPAD_SSH_CONFIG_FILE || path.join(DATA_DIR, "ssh-config");
const LEGACY_SSH_CONFIG_FILE = path.join(os.homedir(), ".ssh", "config");
const SSH_CONTROL_DIR = path.join(DATA_DIR, "ssh-control");
const SSH_CONTROL_MASTER_ENABLED =
  process.env.COZYPAD_SSH_CONTROL_MASTER === "true" ||
  (process.env.COZYPAD_SSH_CONTROL_MASTER === undefined && process.platform !== "win32");
const SSH_CONTROL_PERSIST_SECONDS = Number(
  process.env.COZYPAD_SSH_CONTROL_PERSIST_SECONDS || 24 * 60 * 60,
);
const SSH2_BROKER_ENABLED = process.env.COZYPAD_SSH2_BROKER !== "false";
const SSH2_BROKER_IDLE_MS = Number(
  process.env.COZYPAD_SSH2_BROKER_IDLE_MS || 24 * 60 * 60 * 1000,
);
const SSH2_BROKER_MAX_CHANNELS = Math.max(
  1,
  Number(process.env.COZYPAD_SSH2_BROKER_MAX_CHANNELS || 6) || 6,
);
const SSH2_TERMINAL_ENABLED = true;
const DOMIN_ROOT = path.resolve(
  process.env.COZYPAD_DOMIN_ROOT || "F:\\work_project\\Agent\\cloudflare_ddns_agent",
);
const DOMIN_CONFIG_FILE = path.join(DOMIN_ROOT, "config.json");
const DOMIN_CREDENTIALS_FILE = path.join(DOMIN_ROOT, "credentials.json");
const DOMIN_LOG_DIR = path.join(DOMIN_ROOT, "logs");
const DOMIN_EXE = path.join(DOMIN_ROOT, "CloudflareDdnsAgent.exe");
const DOMIN_UPDATE_SCRIPT = path.join(DOMIN_ROOT, "update-ddns.ps1");
const DOMIN_TASK_NAME =
  process.env.COZYPAD_DOMIN_TASK_NAME || "Cloudflare DDNS cats.modoubletw.com";
const MONITOR_INTERVAL_MS = Number(process.env.COZYPAD_MONITOR_INTERVAL_MS || 30000);
const MONITOR_OPEN_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.COZYPAD_MONITOR_OPEN_TIMEOUT_MS || 20000) || 20000,
);
const MONITOR_FIRST_METRIC_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.COZYPAD_MONITOR_FIRST_METRIC_TIMEOUT_MS || 20000) || 20000,
);
const MONITOR_SHARED_IDLE_TTL_MS = Math.max(
  0,
  Number(process.env.COZYPAD_MONITOR_SHARED_IDLE_TTL_MS || 0) || 0,
);
const TERMINAL_DETACHED_TTL_MS = Number(
  process.env.COZYPAD_TERMINAL_DETACHED_TTL_MS || 24 * 60 * 60 * 1000,
);
const TERMINAL_BUFFER_LIMIT = Number(process.env.COZYPAD_TERMINAL_BUFFER_LIMIT || 240000);
const TERMINAL_WS_PING_MS = Number(process.env.COZYPAD_TERMINAL_WS_PING_MS || 25000);
const TERMINAL_CHANNEL_OPEN_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.COZYPAD_TERMINAL_CHANNEL_OPEN_TIMEOUT_MS || 15000) || 15000,
);
const TERMINAL_AGENT_RUN_TIMEOUT_MS = Number(
  process.env.COZYPAD_TERMINAL_AGENT_RUN_TIMEOUT_MS || 24 * 60 * 60 * 1000,
);
const AGENT_TERMINAL_BRIDGE_ENABLED = process.env.COZYPAD_AGENT_TERMINAL_BRIDGE !== "false";
const CODEX_SESSION_DETACHED_TTL_MS = Number(
  process.env.COZYPAD_CODEX_SESSION_DETACHED_TTL_MS || 24 * 60 * 60 * 1000,
);
const CODEX_SESSION_BUFFER_LIMIT = Number(process.env.COZYPAD_CODEX_SESSION_BUFFER_LIMIT || 240000);
const CODEX_SESSION_PENDING_LIMIT = Number(process.env.COZYPAD_CODEX_SESSION_PENDING_LIMIT || 8);
const CLAUDE_SESSION_DETACHED_TTL_MS = Number(
  process.env.COZYPAD_CLAUDE_SESSION_DETACHED_TTL_MS || CODEX_SESSION_DETACHED_TTL_MS,
);
const CLAUDE_SESSION_BUFFER_LIMIT = Number(
  process.env.COZYPAD_CLAUDE_SESSION_BUFFER_LIMIT || CODEX_SESSION_BUFFER_LIMIT,
);
const CLAUDE_SESSION_PENDING_LIMIT = Number(
  process.env.COZYPAD_CLAUDE_SESSION_PENDING_LIMIT || CODEX_SESSION_PENDING_LIMIT,
);
const CLAUDE_SESSION_HISTORY_LIMIT = Number(process.env.COZYPAD_CLAUDE_SESSION_HISTORY_LIMIT || 6);
const AGY_SESSION_DETACHED_TTL_MS = Number(
  process.env.COZYPAD_AGY_SESSION_DETACHED_TTL_MS || CODEX_SESSION_DETACHED_TTL_MS,
);
const AGY_SESSION_BUFFER_LIMIT = Number(
  process.env.COZYPAD_AGY_SESSION_BUFFER_LIMIT || CODEX_SESSION_BUFFER_LIMIT,
);
const AGY_SESSION_PENDING_LIMIT = Number(
  process.env.COZYPAD_AGY_SESSION_PENDING_LIMIT || CODEX_SESSION_PENDING_LIMIT,
);
const AGY_SESSION_HISTORY_LIMIT = Number(process.env.COZYPAD_AGY_SESSION_HISTORY_LIMIT || 6);
const BAILIAN_SESSION_DETACHED_TTL_MS = Number(
  process.env.COZYPAD_BAILIAN_SESSION_DETACHED_TTL_MS || CODEX_SESSION_DETACHED_TTL_MS,
);
const BAILIAN_SESSION_BUFFER_LIMIT = Number(
  process.env.COZYPAD_BAILIAN_SESSION_BUFFER_LIMIT || CODEX_SESSION_BUFFER_LIMIT,
);
const BAILIAN_SESSION_PENDING_LIMIT = Number(
  process.env.COZYPAD_BAILIAN_SESSION_PENDING_LIMIT || CODEX_SESSION_PENDING_LIMIT,
);
const CODEX_COMMAND_TOKEN_TTL_MS = Number(
  process.env.COZYPAD_CODEX_COMMAND_TOKEN_TTL_MS || 2 * 60 * 60 * 1000,
);
const CODEX_COMMAND_MAX_LENGTH = Number(process.env.COZYPAD_CODEX_COMMAND_MAX_LENGTH || 24000);
const CODEX_WORKFLOW_LIMIT = Number(process.env.COZYPAD_CODEX_WORKFLOW_LIMIT || 80);
const CODEX_WORKFLOW_OUTPUT_LIMIT = Number(
  process.env.COZYPAD_CODEX_WORKFLOW_OUTPUT_LIMIT || 240000,
);
const REMOTE_CODEX_SSH_FAILURE_COOLDOWN_MS = Number(
  process.env.COZYPAD_REMOTE_CODEX_SSH_FAILURE_COOLDOWN_MS || 60 * 1000,
);
const REMOTE_CODEX_SSH_MAX_RETRIES = Math.max(
  0,
  Number(process.env.COZYPAD_REMOTE_CODEX_SSH_MAX_RETRIES || 2) || 2,
);
const REMOTE_AGENT_SSH_FAILURE_COOLDOWN_MS = Number(
  process.env.COZYPAD_REMOTE_AGENT_SSH_FAILURE_COOLDOWN_MS ||
    REMOTE_CODEX_SSH_FAILURE_COOLDOWN_MS,
);
const SSH_GATE_ENABLED = false;
const SSH_GATE_CONFIRM_AFTER_MS = Math.max(
  1000,
  Number(process.env.COZYPAD_SSH_GATE_CONFIRM_AFTER_MS || 8000) || 8000,
);
const SSH_GATE_CONFIRM_CODE = "SSH_GATE_CONFIRM_REQUIRED";
const CODEX_WS_MAX_PAYLOAD_BYTES = Math.max(
  1024 * 1024,
  Number(process.env.COZYPAD_CODEX_WS_MAX_PAYLOAD_BYTES || 16 * 1024 * 1024) ||
    16 * 1024 * 1024,
);
const CODEX_IMAGE_ATTACHMENT_LIMIT = Math.max(
  1,
  Number(process.env.COZYPAD_CODEX_IMAGE_ATTACHMENT_LIMIT || 6) || 6,
);
const CODEX_IMAGE_ATTACHMENT_MAX_BYTES = Math.max(
  128 * 1024,
  Number(process.env.COZYPAD_CODEX_IMAGE_ATTACHMENT_MAX_BYTES || 4 * 1024 * 1024) ||
    4 * 1024 * 1024,
);
const CODEX_IMAGE_ATTACHMENT_MAX_TOTAL_BYTES = Math.max(
  CODEX_IMAGE_ATTACHMENT_MAX_BYTES,
  Number(process.env.COZYPAD_CODEX_IMAGE_ATTACHMENT_MAX_TOTAL_BYTES || 12 * 1024 * 1024) ||
    12 * 1024 * 1024,
);
const CODEX_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
const CODEX_MODEL_FALLBACKS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "codex-auto-review",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
  "gpt-5",
  "gpt-5-mini",
  "o4-mini",
  "o3",
];
const CODEX_MODEL_MARKER = "__COZYPAD_CODEX_MODEL__:";
const CODEX_DEFAULT_MODEL_MARKER = "__COZYPAD_CODEX_DEFAULT_MODEL__:";
const CLAUDE_MODEL_FALLBACKS = [
  "opus",
  "sonnet",
  "haiku",
  "fable",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5",
  "claude-3-5-haiku",
];
const AGY_MODEL_FALLBACKS = [
  "gemini-3.6-flash-high",
  "gemini-3.6-flash-medium",
  "gemini-3.6-flash-low",
  "gemini-3.5-flash-high",
  "gemini-3.5-flash-medium",
  "gemini-3.5-flash-low",
  "gemini-3.1-pro-high",
  "gemini-3.1-pro-low",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
];
const CLAUDE_DEFAULT_MODEL_MARKER = "__COZYPAD_CLAUDE_DEFAULT_MODEL__:";
const CLAUDE_MODELS_BEGIN_MARKER = "__COZYPAD_CLAUDE_MODELS_BEGIN__";
const CLAUDE_MODELS_END_MARKER = "__COZYPAD_CLAUDE_MODELS_END__";
const AGY_DEFAULT_MODEL_MARKER = "__COZYPAD_AGY_DEFAULT_MODEL__:";
const AGY_MODELS_BEGIN_MARKER = "__COZYPAD_AGY_MODELS_BEGIN__";
const AGY_MODELS_END_MARKER = "__COZYPAD_AGY_MODELS_END__";
const CODEX_REASONING_CONFIG_KEY = /^[A-Za-z0-9_.-]+$/.test(
  String(process.env.COZYPAD_CODEX_REASONING_CONFIG_KEY || "").trim(),
)
  ? String(process.env.COZYPAD_CODEX_REASONING_CONFIG_KEY).trim()
  : "model_reasoning_effort";
const REMOTE_CODEX_WORKFLOW_STDOUT_LIMIT = Number(
  process.env.COZYPAD_REMOTE_CODEX_WORKFLOW_STDOUT_LIMIT || 5 * 1024 * 1024,
);
const REMOTE_AGENT_WORKER_IDLE_MS = Number(
  process.env.COZYPAD_REMOTE_AGENT_WORKER_IDLE_MS || 24 * 60 * 60 * 1000,
);
const SESSION_TTL_MS = Number(process.env.COZYPAD_SESSION_TTL_MS || 24 * 60 * 60 * 1000);
const sessions = new Map();
const twoFactorChallenges = new Map();
const authRateLimits = new Map();
const sshConfigRefreshLimits = new Map();
const monitorAuthBlocks = new Map();
const terminalSessions = new Map();
const codexSessions = new Map();
const remoteCodexWorkers = new Map();
const remoteAgentWorkers = new Map();
const remoteCodexWorkerCreates = new Map();
const remoteAgentWorkerCreates = new Map();
const remoteCodexWorkerBlocks = new Map();
const remoteAgentBlocks = new Map();
const sshGateLeases = new Map();
const sharedMonitorStreams = new Map();
const ssh2Brokers = new Map();
const sshGateRequestContext = new AsyncLocalStorage();
const codexCommandTokens = new Map();
const researchFlowchartJobs = new Map();
const remoteAgentRunJobs = new Map();
const claudeSessions = new Map();
const agySessions = new Map();
const bailianSessions = new Map();
const bailianSessionApiKeys = new Map();

const appRoot = ROOT;
const PUBLIC_TUNNEL_ID =
  process.env.COZYPAD_PUBLIC_TUNNEL_ID || "60f47fa8-e390-4c4f-a416-777b2b825e2d";
const PUBLIC_URL = process.env.COZYPAD_PUBLIC_URL || "https://cozypad.modoubletw.com/";
const PUBLIC_ORIGIN_URL = process.env.COZYPAD_PUBLIC_ORIGIN_URL || "http://localhost:5173";
const PUBLIC_WORKFLOW_SCRIPT = path.join(ROOT, "scripts", "start-cozypad4-public.ps1");
const LOCAL_CODEX_ENTRY = path.join(appRoot, "node_modules", "@openai", "codex", "bin", "codex.js");
const LOCAL_CMD_BRIDGE_ENTRY = path.join(appRoot, "scripts", "local-cmd-bridge.mjs");
const RTK_EXE = process.env.COZYPAD_RTK_PATH || path.join(os.homedir(), ".local", "bin", "rtk.exe");
const DEFAULT_CODEX_ARGS = [
  "exec",
  "--json",
  "--skip-git-repo-check",
  "--color",
  "never",
  "--dangerously-bypass-approvals-and-sandbox",
  "{prompt}",
];
const codexAppServerRuntimeManager = new CodexRuntimeManager({
  mode: CODEX_RUNTIME_MODE,
  startTransport: startCodexAppServerTransport,
  maxReplayEvents: Number(process.env.COZYPAD_CODEX_APP_SERVER_REPLAY_EVENTS || 2_000),
  maxRestartAttempts: Number(process.env.COZYPAD_CODEX_APP_SERVER_RESTART_ATTEMPTS || 2),
  restartBaseDelayMs: Number(process.env.COZYPAD_CODEX_APP_SERVER_RESTART_DELAY_MS || 1_000),
  serverRequestTimeoutMs: Number(
    process.env.COZYPAD_CODEX_APP_SERVER_REQUEST_TIMEOUT_MS || 5 * 60_000,
  ),
});
let cfAccessJwks = null;
let googleJwks = null;
let dominUpdateProcess = null;
let sessionPersistTimer = null;

function loadLocalEnv(filePath) {
  if (!existsSync(filePath)) {
    return;
  }

  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) {
      continue;
    }

    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function sendJson(response, statusCode, payload, headers = {}) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "x-frame-options": "DENY",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

function sendErrorJson(response, fallbackStatus, error, fallbackMessage = "Request failed") {
  if (isSshGateConfirmationError(error)) {
    sendJson(response, 409, sshGateErrorPayload(error));
    return;
  }

  sendJson(response, fallbackStatus, {
    ok: false,
    error: error instanceof Error ? error.message : fallbackMessage,
  });
}

function sendText(response, statusCode, text, headers = {}) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(text);
}

function sendEmpty(response, statusCode, headers = {}) {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "x-frame-options": "DENY",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    ...headers,
  });
  response.end();
}

function corsHeadersForRequest(request) {
  const origin = normalizeOrigin(request.headers.origin);
  if (!origin) {
    return {};
  }
  if (!ALLOWED_ORIGINS.has(origin) && origin !== requestOriginFromHost(request)) {
    return {};
  }
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET,HEAD,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers":
      "content-type,x-cozypad-request,x-cozypad-rpc,x-requested-with",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

function applyCorsHeaders(request, response) {
  const headers = corsHeadersForRequest(request);
  for (const [key, value] of Object.entries(headers)) {
    response.setHeader(key, value);
  }
  return headers;
}

function truncateForApi(value, limit = 12000) {
  const text = String(value || "");
  if (text.length <= limit) {
    return text;
  }

  return `[truncated ${text.length - limit} chars]\n${text.slice(-limit)}`;
}

function parseSshJsonOutput(stdout) {
  const text = String(stdout || "").trim();
  if (!text) {
    throw new Error("SSH command did not return JSON");
  }

  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line.startsWith("{") || !line.endsWith("}")) {
        continue;
      }

      try {
        return JSON.parse(line);
      } catch {
        // Keep scanning; SSH login banners or shell hooks may add non-JSON lines.
      }
    }
  }

  throw new Error("SSH command output did not contain a valid JSON object");
}

function firstNonEmptyText(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function publicDiagnosticText(value, limit = 4000) {
  return truncateForApi(redactLocalPaths(value), limit).trim();
}

function pruneResearchFlowchartJobs(now = Date.now()) {
  for (const [jobId, job] of researchFlowchartJobs.entries()) {
    if (!job || Number(job.expiresAt || 0) <= now) {
      researchFlowchartJobs.delete(jobId);
    }
  }
}

function publicResearchFlowchartJob(job) {
  return {
    ok: job.status !== "failed",
    jobId: job.id,
    status: job.status,
    queued: job.status === "queued" || job.status === "running",
    markdown: job.markdown,
    summary: job.summary,
    content: job.content,
    result: job.result,
    items: job.items,
    results: job.results,
    fileCount: job.fileCount,
    model: job.model,
    modelPath: job.modelPath,
    nodeCount: job.nodeCount,
    edgeCount: job.edgeCount,
    idleGpuCount: job.idleGpuCount,
    availableGpuCount: job.availableGpuCount,
    freeGpuCount: job.freeGpuCount,
    concurrency: job.concurrency,
    server: job.server ? publicSshServer(job.server) : undefined,
    error: job.error,
    stderr: job.stderr,
    traceback: job.traceback,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

async function runResearchFlowchartJob(job) {
  job.status = "running";
  job.startedAt = new Date().toISOString();
  try {
    if (job.provider === "bailian") {
      await runResearchFlowchartBailianJob(job);
      return;
    }

    const result = await runRemoteCommandWithInput(
      job.session,
      job.server,
      job.batch ? createFlowchartMarkdownBatchCommand() : createFlowchartMarkdownCommand(),
      JSON.stringify(job.payload),
      FLOWCHART_MARKDOWN_TIMEOUT_MS,
      {
        stdoutLimit: 2 * 1024 * 1024,
        stderrLimit: 512 * 1024,
      },
    );

    if (!result.ok && !result.stdout.trim()) {
      const errorMessage = publicDiagnosticText(
        firstNonEmptyText(
          result.stderr,
          result.stdout,
          `SSH command failed with exit code ${result.code ?? "unknown"}`,
        ),
      );
      console.warn("[research-flowchart] remote command failed", {
        code: result.code,
        stderr: publicDiagnosticText(result.stderr, 1600),
        stdout: publicDiagnosticText(result.stdout, 800),
      });
      Object.assign(job, {
        status: "failed",
        error: errorMessage || "flowchart markdown analysis failed",
        code: result.code,
        stderr: publicDiagnosticText(result.stderr),
        stdout: publicDiagnosticText(result.stdout, 1200),
      });
      return;
    }

    const parsed = parseSshJsonOutput(result.stdout);
    if (!parsed.ok) {
      console.warn("[research-flowchart] remote API returned failure", {
        error: publicDiagnosticText(parsed.error, 1600),
        traceback: publicDiagnosticText(parsed.traceback, 2000),
        stderr: publicDiagnosticText(result.stderr, 1000),
      });
    }

    const errorMessage = publicDiagnosticText(
      firstNonEmptyText(parsed.error, parsed.stderr, result.stderr, parsed.traceback),
    );
    Object.assign(job, {
      ...parsed,
      status: parsed.ok ? "completed" : "failed",
      error: parsed.ok ? parsed.error : errorMessage || "flowchart markdown analysis failed",
      stderr: publicDiagnosticText(result.stderr),
      traceback: parsed.traceback ? publicDiagnosticText(parsed.traceback) : undefined,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? publicDiagnosticText(error.message) : "Flowchart markdown analysis failed";
    console.warn("[research-flowchart] job failed", errorMessage);
    Object.assign(job, {
      status: "failed",
      error: errorMessage,
    });
  } finally {
    job.finishedAt = new Date().toISOString();
    job.expiresAt = Date.now() + 30 * 60 * 1000;
  }
}

function createResearchFlowchartJob(session, server, payload, options = {}) {
  pruneResearchFlowchartJobs();
  const job = {
    id: `flow_${Date.now().toString(36)}_${crypto.randomBytes(5).toString("hex")}`,
    owner: getTerminalOwner(session),
    session: {
      username: session.username,
      role: session.role || "user",
    },
    status: "queued",
    server,
    payload,
    batch: Boolean(options.batch),
    provider: options.provider || "ssh",
    apiKey: String(options.apiKey || "").trim().slice(0, 24000),
    model: normalizeCodexModelOption(options.model || payload.model || ""),
    fileCount: payload.fileCount,
    nodeCount: payload.nodeCount,
    edgeCount: payload.edgeCount,
    createdAt: new Date().toISOString(),
    startedAt: "",
    finishedAt: "",
    expiresAt: Date.now() + 30 * 60 * 1000,
  };
  researchFlowchartJobs.set(job.id, job);
  setTimeout(() => {
    void runResearchFlowchartJob(job);
  }, 0);
  return job;
}

function normalizeRemoteAgentRunAgent(value) {
  const agent = String(value || "").trim().toLowerCase();
  return agent === "agy" || agent === "bailian" || agent === "codex"
    ? agent
    : "";
}

function remoteAgentRunLabel(agent) {
  if (agent === "claude") return "Claude";
  if (agent === "codex") return "Codex";
  if (agent === "bailian") return "bailian";
  return "agy";
}

function pruneRemoteAgentRunJobs(now = Date.now()) {
  for (const [jobId, job] of remoteAgentRunJobs.entries()) {
    if (!job || Number(job.expiresAt || 0) <= now) {
      remoteAgentRunJobs.delete(jobId);
    }
  }
}

function publicRemoteAgentRunJob(job) {
  const result = job.result || {};
  const server = result.server || job.server;
  return {
    ok: job.status !== "failed",
    jobId: job.id,
    agent: job.agent,
    status: job.status,
    queued: job.status === "queued" || job.status === "running",
    server: server ? publicSshServer(server) : undefined,
    output: result.output || "",
    stderr: result.stderr || job.stderr || "",
    code: result.code ?? job.code ?? 0,
    durationMs: result.durationMs ?? job.durationMs ?? 0,
    transport: result.transport,
    terminalId: result.terminalId,
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

async function runRemoteAgentRunPromptForJob(session, agent, body) {
  if (agent === "claude") throw new Error("Claude service is disabled");
  if (agent === "agy") return runRemoteAgyPrompt(session, body);
  if (agent === "bailian") return runRemoteBailianPrompt(session, body);
  if (agent === "codex") return runRemoteCodexPrompt(session, body);
  throw new Error("Unsupported remote agent");
}

async function runRemoteAgentRunJob(job) {
  job.status = "running";
  job.startedAt = new Date().toISOString();
  try {
    const result = await runRemoteAgentRunPromptForJob(job.session, job.agent, job.body);
    const status = result?.status === "completed" ? "completed" : "failed";
    Object.assign(job, {
      status,
      result,
      server: result?.server || job.server,
      error:
        status === "failed"
          ? publicDiagnosticText(
              firstNonEmptyText(result?.output, result?.stderr, `${remoteAgentRunLabel(job.agent)} run failed`),
            )
          : "",
      stderr: publicDiagnosticText(result?.stderr || ""),
      code: result?.code ?? 0,
      durationMs: result?.durationMs ?? 0,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? publicDiagnosticText(error.message)
        : `${remoteAgentRunLabel(job.agent)} run failed`;
    console.warn(`[remote-agent-run] ${job.agent} job failed`, message);
    Object.assign(job, {
      status: "failed",
      error: message,
    });
  } finally {
    job.finishedAt = new Date().toISOString();
    job.expiresAt = Date.now() + 30 * 60 * 1000;
  }
}

async function createRemoteAgentRunJob(session, agentValue, body) {
  const agent = normalizeRemoteAgentRunAgent(agentValue);
  if (!agent) {
    throw new Error("Unsupported remote agent");
  }
  pruneRemoteAgentRunJobs();

  const server = body?.serverId ? await findServer(body.serverId, session) : null;
  if (!server) {
    throw new Error("Server is required");
  }

  const prompt = String(body?.prompt || "").trim();
  if (!prompt) {
    throw new Error("Prompt is required");
  }

  const job = {
    id: `agent_${agent}_${Date.now().toString(36)}_${crypto.randomBytes(5).toString("hex")}`,
    owner: getTerminalOwner(session),
    session: {
      username: session.username,
      role: session.role || "user",
    },
    agent,
    status: "queued",
    server,
    body: { ...body, prompt, serverId: server.id },
    result: null,
    error: "",
    stderr: "",
    code: 0,
    durationMs: 0,
    createdAt: new Date().toISOString(),
    startedAt: "",
    finishedAt: "",
    expiresAt: Date.now() + 30 * 60 * 1000,
  };
  remoteAgentRunJobs.set(job.id, job);
  setTimeout(() => {
    void runRemoteAgentRunJob(job);
  }, 0);
  return job;
}

function getRemoteAgentRunJobForSession(session, agentValue, jobId) {
  pruneRemoteAgentRunJobs();
  const agent = normalizeRemoteAgentRunAgent(agentValue);
  const cleanJobId = String(jobId || "").trim();
  const job = cleanJobId ? remoteAgentRunJobs.get(cleanJobId) : null;
  if (!agent || !job || job.agent !== agent || job.owner !== getTerminalOwner(session)) {
    return null;
  }
  return job;
}

function normalizeOrigin(value) {
  try {
    return new URL(String(value || "")).origin.toLowerCase();
  } catch {
    return "";
  }
}

function firstHeaderValue(value) {
  return Array.isArray(value) ? value[0] || "" : String(value || "");
}

function requestOriginFromHost(request) {
  const forwardedHost = firstHeaderValue(request.headers["x-forwarded-host"]).split(",")[0].trim();
  const host = forwardedHost || firstHeaderValue(request.headers.host).trim();
  if (!host) return "";
  const forwardedProto = firstHeaderValue(request.headers["x-forwarded-proto"])
    .split(",")[0]
    .trim()
    .toLowerCase();
  const lowerHost = host.toLowerCase();
  const proto =
    forwardedProto ||
    (lowerHost.startsWith("localhost") ||
    lowerHost.startsWith("127.") ||
    lowerHost.startsWith("[::1]")
      ? "http"
      : "https");
  return normalizeOrigin(`${proto}://${host}`);
}

function isAllowedOrigin(request) {
  const origin = normalizeOrigin(request.headers.origin);
  if (origin) {
    return ALLOWED_ORIGINS.has(origin) || origin === requestOriginFromHost(request);
  }

  return request.headers["x-cozypad-request"] === "app";
}

function isAllowedWebSocketOrigin(request) {
  const origin = normalizeOrigin(request.headers.origin);
  return Boolean(origin && (ALLOWED_ORIGINS.has(origin) || origin === requestOriginFromHost(request)));
}

function isLoopbackHostname(hostname) {
  const value = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  return value === "localhost" || value === "::1" || value.startsWith("127.");
}

function isLocalCodexRequest(request) {
  const origin = normalizeOrigin(request.headers.origin);
  if (origin) {
    try {
      return isLoopbackHostname(new URL(origin).hostname);
    } catch {
      return false;
    }
  }

  const host = String(request.headers.host || "").trim();
  if (!host) {
    return false;
  }

  try {
    return isLoopbackHostname(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

function isStateChangingMethod(method) {
  return !["GET", "HEAD", "OPTIONS"].includes(String(method || "").toUpperCase());
}

function rejectSocket(socket, statusCode, message) {
  socket.write(`HTTP/1.1 ${statusCode} ${message}\r\n\r\n`);
  socket.destroy();
}

function parseCsvSet(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

function parseUserMap(value) {
  const map = new Map();

  for (const item of String(value || "").split(",")) {
    const trimmed = item.trim();
    if (!trimmed) {
      continue;
    }

    const separator = trimmed.includes("=") ? "=" : ":";
    const index = trimmed.indexOf(separator);
    if (index === -1) {
      continue;
    }

    const email = trimmed.slice(0, index).trim().toLowerCase();
    const username = trimmed.slice(index + 1).trim();
    if (email && username) {
      map.set(email, username);
    }
  }

  return map;
}

function parseCookies(request) {
  const header = request.headers.cookie || "";
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        if (separator === -1) {
          return [part, ""];
        }

        return [
          decodeURIComponent(part.slice(0, separator)),
          decodeURIComponent(part.slice(separator + 1)),
        ];
      }),
  );
}

function hashSessionToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("base64url");
}

function normalizeSessionRecord(record) {
  if (!record || typeof record !== "object") {
    return null;
  }

  const tokenHash = String(record.tokenHash || "");
  const username = String(record.username || "");
  const role = String(record.role || "user");
  const createdAt = Number(record.createdAt || Date.now());
  const expiresAt = Number(record.expiresAt || 0);
  const loginRecordId = String(record.loginRecordId || "");

  if (!tokenHash || !username || !Number.isFinite(expiresAt)) {
    return null;
  }

  if (expiresAt <= Date.now() || !isAllowedLoginUser(username)) {
    return null;
  }

  return {
    tokenHash,
    username,
    role,
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    expiresAt,
    ...(loginRecordId ? { loginRecordId } : {}),
  };
}

async function loadSessions() {
  try {
    const raw = await readFile(SESSIONS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const records = Array.isArray(parsed?.sessions) ? parsed.sessions : Array.isArray(parsed) ? parsed : [];

    for (const record of records) {
      const normalized = normalizeSessionRecord(record);
      if (normalized) {
        sessions.set(normalized.tokenHash, normalized);
      }
    }

    if (sessions.size !== records.length) {
      schedulePersistSessions();
    }
  } catch {
    // Missing or invalid session cache is safe; users can log in again.
  }
}

async function persistSessionsNow() {
  const now = Date.now();
  const records = [];
  const expiredLoginRecordIds = [];

  for (const [tokenHash, session] of sessions.entries()) {
    const normalized = normalizeSessionRecord({ ...session, tokenHash });
    if (!normalized || normalized.expiresAt <= now) {
      if (session.loginRecordId) {
        expiredLoginRecordIds.push(session.loginRecordId);
      }
      sessions.delete(tokenHash);
      continue;
    }
    records.push(normalized);
  }

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(
    SESSIONS_FILE,
    `${JSON.stringify({ sessions: records }, null, 2)}\n`,
    "utf8",
  );

  await Promise.all(expiredLoginRecordIds.map((id) => closeLoginRecord(id, "expired")));
}

function schedulePersistSessions() {
  if (sessionPersistTimer) {
    return;
  }

  sessionPersistTimer = setTimeout(() => {
    sessionPersistTimer = null;
    persistSessionsNow().catch((error) => {
      console.warn(`[auth] failed to persist sessions: ${error.message}`);
    });
  }, 250);
  sessionPersistTimer.unref?.();
}

function normalizeLoginRecord(record) {
  if (!record || typeof record !== "object") {
    return null;
  }

  const id = String(record.id || "").trim();
  const username = String(record.username || "").trim();
  const role = String(record.role || "user").trim() || "user";
  const connectedAt = String(record.connectedAt || "").trim();

  if (!id || !username || !connectedAt) {
    return null;
  }

  return {
    id,
    username,
    role,
    connectedAt,
    closedAt: String(record.closedAt || "").trim(),
    closeReason: String(record.closeReason || "").trim(),
  };
}

async function readLoginRecords() {
  try {
    const raw = await readFile(LOGIN_RECORDS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const records = Array.isArray(parsed?.records) ? parsed.records : Array.isArray(parsed) ? parsed : [];
    return records.map(normalizeLoginRecord).filter(Boolean);
  } catch {
    return [];
  }
}

async function writeLoginRecords(records) {
  const normalized = Array.isArray(records) ? records.map(normalizeLoginRecord).filter(Boolean) : [];
  const sorted = normalized
    .sort((left, right) => Date.parse(right.connectedAt) - Date.parse(left.connectedAt))
    .slice(0, 200);

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(
    LOGIN_RECORDS_FILE,
    `${JSON.stringify({ records: sorted }, null, 2)}\n`,
    "utf8",
  );
}

async function createLoginRecord(user) {
  const now = new Date().toISOString();
  const record = {
    id: `login:${Date.now().toString(36)}-${crypto.randomBytes(5).toString("hex")}`,
    username: user.username,
    role: user.role || "user",
    connectedAt: now,
    closedAt: "",
    closeReason: "",
  };
  const records = await readLoginRecords();
  await writeLoginRecords([record, ...records]);
  return record;
}

async function closeLoginRecord(recordId, reason = "logout") {
  const id = String(recordId || "").trim();
  if (!id) {
    return null;
  }

  const records = await readLoginRecords();
  let closed = null;
  const nextRecords = records.map((record) => {
    if (record.id !== id || record.closedAt) {
      return record;
    }

    closed = {
      ...record,
      closedAt: new Date().toISOString(),
      closeReason: reason,
    };
    return closed;
  });

  if (closed) {
    await writeLoginRecords(nextRecords);
  }

  return closed;
}

function publicLoginRecord(record) {
  return {
    id: record.id,
    username: record.username,
    role: record.role,
    connectedAt: record.connectedAt,
    closedAt: record.closedAt || "",
    closeReason: record.closeReason || "",
  };
}

function normalizePageNumber(value, fallback = 1) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function listPublicLoginRecords(session, options = {}) {
  const limit = Math.min(20, Math.max(1, normalizePageNumber(options.limit, 20)));
  const requestedPage = normalizePageNumber(options.page, 1);
  const records = await readLoginRecords();
  const username = normalizeUsername(session?.username);
  const filtered = isAdminSession(session)
    ? records
    : records.filter((record) => normalizeUsername(record.username) === username);
  const sorted = filtered.sort(
    (left, right) => Date.parse(right.connectedAt) - Date.parse(left.connectedAt),
  );
  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(requestedPage, totalPages);
  const start = (page - 1) * limit;

  return {
    records: sorted.slice(start, start + limit).map(publicLoginRecord),
    page,
    limit,
    total,
    totalPages,
  };
}

function getCloudflareAccessToken(request) {
  return (
    request.headers["cf-access-jwt-assertion"] ||
    parseCookies(request).CF_Authorization ||
    ""
  );
}

function getCloudflareAccessJwks() {
  if (!cfAccessJwks) {
    cfAccessJwks = createRemoteJWKSet(new URL(CF_ACCESS_CERTS_URL));
  }

  return cfAccessJwks;
}

function getGoogleJwks() {
  if (!googleJwks) {
    googleJwks = createRemoteJWKSet(new URL(GOOGLE_CERTS_URL));
  }

  return googleJwks;
}

async function verifyCloudflareAccess(request) {
  if (!REQUIRE_CF_ACCESS) {
    return { ok: true, payload: null };
  }

  if (!CF_ACCESS_ISSUER || !CF_ACCESS_AUD || !CF_ACCESS_CERTS_URL) {
    return {
      ok: false,
      status: 500,
      error:
        "Cloudflare Access is required but COZYPAD_CF_ACCESS_ISSUER / COZYPAD_CF_ACCESS_AUD are not configured",
    };
  }

  const token = getCloudflareAccessToken(request);
  if (!token) {
    return { ok: false, status: 403, error: "Cloudflare Access token required" };
  }

  try {
    const { payload } = await jwtVerify(token, getCloudflareAccessJwks(), {
      issuer: CF_ACCESS_ISSUER,
      audience: CF_ACCESS_AUD,
    });
    const email = String(payload.email || "").toLowerCase();

    if (CF_ACCESS_ALLOWED_EMAILS.size > 0 && !CF_ACCESS_ALLOWED_EMAILS.has(email)) {
      return { ok: false, status: 403, error: "Cloudflare Access email is not allowed" };
    }

    return { ok: true, payload };
  } catch (error) {
    return {
      ok: false,
      status: 403,
      error: error instanceof Error ? error.message : "Invalid Cloudflare Access token",
    };
  }
}

const DEFAULT_USERS = [
  { username: ADMIN_USERNAME, password: ADMIN_PASSWORD, role: "admin" },
  { username: "EFan", password: EFAN_PASSWORD, role: "user" },
  { username: "Youcheng", password: YOUCHENG_PASSWORD, role: "user" },
];

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function isAllowedLoginUser(username) {
  const normalized = normalizeUsername(username);
  return DEFAULT_USERS.some((user) => normalizeUsername(user.username) === normalized);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("base64url")) {
  return {
    salt,
    passwordHash: crypto.scryptSync(String(password), salt, 64).toString("base64url"),
  };
}

function verifyPassword(password, user) {
  if (!user?.salt || !user?.passwordHash) {
    return false;
  }

  const candidate = crypto.scryptSync(String(password), user.salt, 64);
  const expected = Buffer.from(user.passwordHash, "base64url");

  if (candidate.length !== expected.length) {
    return false;
  }

  return crypto.timingSafeEqual(candidate, expected);
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function toBase32(buffer) {
  let bits = "";
  let output = "";

  for (const byte of buffer) {
    bits += byte.toString(2).padStart(8, "0");
  }

  for (let index = 0; index < bits.length; index += 5) {
    const chunk = bits.slice(index, index + 5).padEnd(5, "0");
    output += BASE32_ALPHABET[Number.parseInt(chunk, 2)];
  }

  return output;
}

function base32Decode(value) {
  const clean = String(value || "")
    .replace(/[\s=-]/g, "")
    .toUpperCase();
  let bits = "";

  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error("Invalid TOTP secret");
    }
    bits += index.toString(2).padStart(5, "0");
  }

  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }

  return Buffer.from(bytes);
}

function generateTotpSecret() {
  return toBase32(crypto.randomBytes(20));
}

function generateTotp(secretBase32, now = Date.now()) {
  const key = base32Decode(secretBase32);
  const counter = Math.floor(now / 1000 / 30);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuffer.writeUInt32BE(counter >>> 0, 4);

  const digest = crypto.createHmac("sha1", key).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 1000000).padStart(6, "0");
}

function timingSafeCodeEqual(first, second) {
  const left = Buffer.from(String(first));
  const right = Buffer.from(String(second));

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

function verifyTotp(secretBase32, code) {
  const normalizedCode = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(normalizedCode)) {
    return false;
  }

  for (const offset of [-1, 0, 1]) {
    const expected = generateTotp(secretBase32, Date.now() + offset * 30 * 1000);
    if (timingSafeCodeEqual(normalizedCode, expected)) {
      return true;
    }
  }

  return false;
}

function hasTwoFactor(user) {
  return Boolean(user?.twoFactor?.enabled && user?.twoFactor?.secretBase32);
}

function cleanupTwoFactorChallenges() {
  const now = Date.now();

  for (const [challengeId, challenge] of twoFactorChallenges.entries()) {
    if (challenge.expiresAt <= now) {
      twoFactorChallenges.delete(challengeId);
    }
  }
}

function createOtpAuthUrl(user, secretBase32) {
  const label = `${TWO_FACTOR_ISSUER}:${user.username}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer: TWO_FACTOR_ISSUER,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });

  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

function createTwoFactorChallenge(user, options = {}) {
  cleanupTwoFactorChallenges();

  const challengeId = crypto.randomBytes(24).toString("base64url");
  const secretBase32 = options.secretBase32 || user?.twoFactor?.secretBase32 || "";

  twoFactorChallenges.set(challengeId, {
    username: user.username,
    secretBase32,
    setup: Boolean(options.setup),
    attempts: 0,
    createdAt: Date.now(),
    expiresAt: Date.now() + TWO_FACTOR_CHALLENGE_TTL_MS,
  });

  return challengeId;
}

function createLoginChallengePayload(user) {
  if (hasTwoFactor(user)) {
    return {
      ok: true,
      requiresTwoFactor: true,
      challengeId: createTwoFactorChallenge(user),
      user: publicUser(user),
    };
  }

  const secretBase32 = generateTotpSecret();
  return {
    ok: true,
    requiresTwoFactorSetup: true,
    challengeId: createTwoFactorChallenge(user, { setup: true, secretBase32 }),
    user: publicUser(user),
    setup: {
      issuer: TWO_FACTOR_ISSUER,
      account: user.username,
      secret: secretBase32,
      otpauthUrl: createOtpAuthUrl(user, secretBase32),
    },
  };
}

async function sendLoginResponse(response, user, extra = {}) {
  if (TWO_FACTOR_ENABLED) {
    sendJson(response, 200, { ...createLoginChallengePayload(user), ...extra });
    return;
  }

  sendJson(
    response,
    200,
    { ok: true, user: publicUser(user), ...extra },
    { "set-cookie": await createSessionCookie(user) },
  );
}

async function verifyTwoFactorChallenge(challengeId, code) {
  cleanupTwoFactorChallenges();

  const id = String(challengeId || "").trim();
  const challenge = twoFactorChallenges.get(id);

  if (!challenge) {
    return { ok: false, status: 400, error: "驗證已過期，請重新登入" };
  }

  if (challenge.attempts >= TWO_FACTOR_MAX_ATTEMPTS) {
    twoFactorChallenges.delete(id);
    return { ok: false, status: 429, error: "驗證碼錯誤次數過多，請重新登入" };
  }

  if (!verifyTotp(challenge.secretBase32, code)) {
    challenge.attempts += 1;
    if (challenge.attempts >= TWO_FACTOR_MAX_ATTEMPTS) {
      twoFactorChallenges.delete(id);
      return { ok: false, status: 429, error: "驗證碼錯誤次數過多，請重新登入" };
    }

    return { ok: false, status: 401, error: "驗證碼不正確" };
  }

  const users = await readUsers();
  const userId = normalizeUsername(challenge.username);
  const user = users[userId];

  if (!user) {
    twoFactorChallenges.delete(id);
    return { ok: false, status: 400, error: "使用者不存在，請重新登入" };
  }

  if (challenge.setup) {
    const now = new Date().toISOString();
    users[userId] = {
      ...user,
      twoFactor: {
        enabled: true,
        secretBase32: challenge.secretBase32,
        createdAt: user.twoFactor?.createdAt || now,
        updatedAt: now,
      },
      updatedAt: now,
    };
    await writeUsers(users);
  }

  twoFactorChallenges.delete(id);
  return { ok: true, user: users[userId] };
}

function getClientIp(request) {
  const cfIp = request.headers["cf-connecting-ip"];
  const forwardedFor = request.headers["x-forwarded-for"];
  const forwarded = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  const remote = request.socket?.remoteAddress || "unknown";

  return String(cfIp || forwarded || remote).split(",")[0].trim() || "unknown";
}

function consumeAuthRateLimit(request, identity) {
  const now = Date.now();
  const key = `${getClientIp(request)}:${normalizeUsername(identity) || "unknown"}`;
  const current = authRateLimits.get(key) || { attempts: 0, resetAt: now + AUTH_RATE_LIMIT_WINDOW_MS };

  if (current.resetAt <= now) {
    current.attempts = 0;
    current.resetAt = now + AUTH_RATE_LIMIT_WINDOW_MS;
  }

  if (current.attempts >= AUTH_RATE_LIMIT_MAX) {
    authRateLimits.set(key, current);
    return { ok: false, retryAfterMs: current.resetAt - now, key };
  }

  current.attempts += 1;
  authRateLimits.set(key, current);
  return { ok: true, key };
}

function clearAuthRateLimit(key) {
  if (key) {
    authRateLimits.delete(key);
  }
}

function publicUser(user) {
  return {
    username: user.username,
    role: user.role || "user",
  };
}

function getGoogleEmailsForUser(user) {
  const values = [
    user?.googleEmail,
    ...(Array.isArray(user?.googleEmails) ? user.googleEmails : []),
  ];

  return values
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
}

async function readUsers() {
  let users = {};

  try {
    const raw = await readFile(USERS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    users = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    users = {};
  }

  let changed = false;
  const now = new Date().toISOString();

  for (const defaultUser of DEFAULT_USERS) {
    const id = normalizeUsername(defaultUser.username);

    if (!users[id]) {
      if (!defaultUser.password) {
        continue;
      }

      users[id] = {
        username: defaultUser.username,
        role: defaultUser.role,
        ...hashPassword(defaultUser.password),
        createdAt: now,
        updatedAt: now,
      };
      changed = true;
    }
  }

  if (changed) {
    await writeUsers(users);
  }

  return users;
}

async function writeUsers(users) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(USERS_FILE, `${JSON.stringify(users, null, 2)}\n`, "utf8");
}

async function findUser(username) {
  if (!isAllowedLoginUser(username)) {
    return null;
  }

  const users = await readUsers();
  return users[normalizeUsername(username)] || null;
}

async function findGoogleLoginUser(email) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const users = await readUsers();

  for (const user of Object.values(users)) {
    if (!isAllowedLoginUser(user.username)) {
      continue;
    }

    if (getGoogleEmailsForUser(user).includes(normalizedEmail)) {
      return user;
    }
  }

  const mappedUsername =
    GOOGLE_USER_MAP.get(normalizedEmail) ||
    (GOOGLE_ADMIN_EMAILS.has(normalizedEmail) ? ADMIN_USERNAME : "");
  if (mappedUsername) {
    return isAllowedLoginUser(mappedUsername) ? users[normalizeUsername(mappedUsername)] || null : null;
  }

  const domain = normalizedEmail.split("@")[1] || "";
  const allowed =
    GOOGLE_ALLOWED_EMAILS.has(normalizedEmail) || (domain && GOOGLE_ALLOWED_DOMAINS.has(domain));
  if (!allowed) {
    return null;
  }

  const localPart = normalizeUsername(normalizedEmail.split("@")[0] || "");
  return isAllowedLoginUser(localPart) ? users[localPart] || null : null;
}

async function verifyGoogleCredential(credential) {
  if (!GOOGLE_CLIENT_ID) {
    throw new Error("Google login is not configured");
  }

  const token = String(credential || "").trim();
  if (!token) {
    throw new Error("Google credential is missing");
  }

  const { payload } = await jwtVerify(token, getGoogleJwks(), {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: GOOGLE_CLIENT_ID,
  });
  const email = String(payload.email || "").trim().toLowerCase();
  const verified = payload.email_verified === true || payload.email_verified === "true";

  if (!email || !verified) {
    throw new Error("Google email is not verified");
  }

  return { email, payload };
}

async function changeUserPassword(username, nextPassword) {
  const users = await readUsers();
  const id = normalizeUsername(username);
  const user = users[id];

  if (!user) {
    throw new Error("User not found");
  }

  users[id] = {
    ...user,
    ...hashPassword(nextPassword),
    updatedAt: new Date().toISOString(),
  };
  await writeUsers(users);
  return users[id];
}

function getSession(request) {
  const cookies = parseCookies(request);
  const token = cookies[SESSION_COOKIE] || cookies[LEGACY_SESSION_COOKIE];
  if (!token) {
    return null;
  }

  const tokenHash = hashSessionToken(token);
  const session = sessions.get(tokenHash);
  if (!session || session.expiresAt < Date.now() || !isAllowedLoginUser(session.username)) {
    if (session?.loginRecordId) {
      closeLoginRecord(session.loginRecordId, "expired").catch((error) => {
        console.warn(`[auth] failed to close expired login record: ${error.message}`);
      });
    }
    sessions.delete(tokenHash);
    schedulePersistSessions();
    return null;
  }

  const nextExpiresAt = Date.now() + SESSION_TTL_MS;
  if (nextExpiresAt - session.expiresAt > 1000 * 60 * 5) {
    session.expiresAt = nextExpiresAt;
    schedulePersistSessions();
  } else {
    session.expiresAt = nextExpiresAt;
  }
  return session;
}

function isAuthenticated(request) {
  return Boolean(getSession(request));
}

async function createSessionCookie(user) {
  const token = crypto.randomBytes(32).toString("base64url");
  const loginRecord = await createLoginRecord(user);
  sessions.set(hashSessionToken(token), {
    username: user.username,
    role: user.role || "user",
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
    loginRecordId: loginRecord.id,
  });
  schedulePersistSessions();

  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${
    COOKIE_SECURE ? "; Secure" : ""
  }`;
}

async function clearSessionCookie(request) {
  const cookies = parseCookies(request);
  const token = cookies[SESSION_COOKIE] || cookies[LEGACY_SESSION_COOKIE];
  if (token) {
    const tokenHash = hashSessionToken(token);
    const session = sessions.get(tokenHash);
    if (session) {
      bailianSessionApiKeys.delete(getTerminalOwner(session));
    }
    if (session?.loginRecordId) {
      await closeLoginRecord(session.loginRecordId, "logout");
    }
    sessions.delete(tokenHash);
    schedulePersistSessions();
  }

  const secureSuffix = COOKIE_SECURE ? "; Secure" : "";
  return [
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureSuffix}`,
    `${LEGACY_SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
  ];
}

async function readRawBody(request, maxBytes = 1024 * 1024) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw new Error("Request body is too large");
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function readBody(request, maxBytes = 1024 * 1024) {
  const raw = await readRawBody(request, maxBytes);
  if (!raw.trim()) {
    return {};
  }

  return JSON.parse(raw);
}

function encodedBodyLimit(maxBytes) {
  return Math.ceil(maxBytes * 1.4) + 4096;
}

function decodeBase64UrlText(value) {
  const normalized = String(value || "").trim().replace(/-/g, "+").replace(/_/g, "/");
  if (!normalized) {
    return "";
  }

  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

async function readBase64UrlJsonBody(request, maxBytes = 1024 * 1024) {
  const encoded = (await readRawBody(request, encodedBodyLimit(maxBytes))).trim();
  if (!encoded) {
    return {};
  }

  const raw = decodeBase64UrlText(encoded);
  if (Buffer.byteLength(raw, "utf8") > maxBytes) {
    throw new Error("Request body is too large");
  }

  return JSON.parse(raw);
}

function getLocalServersFile(session) {
  const username = normalizeUsername(session?.username);

  if (!username || username === normalizeUsername(ADMIN_USERNAME)) {
    return SERVERS_FILE;
  }

  return path.join(DATA_DIR, "users", username, "ssh-servers.json");
}

function getCodexHistoriesFile(session) {
  return path.join(getUserDataDir(session), "codex-histories.json");
}

function getCodexWorkflowsFile(session) {
  return path.join(getUserDataDir(session), "codex-workflows.json");
}

function getUserCodexHome(session) {
  return path.join(getUserDataDir(session), "codex-home");
}

function getUserDataDir(session) {
  const username = normalizeUsername(session?.username) || normalizeUsername(ADMIN_USERNAME);

  if (username === normalizeUsername(ADMIN_USERNAME)) {
    return DATA_DIR;
  }

  return path.join(DATA_DIR, "users", username);
}

function getUserKnownHostsFile(session) {
  return path.join(getUserDataDir(session), "known_hosts");
}

function getProjectSshConfigFile(session) {
  const username = normalizeUsername(session?.username);

  if (!username || username === normalizeUsername(ADMIN_USERNAME)) {
    return SSH_CONFIG_FILE;
  }

  return path.join(getUserDataDir(session), "ssh-config");
}

function stripSensitiveServerFields(server) {
  if (!isPlainObject(server)) {
    return server;
  }

  const { password, passphrase, privateKey, ...safeServer } = server;
  return safeServer;
}

async function readLocalServers(session) {
  try {
    const raw = await readFile(getLocalServersFile(session), "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    const knownHostsFile = getUserKnownHostsFile(session);
    return parsed.map((server) => {
      const safeServer = stripSensitiveServerFields(server);
      if (safeServer?.source !== "local" || !safeServer.identityFile) {
        return safeServer;
      }

      return {
        ...safeServer,
        knownHostsFile: safeServer.knownHostsFile || knownHostsFile,
        strictHostKeyChecking: safeServer.strictHostKeyChecking || "accept-new",
      };
    });
  } catch {
    return [];
  }
}

async function writeLocalServers(session, servers) {
  const file = getLocalServersFile(session);
  await mkdir(path.dirname(file), { recursive: true });
  const safeServers = Array.isArray(servers) ? servers.map(stripSensitiveServerFields) : [];
  await writeFile(file, `${JSON.stringify(safeServers, null, 2)}\n`, "utf8");
}

async function readCodexHistories(session) {
  try {
    const raw = await readFile(getCodexHistoriesFile(session), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeCodexHistories(session, histories) {
  const file = getCodexHistoriesFile(session);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(histories, null, 2)}\n`, "utf8");
}

function publicCodexHistory(history, options = {}) {
  return {
    id: history.id,
    serverId: history.serverId,
    serverName: history.serverName,
    title: history.title,
    createdAt: history.createdAt,
    updatedAt: history.updatedAt,
    messageCount: Array.isArray(history.messages) ? history.messages.length : 0,
    ...(options.includeMessages ? { messages: history.messages || [] } : {}),
  };
}

function createCodexHistoryRecord(server, title = "") {
  const now = new Date().toISOString();
  return {
    id: `codex:${Date.now().toString(36)}-${crypto.randomBytes(5).toString("hex")}`,
    serverId: server.id,
    serverName: server.name,
    title: sanitizeText(title) || `${server.name} 對話`,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

function titleFromPrompt(prompt, fallback) {
  const text = sanitizeText(prompt)
    .replace(/\s+/g, " ")
    .slice(0, 36);
  return text || fallback;
}

async function listCodexHistories(session, serverId = "") {
  const histories = await readCodexHistories(session);
  return histories
    .filter((history) => !serverId || history.serverId === serverId)
    .sort((left, right) => Date.parse(right.updatedAt || "") - Date.parse(left.updatedAt || ""))
    .map((history) => publicCodexHistory(history));
}

async function getCodexHistory(session, historyId) {
  const histories = await readCodexHistories(session);
  return histories.find((history) => history.id === historyId) || null;
}

async function createCodexHistory(session, server, title = "") {
  const histories = await readCodexHistories(session);
  const history = createCodexHistoryRecord(server, title);
  histories.push(history);
  await writeCodexHistories(session, histories);
  return history;
}

async function deleteCodexHistory(session, historyId) {
  const histories = await readCodexHistories(session);
  const nextHistories = histories.filter((history) => history.id !== historyId);
  if (nextHistories.length === histories.length) {
    return false;
  }

  await writeCodexHistories(session, nextHistories);
  return true;
}

async function appendCodexHistoryMessages(session, historyId, messages, options = {}) {
  const histories = await readCodexHistories(session);
  const index = histories.findIndex((history) => history.id === historyId);
  if (index < 0) {
    return null;
  }

  const now = new Date().toISOString();
  const history = histories[index];
  const nextMessages = [...(Array.isArray(history.messages) ? history.messages : [])];
  for (const message of messages) {
    const content = String(message.content || "").trim();
    if (!content) {
      continue;
    }
    nextMessages.push({
      role: message.role,
      content,
      createdAt: message.createdAt || now,
    });
  }

  histories[index] = {
    ...history,
    serverName: options.serverName || history.serverName,
    title:
      history.title && !history.title.endsWith(" 對話")
        ? history.title
        : options.title || history.title,
    updatedAt: now,
    messages: nextMessages.slice(-80),
  };
  await writeCodexHistories(session, histories);
  return histories[index];
}

function getRemoteCodexWorkflowLocation(session) {
  const username =
    toSafeServerSlug(normalizeUsername(session?.username) || normalizeUsername(ADMIN_USERNAME)) ||
    "user";
  const directory = `$HOME/.cozypad/users/${username}`;

  return {
    directory,
    file: `${directory}/codex-workflows.json`,
  };
}

function parseRemoteCodexWorkflowsOutput(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return [];
  }

  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start < 0 || end <= start) {
      throw new Error("Remote Codex workflow JSON is invalid");
    }

    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  }
}

async function readCodexWorkflows(session, server) {
  if (!server) {
    throw new Error("Server is required");
  }

  if (isSystemLocalServer(server)) {
    try {
      const raw = await readFile(getCodexWorkflowsFile(session), "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  const { directory, file } = getRemoteCodexWorkflowLocation(session);
  const command = [
    "umask 077",
    `mkdir -p "${directory}"`,
    `if [ -f "${file}" ]; then cat "${file}"; else printf '[]\\n'; fi`,
  ].join(" && ");
  const result = await runRemoteCommand(session, server, command, 15000, {
    connectTimeout: 5,
    connectionAttempts: 1,
    stdoutLimit: REMOTE_CODEX_WORKFLOW_STDOUT_LIMIT,
  });

  if (!result.ok) {
    throw new Error(result.stderr || result.stdout || "Remote Codex workflow read failed");
  }

  return parseRemoteCodexWorkflowsOutput(result.stdout);
}

async function writeCodexWorkflows(session, server, workflows) {
  if (!server) {
    throw new Error("Server is required");
  }

  const sorted = Array.isArray(workflows)
    ? workflows
        .slice()
        .sort(
          (left, right) =>
            Date.parse(left.createdAt || left.updatedAt || "") -
            Date.parse(right.createdAt || right.updatedAt || ""),
        )
        .slice(-CODEX_WORKFLOW_LIMIT)
    : [];

  if (isSystemLocalServer(server)) {
    const file = getCodexWorkflowsFile(session);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
    return sorted;
  }

  const { directory, file } = getRemoteCodexWorkflowLocation(session);
  const command = [
    "umask 077",
    `mkdir -p "${directory}"`,
    `tmp=$(mktemp "${directory}/codex-workflows.XXXXXX")`,
    'cat > "$tmp"',
    `mv "$tmp" "${file}"`,
    `chmod 600 "${file}"`,
    "printf 'COZYPAD_REMOTE_CODEX_WORKFLOWS_OK\\n'",
  ].join(" && ");
  const result = await runRemoteCommandWithInput(
    session,
    server,
    command,
    `${JSON.stringify(sorted, null, 2)}\n`,
    25000,
    {
      connectTimeout: 5,
      connectionAttempts: 1,
      stdoutLimit: 4096,
      stderrLimit: 64 * 1024,
    },
  );

  if (!result.ok || !result.stdout.includes("COZYPAD_REMOTE_CODEX_WORKFLOWS_OK")) {
    throw new Error(result.stderr || result.stdout || "Remote Codex workflow write failed");
  }

  return sorted;
}

function normalizeCodexWorkflowId(value) {
  const id = String(value || "").trim();
  if (/^[A-Za-z0-9:_-]{8,180}$/.test(id)) {
    return id;
  }

  return `workflow:${Date.now().toString(36)}-${crypto.randomBytes(5).toString("hex")}`;
}

function trimCodexWorkflowOutput(value) {
  const text = String(value || "");
  if (text.length <= CODEX_WORKFLOW_OUTPUT_LIMIT) {
    return text;
  }

  return `[CozyPad] workflow output truncated\r\n${text.slice(-CODEX_WORKFLOW_OUTPUT_LIMIT)}`;
}

function normalizeCodexWorkflowStatus(value, fallback = "completed") {
  const status = String(value || "").trim();
  if (status === "completed" || status === "running" || status === "failed") {
    return status;
  }
  return fallback;
}

function publicCodexWorkflow(workflow) {
  return {
    id: workflow.id,
    title: workflow.title,
    serverId: workflow.serverId,
    serverName: workflow.serverName,
    serverTarget: workflow.serverTarget || "",
    remotePath: workflow.remotePath || "~",
    mode: "server",
    prompt: workflow.prompt || "",
    output: workflow.output || "",
    model: workflow.model || "",
    reasoningEffort: workflow.reasoningEffort || "",
    status: normalizeCodexWorkflowStatus(workflow.status, workflow.running ? "running" : "completed"),
    running: normalizeCodexWorkflowStatus(workflow.status, workflow.running ? "running" : "completed") === "running",
    connected: false,
    historyId: workflow.historyId || "",
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
  };
}

function codexWorkflowFromBody(body, server, existing = null) {
  const now = new Date().toISOString();
  const hasServerTarget =
    server &&
    (server.source === "ssh-config" ? server.alias || server.name : server.host || server.name);
  const prompt = String(body.prompt ?? existing?.prompt ?? "").trim();
  const remotePath = String(
    body.remotePath ?? existing?.remotePath ?? server?.defaultPath ?? "~",
  )
    .trim()
    .slice(0, 240) || "~";
  const title = sanitizeText(body.title ?? existing?.title ?? titleFromPrompt(prompt, "遠端工作"))
    .replace(/\s+/g, " ")
    .slice(0, 80);
  const mode = "server";
  const status = normalizeCodexWorkflowStatus(
    body.status ?? existing?.status,
    body.running ? "running" : "completed",
  );

  return {
    ...(existing || {}),
    id: normalizeCodexWorkflowId(body.id || existing?.id),
    title: title || "遠端工作",
    serverId: server?.id || existing?.serverId || "",
    serverName: server?.name || existing?.serverName || "server",
    serverTarget: hasServerTarget ? getServerTargetLabel(server) : existing?.serverTarget || "",
    remotePath,
    mode,
    prompt,
    output: trimCodexWorkflowOutput(body.output ?? existing?.output ?? ""),
    model: normalizeCodexModelOption(body.model ?? existing?.model ?? ""),
    reasoningEffort: normalizeCodexReasoningEffortOption(
      body.reasoningEffort ?? existing?.reasoningEffort ?? "",
    ),
    status,
    running: status === "running",
    historyId: String(body.historyId ?? existing?.historyId ?? ""),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}

async function listCodexWorkflows(session, serverId = "") {
  if (!serverId) {
    return [];
  }

  const server = await findServer(serverId, session);
  if (!server) {
    throw new Error("Server not found");
  }

  const workflows = await readCodexWorkflows(session, server);
  return workflows
    .filter((workflow) => !workflow.serverId || workflow.serverId === server.id)
    .sort(
      (left, right) =>
        Date.parse(left.createdAt || left.updatedAt || "") -
        Date.parse(right.createdAt || right.updatedAt || ""),
    )
    .map((workflow) =>
      publicCodexWorkflow({
        ...workflow,
        serverId: workflow.serverId || server.id,
        serverName: workflow.serverName || server.name,
        serverTarget: workflow.serverTarget || getServerTargetLabel(server),
      }),
    );
}

async function upsertCodexWorkflow(session, body) {
  const server = body.serverId ? await findServer(body.serverId, session) : null;
  if (!server) {
    throw new Error("Server is required");
  }

  const workflows = await readCodexWorkflows(session, server);
  const id = normalizeCodexWorkflowId(body.id);
  const index = workflows.findIndex((workflow) => workflow.id === id);
  const existing = index >= 0 ? workflows[index] : null;
  const workflow = codexWorkflowFromBody({ ...body, id }, server, existing);

  if (index >= 0) {
    workflows[index] = workflow;
  } else {
    workflows.unshift(workflow);
  }

  await writeCodexWorkflows(session, server, workflows);
  return workflow;
}

async function updateCodexWorkflow(session, workflowId, body) {
  const server = body.serverId ? await findServer(body.serverId, session) : null;
  if (!server) {
    throw new Error("Server is required");
  }

  const workflows = await readCodexWorkflows(session, server);
  const index = workflows.findIndex((workflow) => workflow.id === workflowId);
  if (index < 0) {
    return null;
  }

  const existing = workflows[index];
  const workflow = codexWorkflowFromBody(
    {
      ...existing,
      ...body,
      id: existing.id,
      serverId: server.id,
    },
    server,
    existing,
  );
  workflows[index] = workflow;
  await writeCodexWorkflows(session, server, workflows);
  return workflow;
}

async function deleteCodexWorkflow(session, workflowId, serverId = "") {
  const server = serverId ? await findServer(serverId, session) : null;
  if (!server) {
    throw new Error("Server is required");
  }

  const workflows = await readCodexWorkflows(session, server);
  const nextWorkflows = workflows.filter((workflow) => workflow.id !== workflowId);
  if (nextWorkflows.length === workflows.length) {
    return false;
  }

  await writeCodexWorkflows(session, server, nextWorkflows);
  return true;
}

function buildRemoteClaudeShellCommand(script) {
  return `if command -v bash >/dev/null 2>&1; then bash -lc ${shellQuote(script)}; else sh -lc ${shellQuote(
    script,
  )}; fi`;
}

function remoteCliBootstrapLines(extraDirs = []) {
  const dirs = [
    ...extraDirs,
    "$HOME/.local/bin",
    "$HOME/bin",
    "$HOME/.npm-global/bin",
    "$HOME/.npm/bin",
    "$HOME/.bun/bin",
    "$HOME/.yarn/bin",
    "$HOME/.deno/bin",
    "$HOME/.cargo/bin",
  ];
  const dirList = dirs.map((dir) => `"${dir}"`).join(" ");

  return [
    "set +u",
    'if [ -n "${BASH_VERSION:-}" ]; then shopt -s expand_aliases 2>/dev/null || true; fi',
    'for f in "$HOME/.profile" "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.bashrc" "$HOME/.zprofile" "$HOME/.zshrc"; do [ -r "$f" ] && . "$f" >/dev/null 2>&1 || true; done',
    `for d in ${dirList}; do [ -d "$d" ] && PATH="$d:$PATH"; done`,
    'if [ -d "$HOME/.nvm" ]; then export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true; fi',
    'if [ -d "$HOME/.nvm/versions/node" ]; then for d in "$HOME"/.nvm/versions/node/*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done; fi',
    'if command -v npm >/dev/null 2>&1; then npm_prefix=$(npm prefix -g 2>/dev/null || true); [ -n "$npm_prefix" ] && [ -d "$npm_prefix/bin" ] && PATH="$npm_prefix/bin:$PATH"; fi',
    "export PATH",
    "hash -r 2>/dev/null || true",
  ];
}

function remoteClaudeBootstrapLines() {
  return remoteCliBootstrapLines(["$HOME/.claude/local", "$HOME/.claude/bin"]);
}

function remoteAgyBootstrapLines() {
  return remoteCliBootstrapLines(["$HOME/.agy/bin", "$HOME/.agy/local"]);
}

function remoteBailianBootstrapLines() {
  return remoteCliBootstrapLines(["$HOME/.bailian/bin", "$HOME/.bailian/local"]);
}

function remoteCodexBootstrapLines() {
  return remoteCliBootstrapLines(["$HOME/.codex/bin", "$HOME/.codex/local"]);
}

async function getRemoteClaudeStatus(session, serverId = "") {
  const server = serverId ? await findServer(serverId, session) : null;
  if (!server) {
    throw new Error("Server is required");
  }
  if (isSystemLocalServer(server)) {
    return getLocalAgentStatus(session, server, "claude", "Claude");
  }
  if (AGENT_TERMINAL_BRIDGE_ENABLED && findReusableTerminalSession(session, server.id)) {
    return getTerminalBridgeAgentStatus(session, server, "Claude", "Claude");
  }
  const blockKey = assertRemoteAgentNotBlocked("Claude", getTerminalOwner(session), server);

  const script = [
    "set +e",
    ...remoteClaudeBootstrapLines(),
    'claude_path=$(command -v claude 2>/dev/null || true)',
    'if [ -n "$claude_path" ]; then',
    "  printf '__COZYPAD_CLAUDE_AVAILABLE__\\n'",
    '  printf "%s\\n" "$claude_path"',
    '  claude --dangerously-skip-permissions --version 2>/dev/null | head -n 1 || claude --dangerously-skip-permissions --help 2>/dev/null | head -n 1 || true',
    "  printf '__COZYPAD_CLAUDE_MODELS_BEGIN__\\n'",
    '  claude --dangerously-skip-permissions --help 2>/dev/null | grep -Eio "claude-[A-Za-z0-9._-]+|\\b(opus|sonnet|haiku|fable)\\b" | head -n 200 || true',
    '  for f in "$HOME/.claude/settings.json" "$HOME/.claude.json"; do',
    '    [ -r "$f" ] || continue',
    '    grep -Eio "claude-[A-Za-z0-9._-]+|\\b(opus|sonnet|haiku|fable)\\b" "$f" 2>/dev/null | head -n 200 || true',
    '    model_line=$(grep -E \'"model"[[:space:]]*:\' "$f" 2>/dev/null | head -n 1 || true)',
    "    if [ -n \"$model_line\" ]; then default_model=$(printf \"%s\" \"$model_line\" | sed -n 's/.*\"model\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p' | head -n 1); [ -n \"$default_model\" ] && printf '__COZYPAD_CLAUDE_DEFAULT_MODEL__:%s\\n' \"$default_model\"; fi",
    "  done",
    "  printf '__COZYPAD_CLAUDE_MODELS_END__\\n'",
    "  exit 0",
    "fi",
    'probe_file=$(mktemp "${TMPDIR:-/tmp}/cozypad-claude-probe.XXXXXX") || exit 1',
    'trap \'rm -f "$probe_file"\' EXIT',
    "if command -v timeout >/dev/null 2>&1; then",
    '  timeout 6s claude --dangerously-skip-permissions >"$probe_file" 2>&1 </dev/null',
    "  probe_status=$?",
    "else",
    '  claude --dangerously-skip-permissions --help >"$probe_file" 2>&1 </dev/null',
    "  probe_status=$?",
    "fi",
    'if [ "$probe_status" -eq 0 ] || [ "$probe_status" -eq 124 ] || { [ "$probe_status" -ne 127 ] && ! grep -Eqi "not found|not recognized" "$probe_file"; }; then',
    "  printf '__COZYPAD_CLAUDE_AVAILABLE__\\n'",
    "  printf 'claude\\n'",
    '  head -n 1 "$probe_file" || true',
    "  printf '__COZYPAD_CLAUDE_MODELS_BEGIN__\\n'",
    '  grep -Eio "claude-[A-Za-z0-9._-]+|\\b(opus|sonnet|haiku|fable)\\b" "$probe_file" 2>/dev/null | head -n 200 || true',
    "  printf '__COZYPAD_CLAUDE_MODELS_END__\\n'",
    "  exit 0",
    "fi",
    "printf '__COZYPAD_CLAUDE_MISSING__\\n' >&2",
    'cat "$probe_file" >&2',
    "exit 127",
  ].join("\n");

  const result = await runRemoteCommand(
    session,
    server,
    buildRemoteClaudeShellCommand(script),
    15000,
    {
      connectTimeout: 5,
      connectionAttempts: 1,
      stdoutLimit: 64 * 1024,
      stderrLimit: 8192,
    },
  );
  const blockedByTransport = blockRemoteAgentOnTransportError("Claude", blockKey, result);

  const lines = String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const available = lines.includes("__COZYPAD_CLAUDE_AVAILABLE__");
  const markerIndex = lines.indexOf("__COZYPAD_CLAUDE_AVAILABLE__");
  const modelInfo = parseAgentModelMarkers(
    result.stdout,
    CLAUDE_DEFAULT_MODEL_MARKER,
    CLAUDE_MODELS_BEGIN_MARKER,
    CLAUDE_MODELS_END_MARKER,
    CLAUDE_MODEL_FALLBACKS,
  );

  return {
    server: publicSshServer(server),
    available,
    path: available && markerIndex >= 0 ? lines[markerIndex + 1] || "" : "",
    version: available && markerIndex >= 0 ? lines[markerIndex + 2] || "" : "",
    models: modelInfo.models,
    defaultModel: modelInfo.defaultModel,
    error: available
      ? ""
      : blockedByTransport
        ? remoteAgentCooldownMessage("Claude", getRemoteAgentBlock(blockKey))
        : truncateForApi(result.stderr || "Remote Claude CLI not found"),
    checkedAt: new Date().toISOString(),
  };
}

async function getRemoteAgyStatus(session, serverId = "") {
  const server = serverId ? await findServer(serverId, session) : null;
  if (!server) {
    throw new Error("Server is required");
  }
  if (isSystemLocalServer(server)) {
    return getLocalAgentStatus(session, server, "agy", "agy");
  }
  if (AGENT_TERMINAL_BRIDGE_ENABLED && findReusableTerminalSession(session, server.id)) {
    return getTerminalBridgeAgentStatus(session, server, "agy", "agy");
  }
  const blockKey = assertRemoteAgentNotBlocked("agy", getTerminalOwner(session), server);

  const script = [
    "set +e",
    ...remoteAgyBootstrapLines(),
    'agy_path=$(command -v agy 2>/dev/null || true)',
    'if [ -n "$agy_path" ]; then',
    "  printf '__COZYPAD_AGY_AVAILABLE__\\n'",
    '  printf "%s\\n" "$agy_path"',
    '  agy --version 2>/dev/null | head -n 1 || agy --help 2>/dev/null | head -n 1 || printf "agy\\n"',
    "  printf '__COZYPAD_AGY_MODELS_BEGIN__\\n'",
    "  if command -v timeout >/dev/null 2>&1 && command -v script >/dev/null 2>&1; then",
    "    timeout 20s script -q -c 'agy models' /dev/null 2>/dev/null | head -n 300 || true",
    "  elif command -v timeout >/dev/null 2>&1; then",
    '    timeout 12s agy models 2>/dev/null | head -n 300 || true',
    "  else",
    '    agy models 2>/dev/null | head -n 300 || true',
    "  fi",
    "  printf '__COZYPAD_AGY_MODELS_END__\\n'",
    "  exit 0",
    "fi",
    'probe_file=$(mktemp "${TMPDIR:-/tmp}/cozypad-agy-probe.XXXXXX") || exit 1',
    'trap \'rm -f "$probe_file"\' EXIT',
    "if command -v timeout >/dev/null 2>&1; then",
    '  timeout 6s agy --help >"$probe_file" 2>&1 </dev/null',
    "  probe_status=$?",
    "else",
    '  agy --help >"$probe_file" 2>&1 </dev/null',
    "  probe_status=$?",
    "fi",
    'if [ "$probe_status" -eq 0 ] || [ "$probe_status" -eq 124 ] || { [ "$probe_status" -ne 127 ] && ! grep -Eqi "not found|not recognized" "$probe_file"; }; then',
    "  printf '__COZYPAD_AGY_AVAILABLE__\\n'",
    "  printf 'agy\\n'",
    '  head -n 1 "$probe_file" || true',
    "  printf '__COZYPAD_AGY_MODELS_BEGIN__\\n'",
    '  grep -Eio "claude-[A-Za-z0-9._-]+|gemini-[A-Za-z0-9._-]+|gpt-[A-Za-z0-9._-]+|qwen[A-Za-z0-9._-]*" "$probe_file" 2>/dev/null | head -n 200 || true',
    "  printf '__COZYPAD_AGY_MODELS_END__\\n'",
    "  exit 0",
    "fi",
    "printf '__COZYPAD_AGY_MISSING__\\n' >&2",
    'cat "$probe_file" >&2',
    "exit 127",
  ].join("\n");

  const result = await runRemoteCommand(
    session,
    server,
    buildRemoteClaudeShellCommand(script),
    15000,
    {
      connectTimeout: 5,
      connectionAttempts: 1,
      stdoutLimit: 64 * 1024,
      stderrLimit: 8192,
    },
  );
  const blockedByTransport = blockRemoteAgentOnTransportError("agy", blockKey, result);

  const lines = String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const available = lines.includes("__COZYPAD_AGY_AVAILABLE__");
  const markerIndex = lines.indexOf("__COZYPAD_AGY_AVAILABLE__");
  const modelInfo = parseAgentModelMarkers(
    result.stdout,
    AGY_DEFAULT_MODEL_MARKER,
    AGY_MODELS_BEGIN_MARKER,
    AGY_MODELS_END_MARKER,
    AGY_MODEL_FALLBACKS,
  );

  return {
    server: publicSshServer(server),
    available,
    path: available && markerIndex >= 0 ? lines[markerIndex + 1] || "" : "",
    version: available && markerIndex >= 0 ? lines[markerIndex + 2] || "" : "",
    models: modelInfo.models,
    defaultModel: modelInfo.defaultModel,
    error: available
      ? ""
      : blockedByTransport
        ? remoteAgentCooldownMessage("agy", getRemoteAgentBlock(blockKey))
        : truncateForApi(result.stderr || "Remote agy CLI not found"),
    checkedAt: new Date().toISOString(),
  };
}

async function getRemoteBailianStatus(session, serverId = "", options = {}) {
  const server = serverId ? await findServer(serverId, session) : null;
  if (!server) {
    throw new Error("Server is required");
  }
  if (isSystemLocalServer(server)) {
    return getLocalAgentStatus(session, server, "bailian", "bailian");
  }
  if (AGENT_TERMINAL_BRIDGE_ENABLED && findReusableTerminalSession(session, server.id)) {
    return getTerminalBridgeAgentStatus(session, server, "bailian", "baillian");
  }
  if (options.hasApiKey) {
    return bailianApiStatus(server);
  }
  const blockKey = assertRemoteAgentNotBlocked("bailian", getTerminalOwner(session), server);

  const script = [
    "set +e",
    ...remoteBailianBootstrapLines(),
    'bailian_path=$(command -v bailian 2>/dev/null || true)',
    'if [ -n "$bailian_path" ]; then',
    "  printf '__COZYPAD_BAILIAN_AVAILABLE__\\n'",
    '  printf "%s\\n" "$bailian_path"',
    '  bailian --version 2>/dev/null | head -n 1 || bailian --help 2>/dev/null | head -n 1 || true',
    "  exit 0",
    "fi",
    'probe_file=$(mktemp "${TMPDIR:-/tmp}/cozypad-bailian-probe.XXXXXX") || exit 1',
    'trap \'rm -f "$probe_file"\' EXIT',
    "if command -v timeout >/dev/null 2>&1; then",
    '  timeout 6s bailian --help >"$probe_file" 2>&1 </dev/null',
    "  probe_status=$?",
    "else",
    '  bailian --help >"$probe_file" 2>&1 </dev/null',
    "  probe_status=$?",
    "fi",
    'if [ "$probe_status" -eq 0 ] || [ "$probe_status" -eq 124 ] || { [ "$probe_status" -ne 127 ] && ! grep -Eqi "not found|not recognized" "$probe_file"; }; then',
    "  printf '__COZYPAD_BAILIAN_AVAILABLE__\\n'",
    "  printf 'bailian\\n'",
    '  head -n 1 "$probe_file" || true',
    "  exit 0",
    "fi",
    "printf '__COZYPAD_BAILIAN_MISSING__\\n' >&2",
    'cat "$probe_file" >&2',
    "exit 127",
  ].join("\n");

  const result = await runRemoteCommand(
    session,
    server,
    buildRemoteClaudeShellCommand(script),
    15000,
    {
      connectTimeout: 5,
      connectionAttempts: 1,
      stdoutLimit: 8192,
      stderrLimit: 8192,
    },
  );
  const blockedByTransport = blockRemoteAgentOnTransportError("bailian", blockKey, result);

  const lines = String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const available = lines.includes("__COZYPAD_BAILIAN_AVAILABLE__");
  const markerIndex = lines.indexOf("__COZYPAD_BAILIAN_AVAILABLE__");
  const modelInfo = bailianModelInfo(BAILIAN_MODEL, parseModelNamesFromText(result.stdout));

  if (!available && hasBailianApiFallback()) {
    return bailianApiStatus(server);
  }

  return {
    server: publicSshServer(server),
    available,
    path: available && markerIndex >= 0 ? lines[markerIndex + 1] || "" : "",
    version: available && markerIndex >= 0 ? lines[markerIndex + 2] || "" : "",
    models: modelInfo.models,
    defaultModel: modelInfo.defaultModel,
    error: available
      ? ""
      : blockedByTransport
        ? remoteAgentCooldownMessage("bailian", getRemoteAgentBlock(blockKey))
        : truncateForApi(result.stderr || "Remote bailian CLI not found"),
    checkedAt: new Date().toISOString(),
  };
}

async function getRemoteCodexStatus(session, serverId = "") {
  const server = serverId ? await findServer(serverId, session) : null;
  if (!server) {
    throw new Error("Server is required");
  }
  if (isSystemLocalServer(server)) {
    const cli = await getCodexCliStatus(session);
    const modelInfo = await getLocalCodexModelInfo(session, cli);
    return {
      server: publicSshServer(server),
      available: Boolean(cli.available),
      path: cli.available ? [cli.command, ...(cli.args || [])].filter(Boolean).join(" ") : "",
      version: cli.available ? cli.version || "Codex CLI" : "",
      error: cli.available ? "" : cli.error || localCliNotFoundMessage("codex", "Codex"),
      checkedAt: new Date().toISOString(),
      models: modelInfo.models,
      defaultModel: modelInfo.defaultModel,
    };
  }
  if (AGENT_TERMINAL_BRIDGE_ENABLED && findReusableTerminalSession(session, server.id)) {
    return getTerminalBridgeAgentStatus(session, server, "Codex", "Codex");
  }
  const blockKey = assertRemoteAgentNotBlocked("Codex", getTerminalOwner(session), server);

  const script = [
    "set +e",
    ...remoteCodexBootstrapLines(),
    'codex_path=$(command -v codex 2>/dev/null || true)',
    "codex_available=0",
    'if [ -n "$codex_path" ]; then',
    "  codex_available=1",
    "else",
    '  probe_file=$(mktemp "${TMPDIR:-/tmp}/cozypad-codex-probe.XXXXXX") || probe_file=""',
    '  if [ -n "$probe_file" ]; then',
    '    trap \'rm -f "$probe_file" "$models_file"\' EXIT',
    "    if command -v timeout >/dev/null 2>&1; then",
    '      timeout 6s codex --help >"$probe_file" 2>&1 </dev/null',
    "      probe_status=$?",
    "    else",
    '      codex --help >"$probe_file" 2>&1 </dev/null',
    "      probe_status=$?",
    "    fi",
    '    if [ "$probe_status" -eq 0 ] || [ "$probe_status" -eq 124 ] || { [ "$probe_status" -ne 127 ] && ! grep -Eqi "not found|not recognized" "$probe_file"; }; then',
    "      codex_available=1",
    "      codex_path=codex",
    "    fi",
    "  fi",
    "fi",
    'if [ "$codex_available" = "1" ]; then',
    "  printf '__COZYPAD_CODEX_AVAILABLE__\\n'",
    '  printf "%s\\n" "$codex_path"',
    '  codex --version 2>/dev/null | head -n 1 || codex --help 2>/dev/null | head -n 1 || true',
    '  if [ -r "$HOME/.codex/config.toml" ]; then',
    `    grep -E '^[[:space:]]*model[[:space:]]*=' "$HOME/.codex/config.toml" | head -n 1 | cut -d= -f2- | sed -E 's/[[:space:]]*#.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//' | tr -d '"' | sed -E 's/^/__COZYPAD_CODEX_DEFAULT_MODEL__:/'`,
    "  fi",
    '  models_file=$(mktemp "${TMPDIR:-/tmp}/cozypad-codex-models.XXXXXX") || models_file=""',
    '  if [ -n "$models_file" ]; then',
    "    if command -v timeout >/dev/null 2>&1; then",
    '      timeout 8s codex debug models >"$models_file" 2>/dev/null',
    "    else",
    '      codex debug models >"$models_file" 2>/dev/null',
    "    fi",
    '    if [ -s "$models_file" ]; then',
    "      if command -v python3 >/dev/null 2>&1; then",
    "        python3 - \"$models_file\" <<'PY'",
    "import json, sys",
    "try:",
    "    with open(sys.argv[1], 'r', encoding='utf-8') as handle:",
    "        data = json.load(handle)",
    "except Exception:",
    "    data = {}",
    "for row in data.get('models', []) if isinstance(data, dict) else []:",
    "    slug = row.get('slug') or row.get('id') or row.get('model') or row.get('name')",
    "    if isinstance(slug, str) and slug:",
    "        print('__COZYPAD_CODEX_MODEL__:' + slug)",
    "PY",
    "      else",
    `        grep -o '"slug"[[:space:]]*:[[:space:]]*"[^"]*"' "$models_file" | sed -E 's/.*"slug"[[:space:]]*:[[:space:]]*"([^"]*)".*/__COZYPAD_CODEX_MODEL__:\\1/'`,
    "      fi",
    "    fi",
    '    rm -f "$models_file"',
    "  fi",
    "  exit 0",
    "fi",
    "printf '__COZYPAD_CODEX_MISSING__\\n' >&2",
    'if [ -n "$probe_file" ]; then cat "$probe_file" >&2; fi',
    "exit 127",
  ].join("\n");

  const result = await runRemoteCommand(
    session,
    server,
    buildRemoteClaudeShellCommand(script),
    15000,
    {
      connectTimeout: 5,
      connectionAttempts: 1,
      stdoutLimit: 65536,
      stderrLimit: 8192,
    },
  );
  const blockedByTransport = blockRemoteAgentOnTransportError("Codex", blockKey, result);

  const lines = String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const available = lines.includes("__COZYPAD_CODEX_AVAILABLE__");
  const markerIndex = lines.indexOf("__COZYPAD_CODEX_AVAILABLE__");
  const modelInfo = parseCodexModelMarkers(result.stdout);

  return {
    server: publicSshServer(server),
    available,
    path: available && markerIndex >= 0 ? lines[markerIndex + 1] || "" : "",
    version: available && markerIndex >= 0 ? lines[markerIndex + 2] || "" : "",
    error: available
      ? ""
      : blockedByTransport
        ? remoteAgentCooldownMessage("Codex", getRemoteAgentBlock(blockKey))
        : truncateForApi(result.stderr || "Remote Codex CLI not found"),
    checkedAt: new Date().toISOString(),
    models: normalizeCodexModelList([
      modelInfo.defaultModel,
      ...modelInfo.models,
      ...(modelInfo.models.length ? [] : CODEX_MODEL_FALLBACKS),
    ]),
    defaultModel: modelInfo.defaultModel,
  };
}

function normalizeRemoteClaudeAllowedDirs(value, remotePath) {
  const dirs = [];
  const pushDir = (candidate) => {
    const dir = String(candidate || "").trim().slice(0, 240);
    if (!dir || dir === "~") return;
    if (!dir.startsWith("/") && !dir.startsWith("~/")) return;
    if (dir.includes("\0") || /[\r\n]/.test(dir)) return;
    if (!dirs.includes(dir)) dirs.push(dir);
  };

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 12)) pushDir(item);
  }
  pushDir(remotePath);
  return dirs.slice(0, 12);
}

function buildRemoteClaudeArgs(allowedDirs, model = "") {
  const cleanModel = normalizeCodexModelOption(model);
  return [
    "--dangerously-skip-permissions",
    ...(cleanModel ? ["--model", cleanModel] : []),
    ...normalizeRemoteClaudeAllowedDirs(allowedDirs).flatMap((dir) => ["--add-dir", dir]),
  ]
    .map(shellQuote)
    .join(" ");
}

function buildRemoteAgyArgs(model = "") {
  const cleanModel = normalizeCodexModelOption(model);
  return [...(cleanModel ? ["--model", cleanModel] : [])]
    .map(shellQuote)
    .join(" ");
}

function buildRemoteBailianArgs(model = "") {
  const cleanModel = normalizeBailianModelOption(model);
  return ["--model", cleanModel].map(shellQuote).join(" ");
}

function windowsCmdQuote(value) {
  const text = String(value || "");
  if (/^[A-Za-z0-9_./:=+\-]+$/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

function localCliShell(cliName, args = []) {
  const parts = [cliName, ...args].map((part) =>
    process.platform === "win32" ? windowsCmdQuote(part) : shellQuote(part),
  );

  if (process.platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", `chcp 65001 >NUL && ${parts.join(" ")}`],
    };
  }

  return {
    command: "sh",
    args: ["-lc", parts.join(" ")],
  };
}

function localAgentEnv() {
  return {
    ...process.env,
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    TERM: "dumb",
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    PATH: getPathValue(),
  };
}

function localCliMissing(result, cliName = "") {
  const rawText = `${result?.stdout || ""}\n${result?.stderr || ""}`;
  const text = rawText.toLowerCase();
  const cleanCli = String(cliName || "").trim().toLowerCase();
  return (
    result?.code === -1 ||
    text.includes("not recognized") ||
    text.includes("not found") ||
    text.includes("command not found") ||
    text.includes("no such file or directory") ||
    text.includes("failed to run command") ||
    text.includes("enoent") ||
    rawText.includes("\uFFFD") ||
    Boolean(cleanCli && text.includes(cleanCli) && rawText.includes("?"))
  );
}
function localCliNotFoundMessage(cliName, label) {
  return `Local ${label} CLI was not found. Install ${label} CLI or add "${cliName}" to PATH, then refresh CozyPad.`;
}

async function localCliExists(cliName, cwdValue = "~") {
  const cwd = resolveLocalPath(cwdValue || "~", os.homedir());
  if (process.platform === "win32") {
    const result = await runProcess("where.exe", [cliName], {
      cwd,
      env: localAgentEnv(),
      timeoutMs: 5000,
      stdoutLimit: 8192,
      stderrLimit: 8192,
    });
    return result.ok && Boolean(String(result.stdout || "").trim());
  }

  const result = await runProcess("sh", ["-lc", `command -v ${shellQuote(cliName)}`], {
    cwd,
    env: localAgentEnv(),
    timeoutMs: 5000,
    stdoutLimit: 8192,
    stderrLimit: 8192,
  });
  return result.ok && Boolean(String(result.stdout || "").trim());
}

async function runLocalCli(cliName, args = [], options = {}) {
  const shell = localCliShell(cliName, args);
  return runProcess(shell.command, shell.args, {
    cwd: resolveLocalPath(options.cwd || "~", os.homedir()),
    env: options.env || localAgentEnv(),
    input: options.input,
    timeoutMs: options.timeoutMs || 15000,
    stdoutLimit: options.stdoutLimit || 512 * 1024,
    stderrLimit: options.stderrLimit || 128 * 1024,
  });
}

function parseDefaultAgentModelFromText(text) {
  const clean = stripAnsiText(text);
  const jsonMatch = clean.match(/"model"\s*:\s*"([^"]+)"/i);
  if (jsonMatch?.[1]) {
    return normalizeCodexModelOption(jsonMatch[1]);
  }
  const tomlMatch = clean.match(/^\s*model\s*=\s*["']?([^"'\s#]+)["']?/im);
  return normalizeCodexModelOption(tomlMatch?.[1] || "");
}

async function getLocalAgentModelInfo(cliName, cwd = "~") {
  const fallbackModels =
    cliName === "claude"
      ? CLAUDE_MODEL_FALLBACKS
      : cliName === "agy"
        ? AGY_MODEL_FALLBACKS
        : cliName === "bailian"
          ? BAILIAN_MODEL_FALLBACKS
          : [];
  if (fallbackModels.length === 0) {
    return null;
  }

  let text = "";
  if (cliName === "agy") {
    const result = await runLocalCli("agy", ["models"], {
      cwd,
      timeoutMs: 12000,
      stdoutLimit: 256 * 1024,
      stderrLimit: 64 * 1024,
    });
    text = `${result.stdout || ""}\n${result.stderr || ""}`;
  } else if (cliName === "claude") {
    const help = await runLocalCli("claude", ["--dangerously-skip-permissions", "--help"], {
      cwd,
      timeoutMs: 8000,
      stdoutLimit: 64 * 1024,
      stderrLimit: 16 * 1024,
    });
    text = `${help.stdout || ""}\n${help.stderr || ""}`;
    for (const file of [
      path.join(os.homedir(), ".claude", "settings.json"),
      path.join(os.homedir(), ".claude.json"),
    ]) {
      try {
        text = `${text}\n${await readFile(file, "utf8")}`;
      } catch {
        // Optional local Claude settings file.
      }
    }
  } else if (cliName === "bailian") {
    const help = await runLocalCli("bailian", ["--help"], {
      cwd,
      timeoutMs: 8000,
      stdoutLimit: 64 * 1024,
      stderrLimit: 16 * 1024,
    });
    text = `${help.stdout || ""}\n${help.stderr || ""}`;
  }

  const defaultModel = parseDefaultAgentModelFromText(text) || (cliName === "bailian" ? BAILIAN_MODEL : "");
  return {
    defaultModel,
    models: normalizeCodexModelList([
      defaultModel,
      ...parseModelNamesFromText(text),
      ...fallbackModels,
    ]),
  };
}

async function getLocalAgentStatus(session, server, cliName, label) {
  const exists = await localCliExists(cliName, server.defaultPath || "~");
  if (!exists) {
    if (cliName === "bailian" && hasBailianApiFallback()) {
      return bailianApiStatus(server);
    }
    return {
      server: publicSshServer(server),
      available: false,
      path: "",
      version: "",
      error: localCliNotFoundMessage(cliName, label),
      checkedAt: new Date().toISOString(),
    };
  }

  const unrestrictedArgs = cliName === "claude" ? ["--dangerously-skip-permissions"] : [];
  const version = await runLocalCli(cliName, [...unrestrictedArgs, "--version"], {
    cwd: server.defaultPath || "~",
    timeoutMs: 8000,
    stdoutLimit: 8192,
    stderrLimit: 8192,
  });
  const help = version.ok
    ? null
    : await runLocalCli(cliName, [...unrestrictedArgs, "--help"], {
        cwd: server.defaultPath || "~",
        timeoutMs: 8000,
        stdoutLimit: 8192,
        stderrLimit: 8192,
      });
  const result = version.ok ? version : help || version;
  const output = String(result.stdout || result.stderr || "").trim();
  const available = version.ok || Boolean(output && !localCliMissing(result, cliName));
  const modelInfo = available
    ? await getLocalAgentModelInfo(cliName, server.defaultPath || "~")
    : null;

  return {
    server: publicSshServer(server),
    available,
    path: available ? cliName : "",
    version: available ? output.split(/\r?\n/)[0] || `${label} CLI` : "",
    ...(modelInfo ? { models: modelInfo.models, defaultModel: modelInfo.defaultModel } : {}),
    error: available ? "" : localCliNotFoundMessage(cliName, label),
    checkedAt: new Date().toISOString(),
  };
}

async function runLocalClaudePrompt(session, server, prompt, remotePath, model = "") {
  const startedAt = Date.now();
  const cwd = resolveLocalPath(remotePath || server.defaultPath || "~", os.homedir());
  const exists = await localCliExists("claude", cwd);
  if (!exists) {
    return {
      server: publicSshServer(server),
      status: "failed",
      output: localCliNotFoundMessage("claude", "Claude"),
      stderr: "",
      code: 127,
      durationMs: Date.now() - startedAt,
    };
  }

  const cleanModel = normalizeCodexModelOption(model);
  const modelArgs = cleanModel ? ["--model", cleanModel] : [];
  let result = await runLocalCli("claude", ["--dangerously-skip-permissions", ...modelArgs, "-p"], {
    cwd,
    input: `${prompt}\n`,
    timeoutMs: 300000,
    stdoutLimit: 2 * 1024 * 1024,
    stderrLimit: 256 * 1024,
  });

  if (localCliMissing(result, "claude")) {
    return {
      server: publicSshServer(server),
      status: "failed",
      output: localCliNotFoundMessage("claude", "Claude"),
      stderr: "",
      code: 127,
      durationMs: Date.now() - startedAt,
    };
  }

  if (!result.ok) {
    result = await runLocalCli("claude", ["--dangerously-skip-permissions", ...modelArgs, "--print"], {
      cwd,
      input: `${prompt}\n`,
      timeoutMs: 300000,
      stdoutLimit: 2 * 1024 * 1024,
      stderrLimit: 256 * 1024,
    });
  }

  if (localCliMissing(result, "claude")) {
    return {
      server: publicSshServer(server),
      status: "failed",
      output: localCliNotFoundMessage("claude", "Claude"),
      stderr: "",
      code: 127,
      durationMs: Date.now() - startedAt,
    };
  }

  return {
    server: publicSshServer(server),
    status: result.ok ? "completed" : "failed",
    output: truncateForApi(result.stdout || result.stderr || "", 128 * 1024),
    stderr: truncateForApi(result.stderr || ""),
    code: result.code,
    durationMs: Date.now() - startedAt,
  };
}

async function runLocalAgyPrompt(session, server, prompt, remotePath, model = "") {
  const startedAt = Date.now();
  const cwd = resolveLocalPath(remotePath || server.defaultPath || "~", os.homedir());
  const exists = await localCliExists("agy", cwd);
  if (!exists) {
    return {
      server: publicSshServer(server),
      status: "failed",
      output: localCliNotFoundMessage("agy", "agy"),
      stderr: "",
      code: 127,
      durationMs: Date.now() - startedAt,
    };
  }

  const cleanModel = normalizeCodexModelOption(model);
  const modelArgs = cleanModel ? ["--model", cleanModel] : [];
  const attempts = [
    [...modelArgs, "-p", prompt],
    [...modelArgs, "--print", prompt],
    [...modelArgs],
  ];
  let result = null;

  for (const args of attempts) {
    result = await runLocalCli("agy", args, {
      cwd,
      input: `${prompt}\n`,
      timeoutMs: 300000,
      stdoutLimit: 2 * 1024 * 1024,
      stderrLimit: 256 * 1024,
    });
    if (result.ok || localCliMissing(result, "agy")) {
      break;
    }
  }

  result ||= { ok: false, code: -1, stdout: "", stderr: "agy CLI not found on localhost" };

  if (localCliMissing(result, "agy")) {
    return {
      server: publicSshServer(server),
      status: "failed",
      output: localCliNotFoundMessage("agy", "agy"),
      stderr: "",
      code: 127,
      durationMs: Date.now() - startedAt,
    };
  }

  return {
    server: publicSshServer(server),
    status: result.ok ? "completed" : "failed",
    output: truncateForApi(result.stdout || result.stderr || "", 128 * 1024),
    stderr: truncateForApi(result.stderr || ""),
    code: result.code,
    durationMs: Date.now() - startedAt,
  };
}

function agentKeyEnv(apiKey = "") {
  const key = extractBailianApiKeyText(apiKey).slice(0, 24000);
  if (!key) return localAgentEnv();
  return {
    ...localAgentEnv(),
    DASHSCOPE_API_KEY: key,
    BAILIAN_API_KEY: key,
    ALIBABA_CLOUD_API_KEY: key,
  };
}

function stripBailianKeyQuotes(value) {
  return String(value || "")
    .trim()
    .replace(/^['"]|['"];?$/g, "")
    .trim();
}

function extractBailianApiKeyText(value = "") {
  const text = String(value || "").replace(/^\uFEFF/, "").trim();
  if (!text) return "";

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      for (const key of [
        "COZYPAD_BAILIAN_API_KEY",
        "DASHSCOPE_API_KEY",
        "BAILIAN_API_KEY",
        "ALIBABA_CLOUD_API_KEY",
        "apiKey",
        "key",
      ]) {
        if (typeof parsed[key] === "string" && parsed[key].trim()) {
          return extractBailianApiKeyText(parsed[key]);
        }
      }
    }
  } catch {
    // Plain text key files are expected.
  }

  const bearer = text.match(/\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/i);
  if (bearer?.[1]) return bearer[1].trim();

  const skKey = text.match(/\bsk-[A-Za-z0-9_-]{16,}\b/);
  if (skKey?.[0]) return skKey[0].trim();

  const assignment = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) =>
      /^(?:export\s+)?(?:COZYPAD_BAILIAN_API_KEY|DASHSCOPE_API_KEY|BAILIAN_API_KEY|ALIBABA_CLOUD_API_KEY)\s*=/.test(
        line,
      ),
    );
  if (assignment) {
    return stripBailianKeyQuotes(assignment.replace(/^(?:export\s+)?[^=]+=/, ""));
  }

  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#") && !line.startsWith("//"));
  return stripBailianKeyQuotes(firstLine || text);
}

function normalizeBailianBaseUrl(value) {
  const baseUrl = String(value || "").trim();
  if (!baseUrl) return "https://dashscope.aliyuncs.com/compatible-mode/v1";
  return baseUrl.replace(/\/+$/, "");
}

function bailianChatCompletionsUrl() {
  return /\/chat\/completions$/i.test(BAILIAN_BASE_URL)
    ? BAILIAN_BASE_URL
    : `${BAILIAN_BASE_URL}/chat/completions`;
}

function configuredBailianApiKey(apiKey = "") {
  return extractBailianApiKeyText(
    apiKey ||
      process.env.COZYPAD_BAILIAN_API_KEY ||
      process.env.BAILIAN_API_KEY ||
      process.env.DASHSCOPE_API_KEY ||
      process.env.ALIBABA_CLOUD_API_KEY ||
      "",
  )
    .slice(0, 24000);
}

function hasBailianApiFallback(apiKey = "") {
  return configuredBailianApiKey(apiKey).length > 0;
}

function normalizeBailianModelOption(value = "") {
  const model = normalizeCodexModelOption(value);
  return model && !BAILIAN_INACCESSIBLE_MODEL_FALLBACKS.has(model.toLowerCase())
    ? model
    : BAILIAN_MODEL;
}

function bailianModelInfo(defaultModel = BAILIAN_MODEL, extraModels = []) {
  const cleanDefault = normalizeBailianModelOption(defaultModel);
  return {
    defaultModel: cleanDefault,
    models: normalizeCodexModelList([cleanDefault, ...extraModels, ...BAILIAN_MODEL_FALLBACKS]),
  };
}

function bailianApiStatus(server, model = BAILIAN_MODEL) {
  const modelInfo = bailianModelInfo(model);
  return {
    server: publicSshServer(server),
    available: true,
    path: bailianChatCompletionsUrl(),
    version: `${modelInfo.defaultModel} via OpenAI-compatible API`,
    models: modelInfo.models,
    defaultModel: modelInfo.defaultModel,
    error: "",
    checkedAt: new Date().toISOString(),
  };
}

function normalizeBailianMessageContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          return part.text || part.content || "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content === undefined || content === null) return "";
  return String(content);
}

function extractBailianApiOutput(payload) {
  const choice = payload?.choices?.[0] || payload?.output?.choices?.[0];
  const messageContent = normalizeBailianMessageContent(choice?.message?.content);
  if (messageContent) return messageContent;
  const text = normalizeBailianMessageContent(choice?.text || payload?.output?.text);
  if (text) return text;
  return JSON.stringify(payload, null, 2);
}

async function requestBailianChatCompletion(apiKey = "", messages = [], options = {}) {
  const key = configuredBailianApiKey(apiKey);
  if (!key) {
    const error = new Error(
      "Bailian API key is not configured. Load a .txt key in the baillian tab or set COZYPAD_BAILIAN_API_KEY / DASHSCOPE_API_KEY in CozyPad4 .env.",
    );
    error.statusCode = 401;
    throw error;
  }

  const controller = new AbortController();
  const timeoutMs = Math.max(10000, Number(options.timeoutMs || BAILIAN_REQUEST_TIMEOUT_MS) || BAILIAN_REQUEST_TIMEOUT_MS);
  const model = normalizeBailianModelOption(options.model);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(bailianChatCompletionsUrl(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
      }),
      signal: controller.signal,
    });

    const raw = await response.text();
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const errorMessage =
        payload?.error?.message ||
        payload?.message ||
        payload?.Message ||
        raw ||
        `HTTP ${response.status}`;
      const error = new Error(`Bailian API request failed (${response.status}): ${errorMessage}`);
      error.statusCode = response.status;
      error.responseText = raw;
      throw error;
    }

    return {
      raw,
      payload,
      text: extractBailianApiOutput(payload || { raw }),
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error(`Bailian API request timed out after ${timeoutMs}ms`);
      timeoutError.statusCode = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function bailianCliMissing(result) {
  const rawText = `${result?.stdout || ""}\n${result?.stderr || ""}`;
  return rawText.includes("__COZYPAD_BAILIAN_MISSING__") || localCliMissing(result, "bailian");
}

async function callBailianApiPrompt(session, server, prompt, apiKey = "", startedAt = Date.now(), model = "") {
  const key = configuredBailianApiKey(apiKey);
  if (!key) {
    return {
      server: publicSshServer(server),
      status: "failed",
      output:
        "Bailian API key is not configured. Set COZYPAD_BAILIAN_API_KEY or DASHSCOPE_API_KEY in CozyPad4 .env, or load a .txt key in the baillian tab.",
      stderr: "",
      code: 401,
      durationMs: Date.now() - startedAt,
    };
  }

  const controller = new AbortController();
  const selectedModel = normalizeBailianModelOption(model);
  const timer = setTimeout(() => controller.abort(), BAILIAN_REQUEST_TIMEOUT_MS);
  try {
    const messages = [];
    const systemPrompt = String(process.env.COZYPAD_BAILIAN_SYSTEM_PROMPT || "").trim();
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
    messages.push({ role: "user", content: prompt });

    const response = await fetch(bailianChatCompletionsUrl(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: selectedModel,
        messages,
        stream: false,
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const errorMessage =
        payload?.error?.message ||
        payload?.message ||
        payload?.Message ||
        text ||
        `Bailian API request failed with HTTP ${response.status}`;
      return {
        server: publicSshServer(server),
        status: "failed",
        output: truncateForApi(`Bailian API request failed: ${errorMessage}`, 128 * 1024),
        stderr: truncateForApi(text || errorMessage),
        code: response.status,
        durationMs: Date.now() - startedAt,
      };
    }

    return {
      server: publicSshServer(server),
      status: "completed",
      output: truncateForApi(extractBailianApiOutput(payload || { raw: text }), 128 * 1024),
      stderr: "",
      code: 0,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const message =
      error?.name === "AbortError"
        ? `Bailian API request timed out after ${BAILIAN_REQUEST_TIMEOUT_MS}ms`
        : error instanceof Error
          ? error.message
          : "Bailian API request failed";
    return {
      server: publicSshServer(server),
      status: "failed",
      output: message,
      stderr: message,
      code: -1,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runLocalBailianPrompt(session, server, prompt, remotePath, apiKey = "", model = "") {
  const startedAt = Date.now();
  const cwd = resolveLocalPath(remotePath || server.defaultPath || "~", os.homedir());
  const exists = await localCliExists("bailian", cwd);
  if (!exists) {
    if (hasBailianApiFallback(apiKey)) {
      return callBailianApiPrompt(session, server, prompt, apiKey, startedAt, model);
    }
    return {
      server: publicSshServer(server),
      status: "failed",
      output: localCliNotFoundMessage("bailian", "bailian"),
      stderr: "",
      code: 127,
      durationMs: Date.now() - startedAt,
    };
  }

  const cleanModel = normalizeBailianModelOption(model);
  const attempts = [
    ["text", "chat", "--model", cleanModel, "--message", prompt, "--output", "text", "--quiet"],
    ["text", "chat", "--model", cleanModel, "--messages-file", "-", "--output", "text", "--quiet"],
  ];
  let result = null;

  for (const args of attempts) {
    result = await runLocalCli("bailian", args, {
      cwd,
      env: agentKeyEnv(apiKey),
      input: args.includes("--messages-file")
        ? `${JSON.stringify([{ role: "user", content: prompt }])}\n`
        : undefined,
      timeoutMs: 300000,
      stdoutLimit: 2 * 1024 * 1024,
      stderrLimit: 256 * 1024,
    });
    if (result.ok || localCliMissing(result, "bailian")) {
      break;
    }
  }

  result ||= { ok: false, code: -1, stdout: "", stderr: "bailian CLI not found on localhost" };

  if (localCliMissing(result, "bailian")) {
    if (hasBailianApiFallback(apiKey)) {
      return callBailianApiPrompt(session, server, prompt, apiKey, startedAt, model);
    }
    return {
      server: publicSshServer(server),
      status: "failed",
      output: localCliNotFoundMessage("bailian", "bailian"),
      stderr: "",
      code: 127,
      durationMs: Date.now() - startedAt,
    };
  }

  return {
    server: publicSshServer(server),
    status: result.ok ? "completed" : "failed",
    output: truncateForApi(result.stdout || result.stderr || "", 128 * 1024),
    stderr: truncateForApi(result.stderr || ""),
    code: result.code,
    durationMs: Date.now() - startedAt,
  };
}

async function runRemoteClaudePrompt(session, body) {
  const server = body.serverId ? await findServer(body.serverId, session) : null;
  if (!server) {
    throw new Error("Server is required");
  }

  const prompt = String(body.prompt || "").trim();
  if (!prompt) {
    throw new Error("Prompt is required");
  }

  const remotePath =
    String(body.remotePath || server.defaultPath || "~")
      .trim()
      .slice(0, 240) || "~";
  const model = normalizeCodexModelOption(body.model);
  if (isSystemLocalServer(server)) {
    return runLocalClaudePrompt(session, server, prompt, remotePath, model);
  }
  if (AGENT_TERMINAL_BRIDGE_ENABLED && findReusableTerminalSession(session, server.id, body.terminalId || "")) {
    return runRemoteAgentPromptViaTerminal(session, "claude", server, prompt, {
      remotePath,
      allowedDirs: body.allowedDirs,
      terminalId: body.terminalId,
      model,
    });
  }
  const blockKey = assertRemoteAgentNotBlocked("Claude", getTerminalOwner(session), server);
  const allowedDirs = normalizeRemoteClaudeAllowedDirs(body.allowedDirs, remotePath);
  const claudeArgs = buildRemoteClaudeArgs(allowedDirs, model);
  const claudeCommand = `claude ${claudeArgs}`;
  const command = [
    "set -u",
    'tmp=$(mktemp "${TMPDIR:-/tmp}/cozypad-claude.XXXXXX") || exit 1',
    'trap \'rm -f "$tmp"\' EXIT',
    'cat > "$tmp"',
    ...remoteClaudeBootstrapLines(),
    `cd ${shellQuote(remotePath)} 2>/dev/null || cd "$HOME" || exit 1`,
    "if ! command -v claude >/dev/null 2>&1; then",
    "  if ! claude --help >/dev/null 2>&1 </dev/null; then",
    "    printf '__COZYPAD_CLAUDE_MISSING__\\n' >&2",
    "    exit 127",
    "  fi",
    "fi",
    `if ${claudeCommand} -p < "$tmp"; then exit 0; fi`,
    "first_status=$?",
    `if ${claudeCommand} --print < "$tmp"; then exit 0; fi`,
    'exit "$first_status"',
  ].join("\n");
  const startedAt = Date.now();
  const result = await runRemoteCommandWithInput(session, server, buildRemoteClaudeShellCommand(command), `${prompt}\n`, 300000, {
    connectTimeout: 8,
    connectionAttempts: 1,
    stdoutLimit: 2 * 1024 * 1024,
    stderrLimit: 256 * 1024,
  });
  const blockedByTransport = blockRemoteAgentOnTransportError("Claude", blockKey, result);

  return {
    server: publicSshServer(server),
    status: result.ok ? "completed" : "failed",
    output: truncateForApi(
      blockedByTransport
        ? remoteAgentCooldownMessage("Claude", getRemoteAgentBlock(blockKey))
        : result.stdout || result.stderr || "",
      128 * 1024,
    ),
    stderr: truncateForApi(
      blockedByTransport
        ? remoteAgentCooldownMessage("Claude", getRemoteAgentBlock(blockKey))
        : result.stderr || "",
    ),
    code: result.code,
    durationMs: Date.now() - startedAt,
  };
}

async function runRemoteAgyPrompt(session, body) {
  const server = body.serverId ? await findServer(body.serverId, session) : null;
  if (!server) {
    throw new Error("Server is required");
  }

  const prompt = String(body.prompt || "").trim();
  if (!prompt) {
    throw new Error("Prompt is required");
  }

  const remotePath =
    String(body.remotePath || server.defaultPath || "~")
      .trim()
      .slice(0, 240) || "~";
  const model = normalizeBailianModelOption(body.model);
  if (isSystemLocalServer(server)) {
    return runLocalAgyPrompt(session, server, prompt, remotePath, model);
  }
  if (AGENT_TERMINAL_BRIDGE_ENABLED && findReusableTerminalSession(session, server.id, body.terminalId || "")) {
    return runRemoteAgentPromptViaTerminal(session, "agy", server, prompt, {
      remotePath,
      terminalId: body.terminalId,
      model,
    });
  }
  const blockKey = assertRemoteAgentNotBlocked("agy", getTerminalOwner(session), server);
  const agyArgs = buildRemoteAgyArgs(model);
  const command = [
    "set -u",
    'tmp=$(mktemp "${TMPDIR:-/tmp}/cozypad-agy.XXXXXX") || exit 1',
    'trap \'rm -f "$tmp"\' EXIT',
    'cat > "$tmp"',
    ...remoteAgyBootstrapLines(),
    `cd ${shellQuote(remotePath)} 2>/dev/null || cd "$HOME" || exit 1`,
    'agy_prompt=$(cat "$tmp")',
    "if ! command -v agy >/dev/null 2>&1; then",
    "  if ! agy --help >/dev/null 2>&1 </dev/null; then",
    "    printf '__COZYPAD_AGY_MISSING__\\n' >&2",
    "    exit 127",
    "  fi",
    "fi",
    `if agy ${agyArgs} -p "$agy_prompt"; then exit 0; fi`,
    "first_status=$?",
    `if agy ${agyArgs} --print "$agy_prompt"; then exit 0; fi`,
    `if agy ${agyArgs} < "$tmp"; then exit 0; fi`,
    'exit "$first_status"',
  ].join("\n");
  const startedAt = Date.now();
  const result = await runRemoteCommandWithInput(session, server, buildRemoteClaudeShellCommand(command), `${prompt}\n`, 300000, {
    connectTimeout: 8,
    connectionAttempts: 1,
    stdoutLimit: 2 * 1024 * 1024,
    stderrLimit: 256 * 1024,
  });
  const blockedByTransport = blockRemoteAgentOnTransportError("agy", blockKey, result);

  return {
    server: publicSshServer(server),
    status: result.ok ? "completed" : "failed",
    output: truncateForApi(
      blockedByTransport
        ? remoteAgentCooldownMessage("agy", getRemoteAgentBlock(blockKey))
        : result.stdout || result.stderr || "",
      128 * 1024,
    ),
    stderr: truncateForApi(
      blockedByTransport
        ? remoteAgentCooldownMessage("agy", getRemoteAgentBlock(blockKey))
        : result.stderr || "",
    ),
    code: result.code,
    durationMs: Date.now() - startedAt,
  };
}

async function runRemoteBailianPrompt(session, body) {
  const server = body.serverId ? await findServer(body.serverId, session) : null;
  if (!server) {
    throw new Error("Server is required");
  }

  const prompt = String(body.prompt || "").trim();
  if (!prompt) {
    throw new Error("Prompt is required");
  }

  const remotePath =
    String(body.remotePath || server.defaultPath || "~")
      .trim()
      .slice(0, 240) || "~";
  const apiKey = extractBailianApiKeyText(body.apiKey || getBailianSessionKey(session)).slice(0, 24000);
  const model = normalizeCodexModelOption(body.model);
  if (isSystemLocalServer(server)) {
    return runLocalBailianPrompt(session, server, prompt, remotePath, apiKey, model);
  }
  if (AGENT_TERMINAL_BRIDGE_ENABLED && findReusableTerminalSession(session, server.id, body.terminalId || "")) {
    return runRemoteAgentPromptViaTerminal(session, "bailian", server, prompt, {
      remotePath,
      apiKey,
      model,
      terminalId: body.terminalId,
    });
  }
  const blockKey = assertRemoteAgentNotBlocked("bailian", getTerminalOwner(session), server);
  const bailianArgs = buildRemoteBailianArgs(model);
  const command = [
    "set -u",
    'tmp=$(mktemp "${TMPDIR:-/tmp}/cozypad-bailian.XXXXXX") || exit 1',
    'trap \'rm -f "$tmp"\' EXIT',
    'IFS= read -r cozypad_key_b64 || true',
    'if [ -n "$cozypad_key_b64" ]; then',
    '  if command -v base64 >/dev/null 2>&1; then',
    '    cozypad_key=$(printf "%s" "$cozypad_key_b64" | base64 -d 2>/dev/null || true)',
    '  elif command -v python3 >/dev/null 2>&1; then',
    '    cozypad_key=$(printf "%s" "$cozypad_key_b64" | python3 -c "import base64,sys; print(base64.b64decode(sys.stdin.read()).decode(), end=\\"\\")" 2>/dev/null || true)',
    '  else',
    '    cozypad_key=""',
    '  fi',
    '  if [ -n "$cozypad_key" ]; then',
    '    export DASHSCOPE_API_KEY="$cozypad_key"',
    '    export BAILIAN_API_KEY="$cozypad_key"',
    '    export ALIBABA_CLOUD_API_KEY="$cozypad_key"',
    '  fi',
    'fi',
    'cat > "$tmp"',
    ...remoteBailianBootstrapLines(),
    `cd ${shellQuote(remotePath)} 2>/dev/null || cd "$HOME" || exit 1`,
    'bailian_prompt=$(cat "$tmp")',
    "if ! command -v bailian >/dev/null 2>&1; then",
    "  printf '__COZYPAD_BAILIAN_MISSING__\\n' >&2",
    "  exit 127",
    "fi",
    `if bailian text chat ${bailianArgs} --message "$bailian_prompt" --output text --quiet; then exit 0; fi`,
    "first_status=$?",
    'exit "$first_status"',
  ].join("\n");
  const startedAt = Date.now();
  const keyLine = apiKey ? Buffer.from(apiKey, "utf8").toString("base64") : "";
  const result = await runRemoteCommandWithInput(
    session,
    server,
    buildRemoteClaudeShellCommand(command),
    `${keyLine}\n${prompt}\n`,
    300000,
    {
      connectTimeout: 8,
      connectionAttempts: 1,
      stdoutLimit: 2 * 1024 * 1024,
      stderrLimit: 256 * 1024,
    },
  );
  const blockedByTransport = blockRemoteAgentOnTransportError("bailian", blockKey, result);

  if (!result.ok && bailianCliMissing(result) && hasBailianApiFallback(apiKey)) {
    return callBailianApiPrompt(session, server, prompt, apiKey, startedAt, model);
  }

  return {
    server: publicSshServer(server),
    status: result.ok ? "completed" : "failed",
    output: truncateForApi(
      blockedByTransport
        ? remoteAgentCooldownMessage("bailian", getRemoteAgentBlock(blockKey))
        : result.stdout || result.stderr || "",
      128 * 1024,
    ),
    stderr: truncateForApi(
      blockedByTransport
        ? remoteAgentCooldownMessage("bailian", getRemoteAgentBlock(blockKey))
        : result.stderr || "",
    ),
    code: result.code,
    durationMs: Date.now() - startedAt,
  };
}

function collectChildProcess(child, options = {}) {
  return new Promise((resolve) => {
    const stdoutLimit = options.stdoutLimit || 2 * 1024 * 1024;
    const stderrLimit = options.stderrLimit || 256 * 1024;
    let stdout = "";
    let stderr = "";
    let assistantOutput = "";
    let openAiAuthError = false;
    let completed = false;
    const parser = options.parseCodexOutput
      ? createCodexOutputParser(
          (text) => {
            stdout += text;
            if (stdout.length > stdoutLimit) stdout = stdout.slice(-stdoutLimit);
          },
          (text) => {
            assistantOutput = `${assistantOutput}${assistantOutput ? "\n" : ""}${text}`.slice(
              -stdoutLimit,
            );
          },
          () => {
            openAiAuthError = true;
          },
        )
      : null;
    const timeout = setTimeout(() => {
      if (!completed) {
        child.kill();
      }
    }, options.timeoutMs || 300000);

    child.stdout?.on("data", (chunk) => {
      if (parser) {
        parser.write(chunk);
      } else {
        stdout += chunk.toString("utf8");
        if (stdout.length > stdoutLimit) stdout = stdout.slice(-stdoutLimit);
      }
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      if (stderr.length > stderrLimit) stderr = stderr.slice(-stderrLimit);
      if (parser && isRemoteCodexOpenAiAuthError(text)) {
        openAiAuthError = true;
      }
    });

    const finish = (result) => {
      parser?.flush();
      if (!parser) {
        resolve(result);
        return;
      }

      const authError = openAiAuthError || isRemoteCodexOpenAiAuthError(stderr);
      const visibleError = visibleRemoteCodexStderr(stderr);
      const parsedStdout = authError
        ? "Codex OpenAI login is invalid. Run `codex login`, then retry."
        : assistantOutput.trim() || stdout.trim();
      resolve({
        ...result,
        stdout: parsedStdout,
        stderr: authError ? parsedStdout : visibleError || result.stderr,
      });
    };

    child.stdin?.on("error", () => {
      // The CLI may fail before consuming stdin.
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      completed = true;
      finish({ ok: false, code: -1, stdout, stderr: error.message || stderr });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      completed = true;
      finish({ ok: code === 0, code, stdout, stderr });
    });
  });
}

function normalizeCodexCliProcessResult(result, stdoutLimit = 2 * 1024 * 1024) {
  let visibleOutput = "";
  let assistantOutput = "";
  let openAiAuthError = false;
  const parser = createCodexOutputParser(
    (text) => {
      visibleOutput = `${visibleOutput}${text}`.slice(-stdoutLimit);
    },
    (text) => {
      assistantOutput = `${assistantOutput}${assistantOutput ? "\n" : ""}${text}`.slice(
        -stdoutLimit,
      );
    },
    () => {
      openAiAuthError = true;
    },
  );

  parser.write(result?.stdout || "");
  parser.flush();

  const authError = openAiAuthError || isRemoteCodexOpenAiAuthError(result?.stderr || "");
  const authMessage = "Codex OpenAI login is invalid. Run `codex login`, then retry.";
  return {
    output: authError
      ? authMessage
      : assistantOutput.trim() || visibleOutput.trim() || result?.stdout || result?.stderr || "",
    stderr: authError ? authMessage : visibleRemoteCodexStderr(result?.stderr || "") || result?.stderr || "",
  };
}

async function runLocalCodexPrompt(session, server, prompt, remotePath, options = {}) {
  const startedAt = Date.now();
  let child;
  try {
    child = await spawnLocalCodex(prompt, session, [], options, remotePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Local Codex run failed";
    return {
      server: publicSshServer(server),
      status: "failed",
      output: truncateForApi(message, 128 * 1024),
      stderr: truncateForApi(message),
      code: -1,
      durationMs: Date.now() - startedAt,
    };
  }

  const result = await collectChildProcess(child, {
    parseCodexOutput: true,
    timeoutMs: 300000,
    stdoutLimit: 2 * 1024 * 1024,
    stderrLimit: 256 * 1024,
  });

  return {
    server: publicSshServer(server),
    status: result.ok ? "completed" : "failed",
    output: truncateForApi(result.stdout || result.stderr || "", 128 * 1024),
    stderr: truncateForApi(result.stderr || ""),
    code: result.code,
    durationMs: Date.now() - startedAt,
  };
}

async function runRemoteCodexPrompt(session, body) {
  const server = body.serverId ? await findServer(body.serverId, session) : null;
  if (!server) {
    throw new Error("Server is required");
  }

  const prompt = String(body.prompt || "").trim();
  if (!prompt) {
    throw new Error("Prompt is required");
  }

  const remotePath =
    String(body.remotePath || server.defaultPath || "~")
      .trim()
      .slice(0, 240) || "~";
  const options = normalizeCodexRunOptions(body);
  const selectedServer = { ...server, defaultPath: remotePath };

  if (isSystemLocalServer(server)) {
    return runLocalCodexPrompt(session, selectedServer, prompt, remotePath, options);
  }
  if (AGENT_TERMINAL_BRIDGE_ENABLED && findReusableTerminalSession(session, selectedServer.id, body.terminalId || "")) {
    return runRemoteAgentPromptViaTerminal(session, "codex", selectedServer, prompt, {
      ...options,
      remotePath,
      terminalId: body.terminalId,
    });
  }

  const blockKey = assertRemoteAgentNotBlocked("Codex", getTerminalOwner(session), server);
  const startedAt = Date.now();
  const result = await runRemoteCommandWithInput(
    session,
    server,
    buildRemoteCodexCommand(selectedServer, options),
    `${prompt}\n`,
    300000,
    {
      connectTimeout: 8,
      connectionAttempts: 1,
      stdoutLimit: 2 * 1024 * 1024,
      stderrLimit: 256 * 1024,
    },
  );
  const blockedByTransport = blockRemoteAgentOnTransportError("Codex", blockKey, result);
  const parsedResult = normalizeCodexCliProcessResult(result);

  return {
    server: publicSshServer(selectedServer),
    status: result.ok ? "completed" : "failed",
    output: truncateForApi(
      blockedByTransport
        ? remoteAgentCooldownMessage("Codex", getRemoteAgentBlock(blockKey))
        : parsedResult.output,
      128 * 1024,
    ),
    stderr: truncateForApi(
      blockedByTransport
        ? remoteAgentCooldownMessage("Codex", getRemoteAgentBlock(blockKey))
        : parsedResult.stderr,
    ),
    code: result.code,
    durationMs: Date.now() - startedAt,
  };
}

function formatCodexHistoryForPrompt(history) {
  const messages = (history?.messages || []).slice(-12);
  if (!messages.length) {
    return "No previous CozyPad Codex conversation for this history.";
  }

  return messages
    .map((message) => {
      const role = message.role === "assistant" ? "Codex" : "User";
      return `${role}: ${String(message.content || "").slice(0, 3000)}`;
    })
    .join("\n\n");
}

function isRtkAvailable() {
  return existsSync(RTK_EXE);
}

let freshWindowsPathCache = {
  value: "",
  expiresAt: 0,
};

function expandWindowsEnvPathValue(value) {
  return String(value || "").replace(/%([^%]+)%/g, (match, name) => process.env[name] || match);
}

function getFreshWindowsPathValue() {
  if (process.platform !== "win32") {
    return "";
  }

  const now = Date.now();
  if (freshWindowsPathCache.expiresAt > now) {
    return freshWindowsPathCache.value;
  }

  try {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Write-Output ([Environment]::GetEnvironmentVariable('Path','User')); Write-Output ([Environment]::GetEnvironmentVariable('Path','Machine'))",
      ],
      {
        cwd: appRoot,
        env: process.env,
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      },
    );
    const value = String(result.stdout || "")
      .split(/\r?\n/)
      .map((line) => expandWindowsEnvPathValue(line.trim()))
      .filter(Boolean)
      .join(path.delimiter);
    freshWindowsPathCache = {
      value,
      expiresAt: now + 30 * 1000,
    };
    return value;
  } catch {
    freshWindowsPathCache = {
      value: "",
      expiresAt: now + 30 * 1000,
    };
    return "";
  }
}

function getPathValue(env = process.env) {
  return [env.PATH || env.Path || env.path || "", getFreshWindowsPathValue()]
    .filter(Boolean)
    .join(path.delimiter);
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

  if (existsSync(LOCAL_CODEX_ENTRY)) {
    pushCodexCandidate(candidates, "project", process.execPath, [LOCAL_CODEX_ENTRY]);
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

async function getCodexCliStatus(session) {
  await ensureUserCodexHome(session);
  let lastError = "";

  for (const candidate of getCodexCandidates()) {
    try {
      const result = await runProcess(candidate.command, [...candidate.args, "--version"], {
        cwd: appRoot,
        env: getCodexEnv(session),
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
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    available: false,
    source: "",
    command: "",
    args: [],
    version: "",
    error: lastError || "Codex CLI was not found",
  };
}

function getCodexEnv(session) {
  const pathEntries = [];
  if (isRtkAvailable()) {
    pathEntries.push(path.dirname(RTK_EXE));
  }

  return {
    ...process.env,
    CODEX_HOME: getUserCodexHome(session),
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    TERM: "dumb",
    PATH: [...pathEntries, getPathValue()].filter(Boolean).join(path.delimiter),
  };
}

async function ensureUserCodexHome(session) {
  const codexHome = getUserCodexHome(session);
  await mkdir(codexHome, { recursive: true });
  return codexHome;
}

async function removeCodexCredentialFiles(session) {
  const codexHome = await ensureUserCodexHome(session);
  const removed = [];
  let entries = [];

  try {
    entries = await readdir(codexHome, { withFileTypes: true });
  } catch {
    return removed;
  }

  for (const entry of entries) {
    const name = entry.name.toLowerCase();
    const isCredentialFile = entry.isFile() && /^(auth|account|credential|credentials|login|token|tokens)(\..*)?$/.test(name);
    const isCredentialDir = entry.isDirectory() && /^(auth|account|credential|credentials|login|token|tokens)$/.test(name);

    if (!isCredentialFile && !isCredentialDir) {
      continue;
    }

    try {
      await rm(path.join(codexHome, entry.name), { recursive: true, force: true });
      removed.push(entry.name);
    } catch {
      // Best effort cleanup; the final login status check decides success.
    }
  }

  return removed;
}

async function createLocalHelperInstallerScript() {
  const helperSource = await readFile(LOCAL_CMD_BRIDGE_ENTRY, "utf8");
  const helperBase64 = Buffer.from(helperSource, "utf8").toString("base64");

  return [
    "$ErrorActionPreference = 'Stop'",
    "$installDir = Join-Path $env:LOCALAPPDATA 'CozyPad\\local-helper'",
    "New-Item -ItemType Directory -Force -Path $installDir | Out-Null",
    "$helperPath = Join-Path $installDir 'local-cmd-bridge.mjs'",
    "$startPath = Join-Path $installDir 'start-cozypad-helper.cmd'",
    "$helperBase64 = @'",
    helperBase64,
    "'@",
    "$helperSource = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($helperBase64))",
    "$utf8NoBom = New-Object Text.UTF8Encoding($false)",
    "[IO.File]::WriteAllText($helperPath, $helperSource, $utf8NoBom)",
    "$cmd = \"@echo off`r`ncd /d `\"$installDir`\"`r`nnode local-cmd-bridge.mjs`r`npause`r`n\"",
    "[IO.File]::WriteAllText($startPath, $cmd, [Text.Encoding]::ASCII)",
    "Write-Host ''",
    "Write-Host 'CozyPad local helper installed:' $installDir",
    "if (-not (Get-Command node -ErrorAction SilentlyContinue)) {",
    "  Write-Host 'Node.js was not found. Install Node.js LTS, then run start-cozypad-helper.cmd again.'",
    "  exit 1",
    "}",
    "Write-Host 'Codex CLI detection is handled by the Node.js CozyPad helper.'",
    "Write-Host 'If Codex is not installed for this Windows account, install with:'",
    "Write-Host 'npm install -g @openai/codex@latest'",
    "Write-Host 'Starting CozyPad local helper on 127.0.0.1:5175...'",
    "Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', \"`\"$startPath`\"\"",
    "Write-Host 'Return to CozyPad and press 重新檢查 CLI.'",
    "",
  ].join("\r\n");
}

async function getCodexAccountStatus(session) {
  await ensureUserCodexHome(session);
  const cli = await getCodexCliStatus(session);
  const publicCli = {
    available: cli.available,
    source: cli.source,
    command: cli.command,
    version: cli.version,
    ...(cli.error ? { error: cli.error } : {}),
  };
  const result = cli.available
    ? await runProcess(cli.command, [...cli.args, "login", "status"], {
        cwd: appRoot,
        env: getCodexEnv(session),
        timeoutMs: 15000,
      })
    : { ok: false, stdout: "", stderr: cli.error || "Codex CLI was not found" };
  const output = `${result.stdout}\n${result.stderr}`.trim();
  const bound = result.ok && !/not logged in/i.test(output);
  let rtkVersion = "";

  if (isRtkAvailable()) {
    const rtk = await runProcess(RTK_EXE, ["--version"], {
      cwd: appRoot,
      env: getCodexEnv(session),
      timeoutMs: 5000,
    });
    rtkVersion = (rtk.stdout || rtk.stderr || "").trim().split(/\r?\n/)[0] || "";
  }

  return {
    bound,
    status: bound ? "bound" : "unbound",
    message: cli.available
      ? bound
        ? "Codex account is bound"
        : "Codex account is not bound"
      : "Codex CLI is not available",
    cli: publicCli,
    rtk: {
      available: isRtkAvailable(),
      version: rtkVersion,
    },
  };
}

async function launchCodexAccountBinding(session) {
  const codexHome = await ensureUserCodexHome(session);
  const userDataDir = getUserDataDir(session);
  const env = getCodexEnv(session);
  const cli = await getCodexCliStatus(session);
  if (!cli.available) {
    throw new Error(cli.error || "Codex CLI was not found");
  }

  const codexLoginCommand = `& ${[cli.command, ...cli.args, "login"].map(powershellSingleQuote).join(" ")}`;
  const codexDeviceLoginCommand = `& ${[cli.command, ...cli.args, "login", "--device-auth"].map(powershellSingleQuote).join(" ")}`;
  const scriptPath = path.join(userDataDir, "codex-login.ps1");
  const script = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$env:CODEX_HOME = ${powershellSingleQuote(env.CODEX_HOME)}
$env:PATH = ${powershellSingleQuote(env.PATH)}
Write-Host "CozyPad Codex self login for ${session.username}" -ForegroundColor Cyan
Write-Host "This login is stored only for this CozyPad user:"
Write-Host ${powershellSingleQuote(codexHome)}
Write-Host ""
Write-Host "Opening the OpenAI browser login flow through Codex CLI..." -ForegroundColor Green
Write-Host "A browser tab should open for OpenAI login." -ForegroundColor Green
${codexLoginCommand}
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "Browser callback login failed. Falling back to device-code login." -ForegroundColor Yellow
  Write-Host "Copy the URL shown below into your browser, sign in, then enter the one-time code." -ForegroundColor Yellow
  ${codexDeviceLoginCommand}
}
Write-Host ""
Write-Host "After login finishes, return to CozyPad and press account refresh."
Read-Host "Press Enter to close"
`.trim();
  await mkdir(userDataDir, { recursive: true });
  await writeFile(scriptPath, `${script}\n`, "utf8");

  console.info(`[codex-login] launch requested user=${session.username}`);
  const loginChild = spawn("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-NoExit",
    "-File",
    scriptPath,
  ], {
    cwd: appRoot,
    env,
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  loginChild.on("error", (error) => {
    console.warn(`[codex-login] powershell launch failed user=${session.username}: ${error.message}`);
  });
  loginChild.unref();
  console.info(`[codex-login] launcher pid=${loginChild.pid} mode=powershell-direct`);
  return { pid: loginChild.pid, mode: "powershell-direct" };
}

async function logoutCodexAccount(session) {
  await ensureUserCodexHome(session);
  const cli = await getCodexCliStatus(session);
  const result = cli.available
    ? await runProcess(cli.command, [...cli.args, "logout"], {
        cwd: appRoot,
        env: getCodexEnv(session),
        timeoutMs: 15000,
      })
    : { ok: false, stdout: "", stderr: cli.error || "Codex CLI was not found" };
  const removedCredentials = await removeCodexCredentialFiles(session);

  return {
    ...result,
    removedCredentials,
  };
}

async function ensureProjectSshConfigFile(session) {
  const configFile = getProjectSshConfigFile(session);

  if (existsSync(configFile)) {
    return;
  }

  await mkdir(path.dirname(configFile), { recursive: true });

  const username = normalizeUsername(session?.username);
  const canImportLegacyConfig = !username || username === normalizeUsername(ADMIN_USERNAME);

  if (!canImportLegacyConfig) {
    await writeFile(
      configFile,
      `# CozyPad project SSH config for ${session.username}\n# Use refresh or the CozyPad SSH form to add Host blocks.\n`,
      "utf8",
    );
    return;
  }

  try {
    const raw = await readFile(LEGACY_SSH_CONFIG_FILE, "utf8");
    await writeFile(
      configFile,
      `# Imported from ${LEGACY_SSH_CONFIG_FILE} at ${new Date().toISOString()}\n${raw.replace(
        /^\uFEFF/,
        "",
      )}`,
      "utf8",
    );
  } catch {
    await writeFile(
      configFile,
      `# CozyPad project SSH config\n# Add Host blocks here or use the CozyPad SSH form.\n`,
      "utf8",
    );
  }
}

function consumeSshConfigRefreshLimit(session) {
  const key = normalizeUsername(session?.username) || "anonymous";
  const now = Date.now();
  const nextAllowedAt = sshConfigRefreshLimits.get(key) || 0;

  if (nextAllowedAt > now) {
    return {
      ok: false,
      retryAfterMs: nextAllowedAt - now,
    };
  }

  sshConfigRefreshLimits.set(key, now + SSH_CONFIG_REFRESH_COOLDOWN_MS);
  return { ok: true, retryAfterMs: SSH_CONFIG_REFRESH_COOLDOWN_MS };
}

async function refreshProjectSshConfigFromLocal(session) {
  const configFile = getProjectSshConfigFile(session);

  if (!isAdminSession(session)) {
    await ensureProjectSshConfigFile(session);
    return {
      refreshed: false,
      changed: false,
      reason: "user-isolated",
      target: configFile,
      importedAt: new Date().toISOString(),
    };
  }

  await mkdir(path.dirname(configFile), { recursive: true });

  const importedAt = new Date().toISOString();
  const raw = (await readFile(LEGACY_SSH_CONFIG_FILE, "utf8")).replace(/^\uFEFF/, "");
  const nextText = `# Synced from ${LEGACY_SSH_CONFIG_FILE} at ${importedAt}\n${raw}`;
  let previousText = "";

  try {
    previousText = await readFile(configFile, "utf8");
  } catch {
    previousText = "";
  }

  const changed = previousText !== nextText;
  if (changed) {
    await writeFile(configFile, nextText, "utf8");
  }

  return {
    refreshed: true,
    changed,
    source: LEGACY_SSH_CONFIG_FILE,
    target: configFile,
    importedAt,
  };
}

function parseSshConfig(raw, configFile = SSH_CONFIG_FILE) {
  const servers = [];
  let currentHosts = [];
  let options = {};

  function flush() {
    for (const alias of currentHosts) {
      if (!alias || /[*?\[\]]/.test(alias)) {
        continue;
      }

      servers.push({
        id: `config:${alias}`,
        source: "ssh-config",
        name: alias,
        alias,
        configFile,
        host: options.hostname || alias,
        user: options.user || "",
        port: Number(options.port || 22),
        identityFile: options.identityfile || "",
        defaultPath: "~",
      });
    }
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = trimmed.match(/^(\S+)\s+(.+)$/);
    if (!match) {
      continue;
    }

    const key = match[1].toLowerCase();
    const value = match[2].trim();

    if (key === "host") {
      flush();
      currentHosts = value.split(/\s+/);
      options = {};
      continue;
    }

    if (currentHosts.length > 0) {
      options[key] = value;
    }
  }

  flush();
  return servers;
}

async function readSshConfigServers(session) {
  try {
    await ensureProjectSshConfigFile(session);
    const configFile = getProjectSshConfigFile(session);
    const raw = await readFile(configFile, "utf8");
    return parseSshConfig(raw, configFile);
  } catch {
    return [];
  }
}

function publicSshServer(server) {
  const {
    configFile,
    identityFile,
    knownHostsFile,
    strictHostKeyChecking,
    password,
    passphrase,
    privateKey,
    ...publicServer
  } = server;
  return {
    ...publicServer,
    hasIdentityFile: Boolean(identityFile),
    identityFileReady: Boolean(isSystemLocalServer(server) || canUseSsh2Broker(server)),
  };
}

function isSystemLocalServer(server) {
  if (!server) return false;
  if (server.localOnly) return true;
  if (server.source === "system" && server.id === "system:localhost") return true;

  const host = String(server.host || "").trim().toLowerCase();
  const labels = [server.id, server.name, server.alias, server.source]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  const labelledLocalTerminal = labels.some(
    (value) => value === "local terminal" || value.includes("local terminal"),
  );
  const noSshPort =
    server.port === undefined ||
    server.port === null ||
    Number(server.port) <= 0 ||
    !Number.isFinite(Number(server.port));

  return isLoopbackHostname(host) && (labelledLocalTerminal || noSshPort);
}

function localCodexSshBinding(server, commandAccess = null) {
  const {
    configFile,
    identityFile,
    knownHostsFile,
    strictHostKeyChecking,
    password,
    passphrase,
    privateKey,
    createdAt,
    updatedAt,
    ...binding
  } = server;
  return {
    ...binding,
    ...(commandAccess
      ? {
          commandToken: commandAccess.token,
          commandExpiresAt: commandAccess.expiresAt,
        }
      : {}),
  };
}

async function listServers(session, options = {}) {
  const [localServers, configServers] = await Promise.all([
    readLocalServers(session),
    readSshConfigServers(session),
  ]);
  const localAliases = new Set(localServers.map((server) => server.alias || server.name));

  const servers = [
    ...localServers.map((server) => ({ ...server, source: "local" })),
    ...configServers.filter((server) => !localAliases.has(server.alias)),
  ];

  return options.includeInternal ? servers : servers.map(publicSshServer);
}

async function findServer(id, session) {
  const decodedId = decodeURIComponent(id);
  const servers = await listServers(session, { includeInternal: true });
  return servers.find((server) => server.id === decodedId);
}

function splitSshHostPatterns(value) {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function removeHostFromSshConfig(raw, alias) {
  const target = String(alias || "").trim();
  const lines = String(raw || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  const output = [];
  let block = [];
  let removed = false;

  function flushBlock() {
    if (!block.length) {
      return;
    }

    const hostMatch = block[0].match(/^(\s*Host\s+)(.+)$/i);
    if (!hostMatch) {
      output.push(...block);
      block = [];
      return;
    }

    const hosts = splitSshHostPatterns(hostMatch[2]);
    if (!hosts.includes(target)) {
      output.push(...block);
      block = [];
      return;
    }

    removed = true;
    const remainingHosts = hosts.filter((host) => host !== target);
    if (remainingHosts.length > 0) {
      output.push(`${hostMatch[1]}${remainingHosts.join(" ")}`, ...block.slice(1));
    }
    block = [];
  }

  for (const line of lines) {
    if (/^\s*Host\s+/i.test(line)) {
      flushBlock();
      block = [line];
    } else if (block.length) {
      block.push(line);
    } else {
      output.push(line);
    }
  }

  flushBlock();

  return {
    removed,
    text: `${output.join("\n").replace(/\n+$/g, "")}\n`,
  };
}

async function deleteSshConfigServer(server, session) {
  await ensureProjectSshConfigFile(session);
  const configFile = server.configFile || getProjectSshConfigFile(session);
  const raw = await readFile(configFile, "utf8");
  const next = removeHostFromSshConfig(raw, server.alias || server.name);

  if (!next.removed) {
    throw new Error("SSH config host was not found in CozyPad project config");
  }

  await writeFile(configFile, next.text, "utf8");
}

function getServerTargetLabel(server) {
  if (isSystemLocalServer(server)) {
    return "localhost";
  }

  if (server.source === "system") {
    return "自己的電腦";
  }

  if (server.source === "ssh-config") {
    return server.alias || server.name;
  }

  return `${server.user ? `${server.user}@` : ""}${server.host}${
    server.port ? `:${server.port}` : ""
  }`;
}

function getSshGateKey(server) {
  if (!server || isSystemLocalServer(server)) {
    return "";
  }

  const identity =
    server.source === "ssh-config"
      ? [
          "ssh-config",
          server.configFile || SSH_CONFIG_FILE,
          server.alias || server.name || "",
          server.port || "",
        ].join("|")
      : [
          "direct",
          server.host || "",
          server.user || "",
          server.port || 22,
          server.identityFile || "",
        ].join("|");
  return crypto.createHash("sha256").update(identity).digest("hex");
}

function getSshGateOverrideFromRequest(request) {
  const raw = firstHeaderValue(request.headers["x-cozypad-ssh-gate-confirm"])
    .trim()
    .toLowerCase();
  return raw === "open-second" || raw === "true" || raw === "1";
}

function requestAllowsSecondSshChannel() {
  return Boolean(sshGateRequestContext.getStore()?.allowSecondSshChannel);
}

function isSshGateLocalTarget(server) {
  return Boolean(server && (isSystemLocalServer(server) || isLoopbackHostname(server.host)));
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function pruneSshGateEntry(key) {
  const entry = sshGateLeases.get(key);
  if (!entry) {
    return null;
  }

  entry.leases = entry.leases.filter((lease) => !lease.released);
  if (entry.leases.length === 0) {
    sshGateLeases.delete(key);
    return null;
  }

  return entry;
}

function firstActiveSshGateLease(key) {
  return pruneSshGateEntry(key)?.leases[0] || null;
}

class SshGateConfirmationRequiredError extends Error {
  constructor(server, activeLease, requestedPurpose, waitedMs) {
    const target = getServerTargetLabel(server);
    const activeSeconds = Math.max(1, Math.ceil((Date.now() - activeLease.startedAt) / 1000));
    super(
      `SSH gate is holding ${target}: ${activeLease.purpose} has used the only channel for ${activeSeconds}s. ` +
        `Opening ${requestedPurpose} needs a second SSH channel.`,
    );
    this.name = "SshGateConfirmationRequiredError";
    this.statusCode = 409;
    this.code = SSH_GATE_CONFIRM_CODE;
    this.confirmation = {
      code: SSH_GATE_CONFIRM_CODE,
      serverName: server.name || target,
      target,
      requestedPurpose,
      activePurpose: activeLease.purpose,
      activeForMs: Date.now() - activeLease.startedAt,
      waitedMs,
      message:
        `CozyPad is already using one SSH channel for ${server.name || target} (${activeLease.purpose}). ` +
        `Open a second SSH channel for ${requestedPurpose}?`,
    };
  }
}

function isSshGateConfirmationError(error) {
  return Boolean(error && error.code === SSH_GATE_CONFIRM_CODE);
}

function sshGateErrorPayload(error) {
  return {
    ok: false,
    code: SSH_GATE_CONFIRM_CODE,
    error: error instanceof Error ? error.message : "SSH gate confirmation is required",
    confirmation: error?.confirmation || null,
  };
}

function releaseSshGateLease(lease) {
  if (!lease || lease.released) {
    return;
  }

  lease.released = true;
  pruneSshGateEntry(lease.key);
}

function createNoopSshGateLease() {
  return {
    released: false,
    release() {
      this.released = true;
    },
  };
}

async function acquireSshGateLease(server, purpose = "SSH operation", options = {}) {
  if (!SSH_GATE_ENABLED || !server || isSshGateLocalTarget(server) || options.skipGate) {
    return createNoopSshGateLease();
  }

  const key = getSshGateKey(server);
  if (!key) {
    return createNoopSshGateLease();
  }

  const allowSecondChannel = Boolean(
    options.allowSecondChannel || requestAllowsSecondSshChannel(),
  );
  const confirmAfterMs = Math.max(
    0,
    Number(options.confirmAfterMs ?? SSH_GATE_CONFIRM_AFTER_MS) || SSH_GATE_CONFIRM_AFTER_MS,
  );
  const waitStartedAt = Date.now();

  while (true) {
    const activeEntry = pruneSshGateEntry(key);
    const activeLeases = activeEntry?.leases || [];
    const activeLease = activeLeases[0] || null;
    if (!activeLease || (allowSecondChannel && activeLeases.length < 2)) {
      const lease = {
        id: `ssh_gate_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`,
        key,
        serverName: server.name || getServerTargetLabel(server),
        target: getServerTargetLabel(server),
        purpose,
        startedAt: Date.now(),
        allowSecondChannel,
        released: false,
      };
      lease.release = () => releaseSshGateLease(lease);

      const entry = pruneSshGateEntry(key) || {
        key,
        serverName: lease.serverName,
        target: lease.target,
        leases: [],
      };
      entry.leases.push(lease);
      sshGateLeases.set(key, entry);
      return lease;
    }

    const waitedMs = Date.now() - waitStartedAt;
    if (waitedMs >= confirmAfterMs) {
      console.warn(
        `[ssh-gate] blocked purpose=${purpose} server=${server.name || getServerTargetLabel(server)} ` +
          `active=${activeLeases.length} activePurpose=${activeLease.purpose} waitedMs=${waitedMs}`,
      );
      throw new SshGateConfirmationRequiredError(server, activeLease, purpose, waitedMs);
    }

    await sleepMs(Math.min(250, confirmAfterMs - waitedMs));
  }
}

async function spawnGatedSsh(server, args, spawnOptions, purpose, gateOptions = {}) {
  throw new Error(ssh2RequiredMessage(server, purpose || "SSH operation"));
}

async function assertDetachedSshLaunchAllowed(server, purpose) {
  const lease = await acquireSshGateLease(server, purpose, {
    confirmAfterMs: 0,
  });
  lease.release();
}

function sanitizeText(value) {
  return String(value || "").trim();
}

function toSafeServerSlug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);
}

function getSshControlPath(server) {
  const slug =
    toSafeServerSlug(server.alias || server.name || server.host || server.id || "server") ||
    "server";
  const identity = [
    server.id,
    server.source,
    server.configFile || "",
    server.alias || "",
    server.name || "",
    server.host || "",
    server.user || "",
    server.port || "",
  ].join("|");
  const hash = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 20);
  return path.join(SSH_CONTROL_DIR, `${slug.slice(0, 18)}-${hash}.sock`).replace(/\\/g, "/");
}

function appendSshControlMasterArgs(args, server, options = {}) {
  if (!SSH_CONTROL_MASTER_ENABLED || options.controlMaster === false) {
    return;
  }

  try {
    mkdirSync(SSH_CONTROL_DIR, { recursive: true });
  } catch {
    return;
  }

  args.push(
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPersist=${Math.max(60, SSH_CONTROL_PERSIST_SECONDS)}`,
    "-o",
    `ControlPath=${getSshControlPath(server)}`,
  );
}

function createServerProfile(input) {
  const name = sanitizeText(input.name);
  const host = sanitizeText(input.host);
  const user = sanitizeText(input.user);
  const identityFile = "";
  const defaultPath = sanitizeText(input.defaultPath) || "~";
  const port = Number(input.port || 22);

  if (!name) {
    throw new Error("Name is required");
  }

  if (!host) {
    throw new Error("Host is required");
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Port must be between 1 and 65535");
  }

  const slug = toSafeServerSlug(name);
  const now = new Date().toISOString();

  return {
    id: `local:${slug || "server"}-${Date.now().toString(36)}`,
    source: "local",
    name,
    alias: name,
    host,
    user,
    port,
    identityFile,
    defaultPath,
    createdAt: now,
    updatedAt: now,
  };
}

function buildSshArgs(server, options = {}) {
  const batch = options.batch !== false;
  const args = [];
  const connectTimeout = options.connectTimeout || 10;
  const connectionAttempts = options.connectionAttempts || 1;

  if (batch) {
    args.push("-o", "BatchMode=yes");
  }

  args.push(
    "-o",
    `ConnectTimeout=${connectTimeout}`,
    "-o",
    `ConnectionAttempts=${connectionAttempts}`,
    "-o",
    "TCPKeepAlive=yes",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=6",
  );

  appendSshControlMasterArgs(args, server, options);

  if (server.knownHostsFile) {
    args.push("-o", `UserKnownHostsFile=${server.knownHostsFile}`);
    args.push("-o", `StrictHostKeyChecking=${server.strictHostKeyChecking || "accept-new"}`);
  }

  if (server.source === "ssh-config") {
    args.push("-F", server.configFile || SSH_CONFIG_FILE);
    args.push(server.alias || server.name);
    return args;
  }

  if (server.identityFile) {
    args.push("-o", "IdentitiesOnly=yes");
    args.push("-i", server.identityFile);
  }

  if (server.port) {
    args.push("-p", String(server.port));
  }

  const target = server.user ? `${server.user}@${server.host}` : server.host;
  args.push(target);
  return args;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const hasInput = options.input !== undefined;
    const stdoutLimit = options.stdoutLimit || 512 * 1024;
    const stderrLimit = options.stderrLimit || 128 * 1024;
    const child = spawn(command, args, {
      cwd: options.cwd || appRoot,
      env: options.env || process.env,
      windowsHide: true,
      stdio: [hasInput ? "pipe" : "ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let completed = false;
    const timeout = setTimeout(() => {
      if (!completed) {
        child.kill();
      }
    }, options.timeoutMs || 15000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > stdoutLimit) {
        stdout = stdout.slice(-stdoutLimit);
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > stderrLimit) {
        stderr = stderr.slice(-stderrLimit);
      }
    });

    if (hasInput) {
      child.stdin.on("error", () => {
        // The child may fail before consuming stdin.
      });
      child.stdin.end(String(options.input || ""), "utf8");
    }

    child.on("error", (error) => {
      clearTimeout(timeout);
      completed = true;
      resolve({ ok: false, code: -1, stdout, stderr: error.message });
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      completed = true;
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

function condaEnvNameFromPath(envPath) {
  const normalized = String(envPath || "").replace(/\\/g, "/").replace(/\/+$/g, "");
  const name = normalized.split("/").filter(Boolean).pop() || normalized;
  return /^(?:miniconda3|anaconda3|mambaforge|micromamba)$/i.test(name) ? "base" : name;
}

function uniqueCondaEnvs(envs) {
  const seen = new Set();
  return envs
    .map((env) => ({
      name: String(env.name || condaEnvNameFromPath(env.path)).trim(),
      path: String(env.path || "").trim(),
      active: Boolean(env.active),
    }))
    .filter((env) => env.name && env.path)
    .filter((env) => {
      const key = `${env.name}\n${env.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function parseCondaEnvOutput(stdout) {
  const raw = String(stdout || "").trim();
  if (!raw) return [];

  try {
    const data = JSON.parse(raw);
    if (Array.isArray(data?.envs)) {
      return uniqueCondaEnvs(
        data.envs.map((envPath) => ({
          name: condaEnvNameFromPath(envPath),
          path: String(envPath || ""),
          active: false,
        })),
      );
    }
  } catch {
    // Fall through to plain-text conda output parsing.
  }

  return uniqueCondaEnvs(
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const active = /\*/.test(line);
        const cleaned = line.replace(/\*/g, " ").trim();
        const parts = cleaned.split(/\s+/).filter(Boolean);
        if (parts.length === 1) {
          return { name: condaEnvNameFromPath(parts[0]), path: parts[0], active };
        }
        return { name: parts[0], path: parts[parts.length - 1], active };
      }),
  );
}

async function listLocalCondaEnvs() {
  const jsonScript =
    "$ErrorActionPreference='SilentlyContinue'; conda env list --json 2>$null";
  const jsonResult = await runProcess("powershell.exe", ["-NoProfile", "-Command", jsonScript], {
    timeoutMs: 15000,
    stdoutLimit: 128 * 1024,
    stderrLimit: 64 * 1024,
  });
  const jsonEnvs = parseCondaEnvOutput(jsonResult.stdout);
  if (jsonEnvs.length) return jsonEnvs;

  const textScript = "$ErrorActionPreference='SilentlyContinue'; conda info --envs 2>$null";
  const textResult = await runProcess("powershell.exe", ["-NoProfile", "-Command", textScript], {
    timeoutMs: 15000,
    stdoutLimit: 128 * 1024,
    stderrLimit: 64 * 1024,
  });
  return parseCondaEnvOutput(textResult.stdout);
}

async function listServerCondaEnvs(session, server) {
  if (isSystemLocalServer(server)) {
    return listLocalCondaEnvs();
  }

  const command = [
    "if command -v conda >/dev/null 2>&1; then",
    "conda env list --json 2>/dev/null || conda info --envs 2>/dev/null || true;",
    "elif [ -n \"$CONDA_EXE\" ] && [ -x \"$CONDA_EXE\" ]; then",
    "\"$CONDA_EXE\" env list --json 2>/dev/null || \"$CONDA_EXE\" info --envs 2>/dev/null || true;",
    "else",
    "printf '';",
    "fi",
  ].join(" ");
  const result = await runRemoteCommand(session, server, command, 15000, {
    purpose: "conda env scan",
    stdoutLimit: 128 * 1024,
    stderrLimit: 64 * 1024,
  });
  if (!result.ok && !result.stdout) {
    throw new Error(result.stderr || "Conda env scan failed");
  }
  return parseCondaEnvOutput(result.stdout);
}

function sanitizePublicWorkflowText(value) {
  return String(value || "")
    .replace(/[A-Za-z]:\\(?:[^"'\r\n\s]+\\)*[^"'\r\n\s]*/g, "[local path]")
    .replace(/--credentials-file\s+"?[^"\r\n]+("?)/gi, "--credentials-file [hidden]")
    .replace(/cloudflared-token-credentials\.json/gi, "[cloudflared credential]");
}

async function fetchStatus(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: controller.signal,
    });
    return {
      ok: response.status < 500,
      status: response.status,
      statusText: response.statusText,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      statusText: error instanceof Error ? error.message : "Request failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function getPublicTunnelProcessStatus() {
  const command = [
    "$p=@(Get-CimInstance Win32_Process -Filter \"Name = 'cloudflared.exe'\" -ErrorAction SilentlyContinue |",
    `Where-Object { $_.CommandLine -like "*${PUBLIC_TUNNEL_ID}*" });`,
    "[pscustomobject]@{running=($p.Count -gt 0);count=$p.Count;pids=@($p|ForEach-Object{$_.ProcessId})}|ConvertTo-Json -Compress",
  ].join(" ");
  const result = await runProcess("powershell.exe", ["-NoProfile", "-Command", command], {
    timeoutMs: 8000,
    stdoutLimit: 16 * 1024,
    stderrLimit: 16 * 1024,
  });

  if (!result.ok) {
    return {
      running: false,
      count: 0,
      pids: [],
      error: sanitizePublicWorkflowText(result.stderr || result.stdout),
    };
  }

  try {
    const parsed = JSON.parse(result.stdout || "{}");
    return {
      running: Boolean(parsed.running),
      count: Number(parsed.count || 0),
      pids: Array.isArray(parsed.pids) ? parsed.pids.map(Number).filter(Number.isFinite) : [],
      error: "",
    };
  } catch {
    return {
      running: false,
      count: 0,
      pids: [],
      error: "Unable to parse cloudflared status",
    };
  }
}

async function getPublicWorkflowStatus() {
  const [origin, publicSite, tunnel] = await Promise.all([
    fetchStatus(PUBLIC_ORIGIN_URL),
    fetchStatus(PUBLIC_URL),
    getPublicTunnelProcessStatus(),
  ]);

  return {
    ok: true,
    publicUrl: PUBLIC_URL,
    originUrl: PUBLIC_ORIGIN_URL,
    tunnelId: PUBLIC_TUNNEL_ID,
    protocol: "http2",
    api: {
      online: true,
      port: PORT,
    },
    origin: {
      online: origin.ok,
      status: origin.status,
      statusText: origin.statusText,
    },
    tunnel: {
      running: tunnel.running,
      count: tunnel.count,
      pids: tunnel.pids,
      error: tunnel.error,
    },
    publicSite: {
      reachable: publicSite.ok,
      status: publicSite.status,
      statusText: publicSite.statusText,
      securityBlocked: publicSite.status === 401 || publicSite.status === 403,
    },
    checkedAt: new Date().toISOString(),
  };
}

async function startPublicWorkflow(restartTunnel = false) {
  if (!existsSync(PUBLIC_WORKFLOW_SCRIPT)) {
    return {
      ok: false,
      error: "Public workflow script is missing",
      status: await getPublicWorkflowStatus(),
    };
  }

  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    PUBLIC_WORKFLOW_SCRIPT,
  ];
  if (restartTunnel) {
    args.push("-RestartTunnel");
  }

  const result = await runProcess("powershell.exe", args, {
    cwd: ROOT,
    timeoutMs: 60 * 1000,
    stdoutLimit: 96 * 1024,
    stderrLimit: 96 * 1024,
  });
  let script = null;
  try {
    script = JSON.parse(result.stdout || "{}");
  } catch {
    script = null;
  }

  const status = await getPublicWorkflowStatus();
  return {
    ok: result.ok && status.origin.online && status.tunnel.running,
    code: result.code,
    script: script
      ? {
          publicUrl: script.PublicUrl || PUBLIC_URL,
          originUrl: script.OriginUrl || PUBLIC_ORIGIN_URL,
          apiPort: script.ApiPort || PORT,
          apiPids: Array.isArray(script.ApiPids) ? script.ApiPids : [],
          webPids: Array.isArray(script.WebPids) ? script.WebPids : [],
          tunnelRunning: Boolean(script.TunnelRunning),
          tunnelPids: Array.isArray(script.TunnelPids) ? script.TunnelPids : [],
          protocol: script.Protocol || "http2",
        }
      : null,
    stdout: script ? "" : sanitizePublicWorkflowText(result.stdout),
    stderr: sanitizePublicWorkflowText(result.stderr),
    status,
  };
}

function createLocalTestResult(server) {
  return {
    ok: true,
    code: 0,
    stdout: `COZYPAD_SSH_OK\n${os.hostname()}\n${server.defaultPath || os.homedir()}\n`,
    stderr: "",
  };
}

function opensshFallbackAllowed(server, options = {}) {
  return options.opensshFallback !== false && !isSystemLocalServer(server);
}

async function runSshCommand(server, remoteCommand, timeoutMs, sshOptions = {}) {
  const startedAt = Date.now();
  const args = [
    ...buildSshArgs(server, {
      ...sshOptions,
      controlMaster: sshOptions.controlMaster ?? false,
    }),
    remoteCommand,
  ];
  const result = await runProcess("ssh.exe", args, {
    timeoutMs,
    stdoutLimit: sshOptions.stdoutLimit,
    stderrLimit: sshOptions.stderrLimit,
  });
  return {
    ...result,
    durationMs: Date.now() - startedAt,
    transport: "openssh",
  };
}

async function runSshCommandWithInput(server, remoteCommand, input, timeoutMs, sshOptions = {}) {
  const startedAt = Date.now();
  const args = [
    ...buildSshArgs(server, {
      ...sshOptions,
      controlMaster: sshOptions.controlMaster ?? false,
    }),
    remoteCommand,
  ];
  const result = await runProcess("ssh.exe", args, {
    input,
    timeoutMs,
    stdoutLimit: sshOptions.stdoutLimit,
    stderrLimit: sshOptions.stderrLimit,
  });
  return {
    ...result,
    durationMs: Date.now() - startedAt,
    transport: "openssh",
  };
}

function expandLocalSshPath(value) {
  let text = String(value || "").trim();
  if (!text) {
    return "";
  }
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }
  if (text === "~") {
    return os.homedir();
  }
  if (text.startsWith("~/") || text.startsWith("~\\")) {
    return path.join(os.homedir(), text.slice(2));
  }
  return text;
}

function canUseSsh2Broker(server) {
  if (!SSH2_BROKER_ENABLED || !server || isSystemLocalServer(server)) {
    return false;
  }
  if (!server.host || !server.user) {
    return false;
  }

  const identityFile = expandLocalSshPath(server.identityFile);
  return Boolean(identityFile && existsSync(identityFile));
}

function ssh2RequiredMessage(server, purpose = "SSH operation") {
  const target = server ? server.name || getServerTargetLabel(server) : "selected SSH server";
  if (!SSH2_BROKER_ENABLED) {
    return `${purpose} requires ssh2 broker, but COZYPAD_SSH2_BROKER is disabled. Re-enable ssh2 broker; CozyPad will not use ssh.exe fallback.`;
  }
  if (!server?.host || !server?.user) {
    return `${purpose} requires ssh2 with direct HostName and User for ${target}. Update the SSH config; CozyPad will not use ssh.exe fallback.`;
  }
  const identityFile = expandLocalSshPath(server.identityFile);
  if (!identityFile) {
    return `${purpose} requires ssh2 with IdentityFile for ${target}. Add IdentityFile to the SSH config; CozyPad will not use ssh.exe fallback.`;
  }
  if (!existsSync(identityFile)) {
    return `${purpose} requires ssh2, but IdentityFile is not readable for ${target}: ${identityFile}. Fix the key path; CozyPad will not use ssh.exe fallback.`;
  }
  return `${purpose} requires ssh2 for ${target}; CozyPad will not use ssh.exe fallback.`;
}

function getSsh2BrokerKey(session, server) {
  const owner = getTerminalOwner(session);
  const identity = [
    owner,
    String(server.host || "").trim().toLowerCase(),
    String(server.user || "").trim().toLowerCase(),
    Number(server.port || 22) || 22,
    expandLocalSshPath(server.identityFile).toLowerCase(),
  ].join("|");
  return crypto.createHash("sha256").update(identity).digest("base64url");
}

function buildSsh2ConnectConfig(server) {
  const identityFile = expandLocalSshPath(server.identityFile);
  return {
    host: server.host,
    port: Number(server.port || 22) || 22,
    username: server.user,
    privateKey: readFileSync(identityFile),
    readyTimeout: 15000,
    keepaliveInterval: 30000,
    keepaliveCountMax: 6,
    tryKeyboard: false,
  };
}

function disposeSsh2Broker(broker, reason = "closed") {
  if (!broker || broker.closed) {
    return;
  }
  broker.closed = true;
  broker.status = reason;
  if (broker.idleTimer) {
    clearTimeout(broker.idleTimer);
    broker.idleTimer = null;
  }
  while (broker.waiters.length) {
    const waiter = broker.waiters.shift();
    waiter.reject(new Error(`SSH2 broker ${reason}`));
  }
  try {
    broker.connection?.end?.();
  } catch {
    // Connection may already be closed by ssh2.
  }
  try {
    broker.lease?.release?.();
  } catch {
    // Gate lease may already be released.
  }
  ssh2Brokers.delete(broker.key);
}

function scheduleSsh2BrokerIdleClose(broker) {
  if (!broker || broker.closed || broker.activeChannels > 0 || broker.waiters.length > 0) {
    return;
  }
  if (broker.idleTimer) {
    clearTimeout(broker.idleTimer);
  }
  broker.idleTimer = setTimeout(() => {
    if (broker.activeChannels === 0 && broker.waiters.length === 0) {
      disposeSsh2Broker(broker, "idle timeout");
    }
  }, Math.max(1000, SSH2_BROKER_IDLE_MS));
  broker.idleTimer.unref?.();
}

function resolveNextSsh2BrokerWaiter(broker) {
  if (!broker || broker.closed) {
    return;
  }
  while (broker.waiters.length > 0 && broker.activeChannels < SSH2_BROKER_MAX_CHANNELS) {
    const waiter = broker.waiters.shift();
    broker.activeChannels += 1;
    waiter.resolve(createSsh2BrokerChannelRelease(broker));
  }
  scheduleSsh2BrokerIdleClose(broker);
}

function createSsh2BrokerChannelRelease(broker) {
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    broker.activeChannels = Math.max(0, broker.activeChannels - 1);
    broker.lastUsedAt = Date.now();
    resolveNextSsh2BrokerWaiter(broker);
  };
}

function acquireSsh2BrokerChannel(broker) {
  if (broker.closed || broker.status !== "ready") {
    return Promise.reject(new Error(`SSH2 broker is not ready (${broker.status || "closed"})`));
  }
  if (broker.idleTimer) {
    clearTimeout(broker.idleTimer);
    broker.idleTimer = null;
  }
  if (broker.activeChannels < SSH2_BROKER_MAX_CHANNELS) {
    broker.activeChannels += 1;
    return Promise.resolve(createSsh2BrokerChannelRelease(broker));
  }
  return new Promise((resolve, reject) => {
    broker.waiters.push({ resolve, reject });
  });
}

async function getSsh2Broker(session, server, gateOptions = {}) {
  if (!canUseSsh2Broker(server)) {
    throw new Error(ssh2RequiredMessage(server, "SSH2 broker"));
  }

  const key = getSsh2BrokerKey(session, server);
  const existing = ssh2Brokers.get(key);
  if (existing && !existing.closed) {
    if (existing.status === "ready") {
      if (existing.idleTimer) {
        clearTimeout(existing.idleTimer);
        existing.idleTimer = null;
      }
      return existing;
    }
    if (existing.readyPromise) {
      return existing.readyPromise;
    }
  }

  const broker = {
    key,
    owner: getTerminalOwner(session),
    server,
    connection: new SshClient(),
    lease: null,
    status: "connecting",
    readyPromise: null,
    activeChannels: 0,
    waiters: [],
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    idleTimer: null,
    closed: false,
  };
  ssh2Brokers.set(key, broker);

  broker.readyPromise = (async () => {
    broker.lease = await acquireSshGateLease(server, "SSH2 broker", gateOptions);
    await new Promise((resolve, reject) => {
      let settled = false;
      const connection = broker.connection;
      const finish = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      connection.once("ready", () => finish());
      connection.once("error", (error) => finish(error));
      connection.once("timeout", () => finish(new Error("SSH2 broker connection timed out")));
      connection.once("close", () => {
        if (!settled) {
          finish(new Error("SSH2 broker connection closed before ready"));
        } else {
          disposeSsh2Broker(broker, "closed");
        }
      });
      connection.connect(buildSsh2ConnectConfig(server));
    });
    broker.status = "ready";
    broker.lastUsedAt = Date.now();
    scheduleSsh2BrokerIdleClose(broker);
    return broker;
  })().catch((error) => {
    disposeSsh2Broker(broker, "connect failed");
    throw error;
  });

  return broker.readyPromise;
}

async function openSsh2BrokerExecStream(session, server, remoteCommand, options = {}) {
  const broker = await getSsh2Broker(session, server, options);
  const release = await acquireSsh2BrokerChannel(broker);
  let released = false;
  const releaseOnce = () => {
    if (released) {
      return;
    }
    released = true;
    release();
  };

  return await new Promise((resolve, reject) => {
    broker.connection.exec(remoteCommand, options.exec || {}, (error, stream) => {
      if (error) {
        releaseOnce();
        reject(error);
        return;
      }
      stream.once("close", releaseOnce);
      stream.once("error", releaseOnce);
      resolve({
        stream,
        broker,
        close() {
          try {
            stream.close?.();
            stream.end?.();
          } catch {
            // Stream may already be closed.
          }
          releaseOnce();
        },
      });
    });
  });
}

async function runSsh2BrokerCommand(session, server, remoteCommand, input, timeoutMs, options = {}) {
  const startedAt = Date.now();
  try {
    const channel = await openSsh2BrokerExecStream(session, server, remoteCommand, options);
    const stream = channel.stream;
    const stdoutLimit = options.stdoutLimit || 512 * 1024;
    const stderrLimit = options.stderrLimit || 128 * 1024;
    return await new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        channel.close();
        resolve({
          ok: false,
          code: 124,
          stdout,
          stderr: `${stderr}${stderr ? "\n" : ""}SSH2 broker command timed out after ${Math.round(timeoutMs / 1000)}s`,
          durationMs: Date.now() - startedAt,
          transport: "ssh2",
        });
      }, Math.max(1000, Number(timeoutMs) || 30000));
      timeout.unref?.();

      stream.on("data", (chunk) => {
        stdout = `${stdout}${chunk.toString("utf8")}`.slice(-stdoutLimit);
      });
      stream.stderr.on("data", (chunk) => {
        stderr = `${stderr}${chunk.toString("utf8")}`.slice(-stderrLimit);
      });
      stream.on("close", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve({
          ok: Number(code || 0) === 0,
          code: Number(code || 0),
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
          transport: "ssh2",
        });
      });
      stream.on("error", (error) => {
        stderr = `${stderr}${stderr ? "\n" : ""}${error.message}`.slice(-stderrLimit);
      });
      if (input !== undefined && input !== null) {
        stream.write(String(input), "utf8");
      }
      stream.end();
    });
  } catch (error) {
    return {
      ok: false,
      code: -1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error || "SSH2 broker failed"),
      durationMs: Date.now() - startedAt,
      transport: "ssh2",
    };
  }
}

function runRemoteCommand(session, server, remoteCommand, timeoutMs, sshOptions = {}) {
  if (canUseSsh2Broker(server) && sshOptions.ssh2 !== false) {
    return runSsh2BrokerCommand(session, server, remoteCommand, undefined, timeoutMs, sshOptions).then(
      async (result) => {
        if (
          opensshFallbackAllowed(server, sshOptions) &&
          !result.ok &&
          (result.code === 124 || result.code === -1) &&
          !String(result.stdout || "").trim()
        ) {
          return runSshCommand(server, remoteCommand, timeoutMs, sshOptions);
        }
        return result;
      },
    );
  }
  if (opensshFallbackAllowed(server, sshOptions)) {
    return runSshCommand(server, remoteCommand, timeoutMs, sshOptions);
  }
  return Promise.reject(new Error(ssh2RequiredMessage(server, sshOptions.purpose || "SSH command")));
}

function runRemoteCommandWithInput(session, server, remoteCommand, input, timeoutMs, sshOptions = {}) {
  if (canUseSsh2Broker(server) && sshOptions.ssh2 !== false) {
    return runSsh2BrokerCommand(session, server, remoteCommand, input, timeoutMs, sshOptions).then(
      async (result) => {
        if (
          opensshFallbackAllowed(server, sshOptions) &&
          !result.ok &&
          (result.code === 124 || result.code === -1) &&
          !String(result.stdout || "").trim()
        ) {
          return runSshCommandWithInput(server, remoteCommand, input, timeoutMs, sshOptions);
        }
        return result;
      },
    );
  }
  if (opensshFallbackAllowed(server, sshOptions)) {
    return runSshCommandWithInput(server, remoteCommand, input, timeoutMs, sshOptions);
  }
  return Promise.reject(new Error(ssh2RequiredMessage(server, sshOptions.purpose || "SSH command")));
}

async function ensureDirectSshKey(session, server) {
  const keyPath = path.join(
    getUserDataDir(session),
    "keys",
    `${toSafeServerSlug(server.name) || "server"}.ed25519`,
  );

  await mkdir(path.dirname(keyPath), { recursive: true });

  if (!existsSync(keyPath)) {
    const result = await runProcess(
      "ssh-keygen.exe",
      ["-t", "ed25519", "-N", "", "-f", keyPath, "-C", `cozypad-${normalizeUsername(session?.username)}-${server.name}`],
      { timeoutMs: 20000 },
    );

    if (!result.ok) {
      throw new Error(result.stderr || "SSH key generation failed");
    }
  }

  let publicKey = "";
  try {
    publicKey = (await readFile(`${keyPath}.pub`, "utf8")).trim();
  } catch {
    const result = await runProcess("ssh-keygen.exe", ["-y", "-f", keyPath], { timeoutMs: 10000 });
    if (!result.ok || !result.stdout.trim()) {
      throw new Error(result.stderr || "SSH public key extraction failed");
    }

    publicKey = result.stdout.trim();
    await writeFile(`${keyPath}.pub`, `${publicKey}\n`, "utf8");
  }

  if (!publicKey) {
    throw new Error("SSH public key is empty");
  }

  return { identityFile: keyPath, publicKey };
}

function execSsh2Command(connection, command) {
  return new Promise((resolve, reject) => {
    connection.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      let stdout = "";
      let stderr = "";

      stream.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      stream.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      stream.on("close", (code) => {
        resolve({ ok: code === 0, code, stdout, stderr });
      });
    });
  });
}

function connectSshWithPassword(server, password) {
  return new Promise((resolve, reject) => {
    const connection = new SshClient();
    let settled = false;

    function finish(error) {
      if (settled) {
        return;
      }

      settled = true;
      if (error) {
        connection.end();
        reject(error);
        return;
      }

      resolve(connection);
    }

    connection.once("ready", () => finish());
    connection.once("error", (error) => finish(error));
    connection.once("timeout", () => finish(new Error("SSH password connection timed out")));
    connection.connect({
      host: server.host,
      port: server.port || 22,
      username: server.user,
      password: String(password || ""),
      readyTimeout: 15000,
    });
  });
}

async function installPublicKeyWithPassword(server, password, publicKey) {
  const connection = await connectSshWithPassword(server, password);

  try {
    const command = [
      "umask 077",
      "mkdir -p ~/.ssh",
      "touch ~/.ssh/authorized_keys",
      `(grep -qxF ${shellQuote(publicKey)} ~/.ssh/authorized_keys || printf '%s\\n' ${shellQuote(publicKey)} >> ~/.ssh/authorized_keys)`,
      "chmod 700 ~/.ssh",
      "chmod 600 ~/.ssh/authorized_keys",
      "printf 'COZYPAD_KEY_READY\\n'",
    ].join(" && ");
    const result = await execSsh2Command(connection, command);

    if (!result.ok || !result.stdout.includes("COZYPAD_KEY_READY")) {
      throw new Error(result.stderr || "SSH key install failed");
    }
  } finally {
    connection.end();
  }
}

async function createDirectServerProfile(session, input) {
  const password = String(input.password || "");
  const server = createServerProfile(input);
  const knownHostsFile = getUserKnownHostsFile(session);

  if (!server.user) {
    throw new Error("User is required");
  }

  if (!password) {
    throw new Error("SSH password is required");
  }

  const key = await ensureDirectSshKey(session, server);
  const directServer = {
    ...server,
    identityFile: key.identityFile,
    knownHostsFile,
    strictHostKeyChecking: "accept-new",
  };

  await installPublicKeyWithPassword(directServer, password, key.publicKey);

  const test = await runRemoteCommand(
    session,
    directServer,
    "printf 'COZYPAD_SSH_OK\\n'; hostname; pwd",
    15000,
  );

  if (!test.ok || !test.stdout.includes("COZYPAD_SSH_OK")) {
    throw new Error(test.stderr || "SSH key direct connection failed");
  }

  return directServer;
}

async function repairDirectServerKey(session, server, password) {
  if (server.source !== "local") {
    throw new Error("Only CozyPad local servers can repair SSH keys");
  }

  if (!server.host || !server.user) {
    throw new Error("Server host and user are required");
  }

  if (!String(password || "")) {
    throw new Error("SSH password is required");
  }

  const key = await ensureDirectSshKey(session, server);
  const repairedServer = {
    ...server,
    identityFile: key.identityFile,
    knownHostsFile: getUserKnownHostsFile(session),
    strictHostKeyChecking: server.strictHostKeyChecking || "accept-new",
    updatedAt: new Date().toISOString(),
  };

  await installPublicKeyWithPassword(repairedServer, password, key.publicKey);

  const test = await runRemoteCommand(
    session,
    repairedServer,
    "printf 'COZYPAD_SSH_OK\\n'; hostname; pwd",
    15000,
  );

  if (!test.ok || !test.stdout.includes("COZYPAD_SSH_OK")) {
    throw new Error(test.stderr || "SSH key repair test failed");
  }

  const servers = await readLocalServers(session);
  const nextServers = servers.map((item) =>
    item.id === server.id ? repairedServer : item,
  );
  await writeLocalServers(session, nextServers);

  return repairedServer;
}

function createCodexCommandAccess(session, server) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + CODEX_COMMAND_TOKEN_TTL_MS;
  codexCommandTokens.set(hashSessionToken(token), {
    serverId: server.id,
    username: session.username,
    role: session.role || "user",
    createdAt: Date.now(),
    expiresAt,
  });

  return {
    token,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

function getBearerToken(request) {
  const value = String(request.headers.authorization || "").trim();
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function verifyCodexCommandAccess(request) {
  const token = getBearerToken(request);
  if (!token) {
    return { ok: false, status: 401, error: "Codex command token is required" };
  }

  const tokenHash = hashSessionToken(token);
  const grant = codexCommandTokens.get(tokenHash);
  if (!grant) {
    return { ok: false, status: 401, error: "Codex command token is invalid" };
  }

  if (grant.expiresAt <= Date.now()) {
    codexCommandTokens.delete(tokenHash);
    return { ok: false, status: 401, error: "Codex command token expired" };
  }

  return {
    ok: true,
    tokenHash,
    session: {
      username: grant.username,
      role: grant.role,
    },
    serverId: grant.serverId,
  };
}

async function handleCodexCommandRequest(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  const access = verifyCodexCommandAccess(request);
  if (!access.ok) {
    sendJson(response, access.status || 401, { ok: false, error: access.error });
    return;
  }

  const body = await readBody(request);
  const command = String(body.command || "").trim();
  const cwd = String(body.cwd || body.remotePath || "").trim().slice(0, 240);
  if (!command) {
    sendJson(response, 400, { ok: false, error: "Remote command is required" });
    return;
  }

  if (command.length > CODEX_COMMAND_MAX_LENGTH) {
    sendJson(response, 413, { ok: false, error: "Remote command is too long" });
    return;
  }

  const server = await findServer(access.serverId, access.session);
  if (!server) {
    sendJson(response, 404, { ok: false, error: "SSH server not found" });
    return;
  }

  const effectiveCommand = cwd ? `cd ${shellQuote(cwd)} && ${command}` : command;
  const result = await runRemoteCommand(access.session, server, effectiveCommand, 120000);
  sendJson(response, result.ok ? 200 : 502, {
    ok: result.ok,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

function isAdminSession(session) {
  return session?.role === "admin" || normalizeUsername(session?.username) === normalizeUsername(ADMIN_USERNAME);
}

function requireAdmin(response, session) {
  if (isAdminSession(session)) {
    return true;
  }

  sendJson(response, 403, { ok: false, error: "Admin account required" });
  return false;
}

async function tailTextFile(filePath, maxLines = 160) {
  try {
    const raw = await readFile(filePath, "utf8");
    const lines = raw.split(/\r?\n/);
    return lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
  } catch {
    return "";
  }
}

function redactLocalPaths(value) {
  return String(value ?? "")
    .replace(/[A-Za-z]:[\\/][^\r\n"'<>|`]*/g, "[hidden path]")
    .replace(/\\\\[^\r\n"'<>|`]+/g, "[hidden path]");
}

function publicDominLogInfo(info) {
  if (!info) {
    return null;
  }

  const { path: _path, ...publicInfo } = info;
  return publicInfo;
}

const DOMIN_SCRIPT_ALLOWLIST = new Map([
  ["setup-credentials", "setup-credentials.ps1"],
  ["install-task", "install-task.ps1"],
  ["install-startup", "install-startup.ps1"],
]);

function powershellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function cmdDoubleQuote(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isIpv4(value) {
  const parts = String(value || "").trim().split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
  );
}

async function readJsonFileSafe(filePath, fallback) {
  try {
    const raw = (await readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function readDominDdnsConfig() {
  return {
    zoneName: "modoubletw.com",
    recordName: "pal.modoubletw.com",
    recordType: "A",
    ttl: 120,
    proxied: false,
    records: [
      {
        recordName: "pal.modoubletw.com",
        recordType: "A",
        ttl: 120,
        proxied: false,
        replaceConflictingRecords: false,
      },
    ],
    useCustomIp: false,
    customIp: "",
    cloudflareApiBaseUrl: "https://api.cloudflare.com/client/v4",
    publicIpServices: [
      "https://api.ipify.org",
      "https://ipv4.icanhazip.com",
      "https://checkip.amazonaws.com",
    ],
    ...(await readJsonFileSafe(DOMIN_CONFIG_FILE, {})),
  };
}

function requireConfigText(value, fieldName) {
  const text = String(value || "").trim();
  if (!text) {
    throw new Error(`${fieldName} is required`);
  }
  if (/\s/.test(text)) {
    throw new Error(`${fieldName} cannot contain spaces`);
  }
  return text;
}

function normalizePublicIpServices(value) {
  const services = Array.isArray(value) ? value : String(value || "").split(/\r?\n|,/);
  const cleaned = services
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, 8);

  if (!cleaned.length) {
    throw new Error("At least one public IP service is required");
  }

  for (const service of cleaned) {
    if (!/^https?:\/\//i.test(service)) {
      throw new Error(`Invalid public IP service URL: ${service}`);
    }
  }

  return cleaned;
}

function normalizeDominDdnsRecords(current, next, body) {
  const bodyHasRecords = Array.isArray(body.records);
  const source = bodyHasRecords ? body.records : Array.isArray(current.records) ? current.records : [];
  const records = source.map((item, index) => {
    const record = isPlainObject(item) ? item : {};
    const recordName = requireConfigText(
      record.recordName ?? record.name ?? (index === 0 ? next.recordName : ""),
      `records[${index}].recordName`,
    );
    const recordType = String(record.recordType ?? record.type ?? next.recordType ?? "A")
      .trim()
      .toUpperCase();
    const ttl = Number(record.ttl ?? next.ttl ?? 120);
    const proxied = Boolean(record.proxied ?? next.proxied);

    if (recordType !== "A") {
      throw new Error(`records[${index}].recordType must be A`);
    }

    if (!Number.isInteger(ttl) || (ttl !== 1 && (ttl < 60 || ttl > 86400))) {
      throw new Error(`records[${index}].ttl must be 1, or an integer between 60 and 86400`);
    }

    return {
      recordName,
      recordType,
      ttl,
      proxied,
      replaceConflictingRecords: Boolean(record.replaceConflictingRecords),
    };
  });

  if (!records.length) {
    records.push({
      recordName: next.recordName,
      recordType: next.recordType,
      ttl: next.ttl,
      proxied: next.proxied,
      replaceConflictingRecords: false,
    });
  }

  const selectedIndex = records.findIndex(
    (record) => record.recordName.toLowerCase() === next.recordName.toLowerCase(),
  );

  if (selectedIndex >= 0) {
    records[selectedIndex] = {
      ...records[selectedIndex],
      recordType: next.recordType,
      ttl: next.ttl,
      proxied: next.proxied,
    };
  } else if (!bodyHasRecords) {
    records[0] = {
      ...records[0],
      recordName: next.recordName,
      recordType: next.recordType,
      ttl: next.ttl,
      proxied: next.proxied,
    };
  }

  return records;
}

function normalizeDominDdnsConfig(current, body) {
  const next = {
    ...current,
    ...body,
    zoneName: requireConfigText(body.zoneName ?? current.zoneName, "zoneName"),
    recordName: requireConfigText(body.recordName ?? current.recordName, "recordName"),
    recordType: String(body.recordType ?? current.recordType ?? "A").trim().toUpperCase(),
    ttl: Number(body.ttl ?? current.ttl ?? 120),
    proxied: Boolean(body.proxied),
    useCustomIp: Boolean(body.useCustomIp),
    customIp: String(body.customIp ?? "").trim(),
    cloudflareApiBaseUrl: requireConfigText(
      body.cloudflareApiBaseUrl ?? current.cloudflareApiBaseUrl,
      "cloudflareApiBaseUrl",
    ),
    publicIpServices: normalizePublicIpServices(body.publicIpServices ?? current.publicIpServices),
  };

  if (next.recordType !== "A") {
    throw new Error("This DDNS agent currently manages IPv4 A records only");
  }

  if (!Number.isInteger(next.ttl) || (next.ttl !== 1 && (next.ttl < 60 || next.ttl > 86400))) {
    throw new Error("ttl must be 1, or an integer between 60 and 86400");
  }

  if (!/^https?:\/\//i.test(next.cloudflareApiBaseUrl)) {
    throw new Error("cloudflareApiBaseUrl must be an http(s) URL");
  }

  if (next.customIp && !isIpv4(next.customIp)) {
    throw new Error("customIp must be a valid IPv4 address");
  }

  if (next.useCustomIp && !next.customIp) {
    throw new Error("customIp is required when useCustomIp is enabled");
  }

  next.records = normalizeDominDdnsRecords(current, next, body);

  return next;
}

async function writeDominDdnsConfig(body) {
  if (!existsSync(DOMIN_ROOT)) {
    throw new Error("Domin root does not exist");
  }

  const current = await readDominDdnsConfig();
  const next = normalizeDominDdnsConfig(current, body);
  await writeFile(DOMIN_CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

async function getDominDdnsCredentialsStatus() {
  const exists = existsSync(DOMIN_CREDENTIALS_FILE);
  if (!exists) {
    return { exists: false, hasToken: false };
  }

  const credentials = await readJsonFileSafe(DOMIN_CREDENTIALS_FILE, {});
  const hasToken = Object.entries(credentials).some(
    ([key, value]) => /token/i.test(key) && String(value || "").trim().length > 0,
  );

  return { exists: true, hasToken };
}

async function listDominDdnsLogFiles() {
  try {
    const entries = await readdir(DOMIN_LOG_DIR, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".log"))
        .map(async (entry) => {
          const filePath = path.join(DOMIN_LOG_DIR, entry.name);
          const info = await stat(filePath);
          return {
            name: entry.name,
            path: filePath,
            size: info.size,
            updatedAt: info.mtime.toISOString(),
          };
        }),
    );

    return files.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  } catch {
    return [];
  }
}

async function getLatestDominDdnsLogInfo() {
  return (await listDominDdnsLogFiles())[0] || null;
}

async function getDominDdnsLogs(maxLines = 180) {
  const latestLog = await getLatestDominDdnsLogInfo();
  const lines = Math.max(1, Math.min(500, Number(maxLines) || 180));

  return {
    ok: true,
    latestLog: publicDominLogInfo(latestLog),
    files: (await listDominDdnsLogFiles()).map(publicDominLogInfo),
    text: latestLog ? redactLocalPaths(await tailTextFile(latestLog.path, lines)) : "",
  };
}

async function getDominDdnsPublicIp(config) {
  let lastError = "";

  for (const service of config.publicIpServices || []) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(service, { signal: controller.signal });
      const text = (await response.text()).trim();

      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }

      if (!isIpv4(text)) {
        throw new Error(`non-IPv4 response: ${text}`);
      }

      return { ok: true, address: text, source: service };
    } catch (error) {
      lastError = error instanceof Error ? error.message : "failed to detect public IP";
    } finally {
      clearTimeout(timeout);
    }
  }

  return { ok: false, address: "", source: "", error: lastError || "No public IP service worked" };
}

function parsePowerShellJsonArray(stdout) {
  const text = String(stdout || "").trim();
  if (!text) {
    return [];
  }

  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

async function getDominDdnsUiProcesses() {
  const script = `
$root = ${powershellSingleQuote(DOMIN_ROOT)}
$items = @(Get-CimInstance Win32_Process -Filter "Name = 'CloudflareDdnsAgent.exe'" | Where-Object {
  $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)
} | Select-Object ProcessId, ExecutablePath)
$items | ConvertTo-Json -Compress
`.trim();

  const result = await runProcess("powershell.exe", ["-NoProfile", "-Command", script], {
    cwd: DOMIN_ROOT,
    timeoutMs: 8000,
  });

  if (!result.ok) {
    return [];
  }

  return parsePowerShellJsonArray(result.stdout).map((item) => ({
    pid: Number(item.ProcessId) || 0,
  }));
}

function parseScheduledTaskList(stdout) {
  const fields = {};

  for (const line of String(stdout || "").split(/\r?\n/)) {
    const match = /^([^:]+):\s*(.*)$/.exec(line);
    if (match) {
      fields[match[1].trim()] = match[2].trim();
    }
  }

  return fields;
}

async function getDominDdnsTaskStatus() {
  const result = await runProcess(
    "schtasks.exe",
    ["/Query", "/TN", DOMIN_TASK_NAME, "/FO", "LIST", "/V"],
    { cwd: DOMIN_ROOT, timeoutMs: 8000 },
  );

  if (!result.ok) {
    return {
      installed: false,
      name: DOMIN_TASK_NAME,
      error: redactLocalPaths(result.stderr || result.stdout || "").trim(),
    };
  }

  const fields = parseScheduledTaskList(result.stdout);
  return {
    installed: true,
    name: DOMIN_TASK_NAME,
    status: fields.Status || fields["狀態"] || "",
    lastRunTime: fields["Last Run Time"] || fields["上次執行時間"] || "",
    lastResult: fields["Last Result"] || fields["上次結果"] || "",
    nextRunTime: fields["Next Run Time"] || fields["下次執行時間"] || "",
  };
}

async function getDominDdnsStatus() {
  const config = await readDominDdnsConfig();
  const [credentials, latestLog, logs, uiProcesses, task, currentPublicIp] = await Promise.all([
    getDominDdnsCredentialsStatus(),
    getLatestDominDdnsLogInfo(),
    listDominDdnsLogFiles(),
    getDominDdnsUiProcesses(),
    getDominDdnsTaskStatus(),
    getDominDdnsPublicIp(config),
  ]);
  const lastLogText = latestLog ? await tailTextFile(latestLog.path, 1) : "";
  const lastLogLine = lastLogText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();

  return {
    ok: true,
    rootExists: existsSync(DOMIN_ROOT),
    configExists: existsSync(DOMIN_CONFIG_FILE),
    credentials,
    exeExists: existsSync(DOMIN_EXE),
    updateScriptExists: existsSync(DOMIN_UPDATE_SCRIPT),
    task,
    config,
    currentPublicIp,
    targetIp:
      config.useCustomIp && config.customIp
        ? { ok: true, address: config.customIp, source: "customIp" }
        : currentPublicIp,
    proxiedWarning: Boolean(config.proxied),
    uiProcesses,
    uiRunning: uiProcesses.length > 0,
    updateRunning: Boolean(dominUpdateProcess),
    updateStartedAt: dominUpdateProcess
      ? new Date(dominUpdateProcess.startedAt).toISOString()
      : null,
    logs: {
      count: logs.length,
      latest: publicDominLogInfo(latestLog),
      lastLine: redactLocalPaths(lastLogLine || ""),
    },
  };
}

async function runDominDdnsUpdate(body = {}) {
  if (dominUpdateProcess) {
    throw new Error("DDNS update is already running");
  }

  if (!existsSync(DOMIN_UPDATE_SCRIPT)) {
    throw new Error("Missing update script");
  }

  const ipAddress = String(body.ipAddress || "").trim();
  if (ipAddress && !isIpv4(ipAddress)) {
    throw new Error("ipAddress must be a valid IPv4 address");
  }

  const config = await readDominDdnsConfig();
  const recordName = String(body.recordName || "").trim();
  if (recordName) {
    const records = Array.isArray(config.records) ? config.records : [];
    if (!records.some((record) => String(record?.recordName || "").toLowerCase() === recordName.toLowerCase())) {
      throw new Error("recordName is not configured");
    }
  }

  if (!body.dryRun) {
    if (!recordName) {
      throw new Error("recordName is required for DNS update");
    }

    const expectedConfirmation = `UPDATE ${recordName}`;
    const confirmation = String(body.confirmation || "").trim();
    if (confirmation !== expectedConfirmation) {
      throw new Error(`DNS update requires confirmation: ${expectedConfirmation}`);
    }
  }

  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", DOMIN_UPDATE_SCRIPT];
  if (body.dryRun) {
    args.push("-DryRun");
  }
  if (ipAddress) {
    args.push("-IpAddress", ipAddress);
  }
  if (recordName) {
    args.push("-RecordName", recordName);
  }

  dominUpdateProcess = { startedAt: Date.now() };
  try {
    const result = await runProcess("powershell.exe", args, {
      cwd: DOMIN_ROOT,
      timeoutMs: 120000,
    });
    return {
      ...result,
      stdout: redactLocalPaths(result.stdout),
      stderr: redactLocalPaths(result.stderr),
      ok: result.ok,
      dryRun: Boolean(body.dryRun),
      status: await getDominDdnsStatus(),
    };
  } finally {
    dominUpdateProcess = null;
  }
}

function launchDominDdnsUi() {
  if (!existsSync(DOMIN_EXE)) {
    throw new Error("Missing DDNS GUI executable");
  }

  const child = spawn(DOMIN_EXE, [], {
    cwd: DOMIN_ROOT,
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  return child.pid;
}

async function stopDominDdnsUi() {
  const script = `
$root = ${powershellSingleQuote(DOMIN_ROOT)}
$items = @(Get-CimInstance Win32_Process -Filter "Name = 'CloudflareDdnsAgent.exe'" | Where-Object {
  $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)
})
foreach ($item in $items) {
  Stop-Process -Id $item.ProcessId -Force -ErrorAction SilentlyContinue
}
$items.Count
`.trim();

  const result = await runProcess("powershell.exe", ["-NoProfile", "-Command", script], {
    cwd: DOMIN_ROOT,
    timeoutMs: 10000,
  });

  return {
    ...result,
    stopped: Number(String(result.stdout || "").trim()) || 0,
    status: await getDominDdnsStatus(),
  };
}

function launchDominDdnsScript(scriptName) {
  const fileName = DOMIN_SCRIPT_ALLOWLIST.get(String(scriptName || ""));
  if (!fileName) {
    throw new Error("Unsupported domin script");
  }

  const filePath = path.join(DOMIN_ROOT, fileName);
  if (!existsSync(filePath)) {
    throw new Error(`Missing script: ${fileName}`);
  }

  const child = spawn(
    "powershell.exe",
    ["-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", filePath],
    {
      cwd: DOMIN_ROOT,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    },
  );
  child.unref();
  return child.pid;
}

function createUsageCommand() {
  const script = String.raw`
import json
import os
import platform
import socket
import subprocess
import time

def read_proc_stat():
    with open("/proc/stat", "r", encoding="utf-8") as handle:
        parts = handle.readline().split()[1:8]
    values = [int(part) for part in parts]
    idle = values[3] + values[4]
    total = sum(values)
    return idle, total

def read_cpu_percent():
    try:
        idle1, total1 = read_proc_stat()
        time.sleep(0.2)
        idle2, total2 = read_proc_stat()
        total_delta = total2 - total1
        idle_delta = idle2 - idle1
        return round(0 if total_delta <= 0 else (total_delta - idle_delta) * 100 / total_delta, 1)
    except Exception:
        return 0

def read_memory():
    values = {}
    try:
        with open("/proc/meminfo", "r", encoding="utf-8") as handle:
            for line in handle:
                key, raw_value = line.split(":", 1)
                values[key] = int(raw_value.strip().split()[0])
    except Exception:
        pass

    total = values.get("MemTotal", 0)
    available = values.get("MemAvailable", 0)
    percent = round(0 if total <= 0 else (total - available) * 100 / total, 1)
    return total, available, percent

def read_disks():
    ignored_fs = {
        "autofs",
        "binfmt_misc",
        "bpf",
        "cgroup",
        "cgroup2",
        "configfs",
        "debugfs",
        "devpts",
        "devtmpfs",
        "fusectl",
        "hugetlbfs",
        "mqueue",
        "proc",
        "pstore",
        "ramfs",
        "rpc_pipefs",
        "securityfs",
        "squashfs",
        "sysfs",
        "tmpfs",
        "tracefs",
    }
    physical_fs = {
        "btrfs",
        "exfat",
        "ext2",
        "ext3",
        "ext4",
        "f2fs",
        "ntfs",
        "vfat",
        "xfs",
        "zfs",
    }
    disks = []
    seen = set()

    try:
        with open("/proc/mounts", "r", encoding="utf-8") as handle:
            mounts = [line.split()[:3] for line in handle if len(line.split()) >= 3]
    except Exception:
        mounts = []

    for device, mount, fs_type in mounts:
        if fs_type in ignored_fs:
            continue
        if (
            not device.startswith("/")
            and not device.startswith("UUID=")
            and not device.startswith("LABEL=")
            and fs_type not in physical_fs
        ):
            continue

        decoded_mount = mount.replace("\\040", " ")
        try:
            stat = os.statvfs(decoded_mount)
        except Exception:
            continue

        total = stat.f_blocks * stat.f_frsize // 1024
        if total <= 0:
            continue

        available = stat.f_bavail * stat.f_frsize // 1024
        used = max(total - available, 0)
        percent = round(used * 100 / total, 1)
        key = (device, mount, total)
        if key in seen:
            continue
        seen.add(key)
        disks.append({
            "name": device,
            "mount": decoded_mount,
            "fsType": fs_type,
            "totalKb": total,
            "usedKb": used,
            "availableKb": available,
            "percent": percent,
        })

    disks.sort(key=lambda item: (item["mount"] != "/", item["mount"]))
    total = sum(item["totalKb"] for item in disks)
    used = sum(item["usedKb"] for item in disks)
    percent = round(0 if total <= 0 else used * 100 / total, 1)
    return disks, total, used, percent

def read_uptime():
    try:
        with open("/proc/uptime", "r", encoding="utf-8") as handle:
            return int(float(handle.read().split()[0]))
    except Exception:
        return 0

def read_gpu():
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit",
                "--format=csv,noheader,nounits",
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=3,
        )
    except Exception:
        return [], None, None, None, 0

    rows = []

    def safe_float(value):
        try:
            return float(str(value).strip())
        except Exception:
            return None

    for line in result.stdout.splitlines():
        try:
            parts = [part.strip() for part in line.split(",")]
            if len(parts) < 8:
                continue
            index = safe_float(parts[0])
            name = ",".join(parts[1:-6]).strip() or "GPU"
            util, memory_used, memory_total, temperature, power_draw, power_limit = [
                safe_float(part) for part in parts[-6:]
            ]
            if index is None or util is None or memory_used is None or memory_total is None:
                continue
            memory_percent = round(0 if memory_total <= 0 else memory_used * 100 / memory_total, 1)
            rows.append({
                "index": int(index),
                "name": name,
                "gpuPercent": round(util, 1),
                "memoryUsedMb": round(memory_used, 1),
                "memoryTotalMb": round(memory_total, 1),
                "memoryPercent": memory_percent,
                "temperatureC": None if temperature is None else round(temperature, 1),
                "powerDrawW": None if power_draw is None else round(power_draw, 1),
                "powerLimitW": None if power_limit is None else round(power_limit, 1),
            })
        except Exception:
            continue

    if not rows:
        return [], None, None, None, 0

    gpu_percent = round(sum(row["gpuPercent"] for row in rows) / len(rows), 1)
    memory_total = sum(row["memoryTotalMb"] for row in rows)
    memory_percent = round(0 if memory_total <= 0 else sum(row["memoryUsedMb"] for row in rows) * 100 / memory_total, 1)
    temperatures = [row["temperatureC"] for row in rows if row["temperatureC"] is not None]
    temperature = None if not temperatures else round(sum(temperatures) / len(temperatures), 1)
    return rows, gpu_percent, memory_percent, temperature, len(rows)

memory_total, memory_available, memory_percent = read_memory()
disks, disk_total, disk_used, disk_percent = read_disks()
gpus, gpu_percent, gpu_memory_percent, gpu_temperature_c, gpu_count = read_gpu()
load = os.getloadavg() if hasattr(os, "getloadavg") else (0, 0, 0)

print(json.dumps({
    "ok": True,
    "hostname": socket.gethostname(),
    "kernel": platform.platform(),
    "cpuPercent": read_cpu_percent(),
    "memoryPercent": memory_percent,
    "memoryTotalKb": memory_total,
    "memoryAvailableKb": memory_available,
    "diskPercent": disk_percent,
    "diskTotalKb": disk_total,
    "diskUsedKb": disk_used,
    "disks": disks,
    "load1": round(load[0], 2),
    "load5": round(load[1], 2),
    "load15": round(load[2], 2),
    "uptimeSeconds": read_uptime(),
    "processCount": len([name for name in os.listdir("/proc") if name.isdigit()]) if os.path.isdir("/proc") else 0,
    "gpuPercent": gpu_percent,
    "gpuMemoryPercent": gpu_memory_percent,
    "gpuTemperatureC": gpu_temperature_c,
    "gpuCount": gpu_count,
    "gpus": gpus,
}, ensure_ascii=False))
`.trim();

  return `if command -v python3 >/dev/null 2>&1; then _cozypad_py=python3; elif command -v python >/dev/null 2>&1; then _cozypad_py=python; else echo '{"ok":false,"error":"python3/python not found on remote host"}'; exit 127; fi; "$_cozypad_py" - <<'PY'\n${script}\nPY`;
}

function createUsageStreamCommand(intervalMs = MONITOR_INTERVAL_MS) {
  const intervalSeconds = Math.max(2, Math.round(Number(intervalMs) / 1000) || 8);
  return `while true; do\n${createUsageCommand()}\nsleep ${intervalSeconds}\ndone`;
}

function getMonitorBlockKey(server) {
  const signature = [
    server.source,
    server.id,
    server.alias || "",
    server.name || "",
    server.user || "",
    server.host || "",
    server.port || "",
    server.identityFile || "",
  ].join("|");

  return crypto.createHash("sha256").update(signature).digest("base64url");
}

function isSshAuthenticationFailure(text) {
  const output = String(text || "").toLowerCase();
  return [
    "permission denied",
    "too many authentication failures",
    "authentication failed",
    "all configured authentication methods failed",
    "no supported authentication methods available",
    "publickey,password",
    "publickey,keyboard-interactive",
  ].some((pattern) => output.includes(pattern));
}

function createMonitorBlockedResult(base, block) {
  return {
    ...base,
    online: false,
    latencyMs: 0,
    monitorBlocked: true,
    blockedAt: block.blockedAt,
    error: `SSH 認證失敗後已暫停自動監控，避免重複登入被判定為攻擊。\n${block.error}`,
  };
}

function createMonitorBase(server, checkedAt = Date.now()) {
  return {
    id: server.id,
    name: server.name,
    source: server.source,
    target: getServerTargetLabel(server),
    checkedAt: new Date(checkedAt).toISOString(),
  };
}

function normalizeDiskMetrics(value, fallback = {}) {
  const rawDisks = Array.isArray(value) ? value : value ? [value] : [];
  const disks = rawDisks
    .map((disk) => {
      const totalKb = Number(disk?.totalKb ?? disk?.TotalKb) || 0;
      const usedKb = Number(disk?.usedKb ?? disk?.UsedKb) || 0;
      const availableKb = Number(disk?.availableKb ?? disk?.AvailableKb) || Math.max(totalKb - usedKb, 0);
      const percent = Number(disk?.percent ?? disk?.Percent) || (totalKb > 0 ? (usedKb * 100) / totalKb : 0);

      return {
        name: String(disk?.name ?? disk?.Name ?? "").trim(),
        mount: String(disk?.mount ?? disk?.Mount ?? "").trim(),
        fsType: String(disk?.fsType ?? disk?.FsType ?? "").trim(),
        totalKb,
        usedKb,
        availableKb,
        percent: Number(Math.max(0, Math.min(100, percent)).toFixed(1)),
      };
    })
    .filter((disk) => disk.totalKb > 0);

  if (disks.length) {
    return disks;
  }

  const totalKb = Number(fallback.diskTotalKb) || 0;
  const usedKb = Number(fallback.diskUsedKb) || 0;
  if (totalKb <= 0) {
    return [];
  }

  return [
    {
      name: String(fallback.name || "disk"),
      mount: String(fallback.mount || ""),
      fsType: String(fallback.fsType || ""),
      totalKb,
      usedKb,
      availableKb: Math.max(totalKb - usedKb, 0),
      percent: Number(Math.max(0, Math.min(100, Number(fallback.diskPercent) || 0)).toFixed(1)),
    },
  ];
}

function nullableNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "" || String(value).trim().toUpperCase() === "N/A") {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeGpuMetrics(value) {
  const rawGpus = Array.isArray(value) ? value : value ? [value] : [];
  return rawGpus
    .map((gpu, fallbackIndex) => {
      const memoryUsedMb = nullableNumber(gpu?.memoryUsedMb ?? gpu?.MemoryUsedMb);
      const memoryTotalMb = nullableNumber(gpu?.memoryTotalMb ?? gpu?.MemoryTotalMb);
      const reportedMemoryPercent = nullableNumber(gpu?.memoryPercent ?? gpu?.MemoryPercent);
      const memoryPercent =
        reportedMemoryPercent ??
        (memoryTotalMb && memoryTotalMb > 0 && memoryUsedMb !== null
          ? Number(((memoryUsedMb * 100) / memoryTotalMb).toFixed(1))
          : null);

      return {
        index: Number(gpu?.index ?? gpu?.Index ?? fallbackIndex) || 0,
        name: String(gpu?.name ?? gpu?.Name ?? `GPU ${fallbackIndex}`).trim(),
        gpuPercent: nullableNumber(gpu?.gpuPercent ?? gpu?.GpuPercent),
        memoryUsedMb,
        memoryTotalMb,
        memoryPercent,
        temperatureC: nullableNumber(gpu?.temperatureC ?? gpu?.TemperatureC),
        powerDrawW: nullableNumber(gpu?.powerDrawW ?? gpu?.PowerDrawW),
        powerLimitW: nullableNumber(gpu?.powerLimitW ?? gpu?.PowerLimitW),
      };
    })
    .filter((gpu) => gpu.gpuPercent !== null || gpu.memoryTotalMb !== null);
}

function createUsageMetrics(parsed, fallbackName) {
  const disks = normalizeDiskMetrics(parsed.disks, {
    name: parsed.diskName,
    mount: parsed.diskMount,
    fsType: parsed.diskFsType,
    diskTotalKb: parsed.diskTotalKb,
    diskUsedKb: parsed.diskUsedKb,
    diskPercent: parsed.diskPercent,
  });
  const gpus = normalizeGpuMetrics(parsed.gpus);

  return {
    hostname: parsed.hostname || fallbackName,
    kernel: parsed.kernel || "",
    cpuPercent: Number(parsed.cpuPercent) || 0,
    memoryPercent: Number(parsed.memoryPercent) || 0,
    memoryTotalKb: Number(parsed.memoryTotalKb) || 0,
    memoryAvailableKb: Number(parsed.memoryAvailableKb) || 0,
    diskPercent: Number(parsed.diskPercent) || 0,
    diskTotalKb: Number(parsed.diskTotalKb) || 0,
    diskUsedKb: Number(parsed.diskUsedKb) || 0,
    disks,
    load1: Number(parsed.load1) || 0,
    load5: Number(parsed.load5) || 0,
    load15: Number(parsed.load15) || 0,
    uptimeSeconds: Number(parsed.uptimeSeconds) || 0,
    processCount: Number(parsed.processCount) || 0,
    gpuPercent: nullableNumber(parsed.gpuPercent),
    gpuMemoryPercent: nullableNumber(parsed.gpuMemoryPercent),
    gpuTemperatureC: nullableNumber(parsed.gpuTemperatureC),
    gpuCount: Number(parsed.gpuCount) || 0,
    gpus,
  };
}

function createLocalMonitorServer() {
  return {
    id: "system:local",
    source: "system",
    name: "自己的電腦",
    alias: "local",
    host: os.hostname(),
    user: os.userInfo().username,
    port: 0,
    identityFile: "",
    defaultPath: ROOT,
  };
}

function readLocalCpuSnapshot() {
  return os.cpus().reduce(
    (total, cpu) => {
      total.idle += cpu.times.idle;
      total.total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
      return total;
    },
    { idle: 0, total: 0 },
  );
}

function calculateLocalCpuPercent(previous, current) {
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;

  if (totalDelta <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(100, Number((((totalDelta - idleDelta) * 100) / totalDelta).toFixed(1))));
}

async function readLocalDiskAndProcessUsage() {
  const script = `
$disks = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" -ErrorAction SilentlyContinue | Where-Object {
  $_.Size -and $_.Size -gt 0
} | Sort-Object DeviceID | ForEach-Object {
  $size = [double]$_.Size
  $free = if ($_.FreeSpace) { [double]$_.FreeSpace } else { 0 }
  $used = [Math]::Max($size - $free, 0)
  [pscustomobject]@{
    name = [string]$_.DeviceID
    mount = "$($_.DeviceID)\\"
    fsType = [string]$_.FileSystem
    totalKb = [Math]::Round($size / 1KB)
    usedKb = [Math]::Round($used / 1KB)
    availableKb = [Math]::Round($free / 1KB)
    percent = if ($size -gt 0) { [Math]::Round(($used * 100) / $size, 1) } else { 0 }
  }
})
$total = [double](($disks | Measure-Object -Property totalKb -Sum).Sum)
$usedTotal = [double](($disks | Measure-Object -Property usedKb -Sum).Sum)
$percent = if ($total -gt 0) { [Math]::Round(($usedTotal * 100) / $total, 1) } else { 0 }
[pscustomobject]@{
  DiskTotalKb = [Math]::Round($total)
  DiskUsedKb = [Math]::Round($usedTotal)
  DiskPercent = $percent
  Disks = $disks
  ProcessCount = @((Get-Process -ErrorAction SilentlyContinue)).Count
} | ConvertTo-Json -Compress -Depth 5
`.trim();
  const result = await runProcess("powershell.exe", ["-NoProfile", "-Command", script], {
    cwd: appRoot,
    timeoutMs: 5000,
  });

  if (!result.ok || !result.stdout.trim()) {
    return {
      diskTotalKb: 0,
      diskUsedKb: 0,
      diskPercent: 0,
      disks: [],
      processCount: 0,
    };
  }

  try {
    const parsed = JSON.parse(result.stdout.trim());
    const disks = normalizeDiskMetrics(parsed.Disks);
    return {
      diskTotalKb: Number(parsed.DiskTotalKb) || 0,
      diskUsedKb: Number(parsed.DiskUsedKb) || 0,
      diskPercent: Number(parsed.DiskPercent) || 0,
      disks,
      processCount: Number(parsed.ProcessCount) || 0,
    };
  } catch {
    return {
      diskTotalKb: 0,
      diskUsedKb: 0,
      diskPercent: 0,
      disks: [],
      processCount: 0,
    };
  }
}

async function readLocalGpuUsage() {
  const result = await runProcess(
    "nvidia-smi.exe",
    [
      "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit",
      "--format=csv,noheader,nounits",
    ],
    { cwd: appRoot, timeoutMs: 3000 },
  );

  if (!result.ok) {
    return {
      gpuPercent: null,
      gpuMemoryPercent: null,
      gpuTemperatureC: null,
      gpuCount: 0,
      gpus: [],
    };
  }

  const rows = result.stdout
    .split(/\r?\n/)
    .map((line, fallbackIndex) => {
      const parts = line.split(",").map((part) => part.trim());
      if (parts.length < 8) {
        return null;
      }

      const index = nullableNumber(parts[0]) ?? fallbackIndex;
      const name = parts.slice(1, -6).join(",").trim() || `GPU ${index}`;
      const [gpuPercent, memoryUsedMb, memoryTotalMb, temperatureC, powerDrawW, powerLimitW] = parts
        .slice(-6)
        .map(nullableNumber);
      const memoryPercent =
        memoryTotalMb && memoryTotalMb > 0 && memoryUsedMb !== null
          ? Number(((memoryUsedMb * 100) / memoryTotalMb).toFixed(1))
          : null;

      return {
        index,
        name,
        gpuPercent,
        memoryUsedMb,
        memoryTotalMb,
        memoryPercent,
        temperatureC,
        powerDrawW,
        powerLimitW,
      };
    })
    .filter(Boolean);

  if (!rows.length) {
    return {
      gpuPercent: null,
      gpuMemoryPercent: null,
      gpuTemperatureC: null,
      gpuCount: 0,
      gpus: [],
    };
  }

  const gpuPercent = rows.reduce((total, row) => total + (row.gpuPercent ?? 0), 0) / rows.length;
  const memoryUsed = rows.reduce((total, row) => total + (row.memoryUsedMb ?? 0), 0);
  const memoryTotal = rows.reduce((total, row) => total + (row.memoryTotalMb ?? 0), 0);
  const temperatures = rows
    .map((row) => row.temperatureC)
    .filter((value) => Number.isFinite(value));
  const temperature = temperatures.length
    ? temperatures.reduce((total, value) => total + value, 0) / temperatures.length
    : null;

  return {
    gpuPercent: Number(gpuPercent.toFixed(1)),
    gpuMemoryPercent: memoryTotal > 0 ? Number(((memoryUsed * 100) / memoryTotal).toFixed(1)) : null,
    gpuTemperatureC: temperature === null ? null : Number(temperature.toFixed(1)),
    gpuCount: rows.length,
    gpus: normalizeGpuMetrics(rows),
  };
}

function createMonitorPendingResult(server) {
  return {
    ...createMonitorBase(server),
    online: false,
    latencyMs: 0,
    monitorConnecting: true,
    error:
      server.source === "system"
        ? "Local monitor is starting"
        : "SSH monitor connection is opening",
  };
}

function createMonitorSnapshotFromStates(servers, serverStates) {
  const sampledServers = servers.map((server) => serverStates.get(server.id) || createMonitorPendingResult(server));
  const online = sampledServers.filter((server) => server.online).length;
  const blocked = sampledServers.filter((server) => server.monitorBlocked).length;

  return {
    type: "snapshot",
    generatedAt: new Date().toISOString(),
    intervalMs: MONITOR_INTERVAL_MS,
    totals: {
      total: sampledServers.length,
      online,
      offline: sampledServers.length - online,
      blocked,
    },
    servers: sampledServers,
  };
}

function getMonitorRequestedServerId(url) {
  const raw = String(url.searchParams.get("serverId") || "").trim();
  if (!raw) {
    return "";
  }

  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function selectMonitorServers(servers, url) {
  const scope = String(url.searchParams.get("scope") || "selected").trim().toLowerCase();
  if (scope === "all") {
    throw new Error("Monitor scope=all is disabled to avoid opening multiple SSH sessions at once.");
  }

  const requestedServerId = getMonitorRequestedServerId(url);
  if (requestedServerId) {
    return servers.filter((server) => server.id === requestedServerId);
  }

  const localServer = servers.find((server) => isSystemLocalServer(server));
  return localServer ? [localServer] : servers.slice(0, 1);
}

function startLocalMonitorStream(server, onUpdate) {
  let closed = false;
  let sampling = false;
  let previousCpu = readLocalCpuSnapshot();

  async function sample() {
    if (closed || sampling) {
      return;
    }

    sampling = true;
    const checkedAt = Date.now();
    const currentCpu = readLocalCpuSnapshot();
    const totalMemoryKb = Math.round(os.totalmem() / 1024);
    const availableMemoryKb = Math.round(os.freemem() / 1024);
    const usedMemoryKb = Math.max(totalMemoryKb - availableMemoryKb, 0);
    const memoryPercent =
      totalMemoryKb > 0 ? Number(((usedMemoryKb * 100) / totalMemoryKb).toFixed(1)) : 0;

    try {
      const [disk, gpu] = await Promise.all([
        readLocalDiskAndProcessUsage(),
        readLocalGpuUsage(),
      ]);
      const cpuPercent = calculateLocalCpuPercent(previousCpu, currentCpu);

      previousCpu = currentCpu;
      onUpdate({
        ...createMonitorBase(server, checkedAt),
        online: true,
        latencyMs: 0,
        localOnly: true,
        metrics: {
          hostname: os.hostname(),
          kernel: `${os.type()} ${os.release()}`,
          cpuPercent,
          memoryPercent,
          memoryTotalKb: totalMemoryKb,
          memoryAvailableKb: availableMemoryKb,
          diskPercent: disk.diskPercent,
          diskTotalKb: disk.diskTotalKb,
          diskUsedKb: disk.diskUsedKb,
          disks: disk.disks,
          load1: os.loadavg()[0] || 0,
          load5: os.loadavg()[1] || 0,
          load15: os.loadavg()[2] || 0,
          uptimeSeconds: Math.round(os.uptime()),
          processCount: disk.processCount,
          gpuPercent: gpu.gpuPercent,
          gpuMemoryPercent: gpu.gpuMemoryPercent,
          gpuTemperatureC: gpu.gpuTemperatureC,
          gpuCount: gpu.gpuCount,
          gpus: gpu.gpus,
        },
      });
    } catch (error) {
      onUpdate({
        ...createMonitorBase(server, checkedAt),
        online: false,
        latencyMs: 0,
        localOnly: true,
        error: error instanceof Error ? error.message : "Local monitor failed",
      });
    } finally {
      sampling = false;
    }
  }

  void sample();
  const interval = setInterval(() => {
    void sample();
  }, MONITOR_INTERVAL_MS);

  return {
    close() {
      closed = true;
      clearInterval(interval);
    },
  };
}

function openMonitorExecStreamWithTimeout(channelPromise, timeoutMs, message) {
  let settled = false;
  let timedOut = false;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      timedOut = true;
      settled = true;
      reject(new Error(message));
    }, Math.max(1000, Number(timeoutMs) || MONITOR_OPEN_TIMEOUT_MS));
    timer.unref?.();

    channelPromise.then(
      (channel) => {
        if (timedOut) {
          try {
            channel?.close?.();
          } catch {
            // The delayed channel may already be closed.
          }
          return;
        }
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(channel);
      },
      (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function startSsh2BrokerMonitorStream(session, server, onUpdate, gateOptions = {}) {
  const startedAt = Date.now();
  const monitorBlockKey = getMonitorBlockKey(server);
  const existingBlock = monitorAuthBlocks.get(monitorBlockKey);

  if (existingBlock) {
    onUpdate(createMonitorBlockedResult(createMonitorBase(server), existingBlock));
    return { close() {} };
  }

  let channel;
  try {
    channel = await openMonitorExecStreamWithTimeout(
      openSsh2BrokerExecStream(
        session,
        server,
        createUsageStreamCommand(MONITOR_INTERVAL_MS),
        gateOptions,
      ),
      MONITOR_OPEN_TIMEOUT_MS,
      `SSH monitor stream did not open within ${Math.round(MONITOR_OPEN_TIMEOUT_MS / 1000)}s`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "SSH2 monitor failed");
    if (isSshAuthenticationFailure(message)) {
      const block = { blockedAt: new Date().toISOString(), error: message };
      monitorAuthBlocks.set(monitorBlockKey, block);
      onUpdate(createMonitorBlockedResult(createMonitorBase(server), block));
    } else {
      onUpdate({
        ...createMonitorBase(server),
        online: false,
        latencyMs: Date.now() - startedAt,
        error: message,
      });
    }
    return { close() {} };
  }

  const stream = channel.stream;
  let stdoutBuffer = "";
  let stderr = "";
  let closed = false;
  let firstMetricAt = 0;
  let lastOnline = null;
  const firstMetricTimer = setTimeout(() => {
    if (closed || firstMetricAt) {
      return;
    }
    const error = `Remote monitor did not return metrics within ${Math.round(MONITOR_FIRST_METRIC_TIMEOUT_MS / 1000)}s.`;
    update({
      ...createMonitorBase(server),
      online: false,
      latencyMs: Date.now() - startedAt,
      error,
    });
    closed = true;
    channel.close();
  }, MONITOR_FIRST_METRIC_TIMEOUT_MS);
  firstMetricTimer.unref?.();

  function update(nextState) {
    if (!closed) {
      onUpdate(nextState);
    }
  }

  function clearFirstMetricTimer() {
    if (firstMetricTimer) {
      clearTimeout(firstMetricTimer);
    }
  }

  function blockAuthFailure(error) {
    clearFirstMetricTimer();
    const block = {
      blockedAt: new Date().toISOString(),
      error,
    };
    monitorAuthBlocks.set(monitorBlockKey, block);
    update(createMonitorBlockedResult(createMonitorBase(server), block));
  }

  function handleParsedLine(parsed) {
    const checkedAt = Date.now();

    if (!parsed?.ok) {
      lastOnline = {
        ...createMonitorBase(server, checkedAt),
        online: false,
        latencyMs: firstMetricAt ? firstMetricAt - startedAt : checkedAt - startedAt,
        error: parsed?.error || "Remote metrics did not return JSON",
      };
      update(lastOnline);
      return;
    }

    if (!firstMetricAt) {
      firstMetricAt = checkedAt;
      clearFirstMetricTimer();
    }

    lastOnline = {
      ...createMonitorBase(server, checkedAt),
      online: true,
      latencyMs: firstMetricAt - startedAt,
      metrics: createUsageMetrics(parsed, server.name),
    };
    update(lastOnline);
  }

  stream.on("data", (chunk) => {
    stdoutBuffer = `${stdoutBuffer}${chunk.toString("utf8")}`;
    if (stdoutBuffer.length > 64 * 1024) {
      stdoutBuffer = stdoutBuffer.slice(-64 * 1024);
    }

    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        handleParsedLine(JSON.parse(trimmed));
      } catch {
        // Ignore login banners and shell noise before JSON lines.
      }
    }
  });

  stream.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000);
    if (!firstMetricAt && isSshAuthenticationFailure(stderr)) {
      blockAuthFailure(stderr.trim());
      closed = true;
      channel.close();
    }
  });

  stream.on("error", (error) => {
    clearFirstMetricTimer();
    update({
      ...createMonitorBase(server),
      online: false,
      latencyMs: Date.now() - startedAt,
      error: error.message,
    });
  });

  stream.on("close", (code) => {
    if (closed) {
      return;
    }
    clearFirstMetricTimer();

    const error = stderr.trim();
    if (!firstMetricAt && isSshAuthenticationFailure(error)) {
      blockAuthFailure(error);
      closed = true;
      return;
    }

    update({
      ...(lastOnline || createMonitorBase(server)),
      checkedAt: new Date().toISOString(),
      online: false,
      error: firstMetricAt
        ? `SSH2 monitor stream ended with code ${code ?? "unknown"}. Refresh the preview to reconnect.`
        : error || `SSH2 monitor failed with code ${code ?? "unknown"}`,
    });
    closed = true;
  });

  return {
    close() {
      if (closed) {
        return;
      }
      closed = true;
      clearFirstMetricTimer();
      channel.close();
    },
  };
}

async function startServerMonitorStream(session, server, onUpdate, gateOptions = {}) {
  if (canUseSsh2Broker(server)) {
    return startSsh2BrokerMonitorStream(session, server, onUpdate, gateOptions);
  }

  onUpdate({
    ...createMonitorBase(server),
    online: false,
    latencyMs: 0,
    error: ssh2RequiredMessage(server, "SSH monitor"),
  });
  return {
    close() {},
  };
}

function getMonitorStreamIdentity(server) {
  if (isSystemLocalServer(server)) {
    return "system|localhost";
  }

  const identity = [
    "remote",
    String(server.host || server.alias || server.name || "").trim().toLowerCase(),
    String(server.user || "").trim().toLowerCase(),
    Number(server.port || 22) || 22,
    String(server.identityFile || "").trim().toLowerCase(),
  ].join("|");
  return crypto.createHash("sha256").update(identity).digest("hex");
}

function getSharedMonitorStreamKey(session, server) {
  return `${getTerminalOwner(session)}:${getMonitorStreamIdentity(server)}`;
}

function projectMonitorStateForServer(state, server) {
  const checkedAtMs = Number.isFinite(Date.parse(state?.checkedAt || ""))
    ? Date.parse(state.checkedAt)
    : Date.now();
  const base = createMonitorBase(server, checkedAtMs);
  return {
    ...state,
    ...base,
    checkedAt: state?.checkedAt || base.checkedAt,
    localOnly: state?.localOnly ?? base.localOnly,
  };
}

function notifySharedMonitorSubscribers(stream) {
  for (const subscriber of stream.subscribers) {
    try {
      subscriber.onUpdate(projectMonitorStateForServer(stream.state, subscriber.server));
    } catch {
      // Subscriber callbacks are tied to WebSocket state; stale sockets are cleaned up by close handlers.
    }
  }
}

function setSharedMonitorState(stream, nextState) {
  if (!stream || stream.closed) {
    return;
  }

  stream.state = nextState;
  stream.lastUpdatedAt = Date.now();
  notifySharedMonitorSubscribers(stream);
}

function closeSharedMonitorStream(stream) {
  if (!stream || stream.closed) {
    return;
  }

  stream.closed = true;
  if (stream.closeTimer) {
    clearTimeout(stream.closeTimer);
    stream.closeTimer = null;
  }
  try {
    stream.monitor?.close?.();
  } catch {
    // The child monitor may already have exited.
  }
  stream.subscribers.clear();
  sharedMonitorStreams.delete(stream.key);
}

function releaseSharedMonitorSubscriber(stream, subscriber) {
  if (!stream || stream.closed) {
    return;
  }

  stream.subscribers.delete(subscriber);
  if (stream.subscribers.size > 0) {
    return;
  }

  if (MONITOR_SHARED_IDLE_TTL_MS <= 0) {
    closeSharedMonitorStream(stream);
    return;
  }

  stream.closeTimer = setTimeout(() => {
    if (stream.subscribers.size === 0) {
      closeSharedMonitorStream(stream);
    }
  }, MONITOR_SHARED_IDLE_TTL_MS);
  stream.closeTimer.unref?.();
}

async function acquireSharedMonitorStream(session, server, onUpdate, gateOptions = {}) {
  const key = getSharedMonitorStreamKey(session, server);
  let stream = sharedMonitorStreams.get(key);
  let shouldStart = false;

  if (!stream || stream.closed) {
    stream = {
      key,
      server,
      subscribers: new Set(),
      monitor: null,
      closeTimer: null,
      state: createMonitorPendingResult(server),
      createdAt: Date.now(),
      lastUpdatedAt: Date.now(),
      starting: true,
      closed: false,
    };
    sharedMonitorStreams.set(key, stream);
    shouldStart = true;
  } else if (stream.closeTimer) {
    clearTimeout(stream.closeTimer);
    stream.closeTimer = null;
  }

  const subscriber = {
    id: `monitor_sub_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`,
    server,
    onUpdate,
  };
  stream.subscribers.add(subscriber);
  onUpdate(projectMonitorStateForServer(stream.state, server));

  if (shouldStart) {
    try {
      const monitor = await (isSystemLocalServer(server)
        ? startLocalMonitorStream(server, (nextState) => setSharedMonitorState(stream, nextState))
        : startServerMonitorStream(
            session,
            server,
            (nextState) => setSharedMonitorState(stream, nextState),
            gateOptions,
          ));
      if (stream.closed) {
        monitor.close();
      } else {
        stream.monitor = monitor;
        stream.starting = false;
        if (stream.subscribers.size === 0) {
          releaseSharedMonitorSubscriber(stream, subscriber);
        }
      }
    } catch (error) {
      closeSharedMonitorStream(stream);
      throw error;
    }
  }

  return {
    close() {
      releaseSharedMonitorSubscriber(stream, subscriber);
    },
  };
}

function createBrowseCommand(remotePath, maxItems = 2000) {
  const script = String.raw`
import json
import os
import stat
import sys

target = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else ".")
max_items = max(100, int(sys.argv[2] if len(sys.argv) > 2 else 2000))
root = os.path.abspath(target)
items = []

try:
    with os.scandir(root) as iterator:
        for entry in iterator:
            if len(items) > max_items:
                break
            try:
                info = entry.stat(follow_symlinks=False)
                mode = info.st_mode
                item_type = "directory" if stat.S_ISDIR(mode) else "symlink" if stat.S_ISLNK(mode) else "file"
                items.append({
                    "name": entry.name,
                    "path": os.path.join(root, entry.name),
                    "type": item_type,
                    "isDirectory": item_type == "directory",
                    "size": info.st_size,
                    "mtime": int(info.st_mtime),
                    "mode": oct(stat.S_IMODE(mode)),
                })
            except OSError as error:
                items.append({
                    "name": entry.name,
                    "path": os.path.join(root, entry.name),
                    "type": "unknown",
                    "isDirectory": False,
                    "size": 0,
                    "mtime": 0,
                    "mode": "",
                    "error": str(error),
                })

    total_items = len(items)
    items.sort(key=lambda item: (not item["isDirectory"], item["name"].lower()))
    if total_items > max_items:
        items = items[:max_items]
    print(json.dumps({
        "ok": True,
        "path": root,
        "parent": os.path.dirname(root),
        "items": items,
        "totalItems": total_items,
        "maxItems": max_items,
        "truncated": total_items > max_items,
    }, ensure_ascii=False))
except Exception as error:
    print(json.dumps({
        "ok": False,
        "path": target,
        "error": str(error),
    }, ensure_ascii=False))
    sys.exit(2)
`.trim();

  return `if command -v python3 >/dev/null 2>&1; then _cozypad_py=python3; elif command -v python >/dev/null 2>&1; then _cozypad_py=python; else echo '{"ok":false,"error":"python3/python not found on remote host"}'; exit 127; fi; "$_cozypad_py" - ${shellQuote(
    remotePath || "~",
  )} ${shellQuote(String(maxItems))} <<'PY'\n${script}\nPY`;
}

function createFilePreviewCommand(remotePath, maxBytes = 12 * 1024 * 1024) {
  const script = String.raw`
import base64
import json
import mimetypes
import os
import sys

TEXT_EXTENSIONS = {
    ".bashrc", ".bat", ".cfg", ".conf", ".config", ".cpp", ".cs", ".css", ".csv",
    ".env", ".go", ".h", ".hpp", ".html", ".ini", ".java", ".js", ".json", ".jsx",
    ".log", ".lua", ".m", ".md", ".markdown", ".php", ".ps1", ".py", ".r", ".rb",
    ".rs", ".sh", ".sql", ".tex", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
}
IMAGE_EXTENSIONS = {
    ".apng", ".avif", ".bmp", ".gif", ".ico", ".jpeg", ".jpg", ".png",
    ".svg", ".tif", ".tiff", ".webp",
}
AUDIO_EXTENSIONS = {
    ".aac", ".aif", ".aiff", ".flac", ".m4a", ".mp3", ".oga", ".ogg", ".opus", ".wav", ".weba",
}
VIDEO_EXTENSIONS = {
    ".avi", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".ogv", ".webm", ".wmv",
}

target = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else ".")
max_bytes = int(sys.argv[2] if len(sys.argv) > 2 else 12582912)
path = os.path.abspath(target)

try:
    info = os.stat(path)
    if not os.path.isfile(path):
        raise ValueError("Target is not a regular file")
    if info.st_size > max_bytes:
        raise ValueError(f"File is too large for preview ({info.st_size} bytes)")

    with open(path, "rb") as handle:
        content = handle.read()

    extension = os.path.splitext(path)[1].lower()
    mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
    sample = content[:4096]
    is_text = False

    if extension in {".md", ".markdown"}:
        kind = "markdown"
        mime = "text/markdown"
    elif extension == ".pdf" or mime == "application/pdf":
        kind = "pdf"
        mime = "application/pdf"
    elif extension in IMAGE_EXTENSIONS or mime.startswith("image/"):
        kind = "image"
        if mime == "application/octet-stream":
            mime = {
                ".apng": "image/apng",
                ".avif": "image/avif",
                ".bmp": "image/bmp",
                ".gif": "image/gif",
                ".ico": "image/x-icon",
                ".jpeg": "image/jpeg",
                ".jpg": "image/jpeg",
                ".png": "image/png",
                ".svg": "image/svg+xml",
                ".tif": "image/tiff",
                ".tiff": "image/tiff",
                ".webp": "image/webp",
            }.get(extension, "image/*")
    elif extension in AUDIO_EXTENSIONS or mime.startswith("audio/"):
        kind = "audio"
        if mime == "application/octet-stream":
            mime = {
                ".aac": "audio/aac",
                ".aif": "audio/aiff",
                ".aiff": "audio/aiff",
                ".flac": "audio/flac",
                ".m4a": "audio/mp4",
                ".mp3": "audio/mpeg",
                ".oga": "audio/ogg",
                ".ogg": "audio/ogg",
                ".opus": "audio/ogg",
                ".wav": "audio/wav",
                ".weba": "audio/webm",
            }.get(extension, "audio/*")
    elif extension in VIDEO_EXTENSIONS or mime.startswith("video/"):
        kind = "video"
        if mime == "application/octet-stream":
            mime = {
                ".avi": "video/x-msvideo",
                ".m4v": "video/mp4",
                ".mkv": "video/x-matroska",
                ".mov": "video/quicktime",
                ".mp4": "video/mp4",
                ".mpeg": "video/mpeg",
                ".mpg": "video/mpeg",
                ".ogv": "video/ogg",
                ".webm": "video/webm",
                ".wmv": "video/x-ms-wmv",
            }.get(extension, "video/*")
    else:
        if mime.startswith("text/") or extension in TEXT_EXTENSIONS:
            is_text = True
        elif b"\x00" not in sample:
            try:
                sample.decode("utf-8")
                is_text = True
            except UnicodeDecodeError:
                try:
                    sample.decode("utf-16")
                    is_text = True
                except UnicodeDecodeError:
                    is_text = False

        kind = "text" if is_text else "binary"
        if is_text and mime == "application/octet-stream":
            mime = "text/plain"

    print(json.dumps({
        "ok": True,
        "path": path,
        "name": os.path.basename(path),
        "size": info.st_size,
        "mtime": int(info.st_mtime),
        "mime": mime,
        "kind": kind,
        "encoding": "base64",
        "contentBase64": base64.b64encode(content).decode("ascii"),
    }, ensure_ascii=False))
except Exception as error:
    print(json.dumps({
        "ok": False,
        "path": path,
        "error": str(error),
    }, ensure_ascii=False))
    sys.exit(2)
`.trim();

  return `if command -v python3 >/dev/null 2>&1; then _cozypad_py=python3; elif command -v python >/dev/null 2>&1; then _cozypad_py=python; else echo '{"ok":false,"error":"python3/python not found on remote host"}'; exit 127; fi; "$_cozypad_py" - ${shellQuote(
    remotePath || "~",
  )} ${shellQuote(String(maxBytes))} <<'PY'\n${script}\nPY`;
}

function isMarkdownSummaryServer(server) {
  const keyword = MARKDOWN_SUMMARY_SERVER_KEYWORD.toLowerCase();
  if (!keyword) {
    return false;
  }

  return [server.id, server.name, server.alias, server.host]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(keyword);
}

async function findMarkdownSummaryServer(session, serverId = "") {
  if (serverId) {
    return findServer(serverId, session);
  }

  const servers = await listServers(session, { includeInternal: true });
  return servers.find(isMarkdownSummaryServer) || null;
}

function normalizeMarkdownSummaryPayload(body) {
  const rawFiles = Array.isArray(body.files) ? body.files : [];
  if (rawFiles.length === 0) {
    throw new Error("至少需要加入一個 markdown 或 text 檔案");
  }

  if (rawFiles.length > MARKDOWN_SUMMARY_MAX_FILES) {
    throw new Error(`一次最多只能整理 ${MARKDOWN_SUMMARY_MAX_FILES} 個檔案`);
  }

  let totalBytes = 0;
  const files = rawFiles.map((file, index) => {
    const name = sanitizeText(file?.name || `note-${index + 1}.md`).slice(0, 180);
    const content = String(file?.content || "");
    const extension = path.extname(name).replace(/^\./, "").toLowerCase();

    if (!["md", "markdown", "txt"].includes(extension)) {
      throw new Error(`${name} 不是支援的 .md/.markdown/.txt 檔案`);
    }

    const size = Buffer.byteLength(content, "utf8");
    totalBytes += size;
    if (totalBytes > MARKDOWN_SUMMARY_MAX_TOTAL_BYTES) {
      throw new Error(
        `檔案總大小超過 ${Math.round(MARKDOWN_SUMMARY_MAX_TOTAL_BYTES / 1024 / 1024)} MB`,
      );
    }

    return {
      name,
      extension,
      content,
      size,
    };
  });

  return {
    modelPath: MARKDOWN_SUMMARY_MODEL_PATH,
    instruction: sanitizeText(body.instruction || ""),
    files,
    totalBytes,
    createdAt: new Date().toISOString(),
  };
}

function createMarkdownSummaryCommand() {
  const script = String.raw`
import importlib.util
import json
import os
import sys
import traceback

payload_path = sys.argv[1]
api_path = sys.argv[2]
model_path = sys.argv[3] if len(sys.argv) > 3 else ""

try:
    with open(payload_path, "r", encoding="utf-8") as handle:
        payload = json.load(handle)

    payload["modelPath"] = payload.get("modelPath") or model_path
    os.environ.setdefault("COZYPAD_MARKDOWN_MODEL_PATH", model_path)

    if not os.path.isfile(api_path):
        raise FileNotFoundError(api_path)

    spec = importlib.util.spec_from_file_location("cozypad_markdown_summary_api", api_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot import {api_path}")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    function_names = (
        "summarize_files",
        "summarize_markdown_files",
        "summarize_markdown",
        "summarize",
    )
    summary_fn = next(
        (getattr(module, name, None) for name in function_names if callable(getattr(module, name, None))),
        None,
    )
    if summary_fn is None:
        raise RuntimeError(
            "markdown_summary_api.py must export summarize_files(payload), "
            "summarize_markdown_files(payload), summarize_markdown(payload), or summarize(payload)"
        )

    try:
        result = summary_fn(payload)
    except TypeError as first_error:
        try:
            result = summary_fn(
                payload.get("files", []),
                model_path=payload.get("modelPath") or model_path,
                instruction=payload.get("instruction", ""),
            )
        except TypeError:
            raise first_error

    if result is None:
        result = {"ok": True, "summary": ""}
    elif isinstance(result, str):
        result = {"ok": True, "summary": result}
    elif not isinstance(result, dict):
        result = {"ok": True, "result": result}

    result.setdefault("ok", True)
    if model_path:
        result.setdefault("modelPath", model_path)
    result.setdefault("fileCount", len(payload.get("files", [])))
    print(json.dumps(result, ensure_ascii=False))
except Exception as error:
    print(json.dumps({
        "ok": False,
        "error": str(error),
        "traceback": traceback.format_exc(limit=6),
    }, ensure_ascii=False))
    sys.exit(2)
`.trim();

  return [
    "if command -v python3 >/dev/null 2>&1; then _cozypad_py=python3; elif command -v python >/dev/null 2>&1; then _cozypad_py=python; else echo '{\"ok\":false,\"error\":\"python3/python not found on remote host\"}'; exit 127; fi",
    "_cozypad_payload=$(mktemp /tmp/cozypad_markdown_payload.XXXXXX.json)",
    "trap 'rm -f \"$_cozypad_payload\"' EXIT",
    "cat > \"$_cozypad_payload\"",
    `"$_cozypad_py" - "$_cozypad_payload" ${shellQuote(MARKDOWN_SUMMARY_SCRIPT)} ${shellQuote(
      MARKDOWN_SUMMARY_MODEL_PATH,
    )} <<'PY'\n${script}\nPY`,
  ].join("; ");
}

function normalizeResearchFlowchartPayload(body) {
  const rawNodes = Array.isArray(body.nodes) ? body.nodes : [];
  const rawEdges = Array.isArray(body.edges) ? body.edges : [];

  if (rawNodes.length === 0) {
    throw new Error("流程圖至少需要一個方塊");
  }

  if (rawNodes.length > FLOWCHART_MARKDOWN_MAX_NODES) {
    throw new Error(`流程圖方塊最多只能有 ${FLOWCHART_MARKDOWN_MAX_NODES} 個`);
  }

  if (rawEdges.length > FLOWCHART_MARKDOWN_MAX_EDGES) {
    throw new Error(`流程圖連線最多只能有 ${FLOWCHART_MARKDOWN_MAX_EDGES} 條`);
  }

  const usedNodeIds = new Set();
  const nodes = rawNodes.map((node, index) => {
    const id = sanitizeText(node?.id || `node-${index + 1}`).slice(0, 96);
    if (!id || usedNodeIds.has(id)) {
      throw new Error("流程圖方塊 id 重複或無效");
    }
    usedNodeIds.add(id);

    return {
      id,
      kind: sanitizeText(node?.kind || "node").slice(0, 64),
      title: sanitizeText(node?.title || id).slice(0, 180),
      subtitle: sanitizeText(node?.subtitle || "").slice(0, 220),
      role: sanitizeText(node?.role || "").slice(0, 64),
      x: Number.isFinite(Number(node?.x)) ? Number(node.x) : 0,
      y: Number.isFinite(Number(node?.y)) ? Number(node.y) : 0,
      inputs: Math.max(0, Number(node?.inputs || 0) || 0),
      outputs: Math.max(0, Number(node?.outputs || 0) || 0),
    };
  });

  const nodeTitles = new Map(nodes.map((node) => [node.id, node.title]));
  const usedEdgeIds = new Set();
  const edges = rawEdges.map((edge, index) => {
    const from = sanitizeText(edge?.from || "");
    const to = sanitizeText(edge?.to || "");
    if (!usedNodeIds.has(from) || !usedNodeIds.has(to) || from === to) {
      throw new Error("流程圖連線包含無效方塊");
    }

    const fallbackId = `${from}-${to}`;
    const id = sanitizeText(edge?.id || fallbackId).slice(0, 120) || `edge-${index + 1}`;
    if (usedEdgeIds.has(id)) {
      throw new Error("流程圖連線 id 重複");
    }
    usedEdgeIds.add(id);

    return {
      id,
      from,
      to,
      fromTitle: sanitizeText(edge?.fromTitle || nodeTitles.get(from) || from).slice(0, 180),
      toTitle: sanitizeText(edge?.toTitle || nodeTitles.get(to) || to).slice(0, 180),
    };
  });

  const payload = {
    modelPath: FLOWCHART_MARKDOWN_MODEL_PATH || undefined,
    task: "training-flowchart-markdown",
    instruction:
      sanitizeText(body.instruction || "") ||
      "請將這個訓練流程圖整理成 Markdown，包含流程彙整、節點確認、連線確認、風險與下一步。",
    note: sanitizeText(body.note || body.naturalNote || "").slice(0, 20000),
    nodes,
    edges,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    createdAt: new Date().toISOString(),
  };

  return {
    ...payload,
    filename: "cozypad-flowchart.png",
    imageBase64: createFlowchartImageBase64(payload),
    detailLevel: "detailed",
    maxNewTokens: 2048,
    instruction: formatFlowchartInstruction(payload),
  };
}

function formatBatchFlowchartPrompt(item) {
  return [
    "請使用 SSH server 上的 flowchart_markdown_api.py 進行 batch flowchart markdown 分析。",
    "要求：使用 8bit 載入，根據目前空閒 GPU 自動選卡；同一批會平行分析 2 到 3 個檔案。",
    "請針對此檔案輸出約 500 字，維持學術分析價值，避免只列空泛清單。",
    "每個檔案都要包含：1. 模型建議 2. 超參數建議 3. 資料前處理建議 4. 模型評估建議 5. 整體建議。",
    "",
    item.instruction || "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatBatchFlowchartPromptV2(item) {
  return [
    "Use flowchart_markdown_api.py on the SSH server for batch flowchart markdown analysis.",
    `Image index in this batch: ${Number(item.index || 0) + 1}.`,
    `File name: ${item.fileName || item.title || item.id || `flowchart-${Number(item.index || 0) + 1}.png`}.`,
    "Analyze only this image/file and produce recommendations dedicated to this item.",
    "Do not reuse, copy, merge, or generalize conclusions from other images in the same batch.",
    "Use 8bit loading, select idle GPUs automatically, and process 2 to 3 files in parallel.",
    "Write about 500 Chinese characters for this file.",
    "The output must include five sections: 1. 模型建議 2. 超參數建議 3. 資料前處理建議 4. 模型評估建議 5. 整體建議.",
    "",
    item.instruction || "",
  ]
    .filter(Boolean)
    .join("\n");
}

function normalizeResearchFlowchartBatchPayload(body) {
  const rawItems = Array.isArray(body.items) ? body.items : Array.isArray(body.files) ? body.files : [];
  if (
    rawItems.length < FLOWCHART_MARKDOWN_BATCH_MIN_FILES ||
    rawItems.length > FLOWCHART_MARKDOWN_BATCH_MAX_FILES
  ) {
    throw new Error(
      `batch flowchart markdown analysis requires ${FLOWCHART_MARKDOWN_BATCH_MIN_FILES} to ${FLOWCHART_MARKDOWN_BATCH_MAX_FILES} files`,
    );
  }

  const items = rawItems.map((rawItem, index) => {
    const normalized = normalizeResearchFlowchartPayload({
      ...body,
      ...rawItem,
      instruction: rawItem?.instruction || rawItem?.prompt || body.instruction || "",
    });
    const id = sanitizeText(rawItem?.id || `flowchart-${index + 1}`).slice(0, 96) || `flowchart-${index + 1}`;
    const title = sanitizeText(rawItem?.title || id).slice(0, 180) || id;
    const fileName =
      sanitizeText(rawItem?.fileName || rawItem?.name || `${id}.png`).slice(0, 180) || `${id}.png`;
    return {
      ...normalized,
      id,
      title,
      fileName,
      prompt: formatBatchFlowchartPromptV2({
        ...normalized,
        index,
        id,
        title,
        fileName,
        instruction: rawItem?.instruction || rawItem?.prompt || normalized.instruction,
      }),
    };
  });
  const totalImageBase64Bytes = items.reduce((total, item, index) => {
    const imageBytes = Buffer.byteLength(String(item.imageBase64 || ""), "utf8");
    if (imageBytes > FLOWCHART_MARKDOWN_BATCH_MAX_IMAGE_BASE64_BYTES) {
      throw new Error(
        `${item.fileName || `flowchart-${index + 1}.png`} image_base64 is too large; limit is ${Math.round(
          FLOWCHART_MARKDOWN_BATCH_MAX_IMAGE_BASE64_BYTES / 1024 / 1024,
        )} MB`,
      );
    }
    return total + imageBytes;
  }, 0);
  if (totalImageBase64Bytes > FLOWCHART_MARKDOWN_BATCH_MAX_BODY_BYTES) {
    throw new Error(
      `batch flowchart image payload is too large; limit is ${Math.round(
        FLOWCHART_MARKDOWN_BATCH_MAX_BODY_BYTES / 1024 / 1024,
      )} MB`,
    );
  }

  return {
    task: "training-flowchart-markdown-batch",
    endpointUrl: FLOWCHART_MARKDOWN_BATCH_URL,
    fileCount: items.length,
    totalImageBase64Bytes,
    nodeCount: items.reduce((total, item) => total + Number(item.nodeCount || 0), 0),
    edgeCount: items.reduce((total, item) => total + Number(item.edgeCount || 0), 0),
    createdAt: new Date().toISOString(),
    items,
  };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function encodeRgbaPng(width, height, rgba) {
  const scanlineLength = width * 4 + 1;
  const raw = Buffer.alloc(scanlineLength * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * scanlineLength] = 0;
    rgba.copy(raw, y * scanlineLength + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 6 })),
    pngChunk("IEND"),
  ]);
}

function drawPixel(rgba, width, height, x, y, color) {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= width || py >= height) {
    return;
  }
  const offset = (py * width + px) * 4;
  rgba[offset] = color[0];
  rgba[offset + 1] = color[1];
  rgba[offset + 2] = color[2];
  rgba[offset + 3] = color[3] ?? 255;
}

function drawLine(rgba, width, height, x1, y1, x2, y2, color, thickness = 2) {
  let x = Math.round(x1);
  let y = Math.round(y1);
  const targetX = Math.round(x2);
  const targetY = Math.round(y2);
  const dx = Math.abs(targetX - x);
  const sx = x < targetX ? 1 : -1;
  const dy = -Math.abs(targetY - y);
  const sy = y < targetY ? 1 : -1;
  let error = dx + dy;
  const radius = Math.max(0, Math.floor(thickness / 2));

  while (true) {
    for (let oy = -radius; oy <= radius; oy += 1) {
      for (let ox = -radius; ox <= radius; ox += 1) {
        drawPixel(rgba, width, height, x + ox, y + oy, color);
      }
    }
    if (x === targetX && y === targetY) break;
    const nextError = 2 * error;
    if (nextError >= dy) {
      error += dy;
      x += sx;
    }
    if (nextError <= dx) {
      error += dx;
      y += sy;
    }
  }
}

function drawRect(rgba, width, height, x, y, rectWidth, rectHeight, fill, border) {
  const left = Math.max(0, Math.round(x));
  const top = Math.max(0, Math.round(y));
  const right = Math.min(width - 1, Math.round(x + rectWidth));
  const bottom = Math.min(height - 1, Math.round(y + rectHeight));

  for (let py = top; py <= bottom; py += 1) {
    for (let px = left; px <= right; px += 1) {
      const isBorder = px === left || px === right || py === top || py === bottom;
      drawPixel(rgba, width, height, px, py, isBorder ? border : fill);
    }
  }
}

function createFlowchartImageBase64(payload) {
  const width = 1280;
  const height = 720;
  const rgba = Buffer.alloc(width * height * 4);
  const background = [14, 20, 18, 255];
  for (let index = 0; index < rgba.length; index += 4) {
    rgba[index] = background[0];
    rgba[index + 1] = background[1];
    rgba[index + 2] = background[2];
    rgba[index + 3] = background[3];
  }

  for (let x = 0; x < width; x += 32) {
    drawLine(rgba, width, height, x, 0, x, height - 1, [31, 42, 39, 255], 1);
  }
  for (let y = 0; y < height; y += 32) {
    drawLine(rgba, width, height, 0, y, width - 1, y, [31, 42, 39, 255], 1);
  }

  const nodeMap = new Map(payload.nodes.map((node) => [node.id, node]));
  const nodeWidth = 150;
  const nodeHeight = 82;

  for (const edge of payload.edges) {
    const from = nodeMap.get(edge.from);
    const to = nodeMap.get(edge.to);
    if (!from || !to) continue;
    const sx = (from.x / 100) * width + nodeWidth / 2;
    const sy = (from.y / 100) * height;
    const tx = (to.x / 100) * width - nodeWidth / 2;
    const ty = (to.y / 100) * height;
    drawLine(rgba, width, height, sx, sy, tx, ty, [34, 197, 94, 255], 4);
  }

  const roleColors = {
    input: [[18, 36, 45, 255], [141, 215, 255, 255]],
    factor: [[21, 28, 53, 255], [111, 140, 255, 255]],
    control: [[45, 37, 18, 255], [243, 199, 74, 255]],
    runner: [[18, 42, 25, 255], [121, 214, 122, 255]],
    outcome: [[48, 27, 22, 255], [255, 138, 101, 255]],
    application: [[38, 26, 50, 255], [192, 132, 252, 255]],
  };

  for (const node of payload.nodes) {
    const [fill, border] = roleColors[node.role] || [[26, 32, 30, 255], [95, 110, 105, 255]];
    const x = (node.x / 100) * width - nodeWidth / 2;
    const y = (node.y / 100) * height - nodeHeight / 2;
    drawRect(rgba, width, height, x, y, nodeWidth, nodeHeight, fill, border);
  }

  return encodeRgbaPng(width, height, rgba).toString("base64");
}

function formatFlowchartInstruction(payload) {
  const nodeLines = payload.nodes.map(
    (node, index) =>
      `${index + 1}. ${node.title} [${node.kind}/${node.role}] - ${node.subtitle || "no note"}; inputs=${node.inputs}; outputs=${node.outputs}`,
  );
  const edgeLines = payload.edges.map(
    (edge, index) => `${index + 1}. ${edge.fromTitle} -> ${edge.toTitle}`,
  );

  return [
    payload.instruction,
    "",
    "以下是 CozyPad 畫布送出的實際流程圖資料。圖片中方塊與綠色線只是視覺位置參考；請以這份節點與連線資料作為主要依據。",
    "",
    "Nodes:",
    ...nodeLines,
    "",
    "Edges:",
    ...(edgeLines.length ? edgeLines : ["- 尚未建立連線"]),
    "",
    payload.note ? `補充說明:\n${payload.note}` : "",
    "",
    "請回傳 Markdown，內容要聚焦在訓練流程的彙整與確認，不要回傳 JSON。",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function bailianFlowchartSystemPrompt() {
  return [
    "你是 CozyPad 的研究流程圖分析助手。",
    "你會根據流程圖節點、連線、角色與使用者指令產生可直接放入 CozyPad 的 Markdown。",
    "只回傳使用者要求的內容，不要回傳 JSON、程式碼區塊、前後解釋或模型自我描述。",
  ].join("\n");
}

function buildBailianFlowchartMarkdownPrompt(payload) {
  return [
    "請根據下列 CozyPad 研究流程圖產生 MD.md。",
    "內容必須包含：流程彙整、節點確認、連線確認、訓練排程、checkpoints、required logs、metrics、risk notes、下一步。",
    "請使用繁體中文，條理清楚，輸出 Markdown。",
    "",
    payload.instruction || formatFlowchartInstruction(payload),
  ].join("\n");
}

function buildBailianMixFlowchartPrompt(item) {
  return [
    `請產生 MD.mix 的一個 Markdown 檔案：${item.fileName || item.title || item.id || "analysis.md"}`,
    `主題：${item.title || item.id || "analysis"}`,
    "請使用繁體中文，約 500 個中文字，內容必須包含：模型建議、超參數建議、資料前處理建議、模型評估建議、整體建議。",
    "請專注此檔案主題，不要混合其他 topic，不要輸出 JSON。",
    "",
    "Topic instruction:",
    item.prompt || "",
    "",
    "Flowchart context:",
    item.instruction || formatFlowchartInstruction(item),
  ].join("\n");
}

async function runResearchFlowchartBailianJob(job) {
  const payload = job.payload || {};
  const model = normalizeBailianModelOption(job.model);
  if (job.batch) {
    const items = [];
    for (const item of payload.items || []) {
      const completion = await requestBailianChatCompletion(
        job.apiKey,
        [
          { role: "system", content: bailianFlowchartSystemPrompt() },
          { role: "user", content: buildBailianMixFlowchartPrompt(item) },
        ],
        { timeoutMs: FLOWCHART_MARKDOWN_TIMEOUT_MS, model },
      );
      const markdown = String(completion.text || "").trim();
      if (!markdown) {
        throw new Error(`${item.title || item.id || "MD.mix item"} did not return Markdown content`);
      }
      items.push({
        id: item.id,
        title: item.title,
        fileName: item.fileName,
        ok: true,
        markdown,
      });
    }
    Object.assign(job, {
      ok: true,
      status: "completed",
      items,
      results: items,
      fileCount: items.length,
      model,
      modelPath: `${model} via Bailian`,
      concurrency: Math.min(3, Math.max(1, items.length)),
      error: "",
    });
    return;
  }

  const completion = await requestBailianChatCompletion(
    job.apiKey,
    [
      { role: "system", content: bailianFlowchartSystemPrompt() },
      { role: "user", content: buildBailianFlowchartMarkdownPrompt(payload) },
    ],
    { timeoutMs: FLOWCHART_MARKDOWN_TIMEOUT_MS, model },
  );
  const markdown = String(completion.text || "").trim();
  if (!markdown) {
    throw new Error("Bailian did not return Markdown content");
  }
  Object.assign(job, {
    ok: true,
    status: "completed",
    markdown,
    summary: markdown,
    content: markdown,
    model,
    modelPath: `${model} via Bailian`,
    nodeCount: payload.nodeCount,
    edgeCount: payload.edgeCount,
    error: "",
  });
}

function createFlowchartMarkdownCommand() {
  const script = String.raw`
import importlib.util
import json
import os
import shlex
import subprocess
import sys
import traceback

payload_path = sys.argv[1]
api_path = sys.argv[2]
model_path = sys.argv[3]

def coerce_result(result, payload):
    if result is None:
        result = {"ok": True, "markdown": ""}
    elif isinstance(result, str):
        result = {"ok": True, "markdown": result}
    elif not isinstance(result, dict):
        result = {"ok": True, "result": result}

    markdown = (
        result.get("markdown")
        or result.get("summary")
        or result.get("content")
        or (result.get("result") if isinstance(result.get("result"), str) else "")
    )
    if markdown and "markdown" not in result:
        result["markdown"] = markdown

    result.setdefault("ok", True)
    result.setdefault("modelPath", model_path)
    result.setdefault("nodeCount", len(payload.get("nodes", [])))
    result.setdefault("edgeCount", len(payload.get("edges", [])))
    return result

def parse_subprocess_stdout(stdout):
    text = (stdout or "").strip()
    if not text:
        return {"ok": True, "markdown": ""}
    try:
        return json.loads(text)
    except Exception:
        for line in reversed([line.strip() for line in text.splitlines() if line.strip()]):
            if line.startswith("{") and line.endswith("}"):
                try:
                    return json.loads(line)
                except Exception:
                    pass
    return {"ok": True, "markdown": text}

def api_python_command(api_path):
    try:
        with open(api_path, "r", encoding="utf-8", errors="ignore") as handle:
            first_line = handle.readline().strip()
        if first_line.startswith("#!"):
            parts = shlex.split(first_line[2:].strip())
            if parts:
                executable = parts[0]
                if executable == "/usr/bin/env" and len(parts) > 1:
                    return parts
                if os.path.isfile(executable) and os.access(executable, os.X_OK):
                    return parts
    except Exception:
        pass
    return [sys.executable]

try:
    with open(payload_path, "r", encoding="utf-8") as handle:
        payload = json.load(handle)

    if model_path:
        payload["modelPath"] = payload.get("modelPath") or model_path
        os.environ.setdefault("COZYPAD_FLOWCHART_MODEL_PATH", model_path)

    if not os.path.isfile(api_path):
        raise FileNotFoundError(api_path)

    dry_command = api_python_command(api_path) + [api_path, "--dry-run"]
    if model_path:
        dry_command.extend(["--model-path", model_path])
    dry = subprocess.run(
        dry_command,
        text=True,
        capture_output=True,
        timeout=90,
    )
    if dry.returncode != 0:
        print(json.dumps(coerce_result({
            "ok": False,
            "error": (dry.stderr or dry.stdout or f"flowchart api dry-run exited with code {dry.returncode}").strip(),
            "stderr": dry.stderr.strip(),
        }, payload), ensure_ascii=False))
        sys.exit(2)

    direct_command = api_python_command(api_path) + [
        api_path,
        "--flowchart-image-json",
        payload_path,
    ]
    direct = subprocess.run(
        direct_command,
        text=True,
        capture_output=True,
        timeout=int(payload.get("timeoutSeconds") or payload.get("timeout_seconds") or 600) + 30,
    )
    direct_result = parse_subprocess_stdout(direct.stdout)
    if direct.returncode != 0 and direct_result.get("ok", True):
        direct_result = {
            "ok": False,
            "error": (direct.stderr or direct.stdout or f"flowchart api exited with code {direct.returncode}").strip(),
        }
    if direct.stderr and "stderr" not in direct_result:
        direct_result["stderr"] = direct.stderr.strip()
    print(json.dumps(coerce_result(direct_result, payload), ensure_ascii=False))
    sys.exit(0 if direct_result.get("ok") else 2)

    spec = importlib.util.spec_from_file_location("cozypad_flowchart_markdown_api", api_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot import {api_path}")

    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)

    function_names = (
        "parse_flowchart_image",
        "analyze_flowchart",
        "flowchart_to_markdown",
        "summarize_flowchart",
        "summarize_pipeline",
        "generate_markdown",
        "summarize",
        "analyze",
        "run",
        "main",
    )
    flow_fn = next(
        (getattr(module, name, None) for name in function_names if callable(getattr(module, name, None))),
        None,
    )

    if flow_fn is None:
        payload_text = json.dumps(payload, ensure_ascii=False)
        completed = subprocess.run(
            [sys.executable, api_path],
            input=payload_text,
            text=True,
            capture_output=True,
            timeout=600,
        )
        if completed.returncode != 0:
            completed = subprocess.run(
                [sys.executable, api_path, payload_path, model_path],
                text=True,
                capture_output=True,
                timeout=600,
            )
        if completed.returncode != 0:
            raise RuntimeError((completed.stderr or completed.stdout or "flowchart api failed").strip())
        result = parse_subprocess_stdout(completed.stdout)
    else:
        try:
            result = flow_fn(payload)
        except TypeError as first_error:
            try:
                result = flow_fn(
                    payload.get("nodes", []),
                    payload.get("edges", []),
                    model_path=payload.get("modelPath") or model_path,
                    instruction=payload.get("instruction", ""),
                    note=payload.get("note", ""),
                )
            except TypeError:
                raise first_error

    print(json.dumps(coerce_result(result, payload), ensure_ascii=False))
except Exception as error:
    print(json.dumps({
        "ok": False,
        "error": str(error),
        "traceback": traceback.format_exc(limit=6),
    }, ensure_ascii=False))
    sys.exit(2)
`.trim();

  return [
    "if command -v python3 >/dev/null 2>&1; then _cozypad_py=python3; elif command -v python >/dev/null 2>&1; then _cozypad_py=python; else echo '{\"ok\":false,\"error\":\"python3/python not found on remote host\"}'; exit 127; fi",
    "_cozypad_payload=$(mktemp /tmp/cozypad_flowchart_payload.XXXXXX.json)",
    "trap 'rm -f \"$_cozypad_payload\"' EXIT",
    "cat > \"$_cozypad_payload\"",
    `"$_cozypad_py" - "$_cozypad_payload" ${shellQuote(FLOWCHART_MARKDOWN_SCRIPT)} ${shellQuote(
      FLOWCHART_MARKDOWN_MODEL_PATH,
    )} <<'PY'\n${script}\nPY`,
  ].join("; ");
}

function createFlowchartMarkdownBatchCommand() {
  const script = String.raw`
import base64
import json
import os
import re
import sys
import tempfile
import traceback
import urllib.error
import urllib.request

payload_path = sys.argv[1]
endpoint_url = sys.argv[2]

def safe_name(value, fallback):
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", str(value or "").strip())
    return name[:120] or fallback

def extract_markdown(value):
    if isinstance(value, str):
        return value
    if not isinstance(value, dict):
        return ""
    for key in ("markdown", "summary", "content", "text", "output"):
        candidate = value.get(key)
        if isinstance(candidate, str) and candidate.strip():
            return candidate
    result = value.get("result")
    if isinstance(result, str):
        return result
    if isinstance(result, dict):
        return extract_markdown(result)
    return ""

def normalize_results(raw, payload_items, request_files):
    if not isinstance(raw, dict):
        raw = {"ok": True, "results": raw}

    raw_results = raw.get("results") or raw.get("items") or raw.get("files") or raw.get("data") or []
    if isinstance(raw_results, dict):
        mapped = []
        for item, request_file in zip(payload_items, request_files):
            key_candidates = [
                item.get("id"),
                item.get("title"),
                item.get("fileName"),
                request_file.get("filename"),
            ]
            found = None
            for key in key_candidates:
                if key in raw_results:
                    found = raw_results[key]
                    break
            mapped.append(found or {})
        raw_results = mapped
    if not isinstance(raw_results, list):
        raw_results = []

    items = []
    for index, item in enumerate(payload_items):
        source = raw_results[index] if index < len(raw_results) else {}
        markdown = extract_markdown(source)
        items.append({
            "id": item.get("id") or f"flowchart-{index + 1}",
            "title": item.get("title") or item.get("id") or f"flowchart-{index + 1}",
            "fileName": item.get("fileName") or f"flowchart-{index + 1}.md",
            "path": request_files[index].get("filename") if index < len(request_files) else "",
            "ok": False if isinstance(source, dict) and source.get("ok") is False else bool(markdown),
            "markdown": markdown,
            "error": source.get("error") if isinstance(source, dict) else "",
        })

    ok = bool(raw.get("ok", True)) and all(item.get("ok") for item in items)
    return {
        "ok": ok,
        "items": items,
        "results": items,
        "fileCount": len(items),
        "idleGpuCount": raw.get("idleGpuCount") or raw.get("idle_gpus") or raw.get("idleGpu"),
        "availableGpuCount": raw.get("availableGpuCount") or raw.get("available_gpus"),
        "freeGpuCount": raw.get("freeGpuCount") or raw.get("free_gpus"),
        "concurrency": raw.get("concurrency"),
        "error": "" if ok else (raw.get("error") or "batch flowchart markdown analysis failed"),
    }

try:
    with open(payload_path, "r", encoding="utf-8") as handle:
        payload = json.load(handle)

    items = payload.get("items") or []
    if not isinstance(items, list) or len(items) < 2 or len(items) > 3:
        raise ValueError("batch flowchart markdown analysis requires 2 to 3 files")

    with tempfile.TemporaryDirectory(prefix="cozypad_flowchart_batch_") as temp_dir:
        request_files = []
        for index, item in enumerate(items):
            image_base64 = item.get("imageBase64") or ""
            if not image_base64:
                raise ValueError(f"missing imageBase64 for batch item {index + 1}")
            file_name = safe_name(item.get("fileName"), f"flowchart-{index + 1}.png")
            if not os.path.splitext(file_name)[1]:
                file_name = f"{file_name}.png"
            image_path = os.path.join(temp_dir, file_name)
            with open(image_path, "wb") as image_handle:
                image_handle.write(base64.b64decode(image_base64))
            request_files.append({
                "filename": file_name,
                "image_base64": image_base64,
                "instruction": item.get("prompt") or item.get("instruction") or "請針對此研究內容提供學術等級建議",
            })

        request_body = json.dumps({"files": request_files}, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            endpoint_url,
            data=request_body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        timeout = int(payload.get("timeoutSeconds") or payload.get("timeout_seconds") or 900)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                response_text = response.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as error:
            response_text = error.read().decode("utf-8", errors="replace")
            detail = response_text.strip() or error.reason or ""
            raise RuntimeError(f"batch endpoint returned HTTP {error.code}: {detail}".strip())

        try:
            raw_result = json.loads(response_text)
        except Exception:
            raw_result = {"ok": True, "results": [{"markdown": response_text}]}

        print(json.dumps(normalize_results(raw_result, items, request_files), ensure_ascii=False))
except Exception as error:
    print(json.dumps({
        "ok": False,
        "error": str(error),
        "traceback": traceback.format_exc(limit=6),
    }, ensure_ascii=False))
    sys.exit(2)
`.trim();

  return [
    "if command -v python3 >/dev/null 2>&1; then _cozypad_py=python3; elif command -v python >/dev/null 2>&1; then _cozypad_py=python; else echo '{\"ok\":false,\"error\":\"python3/python not found on remote host\"}'; exit 127; fi",
    "_cozypad_payload=$(mktemp /tmp/cozypad_flowchart_batch_payload.XXXXXX.json)",
    "trap 'rm -f \"$_cozypad_payload\"' EXIT",
    "cat > \"$_cozypad_payload\"",
    `"$_cozypad_py" - "$_cozypad_payload" ${shellQuote(FLOWCHART_MARKDOWN_BATCH_URL)} <<'PY'\n${script}\nPY`,
  ].join("; ");
}

function createFileMutationCommand(action, primaryPath, name = "", destinationPath = "") {
  const script = String.raw`
import json
import os
import shutil
import sys

action = sys.argv[1] if len(sys.argv) > 1 else ""
primary = sys.argv[2] if len(sys.argv) > 2 else ""
name = sys.argv[3] if len(sys.argv) > 3 else ""
destination = sys.argv[4] if len(sys.argv) > 4 else ""

def fail(message, code=2):
    print(json.dumps({"ok": False, "action": action, "error": message}, ensure_ascii=False))
    sys.exit(code)

def resolve(raw):
    if not raw.strip():
        fail("path is required")
    return os.path.abspath(os.path.expanduser(raw))

def validate_name(value):
    clean = value.strip()
    if not clean:
        fail("name is required")
    if clean in {".", ".."} or "/" in clean or "\x00" in clean:
        fail("name cannot be '.', '..', or contain '/'.")
    return clean

try:
    if action == "mkdir":
        directory = resolve(primary)
        folder_name = validate_name(name)
        if not os.path.isdir(directory):
            fail(f"Not a directory: {directory}")
        target = os.path.join(directory, folder_name)
        if os.path.lexists(target):
            fail(f"Already exists: {target}")
        os.mkdir(target)
        result_path = target
        parent = directory
    elif action == "touch":
        directory = resolve(primary)
        file_name = validate_name(name)
        if not os.path.isdir(directory):
            fail(f"Not a directory: {directory}")
        target = os.path.join(directory, file_name)
        if os.path.lexists(target):
            fail(f"Already exists: {target}")
        with open(target, "x", encoding="utf-8"):
            pass
        result_path = target
        parent = directory
    elif action == "rename":
        source = resolve(primary)
        new_name = validate_name(name)
        if not os.path.lexists(source):
            fail(f"Path does not exist: {source}")
        parent = os.path.dirname(source)
        target = os.path.join(parent, new_name)
        if os.path.lexists(target):
            fail(f"Destination already exists: {target}")
        os.rename(source, target)
        result_path = target
    elif action == "delete":
        target = resolve(primary)
        if target == "/":
            fail("Refusing to delete root directory.")
        home = os.path.realpath(os.path.expanduser("~"))
        target_real = os.path.realpath(target)
        if target_real == "/" or target_real == home:
            fail("Refusing to delete root or home directory.")
        if not os.path.lexists(target):
            fail(f"Path does not exist: {target}")
        parent = os.path.dirname(target)
        if os.path.isdir(target) and not os.path.islink(target):
            shutil.rmtree(target)
        else:
            os.unlink(target)
        result_path = target
    elif action in {"copy", "move"}:
        source = resolve(primary)
        directory = resolve(destination)
        if not os.path.lexists(source):
            fail(f"Path does not exist: {source}")
        if not os.path.isdir(directory):
            fail(f"Not a directory: {directory}")
        target = os.path.join(directory, os.path.basename(source))
        if os.path.lexists(target):
            fail(f"Destination already exists: {target}")
        source_real = os.path.realpath(source)
        directory_real = os.path.realpath(directory)
        home = os.path.realpath(os.path.expanduser("~"))
        if source_real in {"/", home}:
            fail("Refusing to copy or move root or home directory.")
        if os.path.isdir(source) and not os.path.islink(source) and (
            directory_real == source_real or directory_real.startswith(source_real + os.sep)
        ):
            fail("Cannot copy or move a directory into itself.")
        if action == "move":
            shutil.move(source, target)
        elif os.path.islink(source):
            os.symlink(os.readlink(source), target)
        elif os.path.isdir(source):
            shutil.copytree(source, target, symlinks=True)
        else:
            shutil.copy2(source, target)
        result_path = target
        parent = directory
    else:
        fail("Unsupported file action")

    print(json.dumps({
        "ok": True,
        "action": action,
        "path": os.path.abspath(result_path),
        "parent": os.path.abspath(parent),
    }, ensure_ascii=False))
except Exception as error:
    fail(str(error))
`.trim();

  return `if command -v python3 >/dev/null 2>&1; then _cozypad_py=python3; elif command -v python >/dev/null 2>&1; then _cozypad_py=python; else echo '{"ok":false,"error":"python3/python not found on remote host"}'; exit 127; fi; "$_cozypad_py" - ${shellQuote(
    action,
  )} ${shellQuote(primaryPath || "")} ${shellQuote(name || "")} ${shellQuote(destinationPath || "")} <<'PY'\n${script}\nPY`;
}

const LOCAL_TEXT_EXTENSIONS = new Set([
  ".bashrc",
  ".bat",
  ".cfg",
  ".conf",
  ".config",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".env",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".lua",
  ".m",
  ".md",
  ".markdown",
  ".php",
  ".ps1",
  ".py",
  ".r",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".tex",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

const LOCAL_IMAGE_MIME = new Map([
  [".apng", "image/apng"],
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".tif", "image/tiff"],
  [".tiff", "image/tiff"],
  [".webp", "image/webp"],
]);

const LOCAL_AUDIO_MIME = new Map([
  [".aac", "audio/aac"],
  [".aif", "audio/aiff"],
  [".aiff", "audio/aiff"],
  [".flac", "audio/flac"],
  [".m4a", "audio/mp4"],
  [".mp3", "audio/mpeg"],
  [".oga", "audio/ogg"],
  [".ogg", "audio/ogg"],
  [".opus", "audio/ogg"],
  [".wav", "audio/wav"],
  [".weba", "audio/webm"],
]);

const LOCAL_VIDEO_MIME = new Map([
  [".avi", "video/x-msvideo"],
  [".m4v", "video/mp4"],
  [".mkv", "video/x-matroska"],
  [".mov", "video/quicktime"],
  [".mp4", "video/mp4"],
  [".mpeg", "video/mpeg"],
  [".mpg", "video/mpeg"],
  [".ogv", "video/ogg"],
  [".webm", "video/webm"],
  [".wmv", "video/x-ms-wmv"],
]);

function resolveLocalPath(value, fallback = os.homedir()) {
  const raw = String(value || "").trim();
  if (!raw || raw === "~") {
    return path.resolve(fallback);
  }
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return path.resolve(path.join(os.homedir(), raw.slice(2)));
  }
  return path.resolve(raw);
}

function fileModeString(mode) {
  return `0o${(Number(mode || 0) & 0o777).toString(8).padStart(3, "0")}`;
}

function validateLocalFileName(value) {
  const clean = String(value || "").trim();
  if (!clean) {
    throw new Error("name is required");
  }
  if (clean === "." || clean === ".." || clean.includes("/") || clean.includes("\\") || clean.includes("\0")) {
    throw new Error("name cannot be '.', '..', or contain path separators");
  }
  return clean;
}

function inferLocalPreviewKind(filePath, content) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".md" || extension === ".markdown") {
    return { kind: "markdown", mime: "text/markdown" };
  }
  if (extension === ".pdf") {
    return { kind: "pdf", mime: "application/pdf" };
  }
  if (LOCAL_IMAGE_MIME.has(extension)) {
    return { kind: "image", mime: LOCAL_IMAGE_MIME.get(extension) };
  }
  if (LOCAL_AUDIO_MIME.has(extension)) {
    return { kind: "audio", mime: LOCAL_AUDIO_MIME.get(extension) };
  }
  if (LOCAL_VIDEO_MIME.has(extension)) {
    return { kind: "video", mime: LOCAL_VIDEO_MIME.get(extension) };
  }
  if (LOCAL_TEXT_EXTENSIONS.has(extension) || !content.subarray(0, 4096).includes(0)) {
    return { kind: "text", mime: "text/plain" };
  }
  return { kind: "binary", mime: "application/octet-stream" };
}

async function browseLocalFiles(localPath, maxItems = FILE_LIST_MAX_ITEMS) {
  const root = resolveLocalPath(localPath);
  const entries = await readdir(root, { withFileTypes: true });
  const items = await Promise.all(
    entries.map(async (entry) => {
      const itemPath = path.join(root, entry.name);
      try {
        const info = await stat(itemPath);
        const isDirectory = entry.isDirectory() || info.isDirectory();
        return {
          name: entry.name,
          path: itemPath,
          type: isDirectory ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
          isDirectory,
          size: info.size,
          mtime: Math.floor(info.mtimeMs / 1000),
          mode: fileModeString(info.mode),
        };
      } catch (error) {
        return {
          name: entry.name,
          path: itemPath,
          type: "unknown",
          isDirectory: false,
          size: 0,
          mtime: 0,
          mode: "",
          error: error instanceof Error ? error.message : "stat failed",
        };
      }
    }),
  );
  const totalItems = items.length;
  const safeMaxItems = Math.max(100, Number(maxItems) || FILE_LIST_MAX_ITEMS);
  items.sort((left, right) => Number(!left.isDirectory) - Number(!right.isDirectory) || left.name.localeCompare(right.name));

  return {
    ok: true,
    path: root,
    parent: path.dirname(root),
    items: items.slice(0, safeMaxItems),
    totalItems,
    maxItems: safeMaxItems,
    truncated: totalItems > safeMaxItems,
  };
}

async function previewLocalFile(localPath, maxBytes = FILE_PREVIEW_MAX_BYTES) {
  const filePath = resolveLocalPath(localPath);
  const info = await stat(filePath);
  if (!info.isFile()) {
    throw new Error("Target is not a regular file");
  }
  if (info.size > maxBytes) {
    throw new Error(`File is too large for preview (${info.size} bytes)`);
  }

  const content = await readFile(filePath);
  const preview = inferLocalPreviewKind(filePath, content);
  return {
    ok: true,
    path: filePath,
    name: path.basename(filePath),
    size: info.size,
    mtime: Math.floor(info.mtimeMs / 1000),
    mime: preview.mime,
    kind: preview.kind,
    encoding: "base64",
    contentBase64: content.toString("base64"),
  };
}

async function mutateLocalFile(action, primaryPath, name = "", destinationPath = "") {
  const primary = resolveLocalPath(primaryPath);
  let resultPath = primary;
  let parent = path.dirname(primary);

  if (action === "mkdir") {
    const folderName = validateLocalFileName(name);
    const directoryInfo = await stat(primary);
    if (!directoryInfo.isDirectory()) {
      throw new Error(`Not a directory: ${primary}`);
    }
    resultPath = path.join(primary, folderName);
    if (existsSync(resultPath)) {
      throw new Error(`Already exists: ${resultPath}`);
    }
    await mkdir(resultPath);
    parent = primary;
  } else if (action === "touch") {
    const fileName = validateLocalFileName(name);
    const directoryInfo = await stat(primary);
    if (!directoryInfo.isDirectory()) throw new Error(`Not a directory: ${primary}`);
    resultPath = path.join(primary, fileName);
    await writeFile(resultPath, "", { flag: "wx" });
    parent = primary;
  } else if (action === "rename") {
    const newName = validateLocalFileName(name);
    if (!existsSync(primary)) {
      throw new Error(`Path does not exist: ${primary}`);
    }
    const target = path.join(path.dirname(primary), newName);
    if (existsSync(target)) {
      throw new Error(`Destination already exists: ${target}`);
    }
    await rename(primary, target);
    resultPath = target;
  } else if (action === "delete") {
    if (!existsSync(primary)) {
      throw new Error(`Path does not exist: ${primary}`);
    }
    const parsed = path.parse(primary);
    const home = path.resolve(os.homedir()).toLowerCase();
    const normalized = path.resolve(primary).toLowerCase();
    if (normalized === path.resolve(parsed.root).toLowerCase() || normalized === home) {
      throw new Error("Refusing to delete root or home directory.");
    }
    await rm(primary, { recursive: true, force: false });
  } else if (action === "copy" || action === "move") {
    const destination = resolveLocalPath(destinationPath);
    const destinationInfo = await stat(destination);
    if (!destinationInfo.isDirectory()) throw new Error(`Not a directory: ${destination}`);
    resultPath = path.join(destination, path.basename(primary));
    if (existsSync(resultPath)) throw new Error(`Destination already exists: ${resultPath}`);
    const sourceInfo = await stat(primary);
    const normalizedSource = path.resolve(primary).toLowerCase();
    if (
      normalizedSource === path.resolve(path.parse(primary).root).toLowerCase() ||
      normalizedSource === path.resolve(os.homedir()).toLowerCase()
    ) {
      throw new Error("Refusing to copy or move root or home directory.");
    }
    const relative = path.relative(primary, destination);
    if (sourceInfo.isDirectory() && (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)))) {
      throw new Error("Cannot copy or move a directory into itself.");
    }
    if (action === "move") {
      try {
        await rename(primary, resultPath);
      } catch (error) {
        if (error?.code !== "EXDEV") throw error;
        await cp(primary, resultPath, { recursive: sourceInfo.isDirectory(), errorOnExist: true });
        await rm(primary, { recursive: sourceInfo.isDirectory(), force: false });
      }
    } else {
      await cp(primary, resultPath, { recursive: sourceInfo.isDirectory(), errorOnExist: true });
    }
    parent = destination;
  } else {
    throw new Error("Unsupported file action");
  }

  return {
    ok: true,
    action,
    path: path.resolve(resultPath),
    parent: path.resolve(parent),
  };
}

function launchWithWindowsTerminal(server) {
  if (isSystemLocalServer(server)) {
    const child = spawn(
      "wt.exe",
      ["new-tab", "--title", "CozyPad - localhost", "powershell.exe", "-NoLogo", "-NoProfile"],
      {
        cwd: server.defaultPath || os.homedir(),
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      },
    );
    child.unref();
    return child.pid;
  }

  throw new Error("External ssh.exe terminal is disabled. Use the CozyPad web Terminal, which runs through ssh2.");
}

function launchDirectPowerShell(server) {
  if (isSystemLocalServer(server)) {
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile"], {
      cwd: server.defaultPath || os.homedir(),
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    return child.pid;
  }

  throw new Error("External ssh.exe connect is disabled. Use CozyPad ssh2-managed sessions instead.");
}

function launchAutoLoginUi() {
  const exe = "F:\\work_project\\Agent\\ssh_auto_login\\SshAutoLoginUI.exe";
  const launcher = existsSync(exe)
    ? { command: exe, args: [] }
    : {
        command: "wscript.exe",
        args: ["F:\\work_project\\Agent\\ssh_auto_login\\launch-ui.vbs"],
      };
  const child = spawn(launcher.command, launcher.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  return child.pid;
}

function normalizeTerminalDimension(value, fallback, min, max) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.round(numberValue)));
}

const TERMINAL_CONTROL_PREFIX = "\0COZYPAD:";

function parseTerminalControlPayload(payload) {
  const text = Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload || "");
  if (!text.startsWith(TERMINAL_CONTROL_PREFIX)) {
    return null;
  }

  try {
    const body = JSON.parse(text.slice(TERMINAL_CONTROL_PREFIX.length));
    if (body?.type === "resize") {
      return {
        type: "resize",
        cols: normalizeTerminalDimension(body.cols, 140, 80, 240),
        rows: normalizeTerminalDimension(body.rows, 36, 24, 80),
      };
    }
  } catch {
    return { type: "invalid" };
  }

  return { type: "unknown" };
}

function buildWebTerminalArgs(server, dimensions = {}) {
  const cols = normalizeTerminalDimension(dimensions.cols, 140, 80, 240);
  const rows = normalizeTerminalDimension(dimensions.rows, 36, 24, 80);
  const args = buildSshArgs(server, { batch: false });
  args.splice(Math.max(0, args.length - 1), 0, "-tt");
  args.push(
    `/bin/sh -lc 'stty rows ${rows} cols ${cols} 2>/dev/null; export TERM=xterm-256color; exec "\${SHELL:-/bin/sh}" -l'`,
  );
  return args;
}

function normalizeTerminalDimensions(dimensions = {}) {
  return {
    cols: normalizeTerminalDimension(dimensions.cols, 140, 80, 240),
    rows: normalizeTerminalDimension(dimensions.rows, 36, 24, 80),
  };
}

function ssh2PtyOptions(dimensions = {}) {
  const { cols, rows } = normalizeTerminalDimensions(dimensions);
  return {
    term: "xterm-256color",
    cols,
    rows,
    width: Math.max(640, cols * 8),
    height: Math.max(480, rows * 18),
  };
}

function createSsh2TerminalAdapter(channel, broker, releaseChannel, initialDimensions = {}) {
  const terminal = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let closed = false;
  let lastDimensions = normalizeTerminalDimensions(initialDimensions);

  function closeOnce(code = 0) {
    if (closed) {
      return;
    }
    closed = true;
    try {
      stdout.end();
    } catch {
      // The stream may already be closed.
    }
    try {
      stderr.end();
    } catch {
      // The stream may already be closed.
    }
    try {
      releaseChannel?.();
    } catch {
      // The broker channel may already have been released.
    }
    terminal.emit("close", code);
  }

  const stdin = new Writable({
    write(chunk, encoding, callback) {
      if (closed || !channel.writable) {
        callback();
        return;
      }
      channel.write(chunk, encoding, callback);
    },
    final(callback) {
      try {
        channel.end();
      } catch {
        // The channel may already be closed.
      }
      callback();
    },
  });

  terminal.stdin = stdin;
  terminal.stdout = stdout;
  terminal.stderr = stderr;
  terminal.transport = "ssh2";
  terminal.brokerKey = broker?.key || "";
  terminal.channel = channel;
  terminal.resize = (nextDimensions = {}) => {
    if (closed || typeof channel.setWindow !== "function") {
      return;
    }
    lastDimensions = normalizeTerminalDimensions({
      ...lastDimensions,
      ...nextDimensions,
    });
    try {
      channel.setWindow(lastDimensions.rows, lastDimensions.cols, 0, 0);
    } catch {
      // Resize is best-effort; the shell itself should remain usable.
    }
  };
  terminal.kill = () => {
    try {
      channel.signal?.("TERM");
    } catch {
      // Some servers ignore or reject signals on shell channels.
    }
    try {
      channel.close?.();
      channel.end?.();
    } catch {
      // The channel may already be closed.
    }
    setTimeout(() => closeOnce(0), 250).unref?.();
  };

  channel.on("data", (chunk) => stdout.write(chunk));
  channel.stderr?.on?.("data", (chunk) => stderr.write(chunk));
  channel.on("error", (error) => {
    stderr.write(`\r\n[CozyPad ssh2] ${error.message}\r\n`);
    terminal.emit("error", error);
  });
  channel.on("close", (code) => closeOnce(Number(code || 0)));
  broker?.connection?.once?.("close", () => closeOnce(0));
  broker?.connection?.once?.("error", (error) => {
    stderr.write(`\r\n[CozyPad ssh2] ${error.message}\r\n`);
    terminal.emit("error", error);
    closeOnce(-1);
  });

  return terminal;
}

async function createSsh2TerminalChild(owner, server, dimensions = {}, gateOptions = {}) {
  const broker = await getSsh2Broker({ username: owner }, server, gateOptions);
  const release = await acquireSsh2BrokerChannel(broker);
  let released = false;
  const releaseOnce = () => {
    if (released) {
      return;
    }
    released = true;
    release();
  };

  try {
    const channel = await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        reject(new Error("SSH2 terminal shell timed out"));
      }, TERMINAL_CHANNEL_OPEN_TIMEOUT_MS);
      timeout.unref?.();
      const finish = (error, stream) => {
        if (settled) {
          try {
            stream?.close?.();
            stream?.end?.();
          } catch {
            // Late shell callbacks can arrive after timeout; close best-effort.
          }
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (error) {
          reject(error);
          return;
        }
        resolve(stream);
      };
      broker.connection.shell(
        ssh2PtyOptions(dimensions),
        { env: { TERM: "xterm-256color" } },
        finish,
      );
    });
    return createSsh2TerminalAdapter(channel, broker, releaseOnce, dimensions);
  } catch (error) {
    releaseOnce();
    throw error;
  }
}

async function createSsh2ExecChild(owner, server, remoteCommand, gateOptions = {}) {
  const broker = await getSsh2Broker({ username: owner }, server, gateOptions);
  const release = await acquireSsh2BrokerChannel(broker);
  let released = false;
  const releaseOnce = () => {
    if (released) {
      return;
    }
    released = true;
    release();
  };

  try {
    const channel = await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        reject(new Error("SSH2 exec channel timed out"));
      }, TERMINAL_CHANNEL_OPEN_TIMEOUT_MS);
      timeout.unref?.();
      broker.connection.exec(remoteCommand, {}, (error, stream) => {
        if (settled) {
          try {
            stream?.close?.();
            stream?.end?.();
          } catch {
            // Late exec callbacks can arrive after timeout; close best-effort.
          }
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (error) {
          reject(error);
          return;
        }
        resolve(stream);
      });
    });
    return createSsh2TerminalAdapter(channel, broker, releaseOnce);
  } catch (error) {
    releaseOnce();
    throw error;
  }
}

function getCodexAppServerHostFingerprint(server) {
  if (!server) return "";
  if (isSystemLocalServer(server)) {
    return crypto
      .createHash("sha256")
      .update(`local\0${os.hostname()}\0${appRoot}`)
      .digest("hex");
  }
  return getSshGateKey(server);
}

function getCodexAppServerIdentity(session, server) {
  const owner = getTerminalOwner(session);
  if (!owner) throw new Error("Codex app-server requires an authenticated owner");
  return {
    owner,
    connectionProfileId: String(server?.id || ""),
    remoteHostFingerprint: getCodexAppServerHostFingerprint(server),
    codexHomeNamespace: `cozypad-${toSafeServerSlug(owner) || "user"}`,
  };
}

function buildRemoteCodexAppServerCommand(owner) {
  const ownerSlug = toSafeServerSlug(owner) || "user";
  return [
    "set +u",
    ...remoteCodexBootstrapLines(),
    "set -u",
    `CODEX_HOME="$HOME/.cozypad/users/${ownerSlug}/codex-home"`,
    "export CODEX_HOME",
    'mkdir -p "$CODEX_HOME"',
    // Keep runtime/history isolated per CozyPad user while reusing the SSH
    // account's existing Codex login. The credential stays on the remote host.
    'if [ ! -s "$CODEX_HOME/auth.json" ] && [ -r "$HOME/.codex/auth.json" ]; then rm -f "$CODEX_HOME/auth.json"; ln -s "$HOME/.codex/auth.json" "$CODEX_HOME/auth.json"; fi',
    'if ! command -v codex >/dev/null 2>&1; then printf "[CozyPad] remote Codex CLI not found on this SSH server.\\n" >&2; exit 127; fi',
    "exec codex -c features.goals=true app-server",
  ].join("; ");
}

async function startCodexAppServerTransport(identity, context) {
  const session = context?.session;
  const server = context?.server;
  if (!session || !server) throw new Error("Codex app-server transport context is incomplete");

  if (isSystemLocalServer(server)) {
    await ensureUserCodexHome(session);
    const cli = await getCodexCliStatus(session);
    if (!cli.available) throw new Error(cli.error || "Codex CLI was not found");
    return spawn(cli.command, [...cli.args, "-c", "features.goals=true", "app-server"], {
      cwd: server.defaultPath || appRoot,
      env: getCodexEnv(session),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  if (!canUseSsh2Broker(server)) {
    throw new Error(ssh2RequiredMessage(server, "Codex app-server"));
  }
  return createSsh2ExecChild(
    identity.owner,
    server,
    buildRemoteCodexAppServerCommand(identity.owner),
    { confirmAfterMs: 0, opensshFallback: false },
  );
}

async function createRemoteWorkerChild(owner, server, remoteCommand, purpose, gateOptions = {}) {
  if (!canUseSsh2Broker(server)) {
    if (opensshFallbackAllowed(server)) {
      return spawn("ssh.exe", [...buildSshArgs(server, { controlMaster: false }), remoteCommand], {
        cwd: appRoot,
        env: { ...process.env, TERM: "xterm-256color" },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    }
    throw new Error(ssh2RequiredMessage(server, purpose));
  }

  try {
    return await createSsh2ExecChild(owner, server, remoteCommand, gateOptions);
  } catch (error) {
    if (opensshFallbackAllowed(server)) {
      return spawn("ssh.exe", [...buildSshArgs(server, { controlMaster: false }), remoteCommand], {
        cwd: appRoot,
        env: { ...process.env, TERM: "xterm-256color" },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    }
    throw new Error(
      `ssh2 ${purpose} failed for ${server.name || getServerTargetLabel(server)}: ${
        error instanceof Error ? error.message : String(error || "unknown error")
      }`,
    );
  }
}

async function createTerminalChild(owner, server, dimensions = {}, gateOptions = {}) {
  if (isSystemLocalServer(server)) {
    return spawn("powershell.exe", ["-NoLogo", "-NoProfile"], {
      cwd: server.defaultPath || os.homedir(),
      env: { ...process.env, TERM: "xterm-256color" },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  if (!SSH2_TERMINAL_ENABLED) {
    if (opensshFallbackAllowed(server)) {
      const args = buildSshArgs(server, { batch: false, controlMaster: false });
      args.splice(Math.max(0, args.length - 1), 0, "-tt");
      return spawn("ssh.exe", args, {
        cwd: appRoot,
        env: { ...process.env, TERM: "xterm-256color" },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    }
    throw new Error(ssh2RequiredMessage(server, "SSH terminal"));
  }

  if (!canUseSsh2Broker(server)) {
    if (opensshFallbackAllowed(server)) {
      const args = buildSshArgs(server, { batch: false, controlMaster: false });
      args.splice(Math.max(0, args.length - 1), 0, "-tt");
      return spawn("ssh.exe", args, {
        cwd: appRoot,
        env: { ...process.env, TERM: "xterm-256color" },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    }
    throw new Error(ssh2RequiredMessage(server, "SSH terminal"));
  }

  try {
    return await createSsh2TerminalChild(owner, server, dimensions, gateOptions);
  } catch (error) {
    if (opensshFallbackAllowed(server)) {
      const args = buildSshArgs(server, { batch: false, controlMaster: false });
      args.splice(Math.max(0, args.length - 1), 0, "-tt");
      return spawn("ssh.exe", args, {
        cwd: appRoot,
        env: { ...process.env, TERM: "xterm-256color" },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    }
    throw new Error(
      `ssh2 terminal failed for ${server.name || getServerTargetLabel(server)}: ${
        error instanceof Error ? error.message : String(error || "unknown error")
      }`,
    );
  }
}

function normalizeTerminalSessionId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9:_-]{8,160}$/.test(id)) {
    return "";
  }
  return id;
}

function getTerminalOwner(session) {
  return normalizeUsername(session?.username || "");
}

function getBailianSessionKey(session) {
  const owner = getTerminalOwner(session);
  return owner ? bailianSessionApiKeys.get(owner) || "" : "";
}

function setBailianSessionKey(session, key) {
  const owner = getTerminalOwner(session);
  if (!owner) return false;
  const cleanKey = extractBailianApiKeyText(key).slice(0, 24000);
  if (!cleanKey) {
    bailianSessionApiKeys.delete(owner);
    return false;
  }
  bailianSessionApiKeys.set(owner, cleanKey);
  return true;
}

function trimTerminalBuffer(value) {
  const text = String(value || "");
  if (text.length <= TERMINAL_BUFFER_LIMIT) {
    return text;
  }
  return `[CozyPad] output truncated\r\n${text.slice(-TERMINAL_BUFFER_LIMIT)}`;
}

function sendWebSocketPing(socket) {
  if (socket.destroyed || !socket.writable) {
    return;
  }

  try {
    socket.write(Buffer.from([0x89, 0x00]));
  } catch {
    // The TCP socket is already going away.
  }
}

function appendTerminalOutput(terminalSession, text) {
  if (!terminalSession || terminalSession.ended) {
    return;
  }

  const output = String(text || "");
  if (!output) {
    return;
  }

  terminalSession.buffer = trimTerminalBuffer(`${terminalSession.buffer}${output}`);
  terminalSession.lastOutputAt = Date.now();

  for (const watcher of terminalSession.watchers || []) {
    try {
      watcher(output);
    } catch {
      // A terminal watcher must not break the user-visible terminal stream.
    }
  }

  for (const socket of terminalSession.sockets) {
    sendWebSocketText(socket, output);
  }
}

function closeTerminalSockets(terminalSession) {
  for (const socket of terminalSession.sockets) {
    closeWebSocket(socket);
  }
  terminalSession.sockets.clear();
}

function scheduleDetachedTerminalCleanup(terminalSession) {
  if (!terminalSession || terminalSession.ended || terminalSession.sockets.size > 0) {
    return;
  }

  if (terminalSession.cleanupTimer) {
    clearTimeout(terminalSession.cleanupTimer);
  }

  terminalSession.detachedAt = Date.now();
  terminalSession.cleanupTimer = setTimeout(() => {
    if (terminalSession.ended || terminalSession.sockets.size > 0) {
      return;
    }

    terminateTerminalSession(terminalSession, "detached timeout");
  }, TERMINAL_DETACHED_TTL_MS);
  terminalSession.cleanupTimer.unref?.();
}

function terminateTerminalSession(terminalSession, reason = "closed") {
  if (!terminalSession || terminalSession.ended) {
    return false;
  }

  terminalSession.ended = true;
  if (terminalSession.cleanupTimer) {
    clearTimeout(terminalSession.cleanupTimer);
    terminalSession.cleanupTimer = null;
  }

  if (reason) {
    terminalSession.buffer = trimTerminalBuffer(
      `${terminalSession.buffer}${terminalSession.buffer.endsWith("\n") ? "" : "\r\n"}[CozyPad] terminal ${reason}\r\n`,
    );
    for (const socket of terminalSession.sockets) {
      sendWebSocketText(socket, `[CozyPad] terminal ${reason}\r\n`);
    }
  }

  if (terminalSession.activeAgentJob?.fail) {
    terminalSession.activeAgentJob.fail(new Error(`Terminal session ${reason}`));
  }
  terminalSession.activeAgentJob = null;
  terminalSession.watchers?.clear();

  closeTerminalSockets(terminalSession);

  try {
    terminalSession.child.kill();
  } catch {
    // The ssh process may already be gone.
  }

  terminalSessions.delete(terminalSession.id);
  return true;
}

function detachTerminalSocket(terminalSession, socket) {
  if (!terminalSession) {
    return;
  }

  terminalSession.sockets.delete(socket);
  scheduleDetachedTerminalCleanup(terminalSession);
}

function attachTerminalSocket(terminalSession, socket, { reattached = false } = {}) {
  if (!terminalSession || terminalSession.ended) {
    return;
  }

  if (terminalSession.cleanupTimer) {
    clearTimeout(terminalSession.cleanupTimer);
    terminalSession.cleanupTimer = null;
  }

  terminalSession.sockets.add(socket);
  terminalSession.lastAttachedAt = Date.now();
  socket.setKeepAlive?.(true, 30000);

  if (reattached) {
    sendWebSocketText(
      socket,
      `[CozyPad] reattached ${terminalSession.serverName}; SSH session kept alive\r\n`,
    );
    if (terminalSession.buffer) {
      sendWebSocketText(socket, terminalSession.buffer);
    }
  } else {
    sendWebSocketText(socket, `[CozyPad] connecting to ${terminalSession.serverName}\r\n`);
  }

  const pingTimer = setInterval(() => sendWebSocketPing(socket), TERMINAL_WS_PING_MS);
  pingTimer.unref?.();

  socket.on("close", () => {
    clearInterval(pingTimer);
    detachTerminalSocket(terminalSession, socket);
  });
  socket.on("error", () => {
    clearInterval(pingTimer);
    detachTerminalSocket(terminalSession, socket);
  });
}

function resizeTerminalSession(terminalSession, dimensions = {}) {
  if (!terminalSession || terminalSession.ended) {
    return;
  }

  terminalSession.dimensions = normalizeTerminalDimensions({
    ...terminalSession.dimensions,
    ...dimensions,
  });
  if (typeof terminalSession.child?.resize === "function") {
    terminalSession.child.resize(terminalSession.dimensions);
    return;
  }
}

function initialTerminalCwdCommand(server, cwd) {
  const clean = String(cwd || "").trim();
  if (!clean) return "";
  if (isSystemLocalServer(server)) {
    const target = clean === "~" ? "$HOME" : `'${clean.replace(/'/g, "''")}'`;
    return `Set-Location -LiteralPath ${target}\r`;
  }
  const target =
    clean === "~"
      ? '"$HOME"'
      : clean.startsWith("~/")
        ? `"$HOME"/${shellQuote(clean.slice(2))}`
        : shellQuote(clean);
  return `cd -- ${target} || printf '[CozyPad] unable to enter requested cwd\\n'\r`;
}

async function createTerminalSession(id, owner, server, dimensions = {}, gateOptions = {}, cwd = "") {
  const child = await createTerminalChild(owner, server, dimensions, gateOptions);
  const now = Date.now();
  const terminalSession = {
    id,
    owner,
    serverId: server.id,
    serverName: server.name,
    transport: child.transport || (isSystemLocalServer(server) ? "local" : "ssh2"),
    dimensions: normalizeTerminalDimensions(dimensions),
    child,
    sockets: new Set(),
    watchers: new Set(),
    activeAgentJob: null,
    buffer: "",
    cleanupTimer: null,
    createdAt: now,
    detachedAt: 0,
    lastAttachedAt: now,
    lastOutputAt: now,
    ended: false,
    cwd: String(cwd || "").trim() || server.defaultPath || "~",
  };

  terminalSessions.set(id, terminalSession);

  child.stdout.on("data", (chunk) => appendTerminalOutput(terminalSession, chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => appendTerminalOutput(terminalSession, chunk.toString("utf8")));
  child.on("error", (error) => {
    appendTerminalOutput(terminalSession, `\r\n[CozyPad] ${error.message}\r\n`);
    terminateTerminalSession(terminalSession, "error");
  });
  child.on("close", (code) => {
    if (terminalSession.ended) {
      return;
    }

    appendTerminalOutput(
      terminalSession,
      `\r\n[CozyPad] ${
        isSystemLocalServer(server) ? "terminal" : "ssh"
      } exited with code ${code ?? "unknown"}\r\n`,
    );
    terminateTerminalSession(terminalSession, "ended");
  });

  const cwdCommand = initialTerminalCwdCommand(server, terminalSession.cwd);
  if (cwdCommand) child.stdin.write(cwdCommand);

  return terminalSession;
}

function closeTerminalSessionForUser(session, terminalId) {
  const id = normalizeTerminalSessionId(terminalId);
  const terminalSession = id ? terminalSessions.get(id) : null;
  if (!terminalSession || terminalSession.owner !== getTerminalOwner(session)) {
    return false;
  }

  return terminateTerminalSession(terminalSession, "closed by user");
}

function dateFromMs(value) {
  const ms = Number(value || 0);
  return ms > 0 ? new Date(ms).toISOString() : "";
}

function publicTerminalSession(session) {
  const now = Date.now();
  return {
    id: session.id,
    serverId: session.serverId,
    serverName: session.serverName,
    transport: session.transport || "",
    attachedSockets: session.sockets?.size || 0,
    detached: (session.sockets?.size || 0) === 0,
    createdAt: dateFromMs(session.createdAt),
    detachedAt: dateFromMs(session.detachedAt),
    lastAttachedAt: dateFromMs(session.lastAttachedAt),
    lastOutputAt: dateFromMs(session.lastOutputAt),
    idleMs: Math.max(0, now - Number(session.lastOutputAt || session.createdAt || now)),
    bufferBytes: Buffer.byteLength(String(session.buffer || ""), "utf8"),
    agentBusy: Boolean(session.activeAgentJob && !session.activeAgentJob.closed),
    agentJobId: session.activeAgentJob?.id || "",
    agent: session.activeAgentJob?.agent || "",
    cwd: session.cwd || "",
  };
}

function listTerminalSessionsForUser(session) {
  const owner = getTerminalOwner(session);
  return Array.from(terminalSessions.values())
    .filter((terminalSession) => terminalSession.owner === owner && !terminalSession.ended)
    .sort((left, right) => Number(right.lastOutputAt || 0) - Number(left.lastOutputAt || 0))
    .map(publicTerminalSession);
}

function listSshGateRuntimeLeases() {
  const now = Date.now();
  const rows = [];
  for (const key of Array.from(sshGateLeases.keys())) {
    const entry = pruneSshGateEntry(key);
    for (const lease of entry?.leases || []) {
      if (lease.released) continue;
      rows.push({
        id: lease.id,
        key: lease.key,
        serverName: lease.serverName,
        target: lease.target,
        purpose: lease.purpose,
        startedAt: dateFromMs(lease.startedAt),
        ageMs: Math.max(0, now - Number(lease.startedAt || now)),
        allowSecondChannel: Boolean(lease.allowSecondChannel),
      });
    }
  }
  return rows.sort((left, right) => right.ageMs - left.ageMs);
}

function listCodexRuntimeSessionsForUser(session) {
  const owner = getTerminalOwner(session);
  const now = Date.now();
  return Array.from(codexSessions.values())
    .filter((codexSession) => codexSession.owner === owner && !codexSession.ended)
    .map((codexSession) => {
      reconcileCodexSessionState(codexSession);
      return {
        key: codexSession.key,
        taskId: codexSession.taskId || "",
        serverId: codexSession.serverId,
        serverName: codexSession.serverName,
        running: Boolean(codexSession.running),
        status: codexSession.status || "",
        socketCount: codexSession.sockets?.size || 0,
        pendingPrompts: codexSession.pendingPrompts?.length || 0,
        createdAt: dateFromMs(codexSession.createdAt),
        lastAttachedAt: dateFromMs(codexSession.lastAttachedAt),
        lastOutputAt: dateFromMs(codexSession.lastOutputAt),
        idleMs: Math.max(0, now - Number(codexSession.lastOutputAt || codexSession.createdAt || now)),
      };
    })
    .sort((left, right) => right.idleMs - left.idleMs);
}

function listClaudeRuntimeSessionsForUser(session) {
  const owner = getTerminalOwner(session);
  const now = Date.now();
  return Array.from(claudeSessions.values())
    .filter((claudeSession) => claudeSession.owner === owner && !claudeSession.ended)
    .map((claudeSession) => {
      reconcileClaudeSessionState(claudeSession);
      return {
        key: claudeSession.key,
        agent: "claude",
        taskId: claudeSession.taskId || "",
        serverId: claudeSession.serverId,
        serverName: claudeSession.serverName,
        running: Boolean(claudeSession.running),
        status: claudeSession.status || "",
        socketCount: claudeSession.sockets?.size || 0,
        pendingPrompts: claudeSession.pendingPrompts?.length || 0,
        createdAt: dateFromMs(claudeSession.createdAt),
        lastAttachedAt: dateFromMs(claudeSession.lastAttachedAt),
        lastOutputAt: dateFromMs(claudeSession.lastOutputAt),
        idleMs: Math.max(0, now - Number(claudeSession.lastOutputAt || claudeSession.createdAt || now)),
      };
    })
    .sort((left, right) => right.idleMs - left.idleMs);
}

function listAgyRuntimeSessionsForUser(session) {
  const owner = getTerminalOwner(session);
  const now = Date.now();
  return Array.from(agySessions.values())
    .filter((agySession) => agySession.owner === owner && !agySession.ended)
    .map((agySession) => {
      reconcileAgySessionState(agySession);
      return {
        key: agySession.key,
        agent: "agy",
        taskId: agySession.taskId || "",
        serverId: agySession.serverId,
        serverName: agySession.serverName,
        running: Boolean(agySession.running),
        status: agySession.status || "",
        socketCount: agySession.sockets?.size || 0,
        pendingPrompts: agySession.pendingPrompts?.length || 0,
        createdAt: dateFromMs(agySession.createdAt),
        lastAttachedAt: dateFromMs(agySession.lastAttachedAt),
        lastOutputAt: dateFromMs(agySession.lastOutputAt),
        idleMs: Math.max(0, now - Number(agySession.lastOutputAt || agySession.createdAt || now)),
      };
    })
    .sort((left, right) => right.idleMs - left.idleMs);
}

function listBailianRuntimeSessionsForUser(session) {
  const owner = getTerminalOwner(session);
  const now = Date.now();
  return Array.from(bailianSessions.values())
    .filter((bailianSession) => bailianSession.owner === owner && !bailianSession.ended)
    .map((bailianSession) => {
      reconcileBailianSessionState(bailianSession);
      return {
        key: bailianSession.key,
        agent: "bailian",
        taskId: bailianSession.taskId || "",
        serverId: bailianSession.serverId,
        serverName: bailianSession.serverName,
        running: Boolean(bailianSession.running),
        status: bailianSession.status || "",
        socketCount: bailianSession.sockets?.size || 0,
        pendingPrompts: bailianSession.pendingPrompts?.length || 0,
        createdAt: dateFromMs(bailianSession.createdAt),
        lastAttachedAt: dateFromMs(bailianSession.lastAttachedAt),
        lastOutputAt: dateFromMs(bailianSession.lastOutputAt),
        idleMs: Math.max(0, now - Number(bailianSession.lastOutputAt || bailianSession.createdAt || now)),
      };
    })
    .sort((left, right) => right.idleMs - left.idleMs);
}

function listRemoteAgentWorkersForUser(session) {
  const owner = getTerminalOwner(session);
  const now = Date.now();
  return Array.from(remoteAgentWorkers.values())
    .filter((worker) => worker.owner === owner && !worker.ended)
    .map((worker) => ({
      key: worker.key,
      agent: worker.agent,
      serverId: worker.server?.id || "",
      serverName: worker.server?.name || "",
      running: Boolean(worker.activeJob && !worker.activeJob.closed),
      queuedJobs: worker.queue?.length || 0,
      pid: worker.child?.pid || 0,
      lastUsedAt: dateFromMs(worker.lastUsedAt),
      idleMs: Math.max(0, now - Number(worker.lastUsedAt || now)),
    }));
}

function listSharedMonitorStreamsForUser(session) {
  const owner = getTerminalOwner(session);
  const now = Date.now();
  return Array.from(sharedMonitorStreams.values())
    .filter((stream) => !stream.closed && stream.key.startsWith(`${owner}:`))
    .map((stream) => ({
      key: stream.key,
      serverId: stream.server?.id || "",
      serverName: stream.server?.name || "",
      target: getServerTargetLabel(stream.server),
      subscribers: stream.subscribers?.size || 0,
      online: Boolean(stream.state?.online),
      connecting: Boolean(stream.state?.monitorConnecting || stream.starting),
      blocked: Boolean(stream.state?.monitorBlocked),
      createdAt: dateFromMs(stream.createdAt),
      lastUpdatedAt: dateFromMs(stream.lastUpdatedAt),
      idleMs: Math.max(0, now - Number(stream.lastUpdatedAt || stream.createdAt || now)),
    }))
    .sort((left, right) => right.subscribers - left.subscribers || right.idleMs - left.idleMs);
}

function listSshRuntimeSnapshot(session) {
  const terminals = listTerminalSessionsForUser(session);
  const codex = listCodexRuntimeSessionsForUser(session);
  const agentSessions = [
    ...listAgyRuntimeSessionsForUser(session),
    ...listBailianRuntimeSessionsForUser(session),
  ];
  const workers = listRemoteAgentWorkersForUser(session);
  const monitorStreams = listSharedMonitorStreamsForUser(session);
  return {
    ok: true,
    type: "ssh-runtime",
    generatedAt: new Date().toISOString(),
    terminalBridgeEnabled: AGENT_TERMINAL_BRIDGE_ENABLED,
    intervalMs: MONITOR_INTERVAL_MS,
    totals: {
      terminals: terminals.length,
      attachedTerminals: terminals.filter((terminal) => terminal.attachedSockets > 0).length,
      busyTerminals: terminals.filter((terminal) => terminal.agentBusy).length,
      codexSessions: codex.length,
      runningCodexSessions: codex.filter((entry) => entry.running).length,
      remoteAgentSessions: agentSessions.length,
      runningRemoteAgentSessions: agentSessions.filter((entry) => entry.running).length,
      remoteAgentWorkers: workers.length,
      monitorStreams: monitorStreams.length,
    },
    terminals,
    monitorStreams,
    codexSessions: codex,
    remoteAgentSessions: agentSessions,
    remoteAgentWorkers: workers,
  };
}

function terminateCodexRuntimeSession(codexSession, reason = "page closed") {
  if (!codexSession || codexSession.ended) {
    return false;
  }

  codexSession.ended = true;
  if (codexSession.cleanupTimer) {
    clearTimeout(codexSession.cleanupTimer);
    codexSession.cleanupTimer = null;
  }
  if (codexSession.retryTimer) {
    clearTimeout(codexSession.retryTimer);
    codexSession.retryTimer = null;
  }

  try {
    codexSession.activeChild?.kill?.();
  } catch {
    // The child may already be closed.
  }
  codexSession.activeChild = null;
  codexSession.running = false;
  codexSession.pendingPrompts = [];

  if (reason) {
    appendCodexSessionOutput(codexSession, `\r\n[CozyPad] codex ${reason}\r\n`);
  }
  for (const socket of codexSession.sockets || []) {
    closeWebSocket(socket);
  }
  codexSession.sockets?.clear?.();
  codexSessions.delete(codexSession.key);
  return true;
}

function terminateClaudeRuntimeSession(claudeSession, reason = "page closed") {
  if (!claudeSession || claudeSession.ended) {
    return false;
  }

  claudeSession.ended = true;
  if (claudeSession.cleanupTimer) {
    clearTimeout(claudeSession.cleanupTimer);
    claudeSession.cleanupTimer = null;
  }

  try {
    claudeSession.activeJob?.kill?.();
  } catch {
    // The agent job may already be closed.
  }
  claudeSession.activeJob = null;
  claudeSession.running = false;
  claudeSession.pendingPrompts = [];

  if (reason) {
    appendClaudeSessionOutput(claudeSession, `\r\n[CozyPad] remote Claude ${reason}\r\n`);
  }
  for (const socket of claudeSession.sockets || []) {
    closeWebSocket(socket);
  }
  claudeSession.sockets?.clear?.();
  claudeSessions.delete(claudeSession.key);
  return true;
}

function terminateAgyRuntimeSession(agySession, reason = "page closed") {
  if (!agySession || agySession.ended) {
    return false;
  }

  agySession.ended = true;
  if (agySession.cleanupTimer) {
    clearTimeout(agySession.cleanupTimer);
    agySession.cleanupTimer = null;
  }

  try {
    agySession.activeJob?.kill?.();
  } catch {
    // The agent job may already be closed.
  }
  agySession.activeJob = null;
  agySession.running = false;
  agySession.pendingPrompts = [];

  if (reason) {
    appendAgySessionOutput(agySession, `\r\n[CozyPad] remote agy ${reason}\r\n`);
  }
  for (const socket of agySession.sockets || []) {
    closeWebSocket(socket);
  }
  agySession.sockets?.clear?.();
  agySessions.delete(agySession.key);
  return true;
}

function terminateBailianRuntimeSession(bailianSession, reason = "page closed") {
  if (!bailianSession || bailianSession.ended) {
    return false;
  }

  bailianSession.ended = true;
  if (bailianSession.cleanupTimer) {
    clearTimeout(bailianSession.cleanupTimer);
    bailianSession.cleanupTimer = null;
  }

  try {
    bailianSession.activeJob?.kill?.();
  } catch {
    // The agent job may already be closed.
  }
  bailianSession.activeJob = null;
  bailianSession.running = false;
  bailianSession.pendingPrompts = [];

  if (reason) {
    appendBailianSessionOutput(bailianSession, `\r\n[CozyPad] remote bailian ${reason}\r\n`);
  }
  for (const socket of bailianSession.sockets || []) {
    closeWebSocket(socket);
  }
  bailianSession.sockets?.clear?.();
  bailianSessions.delete(bailianSession.key);
  return true;
}

function stopCodexRuntimeSession(codexSession, reason = "stopped by user") {
  if (!codexSession || codexSession.ended) {
    return { stopped: false, pendingCleared: 0 };
  }

  reconcileCodexSessionState(codexSession);
  const pendingCleared = codexSession.pendingPrompts?.length || 0;
  const activeChild = codexSession.activeChild;
  const stopped = Boolean(activeChild || codexSession.running || pendingCleared || codexSession.retryTimer);

  if (codexSession.retryTimer) {
    clearTimeout(codexSession.retryTimer);
    codexSession.retryTimer = null;
  }
  codexSession.pendingPrompts = [];
  codexSession.activeChild = null;
  codexSession.running = false;
  codexSession.status = stopped ? "failed" : codexSession.status || "completed";

  if (stopped) {
    appendCodexSessionOutput(codexSession, `\r\n[CozyPad] codex ${reason}\r\n[CozyPad] codex ready\r\n`);
  }

  try {
    activeChild?.kill?.();
  } catch {
    // The Codex process may already be closed.
  }

  void persistCodexSessionWorkflow(codexSession, codexSession.selectedServer).catch(() => undefined);
  scheduleCodexSessionCleanup(codexSession);
  return { stopped, pendingCleared };
}

function stopClaudeRuntimeSession(claudeSession, reason = "stopped by user") {
  if (!claudeSession || claudeSession.ended) {
    return { stopped: false, pendingCleared: 0 };
  }

  reconcileClaudeSessionState(claudeSession);
  const pendingCleared = claudeSession.pendingPrompts?.length || 0;
  const activeJob = claudeSession.activeJob;
  const stopped = Boolean(activeJob || claudeSession.running || pendingCleared);

  claudeSession.pendingPrompts = [];
  claudeSession.activeJob = null;
  claudeSession.running = false;
  claudeSession.status = stopped ? "failed" : claudeSession.status || "completed";

  if (stopped) {
    appendClaudeSessionOutput(
      claudeSession,
      `\r\n[CozyPad] remote Claude ${reason}\r\n[CozyPad] remote Claude ready\r\n`,
    );
  }

  try {
    activeJob?.kill?.();
  } catch {
    // The agent job may already be closed.
  }

  scheduleClaudeSessionCleanup(claudeSession);
  return { stopped, pendingCleared };
}

function stopAgyRuntimeSession(agySession, reason = "stopped by user") {
  if (!agySession || agySession.ended) {
    return { stopped: false, pendingCleared: 0 };
  }

  reconcileAgySessionState(agySession);
  const pendingCleared = agySession.pendingPrompts?.length || 0;
  const activeJob = agySession.activeJob;
  const stopped = Boolean(activeJob || agySession.running || pendingCleared);

  agySession.pendingPrompts = [];
  agySession.activeJob = null;
  agySession.running = false;
  agySession.status = stopped ? "failed" : agySession.status || "completed";

  if (stopped) {
    appendAgySessionOutput(
      agySession,
      `\r\n[CozyPad] remote agy ${reason}\r\n[CozyPad] remote agy ready\r\n`,
    );
  }

  try {
    activeJob?.kill?.();
  } catch {
    // The agent job may already be closed.
  }

  scheduleAgySessionCleanup(agySession);
  return { stopped, pendingCleared };
}

function stopBailianRuntimeSession(bailianSession, reason = "stopped by user") {
  if (!bailianSession || bailianSession.ended) {
    return { stopped: false, pendingCleared: 0 };
  }

  reconcileBailianSessionState(bailianSession);
  const pendingCleared = bailianSession.pendingPrompts?.length || 0;
  const activeJob = bailianSession.activeJob;
  const stopped = Boolean(activeJob || bailianSession.running || pendingCleared);

  bailianSession.pendingPrompts = [];
  bailianSession.activeJob = null;
  bailianSession.running = false;
  bailianSession.status = stopped ? "failed" : bailianSession.status || "completed";

  if (stopped) {
    appendBailianSessionOutput(
      bailianSession,
      `\r\n[CozyPad] remote bailian ${reason}\r\n[CozyPad] remote bailian ready\r\n`,
    );
  }

  try {
    activeJob?.kill?.();
  } catch {
    // The agent job may already be closed.
  }

  scheduleBailianSessionCleanup(bailianSession);
  return { stopped, pendingCleared };
}

function getAgentSessionStopHandlers(agent) {
  if (agent === "codex") {
    return {
      sessions: codexSessions,
      label: "Codex",
      reconcile: reconcileCodexSessionState,
      stop: stopCodexRuntimeSession,
    };
  }
  if (agent === "claude") {
    return {
      sessions: claudeSessions,
      label: "Claude",
      reconcile: reconcileClaudeSessionState,
      stop: stopClaudeRuntimeSession,
    };
  }
  if (agent === "agy") {
    return {
      sessions: agySessions,
      label: "agy",
      reconcile: reconcileAgySessionState,
      stop: stopAgyRuntimeSession,
    };
  }
  if (agent === "bailian") {
    return {
      sessions: bailianSessions,
      label: "bailian",
      reconcile: reconcileBailianSessionState,
      stop: stopBailianRuntimeSession,
    };
  }
  return null;
}

function findLatestAgentSessionToStop(session, agent, serverId, taskId = "") {
  const handlers = getAgentSessionStopHandlers(agent);
  if (!handlers) {
    return { handlers: null, agentSession: null };
  }

  const owner = getTerminalOwner(session);
  const cleanTaskId = normalizeCodexSessionTaskId(taskId);
  const candidates = Array.from(handlers.sessions.values())
    .filter((agentSession) => {
      handlers.reconcile(agentSession);
      return (
        agentSession &&
        !agentSession.ended &&
        agentSession.owner === owner &&
        (!serverId || agentSession.serverId === serverId) &&
        (!cleanTaskId || agentSession.taskId === cleanTaskId)
      );
    })
    .sort((left, right) => Number(right.lastOutputAt || right.createdAt || 0) - Number(left.lastOutputAt || left.createdAt || 0));

  const running = candidates.find(
    (agentSession) =>
      agentSession.running ||
      agentSession.activeChild ||
      agentSession.activeJob ||
      (agentSession.pendingPrompts?.length || 0) > 0 ||
      agentSession.retryTimer,
  );
  return { handlers, agentSession: running || candidates[0] || null };
}

async function stopLatestRemoteAgentTaskForSession(session, body) {
  const agent = normalizeRemoteAgentRunAgent(body?.agent);
  if (!agent) {
    throw new Error("Unsupported agent");
  }

  const serverId = String(body?.serverId || "").trim();
  if (serverId) {
    await findServer(serverId, session);
  }

  const taskId = normalizeCodexSessionTaskId(body?.taskId);
  const { handlers, agentSession } = findLatestAgentSessionToStop(session, agent, serverId, taskId);
  if (!handlers || !agentSession) {
    return {
      ok: true,
      stopped: false,
      agent,
      serverId,
      taskId,
      pendingCleared: 0,
      message: `No running ${remoteAgentRunLabel(agent)} task was found.`,
    };
  }

  const result = handlers.stop(agentSession, "stopped by user");
  return {
    ok: true,
    stopped: result.stopped,
    agent,
    serverId: agentSession.serverId || serverId,
    taskId: agentSession.taskId || taskId,
    pendingCleared: result.pendingCleared,
    message: result.stopped
      ? `${handlers.label} task stopped.`
      : `No running ${handlers.label} task was found.`,
  };
}

function closeRemoteAgentWorker(worker, reason = "page closed") {
  if (!worker || worker.ended) {
    return false;
  }

  worker.ended = true;
  if (worker.idleTimer) {
    clearTimeout(worker.idleTimer);
    worker.idleTimer = null;
  }
  failRemoteAgentWorkerJobs(worker, new Error(`Remote ${worker.label} worker ${reason}`));
  try {
    worker.child?.kill?.();
  } catch {
    // The SSH worker may already be gone.
  }
  remoteAgentWorkers.delete(worker.key);
  return true;
}

function closeRemoteCodexWorker(worker, reason = "page closed") {
  if (!worker || worker.ended) {
    return false;
  }

  worker.ended = true;
  const job = worker.activeJob;
  worker.activeJob = null;
  if (job) {
    failRemoteCodexJob(job, new Error(`Remote Codex worker ${reason}`));
  }
  try {
    worker.child?.kill?.();
  } catch {
    // The SSH worker may already be gone.
  }
  remoteCodexWorkers.delete(worker.key);
  return true;
}

function closeSshRuntimeForUser(session, reason = "page closed") {
  const owner = getTerminalOwner(session);
  const counts = {
    terminals: 0,
    codexSessions: 0,
    claudeSessions: 0,
    agySessions: 0,
    bailianSessions: 0,
    remoteAgentWorkers: 0,
    remoteCodexWorkers: 0,
    monitorStreams: 0,
    ssh2Brokers: 0,
    codexAppServerRuntimes: 0,
  };

  counts.codexAppServerRuntimes = codexAppServerRuntimeManager.closeOwner(owner, reason);

  for (const terminalSession of Array.from(terminalSessions.values())) {
    if (terminalSession.owner === owner && terminateTerminalSession(terminalSession, reason)) {
      counts.terminals += 1;
    }
  }

  for (const codexSession of Array.from(codexSessions.values())) {
    if (codexSession.owner === owner && terminateCodexRuntimeSession(codexSession, reason)) {
      counts.codexSessions += 1;
    }
  }

  for (const claudeSession of Array.from(claudeSessions.values())) {
    if (claudeSession.owner === owner && terminateClaudeRuntimeSession(claudeSession, reason)) {
      counts.claudeSessions += 1;
    }
  }

  for (const agySession of Array.from(agySessions.values())) {
    if (agySession.owner === owner && terminateAgyRuntimeSession(agySession, reason)) {
      counts.agySessions += 1;
    }
  }

  for (const bailianSession of Array.from(bailianSessions.values())) {
    if (bailianSession.owner === owner && terminateBailianRuntimeSession(bailianSession, reason)) {
      counts.bailianSessions += 1;
    }
  }

  for (const worker of Array.from(remoteAgentWorkers.values())) {
    if (worker.owner === owner && closeRemoteAgentWorker(worker, reason)) {
      counts.remoteAgentWorkers += 1;
    }
  }

  for (const worker of Array.from(remoteCodexWorkers.values())) {
    if (worker.owner === owner && closeRemoteCodexWorker(worker, reason)) {
      counts.remoteCodexWorkers += 1;
    }
  }

  for (const stream of Array.from(sharedMonitorStreams.values())) {
    if (stream.key.startsWith(`${owner}:`)) {
      closeSharedMonitorStream(stream);
      counts.monitorStreams += 1;
    }
  }

  for (const broker of Array.from(ssh2Brokers.values())) {
    if (broker.owner === owner) {
      disposeSsh2Broker(broker, reason);
      counts.ssh2Brokers += 1;
    }
  }

  return { ok: true, closed: counts };
}

function stripTerminalControlText(value) {
  return String(value || "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function normalizeTerminalMarkerLine(value) {
  return stripTerminalControlText(value).trim();
}

function terminalBridgeUnavailableMessage(agent, server) {
  return (
    `Terminal bridge for ${agent} is not attached to ${server?.name || "this server"}. ` +
    "Open the Terminal page for this SSH server first and keep that terminal alive; CozyPad will not open a second SSH connection for this agent run."
  );
}

function isTerminalBridgeUserClosedError(error) {
  return /terminal session closed by user/i.test(String(error?.message || error || ""));
}

function terminalBridgeUserClosedMessage(agent, server) {
  const label = String(agent || "agent");
  return (
    `Terminal bridge for ${label} was closed by user on ${server?.name || "this server"}. ` +
    "Open the Terminal page for this SSH server, keep it alive, then retry the agent run."
  );
}

function findReusableTerminalSession(session, serverId, preferredTerminalId = "") {
  const owner = getTerminalOwner(session);
  const cleanTerminalId = normalizeTerminalSessionId(preferredTerminalId);
  const candidates = Array.from(terminalSessions.values())
    .filter(
      (terminalSession) =>
        terminalSession.owner === owner &&
        terminalSession.serverId === serverId &&
        !terminalSession.ended &&
        terminalSession.child?.stdin?.writable,
    )
    .sort((left, right) => {
      const rightAttached = right.sockets?.size ? 1 : 0;
      const leftAttached = left.sockets?.size ? 1 : 0;
      if (rightAttached !== leftAttached) return rightAttached - leftAttached;
      return Number(right.lastAttachedAt || 0) - Number(left.lastAttachedAt || 0);
    });

  if (cleanTerminalId) {
    return candidates.find((terminalSession) => terminalSession.id === cleanTerminalId) || null;
  }

  return candidates[0] || null;
}

function makeHereDocLines(variable, value, prefix) {
  let marker = `__COZYPAD_${prefix}_${crypto.randomBytes(8).toString("hex")}__`;
  const text = String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  while (text.includes(marker)) {
    marker = `__COZYPAD_${prefix}_${crypto.randomBytes(8).toString("hex")}__`;
  }
  return [`cat > "$${variable}" <<'${marker}'`, text, marker];
}

function buildTerminalAgentCliLines(agent, options = {}) {
  if (agent === "claude") {
    const claudeArgs = buildRemoteClaudeArgs(options.allowedDirs || [], options.model);
    return [
      ...remoteClaudeBootstrapLines(),
      'if ! command -v claude >/dev/null 2>&1; then printf "__COZYPAD_CLAUDE_MISSING__\\n" >&2; code=127;',
      "else",
      `  if claude ${claudeArgs} -p < "$prompt_file"; then code=0;`,
      `  else first_status=$?; if claude ${claudeArgs} --print < "$prompt_file"; then code=0; else code=$first_status; fi; fi`,
      "fi",
    ];
  }

  if (agent === "agy") {
    const agyArgs = buildRemoteAgyArgs(options.model);
    return [
      ...remoteAgyBootstrapLines(),
      'if ! command -v agy >/dev/null 2>&1; then printf "__COZYPAD_AGY_MISSING__\\n" >&2; code=127;',
      "else",
      '  agy_prompt=$(cat "$prompt_file")',
      `  if agy ${agyArgs} -p "$agy_prompt"; then code=0;`,
      `  else first_status=$?; if agy ${agyArgs} --print "$agy_prompt"; then code=0; elif agy ${agyArgs} < "$prompt_file"; then code=0; else code=$first_status; fi; fi`,
      "fi",
    ];
  }

  if (agent === "bailian") {
    const bailianArgs = buildRemoteBailianArgs(options.model);
    return [
      'if [ -s "$key_file" ]; then',
      '  cozypad_key=$(cat "$key_file" 2>/dev/null || true)',
      '  if [ -n "$cozypad_key" ]; then',
      '    export DASHSCOPE_API_KEY="$cozypad_key"',
      '    export BAILIAN_API_KEY="$cozypad_key"',
      '    export ALIBABA_CLOUD_API_KEY="$cozypad_key"',
      "  fi",
      "fi",
      ...remoteBailianBootstrapLines(),
      'if ! command -v bailian >/dev/null 2>&1; then printf "__COZYPAD_BAILIAN_MISSING__\\n" >&2; code=127;',
      "else",
      '  bailian_prompt=$(cat "$prompt_file")',
      `  if bailian text chat ${bailianArgs} --message "$bailian_prompt" --output text --quiet; then code=0;`,
      "  else code=$?; fi",
      "fi",
    ];
  }

  if (agent === "codex") {
    const codexArgs = DEFAULT_CODEX_ARGS
      .filter((arg) => arg !== "{prompt}" && !arg.includes("{prompt}"))
      .map(shellQuote)
      .join(" ");
    const codexOptionArgs = buildCodexOptionArgs(options).map(shellQuote).join(" ");
    return [
      ...remoteCodexBootstrapLines(),
      'if ! command -v codex >/dev/null 2>&1; then printf "[CozyPad] remote Codex CLI not found on this SSH server. Install it on the SSH server, then retry.\\n" >&2; code=127;',
      "else",
      '  version=$(codex --version 2>/dev/null | head -n 1 || true)',
      '  if [ -n "$version" ]; then printf "[CozyPad] remote %s\\n" "$version"; else printf "[CozyPad] remote codex\\n"; fi',
      `  codex ${codexArgs}${codexOptionArgs ? ` ${codexOptionArgs}` : ""} - < "$prompt_file"; code=$?`,
      "fi",
    ];
  }

  throw new Error(`Unsupported terminal bridge agent: ${agent}`);
}

function buildTerminalAgentCommand(agent, prompt, server, options = {}, jobId) {
  const startMarker = `__COZYPAD_TERMINAL_JOB_START__:${jobId}`;
  const endPrefix = `__COZYPAD_TERMINAL_JOB_END__:${jobId}:`;
  const remotePath = String(options.remotePath || server.defaultPath || "~").trim().slice(0, 240) || "~";
  const script = [
    "set +e",
    `printf '\\n${startMarker}\\n'`,
    'prompt_file=$(mktemp "${TMPDIR:-/tmp}/cozypad-agent-prompt.XXXXXX") || prompt_file=""',
    'key_file=$(mktemp "${TMPDIR:-/tmp}/cozypad-agent-key.XXXXXX") || key_file=""',
    'cleanup() { [ -n "$prompt_file" ] && rm -f "$prompt_file"; [ -n "$key_file" ] && rm -f "$key_file"; }',
    "trap cleanup EXIT INT TERM",
    'code=0',
    'if [ -z "$prompt_file" ]; then printf "[CozyPad] failed to create prompt temp file\\n" >&2; code=1;',
    "else",
    ...makeHereDocLines("prompt_file", prompt, "PROMPT"),
    ...makeHereDocLines("key_file", options.apiKey || "", "KEY"),
    `  cd ${shellQuote(remotePath)} 2>/dev/null || cd "$HOME" || code=72`,
    '  if [ "$code" -eq 0 ]; then',
    ...buildTerminalAgentCliLines(agent, options).map((line) => `    ${line}`),
    "  fi",
    "fi",
    `printf '\\n${endPrefix}%s\\n' "$code"`,
  ].join("\n");

  return [
    "",
    "stty -echo 2>/dev/null || true",
    buildRemoteClaudeShellCommand(script),
    "stty echo 2>/dev/null || true",
    "",
  ].join("\n");
}

function createTerminalAgentJob(terminalSession, agent, jobId) {
  const job = new EventEmitter();
  job.id = jobId;
  job.agent = agent;
  job.terminalId = terminalSession.id;
  job.serverId = terminalSession.serverId;
  job.closed = false;
  job.closeCode = null;
  job.closeError = null;
  job.stdout = new EventEmitter();
  job.stderr = new EventEmitter();
  job.kill = () => {
    try {
      terminalSession.child.stdin.write("\x03");
    } catch {
      // The terminal may already be closed.
    }
  };
  job.fail = (error) => failTerminalAgentJob(terminalSession, job, error);
  return job;
}

function closeTerminalAgentJob(terminalSession, job, code = 0) {
  if (!job || job.closed) {
    return;
  }
  job.closed = true;
  job.closeCode = code;
  if (terminalSession.activeAgentJob === job) {
    terminalSession.activeAgentJob = null;
  }
  job.emit("close", code);
}

function failTerminalAgentJob(terminalSession, job, error) {
  if (!job || job.closed) {
    return;
  }
  job.closed = true;
  job.closeError = error;
  if (terminalSession.activeAgentJob === job) {
    terminalSession.activeAgentJob = null;
  }
  job.emit("error", error);
}

async function spawnTerminalAgentJob(session, agent, prompt, server, options = {}) {
  const terminalSession = findReusableTerminalSession(session, server.id, options.terminalId || "");
  if (!terminalSession) {
    throw new Error(terminalBridgeUnavailableMessage(agent, server));
  }
  if (terminalSession.activeAgentJob && !terminalSession.activeAgentJob.closed) {
    throw new Error(
      `Terminal bridge on ${terminalSession.serverName} is busy with ${terminalSession.activeAgentJob.agent}. Wait for it to finish before starting another agent run.`,
    );
  }

  const jobId = `termjob_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
  const job = createTerminalAgentJob(terminalSession, agent, jobId);
  terminalSession.activeAgentJob = job;

  const startMarker = `__COZYPAD_TERMINAL_JOB_START__:${jobId}`;
  const endPrefix = `__COZYPAD_TERMINAL_JOB_END__:${jobId}:`;
  let started = false;
  let lineBuffer = "";

  const cleanup = () => {
    terminalSession.watchers.delete(watcher);
    if (timeout) clearTimeout(timeout);
    if (terminalSession.activeAgentJob === job) {
      terminalSession.activeAgentJob = null;
    }
  };

  const watcher = (text) => {
    lineBuffer += String(text || "");
    const lines = lineBuffer.split(/\n/);
    lineBuffer = lines.pop() || "";
    for (const rawLine of lines) {
      const normalized = normalizeTerminalMarkerLine(rawLine);
      if (!started) {
        if (normalized === startMarker) {
          started = true;
        }
        continue;
      }
      if (normalized.startsWith(endPrefix)) {
        const codeText = normalized.slice(endPrefix.length);
        const code = Number.parseInt(codeText, 10);
        cleanup();
        closeTerminalAgentJob(terminalSession, job, Number.isFinite(code) ? code : 0);
        return;
      }
      job.stdout.emit("data", Buffer.from(`${rawLine.replace(/\r$/, "")}\n`, "utf8"));
    }
  };

  const timeout = setTimeout(() => {
    cleanup();
    job.stderr.emit(
      "data",
      Buffer.from(
        `[CozyPad] terminal bridge ${agent} timed out after ${Math.round(
          TERMINAL_AGENT_RUN_TIMEOUT_MS / 1000,
        )}s\r\n`,
        "utf8",
      ),
    );
    try {
      terminalSession.child.stdin.write("\x03");
      terminalSession.child.stdin.write("stty echo 2>/dev/null || true\n");
    } catch {
      // The terminal may already be closed.
    }
    closeTerminalAgentJob(terminalSession, job, 124);
  }, TERMINAL_AGENT_RUN_TIMEOUT_MS);
  timeout.unref?.();

  terminalSession.watchers.add(watcher);
  try {
    terminalSession.child.stdin.write(
      buildTerminalAgentCommand(agent, prompt, server, options, jobId),
      "utf8",
      (error) => {
        if (!error) return;
        cleanup();
        failTerminalAgentJob(terminalSession, job, error);
      },
    );
  } catch (error) {
    cleanup();
    failTerminalAgentJob(terminalSession, job, error);
  }
  return job;
}

async function collectTerminalAgentJob(job, options = {}) {
  return new Promise((resolve) => {
    const stdoutLimit = options.stdoutLimit || 2 * 1024 * 1024;
    const stderrLimit = options.stderrLimit || 256 * 1024;
    let stdout = "";
    let stderr = "";
    let completed = false;

    const finish = (result) => {
      if (completed) return;
      completed = true;
      resolve(result);
    };

    job.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk.toString("utf8")}`.slice(-stdoutLimit);
    });
    job.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-stderrLimit);
    });
    job.on("error", (error) => {
      finish({ ok: false, code: -1, stdout, stderr: error?.message || stderr });
    });
    job.on("close", (code) => {
      finish({ ok: Number(code || 0) === 0, code: Number(code || 0), stdout, stderr });
    });
  });
}

async function runRemoteAgentPromptViaTerminal(session, agent, server, prompt, options = {}) {
  const startedAt = Date.now();
  const job = await spawnTerminalAgentJob(session, agent, prompt, server, options);
  const result = await collectTerminalAgentJob(job, {
    stdoutLimit: 2 * 1024 * 1024,
    stderrLimit: 256 * 1024,
  });
  const parsedResult =
    agent === "codex"
      ? normalizeCodexCliProcessResult(result)
      : {
          output: result.stdout || result.stderr || "",
          stderr: result.stderr || "",
        };
  const terminalBridgeClosedByUser =
    isTerminalBridgeUserClosedError(result.stderr) || isTerminalBridgeUserClosedError(result.stdout);
  const terminalBridgeClosedOutput = terminalBridgeClosedByUser
    ? `[CozyPad] ${agent} failed: ${terminalBridgeUserClosedMessage(agent, server)}`
    : "";
  return {
    server: publicSshServer({ ...server, defaultPath: options.remotePath || server.defaultPath }),
    status: result.ok ? "completed" : "failed",
    output: truncateForApi(
      terminalBridgeClosedOutput || parsedResult.output || parsedResult.stderr || "",
      128 * 1024,
    ),
    stderr: truncateForApi(terminalBridgeClosedOutput || parsedResult.stderr || ""),
    code: result.code,
    durationMs: Date.now() - startedAt,
    transport: "terminal",
    terminalId: job.terminalId,
  };
}

function getTerminalBridgeAgentStatus(session, server, agent, label) {
  const terminalSession = findReusableTerminalSession(session, server.id);
  const agentLower = String(agent || "").toLowerCase();
  const modelStatus =
    agentLower === "codex"
      ? { models: CODEX_MODEL_FALLBACKS, defaultModel: "" }
      : agentLower === "claude"
        ? { models: CLAUDE_MODEL_FALLBACKS, defaultModel: "" }
        : agentLower === "agy"
          ? { models: AGY_MODEL_FALLBACKS, defaultModel: "" }
          : agentLower === "bailian"
            ? bailianModelInfo()
          : {};
  return {
    server: publicSshServer(server),
    available: Boolean(terminalSession),
    path: terminalSession ? `terminal:${terminalSession.id}` : "",
    version: terminalSession ? `${label} terminal bridge` : "",
    error: terminalSession ? "" : terminalBridgeUnavailableMessage(agent, server),
    checkedAt: new Date().toISOString(),
    transport: "terminal",
    terminalId: terminalSession?.id || "",
    ...modelStatus,
  };
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
    // The browser may have closed the panel while a child process was writing.
  }
}

function sendRemoteAgentSocketControl(socket, agent, message) {
  sendWebSocketText(socket, `[CozyPad] remote ${remoteAgentRunLabel(agent)} ${message}\r\n`);
}

function normalizeRemoteAgentSocketPayload(payload) {
  let body = {};
  try {
    body = JSON.parse(Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload || "{}"));
  } catch {
    body = { prompt: Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload || "") };
  }
  return body && typeof body === "object" ? body : {};
}

async function runRemoteAgentSocketPrompt(socket, session, payload) {
  const body = normalizeRemoteAgentSocketPayload(payload);
  const agent = normalizeRemoteAgentRunAgent(body.agent);
  if (agent !== "claude" && agent !== "agy" && agent !== "bailian") {
    sendWebSocketText(socket, "[CozyPad] remote agent failed: unsupported agent\r\n");
    return;
  }

  const server = body.serverId ? await findServer(body.serverId, session) : null;
  if (!server) {
    sendRemoteAgentSocketControl(socket, agent, "failed: server is required");
    return;
  }

  const prompt = String(body.prompt || "").trim();
  if (!prompt) {
    sendRemoteAgentSocketControl(socket, agent, "failed: prompt is empty");
    return;
  }

  const remotePath =
    String(body.remotePath || server.defaultPath || "~")
      .trim()
      .slice(0, 240) || "~";
  const selectedServer = { ...server, defaultPath: remotePath };
  const label = remoteAgentRunLabel(agent);
  const startedAt = Date.now();
  sendRemoteAgentSocketControl(socket, agent, "starting");

  if (isSystemLocalServer(selectedServer)) {
    const result = await runRemoteAgentRunPromptForJob(session, agent, {
      ...body,
      serverId: selectedServer.id,
      remotePath,
    });
    const output = result.output || result.stderr || "";
    if (output) sendWebSocketText(socket, output.endsWith("\n") ? output : `${output}\r\n`);
    sendRemoteAgentSocketControl(
      socket,
      agent,
      result.status === "completed"
        ? `ready (${Date.now() - startedAt}ms)`
        : `exited with code ${result.code ?? "unknown"}`,
    );
    return;
  }

  const streamOptions = {
    owner: getTerminalOwner(session),
    remotePath,
    allowedDirs: body.allowedDirs,
    terminalId: body.terminalId,
    apiKey: agent === "bailian" ? extractBailianApiKeyText(body.apiKey || getBailianSessionKey(session)) : "",
    model:
      agent === "bailian"
        ? normalizeBailianModelOption(body.model)
        : normalizeCodexModelOption(body.model),
  };
  const job =
    AGENT_TERMINAL_BRIDGE_ENABLED &&
    body.terminalId &&
    findReusableTerminalSession(session, selectedServer.id, body.terminalId)
      ? await spawnTerminalAgentJob(session, agent, prompt, selectedServer, streamOptions)
      : await spawnRemoteAgentWorkerJob(agent, prompt, selectedServer, streamOptions);

  let stdout = "";
  let stderr = "";
  job.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stdout = `${stdout}${text}`.slice(-128 * 1024);
    sendWebSocketText(socket, text);
  });
  job.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderr = `${stderr}${text}`.slice(-32 * 1024);
    sendWebSocketText(socket, text);
  });
  job.on("error", (error) => {
    const message = error instanceof Error ? error.message : `${label} stream failed`;
    sendRemoteAgentSocketControl(socket, agent, `failed: ${message}`);
  });
  job.on("close", (code) => {
    const ok = Number(code || 0) === 0;
    if (!ok && !stdout.trim() && stderr.trim()) {
      sendWebSocketText(socket, stderr.endsWith("\n") ? stderr : `${stderr}\r\n`);
    }
    sendRemoteAgentSocketControl(
      socket,
      agent,
      ok ? `ready (${Date.now() - startedAt}ms)` : `exited with code ${code ?? "unknown"}`,
    );
  });
  await new Promise((resolve) => {
    job.once("error", resolve);
    job.once("close", resolve);
  });
}

function cleanRemoteAgentHistoryText(value, maxLength = 6000) {
  const text = String(value || "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n/)
    .filter((line) => {
      const lower = line.trim().toLowerCase();
      return lower && !lower.startsWith("[cozypad]");
    })
    .join("\n")
    .trim();
  return text.length > maxLength ? text.slice(-maxLength) : text;
}

function appendRemoteAgentSessionHistory(agentSession, limit, userPrompt, assistantOutput) {
  if (!agentSession) {
    return;
  }

  const prompt = cleanRemoteAgentHistoryText(userPrompt, 3000);
  const output = cleanRemoteAgentHistoryText(assistantOutput, 7000);
  if (!prompt && !output) {
    return;
  }

  const history = Array.isArray(agentSession.history) ? agentSession.history : [];
  history.push({
    prompt,
    output,
    timestamp: new Date().toISOString(),
  });
  agentSession.history = history.slice(-Math.max(1, Number(limit || 6)));
}

function buildRemoteAgentPromptWithHistory(agentLabel, agentSession, userPrompt, limit) {
  const prompt = String(userPrompt || "").trim();
  const history = (Array.isArray(agentSession?.history) ? agentSession.history : [])
    .slice(-Math.max(1, Number(limit || 6)))
    .map((turn, index) => {
      const user = cleanRemoteAgentHistoryText(turn.prompt, 2500);
      const assistant = cleanRemoteAgentHistoryText(turn.output, 5000);
      return [`Turn ${index + 1}`, user ? `User:\n${user}` : "", assistant ? `${agentLabel}:\n${assistant}` : ""]
        .filter(Boolean)
        .join("\n");
    })
    .filter(Boolean)
    .join("\n\n");

  if (!history) {
    return prompt;
  }

  return [
    `You are continuing the same CozyPad ${agentLabel} task.`,
    "Use the previous context only when it is relevant. Do not repeat old answers unless the user asks.",
    "",
    "Previous task context:",
    history,
    "",
    "Current user request:",
    prompt,
  ].join("\n");
}

function parseClaudeSessionPayload(payload) {
  const body = normalizeRemoteAgentSocketPayload(payload);
  return {
    prompt: String(body.prompt || "").trim(),
    remotePath: normalizeRemotePathOption(body.remotePath),
    allowedDirs: Array.isArray(body.allowedDirs) ? body.allowedDirs : [],
    terminalId: normalizeTerminalSessionId(body.terminalId),
    model: normalizeCodexModelOption(body.model),
  };
}

function getClaudeSessionKey(session, serverId, taskId = "") {
  const owner = getTerminalOwner(session);
  return `${owner}:claude:${String(serverId || "")}:${String(taskId || "")}`;
}

function trimClaudeSessionBuffer(value) {
  const text = String(value || "");
  if (text.length <= CLAUDE_SESSION_BUFFER_LIMIT) {
    return text;
  }
  return `[CozyPad] Claude output truncated\r\n${text.slice(-CLAUDE_SESSION_BUFFER_LIMIT)}`;
}

function appendClaudeSessionOutput(claudeSession, text) {
  if (!claudeSession || claudeSession.ended) {
    return;
  }

  const output = String(text || "");
  if (!output) {
    return;
  }

  claudeSession.buffer = trimClaudeSessionBuffer(`${claudeSession.buffer}${output}`);
  claudeSession.lastOutputAt = Date.now();

  for (const socket of claudeSession.sockets) {
    sendWebSocketText(socket, output);
  }
}

function isClaudeSessionJobClosed(job) {
  if (!job) return true;
  if (job.closed || job.killed) return true;
  return typeof job.exitCode !== "undefined" && job.exitCode !== null;
}

function reconcileClaudeSessionState(claudeSession) {
  if (!claudeSession?.activeJob) {
    return false;
  }

  if (!claudeSession.running || isClaudeSessionJobClosed(claudeSession.activeJob)) {
    claudeSession.activeJob = null;
    claudeSession.running = false;
    return true;
  }

  return false;
}

function scheduleClaudeSessionCleanup(claudeSession) {
  if (
    !claudeSession ||
    claudeSession.ended ||
    claudeSession.running ||
    claudeSession.sockets.size > 0 ||
    claudeSession.pendingPrompts.length > 0
  ) {
    return;
  }

  if (claudeSession.cleanupTimer) {
    clearTimeout(claudeSession.cleanupTimer);
  }

  claudeSession.cleanupTimer = setTimeout(() => {
    if (
      claudeSession.ended ||
      claudeSession.running ||
      claudeSession.sockets.size > 0 ||
      claudeSession.pendingPrompts.length > 0
    ) {
      return;
    }

    claudeSession.ended = true;
    claudeSessions.delete(claudeSession.key);
  }, CLAUDE_SESSION_DETACHED_TTL_MS);
  claudeSession.cleanupTimer.unref?.();
}

function detachClaudeSocket(claudeSession, socket) {
  if (!claudeSession) {
    return;
  }

  claudeSession.sockets.delete(socket);
  scheduleClaudeSessionCleanup(claudeSession);
}

function attachClaudeSocket(claudeSession, socket, options = {}) {
  if (!claudeSession || claudeSession.ended) {
    return;
  }

  reconcileClaudeSessionState(claudeSession);

  if (claudeSession.cleanupTimer) {
    clearTimeout(claudeSession.cleanupTimer);
    claudeSession.cleanupTimer = null;
  }

  claudeSession.sockets.add(socket);
  claudeSession.lastAttachedAt = Date.now();
  socket.setKeepAlive?.(true, 30000);

  if (claudeSession.buffer && !options.suppressReplay) {
    sendWebSocketText(socket, claudeSession.buffer);
  } else {
    sendWebSocketText(socket, `[CozyPad] remote Claude attached to ${claudeSession.serverName}\r\n`);
  }

  sendWebSocketText(
    socket,
    claudeSession.running
      ? "[CozyPad] remote Claude is still running in background\r\n"
      : "[CozyPad] remote Claude ready\r\n",
  );

  const pingTimer = setInterval(() => {
    sendWebSocketPing(socket);
    sendWebSocketText(socket, "[CozyPad] remote Claude heartbeat\r\n");
  }, TERMINAL_WS_PING_MS);
  pingTimer.unref?.();

  socket.on("close", () => {
    clearInterval(pingTimer);
    detachClaudeSocket(claudeSession, socket);
  });
  socket.on("error", () => {
    clearInterval(pingTimer);
    detachClaudeSocket(claudeSession, socket);
  });
}

function getOrCreateClaudeSession(session, selectedServer, taskId = "") {
  const key = getClaudeSessionKey(session, selectedServer.id, taskId);
  const owner = getTerminalOwner(session);
  const existing = claudeSessions.get(key);

  if (existing && !existing.ended) {
    existing.authSession = session;
    existing.taskId = taskId || existing.taskId || "";
    existing.selectedServer = selectedServer || existing.selectedServer;
    return existing;
  }

  const now = Date.now();
  const claudeSession = {
    key,
    owner,
    taskId,
    serverId: selectedServer.id,
    serverName: selectedServer.name,
    selectedServer,
    authSession: session,
    model: "",
    status: "completed",
    activeJob: null,
    pendingPrompts: [],
    history: [],
    running: false,
    sockets: new Set(),
    buffer: "",
    cleanupTimer: null,
    createdAt: now,
    lastAttachedAt: now,
    lastOutputAt: now,
    ended: false,
  };
  claudeSessions.set(key, claudeSession);
  return claudeSession;
}

function queueClaudeSessionPrompt(claudeSession, promptPayload) {
  if (!claudeSession || claudeSession.ended) {
    return;
  }

  if (claudeSession.pendingPrompts.length >= CLAUDE_SESSION_PENDING_LIMIT) {
    appendClaudeSessionOutput(
      claudeSession,
      `\r\n[CozyPad] remote Claude follow-up queue is full (${CLAUDE_SESSION_PENDING_LIMIT}). Wait for the current run to finish.\r\n`,
    );
    return;
  }

  claudeSession.pendingPrompts.push(promptPayload);
  appendClaudeSessionOutput(
    claudeSession,
    `\r\n[CozyPad] remote Claude queued follow-up (${claudeSession.pendingPrompts.length} pending)\r\n`,
  );
}

function findRunningClaudeSessionForServer(owner, serverId, excludeKey = "") {
  for (const session of claudeSessions.values()) {
    reconcileClaudeSessionState(session);
    if (
      session &&
      !session.ended &&
      session.running &&
      session.owner === owner &&
      session.serverId === serverId &&
      session.key !== excludeKey
    ) {
      return session;
    }
  }
  return null;
}

function runNextPendingClaudeSessionForServer(owner, serverId) {
  if (!owner || !serverId || findRunningClaudeSessionForServer(owner, serverId)) {
    return;
  }

  for (const session of claudeSessions.values()) {
    reconcileClaudeSessionState(session);
    if (
      !session ||
      session.ended ||
      session.running ||
      session.owner !== owner ||
      session.serverId !== serverId ||
      session.pendingPrompts.length === 0
    ) {
      continue;
    }

    const nextPrompt = session.pendingPrompts.shift();
    if (!nextPrompt) {
      continue;
    }

    appendClaudeSessionOutput(
      session,
      `\r\n[CozyPad] remote Claude running queued follow-up (${session.pendingPrompts.length} remaining)\r\n`,
    );
    setTimeout(() => {
      void runClaudeSessionPrompt(session, session.selectedServer, nextPrompt);
    }, 0);
    return;
  }
}

function finishClaudeSessionJob(claudeSession, job, message, selectedServer) {
  if (!claudeSession) {
    return;
  }
  if (job && claudeSession.activeJob !== job) {
    return;
  }

  claudeSession.activeJob = null;
  claudeSession.running = false;
  if (message) {
    appendClaudeSessionOutput(claudeSession, message);
  }

  const nextPrompt = claudeSession.pendingPrompts.shift();
  if (nextPrompt) {
    appendClaudeSessionOutput(
      claudeSession,
      `\r\n[CozyPad] remote Claude running queued follow-up (${claudeSession.pendingPrompts.length} remaining)\r\n`,
    );
    setTimeout(() => {
      void runClaudeSessionPrompt(claudeSession, selectedServer || claudeSession.selectedServer, nextPrompt);
    }, 0);
    return;
  }

  appendClaudeSessionOutput(claudeSession, "\r\n[CozyPad] remote Claude ready\r\n");
  scheduleClaudeSessionCleanup(claudeSession);
  runNextPendingClaudeSessionForServer(claudeSession.owner, claudeSession.serverId);
}

async function runClaudeSessionPrompt(claudeSession, selectedServer, payload) {
  if (!claudeSession || claudeSession.ended) {
    return;
  }

  const parsed = parseClaudeSessionPayload(payload);
  const remotePath = parsed.remotePath || selectedServer?.defaultPath || "~";
  const runServer = {
    ...selectedServer,
    defaultPath: remotePath,
  };
  const prompt = parsed.prompt;
  const queuedPromptPayload = JSON.stringify({
    prompt,
    remotePath,
    allowedDirs: parsed.allowedDirs,
    terminalId: parsed.terminalId,
    model: parsed.model,
  });
  claudeSession.selectedServer = runServer;
  claudeSession.model = parsed.model;
  const session = claudeSession.authSession;

  reconcileClaudeSessionState(claudeSession);

  if (!prompt) {
    claudeSession.status = "failed";
    appendClaudeSessionOutput(claudeSession, "[CozyPad] remote Claude failed: prompt is empty\r\n");
    finishClaudeSessionJob(claudeSession, null, "", runServer);
    return;
  }

  if (claudeSession.activeJob || claudeSession.running) {
    queueClaudeSessionPrompt(claudeSession, queuedPromptPayload);
    return;
  }

  const runningSession = findRunningClaudeSessionForServer(
    claudeSession.owner,
    claudeSession.serverId,
    claudeSession.key,
  );
  if (runningSession) {
    appendClaudeSessionOutput(
      claudeSession,
      `\r\n[CozyPad] another remote Claude task is already running on ${runServer.name}; queued this request.\r\n`,
    );
    queueClaudeSessionPrompt(claudeSession, queuedPromptPayload);
    return;
  }

  claudeSession.running = true;
  claudeSession.status = "running";
  appendClaudeSessionOutput(claudeSession, "\r\n[CozyPad] remote Claude starting\r\n");
  const promptForRun = buildRemoteAgentPromptWithHistory(
    "Claude",
    claudeSession,
    prompt,
    CLAUDE_SESSION_HISTORY_LIMIT,
  );

  if (isSystemLocalServer(runServer)) {
    try {
      const result = await runRemoteAgentRunPromptForJob(session, "claude", {
        serverId: runServer.id,
        prompt: promptForRun,
        remotePath,
        allowedDirs: parsed.allowedDirs,
        model: parsed.model,
      });
      const output = result.output || result.stderr || "";
      if (output) {
        appendClaudeSessionOutput(claudeSession, output.endsWith("\n") ? output : `${output}\r\n`);
      }
      if (result.status === "completed") {
        appendRemoteAgentSessionHistory(claudeSession, CLAUDE_SESSION_HISTORY_LIMIT, prompt, output);
      }
      claudeSession.status = result.status === "completed" ? "completed" : "failed";
      finishClaudeSessionJob(
        claudeSession,
        null,
        result.status === "completed"
          ? ""
          : `\r\n[CozyPad] remote Claude exited with code ${result.code ?? "unknown"}\r\n`,
        runServer,
      );
    } catch (error) {
      claudeSession.status = "failed";
      finishClaudeSessionJob(
        claudeSession,
        null,
        `\r\n[CozyPad] remote Claude failed: ${
          error instanceof Error ? error.message : String(error || "unknown error")
        }\r\n`,
        runServer,
      );
    }
    return;
  }

  const streamOptions = {
    owner: claudeSession.owner,
    remotePath,
    allowedDirs: parsed.allowedDirs,
    terminalId: parsed.terminalId,
    model: parsed.model,
  };

  let job;
  try {
    job =
      AGENT_TERMINAL_BRIDGE_ENABLED && findReusableTerminalSession(session, runServer.id, parsed.terminalId)
        ? await spawnTerminalAgentJob(session, "claude", promptForRun, runServer, streamOptions)
        : await spawnRemoteAgentWorkerJob("claude", promptForRun, runServer, streamOptions);
  } catch (error) {
    claudeSession.status = "failed";
    const terminalBridgeClosedByUser = isTerminalBridgeUserClosedError(error);
    finishClaudeSessionJob(
      claudeSession,
      null,
      terminalBridgeClosedByUser
        ? `\r\n[CozyPad] remote Claude failed: ${terminalBridgeUserClosedMessage("Claude", runServer)}\r\n`
        : `\r\n[CozyPad] remote Claude failed: ${
            error instanceof Error ? error.message : String(error || "unknown error")
          }\r\n`,
      runServer,
    );
    return;
  }

  claudeSession.activeJob = job;
  let stdout = "";
  let stderr = "";
  let settled = false;

  const finishOnce = (code, error = null) => {
    if (settled) return;
    settled = true;
    const errorMessage = error instanceof Error ? error.message : error ? String(error) : "";
    const terminalBridgeClosedByUser =
      isTerminalBridgeUserClosedError(errorMessage) ||
      isTerminalBridgeUserClosedError(stdout) ||
      isTerminalBridgeUserClosedError(stderr);
    const transportError = isRemoteCodexSshTransportError(`${stderr}\n${stdout}\n${errorMessage}`);
    const ok = !error && Number(code || 0) === 0;
    claudeSession.status = ok ? "completed" : "failed";
    if (ok) {
      appendRemoteAgentSessionHistory(claudeSession, CLAUDE_SESSION_HISTORY_LIMIT, prompt, stdout || stderr);
    }

    let message = "";
    if (!ok) {
      if (terminalBridgeClosedByUser) {
        message = `\r\n[CozyPad] remote Claude failed: ${terminalBridgeUserClosedMessage("Claude", runServer)}\r\n`;
      } else if (transportError) {
        message =
          "\r\n[CozyPad] remote Claude SSH transport was interrupted. CozyPad will not auto-retry to avoid SSH IP lockout.\r\n";
      } else if (errorMessage) {
        message = `\r\n[CozyPad] remote Claude failed: ${errorMessage}\r\n`;
      } else {
        message = `\r\n[CozyPad] remote Claude exited with code ${code ?? "unknown"}\r\n`;
      }
    }

    finishClaudeSessionJob(claudeSession, job, message, runServer);
  };

  job.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stdout = `${stdout}${text}`.slice(-128 * 1024);
    appendClaudeSessionOutput(claudeSession, text);
  });
  job.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderr = `${stderr}${text}`.slice(-32 * 1024);
    appendClaudeSessionOutput(claudeSession, text);
  });
  job.on("error", (error) => finishOnce(-1, error));
  job.on("close", (code) => finishOnce(code, null));
}

function parseAgySessionPayload(payload) {
  const body = normalizeRemoteAgentSocketPayload(payload);
  return {
    prompt: String(body.prompt || "").trim(),
    remotePath: normalizeRemotePathOption(body.remotePath),
    terminalId: normalizeTerminalSessionId(body.terminalId),
    model: normalizeCodexModelOption(body.model),
  };
}

function getAgySessionKey(session, serverId, taskId = "") {
  const owner = getTerminalOwner(session);
  return `${owner}:agy:${String(serverId || "")}:${String(taskId || "")}`;
}

function trimAgySessionBuffer(value) {
  const text = String(value || "");
  if (text.length <= AGY_SESSION_BUFFER_LIMIT) {
    return text;
  }
  return `[CozyPad] agy output truncated\r\n${text.slice(-AGY_SESSION_BUFFER_LIMIT)}`;
}

function appendAgySessionOutput(agySession, text) {
  if (!agySession || agySession.ended) {
    return;
  }

  const output = String(text || "");
  if (!output) {
    return;
  }

  agySession.buffer = trimAgySessionBuffer(`${agySession.buffer}${output}`);
  agySession.lastOutputAt = Date.now();

  for (const socket of agySession.sockets) {
    sendWebSocketText(socket, output);
  }
}

function isAgySessionJobClosed(job) {
  if (!job) return true;
  if (job.closed || job.killed) return true;
  return typeof job.exitCode !== "undefined" && job.exitCode !== null;
}

function reconcileAgySessionState(agySession) {
  if (!agySession?.activeJob) {
    return false;
  }

  if (!agySession.running || isAgySessionJobClosed(agySession.activeJob)) {
    agySession.activeJob = null;
    agySession.running = false;
    return true;
  }

  return false;
}

function scheduleAgySessionCleanup(agySession) {
  if (
    !agySession ||
    agySession.ended ||
    agySession.running ||
    agySession.sockets.size > 0 ||
    agySession.pendingPrompts.length > 0
  ) {
    return;
  }

  if (agySession.cleanupTimer) {
    clearTimeout(agySession.cleanupTimer);
  }

  agySession.cleanupTimer = setTimeout(() => {
    if (
      agySession.ended ||
      agySession.running ||
      agySession.sockets.size > 0 ||
      agySession.pendingPrompts.length > 0
    ) {
      return;
    }

    agySession.ended = true;
    agySessions.delete(agySession.key);
  }, AGY_SESSION_DETACHED_TTL_MS);
  agySession.cleanupTimer.unref?.();
}

function detachAgySocket(agySession, socket) {
  if (!agySession) {
    return;
  }

  agySession.sockets.delete(socket);
  scheduleAgySessionCleanup(agySession);
}

function attachAgySocket(agySession, socket, options = {}) {
  if (!agySession || agySession.ended) {
    return;
  }

  reconcileAgySessionState(agySession);

  if (agySession.cleanupTimer) {
    clearTimeout(agySession.cleanupTimer);
    agySession.cleanupTimer = null;
  }

  agySession.sockets.add(socket);
  agySession.lastAttachedAt = Date.now();
  socket.setKeepAlive?.(true, 30000);

  if (agySession.buffer && !options.suppressReplay) {
    sendWebSocketText(socket, agySession.buffer);
  } else {
    sendWebSocketText(socket, `[CozyPad] remote agy attached to ${agySession.serverName}\r\n`);
  }

  sendWebSocketText(
    socket,
    agySession.running
      ? "[CozyPad] remote agy is still running in background\r\n"
      : "[CozyPad] remote agy ready\r\n",
  );

  const pingTimer = setInterval(() => {
    sendWebSocketPing(socket);
    sendWebSocketText(socket, "[CozyPad] remote agy heartbeat\r\n");
  }, TERMINAL_WS_PING_MS);
  pingTimer.unref?.();

  socket.on("close", () => {
    clearInterval(pingTimer);
    detachAgySocket(agySession, socket);
  });
  socket.on("error", () => {
    clearInterval(pingTimer);
    detachAgySocket(agySession, socket);
  });
}

function getOrCreateAgySession(session, selectedServer, taskId = "") {
  const key = getAgySessionKey(session, selectedServer.id, taskId);
  const owner = getTerminalOwner(session);
  const existing = agySessions.get(key);

  if (existing && !existing.ended) {
    existing.authSession = session;
    existing.taskId = taskId || existing.taskId || "";
    existing.selectedServer = selectedServer || existing.selectedServer;
    return existing;
  }

  const now = Date.now();
  const agySession = {
    key,
    owner,
    taskId,
    serverId: selectedServer.id,
    serverName: selectedServer.name,
    selectedServer,
    authSession: session,
    model: "",
    status: "completed",
    activeJob: null,
    pendingPrompts: [],
    history: [],
    running: false,
    sockets: new Set(),
    buffer: "",
    cleanupTimer: null,
    createdAt: now,
    lastAttachedAt: now,
    lastOutputAt: now,
    ended: false,
  };
  agySessions.set(key, agySession);
  return agySession;
}

function queueAgySessionPrompt(agySession, promptPayload) {
  if (!agySession || agySession.ended) {
    return;
  }

  if (agySession.pendingPrompts.length >= AGY_SESSION_PENDING_LIMIT) {
    appendAgySessionOutput(
      agySession,
      `\r\n[CozyPad] remote agy follow-up queue is full (${AGY_SESSION_PENDING_LIMIT}). Wait for the current run to finish.\r\n`,
    );
    return;
  }

  agySession.pendingPrompts.push(promptPayload);
  appendAgySessionOutput(
    agySession,
    `\r\n[CozyPad] remote agy queued follow-up (${agySession.pendingPrompts.length} pending)\r\n`,
  );
}

function findRunningAgySessionForServer(owner, serverId, excludeKey = "") {
  for (const session of agySessions.values()) {
    reconcileAgySessionState(session);
    if (
      session &&
      !session.ended &&
      session.running &&
      session.owner === owner &&
      session.serverId === serverId &&
      session.key !== excludeKey
    ) {
      return session;
    }
  }
  return null;
}

function runNextPendingAgySessionForServer(owner, serverId) {
  if (!owner || !serverId || findRunningAgySessionForServer(owner, serverId)) {
    return;
  }

  for (const session of agySessions.values()) {
    reconcileAgySessionState(session);
    if (
      !session ||
      session.ended ||
      session.running ||
      session.owner !== owner ||
      session.serverId !== serverId ||
      session.pendingPrompts.length === 0
    ) {
      continue;
    }

    const nextPrompt = session.pendingPrompts.shift();
    if (!nextPrompt) {
      continue;
    }

    appendAgySessionOutput(
      session,
      `\r\n[CozyPad] remote agy running queued follow-up (${session.pendingPrompts.length} remaining)\r\n`,
    );
    setTimeout(() => {
      void runAgySessionPrompt(session, session.selectedServer, nextPrompt);
    }, 0);
    return;
  }
}

function finishAgySessionJob(agySession, job, message, selectedServer) {
  if (!agySession) {
    return;
  }
  if (job && agySession.activeJob !== job) {
    return;
  }

  agySession.activeJob = null;
  agySession.running = false;
  if (message) {
    appendAgySessionOutput(agySession, message);
  }

  const nextPrompt = agySession.pendingPrompts.shift();
  if (nextPrompt) {
    appendAgySessionOutput(
      agySession,
      `\r\n[CozyPad] remote agy running queued follow-up (${agySession.pendingPrompts.length} remaining)\r\n`,
    );
    setTimeout(() => {
      void runAgySessionPrompt(agySession, selectedServer || agySession.selectedServer, nextPrompt);
    }, 0);
    return;
  }

  appendAgySessionOutput(agySession, "\r\n[CozyPad] remote agy ready\r\n");
  scheduleAgySessionCleanup(agySession);
  runNextPendingAgySessionForServer(agySession.owner, agySession.serverId);
}

async function runAgySessionPrompt(agySession, selectedServer, payload) {
  if (!agySession || agySession.ended) {
    return;
  }

  const parsed = parseAgySessionPayload(payload);
  const remotePath = parsed.remotePath || selectedServer?.defaultPath || "~";
  const runServer = {
    ...selectedServer,
    defaultPath: remotePath,
  };
  const prompt = parsed.prompt;
  const queuedPromptPayload = JSON.stringify({
    prompt,
    remotePath,
    terminalId: parsed.terminalId,
    model: parsed.model,
  });
  agySession.selectedServer = runServer;
  agySession.model = parsed.model;
  const session = agySession.authSession;

  reconcileAgySessionState(agySession);

  if (!prompt) {
    agySession.status = "failed";
    appendAgySessionOutput(agySession, "[CozyPad] remote agy failed: prompt is empty\r\n");
    finishAgySessionJob(agySession, null, "", runServer);
    return;
  }

  if (agySession.activeJob || agySession.running) {
    queueAgySessionPrompt(agySession, queuedPromptPayload);
    return;
  }

  const runningSession = findRunningAgySessionForServer(
    agySession.owner,
    agySession.serverId,
    agySession.key,
  );
  if (runningSession) {
    appendAgySessionOutput(
      agySession,
      `\r\n[CozyPad] another remote agy task is already running on ${runServer.name}; queued this request.\r\n`,
    );
    queueAgySessionPrompt(agySession, queuedPromptPayload);
    return;
  }

  agySession.running = true;
  agySession.status = "running";
  appendAgySessionOutput(agySession, "\r\n[CozyPad] remote agy starting\r\n");
  const promptForRun = buildRemoteAgentPromptWithHistory(
    "agy",
    agySession,
    prompt,
    AGY_SESSION_HISTORY_LIMIT,
  );

  if (isSystemLocalServer(runServer)) {
    try {
      const result = await runRemoteAgentRunPromptForJob(session, "agy", {
        serverId: runServer.id,
        prompt: promptForRun,
        remotePath,
        model: parsed.model,
      });
      const output = result.output || result.stderr || "";
      if (output) {
        appendAgySessionOutput(agySession, output.endsWith("\n") ? output : `${output}\r\n`);
      }
      if (result.status === "completed") {
        appendRemoteAgentSessionHistory(agySession, AGY_SESSION_HISTORY_LIMIT, prompt, output);
      }
      agySession.status = result.status === "completed" ? "completed" : "failed";
      finishAgySessionJob(
        agySession,
        null,
        result.status === "completed"
          ? ""
          : `\r\n[CozyPad] remote agy exited with code ${result.code ?? "unknown"}\r\n`,
        runServer,
      );
    } catch (error) {
      agySession.status = "failed";
      finishAgySessionJob(
        agySession,
        null,
        `\r\n[CozyPad] remote agy failed: ${
          error instanceof Error ? error.message : String(error || "unknown error")
        }\r\n`,
        runServer,
      );
    }
    return;
  }

  const streamOptions = {
    owner: agySession.owner,
    remotePath,
    terminalId: parsed.terminalId,
    model: parsed.model,
  };

  let job;
  try {
    job =
      AGENT_TERMINAL_BRIDGE_ENABLED && findReusableTerminalSession(session, runServer.id, parsed.terminalId)
        ? await spawnTerminalAgentJob(session, "agy", promptForRun, runServer, streamOptions)
        : await spawnRemoteAgentWorkerJob("agy", promptForRun, runServer, streamOptions);
  } catch (error) {
    agySession.status = "failed";
    const terminalBridgeClosedByUser = isTerminalBridgeUserClosedError(error);
    finishAgySessionJob(
      agySession,
      null,
      terminalBridgeClosedByUser
        ? `\r\n[CozyPad] remote agy failed: ${terminalBridgeUserClosedMessage("agy", runServer)}\r\n`
        : `\r\n[CozyPad] remote agy failed: ${
            error instanceof Error ? error.message : String(error || "unknown error")
          }\r\n`,
      runServer,
    );
    return;
  }

  agySession.activeJob = job;
  let stdout = "";
  let stderr = "";
  let settled = false;

  const finishOnce = (code, error = null) => {
    if (settled) return;
    settled = true;
    const errorMessage = error instanceof Error ? error.message : error ? String(error) : "";
    const terminalBridgeClosedByUser =
      isTerminalBridgeUserClosedError(errorMessage) ||
      isTerminalBridgeUserClosedError(stdout) ||
      isTerminalBridgeUserClosedError(stderr);
    const transportError = isRemoteCodexSshTransportError(`${stderr}\n${stdout}\n${errorMessage}`);
    const ok = !error && Number(code || 0) === 0;
    agySession.status = ok ? "completed" : "failed";
    if (ok) {
      appendRemoteAgentSessionHistory(agySession, AGY_SESSION_HISTORY_LIMIT, prompt, stdout || stderr);
    }

    let message = "";
    if (!ok) {
      if (terminalBridgeClosedByUser) {
        message = `\r\n[CozyPad] remote agy failed: ${terminalBridgeUserClosedMessage("agy", runServer)}\r\n`;
      } else if (transportError) {
        message =
          "\r\n[CozyPad] remote agy SSH transport was interrupted. CozyPad will not auto-retry to avoid SSH IP lockout.\r\n";
      } else if (errorMessage) {
        message = `\r\n[CozyPad] remote agy failed: ${errorMessage}\r\n`;
      } else {
        message = `\r\n[CozyPad] remote agy exited with code ${code ?? "unknown"}\r\n`;
      }
    }

    finishAgySessionJob(agySession, job, message, runServer);
  };

  job.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stdout = `${stdout}${text}`.slice(-128 * 1024);
    appendAgySessionOutput(agySession, text);
  });
  job.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderr = `${stderr}${text}`.slice(-32 * 1024);
    appendAgySessionOutput(agySession, text);
  });
  job.on("error", (error) => finishOnce(-1, error));
  job.on("close", (code) => finishOnce(code, null));
}

function parseBailianSessionPayload(payload) {
  const body = normalizeRemoteAgentSocketPayload(payload);
  return {
    prompt: String(body.prompt || "").trim(),
    remotePath: normalizeRemotePathOption(body.remotePath),
    terminalId: normalizeTerminalSessionId(body.terminalId),
    apiKey: extractBailianApiKeyText(body.apiKey || ""),
    model: normalizeBailianModelOption(body.model),
  };
}

function getBailianSessionKeyForTask(session, serverId, taskId = "") {
  const owner = getTerminalOwner(session);
  return `${owner}:bailian:${String(serverId || "")}:${String(taskId || "")}`;
}

function trimBailianSessionBuffer(value) {
  const text = String(value || "");
  if (text.length <= BAILIAN_SESSION_BUFFER_LIMIT) {
    return text;
  }
  return `[CozyPad] bailian output truncated\r\n${text.slice(-BAILIAN_SESSION_BUFFER_LIMIT)}`;
}

function appendBailianSessionOutput(bailianSession, text) {
  if (!bailianSession || bailianSession.ended) {
    return;
  }

  const output = String(text || "");
  if (!output) {
    return;
  }

  bailianSession.buffer = trimBailianSessionBuffer(`${bailianSession.buffer}${output}`);
  bailianSession.lastOutputAt = Date.now();

  for (const socket of bailianSession.sockets) {
    sendWebSocketText(socket, output);
  }
}

function isBailianSessionJobClosed(job) {
  if (!job) return true;
  if (job.closed || job.killed) return true;
  return typeof job.exitCode !== "undefined" && job.exitCode !== null;
}

function reconcileBailianSessionState(bailianSession) {
  if (!bailianSession?.activeJob) {
    return false;
  }

  if (!bailianSession.running || isBailianSessionJobClosed(bailianSession.activeJob)) {
    bailianSession.activeJob = null;
    bailianSession.running = false;
    return true;
  }

  return false;
}

function scheduleBailianSessionCleanup(bailianSession) {
  if (
    !bailianSession ||
    bailianSession.ended ||
    bailianSession.running ||
    bailianSession.sockets.size > 0 ||
    bailianSession.pendingPrompts.length > 0
  ) {
    return;
  }

  if (bailianSession.cleanupTimer) {
    clearTimeout(bailianSession.cleanupTimer);
  }

  bailianSession.cleanupTimer = setTimeout(() => {
    if (
      bailianSession.ended ||
      bailianSession.running ||
      bailianSession.sockets.size > 0 ||
      bailianSession.pendingPrompts.length > 0
    ) {
      return;
    }

    bailianSession.ended = true;
    bailianSessions.delete(bailianSession.key);
  }, BAILIAN_SESSION_DETACHED_TTL_MS);
  bailianSession.cleanupTimer.unref?.();
}

function detachBailianSocket(bailianSession, socket) {
  if (!bailianSession) {
    return;
  }

  bailianSession.sockets.delete(socket);
  scheduleBailianSessionCleanup(bailianSession);
}

function attachBailianSocket(bailianSession, socket, options = {}) {
  if (!bailianSession || bailianSession.ended) {
    return;
  }

  reconcileBailianSessionState(bailianSession);

  if (bailianSession.cleanupTimer) {
    clearTimeout(bailianSession.cleanupTimer);
    bailianSession.cleanupTimer = null;
  }

  bailianSession.sockets.add(socket);
  bailianSession.lastAttachedAt = Date.now();
  socket.setKeepAlive?.(true, 30000);

  if (bailianSession.buffer && !options.suppressReplay) {
    sendWebSocketText(socket, bailianSession.buffer);
  } else {
    sendWebSocketText(socket, `[CozyPad] remote bailian attached to ${bailianSession.serverName}\r\n`);
  }

  sendWebSocketText(
    socket,
    bailianSession.running
      ? "[CozyPad] remote bailian is still running in background\r\n"
      : "[CozyPad] remote bailian ready\r\n",
  );

  const pingTimer = setInterval(() => {
    sendWebSocketPing(socket);
    sendWebSocketText(socket, "[CozyPad] remote bailian heartbeat\r\n");
  }, TERMINAL_WS_PING_MS);
  pingTimer.unref?.();

  socket.on("close", () => {
    clearInterval(pingTimer);
    detachBailianSocket(bailianSession, socket);
  });
  socket.on("error", () => {
    clearInterval(pingTimer);
    detachBailianSocket(bailianSession, socket);
  });
}

function getOrCreateBailianSession(session, selectedServer, taskId = "") {
  const key = getBailianSessionKeyForTask(session, selectedServer.id, taskId);
  const owner = getTerminalOwner(session);
  const existing = bailianSessions.get(key);

  if (existing && !existing.ended) {
    existing.authSession = session;
    existing.taskId = taskId || existing.taskId || "";
    existing.selectedServer = selectedServer || existing.selectedServer;
    return existing;
  }

  const now = Date.now();
  const bailianSession = {
    key,
    owner,
    taskId,
    serverId: selectedServer.id,
    serverName: selectedServer.name,
    selectedServer,
    authSession: session,
    model: "",
    status: "completed",
    activeJob: null,
    pendingPrompts: [],
    running: false,
    sockets: new Set(),
    buffer: "",
    cleanupTimer: null,
    createdAt: now,
    lastAttachedAt: now,
    lastOutputAt: now,
    ended: false,
  };
  bailianSessions.set(key, bailianSession);
  return bailianSession;
}

function queueBailianSessionPrompt(bailianSession, promptPayload) {
  if (!bailianSession || bailianSession.ended) {
    return;
  }

  if (bailianSession.pendingPrompts.length >= BAILIAN_SESSION_PENDING_LIMIT) {
    appendBailianSessionOutput(
      bailianSession,
      `\r\n[CozyPad] remote bailian follow-up queue is full (${BAILIAN_SESSION_PENDING_LIMIT}). Wait for the current run to finish.\r\n`,
    );
    return;
  }

  bailianSession.pendingPrompts.push(promptPayload);
  appendBailianSessionOutput(
    bailianSession,
    `\r\n[CozyPad] remote bailian queued follow-up (${bailianSession.pendingPrompts.length} pending)\r\n`,
  );
}

function findRunningBailianSessionForServer(owner, serverId, excludeKey = "") {
  for (const session of bailianSessions.values()) {
    reconcileBailianSessionState(session);
    if (
      session &&
      !session.ended &&
      session.running &&
      session.owner === owner &&
      session.serverId === serverId &&
      session.key !== excludeKey
    ) {
      return session;
    }
  }
  return null;
}

function runNextPendingBailianSessionForServer(owner, serverId) {
  if (!owner || !serverId || findRunningBailianSessionForServer(owner, serverId)) {
    return;
  }

  for (const session of bailianSessions.values()) {
    reconcileBailianSessionState(session);
    if (
      !session ||
      session.ended ||
      session.running ||
      session.owner !== owner ||
      session.serverId !== serverId ||
      session.pendingPrompts.length === 0
    ) {
      continue;
    }

    const nextPrompt = session.pendingPrompts.shift();
    if (!nextPrompt) {
      continue;
    }

    appendBailianSessionOutput(
      session,
      `\r\n[CozyPad] remote bailian running queued follow-up (${session.pendingPrompts.length} remaining)\r\n`,
    );
    setTimeout(() => {
      void runBailianSessionPrompt(session, session.selectedServer, nextPrompt);
    }, 0);
    return;
  }
}

function finishBailianSessionJob(bailianSession, job, message, selectedServer) {
  if (!bailianSession) {
    return;
  }
  if (job && bailianSession.activeJob !== job) {
    return;
  }

  bailianSession.activeJob = null;
  bailianSession.running = false;
  if (message) {
    appendBailianSessionOutput(bailianSession, message);
  }

  const nextPrompt = bailianSession.pendingPrompts.shift();
  if (nextPrompt) {
    appendBailianSessionOutput(
      bailianSession,
      `\r\n[CozyPad] remote bailian running queued follow-up (${bailianSession.pendingPrompts.length} remaining)\r\n`,
    );
    setTimeout(() => {
      void runBailianSessionPrompt(bailianSession, selectedServer || bailianSession.selectedServer, nextPrompt);
    }, 0);
    return;
  }

  appendBailianSessionOutput(bailianSession, "\r\n[CozyPad] remote bailian ready\r\n");
  scheduleBailianSessionCleanup(bailianSession);
  runNextPendingBailianSessionForServer(bailianSession.owner, bailianSession.serverId);
}

async function runBailianSessionPrompt(bailianSession, selectedServer, payload) {
  if (!bailianSession || bailianSession.ended) {
    return;
  }

  const parsed = parseBailianSessionPayload(payload);
  const remotePath = parsed.remotePath || selectedServer?.defaultPath || "~";
  const runServer = {
    ...selectedServer,
    defaultPath: remotePath,
  };
  const prompt = parsed.prompt;
  const apiKey = parsed.apiKey || getBailianSessionKey(bailianSession.authSession);
  const queuedPromptPayload = JSON.stringify({
    prompt,
    remotePath,
    terminalId: parsed.terminalId,
    apiKey,
    model: parsed.model,
  });
  bailianSession.selectedServer = runServer;
  bailianSession.model = parsed.model;
  const session = bailianSession.authSession;

  reconcileBailianSessionState(bailianSession);

  if (!prompt) {
    bailianSession.status = "failed";
    appendBailianSessionOutput(bailianSession, "[CozyPad] remote bailian failed: prompt is empty\r\n");
    finishBailianSessionJob(bailianSession, null, "", runServer);
    return;
  }

  if (bailianSession.activeJob || bailianSession.running) {
    queueBailianSessionPrompt(bailianSession, queuedPromptPayload);
    return;
  }

  const runningSession = findRunningBailianSessionForServer(
    bailianSession.owner,
    bailianSession.serverId,
    bailianSession.key,
  );
  if (runningSession) {
    appendBailianSessionOutput(
      bailianSession,
      `\r\n[CozyPad] another remote bailian task is already running on ${runServer.name}; queued this request.\r\n`,
    );
    queueBailianSessionPrompt(bailianSession, queuedPromptPayload);
    return;
  }

  bailianSession.running = true;
  bailianSession.status = "running";
  bailianSession.buffer = "";
  appendBailianSessionOutput(bailianSession, "\r\n[CozyPad] remote bailian starting\r\n");

  if (isSystemLocalServer(runServer)) {
    try {
      const result = await runRemoteAgentRunPromptForJob(session, "bailian", {
        serverId: runServer.id,
        prompt,
        remotePath,
        apiKey,
        model: parsed.model,
      });
      const output = result.output || result.stderr || "";
      if (output) {
        appendBailianSessionOutput(bailianSession, output.endsWith("\n") ? output : `${output}\r\n`);
      }
      bailianSession.status = result.status === "completed" ? "completed" : "failed";
      finishBailianSessionJob(
        bailianSession,
        null,
        result.status === "completed"
          ? ""
          : `\r\n[CozyPad] remote bailian exited with code ${result.code ?? "unknown"}\r\n`,
        runServer,
      );
    } catch (error) {
      bailianSession.status = "failed";
      finishBailianSessionJob(
        bailianSession,
        null,
        `\r\n[CozyPad] remote bailian failed: ${
          error instanceof Error ? error.message : String(error || "unknown error")
        }\r\n`,
        runServer,
      );
    }
    return;
  }

  const streamOptions = {
    owner: bailianSession.owner,
    remotePath,
    terminalId: parsed.terminalId,
    apiKey,
    model: parsed.model,
  };

  let job;
  try {
    job =
      AGENT_TERMINAL_BRIDGE_ENABLED && findReusableTerminalSession(session, runServer.id, parsed.terminalId)
        ? await spawnTerminalAgentJob(session, "bailian", prompt, runServer, streamOptions)
        : await spawnRemoteAgentWorkerJob("bailian", prompt, runServer, streamOptions);
  } catch (error) {
    bailianSession.status = "failed";
    const terminalBridgeClosedByUser = isTerminalBridgeUserClosedError(error);
    finishBailianSessionJob(
      bailianSession,
      null,
      terminalBridgeClosedByUser
        ? `\r\n[CozyPad] remote bailian failed: ${terminalBridgeUserClosedMessage("bailian", runServer)}\r\n`
        : `\r\n[CozyPad] remote bailian failed: ${
            error instanceof Error ? error.message : String(error || "unknown error")
          }\r\n`,
      runServer,
    );
    return;
  }

  bailianSession.activeJob = job;
  let stdout = "";
  let stderr = "";
  let settled = false;

  const finishOnce = (code, error = null) => {
    if (settled) return;
    settled = true;
    const errorMessage = error instanceof Error ? error.message : error ? String(error) : "";
    const terminalBridgeClosedByUser =
      isTerminalBridgeUserClosedError(errorMessage) ||
      isTerminalBridgeUserClosedError(stdout) ||
      isTerminalBridgeUserClosedError(stderr);
    const transportError = isRemoteCodexSshTransportError(`${stderr}\n${stdout}\n${errorMessage}`);
    const ok = !error && Number(code || 0) === 0;
    bailianSession.status = ok ? "completed" : "failed";

    let message = "";
    if (!ok) {
      if (terminalBridgeClosedByUser) {
        message = `\r\n[CozyPad] remote bailian failed: ${terminalBridgeUserClosedMessage("bailian", runServer)}\r\n`;
      } else if (transportError) {
        message =
          "\r\n[CozyPad] remote bailian SSH transport was interrupted. CozyPad will not auto-retry to avoid SSH IP lockout.\r\n";
      } else if (errorMessage) {
        message = `\r\n[CozyPad] remote bailian failed: ${errorMessage}\r\n`;
      } else {
        message = `\r\n[CozyPad] remote bailian exited with code ${code ?? "unknown"}\r\n`;
      }
    }

    finishBailianSessionJob(bailianSession, job, message, runServer);
  };

  job.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stdout = `${stdout}${text}`.slice(-128 * 1024);
    appendBailianSessionOutput(bailianSession, text);
  });
  job.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderr = `${stderr}${text}`.slice(-32 * 1024);
    appendBailianSessionOutput(bailianSession, text);
  });
  job.on("error", (error) => finishOnce(-1, error));
  job.on("close", (code) => finishOnce(code, null));
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

function splitCommandLine(value) {
  const args = [];
  let current = "";
  let quote = "";
  let escaping = false;

  for (const char of String(value || "")) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += "\\";
  }

  if (current) {
    args.push(current);
  }

  return args;
}

function normalizeCodexModelOption(value) {
  const model = stripAnsiText(value).trim().slice(0, 80);
  return /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(model) ? model : "";
}

function stripAnsiText(value) {
  return String(value || "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\[[0-9;]*m\]/g, "");
}

function normalizeCodexModelList(values = []) {
  const seen = new Set();
  const models = [];
  for (const value of values || []) {
    const model = normalizeCodexModelOption(value);
    const key = model.toLowerCase();
    if (!model || seen.has(key)) {
      continue;
    }
    seen.add(key);
    models.push(model);
  }
  return models;
}

function extractMarkedBlock(text, beginMarker, endMarker) {
  const raw = String(text || "");
  const begin = raw.indexOf(beginMarker);
  if (begin < 0) return "";
  const start = begin + beginMarker.length;
  const end = raw.indexOf(endMarker, start);
  return end >= 0 ? raw.slice(start, end) : raw.slice(start);
}

function parseModelNamesFromText(text, fallbacks = []) {
  const models = [];
  const clean = stripAnsiText(text);
  const patterns = [
    /\bclaude-[A-Za-z0-9._-]+\b/g,
    /\bgemini-[A-Za-z0-9._-]+\b/g,
    /\bgpt-[A-Za-z0-9._-]+\b/g,
    /\bqwen[A-Za-z0-9._-]*\b/gi,
    /\bdeepseek-[A-Za-z0-9._-]+\b/gi,
    /\bkimi-[A-Za-z0-9._-]+\b/gi,
    /\bglm-[A-Za-z0-9._-]+\b/gi,
    /\bminimax-[A-Za-z0-9._-]+\b/gi,
    /\b(?:opus|sonnet|haiku|fable)\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of clean.matchAll(pattern)) {
      models.push(match[0]);
    }
  }
  return normalizeCodexModelList([...models, ...fallbacks]);
}

function parseAgentModelMarkers(text, defaultMarker, beginMarker, endMarker, fallbacks = []) {
  let defaultModel = "";
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = stripAnsiText(line).trim();
    if (trimmed.startsWith(defaultMarker)) {
      defaultModel = normalizeCodexModelOption(trimmed.slice(defaultMarker.length));
      break;
    }
  }
  const block = extractMarkedBlock(text, beginMarker, endMarker);
  return {
    defaultModel,
    models: normalizeCodexModelList([
      defaultModel,
      ...parseModelNamesFromText(block, fallbacks),
    ]),
  };
}

function parseCodexDebugModelsJson(text) {
  try {
    const parsed = JSON.parse(String(text || ""));
    const rows = Array.isArray(parsed?.models) ? parsed.models : [];
    return normalizeCodexModelList(
      rows.map((row) => row?.slug || row?.id || row?.model || row?.name),
    );
  } catch {
    return [];
  }
}

function parseCodexDefaultModelFromConfig(text) {
  const match = String(text || "").match(/^\s*model\s*=\s*["']?([^"'\s#]+)["']?/m);
  return normalizeCodexModelOption(match?.[1] || "");
}

function parseCodexModelMarkers(text) {
  const models = [];
  let defaultModel = "";
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(CODEX_MODEL_MARKER)) {
      models.push(trimmed.slice(CODEX_MODEL_MARKER.length));
    } else if (trimmed.startsWith(CODEX_DEFAULT_MODEL_MARKER)) {
      defaultModel = normalizeCodexModelOption(trimmed.slice(CODEX_DEFAULT_MODEL_MARKER.length));
    }
  }
  return {
    defaultModel,
    models: normalizeCodexModelList(models),
  };
}

async function getLocalCodexModelInfo(session, cli) {
  let defaultModel = "";
  try {
    defaultModel = parseCodexDefaultModelFromConfig(
      await readFile(path.join(getUserCodexHome(session), "config.toml"), "utf8"),
    );
  } catch {
    defaultModel = "";
  }

  let models = [];
  if (cli?.available) {
    try {
      const result = await runProcess(cli.command, [...(cli.args || []), "debug", "models"], {
        cwd: appRoot,
        env: getCodexEnv(session),
        timeoutMs: 12000,
        stdoutLimit: 4 * 1024 * 1024,
        stderrLimit: 64 * 1024,
      });
      if (result.ok) {
        models = parseCodexDebugModelsJson(result.stdout);
      }
    } catch {
      models = [];
    }
  }

  return {
    defaultModel,
    models: normalizeCodexModelList([defaultModel, ...models, ...CODEX_MODEL_FALLBACKS]),
  };
}

function normalizeCodexReasoningEffortOption(value) {
  const effort = String(value || "").trim().toLowerCase();
  return CODEX_REASONING_EFFORTS.has(effort) ? effort : "";
}

function normalizeRemotePathOption(value) {
  return String(value || "").trim().slice(0, 240) || "~";
}

function normalizeCodexRunOptions(value = {}) {
  return {
    model: normalizeCodexModelOption(value.model),
    reasoningEffort: normalizeCodexReasoningEffortOption(value.reasoningEffort),
  };
}

function buildCodexOptionArgs(options = {}) {
  const normalized = normalizeCodexRunOptions(options);
  const args = [];
  if (normalized.model) {
    args.push("--model", normalized.model);
  }
  if (normalized.reasoningEffort) {
    args.push("-c", `${CODEX_REASONING_CONFIG_KEY}=${normalized.reasoningEffort}`);
  }
  return args;
}

function expandCodexArgsTemplate(template, prompt, options = {}) {
  const optionArgs = buildCodexOptionArgs(options);
  const hasPromptPlaceholder = template.some((arg) => arg.includes("{prompt}"));

  if (!hasPromptPlaceholder) {
    return [...template, ...optionArgs, prompt];
  }

  const args = [];
  let insertedOptions = false;
  for (const arg of template) {
    if (arg === "{codexOptions}") {
      args.push(...optionArgs);
      insertedOptions = true;
      continue;
    }
    if (arg.includes("{prompt}") && !insertedOptions) {
      args.push(...optionArgs);
      insertedOptions = true;
    }
    args.push(arg.replaceAll("{prompt}", prompt));
  }
  if (!insertedOptions) {
    args.push(...optionArgs);
  }
  return args;
}

function encodeRemoteJobField(value) {
  const text = String(value || "");
  return text ? base64EncodeUtf8(text) : "-";
}

function splitRemoteJobField(value, chunkSize = 4096) {
  const text = String(value || "");
  if (!text) return [];
  const chunks = [];
  for (let index = 0; index < text.length; index += chunkSize) {
    chunks.push(text.slice(index, index + chunkSize));
  }
  return chunks;
}

function buildCodexCommand(prompt, options = {}) {
  const cli =
    getCodexCandidates().find(
      (candidate) =>
        candidate.source === "configured" ||
        candidate.args.length > 0 ||
        path.isAbsolute(candidate.command),
    ) || { command: "codex", args: [] };
  const template = process.env.COZYPAD_CODEX_ARGS
    ? splitCommandLine(process.env.COZYPAD_CODEX_ARGS)
    : DEFAULT_CODEX_ARGS;
  const args = expandCodexArgsTemplate(template, prompt, options);

  return { command: cli.command, args: [...cli.args, ...args] };
}

function formatCommandForCodex(command, args) {
  const commandParts = isRtkAvailable() ? ["rtk", "proxy", command, ...args] : [command, ...args];
  const parts = commandParts.map((part) => `'${String(part).replace(/'/g, "''")}'`);
  return `& ${parts.join(" ")}`;
}

function remoteShellCwd(value) {
  const remotePath = String(value || "~").trim() || "~";
  if (remotePath === "~") {
    return '"$HOME"';
  }

  if (remotePath.startsWith("~/")) {
    const remainder = remotePath.slice(2);
    return remainder ? `"$HOME"/${shellQuote(remainder)}` : '"$HOME"';
  }

  return shellQuote(remotePath);
}

function buildRemoteCodexPrompt(server, userPrompt, history = null) {
  const target = getServerTargetLabel(server);
  const historyText = formatCodexHistoryForPrompt(history);

  return `
You are Codex running directly on the SSH server selected in CozyPad.

Treat all unqualified shell commands, file paths, "~", "home", "this machine",
and "server" as referring to this SSH server.

Remote SSH target:
- name: ${server.name}
- target: ${target}
- default remote path: ${server.defaultPath || "~"}

Rules:
- Do not refer to or depend on the CozyPad Windows host.
- Inspect, create, edit, delete, install, and run commands only on this SSH server.
- If images are attached, they have already been staged on this SSH server and
  passed to Codex CLI with --image. Do not ask the user to manually save the image
  or provide a server-side image path unless the user explicitly asks for that.
- If an attached screenshot contains an old error message, describe it as screenshot
  content; do not treat it as proof that the current CozyPad image transfer failed.
- When the user asks to switch the working directory or project root for future CozyPad
  Codex prompts, output one plain line exactly like: [CozyPad cwd] /new/remote/path
  after confirming or creating that directory. Do not wrap this marker in code fences.
- Keep the final answer concise and mention only what happened on this SSH server.

CozyPad Codex conversation history for context:
${historyText}

User request:
${userPrompt}
`.trim();
}

function buildLocalCodexPrompt(server, userPrompt, history = null) {
  const historyText = formatCodexHistoryForPrompt(history);

  return `
You are Codex running on the localhost machine selected in CozyPad.

Treat all unqualified shell commands, file paths, "~", "home", "this machine",
and "localhost" as referring to this local machine.

Local target:
- name: ${server.name}
- default local path: ${server.defaultPath || os.homedir()}

Rules:
- Do not use SSH for localhost work.
- Inspect, create, edit, delete, install, and run commands only on this localhost target.
- If images are attached, they have already been staged on localhost and passed
  to Codex CLI with --image.
- When the user asks to switch the working directory or project root for future CozyPad
  Codex prompts, output one plain line exactly like: [CozyPad cwd] C:\\new\\local\\path
  after confirming or creating that directory. Do not wrap this marker in code fences.
- Keep the final answer concise and mention only what happened on localhost.

CozyPad Codex conversation history for context:
${historyText}

User request:
${userPrompt}
`.trim();
}

function buildRemoteCodexCommand(server, options = {}) {
  const codexArgs = DEFAULT_CODEX_ARGS
    .filter((arg) => arg !== "{prompt}" && !arg.includes("{prompt}"))
    .map(shellQuote)
    .join(" ");
  const codexOptionArgs = buildCodexOptionArgs(options).map(shellQuote).join(" ");
  const remoteCwd = remoteShellCwd(server.defaultPath || "~");
  const script = [
    "set +u",
    ...remoteCodexBootstrapLines(),
    "set -u",
    `cd ${remoteCwd}`,
    'prompt_file=$(mktemp "${TMPDIR:-/tmp}/cozypad-codex.XXXXXX")',
    'trap \'rm -f "$prompt_file"\' EXIT',
    'cat > "$prompt_file"',
    'if ! command -v codex >/dev/null 2>&1; then printf "[CozyPad] remote Codex CLI not found on this SSH server. Install it on the SSH server, then retry.\\n" >&2; exit 127; fi',
    'version=$(codex --version 2>/dev/null | head -n 1 || true)',
    'if [ -n "$version" ]; then printf "[CozyPad] remote %s\\n" "$version"; else printf "[CozyPad] remote codex\\n"; fi',
    `codex ${codexArgs}${codexOptionArgs ? ` ${codexOptionArgs}` : ""} "$(cat "$prompt_file")" </dev/null`,
  ].join("\n");

  return `sh -lc ${shellQuote(script)}`;
}

function spawnCodex(prompt, session) {
  const { command, args } = buildCodexCommand(prompt);

  return spawn(command, args, {
    cwd: appRoot,
    env: getCodexEnv(session),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function buildCodexStdinCommand(options = {}, imagePaths = [], detectedCli = null) {
  const cli =
    detectedCli?.available
      ? detectedCli
      : getCodexCandidates().find(
          (candidate) =>
            candidate.source === "configured" ||
            candidate.args.length > 0 ||
            path.isAbsolute(candidate.command),
        ) || { command: "codex", args: [] };
  const template = process.env.COZYPAD_CODEX_ARGS
    ? splitCommandLine(process.env.COZYPAD_CODEX_ARGS)
    : DEFAULT_CODEX_ARGS;
  const optionArgs = buildCodexOptionArgs(options);
  const args = [];
  let insertedOptions = false;
  let insertedPrompt = false;

  for (const arg of template) {
    if (arg === "{codexOptions}") {
      args.push(...optionArgs);
      insertedOptions = true;
      continue;
    }
    if (arg === "{prompt}" || arg.includes("{prompt}")) {
      if (!insertedOptions) {
        args.push(...optionArgs);
        insertedOptions = true;
      }
      args.push("-");
      insertedPrompt = true;
      continue;
    }
    args.push(arg);
  }

  if (!insertedOptions) {
    args.push(...optionArgs);
  }
  if (!insertedPrompt) {
    args.push("-");
  }
  for (const imagePath of imagePaths) {
    args.push("--image", imagePath);
  }

  return { command: cli.command, args: [...cli.args, ...args] };
}

async function stageLocalCodexAttachments(attachments = []) {
  if (!attachments.length) {
    return { dir: "", paths: [] };
  }

  const dir = path.join(
    os.tmpdir(),
    `cozypad-codex-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`,
  );
  await mkdir(dir, { recursive: true });
  const paths = [];

  for (const attachment of attachments) {
    const targetPath = path.join(dir, attachment.safeName || sanitizeCodexAttachmentName(attachment.name, attachment.type, paths.length));
    await writeFile(targetPath, Buffer.from(String(attachment.dataBase64 || ""), "base64"));
    paths.push(targetPath);
  }

  return { dir, paths };
}

async function spawnLocalCodex(prompt, session, attachments = [], options = {}, cwdValue = "~") {
  await ensureUserCodexHome(session);
  const detectedCli = await getCodexCliStatus(session);
  if (!detectedCli.available) {
    throw new Error(localCliNotFoundMessage("codex", "Codex"));
  }

  const staged = await stageLocalCodexAttachments(attachments);
  const localPrompt = appendCodexAttachmentPrompt(prompt, attachments, staged.dir, "localhost");
  const { command, args } = buildCodexStdinCommand(options, staged.paths, detectedCli);
  const child = spawn(command, args, {
    cwd: resolveLocalPath(cwdValue || "~", os.homedir()),
    env: getCodexEnv(session),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const cleanup = () => {
    if (staged.dir) {
      void rm(staged.dir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
  child.once("close", cleanup);
  child.once("error", cleanup);
  child.stdin.on("error", () => {
    // The CLI may fail before consuming stdin.
  });
  child.stdin.end(`${localPrompt}\n`, "utf8");
  return child;
}

function base64EncodeUtf8(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64");
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function sanitizeCodexAttachmentName(name, mime, index) {
  const fallbackExt = String(mime || "").toLowerCase().includes("jpeg")
    ? ".jpg"
    : String(mime || "").toLowerCase().includes("webp")
      ? ".webp"
      : String(mime || "").toLowerCase().includes("gif")
        ? ".gif"
        : ".png";
  const rawBase = path.basename(String(name || `image-${index + 1}${fallbackExt}`));
  let safeName = rawBase.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[_ .-]+|[_ .-]+$/g, "");
  if (!safeName) safeName = `image-${index + 1}${fallbackExt}`;
  if (!path.extname(safeName)) safeName = `${safeName}${fallbackExt}`;
  return `${String(index + 1).padStart(2, "0")}-${safeName}`.slice(0, 96);
}

function normalizeCodexImageAttachments(value) {
  const source = Array.isArray(value) ? value : [];
  const attachments = [];
  let totalBytes = 0;

  for (const item of source.slice(0, CODEX_IMAGE_ATTACHMENT_LIMIT)) {
    const mime = String(item?.type || item?.mime || "").trim().toLowerCase();
    if (!mime.startsWith("image/")) continue;

    const cleanBase64 = String(item?.dataBase64 || item?.base64 || "")
      .replace(/^data:[^,]+,/i, "")
      .replace(/\s+/g, "");
    if (!cleanBase64) continue;

    let decoded;
    try {
      decoded = Buffer.from(cleanBase64, "base64");
    } catch {
      continue;
    }
    if (!decoded.length || decoded.length > CODEX_IMAGE_ATTACHMENT_MAX_BYTES) continue;
    if (totalBytes + decoded.length > CODEX_IMAGE_ATTACHMENT_MAX_TOTAL_BYTES) break;

    const safeName = sanitizeCodexAttachmentName(item?.name, mime, attachments.length);
    attachments.push({
      name: String(item?.name || safeName).slice(0, 160),
      safeName,
      type: mime,
      size: decoded.length,
      dataBase64: decoded.toString("base64"),
    });
    totalBytes += decoded.length;
  }

  return attachments;
}

function parseCodexPromptPayload(payload) {
  const text = payload.toString("utf8");
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && typeof parsed.prompt === "string") {
      return {
        prompt: parsed.prompt,
        attachments: normalizeCodexImageAttachments(parsed.attachments),
        remotePath: normalizeRemotePathOption(parsed.remotePath),
        options: normalizeCodexRunOptions(parsed.options || parsed),
      };
    }
  } catch {
    // Backward compatibility: older clients send the prompt as plain text.
  }
  return {
    prompt: text,
    attachments: [],
    remotePath: "",
    options: normalizeCodexRunOptions(),
  };
}

function codexAttachmentRemoteDir(jobId) {
  return `/tmp/cozypad-codex-${String(jobId || "job").replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

function appendCodexAttachmentPrompt(prompt, attachments, remoteDir = "", targetLabel = "SSH server") {
  if (!attachments.length) return prompt;
  const lines = attachments.map(
    (attachment, index) => {
      const remotePath = remoteDir ? `${remoteDir}/${attachment.safeName}` : "";
      return `- ${index + 1}. ${attachment.name} (${attachment.type}, ${formatBytes(attachment.size)})${
        remotePath ? ` -> ${remotePath}` : ""
      }`;
    },
  );
  return `${prompt}

CozyPad attached image files to this Codex CLI request:
${lines.join("\n")}

These images were already written to temporary files on ${targetLabel} and passed
to Codex CLI with --image. The attachment transfer is successful if you can see
the image content. Do not suggest saving the same uploaded image to a manual
server path unless the user asks for that.

Use the attached image context when answering the user's request.`;
}

function formatCodexPromptForHistory(prompt, attachments) {
  if (!attachments.length) return prompt;
  const lines = attachments.map(
    (attachment, index) =>
      `- ${index + 1}. ${attachment.name} (${attachment.type}, ${formatBytes(attachment.size)})`,
  );
  return `${prompt}

[Attached images]
${lines.join("\n")}`;
}

function getRemoteCodexWorkerKey(owner, server) {
  const identity = [
    owner || "user",
    server.id || "",
    server.source || "",
    server.configFile || "",
    server.alias || "",
    server.name || "",
    server.host || "",
    server.user || "",
    server.port || "",
  ].join("|");
  return crypto.createHash("sha256").update(identity).digest("hex");
}

function isRemoteCodexSshTransportError(text) {
  const lower = String(text || "").toLowerCase();
  return (
    lower.includes("banner exchange") ||
    lower.includes("connection timed out") ||
    lower.includes("timed out during banner exchange") ||
    lower.includes("connection refused") ||
    lower.includes("kex_exchange_identification") ||
    lower.includes("ssh_exchange_identification") ||
    lower.includes("connection closed by") ||
    lower.includes("read from remote host") ||
    lower.includes("getsockname failed")
  );
}

function getRemoteAgentBlockKey(agent, owner, server) {
  const identity = [
    agent || "agent",
    owner || "user",
    server?.id || "",
    server?.source || "",
    server?.configFile || "",
    server?.alias || "",
    server?.name || "",
    server?.host || "",
    server?.user || "",
    server?.port || "",
  ].join("|");
  return crypto.createHash("sha256").update(identity).digest("hex");
}

function getRemoteAgentBlock(key) {
  const block = remoteAgentBlocks.get(key);
  if (!block) {
    return null;
  }
  if (block.expiresAt <= Date.now()) {
    remoteAgentBlocks.delete(key);
    return null;
  }
  return block;
}

function blockRemoteAgent(key, detail = "") {
  remoteAgentBlocks.set(key, {
    expiresAt: Date.now() + Math.max(1000, REMOTE_AGENT_SSH_FAILURE_COOLDOWN_MS),
    detail: truncateForApi(detail, 1200),
  });
}

function remoteAgentCooldownMessage(agent, block) {
  const expiresAt = block?.expiresAt || Date.now() + Math.max(1000, REMOTE_AGENT_SSH_FAILURE_COOLDOWN_MS);
  const retryAfterSeconds = Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
  return `Remote ${agent} SSH connection is paused after a transport failure; retry manually after ${retryAfterSeconds}s. CozyPad will not auto-retry.`;
}

function assertRemoteAgentNotBlocked(agent, owner, server) {
  const key = getRemoteAgentBlockKey(agent, owner, server);
  const block = getRemoteAgentBlock(key);
  if (block) {
    throw new Error(remoteAgentCooldownMessage(agent, block));
  }
  return key;
}

async function resetRemoteAgentBlockForSession(session, body) {
  const agent = String(body.agent || "").trim();
  const serverId = String(body.serverId || "").trim();
  if (!agent || !serverId) {
    throw new Error("agent and serverId are required");
  }
  if (!["claude", "codex", "agy", "bailian"].includes(agent.toLowerCase())) {
    throw new Error("Unsupported remote agent");
  }

  const server = await findServer(serverId, session);
  if (!server) {
    throw new Error("Server not found");
  }

  const key = getRemoteAgentBlockKey(agent, getTerminalOwner(session), server);
  const existed = remoteAgentBlocks.delete(key);
  return {
    ok: true,
    agent,
    serverId: server.id,
    cleared: existed,
  };
}

function blockRemoteAgentOnTransportError(agent, key, result) {
  const detail = `${result?.stderr || ""}\n${result?.stdout || ""}`;
  if (!result?.ok && isRemoteCodexSshTransportError(detail)) {
    blockRemoteAgent(key, detail);
    return true;
  }
  return false;
}

function normalizeRemoteAgentWorkerName(agent) {
  const value = String(agent || "").trim().toLowerCase();
  if (value === "claude" || value === "agy" || value === "bailian") {
    return value;
  }
  throw new Error(`Unsupported remote agent worker: ${agent}`);
}

function remoteAgentWorkerConfig(agent) {
  const normalized = normalizeRemoteAgentWorkerName(agent);
  if (normalized === "claude") {
    return {
      agent: normalized,
      label: "Claude",
      cli: "claude",
      bootstrapLines: remoteClaudeBootstrapLines(),
      missingMarker: "__COZYPAD_CLAUDE_MISSING__",
      runLines: [
        "    set -- claude --dangerously-skip-permissions",
        '    if [ -n "${agent_model:-}" ]; then set -- "$@" --model "$agent_model"; fi',
        '    if [ -s "$allowed_args_file" ]; then while IFS= read -r allowed_dir; do [ -n "$allowed_dir" ] && set -- "$@" --add-dir "$allowed_dir"; done < "$allowed_args_file"; fi',
        '    if "$@" -p < "$prompt_file"; then exit 0; fi',
        "    first_status=$?",
        '    if "$@" --print < "$prompt_file"; then exit 0; fi',
        '    exit "$first_status"',
      ],
    };
  }
  if (normalized === "agy") {
    return {
      agent: normalized,
      label: "agy",
      cli: "agy",
      bootstrapLines: remoteAgyBootstrapLines(),
      missingMarker: "__COZYPAD_AGY_MISSING__",
      runLines: [
        "    set -- agy",
        '    if [ -n "${agent_model:-}" ]; then set -- "$@" --model "$agent_model"; fi',
        '    agy_prompt=$(cat "$prompt_file")',
        '    if "$@" -p "$agy_prompt"; then exit 0; fi',
        "    first_status=$?",
        '    if "$@" --print "$agy_prompt"; then exit 0; fi',
        '    if "$@" < "$prompt_file"; then exit 0; fi',
        '    exit "$first_status"',
      ],
    };
  }
  return {
    agent: normalized,
    label: "bailian",
    cli: "bailian",
    bootstrapLines: remoteBailianBootstrapLines(),
    missingMarker: "__COZYPAD_BAILIAN_MISSING__",
    runLines: [
      "    set -- bailian text chat",
      '    if [ -n "${agent_model:-}" ]; then set -- "$@" --model "$agent_model"; fi',
      '    bailian_prompt=$(cat "$prompt_file")',
      '    "$@" --message "$bailian_prompt" --output text --quiet',
    ],
  };
}

function buildRemoteAgentWorkerCommand(agent) {
  const config = remoteAgentWorkerConfig(agent);
  const script = [
    "set +u",
    ...config.bootstrapLines,
    "set -u",
    'if ! command -v base64 >/dev/null 2>&1; then printf "[CozyPad] base64 not found on remote host\\n" >&2; exit 127; fi',
    `if ! command -v ${config.cli} >/dev/null 2>&1; then printf "${config.missingMarker}\\n[CozyPad] remote ${config.label} CLI not found on this SSH server.\\n" >&2; exit 127; fi`,
    `version=$(${config.cli} --version 2>/dev/null | head -n 1 || ${config.cli} --help 2>/dev/null | head -n 1 || true)`,
    `if [ -n "$version" ]; then printf "[CozyPad] remote ${config.label} worker ready: %s\\n" "$version"; else printf "[CozyPad] remote ${config.label} worker ready\\n"; fi`,
    'while IFS=" " read -r job_id cwd_b64 prompt_chunk_count key_b64 model_b64 effort_b64 allowed_dir_count; do',
    '  [ -n "$job_id" ] || continue',
    '  printf "__COZYPAD_AGENT_JOB_START__:%s\\n" "$job_id"',
    '  case "${prompt_chunk_count:-0}" in ""|*[!0-9]*) prompt_chunk_count=0 ;; esac',
    '  case "${allowed_dir_count:-0}" in ""|*[!0-9]*) allowed_dir_count=0 ;; esac',
    '  cwd=$(printf "%s" "$cwd_b64" | base64 -d 2>/dev/null || printf "%s" "$HOME")',
    '  prompt_b64_file=$(mktemp "${TMPDIR:-/tmp}/cozypad-agent-prompt.XXXXXX.b64") || { printf "__COZYPAD_AGENT_JOB_END__:%s:1\\n" "$job_id"; continue; }',
    '  prompt_file=$(mktemp "${TMPDIR:-/tmp}/cozypad-agent-prompt.XXXXXX") || { rm -f "$prompt_b64_file"; printf "__COZYPAD_AGENT_JOB_END__:%s:1\\n" "$job_id"; continue; }',
    '  allowed_args_file=$(mktemp "${TMPDIR:-/tmp}/cozypad-agent-allowed.XXXXXX") || { rm -f "$prompt_b64_file" "$prompt_file"; printf "__COZYPAD_AGENT_JOB_END__:%s:1\\n" "$job_id"; continue; }',
    '  prompt_read_failed=0',
    '  chunk_index=0',
    '  while [ "$chunk_index" -lt "$prompt_chunk_count" ]; do',
    '    if ! IFS= read -r prompt_chunk; then prompt_read_failed=1; break; fi',
    '    printf "%s" "$prompt_chunk" >> "$prompt_b64_file"',
    '    chunk_index=$((chunk_index + 1))',
    '  done',
    '  allowed_index=0',
    '  while [ "$allowed_index" -lt "$allowed_dir_count" ]; do',
    '    if ! IFS= read -r allowed_dir_b64; then prompt_read_failed=1; break; fi',
    '    allowed_dir=$(printf "%s" "$allowed_dir_b64" | base64 -d 2>/dev/null || true)',
    '    [ -n "$allowed_dir" ] && printf "%s\\n" "$allowed_dir" >> "$allowed_args_file"',
    '    allowed_index=$((allowed_index + 1))',
    '  done',
    '  if [ "$prompt_read_failed" = "1" ] || [ "$prompt_chunk_count" -le 0 ]; then',
    '    printf "[CozyPad] agent prompt transfer incomplete\\n" >&2',
    '    rm -f "$prompt_b64_file" "$prompt_file" "$allowed_args_file"',
    '    printf "__COZYPAD_AGENT_JOB_END__:%s:1\\n" "$job_id"',
    '    continue',
    '  fi',
    '  if ! base64 -d "$prompt_b64_file" > "$prompt_file" 2>/dev/null; then',
    '    printf "[CozyPad] agent prompt decode failed\\n" >&2',
    '    rm -f "$prompt_b64_file" "$prompt_file" "$allowed_args_file"',
    '    printf "__COZYPAD_AGENT_JOB_END__:%s:1\\n" "$job_id"',
    '    continue',
    '  fi',
    '  if [ -n "${key_b64:-}" ] && [ "$key_b64" != "-" ]; then',
    '    cozypad_key=$(printf "%s" "$key_b64" | base64 -d 2>/dev/null || true)',
    '    if [ -n "$cozypad_key" ]; then',
    '      export DASHSCOPE_API_KEY="$cozypad_key"',
    '      export BAILIAN_API_KEY="$cozypad_key"',
    '      export ALIBABA_CLOUD_API_KEY="$cozypad_key"',
    '    fi',
    '  fi',
    '  agent_model=""',
    '  if [ -n "${model_b64:-}" ] && [ "$model_b64" != "-" ]; then',
    '    agent_model=$(printf "%s" "$model_b64" | base64 -d 2>/dev/null || true)',
    '  fi',
    "  (",
    '    case "$cwd" in',
    '      "~") cd "$HOME" ;;',
    '      "~/"*) cd "$HOME/${cwd#~/}" ;;',
    '      "") cd "$HOME" ;;',
    '      *) cd "$cwd" ;;',
    "    esac || exit 72",
    ...config.runLines,
    "  )",
    "  code=$?",
    '  rm -f "$prompt_b64_file" "$prompt_file" "$allowed_args_file"',
    '  printf "\\n__COZYPAD_AGENT_JOB_END__:%s:%s\\n" "$job_id" "$code"',
    "done",
  ].join("\n");

  return `sh -lc ${shellQuote(script)}`;
}

function getRemoteAgentWorkerKey(agent, owner, server) {
  return getRemoteAgentBlockKey(normalizeRemoteAgentWorkerName(agent), owner, server);
}

function createRemoteAgentJob(worker, jobId) {
  const job = new EventEmitter();
  job.id = jobId;
  job.pid = worker.child.pid;
  job.closed = false;
  job.closeCode = null;
  job.closeError = null;
  job.stdout = new EventEmitter();
  job.stderr = new EventEmitter();
  job.kill = () => {
    if (worker.activeJob === job) {
      worker.child.kill();
    } else {
      worker.queue = worker.queue.filter((entry) => entry.job !== job);
      failRemoteAgentJob(job, new Error(`Remote ${worker.label} worker job was cancelled`));
    }
  };
  return job;
}

function closeRemoteAgentJob(job, code = 0) {
  if (!job || job.closed) {
    return;
  }

  job.closed = true;
  job.closeCode = code;
  job.emit("close", code);
}

function failRemoteAgentJob(job, error) {
  if (!job || job.closed) {
    return;
  }

  job.closed = true;
  job.closeError = error;
  job.emit("error", error);
}

function failRemoteAgentWorkerJobs(worker, error) {
  const activeJob = worker.activeJob;
  worker.activeJob = null;
  if (activeJob) {
    failRemoteAgentJob(activeJob, error);
  }
  for (const entry of worker.queue.splice(0)) {
    failRemoteAgentJob(entry.job, error);
  }
}

function scheduleRemoteAgentWorkerIdleClose(worker) {
  if (worker.idleTimer) {
    clearTimeout(worker.idleTimer);
    worker.idleTimer = null;
  }
  if (worker.ended || worker.activeJob || worker.queue.length > 0) {
    return;
  }
  worker.idleTimer = setTimeout(() => {
    if (!worker.ended && !worker.activeJob && worker.queue.length === 0) {
      worker.child.kill();
    }
  }, Math.max(60_000, REMOTE_AGENT_WORKER_IDLE_MS));
  worker.idleTimer.unref?.();
}

function drainRemoteAgentWorkerQueue(worker) {
  if (worker.ended || worker.activeJob) {
    return;
  }
  if (worker.idleTimer) {
    clearTimeout(worker.idleTimer);
    worker.idleTimer = null;
  }

  const next = worker.queue.shift();
  if (!next) {
    scheduleRemoteAgentWorkerIdleClose(worker);
    return;
  }

  worker.activeJob = next.job;
  worker.child.stdin.write(next.payload, "utf8", (error) => {
    if (!error) {
      return;
    }
    if (worker.activeJob === next.job) {
      worker.activeJob = null;
    }
    failRemoteAgentJob(next.job, error);
    drainRemoteAgentWorkerQueue(worker);
  });
}

function handleRemoteAgentWorkerLine(worker, line) {
  const startMatch = String(line).match(/^__COZYPAD_AGENT_JOB_START__:(.+)$/);
  if (startMatch) {
    return;
  }

  const endMatch = String(line).match(/^__COZYPAD_AGENT_JOB_END__:(.+):(\d+)$/);
  if (endMatch) {
    const job = worker.activeJob;
    if (job && job.id === endMatch[1]) {
      worker.activeJob = null;
      closeRemoteAgentJob(job, Number(endMatch[2] || 0));
      drainRemoteAgentWorkerQueue(worker);
    }
    return;
  }

  const job = worker.activeJob;
  if (job) {
    job.stdout.emit("data", Buffer.from(`${line}\n`, "utf8"));
  } else {
    worker.startupBuffer = `${worker.startupBuffer}${line}\n`.slice(-8000);
  }
}

function handleRemoteAgentWorkerStdout(worker, chunk) {
  worker.stdoutBuffer += chunk.toString("utf8");
  const lines = worker.stdoutBuffer.split(/\r?\n/);
  worker.stdoutBuffer = lines.pop() || "";
  for (const line of lines) {
    handleRemoteAgentWorkerLine(worker, line);
  }
}

async function getOrCreateRemoteAgentWorker(agent, owner, server, gateOptions = {}) {
  const config = remoteAgentWorkerConfig(agent);
  const key = getRemoteAgentWorkerKey(config.agent, owner, server);
  const existing = remoteAgentWorkers.get(key);
  if (existing && !existing.ended && existing.child.exitCode === null) {
    existing.server = server;
    return existing;
  }

  const pending = remoteAgentWorkerCreates.get(key);
  if (pending) {
    const worker = await pending;
    worker.server = server;
    return worker;
  }

  const block = getRemoteAgentBlock(key);
  if (block) {
    throw new Error(remoteAgentCooldownMessage(config.label, block));
  }

  const createPromise = (async () => {
    const child = await createRemoteWorkerChild(
      owner,
      server,
      buildRemoteAgentWorkerCommand(config.agent),
      `Remote ${config.label} agent worker`,
      gateOptions,
    );

    const worker = {
      key,
      agent: config.agent,
      label: config.label,
      owner,
      server,
      child,
      activeJob: null,
      queue: [],
      stdoutBuffer: "",
      stderrBuffer: "",
      startupBuffer: "",
      idleTimer: null,
      ended: false,
    };
    remoteAgentWorkers.set(key, worker);

    child.stdout.on("data", (chunk) => handleRemoteAgentWorkerStdout(worker, chunk));
    child.stderr.on("data", (chunk) => {
      worker.stderrBuffer = `${worker.stderrBuffer}${chunk.toString("utf8")}`.slice(-8000);
      const job = worker.activeJob;
      if (job) {
        job.stderr.emit("data", chunk);
      }
    });
    child.on("error", (error) => {
      worker.ended = true;
      remoteAgentWorkers.delete(key);
      failRemoteAgentWorkerJobs(worker, error);
    });
    child.on("close", (code) => {
      worker.ended = true;
      if (worker.idleTimer) {
        clearTimeout(worker.idleTimer);
        worker.idleTimer = null;
      }
      remoteAgentWorkers.delete(key);
      if (isRemoteCodexSshTransportError(worker.stderrBuffer)) {
        blockRemoteAgent(key, worker.stderrBuffer);
      }
      const error = new Error(
        `Remote ${config.label} SSH worker ended with code ${code ?? "unknown"}`,
      );
      failRemoteAgentWorkerJobs(worker, error);
    });
    child.stdin.on("error", () => {
      // The SSH process may fail before reading the queued job.
    });
    scheduleRemoteAgentWorkerIdleClose(worker);
    return worker;
  })();

  remoteAgentWorkerCreates.set(key, createPromise);
  try {
    return await createPromise;
  } finally {
    if (remoteAgentWorkerCreates.get(key) === createPromise) {
      remoteAgentWorkerCreates.delete(key);
    }
  }
}

async function spawnRemoteAgentWorkerJob(agent, prompt, server, options = {}) {
  const config = remoteAgentWorkerConfig(agent);
  const worker = await getOrCreateRemoteAgentWorker(
    config.agent,
    options.owner || "user",
    server,
    options,
  );
  const jobId = `job_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
  const job = createRemoteAgentJob(worker, jobId);
  const promptChunks = splitRemoteJobField(base64EncodeUtf8(prompt));
  const allowedDirs =
    config.agent === "claude"
      ? normalizeRemoteClaudeAllowedDirs(options.allowedDirs, server.defaultPath || "~")
      : [];
  const header = `${[
    jobId,
    base64EncodeUtf8(server.defaultPath || "~"),
    String(promptChunks.length),
    encodeRemoteJobField(options.apiKey),
    encodeRemoteJobField(normalizeCodexModelOption(options.model)),
    encodeRemoteJobField(options.reasoningEffort),
    String(allowedDirs.length),
  ].join(" ")}\n`;
  const payload = `${header}${promptChunks.join("\n")}${promptChunks.length ? "\n" : ""}${allowedDirs
    .map(base64EncodeUtf8)
    .join("\n")}${allowedDirs.length ? "\n" : ""}`;
  worker.queue.push({ job, payload });
  drainRemoteAgentWorkerQueue(worker);
  return job;
}

function getRemoteCodexWorkerBlock(key) {
  const block = remoteCodexWorkerBlocks.get(key);
  if (!block) {
    return null;
  }
  if (block.expiresAt <= Date.now()) {
    remoteCodexWorkerBlocks.delete(key);
    return null;
  }
  return block;
}

function blockRemoteCodexWorker(key, detail = "") {
  const expiresAt = Date.now() + Math.max(1000, REMOTE_CODEX_SSH_FAILURE_COOLDOWN_MS);
  remoteCodexWorkerBlocks.set(key, {
    expiresAt,
    detail: truncateForApi(detail, 1200),
  });
}

function remoteCodexCooldownMessage(block) {
  const retryAfterSeconds = Math.max(1, Math.ceil((block.expiresAt - Date.now()) / 1000));
  return `Remote Codex SSH connection is paused after a transport failure; retry manually after ${retryAfterSeconds}s. CozyPad will not auto-retry.`;
}

function buildRemoteCodexWorkerCommand() {
  const codexArgs = DEFAULT_CODEX_ARGS
    .filter((arg) => arg !== "{prompt}" && !arg.includes("{prompt}"))
    .map(shellQuote)
    .join(" ");
  const script = [
    "set +u",
    ...remoteCodexBootstrapLines(),
    "set -u",
    'if ! command -v base64 >/dev/null 2>&1; then printf "[CozyPad] base64 not found on remote host\\n" >&2; exit 127; fi',
    'if ! command -v codex >/dev/null 2>&1; then printf "[CozyPad] remote Codex CLI not found on this SSH server. Install it on the SSH server, then retry.\\n" >&2; exit 127; fi',
    'version=$(codex --version 2>/dev/null | head -n 1 || true)',
    'if [ -n "$version" ]; then printf "[CozyPad] remote %s\\n" "$version"; else printf "[CozyPad] remote codex\\n"; fi',
    'codex_image_args_supported=0',
    'if command -v grep >/dev/null 2>&1 && codex exec --help 2>&1 | grep -q -- "--image"; then codex_image_args_supported=1; fi',
    'while IFS=" " read -r job_id cwd_b64 prompt_b64 attachment_chunk_count model_b64 effort_b64; do',
    '  [ -n "$job_id" ] || continue',
    '  printf "__COZYPAD_JOB_START__:%s\\n" "$job_id"',
    '  cwd=$(printf "%s" "$cwd_b64" | base64 -d 2>/dev/null || printf "%s" "$HOME")',
    '  prompt_file=$(mktemp "${TMPDIR:-/tmp}/cozypad-codex.XXXXXX") || { printf "__COZYPAD_JOB_END__:%s:1\\n" "$job_id"; continue; }',
    '  if ! printf "%s" "$prompt_b64" | base64 -d > "$prompt_file" 2>/dev/null; then printf "[CozyPad] prompt decode failed\\n" >&2; rm -f "$prompt_file"; printf "__COZYPAD_JOB_END__:%s:1\\n" "$job_id"; continue; fi',
    '  attachment_chunk_count=${attachment_chunk_count:-0}',
    '  case "$attachment_chunk_count" in ""|*[!0-9]*) attachment_chunk_count=0 ;; esac',
    '  model_b64=${model_b64:-}',
    '  effort_b64=${effort_b64:-}',
    '  codex_model=""',
    '  codex_effort=""',
    '  if [ -n "$model_b64" ] && [ "$model_b64" != "-" ]; then codex_model=$(printf "%s" "$model_b64" | base64 -d 2>/dev/null || true); fi',
    '  if [ -n "$effort_b64" ] && [ "$effort_b64" != "-" ]; then codex_effort=$(printf "%s" "$effort_b64" | base64 -d 2>/dev/null || true); fi',
    '  attachment_dir="/tmp/cozypad-codex-$job_id"',
    '  image_paths_file=""',
    '  attachments_present=0',
    '  if [ "$attachment_chunk_count" -gt 0 ]; then',
    '    attachments_present=1',
    '    mkdir -p "$attachment_dir"',
    '    image_paths_file=$(mktemp "${TMPDIR:-/tmp}/cozypad-codex-images.XXXXXX") || { printf "[CozyPad] image list temp file failed\\n" >&2; rm -f "$prompt_file"; rmdir "$attachment_dir" 2>/dev/null || true; printf "__COZYPAD_JOB_END__:%s:1\\n" "$job_id"; continue; }',
    '    attachments_file=$(mktemp "${TMPDIR:-/tmp}/cozypad-codex-attachments.XXXXXX") || { rm -f "$prompt_file"; rm -f "$image_paths_file"; rmdir "$attachment_dir" 2>/dev/null || true; printf "__COZYPAD_JOB_END__:%s:1\\n" "$job_id"; continue; }',
    '    attachments_b64_file=$(mktemp "${TMPDIR:-/tmp}/cozypad-codex-attachments.XXXXXX.b64") || { rm -f "$prompt_file" "$image_paths_file" "$attachments_file"; rmdir "$attachment_dir" 2>/dev/null || true; printf "__COZYPAD_JOB_END__:%s:1\\n" "$job_id"; continue; }',
    '    attachment_read_failed=0',
    '    chunk_index=0',
    '    while [ "$chunk_index" -lt "$attachment_chunk_count" ]; do',
    '      if ! IFS= read -r attachment_chunk; then attachment_read_failed=1; break; fi',
    '      printf "%s" "$attachment_chunk" >> "$attachments_b64_file"',
    '      chunk_index=$((chunk_index + 1))',
    '    done',
    '    if [ "$attachment_read_failed" = "1" ]; then',
    '      printf "[CozyPad] image attachment transfer incomplete\\n" >&2',
    '      rm -f "$prompt_file" "$image_paths_file" "$attachments_file" "$attachments_b64_file"',
    '      case "$attachment_dir" in /tmp/cozypad-codex-*) rm -rf "$attachment_dir" ;; esac',
    '      printf "__COZYPAD_JOB_END__:%s:1\\n" "$job_id"',
    '      continue',
    '    fi',
    '    if base64 -d "$attachments_b64_file" > "$attachments_file" 2>/dev/null; then',
    '      if command -v python3 >/dev/null 2>&1; then',
    '        COZYPAD_ATTACH_DIR="$attachment_dir" COZYPAD_IMAGE_PATHS_FILE="$image_paths_file" python3 - "$attachments_file" <<\'PY\' || printf "[CozyPad] image attachment write failed\\n" >&2',
    'import base64, json, os, re, sys',
    'attach_dir = os.environ.get("COZYPAD_ATTACH_DIR", "/tmp/cozypad-codex-attachments")',
    'paths_file = os.environ.get("COZYPAD_IMAGE_PATHS_FILE")',
    'with open(sys.argv[1], "r", encoding="utf-8") as handle:',
    '    items = json.load(handle)',
    'os.makedirs(attach_dir, exist_ok=True)',
    'paths = open(paths_file, "a", encoding="utf-8") if paths_file else None',
    'try:',
    '    for index, item in enumerate(items if isinstance(items, list) else []):',
    '        name = str(item.get("safeName") or f"image-{index + 1}.png")',
    '        name = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("._-") or f"image-{index + 1}.png"',
    '        raw = base64.b64decode(str(item.get("dataBase64") or ""), validate=True)',
    '        file_path = os.path.join(attach_dir, name)',
    '        with open(file_path, "wb") as output:',
    '            output.write(raw)',
    '        if paths:',
    '            paths.write(file_path + "\\n")',
    '        print(f"[CozyPad] image attachment ready: {name}")',
    'finally:',
    '    if paths:',
    '        paths.close()',
    'PY',
    '      else',
    '        printf "[CozyPad] python3 not found; image attachments were not written\\n" >&2',
    '      fi',
    '    else',
    '      printf "[CozyPad] image attachment decode failed\\n" >&2',
    '    fi',
    '    rm -f "$attachments_file" "$attachments_b64_file"',
    '  fi',
    "  (",
    '    case "$cwd" in',
    '      "~") cd "$HOME" ;;',
    '      "~/"*) cd "$HOME/${cwd#~/}" ;;',
    '      "") cd "$HOME" ;;',
    '      *) cd "$cwd" ;;',
    "    esac || exit 72",
    `    set -- codex ${codexArgs}`,
    '    if [ -n "${codex_model:-}" ]; then set -- "$@" --model "$codex_model"; fi',
    `    if [ -n "\${codex_effort:-}" ]; then set -- "$@" -c "${CODEX_REASONING_CONFIG_KEY}=$codex_effort"; fi`,
    '    set -- "$@" -',
    '    if [ -n "${image_paths_file:-}" ] && [ -s "$image_paths_file" ]; then',
    '      if [ "${codex_image_args_supported:-0}" != "1" ]; then',
    '        printf "[CozyPad] remote Codex CLI does not support --image. Update Codex CLI on this SSH server.\\n" >&2',
    '        exit 64',
    '      fi',
    '      while IFS= read -r image_path; do',
    '        [ -n "$image_path" ] && set -- "$@" --image "$image_path"',
    '      done < "$image_paths_file"',
    '    elif [ "${attachments_present:-0}" = "1" ]; then',
    '      printf "[CozyPad] image attachments were not available to Codex CLI\\n" >&2',
    '      exit 64',
    '    fi',
    '    "$@" < "$prompt_file"',
    "  )",
    "  code=$?",
    '  rm -f "$prompt_file"',
    '  [ -n "${image_paths_file:-}" ] && rm -f "$image_paths_file"',
    '  case "$attachment_dir" in /tmp/cozypad-codex-*) rm -rf "$attachment_dir" ;; esac',
    '  printf "__COZYPAD_JOB_END__:%s:%s\\n" "$job_id" "$code"',
    "done",
  ].join("\n");

  return `sh -lc ${shellQuote(script)}`;
}

function createRemoteCodexJob(worker, jobId) {
  const job = new EventEmitter();
  job.id = jobId;
  job.pid = worker.child.pid;
  job.closed = false;
  job.closeCode = null;
  job.closeError = null;
  job.stdout = new EventEmitter();
  job.stderr = new EventEmitter();
  job.kill = () => {
    if (worker.activeJob === job) {
      worker.child.kill();
    }
  };
  return job;
}

function closeRemoteCodexJob(job, code = 0) {
  if (!job || job.closed) {
    return;
  }

  job.closed = true;
  job.closeCode = code;
  job.emit("close", code);
}

function failRemoteCodexJob(job, error) {
  if (!job || job.closed) {
    return;
  }

  job.closed = true;
  job.closeError = error;
  job.emit("error", error);
}

function handleRemoteCodexWorkerLine(worker, line) {
  const startMatch = String(line).match(/^__COZYPAD_JOB_START__:(.+)$/);
  if (startMatch) {
    return;
  }

  const endMatch = String(line).match(/^__COZYPAD_JOB_END__:(.+):(\d+)$/);
  if (endMatch) {
    const job = worker.activeJob;
    if (job && job.id === endMatch[1]) {
      worker.activeJob = null;
      closeRemoteCodexJob(job, Number(endMatch[2] || 0));
    }
    return;
  }

  const job = worker.activeJob;
  if (job) {
    job.stdout.emit("data", Buffer.from(`${line}\n`, "utf8"));
  }
}

function handleRemoteCodexWorkerStdout(worker, chunk) {
  worker.stdoutBuffer += chunk.toString("utf8");
  const lines = worker.stdoutBuffer.split(/\r?\n/);
  worker.stdoutBuffer = lines.pop() || "";
  for (const line of lines) {
    handleRemoteCodexWorkerLine(worker, line);
  }
}

async function getOrCreateRemoteCodexWorker(owner, server, gateOptions = {}) {
  const key = getRemoteCodexWorkerKey(owner, server);
  const existing = remoteCodexWorkers.get(key);
  if (existing && !existing.ended && existing.child.exitCode === null) {
    existing.server = server;
    return existing;
  }

  const pending = remoteCodexWorkerCreates.get(key);
  if (pending) {
    const worker = await pending;
    worker.server = server;
    return worker;
  }

  const block = getRemoteCodexWorkerBlock(key);
  if (block) {
    throw new Error(remoteCodexCooldownMessage(block));
  }

  const createPromise = (async () => {
    const child = await createRemoteWorkerChild(
      owner,
      server,
      buildRemoteCodexWorkerCommand(),
      "Remote Codex worker",
      gateOptions,
    );

    const worker = {
      key,
      owner,
      server,
      child,
      activeJob: null,
      stdoutBuffer: "",
      stderrBuffer: "",
      ended: false,
    };
    remoteCodexWorkers.set(key, worker);

    child.stdout.on("data", (chunk) => handleRemoteCodexWorkerStdout(worker, chunk));
    child.stderr.on("data", (chunk) => {
      worker.stderrBuffer = `${worker.stderrBuffer}${chunk.toString("utf8")}`.slice(-8000);
      const job = worker.activeJob;
      if (job) {
        job.stderr.emit("data", chunk);
      }
    });
    child.on("error", (error) => {
      worker.ended = true;
      remoteCodexWorkers.delete(key);
      const job = worker.activeJob;
      worker.activeJob = null;
      if (job) {
        failRemoteCodexJob(job, error);
      }
    });
    child.on("close", (code) => {
      worker.ended = true;
      remoteCodexWorkers.delete(key);
      if (isRemoteCodexSshTransportError(worker.stderrBuffer)) {
        blockRemoteCodexWorker(key, worker.stderrBuffer);
      }
      const job = worker.activeJob;
      worker.activeJob = null;
      if (job) {
        job.stderr.emit(
          "data",
          Buffer.from(`\r\n[CozyPad] remote SSH worker ended with code ${code ?? "unknown"}\r\n`, "utf8"),
        );
        closeRemoteCodexJob(job, code ?? 255);
      }
    });
    child.stdin.on("error", () => {
      // The SSH process may fail before reading the prompt.
    });
    return worker;
  })();

  remoteCodexWorkerCreates.set(key, createPromise);
  try {
    return await createPromise;
  } finally {
    if (remoteCodexWorkerCreates.get(key) === createPromise) {
      remoteCodexWorkerCreates.delete(key);
    }
  }
}

async function spawnRemoteCodex(prompt, server, codexSession, attachments = [], options = {}) {
  const worker = await getOrCreateRemoteCodexWorker(codexSession?.owner || "user", server, options);

  if (worker.activeJob) {
    throw new Error("Remote Codex SSH worker is busy");
  }

  const codexOptions = normalizeCodexRunOptions(options);
  const jobId = `job_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
  const job = createRemoteCodexJob(worker, jobId);
  worker.activeJob = job;
  const remoteCwd = server.defaultPath || "~";
  const remoteAttachmentDir = codexAttachmentRemoteDir(jobId);
  const remotePrompt = appendCodexAttachmentPrompt(prompt, attachments, remoteAttachmentDir);
  const attachmentsPayload = attachments.length ? JSON.stringify(attachments) : "";
  const attachmentChunks = attachmentsPayload ? splitRemoteJobField(base64EncodeUtf8(attachmentsPayload)) : [];
  const header = `${[
    jobId,
    base64EncodeUtf8(remoteCwd),
    base64EncodeUtf8(remotePrompt),
    String(attachmentChunks.length),
    encodeRemoteJobField(codexOptions.model),
    encodeRemoteJobField(codexOptions.reasoningEffort),
  ].join(" ")}\n`;
  const payload = attachmentChunks.length
    ? `${header}${attachmentChunks.join("\n")}\n`
    : header;
  worker.child.stdin.write(payload, "utf8", (error) => {
    if (error) {
      worker.activeJob = null;
      failRemoteCodexJob(job, error);
    }
  });
  return job;
}

function createCodexOutputParser(target, onText = () => undefined, onOpenAiAuthError = () => undefined) {
  let buffer = "";
  const sendText =
    typeof target === "function" ? target : (text) => sendWebSocketText(target, text);

  function isHiddenImagePayloadLine(line) {
    const lower = String(line || "").trim().toLowerCase();
    return (
      lower.includes("[cozypad] image attachment ready") ||
      lower.includes("cozypad image attachments copied") ||
      lower.includes("cozypad attached image files") ||
      lower.includes('"database64"') ||
      lower.includes("data:image/") ||
      (lower.includes('"attachments"') && lower.includes("base64"))
    );
  }

  function sanitizeVisibleText(value) {
    return String(value || "")
      .split(/\r?\n/)
      .filter((line) => !isHiddenImagePayloadLine(line))
      .join("\n")
      .trimEnd();
  }

  function itemSummary(item) {
    if (!item) {
      return "";
    }

    const type = String(item.type || "").replace(/_/g, " ");
    const command =
      item.command ||
      item.cmd ||
      item.action?.command ||
      item.call?.command ||
      item.arguments?.command ||
      "";
    const text = item.text || item.summary || item.message || "";
    if (command) {
      return `${type || "tool"}: ${String(command).slice(0, 220)}`;
    }
    if (text && type !== "agent message") {
      return `${type || "event"}: ${String(text).slice(0, 220)}`;
    }
    return type;
  }

  function displayEvent(event) {
    const type = String(event.type || "");
    const itemType = String(event.item?.type || "");

    if (type === "item.completed" && itemType === "agent_message") {
      return { text: String(event.item.text || ""), history: true };
    }

    if (type === "error") {
      return { text: `[Codex] ${event.message || event.error || "error"}`, history: true };
    }

    if (type === "turn.started") {
      return { text: "[Codex] turn started", history: false };
    }

    if (type === "turn.completed") {
      return { text: "[Codex] turn completed", history: false };
    }

    if (type === "item.started") {
      const summary = itemSummary(event.item);
      return {
        text: summary ? `[Codex] started ${summary}` : "[Codex] item started",
        history: false,
      };
    }

    if (type === "item.completed") {
      const summary = itemSummary(event.item);
      if (!summary || itemType === "agent_message") {
        return null;
      }
      return { text: `[Codex] completed ${summary}`, history: false };
    }

    if (/delta|output|log/i.test(type) && event.message) {
      return { text: `[Codex] ${event.message}`, history: false };
    }

    return null;
  }

  function handleLine(line) {
    const text = line.trim();
    if (!text || text === "Reading additional input from stdin...") {
      return;
    }

    try {
      const event = JSON.parse(text);
      if (isRemoteCodexOpenAiAuthError(text) || isRemoteCodexOpenAiAuthError(JSON.stringify(event))) {
        onOpenAiAuthError(text);
        return;
      }
      const display = displayEvent(event);
      if (display?.text) {
        const output = sanitizeVisibleText(display.text);
        if (!output) {
          return;
        }
        if (display.history) {
          onText(output);
        }
        sendText(`${output}\r\n`);
      }
    } catch {
      if (isRemoteCodexOpenAiAuthError(line)) {
        onOpenAiAuthError(line);
        return;
      }
      if (isHiddenImagePayloadLine(line)) {
        return;
      }
      onText(line);
      sendText(`${line}\r\n`);
    }
  }

  return {
    write(chunk) {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        handleLine(line);
      }
    },
    flush() {
      if (buffer.trim()) {
        handleLine(buffer);
      }
      buffer = "";
    },
  };
}

function extractJsonFromCodexText(value) {
  const text = String(value || "").trim();
  if (!text) {
    throw new Error("Codex did not return diagram JSON");
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || text;
  try {
    return JSON.parse(candidate);
  } catch {
    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
    }
    throw new Error("Diagram output was not valid JSON");
  }
}

function normalizeResearchDiagramNodes(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 80).map((node) => ({
    id: String(node?.id || "").slice(0, 80),
    kind: String(node?.kind || "").slice(0, 32),
    title: String(node?.title || "").slice(0, 160),
    subtitle: String(node?.subtitle || "").slice(0, 220),
    role: String(node?.role || "").slice(0, 32),
    x: Number.isFinite(Number(node?.x)) ? Number(node.x) : 0,
    y: Number.isFinite(Number(node?.y)) ? Number(node.y) : 0,
    inputs: Number.isFinite(Number(node?.inputs)) ? Number(node.inputs) : 0,
    outputs: Number.isFinite(Number(node?.outputs)) ? Number(node.outputs) : 0,
  }));
}

function normalizeResearchDiagramEdges(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 120).map((edge) => ({
    id: String(edge?.id || "").slice(0, 120),
    from: String(edge?.from || "").slice(0, 80),
    to: String(edge?.to || "").slice(0, 80),
    fromTitle: String(edge?.fromTitle || "").slice(0, 160),
    toTitle: String(edge?.toTitle || "").slice(0, 160),
  }));
}

function buildResearchDiagramCodexPrompt(body) {
  const userPrompt = String(body.prompt || "").trim().slice(0, 24000);
  if (!userPrompt) {
    throw new Error("prompt is required");
  }

  const graph = {
    nodes: normalizeResearchDiagramNodes(body.nodes),
    edges: normalizeResearchDiagramEdges(body.edges),
  };

  return [
    "You are CozyPad Research Diagram Drawer powered by Bailian.",
    "",
    "Return only one valid JSON object. Do not return Markdown, code fences, comments, prose, or explanations.",
    "",
    "Required schema:",
    "{",
    '  "nodes": [',
    '    { "id": "dataset", "kind": "source", "title": "Dataset", "subtitle": "Data source", "role": "input", "x": 12, "y": 35 }',
    "  ],",
    '  "edges": [',
    '    { "from": "dataset", "to": "train", "fromSide": "right", "toSide": "left" }',
    "  ]",
    "}",
    "",
    "Allowed kind values: source, operation, model, command, output, application.",
    "Allowed role values: input, control, factor, runner, outcome, application.",
    "Allowed side values: top, right, bottom, left.",
    "Use x/y as percentages from 0 to 100. Prefer a readable left-to-right workflow.",
    "Keep id values short lowercase ASCII slugs.",
    "",
    "Current diagram:",
    JSON.stringify(graph, null, 2),
    "",
    "User request:",
    userPrompt,
  ].join("\n");
}

async function runResearchDiagramBailian(session, body) {
  const diagramPrompt = buildResearchDiagramCodexPrompt(body);
  const model = normalizeBailianModelOption(body.model);
  const completion = await requestBailianChatCompletion(
    body.apiKey || getBailianSessionKey(session),
    [
      {
        role: "system",
        content:
          "You create valid JSON research workflow diagrams for CozyPad. Return only JSON and never include Markdown fences.",
      },
      { role: "user", content: diagramPrompt },
    ],
    { timeoutMs: 180000, model },
  );

  const raw = String(completion.text || "").trim();
  const diagram = extractJsonFromCodexText(raw);
  return {
    ok: true,
    raw,
    diagram,
    modelPath: `${model} via Bailian`,
    stderr: "",
  };
}

async function runResearchDiagramCodex(session, body) {
  const serverId = String(body.serverId || "").trim();
  const server = serverId
    ? await findServer(serverId, session)
    : await findMarkdownSummaryServer(session, "");
  if (!server) {
    throw new Error("No SSH server is available for Codex diagram drawing");
  }
  if (isSystemLocalServer(server)) {
    throw new Error("localhost is not a remote Codex diagram target");
  }

  const codexPrompt = buildResearchDiagramCodexPrompt(body);
  const job = await spawnRemoteCodex(codexPrompt, server, { owner: getTerminalOwner(session) }, [], {
    model: body.model,
    reasoningEffort: body.reasoningEffort || "low",
  });

  return await new Promise((resolve, reject) => {
    let visibleOutput = "";
    let assistantOutput = "";
    let stderr = "";
    let openAiAuthError = false;
    const timeout = setTimeout(() => {
      try {
        job.kill?.();
      } catch {
        // Ignore kill failures; reject below.
      }
      reject(new Error("Codex diagram drawing timed out"));
    }, 180000);
    timeout.unref?.();

    const cleanup = () => clearTimeout(timeout);
    const parser = createCodexOutputParser(
      (text) => {
        visibleOutput = `${visibleOutput}${text}`.slice(-256 * 1024);
      },
      (text) => {
        assistantOutput = `${assistantOutput}${assistantOutput ? "\n" : ""}${text}`.slice(
          -256 * 1024,
        );
      },
      () => {
        openAiAuthError = true;
      },
    );

    job.stdout.on("data", (chunk) => parser.write(chunk));
    job.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr = `${stderr}${text}`.slice(-12000);
    });
    job.on("error", (error) => {
      cleanup();
      reject(error);
    });
    job.on("close", (code) => {
      cleanup();
      parser.flush();
      if (openAiAuthError || isRemoteCodexOpenAiAuthError(stderr)) {
        reject(new Error(`${server.name} 的 Codex OpenAI 登入已失效，請在該台 SSH server 執行 codex login。`));
        return;
      }
      const raw = (assistantOutput.trim() || visibleOutput.trim()).trim();
      if (code && !raw) {
        reject(new Error(visibleRemoteCodexStderr(stderr) || `Codex exited with code ${code}`));
        return;
      }
      try {
        const diagram = extractJsonFromCodexText(raw);
        resolve({
          ok: true,
          raw,
          diagram,
          server: publicSshServer(server),
          stderr: truncateForApi(visibleRemoteCodexStderr(stderr), 1200),
        });
      } catch (error) {
        reject(
          new Error(
            `${error instanceof Error ? error.message : "Codex diagram parse failed"}: ${raw.slice(0, 800)}`,
          ),
        );
      }
    });
  });
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
      if (bigLength > BigInt(CODEX_WS_MAX_PAYLOAD_BYTES)) {
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

function normalizeCodexSessionTaskId(value) {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9:_-]{8,180}$/.test(id) ? id : "";
}

function getCodexSessionKey(session, serverId, historyId, taskId = "") {
  const owner = getTerminalOwner(session);
  return `${owner}:${String(serverId || "")}:${String(taskId || historyId || "")}`;
}

function trimCodexSessionBuffer(value) {
  const text = String(value || "");
  if (text.length <= CODEX_SESSION_BUFFER_LIMIT) {
    return text;
  }
  return `[CozyPad] codex output truncated\r\n${text.slice(-CODEX_SESSION_BUFFER_LIMIT)}`;
}

function appendCodexSessionOutput(codexSession, text) {
  if (!codexSession || codexSession.ended) {
    return;
  }

  const output = String(text || "");
  if (!output) {
    return;
  }

  codexSession.buffer = trimCodexSessionBuffer(`${codexSession.buffer}${output}`);
  codexSession.lastOutputAt = Date.now();

  for (const socket of codexSession.sockets) {
    sendWebSocketText(socket, output);
  }
}

function isHiddenRemoteCodexStderrLine(line) {
  const text = String(line || "").trim();
  const lower = text.toLowerCase();
  return (
    !text ||
    isRemoteCodexOpenAiAuthError(text) ||
    /^reading (additional input|prompt) from stdin\.{3}$/i.test(text) ||
    text.includes("WARN ") ||
    /^connection closed by .+ port \d+$/i.test(text) ||
    /^connection timed out during banner exchange/i.test(text) ||
    /^connection to .+ port \d+ timed out$/i.test(text) ||
    /^banner exchange:/i.test(text) ||
    /^read from remote host .+: unknown error$/i.test(text) ||
    /^getsockname failed: not a socket$/i.test(text) ||
    /^codex exited with code 255$/i.test(text) ||
    lower.includes("remote ssh worker ended with code") ||
    lower.includes("kex_exchange_identification") ||
    lower.includes("ssh_exchange_identification") ||
    lower.includes("timed out during banner exchange") ||
    lower.includes("connection to unknown port -1") ||
    lower.includes("connection refused")
  );
}

function isRemoteCodexOpenAiAuthError(text) {
  const lower = String(text || "").toLowerCase();
  return (
    lower.includes("401 unauthorized") &&
    (lower.includes("api.openai.com") ||
      lower.includes("responses_websocket") ||
      lower.includes("codex_api::endpoint"))
  );
}

function visibleRemoteCodexStderr(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => !isHiddenRemoteCodexStderrLine(line))
    .join("\r\n");
}

function isCodexSessionChildClosed(child) {
  if (!child) {
    return true;
  }

  if (child.closed || child.killed) {
    return true;
  }

  return typeof child.exitCode !== "undefined" && child.exitCode !== null;
}

function reconcileCodexSessionState(codexSession) {
  if (!codexSession?.activeChild) {
    return false;
  }

  if (!codexSession.running || isCodexSessionChildClosed(codexSession.activeChild)) {
    codexSession.activeChild = null;
    codexSession.running = false;
    return true;
  }

  return false;
}

function scheduleCodexSessionCleanup(codexSession) {
  if (
    !codexSession ||
    codexSession.ended ||
    codexSession.running ||
    codexSession.retryTimer ||
    codexSession.sockets.size > 0
  ) {
    return;
  }

  if (codexSession.cleanupTimer) {
    clearTimeout(codexSession.cleanupTimer);
  }

  codexSession.cleanupTimer = setTimeout(() => {
    if (codexSession.ended || codexSession.running || codexSession.retryTimer || codexSession.sockets.size > 0) {
      return;
    }

    codexSession.ended = true;
    codexSessions.delete(codexSession.key);
  }, CODEX_SESSION_DETACHED_TTL_MS);
  codexSession.cleanupTimer.unref?.();
}

function detachCodexSocket(codexSession, socket) {
  if (!codexSession) {
    return;
  }

  codexSession.sockets.delete(socket);
  scheduleCodexSessionCleanup(codexSession);
}

function attachCodexSocket(codexSession, socket, options = {}) {
  if (!codexSession || codexSession.ended) {
    return;
  }

  reconcileCodexSessionState(codexSession);

  if (codexSession.cleanupTimer) {
    clearTimeout(codexSession.cleanupTimer);
    codexSession.cleanupTimer = null;
  }

  codexSession.sockets.add(socket);
  codexSession.lastAttachedAt = Date.now();
  socket.setKeepAlive?.(true, 30000);

  if (codexSession.buffer && !options.suppressReplay) {
    sendWebSocketText(socket, codexSession.buffer);
  } else {
    sendWebSocketText(socket, `[CozyPad] codex attached to ${codexSession.serverName}\r\n`);
  }

  sendWebSocketText(
    socket,
    codexSession.running
      ? "[CozyPad] codex is still running in background\r\n"
      : "[CozyPad] codex ready\r\n",
  );

  const pingTimer = setInterval(() => {
    sendWebSocketPing(socket);
    sendWebSocketText(socket, "[CozyPad] codex heartbeat\r\n");
  }, TERMINAL_WS_PING_MS);
  pingTimer.unref?.();

  socket.on("close", () => {
    clearInterval(pingTimer);
    detachCodexSocket(codexSession, socket);
  });
  socket.on("error", () => {
    clearInterval(pingTimer);
    detachCodexSocket(codexSession, socket);
  });
}

function getOrCreateCodexSession(session, selectedServer, activeHistory, taskId = "") {
  const key = getCodexSessionKey(session, selectedServer.id, activeHistory?.id || "", taskId);
  const owner = getTerminalOwner(session);
  const existing = codexSessions.get(key);

  if (existing && !existing.ended) {
    existing.authSession = session;
    existing.activeHistory = activeHistory || existing.activeHistory;
    existing.taskId = taskId || existing.taskId || "";
    existing.selectedServer = selectedServer || existing.selectedServer;
    return existing;
  }

  const now = Date.now();
  const codexSession = {
    key,
    owner,
    taskId,
    serverId: selectedServer.id,
    serverName: selectedServer.name,
    selectedServer,
    authSession: session,
    activeHistory,
    workflowPrompt: "",
    workflowTitle: "",
    codexModel: "",
    codexReasoningEffort: "",
    status: "completed",
    activeChild: null,
    pendingPrompts: [],
    retryTimer: null,
    sshTransportRetryCount: 0,
    running: false,
    sockets: new Set(),
    buffer: "",
    cleanupTimer: null,
    createdAt: now,
    lastAttachedAt: now,
    lastOutputAt: now,
    ended: false,
  };
  codexSessions.set(key, codexSession);
  return codexSession;
}

async function persistCodexSessionWorkflow(codexSession, selectedServer) {
  if (!codexSession?.taskId || !selectedServer) {
    return;
  }

  try {
    await upsertCodexWorkflow(codexSession.authSession, {
      id: codexSession.taskId,
      serverId: selectedServer.id,
      title:
        codexSession.workflowTitle ||
        titleFromPrompt(codexSession.workflowPrompt || "", `${selectedServer.name} 工作`),
      prompt: codexSession.workflowPrompt || "",
      output: codexSession.buffer || "",
      model: codexSession.codexModel || "",
      reasoningEffort: codexSession.codexReasoningEffort || "",
      status: codexSession.status || (codexSession.running ? "running" : "completed"),
      remotePath: selectedServer.defaultPath || "~",
      historyId: codexSession.activeHistory?.id || "",
    });
  } catch {
    // The live Codex session should not fail only because workflow persistence failed.
  }
}

function queueCodexSessionPrompt(codexSession, prompt) {
  if (!codexSession || codexSession.ended) {
    return;
  }

  if (codexSession.pendingPrompts.length >= CODEX_SESSION_PENDING_LIMIT) {
    appendCodexSessionOutput(
      codexSession,
      `\r\n[CozyPad] follow-up queue is full (${CODEX_SESSION_PENDING_LIMIT}). Wait for the current remote Codex run to finish.\r\n`,
    );
    return;
  }

  codexSession.pendingPrompts.push(prompt);
  appendCodexSessionOutput(
    codexSession,
    `\r\n[CozyPad] queued follow-up (${codexSession.pendingPrompts.length} pending)\r\n`,
  );
}

function runNextQueuedCodexPrompt(codexSession, selectedServer) {
  const nextPrompt = codexSession?.pendingPrompts.shift();
  if (!nextPrompt) {
    appendCodexSessionOutput(codexSession, "\r\n[CozyPad] codex ready\r\n");
    scheduleCodexSessionCleanup(codexSession);
    runNextPendingCodexSessionForServer(codexSession?.owner, codexSession?.serverId);
    return;
  }

  appendCodexSessionOutput(
    codexSession,
    `\r\n[CozyPad] running queued follow-up (${codexSession.pendingPrompts.length} remaining)\r\n`,
  );
  setTimeout(() => {
    void runCodexSessionPrompt(codexSession, selectedServer, nextPrompt);
  }, 0);
}

function prependCodexSessionPrompt(codexSession, prompt) {
  if (!codexSession || !prompt) return;
  codexSession.pendingPrompts.unshift(prompt);
  if (codexSession.pendingPrompts.length > CODEX_SESSION_PENDING_LIMIT) {
    codexSession.pendingPrompts = codexSession.pendingPrompts.slice(0, CODEX_SESSION_PENDING_LIMIT);
  }
}

function scheduleCodexSessionRetry(codexSession, selectedServer, delayMs) {
  if (!codexSession || codexSession.ended) return;
  if (codexSession.retryTimer) return;

  const delay = Math.max(1000, Number(delayMs || REMOTE_CODEX_SSH_FAILURE_COOLDOWN_MS));
  codexSession.status = "running";
  appendCodexSessionOutput(
    codexSession,
    `\r\n[CozyPad] remote codex retry scheduled in ${Math.ceil(delay / 1000)}s\r\n`,
  );

  codexSession.retryTimer = setTimeout(() => {
    codexSession.retryTimer = null;
    if (codexSession.ended || codexSession.activeChild || codexSession.running) {
      return;
    }
    if (findRunningCodexSessionForServer(codexSession.owner, codexSession.serverId, codexSession.key)) {
      scheduleCodexSessionRetry(codexSession, selectedServer, Math.min(15000, delay));
      return;
    }
    runNextQueuedCodexPrompt(codexSession, selectedServer || codexSession.selectedServer);
  }, delay);
  codexSession.retryTimer.unref?.();
}

function findRunningCodexSessionForServer(owner, serverId, excludeKey = "") {
  for (const session of codexSessions.values()) {
    reconcileCodexSessionState(session);
    if (
      session &&
      !session.ended &&
      session.running &&
      session.owner === owner &&
      session.serverId === serverId &&
      session.key !== excludeKey
    ) {
      return session;
    }
  }
  return null;
}

function runNextPendingCodexSessionForServer(owner, serverId) {
  if (!owner || !serverId || findRunningCodexSessionForServer(owner, serverId)) {
    return;
  }

  for (const session of codexSessions.values()) {
    reconcileCodexSessionState(session);
    if (
      !session ||
      session.ended ||
      session.running ||
      session.owner !== owner ||
      session.serverId !== serverId ||
      session.pendingPrompts.length === 0
    ) {
      continue;
    }

    const nextPrompt = session.pendingPrompts.shift();
    if (!nextPrompt) {
      continue;
    }

    appendCodexSessionOutput(
      session,
      `\r\n[CozyPad] running queued follow-up (${session.pendingPrompts.length} remaining)\r\n`,
    );
    setTimeout(() => {
      void runCodexSessionPrompt(session, session.selectedServer, nextPrompt);
    }, 0);
    return;
  }
}

function finishCodexSessionChild(codexSession, child, message, selectedServer, options = {}) {
  if (!codexSession || codexSession.activeChild !== child) {
    return;
  }

  codexSession.activeChild = null;
  codexSession.running = false;
  if (message) {
    appendCodexSessionOutput(codexSession, message);
  }
  if (options.drainQueue === false) {
    if (options.requeuePrompt) {
      prependCodexSessionPrompt(codexSession, options.requeuePrompt);
    }
    codexSession.status = "running";
    scheduleCodexSessionRetry(codexSession, selectedServer, options.retryDelayMs);
    return;
  }
  runNextQueuedCodexPrompt(codexSession, selectedServer);
}

async function runCodexSessionPrompt(codexSession, selectedServer, prompt) {
  const parsedPrompt = parseCodexPromptPayload(Buffer.isBuffer(prompt) ? prompt : Buffer.from(String(prompt || ""), "utf8"));
  const attachments = parsedPrompt.attachments;
  const codexOptions = normalizeCodexRunOptions(parsedPrompt.options);
  const runRemotePath = normalizeRemotePathOption(
    parsedPrompt.remotePath || selectedServer?.defaultPath || "~",
  );
  selectedServer = {
    ...selectedServer,
    defaultPath: runRemotePath,
  };
  const localCodex = isSystemLocalServer(selectedServer);
  codexSession.selectedServer = selectedServer;
  const userPrompt =
    String(parsedPrompt.prompt || "").trim() ||
    (attachments.length ? "Please help with the attached images." : "");
  const historyPrompt = formatCodexPromptForHistory(userPrompt, attachments);
  const queuedPromptPayload =
    parsedPrompt.remotePath || attachments.length || codexOptions.model || codexOptions.reasoningEffort
      ? JSON.stringify({
          prompt: userPrompt,
          attachments,
          remotePath: runRemotePath,
          model: codexOptions.model,
          reasoningEffort: codexOptions.reasoningEffort,
        })
    : userPrompt;
  const session = codexSession.authSession;

  reconcileCodexSessionState(codexSession);

  if (!userPrompt) {
    appendCodexSessionOutput(codexSession, "[CozyPad] prompt is empty\r\n");
    return;
  }

  if (codexSession.activeChild) {
    queueCodexSessionPrompt(codexSession, queuedPromptPayload);
    return;
  }

  if (codexSession.retryTimer) {
    queueCodexSessionPrompt(codexSession, queuedPromptPayload);
    return;
  }

  const runningSession = findRunningCodexSessionForServer(
    codexSession.owner,
    codexSession.serverId,
    codexSession.key,
  );
  if (runningSession) {
    appendCodexSessionOutput(
      codexSession,
      `\r\n[CozyPad] another ${localCodex ? "local" : "remote"} Codex task is already running on ${selectedServer.name}; queued this request.\r\n`,
    );
    queueCodexSessionPrompt(codexSession, queuedPromptPayload);
    return;
  }

  const history = codexSession.activeHistory;
  if (!history) {
    appendCodexSessionOutput(codexSession, "[CozyPad] codex history not found\r\n");
    appendCodexSessionOutput(codexSession, "[CozyPad] codex ready\r\n");
    return;
  }

  const codexPrompt = localCodex
    ? buildLocalCodexPrompt(selectedServer, userPrompt, history)
    : buildRemoteCodexPrompt(selectedServer, userPrompt, history);
  codexSession.workflowPrompt = [codexSession.workflowPrompt, userPrompt]
    .filter(Boolean)
    .join("\n\n")
    .slice(-16000);
  codexSession.codexModel = codexOptions.model;
  codexSession.codexReasoningEffort = codexOptions.reasoningEffort;
  if (!codexSession.workflowTitle) {
    codexSession.workflowTitle = titleFromPrompt(userPrompt, `${selectedServer.name} 工作`);
  }
  let child;
  try {
    if (localCodex) {
      child = await spawnLocalCodex(codexPrompt, session, attachments, codexOptions, runRemotePath);
    } else if (
      AGENT_TERMINAL_BRIDGE_ENABLED &&
      attachments.length === 0 &&
      findReusableTerminalSession(session, selectedServer.id)
    ) {
      child = await spawnTerminalAgentJob(session, "codex", codexPrompt, selectedServer, {
        ...codexOptions,
        owner: codexSession.owner,
        remotePath: runRemotePath,
      });
    } else {
      child = await spawnRemoteCodex(codexPrompt, selectedServer, codexSession, attachments, codexOptions);
    }
  } catch (error) {
    const failureMessage = String(error?.message || "");
    if (isSshGateConfirmationError(error)) {
      const gatePayload = sshGateErrorPayload(error);
      codexSession.status = "failed";
      await appendCodexHistoryMessages(
        session,
        history.id,
        [
          { role: "user", content: historyPrompt },
          { role: "assistant", content: `[CozyPad] ${gatePayload.error}` },
        ],
        {
          serverName: selectedServer.name,
          title: titleFromPrompt(userPrompt, history.title),
        },
      );
      appendCodexSessionOutput(
        codexSession,
        `\r\n[CozyPad] ${gatePayload.error}\r\n${gatePayload.confirmation?.message || ""}\r\n`,
      );
      await persistCodexSessionWorkflow(codexSession, selectedServer);
      return;
    }
    const isCooldown =
      failureMessage.includes("temporarily unavailable") ||
      failureMessage.includes("paused after a transport");
    if (isCooldown) {
      codexSession.status = "failed";
      appendCodexSessionOutput(codexSession, `\r\n[CozyPad] ${failureMessage}\r\n`);
      await persistCodexSessionWorkflow(codexSession, selectedServer);
      return;
    }
    const terminalBridgeClosedByUser = !localCodex && isTerminalBridgeUserClosedError(error);
    codexSession.status = "failed";
    const failureText = terminalBridgeClosedByUser
      ? `remote codex failed: ${terminalBridgeUserClosedMessage("codex", selectedServer)}`
      : `${localCodex ? "local" : "remote"} codex failed: ${failureMessage}`;
    await appendCodexHistoryMessages(
      session,
      history.id,
      [
        { role: "user", content: historyPrompt },
        { role: "assistant", content: `[CozyPad] ${failureText}` },
      ],
      {
        serverName: selectedServer.name,
        title: titleFromPrompt(userPrompt, history.title),
      },
    );
    appendCodexSessionOutput(
      codexSession,
      terminalBridgeClosedByUser
        ? `\r\n[CozyPad] ${failureText}\r\n`
        : `\r\n[CozyPad] ${failureText}\r\nConfirm Codex CLI is installed on ${selectedServer.name}.\r\n`,
    );
    await persistCodexSessionWorkflow(codexSession, selectedServer);
    return;
  }

  codexSession.activeChild = child;
  codexSession.running = true;
  codexSession.status = "running";
  codexSession.buffer = trimCodexSessionBuffer(
    `${codexSession.buffer}${codexSession.buffer.endsWith("\n") ? "" : "\r\n"}> ${historyPrompt}\r\n`,
  );
  appendCodexSessionOutput(codexSession, "[CozyPad] codex started; waiting for CLI output\r\n");

  let assistantOutput = "";
  let openAiAuthError = false;
  let lastVisibleCodexOutputAt = Date.now();
  const progressTimer = setInterval(() => {
    if (!codexSession.running || codexSession.activeChild !== child) {
      clearInterval(progressTimer);
      return;
    }
    if (Date.now() - lastVisibleCodexOutputAt < 60000) {
      return;
    }
    lastVisibleCodexOutputAt = Date.now();
    appendCodexSessionOutput(codexSession, "[CozyPad] codex is still processing; waiting for CLI output\r\n");
  }, 15000);
  progressTimer.unref?.();
  const openAiAuthMessage = localCodex
    ? "Local Codex OpenAI login is invalid. Run `codex login` on this computer, then retry."
    : `${selectedServer.name} Codex OpenAI login is invalid. Run \`codex login\` on that SSH server, then retry.`;
  const markOpenAiAuthError = () => {
    if (openAiAuthError) return;
    openAiAuthError = true;
    assistantOutput = `${assistantOutput}${assistantOutput ? "\n" : ""}${openAiAuthMessage}`.slice(
      -64 * 1024,
    );
    appendCodexSessionOutput(codexSession, `\r\n${openAiAuthMessage}\r\n`);
  };
  const outputParser = createCodexOutputParser(
    (text) => {
      lastVisibleCodexOutputAt = Date.now();
      appendCodexSessionOutput(codexSession, text);
    },
    (text) => {
      assistantOutput = `${assistantOutput}${assistantOutput ? "\n" : ""}${text}`.slice(
        -64 * 1024,
      );
    },
    markOpenAiAuthError,
  );
  let stderr = "";

  child.stdout.on("data", (chunk) => outputParser.write(chunk));
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderr = `${stderr}${text}`.slice(-6000);
    if (isRemoteCodexOpenAiAuthError(text)) {
      markOpenAiAuthError();
      return;
    }
    const visibleError = visibleRemoteCodexStderr(text);
    if (visibleError) {
      lastVisibleCodexOutputAt = Date.now();
      appendCodexSessionOutput(
        codexSession,
        `\r\n[${localCodex ? "Local Codex" : "Remote Codex"}]\r\n${visibleError}\r\n`,
      );
    }
  });
  child.on("error", async (error) => {
    clearInterval(progressTimer);
    codexSession.status = "failed";
    const terminalBridgeClosedByUser = !localCodex && isTerminalBridgeUserClosedError(error);
    const failureText = terminalBridgeClosedByUser
      ? `remote codex failed: ${terminalBridgeUserClosedMessage("codex", selectedServer)}`
      : `${localCodex ? "local" : "remote"} codex failed: ${error.message}`;
    try {
      await appendCodexHistoryMessages(
        session,
        history.id,
        [
          { role: "user", content: historyPrompt },
          { role: "assistant", content: `[CozyPad] ${failureText}` },
        ],
        {
          serverName: selectedServer.name,
          title: titleFromPrompt(userPrompt, history.title),
        },
      );
    } catch {
      appendCodexSessionOutput(codexSession, "\r\n[CozyPad] failed to save codex history\r\n");
    } finally {
      finishCodexSessionChild(
        codexSession,
        child,
        terminalBridgeClosedByUser
          ? `\r\n[CozyPad] ${failureText}\r\n`
          : `\r\n[CozyPad] ${failureText}\r\nConfirm Codex CLI is installed on ${selectedServer.name}.\r\n`,
        selectedServer,
      );
      await persistCodexSessionWorkflow(codexSession, selectedServer);
    }
  });
  child.on("close", async (code) => {
    clearInterval(progressTimer);
    outputParser.flush();
    const transportError = !localCodex && isRemoteCodexSshTransportError(stderr);
    const authError = openAiAuthError || isRemoteCodexOpenAiAuthError(stderr);
    if (authError) {
      markOpenAiAuthError();
    }
    const errorOutput = visibleRemoteCodexStderr(stderr);
    let finalOutput = assistantOutput;
    if (authError) {
      finalOutput = openAiAuthMessage;
    } else if (!finalOutput && code && transportError) {
      finalOutput = "Remote Codex SSH connection is temporarily unavailable.";
    } else if (!finalOutput && code && errorOutput) {
      finalOutput = `Codex exited with code ${code ?? "unknown"}\n${errorOutput}`;
    } else if (!finalOutput && code) {
      finalOutput = `Codex exited with code ${code ?? "unknown"}`;
    }
    if (transportError && !authError) {
      codexSession.sshTransportRetryCount = Number(codexSession.sshTransportRetryCount || 0) + 1;
      if (codexSession.sshTransportRetryCount >= REMOTE_CODEX_SSH_MAX_RETRIES) {
        const stopMessage =
          `Remote Codex SSH transport failed ${codexSession.sshTransportRetryCount} times. ` +
          "CozyPad stopped automatic SSH retries to avoid server-side IP lockout; check the server, network, and credentials, then retry manually.";
        codexSession.status = "failed";
        try {
          const savedHistory = await appendCodexHistoryMessages(
            session,
            history.id,
            [
              { role: "user", content: historyPrompt },
              { role: "assistant", content: `[CozyPad] ${stopMessage}` },
            ],
            {
              serverName: selectedServer.name,
              title: titleFromPrompt(userPrompt, history.title),
            },
          );
          if (savedHistory) {
            codexSession.activeHistory = savedHistory;
          }
        } catch {
          appendCodexSessionOutput(codexSession, "\r\n[CozyPad] failed to save codex history\r\n");
        }
        finishCodexSessionChild(
          codexSession,
          child,
          `\r\n[CozyPad] ${stopMessage}\r\n`,
          selectedServer,
          { drainQueue: true },
        );
        await persistCodexSessionWorkflow(codexSession, selectedServer);
        return;
      }
      codexSession.status = "running";
      finishCodexSessionChild(
        codexSession,
        child,
        `\r\n[CozyPad] Remote Codex SSH transport was interrupted; retry ${codexSession.sshTransportRetryCount}/${REMOTE_CODEX_SSH_MAX_RETRIES} is scheduled.\r\n`,
        selectedServer,
        {
          drainQueue: false,
          requeuePrompt: queuedPromptPayload,
          retryDelayMs: REMOTE_CODEX_SSH_FAILURE_COOLDOWN_MS,
        },
      );
      await persistCodexSessionWorkflow(codexSession, selectedServer);
      return;
    }
    if (!transportError) {
      codexSession.sshTransportRetryCount = 0;
    }
    codexSession.status = authError || (code && !assistantOutput.trim()) ? "failed" : "completed";
    try {
      const savedHistory = await appendCodexHistoryMessages(
        session,
        history.id,
        [
          { role: "user", content: historyPrompt },
          { role: "assistant", content: finalOutput || "Codex completed without visible output." },
        ],
        {
          serverName: selectedServer.name,
          title: titleFromPrompt(userPrompt, history.title),
        },
      );
      if (savedHistory) {
        codexSession.activeHistory = savedHistory;
      }
    } catch {
      appendCodexSessionOutput(codexSession, "\r\n[CozyPad] failed to save codex history\r\n");
    } finally {
      finishCodexSessionChild(
        codexSession,
        child,
        authError
          ? ""
          : code
          ? `\r\n[CozyPad] codex exited with code ${code ?? "unknown"}${
              errorOutput ? `\r\n${errorOutput}` : ""
            }\r\n`
          : "",
        selectedServer,
      );
      await persistCodexSessionWorkflow(codexSession, selectedServer);
    }
  });
}

async function handleTerminalUpgrade(request, socket) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);

  if (url.pathname !== "/api/ssh/terminal") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  if (!isAllowedWebSocketOrigin(request)) {
    rejectSocket(socket, 403, "Forbidden");
    return;
  }

  const access = await verifyCloudflareAccess(request);
  if (!access.ok) {
    socket.write(`HTTP/1.1 ${access.status || 403} Forbidden\r\n\r\n${access.error}`);
    socket.destroy();
    return;
  }

  if (!isAuthenticated(request)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  const serverId = url.searchParams.get("serverId");
  const terminalId = normalizeTerminalSessionId(url.searchParams.get("terminalId"));
  const reuseOnly = url.searchParams.get("reuse") === "1";
  const requestedCwd = String(url.searchParams.get("cwd") || "").trim();
  const terminalDimensions = {
    cols: normalizeTerminalDimension(url.searchParams.get("cols"), 140, 80, 240),
    rows: normalizeTerminalDimension(url.searchParams.get("rows"), 36, 24, 80),
  };
  const session = getSession(request);
  const server = serverId ? await findServer(serverId, session) : null;
  const key = request.headers["sec-websocket-key"];

  if (!server || !key || !terminalId) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  const owner = getTerminalOwner(session);
  let terminalSession = terminalSessions.get(terminalId) || null;
  const canReuse =
    terminalSession &&
    !terminalSession.ended &&
    terminalSession.owner === owner &&
    terminalSession.serverId === server.id;

  if (terminalSession && !canReuse) {
    socket.write("HTTP/1.1 409 Conflict\r\n\r\nTerminal session does not match this user or server");
    socket.destroy();
    return;
  }

  if (!terminalSession && reuseOnly) {
    socket.write("HTTP/1.1 409 Conflict\r\n\r\nTerminal session is not available");
    socket.destroy();
    return;
  }

  if (!terminalSession) {
    terminalSession = await createTerminalSession(
      terminalId,
      owner,
      server,
      terminalDimensions,
      {},
      requestedCwd || server.defaultPath || "~",
    );
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

  const frameState = { buffer: Buffer.alloc(0) };

  attachTerminalSocket(terminalSession, socket, { reattached: canReuse || reuseOnly });

  socket.on("data", (chunk) => {
    readWebSocketFrames(
      frameState,
      chunk,
      (payload) => {
        const control = parseTerminalControlPayload(payload);
        if (control) {
          if (control.type === "resize") {
            resizeTerminalSession(terminalSession, control);
          }
          return;
        }

        if (terminalSession.ended || !terminalSession.child.stdin.writable) {
          return;
        }

        terminalSession.child.stdin.write(payload);
      },
      () => {
        closeWebSocket(socket);
      },
    );
  });
}

async function handleCodexUpgrade(request, socket) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);

  if (url.pathname !== "/api/codex/session") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  if (!isAllowedWebSocketOrigin(request)) {
    rejectSocket(socket, 403, "Forbidden");
    return;
  }

  const access = await verifyCloudflareAccess(request);
  if (!access.ok) {
    socket.write(`HTTP/1.1 ${access.status || 403} Forbidden\r\n\r\n${access.error}`);
    socket.destroy();
    return;
  }

  const session = getSession(request);
  if (!session) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  const serverId = url.searchParams.get("serverId");
  const baseServer = serverId ? await findServer(serverId, session) : null;
  const requestedRemotePath = String(url.searchParams.get("remotePath") || "")
    .trim()
    .slice(0, 240);
  const selectedServer = baseServer
    ? {
        ...baseServer,
        defaultPath: requestedRemotePath || baseServer.defaultPath,
      }
    : null;
  if (!selectedServer) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }
  const key = request.headers["sec-websocket-key"];
  if (!key) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
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

  const frameState = { buffer: Buffer.alloc(0) };
  const requestedHistoryId = url.searchParams.get("historyId");
  const requestedTaskId = normalizeCodexSessionTaskId(url.searchParams.get("taskId"));
  const suppressReplay = url.searchParams.get("suppressReplay") === "1";
  let activeHistory = null;

  if (requestedHistoryId) {
    activeHistory = await getCodexHistory(session, requestedHistoryId);
    if (!activeHistory || activeHistory.serverId !== selectedServer.id) {
      sendWebSocketText(socket, "[CozyPad] codex history not found for this server\r\n");
      closeWebSocket(socket);
      return;
    }
  }

  const codexSession = getOrCreateCodexSession(
    session,
    selectedServer,
    activeHistory,
    requestedTaskId,
  );
  attachCodexSocket(codexSession, socket, { suppressReplay });

  socket.on("data", (chunk) => {
    readWebSocketFrames(
      frameState,
      chunk,
      (payload) => {
        void runCodexSessionPrompt(codexSession, selectedServer, payload);
      },
      () => {
        closeWebSocket(socket);
      },
    );
  });
}

const CODEX_APP_SERVER_RPC_METHODS = new Set([
  "model/list",
  "collaborationMode/list",
  "skills/list",
  "thread/start",
  "thread/resume",
  "thread/read",
  "thread/list",
  "thread/archive",
  "thread/name/set",
  "thread/goal/set",
  "thread/goal/get",
  "thread/goal/clear",
  "fs/readFile",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
]);

function sendCodexAppServerSocketJson(socket, payload) {
  sendWebSocketText(socket, JSON.stringify(payload));
}

async function handleCodexAppServerUpgrade(request, socket) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  if (url.pathname !== "/api/codex/app-server/session") {
    rejectSocket(socket, 404, "Not Found");
    return;
  }
  if (!CODEX_FEATURE_ENABLED || CODEX_RUNTIME_MODE === "legacy") {
    rejectSocket(socket, 410, "Codex app-server runtime is disabled");
    return;
  }
  if (!isAllowedWebSocketOrigin(request)) {
    rejectSocket(socket, 403, "Forbidden");
    return;
  }
  const access = await verifyCloudflareAccess(request);
  if (!access.ok) {
    rejectSocket(socket, access.status || 403, access.error || "Forbidden");
    return;
  }
  const session = getSession(request);
  if (!session) {
    rejectSocket(socket, 401, "Unauthorized");
    return;
  }
  const serverId = url.searchParams.get("serverId");
  const server = serverId ? await findServer(serverId, session) : null;
  const websocketKey = request.headers["sec-websocket-key"];
  if (!server || !websocketKey) {
    rejectSocket(socket, 400, "A valid serverId and WebSocket key are required");
    return;
  }

  const identity = getCodexAppServerIdentity(session, server);
  const runtime = await codexAppServerRuntimeManager.acquire(identity, { session, server });
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${websocketAccept(websocketKey)}`,
      "\r\n",
    ].join("\r\n"),
  );

  let closed = false;
  const seenServerRequestIds = new Set();
  const frameState = { buffer: Buffer.alloc(0) };
  const unsubscribe = runtime.subscribe((message) => {
    if (closed) return;
    if (message.type === "server_request") seenServerRequestIds.add(message.request.id);
    sendCodexAppServerSocketJson(socket, message);
  });
  const afterSequence = Math.max(0, Number(url.searchParams.get("afterSequence") || 0));
  sendCodexAppServerSocketJson(socket, { type: "runtime_status", runtime: runtime.snapshot() });
  for (const event of runtime.replay(afterSequence)) {
    sendCodexAppServerSocketJson(socket, { type: "event", event, replayed: true });
  }
  for (const request of runtime.pendingServerRequests()) {
    seenServerRequestIds.add(request.id);
    sendCodexAppServerSocketJson(socket, { type: "server_request", request, replayed: true });
  }

  const pingTimer = setInterval(() => sendWebSocketPing(socket), TERMINAL_WS_PING_MS);
  pingTimer.unref?.();
  function closeClient() {
    if (closed) return;
    closed = true;
    clearInterval(pingTimer);
    unsubscribe();
    closeWebSocket(socket);
  }

  socket.on("data", (chunk) => {
    readWebSocketFrames(
      frameState,
      chunk,
      (payload) => {
        let message;
        try {
          message = JSON.parse(payload.toString("utf8"));
        } catch {
          sendCodexAppServerSocketJson(socket, { type: "protocol_error", error: "Invalid JSON" });
          return;
        }

        if (message?.type === "rpc") {
          const requestId = String(message.requestId || "").slice(0, 160);
          const method = String(message.method || "");
          if (!requestId || !CODEX_APP_SERVER_RPC_METHODS.has(method)) {
            sendCodexAppServerSocketJson(socket, {
              type: "rpc_result",
              requestId,
              error: { message: "Unsupported Codex app-server method" },
            });
            return;
          }
          void runtime.call(method, message.params || {}).then(
            (result) => sendCodexAppServerSocketJson(socket, { type: "rpc_result", requestId, result }),
            (error) =>
              sendCodexAppServerSocketJson(socket, {
                type: "rpc_result",
                requestId,
                error: {
                  message: error instanceof Error ? error.message : "Codex app-server request failed",
                  ...(error?.code !== undefined ? { code: error.code } : {}),
                },
              }),
          );
          return;
        }

        if (message?.type === "server_request_result") {
          const appServerRequestId = message.appServerRequestId;
          if (!seenServerRequestIds.has(appServerRequestId)) {
            sendCodexAppServerSocketJson(socket, {
              type: "protocol_error",
              error: "Unknown or already resolved Codex app-server request",
            });
            return;
          }
          seenServerRequestIds.delete(appServerRequestId);
          try {
            runtime.respond(appServerRequestId, message.result, message.error);
          } catch (error) {
            sendCodexAppServerSocketJson(socket, {
              type: "protocol_error",
              error: error instanceof Error ? error.message : "Approval response failed",
            });
          }
          return;
        }

        sendCodexAppServerSocketJson(socket, {
          type: "protocol_error",
          error: "Unsupported Web Agent message",
        });
      },
      closeClient,
    );
  });
  socket.on("close", closeClient);
  socket.on("error", closeClient);
}

async function handleClaudeUpgrade(request, socket) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);

  if (url.pathname !== "/api/claude/session") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  if (!CLAUDE_SERVICES_ENABLED) {
    socket.write("HTTP/1.1 410 Gone\r\n\r\nClaude service is disabled");
    socket.destroy();
    return;
  }

  if (!isAllowedWebSocketOrigin(request)) {
    rejectSocket(socket, 403, "Forbidden");
    return;
  }

  const access = await verifyCloudflareAccess(request);
  if (!access.ok) {
    socket.write(`HTTP/1.1 ${access.status || 403} Forbidden\r\n\r\n${access.error}`);
    socket.destroy();
    return;
  }

  const session = getSession(request);
  if (!session) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  const serverId = url.searchParams.get("serverId");
  const baseServer = serverId ? await findServer(serverId, session) : null;
  const requestedRemotePath = String(url.searchParams.get("remotePath") || "")
    .trim()
    .slice(0, 240);
  const selectedServer = baseServer
    ? {
        ...baseServer,
        defaultPath: requestedRemotePath || baseServer.defaultPath,
      }
    : null;
  if (!selectedServer) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }
  const key = request.headers["sec-websocket-key"];
  if (!key) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
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

  const frameState = { buffer: Buffer.alloc(0) };
  const requestedTaskId = normalizeCodexSessionTaskId(url.searchParams.get("taskId"));
  const suppressReplay = url.searchParams.get("suppressReplay") === "1";
  const claudeSession = getOrCreateClaudeSession(session, selectedServer, requestedTaskId);
  attachClaudeSocket(claudeSession, socket, { suppressReplay });

  socket.on("data", (chunk) => {
    readWebSocketFrames(
      frameState,
      chunk,
      (payload) => {
        void runClaudeSessionPrompt(claudeSession, selectedServer, payload);
      },
      () => {
        closeWebSocket(socket);
      },
    );
  });
}

async function handleAgyUpgrade(request, socket) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);

  if (url.pathname !== "/api/agy/session") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  if (!isAllowedWebSocketOrigin(request)) {
    rejectSocket(socket, 403, "Forbidden");
    return;
  }

  const access = await verifyCloudflareAccess(request);
  if (!access.ok) {
    socket.write(`HTTP/1.1 ${access.status || 403} Forbidden\r\n\r\n${access.error}`);
    socket.destroy();
    return;
  }

  const session = getSession(request);
  if (!session) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  const serverId = url.searchParams.get("serverId");
  const baseServer = serverId ? await findServer(serverId, session) : null;
  const requestedRemotePath = String(url.searchParams.get("remotePath") || "")
    .trim()
    .slice(0, 240);
  const selectedServer = baseServer
    ? {
        ...baseServer,
        defaultPath: requestedRemotePath || baseServer.defaultPath,
      }
    : null;
  if (!selectedServer) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }
  const key = request.headers["sec-websocket-key"];
  if (!key) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
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

  const frameState = { buffer: Buffer.alloc(0) };
  const requestedTaskId = normalizeCodexSessionTaskId(url.searchParams.get("taskId"));
  const suppressReplay = url.searchParams.get("suppressReplay") === "1";
  const agySession = getOrCreateAgySession(session, selectedServer, requestedTaskId);
  attachAgySocket(agySession, socket, { suppressReplay });

  socket.on("data", (chunk) => {
    readWebSocketFrames(
      frameState,
      chunk,
      (payload) => {
        void runAgySessionPrompt(agySession, selectedServer, payload);
      },
      () => {
        closeWebSocket(socket);
      },
    );
  });
}

async function handleBailianUpgrade(request, socket) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);

  if (url.pathname !== "/api/bailian/session") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  if (!isAllowedWebSocketOrigin(request)) {
    rejectSocket(socket, 403, "Forbidden");
    return;
  }

  const access = await verifyCloudflareAccess(request);
  if (!access.ok) {
    socket.write(`HTTP/1.1 ${access.status || 403} Forbidden\r\n\r\n${access.error}`);
    socket.destroy();
    return;
  }

  const session = getSession(request);
  if (!session) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  const serverId = url.searchParams.get("serverId");
  const baseServer = serverId ? await findServer(serverId, session) : null;
  const requestedRemotePath = String(url.searchParams.get("remotePath") || "")
    .trim()
    .slice(0, 240);
  const selectedServer = baseServer
    ? {
        ...baseServer,
        defaultPath: requestedRemotePath || baseServer.defaultPath,
      }
    : null;
  if (!selectedServer) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }
  const key = request.headers["sec-websocket-key"];
  if (!key) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
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

  const frameState = { buffer: Buffer.alloc(0) };
  const requestedTaskId = normalizeCodexSessionTaskId(url.searchParams.get("taskId"));
  const suppressReplay = url.searchParams.get("suppressReplay") === "1";
  const bailianSession = getOrCreateBailianSession(session, selectedServer, requestedTaskId);
  attachBailianSocket(bailianSession, socket, { suppressReplay });

  socket.on("data", (chunk) => {
    readWebSocketFrames(
      frameState,
      chunk,
      (payload) => {
        void runBailianSessionPrompt(bailianSession, selectedServer, payload);
      },
      () => {
        closeWebSocket(socket);
      },
    );
  });
}

async function handleAgentSessionUpgrade(request, socket) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);

  if (url.pathname !== "/api/agent/session") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  if (!isAllowedWebSocketOrigin(request)) {
    rejectSocket(socket, 403, "Forbidden");
    return;
  }

  const access = await verifyCloudflareAccess(request);
  if (!access.ok) {
    socket.write(`HTTP/1.1 ${access.status || 403} Forbidden\r\n\r\n${access.error}`);
    socket.destroy();
    return;
  }

  const session = getSession(request);
  if (!session) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  const key = request.headers["sec-websocket-key"];
  if (!key) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
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

  const frameState = { buffer: Buffer.alloc(0) };
  let running = false;
  const pingTimer = setInterval(() => {
    sendWebSocketPing(socket);
  }, TERMINAL_WS_PING_MS);
  pingTimer.unref?.();

  socket.on("close", () => clearInterval(pingTimer));
  socket.on("error", () => clearInterval(pingTimer));
  sendWebSocketText(socket, "[CozyPad] remote agent stream ready\r\n");

  socket.on("data", (chunk) => {
    readWebSocketFrames(
      frameState,
      chunk,
      (payload) => {
        if (running) {
          sendWebSocketText(socket, "[CozyPad] remote agent is still running; wait before sending another prompt\r\n");
          return;
        }
        running = true;
        void runRemoteAgentSocketPrompt(socket, session, payload)
          .catch((error) => {
            sendWebSocketText(
              socket,
              `[CozyPad] remote agent failed: ${
                error instanceof Error ? error.message : String(error || "unknown error")
              }\r\n`,
            );
          })
          .finally(() => {
            running = false;
          });
      },
      () => {
        clearInterval(pingTimer);
        closeWebSocket(socket);
      },
    );
  });
}

async function handleMonitorUpgrade(request, socket) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);

  if (url.pathname !== "/api/ssh/monitor") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  if (!isAllowedWebSocketOrigin(request)) {
    rejectSocket(socket, 403, "Forbidden");
    return;
  }

  const access = await verifyCloudflareAccess(request);
  if (!access.ok) {
    socket.write(`HTTP/1.1 ${access.status || 403} Forbidden\r\n\r\n${access.error}`);
    socket.destroy();
    return;
  }

  const session = getSession(request);
  if (!session) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  const key = request.headers["sec-websocket-key"];
  if (!key) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
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

  let closed = false;
  const frameState = { buffer: Buffer.alloc(0) };
  let servers = [];
  const serverStates = new Map();
  const monitors = [];
  let interval = null;

  function pushSnapshot() {
    if (closed) {
      return;
    }

    sendWebSocketText(socket, JSON.stringify(createMonitorSnapshotFromStates(servers, serverStates)));
  }

  function closeMonitor() {
    if (closed) {
      return;
    }

    closed = true;
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    for (const monitor of monitors) {
      monitor.close();
    }
    monitors.length = 0;
    closeWebSocket(socket);
  }

  socket.on("data", (chunk) => {
    readWebSocketFrames(frameState, chunk, () => undefined, closeMonitor);
  });
  socket.on("close", closeMonitor);
  socket.on("error", closeMonitor);

  try {
    const allServers = await listServers(session, { includeInternal: true });
    const requestedServerId = getMonitorRequestedServerId(url);
    servers = selectMonitorServers(allServers, url);

    if (requestedServerId && servers.length === 0) {
      throw new Error(`Monitor target not found: ${requestedServerId}`);
    }

    for (const server of servers) {
      serverStates.set(server.id, createMonitorPendingResult(server));
    }
    pushSnapshot();

    for (const server of servers) {
      if (closed) {
        break;
      }

      const monitor = await acquireSharedMonitorStream(
        session,
        server,
        (nextState) => {
          serverStates.set(server.id, nextState);
          pushSnapshot();
        },
      );
      if (closed) {
        monitor.close();
        break;
      }
      monitors.push(monitor);
    }
  } catch (error) {
    const gatePayload = isSshGateConfirmationError(error) ? sshGateErrorPayload(error) : null;
    if (!closed) {
      sendWebSocketText(
        socket,
        JSON.stringify({
          type: "error",
          generatedAt: new Date().toISOString(),
          ...(gatePayload || {
            error: error instanceof Error ? error.message : "Monitor failed",
          }),
        }),
      );
    }
  }

  if (!closed) {
    interval = setInterval(pushSnapshot, MONITOR_INTERVAL_MS);
    interval.unref?.();
  }
}

async function handleRequest(request, response) {
  const corsHeaders = applyCorsHeaders(request, response);
  if (request.method === "OPTIONS") {
    sendEmpty(response, Object.keys(corsHeaders).length > 0 ? 204 : 403, corsHeaders);
    return;
  }

  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  let pathname = url.pathname;
  if (pathname.startsWith("/cozypad-research/")) {
    pathname = `/api/research/${pathname.slice("/cozypad-research/".length)}`;
  }
  if (pathname.startsWith("/cozypad-rpc/")) {
    pathname = `/api/rpc/${pathname.slice("/cozypad-rpc/".length)}`;
  }
  if (pathname.startsWith("/cozypad-agent/")) {
    pathname = `/api/${pathname.slice("/cozypad-agent/".length)}`;
  }

  if (pathname === "/api/ssh/codex-command") {
    await handleCodexCommandRequest(request, response);
    return;
  }

  const access = await verifyCloudflareAccess(request);

  if (!access.ok) {
    sendJson(response, access.status || 403, { ok: false, error: access.error });
    return;
  }

  if (isStateChangingMethod(request.method) && !isAllowedOrigin(request)) {
    sendJson(response, 403, { ok: false, error: "Request origin is not allowed" });
    return;
  }

  if (request.method === "GET" && pathname === "/api/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && pathname === "/api/auth/google/config") {
    sendJson(response, 200, {
      ok: true,
      enabled: Boolean(GOOGLE_CLIENT_ID),
      clientId: GOOGLE_CLIENT_ID,
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/auth/login") {
    const body = await readBody(request);
    const username = String(body.username || "").trim();
    const rateLimit = consumeAuthRateLimit(request, username);

    if (!rateLimit.ok) {
      sendJson(response, 429, {
        ok: false,
        error: "登入嘗試太多次，請稍後再試",
        retryAfterMs: rateLimit.retryAfterMs,
      });
      return;
    }

    const user = await findUser(username);

    if (user && verifyPassword(body.password, user)) {
      clearAuthRateLimit(rateLimit.key);
      await sendLoginResponse(response, user);
      return;
    }

    sendJson(response, 401, { ok: false, error: "Invalid username or password" });
    return;
  }

  if (request.method === "POST" && pathname === "/api/auth/2fa/verify") {
    const body = await readBody(request);
    const result = await verifyTwoFactorChallenge(body.challengeId, body.code);

    if (!result.ok) {
      sendJson(response, result.status || 400, { ok: false, error: result.error });
      return;
    }

    sendJson(
      response,
      200,
      { ok: true, user: publicUser(result.user) },
      { "set-cookie": await createSessionCookie(result.user) },
    );
    return;
  }

  if (request.method === "POST" && pathname === "/api/auth/google") {
    const rateLimit = consumeAuthRateLimit(request, "google");
    if (!rateLimit.ok) {
      sendJson(response, 429, {
        ok: false,
        error: "登入嘗試太多次，請稍後再試",
        retryAfterMs: rateLimit.retryAfterMs,
      });
      return;
    }

    try {
      const body = await readBody(request);
      const { email } = await verifyGoogleCredential(body.credential);
      const user = await findGoogleLoginUser(email);

      if (!user) {
        sendJson(response, 403, {
          ok: false,
          error: "Google account is verified but not allowed for this CozyPad",
        });
        return;
      }

      clearAuthRateLimit(rateLimit.key);
      await sendLoginResponse(response, user, { email });
    } catch (error) {
      sendJson(response, 401, {
        ok: false,
        error: error instanceof Error ? error.message : "Google login failed",
      });
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/auth/logout") {
    sendJson(response, 200, { ok: true }, { "set-cookie": await clearSessionCookie(request) });
    return;
  }

  if (request.method === "GET" && pathname === "/api/auth/session") {
    const session = getSession(request);
    sendJson(response, 200, {
      authenticated: Boolean(session),
      user: session ? { username: session.username, role: session.role || "user" } : null,
    });
    return;
  }

  const session = getSession(request);
  if (!session) {
    sendJson(response, 401, { ok: false, error: "Authentication required" });
    return;
  }

  if (request.method === "GET" && pathname === "/api/codex/app-server/status") {
    const serverId = String(url.searchParams.get("serverId") || "");
    const selectedServer = serverId ? await findServer(serverId, session) : null;
    if (serverId && !selectedServer) {
      sendJson(response, 404, { ok: false, error: "Server not found" });
      return;
    }
    sendJson(response, 200, {
      ok: true,
      enabled: CODEX_FEATURE_ENABLED && CODEX_RUNTIME_MODE !== "legacy",
      mode: CODEX_RUNTIME_MODE,
      runtimes: codexAppServerRuntimeManager.list(getTerminalOwner(session)).filter((runtime) =>
        selectedServer ? runtime.identity.connectionProfileId === selectedServer.id : true,
      ),
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/auth/login-records") {
    sendJson(
      response,
      200,
      await listPublicLoginRecords(session, {
        page: url.searchParams.get("page"),
        limit: url.searchParams.get("limit"),
      }),
    );
    return;
  }

  if (request.method === "GET" && pathname === "/api/local-helper/windows.ps1") {
    sendText(response, 200, await createLocalHelperInstallerScript(), {
      "content-disposition": 'attachment; filename="install-cozypad-local-helper.ps1"',
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/ssh/terminal/close") {
    const body = await readBody(request);
    const closed = closeTerminalSessionForUser(session, body.terminalId);
    sendJson(response, 200, { ok: true, closed });
    return;
  }

  if (request.method === "POST" && pathname === "/api/ssh/connect") {
    const body = await readBody(request);
    const selectedServer = body?.serverId ? await findServer(body.serverId, session) : null;
    if (!selectedServer || isSystemLocalServer(selectedServer)) {
      sendJson(response, 400, { ok: false, error: "A remote SSH server is required" });
      return;
    }
    const broker = await getSsh2Broker(session, selectedServer);
    sendJson(response, 200, {
      ok: true,
      serverId: selectedServer.id,
      status: broker.status,
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/ssh/runtime/close-all") {
    sendJson(response, 200, closeSshRuntimeForUser(session, "page closed"));
    return;
  }

  if (request.method === "POST" && pathname === "/api/ssh/agent-cooldown/reset") {
    try {
      const body = await readBody(request);
      sendJson(response, 200, await resetRemoteAgentBlockForSession(session, body));
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        error: error instanceof Error ? error.message : "Remote agent cooldown reset failed",
      });
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/ssh/agents/stop-latest") {
    try {
      const body = await readBody(request, 128 * 1024);
      sendJson(response, 200, await stopLatestRemoteAgentTaskForSession(session, body));
    } catch (error) {
      sendErrorJson(response, 400, error, "Remote agent stop failed");
    }
    return;
  }

  if (request.method === "GET" && pathname === "/api/ssh/runtime") {
    sendJson(response, 200, listSshRuntimeSnapshot(session));
    return;
  }

  if (request.method === "GET" && pathname === "/api/ssh/terminal/sessions") {
    sendJson(response, 200, {
      ok: true,
      generatedAt: new Date().toISOString(),
      terminalBridgeEnabled: AGENT_TERMINAL_BRIDGE_ENABLED,
      terminals: listTerminalSessionsForUser(session),
    });
    return;
  }

  const remoteAgentRunJobMatch = pathname.match(
    /^\/api\/ssh\/(claude|agy|bailian|codex)\/run\/jobs\/([^/]+)$/,
  );
  if (request.method === "GET" && remoteAgentRunJobMatch) {
    const agent = remoteAgentRunJobMatch[1] || "";
    const jobId = decodeURIComponent(remoteAgentRunJobMatch[2] || "");
    const job = getRemoteAgentRunJobForSession(session, agent, jobId);
    if (!job) {
      sendJson(response, 404, { ok: false, error: "Remote agent job not found" });
      return;
    }
    sendJson(response, 200, publicRemoteAgentRunJob(job));
    return;
  }

  const remoteAgentRunJobRpcMatch = pathname.match(
    /^\/api\/rpc\/ssh\/(claude|agy|bailian|codex)\/run\/jobs\/([^/]+)$/,
  );
  if (request.method === "POST" && remoteAgentRunJobRpcMatch) {
    const agent = remoteAgentRunJobRpcMatch[1] || "";
    let jobId = decodeURIComponent(remoteAgentRunJobRpcMatch[2] || "");
    try {
      const body = await readBase64UrlJsonBody(request, 128 * 1024);
      jobId = String(body.jobId || jobId || "").trim();
    } catch {
      // The job id is already present in the URL. Keep this endpoint tolerant so
      // status polling can recover from Cloudflare edge failures.
    }
    const job = getRemoteAgentRunJobForSession(session, agent, jobId);
    if (!job) {
      sendJson(response, 404, { ok: false, error: "Remote agent job not found" });
      return;
    }
    sendJson(response, 200, publicRemoteAgentRunJob(job));
    return;
  }

  const remoteAgentRunJobsMatch = pathname.match(
    /^\/api\/ssh\/(claude|agy|bailian|codex)\/run\/jobs$/,
  );
  if (request.method === "POST" && remoteAgentRunJobsMatch) {
    try {
      const body = await readBody(request, 512 * 1024);
      const job = await createRemoteAgentRunJob(session, remoteAgentRunJobsMatch[1], body);
      sendJson(response, 202, publicRemoteAgentRunJob(job));
    } catch (error) {
      sendErrorJson(response, 400, error, "Remote agent job failed");
    }
    return;
  }

  const remoteAgentRunJobsRpcMatch = pathname.match(
    /^\/api\/rpc\/ssh\/(claude|agy|bailian|codex)\/run\/jobs$/,
  );
  if (request.method === "POST" && remoteAgentRunJobsRpcMatch) {
    try {
      const body = await readBase64UrlJsonBody(request, 512 * 1024);
      const job = await createRemoteAgentRunJob(session, remoteAgentRunJobsRpcMatch[1], body);
      sendJson(response, 202, publicRemoteAgentRunJob(job));
    } catch (error) {
      sendErrorJson(response, 400, error, "Remote agent job failed");
    }
    return;
  }

  const codexStatusMatch = pathname.match(/^\/api\/ssh\/servers\/([^/]+)\/codex-status$/);
  if (request.method === "GET" && codexStatusMatch) {
    try {
      const serverId = decodeURIComponent(codexStatusMatch[1] || "");
      sendJson(response, 200, await getRemoteCodexStatus(session, serverId));
    } catch (error) {
      sendErrorJson(response, 400, error, "Remote Codex status failed");
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/rpc/ssh/codex/status") {
    try {
      const body = await readBase64UrlJsonBody(request, 128 * 1024);
      sendJson(response, 200, await getRemoteCodexStatus(session, String(body.serverId || "")));
    } catch (error) {
      sendErrorJson(response, 400, error, "Remote Codex status failed");
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/ssh/codex/run") {
    try {
      const body = await readBody(request, 512 * 1024);
      sendJson(response, 200, await runRemoteCodexPrompt(session, body));
    } catch (error) {
      sendErrorJson(response, 400, error, "Remote Codex run failed");
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/rpc/ssh/codex/run") {
    try {
      const body = await readBase64UrlJsonBody(request, 512 * 1024);
      sendJson(response, 200, await runRemoteCodexPrompt(session, body));
    } catch (error) {
      sendErrorJson(response, 400, error, "Remote Codex run failed");
    }
    return;
  }

  if (
    !CLAUDE_SERVICES_ENABLED &&
    (pathname === "/api/ssh/claude/run" ||
      pathname === "/api/rpc/ssh/claude/run" ||
      pathname === "/api/rpc/ssh/claude/status" ||
      /^\/api\/ssh\/servers\/[^/]+\/claude-status$/.test(pathname))
  ) {
    sendJson(response, 410, {
      ok: false,
      error: "Claude service is disabled",
    });
    return;
  }

  const claudeStatusMatch = pathname.match(/^\/api\/ssh\/servers\/([^/]+)\/claude-status$/);
  if (request.method === "GET" && claudeStatusMatch) {
    try {
      const serverId = decodeURIComponent(claudeStatusMatch[1] || "");
      sendJson(response, 200, await getRemoteClaudeStatus(session, serverId));
    } catch (error) {
      sendErrorJson(response, 400, error, "Remote Claude status failed");
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/rpc/ssh/claude/status") {
    try {
      const body = await readBase64UrlJsonBody(request, 128 * 1024);
      sendJson(response, 200, await getRemoteClaudeStatus(session, String(body.serverId || "")));
    } catch (error) {
      sendErrorJson(response, 400, error, "Remote Claude status failed");
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/ssh/claude/run") {
    try {
      const body = await readBody(request, 512 * 1024);
      sendJson(response, 200, await runRemoteClaudePrompt(session, body));
    } catch (error) {
      sendErrorJson(response, 400, error, "Remote Claude run failed");
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/rpc/ssh/claude/run") {
    try {
      const body = await readBase64UrlJsonBody(request, 512 * 1024);
      sendJson(response, 200, await runRemoteClaudePrompt(session, body));
    } catch (error) {
      sendErrorJson(response, 400, error, "Remote Claude run failed");
    }
    return;
  }

  const agyStatusMatch = pathname.match(/^\/api\/ssh\/servers\/([^/]+)\/agy-status$/);
  if (request.method === "GET" && agyStatusMatch) {
    try {
      const serverId = decodeURIComponent(agyStatusMatch[1] || "");
      sendJson(response, 200, await getRemoteAgyStatus(session, serverId));
    } catch (error) {
      sendErrorJson(response, 400, error, "Remote agy status failed");
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/rpc/ssh/agy/status") {
    try {
      const body = await readBase64UrlJsonBody(request, 128 * 1024);
      sendJson(response, 200, await getRemoteAgyStatus(session, String(body.serverId || "")));
    } catch (error) {
      sendErrorJson(response, 400, error, "Remote agy status failed");
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/ssh/agy/run") {
    try {
      const body = await readBody(request, 512 * 1024);
      sendJson(response, 200, await runRemoteAgyPrompt(session, body));
    } catch (error) {
      sendErrorJson(response, 400, error, "Remote agy run failed");
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/rpc/ssh/agy/run") {
    try {
      const body = await readBase64UrlJsonBody(request, 512 * 1024);
      sendJson(response, 200, await runRemoteAgyPrompt(session, body));
    } catch (error) {
      sendErrorJson(response, 400, error, "Remote agy run failed");
    }
    return;
  }

  const bailianStatusMatch = pathname.match(/^\/api\/ssh\/servers\/([^/]+)\/bailian-status$/);
  if (request.method === "GET" && bailianStatusMatch) {
    try {
      const serverId = decodeURIComponent(bailianStatusMatch[1] || "");
      sendJson(response, 200, await getRemoteBailianStatus(session, serverId, {
        hasApiKey: url.searchParams.get("hasApiKey") === "1",
      }));
    } catch (error) {
      sendErrorJson(response, 400, error, "Remote bailian status failed");
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/rpc/ssh/bailian/status") {
    try {
      const body = await readBase64UrlJsonBody(request, 128 * 1024);
      sendJson(response, 200, await getRemoteBailianStatus(session, String(body.serverId || ""), {
        hasApiKey: Boolean(body.hasApiKey),
      }));
    } catch (error) {
      sendErrorJson(response, 400, error, "Remote bailian status failed");
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/ssh/bailian/session-key") {
    try {
      const body = await readBody(request, 128 * 1024);
      if (body.clear) {
        setBailianSessionKey(session, "");
        sendJson(response, 200, { ok: true, hasKey: false });
        return;
      }
      const encoded = String(body.encoded || "").trim();
      const keyText = encoded ? Buffer.from(encoded, "base64").toString("utf8") : "";
      const hasKey = setBailianSessionKey(session, keyText || body.value || "");
      if (!hasKey) {
        sendJson(response, 400, { ok: false, error: "Bailian key is empty" });
        return;
      }
      sendJson(response, 200, { ok: true, hasKey: true });
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        error: error instanceof Error ? error.message : "Bailian key sync failed",
      });
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/rpc/ssh/bailian/session-key") {
    try {
      const body = await readBase64UrlJsonBody(request, 128 * 1024);
      if (body.clear) {
        setBailianSessionKey(session, "");
        sendJson(response, 200, { ok: true, hasKey: false });
        return;
      }
      const encoded = String(body.encoded || "").trim();
      const keyText = encoded ? Buffer.from(encoded, "base64").toString("utf8") : "";
      const hasKey = setBailianSessionKey(session, keyText || body.value || "");
      if (!hasKey) {
        sendJson(response, 400, { ok: false, error: "Bailian key is empty" });
        return;
      }
      sendJson(response, 200, { ok: true, hasKey: true });
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        error: error instanceof Error ? error.message : "Bailian key sync failed",
      });
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/ssh/bailian/run") {
    try {
      const body = await readBody(request, 512 * 1024);
      sendJson(response, 200, await runRemoteBailianPrompt(session, body));
    } catch (error) {
      sendErrorJson(response, 400, error, "Remote bailian run failed");
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/rpc/ssh/bailian/run") {
    try {
      const body = await readBase64UrlJsonBody(request, 512 * 1024);
      sendJson(response, 200, await runRemoteBailianPrompt(session, body));
    } catch (error) {
      sendErrorJson(response, 400, error, "Remote bailian run failed");
    }
    return;
  }

  if (!CODEX_FEATURE_ENABLED && pathname.startsWith("/api/codex")) {
    sendJson(response, 410, { ok: false, error: "Codex feature is disabled" });
    return;
  }

  if (pathname.startsWith("/api/domin") && !requireAdmin(response, session)) {
    return;
  }

  if (pathname.startsWith("/api/public") && !requireAdmin(response, session)) {
    return;
  }

  if (request.method === "GET" && pathname === "/api/public/status") {
    sendJson(response, 200, await getPublicWorkflowStatus());
    return;
  }

  if (request.method === "POST" && pathname === "/api/public/start") {
    try {
      const body = await readBody(request);
      sendJson(response, 200, await startPublicWorkflow(Boolean(body.restartTunnel)));
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : "Public workflow failed",
        status: await getPublicWorkflowStatus(),
      });
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/markdown/summarize") {
    try {
      const body = await readBody(request, MARKDOWN_SUMMARY_MAX_TOTAL_BYTES + 512 * 1024);
      const server = await findMarkdownSummaryServer(session, String(body.serverId || ""));
      if (!server) {
        sendJson(response, 400, {
          ok: false,
          error: `找不到可用的 ${MARKDOWN_SUMMARY_SERVER_KEYWORD || "91"} SSH server`,
        });
        return;
      }

      const payload = normalizeMarkdownSummaryPayload(body);
      const result = await runRemoteCommandWithInput(
        session,
        server,
        createMarkdownSummaryCommand(),
        JSON.stringify(payload),
        MARKDOWN_SUMMARY_TIMEOUT_MS,
        {
          stdoutLimit: 2 * 1024 * 1024,
          stderrLimit: 512 * 1024,
        },
      );

      if (!result.ok && !result.stdout.trim()) {
        sendJson(response, 502, {
          ok: false,
          error: result.stderr || "Remote markdown summary failed",
          result,
        });
        return;
      }

      const parsed = parseSshJsonOutput(result.stdout);
      sendJson(response, parsed.ok ? 200 : 502, {
        ...parsed,
        server: publicSshServer(server),
        stderr: truncateForApi(result.stderr),
      });
    } catch (error) {
      sendErrorJson(response, 400, error, "Markdown summary failed");
    }
    return;
  }

  const researchFlowchartJobMatch = pathname.match(/^\/api\/research\/flowchart-markdown\/jobs\/([^/]+)$/);
  if (request.method === "GET" && researchFlowchartJobMatch) {
    pruneResearchFlowchartJobs();
    const jobId = decodeURIComponent(researchFlowchartJobMatch[1] || "");
    const job = researchFlowchartJobs.get(jobId);
    if (!job || job.owner !== getTerminalOwner(session)) {
      sendJson(response, 404, {
        ok: false,
        error: "找不到 baillian 分析工作，可能已過期或服務已重啟。",
      });
      return;
    }

    const statusCode = job.status === "queued" || job.status === "running" ? 202 : 200;
    sendJson(response, statusCode, publicResearchFlowchartJob(job));
    return;
  }

  if (request.method === "POST" && pathname === "/api/research/flowchart-markdown") {
    try {
      const body = await readBody(request, 1024 * 1024);
      const payload = normalizeResearchFlowchartPayload(body);
      const job = createResearchFlowchartJob(session, null, payload, {
        provider: "bailian",
        apiKey: body.apiKey || getBailianSessionKey(session),
        model: body.model,
      });
      sendJson(response, 202, publicResearchFlowchartJob(job));
    } catch (error) {
      const errorMessage =
        error instanceof Error ? publicDiagnosticText(error.message) : "Flowchart markdown analysis failed";
      console.warn("[research-flowchart] request failed", errorMessage);
      sendJson(response, 400, {
        ok: false,
        error: errorMessage,
      });
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/research/flowchart-markdown/batch") {
    try {
      const body = await readBody(request, FLOWCHART_MARKDOWN_BATCH_MAX_BODY_BYTES);
      const payload = normalizeResearchFlowchartBatchPayload(body);
      const job = createResearchFlowchartJob(session, null, payload, {
        batch: true,
        provider: "bailian",
        apiKey: body.apiKey || getBailianSessionKey(session),
        model: body.model,
      });
      sendJson(response, 202, publicResearchFlowchartJob(job));
    } catch (error) {
      const errorMessage =
        error instanceof Error ? publicDiagnosticText(error.message) : "Batch flowchart markdown analysis failed";
      console.warn("[research-flowchart-batch] request failed", errorMessage);
      sendJson(response, 400, {
        ok: false,
        error: errorMessage,
      });
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/rpc/research/flowchart-markdown") {
    try {
      const body = await readBase64UrlJsonBody(request, 1024 * 1024);
      const payload = normalizeResearchFlowchartPayload(body);
      const job = createResearchFlowchartJob(session, null, payload, {
        provider: "bailian",
        apiKey: body.apiKey || getBailianSessionKey(session),
        model: body.model,
      });
      sendJson(response, 202, publicResearchFlowchartJob(job));
    } catch (error) {
      const errorMessage =
        error instanceof Error ? publicDiagnosticText(error.message) : "Flowchart markdown analysis failed";
      console.warn("[research-flowchart-rpc] request failed", errorMessage);
      sendJson(response, 400, {
        ok: false,
        error: errorMessage,
      });
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/rpc/research/flowchart-markdown/batch") {
    try {
      const body = await readBase64UrlJsonBody(request, FLOWCHART_MARKDOWN_BATCH_MAX_BODY_BYTES);
      const payload = normalizeResearchFlowchartBatchPayload(body);
      const job = createResearchFlowchartJob(session, null, payload, {
        batch: true,
        provider: "bailian",
        apiKey: body.apiKey || getBailianSessionKey(session),
        model: body.model,
      });
      sendJson(response, 202, publicResearchFlowchartJob(job));
    } catch (error) {
      const errorMessage =
        error instanceof Error ? publicDiagnosticText(error.message) : "Batch flowchart markdown analysis failed";
      console.warn("[research-flowchart-batch-rpc] request failed", errorMessage);
      sendJson(response, 400, {
        ok: false,
        error: errorMessage,
      });
    }
    return;
  }

  if (
    request.method === "POST" &&
    (pathname === "/api/rpc/research/diagram-bailian" || pathname === "/api/rpc/research/diagram-codex")
  ) {
    try {
      const body = await readBase64UrlJsonBody(request, 512 * 1024);
      sendJson(response, 200, await runResearchDiagramBailian(session, body));
    } catch (error) {
      if (isSshGateConfirmationError(error)) {
        sendErrorJson(response, 409, error, "Diagram drawing needs SSH confirmation");
        return;
      }
      const message = error instanceof Error ? publicDiagnosticText(error.message) : "Bailian diagram drawing failed";
      const explicitStatus = Number(error?.statusCode || 0);
      const status = explicitStatus >= 400 && explicitStatus < 600 ? explicitStatus : /busy/i.test(message) ? 409 : 400;
      sendJson(response, status, {
        ok: false,
        error: message,
      });
    }
    return;
  }

  if (
    request.method === "POST" &&
    (pathname === "/api/research/diagram-bailian" || pathname === "/api/research/diagram-codex")
  ) {
    try {
      const body = await readBody(request, 512 * 1024);
      sendJson(response, 200, await runResearchDiagramBailian(session, body));
    } catch (error) {
      if (isSshGateConfirmationError(error)) {
        sendErrorJson(response, 409, error, "Diagram drawing needs SSH confirmation");
        return;
      }
      const message = error instanceof Error ? publicDiagnosticText(error.message) : "Bailian diagram drawing failed";
      const explicitStatus = Number(error?.statusCode || 0);
      const status = explicitStatus >= 400 && explicitStatus < 600 ? explicitStatus : /busy/i.test(message) ? 409 : 400;
      sendJson(response, status, {
        ok: false,
        error: message,
      });
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/auth/password") {
    const body = await readBody(request);
    const user = await findUser(session.username);

    if (!user || !verifyPassword(body.currentPassword, user)) {
      sendJson(response, 400, { ok: false, error: "Current password is incorrect" });
      return;
    }

    const nextPassword = String(body.nextPassword || "");
    if (nextPassword.length < 4) {
      sendJson(response, 400, { ok: false, error: "Password must be at least 4 characters" });
      return;
    }

    await changeUserPassword(session.username, nextPassword);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && pathname === "/api/codex/histories") {
    const serverId = url.searchParams.get("serverId") || "";
    sendJson(response, 200, { histories: await listCodexHistories(session, serverId) });
    return;
  }

  if (request.method === "GET" && pathname === "/api/codex/account") {
    sendJson(response, 200, await getCodexAccountStatus(session));
    return;
  }

  if (request.method === "POST" && pathname === "/api/codex/account/bind") {
    try {
      console.info(`[api] codex account bind user=${session.username}`);
      const launch = await launchCodexAccountBinding(session);
      sendJson(response, 200, { ok: true, ...launch });
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : "Codex 自行登入失敗",
      });
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/codex/account/logout") {
    const result = await logoutCodexAccount(session);
    const account = await getCodexAccountStatus(session);
    const ok = !account.bound;
    sendJson(response, ok ? 200 : 500, {
      ok,
      ...(ok
        ? {}
        : { error: result.stderr || result.stdout || "Codex logout failed" }),
      account,
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/codex/histories") {
    try {
      const body = await readBody(request);
      const server = body.serverId ? await findServer(body.serverId, session) : null;
      if (!server) {
        sendJson(response, 400, { ok: false, error: "Server is required" });
        return;
      }

      const history = await createCodexHistory(session, server, body.title);
      sendJson(response, 201, { history: publicCodexHistory(history, { includeMessages: true }) });
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        error: error instanceof Error ? error.message : "Codex history create failed",
      });
    }
    return;
  }

  const codexHistoryMatch = pathname.match(/^\/api\/codex\/histories\/([^/]+)$/);
  if (codexHistoryMatch) {
    const historyId = decodeURIComponent(codexHistoryMatch[1]);

    if (request.method === "GET") {
      const history = await getCodexHistory(session, historyId);
      if (!history) {
        sendJson(response, 404, { ok: false, error: "Codex history not found" });
        return;
      }

      sendJson(response, 200, { history: publicCodexHistory(history, { includeMessages: true }) });
      return;
    }

    if (request.method === "DELETE") {
      const deleted = await deleteCodexHistory(session, historyId);
      sendJson(response, deleted ? 200 : 404, {
        ok: deleted,
        ...(deleted ? {} : { error: "Codex history not found" }),
      });
      return;
    }
  }

  if (request.method === "GET" && pathname === "/api/ssh/codex-workflows") {
    const serverId = url.searchParams.get("serverId") || "";
    try {
      sendJson(response, 200, { workflows: await listCodexWorkflows(session, serverId) });
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        error: error instanceof Error ? error.message : "Codex workflow read failed",
      });
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/ssh/codex-workflows") {
    try {
      const body = await readBody(request);
      const workflow = await upsertCodexWorkflow(session, body);
      sendJson(response, 201, { workflow: publicCodexWorkflow(workflow) });
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        error: error instanceof Error ? error.message : "Codex workflow save failed",
      });
    }
    return;
  }

  const codexWorkflowMatch = pathname.match(/^\/api\/ssh\/codex-workflows\/([^/]+)$/);
  if (codexWorkflowMatch) {
    const workflowId = decodeURIComponent(codexWorkflowMatch[1]);

    if (request.method === "PATCH") {
      try {
        const body = await readBody(request);
        const workflow = await updateCodexWorkflow(session, workflowId, body);
        if (!workflow) {
          sendJson(response, 404, { ok: false, error: "Codex workflow not found" });
          return;
        }

        sendJson(response, 200, { workflow: publicCodexWorkflow(workflow) });
      } catch (error) {
        sendJson(response, 400, {
          ok: false,
          error: error instanceof Error ? error.message : "Codex workflow update failed",
        });
      }
      return;
    }

    if (request.method === "DELETE") {
      try {
        const serverId = url.searchParams.get("serverId") || "";
        const deleted = await deleteCodexWorkflow(session, workflowId, serverId);
        sendJson(response, deleted ? 200 : 404, {
          ok: deleted,
          ...(deleted ? {} : { error: "Codex workflow not found" }),
        });
      } catch (error) {
        sendJson(response, 400, {
          ok: false,
          error: error instanceof Error ? error.message : "Codex workflow delete failed",
        });
      }
      return;
    }
  }

  const condaEnvRoute = pathname.match(/^\/api\/ssh\/servers\/([^/]+)\/conda-envs$/);
  if (request.method === "GET" && condaEnvRoute) {
    try {
      const server = await findServer(condaEnvRoute[1], session);
      if (!server) {
        sendJson(response, 404, { ok: false, error: "SSH server not found" });
        return;
      }
      const envs = await listServerCondaEnvs(session, server);
      sendJson(response, 200, { ok: true, server: publicSshServer(server), envs });
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : "Conda env scan failed",
      });
    }
    return;
  }

  if (request.method === "GET" && pathname === "/api/ssh/servers") {
    sendJson(response, 200, { servers: await listServers(session) });
    return;
  }

  if (request.method === "POST" && pathname === "/api/ssh/servers/refresh") {
    const limit = consumeSshConfigRefreshLimit(session);

    if (!limit.ok) {
      sendJson(response, 200, {
        ok: true,
        refreshed: false,
        throttled: true,
        retryAfterMs: limit.retryAfterMs,
        servers: await listServers(session),
      });
      return;
    }

    let refresh;
    try {
      refresh = await refreshProjectSshConfigFromLocal(session);
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : "SSH config refresh failed",
      });
      return;
    }

    sendJson(response, 200, {
      ok: true,
      ...refresh,
      retryAfterMs: limit.retryAfterMs,
      servers: await listServers(session),
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/ssh/servers") {
    try {
      const body = await readBody(request);
      const nextServer = await createDirectServerProfile(session, body);
      const servers = await readLocalServers(session);
      servers.push(nextServer);
      await writeLocalServers(session, servers);
      sendJson(response, 201, { server: publicSshServer(nextServer) });
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        error: error instanceof Error ? error.message : "新增 server 失敗",
      });
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/ssh/tools/auto-login") {
    if (!requireAdmin(response, session)) {
      return;
    }

    sendJson(response, 200, { ok: true, pid: launchAutoLoginUi() });
    return;
  }

  if (request.method === "GET" && pathname === "/api/domin/status") {
    sendJson(response, 200, await getDominDdnsStatus());
    return;
  }

  if (request.method === "GET" && pathname === "/api/domin/config") {
    sendJson(response, 200, { ok: true, config: await readDominDdnsConfig() });
    return;
  }

  if ((request.method === "POST" || request.method === "PUT") && pathname === "/api/domin/config") {
    if (!requireAdmin(response, session)) {
      return;
    }

    try {
      const config = await writeDominDdnsConfig(await readBody(request));
      sendJson(response, 200, { ok: true, config, status: await getDominDdnsStatus() });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (request.method === "GET" && pathname === "/api/domin/logs") {
    sendJson(response, 200, await getDominDdnsLogs(url.searchParams.get("lines") || 180));
    return;
  }

  if (request.method === "POST" && pathname === "/api/domin/update") {
    if (!requireAdmin(response, session)) {
      return;
    }

    try {
      sendJson(response, 200, await runDominDdnsUpdate(await readBody(request)));
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/domin/ui") {
    if (!requireAdmin(response, session)) {
      return;
    }

    try {
      const body = await readBody(request);
      if (body.action === "start") {
        sendJson(response, 200, { ok: true, pid: launchDominDdnsUi(), status: await getDominDdnsStatus() });
      } else if (body.action === "stop") {
        sendJson(response, 200, await stopDominDdnsUi());
      } else {
        sendJson(response, 400, { ok: false, error: "Unsupported UI action" });
      }
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/domin/script") {
    if (!requireAdmin(response, session)) {
      return;
    }

    try {
      const body = await readBody(request);
      sendJson(response, 200, {
        ok: true,
        pid: launchDominDdnsScript(body.script),
        status: await getDominDdnsStatus(),
      });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message });
    }
    return;
  }

  const serverMatch = pathname.match(/^\/api\/ssh\/servers\/([^/]+)(?:\/([^/]+))?$/);
  if (!serverMatch) {
    sendJson(response, 404, { ok: false, error: "Not found" });
    return;
  }

  const server = await findServer(serverMatch[1], session);
  const action = serverMatch[2];

  if (!server) {
    sendJson(response, 404, { ok: false, error: "SSH server not found" });
    return;
  }

  if (request.method === "DELETE" && !action) {
    if (isSystemLocalServer(server)) {
      sendJson(response, 400, { ok: false, error: "localhost is a built-in server and cannot be deleted" });
      return;
    }

    if (server.source === "ssh-config") {
      await deleteSshConfigServer(server, session);
      sendEmpty(response, 204);
      return;
    }

    if (server.source !== "local") {
      sendJson(response, 400, { ok: false, error: "Unsupported SSH server source" });
      return;
    }

    const servers = await readLocalServers(session);
    await writeLocalServers(
      session,
      servers.filter((item) => item.id !== server.id),
    );
    sendEmpty(response, 204);
    return;
  }

  if (request.method === "POST" && action === "test") {
    if (isSystemLocalServer(server)) {
      sendJson(response, 200, createLocalTestResult(server));
      return;
    }

    const result = await runRemoteCommand(session, server, "printf 'COZYPAD_SSH_OK\\n'; hostname; pwd", 15000);
    sendJson(response, result.ok ? 200 : 502, { ...result });
    return;
  }

  if (request.method === "GET" && action === "codex-binding") {
    sendJson(response, 200, {
      binding: localCodexSshBinding(server, createCodexCommandAccess(session, server)),
    });
    return;
  }

  if (request.method === "POST" && action === "repair-key") {
    try {
      const body = await readBody(request);
      const repairedServer = await repairDirectServerKey(session, server, body.password);
      sendJson(response, 200, {
        ok: true,
        server: publicSshServer(repairedServer),
      });
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        error: error instanceof Error ? error.message : "SSH key repair failed",
      });
    }
    return;
  }

  if (request.method === "GET" && action === "files") {
    const remotePath = url.searchParams.get("path") || server.defaultPath || "~";
    if (isSystemLocalServer(server)) {
      try {
        sendJson(response, 200, await browseLocalFiles(remotePath, FILE_LIST_MAX_ITEMS));
      } catch (error) {
        sendJson(response, 502, {
          ok: false,
          path: remotePath,
          error: error instanceof Error ? error.message : "Local file listing failed",
        });
      }
      return;
    }

    const result = await runRemoteCommand(
      session,
      server,
      createBrowseCommand(remotePath, FILE_LIST_MAX_ITEMS),
      30000,
      {
        controlMaster: false,
        stdoutLimit: FILE_LIST_STDOUT_LIMIT,
        stderrLimit: 256 * 1024,
      },
    );
    if (!result.ok && !result.stdout.trim()) {
      sendJson(response, 502, { ok: false, error: result.stderr || "SSH command failed", result });
      return;
    }

    try {
      const parsed = parseSshJsonOutput(result.stdout);
      sendJson(response, parsed.ok ? 200 : 502, { ...parsed, stderr: result.stderr });
    } catch (error) {
      sendJson(response, 502, {
        ok: false,
        error:
          error instanceof Error
            ? `Remote file listing did not return JSON: ${error.message}`
            : "Remote file listing did not return JSON",
        stdout: truncateForApi(result.stdout),
        stderr: truncateForApi(result.stderr),
      });
    }
    return;
  }

  if (request.method === "POST" && action === "files") {
    let body = {};
    try {
      body = await readBody(request);
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message });
      return;
    }

    const fileAction = String(body.action || "").trim();
    const primaryPath =
      fileAction === "mkdir" || fileAction === "touch"
        ? String(body.directory || "")
        : String(body.path || "");
    const fileName = String(body.name || "");
    const destinationPath = String(body.destination || "");

    if (!["mkdir", "touch", "rename", "delete", "copy", "move"].includes(fileAction)) {
      sendJson(response, 400, { ok: false, error: "Unsupported file action" });
      return;
    }

    if (isSystemLocalServer(server)) {
      try {
        sendJson(response, 200, await mutateLocalFile(fileAction, primaryPath, fileName, destinationPath));
      } catch (error) {
        sendJson(response, 400, {
          ok: false,
          action: fileAction,
          error: error instanceof Error ? error.message : "Local file operation failed",
        });
      }
      return;
    }

    const result = await runRemoteCommand(
      session,
      server,
      createFileMutationCommand(fileAction, primaryPath, fileName, destinationPath),
      ["delete", "copy", "move"].includes(fileAction) ? 45000 : 15000,
      { controlMaster: false },
    );
    if (!result.ok && !result.stdout.trim()) {
      sendJson(response, 502, { ok: false, error: result.stderr || "SSH command failed", result });
      return;
    }

    try {
      const parsed = parseSshJsonOutput(result.stdout);
      sendJson(response, parsed.ok ? 200 : 400, { ...parsed, stderr: result.stderr });
    } catch (error) {
      sendJson(response, 502, {
        ok: false,
        error:
          error instanceof Error
            ? `Remote file operation did not return JSON: ${error.message}`
            : "Remote file operation did not return JSON",
        stdout: truncateForApi(result.stdout),
        stderr: truncateForApi(result.stderr),
      });
    }
    return;
  }

  if (request.method === "GET" && action === "file") {
    const remotePath = url.searchParams.get("path") || "";
    if (!remotePath.trim()) {
      sendJson(response, 400, { ok: false, error: "path is required" });
      return;
    }

    if (isSystemLocalServer(server)) {
      try {
        sendJson(response, 200, await previewLocalFile(remotePath, FILE_PREVIEW_MAX_BYTES));
      } catch (error) {
        sendJson(response, 502, {
          ok: false,
          path: remotePath,
          error: error instanceof Error ? error.message : "Local file preview failed",
        });
      }
      return;
    }

    const previewStdoutLimit = Math.ceil(FILE_PREVIEW_MAX_BYTES * 1.5) + 64 * 1024;
    const result = await runRemoteCommand(
      session,
      server,
      createFilePreviewCommand(remotePath, FILE_PREVIEW_MAX_BYTES),
      60000,
      {
        controlMaster: false,
        stdoutLimit: previewStdoutLimit,
        stderrLimit: 256 * 1024,
      },
    );
    if (!result.ok && !result.stdout.trim()) {
      sendJson(response, 502, { ok: false, error: result.stderr || "SSH command failed", result });
      return;
    }

    try {
      const parsed = parseSshJsonOutput(result.stdout);
      sendJson(response, parsed.ok ? 200 : 502, { ...parsed, stderr: result.stderr });
    } catch (error) {
      sendJson(response, 502, {
        ok: false,
        error:
          error instanceof Error
            ? `Remote file preview did not return JSON: ${error.message}`
            : "Remote file preview did not return JSON",
        stdout: truncateForApi(result.stdout),
        stderr: truncateForApi(result.stderr),
      });
    }
    return;
  }

  if (request.method === "POST" && action === "terminal") {
    if (!requireAdmin(response, session)) {
      return;
    }

    if (!isSystemLocalServer(server)) {
      sendJson(response, 410, {
        ok: false,
        error: "External ssh.exe terminal is disabled. Use the CozyPad web Terminal, which runs through ssh2.",
      });
      return;
    }

    sendJson(response, 200, { ok: true, pid: launchWithWindowsTerminal(server) });
    return;
  }

  if (request.method === "POST" && action === "connect") {
    if (!requireAdmin(response, session)) {
      return;
    }

    if (!isSystemLocalServer(server)) {
      sendJson(response, 410, {
        ok: false,
        error: "External ssh.exe connect is disabled. Use CozyPad ssh2-managed sessions instead.",
      });
      return;
    }

    sendJson(response, 200, { ok: true, pid: launchDirectPowerShell(server) });
    return;
  }

  sendJson(response, 404, { ok: false, error: "Not found" });
}

const server = createServer((request, response) => {
  sshGateRequestContext.run(
    { allowSecondSshChannel: getSshGateOverrideFromRequest(request) },
    () => {
      handleRequest(request, response).catch((error) => {
        sendErrorJson(response, 500, error, "CozyPad API failed");
      });
    },
  );
});

server.on("upgrade", (request, socket) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  if (url.pathname.startsWith("/cozypad-agent/")) {
    url.pathname = `/api/${url.pathname.slice("/cozypad-agent/".length)}`;
    request.url = `${url.pathname}${url.search}`;
  }
  if (
    !CODEX_FEATURE_ENABLED &&
    (url.pathname === "/api/codex/session" || url.pathname === "/api/codex/app-server/session")
  ) {
    rejectSocket(socket, 410, "Codex feature is disabled");
    return;
  }

  const handler =
    url.pathname === "/api/codex/app-server/session"
      ? handleCodexAppServerUpgrade
      : url.pathname === "/api/codex/session"
      ? handleCodexUpgrade
      : url.pathname === "/api/claude/session"
        ? handleClaudeUpgrade
      : url.pathname === "/api/agy/session"
        ? handleAgyUpgrade
      : url.pathname === "/api/bailian/session"
        ? handleBailianUpgrade
      : url.pathname === "/api/agent/session"
        ? handleAgentSessionUpgrade
      : url.pathname === "/api/ssh/monitor"
        ? handleMonitorUpgrade
        : handleTerminalUpgrade;

  sshGateRequestContext.run({ allowSecondSshChannel: false }, () => {
    handler(request, socket).catch((error) => {
      try {
        if (isSshGateConfirmationError(error)) {
          const payload = JSON.stringify(sshGateErrorPayload(error));
          socket.write(
            `HTTP/1.1 409 Conflict\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
          );
        } else {
          socket.write(`HTTP/1.1 500 Internal Server Error\r\n\r\n${error.message}`);
        }
      } finally {
        socket.destroy();
      }
    });
  });
});

await loadSessions();

server.listen(PORT, "127.0.0.1", () => {
  console.log(`CozyPad SSH API listening on http://127.0.0.1:${PORT}`);
});
