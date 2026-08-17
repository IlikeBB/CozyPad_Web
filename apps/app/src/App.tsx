import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ConnectionProfile,
  ConnectionState,
  HostKeyPromptEvent,
  TmuxStatus,
} from '@cozypad/contracts';
import { getBridge } from './platform/bridge';
import {
  ConnectionManager,
  CredentialPrompt,
  HostKeyDialog,
} from './components/ConnectionManager';
import type { CredentialSubmission } from './components/ConnectionManager';
import { LoginScreen } from './components/LoginScreen';
import {
  AgentsIcon,
  FilesIcon,
  MonitorIcon,
  ResearchIcon,
  SettingsIcon,
  TerminalIcon,
  WebIcon,
  WorkIcon,
} from './components/icons';
import { TmuxSetupDialog } from './components/TmuxSetupDialog';
import {
  OPEN_FILE_PATH_EVENT,
  type OpenFilePathEventDetail,
} from './components/markdownComponents';
import { AgentsWorkspace } from './workspaces/agents/AgentsWorkspace';
import { FilesWorkspace } from './workspaces/FilesWorkspace';
import { MonitorWorkspace } from './workspaces/MonitorWorkspace';
import { PublicWorkspace } from './workspaces/PublicWorkspace';
import { ResearchWorkspace } from './workspaces/ResearchWorkspace';
import { SettingsWorkspace } from './workspaces/SettingsWorkspace';
import { TerminalWorkspace } from './workspaces/TerminalWorkspace';
import { WorkWorkspace } from './workspaces/WorkWorkspace';
import type { WorkRun } from './workspaces/workRuns';
import {
  reconnectDelayMs,
  shouldEnterReconnectFlow,
  type ConnectionAttemptOrigin,
} from './reconnectPolicy';
import {
  closeAllLegacySshRuntime,
  connectLegacySsh,
  createLegacyServer,
  deleteLegacyServer,
  getLegacySession,
  listLegacyServers,
  logoutLegacy,
  provisionLegacyServer,
  setLegacySshExecutionEnabled,
  updateLegacyServer,
} from './workspaces/agents/legacySshApi';
import type { LegacyAuthUser, LegacySshServer } from './workspaces/agents/legacySshApi';
import { activateUserStorage, deactivateUserStorage } from './platform/userStorage';
import { subscribeCodexTrainingTasks } from './workspaces/agents/codexTaskQueue';
import {
  readLastSelectedLegacyServerId,
  rememberLastSelectedLegacyServerId,
  subscribeLastSelectedLegacyServerId,
} from './workspaces/sshServerPreference';

type WorkspaceId =
  | 'agents'
  | 'research'
  | 'work'
  | 'terminal'
  | 'files'
  | 'monitor'
  | 'public'
  | 'settings';

type SuiteHealthState = 'checking' | 'ready' | 'partial' | 'offline';

type SuiteHealthResponse = {
  ready?: boolean;
  services?: {
    web?: boolean;
    api?: boolean;
    localCmd?: boolean;
  };
};

const NAV_ITEMS: { id: WorkspaceId; label: string; icon: () => React.ReactElement }[] = [
  { id: 'research', label: 'Research', icon: () => <ResearchIcon /> },
  { id: 'agents', label: 'Agents', icon: () => <AgentsIcon /> },
  { id: 'terminal', label: 'Terminal', icon: () => <TerminalIcon /> },
  { id: 'files', label: 'File', icon: () => <FilesIcon /> },
  { id: 'work', label: 'Work', icon: () => <WorkIcon /> },
  { id: 'monitor', label: 'device Monitor', icon: () => <MonitorIcon /> },
  { id: 'public', label: 'Public', icon: () => <WebIcon /> },
  { id: 'settings', label: 'Settings', icon: () => <SettingsIcon /> },
];

const SSH_AUTO_RECONNECT_MAX_ATTEMPTS = 0;

