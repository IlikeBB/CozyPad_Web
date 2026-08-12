import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import type { ConnectionProfile } from '@cozypad/contracts';
import {
  markdownRehypePlugins,
  markdownRemarkPlugins,
  normalizeMarkdownMath,
} from '../../components/markdownPlugins';
import {
  AgentImagePreviewStrip,
  createMarkdownComponents,
  dispatchOpenFilePath,
  filePathLinkDataset,
  linkifyRemotePathLines,
} from '../../components/markdownComponents';
import { ChatComposer } from './ChatComposer';
import type { ChatComposerAttachment } from './ChatComposer';
import { EditSentMessageDialog } from './EditSentMessageDialog';
import { isWorkRunDeleted, markWorkRunDeleted } from '../workRuns';
import {
  isQueuedStartTrainingTask,
  subscribeCodexTrainingTasks,
  takeQueuedCodexTrainingTasks,
} from './codexTaskQueue';
import { commonAgentSlashCommands } from './slashCommands';
import {
  createLegacyCodexHistory,
  deleteLegacyCodexWorkflow,
  getLegacyCodexStatus,
  listLegacyCodexWorkflows,
  loadLegacyCodexBinding,
  saveLegacyCodexWorkflow,
  stopLegacyAgentLatestTask,
} from './legacySshApi';
import type {
  LegacyCodexBinding,
  LegacyCodexReasoningEffort,
  LegacyCodexStatus,
  LegacyCodexWorkflow,
  LegacySshServer,
} from './legacySshApi';

const STORAGE_KEY = 'cozypad3.legacyCodexTasks.v1';
const COMPOSER_DRAFT_STORAGE_KEY = 'cozypad3.legacyCodexComposerDraft.v1';
const CODEX_MODEL_STORAGE_KEY = 'cozypad3.remoteCodex.model.v1';
const CODEX_EFFORT_STORAGE_KEY = 'cozypad3.remoteCodex.reasoningEffort.v1';
const RESEARCH_REFRESH_EVENT = 'cozypad-research-runs-updated';
const MAX_OUTPUT_LENGTH = 160_000;
const MAX_TASKS = 24;
const IDLE_OUTPUT = '';
const MAX_IMAGE_ATTACHMENTS = 6;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 1800;
const CODEX_WS_RECONNECT_BASE_MS = 1_500;
const CODEX_WS_RECONNECT_MAX_MS = 15_000;
const CODEX_WS_RECONNECT_MAX_ATTEMPTS = 2;
const CODEX_MODEL_FALLBACKS = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'codex-auto-review',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex-spark',
  'gpt-5',
  'gpt-5-mini',
  'o4-mini',
  'o3',
];
const CODEX_EFFORT_OPTIONS: Array<{
  value: LegacyCodexReasoningEffort;
  label: string;
}> = [
  { value: '', label: 'auto' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
  { value: 'max', label: 'max' },
  { value: 'ultra', label: 'ultra' },
];

type CodexTask = {
  id: string;
  title: string;
  prompt: string;
  output: string;
  status: CodexTaskStatus;
  running: boolean;
  connected: boolean;
  profileId: string;
  profileName: string;
  serverTarget?: string;
  remotePath: string;
  model: string;
  reasoningEffort: LegacyCodexReasoningEffort;
  historyId: string;
  createdAt: string;
  updatedAt: string;
};

type SendPayload = {
  prompt: string;
  attachments?: CodexImagePayload[];
  remotePath?: string;
  model?: string;
  reasoningEffort?: LegacyCodexReasoningEffort;
};

type StartTaskOptions = {
  title?: string;
  remotePath?: string;
};

type CodexImageAttachment = ChatComposerAttachment & {
  dataBase64: string;
};

type CodexImagePayload = {
  name: string;
  type: string;
  size: number;
  dataBase64: string;
};

type CodexTaskStatus = 'completed' | 'running' | 'failed';
type CodexDialogueRole = 'user' | 'codex' | 'system';

type CodexDialogueBlock = {
  role: CodexDialogueRole;
  text: string;
};

type CodexContentSection =
  | { kind: 'text'; title?: string; text: string }
  | { kind: 'code'; title: string; text: string }
  | { kind: 'tool'; title: string; text: string }
  | { kind: 'diff'; title: string; text: string }
  | { kind: 'status'; title: string; text: string }
  | { kind: 'meta'; title: string; text: string };

const USER_TRANSCRIPT_MARKER = '[CozyPad User]';
const CODEX_TRANSCRIPT_MARKER = '[CozyPad Codex]';
const CODEX_STREAM_WAITING_TEXT = '[CozyPad] codex stream connected; waiting for agent output';
const INLINE_REMOTE_PATH_PATTERN =
  /((?:~(?:\/[^\s`"'<>]*)?)|(?:\/(?:home|ssd\d*|mnt|data|workspace|work|project|projects|tmp|var|opt|root|usr|srv)(?:\/[^\s`"'<>]*)?))/g;
const TRAILING_INLINE_PATH_PUNCTUATION = /[),.，。；;：:、\]}）】》」』]+$/;

function createTaskId(): string {
  if (window.crypto?.randomUUID) return `codex:${window.crypto.randomUUID()}`;
  return `codex:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

function legacyServerTarget(server: LegacySshServer | null): string {
  if (!server) return '';
  if (isLocalLegacyServer(server)) return server.alias || server.name || 'localhost';
  if (server.source === 'ssh-config') return server.alias || server.name;
  return `${server.user ? `${server.user}@` : ''}${server.host}${server.port ? `:${server.port}` : ''}`;
}

function titleFromPrompt(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim().slice(0, 32) || 'Codex 工作';
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function normalizeCodexModel(value: string): string {
  const model = value.trim().slice(0, 80);
  return /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(model) ? model : '';
}

function mergeCodexModelOptions(...groups: Array<Array<string | undefined> | undefined>): string[] {
  const seen = new Set<string>();
  const options: string[] = [];
  for (const group of groups) {
    for (const value of group || []) {
      const model = normalizeCodexModel(String(value || ''));
      const key = model.toLowerCase();
      if (!model || seen.has(key)) continue;
      seen.add(key);
      options.push(model);
    }
  }
  return options;
}

function normalizeCodexReasoningEffort(value: string): LegacyCodexReasoningEffort {
  const effort = value.trim().toLowerCase();
  return CODEX_EFFORT_OPTIONS.some((option) => option.value === effort)
    ? (effort as LegacyCodexReasoningEffort)
    : '';
}

function normalizeRemotePath(value: string): string {
  return value.trim().slice(0, 240) || '~';
}

function extractCodexCwdUpdate(text: string): string {
  const lines = normalizeOutput(text).split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = (lines[index] || '').trim().match(/^\[CozyPad cwd\]\s*:?\s*(.+)$/i);
    if (match?.[1]) {
      return normalizeRemotePath(match[1]);
    }
  }
  return '';
}

function isHiddenCodexControlLine(line: string): boolean {
  return Boolean(extractCodexCwdUpdate(line));
}

function parseStandaloneCwdChangeRequest(prompt: string): string {
  const text = prompt.trim();
  const match =
    text.match(/^(?:cd|cwd)\s+([~/][^\s，。；;]*)\s*$/i) ||
    text.match(/^(?:目標路徑)?請?先?(?:切換|切到|切換到|切換至)\s*([~/][^\s，。；;]*)\s*$/i) ||
    text.match(/^目標路徑請先切換到\s*([~/][^\s，。；;]*)\s*$/i);
  return match?.[1] ? normalizeRemotePath(match[1]) : '';
}

function readStoredCodexModel(): string {
  try {
    return normalizeCodexModel(window.localStorage.getItem(CODEX_MODEL_STORAGE_KEY) || '');
  } catch {
    return '';
  }
}

function readStoredCodexReasoningEffort(): LegacyCodexReasoningEffort {
  try {
    return normalizeCodexReasoningEffort(
      window.localStorage.getItem(CODEX_EFFORT_STORAGE_KEY) || '',
    );
  } catch {
    return '';
  }
}

function readStoredComposerDraft(): string {
  try {
    return window.localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function writeStoredComposerDraft(value: string): void {
  try {
    if (value.trim()) {
      window.localStorage.setItem(COMPOSER_DRAFT_STORAGE_KEY, value);
    } else {
      window.localStorage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
    }
  } catch {
    // Browser storage is best-effort.
  }
}

function payloadFromImages(images: CodexImageAttachment[]): CodexImagePayload[] {
  return images.map(({ name, type, size, dataBase64 }) => ({
    name,
    type,
    size,
    dataBase64,
  }));
}

function imageSummary(images: CodexImagePayload[] | CodexImageAttachment[]): string {
  if (images.length === 0) return '';
  return [
    '',
    '[Attached images]',
    ...images.map((image, index) => `- ${index + 1}. ${image.name} (${image.type}, ${formatBytes(image.size)})`),
  ].join('\n');
}

function isHiddenCodexImagePayloadLine(line: string): boolean {
  const trimmed = line.trim();
  const lower = trimmed.toLowerCase();
  return (
    lower.includes('[cozypad] image attachment ready') ||
    lower.includes('[cozypad] image attachment decode failed') ||
    lower.includes('[cozypad] image attachments were not available to codex cli') ||
    lower.includes('cozypad image attachments copied') ||
    lower.includes('cozypad attached image files') ||
    lower.includes('"database64"') ||
    lower.includes('data:image/') ||
    (lower.includes('"attachments"') && lower.includes('base64'))
  );
}

function isHiddenRemoteCodexTransportLine(line: string): boolean {
  const trimmed = line.trim();
  const lower = trimmed.toLowerCase();
  return (
    lower === '[remote codex]' ||
    lower === '[cozypad] remote codex ready' ||
    lower === '[cozypad] codex ready' ||
    lower === '[cozypad] codex heartbeat' ||
    lower === '[cozypad] codex is still running in background' ||
    lower === '[cozypad local codex] ready' ||
    lower === '[cozypad] remote codex websocket error' ||
    lower.includes('remote codex retry scheduled') ||
    lower.includes('remote codex ssh transport was interrupted') ||
    lower.includes('cozypad will retry automatically') ||
    lower.includes('cozypad will continue this task automatically') ||
    (lower.includes('401 unauthorized') &&
      (lower.includes('api.openai.com') ||
        lower.includes('responses_websocket') ||
        lower.includes('codex_api::endpoint'))) ||
    /^connection closed by .+ port \d+$/i.test(trimmed) ||
    /^banner exchange:\s*connection to unknown port -1:\s*connection refused$/i.test(trimmed) ||
    /^banner exchange:/i.test(trimmed) ||
    /^connection timed out during banner exchange/i.test(trimmed) ||
    /^connection to .+ port \d+ timed out$/i.test(trimmed) ||
    /^read from remote host .+: unknown error$/i.test(trimmed) ||
    /^getsockname failed: not a socket$/i.test(trimmed) ||
    /^codex exited with code 255$/i.test(trimmed) ||
    lower.includes('remote ssh worker ended with code') ||
    lower.includes('connection to unknown port -1') ||
    lower.includes('kex_exchange_identification: read: connection reset') ||
    lower.includes('timed out during banner exchange')
  );
}

function stripHiddenCodexLifecycleText(text: string): string {
  return text
    .replace(/Reading additional input from stdin\.\.\./gi, '')
    .replace(/\[Codex\]\s*turn started\b/gi, '')
    .replace(/\[Codex\]\s*turn complete(?:d)?\b/gi, '')
    .replace(/\[Codex\]\s*completed[^\r\n]*/gi, '')
    .replace(/[ \t]{2,}/g, ' ');
}

function normalizeCodexEventBoundaries(text: string): string {
  return text
    .replace(/([^\r\n])(\[Codex\])/gi, '$1\n$2')
    .replace(
      /(\[Codex\]\s*started command execution:\s*\/bin\/bash\s+-lc\s+'(?:[^'\\]|\\.)*')(?=[^\r\n\[])/giu,
      '$1\n',
    );
}

function stripHiddenCodexImagePayload(text: string): string {
  const withoutTransportBlock = normalizeOutput(text)
    .replace(
      /\[Remote Codex\]\n(?:banner exchange:\s*Connection to UNKNOWN port -1:\s*Connection refused|Connection closed by .+ port \d+|Connection timed out during banner exchange[^\n]*|Connection to .+ port \d+ timed out|Read from remote host .+: Unknown error|getsockname failed: Not a Socket|kex_exchange_identification: read: Connection reset[^\n]*)/gi,
      '',
    );
  return normalizeCodexEventBoundaries(stripHiddenCodexLifecycleText(withoutTransportBlock))
    .split('\n')
    .map((line) => normalizeCodexEventBoundaries(stripHiddenCodexLifecycleText(line)).trimEnd())
    .filter(
      (line) =>
        !isHiddenCodexImagePayloadLine(line) &&
        !isHiddenCodexControlLine(line) &&
        !isHiddenRemoteCodexTransportLine(line) &&
        !isHiddenLocalCodexLine(line),
    )
    .join('\n')
    .trimEnd();
}

function formatPromptForTranscript(prompt: string, images: CodexImagePayload[] | CodexImageAttachment[]): string {
  return `${prompt.trim() || '請根據附上的圖片進行協助。'}${imageSummary(images)}`.trim();
}

function serializeSendPayload(payload: SendPayload): string {
  return payload.attachments?.length || payload.remotePath || payload.model || payload.reasoningEffort
    ? JSON.stringify(payload)
    : payload.prompt;
}

function replaceImageExtension(name: string, extension: string): string {
  const cleanName = name.trim() || `image-${Date.now()}`;
  return /\.[A-Za-z0-9]+$/.test(cleanName)
    ? cleanName.replace(/\.[A-Za-z0-9]+$/, extension)
    : `${cleanName}${extension}`;
}

function imageBlobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('圖片讀取失敗'));
    reader.readAsDataURL(blob);
  });
}

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('圖片解析失敗'));
    image.src = url;
  });
}

async function resizeImageForCodex(file: File): Promise<{ blob: Blob; name: string; type: string }> {
  const type = file.type || 'image/png';
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) {
    return { blob: file, name: file.name || `image-${Date.now()}.png`, type };
  }

  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = await loadImageElement(sourceUrl);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    const longest = Math.max(width, height);
    if (!width || !height || longest <= MAX_IMAGE_DIMENSION) {
      return { blob: file, name: file.name || `image-${Date.now()}.png`, type };
    }

    const scale = MAX_IMAGE_DIMENSION / longest;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) return { blob: file, name: file.name || `image-${Date.now()}.png`, type };
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const pngBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (pngBlob && pngBlob.size <= MAX_IMAGE_BYTES && pngBlob.size < file.size) {
      return {
        blob: pngBlob,
        name: replaceImageExtension(file.name || `image-${Date.now()}`, '.png'),
        type: 'image/png',
      };
    }

    const jpegBlob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.9),
    );
    if (jpegBlob && jpegBlob.size <= Math.max(file.size, MAX_IMAGE_BYTES)) {
      return {
        blob: jpegBlob,
        name: replaceImageExtension(file.name || `image-${Date.now()}`, '.jpg'),
        type: 'image/jpeg',
      };
    }

    return { blob: pngBlob || file, name: file.name || `image-${Date.now()}.png`, type: pngBlob?.type || type };
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

async function readImageAttachment(file: File): Promise<CodexImageAttachment> {
  const optimized = await resizeImageForCodex(file);
  if (optimized.blob.size > MAX_IMAGE_BYTES) {
    throw new Error(`${file.name} 壓縮後仍超過 ${formatBytes(MAX_IMAGE_BYTES)}，請裁切後再貼上。`);
  }
  const dataUrl = await imageBlobToDataUrl(optimized.blob);
  const marker = ';base64,';
  const markerIndex = dataUrl.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`${file.name} 不是可讀取的圖片格式`);
  }
  return {
    id: `img:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    name: optimized.name,
    type: optimized.type || 'image/png',
    size: optimized.blob.size,
    dataBase64: dataUrl.slice(markerIndex + marker.length),
    previewUrl: URL.createObjectURL(optimized.blob),
  };
}

function trimOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_LENGTH) return output;
  return `[CozyPad] remote codex output truncated\r\n${output.slice(-MAX_OUTPUT_LENGTH)}`;
}

