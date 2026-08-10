import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import {
  markdownRehypePlugins,
  markdownRemarkPlugins,
  normalizeMarkdownMath,
} from '../components/markdownPlugins';
import {
  isLegacyAuthError,
  listLegacyServers,
  summarizeLegacyMarkdown,
  type LegacyMarkdownSummaryResponse,
  type LegacySshServer,
} from './agents/legacySshApi';
import {
  findRememberedLegacyServer,
  readLastSelectedLegacyServerId,
  subscribeLastSelectedLegacyServerId,
} from './sshServerPreference';

const PRIMARY_SERVER_KEYWORD = '91';
const ACCEPTED_NOTE_EXTENSIONS = new Set(['md', 'markdown', 'txt']);
const MAX_NOTE_FILE_BYTES = 3 * 1024 * 1024;

type MarkdownDraftFile = {
  id: string;
  name: string;
  size: number;
  extension: string;
  content: string;
  addedAt: number;
  order: number;
};

type MarkdownSummaryState = {
  loading: boolean;
  error: string;
  result: LegacyMarkdownSummaryResponse | null;
  runningFileCount: number;
  startedAt: number | null;
};

type MarkdownRuntimeState = {
  draftFiles: MarkdownDraftFile[];
  dropMessage: string;
  summaryInstruction: string;
  summary: MarkdownSummaryState;
};

const initialMarkdownRuntimeState: MarkdownRuntimeState = {
  draftFiles: [],
  dropMessage: '',
  summaryInstruction: '',
  summary: {
    loading: false,
    error: '',
    result: null,
    runningFileCount: 0,
    startedAt: null,
  },
};

let markdownRuntimeState = initialMarkdownRuntimeState;
let markdownSummaryJob: Promise<void> | null = null;
const markdownRuntimeSubscribers = new Set<() => void>();

function nextDraftOrder(files: MarkdownDraftFile[]): number {
  return files.reduce((max, file) => Math.max(max, file.order + 1), 0);
}

function getMarkdownRuntimeState(): MarkdownRuntimeState {
  return markdownRuntimeState;
}

function setMarkdownRuntimeState(
  updater: (current: MarkdownRuntimeState) => MarkdownRuntimeState,
): void {
  markdownRuntimeState = updater(markdownRuntimeState);
  for (const subscriber of markdownRuntimeSubscribers) {
    subscriber();
  }
}

function subscribeMarkdownRuntime(subscriber: () => void): () => void {
  markdownRuntimeSubscribers.add(subscriber);
  return () => markdownRuntimeSubscribers.delete(subscriber);
}

function setMarkdownSummaryError(error: string): void {
  setMarkdownRuntimeState((current) => ({
    ...current,
    summary: {
      ...current.summary,
      loading: false,
      error,
    },
  }));
}

function startMarkdownSummaryJob(serverId: string, files: MarkdownDraftFile[], instruction: string): void {
  if (markdownSummaryJob) return;

  const payload = files.map((file) => ({
    name: file.name,
    content: file.content,
  }));

  setMarkdownRuntimeState((current) => ({
    ...current,
    summary: {
      loading: true,
      error: '',
      result: null,
      runningFileCount: payload.length,
      startedAt: Date.now(),
    },
  }));

  markdownSummaryJob = (async () => {
    try {
      const result = await summarizeLegacyMarkdown(serverId, payload, instruction);
      setMarkdownRuntimeState((current) => ({
        ...current,
        summary: {
          ...current.summary,
          loading: false,
          error: result.ok ? '' : result.error || 'Markdown summary failed',
          result,
        },
      }));
    } catch (err) {
      setMarkdownRuntimeState((current) => ({
        ...current,
        summary: {
          ...current.summary,
          loading: false,
          error: err instanceof Error ? err.message : 'Markdown summary failed',
          result: null,
        },
      }));
    } finally {
      markdownSummaryJob = null;
    }
  })();
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : '';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.split(/\r\n|\r|\n/).length;
}

function formatSummaryResult(result: LegacyMarkdownSummaryResponse | null): string {
  if (!result) return '';
  if (typeof result.summary === 'string') return result.summary;
  if (typeof result.result === 'string') return result.result;
  if (result.result !== undefined) return JSON.stringify(result.result, null, 2);
  return JSON.stringify(
    {
      ok: result.ok,
      fileCount: result.fileCount,
      modelPath: result.modelPath,
      error: result.error,
    },
    null,
    2,
  );
}

function isNinetyOneServer(server: LegacySshServer): boolean {
  const haystack = [server.id, server.name, server.alias, server.host]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(PRIMARY_SERVER_KEYWORD);
}

