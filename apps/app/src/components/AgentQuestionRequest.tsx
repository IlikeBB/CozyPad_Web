import { CircleHelp } from 'lucide-react';
import type { AgentQuestionRequest as QuestionRequest, AgentTask } from '@cozypad/contracts';
import { post } from '../api';
import { AgentQuestionForm } from './AgentQuestionForm';
import { AgentQuestionDialog } from './AgentQuestionDialog';

export function AgentQuestionRequest({ task, text, autoOpen = false }: { task: AgentTask; text: string; autoOpen?: boolean }) {
  let request: QuestionRequest;
  try { request = JSON.parse(text); } catch { return <p className="error">無法讀取提問。</p>; }
  const pending = request.status === 'pending' && task.status === 'running';
  return <section className="agent-question-request" aria-label="Codex 提問">
    <header><CircleHelp size={16} /><strong>Codex 提問</strong><span>{pending ? '等待回覆' : request.status === 'answered' ? '已回覆' : '已結束'}</span></header>
    {pending ? <AgentQuestionDialog key={request.id} autoOpen={autoOpen} waiting><AgentQuestionForm questions={request.questions} onAnswer={answers => post(`/tasks/${encodeURIComponent(task.id)}/answer`, { requestId: request.id, answers })} /></AgentQuestionDialog>
      : request.questions.map(question => <div className="agent-question-result" key={question.id}><p>{question.question}</p>{request.status === 'answered' && <strong>{question.isSecret ? '已回覆' : request.answers?.[question.id]}</strong>}</div>)}
  </section>;
}
