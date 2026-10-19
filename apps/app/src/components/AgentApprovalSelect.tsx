import { ShieldAlert, ShieldCheck } from 'lucide-react';
import type { CodexApprovalMode } from '@cozypad/contracts';

export function AgentApprovalSelect({ value, disabled, onChange }: { value: CodexApprovalMode; disabled: boolean; onChange: (mode: CodexApprovalMode) => void }) {
  return <label className={`composer-approval ${value === 'full-access' ? 'full-access' : ''}`}>
    {value === 'full-access' ? <ShieldAlert size={15} /> : <ShieldCheck size={15} />}
    <span>動作核准</span>
    <select aria-label="Codex 核准模式" value={value} disabled={disabled} title={value === 'full-access' ? '允許遠端 Codex 不經核准存取檔案及網路' : 'Codex 動作核准模式'} onChange={event => onChange(event.target.value as CodexApprovalMode)}>
      <option value="ask">要求核准</option>
      <option value="auto">代表核准</option>
      <option value="full-access">完整存取權</option>
    </select>
  </label>;
}
