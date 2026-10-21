import { useEffect, useRef, useState } from 'react';
import { Download, FileText, Film, Image, Folder, FolderInput, FolderPlus, Pencil, RotateCw, Save, Search, Trash2, Upload, X, FolderUp } from 'lucide-react';
import type { FileEntry, ServerProfile } from '@cozypad/contracts';
import { api, message, post, serverQuery } from '../api';
import { Busy, IconButton } from '../components/Controls';
import { FolderDialog, type FolderAction } from '../components/FolderDialog';
import { FileSearchPanel } from '../components/FileSearchPanel';
import { MarkdownDocument } from '../components/MarkdownDocument';
import { MarkdownViewSwitch } from '../components/MarkdownViewSwitch';
import { isMarkdownFile } from '../components/markdown-document.mjs';
import { mediaType } from '../../../../packages/contracts/src/media-types.mjs';
import { mediaFileUrl } from '../components/MediaPreview';
import { AgentFilePreview, type FilePreview } from '../components/AgentFilePreview';
import { useFileMove, parentDirectory } from '../components/use-file-move';
import { FileMoveDialog } from '../components/FileMoveDialog';

const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
export function FilesWorkspace({ server, markdownOnly = false }: { server: ServerProfile; markdownOnly?: boolean }) {
  const [path, setPath] = useState(server.defaultPath);
  const [pathInput, setPathInput] = useState(server.defaultPath);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [editor, setEditor] = useState<{ path: string; content: string; original: string; revision: string } | null>(null);
  const [media, setMedia] = useState<FilePreview | null>(null);
  const [loading, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [folderAction, setFolderAction] = useState<FolderAction | null>(null);
  const [moveTarget, setMoveTarget] = useState<FileEntry | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [preview, setPreview] = useState(true);
  const requestId = useRef(0);
  const load = async (target: string) => {
    const id = ++requestId.current; setBusy(true); setError('');
    try {
      const result = await api<{ path: string; entries: FileEntry[] }>(`/files?${serverQuery(server.id, target)}`);
      if (id !== requestId.current) return;
      setPath(result.path); setPathInput(result.path); setEntries(result.entries);
    } catch (error) { if (id === requestId.current) setError(message(error)); }
    finally { if (id === requestId.current) setBusy(false); }
  };
  const moves = useFileMove({ serverId: server.id, disabled: loading || markdownOnly, onError: setError, onNotice: setNotice, onMoved: async result => {
    setEditor(previous => previous?.path === result.source ? { ...previous, path: result.path } : previous);
    setMedia(previous => previous?.path === result.source ? { ...previous, path: result.path, version: (previous.version || 0) + 1 } : previous);
    await load(path);
  } });
  const busy = loading || moves.moving;
  useEffect(() => { setEditor(null); setMedia(null); void load(server.defaultPath); return () => { requestId.current++; }; }, [server.id]);
  const open = async (entry: FileEntry) => {
    if (busy) return;
    if (markdownOnly && !entry.directory && !isMarkdownFile(entry.name)) { setError('請選擇 Markdown 檔案。'); return; }
    if (editor && editor.content !== editor.original && !window.confirm('放棄尚未儲存的變更？')) return;
    if (entry.directory) { setEditor(null); setMedia(null); await load(entry.path); return; }
    if (mediaType(entry.path)) {
      requestId.current++; setEditor(null); setBusy(false); setError(''); setNotice('');
      setMedia({ path: entry.path, name: entry.name, content: '', loading: false, error: '', version: Date.now() }); return;
    }
    setMedia(null);
    const id = ++requestId.current;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api<{ path: string; content: string; revision: string }>(`/files/content?${serverQuery(server.id, entry.path)}`);
      if (id !== requestId.current) return;
      setEditor({ ...result, original: result.content }); setPreview(true);
    } catch (error) { if (id === requestId.current) setError(message(error)); } finally { if (id === requestId.current) setBusy(false); }
  };
  const save = async () => {
    if (!editor) return; setBusy(true); setError('');
    try {
      await api('/files/content', { method: 'PUT', body: JSON.stringify({ serverId: server.id, path: editor.path, content: editor.content, revision: editor.revision }) });
      const result = await api<{ path: string; content: string; revision: string }>(`/files/content?${serverQuery(server.id, editor.path)}`);
      setEditor({ ...result, original: result.content }); setNotice('已儲存。');
    } catch (error) { setError(message(error)); } finally { setBusy(false); }
  };
  const upload = async (file: File) => {
    if (file.size > 10485760) { setError('檔案超過 10 MB 上限。'); return; }
    if (entries.some(entry => entry.name === file.name) && !window.confirm(`覆寫 ${file.name}？`)) return;
    setBusy(true); setError('');
    try {
      const content = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] || ''); reader.onerror = reject; reader.readAsDataURL(file);
      });
      await post('/files/upload', { serverId: server.id, path: `${path}/${file.name}`, content });
      await load(path); setNotice('檔案已上傳。');
    } catch (error) { setError(message(error)); } finally { setBusy(false); }
  };
  const visibleEntries = markdownOnly ? entries.filter(entry => entry.directory || isMarkdownFile(entry.name)) : entries;
  const openMarkdownLink = (filePath: string) => { if (!busy) void open({ name: filePath.split('/').at(-1) || '', path: filePath, directory: false, size: 0, modified: 0 }); };
  return <section className={`files-workspace ${markdownOnly ? 'markdown-files-workspace' : ''}`} aria-label={markdownOnly ? 'SSH Markdown 瀏覽器' : '檔案瀏覽器'}>
    <div className="workspace-toolbar files-toolbar">
      <IconButton label="上一層目錄" {...(!markdownOnly && path !== '/' ? moves.targetProps(parentDirectory(path)) : {})} className={moves.dropTarget === parentDirectory(path) ? 'file-drop-target' : ''} disabled={busy || path === '/'} onClick={() => { setEditor(null); setMedia(null); void load(parentDirectory(path)); }}><FolderUp size={18} /></IconButton>
      <form className="path-form" onSubmit={event => { event.preventDefault(); if (busy) return; setEditor(null); setMedia(null); void load(pathInput); }}><input aria-label="目錄路徑" value={pathInput} disabled={busy} onChange={event => setPathInput(event.target.value)} /></form>
      {!markdownOnly && <><IconButton label="新增資料夾" disabled={busy} onClick={() => setFolderAction({ kind: 'create' })}><FolderPlus size={18} /></IconButton>
      <IconButton label="目錄搜尋" disabled={busy} aria-pressed={searchOpen} onClick={() => setSearchOpen(!searchOpen)}><Search size={18} /></IconButton>
      <label className="icon-button upload-icon" title="上傳檔案"><Upload size={18} /><input type="file" aria-label="上傳檔案" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = ''; }} /></label></>}
      <IconButton label="重新整理檔案" disabled={busy} onClick={() => void load(path)}><RotateCw size={18} /></IconButton>
    </div>
    {error && <p className="error inline-alert" role="alert">{error}</p>}{notice && <p className="notice inline-alert" role="status">{notice}</p>}
    {searchOpen && <FileSearchPanel serverId={server.id} root={path} onOpen={entry => void open(entry)} onLocate={directory => { setSearchOpen(false); setEditor(null); setMedia(null); void load(directory); }} />}
    <div className={`files-content ${editor || media ? 'with-editor' : ''}`}>
      <div className="file-table-wrap"><table className="file-table"><thead><tr><th>名稱</th><th>大小</th><th>更新時間</th><th /></tr></thead><tbody>
        {visibleEntries.map(entry => <tr key={entry.path} {...(entry.directory && !markdownOnly ? moves.targetProps(entry.path) : {})} className={`${moves.dropTarget === entry.path ? 'file-drop-target' : ''} ${moves.dragPath === entry.path ? 'file-drag-source' : ''}`}><td><button className="file-name" {...moves.sourceProps(entry)} disabled={busy} title={entry.name} onClick={() => void open(entry)}>{entry.directory ? <Folder size={17} className="folder-icon" /> : mediaType(entry.path)?.kind === 'image' ? <Image size={17} className="muted" /> : mediaType(entry.path)?.kind === 'video' ? <Film size={17} className="muted" /> : <FileText size={17} className="muted" />}<span>{entry.name}</span></button></td><td>{entry.directory ? '—' : size(entry.size)}</td><td>{new Date(entry.modified).toLocaleDateString('zh-TW')}</td><td><div className="file-row-actions">{entry.directory ? !markdownOnly && <><IconButton label={`更名資料夾 ${entry.name}`} disabled={busy} onClick={() => setFolderAction({ kind: 'rename', entry })}><Pencil size={16} /></IconButton><IconButton label={`刪除資料夾 ${entry.name}`} className="danger-icon" disabled={busy} onClick={() => setFolderAction({ kind: 'delete', entry })}><Trash2 size={16} /></IconButton></> : <>{!markdownOnly && <IconButton label={`移動檔案 ${entry.name}`} disabled={busy} onClick={() => { setError(''); setMoveTarget(entry); }}><FolderInput size={16} /></IconButton>}<a className="icon-button" title={`下載 ${entry.name}`} aria-label={`下載 ${entry.name}`} href={mediaType(entry.path) ? mediaFileUrl(server.id, entry.path, true) : `/api/files/download?${serverQuery(server.id, entry.path)}`}><Download size={16} /></a></>}</div></td></tr>)}
      </tbody></table>{busy && <div className="table-status"><Busy /></div>}{!busy && !visibleEntries.length && !error && <p className="muted empty-list">{markdownOnly ? '此目錄沒有 Markdown 檔案或子資料夾。' : '空目錄'}</p>}</div>
      {media ? <section className="file-editor" aria-label="媒體檔案預覽"><AgentFilePreview key={media.path} file={media} serverId={server.id} onRefresh={() => setMedia({ ...media, version: (media.version || 0) + 1 })} onClose={() => setMedia(null)} /></section> : editor ? <section className="file-editor"><div className="workspace-toolbar preview-toolbar"><span className="editor-filename" title={editor.path}>{editor.path.split('/').at(-1)}{editor.content !== editor.original && ' *'}</span><div className="toolbar-spacer" />{isMarkdownFile(editor.path) && <MarkdownViewSwitch preview={preview} onChange={setPreview} />}{markdownOnly ? <span className="muted">唯讀</span> : <IconButton label="儲存檔案" disabled={busy || editor.content === editor.original} onClick={() => void save()}><Save size={17} /></IconButton>}<IconButton label="關閉編輯器" onClick={() => { if (editor.content === editor.original || window.confirm('放棄尚未儲存的變更？')) setEditor(null); }}><X size={17} /></IconButton></div>
        {isMarkdownFile(editor.path) && preview ? <MarkdownDocument key={editor.path} content={editor.content} path={editor.path} serverId={server.id} onOpenFile={openMarkdownLink} /> : markdownOnly ? <pre className="markdown-source" aria-label="Markdown 原始碼" tabIndex={0}>{editor.content}</pre> : <textarea aria-label="檔案內容" className="code-editor" value={editor.content} spellCheck={false} onChange={event => setEditor({ ...editor, content: event.target.value })} />}
      </section> : markdownOnly && <div className="markdown-reader-empty"><FileText size={32} /><h2>選擇 Markdown 檔案</h2><p>點選 .md 檔案，閱讀完整排版。</p></div>}
    </div>
    <div className="workspace-bottom"><span>{moves.moving ? '正在移動檔案…' : moves.dropTarget ? `放開即可移動到 ${moves.dropTarget.split('/').at(-1) || '/'}` : `${visibleEntries.length} 個項目${markdownOnly ? ' · Markdown 與資料夾' : ' · 可拖曳檔案到資料夾'}`}</span><span>SFTP</span></div>
    {folderAction && <FolderDialog action={folderAction} serverId={server.id} parent={path} onClose={() => setFolderAction(null)} onChanged={async notice => { await load(path); setNotice(notice); }} />}
    {moveTarget && <FileMoveDialog file={moveTarget} onMove={destination => moves.moveFile(moveTarget.path, destination, false)} onClose={() => setMoveTarget(null)} />}
  </section>;
}
