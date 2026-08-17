import { describe, expect, it, vi } from 'vitest';
import {
  coalesceCodexStreamMessages,
  createCodexEventBatcher,
} from '../src/workspaces/agents/codexAppServerClient';

describe('createCodexEventBatcher', () => {
  it('delivers burst events together on the scheduled refresh', () => {
    const delivered: number[][] = [];
    let callback: (() => void) | undefined;
    const cancel = vi.fn();
    const batcher = createCodexEventBatcher<number>(
      (messages) => delivered.push(messages),
      {
        schedule(next) {
          callback = next;
          return 7;
        },
        cancel,
      },
    );

    batcher.enqueue(1);
    batcher.enqueue(2);
    batcher.enqueue(3);

    expect(delivered).toEqual([]);
    callback?.();
    expect(delivered).toEqual([[1, 2, 3]]);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('flushes pending events once and cancels the scheduled refresh', () => {
    const delivered: string[][] = [];
    let callback: (() => void) | undefined;
    const cancel = vi.fn();
    const batcher = createCodexEventBatcher<string>(
      (messages) => delivered.push(messages),
      {
        schedule(next) {
          callback = next;
          return 9;
        },
        cancel,
      },
    );

    batcher.enqueue('event');
    batcher.flush();
    callback?.();

    expect(delivered).toEqual([['event']]);
    expect(cancel).toHaveBeenCalledWith(9);
  });
});

describe('coalesceCodexStreamMessages', () => {
  it('combines adjacent deltas for the same item but preserves lifecycle order', () => {
    const baseEvent = {
      eventId: 'event-1',
      sequence: 1,
      localSessionId: 'runtime-1',
      connectionProfileId: 'server-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      method: 'item/agentMessage/delta',
      timestamp: '2026-08-16T00:00:00.000Z',
      rawEventVersion: 'v1',
    } as const;
    const messages = coalesceCodexStreamMessages([
      { type: 'event', event: { ...baseEvent, payload: { itemId: 'item-1', delta: 'hello ' } } },
      { type: 'event', event: { ...baseEvent, eventId: 'event-2', sequence: 2, payload: { itemId: 'item-1', delta: 'world' } } },
      { type: 'event', event: { ...baseEvent, eventId: 'event-3', sequence: 3, method: 'item/completed', payload: { item: { id: 'item-1' } } } },
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      type: 'event',
      event: { sequence: 2, payload: { itemId: 'item-1', delta: 'hello world' } },
    });
    expect(messages[1]).toMatchObject({ type: 'event', event: { method: 'item/completed' } });
  });

  it('reduces a large streaming burst to one render message', () => {
    const messages = coalesceCodexStreamMessages(Array.from({ length: 1_000 }, (_, index) => ({
      type: 'event' as const,
      event: {
        eventId: `event-${index}`,
        sequence: index + 1,
        localSessionId: 'runtime-1',
        connectionProfileId: 'server-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        method: 'item/commandExecution/outputDelta',
        timestamp: '2026-08-16T00:00:00.000Z',
        rawEventVersion: 'v1',
        payload: { itemId: 'command-1', delta: 'x' },
      },
    })));

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'event',
      event: { sequence: 1_000, payload: { delta: 'x'.repeat(1_000) } },
    });
  });
});