function normalizeOutput(output: string): string {
  return String(output || '')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\r/g, '\n');
}

function normalizeTaskStatus(value: unknown, fallback: CodexTaskStatus = 'completed'): CodexTaskStatus {
  return value === 'completed' || value === 'running' || value === 'failed'
    ? value
    : fallback;
}

function hasFatalCodexStatus(text: string): boolean {
  return normalizeOutput(text)
    .split('\n')
    .some((line) => {
      const lower = line.trim().toLowerCase();
      if (!lower) return false;
      return (
        lower.startsWith('[cozypad] remote codex failed') ||
        lower.startsWith('[cozypad] codex failed') ||
        (lower.startsWith('[cozypad local codex]') && lower.includes('failed')) ||
        lower.includes('codex history not found') ||
        lower.includes('codex prompt is empty') ||
        lower.includes('permission denied (publickey,password)') ||
        lower.includes('host key verification failed') ||
        lower.includes('connection timed out') ||
        lower.includes('connection reset') ||
        lower.includes('paused after a transport') ||
        lower.includes('will not auto-retry') ||
        lower.includes('getsockname failed') ||
        lower.includes('not a socket') ||
        lower.includes('remote codex cli not found') ||
        lower.includes('codex cli not found') ||
        lower.includes('codex openai login is invalid') ||
        lower.includes('401 unauthorized') ||
        lower.includes('spawn eperm')
      );
    });
}

function codexTaskDedupeKey(task: CodexTask): string {
  return [
    task.title.trim(),
    task.prompt.trim(),
    task.profileId,
    task.serverTarget,
    task.remotePath,
    task.model,
    task.reasoningEffort,
  ].join('\u001f');
}

function dedupeCodexTasks(tasks: CodexTask[]): CodexTask[] {
  const seen = new Set<string>();
  return tasks.filter((task) => {
    const key = codexTaskDedupeKey(task);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isResearchOnlyCodexTask(task: Pick<CodexTask, 'id' | 'title' | 'prompt'>): boolean {
  const id = task.id.trim().toLowerCase();
  const title = task.title.trim().toLowerCase();
  const prompt = task.prompt.trim().toLowerCase();
  return (
    id.startsWith('research-codex:') ||
    title === 'research diagram draw' ||
    title === 'default analysis diagram' ||
    title === 'mix analysis diagram' ||
    prompt.startsWith('you are a json-only diagram generator for cozypad.') ||
    prompt.startsWith('you are analyzing a cozypad research flowchart.') ||
    prompt.startsWith('you are generating md.mix markdown files from a cozypad research flowchart.')
  );
}

function readStoredTasks(): CodexTask[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    const tasks = parsed
      .filter((task) => task && typeof task.id === 'string')
      .map((task) => {
        const status = normalizeTaskStatus(task.status, task.running ? 'running' : 'completed');
        return {
          id: String(task.id),
          title: String(task.title || 'Codex 工作'),
          prompt: String(task.prompt || ''),
          output: String(task.output || IDLE_OUTPUT).slice(-MAX_OUTPUT_LENGTH),
          status,
          running: status === 'running',
          connected: false,
          profileId: String(task.profileId || ''),
          profileName: String(task.profileName || '未綁 SSH'),
          serverTarget: String(task.serverTarget || ''),
          remotePath: String(task.remotePath || '~'),
          model: normalizeCodexModel(String(task.model || '')),
          reasoningEffort: normalizeCodexReasoningEffort(String(task.reasoningEffort || '')),
          historyId: String(task.historyId || ''),
          createdAt: String(task.createdAt || new Date().toISOString()),
          updatedAt: String(task.updatedAt || task.createdAt || new Date().toISOString()),
        };
      });
    return dedupeCodexTasks(tasks.filter((task) => !isResearchOnlyCodexTask(task))).slice(0, MAX_TASKS);
  } catch {
    return [];
  }
}

function writeStoredTasks(tasks: CodexTask[]): void {
  try {
    const serializable = dedupeCodexTasks(tasks.filter((task) => !isResearchOnlyCodexTask(task)))
      .slice(0, MAX_TASKS)
      .map((task) => ({
        ...task,
        connected: false,
        running: task.running,
        status: task.running ? 'running' : task.status,
        output: task.output.slice(-MAX_OUTPUT_LENGTH),
      }));
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
    window.dispatchEvent(new Event(RESEARCH_REFRESH_EVENT));
  } catch {
    // Codex task restore is best-effort browser state.
  }
}

function isCodexEventLine(line: string): boolean {
  return line.trim().toLowerCase().startsWith('[codex]');
}

function isHiddenCodexEventLine(line: string): boolean {
  const lower = line.trim().toLowerCase();
  return (
    lower.startsWith('[codex] turn started') ||
    lower.startsWith('[codex] turn complete') ||
    lower.startsWith('[codex] turn completed') ||
    lower.startsWith('[codex] completed ')
  );
}

function isCodexContentBoundary(line: string): boolean {
  const trimmed = line.trim();
  const lower = trimmed.toLowerCase();
  return (
    trimmed === USER_TRANSCRIPT_MARKER ||
    trimmed === CODEX_TRANSCRIPT_MARKER ||
    lower === 'user' ||
    lower === 'codex' ||
    lower === 'assistant' ||
    trimmed.startsWith('[CozyPad Local Codex]') ||
    trimmed.startsWith('[CozyPad]')
  );
}

function nextNonBlankLineIsCodexEvent(lines: string[], startIndex: number): boolean {
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!line.trim()) continue;
    return isCodexEventLine(line) && !isHiddenCodexEventLine(line);
  }
  return false;
}

