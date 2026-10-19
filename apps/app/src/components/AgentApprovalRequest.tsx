import { useState } from 'react';
import { Check, ShieldAlert, X } from 'lucide-react';
import type { AgentApproval, AgentTask } from '@cozypad/contracts';
import { message, post } from '../api';

const statuses = { accepted: '已核准本次', declined: '已拒絕本次', cancelled: '已結束' };

export function AgentApprovalRequest({ task, text }: { task: AgentTask; text: string }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  let request: AgentApproval;
  try { request = JSON.parse(text); } catch { return <p className="error">無法讀取核准請求。</p>; }
  const pending = request.status === 'pending' && task.status === 'running';
  const decide = async (decision: 'accept' | 'decline') => {
    if (busy || !pending) return;
    setBusy(true); setError('');
    try { await post(`/tasks/${encodeURIComponent(task.id)}/approval`, { requestId: request.id, decision }); }
    catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  };
  return <section className="approval-request" aria-label="Codex 動作核准請求">
    <header><ShieldAlert size={16} /><strong>{request.network ? '網路存取核准' : request.kind === 'file-change' ? '檔案修改核准' : '指令執行核准'}</strong><span>{pending ? '等待核准' : request.status === 'pending' ? '已結束' : statuses[request.status]}</span></header>
    {request.reason && <p>{request.reason}</p>}
    <dl>{request.agentThreadId && <><dt>子代理</dt><dd>{request.agentThreadId}</dd></>}<dt>工作目錄</dt><dd>{request.cwd}</dd>{request.grantRoot && <><dt>存取範圍</dt><dd>{request.grantRoot}</dd></>}{request.network && <><dt>網路目標</dt><dd>{request.network.protocol}://{request.network.host}{request.network.port ? `:${request.network.port}` : ''}</dd></>}</dl>
    {request.command && <pre>{request.command}</pre>}
    {request.changes.map(change => <details key={change.path}><summary>{change.path}</summary><pre>{change.diff}</pre></details>)}
    {pending && <div className="approval-actions"><button type="button" className="secondary" disabled={busy} onClick={() => void decide('decline')}><X size={14} />拒絕本次</button><button type="button" className="primary" disabled={busy || !request.canAccept} onClick={() => void decide('accept')}><Check size={14} />核准本次</button></div>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
