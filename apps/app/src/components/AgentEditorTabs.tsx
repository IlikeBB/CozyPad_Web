import { Bot, FileText, Plus, X } from 'lucide-react';
import { IconButton } from './Controls';

export type EditorTab = { key: string; label: string; kind: 'chat' | 'file'; title: string; status?: string };
export function AgentEditorTabs({ tabs, selected, disabled, onSelect, onClose, onNew }: {
  tabs: EditorTab[]; selected: string; disabled: boolean; onSelect: (key: string) => void; onClose: (key: string) => void; onNew: () => void;
}) {
  return <div className="agent-editor-tabs"><div className="agent-tab-list" role="tablist" aria-label="工作與檔案分頁" onKeyDown={event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || disabled || event.target instanceof HTMLElement && event.target.getAttribute('role') !== 'tab') return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    event.preventDefault(); buttons[next]?.click(); buttons[next]?.focus();
  }}>{tabs.map(tab => <div key={tab.key} className={`agent-editor-tab ${selected === tab.key ? 'active' : ''}`}>
    <button type="button" role="tab" aria-selected={selected === tab.key} tabIndex={selected === tab.key ? 0 : -1} disabled={disabled} title={tab.title} onClick={() => onSelect(tab.key)}>
      {tab.kind === 'chat' ? <Bot size={15} /> : <FileText size={15} />}<span>{tab.label}</span>{tab.status && <i className={`status-dot ${tab.status}`} />}
    </button><IconButton label={`關閉分頁 ${tab.label}`} disabled={disabled} onClick={() => onClose(tab.key)}><X size={13} /></IconButton>
  </div>)}</div><IconButton label="新增 Codex 對話" disabled={disabled} onClick={onNew}><Plus size={17} /></IconButton></div>;
}
