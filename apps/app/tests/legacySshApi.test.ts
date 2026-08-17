import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deleteLegacyServer,
  importLegacySshConfig,
  legacyApiRequest,
  saveLegacyServer,
} from '../src/workspaces/agents/legacySshApi';

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
    ).rejects.toThrow(/actions that start work/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('uses a custom timeout and label for slow action requests', async () => {
    vi.useFakeTimers();
    setupWindow();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason ?? timeoutError());
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const request = legacyApiRequest('/api/codex/histories', {
      method: 'POST',
      body: JSON.stringify({ serverId: 'local', title: 'Task' }),
      timeoutLabel: 'Codex history create request',
      timeoutMs: 1_200,
    });
    const expectation = expect(request).rejects.toThrow(
      /Codex history create request timed out.*actions that start work/,
    );

    await vi.advanceTimersByTimeAsync(1_200);

    await expectation;
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('updates existing SSH servers with a POST action', async () => {
    setupWindow();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      expect(String(input)).toBe('/api/ssh/servers/local%3Ancku-91/update');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        name: 'NCKU 91',
        host: '10.0.0.91',
        user: 'ru035',
        port: 22,
        defaultPath: '~/project',
      });
      return jsonResponse({
        server: {
          id: 'local:ncku-91',
          source: 'local',
          name: 'NCKU 91',
          host: '10.0.0.91',
          user: 'ru035',
          port: 22,
          defaultPath: '~/project',
          hasIdentityFile: true,
          identityFileReady: true,
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      saveLegacyServer({
        id: 'local:ncku-91',
        name: 'NCKU 91',
        host: '10.0.0.91',
        user: 'ru035',
        port: 22,
        defaultPath: '~/project',
      }),
    ).resolves.toMatchObject({
      id: 'local:ncku-91',
      defaultPath: '~/project',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('deletes SSH servers with a POST action', async () => {
    setupWindow();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      expect(String(input)).toBe('/api/ssh/servers/local%3Ancku-91/delete');
      expect(init?.method).toBe('POST');
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(deleteLegacyServer('local:ncku-91')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('imports client SSH config with a POST action', async () => {
    setupWindow();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      expect(String(input)).toBe('/api/ssh/servers/import-config');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        rawConfig: 'Host ncku-91\n  HostName 140.113.110.133',
        sourceName: 'config',
      });
      return jsonResponse({
        ok: true,
        imported: 1,
        skipped: 0,
        servers: [],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      importLegacySshConfig('Host ncku-91\n  HostName 140.113.110.133', 'config'),
    ).resolves.toMatchObject({
      imported: 1,
      servers: [],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