export function MarkdownWorkspace() {
  const [servers, setServers] = useState<LegacySshServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dropActive, setDropActive] = useState(false);
  const [runtimeState, setRuntimeState] = useState(() => getMarkdownRuntimeState());
  const [rememberedServerId, setRememberedServerId] = useState(() => readLastSelectedLegacyServerId());
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => subscribeMarkdownRuntime(() => setRuntimeState(getMarkdownRuntimeState())), []);

  useEffect(
    () =>
      subscribeLastSelectedLegacyServerId((serverId) => {
        setRememberedServerId(serverId);
      }),
    [],
  );

  const refreshServers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const list = await listLegacyServers();
      setServers(list);
    } catch (err) {
      setServers([]);
      setError(
        isLegacyAuthError(err)
          ? '請先登入 CozyPad，Markdown 工作區才能讀取已匯入的 SSH server。'
          : err instanceof Error
            ? err.message
            : 'Markdown 工作區載入 server 清單失敗。',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshServers();
  }, [refreshServers]);

  const targetServer = useMemo(
    () =>
      (rememberedServerId ? servers.find((server) => server.id === rememberedServerId) : null) ??
      findRememberedLegacyServer(servers) ??
      servers.find(isNinetyOneServer) ??
      null,
    [rememberedServerId, servers],
  );

  const serverState = targetServer ? 'ready' : loading ? 'loading' : 'missing';
  const { draftFiles, dropMessage, summaryInstruction, summary } = runtimeState;
  const summaryLoading = summary.loading;
  const summaryError = summary.error;
  const summaryResult = summary.result;
  const targetServerName = targetServer?.name || '上次選擇的 server';
  const totalBytes = useMemo(
    () => draftFiles.reduce((sum, file) => sum + file.size, 0),
    [draftFiles],
  );
  const totalLines = useMemo(
    () => draftFiles.reduce((sum, file) => sum + countLines(file.content), 0),
    [draftFiles],
  );
  const summaryText = useMemo(() => formatSummaryResult(summaryResult), [summaryResult]);

  const appendDraftFiles = useCallback(async (files: FileList | File[]) => {
    const incoming = Array.from(files);
    if (incoming.length === 0) return;

    const rejected: string[] = [];
    const accepted = incoming.filter((file) => {
      const extension = extensionOf(file.name);
      if (!ACCEPTED_NOTE_EXTENSIONS.has(extension)) {
        rejected.push(`${file.name} 格式不支援`);
        return false;
      }
      if (file.size > MAX_NOTE_FILE_BYTES) {
        rejected.push(`${file.name} 超過 ${formatBytes(MAX_NOTE_FILE_BYTES)}`);
        return false;
      }
      return true;
    });

    if (accepted.length === 0) {
      const message = rejected.slice(0, 3).join('，') || '沒有可加入的檔案。';
      setMarkdownRuntimeState((current) => ({
        ...current,
        dropMessage: message,
      }));
      return;
    }

    const loaded = await Promise.all(
      accepted.map(async (file, index) => ({
        id: `${file.name}-${file.size}-${file.lastModified}`,
        name: file.name,
        size: file.size,
        extension: extensionOf(file.name),
        content: await file.text(),
        addedAt: Date.now(),
        order: index,
      })),
    );

    setMarkdownRuntimeState((current) => {
      const next = new Map(current.draftFiles.map((file) => [file.id, file]));
      let order = nextDraftOrder(current.draftFiles);
      for (const file of loaded) {
        const existing = next.get(file.id);
        next.set(file.id, existing ? { ...file, order: existing.order } : { ...file, order });
        if (!existing) order += 1;
      }
      return {
        ...current,
        draftFiles: Array.from(next.values()).sort((a, b) => a.order - b.order),
        dropMessage:
          rejected.length > 0
            ? `已加入 ${loaded.length} 個檔案，略過 ${rejected.length} 個不支援檔案。`
            : `已加入 ${loaded.length} 個檔案。`,
      };
    });
  }, []);

  const removeDraftFile = useCallback((id: string) => {
    setMarkdownRuntimeState((current) => ({
      ...current,
      draftFiles: current.draftFiles.filter((file) => file.id !== id),
    }));
  }, []);

  const runSummary = useCallback(async () => {
    if (!targetServer) {
      setMarkdownSummaryError('找不到可用 server，請先確認 SSH server 清單已匯入。');
      return;
    }

    if (draftFiles.length === 0) {
      setMarkdownSummaryError('請先加入至少一個 .md 或 .txt 檔案。');
      return;
    }

    if (summaryLoading) return;

    setDropActive(false);
    startMarkdownSummaryJob(targetServer.id, draftFiles, summaryInstruction);
  }, [draftFiles, summaryInstruction, summaryLoading, targetServer]);

  return (
    <div className="markdown-workspace">
      <section className="markdown-hero">
        <div>
          <span className={`markdown-state markdown-state-${serverState}`}>
            {serverState}
          </span>
          <h2>Markdown Notes</h2>
          <p>
            這裡會作為 LLM 整理 markdown 筆記的彙整應用程式。現階段先建立入口、
            工作區版面與已選 server 綁定提示，LLM pipeline 暫時不啟用。
          </p>
        </div>
        <button type="button" onClick={() => void refreshServers()}>
          Refresh
        </button>
      </section>

      {error ? <p className="markdown-error">{error}</p> : null}

      {summaryLoading ? (
        <section className="card markdown-summary-progress">
          <div className="markdown-summary-spinner" aria-hidden="true" />
          <div>
            <h3>Summarizing notes</h3>
            <p>
              已送出 {summary.runningFileCount} 個檔案到 {targetServerName}，切換畫面後會在背景繼續等待遠端回傳。
            </p>
          </div>
        </section>
      ) : (
      <section className="card markdown-upload-card">
        <div className="markdown-upload-head">
          <div>
            <h3>Drop notes</h3>
            <p className="hint">
              可以一次放入多個 .md、.markdown 或 .txt 檔案，先建立待整理清單。
            </p>
          </div>
          <div className="markdown-upload-summary">
            <strong>{draftFiles.length}</strong>
            <span>files</span>
          </div>
        </div>

        <div
          className={`markdown-dropzone${dropActive ? ' markdown-dropzone-active' : ''}`}
          onDragEnter={(event) => {
            event.preventDefault();
            setDropActive(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            setDropActive(true);
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            if (event.currentTarget === event.target) setDropActive(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDropActive(false);
            void appendDraftFiles(event.dataTransfer.files);
          }}
          role="button"
          tabIndex={0}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              fileInputRef.current?.click();
            }
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".md,.markdown,.txt,text/markdown,text/plain"
            onChange={(event) => {
              void appendDraftFiles(event.currentTarget.files ?? []);
              event.currentTarget.value = '';
            }}
          />
          <strong>拖放 markdown / text 檔案到這裡</strong>
          <span>或點擊選取多個檔案</span>
        </div>

        <div className="markdown-upload-meta">
          <span>{formatBytes(totalBytes)}</span>
          <span>{totalLines.toLocaleString()} lines</span>
          <span>單檔上限 {formatBytes(MAX_NOTE_FILE_BYTES)}</span>
        </div>

        {dropMessage ? <p className="markdown-drop-message">{dropMessage}</p> : null}

        {draftFiles.length > 0 ? (
          <div className="markdown-file-list" aria-label="已加入的筆記檔案">
            {draftFiles.map((file) => (
              <div key={file.id} className="markdown-file-row">
                <div>
                  <strong>{file.name}</strong>
                  <span>
                    {file.extension.toUpperCase()} · {formatBytes(file.size)} ·{' '}
                    {countLines(file.content).toLocaleString()} lines
                  </span>
                </div>
                <button type="button" onClick={() => removeDraftFile(file.id)}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <textarea
          className="markdown-instruction"
          value={summaryInstruction}
          onChange={(event) =>
            setMarkdownRuntimeState((current) => ({
              ...current,
              summaryInstruction: event.currentTarget.value,
            }))
          }
          placeholder="可選：輸入整理方向，例如整理成研究筆記、條列重點、待辦事項或引用摘要"
          rows={3}
        />

        <div className="markdown-summary-actions">
          <button
            type="button"
            onClick={() => void runSummary()}
            disabled={summaryLoading || !targetServer || draftFiles.length === 0}
          >
            {summaryLoading ? 'Summarizing...' : `送到 ${targetServerName} 彙整`}
          </button>
          <span>
            API 會匯入遠端 <span className="mono">markdown_summary_api.py</span>
          </span>
        </div>

        {summaryError ? <p className="markdown-error">{summaryError}</p> : null}
        {summaryText ? (
          <div className="markdown-summary-result">
            <div className="markdown-summary-result-head">
              <strong>Summary result</strong>
              {summaryResult?.fileCount ? <span>{summaryResult.fileCount} files</span> : null}
            </div>
            <div className="markdown markdown-doc markdown-summary-doc">
              <Markdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins}>
                {normalizeMarkdownMath(summaryText)}
              </Markdown>
            </div>
          </div>
        ) : null}
      </section>
      )}

    </div>
  );
}
