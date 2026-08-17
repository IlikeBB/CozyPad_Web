import { afterEach, describe, expect, it, vi } from 'vitest';
import { legacyApiRequest } from '../src/workspaces/agents/legacySshApi';

function setupWindow(hostname = 'localhost'): void {
  vi.stubGlobal('window', {
    location: { hostname },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function timeoutError(): Error {
  const error = new Error('request timed out');
  error.name = 'TimeoutError';
  return error;
}

describe('legacyApiRequest', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('probes API health and retries safe requests after a timeout', async () => {
    vi.useFakeTimers();
    setupWindow();

    let call = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      call += 1;
      const url = String(input);

      if (call === 1) throw timeoutError();
      if (url === '/api/health') return jsonResponse({ ok: true });
      if (url === '/api/ssh/servers') return jsonResponse({ servers: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const request = legacyApiRequest<{ servers: unknown[] }>('/api/ssh/servers');

    await vi.advanceTimersByTimeAsync(600);

    await expect(request).resolves.toEqual({ servers: [] });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      '/api/ssh/servers',
      '/api/health',
      '/api/ssh/servers',
    ]);
  });

  it('does not retry unsafe requests after a timeout', async () => {
    setupWindow();
    const fetchMock = vi.fn(async (): Promise<Response> => {
      throw timeoutError();
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      legacyApiRequest('/api/public/start', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    ).rejects.toThrow(/retries safe status\/list requests/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
