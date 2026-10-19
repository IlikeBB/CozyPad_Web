import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, FolderUp, LoaderCircle, RotateCw } from 'lucide-react';
import type { FileEntry, ServerProfile } from '@cozypad/contracts';
import { displayDirectoryPath } from '@cozypad/contracts';
import { api, message, post, serverQuery } from '../api';
import { IconButton } from './Controls';

export function AgentFileExplorer({ server, path, contextKey, enabled, disabled, onPath, onFile, onBusy }: {
  server: ServerProfile; path: string; contextKey: string; enabled: boolean; disabled: boolean;
  onPath: (path: string) => void; onFile: (entry: FileEntry) => void; onBusy: (busy: boolean) => void;
}) {
  const [root, setRoot] = useState(''), [entries, setEntries] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState(new Set<string>()), [pending, setPending] = useState(''), [error, setError] = useState('');
  const request = useRef(0), rootPath = useRef(''), scope = useRef(''), chosen = useRef('');
  const callbacks = useRef({ onPath, onFile }); callbacks.current = { onPath, onFile };
  useEffect(() => () => { request.current++; onBusy(false); }, [onBusy]);

  const loadRoot = async (target: string, select = false, current = ++request.current) => {
    setPending(target); setError(''); onBusy(select);
    try {
      const result = await api<{ path: string; entries: FileEntry[] }>(`/files?${serverQuery(server.id, target)}`);
      if (current !== request.current) return;
      let resolved = result.path;
      if (select) {
        const selected = await post<{ path: string }>('/agents/directories', { serverId: server.id, path: result.path });
        if (current !== request.current) return; resolved = selected.path;
      }
      rootPath.current = resolved; chosen.current = select || path === target ? resolved : path;
      setRoot(resolved); setEntries({ [resolved]: result.entries }); setExpanded(new Set([resolved]));
      if (select || path === target) callbacks.current.onPath(resolved);
    } catch (error) { if (current === request.current) setError(message(error)); }
    finally { if (current === request.current) { setPending(''); onBusy(false); } }
  };
  useEffect(() => {
    const context = `${server.id}:${contextKey}`;
    if (scope.current !== context) {
      request.current++; onBusy(false); scope.current = context; rootPath.current = ''; setRoot(''); setEntries({}); setExpanded(new Set()); setPending(''); setError('');
    }
    if (!enabled) return;
    const within = path === rootPath.current || path.startsWith(`${rootPath.current}/`);
    if (!rootPath.current || (!within && path !== chosen.current)) {
      const current = ++request.current; setPending(path);
      const timer = window.setTimeout(() => void loadRoot(path, false, current), 250);
      return () => {
        window.clearTimeout(timer);
        if (current === request.current) { request.current++; setPending(''); onBusy(false); }
      };
    }
  }, [server.id, contextKey, path, enabled]);

  const open = async (entry: FileEntry) => {
    if (disabled) return;
    const current = ++request.current; setPending(entry.path); setError(''); onBusy(true);
    try {
      const target = entry.directory ? entry.path : entry.path.slice(0, entry.path.lastIndexOf('/')) || '/';
      const result = target === path ? { path } : await post<{ path: string }>('/agents/directories', { serverId: server.id, path: target });
      if (current !== request.current) return;
      if (entry.directory) {
        let children = entries[entry.path];
        if (!children) {
          const loaded = (await api<{ entries: FileEntry[] }>(`/files?${serverQuery(server.id, entry.path)}`)).entries;
          if (current !== request.current) return;
          setEntries(previous => ({ ...previous, [entry.path]: loaded }));
        }
        setExpanded(previous => { const next = new Set(previous); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; });
      }
      chosen.current = result.path; callbacks.current.onPath(result.path);
      if (!entry.directory) callbacks.current.onFile(entry);
    } catch (error) { if (current === request.current) setError(message(error)); }
    finally { if (current === request.current) { setPending(''); onBusy(false); } }
  };
  const rows = (directory: string, depth = 0): React.ReactNode => entries[directory]?.map(entry => <div key={entry.path} role="none">
    <button type="button" role="treeitem" aria-label={`${entry.directory ? '資料夾' : '檔案'} ${entry.name}`} aria-level={depth + 1}
      aria-expanded={entry.directory ? expanded.has(entry.path) : undefined} aria-selected={entry.directory && path === entry.path}
      className={`explorer-entry ${entry.directory && path === entry.path ? 'selected' : ''}`} style={{ paddingLeft: 10 + depth * 14 }}
      title={displayDirectoryPath(entry.path, server.platform)} disabled={disabled} onClick={() => void open(entry)}>
      {pending === entry.path ? <LoaderCircle size={14} className="spin" /> : entry.directory ? expanded.has(entry.path) ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : <span className="explorer-indent" />}
      {entry.directory ? expanded.has(entry.path) ? <FolderOpen size={16} className="folder-icon" /> : <Folder size={16} className="folder-icon" /> : <FileText size={16} className="muted" />}<span>{entry.name}</span>
    </button>
    {entry.directory && expanded.has(entry.path) && <div role="group">{rows(entry.path, depth + 1)}{entries[entry.path]?.length === 0 && <p className="explorer-empty" style={{ paddingLeft: 38 + depth * 14 }}>空目錄</p>}</div>}
  </div>);
  return <div className="agent-explorer">
    <div className="explorer-toolbar"><span title={displayDirectoryPath(path, server.platform)}>{displayDirectoryPath(path, server.platform)}</span>
      <IconButton label="檔案總管上一層" disabled={disabled || !root || !!pending || root === '/'} onClick={() => void loadRoot(root.slice(0, root.lastIndexOf('/')) || '/', true)}><FolderUp size={15} /></IconButton>
      <IconButton label="重新整理檔案總管" disabled={disabled || !!pending} onClick={() => void loadRoot(root || path)}><RotateCw size={15} /></IconButton>
    </div>
    {error && <p className="error explorer-error" role="alert">{error}</p>}
    <div className="explorer-tree" role="tree" aria-label="目前工作目錄檔案">
      {root && <button type="button" className={`explorer-root ${path === root ? 'selected' : ''}`} title={root} disabled={disabled || !!pending} onClick={() => void loadRoot(root, true)}><FolderOpen size={16} /><strong>{root.split('/').at(-1) || '/'}</strong></button>}
      {root && expanded.has(root) && rows(root)}
      {!!pending && !root && <p className="explorer-empty"><LoaderCircle size={15} className="spin" />讀取目錄…</p>}
      {root && entries[root]?.length === 0 && !pending && <p className="explorer-empty">空目錄</p>}
    </div>
    <div className="explorer-hint">點選資料夾切換 pwd；點選檔案預覽內容。</div>
  </div>;
}
