import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TerminalKeysBar } from '../components/TerminalKeysBar';
import { TerminalView } from '../components/TerminalView';
import type { TerminalHandle, TerminalModifiers } from '../components/TerminalView';
import {
  closeLegacyTerminal,
  isLegacyAuthError,
  listLegacyServers,
} from './agents/legacySshApi';
import type { LegacySshServer } from './agents/legacySshApi';
import {
  readLastSelectedLegacyServerId,
  resolveLastSelectedLegacyServerId,
  subscribeLastSelectedLegacyServerId,
} from './sshServerPreference';

interface TerminalWorkspaceProps {
  active?: boolean;
  connected?: boolean;
  profileId?: string | null;
}

type TerminalTab = {
  id: number;
  terminalId: string;
  serverId: string;
  serverName: string;
};

const QUICK_COMMANDS: { label: string; command: string }[] = [
  { label: '列表', command: 'ls -la' },
  { label: '路徑', command: 'pwd' },
  { label: 'Git 狀態', command: 'git status' },
  { label: 'Git 紀錄', command: 'git log --oneline -10' },
  { label: 'GPU 狀態', command: 'nvidia-smi' },
  { label: 'GPU 監看', command: 'watch -n1 nvidia-smi' },
  { label: '記憶體', command: 'free -h' },
  { label: '硬碟', command: 'df -h' },
  { label: '程序', command: 'htop' },
  { label: 'tmux 列表', command: 'tmux ls' },
  { label: 'tmux 連線', command: 'tmux attach -t ' },
  { label: 'Python', command: 'python -V' },
];

const TERMINAL_SERVER_LIST_TIMEOUT_MS = 15000;

function createTerminalSessionId(serverId: string): string {
  const random =
    typeof window !== 'undefined' && window.crypto?.randomUUID
      ? window.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const safeServer = serverId.replace(/[^A-Za-z0-9:_-]/g, '-').slice(0, 48);
  return `term-${safeServer}-${random}`.replace(/[^A-Za-z0-9:_-]/g, '-').slice(0, 150);
}

function resolveTerminalServerId(
  servers: LegacySshServer[],
  preferredId: string | null | undefined,
  currentId = '',
): string {
  if (preferredId && servers.some((server) => server.id === preferredId)) {
    return preferredId;
  }
  return resolveLastSelectedLegacyServerId(servers, currentId);
}

