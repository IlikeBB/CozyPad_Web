import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileText, Folder, FolderOpen, FolderUp, LoaderCircle, Paperclip, RotateCw, X } from 'lucide-react';
import { attachmentType, type BrowserDirectoryContext } from '@cozypad/contracts';
import { BrowserDirectory, directoryFromFiles, type BrowserDirectoryHandle, type BrowserDirectoryItem, type BrowserDirectoryResult, type BrowserFileHandle } from '../workspaces/browser-directory.mjs';
import { forgetBrowserDirectory, loadBrowserDirectory, saveBrowserDirectory, type RememberedBrowserDirectory } from '../workspaces/browser-directory-preference.mjs';
import { preloadMarkdownDirectory, type LocalMarkdownReader } from '../workspaces/markdown-directory.mjs';
import { message } from '../api';
import { Dialog, IconButton } from './Controls';

export function BrowserDirectoryPicker({ scope, disabled, attachmentError, attachedNames, onContext, onAttach, onBusy, onMarkdownReader }: { scope: string; disabled: boolean; attachmentError: string; attachedNames: string[]; onContext: (context: BrowserDirectoryContext | undefined) => void; onAttach: (files: File[]) => Promise<void>; onBusy: (busy: boolean) => void; onMarkdownReader: (reader: LocalMarkdownReader | undefined) => void }) {
  const [folder, setFolder] = useState<BrowserDirectory | null>(null), [parts, setParts] = useState<string[]>([]), [items, setItems] = useState<BrowserDirectoryItem[]>([]);
  const [incomplete, setIncomplete] = useState(false), [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [remembered, setRemembered] = useState<RememberedBrowserDirectory | null>(null), [notice, setNotice] = useState('');
  const [autoMarkdown, setAutoMarkdown] = useState(true);
  const [markdownRevision, setMarkdownRevision] = useState(0), [markdownStatus, setMarkdownStatus] = useState('');
  const autoMarkdownRef = useRef(true);
  const generation = useRef(0), reading = useRef<AbortController | null>(null), input = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const current = ++generation.current;
    reading.current?.abort(); setFolder(null); setItems([]); setParts([]); setOpen(false); setRemembered(null); setNotice(''); setError(''); setIncomplete(false);
    autoMarkdownRef.current = true; setAutoMarkdown(true);
    setBusy(true); onBusy(true); onContext(undefined);
    void (async () => {
      try {
        const saved = await loadBrowserDirectory(scope);
        if (current !== generation.current || !saved) return;
        setRemembered(saved);
        autoMarkdownRef.current = saved.autoMarkdown !== false; setAutoMarkdown(autoMarkdownRef.current);
        if (!saved.directory) { setNotice('已記住上次目錄；此瀏覽器需重新選取資料夾才能讀取，建議使用桌面版 Chrome 或 Edge。'); return; }
        const permission = await saved.directory.root.queryPermission?.({ mode: 'read' });
        if (current !== generation.current) return;
        if (!permission || permission === 'granted') await read(saved.directory, saved.parts, true);
        else setNotice('已記住上次目錄，按「恢復存取」即可繼續讀取。');
      } catch (error) { if (current === generation.current) setNotice(`無法恢復上次目錄：${message(error)}`); }
      finally { if (current === generation.current) { setBusy(false); onBusy(false); } }
    })();
    return () => { generation.current++; reading.current?.abort(); };
  }, [scope]);
  useEffect(() => {
    setMarkdownStatus('');
    if (!autoMarkdown || (!folder && !remembered)) { onMarkdownReader(undefined); return; }
    if (!folder) {
      onMarkdownReader(async () => { throw new Error('本機目錄尚未取得讀取權限。請按「恢復存取」，或重新選取資料夾，再送出訊息。'); });
      return () => onMarkdownReader(undefined);
    }
    const current = generation.current, preload = preloadMarkdownDirectory(folder, parts);
    const reader: LocalMarkdownReader = async signal => {
      const bundle = await preload.read(signal);
      if (current !== generation.current || signal.aborted) throw new Error('本機目錄已變更，訊息尚未送出。');
      return bundle;
    };
    setMarkdownStatus('正在預載入本機 MD…');
    onMarkdownReader(reader);
    let mounted = true;
    void preload.result.then(bundle => {
      if (!mounted || current !== generation.current) return;
      reader.ready = true;
      setMarkdownStatus(bundle ? `已預載入 ${bundle.count} 個 MD${bundle.incomplete ? '（部分未涵蓋）' : ''}` : '此目錄沒有 MD');
    }, reason => {
      if (!mounted || current !== generation.current) return;
      reader.ready = true;
      setMarkdownStatus('MD 預載入失敗'); setError(message(reason));
    });
    return () => { mounted = false; preload.abort(); onMarkdownReader(undefined); };
  }, [folder, remembered, parts, autoMarkdown, markdownRevision, onMarkdownReader]);
  const read = async (directory: BrowserDirectory, target: string[], restoring = false) => {
    const current = ++generation.current; reading.current?.abort();
    setMarkdownRevision(previous => previous + 1);
    const controller = new AbortController(); reading.current = controller;
    setBusy(true); onBusy(true); setError(''); setNotice('');
    // Keep the selected capability even if its first enumeration stalls.
    const remember = (location: string[]) => {
      setRemembered({ version: 1, rootName: directory.root.name, parts: [...location], directory, autoMarkdown: autoMarkdownRef.current });
      return saveBrowserDirectory(scope, directory, location, { autoMarkdown: autoMarkdownRef.current }).catch(error => {
        if (current === generation.current) setError(`本次仍可讀取，但無法記住目錄：${message(error)}`);
      });
    };
    setFolder(directory); setParts(target); setItems([]); setIncomplete(true); onContext(undefined);
    let persistence = remember(target);
    if (!directory.root.queryPermission) setNotice('此瀏覽器只能在本次開啟期間保留目錄；下次開啟建議使用桌面版 Chrome 或 Edge。');
    const display = (result: BrowserDirectoryResult) => {
      if (current !== generation.current) return;
      setItems(result.items); setIncomplete(result.context.incomplete); onContext(result.context);
    };
    try {
      let result;
      try { result = await directory.read(target, controller.signal, { onProgress: display }); }
      catch (error) {
        if (!restoring || !target.length || !(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
        target = [];
        if (current === generation.current) { setParts(target); persistence = remember(target); }
        result = await directory.read(target, controller.signal, { onProgress: display });
        if (current === generation.current) setNotice('上次的子目錄已不存在，已回到原資料夾。');
      }
      if (current !== generation.current) return;
      display(result);
      if (result.stopReason === 'timeout') setNotice(`讀取較慢，已保留取得的 ${result.items.length} 個項目與選取目錄。可按「重新讀取本機目錄」重試，或進入已列出的子目錄。`);
      else if (result.stopReason === 'cancelled') setNotice(`已停止讀取，保留目前取得的 ${result.items.length} 個項目與選取目錄；可隨時重試。`);
    } catch (error) {
      if (current === generation.current) {
        if (error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name)) { setFolder(null); setItems([]); onContext(undefined); }
        setError(error instanceof DOMException && ['TimeoutError', 'AbortError'].includes(error.name)
          ? '尚未能開啟這個目錄，已保留選取位置；可重新讀取、回到上一層或改選資料夾。'
          : `無法讀取本機目錄：${message(error)}。可恢復存取或重新選取資料夾。`);
      }
    }
    finally { await persistence; if (current === generation.current) { reading.current = null; setBusy(false); onBusy(false); } }
  };
  const pick = async () => {
    const picker = (window as Window & { showDirectoryPicker?: (options: { mode: 'read'; id: string; startIn?: BrowserDirectoryHandle }) => Promise<BrowserDirectoryHandle> }).showDirectoryPicker;
    if (!picker) { input.current?.click(); return; }
    const current = generation.current;
    setBusy(true); onBusy(true); setError('');
    try {
      const root = remembered?.directory?.root;
      const handle = await picker.call(window, { mode: 'read', id: 'cozypad-local-reference', ...(root?.queryPermission ? { startIn: root } : {}) });
      if (current === generation.current) { setNotice(''); await read(new BrowserDirectory(handle), []); }
    } catch (error) { if (current === generation.current && !(error instanceof DOMException && error.name === 'AbortError')) setError(message(error)); }
    finally { if (current === generation.current) { setBusy(false); onBusy(false); } }
  };
  const resume = async () => {
    const directory = remembered?.directory;
    if (!directory) return;
    const current = generation.current;
    setBusy(true); onBusy(true); setError('');
    try {
      // Request directly from the click, while user activation is still available.
      const permission = await directory.root.requestPermission?.({ mode: 'read' });
      if (current !== generation.current) return;
      if (permission && permission !== 'granted') { setError('尚未取得讀取權限；已保留上次目錄，可再次按「恢復存取」。'); return; }
      setNotice(''); await read(directory, remembered.parts, true);
    } catch (error) { if (current === generation.current) setError(`無法恢復存取：${message(error)}`); }
    finally { if (current === generation.current) { setBusy(false); onBusy(false); } }
  };
  const attach = async (item: BrowserDirectoryItem) => {
    if (disabled || busy || item.kind !== 'file') return;
    const current = generation.current; setBusy(true); onBusy(true); setError('');
    try {
      const file = await (item.handle as BrowserFileHandle).getFile();
      if (current === generation.current) { onBusy(false); await onAttach([file]); }
    } catch (error) { if (current === generation.current) setError(message(error)); }
    finally { if (current === generation.current) { setBusy(false); onBusy(false); } }
  };
  const clear = async () => {
    const current = ++generation.current;
    reading.current?.abort(); reading.current = null; setFolder(null); setItems([]); setParts([]); setRemembered(null); setError(''); setNotice(''); setIncomplete(false); setBusy(true); onBusy(true); onContext(undefined);
    try { await forgetBrowserDirectory(scope); }
    catch (error) { if (current === generation.current) setError(`本次已移除，但無法清除保存的目錄：${message(error)}`); }
    finally { if (current === generation.current) { setBusy(false); onBusy(false); } }
  };
  const changeAutoMarkdown = (enabled: boolean) => {
    autoMarkdownRef.current = enabled; setAutoMarkdown(enabled);
    if (folder) void saveBrowserDirectory(scope, folder, parts, { autoMarkdown: enabled }).catch(error => setError(message(error)));
  };
  const rootName = folder?.root.name || remembered?.rootName;
  const displayedParts = folder ? parts : remembered?.parts || [];
  const location = rootName ? `${rootName}${displayedParts.length ? `/${displayedParts.join('/')}` : '/'}` : '';
  return <div className="browser-directory-control">
    <IconButton label="本機參考資料夾" disabled={disabled} onClick={() => setOpen(true)}><FolderOpen size={16} /></IconButton>
    {rootName && <span className="browser-directory-label" title={`${location}${autoMarkdown ? ` · ${markdownStatus}` : ' · 僅目錄資訊'}`}>本機 · {location}{!folder ? '（待恢復）' : ''}</span>}
    {remembered?.directory && !folder && <button type="button" className="secondary" disabled={disabled || busy} onClick={() => void resume()}>恢復存取</button>}
    <input ref={element => { input.current = element; element?.setAttribute('webkitdirectory', ''); }} type="file" multiple hidden aria-label="選取本機資料夾檔案" onChange={event => {
      try { if (event.target.files?.length) { setNotice('此瀏覽器只能在本次開啟期間保留目錄；下次開啟建議使用桌面版 Chrome 或 Edge。'); void read(directoryFromFiles(event.target.files), []); } } catch (error) { setError(message(error)); }
      event.target.value = '';
    }} />
    {open && createPortal(<Dialog title="本機參考資料夾" onClose={() => { reading.current?.abort(); setOpen(false); }}><div className="dialog-body">
      <div className="local-directory-toolbar"><button type="button" className="secondary" disabled={disabled || busy} onClick={() => void pick()}><FolderOpen size={16} />選取資料夾</button>
        <button type="button" className="secondary" disabled={disabled || busy} onClick={() => input.current?.click()}>改用資料夾檔案讀取</button>
        {remembered?.directory && !folder && <button type="button" className="secondary" disabled={disabled || busy} onClick={() => void resume()}>恢復存取</button>}
        {folder && <><IconButton label="本機上一層目錄" disabled={busy || !parts.length} onClick={() => void read(folder, parts.slice(0, -1))}><FolderUp size={16} /></IconButton><IconButton label="重新讀取本機目錄" disabled={busy} onClick={() => { setNotice(''); void read(folder, parts); }}><RotateCw size={16} /></IconButton></>}
        {(folder || remembered) && <IconButton label="移除本機參考資料夾" disabled={busy} onClick={() => void clear()}><X size={16} /></IconButton>}
        {busy && reading.current && <button type="button" className="secondary" onClick={() => reading.current?.abort()}>停止讀取</button>}
      </div>
      {location && <p className="local-directory-path">{location}</p>}
      <p className="muted local-directory-notice">本機參考，不是 SSH 執行目錄。瀏覽器不提供作業系統的絕對 pwd。</p>
      <label className="checkbox local-markdown-option"><input type="checkbox" aria-label="預先載入本機 MD" checked={autoMarkdown} disabled={disabled || busy} onChange={event => changeAutoMarkdown(event.target.checked)} />預先載入 MD 內容（含子資料夾）</label>
      <p className="muted local-directory-notice">選取或恢復資料夾時，預先載入最多 100 個 MD，後續訊息沿用已載入的內容。檔案修改後請重新載入；若讀取一直停住，可使用「改用資料夾檔案讀取」。</p>
      {folder && autoMarkdown && <><p className="muted" aria-live="polite">{markdownStatus}</p><button type="button" className="secondary" disabled={disabled || busy} onClick={() => { generation.current++; setError(''); setNotice(''); setMarkdownRevision(previous => previous + 1); }}>重新載入 MD 內容</button></>}
      {folder && !folder.root.queryPermission && <p className="muted local-directory-notice">目前使用資料夾檔案讀取；同頁面切換會保留，重新整理後需要再次選取資料夾。</p>}
      {notice && <p className="muted" role="status">{notice}</p>}
      {folder && !notice && <p className="muted">已記住此目錄與所在子資料夾，下次開啟會自動恢復。</p>}
      {incomplete && folder && <p className="search-incomplete">目錄資訊未完整涵蓋；可能有排除項目、讀取尚未完成，或已達 50 筆顯示上限。</p>}
      {(error || attachmentError) && <p className="error" role="alert">{error || attachmentError}</p>}
      {busy && <p className="muted" role="status"><LoaderCircle className="spin" size={15} />讀取中</p>}
      <ul className="local-directory-list">{items.map(item => <li key={item.name}>
        {item.kind === 'directory' ? <button type="button" disabled={busy} onClick={() => folder && void read(folder, [...parts, item.name])}><Folder size={16} /><span>{item.name}</span></button> : <span><FileText size={16} /><span>{item.name}</span></span>}
        {item.kind === 'file' && <IconButton label={`附加本機檔案 ${item.name}`} disabled={disabled || busy || attachedNames.includes(item.name) || !attachmentType(item.name)} onClick={() => void attach(item)}><Paperclip size={16} /></IconButton>}
        {attachedNames.includes(item.name) && <small className="muted">已附加</small>}
      </li>)}</ul>
      {folder && !items.length && !busy && <p className="muted">{incomplete ? '尚未取得可顯示項目；可重新讀取或改選其他目錄。' : '此層沒有可顯示項目。'}</p>}
    </div></Dialog>, document.body)}
  </div>;
}