function getLineClass(line: string): string {
  const trimmed = line.trim();
  const lower = trimmed.toLowerCase();

  if (!trimmed) return 'legacy-codex-line legacy-codex-blank';
  if (trimmed.startsWith('[CozyPad Local Codex]') || trimmed.startsWith('[CozyPad]')) {
    if (lower.includes('error') || lower.includes('failed') || lower.includes('denied')) {
      return 'legacy-codex-line legacy-codex-error';
    }
    if (lower.includes('ready') || lower.includes('exited')) {
      return 'legacy-codex-line legacy-codex-complete';
    }
    return 'legacy-codex-line legacy-codex-local';
  }
  if (isCodexEventLine(trimmed)) {
    if (lower.includes('error') || lower.includes('failed') || lower.includes('denied')) {
      return 'legacy-codex-line legacy-codex-error';
    }
    if (lower.includes('started') || lower.includes('completed') || lower.includes('turn ')) {
      return 'legacy-codex-line legacy-codex-meta';
    }
    return 'legacy-codex-line legacy-codex-meta';
  }
  if (
    lower.includes('error') ||
    lower.includes('failed') ||
    lower.includes('denied') ||
    lower.includes('exit code:')
  ) {
    return 'legacy-codex-line legacy-codex-error';
  }
  if (lower.startsWith('exec') || lower.startsWith('tool:') || lower.includes(' in c:\\')) {
    return 'legacy-codex-line legacy-codex-exec';
  }
  if (lower.startsWith('tokens used') || /^\d{4}-\d{2}-\d{2}t/i.test(trimmed)) {
    return 'legacy-codex-line legacy-codex-meta';
  }
  return 'legacy-codex-line legacy-codex-assistant';
}

function isHiddenLocalCodexLine(line: string): boolean {
  const lower = line.trim().toLowerCase();
  if (isHiddenCodexImagePayloadLine(line)) return true;
  const isLocalStatus = lower.startsWith('[cozypad local codex]');
  const isRemoteStatus = lower.startsWith('[cozypad]');
  const isImportant =
    lower.includes('error') ||
    lower.includes('failed') ||
    lower.includes('denied') ||
    lower.includes('not found') ||
    lower.includes('eno');

  if ((isLocalStatus || isRemoteStatus) && !isImportant) {
    return (
      lower.includes('bound to ssh server') ||
      lower.includes('ssh server 已綁定') ||
      lower.includes('connected ') ||
      lower.includes('spawn ') ||
      lower.includes('opening ') ||
      lower.includes('queued follow-up') ||
      lower.includes('running queued follow-up') ||
      lower.includes('codex is still running') ||
      lower.includes('codex attached') ||
      lower.includes('remote codex')
    );
  }

  return (
    lower === '[cozypad local codex] ready' ||
    lower === '[cozypad] codex ready' ||
    /^\[cozypad local codex\] exited with code\b/.test(lower) ||
    /^\[cozypad\] codex exited with code(?: 0| 64)?$/.test(lower)
  );
}

function isLocalConnectionCommandSection(text: string): boolean {
  const lower = normalizeOutput(text).toLowerCase().replace(/\s+/g, ' ');
  const hasLocalShell =
    lower.includes('windowspowershell') ||
    lower.includes('powershell.exe') ||
    lower.includes('cmd.exe') ||
    lower.includes('c:\\windows\\system32');
  const looksLikeWrapper =
    lower.includes(' -command ') ||
    lower.includes('cozypad-ssh') ||
    lower.includes('local-codex') ||
    lower.includes(' in c:\\') ||
    lower.includes('c:\\users\\');
  return hasLocalShell && looksLikeWrapper;
}

function createProfileBinding(
  profile: ConnectionProfile | null,
  connected: boolean,
  remotePath: string,
): LegacyCodexBinding | null {
  if (!connected || profile === null || profile.id === 'mock-local' || profile.host === 'mock.local') {
    return null;
  }

  return {
    id: profile.id,
    source: 'local',
    name: profile.name,
    host: profile.host,
    user: profile.username,
    port: profile.port,
    defaultPath: remotePath.trim() || '~',
  };
}

function workflowToTask(workflow: LegacyCodexWorkflow): CodexTask {
  const status = normalizeTaskStatus(workflow.status, workflow.running ? 'running' : 'completed');
  return {
    id: workflow.id,
    title: workflow.title || 'Codex 工作',
    prompt: workflow.prompt || '',
    output: workflow.output || IDLE_OUTPUT,
    status,
    running: status === 'running',
    connected: false,
    profileId: workflow.serverId || '',
    profileName: workflow.serverName || 'SSH server',
    serverTarget: workflow.serverTarget || '',
    remotePath: workflow.remotePath || '~',
    model: normalizeCodexModel(workflow.model || ''),
    reasoningEffort: normalizeCodexReasoningEffort(workflow.reasoningEffort || ''),
    historyId: workflow.historyId || '',
    createdAt: workflow.createdAt || new Date().toISOString(),
    updatedAt: workflow.updatedAt || workflow.createdAt || new Date().toISOString(),
  };
}

