import { useEffect, useRef, useState } from 'react';
import { FileText, FolderOpen } from 'lucide-react';
import type { ServerProfile } from '@cozypad/contracts';
import { Busy } from '../components/Controls';
import { MarkdownDocument } from '../components/MarkdownDocument';
import { MarkdownViewSwitch } from '../components/MarkdownViewSwitch';
import { isMarkdownFile } from '../components/markdown-document.mjs';
import { FilesWorkspace } from './FilesWorkspace';
import { message } from '../api';

export function MarkdownWorkspace({ server, connected }: { server?: ServerProfile; connected: boolean }) {
  const [source, setSource] = useState<'ssh' | 'local'>(server && connected ? 'ssh' : 'local');
  const [files, setFiles] = useState<File[]>([]), [selected, setSelected] = useState<File | null>(null);
  const [content, setContent] = useState(''), [preview, setPreview] = useState(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const picker = useRef<HTMLInputElement>(null), sequence = useRef(0);
  useEffect(() => () => { sequence.current++; }, []);
  const open = async (file: File) => {
    const request = ++sequence.current; setBusy(true); setError('');
    try {
      if (!isMarkdownFile(file.name)) throw new Error('請選擇 .md 或 .markdown 檔案。');
      if (file.size > 2097152) throw new Error('Markdown 檔案超過 2 MB 上限。');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (text.includes('\0')) throw new Error('此檔案不是文字檔。');
      if (request !== sequence.current) return;
      setSelected(file); setContent(text); setPreview(true);
    } catch (error) { if (request === sequence.current) setError(error instanceof TypeError ? '無法讀取 UTF-8 文字，請確認檔案編碼。' : message(error)); }
    finally { if (request === sequence.current) setBusy(false); }
  };
  const choose = (chosen: File[]) => {
    if (!chosen.length) return;
    const markdown = chosen.filter(file => isMarkdownFile(file.name)).slice(0, 200);
    if (!markdown.length) { setError('請選擇 Markdown 檔案。'); return; }
    setSource('local'); setFiles(markdown); void open(markdown[0]!);
  };
  return <section className="markdown-workspace" aria-label="Markdown 檔案瀏覽器">
    <div className="workspace-toolbar markdown-browser-toolbar">
      <div className="markdown-view-switch" role="group" aria-label="Markdown 檔案來源"><button type="button" aria-pressed={source === 'ssh'} className={source === 'ssh' ? 'active' : ''} disabled={!server || !connected} onClick={() => setSource('ssh')}>SSH 檔案</button><button type="button" aria-pressed={source === 'local'} className={source === 'local' ? 'active' : ''} onClick={() => setSource('local')}>本機檔案</button></div>
      <div className="toolbar-spacer" />
      <button type="button" className="secondary" onClick={() => picker.current?.click()}><FolderOpen size={16} />開啟本機 Markdown</button>
      <input ref={picker} type="file" hidden multiple accept=".md,.markdown,.mdown,.mkd" aria-label="開啟本機 Markdown 檔案" onChange={event => { choose(Array.from(event.target.files || [])); event.target.value = ''; }} />
    </div>
    {source === 'ssh' ? server && connected ? <FilesWorkspace key={server.id} server={server} markdownOnly /> : <div className="markdown-reader-empty"><FileText size={32} /><h2>SSH 尚未連線</h2><p>連線後可瀏覽遠端 Markdown，也可以開啟本機檔案。</p></div> : <>
      {error && <p className="error inline-alert" role="alert">{error}</p>}
      <div className={`markdown-local-content ${selected ? 'with-document' : ''}`}>
        <div className="markdown-local-files" aria-label="本機 Markdown 檔案">
          {files.map((file, index) => <button type="button" key={`${index}:${file.name}`} className={file === selected ? 'selected' : ''} aria-pressed={file === selected} disabled={busy} onClick={() => void open(file)}><FileText size={16} /><span title={file.name}>{file.name}</span></button>)}
          <p className="muted">選擇的檔案只在此瀏覽器中預覽。</p>
        </div>
        {busy ? <div className="markdown-reader-empty"><Busy label="讀取 Markdown" /></div> : selected ? <section className="file-editor">
          <div className="workspace-toolbar preview-toolbar"><span className="editor-filename" title={selected.name}>{selected.name}</span><div className="toolbar-spacer" /><MarkdownViewSwitch preview={preview} onChange={setPreview} /><span className="muted">唯讀</span></div>
          {preview ? <MarkdownDocument key={selected.name + selected.lastModified} content={content} /> : <pre className="markdown-source" aria-label="Markdown 原始碼" tabIndex={0}>{content}</pre>}
        </section> : <div className="markdown-reader-empty"><FileText size={32} /><h2>閱讀 Markdown</h2><p>開啟本機 .md 檔案，或連線後選擇 SSH 檔案。</p><button type="button" className="primary" onClick={() => picker.current?.click()}>選擇 Markdown 檔案</button></div>}
      </div>
    </>}
  </section>;
}
