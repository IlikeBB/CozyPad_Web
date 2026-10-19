import { useId, useRef, useState } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import type { AgentQuestion } from '@cozypad/contracts';
import { message } from '../api';

export function AgentQuestionForm({ questions, disabled = false, submitDisabled = false, submitLabel = '確認', onAnswer }: { questions: AgentQuestion[]; disabled?: boolean; submitDisabled?: boolean; submitLabel?: string; onAnswer: (answers: Record<string, string>) => Promise<void> }) {
  const prefix = useId();
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false), [sent, setSent] = useState(false), [error, setError] = useState('');
  const pending = useRef(false);
  const values = Object.fromEntries(questions.map(question => [question.id, !question.options.length || selected[question.id] === 'other' ? (custom[question.id] || '').trim() : question.options[Number(selected[question.id])]?.label || '']));
  const blocked = disabled || busy || sent;
  return <form className="agent-question-form" aria-label="Codex 選擇題" onSubmit={event => {
    event.preventDefault();
    if (blocked || submitDisabled || pending.current || Object.values(values).some(value => !value)) return;
    pending.current = true; setBusy(true); setError('');
    void onAnswer(values).then(() => setSent(true)).catch(error => setError(message(error))).finally(() => { pending.current = false; setBusy(false); });
  }}>
    {questions.map(question => <fieldset key={question.id} disabled={blocked}>
      <legend>{question.question}</legend>
      {question.options.map((option, index) => <label className="agent-choice" key={option.label}>
        <input type="radio" name={`${prefix}-${question.id}`} value={index} checked={selected[question.id] === String(index)} onChange={() => setSelected(previous => ({ ...previous, [question.id]: String(index) }))} />
        <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
      </label>)}
      {question.options.length > 0 && question.isOther && <label className="agent-choice"><input type="radio" name={`${prefix}-${question.id}`} value="other" checked={selected[question.id] === 'other'} onChange={() => setSelected(previous => ({ ...previous, [question.id]: 'other' }))} /><span>其他</span></label>}
      {question.isOther && (!question.options.length || selected[question.id] === 'other') && <label className="agent-choice-custom">{question.options.length ? '其他回覆' : '你的回覆'}{questions.length > 1 ? ` · ${question.header || question.id}` : ''}
        <input type={question.isSecret ? 'password' : 'text'} autoComplete="off" maxLength={4096} value={custom[question.id] || ''} onChange={event => setCustom(previous => ({ ...previous, [question.id]: event.target.value }))} />
      </label>}
    </fieldset>)}
    <div className="agent-question-actions"><button type="submit" className="primary" disabled={blocked || submitDisabled || Object.values(values).some(value => !value)}>{busy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}{sent ? '已回覆' : submitLabel}</button></div>
    {error && <p className="error" role="alert">{error}</p>}
  </form>;
}
