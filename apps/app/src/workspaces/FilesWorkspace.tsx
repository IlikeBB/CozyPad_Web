import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import type { RemoteFileItem } from '@cozypad/contracts';
import { textToBase64 } from '@cozypad/contracts';
import { getBridge } from '../platform/bridge';
import { CodeEditor } from '../components/CodeEditor';
import { ContextMenu, useLongPress } from '../components/ContextMenu';
import type { MenuAction } from '../components/ContextMenu';
import { FileIcon, fileKindOf } from '../components/FileIcons';
import {
  markdownRehypePlugins,
  markdownRemarkPlugins,
  normalizeMarkdownMath,
} from '../components/markdownPlugins';
import { PdfViewer } from '../components/PdfViewer';
import { mimeTypeForFileName, saveWithBrowserDownload } from '../fileDownload';
import { buildFileBreadcrumbs, directoryItems } from './fileNavigation';
import {
  createLegacyServerFolder,
  deleteLegacyServerFile,
  listLegacyServerFiles,
  listLegacyServers,
  previewLegacyServerFile,
  renameLegacyServerFile,
} from './agents/legacySshApi';
import type {
  LegacyFilePreviewKind,
  LegacySshFileItem,
  LegacySshFilePreview,
  LegacySshServer,
} from './agents/legacySshApi';
import {
  readLastSelectedLegacyServerId,
  resolveLastSelectedLegacyServerId,
  subscribeLastSelectedLegacyServerId,
} from './sshServerPreference';

interface FilesWorkspaceProps {
  active?: boolean;
  connected: boolean;
  profileId?: string | null;
}

type DialogState =
  | null
  | { kind: 'new-file'; dir: string }
  | { kind: 'new-folder'; dir: string }
  | { kind: 'rename'; item: RemoteFileItem }
  | { kind: 'move'; item: RemoteFileItem }
  | { kind: 'copy-to'; item: RemoteFileItem }
  | { kind: 'delete'; item: RemoteFileItem };

type LegacyFileBrowserState = {
  serverId: string;
  path: string;
  parent: string;
  items: LegacySshFileItem[];
  totalItems: number;
  maxItems: number;
  truncated: boolean;
  loading: boolean;
  error: string;
};

type LegacyFilePreviewState = {
  open: boolean;
  loading: boolean;
  path: string;
  name: string;
  kind: LegacyFilePreviewKind;
  mime: string;
  size: number;
  content: string;
  objectUrl: string;
  error: string;
};

type LegacyFilesDialogState =
  | null
  | { kind: 'new-folder'; dir: string }
  | { kind: 'rename'; item: LegacySshFileItem }
  | { kind: 'delete'; item: LegacySshFileItem };

type LegacyFilesMenuState =
  | null
  | { kind: 'item'; item: LegacySshFileItem; x: number; y: number }
  | { kind: 'blank'; x: number; y: number };

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'py', 'ts', 'tsx', 'js', 'jsx', 'json', 'yaml', 'yml',
  'toml', 'cfg', 'ini', 'sh', 'bash', 'zsh', 'log', 'csv', 'tsv', 'xml', 'html',
  'css', 'sql', 'rs', 'go', 'c', 'h', 'cpp', 'hpp', 'java', 'rb', 'dart', 'gitignore',
]);

const IMAGE_EXTENSIONS = new Set([
  'avif', 'bmp', 'gif', 'heic', 'heif', 'ico', 'jpeg', 'jpg', 'png', 'svg', 'webp',
]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function isTextFile(item: RemoteFileItem): boolean {
  if (item.name.startsWith('.') && !item.name.includes('.', 1)) return true;
  const ext = extensionOf(item.name);
  // 無副檔名的檔案（README、Makefile、syslog…）在大小合理時當文字處理。
  if (ext === '' && item.sizeBytes <= MAX_EDITOR_BYTES) return true;
  return TEXT_EXTENSIONS.has(ext);
}

function isMarkdown(item: RemoteFileItem): boolean {
  const ext = extensionOf(item.name);
  return ext === 'md' || ext === 'markdown';
}

function isPdf(item: RemoteFileItem): boolean {
  return extensionOf(item.name) === 'pdf';
}

function isLegacyImageItem(item: LegacySshFileItem): boolean {
  if (item.isDirectory) return false;
  return IMAGE_EXTENSIONS.has(extensionOf(item.name));
}

function parentOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

function isMouseBackButton(event: MouseEvent): boolean {
  return event.button === 3;
}

function isKeyboardBackShortcut(event: KeyboardEvent): boolean {
  return event.key === 'BrowserBack' || (event.altKey && event.key === 'ArrowLeft');
}

function useFileBackShortcut(
  active: boolean,
  canGoParent: boolean,
  goParent: () => void,
): void {
  const goParentRef = useRef(goParent);
  goParentRef.current = goParent;

  useEffect(() => {
    if (!active || !canGoParent) return;

    const onMouseNavigation = (event: MouseEvent): void => {
      if (!isMouseBackButton(event)) return;
      event.preventDefault();
      event.stopPropagation();
      goParentRef.current();
    };

    const onKeyNavigation = (event: KeyboardEvent): void => {
      if (!isKeyboardBackShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      goParentRef.current();
    };

    const onPopState = (): void => {
      goParentRef.current();
      window.history.pushState({ cozyPadFilesBackGuard: true }, '', window.location.href);
    };

    window.history.pushState({ cozyPadFilesBackGuard: true }, '', window.location.href);
    window.addEventListener('mousedown', onMouseNavigation, { capture: true });
    window.addEventListener('mouseup', onMouseNavigation, { capture: true });
    window.addEventListener('auxclick', onMouseNavigation, { capture: true });
    window.addEventListener('keydown', onKeyNavigation, { capture: true });
    window.addEventListener('popstate', onPopState);

    return () => {
      window.removeEventListener('mousedown', onMouseNavigation, { capture: true });
      window.removeEventListener('mouseup', onMouseNavigation, { capture: true });
      window.removeEventListener('auxclick', onMouseNavigation, { capture: true });
      window.removeEventListener('keydown', onKeyNavigation, { capture: true });
      window.removeEventListener('popstate', onPopState);
    };
  }, [active, canGoParent]);
}

const MAX_EDITOR_BYTES = 262144;

const emptyLegacyFileBrowser: LegacyFileBrowserState = {
  serverId: '',
  path: '~',
  parent: '',
  items: [],
  totalItems: 0,
  maxItems: 0,
  truncated: false,
  loading: false,
  error: '',
};

const emptyLegacyFilePreview: LegacyFilePreviewState = {
  open: false,
  loading: false,
  path: '',
  name: '',
  kind: 'text',
  mime: '',
  size: 0,
  content: '',
  objectUrl: '',
  error: '',
};

const FILE_LIST_TIMEOUT_MS = 20000;

function formatLegacyFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function formatLegacyFileTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '-';
  return new Date(seconds * 1000).toLocaleString('zh-TW', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function legacyItemAsRemote(item: LegacySshFileItem): RemoteFileItem {
  return {
    name: item.name,
    path: item.path,
    type: item.isDirectory ? 'd' : item.type === 'symlink' ? 'l' : 'f',
    sizeBytes: item.size,
    modified: formatLegacyFileTime(item.mtime),
    executable: item.mode.includes('111') || item.mode.includes('755') || item.mode.includes('775'),
  };
}

function bytesFromBase64(base64: string): Uint8Array {
  const binary = window.atob(base64 || '');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function textFromBase64(base64: string): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytesFromBase64(base64));
}

function objectUrlFromPreview(preview: LegacySshFilePreview): string {
  const bytes = bytesFromBase64(preview.contentBase64);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const blob = new Blob([buffer], {
    type: preview.mime || 'application/octet-stream',
  });
  return URL.createObjectURL(blob);
}

function legacyPreviewKindLabel(kind: LegacyFilePreviewKind, mime: string): string {
  if (kind === 'markdown') return 'Markdown';
  if (kind === 'text') return '文字檔';
  if (kind === 'pdf') return 'PDF';
  if (kind === 'image') return '圖片';
  if (kind === 'audio') return '音訊';
  if (kind === 'video') return '影片';
  if (kind === 'binary') return mime || '二進位檔案';
  return '檔案預覽';
}

function parentPath(path: string): string {
  const cleanPath = path.replace(/\/+$/u, '') || '/';
  const index = cleanPath.lastIndexOf('/');
  return index <= 0 ? '/' : cleanPath.slice(0, index);
}

function sortLegacyFileItems(items: LegacySshFileItem[]): LegacySshFileItem[] {
  return [...items].sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  });
}

