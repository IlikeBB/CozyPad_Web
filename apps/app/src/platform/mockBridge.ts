import type {
  ConnectionProfile,
  ConnectionState,
  ConnectionStateChanged,
  PlatformBridge,
  RemoteSettings,
  SshConfigImportResult,
  TelemetrySnapshot,
  TmuxStatus,
  TerminalClosedEvent,
  TerminalOutputEvent,
} from '@cozypad/contracts';
import {
  ConnectionProfileSchema,
  base64ToBytes,
  bytesToBase64,
  parseSshConfigEntries,
} from '@cozypad/contracts';
import {
  MockPtyEngine,
  MockRemoteFs,
  MockTelemetryGenerator,
} from '@cozypad/test-fixtures';
import { V4_STORAGE_KEYS } from './storageKeys';

const MOCK_PROFILE: ConnectionProfile = {
  id: 'mock-local',
  name: 'Mock Host (browser)',
  host: 'mock.local',
  port: 22,
  username: 'cozy',
  authMethod: 'password',
  hasPassword: true,
  credentialPersisted: false,
};

function browserLocalStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function normalizeBrowserStorageOwner(owner: string | null | undefined): string {
  return (
    String(owner || 'anonymous')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || 'anonymous'
  );
}

function browserProfilesStorageKey(owner: string): string {
  const normalizedOwner = normalizeBrowserStorageOwner(owner);
  return normalizedOwner === 'anonymous'
    ? V4_STORAGE_KEYS.connections.browserProfiles
    : `${V4_STORAGE_KEYS.connections.browserProfiles}.${normalizedOwner}`;
}

function sanitizeStoredBrowserProfile(profile: ConnectionProfile): ConnectionProfile {
  return {
    ...profile,
    authMethod: profile.authMethod ?? 'password',
    hasPassword: false,
    hasPrivateKey: false,
    credentialPersisted: false,
  };
}

function readStoredBrowserProfiles(owner: string): ConnectionProfile[] {
  const storage = browserLocalStorage();
  if (storage === null) return [];
  try {
    const raw = storage.getItem(browserProfilesStorageKey(owner));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    const profiles: ConnectionProfile[] = [];
    for (const item of parsed) {
      const result = ConnectionProfileSchema.safeParse(item);
      if (!result.success || result.data.id === MOCK_PROFILE.id) continue;
      profiles.push(sanitizeStoredBrowserProfile(result.data));
    }
    return profiles;
  } catch {
    return [];
  }
}

function writeStoredBrowserProfiles(owner: string, profiles: ConnectionProfile[]): void {
  const storage = browserLocalStorage();
  if (storage === null) return;
  try {
    const serializable = profiles
      .filter((profile) => profile.id !== MOCK_PROFILE.id)
      .map(sanitizeStoredBrowserProfile);
    storage.setItem(
      browserProfilesStorageKey(owner),
      JSON.stringify(serializable),
    );
  } catch {
    // Browser storage is best-effort.
  }
}

function nextBrowserProfileCounter(profiles: ConnectionProfile[]): number {
  return profiles.reduce((maxId, profile) => {
    const match = profile.id.match(/^mock-p(\d+)$/);
    return match ? Math.max(maxId, Number(match[1]) + 1) : maxId;
  }, 1);
}

