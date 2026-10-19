import { useEffect, useRef, useState } from 'react';
import { FileText, FolderOpen, Search, SlidersHorizontal, X } from 'lucide-react';
import { searchLimits, searchLimitLabels, searchOptions, type FileEntry, type FileSearchResult } from '@cozypad/contracts';
import { api, message } from '../api';
import { Busy, IconButton } from './Controls';

export function FileSearchPanel({ serverId, root, onOpen, onLocate }: { serverId: string; root: string; onOpen: (entry: FileEntry) => void; onLocate: (path: string) => void }) {
  const [mode, setMode] = useState<'name' | 'text'>('name');
  const [glob, setGlob] = useState('*'), [text, setText] = useState('');
  const [budget, setBudget] = useState({ ...searchLimits });
  const [result, setResult] = useState<FileSearchResult | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const active = useRef<AbortController | null>(null);
  useEffect(() => { active.current?.abort(); active.current = null; setBusy(false); setResult(null); setError(''); return () => { active.current?.abort(); active.current = null; }; }, [serverId, root]);
  const search = async () => {
    if (active.current) return;
    setError('');
    let options;
    try { options = searchOptions({ root, glob, ...(mode === 'text' ? { text } : {}), ...budget }); }
    catch (error) { setError(message(error)); return; }
    const controller = new AbortController(); active.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 25000);
    setBusy(true); setResult(null);
    try {
      const value = await api<FileSearchResult>('/files/search', { method: 'POST', body: JSON.stringify({ serverId, ...options }), signal: controller.signal });
      if (active.current === controller) setResult(value);
    } catch (error) { if (active.current === controller) setError(controller.signal.aborted ? '搜尋已停止；未取得完整結果。' : message(error)); }
    finally { window.clearTimeout(timer); if (active.current === controller) { active.current = null; setBusy(false); } }
  };
  return <section className="file-search-panel" aria-label="目錄搜尋">
    <form aria-label="檔案搜尋" onSubmit={event => { event.preventDefault(); void search(); }}>
      <div className="search-modes" role="group" aria-label="搜尋模式">
        <button type="button" aria-pressed={mode === 'name'} disabled={busy} onClick={() => setMode('name')}>檔名</button>
        <button type="button" aria-pressed={mode === 'text'} disabled={busy} onClick={() => setMode('text')}>內容</button>
      </div>
      <div className="search-fields">
        <label>檔名模式<input value={glob} maxLength={128} placeholder="*.py" required disabled={busy} onChange={event => setGlob(event.target.value)} /></label>
        {mode === 'text' && <label>搜尋文字<input value={text} maxLength={256} required disabled={busy} onChange={event => setText(event.target.value)} /></label>}
        <div className="search-actions"><IconButton label="搜尋檔案" type="submit" disabled={busy}><Search size={18} /></IconButton>{busy && <IconButton label="取消搜尋" onClick={() => active.current?.abort()}><X size={18} /></IconButton>}</div>
      </div>
      <details className="search-budget"><summary><SlidersHorizontal size={14} />搜尋預算</summary><div>
        {([['maxDepth', '深度'], ['maxEntries', '目錄項目'], ['maxFiles', '候選檔案'], ['maxResults', '結果筆數'], ['maxBytes', '單檔位元組']] as const).map(([key, label]) => <label key={key}>{label}<input type="number" min={key === 'maxDepth' ? 0 : 1} max={searchLimits[key]} step={1} required disabled={busy} value={budget[key]} onChange={event => setBudget({ ...budget, [key]: Number(event.target.value) })} /></label>)}
      </div></details>
    </form>
    <p className="search-root" title={root}>{root}</p>
    {busy && <div role="status"><Busy /></div>}
    {error && <p className="error" role="alert">{error}</p>}
    {result && <div className="search-report" role="region" aria-label="搜尋結果">
      <p role="status" className={result.complete ? 'notice' : 'search-incomplete'}>{result.complete ? '已完成指定範圍搜尋' : '搜尋未完整涵蓋指定範圍'} · {result.results.length} 筆結果 · {result.counts.entries} 個項目 · {result.counts.candidateFiles} 個候選檔案 · {result.counts.bytes.toLocaleString()} B</p>
      {!!result.limitations.length && <ul className="search-limitations">{result.limitations.map(code => <li key={code}>{searchLimitLabels[code] || code}</li>)}</ul>}
      {!result.results.length && <p className="muted">此輪搜尋未找到符合條件的結果。</p>}
      <ul className="file-search-results">{result.results.map((entry, index) => <li key={`${entry.path}:${entry.line ?? index}`}>
        <button className="search-file" type="button" onClick={() => onOpen(entry)}><FileText size={16} /><span>{entry.path.slice(result.root.length + 1)}{entry.line && <small>:{entry.line}</small>}</span></button>
        <IconButton label={`前往目錄 ${entry.name}`} onClick={() => onLocate(entry.path.slice(0, entry.path.lastIndexOf('/')) || '/')}><FolderOpen size={16} /></IconButton>
        {entry.excerpt !== undefined && <pre>{entry.excerpt}</pre>}
      </li>)}</ul>
    </div>}
  </section>;
}
