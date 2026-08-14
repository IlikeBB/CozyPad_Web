import { describe, expect, it } from 'vitest';
import type { CodexRuntimeEvent } from '@cozypad/contracts';
import {
  EMPTY_CODEX_STRUCTURED_STATE,
  reduceCodexRuntimeEvent,
} from '../src/workspaces/agents/codexAppServerState';

function event(method: string, payload: Record<string, unknown>): CodexRuntimeEvent {
  return {
    eventId: crypto.randomUUID(),
    sequence: 1,
    localSessionId: 'runtime',
    connectionProfileId: 'server-91',
    threadId: 'thread-1',
    turnId: 'turn-1',
    method,
    timestamp: new Date().toISOString(),
    rawEventVersion: 'v1',
    payload,
  };
}

describe('reduceCodexRuntimeEvent', () => {
  it('keeps user and agent items separate and appends deltas by item id', () => {
    const withUser = reduceCodexRuntimeEvent(
      { ...EMPTY_CODEX_STRUCTURED_STATE, threadId: 'thread-1' },
      event('item/started', {
        item: { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'hello' }] },
      }),
    );
    const withAgent = reduceCodexRuntimeEvent(
      withUser,
      event('item/started', { item: { id: 'agent-1', type: 'agentMessage', text: '' } }),
    );
    const streamed = reduceCodexRuntimeEvent(
      withAgent,
      event('item/agentMessage/delta', { itemId: 'agent-1', delta: 'world' }),
    );

    expect(streamed.items).toHaveLength(2);
    expect(streamed.items[0]).toMatchObject({ id: 'user-1', type: 'userMessage' });
    expect(streamed.items[1]).toMatchObject({ id: 'agent-1', text: 'world' });
  });

  it('ignores events for a different selected thread', () => {
    const state = { ...EMPTY_CODEX_STRUCTURED_STATE, threadId: 'thread-other' };
    expect(reduceCodexRuntimeEvent(state, event('turn/started', {}))).toBe(state);
  });

  it('tracks command output independently from assistant text', () => {
    const state = reduceCodexRuntimeEvent(
      { ...EMPTY_CODEX_STRUCTURED_STATE, threadId: 'thread-1' },
      event('item/started', {
        item: { id: 'cmd-1', type: 'commandExecution', command: 'pwd', aggregatedOutput: '' },
      }),
    );
    const next = reduceCodexRuntimeEvent(
      state,
      event('item/commandExecution/outputDelta', { itemId: 'cmd-1', delta: '/workspace\n' }),
    );
    expect(next.items[0]).toMatchObject({ command: 'pwd', aggregatedOutput: '/workspace\n' });
  });

  it('settles running command cards when a turn is interrupted', () => {
    const running = reduceCodexRuntimeEvent(
      { ...EMPTY_CODEX_STRUCTURED_STATE, threadId: 'thread-1' },
      event('item/started', {
        item: { id: 'cmd-1', type: 'commandExecution', command: 'sleep 30', status: 'inProgress' },
      }),
    );
    const interrupted = reduceCodexRuntimeEvent(
      running,
      event('turn/completed', { turn: { id: 'turn-1', status: 'interrupted' } }),
    );

    expect(interrupted.turnStatus).toBe('interrupted');
    expect(interrupted.items[0]).toMatchObject({ id: 'cmd-1', status: 'interrupted' });
  });

  it('records app-server token usage updates for the selected thread', () => {
    const state = reduceCodexRuntimeEvent(
      { ...EMPTY_CODEX_STRUCTURED_STATE, threadId: 'thread-1' },
      event('thread/tokenUsage/updated', {
        tokenUsage: {
          total: {
            inputTokens: 12_000,
            cachedInputTokens: 8_000,
            outputTokens: 2_000,
            reasoningOutputTokens: 500,
            totalTokens: 14_000,
          },
          last: {
            inputTokens: 2_500,
            cachedInputTokens: 2_000,
            outputTokens: 600,
            reasoningOutputTokens: 200,
            totalTokens: 3_100,
          },
          modelContextWindow: 200_000,
        },
      }),
    );

    expect(state.tokenUsage).toEqual({
      total: {
        inputTokens: 12_000,
        cachedInputTokens: 8_000,
        outputTokens: 2_000,
        reasoningOutputTokens: 500,
        totalTokens: 14_000,
      },
      last: {
        inputTokens: 2_500,
        cachedInputTokens: 2_000,
        outputTokens: 600,
        reasoningOutputTokens: 200,
        totalTokens: 3_100,
      },
      modelContextWindow: 200_000,
    });
  });
});
