import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Folder, FolderInput, FolderOpen, FolderUp, LoaderCircle, RotateCw } from 'lucide-react';
import type { FileEntry, ServerProfile } from '@cozypad/contracts';
import { displayDirectoryPath } from '@cozypad/contracts';
import { api, message, post, serverQuery } from '../api';
import { IconButton } from './Controls';
import { useFileMove, parentDirectory, type FileMove } from './use-file-move';
import { FileMoveDialog } from './FileMoveDialog';
import { pathAfterMove, treeAfterMove } from '../../../../packages/contracts/src/file-moves.mjs';

export function AgentFileExplorer({ server, path, contextKey, enabled, disabled, onPath, onFile, onBusy, onFileMoved, onMoving }: {
  server: ServerProfile; path: string; contextKey: string; enabled: boolean; disabled: boolean;
  onPath: (path: string) => void; onFile: (entry: FileEntry) => void; onBusy: (busy: boolean) => void;
  onFileMoved: (result: FileMove) => void; onMoving: (moving: boolean) => void;
}) {
  const [root, setRoot] = useState(''), [entries, setEntries] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState(new Set<string>()), [pending, setPending] = useState(''), [error, setError] = useState('');
  const [notice, setNotice] = useState(''), [moveTarget, setMoveTarget] = useState<FileEntry | null>(null);
  const request = useRef(0), rootPath = useRef(''), scope = useRef(''), chosen = useRef('');
  const listings = useRef(new Map<string, Promise<{ path: string; entries: FileEntry[] }>>());
  const list = (target: string) => {
    const key = `${server.id}:${target}`;
    const existing = listings.current.get(key); if (existing) return existing;
    const work = api<{ path: string; entries: FileEntry[] }>(`/files?${serverQuery(server.id, target)}`).finally(() => { if (listings.current.get(key) === work) listings.current.delete(key); });
    listings.current.set(key, work); return work;
  };
  const callbacks = useRef({ onPath, onFile }); callbacks.current = { onPath, onFile };
  useEffect(() => () => { request.current++; onBusy(false); }, [onBusy]);
  const moves = useFileMove({ serverId: server.id, disabled: disabled || !!pending, onError: setError, onNotice: setNotice, onBusy: value => { onBusy(value); onMoving(value); }, onMoved: async result => {
    setEntries(previous => treeAfterMove(previous, result));
    setExpanded(previous => new Set([...previous].map(directory => pathAfterMove(directory, result))));
    rootPath.current = pathAfterMove(rootPath.current, result); chosen.current = pathAfterMove(chosen.current, result);
    setRoot(previous => pathAfterMove(previous, result));
    onFileMoved(result);
  } });
  const unavailable = disabled || moves.moving;

  const loadRoot = async (target: string, select = false, current = ++request.current) => {
    setPending(target); setError(''); onBusy(select);
    try {
      const [result, selected] = await Promise.all([
        list(target),
        select ? post<{ path: string }>('/agents/directories', { serverId: server.id, path: target }) : Promise.resolve(null)
      ]);
      if (current !== request.current) return;
      const resolved = selected?.path || result.path;
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
      let cancelled = false;
      queueMicrotask(() => { if (!cancelled && current === request.current) void loadRoot(path, false, current); });
      return () => {
        cancelled = true;
        if (current === request.current) { request.current++; setPending(''); onBusy(false); }
      };
    }
  }, [server.id, contextKey, path, enabled]);

  const open = async (entry: FileEntry) => {
    if (unavailable) return;
    const current = ++request.current; setPending(entry.path); setError(''); onBusy(true);
    try {
      const target = entry.directory ? entry.path : entry.path.slice(0, entry.path.lastIndexOf('/')) || '/';
      // Listing and cwd validation use independent SFTP channels on the same
      // authenticated connection. Neither needs to wait for the other.
      const [result, children] = await Promise.all([
        target === path ? Promise.resolve({ path }) : post<{ path: string }>('/agents/directories', { serverId: server.id, path: target }),
        entry.directory && !entries[entry.path] ? list(entry.path) : Promise.resolve(null)
      ]);
      if (current !== request.current) return;
      if (entry.directory) {
        if (children) setEntries(previous => ({ ...previous, [entry.path]: children.entries }));
        setExpanded(previous => { const next = new Set(previous); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; });
      }
      chosen.current = result.path; callbacks.current.onPath(result.path);
      if (!entry.directory) callbacks.current.onFile(entry);
    } catch (error) { if (current === request.current) setError(message(error)); }
    finally { if (current === request.current) { setPending(''); onBusy(false); } }
  };
  const rows = (directory: string, depth = 0): React.ReactNode => entries[directory]?.map(entry => <div key={entry.path} role="none">
    <div className="explorer-row">
    <button type="button" role="treeitem" aria-label={`${entry.directory ? '資料夾' : '檔案'} ${entry.name}`} aria-level={depth + 1}
      {...moves.sourceProps(entry)} {...(entry.directory ? moves.targetProps(entry.path) : {})}
      aria-expanded={entry.directory ? expanded.has(entry.path) : undefined} aria-selected={entry.directory && path === entry.path}
      className={`explorer-entry ${entry.directory && path === entry.path ? 'selected' : ''} ${moves.dropTarget === entry.path ? 'file-drop-target' : ''} ${moves.dragPath === entry.path ? 'file-drag-source' : ''}`} style={{ paddingLeft: 10 + depth * 14 }}
      title={displayDirectoryPath(entry.path, server.platform)} disabled={unavailable} onClick={() => void open(entry)}>
      {pending === entry.path ? <LoaderCircle size={14} className="spin" /> : entry.directory ? expanded.has(entry.path) ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : <span className="explorer-indent" />}
      {entry.directory ? expanded.has(entry.path) ? <FolderOpen size={16} className="folder-icon" /> : <Folder size={16} className="folder-icon" /> : <FileText size={16} className="muted" />}<span>{entry.name}</span>
    </button>
    <IconButton className="explorer-move" label={`移動${entry.directory ? '資料夾' : '檔案'} ${entry.name}`} disabled={unavailable || !!pending} onClick={() => { setError(''); setMoveTarget(entry); }}><FolderInput size={14} /></IconButton>
    </div>
    {entry.directory && expanded.has(entry.path) && <div role="group">{rows(entry.path, depth + 1)}{entries[entry.path]?.length === 0 && <p className="explorer-empty" style={{ paddingLeft: 38 + depth * 14 }}>空目錄</p>}</div>}
  </div>);
  return <div className="agent-explorer">
    <div className="explorer-toolbar"><span title={displayDirectoryPath(path, server.platform)}>{displayDirectoryPath(path, server.platform)}</span>
      <IconButton label="檔案總管上一層" {...(root && root !== '/' ? moves.targetProps(parentDirectory(root)) : {})} className={moves.dropTarget === parentDirectory(root) ? 'file-drop-target' : ''} disabled={unavailable || !root || !!pending || root === '/'} onClick={() => void loadRoot(parentDirectory(root), true)}><FolderUp size={15} /></IconButton>
      <IconButton label="重新整理檔案總管" disabled={unavailable || !!pending} onClick={() => void loadRoot(root || path)}><RotateCw size={15} /></IconButton>
    </div>
    {error && <p className="error explorer-error" role="alert">{error}</p>}
    {notice && <p className="notice explorer-error" role="status">{notice}</p>}
    <div className="explorer-tree" role="tree" aria-label="目前工作目錄檔案">
      {root && <button type="button" {...moves.targetProps(root)} className={`explorer-root ${path === root ? 'selected' : ''} ${moves.dropTarget === root ? 'file-drop-target' : ''}`} title={root} disabled={unavailable || !!pending} onClick={() => void loadRoot(root, true)}><FolderOpen size={16} /><strong>{root.split('/').at(-1) || '/'}</strong></button>}
      {root && expanded.has(root) && rows(root)}
      {!!pending && !root && <p className="explorer-empty"><LoaderCircle size={15} className="spin" />讀取目錄…</p>}
      {root && entries[root]?.length === 0 && !pending && <p className="explorer-empty">空目錄</p>}
    </div>
    <div className="explorer-hint" role={moves.moving ? 'status' : undefined}>{moves.moving ? '正在移動項目…' : moves.dropTarget ? `放開即可移動到 ${displayDirectoryPath(moves.dropTarget, server.platform)}` : '點選資料夾切換 pwd；點選檔案預覽。可拖曳檔案與資料夾。'}</div>
    {moveTarget && <FileMoveDialog file={moveTarget} onMove={destination => moves.moveFile(moveTarget.path, destination, false)} onClose={() => setMoveTarget(null)} />}
  </div>;
}
