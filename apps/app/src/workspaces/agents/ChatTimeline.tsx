import { useEffect, useRef } from 'react';
import Markdown from 'react-markdown';
import type { ChatItem } from '@cozypad/contracts';
import {
  markdownRehypePlugins,
  markdownRemarkPlugins,
  normalizeMarkdownMath,
} from '../../components/markdownPlugins';
import {
  createMarkdownComponents,
  linkifyRemotePathLines,
  markdownComponents,
} from '../../components/markdownComponents';

interface ChatTimelineProps {
  sessionId: string;
  items: ChatItem[];
  assistantLabel?: string;
  serverId?: string;
  onOpenFilesPath?: (target: { serverId: string; path: string }) => void;
  onResolveApproval(itemId: string, resolution: 'allowed' | 'denied'): void;
  onAnswerQuestion(itemId: string, optionIndex: number): void;
}

function DiffBody({ diff }: { diff: string }) {
  return (
    <pre className="diff-body">
      {diff.split('\n').map((line, index) => {
        const cls = line.startsWith('+')
          ? 'diff-add'
          : line.startsWith('-')
            ? 'diff-del'
            : line.startsWith('@@')
              ? 'diff-hunk'
              : '';
        return (
          <span key={index} className={cls}>
            {line}
            {'\n'}
          </span>
        );
      })}
    </pre>
  );
}

type AssistantSection =
  | { kind: 'text'; text: string }
  | { kind: 'meta' | 'tool' | 'status'; title: string; label: string; text: string };

function normalizeAssistantText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/([^\n])(\s*\[(?:Codex|Claude|agy|bailian|baillian|CozyPad(?: Local [^\]]+)?)\])/gi, '$1\n$2')
    .replace(/\[(?:Codex|Claude|agy|bailian|baillian)\]\s*turn (?:started|complete|completed)/gi, '')
    .replace(/[ \t]+\n/g, '\n');
}

function isAgentEventLine(line: string): boolean {
  return /^\s*\[(?:Codex|Claude|agy|bailian|baillian|CozyPad(?: Local [^\]]+)?)\]/i.test(line);
}

function isHiddenAgentEventLine(line: string): boolean {
  const lower = line.trim().toLowerCase();
  return (
    lower.startsWith('[codex] turn started') ||
    lower.startsWith('[codex] turn complete') ||
    lower.startsWith('[codex] turn completed') ||
    lower.startsWith('[claude] turn started') ||
    lower.startsWith('[claude] turn complete') ||
    lower.startsWith('[claude] turn completed') ||
    lower.startsWith('[agy] turn started') ||
    lower.startsWith('[agy] turn complete') ||
    lower.startsWith('[agy] turn completed') ||
    lower.startsWith('[bailian] turn started') ||
    lower.startsWith('[bailian] turn complete') ||
    lower.startsWith('[bailian] turn completed') ||
    lower.startsWith('[baillian] turn started') ||
    lower.startsWith('[baillian] turn complete') ||
    lower.startsWith('[baillian] turn completed')
  );
}

function isToolishLine(line: string): boolean {
  const lower = line.trim().toLowerCase();
  return (
    lower === 'exec' ||
    lower.startsWith('exec ') ||
    lower.startsWith('tool:') ||
    lower.startsWith('usage ') ||
    lower.startsWith('usage —') ||
    lower.startsWith('tokens used') ||
    lower.startsWith('wall time:') ||
    lower.startsWith('output:') ||
    /^\d{4}-\d{2}-\d{2}t/i.test(lower)
  );
}

function isSectionBoundary(line: string): boolean {
  const trimmed = line.trim();
  const lower = trimmed.toLowerCase();
  return (
    trimmed === '' ||
    lower === 'user' ||
    lower === 'assistant' ||
    lower === 'claude' ||
    lower === 'codex' ||
    lower === 'agy' ||
    lower === 'bailian' ||
    lower === 'baillian'
  );
}

function lineCount(text: string): number {
  return normalizeAssistantText(text).split('\n').filter((line) => line.trim()).length || 1;
}

function summarizeSection(text: string, fallback: string): string {
  return (
    normalizeAssistantText(text)
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean)
      ?.slice(0, 120) || fallback
  );
}

function sectionLabel(text: string, kind: 'meta' | 'tool' | 'status'): string {
  const first = summarizeSection(text, '');
  const match = first.match(/^\s*\[([^\]]+)\]/);
  if (match?.[1]) {
    return match[1].replace(/^CozyPad\s+/i, '').slice(0, 16) || 'Meta';
  }
  return kind === 'tool' ? 'Tool' : kind === 'status' ? 'Status' : 'Meta';
}

function classifyAssistantSection(text: string): 'meta' | 'tool' | 'status' {
  const lower = normalizeAssistantText(text).toLowerCase();
  if (
    lower.includes('error') ||
    lower.includes('failed') ||
    lower.includes('denied') ||
    lower.includes('not found') ||
    lower.includes('connection closed') ||
    lower.includes('connection reset') ||
    lower.includes('exit code')
  ) {
    return 'status';
  }
  if (
    lower.includes('started command execution') ||
    lower.includes('tool call') ||
    normalizeAssistantText(text).split('\n').some(isToolishLine)
  ) {
    return 'tool';
  }
  return 'meta';
}

