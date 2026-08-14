import { describe, expect, it, vi } from 'vitest';
import { CodexRuntimeEventSchema } from '@cozypad/contracts';
import {
  AppServerRpcClient,
  AppServerRpcError,
  mapCodexNotification,
} from '../src';

function createHarness() {
  const lines: string[] = [];
  const client = new AppServerRpcClient({
    writeLine: (line) => lines.push(line),
    requestTimeoutMs: 1_000,
  });
  return { client, lines };
}

async function initialize(client: AppServerRpcClient, lines: string[]) {
  const promise = client.initialize({
    clientInfo: { name: 'cozypad', title: 'CozyPad', version: '4.0.0' },
  });
  const request = JSON.parse(lines[0] ?? '{}') as { id: number; method: string };
  expect(request.method).toBe('initialize');
  client.ingestLine(JSON.stringify({ id: request.id, result: { platformOs: 'linux' } }));
  await promise;
  expect(JSON.parse(lines[1] ?? '{}')).toEqual({ method: 'initialized', params: {} });
}

describe('AppServerRpcClient', () => {
  it('performs initialize before regular RPC calls', async () => {
    const { client, lines } = createHarness();
    await expect(client.call('thread/list', {})).rejects.toThrow('not initialized');
    await initialize(client, lines);

    const call = client.call('thread/list', { limit: 20 });
    const request = JSON.parse(lines[2] ?? '{}') as { id: number; method: string };
    expect(request.method).toBe('thread/list');
    client.ingestLine(JSON.stringify({ id: request.id, result: { data: [] } }));
    await expect(call).resolves.toEqual({ data: [] });
  });

  it('dispatches notifications and server-initiated requests separately', async () => {
    const { client, lines } = createHarness();
    await initialize(client, lines);
    const notifications = vi.fn();
    const requests = vi.fn();
    client.onNotification(notifications);
    client.onServerRequest(requests);

    client.ingestLine(JSON.stringify({ method: 'turn/started', params: { threadId: 'thr-1' } }));
    client.ingestLine(JSON.stringify({
      id: 91,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thr-1', turnId: 'turn-1' },
    }));

    expect(notifications).toHaveBeenCalledWith({
      method: 'turn/started',
      params: { threadId: 'thr-1' },
    });
    expect(requests).toHaveBeenCalledWith(expect.objectContaining({ id: 91 }));
    client.respond(91, { decision: 'decline' });
    expect(JSON.parse(lines.at(-1) ?? '{}')).toEqual({ id: 91, result: { decision: 'decline' } });
  });

  it('preserves overload error codes for retry policy', async () => {
    const { client, lines } = createHarness();
    await initialize(client, lines);
    const call = client.call('turn/start', { threadId: 'thr-1', input: [] });
    const request = JSON.parse(lines.at(-1) ?? '{}') as { id: number };
    client.ingestLine(JSON.stringify({
      id: request.id,
      error: { code: -32001, message: 'Server overloaded; retry later.' },
    }));
    await expect(call).rejects.toMatchObject({
      name: AppServerRpcError.name,
      code: -32001,
    });
  });

  it('rejects pending requests when the transport closes', async () => {
    const { client, lines } = createHarness();
    await initialize(client, lines);
    const call = client.call('thread/read', { threadId: 'thr-1' });
    client.close(new Error('ssh channel closed'));
    await expect(call).rejects.toThrow('ssh channel closed');
  });
});

describe('mapCodexNotification', () => {
  it('preserves thread, turn, item, sequence and raw payload identity', () => {
    let sequence = 0;
    const event = mapCodexNotification({
      method: 'item/completed',
      params: {
        threadId: 'thr-1',
        turnId: 'turn-1',
        item: { id: 'item-1', type: 'agentMessage', text: 'done' },
      },
    }, {
      localSessionId: 'local-1',
      connectionProfileId: 'profile-1',
      rawEventVersion: 'codex-0.1',
      nextSequence: () => sequence++,
      nextEventId: () => 'event-1',
      now: () => '2026-08-13T08:00:00.000Z',
    });

    expect(CodexRuntimeEventSchema.parse(event)).toMatchObject({
      threadId: 'thr-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      sequence: 0,
      method: 'item/completed',
    });
  });
});
