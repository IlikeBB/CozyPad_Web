import type { CodexRuntimeEvent } from '@cozypad/contracts';

export type CodexThreadSummary = {
  id: string;
  name?: string | null;
  preview?: string;
  cwd?: string;
  updatedAt?: number;
  status?: unknown;
  turns?: CodexTurn[];
};

export type CodexTurn = {
  id: string;
  status?: string;
  items?: CodexThreadItem[];
};

export type CodexThreadItem = {
  id: string;
  type: string;
  text?: string;
  command?: string;
  cwd?: string;
  status?: string;
  aggregatedOutput?: string | null;
  content?: unknown[];
  changes?: unknown[];
  summary?: string[];
  [key: string]: unknown;
};

export type CodexTokenUsageBreakdown = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

export type CodexTokenUsage = {
  total: CodexTokenUsageBreakdown;
  last: CodexTokenUsageBreakdown;
  modelContextWindow: number | null;
};

export type CodexStructuredState = {
  threadId: string;
  turnId: string;
  turnStatus: string;
  items: CodexThreadItem[];
  tokenUsage: CodexTokenUsage | null;
  error: string;
};

export const EMPTY_CODEX_STRUCTURED_STATE: CodexStructuredState = {
  threadId: '',
  turnId: '',
  turnStatus: 'idle',
  items: [],
  tokenUsage: null,
  error: '',
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function tokenCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : 0;
}

function tokenBreakdown(value: unknown): CodexTokenUsageBreakdown {
  const usage = record(value);
  return {
    inputTokens: tokenCount(usage.inputTokens ?? usage.input_tokens),
    cachedInputTokens: tokenCount(usage.cachedInputTokens ?? usage.cached_input_tokens),
    outputTokens: tokenCount(usage.outputTokens ?? usage.output_tokens),
    reasoningOutputTokens: tokenCount(
      usage.reasoningOutputTokens ?? usage.reasoning_output_tokens,
    ),
    totalTokens: tokenCount(usage.totalTokens ?? usage.total_tokens),
  };
}

export function codexTokenUsageFrom(value: unknown): CodexTokenUsage | null {
  const usage = record(value);
  if (!Object.keys(usage).length) return null;
  const contextWindowValue = usage.modelContextWindow ?? usage.model_context_window;
  const contextWindow = Number(contextWindowValue);
  return {
    total: tokenBreakdown(usage.total),
    last: tokenBreakdown(usage.last),
    modelContextWindow:
      Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null,
  };
}

function itemFrom(value: unknown): CodexThreadItem | null {
  const candidate = record(value);
  const id = String(candidate.id || '');
  const type = String(candidate.type || 'event');
  return id ? ({ ...candidate, id, type } as CodexThreadItem) : null;
}

function upsert(items: CodexThreadItem[], item: CodexThreadItem): CodexThreadItem[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, item];
  const next = [...items];
  next[index] = { ...items[index], ...item };
  return next;
}

function appendItemText(
  items: CodexThreadItem[],
  itemId: string,
  field: 'text' | 'aggregatedOutput',
  delta: string,
): CodexThreadItem[] {
  if (!itemId || !delta) return items;
  const existing = items.find((item) => item.id === itemId);
  const item = existing || ({ id: itemId, type: 'event' } as CodexThreadItem);
  return upsert(items, { ...item, [field]: `${String(item[field] || '')}${delta}` });
}

function settleInProgressItems(items: CodexThreadItem[], turnStatus: string): CodexThreadItem[] {
  const terminalStatus = /interrupt|cancel/i.test(turnStatus) ? 'interrupted' : turnStatus;
  return items.map((item) =>
    item.status === 'inProgress' ? { ...item, status: terminalStatus } : item,
  );
}

export function structuredStateFromThread(
  thread: CodexThreadSummary,
  tokenUsage: CodexTokenUsage | null = null,
): CodexStructuredState {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const lastTurn = turns[turns.length - 1];
  return {
    threadId: thread.id,
    turnId: lastTurn?.id || '',
    turnStatus: lastTurn?.status || 'idle',
    items: turns.flatMap((turn) => (Array.isArray(turn.items) ? turn.items : [])),
    tokenUsage,
    error: '',
  };
}

export function reduceCodexRuntimeEvent(
  state: CodexStructuredState,
  event: CodexRuntimeEvent,
): CodexStructuredState {
  const params = record(event.payload);
  if (event.threadId && state.threadId && event.threadId !== state.threadId) return state;

  if (event.method === 'thread/started') {
    const thread = record(params.thread);
    return { ...state, threadId: String(thread.id || event.threadId || state.threadId) };
  }
  if (event.method === 'turn/started') {
    const turn = record(params.turn);
    return {
      ...state,
      threadId: event.threadId || state.threadId,
      turnId: String(turn.id || event.turnId || ''),
      turnStatus: String(turn.status || 'inProgress'),
      error: '',
    };
  }
  if (event.method === 'turn/completed') {
    const turn = record(params.turn);
    const turnStatus = String(turn.status || 'completed');
    return {
      ...state,
      turnId: String(turn.id || event.turnId || state.turnId),
      turnStatus,
      items: settleInProgressItems(state.items, turnStatus),
    };
  }
  if (event.method === 'thread/tokenUsage/updated') {
    const tokenUsage = codexTokenUsageFrom(params.tokenUsage ?? params.token_usage);
    return tokenUsage ? { ...state, tokenUsage } : state;
  }
  if (event.method === 'item/started' || event.method === 'item/completed') {
    const item = itemFrom(params.item);
    return item ? { ...state, items: upsert(state.items, item) } : state;
  }
  if (
    event.method === 'item/agentMessage/delta' ||
    event.method === 'item/plan/delta' ||
    event.method.includes('reasoning/')
  ) {
    return {
      ...state,
      items: appendItemText(
        state.items,
        String(params.itemId || event.itemId || ''),
        'text',
        String(params.delta || params.text || ''),
      ),
    };
  }
  if (event.method.includes('outputDelta')) {
    return {
      ...state,
      items: appendItemText(
        state.items,
        String(params.itemId || event.itemId || ''),
        'aggregatedOutput',
        String(params.delta || params.output || ''),
      ),
    };
  }
  if (event.method === 'error') {
    const error = record(params.error);
    return { ...state, error: String(error.message || params.message || 'Codex turn failed') };
  }
  return state;
}