const MOCK_TMUX_STATUS: TmuxStatus = {
  installed: true,
  version: '3.5a',
  path: '/usr/bin/tmux',
  userLevel: false,
  satisfiesTarget: true,
  targetVersion: '3.5a',
  canInstall: true,
  missingTools: [],
  extraBuilds: [],
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface MockBridgeExtras {
  /** 模擬非預期斷線，供重連機制的 UI 驗證用。 */
  simulateDrop(): void;
  setBrowserStorageOwner(owner: string | null): void;
}

/** 純瀏覽器模式的 PlatformBridge：讓 UI 開發完全不需要 Electron 或真實主機。 */
export function createMockBridge(): PlatformBridge & MockBridgeExtras {
  const stateListeners = new Set<(event: ConnectionStateChanged) => void>();
  const outputListeners = new Set<(event: TerminalOutputEvent) => void>();
  const closedListeners = new Set<(event: TerminalClosedEvent) => void>();
  const telemetryListeners = new Set<(snapshot: TelemetrySnapshot) => void>();
  const terminals = new Map<string, MockPtyEngine>();
  const remoteFs = new MockRemoteFs();
  const telemetry = new MockTelemetryGenerator();
  let browserStorageOwner = normalizeBrowserStorageOwner(null);
  let profiles: ConnectionProfile[] = [MOCK_PROFILE, ...readStoredBrowserProfiles(browserStorageOwner)];
  const passwords = new Map<string, string>([[MOCK_PROFILE.id, 'mock']]);
  const privateKeys = new Map<string, string>();
  let connectedProfileId: string | null = null;
  let nextTerminalId = 1;
  let nextProfileId = nextBrowserProfileCounter(profiles);
  let remoteSettings: RemoteSettings = { tmuxMouseMode: true, tmuxSocket: 'default' };
  let fallbackClipboard = '';

  const emitState = (
    profileId: string,
    state: ConnectionState,
    error?: string,
  ): void => {
    const event: ConnectionStateChanged = {
      profileId,
      state,
      ...(error === undefined ? {} : { error }),
    };
    stateListeners.forEach((listener) => listener(event));
  };

  const closeAllTerminals = (): void => {
    for (const engine of terminals.values()) engine.close();
    terminals.clear();
  };

  const resetCredentialsForOwner = (): void => {
    passwords.clear();
    passwords.set(MOCK_PROFILE.id, 'mock');
    privateKeys.clear();
  };

  return {
    kind: 'mock',

    setBrowserStorageOwner(owner) {
      const nextOwner = normalizeBrowserStorageOwner(owner);
      if (nextOwner === browserStorageOwner) return;
      closeAllTerminals();
      connectedProfileId = null;
      browserStorageOwner = nextOwner;
      profiles = [MOCK_PROFILE, ...readStoredBrowserProfiles(browserStorageOwner)];
      nextProfileId = nextBrowserProfileCounter(profiles);
      resetCredentialsForOwner();
    },

    getAppInfo: () => Promise.resolve({ mockData: true }),

    listProfiles: () => Promise.resolve([...profiles]),

    saveProfile(draft) {
      const id = draft.id ?? `mock-p${nextProfileId++}`;
      if (draft.authMethod === 'privateKey') {
        passwords.delete(id);
        if (draft.privateKey) privateKeys.set(id, draft.privateKey);
      } else {
        privateKeys.delete(id);
        if (draft.password) passwords.set(id, draft.password);
      }
      const profile: ConnectionProfile = {
        id,
        name: draft.name,
        host: draft.host,
        port: draft.port,
        username: draft.username,
        authMethod: draft.authMethod,
        hasPassword: passwords.has(id),
        hasPrivateKey: privateKeys.has(id),
        credentialPersisted:
          draft.rememberCredential &&
          (passwords.has(id) || privateKeys.has(id)),
      };
      profiles = [...profiles.filter((entry) => entry.id !== id), profile];
      writeStoredBrowserProfiles(browserStorageOwner, profiles);
      return Promise.resolve(profile);
    },

    deleteProfile({ profileId }) {
      profiles = profiles.filter((profile) => profile.id !== profileId);
      passwords.delete(profileId);
      privateKeys.delete(profileId);
      writeStoredBrowserProfiles(browserStorageOwner, profiles);
      return Promise.resolve();
    },

    importSshConfig(request = {}): Promise<SshConfigImportResult> {
      const parsed = parseSshConfigEntries(request.rawConfig ?? '');
      const importedIds = new Set<string>();
      for (const entry of parsed.entries) {
        const id = `ssh-config:${entry.alias}`;
        const authMethod = entry.identityFile ? 'privateKey' : 'password';
        const profile: ConnectionProfile = {
          id,
          name: entry.alias,
          host: entry.host,
          port: entry.port,
          username: entry.username || 'ssh',
          authMethod,
          hasPassword: passwords.has(id),
          hasPrivateKey: privateKeys.has(id),
          credentialPersisted: false,
        };
        profiles = [...profiles.filter((item) => item.id !== id), profile];
        importedIds.add(id);
      }
      writeStoredBrowserProfiles(browserStorageOwner, profiles);
      return Promise.resolve({
        source: request.sourcePath,
        imported: importedIds.size,
        skipped: parsed.skipped,
        profiles: [...profiles],
      });
    },

    async connect({ profileId }) {
      emitState(profileId, 'connecting');
      await delay(300);
      connectedProfileId = profileId;
      emitState(profileId, 'connected');
      telemetry.start(profileId, (snapshot) =>
        telemetryListeners.forEach((listener) => listener(snapshot)),
      );
    },

    async disconnect({ profileId }) {
      connectedProfileId = null;
      telemetry.stop();
      closeAllTerminals();
      emitState(profileId, 'disconnected');
    },

    simulateDrop() {
      if (connectedProfileId === null) return;
      const profileId = connectedProfileId;
      connectedProfileId = null;
      telemetry.stop();
      closeAllTerminals();
      emitState(profileId, 'disconnected');
    },

    onConnectionState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },

    async openTerminal(request) {
      if (connectedProfileId === null) throw new Error('mock bridge: not connected');
      const terminalId = `mock-term-${nextTerminalId++}`;
      const engine = new MockPtyEngine(
        {
          onData: (data) => {
            const event: TerminalOutputEvent = {
              terminalId,
              dataBase64: bytesToBase64(data),
            };
            outputListeners.forEach((listener) => listener(event));
          },
          onClose: (info) => {
            terminals.delete(terminalId);
            const event: TerminalClosedEvent = {
              terminalId,
              exitCode: info.exitCode,
            };
            closedListeners.forEach((listener) => listener(event));
          },
        },
        { cols: request.cols, rows: request.rows },
      );
      terminals.set(terminalId, engine);
      setTimeout(() => engine.start(), 30);
      return { terminalId };
    },

    writeTerminal(input) {
      terminals.get(input.terminalId)?.write(base64ToBytes(input.dataBase64));
    },

    resizeTerminal(request) {
      terminals.get(request.terminalId)?.resize(request.cols, request.rows);
      return Promise.resolve();
    },

    closeTerminal(request) {
      terminals.get(request.terminalId)?.close();
      return Promise.resolve();
    },

    onTerminalOutput(listener) {
      outputListeners.add(listener);
      return () => outputListeners.delete(listener);
    },

    onTerminalClosed(listener) {
      closedListeners.add(listener);
      return () => closedListeners.delete(listener);
    },

    onTelemetry(listener) {
      telemetryListeners.add(listener);
      return () => telemetryListeners.delete(listener);
    },

    fsList: (request) => remoteFs.list(request.path),
    fsRead: async (request) => ({
      content: await remoteFs.readText(request.path, request.maxBytes, request.offset),
    }),
    fsReadBytes: async (request) => ({ dataBase64: await remoteFs.readBytes(request.path) }),
    fsWrite: (request) => remoteFs.write(request.path, request.contentBase64),
    fsCreate: (request) => remoteFs.create(request.directory, request.name, request.kind),
    fsRename: (request) => remoteFs.rename(request.path, request.newName),
    fsDuplicate: async (request) => ({ path: await remoteFs.duplicate(request.path) }),
    fsCopy: async (request) => ({
      path: await remoteFs.copyTo(request.sourcePath, request.destinationDirectory),
    }),
    fsMove: async (request) => ({
      path: await remoteFs.moveTo(request.sourcePath, request.destinationDirectory),
    }),
    fsDelete: (request) => remoteFs.remove(request.path),

    onHostKeyPrompt() {
      return () => undefined;
    },
    respondHostKey: () => Promise.resolve(),

    getBackgroundMode: () => Promise.resolve({ supported: false, enabled: false }),
    setBackgroundMode: () => Promise.resolve(),

    async readClipboard() {
      try {
        return await navigator.clipboard.readText();
      } catch {
        return fallbackClipboard;
      }
    },
    async writeClipboard(text) {
      fallbackClipboard = text;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // 瀏覽器權限不足時只保留內部緩衝
      }
    },

    getTmuxStatus: () => Promise.resolve({ ...MOCK_TMUX_STATUS }),
    installTmux: () =>
      Promise.resolve({ ok: true, status: { ...MOCK_TMUX_STATUS }, log: '' }),
    cleanupRemote: () => Promise.resolve('mock'),
    onTmuxStatus() {
      return () => undefined;
    },
    onTmuxInstallProgress() {
      return () => undefined;
    },
    onTmuxInstallLog() {
      return () => undefined;
    },

    getRemoteSettings: () => Promise.resolve({ ...remoteSettings }),
    setRemoteSettings: (patch) => {
      remoteSettings = { ...remoteSettings, ...patch };
      return Promise.resolve({ ...remoteSettings });
    },
  };
}
