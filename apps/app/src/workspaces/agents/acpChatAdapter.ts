import type { AcpSessionUpdate, ChatItem } from '@cozypad/contracts';

function timestamp(): string {
  return new Date().toISOString();
}

function textFromAcpContent(update: Extract<AcpSessionUpdate, { kind: 'agent_message_chunk' }>): string {
  return update.content
    .map((block) => {
      if (block.type === 'text') return block.text;
      return block.filename ? `[image: ${block.filename}]` : `[image: ${block.mimeType}]`;
    })
    .join('');
}

function overlapLength(left: string, right: string): number {
  const max = Math.min(left.length, right.length);
  for (let length = max; length > 0; length -= 1) {
    if (left.slice(-length) === right.slice(0, length)) return length;
  }
  return 0;
}

export function appendAcpTextChunk(current: string, chunk: string): string {
  if (!chunk) return current;
  if (!current) return chunk;
  if (current.endsWith(chunk)) return current;
  if (chunk.startsWith(current)) return chunk;
  const overlap = overlapLength(current, chunk);
  return overlap > 0 ? `${current}${chunk.slice(overlap)}` : `${current}${chunk}`;
}

export function applyAcpSessionUpdateToChatItems(
  items: ChatItem[],
  update: AcpSessionUpdate,
): ChatItem[] {
  if (update.kind === 'agent_message_chunk') {
    const chunk = textFromAcpContent(update);
    if (!chunk) return items;
    const existingIndex = items.findIndex(
      (item) => item.kind === 'message' && item.role === 'assistant' && item.id === update.messageId,
    );
    if (existingIndex >= 0) {
      return items.map((item, index) =>
        index === existingIndex && item.kind === 'message'
          ? {
              ...item,
              text: appendAcpTextChunk(item.text, chunk),
              streaming: true,
              timestamp: item.timestamp || timestamp(),
            }
          : item,
      );
    }
    return [
      ...items,
      {
        kind: 'message',
        id: update.messageId,
        role: 'assistant',
        text: chunk,
        streaming: true,
        timestamp: timestamp(),
      },
    ];
  }

  if (update.kind === 'tool_call') {
    const existingIndex = items.findIndex(
      (item) => item.kind === 'tool_call' && item.id === update.toolCallId,
    );
    const toolItem: ChatItem = {
      kind: 'tool_call',
      id: update.toolCallId,
      name: update.name,
      summary: update.summary,
      status: update.status,
      output: update.output,
      durationMs: update.durationMs,
      timestamp: timestamp(),
    };
    if (existingIndex >= 0) {
      return items.map((item, index) => (index === existingIndex ? toolItem : item));
    }
    return [...items, toolItem];
  }

  if (update.kind === 'usage_update') {
    const usageId = `${update.sessionId}:usage`;
    const usageItem: ChatItem = {
      kind: 'usage',
      id: usageId,
      inputTokens: update.inputTokens,
      outputTokens: update.outputTokens,
      timestamp: timestamp(),
    };
    const existingIndex = items.findIndex((item) => item.kind === 'usage' && item.id === usageId);
    if (existingIndex >= 0) {
      return items.map((item, index) => (index === existingIndex ? usageItem : item));
    }
    return [...items, usageItem];
  }

  if (update.kind === 'plan') {
    if (update.entries.length === 0) return items;
    return [
      ...items,
      {
        kind: 'tool_call',
        id: `${update.sessionId}:plan:${Date.now()}`,
        name: 'plan',
        summary: 'Agent plan',
        status: 'completed',
        output: update.entries.map((entry, index) => `${index + 1}. ${entry}`).join('\n'),
        timestamp: timestamp(),
      },
    ];
  }

  if (update.kind === 'turn_completed') {
    return items.map((item) =>
      item.kind === 'message' && item.role === 'assistant' && item.streaming
        ? { ...item, streaming: false }
        : item,
    );
  }

  if (update.kind === 'error') {
    return [
      ...items,
      {
        kind: 'message',
        id: `${update.sessionId}:error:${Date.now()}`,
        role: 'assistant',
        text: `[CozyPad] ${update.message}`,
        streaming: false,
        timestamp: timestamp(),
      },
    ];
  }

  return items;
}