function isMarkdownBlockStart(line: string, afterBlank: boolean): boolean {
  const trimmed = line.trim();
  return (
    /^#{1,6}\s+\S/.test(trimmed) ||
    /^\*\*[^*]+?\*\*\s*[:：]?$/.test(trimmed) ||
    (afterBlank && /^\d+\.\s+\S/.test(trimmed)) ||
    (afterBlank && /^[-*]\s+\*\*[^*]+?\*\*/.test(trimmed)) ||
    /^-{3,}$/.test(trimmed)
  );
}

function splitAssistantTextBlocks(text: string): string[] {
  const normalized = text.trimEnd();
  if (!normalized.trim()) return [];

  const lines = normalized.split('\n');
  const blocks: string[] = [];
  let buffer: string[] = [];
  let inCodeFence = false;
  let blankRun = 0;
  let previousWasBlank = false;

  const flush = () => {
    const block = buffer.join('\n').trim();
    if (block) blocks.push(block);
    buffer = [];
    blankRun = 0;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const fence = trimmed.startsWith('```');

    if (!inCodeFence && buffer.some((item) => item.trim()) && isMarkdownBlockStart(line, previousWasBlank)) {
      flush();
    }

    buffer.push(line);

    if (fence) {
      inCodeFence = !inCodeFence;
      blankRun = 0;
      continue;
    }

    if (inCodeFence) continue;

    if (!trimmed) {
      blankRun += 1;
      previousWasBlank = true;
      if (blankRun >= 2) flush();
      continue;
    }

    blankRun = 0;
    previousWasBlank = false;
  }

  flush();
  return blocks;
}

function pushAssistantSection(sections: AssistantSection[], section: AssistantSection): void {
  if (!section.text.trim()) return;
  const previous = sections[sections.length - 1];
  if (section.kind === 'text') {
    for (const block of splitAssistantTextBlocks(section.text)) {
      sections.push({ kind: 'text', text: block });
    }
    return;
  }
  if (previous?.kind !== 'text' && previous?.kind === section.kind) {
    previous.text = `${previous.text}\n${section.text}`.trimEnd();
    previous.title = summarizeSection(previous.text, previous.title);
    return;
  }
  sections.push(section);
}

function parseAssistantSections(text: string): AssistantSection[] {
  const sections: AssistantSection[] = [];
  const lines = normalizeAssistantText(text).split('\n');
  let index = 0;
  let textBuffer: string[] = [];

  const flushText = () => {
    pushAssistantSection(sections, { kind: 'text', text: textBuffer.join('\n').trimEnd() });
    textBuffer = [];
  };

  while (index < lines.length) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();

    if (isHiddenAgentEventLine(line)) {
      index += 1;
      continue;
    }

    if (isAgentEventLine(line) || isToolishLine(line)) {
      flushText();
      const blockLines = [line];
      index += 1;
      while (index < lines.length) {
        const nextLine = lines[index] ?? '';
        if (isHiddenAgentEventLine(nextLine)) {
          index += 1;
          continue;
        }
        if (isAgentEventLine(nextLine) || isToolishLine(nextLine)) {
          blockLines.push(nextLine);
          index += 1;
          continue;
        }
        if (isSectionBoundary(nextLine)) break;
        blockLines.push(nextLine);
        index += 1;
      }
      const blockText = blockLines.join('\n').trimEnd();
      const kind = classifyAssistantSection(blockText);
      pushAssistantSection(sections, {
        kind,
        label: sectionLabel(blockText, kind),
        title: summarizeSection(blockText, kind === 'tool' ? 'Tool output' : 'Agent event'),
        text: blockText,
      });
      continue;
    }

    textBuffer.push(line);
    index += 1;
  }

  flushText();
  return sections;
}

function renderAssistantStatusCard(section: Extract<AssistantSection, { kind: 'meta' | 'tool' | 'status' }>, index: number) {
  return (
    <details
      className={`legacy-codex-card legacy-codex-card-${section.kind} agent-processing-card`}
      key={`${section.kind}-${index}-${section.title}`}
    >
      <summary>
        <span className="legacy-codex-card-chevron" aria-hidden="true" />
        <span className="legacy-codex-card-dot" />
        <span className="legacy-codex-card-badge">{section.label}</span>
        <span className="legacy-codex-card-title">{section.title}</span>
        <span className="legacy-codex-card-lines">{lineCount(section.text)} lines</span>
      </summary>
      <pre>{section.text}</pre>
    </details>
  );
}

function renderMarkdownMessage(
  text: string,
  serverId: string,
  className: string,
  onOpenFilesPath?: (target: { serverId: string; path: string }) => void,
) {
  return (
    <div className={`markdown legacy-codex-markdown ${className}`}>
      <Markdown
        components={onOpenFilesPath ? createMarkdownComponents(onOpenFilesPath) : markdownComponents}
        remarkPlugins={markdownRemarkPlugins}
        rehypePlugins={markdownRehypePlugins}
      >
        {normalizeMarkdownMath(linkifyRemotePathLines(text, serverId))}
      </Markdown>
    </div>
  );
}