function legacyPathBreadcrumbs(remotePath: string): Array<{ label: string; path: string }> {
  const path = (remotePath || '~').replace(/\/+$/u, '') || '/';
  if (path === '/' || path === '~') return [{ label: path, path }];

  const homeLike = path === '~' || path.startsWith('~/');
  const root = homeLike ? '~' : '/';
  const rest = homeLike ? path.slice(2) : path.replace(/^\/+/u, '');
  const parts = rest.split('/').filter(Boolean);
  const crumbs = [{ label: root, path: root }];
  let current = root;
  for (const part of parts) {
    current = current === '/' ? `/${part}` : `${current}/${part}`;
    crumbs.push({ label: part, path: current });
  }
  return crumbs;
}

/** 單列檔案項目：右鍵與長按都會開動作選單。 */
function TreeRow({
  item,
  className,
  style,
  title,
  onClick,
  onDoubleClick,
  onOpenMenu,
  children,
}: {
  item: RemoteFileItem;
  className: string;
  style?: React.CSSProperties;
  title: string;
  onClick(): void;
  onDoubleClick(): void;
  onOpenMenu(x: number, y: number): void;
  children: React.ReactNode;
}) {
  const longPress = useLongPress(onOpenMenu);
  return (
    <button
      className={className}
      style={style}
      title={title}
      data-path={item.path}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      {...longPress}
    >
      {children}
    </button>
  );
}

function resolveFilesServerId(
  servers: LegacySshServer[],
  preferredId: string | null | undefined,
  currentId = '',
): string {
  if (preferredId && servers.some((server) => server.id === preferredId)) {
    return preferredId;
  }
  return resolveLastSelectedLegacyServerId(servers, currentId);
}

