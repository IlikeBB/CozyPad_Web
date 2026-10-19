import { Bot, Network } from 'lucide-react';
import type { CodexExecutionMode } from '@cozypad/contracts';

export function AgentExecutionSelect({ value, disabled, canCooperate = true, onChange }: { value: CodexExecutionMode; disabled: boolean; canCooperate?: boolean; onChange: (mode: CodexExecutionMode) => void }) {
  return <label className="composer-mode">
    {value === 'delegated' ? <Network size={15} /> : <Bot size={15} />}
    <span>執行模式</span>
    <select aria-label="Codex 執行模式" value={value} disabled={disabled} title={value === 'cooperative' ? '不同 SSH 伺服器的 Codex 協同；總 token 用量可能增加' : value === 'delegated' ? 'Codex 子代理分工後彙整；總 token 用量可能增加' : '由目前 Codex 直接處理，不啟用子代理'} onChange={event => onChange(event.target.value as CodexExecutionMode)}>
      <option value="general">一般處理</option>
      <option value="delegated">委派處理</option>
      <option value="cooperative" disabled={!canCooperate}>跨伺服器協同</option>
    </select>
  </label>;
}