function renderAssistantBody(
  text: string,
  serverId: string,
  onOpenFilesPath?: (target: { serverId: string; path: string }) => void,
) {
  return (
    <div className="agent-rich-message">
      {parseAssistantSections(text).map((section, index) =>
        section.kind === 'text' ? (
          <div key={`text-${index}`}>
            {renderMarkdownMessage(section.text, serverId, 'agent-text-markdown', onOpenFilesPath)}
          </div>
        ) : (
          renderAssistantStatusCard(section, index)
        ),
      )}
    </div>
  );
}

export function ChatTimeline({
  sessionId,
  items,
  assistantLabel = 'Agent',
  serverId = '',
  onOpenFilesPath,
  onResolveApproval,
  onAnswerQuestion,
}: ChatTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());
  const lastSession = useRef<string | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (lastSession.current !== sessionId) {
      if (lastSession.current !== null) {
        positions.current.set(lastSession.current, el.scrollTop);
      }
      el.scrollTop = positions.current.get(sessionId) ?? el.scrollHeight;
      lastSession.current = sessionId;
      return;
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [sessionId, items]);

  return (
    <div className="chat-timeline" ref={scrollRef}>
      {items.map((item) => {
        switch (item.kind) {
          case 'message':
            return (
              <div
                key={item.id}
                className={`msg msg-${item.role}${item.streaming ? ' msg-streaming' : ''}`}
              >
                <div className="msg-stack">
                  <div className="msg-label">{item.role === 'assistant' ? assistantLabel : 'User'}</div>
                  <div className="msg-body">
                    {item.role === 'assistant'
                      ? renderAssistantBody(item.text, serverId, onOpenFilesPath)
                      : renderMarkdownMessage(item.text, serverId, 'agent-user-markdown', onOpenFilesPath)}
                    {item.streaming ? <span className="caret" /> : null}
                  </div>
                </div>
              </div>
            );
          case 'tool_call':
            return (
              <details key={item.id} className={`card tool-card tool-${item.status}`}>
                <summary>
                  <span className={`tool-status tool-status-${item.status}`} />
                  <span className="tool-name">{item.name}</span>
                  <span className="tool-summary mono">{item.summary}</span>
                  {item.durationMs !== undefined ? (
                    <span className="tool-duration">{item.durationMs}ms</span>
                  ) : null}
                </summary>
                {item.output ? <pre className="tool-output">{item.output}</pre> : null}
              </details>
            );
          case 'file_diff':
            return (
              <details key={item.id} className="card diff-card" open>
                <summary>
                  <span className="mono diff-path">{item.path}</span>
                  <span className="diff-stat">
                    <span className="diff-add">+{item.additions}</span>{' '}
                    <span className="diff-del">−{item.deletions}</span>
                  </span>
                </summary>
                <DiffBody diff={item.diff} />
              </details>
            );
          case 'approval':
            return (
              <div key={item.id} className={`card approval-card approval-${item.resolution}`}>
                <div className="approval-head">
                  <span className="approval-title">需要核准</span>
                  <span className="approval-risk">{item.riskSummary}</span>
                </div>
                <code className="approval-command">{item.command}</code>
                <div className="approval-meta mono">cwd: {item.cwd}</div>
                {item.resolution === 'pending' ? (
                  <div className="approval-actions">
                    <button
                      className="btn-allow"
                      onClick={() => onResolveApproval(item.id, 'allowed')}
                    >
                      允許
                    </button>
                    <button
                      className="btn-deny"
                      onClick={() => onResolveApproval(item.id, 'denied')}
                    >
                      拒絕
                    </button>
                  </div>
                ) : (
                  <span className={`chip chip-${item.resolution}`}>
                    {item.resolution === 'allowed' ? '已允許' : '已拒絕'}
                  </span>
                )}
              </div>
            );
          case 'question':
            return (
              <div key={item.id} className="card question-card">
                <div className="question-prompt">{item.prompt}</div>
                <div className="question-options">
                  {item.options.map((option, index) => {
                    const chosen = item.selectedIndex === index;
                    const answered = item.selectedIndex !== null;
                    return (
                      <button
                        key={option.label}
                        className={`question-option${chosen ? ' question-option-chosen' : ''}`}
                        disabled={answered}
                        onClick={() => onAnswerQuestion(item.id, index)}
                      >
                        <span className="question-label">{option.label}</span>
                        {option.description ? (
                          <span className="question-desc">{option.description}</span>
                        ) : null}
                        {chosen ? <span className="question-check">✓</span> : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          case 'usage':
            return (
              <div key={item.id} className="usage-row">
                usage — in {item.inputTokens.toLocaleString()} / out{' '}
                {item.outputTokens.toLocaleString()} tokens
              </div>
            );
        }
      })}
    </div>
  );
}
