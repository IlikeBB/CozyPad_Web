import { Bot, ChevronDown, CircleHelp, Clock3, LoaderCircle } from 'lucide-react';
import { useMemo } from 'react';
import type { AgentEvent, AgentTask } from '@cozypad/contracts';
import { AgentApprovalRequest } from './AgentApprovalRequest';
import { AgentMessageAttachments } from './AgentAttachments';
import { AgentProcessGroup } from './AgentProcessGroup';
import { AgentMarkdown } from './AgentMarkdown';
import { AgentDelegationActivity } from './AgentDelegationActivity';
import { AgentQuestionForm } from './AgentQuestionForm';
import { AgentQuestionRequest } from './AgentQuestionRequest';
import { AgentQuestionDialog } from './AgentQuestionDialog';
import { choiceQuestion } from './choice-question.mjs';
import { groupProcessEvents } from '../workspaces/process-groups';
import { AgentCooperationActivity } from './AgentCooperationActivity';

type ChoiceAnswer = (eventId: number, answer: string, question: string) => Promise<void>;

function AssistantMessage({ task, event, userPrompt, selectable, disabled, autoOpen, onChoice }: { task: AgentTask; event: AgentEvent; userPrompt: string; selectable: boolean; disabled: boolean; autoOpen: boolean; onChoice: ChoiceAnswer }) {
  const choice = useMemo(() => selectable ? choiceQuestion(event.text, userPrompt) : null, [selectable, event.text, userPrompt]);
  const markdown = choice?.before ?? event.text;
  const waitingForChoice = task.status === 'running' && (!task.activeTurnId || event.itemCompleted === false);
  return <article className="assistant-message"><span className="message-label"><Bot size={15} />Codex</span>{markdown && <div className="markdown"><AgentMarkdown taskId={task.id} cwd={event.cwd || task.cwd || task.path} text={markdown} /></div>}
    {choice && <AgentQuestionDialog autoOpen={autoOpen} waiting={false}><AgentQuestionForm questions={[{ id: 'choice', header: '選擇項目', question: choice.question, options: choice.options, isOther: true, isSecret: false }]} disabled={disabled} submitDisabled={waitingForChoice} submitLabel="確認" onAnswer={answers => onChoice(event.id, answers.choice || '', choice.question)} />
      {waitingForChoice && <p className="muted composer-send-state">{task.activeTurnId ? '選項顯示完整後即可確認。' : '目前連線需等回覆結束後確認；這段文字提問尚未暫停工作。'}</p>}</AgentQuestionDialog>}
  </article>;
}

export function AgentTimeline({ task, choiceDisabled, onChoice, onOpenTask }: { task: AgentTask; choiceDisabled: boolean; onChoice: ChoiceAnswer; onOpenTask: (serverId: string, taskId: string) => void }) {
  const answered = new Set(task.events.filter(event => event.type === 'user' && event.replyToEventId !== undefined).map(event => event.replyToEventId));
  const nativeChoices = new Set<number>();
  let turnChoices: { id: number; question: string }[] = [], turnPrompt = '';
  for (const event of task.events) {
    if (event.type === 'user') { turnChoices = []; turnPrompt = event.text; }
    if (event.type === 'assistant') {
      const choice = choiceQuestion(event.text, turnPrompt);
      if (choice) turnChoices.push({ id: event.id, question: choice.question });
    }
    if (event.type === 'question') {
      try {
        const questions = JSON.parse(event.text).questions;
        for (const choice of turnChoices) if (Array.isArray(questions) && questions.some((question: { question: string }) => question.question === choice.question)) nativeChoices.add(choice.id);
      } catch { /* Malformed questions retain their existing error display. */ }
    }
  }
  const pendingQuestion = task.status === 'running' ? task.events.find(event => {
    if (event.type !== 'question') return false;
    try { return JSON.parse(event.text).status === 'pending'; } catch { return false; }
  }) : undefined;
  const latestUser = task.events.reduce((index, event, current) => event.type === 'user' ? current : index, -1);
  const latestChoice = pendingQuestion ? undefined : task.events.slice(latestUser + 1).reverse().find(event => event.type === 'assistant' && !answered.has(event.id) && !nativeChoices.has(event.id) && (event.itemCompleted === true || task.status !== 'running') && choiceQuestion(event.text, task.events[latestUser]?.text || ''));
  let userPrompt = '';
  return <>
    {groupProcessEvents(task.events).map(entry => {
      const key = entry.key;
      if (entry.kind === 'process') return <AgentProcessGroup key={key} group={entry} />;
      const event = entry.event;
      if (event.type === 'user') userPrompt = event.text;
      if (event.type === 'user' && event.steeringTurnId) return <div className="user-message" key={key}><span>你 · 途中引導</span><p>{event.text}</p></div>;
      if (event.type === 'approval') return <AgentApprovalRequest key={key} task={task} text={event.text} />;
      if (event.type === 'question') return <AgentQuestionRequest key={key} task={task} text={event.text} autoOpen={pendingQuestion?.id === event.id} />;
      if (event.type === 'delegation') return <AgentDelegationActivity key={key} text={event.text} />;
      if (event.type === 'cooperation') return <AgentCooperationActivity key={key} text={event.text} onOpen={onOpenTask} />;
      if (event.type === 'user') return <div className="user-message" key={key}><span>你{event.executionMode ? ` · ${event.executionMode === 'cooperative' ? '協同處理' : event.executionMode === 'delegated' ? '委派處理' : '一般處理'}` : ''}</span><p>{event.text}</p>{event.localContext && <p className="user-local-context">本機參考：{event.localContext.rootName}{event.localContext.path ? `/${event.localContext.path}` : '/'}{event.localContext.incomplete ? ' · 目錄未完整涵蓋' : ''}</p>}{!!event.attachments?.length && <AgentMessageAttachments taskId={task.id} files={event.attachments} />}</div>;
      if (event.type === 'assistant') return <AssistantMessage key={key} task={task} event={event} userPrompt={userPrompt} selectable={!answered.has(event.id) && !nativeChoices.has(event.id) && !task.remoteThreadDeleted} disabled={choiceDisabled} autoOpen={latestChoice?.id === event.id && !task.remoteThreadDeleted} onChoice={onChoice} />;
      return <details className={`process-bubble ${event.type === 'error' ? 'process-error' : ''}`} key={key} open={event.type === 'error'}>
        <summary><Clock3 size={14} /><span>{event.text.split('\n')[0]?.slice(0, 150)}</span><ChevronDown size={14} /></summary><pre>{event.text}</pre>
      </details>;
    })}
    {task.status === 'running' && <div className="running-label">{pendingQuestion ? <><CircleHelp size={15} />等待你的選擇</> : <><LoaderCircle className="spin" size={15} />正在回覆</>}</div>}
  </>;
}
