import type { CodexRuntimeEvent } from '@cozypad/contracts';
import type { AppServerNotification } from './protocol';

export interface CodexEventMappingContext {
  localSessionId: string;
  connectionProfileId: string;
  rawEventVersion: string;
  nextSequence(): number;
  nextEventId(): string;
  now(): string;
  fallbackThreadId?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function stringField(value: Record<string, unknown> | null, ...names: string[]): string {
  if (!value) return '';
  for (const name of names) {
    const candidate = value[name];
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  return '';
}

export function mapCodexNotification(
  notification: AppServerNotification,
  context: CodexEventMappingContext,
): CodexRuntimeEvent | null {
  const params = record(notification.params);
  const thread = record(params?.thread);
  const turn = record(params?.turn);
  const item = record(params?.item);
  const threadId =
    stringField(params, 'threadId', 'thread_id') ||
    stringField(thread, 'id') ||
    stringField(turn, 'threadId', 'thread_id') ||
    context.fallbackThreadId ||
    '';
  if (!threadId) return null;

  const turnId = stringField(params, 'turnId', 'turn_id') || stringField(turn, 'id');
  const itemId = stringField(item, 'id');
  return {
    eventId: context.nextEventId(),
    sequence: context.nextSequence(),
    localSessionId: context.localSessionId,
    connectionProfileId: context.connectionProfileId,
    threadId,
    ...(turnId ? { turnId } : {}),
    ...(itemId ? { itemId } : {}),
    method: notification.method,
    timestamp: context.now(),
    rawEventVersion: context.rawEventVersion,
    payload: notification.params,
  };
}
