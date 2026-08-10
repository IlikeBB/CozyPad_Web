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
import { AgentsWorkspace } from './workspaces/agents/AgentsWorkspace';
import { FilesWorkspace } from './workspaces/FilesWorkspace';
import { MonitorWorkspace } from './workspaces/MonitorWorkspace';
import { PublicWorkspace } from './workspaces/PublicWorkspace';
import { ResearchWorkspace } from './workspaces/ResearchWorkspace';
import { SettingsWorkspace } from './workspaces/SettingsWorkspace';
import { TerminalWorkspace } from './workspaces/TerminalWorkspace';
import { WorkWorkspace } from './workspaces/WorkWorkspace';
import type { WorkRun } from './workspaces/workRuns';
import { reconnectDelayMs } from './reconnectPolicy';
import {
  getLegacySession,
  listLegacyServers,
  logoutLegacy,
  setLegacySshExecutionEnabled,
} from './workspaces/agents/legacySshApi';
import type { LegacyAuthUser, LegacySshServer } from './workspaces/agents/legacySshApi';
import { subscribeCodexTrainingTasks } from './workspaces/agents/codexTaskQueue';
import {
  readLastSelectedLegacyServerId,
  rememberLastSelectedLegacyServerId,
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

function isLocalLegacyServer(server: LegacySshServer): boolean {
  const host = String(server.host || '').trim().toLowerCase();
  return (
    server.localOnly === true ||
    (server.source === 'system' && server.id === 'system:localhost') ||
    host === 'localhost' ||
    host === '::1' ||
    host === 'mock.local' ||
    host.startsWith('127.')
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
  return (
    profile.id === 'system:localhost' ||
    profile.host === '127.0.0.1' ||
    profile.host === 'localhost' ||
    profile.hasPrivateKey === true
  );
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
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [legacyProfileOptions, setLegacyProfileOptions] = useState<ConnectionProfile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [state, setState] = useState<ConnectionState>('disconnected');
  const [error, setError] = useState<string | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [credentialPrompt, setCredentialPrompt] = useState<ConnectionProfile | null>(null);
  const [hostKeyPrompt, setHostKeyPrompt] = useState<HostKeyPromptEvent | null>(null);
  const [mockData, setMockData] = useState(false);
  const [tmuxStatus, setTmuxStatus] = useState<TmuxStatus | null>(null);
  const [tmuxPromptDismissed, setTmuxPromptDismissed] = useState(false);
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

  useEffect(() => {
    setLegacySshExecutionEnabled(state === 'connected');
  }, [state]);

  useEffect(() => {
    let active = true;
    async function checkAuthSession() {
      try {
        const session = await getLegacySession();
        if (!active) return;
        if (session.authenticated && session.user) {
          setCurrentUser(session.user);
          setAuthState('authenticated');
        } else {
          setCurrentUser(null);
          setAuthState('anonymous');
        }
      } catch {
        if (!active) return;
        setCurrentUser(null);
        setAuthState('anonymous');
      }
    }

    void checkAuthSession();
    return () => {
      active = false;
    };
  }, []);

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
    setSelectedId((current) =>
      current !== null && (bridge.kind === 'mock' || list.some((profile) => profile.id === current))
        ? current
        : (list[0]?.id ?? null),
    );
  }, [bridge]);

  useEffect(() => {
    void refreshProfiles();
  }, [refreshProfiles]);

  useEffect(() => {
    if (bridge.kind !== 'mock' || authState !== 'authenticated') {
      setLegacyProfileOptions([]);
      return;
    }

    let active = true;
    void listLegacyServers(false)
      .then((servers) => {
        if (!active) return;
        const nextLegacyProfiles = servers.map(legacyServerToConnectionProfile);
        setLegacyProfileOptions(nextLegacyProfiles);
        setSelectedId((current) => {
          const currentProfile = nextLegacyProfiles.find((profile) => profile.id === current);
          if (currentProfile && canUseLegacyProfile(currentProfile)) return currentProfile.id;
          const rememberedId = readLastSelectedLegacyServerId();
          const remembered = nextLegacyProfiles.find(
            (profile) => profile.id === rememberedId && canUseLegacyProfile(profile),
          );
          if (remembered) return remembered.id;
          const remote = nextLegacyProfiles.find(
            (profile) => profile.id !== 'system:localhost' && canUseLegacyProfile(profile),
          );
          return remote?.id ?? current ?? nextLegacyProfiles[0]?.id ?? null;
        });
      })
      .catch(() => {
        if (active) setLegacyProfileOptions([]);
      });

    return () => {
      active = false;
    };
  }, [authState, bridge.kind]);

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
    (profileId: string) => {
      if (connectInFlight.current) return;
      connectInFlight.current = true;
      manualDisconnect.current = false;
      setError(null);
      void bridge
        .connect({ profileId })
        .then(() => {
          connectInFlight.current = false;
        })
        .catch((err: unknown) => {
          connectInFlight.current = false;
          setState('error');
          setError(String(err));
          scheduleRef.current(profileId);
        });
    },
    [bridge],
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
        doConnect(profileId);
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
        wasConnected.current = true;
        attempts.current = 0;
        clearTimers();
        setReconnect(null);
      }
      if (event.state === 'error') {
        connectInFlight.current = false;
        if (!manualDisconnect.current && wasConnected.current) {
          scheduleRef.current(event.profileId);
        }
      }
      if (
        event.state === 'disconnected' &&
        !manualDisconnect.current &&
        wasConnected.current
      ) {
        scheduleRef.current(event.profileId);
      }
    });
  }, [bridge, clearTimers]);

  const profileOptions = useMemo(
    () => mergeProfileOptions(profiles, legacyProfileOptions),
    [legacyProfileOptions, profiles],
  );
  const selectedProfile = profileOptions.find((profile) => profile.id === selectedId) ?? null;
  const selectedLegacyProfile = legacyProfileOptions.some((profile) => profile.id === selectedId);
  const effectiveMockData = mockData && !selectedLegacyProfile;

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
    wasConnected.current = false;
    connectInFlight.current = false;
    clearTimers();
    setReconnect(null);
    if (selectedId !== null) void bridge.disconnect({ profileId: selectedId });
  };

  const handleLogout = async () => {
    handleDisconnect();
    try {
      await logoutLegacy();
    } catch {
      // The local session may already be gone. The UI should still leave the app shell.
    } finally {
      setCurrentUser(null);
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
        onAuthenticated={(user) => {
          setCurrentUser(user);
          setAuthState('authenticated');
        }}
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
            setSelectedId(nextId);
            if (legacyProfileOptions.some((profile) => profile.id === nextId)) {
              rememberLastSelectedLegacyServerId(nextId);
            }
          }}
          disabled={state === 'connected' || state === 'connecting'}
        >
          {profileOptions.length === 0 ? <option value="">（無連線設定）</option> : null}
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
        <span className={`status status-${state}`}>{state}</span>
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
            disabled={!selectedProfile || state === 'connecting'}
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
              if (selectedId !== null) doConnect(selectedId);
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
          {NAV_ITEMS.map((item) => (
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
            />
          </section>
        </main>
      </div>
      {managerOpen ? (
        <ConnectionManager
          profiles={profiles}
          onClose={() => setManagerOpen(false)}
          onChanged={refreshProfiles}
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
