import { Plus, Search, Trash2 } from 'lucide-react';
import type { AgentTask } from '@cozypad/contracts';
import { IconButton } from './Controls';

export const taskLabels = { running: '執行中', completed: '已完成', failed: '失敗', cancelled: '已停止' };
export type TaskStage = 'all' | AgentTask['status'];

type Props = {
  tasks: AgentTask[];
  selected: string | null;
  search: string;
  stage: TaskStage;
  loading: boolean;
  onSearch: (value: string) => void;
  onStage: (value: TaskStage) => void;
  onSelect: (task: AgentTask) => void;
  onDelete: (task: AgentTask) => void;
  onNew: () => void;
};

export function AgentTaskList({ tasks, selected, search, stage, loading, onSearch, onStage, onSelect, onDelete, onNew }: Props) {
  const visible = tasks.filter(task => (stage === 'all' || task.status === stage) && (task.prompt.toLowerCase().includes(search.toLowerCase()) || task.events.some(event => event.type === 'user' && event.text.toLowerCase().includes(search.toLowerCase()))));
  return <>
    <label className="search-field"><Search size={15} /><input aria-label="搜尋 Codex 工作" placeholder="搜尋工作" value={search} onChange={event => onSearch(event.target.value)} /></label>
    <label className="task-stage">工作階段<select aria-label="工作階段" value={stage} onChange={event => onStage(event.target.value as TaskStage)}>
      <option value="all">全部 ({tasks.length})</option>
      {Object.entries(taskLabels).map(([value, label]) => <option key={value} value={value}>{label} ({tasks.filter(task => task.status === value).length})</option>)}
    </select></label>
    <div className="task-list">{visible.map(task => <div className={`task-row ${selected === task.id ? 'selected' : ''}`} key={task.id}>
      <button className="task-select" type="button" onClick={() => onSelect(task)} aria-pressed={selected === task.id}>
      <strong>{task.prompt}</strong><small className="task-path" title={task.path}>{task.path} · {task.turnCount || 1} 輪</small><span><i className={`status-dot ${task.status}`} />{taskLabels[task.status]}<time>{new Date(task.updatedAt || task.createdAt).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></span>
      </button><IconButton label={`刪除工作階段 ${task.prompt}`} className="task-delete" disabled={task.status === 'running' || loading} onClick={() => onDelete(task)}><Trash2 size={15} /></IconButton>
    </div>)}{!visible.length && <p className="muted empty-list">{loading ? '正在載入工作…' : search || stage !== 'all' ? '沒有符合的工作' : '尚無工作'}</p>}</div>
    <div className="drawer-footer"><button className="secondary" onClick={onNew}><Plus size={16} />新對話</button></div>
  </>;
}