type AgentTaskOpenTarget = {
  agent: 'codex' | 'claude' | 'agy' | 'bailian';
  taskId: string;
  profileId: string;
  nonce: number;
};

type FilesOpenTarget = {
  serverId: string;
  path: string;
  nonce: number;
};

function isLocalLegacyServer(server: LegacySshServer): boolean {
  const host = String(server.host || '').trim().toLowerCase();
  return (
    server.localOnly === true ||
    (server.source === 'system' && server.id === 'system:localhost') ||
    (server.source === 'system' && (
      host === 'localhost' ||
      host === '::1' ||
      host === 'mock.local' ||
      host.startsWith('127.')
    ))
  );
}

function legacyServerToConnectionProfile(server: LegacySshServer): ConnectionProfile {
  const local = isLocalLegacyServer(server);
  const hasIdentityFile = Boolean(server.identityFileReady ?? server.hasIdentityFile ?? server.identityFile);
  return {
    id: server.id,
    name: server.name || server.alias || server.host || server.id,
    host: local ? '127.0.0.1' : server.host,
    port: local ? 22 : Number(server.port || 22),
    username: server.user || (local ? 'local' : 'ssh'),
    authMethod: hasIdentityFile ? 'privateKey' : 'password',
    hasPassword: local,
    hasPrivateKey: hasIdentityFile,
    credentialPersisted: local || hasIdentityFile,
  };
}

function canUseLegacyProfile(profile: ConnectionProfile): boolean {
  return profile.hasPrivateKey === true;
}

function mergeProfileOptions(
  profiles: ConnectionProfile[],
  legacyProfiles: ConnectionProfile[],
): ConnectionProfile[] {
  const seen = new Set<string>();
  const options: ConnectionProfile[] = [];
  for (const profile of [...profiles, ...legacyProfiles]) {
    if (seen.has(profile.id)) continue;
    seen.add(profile.id);
    options.push(profile);
  }
  return options;
}