function LegacyServerFilesWorkspace({
  active = false,
  bridgeConnected,
  profileId = null,
}: {
  active?: boolean;
  bridgeConnected: boolean;
  profileId?: string | null;
}) {
  const [servers, setServers] = useState<LegacySshServer[]>([]);
  const [selectedServerId, setSelectedServerId] = useState(() => readLastSelectedLegacyServerId());
  const [pathInput, setPathInput] = useState('~');
  const [serverError, setServerError] = useState('');
  const [browser, setBrowser] = useState<LegacyFileBrowserState>(emptyLegacyFileBrowser);
  const [preview, setPreview] = useState<LegacyFilePreviewState>(emptyLegacyFilePreview);
  const [legacyMenu, setLegacyMenu] = useState<LegacyFilesMenuState>(null);
  const [legacyDialog, setLegacyDialog] = useState<LegacyFilesDialogState>(null);
  const [legacyDialogInput, setLegacyDialogInput] = useState('');
  const [legacyBusy, setLegacyBusy] = useState(false);
  const [legacyFlash, setLegacyFlash] = useState('');
  const [legacyActionError, setLegacyActionError] = useState('');
  const [selectedLegacyPath, setSelectedLegacyPath] = useState('');
  const previewObjectUrlRef = useRef('');
  const loadFilesRequestRef = useRef(0);

  const selectedServer = useMemo(
    () => servers.find((server) => server.id === selectedServerId) ?? null,
    [selectedServerId, servers],
  );

  const clearPreviewObjectUrl = useCallback(() => {
    if (!previewObjectUrlRef.current) return;
    URL.revokeObjectURL(previewObjectUrlRef.current);
    previewObjectUrlRef.current = '';
  }, []);

  const closePreview = useCallback(() => {
    clearPreviewObjectUrl();
    setPreview(emptyLegacyFilePreview);
  }, [clearPreviewObjectUrl]);

  useEffect(() => {
    return () => clearPreviewObjectUrl();
  }, [clearPreviewObjectUrl]);

  const loadServers = useCallback(async (refresh = false) => {
    if (!bridgeConnected) {
      setServerError('Press Connect before browsing SSH files.');
      return;
    }
    setServerError('');
    try {
      const nextServers = await listLegacyServers(refresh);
      setServers(nextServers);
      setSelectedServerId((current) => {
        const nextServerId = resolveFilesServerId(nextServers, profileId, current);
        if (!nextServerId) setBrowser(emptyLegacyFileBrowser);
        return nextServerId;
      });
    } catch (error) {
      setServerError(error instanceof Error ? error.message : 'server 列表載入失敗');
    }
  }, [bridgeConnected, profileId]);

  useEffect(() => {
    if (!bridgeConnected) {
      setServers([]);
      setSelectedServerId('');
      setServerError('Press Connect before browsing SSH files.');
      setBrowser(emptyLegacyFileBrowser);
      closePreview();
      return;
    }

    void loadServers(false);
  }, [bridgeConnected, closePreview, loadServers]);

  useEffect(
    () =>
      subscribeLastSelectedLegacyServerId((serverId) => {
        if (!serverId || !servers.some((server) => server.id === serverId)) return;
        setSelectedServerId(serverId);
        closePreview();
        setBrowser(emptyLegacyFileBrowser);
        setPathInput(servers.find((server) => server.id === serverId)?.defaultPath || '~');
      }),
    [closePreview, servers],
  );

  const loadFiles = useCallback(
    async (server: LegacySshServer, remotePath: string) => {
      if (!bridgeConnected) {
        setLegacyActionError('Press Connect before browsing SSH files.');
        return;
      }

      const nextPath = remotePath.trim() || server.defaultPath || '~';
      const requestId = loadFilesRequestRef.current + 1;
      loadFilesRequestRef.current = requestId;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), FILE_LIST_TIMEOUT_MS);
      setPathInput(nextPath);
      setLegacyActionError('');
      setBrowser((current) => ({
        ...current,
        serverId: server.id,
        path: nextPath,
        loading: true,
        error: '',
      }));
      try {
        const listing = await listLegacyServerFiles(server.id, nextPath, {
          signal: controller.signal,
        });
        if (loadFilesRequestRef.current !== requestId) return;
        setSelectedLegacyPath('');
        setBrowser({
          serverId: server.id,
          path: listing.path || nextPath,
          parent: listing.parent || parentPath(listing.path || nextPath),
          items: listing.items,
          totalItems: Number(listing.totalItems || listing.items.length),
          maxItems: Number(listing.maxItems || listing.items.length),
          truncated: Boolean(listing.truncated),
          loading: false,
          error: '',
        });
        setPathInput(listing.path || nextPath);
      } catch (error) {
        if (loadFilesRequestRef.current !== requestId) return;
        const aborted = controller.signal.aborted;
        if (aborted) {
          setLegacyActionError(
            `File listing timed out after ${Math.round(FILE_LIST_TIMEOUT_MS / 1000)}s.`,
          );
        }
        setBrowser((current) => ({
          ...current,
          serverId: server.id,
          loading: false,
          error: error instanceof Error ? error.message : '檔案列表載入失敗',
        }));
      } finally {
        window.clearTimeout(timeout);
      }
    },
    [bridgeConnected],
  );

  useEffect(() => {
    if (!bridgeConnected || !selectedServer) return;
    if (browser.serverId === selectedServer.id && browser.path) return;

    closePreview();
    const nextPath = selectedServer.defaultPath || '~';
    setPathInput(nextPath);
    void loadFiles(selectedServer, nextPath);
  }, [bridgeConnected, browser.path, browser.serverId, closePreview, loadFiles, selectedServer]);

  useEffect(() => {
    if (!profileId || !servers.some((server) => server.id === profileId)) return;
    setSelectedServerId(profileId);
  }, [profileId, servers]);

  useEffect(() => {
    if (selectedServerId && selectedServer) return;
    if (!selectedServerId) return;
    setBrowser(emptyLegacyFileBrowser);
    setPathInput('~');
  }, [selectedServer, selectedServerId]);

  const openItem = (item: LegacySshFileItem) => {
    if (!selectedServer) return;
    setSelectedLegacyPath(item.path);
    if (item.isDirectory) {
      closePreview();
      void loadFiles(selectedServer, item.path);
      return;
    }
    void openPreview(item);
  };

  const openPreview = async (item: LegacySshFileItem) => {
    if (!selectedServer) return;
    clearPreviewObjectUrl();
    setPreview({
      ...emptyLegacyFilePreview,
      open: true,
      loading: true,
      path: item.path,
      name: item.name,
      size: item.size,
      kind: isLegacyImageItem(item) ? 'image' : emptyLegacyFilePreview.kind,
    });
    try {
      const result = await previewLegacyServerFile(selectedServer.id, item.path);
      const content =
        result.kind === 'text' || result.kind === 'markdown'
          ? textFromBase64(result.contentBase64)
          : '';
      const objectUrl =
        result.kind === 'pdf' ||
        result.kind === 'image' ||
        result.kind === 'audio' ||
        result.kind === 'video'
          ? objectUrlFromPreview(result)
          : '';
      previewObjectUrlRef.current = objectUrl;
      setPreview({
        open: true,
        loading: false,
        path: result.path,
        name: result.name,
        kind: result.kind,
        mime: result.mime,
        size: result.size,
        content,
        objectUrl,
        error: result.error || '',
      });
    } catch (error) {
      setPreview((current) => ({
        ...current,
        loading: false,
        kind: 'error',
        error: error instanceof Error ? error.message : '檔案預覽失敗',
      }));
    }
  };

  const copyPath = (path: string) => {
    void navigator.clipboard?.writeText(path).catch(() => undefined);
  };

  const showLegacyFlash = (message: string) => {
    setLegacyFlash(message);
    setTimeout(() => setLegacyFlash(''), 1800);
  };

  const currentLegacyDir = browser.path || pathInput || selectedServer?.defaultPath || '~';
  const inlineImagePreview = preview.open && preview.kind === 'image';
  const visibleLegacyItems = useMemo(() => sortLegacyFileItems(browser.items), [browser.items]);
  const legacyBreadcrumbs = useMemo(
    () => legacyPathBreadcrumbs(browser.path || pathInput || '~'),
    [browser.path, pathInput],
  );
  const canGoLegacyParent =
    active &&
    Boolean(selectedServer) &&
    !browser.loading &&
    !legacyBusy &&
    Boolean(browser.parent) &&
    browser.path !== '/' &&
    browser.path !== '~';

  const goLegacyParent = useCallback(() => {
    if (!selectedServer || !browser.parent || browser.loading || legacyBusy) return;
    closePreview();
    void loadFiles(selectedServer, browser.parent);
  }, [browser.loading, browser.parent, closePreview, legacyBusy, loadFiles, selectedServer]);

  useFileBackShortcut(active, canGoLegacyParent, goLegacyParent);

  const openLegacyBlankMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!selectedServer) return;
    const target = event.target as HTMLElement;
    if (target.closest('.legacy-file-row')) return;
    event.preventDefault();
    event.stopPropagation();
    setLegacyMenu({ kind: 'blank', x: event.clientX, y: event.clientY });
  };

  const legacyItemMenuActions: MenuAction[] = [
    { id: 'rename', label: '重新命名' },
    { id: 'delete', label: '刪除', danger: true, separatorBefore: true },
  ];

  const legacyBlankMenuActions: MenuAction[] = [
    { id: 'new-folder', label: '新增資料夾' },
  ];

  const runLegacyMenuAction = (actionId: string) => {
    if (!legacyMenu) return;
    if (legacyMenu.kind === 'blank') {
      if (actionId === 'new-folder') {
        setLegacyDialogInput('');
        setLegacyDialog({ kind: 'new-folder', dir: currentLegacyDir });
      }
      return;
    }

    if (actionId === 'rename') {
      setLegacyDialogInput(legacyMenu.item.name);
      setLegacyDialog({ kind: 'rename', item: legacyMenu.item });
      return;
    }

    if (actionId === 'delete') {
      setLegacyDialog({ kind: 'delete', item: legacyMenu.item });
    }
  };

  const confirmLegacyDialog = async () => {
    if (!selectedServer || !legacyDialog) return;
    const input = legacyDialogInput.trim();
    if (legacyDialog.kind !== 'delete' && input === '') {
      setLegacyActionError('名稱不能是空白');
      return;
    }

    setLegacyBusy(true);
    setLegacyActionError('');
    try {
      const result =
        legacyDialog.kind === 'new-folder'
          ? await createLegacyServerFolder(selectedServer.id, legacyDialog.dir, input)
          : legacyDialog.kind === 'rename'
            ? await renameLegacyServerFile(selectedServer.id, legacyDialog.item.path, input)
            : await deleteLegacyServerFile(selectedServer.id, legacyDialog.item.path);

      if (
        legacyDialog.kind === 'delete' ||
        (legacyDialog.kind === 'rename' && preview.path === legacyDialog.item.path)
      ) {
        closePreview();
      }

      setLegacyDialog(null);
      setLegacyDialogInput('');
      showLegacyFlash(
        legacyDialog.kind === 'new-folder'
          ? '資料夾已新增'
          : legacyDialog.kind === 'rename'
            ? '已重新命名'
            : '已刪除',
      );
      await loadFiles(selectedServer, result.parent || currentLegacyDir);
    } catch (error) {
      setLegacyActionError(error instanceof Error ? error.message : '檔案操作失敗');
    } finally {
      setLegacyBusy(false);
    }
  };

  if (serverError && servers.length === 0 && bridgeConnected) {
    return <BridgeFilesWorkspace active={active} connected={bridgeConnected} />;
  }

  return (
    <div className="files-workspace legacy-files-workspace">
      <aside className="files-tree legacy-files-tree">
        <form
          className="legacy-files-pathbar"
          onSubmit={(event) => {
            event.preventDefault();
            if (selectedServer) void loadFiles(selectedServer, pathInput);
          }}
        >
          <button
            type="button"
            disabled={!selectedServer || browser.loading || legacyBusy || !browser.parent}
            onClick={() => {
              if (selectedServer && browser.parent) void loadFiles(selectedServer, browser.parent);
            }}
          >
            上一層
          </button>
          <input
            className="mono"
            value={pathInput}
            onChange={(event) => setPathInput(event.target.value)}
            placeholder={selectedServer?.defaultPath || '~'}
          />
          <button type="submit" disabled={!selectedServer || browser.loading || legacyBusy}>
            開啟
          </button>
        </form>

        {serverError ? <div className="error-banner">{serverError}</div> : null}
        {legacyActionError ? <div className="error-banner">{legacyActionError}</div> : null}
        {legacyFlash ? <div className="legacy-files-flash">{legacyFlash}</div> : null}

        <div className="tree-scroll legacy-files-list" onContextMenu={openLegacyBlankMenu}>
          {!selectedServer ? (
            <div className="placeholder">
              <p>{servers.length === 0 ? '尚無 server' : '請選擇 server'}</p>
              <p className="hint">Files 會使用 v1 SSH server 設定進行遠端瀏覽。</p>
            </div>
          ) : browser.error ? (
            <div className="placeholder">
              <p>{browser.error}</p>
            </div>
          ) : visibleLegacyItems.length > 0 ? (
            visibleLegacyItems.map((item) => {
              const remoteItem = legacyItemAsRemote(item);
              return (
                <TreeRow
                  item={remoteItem}
                  className={`tree-row legacy-file-row${
                    selectedLegacyPath === item.path ? ' tree-row-active' : ''
                  }`}
                  key={item.path}
                  title={
                    item.error
                      ? `${item.path}\n${item.error}`
                      : `${item.path}\n${item.mode || item.type} · ${formatLegacyFileTime(item.mtime)}`
                  }
                  onOpenMenu={(x, y) => setLegacyMenu({ kind: 'item', item, x, y })}
                  onClick={() => openItem(item)}
                  onDoubleClick={() => undefined}
                >
                  <FileIcon kind={fileKindOf(remoteItem)} />
                  <span className="tree-name">{item.name}</span>
                  <span className="legacy-file-mode">{item.mode || item.type}</span>
                  <span className="legacy-file-size">
                    {item.isDirectory ? 'folder' : formatLegacyFileSize(item.size)}
                  </span>
                  <span className="legacy-file-time">{formatLegacyFileTime(item.mtime)}</span>
                </TreeRow>
              );
            })
              .concat(
                browser.truncated
                  ? [
                      <div key="__legacy_files_truncated__" className="hint tree-truncated">
                        僅顯示前 {browser.maxItems || browser.items.length} 筆，共 {browser.totalItems} 筆。
                      </div>,
                    ]
                  : [],
              )
          ) : (
            <div className="placeholder">
              <p>{browser.loading ? '載入中' : '這個資料夾沒有項目'}</p>
            </div>
          )}
        </div>
      </aside>

      <section className="files-preview legacy-files-preview">
        <div className="breadcrumb-bar">
          <button
            className="crumb files-copy-path-crumb"
            type="button"
            disabled={!selectedServer}
            onClick={() => {
              copyPath(currentLegacyDir);
              showLegacyFlash('路徑已複製');
            }}
            title={currentLegacyDir}
          >
            Copy path
          </button>
          <span className="crumb-wrap">
            <button className="crumb" type="button" disabled={!selectedServer}>
              {selectedServer?.name || 'Files'}
            </button>
          </span>
          {selectedServer
            ? legacyBreadcrumbs.map((crumb, index) => (
                <span className="crumb-wrap" key={`${crumb.path}:${index}`}>
                  <span className="crumb-sep">/</span>
                  <button
                    className="crumb mono"
                    type="button"
                    onClick={() => void loadFiles(selectedServer, crumb.path)}
                    disabled={browser.loading || legacyBusy}
                  >
                    {crumb.label}
                  </button>
                </span>
              ))
            : null}
        </div>
        {selectedServer ? (
          <div className="legacy-files-side-content">
            <div className="legacy-files-side-head">
              <div>
                <span className="hint">Current folder</span>
                <h3>{browser.path || pathInput}</h3>
              </div>
              <span className="legacy-files-count">
                {browser.loading ? 'loading' : `${browser.items.length} items`}
              </span>
            </div>
            {inlineImagePreview ? (
              <section className="legacy-files-inline-preview" aria-label="image preview">
                <div className="legacy-files-inline-preview-head">
                  <div>
                    <span className="hint">圖片預覽</span>
                    <strong>{preview.name || 'Image'}</strong>
                  </div>
                  <button type="button" onClick={closePreview}>
                    關閉
                  </button>
                </div>
                <div className="legacy-files-inline-image">
                  {preview.loading ? (
                    <p className="hint">圖片載入中</p>
                  ) : preview.error ? (
                    <p className="error-text">{preview.error}</p>
                  ) : preview.objectUrl ? (
                    <img alt={preview.name || 'Image preview'} src={preview.objectUrl} />
                  ) : (
                    <p className="hint">無法顯示圖片</p>
                  )}
                </div>
              </section>
            ) : null}
            <div className="legacy-files-side-list" onContextMenu={openLegacyBlankMenu}>
              {browser.error ? (
                <div className="placeholder">
                  <p>{browser.error}</p>
                </div>
              ) : visibleLegacyItems.length > 0 ? (
                visibleLegacyItems.map((item) => {
                  const remoteItem = legacyItemAsRemote(item);
                  return (
                    <button
                      type="button"
                      className={`legacy-files-side-item${
                        selectedLegacyPath === item.path ? ' legacy-files-side-item-active' : ''
                      }${item.isDirectory ? ' legacy-files-side-folder' : ''}`}
                      key={item.path}
                      title={item.path}
                      onClick={() => openItem(item)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setLegacyMenu({ kind: 'item', item, x: event.clientX, y: event.clientY });
                      }}
                    >
                      <FileIcon kind={fileKindOf(remoteItem)} />
                      <span className="legacy-files-side-name">{item.name}</span>
                      <span className="legacy-files-side-meta">
                        {item.isDirectory ? 'folder' : formatLegacyFileSize(item.size)}
                      </span>
                    </button>
                  );
                })
              ) : (
                <div className="placeholder legacy-files-empty">
                  <p>{browser.loading ? '載入中' : '這個資料夾沒有項目'}</p>
                  <p className="hint">右側也可以點資料夾進入更深層位置。</p>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="placeholder legacy-files-empty">
            <p>請先選擇要瀏覽的 SSH server。</p>
            <p className="hint">
              支援文字、Markdown、PDF、圖片、MP3/MP4 等媒體預覽；大型或二進位檔案會顯示不可預覽。
            </p>
          </div>
        )}
      </section>

      {preview.open && preview.kind !== 'image' ? (
        <div
          className="modal-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closePreview();
          }}
        >
          <section
            className="modal legacy-file-preview-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="legacy-file-preview-title"
          >
            <div className="modal-head">
              <div>
                <span className="hint">{legacyPreviewKindLabel(preview.kind, preview.mime)}</span>
                <h2 id="legacy-file-preview-title">{preview.name || '檔案預覽'}</h2>
              </div>
              <button className="modal-close" type="button" onClick={closePreview}>
                ×
              </button>
            </div>
            <div className="legacy-file-preview-meta">
              <span>{formatLegacyFileSize(preview.size)}</span>
              <span>{preview.mime || '-'}</span>
              <button type="button" onClick={() => copyPath(preview.path)}>
                copy path
              </button>
            </div>
            <div className="legacy-file-preview-body">
              {preview.loading ? (
                <div className="placeholder">
                  <p>載入中</p>
                </div>
              ) : preview.error ? (
                <div className="placeholder">
                  <p>{preview.error}</p>
                </div>
              ) : preview.kind === 'pdf' && preview.objectUrl ? (
                <iframe title={preview.name || 'PDF preview'} src={preview.objectUrl} />
              ) : preview.kind === 'audio' && preview.objectUrl ? (
                <div className="legacy-file-media-frame legacy-file-audio-frame">
                  <audio controls preload="metadata" src={preview.objectUrl}>
                    這個瀏覽器不支援音訊播放。
                  </audio>
                </div>
              ) : preview.kind === 'video' && preview.objectUrl ? (
                <div className="legacy-file-media-frame legacy-file-video-frame">
                  <video controls preload="metadata" src={preview.objectUrl}>
                    這個瀏覽器不支援影片播放。
                  </video>
                </div>
              ) : preview.kind === 'markdown' ? (
                <div className="markdown markdown-doc legacy-file-markdown">
                  <Markdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins}>
                    {normalizeMarkdownMath(preview.content)}
                  </Markdown>
                </div>
              ) : preview.kind === 'text' ? (
                <pre className="legacy-file-text-preview">{preview.content}</pre>
              ) : (
                <div className="placeholder">
                  <p>不支援預覽此檔案</p>
                </div>
              )}
            </div>
          </section>
        </div>
      ) : null}

      {legacyMenu !== null ? (
        <ContextMenu
          x={legacyMenu.x}
          y={legacyMenu.y}
          title={legacyMenu.kind === 'item' ? legacyMenu.item.name : '新增'}
          subtitle={legacyMenu.kind === 'item' ? legacyMenu.item.path : currentLegacyDir}
          actions={legacyMenu.kind === 'item' ? legacyItemMenuActions : legacyBlankMenuActions}
          onSelect={runLegacyMenuAction}
          onClose={() => setLegacyMenu(null)}
        />
      ) : null}

      {legacyDialog !== null ? (
        <div className="modal-overlay" onClick={() => setLegacyDialog(null)}>
          <div className="modal modal-narrow" onClick={(event) => event.stopPropagation()}>
            {legacyDialog.kind === 'delete' ? (
              <>
                <div className="modal-head">
                  <h2>確認刪除</h2>
                  <button className="modal-close" type="button" onClick={() => setLegacyDialog(null)}>
                    ×
                  </button>
                </div>
                <p>
                  確定要刪除 <span className="mono">{legacyDialog.item.path}</span>？
                  {legacyDialog.item.isDirectory ? ' 這會刪除資料夾與其中所有內容。' : ''}
                </p>
                <div className="form-actions">
                  <button type="button" onClick={() => setLegacyDialog(null)}>
                    取消
                  </button>
                  <button
                    className="danger"
                    type="button"
                    disabled={legacyBusy}
                    onClick={() => void confirmLegacyDialog()}
                  >
                    刪除
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="modal-head">
                  <h2>{legacyDialog.kind === 'new-folder' ? '新增資料夾' : '重新命名'}</h2>
                  <button className="modal-close" type="button" onClick={() => setLegacyDialog(null)}>
                    ×
                  </button>
                </div>
                <p className="hint">
                  {legacyDialog.kind === 'new-folder'
                    ? `位置：${legacyDialog.dir}`
                    : `原名稱：${legacyDialog.item.name}`}
                </p>
                <input
                  autoFocus
                  value={legacyDialogInput}
                  placeholder={legacyDialog.kind === 'new-folder' ? '資料夾名稱' : legacyDialog.item.name}
                  onChange={(event) => setLegacyDialogInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void confirmLegacyDialog();
                  }}
                />
                <div className="form-actions">
                  <button type="button" onClick={() => setLegacyDialog(null)}>
                    取消
                  </button>
                  <button
                    className="primary"
                    type="button"
                    disabled={legacyBusy || legacyDialogInput.trim() === ''}
                    onClick={() => void confirmLegacyDialog()}
                  >
                    確定
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function BridgeFilesWorkspace({ active = false, connected }: FilesWorkspaceProps) {
  const bridge = useMemo(() => getBridge(), []);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [homePath, setHomePath] = useState<string | null>(null);
  const [children, setChildren] = useState<Record<string, RemoteFileItem[]>>({});
  const [truncatedDirs, setTruncatedDirs] = useState<Set<string>>(new Set());
  const [jumpOpen, setJumpOpen] = useState(false);
  const [jumpValue, setJumpValue] = useState('');
  const [menu, setMenu] = useState<{ item: RemoteFileItem; x: number; y: number } | null>(
    null,
  );
  /** openPath 定義在 confirmDiscard 之前，用 ref 打通順序。 */
  const confirmDiscardRef = useRef<() => boolean>(() => true);
  /** 遠端剪貼簿：Copy/Move 兩段式操作的暫存（Flutter 版同款行為）。 */
  const [clipboard, setClipboard] = useState<{
    item: RemoteFileItem;
    mode: 'copy' | 'move';
  } | null>(null);
  const [selected, setSelected] = useState<RemoteFileItem | null>(null);
  const [draft, setDraft] = useState<{ path: string; text: string; saved: string } | null>(
    null,
  );
  const [pdfData, setPdfData] = useState<{ path: string; dataBase64: string } | null>(null);
  const [mdPreview, setMdPreview] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pwd, setPwd] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [dialogInput, setDialogInput] = useState('');

  const showFlash = (message: string) => {
    setFlash(message);
    setTimeout(() => setFlash(null), 1600);
  };

  const report = (err: unknown) => {
    setError(err instanceof Error ? err.message : String(err));
  };

  const loadDir = useCallback(
    async (path: string): Promise<string | null> => {
      try {
        const listing = await bridge.fsList({ path });
        setChildren((current) => ({ ...current, [listing.path]: listing.items }));
        setTruncatedDirs((current) => {
          const next = new Set(current);
          if (listing.truncated) next.add(listing.path);
          else next.delete(listing.path);
          return next;
        });
        setError(null);
        return listing.path;
      } catch (err: unknown) {
        report(err);
        return null;
      }
    },
    [bridge],
  );

  /** 切換目前目錄（Home、/、breadcrumb 或任意路徑）。 */
  const openPath = useCallback(
    async (path: string) => {
      if (!confirmDiscardRef.current()) return;
      const resolved = await loadDir(path);
      if (resolved === null) return;
      setCurrentPath(resolved);
      setSelected(null);
      setDraft(null);
      setPdfData(null);
    },
    [loadDir],
  );

  useEffect(() => {
    if (!connected) {
      setCurrentPath(null);
      setChildren({});
      setSelected(null);
      setDraft(null);
      setPwd(null);
      return;
    }
    void loadDir('~').then((resolved) => {
      if (resolved !== null) {
        setCurrentPath(resolved);
        setHomePath(resolved);
        setPwd(resolved);
      }
    });
  }, [connected, loadDir]);

  /** symlink：指向目錄就跳過去，指向檔案就開目標。 */
  const followSymlink = (item: RemoteFileItem) => {
    const target = item.linkTarget;
    if (target === undefined || item.targetType === 'N') {
      setError(`連結目標不存在：${target ?? '(未知)'}`);
      return;
    }
    const absolute = target.startsWith('/')
      ? target
      : `${parentOf(item.path)}/${target}`;
    if (item.targetType === 'd') {
      void openPath(absolute);
      showFlash('已跳到連結目標');
      return;
    }
    void bridge
      .fsList({ path: parentOf(absolute) })
      .then((listing) => {
        const found = listing.items.find((entry) => entry.path === absolute);
        if (found) openFile(found);
        else setError(`找不到連結目標：${absolute}`);
      })
      .catch(report);
  };

  /** 有未存檔變更時先確認，避免切換檔案靜默丟失編輯內容。 */
  const confirmDiscard = (): boolean => {
    if (draft === null || draft.text === draft.saved) return true;
    return window.confirm(
      `${draft.path.slice(draft.path.lastIndexOf('/') + 1)} 有未儲存的變更，要放棄嗎？`,
    );
  };

  const openFile = (item: RemoteFileItem) => {
    if (!confirmDiscard()) return;
    if (item.type === 'l') {
      setSelected(item);
      setDraft(null);
      setPdfData(null);
      return;
    }
    setSelected(item);
    setDraft(null);
    setPdfData(null);
    setMdPreview(false);

    if (isPdf(item)) {
      setBusy(true);
      void bridge
        .fsReadBytes({ path: item.path })
        .then(({ dataBase64 }) => setPdfData({ path: item.path, dataBase64 }))
        .catch(report)
        .finally(() => setBusy(false));
      return;
    }

    if (!isTextFile(item) || item.sizeBytes > MAX_EDITOR_BYTES) return;
    void bridge
      .fsRead({ path: item.path, maxBytes: MAX_EDITOR_BYTES, offset: 0 })
      .then(({ content }) => {
        setDraft({ path: item.path, text: content, saved: content });
        if (isMarkdown(item)) setMdPreview(true);
      })
      .catch(report);
  };

  const refreshDirs = async (...paths: (string | null)[]) => {
    for (const path of paths) {
      if (path !== null && (children[path] !== undefined || path === currentPath)) {
        await loadDir(path);
      }
    }
  };

  const saveDraft = () => {
    if (!draft) return;
    setBusy(true);
    bridge
      .fsWrite({ path: draft.path, contentBase64: textToBase64(draft.text) })
      .then(() => {
        setDraft((current) => (current ? { ...current, saved: current.text } : current));
        showFlash('已儲存');
        void refreshDirs(parentOf(draft.path));
      })
      .catch(report)
      .finally(() => setBusy(false));
  };

  const download = (target?: RemoteFileItem) => {
    const item = target ?? selected;
    if (!item || item.type === 'd') return;
    setBusy(true);
    bridge
      .fsReadBytes({ path: item.path })
      .then(async ({ dataBase64 }) => {
        const request = {
          fileName: item.name,
          dataBase64,
          mimeType: mimeTypeForFileName(item.name),
        };
        if (bridge.saveDownload !== undefined) {
          const result = await bridge.saveDownload(request);
          if (!result.cancelled) showFlash(`已下載 ${result.fileName}`);
          return;
        }
        saveWithBrowserDownload(request);
        showFlash(`已開始下載 ${item.name}`);
      })
      .catch(report)
      .finally(() => setBusy(false));
  };

  const duplicate = (target?: RemoteFileItem) => {
    const item = target ?? selected;
    if (!item) return;
    setBusy(true);
    bridge
      .fsDuplicate({ path: item.path })
      .then(() => {
        showFlash('已建立副本');
        void refreshDirs(parentOf(item.path));
      })
      .catch(report)
      .finally(() => setBusy(false));
  };

  const confirmDialog = () => {
    if (dialog === null) return;
    const input = dialogInput.trim();
    setBusy(true);
    const done = (message: string, ...refresh: (string | null)[]) => {
      showFlash(message);
      setDialog(null);
      setDialogInput('');
      void refreshDirs(...refresh);
    };

    let action: Promise<void>;
    if (dialog.kind === 'new-file' || dialog.kind === 'new-folder') {
      if (input === '') {
        setBusy(false);
        return;
      }
      action = bridge
        .fsCreate({
          directory: dialog.dir,
          name: input,
          kind: dialog.kind === 'new-file' ? 'file' : 'directory',
        })
        .then(() => done(dialog.kind === 'new-file' ? '已建立檔案' : '已建立資料夾', dialog.dir));
    } else if (dialog.kind === 'rename') {
      if (input === '') {
        setBusy(false);
        return;
      }
      action = bridge
        .fsRename({ path: dialog.item.path, newName: input })
        .then(() => {
          setSelected(null);
          setDraft(null);
          done('已重新命名', parentOf(dialog.item.path));
        });
    } else if (dialog.kind === 'move' || dialog.kind === 'copy-to') {
      if (input === '') {
        setBusy(false);
        return;
      }
      const call =
        dialog.kind === 'move'
          ? bridge.fsMove({ sourcePath: dialog.item.path, destinationDirectory: input })
          : bridge.fsCopy({ sourcePath: dialog.item.path, destinationDirectory: input });
      action = call.then(({ path }) => {
        if (dialog.kind === 'move') {
          setSelected(null);
          setDraft(null);
        }
        done(dialog.kind === 'move' ? '已移動' : '已複製', parentOf(dialog.item.path), parentOf(path));
      });
    } else {
      action = bridge.fsDelete({ path: dialog.item.path }).then(() => {
        setSelected(null);
        setDraft(null);
        done('已刪除', parentOf(dialog.item.path));
      });
    }
    action.catch(report).finally(() => setBusy(false));
  };

  const currentDir = currentPath ?? pwd ?? '~';

  const dirty = draft !== null && draft.text !== draft.saved;
  confirmDiscardRef.current = confirmDiscard;
  const canGoBridgeParent = active && connected && currentPath !== null && currentPath !== '/';
  const goBridgeParent = useCallback(() => {
    if (currentPath === null || currentPath === '/') return;
    void openPath(parentOf(currentPath));
  }, [currentPath, openPath]);

  useFileBackShortcut(active, canGoBridgeParent, goBridgeParent);

  // 有未存檔內容時關閉 app／重新整理要先提醒。
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const renderListing = (dirPath: string) => {
    const items = directoryItems(children, dirPath);
    if (items === undefined) {
      return <div className="hint tree-loading">載入中…</div>;
    }
    const rows = items.map((item) => {
      const isDir = item.type === 'd';
      const kind = fileKindOf(item);
      return (
        <div key={item.path}>
          <TreeRow
            item={item}
            className={`tree-row${selected?.path === item.path ? ' tree-row-active' : ''}`}
            onOpenMenu={(x, y) => setMenu({ item, x, y })}
            onClick={() => {
              if (isDir) void openPath(item.path);
              else openFile(item);
            }}
            onDoubleClick={() => {
              if (item.type === 'l') followSymlink(item);
            }}
            title={
              item.type === 'l'
                ? `${item.path} → ${item.linkTarget ?? '?'}（雙擊跳轉）`
                : `${item.path}（右鍵或長按顯示選單）`
            }
          >
            <span className={`tree-caret${isDir ? '' : ' tree-caret-empty'}`}>
              {isDir ? '›' : ''}
            </span>
            <FileIcon kind={kind} />
            <span className="tree-name">{item.name}</span>
            {item.type === 'l' ? <span className="tree-arrow">→</span> : null}
            {item.executable === true && item.type === 'f' ? (
              <span className="tree-badge tree-badge-exec">x</span>
            ) : null}
            {item.path === pwd ? <span className="pwd-badge">pwd</span> : null}
          </TreeRow>
        </div>
      );
    });

    if (truncatedDirs.has(dirPath)) {
      rows.push(
        <div key={`${dirPath}__truncated`} className="hint tree-truncated">
          僅顯示前 2000 筆（目錄過大）
        </div>,
      );
    }
    return rows;
  };

  const copyToClipboardText = (text: string, label: string) => {
    void bridge
      .writeClipboard(text)
      .then(() => showFlash(label))
      .catch(report);
  };

  const relativePath = (item: RemoteFileItem): string => {
    const base = currentPath;
    if (base !== null && item.path.startsWith(`${base}/`)) {
      return item.path.slice(base.length + 1);
    }
    return item.name;
  };

  const menuActionsFor = (item: RemoteFileItem): MenuAction[] => {
    const isDir = item.type === 'd';
    const isLink = item.type === 'l';
    return [
      {
        id: 'open',
        label: isDir ? 'Open folder' : isLink ? 'Follow link' : 'Open / edit file',
      },
      { id: 'rename', label: 'Rename', separatorBefore: true },
      { id: 'stageCopy', label: 'Copy', hint: '暫存後貼到其他資料夾' },
      { id: 'stageMove', label: 'Move', hint: '暫存後貼到其他資料夾' },
      { id: 'duplicate', label: 'Duplicate here', hint: '在同資料夾建立副本' },
      { id: 'copyName', label: 'Copy name', separatorBefore: true },
      { id: 'copyAbs', label: 'Copy abs path' },
      { id: 'copyRel', label: 'Copy rel path' },
      ...(isDir
        ? [{ id: 'setPwd', label: 'Set PWD', hint: '新 Terminal／Agent 分頁的工作目錄' }]
        : []),
      ...(item.type === 'f'
        ? [{ id: 'download', label: 'Download', separatorBefore: true }]
        : []),
      { id: 'delete', label: 'Delete', danger: true, separatorBefore: true },
    ];
  };

  const runMenuAction = (item: RemoteFileItem, actionId: string) => {
    switch (actionId) {
      case 'open':
        if (item.type === 'd') {
          void openPath(item.path);
        } else if (item.type === 'l') {
          followSymlink(item);
        } else {
          openFile(item);
        }
        return;
      case 'rename':
        setDialogInput(item.name);
        setDialog({ kind: 'rename', item });
        return;
      case 'stageCopy':
        setClipboard({ item, mode: 'copy' });
        showFlash(`已暫存複製：${item.name}`);
        return;
      case 'stageMove':
        setClipboard({ item, mode: 'move' });
        showFlash(`已暫存移動：${item.name}`);
        return;
      case 'duplicate':
        setSelected(item);
        duplicate(item);
        return;
      case 'copyName':
        copyToClipboardText(item.name, '已複製檔名');
        return;
      case 'copyAbs':
        copyToClipboardText(item.path, '已複製絕對路徑');
        return;
      case 'copyRel':
        copyToClipboardText(relativePath(item), '已複製相對路徑');
        return;
      case 'setPwd':
        setPwd(item.path);
        showFlash('已設定 pwd');
        return;
      case 'download':
        setSelected(item);
        setTimeout(() => download(item), 0);
        return;
      case 'delete':
        setDialog({ kind: 'delete', item });
        return;
    }
  };

  /** 把暫存的項目貼進目標資料夾（Copy/Move 的第二段）。 */
  const pasteClipboard = (destination: string) => {
    if (clipboard === null) return;
    const { item, mode } = clipboard;
    setBusy(true);
    const call =
      mode === 'copy'
        ? bridge.fsCopy({ sourcePath: item.path, destinationDirectory: destination })
        : bridge.fsMove({ sourcePath: item.path, destinationDirectory: destination });
    void call
      .then(({ path }) => {
        showFlash(mode === 'copy' ? '已複製' : '已移動');
        if (mode === 'move') {
          setClipboard(null);
          if (selected?.path === item.path) {
            setSelected(null);
            setDraft(null);
          }
        }
        void refreshDirs(parentOf(item.path), parentOf(path), destination);
      })
      .catch(report)
      .finally(() => setBusy(false));
  };

  const breadcrumbs = buildFileBreadcrumbs(currentDir);


  if (!connected) {
    return (
      <div className="placeholder">
        <p>Connect to browse remote files.</p>
        <p className="hint">連線後從家目錄開始瀏覽。</p>
      </div>
    );
  }

  return (
    <div className="files-workspace">
      <aside className="files-tree">
        <div className="files-roots">
          <button
            className={currentPath !== null && currentPath === homePath ? 'root-active' : ''}
            onClick={() => void openPath('~')}
            title="家目錄"
          >
            ⌂ Home
          </button>
          <button
            className={currentPath === '/' ? 'root-active' : ''}
            onClick={() => void openPath('/')}
            title="根目錄"
          >
            / Root
          </button>
          {pwd !== null && pwd !== currentPath ? (
            <button onClick={() => void openPath(pwd)} title="切換到 pwd">
              ↦ pwd
            </button>
          ) : null}
          <button
            onClick={() => {
              setJumpValue(currentDir);
              setJumpOpen(true);
            }}
            title="跳到指定路徑"
          >
            ⤓ 路徑…
          </button>
        </div>
        <div className="files-toolbar">
          <button onClick={() => setDialog({ kind: 'new-file', dir: currentDir })}>
            ＋檔案
          </button>
          <button onClick={() => setDialog({ kind: 'new-folder', dir: currentDir })}>
            ＋資料夾
          </button>
          <button onClick={() => void refreshDirs(...Object.keys(children))} title="重新整理">
            ↻
          </button>
        </div>
        {clipboard !== null ? (
          <div className="clipboard-bar">
            <span className={`clip-mode clip-${clipboard.mode}`}>
              {clipboard.mode === 'copy' ? '複製' : '移動'}
            </span>
            <span className="clip-name" title={clipboard.item.path}>
              {clipboard.item.name}
            </span>
            <button
              className="primary"
              disabled={busy}
              title={`貼到 ${currentDir}`}
              onClick={() => pasteClipboard(currentDir)}
            >
              貼到此處
            </button>
            <button className="clip-cancel" onClick={() => setClipboard(null)} title="取消">
              ×
            </button>
          </div>
        ) : null}
        <div className="tree-scroll">
          {currentPath !== null ? (
            <>
              <button
                className={`tree-row tree-root-row${selected === null ? ' tree-row-active' : ''}`}
                onClick={() => void refreshDirs(currentPath)}
                title={`${currentPath}（重新整理）`}
              >
                <span className="tree-caret">↻</span>
                <FileIcon kind="folder-open" />
                <span className="tree-name mono">{currentPath}</span>
              </button>
              {currentPath !== '/' ? (
                <button
                  className="tree-row tree-parent-row"
                  onClick={() => void openPath(parentOf(currentPath))}
                  title={parentOf(currentPath)}
                >
                  <span className="tree-caret">↑</span>
                  <FileIcon kind="folder" />
                  <span className="tree-name">..</span>
                </button>
              ) : null}
              {renderListing(currentPath)}
            </>
          ) : (
            <div className="hint tree-loading">載入中…</div>
          )}
        </div>
      </aside>
      <div className="files-preview">
        <div className="breadcrumb-bar">
          <button
            className="crumb files-copy-path-crumb"
            type="button"
            onClick={() => copyToClipboardText(currentDir, '路徑已複製')}
            title={currentDir}
          >
            Copy path
          </button>
          {breadcrumbs.map((crumb, index) => (
            <span key={crumb.path} className="crumb-wrap">
              {index > 0 ? <span className="crumb-sep">/</span> : null}
              <button className="crumb" onClick={() => void openPath(crumb.path)}>
                {crumb.label}
              </button>
            </span>
          ))}
        </div>
        {error ? <div className="error-banner">{error}</div> : null}
        {selected ? (
          <>
            <div className="files-preview-head">
              <span className="mono files-path">{selected.path}</span>
              {flash ? <span className="flash">{flash}</span> : null}
              <div className="files-actions">
                {selected.type === 'd' ? (
                  <button onClick={() => setPwd(selected.path)}>Set pwd</button>
                ) : null}
                {draft ? (
                  <button className={dirty ? 'primary' : ''} disabled={busy} onClick={saveDraft}>
                    儲存{dirty ? ' •' : ''}
                  </button>
                ) : null}
                {draft && isMarkdown(selected) ? (
                  <button onClick={() => setMdPreview((preview) => !preview)}>
                    {mdPreview ? '編輯' : '預覽'}
                  </button>
                ) : null}
                <button onClick={() => copyToClipboardText(selected.path, '路徑已複製')}>
                  Copy path
                </button>
                <button disabled={busy} onClick={() => duplicate()}>
                  Copy
                </button>
                <button onClick={() => setDialog({ kind: 'copy-to', item: selected })}>
                  Copy to…
                </button>
                <button onClick={() => setDialog({ kind: 'move', item: selected })}>
                  Move
                </button>
                <button onClick={() => setDialog({ kind: 'rename', item: selected })}>
                  Rename
                </button>
                {selected.type !== 'd' ? (
                  <button disabled={busy} onClick={() => download()}>
                    Download
                  </button>
                ) : null}
                <button
                  className="danger"
                  onClick={() => setDialog({ kind: 'delete', item: selected })}
                >
                  Delete
                </button>
              </div>
            </div>
            {selected.type === 'l' ? (
              <div className="placeholder link-card">
                <p>
                  <FileIcon kind={fileKindOf(selected)} size={22} />
                </p>
                <p className="mono link-target">→ {selected.linkTarget ?? '(未知目標)'}</p>
                <p className="hint">
                  {selected.targetType === 'd'
                    ? '指向資料夾'
                    : selected.targetType === 'N'
                      ? '目標不存在（斷鏈）'
                      : '指向檔案'}
                </p>
                <button
                  className="primary"
                  disabled={selected.targetType === 'N'}
                  onClick={() => followSymlink(selected)}
                >
                  跳到目標
                </button>
              </div>
            ) : selected.type === 'd' ? (
              <div className="placeholder">
                <p>{children[selected.path]?.length ?? '…'} 個項目</p>
                <p className="hint">pwd: {pwd ?? '—'}</p>
              </div>
            ) : isPdf(selected) ? (
              pdfData && pdfData.path === selected.path ? (
                <PdfViewer dataBase64={pdfData.dataBase64} fileName={selected.name} />
              ) : (
                <div className="placeholder">
                  <p>載入 PDF…</p>
                </div>
              )
            ) : draft && isMarkdown(selected) && mdPreview ? (
              <div className="md-preview markdown markdown-doc">
                <Markdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins}>
                  {normalizeMarkdownMath(draft.text)}
                </Markdown>
              </div>
            ) : draft ? (
              <CodeEditor
                path={draft.path}
                value={draft.text}
                onChange={(text) =>
                  setDraft((current) => (current ? { ...current, text } : current))
                }
                onSave={saveDraft}
              />
            ) : (
              <div className="placeholder">
                <p>{selected.name}</p>
                <p className="hint">
                  {(selected.sizeBytes / 1024).toFixed(1)} KB · {selected.modified} ·
                  {isTextFile(selected)
                    ? ' 檔案過大，僅供 Download'
                    : ' 二進位格式不做文字預覽（SPEC FR-04）'}
                </p>
              </div>
            )}
          </>
        ) : (
          <div className="placeholder">
            <p>選一個檔案或資料夾。</p>
          </div>
        )}
      </div>

      {menu !== null ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          title={menu.item.name}
          subtitle={menu.item.path}
          actions={menuActionsFor(menu.item)}
          onSelect={(actionId) => runMenuAction(menu.item, actionId)}
          onClose={() => setMenu(null)}
        />
      ) : null}

      {jumpOpen ? (
        <div className="modal-overlay" onClick={() => setJumpOpen(false)}>
          <div className="modal modal-narrow" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h2>跳到路徑</h2>
              <button className="modal-close" onClick={() => setJumpOpen(false)}>
                ×
              </button>
            </div>
            <input
              autoFocus
              className="mono"
              value={jumpValue}
              placeholder="/var/log 或 ~/projects"
              onChange={(event) => setJumpValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && jumpValue.trim() !== '') {
                  void openPath(jumpValue.trim());
                  setJumpOpen(false);
                }
              }}
            />
            <p className="hint">支援 ~ 展開；只讀取該層目錄，不遞迴掃描。</p>
            <div className="form-actions">
              <button onClick={() => setJumpOpen(false)}>取消</button>
              <button
                className="primary"
                disabled={jumpValue.trim() === ''}
                onClick={() => {
                  void openPath(jumpValue.trim());
                  setJumpOpen(false);
                }}
              >
                前往
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {dialog ? (
        <div className="modal-overlay" onClick={() => setDialog(null)}>
          <div className="modal modal-narrow" onClick={(event) => event.stopPropagation()}>
            {dialog.kind === 'delete' ? (
              <>
                <p>
                  確定刪除 <span className="mono">{dialog.item.path}</span>？
                  {dialog.item.type === 'd' ? '（含其中所有內容）' : ''}
                </p>
                <div className="form-actions">
                  <button onClick={() => setDialog(null)}>取消</button>
                  <button className="danger" disabled={busy} onClick={confirmDialog}>
                    刪除
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>
                  {dialog.kind === 'new-file'
                    ? `在 ${dialog.dir} 新增檔案`
                    : dialog.kind === 'new-folder'
                      ? `在 ${dialog.dir} 新增資料夾`
                      : dialog.kind === 'rename'
                        ? `重新命名 ${dialog.item.name}`
                        : dialog.kind === 'move'
                          ? `把 ${dialog.item.name} 移動到（目標資料夾路徑）`
                          : `把 ${dialog.item.name} 複製到（目標資料夾路徑）`}
                </p>
                <input
                  autoFocus
                  value={dialogInput}
                  placeholder={
                    dialog.kind === 'move' || dialog.kind === 'copy-to'
                      ? currentDir
                      : dialog.kind === 'rename'
                        ? dialog.item.name
                        : '名稱'
                  }
                  onChange={(event) => setDialogInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') confirmDialog();
                  }}
                />
                <div className="form-actions">
                  <button onClick={() => setDialog(null)}>取消</button>
                  <button className="primary" disabled={busy} onClick={confirmDialog}>
                    確定
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function FilesWorkspace({ active = false, connected, profileId = null }: FilesWorkspaceProps) {
  return (
    <LegacyServerFilesWorkspace
      active={active}
      bridgeConnected={connected}
      profileId={profileId}
    />
  );
}
