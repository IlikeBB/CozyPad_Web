import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, Bug, CheckCircle2, ChevronLeft, ChevronRight, Plus, RefreshCw, Save, Send } from 'lucide-react';
import type { IssueCategory, IssuePage, IssueReport, IssueStatus, User } from '@cozypad/contracts';
import { api, message, post } from '../api';
import { Busy, IconButton } from '../components/Controls';
import './issues.css';

const categories: Record<IssueCategory, string> = { bug: '功能錯誤', connection: '登入／連線', agents: 'Codex 對話', files: '檔案操作', other: '其他／功能建議' };
const statuses: Record<IssueStatus, string> = { open: '待處理', in_progress: '處理中', resolved: '已解決', closed: '已關閉' };
const date = (value: number) => new Date(value).toLocaleString('zh-TW');
function Status({ value }: { value: IssueStatus }) { return <span className={`issue-status issue-status-${value}`}>{statuses[value]}</span>; }

function NewIssue({ onCreated }: { onCreated: (report: IssueReport) => void }) {
  const [title, setTitle] = useState(''), [category, setCategory] = useState<IssueCategory>('bug');
  const [description, setDescription] = useState(''), [steps, setSteps] = useState(''), [expected, setExpected] = useState('');
  const [includeDiagnostics, setIncludeDiagnostics] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const attempt = useRef<{ serialized: string; payload: object } | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError('');
    const draft = { title, category, description, steps, expected };
    const serialized = JSON.stringify({ ...draft, includeDiagnostics });
    if (attempt.current?.serialized !== serialized) attempt.current = { serialized, payload: { ...draft, requestId: crypto.randomUUID(), diagnostics: includeDiagnostics ? {
      userAgent: navigator.userAgent.slice(0, 500), viewport: `${window.innerWidth} × ${window.innerHeight}`, version: 'CozyPad TT V4.0'
    } : null } };
    try { onCreated(await post<IssueReport>('/issues', attempt.current.payload)); }
    catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  };
  return <form className="issue-form" onSubmit={event => void submit(event)}>
    <h2>新增問題回報</h2>
    <fieldset disabled={busy}>
      <label>問題類型<select aria-label="問題類型" value={category} onChange={event => setCategory(event.target.value as IssueCategory)}>{Object.entries(categories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>標題<input value={title} required maxLength={160} onChange={event => setTitle(event.target.value)} placeholder="例如：Codex 回覆的檔案無法下載" /></label>
      <label>問題描述<textarea value={description} required maxLength={8000} rows={5} onChange={event => setDescription(event.target.value)} /></label>
      <label>重現步驟（選填）<textarea value={steps} maxLength={4000} rows={3} onChange={event => setSteps(event.target.value)} /></label>
      <label>預期結果（選填）<textarea value={expected} maxLength={2000} rows={2} onChange={event => setExpected(event.target.value)} /></label>
      <label className="checkbox"><input type="checkbox" checked={includeDiagnostics} onChange={event => setIncludeDiagnostics(event.target.checked)} />附加瀏覽器版本、視窗大小及 CozyPad 版本</label>
    </fieldset>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="issue-form-actions"><button className="primary" disabled={busy}>{busy ? <Busy label="送出中" /> : <><Send size={16} />送出回報</>}</button></div>
  </form>;
}

function AdminResponse({ report, onUpdated }: { report: IssueReport; onUpdated: (report: IssueReport) => void }) {
  const [status, setStatus] = useState(report.status), [response, setResponse] = useState(report.response);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return; setBusy(true); setError('');
    try { onUpdated(await api<IssueReport>(`/issues/${report.id}`, { method: 'PUT', body: JSON.stringify({ status, response, revision: report.revision }) })); }
    catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  };
  return <form className="issue-admin" onSubmit={event => void save(event)}>
    <h3>管理員處理</h3>
    <fieldset disabled={busy}><label>處理狀態<select aria-label="處理狀態" value={status} onChange={event => setStatus(event.target.value as IssueStatus)}>{Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>管理員回覆<textarea value={response} maxLength={4000} rows={4} onChange={event => setResponse(event.target.value)} /></label></fieldset>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="issue-form-actions"><button className="primary" disabled={busy}>{busy ? <Busy label="儲存中" /> : <><Save size={16} />儲存處理結果</>}</button></div>
  </form>;
}

function IssueDetail({ report, admin, onUpdated }: { report: IssueReport; admin: boolean; onUpdated: (report: IssueReport) => void }) {
  return <article className="issue-detail">
    <div className="issue-detail-heading"><Status value={report.status} /><span>{categories[report.category]}</span></div>
    <h2>{report.title}</h2>
    <dl className="issue-metadata"><div><dt>回報編號</dt><dd className="mono">{report.id}</dd></div><div><dt>回報者</dt><dd>{report.owner}</dd></div><div><dt>建立時間</dt><dd>{date(report.createdAt)}</dd></div><div><dt>更新時間</dt><dd>{date(report.updatedAt)}</dd></div></dl>
    <section><h3>問題描述</h3><p>{report.description}</p></section>
    {report.steps && <section><h3>重現步驟</h3><p>{report.steps}</p></section>}
    {report.expected && <section><h3>預期結果</h3><p>{report.expected}</p></section>}
    {report.diagnostics && <details className="issue-diagnostics"><summary>瀏覽器資訊</summary><p>{report.diagnostics.userAgent}</p><p>{report.diagnostics.viewport} · {report.diagnostics.version}</p></details>}
    {report.response && <section className="issue-response"><h3>管理員回覆</h3><p>{report.response}</p><small>{report.respondedBy} · {report.respondedAt && date(report.respondedAt)}</small></section>}
    {admin && <AdminResponse key={`${report.id}:${report.revision}`} report={report} onUpdated={onUpdated} />}
  </article>;
}

export function IssuesWorkspace({ user }: { user: User }) {
  const admin = user.role === 'admin';
  const [scope, setScope] = useState(admin ? 'all' : 'mine'), [status, setStatus] = useState('all'), [page, setPage] = useState(1);
  const [reports, setReports] = useState<IssuePage>({ items: [], total: 0, page: 1, limit: 25 });
  const [loading, setLoading] = useState(true), [listError, setListError] = useState('');
  const [mode, setMode] = useState<'new' | 'detail' | 'list'>('new'), [selected, setSelected] = useState('');
  const [report, setReport] = useState<IssueReport | null>(null), [detailLoading, setDetailLoading] = useState(false), [detailError, setDetailError] = useState('');
  const [notice, setNotice] = useState(''), [formKey, setFormKey] = useState(0);
  const listSequence = useRef(0), detailSequence = useRef(0);
  const load = useCallback(async () => {
    const sequence = ++listSequence.current; setLoading(true); setListError('');
    try {
      const result = await api<IssuePage>(`/issues?${new URLSearchParams({ scope, status, page: String(page) })}`);
      if (sequence === listSequence.current) {
        setReports(result);
        const lastPage = Math.max(1, Math.ceil(result.total / result.limit));
        if (page > lastPage) setPage(lastPage);
      }
    } catch (error) { if (sequence === listSequence.current) setListError(message(error)); }
    finally { if (sequence === listSequence.current) setLoading(false); }
  }, [scope, status, page]);
  useEffect(() => { void load(); return () => { listSequence.current++; }; }, [load]);
  useEffect(() => () => { detailSequence.current++; }, []);
  const open = async (id: string) => {
    const sequence = ++detailSequence.current; setSelected(id); setMode('detail'); setReport(null); setDetailError(''); setDetailLoading(true); setNotice('');
    try { const result = await api<IssueReport>(`/issues/${id}`); if (sequence === detailSequence.current) setReport(result); }
    catch (error) { if (sequence === detailSequence.current) setDetailError(message(error)); }
    finally { if (sequence === detailSequence.current) setDetailLoading(false); }
  };
  const created = (result: IssueReport) => {
    detailSequence.current++; setSelected(result.id); setReport(result); setMode('detail'); setDetailLoading(false); setDetailError(''); setFormKey(value => value + 1);
    setNotice('問題已回報。'); setPage(1); if (page === 1) void load();
  };
  const updated = (result: IssueReport) => { setReport(result); setNotice('處理結果已儲存。'); void load(); };
  return <section className={`issues-workspace issues-mode-${mode}`}>
    <div className="workspace-toolbar issues-toolbar"><strong>{admin && scope === 'all' ? '全部回報' : '我的回報'}</strong><span className="muted">{reports.total}</span><div className="toolbar-spacer" />
      <IconButton label="重新整理回報" disabled={loading || detailLoading} onClick={() => { void load(); if (mode === 'detail' && selected) void open(selected); }}><RefreshCw size={16} /></IconButton>
      <button className="primary" onClick={() => { detailSequence.current++; setMode('new'); setSelected(''); setDetailLoading(false); setNotice(''); }}><Plus size={16} />新增回報</button>
    </div>
    <div className="issues-layout">
      <aside className="issues-list" aria-label="問題回報紀錄">
        <div className="issue-filters">{admin && <label>回報範圍<select aria-label="回報範圍" value={scope} onChange={event => { setScope(event.target.value); setPage(1); }}><option value="all">全部使用者</option><option value="mine">我的回報</option></select></label>}
          <label>篩選狀態<select aria-label="篩選狀態" value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><option value="all">全部狀態</option>{Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        </div>
        {listError && <p className="error issue-list-message" role="alert">{listError}</p>}
        {loading ? <div className="issue-list-message"><Busy /></div> : !reports.items.length ? <p className="muted issue-list-message">尚無符合條件的回報。</p> : <ul>{reports.items.map(item => <li key={item.id}><button className={selected === item.id ? 'selected' : ''} onClick={() => void open(item.id)} aria-label={`查看回報 ${item.title}`} aria-current={selected === item.id ? 'true' : undefined}>
          <strong>{item.title}</strong><span><Status value={item.status} /><small>{categories[item.category]}</small></span><small>{admin ? `${item.owner} · ` : ''}{date(item.updatedAt)}</small>
        </button></li>)}</ul>}
        <div className="issue-pagination"><IconButton label="上一頁回報" disabled={page <= 1 || loading} onClick={() => setPage(value => value - 1)}><ChevronLeft size={16} /></IconButton><span>{page} / {Math.max(1, Math.ceil(reports.total / reports.limit))}</span><IconButton label="下一頁回報" disabled={page * reports.limit >= reports.total || loading} onClick={() => setPage(value => value + 1)}><ChevronRight size={16} /></IconButton></div>
      </aside>
      <div className="issue-content">
        <button className="secondary issue-back" onClick={() => { detailSequence.current++; setMode('list'); setDetailLoading(false); }}><ArrowLeft size={16} />回報紀錄</button>
        {notice && <p className="notice" role="status"><CheckCircle2 size={16} />{notice}</p>}
        {mode === 'new' && <NewIssue key={formKey} onCreated={created} />}
        {mode === 'detail' && (detailLoading ? <Busy /> : detailError ? <p className="error" role="alert">{detailError}</p> : report && <IssueDetail report={report} admin={admin} onUpdated={updated} />)}
        {mode === 'list' && <div className="issue-empty"><Bug size={28} /><span>尚未選擇回報</span></div>}
      </div>
    </div>
  </section>;
}