export function App() {
  const bridge = useMemo(() => getBridge(), []);
  const [authState, setAuthState] = useState<'checking' | 'authenticated' | 'anonymous'>(
    'checking',
  );
  const [currentUser, setCurrentUser] = useState<LegacyAuthUser | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceId>('agents');
  const [agentTaskOpenTarget, setAgentTaskOpenTarget] = useState<AgentTaskOpenTarget | null>(null);
  const [filesOpenTarget, setFilesOpenTarget] = useState<FilesOpenTarget | null>(null);
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [legacyProfileOptions, setLegacyProfileOptions] = useState<ConnectionProfile[]>([]);
  const [legacyProfileStatuses, setLegacyProfileStatuses] = useState<Map<string, string>>(new Map());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [state, setState] = useState<ConnectionState>('disconnected');
  const [error, setError] = useState<string | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [credentialPrompt, setCredentialPrompt] = useState<ConnectionProfile | null>(null);
  const [hostKeyPrompt, setHostKeyPrompt] = useState<HostKeyPromptEvent | null>(null);
  const [mockData, setMockData] = useState(false);
  const [tmuxStatus, setTmuxStatus] = useState<TmuxStatus | null>(null);
  const [tmuxPromptDismissed, setTmuxPromptDismissed] = useState(false);
  const [suiteHealth, setSuiteHealth] = useState<SuiteHealthState>('checking');
  const [suiteHealthDetail, setSuiteHealthDetail] = useState('Checking local services…');
  const [reconnect, setReconnect] = useState<{
    attempt: number;
    secondsLeft: number;
  } | null>(null);

  const manualDisconnect = useRef(true);
  const wasConnected = useRef(false);
  const attempts = useRef(0);
  const connectInFlight = useRef(false);
  const reconnectScheduled = useRef(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTicker = useRef<ReturnType<typeof setInterval> | null>(null);
  const connectionAttemptOrigin = useRef<ConnectionAttemptOrigin>(null);

  const acceptAuthenticatedUser = useCallback((user: LegacyAuthUser) => {
    activateUserStorage(user.username, user.role);
    setCurrentUser(user);
    setWorkspace('agents');
    setAgentTaskOpenTarget(null);
    setFilesOpenTarget(null);
    setSelectedId(null);
    setProfiles([]);
    setLegacyProfileOptions([]);
    setLegacyProfileStatuses(new Map());
    setManagerOpen(false);
    setCredentialPrompt(null);
    setHostKeyPrompt(null);
    setError(null);
    setAuthState('authenticated');
  }, []);

  useEffect(() => {
    setLegacySshExecutionEnabled(state === 'connected');
  }, [state]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refreshSuiteHealth = async () => {
      try {
        const response = await fetch('/api/suite/health', {
          credentials: 'include',
          headers: { 'x-cozypad-request': 'app' },
        });
        const body = await response.json().catch(() => ({})) as SuiteHealthResponse;
        if (!active) return;
        const services = body.services || {};
        const values = [services.web, services.api, services.localCmd];
        const ready = response.ok && body.ready === true && values.every(Boolean);
        setSuiteHealth(ready ? 'ready' : values.some(Boolean) ? 'partial' : 'offline');
        setSuiteHealthDetail(
          `Web ${services.web ? 'ready' : 'down'} · API ${services.api ? 'ready' : 'down'} · `
          + `Local command ${services.localCmd ? 'ready' : 'down'}`,
        );
      } catch {
        if (!active) return;
        setSuiteHealth('offline');
        setSuiteHealthDetail('The CozyPad API is not responding.');
      } finally {
        if (active) timer = setTimeout(refreshSuiteHealth, 4_000);
      }
    };
    void refreshSuiteHealth();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    let active = true;
    async function checkAuthSession() {
      try {
        const session = await getLegacySession();
        if (!active) return;
        if (session.authenticated && session.user) {
          acceptAuthenticatedUser(session.user);
        } else {
          deactivateUserStorage();
          setCurrentUser(null);
          setAuthState('anonymous');
        }
      } catch {
        if (!active) return;
        deactivateUserStorage();
        setCurrentUser(null);
        setAuthState('anonymous');
      }
    }

    void checkAuthSession();
    return () => {
      active = false;
    };
  }, [acceptAuthenticatedUser]);

  useEffect(() => subscribeCodexTrainingTasks(() => setWorkspace('agents')), []);

  const clearTimers = useCallback(() => {
    if (reconnectTimer.current !== null) clearTimeout(reconnectTimer.current);
    if (reconnectTicker.current !== null) clearInterval(reconnectTicker.current);
    reconnectTimer.current = null;
    reconnectTicker.current = null;
    reconnectScheduled.current = false;
  }, []);

  const refreshProfiles = useCallback(async () => {
    const list = await bridge.listProfiles();
    setProfiles(list);
    setSelectedId((current) => {
      // The browser bridge exposes a development-only mock profile. Keep the
      // production selector empty until the user explicitly chooses an SSH host.
      if (bridge.kind === 'mock') return current;
      return current !== null && list.some((profile) => profile.id === current)
        ? current
        : null;
    });
  }, [bridge]);

  useEffect(() => {
    void refreshProfiles();
  }, [refreshProfiles]);

  const refreshLegacyProfiles = useCallback(async (refresh = false) => {
    if (bridge.kind !== 'mock' || authState !== 'authenticated') {
      setLegacyProfileOptions([]);
      setLegacyProfileStatuses(new Map());
      return 0;
    }

    const servers = await listLegacyServers(refresh);
    const nextLegacyProfiles = servers
      .filter((server) => !isLocalLegacyServer(server))
      .map(legacyServerToConnectionProfile);
    const rememberedId = readLastSelectedLegacyServerId();
    setLegacyProfileOptions(nextLegacyProfiles);
    setLegacyProfileStatuses(new Map(
      servers.map((server) => [
        server.id,
        server.provisioningStatus
          || (server.source === 'ssh-config'
            ? 'imported'
            : server.identityFileReady
              ? 'ready'
              : 'not-provisioned'),
      ]),
    ));
    setSelectedId((current) => {
      const currentProfile = nextLegacyProfiles.find((profile) => profile.id === current);
      if (currentProfile && canUseLegacyProfile(currentProfile)) return currentProfile.id;
      const rememberedProfile = nextLegacyProfiles.find((profile) => profile.id === rememberedId);
      if (rememberedProfile && canUseLegacyProfile(rememberedProfile)) return rememberedProfile.id;
      return null;
    });
    return nextLegacyProfiles.length;
  }, [authState, bridge.kind]);

  useEffect(() => {
    let active = true;
    void refreshLegacyProfiles().catch(() => {
      if (active) setLegacyProfileOptions([]);
    });
    return () => {
      active = false;
    };
  }, [refreshLegacyProfiles]);

  useEffect(
    () =>
      subscribeLastSelectedLegacyServerId((serverId) => {
        if (!serverId) {
          setSelectedId(null);
          return;
        }
        if (legacyProfileOptions.some((profile) => profile.id === serverId)) {
          setSelectedId(serverId);
        }
      }),
    [legacyProfileOptions],
  );

  useEffect(() => bridge.onHostKeyPrompt(setHostKeyPrompt), [bridge]);

  useEffect(() => {
    void bridge.getAppInfo().then((info) => setMockData(info.mockData));
  }, [bridge]);

  useEffect(
    () =>
      bridge.onTmuxStatus((status) => {
        setTmuxStatus(status);
        if (status.installed && status.satisfiesTarget) setTmuxPromptDismissed(false);
      }),
    [bridge],
  );

  const doConnect = useCallback(
    (profileId: string, origin: Exclude<ConnectionAttemptOrigin, null> = 'manual') => {
      if (connectInFlight.current) return;
      connectInFlight.current = true;
      connectionAttemptOrigin.current = origin;
      manualDisconnect.current = false;
      setError(null);
      const legacyProfile = legacyProfileOptions.some((profile) => profile.id === profileId);
      const connectRequest =
        bridge.kind === 'mock' && legacyProfile
          ? connectLegacySsh(profileId).then(() => bridge.connect({ profileId }))
          : bridge.connect({ profileId });
      void connectRequest
        .then(() => {
          connectInFlight.current = false;
          connectionAttemptOrigin.current = null;
        })
        .catch((err: unknown) => {
          connectInFlight.current = false;
          connectionAttemptOrigin.current = null;
          setState('error');
          setError(err instanceof Error ? err.message : String(err));
          if (origin === 'reconnect' && wasConnected.current) {
            scheduleRef.current(profileId);
          } else {
            manualDisconnect.current = true;
            clearTimers();
            setReconnect(null);
          }
        });
    },
    [bridge, clearTimers, legacyProfileOptions],
  );

  const scheduleReconnect = useCallback(
    (profileId: string) => {
      if (manualDisconnect.current || reconnectScheduled.current || connectInFlight.current) return;
      if (SSH_AUTO_RECONNECT_MAX_ATTEMPTS <= 0) {
        manualDisconnect.current = true;
        connectInFlight.current = false;
        clearTimers();
        setReconnect(null);
        setError('SSH auto reconnect is disabled to avoid repeated server-side login attempts. Check the server, network, and credentials, then press Connect manually.');
        return;
      }
      if (attempts.current >= SSH_AUTO_RECONNECT_MAX_ATTEMPTS) {
        manualDisconnect.current = true;
        connectInFlight.current = false;
        clearTimers();
        setReconnect(null);
        setError(`SSH auto reconnect stopped after ${SSH_AUTO_RECONNECT_MAX_ATTEMPTS} failed attempt(s). Check the server, network, and credentials, then press Connect manually.`);
        return;
        setError(
          `SSH 自動重連已停止：連續失敗 ${SSH_AUTO_RECONNECT_MAX_ATTEMPTS} 次。為避免 IP 被封鎖，請確認 server、網路與憑證後再手動按 Connect。`,
        );
        return;
      }
      reconnectScheduled.current = true;
      const delayMs = reconnectDelayMs(attempts.current);
      attempts.current += 1;
      const attempt = attempts.current;
      let secondsLeft = Math.round(delayMs / 1000);
      setReconnect({ attempt, secondsLeft });
      const ticker = setInterval(() => {
        secondsLeft -= 1;
        if (secondsLeft > 0) setReconnect({ attempt, secondsLeft });
      }, 1000);
      reconnectTicker.current = ticker;
      const timer = setTimeout(() => {
        clearInterval(ticker);
        reconnectTicker.current = null;
        reconnectTimer.current = null;
        reconnectScheduled.current = false;
        setReconnect(null);
        doConnect(profileId, 'reconnect');
      }, delayMs);
      reconnectTimer.current = timer;
    },
    [clearTimers, doConnect],
  );

  const scheduleRef = useRef(scheduleReconnect);
  scheduleRef.current = scheduleReconnect;

  useEffect(() => {
    return bridge.onConnectionState((event) => {
      setState(event.state);
      setError(event.error ?? null);
      if (event.state === 'connected') {
        connectInFlight.current = false;
        connectionAttemptOrigin.current = null;
        wasConnected.current = true;
        attempts.current = 0;
        clearTimers();
        setReconnect(null);
      }
      if (event.state === 'error') {
        connectInFlight.current = false;
        if (shouldEnterReconnectFlow({
          attemptOrigin: connectionAttemptOrigin.current,
          manualDisconnect: manualDisconnect.current,
          wasConnected: wasConnected.current,
        })) {
          scheduleRef.current(event.profileId);
        }
      }
      if (
        event.state === 'disconnected' &&
        shouldEnterReconnectFlow({
          attemptOrigin: connectionAttemptOrigin.current,
          manualDisconnect: manualDisconnect.current,
          wasConnected: wasConnected.current,
        })
      ) {
        scheduleRef.current(event.profileId);
      }
    });
  }, [bridge, clearTimers]);

  const profileOptions = useMemo(() => {
    const visibleProfiles =
      bridge.kind === 'mock'
        ? profiles.filter((profile) => profile.id !== 'mock-local' && profile.host !== 'mock.local')
        : profiles;
    return mergeProfileOptions(visibleProfiles, legacyProfileOptions);
  }, [bridge.kind, legacyProfileOptions, profiles]);
  const selectedProfile = profileOptions.find((profile) => profile.id === selectedId) ?? null;
  const selectedLegacyProfile = legacyProfileOptions.some((profile) => profile.id === selectedId);
  const effectiveMockData = mockData && selectedProfile?.id === 'mock-local' && !selectedLegacyProfile;

  const handleConnect = () => {
    if (!selectedProfile) return;
    attempts.current = 0;
    const hasCredential =
      (selectedProfile.authMethod ?? 'password') === 'privateKey'
        ? selectedProfile.hasPrivateKey === true
        : selectedProfile.hasPassword === true;
    if (!hasCredential && bridge.kind !== 'mock') {
      setCredentialPrompt(selectedProfile);
      return;
    }
    doConnect(selectedProfile.id);
  };

  const handleDisconnect = () => {
    manualDisconnect.current = true;
    connectionAttemptOrigin.current = null;
    wasConnected.current = false;
    connectInFlight.current = false;
    clearTimers();
    setReconnect(null);
    if (selectedId !== null) {
      if (bridge.kind === 'mock' && legacyProfileOptions.some((profile) => profile.id === selectedId)) {
        void closeAllLegacySshRuntime()
          .catch(() => undefined)
          .finally(() => bridge.disconnect({ profileId: selectedId }));
      } else {
        void bridge.disconnect({ profileId: selectedId });
      }
    }
  };

  const handleLogout = async () => {
    handleDisconnect();
    try {
      await logoutLegacy();
    } catch {
      // The local session may already be gone. The UI should still leave the app shell.
    } finally {
      deactivateUserStorage();
      setCurrentUser(null);
      setWorkspace('agents');
      setProfiles([]);
      setLegacyProfileOptions([]);
      setLegacyProfileStatuses(new Map());
      setSelectedId(null);
      setManagerOpen(false);
      setCredentialPrompt(null);
      setHostKeyPrompt(null);
      setAuthState('anonymous');
    }
  };

  const handleOpenWorkRun = useCallback((run: WorkRun) => {
    if (run.profileId) rememberLastSelectedLegacyServerId(run.profileId);
    setAgentTaskOpenTarget({
      agent: run.agent,
      taskId: run.taskId,
      profileId: run.profileId,
      nonce: Date.now(),
    });
    setWorkspace('agents');
  }, []);

  const handleOpenFilesPath = useCallback((target: { serverId: string; path: string }) => {
    const serverId = target.serverId.trim();
    const path = target.path.trim();
    if (!serverId || !path) return;
    rememberLastSelectedLegacyServerId(serverId);
    setFilesOpenTarget({ serverId, path, nonce: Date.now() });
    setWorkspace('files');
  }, []);

  useEffect(() => {
    const openFromElement = (element: Element): boolean => {
      const target = element.closest<HTMLElement>('[data-cozypad-file-path]');
      if (!target) return false;
      const serverId = target.dataset.cozypadFileServerId || '';
      const path = target.dataset.cozypadFilePath || '';
      if (!serverId || !path) return false;
      handleOpenFilesPath({ serverId, path });
      return true;
    };

    const handleOpenFilePathEvent = (event: Event) => {
      const detail = (event as CustomEvent<OpenFilePathEventDetail>).detail;
      if (!detail?.serverId || !detail.path) return;
      handleOpenFilesPath(detail);
    };

    const handleDocumentClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      if (!openFromElement(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener(OPEN_FILE_PATH_EVENT, handleOpenFilePathEvent);
    document.addEventListener('click', handleDocumentClick, true);
    return () => {
      window.removeEventListener(OPEN_FILE_PATH_EVENT, handleOpenFilePathEvent);
      document.removeEventListener('click', handleDocumentClick, true);
    };
  }, [handleOpenFilesPath]);

  const submitCredential = async (credential: CredentialSubmission) => {
    const profile = credentialPrompt;
    if (!profile) return;
    setCredentialPrompt(null);
    try {
      await bridge.saveProfile({
        id: profile.id,
        name: profile.name,
        host: profile.host,
        port: profile.port,
        username: profile.username,
        ...credential,
      });
      await refreshProfiles();
      doConnect(profile.id);
    } catch (credentialError) {
      setState('error');
      setError(
        credentialError instanceof Error
          ? credentialError.message
          : String(credentialError),
      );
    }
  };

  if (authState === 'checking') {
    return (
      <main className="login-screen">
        <section className="login-card login-loading" aria-label="CozyPad loading">
          <header className="login-card-head">
            <div className="login-mark" aria-hidden="true">
              &gt;_
            </div>
            <div>
              <h1>CozyPad</h1>
              <span>檢查 session</span>
            </div>
          </header>
        </section>
      </main>
    );
  }

  if (authState === 'anonymous') {
    return (
      <LoginScreen
        onAuthenticated={acceptAuthenticatedUser}
      />
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">CozyPad</span>
        <select
          className="profile-select"
          value={selectedId ?? ''}
          onChange={(event) => {
            const nextId = event.target.value;
            setSelectedId(nextId || null);
            if (!nextId) {
              rememberLastSelectedLegacyServerId('');
              return;
            }
            if (legacyProfileOptions.some((profile) => profile.id === nextId)) {
              rememberLastSelectedLegacyServerId(nextId);
            }
          }}
          disabled={state === 'connected' || state === 'connecting'}
        >
          <option value="">（請選擇 SSH 主機）</option>
          {profileOptions.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
        <button
          className="ghost"
          title="管理連線"
          onClick={() => setManagerOpen(true)}
        >
          ⚙
        </button>
        <span
          className={`status suite-status status-${
            suiteHealth === 'ready'
              ? 'connected'
              : suiteHealth === 'checking'
                ? 'connecting'
                : 'error'
          }`}
          title={suiteHealthDetail}
        >
          Services · {suiteHealth}
        </span>
        <span className={`status status-${state}`} title={`SSH · ${state}`}>
          SSH · {state}
        </span>
        <span className={`mode-tag${effectiveMockData ? ' mode-mock' : ' mode-ssh'}`}>
          {effectiveMockData ? 'MOCK 資料' : 'SSH'}
        </span>
        <span className="spacer" />
        {currentUser ? (
          <span className="topbar-user">
            {currentUser.username}
            <small>{currentUser.role}</small>
          </span>
        ) : null}
        {state === 'connected' ? (
          <button onClick={handleDisconnect}>Disconnect</button>
        ) : (
          <button
            onClick={handleConnect}
            disabled={
              !selectedProfile || state === 'connecting' || suiteHealth !== 'ready'
            }
          >
            {state === 'connecting' ? 'Connecting…' : 'Connect'}
          </button>
        )}
        <button className="topbar-logout" onClick={() => void handleLogout()}>
          登出
        </button>
      </header>
      {reconnect ? (
        <div className="reconnect-banner">
          <span>
            連線中斷 — {reconnect.secondsLeft}s 後重試（第 {reconnect.attempt} 次）
          </span>
          <button
            onClick={() => {
              clearTimers();
              setReconnect(null);
              if (selectedId !== null) doConnect(selectedId, 'reconnect');
            }}
          >
            立即重連
          </button>
          <button
            onClick={() => {
              manualDisconnect.current = true;
              clearTimers();
              setReconnect(null);
            }}
          >
            取消
          </button>
        </div>
      ) : null}
      {error !== null && !reconnect ? <div className="error-banner">{error}</div> : null}
      <div className="shell">
        <nav className="nav-rail">
          {NAV_ITEMS.filter((item) => {
            if (item.id !== 'public') return true;
            return currentUser?.capabilities?.some(
              (capability) => capability === 'public.read' || capability === 'public.manage',
            );
          }).map((item) => (
            <button
              key={item.id}
              className={`nav-item${workspace === item.id ? ' nav-item-active' : ''}`}
              onClick={() => setWorkspace(item.id)}
              title={item.label}
            >
              {item.icon()}
              <span className="nav-label">{item.label}</span>
            </button>
          ))}
        </nav>
        <main className="workspace">
          <section className="workspace-page" hidden={workspace !== 'agents'}>
            <AgentsWorkspace
              mockData={effectiveMockData}
              selectedProfile={selectedProfile}
              connected={state === 'connected'}
              openTarget={agentTaskOpenTarget}
              onOpenFilesPath={handleOpenFilesPath}
            />
          </section>
          <section className="workspace-page" hidden={workspace !== 'research'}>
            <ResearchWorkspace connected={state === 'connected'} />
          </section>
          <section className="workspace-page" hidden={workspace !== 'work'}>
            <WorkWorkspace active={workspace === 'work'} onOpenRun={handleOpenWorkRun} />
          </section>
          <section className="workspace-page" hidden={workspace !== 'terminal'}>
            <TerminalWorkspace
              active={workspace === 'terminal'}
              connected={state === 'connected'}
              profileId={selectedId}
            />
          </section>
          <section className="workspace-page" hidden={workspace !== 'files'}>
            <FilesWorkspace
              active={workspace === 'files'}
              connected={state === 'connected'}
              profileId={selectedId}
              openTarget={filesOpenTarget}
            />
          </section>
          <section className="workspace-page" hidden={workspace !== 'monitor'}>
            <MonitorWorkspace
              active={workspace === 'monitor'}
              connected={state === 'connected'}
              host={selectedProfile ? `${selectedProfile.username}@${selectedProfile.host}` : null}
              selectedServerId={selectedId}
            />
          </section>
          <section className="workspace-page" hidden={workspace !== 'public'}>
            <PublicWorkspace />
          </section>
          <section className="workspace-page" hidden={workspace !== 'settings'}>
            <SettingsWorkspace
              bridgeKind={bridge.kind}
              mockData={effectiveMockData}
              connected={state === 'connected'}
              allowDeveloperTools={currentUser?.capabilities?.includes('developer.simulate-drop')}
            />
          </section>
        </main>
      </div>
      {managerOpen ? (
        <ConnectionManager
          profiles={profileOptions}
          managedProfileIds={new Set(legacyProfileOptions.map((profile) => profile.id))}
          managedProfileStatuses={legacyProfileStatuses}
          onClose={() => setManagerOpen(false)}
          onChanged={() => Promise.all([refreshProfiles(), refreshLegacyProfiles()]).then(() => undefined)}
          onImportSshConfig={
            currentUser?.capabilities?.includes('ssh.import-system-config')
              ? () => refreshLegacyProfiles(true)
              : undefined
          }
          onSaveManagedProfile={async (profile) => {
            if (profile.id) {
              const updated = await updateLegacyServer(profile.id, {
                name: profile.name,
                host: profile.host,
                user: profile.username,
                port: profile.port,
                defaultPath: '~',
              });
              if (selectedId === profile.id) rememberLastSelectedLegacyServerId(updated.id);
              return { id: updated.id };
            }
            if (profile.authMethod !== 'password') {
              throw new Error('Import private-key profiles through ~/.ssh/config. New managed profiles use a one-time SSH password to install a generated key.');
            }
            const created = await createLegacyServer({
              name: profile.name,
              host: profile.host,
              user: profile.username,
              port: profile.port,
              password: profile.password,
              defaultPath: '~',
            });
            rememberLastSelectedLegacyServerId(created.id);
            return { id: created.id };
          }}
          onProvisionManagedProfile={async (profileId, password, expectedHostFingerprint) => {
            const result = await provisionLegacyServer(profileId, {
              password,
              expectedHostFingerprint,
            });
            rememberLastSelectedLegacyServerId(result.server.id);
          }}
          onDeleteManagedProfile={async (profileId) => {
            await deleteLegacyServer(profileId);
            if (selectedId === profileId) rememberLastSelectedLegacyServerId('');
          }}
          mutationsDisabled={state === 'connected' || state === 'connecting'}
        />
      ) : null}
      {credentialPrompt ? (
        <CredentialPrompt
          profile={credentialPrompt}
          onCancel={() => setCredentialPrompt(null)}
          onSubmit={(credential) => void submitCredential(credential)}
        />
      ) : null}
      {tmuxStatus !== null &&
      !tmuxPromptDismissed &&
      state === 'connected' &&
      !(tmuxStatus.installed && tmuxStatus.satisfiesTarget) ? (
        <TmuxSetupDialog
          status={tmuxStatus}
          onDismiss={() => setTmuxPromptDismissed(true)}
          onInstalled={(status) => {
            setTmuxStatus(status);
            setTmuxPromptDismissed(true);
          }}
        />
      ) : null}
      {hostKeyPrompt ? (
        <HostKeyDialog
          prompt={hostKeyPrompt}
          onRespond={(accept) => {
            void bridge.respondHostKey({ requestId: hostKeyPrompt.requestId, accept });
            setHostKeyPrompt(null);
          }}
        />
      ) : null}
    </div>
  );
}