function taskToWorkflow(task: CodexTask, server: LegacySshServer): LegacyCodexWorkflow {
  return {
    id: task.id,
    title: task.title,
    serverId: server.id,
    serverName: server.name,
    serverTarget: task.serverTarget || '',
    remotePath: task.remotePath || server.defaultPath || '~',
    mode: 'server',
    prompt: task.prompt,
    output: task.output,
    model: normalizeCodexModel(task.model || ''),
    reasoningEffort: normalizeCodexReasoningEffort(task.reasoningEffort || ''),
    status: task.status,
    running: task.running,
    connected: false,
    historyId: task.historyId || '',
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function taskContext(task: CodexTask): string {
  const transcript = normalizeOutput(task.output).trim();
  return [
    `Previous CozyPad Codex task: ${task.title}`,
    `- server: ${task.profileName || '未綁 SSH'}`,
    `- remote path: ${task.remotePath || '~'}`,
    '',
    'Use this previous transcript as context before answering the new request:',
    transcript || 'No previous transcript was saved.',
  ].join('\n');
}

function normalizeComparableText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function cleanUserMessage(text: string): string {
  const requestMarker = 'User request:';
  const possiblePayload = text.trim().replace(/^[^{]*(?=\{)/, '').trim();
  try {
    const parsed = JSON.parse(possiblePayload);
    if (parsed && typeof parsed === 'object' && typeof parsed.prompt === 'string') {
      const images = Array.isArray(parsed.attachments)
        ? parsed.attachments.map((item: Partial<CodexImagePayload>, index: number) => ({
            name: String(item.name || `image-${index + 1}.png`),
            type: String(item.type || 'image/*'),
            size: Number(item.size) || 0,
            dataBase64: '',
          }))
        : [];
      return formatPromptForTranscript(parsed.prompt, images).trim();
    }
  } catch {
    // Plain text prompt.
  }
  let cleanText = text.trim().replace(/^[>›]\s*/, '').trim();
  cleanText = stripHiddenCodexImagePayload(cleanText);
  const requestIndex = cleanText.lastIndexOf(requestMarker);
  if (requestIndex >= 0) {
    cleanText = cleanText.slice(requestIndex + requestMarker.length).trim();
  }
  return cleanText;
}

function appendDialogueBlock(
  blocks: CodexDialogueBlock[],
  role: CodexDialogueRole,
  text: string,
): void {
  const cleanText = role === 'user' ? cleanUserMessage(text) : stripHiddenCodexImagePayload(text);
  if (!cleanText.trim()) return;

  const previous = blocks[blocks.length - 1];
  if (previous?.role === role) {
    if (normalizeComparableText(previous.text) === normalizeComparableText(cleanText)) return;
    previous.text = `${previous.text}\n${cleanText}`.trimEnd();
    return;
  }

  blocks.push({ role, text: cleanText });
}

function outputHasUserSegment(lines: string[]): boolean {
  return lines.some((line) => {
    const trimmed = line.trim();
    const lower = trimmed.toLowerCase();
    return (
      trimmed === USER_TRANSCRIPT_MARKER ||
      lower === 'user' ||
      trimmed.startsWith('>') ||
      trimmed.startsWith('›') ||
      trimmed.includes('User request:')
    );
  });
}

function hasEquivalentUserBlock(blocks: CodexDialogueBlock[], text: string): boolean {
  const normalized = normalizeComparableText(cleanUserMessage(text));
  if (!normalized) return false;
  return blocks.some(
    (block) =>
      block.role === 'user' && normalizeComparableText(cleanUserMessage(block.text)) === normalized,
  );
}

function parseCodexDialogue(task: CodexTask): CodexDialogueBlock[] {
  const blocks: CodexDialogueBlock[] = [];
  const output = normalizeOutput(task.output).trimEnd();
  const lines = output ? output.split('\n') : [];

  if (task.prompt.trim() && !outputHasUserSegment(lines)) {
    appendDialogueBlock(blocks, 'user', task.prompt);
  }

  let role: CodexDialogueRole = 'codex';
  let buffer: string[] = [];
  const flush = () => {
    appendDialogueBlock(blocks, role, buffer.join('\n'));
    buffer = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const lower = trimmed.toLowerCase();

    if (trimmed === USER_TRANSCRIPT_MARKER || lower === 'user') {
      flush();
      role = 'user';
      continue;
    }

    if (trimmed === CODEX_TRANSCRIPT_MARKER || lower === 'codex' || lower === 'assistant') {
      flush();
      role = 'codex';
      continue;
    }

    const inlinePrompt = trimmed.match(/^[>›]\s*(.+)$/);
    if (inlinePrompt) {
      flush();
      const echoedPrompt = inlinePrompt[1] || '';
      if (!hasEquivalentUserBlock(blocks, echoedPrompt)) {
        appendDialogueBlock(blocks, 'user', echoedPrompt);
      }
      role = 'codex';
      continue;
    }

    if (lower === 'exec' && role === 'user') {
      flush();
      role = 'codex';
    }

    buffer.push(line);
  }

  flush();
  return blocks;
}

type OpenFilesPathHandler = (target: { serverId: string; path: string }) => void;

function openFilesPathFromLink(
  event: React.MouseEvent<HTMLButtonElement>,
  serverId: string,
  path: string,
  onOpenFilesPath?: OpenFilesPathHandler,
) {
  event.preventDefault();
  event.stopPropagation();
  if (onOpenFilesPath) {
    onOpenFilesPath({ serverId, path });
    return;
  }
  dispatchOpenFilePath(serverId, path);
}

function renderFilePathAnchor(
  path: string,
  serverId: string,
  key?: string,
  onOpenFilesPath?: OpenFilesPathHandler,
) {
  return (
    <button
      type="button"
      className="legacy-codex-path-link"
      key={key ?? path}
      {...filePathLinkDataset(serverId, path)}
      onClick={(event) => openFilesPathFromLink(event, serverId, path, onOpenFilesPath)}
      title="在 File 中開啟這個路徑"
    >
      {path}
    </button>
  );
}

function renderDialogueText(
  block: CodexDialogueBlock,
  serverId = '',
  onOpenFilesPath?: OpenFilesPathHandler,
) {
  return normalizeOutput(block.text)
    .split('\n')
    .map((line, index) => (
      <span
        className={block.role === 'codex' ? getLineClass(line) : 'legacy-codex-line'}
        key={`${index}-${line.slice(0, 20)}`}
      >
        {renderInlinePathLinks(line, serverId, onOpenFilesPath)}
      </span>
    ));
}

function textLineCount(text: string): number {
  return normalizeOutput(text).split('\n').length;
}

function pushSection(sections: CodexContentSection[], section: CodexContentSection): void {
  if (!section.text.trim()) return;
  const previous = sections[sections.length - 1];
  if (previous?.kind === section.kind && section.kind === 'text') {
    previous.text = `${previous.text}\n${section.text}`.trimEnd();
    return;
  }
  if (
    previous?.kind === 'meta' &&
    section.kind === 'meta' &&
    isCodexEventSection(previous) &&
    isCodexEventSection(section)
  ) {
    previous.text = `${previous.text}\n${section.text}`.trimEnd();
    previous.title = summarizeOneLine(previous.text, 'Codex event');
    return;
  }
  sections.push(section);
}

function isCodexEventSection(section: CodexContentSection): boolean {
  return section.kind === 'meta' && normalizeOutput(section.text).split('\n').some(isCodexEventLine);
}

function summarizeOneLine(text: string, fallback: string): string {
  return (
    normalizeOutput(text)
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean)
      ?.slice(0, 120) || fallback
  );
}

function sectionTitleFromCommand(text: string): string {
  const lines = normalizeOutput(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const commandLine = lines.find((line) => line !== 'exec' && !line.startsWith('202')) || lines[0] || '';
  if (commandLine.toLowerCase().startsWith('exec')) return 'Command';
  if (commandLine.length > 76) return `${commandLine.slice(0, 76)}...`;
  return commandLine || 'Command';
}

function sectionTitleFromCode(fenceLine: string): string {
  const language = fenceLine.replace(/^```/u, '').trim();
  return language ? `Code · ${language}` : 'Code';
}

function parseCodexContent(text: string): CodexContentSection[] {
  const sections: CodexContentSection[] = [];
  const lines = normalizeCodexEventBoundaries(stripHiddenCodexLifecycleText(normalizeOutput(text))).split('\n');
  let index = 0;
  let buffer: string[] = [];

  const flushText = () => {
    pushSection(sections, { kind: 'text', text: buffer.join('\n').trimEnd() });
    buffer = [];
  };

  while (index < lines.length) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    const lower = trimmed.toLowerCase();

    if (trimmed.startsWith('```')) {
      flushText();
      const codeLines = [line];
      const title = sectionTitleFromCode(trimmed);
      index += 1;
      while (index < lines.length) {
        const nextLine = lines[index] ?? '';
        codeLines.push(nextLine);
        index += 1;
        if (nextLine.trim().startsWith('```')) break;
      }
      pushSection(sections, { kind: 'code', title, text: codeLines.join('\n') });
      continue;
    }

    if (lower === 'exec' || lower.startsWith('exec ') || lower.startsWith('tool:')) {
      flushText();
      const toolLines = [line];
      index += 1;
      while (index < lines.length) {
        const nextLine = lines[index] ?? '';
        const nextTrimmed = nextLine.trim();
        const nextLower = nextTrimmed.toLowerCase();
        if (
          nextTrimmed === '' ||
          nextTrimmed === USER_TRANSCRIPT_MARKER ||
          nextTrimmed === CODEX_TRANSCRIPT_MARKER ||
          nextLower === 'user' ||
          nextLower === 'codex' ||
          nextLower === 'assistant'
        ) {
          break;
        }
        toolLines.push(nextLine);
        index += 1;
      }
      const toolText = toolLines.join('\n');
      if (!isLocalConnectionCommandSection(toolText)) {
        pushSection(sections, {
          kind: 'tool',
          title: sectionTitleFromCommand(toolText),
          text: toolText,
        });
      }
      continue;
    }

    if (lower.startsWith('diff --git') || trimmed.startsWith('@@')) {
      flushText();
      const diffLines = [line];
      index += 1;
      while (index < lines.length) {
        const nextLine = lines[index] ?? '';
        const nextTrimmed = nextLine.trim();
        if (
          nextTrimmed === '' ||
          nextTrimmed.startsWith('[CozyPad') ||
          nextTrimmed === USER_TRANSCRIPT_MARKER ||
          nextTrimmed === CODEX_TRANSCRIPT_MARKER
        ) {
          break;
        }
        diffLines.push(nextLine);
        index += 1;
      }
      pushSection(sections, {
        kind: 'diff',
        title: summarizeOneLine(diffLines[0] || '', 'Diff'),
        text: diffLines.join('\n'),
      });
      continue;
    }

    if (isHiddenCodexEventLine(line)) {
      index += 1;
      continue;
    }

    if (trimmed.startsWith('[CozyPad Local Codex]') || trimmed.startsWith('[CozyPad]')) {
      flushText();
      const statusLines = [line];
      index += 1;
      while (
        index < lines.length &&
        ((lines[index] ?? '').trim().startsWith('[CozyPad Local Codex]') ||
          (lines[index] ?? '').trim().startsWith('[CozyPad]'))
      ) {
        statusLines.push(lines[index] ?? '');
        index += 1;
      }
      const visibleStatusLines = statusLines.filter((statusLine) => !isHiddenLocalCodexLine(statusLine));
      if (visibleStatusLines.length === 0) {
        continue;
      }
      pushSection(sections, {
        kind: lower.includes('error') || lower.includes('failed') ? 'status' : 'meta',
        title: summarizeOneLine(visibleStatusLines.join('\n'), 'CozyPad status'),
        text: visibleStatusLines.join('\n'),
      });
      continue;
    }

    if (isCodexEventLine(line)) {
      flushText();
      const codexLines = [line];
      index += 1;
      while (index < lines.length) {
        const nextLine = lines[index] ?? '';
        const nextTrimmed = nextLine.trim();
        if (isCodexEventLine(nextLine)) {
          if (isHiddenCodexEventLine(nextLine)) {
            index += 1;
            continue;
          }
          codexLines.push(nextLine);
          index += 1;
          continue;
        }
        if (!nextTrimmed) {
          if (nextNonBlankLineIsCodexEvent(lines, index + 1)) {
            codexLines.push(nextLine);
            index += 1;
            continue;
          }
          break;
        }
        if (isCodexContentBoundary(nextLine)) {
          break;
        }
        if (
          nextTrimmed.startsWith('```') ||
          nextTrimmed.startsWith('@@') ||
          nextTrimmed.toLowerCase().startsWith('diff --git') ||
          nextTrimmed.toLowerCase() === 'exec' ||
          nextTrimmed.toLowerCase().startsWith('exec ') ||
          nextTrimmed.toLowerCase().startsWith('tool:')
        ) {
          codexLines.push(nextLine);
          index += 1;
          continue;
        }
        codexLines.push(nextLine);
        index += 1;
      }
      const codexText = codexLines
        .filter((codexLine, lineIndex, allLines) => {
          if (isHiddenCodexEventLine(codexLine)) return false;
          if (codexLine.trim()) return true;
          const previousLine = allLines[lineIndex - 1] ?? '';
          const nextLine = allLines[lineIndex + 1] ?? '';
          return (
            isCodexEventLine(previousLine) &&
            !isHiddenCodexEventLine(previousLine) &&
            isCodexEventLine(nextLine) &&
            !isHiddenCodexEventLine(nextLine)
          );
        })
        .join('\n');
      pushSection(sections, {
        kind: 'meta',
        title: summarizeOneLine(codexText, 'Codex event'),
        text: codexText,
      });
      continue;
    }
    if (
      lower.startsWith('tokens used') ||
      lower.startsWith('wall time:') ||
      lower.startsWith('output:') ||
      /^\d{4}-\d{2}-\d{2}t/i.test(trimmed)
    ) {
      flushText();
      const metaLines = [line];
      index += 1;
      while (index < lines.length) {
        const nextLine = lines[index] ?? '';
        const nextLower = nextLine.trim().toLowerCase();
        if (
          nextLine.trim() === '' ||
          nextLower.startsWith('tokens used') ||
          nextLower.startsWith('wall time:') ||
          nextLower.startsWith('output:') ||
          /^\d{4}-\d{2}-\d{2}t/i.test(nextLine.trim())
        ) {
          metaLines.push(nextLine);
          index += 1;
          continue;
        }
        break;
      }
      pushSection(sections, {
        kind: 'meta',
        title: summarizeOneLine(metaLines.join('\n'), 'Metadata'),
        text: metaLines.join('\n'),
      });
      continue;
    }

    buffer.push(line);
    index += 1;
  }

  flushText();
  return sections;
}

function renderInlinePathLinks(
  line: string,
  serverId: string,
  onOpenFilesPath?: OpenFilesPathHandler,
) {
  if (!serverId.trim() || !line.trim()) return line || ' ';

  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  for (const match of line.matchAll(INLINE_REMOTE_PATH_PATTERN)) {
    const rawPath = match[0];
    const index = match.index ?? 0;
    if (index > lastIndex) nodes.push(line.slice(lastIndex, index));

    const trailing = rawPath.match(TRAILING_INLINE_PATH_PUNCTUATION)?.[0] || '';
    const path = trailing ? rawPath.slice(0, -trailing.length) : rawPath;
    if (!path || path === '/') {
      nodes.push(rawPath);
    } else {
      nodes.push(renderFilePathAnchor(path, serverId, `${index}-${path}`, onOpenFilesPath));
      if (trailing) nodes.push(trailing);
    }
    lastIndex = index + rawPath.length;
  }

  if (lastIndex < line.length) nodes.push(line.slice(lastIndex));
  return nodes.length > 0 ? nodes : line || ' ';
}

function renderPreLines(
  text: string,
  codexColors = true,
  serverId = '',
  onOpenFilesPath?: OpenFilesPathHandler,
) {
  return normalizeOutput(text)
    .split('\n')
    .map((line, index) => (
      <span
        className={codexColors ? getLineClass(line) : 'legacy-codex-line'}
        key={`${index}-${line.slice(0, 20)}`}
      >
        {renderInlinePathLinks(line, serverId, onOpenFilesPath)}
      </span>
    ));
}

function renderMarkdownText(
  text: string,
  className = '',
  key?: string,
  serverId = '',
  onOpenFilesPath?: OpenFilesPathHandler,
) {
  return (
    <div className={`markdown legacy-codex-markdown${className ? ` ${className}` : ''}`} key={key}>
      <Markdown
        components={
          onOpenFilesPath
            ? createMarkdownComponents(onOpenFilesPath, { serverId })
            : createMarkdownComponents(undefined, { serverId })
        }
        remarkPlugins={markdownRemarkPlugins}
        rehypePlugins={markdownRehypePlugins}
      >
        {normalizeMarkdownMath(linkifyRemotePathLines(normalizeOutput(text), serverId))}
      </Markdown>
      <AgentImagePreviewStrip
        onOpenFilesPath={onOpenFilesPath}
        serverId={serverId}
        text={normalizeOutput(text)}
      />
    </div>
  );
}

function parseUserPromptAttachments(text: string): {
  prompt: string;
  attachments: { name: string; type: string; size: string }[];
} {
  const lines = normalizeOutput(text).split('\n');
  const markerIndex = lines.findIndex((line) => line.trim() === '[Attached images]');
  if (markerIndex < 0) {
    return { prompt: normalizeOutput(text).trimEnd(), attachments: [] };
  }

  const prompt = lines.slice(0, markerIndex).join('\n').trimEnd();
  const attachments = lines
    .slice(markerIndex + 1)
    .map((line) => {
      const match = line.trim().match(/^-\s*\d+\.\s*(.+?)\s*\((.+?),\s*([^)]+)\)\s*$/);
      if (!match) return null;
      return {
        name: match[1] || 'image',
        type: match[2] || 'image/*',
        size: match[3] || '',
      };
    })
    .filter((item): item is { name: string; type: string; size: string } => item !== null);

  return { prompt, attachments };
}

function renderUserMessageBody(
  text: string,
  serverId = '',
  onOpenFilesPath?: OpenFilesPathHandler,
) {
  const { prompt, attachments } = parseUserPromptAttachments(text);
  return (
    <div className="legacy-codex-message-body legacy-codex-user-body">
      {prompt
        ? renderMarkdownText(prompt, 'legacy-codex-user-markdown', undefined, serverId, onOpenFilesPath)
        : null}
      {attachments.length > 0 ? (
        <div className="legacy-codex-user-attachments" aria-label="attached images">
          {attachments.map((attachment, index) => (
            <span className="legacy-codex-user-attachment" key={`${attachment.name}-${index}`}>
              <span className="legacy-codex-user-attachment-icon" />
              <span>{attachment.name}</span>
              <small>
                {attachment.type}
                {attachment.size ? ` · ${attachment.size}` : ''}
              </small>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function renderCollapsibleSection(
  section: CodexContentSection,
  index: number,
  serverId = '',
  onOpenFilesPath?: OpenFilesPathHandler,
) {
  const lines = textLineCount(section.text);
  const lowerText = normalizeOutput(section.text).toLowerCase();
  const codexEvent = isCodexEventSection(section);
  const kindLabel = codexEvent
    ? 'Codex'
    : section.kind === 'tool'
      ? 'Tool'
      : section.kind === 'diff'
        ? 'Diff'
        : section.kind === 'status'
          ? 'Status'
          : section.kind === 'code'
            ? 'Code'
            : 'Meta';
  const openByDefault =
    section.kind === 'status' &&
    (lowerText.includes('error') ||
      lowerText.includes('failed') ||
      lowerText.includes('denied') ||
      lowerText.includes('not found') ||
      lowerText.includes('connection reset'));
  return (
    <details
      className={`legacy-codex-card legacy-codex-card-${section.kind}${
        codexEvent ? ' legacy-codex-card-event' : ''
      }`}
      key={`${section.kind}-${index}-${section.title}`}
      open={openByDefault}
    >
      <summary>
        <span className="legacy-codex-card-chevron" aria-hidden="true" />
        <span className="legacy-codex-card-dot" />
        <span className="legacy-codex-card-badge">{kindLabel}</span>
        <span className="legacy-codex-card-title">{section.title}</span>
        <span className="legacy-codex-card-lines">{lines} lines</span>
      </summary>
      <pre>{renderPreLines(section.text, true, serverId, onOpenFilesPath)}</pre>
      <AgentImagePreviewStrip
        maxImages={8}
        onOpenFilesPath={onOpenFilesPath}
        serverId={serverId}
        text={section.text}
      />
    </details>
  );
}

function renderCodexRichContent(
  text: string,
  serverId = '',
  onOpenFilesPath?: OpenFilesPathHandler,
) {
  return parseCodexContent(text).map((section, index) => {
    if (section.kind === 'text' || section.kind === 'code') {
      return renderMarkdownText(
        section.text,
        'legacy-codex-inline-text',
        `text-${index}`,
        serverId,
        onOpenFilesPath,
      );
    }

    return renderCollapsibleSection(section, index, serverId, onOpenFilesPath);
  });
}

function isPlainCodexText(text: string): boolean {
  const sections = parseCodexContent(text);
  return sections.length > 0 && sections.every((section) => section.kind === 'text' || section.kind === 'code');
}

function hasCodexFeedbackAfterLatestPrompt(output: string): boolean {
  const normalized = normalizeOutput(output);
  const index = normalized.lastIndexOf(CODEX_TRANSCRIPT_MARKER);
  if (index === -1) return normalized.trim().length > 0;
  return normalized.slice(index + CODEX_TRANSCRIPT_MARKER.length).trim().length > 0;
}

function renderDialogue(
  task: CodexTask,
  serverId = '',
  onOpenFilesPath?: OpenFilesPathHandler,
  onEditUserPrompt?: (text: string) => void,
) {
  return parseCodexDialogue(task).map((block, index) => {
    const plainCodexText = block.role === 'codex' && isPlainCodexText(block.text);
    return (
      <div
        className={`legacy-codex-message legacy-codex-message-${block.role}${
          plainCodexText ? ' legacy-codex-message-plain' : ''
        }`}
        key={`${block.role}-${index}-${block.text.slice(0, 16)}`}
        onContextMenu={(event) => {
          if (block.role !== 'user' || !onEditUserPrompt) return;
          event.preventDefault();
          event.stopPropagation();
          onEditUserPrompt(block.text);
        }}
      >
        <span className="legacy-codex-message-label">
          {block.role === 'user' ? 'User' : block.role === 'codex' ? 'Codex' : 'System'}
        </span>
        {block.role === 'codex' ? (
          plainCodexText ? (
            renderMarkdownText(block.text, '', undefined, serverId, onOpenFilesPath)
          ) : (
            <div className="legacy-codex-message-body legacy-codex-message-rich">
              {renderCodexRichContent(block.text, serverId, onOpenFilesPath)}
            </div>
          )
        ) : block.role === 'user' ? (
          renderUserMessageBody(block.text, serverId, onOpenFilesPath)
        ) : (
          <pre className="legacy-codex-message-body">
            {renderDialogueText(block, serverId, onOpenFilesPath)}
          </pre>
        )}
      </div>
    );
  });
}

export function LegacyCodexPanel({
  selectedProfile,
  connected,
  legacyServer,
  focusTaskId = '',
  focusRequestNonce = 0,
  onOpenFilesPath,
}: {
  selectedProfile: ConnectionProfile | null;
  connected: boolean;
  legacyServer: LegacySshServer | null;
  focusTaskId?: string;
  focusRequestNonce?: number;
  onOpenFilesPath?: (target: { serverId: string; path: string }) => void;
}) {
  const [helperError, setHelperError] = useState('');
  const [tasks, setTasks] = useState<CodexTask[]>(() => readStoredTasks());
  const [activeTaskId, setActiveTaskId] = useState(() => readStoredTasks()[0]?.id ?? '');
  const [remotePath, setRemotePath] = useState('~');
  const [cwdInput, setCwdInput] = useState('~');
  const [composerText, setComposerText] = useState(() => readStoredComposerDraft());
  const [imageAttachments, setImageAttachments] = useState<CodexImageAttachment[]>([]);
  const [creatingNewTask, setCreatingNewTask] = useState(false);
  const [taskFilter, setTaskFilter] = useState('');
  const [loadingWorkflows, setLoadingWorkflows] = useState(false);
  const [loadedWorkflowServerId, setLoadedWorkflowServerId] = useState('');
  const [codexStatus, setCodexStatus] = useState<LegacyCodexStatus | null>(null);
  const [checkingCodex, setCheckingCodex] = useState(false);
  const [codexCheckError, setCodexCheckError] = useState('');
  const [stoppingTaskId, setStoppingTaskId] = useState('');
  const [editingUserPrompt, setEditingUserPrompt] = useState('');
  const [codexModelInput, setCodexModelInput] = useState(() => readStoredCodexModel());
  const [codexReasoningEffort, setCodexReasoningEffort] = useState<LegacyCodexReasoningEffort>(
    () => readStoredCodexReasoningEffort(),
  );
  const socketsRef = useRef(new Map<string, WebSocket>());
  const queuedSocketPayloadsRef = useRef(new Map<string, SendPayload[]>());
  const reconnectTimersRef = useRef(new Map<string, number>());
  const reconnectAttemptsRef = useRef(new Map<string, number>());
  const manuallyClosedTaskIdsRef = useRef(new Set<string>());
  const nonReconnectTaskIdsRef = useRef(new Set<string>());
  const unmountedRef = useRef(false);
  const tasksRef = useRef(tasks);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialogueScrollRef = useRef<HTMLDivElement>(null);
  const imageAttachmentsRef = useRef<CodexImageAttachment[]>([]);
  const composerTextRef = useRef(composerText);
  const drainingTrainingQueueRef = useRef(false);

  const activeTask = useMemo(
    () => (creatingNewTask ? null : (tasks.find((task) => task.id === activeTaskId) ?? tasks[0] ?? null)),
    [activeTaskId, creatingNewTask, tasks],
  );
  const currentBinding = useMemo<LegacyCodexBinding | null>(() => {
    if (legacyServer) {
      return {
        ...legacyServer,
        apiBaseUrl: window.location.origin,
        defaultPath: remotePath.trim() || legacyServer.defaultPath || '~',
      };
    }
    return createProfileBinding(selectedProfile, connected, remotePath);
  }, [connected, legacyServer, remotePath, selectedProfile]);
  const codexReady = Boolean(legacyServer?.id);
  const localMode = isLocalLegacyServer(legacyServer);
  const codexRunOptions = useMemo(
    () => ({
      model: normalizeCodexModel(codexModelInput),
      reasoningEffort: normalizeCodexReasoningEffort(codexReasoningEffort),
    }),
    [codexModelInput, codexReasoningEffort],
  );
  const codexModelOptions = useMemo(
    () =>
      mergeCodexModelOptions(
        [codexStatus?.defaultModel, codexModelInput, activeTask?.model],
        codexStatus?.models,
        CODEX_MODEL_FALLBACKS,
      ),
    [activeTask?.model, codexModelInput, codexStatus?.defaultModel, codexStatus?.models],
  );
  const checkCodex = useCallback(() => {
    if (!legacyServer?.id) {
      setCodexStatus(null);
      setCodexCheckError('');
      return;
    }
    if (!connected) {
      setCodexStatus(null);
      setCodexCheckError('Press Connect before checking Codex.');
      return;
    }
    setCheckingCodex(true);
    setCodexCheckError('');
    void getLegacyCodexStatus(legacyServer.id)
      .then((status) => {
        setCodexStatus(status);
        setCodexCheckError(status.available ? '' : status.error || 'Codex CLI not found.');
      })
      .catch((error) => {
        setCodexStatus(null);
        setCodexCheckError(error instanceof Error ? error.message : 'Remote Codex check failed.');
      })
      .finally(() => setCheckingCodex(false));
  }, [connected, legacyServer?.id]);
  const visibleTasks = useMemo(
    () =>
      tasks.filter((task) =>
        taskFilter.trim()
          ? `${task.title} ${task.profileName} ${task.remotePath}`
              .toLowerCase()
              .includes(taskFilter.trim().toLowerCase())
          : true,
      ),
    [taskFilter, tasks],
  );

  useEffect(() => {
    setCwdInput(activeTask?.remotePath || remotePath || '~');
  }, [activeTask?.id, activeTask?.remotePath, remotePath]);

  useEffect(() => {
    setCodexStatus(null);
    setCodexCheckError('');
    setCheckingCodex(false);
  }, [connected, legacyServer?.id]);

  useEffect(() => {
    if (legacyServer?.defaultPath) {
      setRemotePath(legacyServer.defaultPath);
    }
  }, [legacyServer?.defaultPath, legacyServer?.id]);

  useEffect(() => {
    writeStoredTasks(tasks);
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    try {
      window.localStorage.setItem(CODEX_MODEL_STORAGE_KEY, codexRunOptions.model);
      window.localStorage.setItem(CODEX_EFFORT_STORAGE_KEY, codexRunOptions.reasoningEffort);
    } catch {
      // Browser storage is best effort.
    }
  }, [codexRunOptions.model, codexRunOptions.reasoningEffort]);

  useEffect(() => {
    imageAttachmentsRef.current = imageAttachments;
  }, [imageAttachments]);

  useEffect(() => {
    composerTextRef.current = composerText;
    writeStoredComposerDraft(composerText);
  }, [composerText]);

  useEffect(() => {
    let active = true;
    const serverId = legacyServer?.id || '';

    if (!connected || !serverId) {
      setLoadingWorkflows(false);
      setLoadedWorkflowServerId('');
      return () => {
        active = false;
      };
    }

    setLoadedWorkflowServerId('');
    setLoadingWorkflows(true);
    setHelperError('');
    void listLegacyCodexWorkflows(serverId)
      .then((workflows) => {
        if (!active) return;
        const restored = workflows
          .map(workflowToTask)
          .filter((task) => !isResearchOnlyCodexTask(task) && !isWorkRunDeleted(`codex:${task.id}`));
        setTasks(restored);
        setActiveTaskId(restored[0]?.id ?? '');
      })
      .catch((error) => {
        if (!active) return;
        setHelperError(error instanceof Error ? error.message : '遠端 Codex 工作紀錄載入失敗');
      })
      .finally(() => {
        if (active) {
          setLoadedWorkflowServerId(serverId);
          setLoadingWorkflows(false);
        }
      });

    return () => {
      active = false;
    };
  }, [connected, legacyServer?.id]);

  useEffect(() => {
    if (!legacyServer || loadingWorkflows) return;
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const serverTasks = tasks.filter((task) => task.profileId === legacyServer.id);
      for (const task of serverTasks) {
        void saveLegacyCodexWorkflow(taskToWorkflow(task, legacyServer)).catch((error) => {
          setHelperError(error instanceof Error ? error.message : '遠端 Codex 工作紀錄保存失敗');
        });
      }
      saveTimerRef.current = null;
    }, 900);

    return () => {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [legacyServer, loadingWorkflows, tasks]);

  useEffect(() => {
    if (creatingNewTask) return;
    if (activeTaskId && tasks.some((task) => task.id === activeTaskId)) return;
    setActiveTaskId(tasks[0]?.id ?? '');
  }, [activeTaskId, creatingNewTask, tasks]);

  useEffect(() => {
    if (!focusTaskId) return;
    const matchedTask = tasks.find((task) => task.id === focusTaskId);
    if (!matchedTask) return;
    setCreatingNewTask(false);
    setTaskFilter('');
    setActiveTaskId(matchedTask.id);
    setCwdInput(matchedTask.remotePath || '~');
  }, [focusRequestNonce, focusTaskId, tasks]);

  useEffect(() => {
    const element = dialogueScrollRef.current;
    if (!element) return;
    const frame = window.requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTask?.id, activeTask?.output, activeTask?.running, creatingNewTask]);

  useEffect(() => {
    return () => {
      unmountedRef.current = true;
      for (const socket of socketsRef.current.values()) {
        socket.close();
      }
      socketsRef.current.clear();
      for (const timer of reconnectTimersRef.current.values()) {
        clearTimeout(timer);
      }
      reconnectTimersRef.current.clear();
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
      for (const image of imageAttachmentsRef.current) {
        if (image.previewUrl) URL.revokeObjectURL(image.previewUrl);
      }
    };
  }, []);

  const updateTask = useCallback((taskId: string, updater: (task: CodexTask) => CodexTask) => {
    setTasks((current) =>
      current.map((task) => (task.id === taskId ? updater(task) : task)),
    );
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setTasks((current) => {
        let changed = false;
        const nextTasks = current.map((task) => {
          if (task.status !== 'running' || !task.running || hasCodexFeedbackAfterLatestPrompt(task.output)) {
            return task;
          }
          changed = true;
          return {
            ...task,
            output: trimOutput(`${task.output}\r\n${CODEX_STREAM_WAITING_TEXT}\r\n`),
            updatedAt: new Date().toISOString(),
          };
        });
        return changed ? nextTasks : current;
      });
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (connected) return;
    for (const socket of socketsRef.current.values()) {
      socket.close();
    }
    socketsRef.current.clear();
    for (const timer of reconnectTimersRef.current.values()) {
      clearTimeout(timer);
    }
    reconnectTimersRef.current.clear();
    reconnectAttemptsRef.current.clear();
    setTasks((current) =>
      current.map((task) => (task.connected ? { ...task, connected: false } : task)),
    );
  }, [connected]);

  const applyCwdInput = useCallback(() => {
    const nextPath = normalizeRemotePath(cwdInput);
    setCwdInput(nextPath);
    if (activeTask) {
      updateTask(activeTask.id, (task) => ({
        ...task,
        remotePath: nextPath,
        updatedAt: new Date().toISOString(),
      }));
      return;
    }
    setRemotePath(nextPath);
  }, [activeTask, cwdInput, updateTask]);

  const clearImageAttachments = useCallback(() => {
    setImageAttachments((current) => {
      for (const image of current) {
        if (image.previewUrl) URL.revokeObjectURL(image.previewUrl);
      }
      return [];
    });
  }, []);

  const removeImageAttachment = useCallback((imageId: string) => {
    setImageAttachments((current) => {
      const removed = current.find((image) => image.id === imageId);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((image) => image.id !== imageId);
    });
  }, []);

  const addImageFiles = useCallback(async (files: File[]) => {
    const imageFiles = files.filter((file) => file.type.startsWith('image/'));
    if (imageFiles.length === 0) {
      setHelperError('Codex 目前只接受圖片附件。');
      return;
    }

    const availableSlots = MAX_IMAGE_ATTACHMENTS - imageAttachmentsRef.current.length;
    if (availableSlots <= 0) {
      setHelperError(`一次最多附加 ${MAX_IMAGE_ATTACHMENTS} 張圖片。`);
      return;
    }

    try {
      const nextImages = await Promise.all(imageFiles.slice(0, availableSlots).map(readImageAttachment));
      setImageAttachments((current) => [...current, ...nextImages].slice(0, MAX_IMAGE_ATTACHMENTS));
      setHelperError('');
    } catch (error) {
      setHelperError(error instanceof Error ? error.message : '圖片讀取失敗');
    }
  }, []);

  const resolveBinding = useCallback(
    async (path: string): Promise<LegacyCodexBinding | null> => {
      const cleanPath = path.trim() || legacyServer?.defaultPath || '~';
      if (legacyServer) {
        const binding = await loadLegacyCodexBinding(legacyServer.id);
        return {
          ...binding,
          defaultPath: cleanPath,
        };
      }
      return createProfileBinding(selectedProfile, connected, cleanPath);
    },
    [connected, legacyServer, selectedProfile],
  );

  const connectTask = useCallback(
    (task: CodexTask, payload?: SendPayload) => {
      if (!connected) {
        setHelperError('Press Connect before opening Codex SSH sessions.');
        return;
      }
      if (!legacyServer?.id) {
        setHelperError('請先選擇 SSH server。');
        return;
      }
      if (!task.historyId) {
        setHelperError('這個 Codex 任務尚未建立遠端 history，請重新送出一次需求。');
        return;
      }
      manuallyClosedTaskIdsRef.current.delete(task.id);
      nonReconnectTaskIdsRef.current.delete(task.id);
      const reconnectTimer = reconnectTimersRef.current.get(task.id);
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimersRef.current.delete(task.id);
      }
      const existing = socketsRef.current.get(task.id);
      if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
        if (payload && existing.readyState === WebSocket.OPEN) {
          existing.send(serializeSendPayload(payload));
        } else if (payload) {
          const queue = queuedSocketPayloadsRef.current.get(task.id) ?? [];
          queue.push(payload);
          queuedSocketPayloadsRef.current.set(task.id, queue);
        }
        return;
      }
      existing?.close();

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = new URL(`${protocol}//${window.location.host}/api/codex/session`);
      url.searchParams.set('serverId', legacyServer.id);
      url.searchParams.set('remotePath', task.remotePath || legacyServer.defaultPath || '~');
      url.searchParams.set('taskId', task.id);
      url.searchParams.set('historyId', task.historyId);
      if (payload) url.searchParams.set('suppressReplay', '1');
      const socket = new WebSocket(url.toString());
      let pendingPayload = payload;
      socketsRef.current.set(task.id, socket);
      updateTask(task.id, (current) => ({ ...current, connected: false }));

      const scheduleReconnect = () => {
        if (!connected) return;
        if (
          unmountedRef.current ||
          manuallyClosedTaskIdsRef.current.has(task.id) ||
          nonReconnectTaskIdsRef.current.has(task.id)
        ) {
          return;
        }
        const latest = tasksRef.current.find((item) => item.id === task.id);
        if (!latest || !latest.historyId || latest.status !== 'running') return;
        if (hasFatalCodexStatus(latest.output)) {
          nonReconnectTaskIdsRef.current.add(task.id);
          updateTask(task.id, (current) => ({
            ...current,
            status: 'failed',
            running: false,
            connected: false,
            updatedAt: new Date().toISOString(),
          }));
          return;
        }
        if (reconnectTimersRef.current.has(task.id)) return;
        const attempts = reconnectAttemptsRef.current.get(task.id) ?? 0;
        if (attempts >= CODEX_WS_RECONNECT_MAX_ATTEMPTS) {
          manuallyClosedTaskIdsRef.current.add(task.id);
          setHelperError(
            `Codex stream auto-reconnect stopped after ${CODEX_WS_RECONNECT_MAX_ATTEMPTS} failed attempts to avoid repeated SSH attempts. Check the server/network, then reconnect manually.`,
          );
          updateTask(task.id, (current) => ({
            ...current,
            status: 'failed',
            running: false,
            connected: false,
            output: trimOutput(
              `${current.output}\n[CozyPad] Codex stream auto-reconnect stopped after ${CODEX_WS_RECONNECT_MAX_ATTEMPTS} failed attempts to avoid SSH IP lockout.\n`,
            ),
            updatedAt: new Date().toISOString(),
          }));
          return;
        }
        const delay = Math.min(
          CODEX_WS_RECONNECT_MAX_MS,
          CODEX_WS_RECONNECT_BASE_MS * Math.max(1, attempts + 1),
        );
        const timer = window.setTimeout(() => {
          reconnectTimersRef.current.delete(task.id);
          reconnectAttemptsRef.current.set(task.id, attempts + 1);
          const currentTask = tasksRef.current.find((item) => item.id === task.id);
          if (!currentTask || currentTask.status !== 'running') return;
          connectTask(currentTask, pendingPayload);
          pendingPayload = undefined;
        }, delay);
        reconnectTimersRef.current.set(task.id, timer);
      };

      socket.addEventListener('open', () => {
        reconnectAttemptsRef.current.delete(task.id);
        updateTask(task.id, (current) => ({ ...current, connected: true }));
        setHelperError((current) =>
          /websocket|串流|transport/i.test(current) ? '' : current,
        );
        const queuedPayloads = queuedSocketPayloadsRef.current.get(task.id) ?? [];
        queuedSocketPayloadsRef.current.delete(task.id);
        const payloadsToSend = [...(pendingPayload ? [pendingPayload] : []), ...queuedPayloads];
        pendingPayload = undefined;
        for (const payloadToSend of payloadsToSend) {
          socket.send(serializeSendPayload(payloadToSend));
        }
      });
      socket.addEventListener('message', (event) => {
        const text = String(event.data || '');
        const rawNormalized = normalizeOutput(text);
        const cwdUpdate = extractCodexCwdUpdate(text);
        const visibleText = stripHiddenCodexImagePayload(text);
        const done =
          rawNormalized.includes('[CozyPad] codex ready') ||
          rawNormalized.includes('[CozyPad Local Codex] ready') ||
          rawNormalized.includes('[CozyPad] remote codex ready');
        const failed = hasFatalCodexStatus(text);
        const runningSignal =
          rawNormalized.includes('queued follow-up') ||
          rawNormalized.includes('running queued follow-up') ||
          rawNormalized.includes('codex is still running');
        if (!visibleText.trim() && !done && !failed && !runningSignal && !cwdUpdate) return;
        if (done || failed) {
          nonReconnectTaskIdsRef.current.add(task.id);
        }
        updateTask(task.id, (current) => ({
          ...current,
          output: visibleText.trim() ? trimOutput(`${current.output}${visibleText}`) : current.output,
          remotePath: cwdUpdate || current.remotePath,
          status: failed
            ? 'failed'
            : done && current.status !== 'failed'
              ? 'completed'
              : runningSignal
                ? 'running'
                : current.status,
          running: failed || done ? false : runningSignal ? true : current.running,
          updatedAt: new Date().toISOString(),
        }));
      });
      socket.addEventListener('close', () => {
        if (socketsRef.current.get(task.id) !== socket) return;
        socketsRef.current.delete(task.id);
        updateTask(task.id, (current) => ({ ...current, connected: false }));
        scheduleReconnect();
      });
      socket.addEventListener('error', () => {
        if (socketsRef.current.get(task.id) !== socket) return;
        updateTask(task.id, (current) => ({
          ...current,
          connected: false,
          updatedAt: new Date().toISOString(),
        }));
        try {
          socket.close();
        } catch {
          // Browser WebSocket close can fail if the socket is already closed.
        }
      });
    },
    [connected, legacyServer, updateTask],
  );

  const connectExistingTask = async (task: CodexTask) => {
    if (task.status !== 'running') {
      return;
    }
    if (task.historyId) {
      connectTask(task);
      return;
    }
    if (!legacyServer) {
      setHelperError('請先選擇 SSH server。');
      return;
    }

    try {
      const history = await createLegacyCodexHistory(legacyServer.id, task.title || 'Codex 工作');
      const nextTask = { ...task, historyId: history.id };
      updateTask(task.id, (current) => ({ ...current, historyId: history.id }));
      connectTask(nextTask);
    } catch (error) {
      setHelperError(error instanceof Error ? error.message : '建立遠端 Codex history 失敗');
    }
  };

  useEffect(() => {
    if (!connected || !legacyServer?.id || loadingWorkflows) return;

    tasksRef.current
      .filter(
        (task) =>
          task.profileId === legacyServer.id &&
          task.status === 'running' &&
          task.historyId &&
          !socketsRef.current.has(task.id),
      )
      .forEach((task) => connectTask(task));
  }, [connectTask, connected, legacyServer?.id, loadingWorkflows]);

  const startTask = useCallback(async (
    promptText: string,
    images: CodexImageAttachment[] = [],
    options: StartTaskOptions = {},
  ) => {
    const prompt = promptText.trim() || (images.length > 0 ? '請根據附上的圖片進行協助。' : '');
    if (!prompt || !codexReady) return false;
    if (!legacyServer) {
      setHelperError('請先選擇 SSH server。');
      return false;
    }
    if (!connected) {
      setHelperError('Press Connect before checking or running Codex; no SSH starts while disconnected.');
      return false;
    }
    const cwdOnlyChange = images.length === 0 ? parseStandaloneCwdChangeRequest(prompt) : '';
    if (cwdOnlyChange) {
      setRemotePath(cwdOnlyChange);
      setCwdInput(cwdOnlyChange);
      setHelperError('');
      return true;
    }
    const now = new Date().toISOString();
    const attachmentPayload = payloadFromImages(images);
    const transcriptPrompt = formatPromptForTranscript(prompt, attachmentPayload);
    const title = options.title?.trim() || titleFromPrompt(prompt || images[0]?.name || '圖片任務');
    let historyId = '';
    try {
      const history = await createLegacyCodexHistory(legacyServer.id, title);
      historyId = history.id;
    } catch (error) {
      setHelperError(error instanceof Error ? error.message : '建立遠端 Codex history 失敗');
      return false;
    }
    const taskRemotePath = normalizeRemotePath(
      options.remotePath || cwdInput || remotePath || legacyServer.defaultPath || '~',
    );
    const task: CodexTask = {
      id: createTaskId(),
      title,
      prompt,
      output: `${USER_TRANSCRIPT_MARKER}\n${transcriptPrompt}\n${CODEX_TRANSCRIPT_MARKER}\n[CozyPad] codex started; opening stream\n`,
      status: 'running',
      running: true,
      connected: false,
      profileId: legacyServer.id,
      profileName: legacyServer.name,
      serverTarget: legacyServerTarget(legacyServer),
      remotePath: taskRemotePath,
      model: codexRunOptions.model,
      reasoningEffort: codexRunOptions.reasoningEffort,
      historyId,
      createdAt: now,
      updatedAt: now,
    };
    const payload: SendPayload = {
      prompt,
      attachments: attachmentPayload,
      remotePath: taskRemotePath,
      model: codexRunOptions.model,
      reasoningEffort: codexRunOptions.reasoningEffort,
    };
    setTasks((current) => [task, ...current].slice(0, MAX_TASKS));
    setActiveTaskId(task.id);
    setCreatingNewTask(false);
    connectTask(task, payload);
    return true;
  }, [
    codexReady,
    codexRunOptions.model,
    codexRunOptions.reasoningEffort,
    connectTask,
    connected,
    cwdInput,
    legacyServer,
    remotePath,
  ]);

  const drainQueuedTrainingTasks = useCallback(async () => {
    if (
      drainingTrainingQueueRef.current ||
      !connected ||
      !legacyServer?.id ||
      !codexReady ||
      loadingWorkflows ||
      loadedWorkflowServerId !== legacyServer.id
    ) {
      return;
    }
    if (composerTextRef.current.trim()) {
      return;
    }

    const queuedTasks = takeQueuedCodexTrainingTasks(
      (task) =>
        task.agent === 'codex' &&
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
      await startTask(task.prompt, [], {
        title: task.title || 'Start Training',
        remotePath: task.remotePath,
      });
    } finally {
      drainingTrainingQueueRef.current = false;
    }
  }, [codexReady, connected, legacyServer?.id, loadedWorkflowServerId, loadingWorkflows, startTask]);

  useEffect(() => {
    void drainQueuedTrainingTasks();
    return subscribeCodexTrainingTasks(() => {
      void drainQueuedTrainingTasks();
    });
  }, [drainQueuedTrainingTasks]);

  useEffect(() => {
    if (!composerText.trim()) {
      void drainQueuedTrainingTasks();
    }
  }, [composerText, drainQueuedTrainingTasks]);

  const continueTask = async (promptText: string, images: CodexImageAttachment[] = []) => {
    const prompt = promptText.trim() || (images.length > 0 ? '請根據附上的圖片進行協助。' : '');
    if (!prompt || !activeTask || !codexReady) return false;
    if (!legacyServer) {
      setHelperError('請先選擇 SSH server。');
      return false;
    }
    if (!connected) {
      setHelperError('Press Connect before checking or running Codex; no SSH starts while disconnected.');
      return false;
    }
    const cwdOnlyChange = images.length === 0 ? parseStandaloneCwdChangeRequest(prompt) : '';
    if (cwdOnlyChange) {
      updateTask(activeTask.id, (task) => ({
        ...task,
        remotePath: cwdOnlyChange,
        output: trimOutput(
          `${task.output}\r\n${USER_TRANSCRIPT_MARKER}\r\n${prompt}\r\n${CODEX_TRANSCRIPT_MARKER}\r\n已將工作目錄切換到 \`${cwdOnlyChange}\`。\r\n`,
        ),
        updatedAt: new Date().toISOString(),
      }));
      setCwdInput(cwdOnlyChange);
      setHelperError('');
      return true;
    }
    let historyId = activeTask.historyId;
    if (!historyId) {
      try {
        const history = await createLegacyCodexHistory(legacyServer.id, activeTask.title || titleFromPrompt(prompt));
        historyId = history.id;
      } catch (error) {
        setHelperError(error instanceof Error ? error.message : '建立遠端 Codex history 失敗');
        return false;
      }
    }
    const attachmentPayload = payloadFromImages(images);
    const transcriptPrompt = formatPromptForTranscript(prompt, attachmentPayload);
    const taskRemotePath = normalizeRemotePath(cwdInput || activeTask.remotePath || legacyServer.defaultPath || '~');
    const payload: SendPayload = {
      prompt,
      attachments: attachmentPayload,
      remotePath: taskRemotePath,
      model: codexRunOptions.model,
      reasoningEffort: codexRunOptions.reasoningEffort,
    };
    updateTask(activeTask.id, (task) => ({
      ...task,
      running: true,
      status: 'running',
      prompt,
      remotePath: taskRemotePath,
      model: codexRunOptions.model,
      reasoningEffort: codexRunOptions.reasoningEffort,
      historyId,
      output: trimOutput(
        `${task.output}\r\n${USER_TRANSCRIPT_MARKER}\r\n${transcriptPrompt}\r\n${CODEX_TRANSCRIPT_MARKER}\r\n[CozyPad] codex started; opening stream\r\n`,
      ),
      updatedAt: new Date().toISOString(),
    }));
    connectTask(
      {
        ...activeTask,
        running: true,
        historyId,
        remotePath: taskRemotePath,
        model: codexRunOptions.model,
        reasoningEffort: codexRunOptions.reasoningEffort,
      },
      payload,
    );
    return true;
  };

  const sendComposerText = async (text: string) => {
    const attachments = imageAttachmentsRef.current;
    const ok = activeTask ? await continueTask(text, attachments) : await startTask(text, attachments);
    if (ok) {
      setComposerText('');
      clearImageAttachments();
    }
  };

  const removeTask = (taskId: string) => {
    const task = tasks.find((item) => item.id === taskId) || null;
    manuallyClosedTaskIdsRef.current.add(taskId);
    nonReconnectTaskIdsRef.current.delete(taskId);
    const reconnectTimer = reconnectTimersRef.current.get(taskId);
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimersRef.current.delete(taskId);
    }
    reconnectAttemptsRef.current.delete(taskId);
    queuedSocketPayloadsRef.current.delete(taskId);
    socketsRef.current.get(taskId)?.close();
    socketsRef.current.delete(taskId);
    markWorkRunDeleted(`codex:${taskId}`);
    setTasks((current) => current.filter((task) => task.id !== taskId));
    if (legacyServer && task?.profileId === legacyServer.id) {
      void deleteLegacyCodexWorkflow(taskId, legacyServer.id).catch((error) => {
        setHelperError(error instanceof Error ? error.message : '遠端 Codex 工作刪除失敗');
      });
    }
  };

  const stopActiveTask = async () => {
    if (!activeTask || !legacyServer?.id || !activeTask.running || stoppingTaskId) return;
    const taskId = activeTask.id;
    setStoppingTaskId(taskId);
    manuallyClosedTaskIdsRef.current.add(taskId);
    nonReconnectTaskIdsRef.current.add(taskId);
    const reconnectTimer = reconnectTimersRef.current.get(taskId);
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimersRef.current.delete(taskId);
    }
    reconnectAttemptsRef.current.delete(taskId);
    queuedSocketPayloadsRef.current.delete(taskId);

    try {
      const result = await stopLegacyAgentLatestTask({
        agent: 'codex',
        serverId: legacyServer.id,
        taskId,
      });
      const message = result.stopped
        ? '[CozyPad] codex stopped by user'
        : `[CozyPad] ${result.message || 'No running Codex task was found.'}`;
      updateTask(taskId, (task) => ({
        ...task,
        status: 'failed',
        running: false,
        connected: false,
        output: trimOutput(`${task.output}\r\n${message}\r\n`),
        updatedAt: new Date().toISOString(),
      }));
      socketsRef.current.get(taskId)?.close();
      socketsRef.current.delete(taskId);
    } catch (error) {
      setHelperError(error instanceof Error ? error.message : 'Codex stop failed.');
    } finally {
      setStoppingTaskId('');
    }
  };

  const submitEditedUserPrompt = async (nextText: string) => {
    const task = activeTask;
    if (!task) {
      setEditingUserPrompt('');
      return;
    }

    const rerunTitle = task.title || titleFromPrompt(nextText);
    const rerunPath = task.remotePath || cwdInput || '~';
    if (task.running) {
      await stopActiveTask();
    }

    setEditingUserPrompt('');
    await startTask(nextText, [], {
      title: rerunTitle,
      remotePath: rerunPath,
    });
  };

  const cliLabel = legacyServer
    ? `${localMode ? 'Local' : 'Remote'} Codex on ${legacyServer.name}`
    : '請先選擇 SSH server';

  const visibleHelperError = stripHiddenCodexImagePayload(helperError);
  const codexAvailable = Boolean(legacyServer && codexStatus?.available);
  const codexHasChecked = Boolean(codexStatus || codexCheckError);
  const codexModeLabel =
    codexStatus?.transport === 'terminal' ? 'terminal bridge' : localMode ? 'local mode' : 'server mode';
  const codexStatusLabel = codexAvailable
    ? codexModeLabel
    : codexHasChecked
      ? 'no service'
      : codexReady
        ? 'unchecked'
        : 'no server';

  return (
    <div className="legacy-codex-panel">
      <header className="legacy-codex-head">
        <div>
          <h2>Codex CLI</h2>
          <span>{cliLabel}</span>
        </div>
        <div className="legacy-codex-actions">
          <button type="button" onClick={checkCodex} disabled={!connected || !legacyServer || checkingCodex}>
            {checkingCodex ? 'Checking...' : '檢查 Codex'}
          </button>
          <span className="chip chip-ready">
            {codexRunOptions.model || 'default'} · {codexRunOptions.reasoningEffort || 'auto'}
          </span>
          <span className={`chip chip-${codexAvailable ? 'ready' : 'disconnected'}`}>
            {codexStatusLabel}
          </span>
        </div>
      </header>
      {visibleHelperError ? (
        <div className="legacy-codex-alert">
          <strong>{localMode ? 'Local Codex' : 'Remote Codex'}</strong>
          <span>{visibleHelperError}</span>
        </div>
      ) : null}

      {legacyServer && connected && codexCheckError ? (
        <div className="legacy-codex-alert">
          <strong>{localMode ? 'Local Codex' : 'Remote Codex'}</strong>
          <span>{checkingCodex ? 'Checking Codex CLI...' : codexCheckError}</span>
        </div>
      ) : null}

      {!legacyServer ? (
        <div className="legacy-codex-alert">
          <strong>請先選擇 SSH server</strong>
          <span>Codex CLI 會在選取的遠端伺服器上執行，不使用本機 Codex。</span>
        </div>
      ) : null}

      {legacyServer && !connected ? (
        <div className="legacy-codex-alert">
          <strong>Connect required</strong>
          <span>Press Connect before checking or running Codex; no SSH starts while disconnected.</span>
        </div>
      ) : null}

      <div className="agent-panes legacy-codex-panes">
        <aside className="session-sidebar legacy-codex-sidebar">
          <input
            className="session-filter"
            placeholder="搜尋 Codex 工作..."
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
                    setCreatingNewTask(false);
                    void connectExistingTask(task);
                  }}
                >
                  <span className="session-title">{task.title}</span>
                  <span className="session-meta">
                    {task.profileName} · {task.remotePath || '~'}
                  </span>
                  <span className="session-footer">
                    <span className={`chip chip-${task.running ? 'running' : 'ready'}`}>
                      {task.running ? 'running' : task.connected ? 'connected' : 'saved'}
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
                  ×
                </button>
              </div>
            ))}
            {visibleTasks.length === 0 ? (
              <p className="hint session-empty">尚無符合的 Codex 工作。</p>
            ) : null}
          </div>
          <button
            className="session-new"
            type="button"
            onClick={() => {
              setCreatingNewTask(true);
              setActiveTaskId('');
            }}
            disabled={!codexReady || loadingWorkflows}
          >
            + 新工作
          </button>
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
                    {activeTask.remotePath || '~'} ·{' '}
                    {activeTask.connected ? 'connected' : 'saved'}
                  </span>
                </div>
                <span
                  className={`chip chip-${
                    activeTask.connected ? 'ready' : activeTask.running ? 'running' : 'disconnected'
                  }`}
                >
                  {activeTask.connected ? 'connected' : activeTask.running ? 'running' : 'saved'}
                </span>
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
              <div className="legacy-codex-dialogue" ref={dialogueScrollRef}>
                {renderDialogue(
                  activeTask,
                  activeTask.profileId || legacyServer?.id || '',
                  onOpenFilesPath,
                  setEditingUserPrompt,
                )}
              </div>
            </>
          ) : (
            <div className="placeholder">
              <p>{creatingNewTask ? '輸入需求後送出，建立新的 Codex 工作。' : '建立一個 Codex 工作開始。'}</p>
            </div>
          )}
          <ChatComposer
            agentLabel="Codex"
            value={composerText}
            commands={commonAgentSlashCommands}
            attachments={imageAttachments}
            disabled={!codexReady || loadingWorkflows}
            attachDisabled={false}
            attachTitle="新增 Codex 工作"
            showAttachButton={false}
            placeholder={
              loadingWorkflows
                ? '正在載入遠端 Codex 工作'
                : activeTask
                  ? activeTask.running
                    ? '插入補充指令…（目前回合結束後會自動接續執行）'
                    : `Message Codex…（可拖曳或貼上圖片）`
                  : 'Message Codex…（可拖曳或貼上圖片）'
            }
            onAttach={() => {
              setCreatingNewTask(true);
              setActiveTaskId('');
            }}
            onChange={setComposerText}
            onSend={(text) => void sendComposerText(text)}
            onFilesAttached={(files) => void addImageFiles(files)}
            onRemoveAttachment={removeImageAttachment}
          />
        </section>

        <aside className="context-panel legacy-codex-context">
          <h3>Context</h3>
          <dl>
            <dt>Agent</dt>
            <dd>Codex CLI</dd>
            <dt>Mode</dt>
            <dd>{localMode ? 'local machine' : 'remote SSH server'}</dd>
            <dt>Server</dt>
            <dd>{legacyServer?.name || currentBinding?.name || '未選擇'}</dd>
            <dt>Target</dt>
            <dd>
              {legacyServer ? legacyServerTarget(legacyServer) : currentBinding?.host || '-'}
            </dd>
            <dt>cwd</dt>
            <dd className="legacy-codex-cwd-cell">
              <input
                className="legacy-codex-cwd-input"
                value={cwdInput}
                onChange={(event) => setCwdInput(event.target.value)}
                onBlur={applyCwdInput}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.currentTarget.blur();
                  }
                }}
                placeholder="~"
                spellCheck={false}
              />
              <button
                type="button"
                className="legacy-codex-cwd-open"
                disabled={!legacyServer?.id || !cwdInput.trim()}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  const path = cwdInput.trim();
                  if (!legacyServer?.id || !path) return;
                  onOpenFilesPath?.({ serverId: legacyServer.id, path });
                }}
              >
                File
              </button>
            </dd>
            <dt>Status</dt>
            <dd>
              <span className={`chip chip-${codexAvailable ? 'ready' : 'disconnected'}`}>
                {codexStatusLabel}
              </span>
            </dd>
          </dl>
          <h3>Runtime</h3>
          <div className="legacy-codex-settings">
            <label className="legacy-codex-setting">
              <span>Model</span>
              <select
                value={codexModelInput}
                onChange={(event) => setCodexModelInput(event.target.value)}
              >
                <option value="">default</option>
                {codexModelOptions.map((model) => (
                  <option value={model} key={model}>
                    {model}
                  </option>
                ))}
              </select>
            </label>
            <div className="legacy-codex-setting">
              <span>Effort</span>
              <div className="legacy-codex-segmented" role="group" aria-label="Codex effort">
                {CODEX_EFFORT_OPTIONS.map((option) => (
                  <button
                    className={
                      option.value === codexRunOptions.reasoningEffort ? 'active' : undefined
                    }
                    type="button"
                    key={option.value || 'auto'}
                    onClick={() => setCodexReasoningEffort(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <h3>Workflow</h3>
          <p className="hint">
            {legacyServer
              ? '工作紀錄會保存到選取的遠端 server。'
              : '請先選擇 SSH server，Codex 才會綁定遠端執行。'}
          </p>
          <h3>Usage</h3>
          <p className="hint">Codex CLI 輸出會保留在工作分頁中。</p>
        </aside>
      </div>
      {editingUserPrompt ? (
        <EditSentMessageDialog
          agentLabel="Codex"
          initialText={editingUserPrompt}
          running={Boolean(activeTask?.running)}
          onCancel={() => setEditingUserPrompt('')}
          onSubmit={submitEditedUserPrompt}
        />
      ) : null}
    </div>
  );
}
