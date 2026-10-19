import { ChevronDown, Network } from 'lucide-react';
import type { AgentDelegation } from '@cozypad/contracts';

const tools: Record<string, string> = { spawnAgent: '建立子代理', sendInput: '傳送子任務', resumeAgent: '接續子代理', wait: '等待子代理', closeAgent: '結束子代理', interruptAgent: '停止子代理', listAgents: '查看子代理' };
const statuses: Record<string, string> = { pendingInit: '準備中', inProgress: '執行中', running: '執行中', completed: '已完成', interrupted: '已停止', shutdown: '已結束', failed: '失敗', errored: '失敗', notFound: '找不到' };

export function AgentDelegationActivity({ text }: { text: string }) {
  let item: AgentDelegation;
  try { item = JSON.parse(text); } catch { return <p className="error">無法讀取委派進度。</p>; }
  return <details className={`process-bubble delegation-activity ${item.status === 'failed' ? 'process-error' : ''}`}>
    <summary><Network size={14} /><span>{tools[item.tool] || '子代理處理'}{item.model ? ` · ${item.model}` : ''}</span><b>{statuses[item.status] || item.status}</b><ChevronDown size={14} /></summary>
    {item.prompt && <pre>{item.prompt}</pre>}
    <ul className="delegation-agents">{item.agents.map(agent => <li key={agent.id}><span title={agent.id}>{agent.id}</span><b>{statuses[agent.status] || agent.status}</b>{agent.message && <p>{agent.message}</p>}</li>)}</ul>
  </details>;
}
