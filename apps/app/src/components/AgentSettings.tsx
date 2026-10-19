import { RefreshCw } from 'lucide-react';
import type { CodexApprovalMode, CodexExecutionMode, CodexModel, ServerProfile } from '@cozypad/contracts';
import { Busy, IconButton } from './Controls';

export type AgentOptions = { model: string; reasoningEffort: string; approvalMode: CodexApprovalMode; executionMode: CodexExecutionMode; cooperationTargetId?: string; cooperationPath?: string };
type Props = {
  server: ServerProfile;
  options: AgentOptions;
  models: CodexModel[];
  loading: boolean;
  error: string;
  disabled: boolean;
  path: string;
  onOptions: (options: AgentOptions) => void;
  onPath: (value: string) => void;
  onRefresh: () => void;
};

export function AgentSettings({ server, options, models, loading, error, disabled, path, onOptions, onPath, onRefresh }: Props) {
  const [customMode, setCustomMode] = useState(false);
  const chosen = models.find(item => item.model === options.model);
  const custom = !chosen && (customMode || !!options.model);
  const efforts = chosen?.reasoningEfforts || [];
  return <div className="agent-settings">
    <dl className="agent-target"><dt>{server.kind === 'local' ? '本機' : 'SSH 帳號'}</dt><dd>{server.kind === 'local' ? server.name : `${server.username}@${server.host}:${server.port}`}</dd></dl>
    <div className="settings-section-title"><strong>執行設定</strong><IconButton label="重新讀取模型清單" onClick={onRefresh} disabled={loading}><RefreshCw size={15} className={loading ? 'spin' : ''} /></IconButton></div>
    <label>模型<select aria-label="Codex 模型" value={custom ? '__custom' : options.model} disabled={disabled} onChange={event => {
      setCustomMode(event.target.value === '__custom');
      onOptions({ ...options, model: event.target.value === '__custom' ? '' : event.target.value, reasoningEffort: '' });
    }}>
      <option value="">遠端 CLI 預設</option>
      {models.map(item => <option value={item.model} key={item.model}>{item.displayName}{item.isDefault ? ' · 預設' : ''}</option>)}
      <option value="__custom">自訂模型</option>
    </select></label>
    {custom && <label>模型 ID<input aria-label="自訂模型 ID" value={options.model} onChange={event => onOptions({ ...options, model: event.target.value, reasoningEffort: '' })} disabled={disabled} spellCheck={false} maxLength={128} /></label>}
    {loading && <span className="muted model-loading"><Busy label="讀取遠端模型…" /></span>}
    {error && <p className="error" role="alert">{error}</p>}
    <label>推理強度<select aria-label="Codex 推理強度" value={options.reasoningEffort} disabled={disabled || !efforts.length} onChange={event => onOptions({ ...options, reasoningEffort: event.target.value })}>
      <option value="">自動</option>
      {options.reasoningEffort && !efforts.includes(options.reasoningEffort) && <option value={options.reasoningEffort}>{options.reasoningEffort}</option>}
      {efforts.map(effort => <option value={effort} key={effort}>{effort}</option>)}
    </select></label>
    <label>工作目錄<input aria-label="Codex 工作目錄" value={path} onChange={event => onPath(event.target.value)} disabled={disabled} spellCheck={false} /></label>
  </div>;
}
import { useState } from 'react';