function isLocalTerminalServer(server: LegacySshServer): boolean {
  if (server.localOnly) return true;
  if (server.source === 'system' && server.id === 'system:localhost') return true;
  const host = String(server.host || '').trim().toLowerCase();
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

export function TerminalWorkspace({
  active: workspaceActive = false,
  connected = false,
  profileId = null,
}: TerminalWorkspaceProps) {
  const [servers, setServers] = useState<LegacySshServer[]>([]);
  const [selectedServerId, setSelectedServerId] = useState(() => readLastSelectedLegacyServerId());
  const [serverError, setServerError] = useState('');
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [quickOpen, setQuickOpen] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [modifiers, setModifiers] = useState<TerminalModifiers>({
    ctrl: false,
    alt: false,
  });
  const [keysBarOn, setKeysBarOn] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(pointer: coarse), (max-width: 600px)').matches,
  );
  const nextId = useRef(1);
  const handles = useRef(new Map<number, TerminalHandle>());
  const loadServersRequestRef = useRef(0);

  const selectedServer = useMemo(
    () => servers.find((server) => server.id === selectedServerId) ?? null,
    [selectedServerId, servers],
  );
  const isRemoteTabBlocked = useCallback(
    (tab: TerminalTab): boolean => {
      if (connected) return false;
      const server = servers.find((item) => item.id === tab.serverId);
      if (!server) return true;
      return !isLocalTerminalServer(server);
    },
    [connected, servers],
  );

  const loadServers = useCallback(
    async (refresh = false) => {
      const requestId = loadServersRequestRef.current + 1;
      loadServersRequestRef.current = requestId;
      const controller = new AbortController();
      const timeout = window.setTimeout(
        () => controller.abort(),
        TERMINAL_SERVER_LIST_TIMEOUT_MS,
      );
      setServerError('');
      try {
        const nextServers = await listLegacyServers(refresh, {
          signal: controller.signal,
        });
        if (loadServersRequestRef.current !== requestId) return;
        setServers(nextServers);
        setSelectedServerId((current) => {
          return resolveTerminalServerId(nextServers, profileId, current);
        });
      } catch (error) {
        if (loadServersRequestRef.current !== requestId) return;
        const aborted = controller.signal.aborted;
        if (aborted) {
          setServerError(
            `Terminal server list timed out after ${Math.round(
              TERMINAL_SERVER_LIST_TIMEOUT_MS / 1000,
            )}s.`,
          );
          return;
        }
        if (isLegacyAuthError(error)) {
          setServerError('請先登入 CozyPad，Terminal 才能載入已匯入 SSH server。');
        } else {
          setServerError(error instanceof Error ? error.message : 'SSH server 載入失敗');
        }
      } finally {
        window.clearTimeout(timeout);
      }
    },
    [connected, profileId],
  );

  useEffect(() => {
    void loadServers(false);
  }, [loadServers]);

  useEffect(() => {
    if (connected || servers.length === 0 || tabs.length === 0) return;

    const localServerIds = new Set(servers.filter(isLocalTerminalServer).map((server) => server.id));
    const remoteTabs = tabs.filter((tab) => !localServerIds.has(tab.serverId));
    if (remoteTabs.length === 0) return;

    for (const tab of remoteTabs) {
      void closeLegacyTerminal(tab.terminalId).catch(() => undefined);
      handles.current.delete(tab.id);
    }

    setTabs((current) => {
      const remaining = current.filter((tab) => localServerIds.has(tab.serverId));
      setActive((activeId) =>
        activeId !== null && remaining.some((tab) => tab.id === activeId)
          ? activeId
          : (remaining[remaining.length - 1]?.id ?? null),
      );
      return remaining;
    });
  }, [connected, servers, tabs]);

  useEffect(() => {
    if (!profileId || !servers.some((server) => server.id === profileId)) return;
    setSelectedServerId(profileId);
  }, [profileId, servers]);

  useEffect(
    () =>
      subscribeLastSelectedLegacyServerId((serverId) => {
        if (!serverId || !servers.some((server) => server.id === serverId)) return;
        setSelectedServerId(serverId);
      }),
    [servers],
  );

  const addTab = useCallback((serverOverride?: LegacySshServer | null) => {
    const targetServer = serverOverride ?? selectedServer;
    if (!targetServer) {
      setServerError('請先選擇已匯入的 SSH server。');
      return;
    }

    if (!connected && !isLocalTerminalServer(targetServer)) {
      setServerError('Press Connect before opening SSH terminals.');
      return;
    }

    const id = nextId.current++;
    const tab: TerminalTab = {
      id,
      terminalId: createTerminalSessionId(targetServer.id),
      serverId: targetServer.id,
      serverName: targetServer.name,
    };
    setTabs((current) => [...current, tab]);
    setActive(id);
    setServerError('');
  }, [connected, selectedServer]);

  useEffect(() => {
    const handleNewTerminal = () => addTab(selectedServer);
    window.addEventListener('cozypad:terminal:new', handleNewTerminal);
    return () => window.removeEventListener('cozypad:terminal:new', handleNewTerminal);
  }, [addTab, selectedServer]);

  useEffect(() => {
    if (!workspaceActive || tabs.length > 0 || servers.length === 0) return;
    addTab(selectedServer);
  }, [addTab, selectedServer, servers.length, tabs.length, workspaceActive]);

  const closeTab = (id: number) => {
    const tab = tabs.find((item) => item.id === id);
    if (tab) {
      void closeLegacyTerminal(tab.terminalId).catch((error) => {
        setServerError(error instanceof Error ? error.message : 'Terminal 關閉失敗');
      });
    }

    handles.current.delete(id);
    setTabs((current) => {
      const remaining = current.filter((tabItem) => tabItem.id !== id);
      setActive((activeId) =>
        activeId === id ? (remaining[remaining.length - 1]?.id ?? null) : activeId,
      );
      return remaining;
    });
  };

  const runQuick = (command: string, execute: boolean) => {
    const handle = active !== null ? handles.current.get(active) : undefined;
    if (!handle) return;
    if (execute) handle.run(command);
    else handle.paste(command);
    handle.focus();
  };

  return (
    <div className="terminal-workspace">
      <div className="tab-bar">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab${active === tab.id ? ' tab-active' : ''}`}
            onClick={() => setActive(tab.id)}
          >
            <span>{tab.serverName}</span>
            <button
              className="tab-close"
              title="Close"
              onClick={(event) => {
                event.stopPropagation();
                closeTab(tab.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button
          className="tab-add"
          type="button"
          title="New terminal"
          aria-label="New terminal"
          onClick={() => addTab(selectedServer)}
          disabled={!selectedServer}
        >
          +
        </button>
        <span className="spacer" />
        <span className="hint terminal-hint">右鍵：有選取＝複製，無選取＝貼上</span>
        <button
          className={`tab-quick-toggle${keysBarOn ? ' tab-quick-toggle-on' : ''}`}
          onClick={() => setKeysBarOn((on) => !on)}
          title="手機快捷鍵"
        >
          Keys
        </button>
        <button
          className={`tab-quick-toggle${quickOpen ? ' tab-quick-toggle-on' : ''}`}
          onClick={() => setQuickOpen((open) => !open)}
          title="快速指令"
        >
          Commands
        </button>
      </div>
      <div className="terminal-body">
        <div className="terminal-panes">
          {tabs.length === 0 ? (
            <div className="placeholder">
              <p>No terminals open.</p>
              <p className="hint">{serverError || '左上角選擇已匯入 SSH server 後，按齒輪旁的 + 開始連線。'}</p>
            </div>
          ) : null}
          {tabs.map((tab) => {
            const blocked = isRemoteTabBlocked(tab);
            return (
              <div key={tab.id} className="terminal-pane" hidden={active !== tab.id}>
                {blocked ? (
                  <div className="placeholder">
                    <p>Press Connect before opening SSH terminals.</p>
                    <p className="hint">This remote tab is kept, but CozyPad will not start SSH while disconnected.</p>
                  </div>
                ) : (
                  <TerminalView
                    legacyServerId={tab.serverId}
                    legacyTerminalId={tab.terminalId}
                    onNotify={(message) => {
                      setToast(message);
                      setTimeout(() => setToast(null), 1600);
                    }}
                    onModifiersChange={setModifiers}
                    onHandle={(handle) => {
                      if (handle) handles.current.set(tab.id, handle);
                      else handles.current.delete(tab.id);
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
        {quickOpen && tabs.length > 0 ? (
          <aside className="quick-commands">
            <div className="quick-head hint">快速指令：點左側貼上，點右側執行</div>
            {QUICK_COMMANDS.map((entry) => (
              <div key={entry.command} className="quick-row">
                <button
                  className="quick-paste"
                  title={entry.command}
                  onClick={() => runQuick(entry.command, false)}
                >
                  <span className="quick-label">{entry.label}</span>
                  <span className="quick-cmd mono">{entry.command}</span>
                </button>
                <button
                  className="quick-run"
                  title={`執行 ${entry.command}`}
                  onClick={() => runQuick(entry.command, true)}
                >
                  ↵
                </button>
              </div>
            ))}
          </aside>
        ) : null}
      </div>
      {keysBarOn && tabs.length > 0 ? (
        <TerminalKeysBar
          modifiers={modifiers}
          onSend={(sequence) => {
            const handle = active !== null ? handles.current.get(active) : undefined;
            handle?.sendRaw(sequence);
            handle?.focus();
          }}
          onToggleModifier={(mod) => {
            const handle = active !== null ? handles.current.get(active) : undefined;
            handle?.setModifier(mod, !modifiers[mod]);
            handle?.focus();
          }}
        />
      ) : null}
      {toast !== null ? <div className="terminal-toast">{toast}</div> : null}
    </div>
  );
}
