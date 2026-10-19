import { ArrowUpRight, Network } from 'lucide-react';
import { IconButton } from './Controls';
const labels: Record<string, string> = { running: '執行中', completed: '已完成', failed: '失敗', cancelled: '已停止' };
export function AgentCooperationActivity({ text, onOpen }: { text: string; onOpen: (serverId: string, taskId: string) => void }) {
  let value: { taskId: string; serverId: string; prompt: string; status: string; pendingUserAction: string[] };
  try { value = JSON.parse(text); if (typeof value.taskId !== 'string' || typeof value.serverId !== 'string') return null; } catch { return null; }
  return <div className="cooperation-activity"><Network size={16} /><div><strong>{value.serverId.startsWith('local-') ? '本機 Codex' : '遠端 Codex'} · {labels[value.status] || value.status}</strong><span>{value.prompt}</span>{!!value.pendingUserAction?.length && <small>等待使用者核准／回答</small>}</div><IconButton label="查看協同任務" onClick={() => onOpen(value.serverId, value.taskId)}><ArrowUpRight size={17} /></IconButton></div>;
}
