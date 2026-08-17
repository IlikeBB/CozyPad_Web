import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionStateChanged, TerminalOutputEvent } from '@cozypad/contracts';
import { base64ToText, textToBase64 } from '@cozypad/contracts';
import { createMockBridge } from '../src/platform/mockBridge';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

describe('createMockBridge', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exposes the mock profile', async () => {
    const bridge = createMockBridge();
    const profiles = await bridge.listProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.host).toBe('mock.local');
  });

  it('persists browser profile metadata across refreshes', async () => {
    vi.stubGlobal('window', { localStorage: createMemoryStorage() });

    const firstBridge = createMockBridge();
    const saved = await firstBridge.saveProfile({
      name: 'NCKU 91',
      host: '10.0.0.91',
      port: 22,
      username: 'ru035',
      authMethod: 'password',
      password: 'secret',
      rememberCredential: true,
    });
    expect(saved.hasPassword).toBe(true);

    const refreshedBridge = createMockBridge();
    const profiles = await refreshedBridge.listProfiles();
    const restored = profiles.find((profile) => profile.host === '10.0.0.91');
    expect(restored?.name).toBe('NCKU 91');
    expect(restored?.username).toBe('ru035');
    expect(restored?.hasPassword).toBe(false);
    expect(restored?.credentialPersisted).toBe(false);
  });

  it('removes stored browser profiles across refreshes', async () => {
    vi.stubGlobal('window', { localStorage: createMemoryStorage() });

    const bridge = createMockBridge();
    const saved = await bridge.saveProfile({
      name: 'Delete Me',
      host: '10.0.0.92',
      port: 22,
      username: 'ru035',
      authMethod: 'password',
      password: 'secret',
      rememberCredential: true,
    });
    await bridge.deleteProfile({ profileId: saved.id });

    const refreshedBridge = createMockBridge();
    const profiles = await refreshedBridge.listProfiles();
    expect(profiles.some((profile) => profile.id === saved.id)).toBe(false);
  });

  it('imports SSH config entries into browser profile metadata', async () => {
    vi.stubGlobal('window', { localStorage: createMemoryStorage() });

    const bridge = createMockBridge();
    const result = await bridge.importSshConfig({
      rawConfig: [
        'Host ncku-91',
        '  HostName 140.113.110.133',
        '  User ru035',
        '  Port 7735',
      ].join('\n'),
      sourcePath: 'config',
    });

    expect(result.imported).toBe(1);
    const refreshedBridge = createMockBridge();
    const profiles = await refreshedBridge.listProfiles();
    expect(profiles.find((profile) => profile.id === 'ssh-config:ncku-91')).toMatchObject({
      name: 'ncku-91',
      host: '140.113.110.133',
      port: 7735,
      username: 'ru035',
    });
  });

  it('walks connecting → connected on connect', async () => {
    const bridge = createMockBridge();
    const states: ConnectionStateChanged['state'][] = [];
    bridge.onConnectionState((event) => states.push(event.state));
    await bridge.connect({ profileId: 'mock-local' });
    expect(states).toEqual(['connecting', 'connected']);
  });

  it('refuses to open a terminal before connecting', async () => {
    const bridge = createMockBridge();
    await expect(
      bridge.openTerminal({ profileId: 'mock-local', cols: 80, rows: 24 }),
    ).rejects.toThrow('not connected');
  });

  it('streams the banner after opening a terminal', async () => {
    const bridge = createMockBridge();
    await bridge.connect({ profileId: 'mock-local' });
    const chunks: TerminalOutputEvent[] = [];
    bridge.onTerminalOutput((event) => chunks.push(event));
    const { terminalId } = await bridge.openTerminal({
      profileId: 'mock-local',
      cols: 80,
      rows: 24,
    });
    await delay(80);
    const text = chunks
      .filter((chunk) => chunk.terminalId === terminalId)
      .map((chunk) => base64ToText(chunk.dataBase64))
      .join('');
    expect(text).toContain('CozyPad mock shell');
  });

  it('echoes input and runs commands through the PTY stream', async () => {
    const bridge = createMockBridge();
    await bridge.connect({ profileId: 'mock-local' });
    const chunks: TerminalOutputEvent[] = [];
    bridge.onTerminalOutput((event) => chunks.push(event));
    const { terminalId } = await bridge.openTerminal({
      profileId: 'mock-local',
      cols: 80,
      rows: 24,
    });
    await delay(80);
    bridge.writeTerminal({ terminalId, dataBase64: textToBase64('ls\r') });
    const text = chunks.map((chunk) => base64ToText(chunk.dataBase64)).join('');
    expect(text).toContain('cozypad.study.yaml');
  });

  it('emits closed events and drops terminals on disconnect', async () => {
    const bridge = createMockBridge();
    await bridge.connect({ profileId: 'mock-local' });
    const closed: string[] = [];
    bridge.onTerminalClosed((event) => closed.push(event.terminalId));
    const { terminalId } = await bridge.openTerminal({
      profileId: 'mock-local',
      cols: 80,
      rows: 24,
    });
    await bridge.disconnect({ profileId: 'mock-local' });
    expect(closed).toEqual([terminalId]);
  });
});
